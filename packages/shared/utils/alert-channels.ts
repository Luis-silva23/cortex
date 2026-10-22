/**
 * TRANSPORTES de alerta (e-mail, SMS, WhatsApp): funções PURAS, sem banco, sem log e sem estado — recebem a configuração (variáveis de ambiente) e um `fetch` injetável.
 * Usadas pela API (que acrescenta limites, deduplicação e registro no banco) e pelo serviço de monitoramento independente (`apps/monitor`, que acrescenta estado em arquivo).
 * Uma única implementação de cada provedor: nada de duas cópias divergentes.
 *
 * Provedores (cada endpoint abaixo é o documentado pelo provedor; nada aqui foi executado contra o provedor real — ver docs/CORTEX/ALERTAS_CANAIS.md):
 *   e-mail    → Resend            POST https://api.resend.com/emails
 *   SMS       → Twilio            POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json   (form, Basic)
 *   WhatsApp  → Meta Cloud API    POST https://graph.facebook.com/{versão}/{phone-number-id}/messages           (JSON, Bearer, mensagem de MODELO aprovado)
 *             → Twilio WhatsApp   mesma API de mensagens da Twilio com `whatsapp:+E164` e ContentSid (modelo aprovado)
 *
 * Vocabulário de resultado (nunca afirmar mais do que se sabe): `ok: true` significa ACEITO pelo provedor (a API respondeu sucesso); NÃO significa entregue no aparelho.
 * Entrega confirmada exigiria o retorno (webhook/status callback) do provedor, que não está implementado.
 */

export type AlertChannel = 'EMAIL' | 'SMS' | 'WHATSAPP';

export interface TransportDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface TransportResult {
  ok: boolean;
  provider: string;
  /** Identificador devolvido pelo provedor (mensagem aceita). Nunca contém segredo. */
  providerMessageId?: string;
  httpStatus?: number;
  /** Erro JÁ mascarado (sem chave, número, e-mail ou token). */
  error?: string;
  /** Vale tentar de novo (falha de rede, tempo esgotado, 429, 5xx)? Erro de configuração/credencial/destinatário NÃO é repetível. */
  retryable: boolean;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim().length > 0;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Mascaramento e telefones
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Mascara o que costuma vazar em mensagem de erro de provedor: tokens, chaves, Basic auth, e-mails e números de telefone. Limita o tamanho. */
export function redact(message: unknown, max = 200): string {
  return String(message ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic [REDACTED]')
    .replace(/\b(re|sk|pk)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(AC|SK|HX|MG)[0-9a-fA-F]{32}\b/g, '[REDACTED]')
    .replace(/\bEA[A-Za-z0-9]{40,}\b/g, '[REDACTED]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(?:whatsapp:)?\+?\d[\d\s().-]{8,}\d/g, '[telefone]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Normaliza para E.164. Sem "+", assume Brasil (DDI 55) para números com 10 ou 11 dígitos. Devolve null se não for um número plausível. */
export function normalizePhone(raw: string): string | null {
  const t = String(raw ?? '').trim().replace(/^whatsapp:/i, '');
  if (!t) return null;
  const digits = t.replace(/\D/g, '');
  let e164: string;
  if (t.startsWith('+')) e164 = `+${digits}`;
  else if (digits.length === 10 || digits.length === 11) e164 = `+55${digits}`;
  else if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) e164 = `+${digits}`;
  else return null;
  return /^\+[1-9]\d{9,14}$/.test(e164) ? e164 : null;
}

/** "+55119****1234": só o início e o fim — para telas e registros. */
export function maskPhone(e164: string): string {
  const d = e164.replace(/\D/g, '');
  if (d.length < 8) return '[telefone]';
  return `+${d.slice(0, 4)}${'*'.repeat(Math.max(1, d.length - 8))}${d.slice(-4)}`;
}

export function parsePhoneList(raw: string | undefined): { valid: string[]; invalid: number } {
  const valid: string[] = [];
  let invalid = 0;
  for (const part of String(raw ?? '').split(',')) {
    if (!part.trim()) continue;
    const n = normalizePhone(part);
    if (n) {
      if (!valid.includes(n)) valid.push(n);
    } else invalid += 1;
  }
  return { valid, invalid };
}

/** Texto de SMS: ASCII (sem acento), uma linha, limitado. Evita dividir em vários segmentos e problemas de codificação. */
export function toSmsText(text: string, max = 300): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E\n]/g, ' ')
    .replace(/\s*\n\s*/g, ' | ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/** Parâmetro de modelo do WhatsApp: sem quebra de linha, sem tabulação e sem espaços repetidos (regras do modelo de mensagem), limitado. */
export function toTemplateParam(text: string, max = 900): string {
  return text.replace(/[\r\n\t]+/g, ' | ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Configuração (só lê variáveis de ambiente; nunca imprime valores)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface EmailConfig {
  configured: boolean;
  missing: string[];
  from: string | null;
  to: string[];
}

export function emailConfig(env: NodeJS.ProcessEnv): EmailConfig {
  const missing: string[] = [];
  if (!present(env.RESEND_API_KEY)) missing.push('RESEND_API_KEY');
  if (!present(env.ALERT_EMAIL_FROM)) missing.push('ALERT_EMAIL_FROM');
  if (!present(env.ALERT_EMAIL_TO)) missing.push('ALERT_EMAIL_TO');
  if (env.RESEND_DOMAIN_VERIFIED?.trim().toLowerCase() !== 'true') missing.push('RESEND_DOMAIN_VERIFIED=true');
  const to = present(env.ALERT_EMAIL_TO) ? env.ALERT_EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { configured: missing.length === 0, missing, from: present(env.ALERT_EMAIL_FROM) ? env.ALERT_EMAIL_FROM.trim() : null, to };
}

interface TwilioCreds {
  accountSid: string;
  user: string;
  secret: string;
}

function twilioCreds(env: NodeJS.ProcessEnv): { creds: TwilioCreds | null; missing: string[] } {
  const missing: string[] = [];
  if (!present(env.TWILIO_ACCOUNT_SID)) missing.push('TWILIO_ACCOUNT_SID');
  const apiKey = present(env.TWILIO_API_KEY_SID) && present(env.TWILIO_API_KEY_SECRET);
  const token = present(env.TWILIO_AUTH_TOKEN);
  if (!apiKey && !token) missing.push('TWILIO_AUTH_TOKEN (ou TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET)');
  if (missing.length) return { creds: null, missing };
  return {
    creds: { accountSid: env.TWILIO_ACCOUNT_SID!.trim(), user: apiKey ? env.TWILIO_API_KEY_SID!.trim() : env.TWILIO_ACCOUNT_SID!.trim(), secret: apiKey ? env.TWILIO_API_KEY_SECRET!.trim() : env.TWILIO_AUTH_TOKEN!.trim() },
    missing,
  };
}

export interface SmsConfig {
  configured: boolean;
  missing: string[];
  providers: string[];
  to: string[];
  invalidRecipients: number;
}

export function smsConfig(env: NodeJS.ProcessEnv): SmsConfig {
  const missing: string[] = [];
  const tw = twilioCreds(env);
  missing.push(...tw.missing);
  if (!present(env.ALERT_SMS_FROM) && !present(env.TWILIO_MESSAGING_SERVICE_SID)) missing.push('ALERT_SMS_FROM (ou TWILIO_MESSAGING_SERVICE_SID)');
  const list = parsePhoneList(env.ALERT_SMS_TO);
  if (list.valid.length === 0) missing.push(list.invalid ? 'ALERT_SMS_TO (nenhum número válido)' : 'ALERT_SMS_TO');
  // declaração explícita do operador: o remetente está registrado/autorizado para enviar SMS no Brasil (as operadoras bloqueiam remetente não registrado)
  if (env.ALERT_SMS_SENDER_VERIFIED?.trim().toLowerCase() !== 'true') missing.push('ALERT_SMS_SENDER_VERIFIED=true');
  return { configured: missing.length === 0, missing, providers: missing.length === 0 ? ['twilio'] : [], to: list.valid, invalidRecipients: list.invalid };
}

export interface WhatsappConfig {
  configured: boolean;
  /** Pendências por provedor (para a tela e a documentação). */
  missing: string[];
  /** Provedores prontos, na ordem de tentativa. */
  providers: Array<'meta' | 'twilio'>;
  to: string[];
  invalidRecipients: number;
}

export function whatsappConfig(env: NodeJS.ProcessEnv): WhatsappConfig {
  const order = (present(env.ALERT_WHATSAPP_PROVIDERS) ? env.ALERT_WHATSAPP_PROVIDERS : 'meta,twilio')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is 'meta' | 'twilio' => s === 'meta' || s === 'twilio');
  const ready: Array<'meta' | 'twilio'> = [];
  const missing: string[] = [];
  for (const p of order) {
    const gaps: string[] = [];
    if (p === 'meta') {
      if (!present(env.META_WHATSAPP_TOKEN)) gaps.push('META_WHATSAPP_TOKEN');
      if (!present(env.META_WHATSAPP_PHONE_NUMBER_ID)) gaps.push('META_WHATSAPP_PHONE_NUMBER_ID');
      if (!present(env.ALERT_WHATSAPP_TEMPLATE_NAME)) gaps.push('ALERT_WHATSAPP_TEMPLATE_NAME');
    } else {
      gaps.push(...twilioCreds(env).missing);
      if (!present(env.TWILIO_WHATSAPP_FROM)) gaps.push('TWILIO_WHATSAPP_FROM');
      if (!present(env.TWILIO_WHATSAPP_CONTENT_SID)) gaps.push('TWILIO_WHATSAPP_CONTENT_SID');
    }
    if (gaps.length === 0) ready.push(p);
    else missing.push(`${p}: ${gaps.join(', ')}`);
  }
  const list = parsePhoneList(env.ALERT_WHATSAPP_TO);
  if (list.valid.length === 0) missing.push(list.invalid ? 'ALERT_WHATSAPP_TO (nenhum número válido)' : 'ALERT_WHATSAPP_TO');
  // declaração explícita: o modelo de mensagem usado está APROVADO no provedor (mensagem iniciada pela empresa só pode usar modelo aprovado)
  const approved = env.ALERT_WHATSAPP_TEMPLATE_APPROVED?.trim().toLowerCase() === 'true';
  if (!approved) missing.push('ALERT_WHATSAPP_TEMPLATE_APPROVED=true');
  const ok = ready.length > 0 && list.valid.length > 0 && approved;
  return { configured: ok, missing: ok ? [] : missing, providers: ok ? ready : [], to: list.valid, invalidRecipients: list.invalid };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Chamada HTTP comum
// ---------------------------------------------------------------------------------------------------------------------------------------------

async function call(
  provider: string,
  url: string,
  init: RequestInit,
  deps: TransportDeps,
  extractId: (body: any) => string | undefined,
  extractError: (body: any) => string | undefined
): Promise<TransportResult> {
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* corpo sem JSON: vale só o status */
    }
    const apiError = extractError(body);
    if (res.ok && !apiError) return { ok: true, provider, httpStatus: res.status, providerMessageId: extractId(body), retryable: false };
    return {
      ok: false,
      provider,
      httpStatus: res.status,
      error: redact(`http_${res.status}${apiError ? `: ${apiError}` : ''}`),
      retryable: res.status === 429 || res.status >= 500,
    };
  } catch (error) {
    // rede caiu, DNS, TLS ou tempo esgotado: repetível
    return { ok: false, provider, error: redact(error instanceof Error ? `${error.name}: ${error.message}` : error), retryable: true };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Provedores
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface EmailMessage {
  subject: string;
  text: string;
  to?: string[];
  /** Chave de idempotência do provedor: a mesma chave não gera um segundo e-mail. */
  idempotencyKey: string;
}

export function sendEmailResend(env: NodeJS.ProcessEnv, msg: EmailMessage, deps: TransportDeps = {}): Promise<TransportResult> {
  const cfg = emailConfig(env);
  if (!cfg.configured) return Promise.resolve({ ok: false, provider: 'resend', error: 'not_configured', retryable: false });
  return call(
    'resend',
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY!.trim()}`, 'Content-Type': 'application/json', 'Idempotency-Key': msg.idempotencyKey },
      body: JSON.stringify({ from: cfg.from, to: msg.to && msg.to.length ? msg.to : cfg.to, subject: msg.subject, text: msg.text }),
    },
    deps,
    (b) => b?.id,
    (b) => (b && typeof b.message === 'string' ? b.message : undefined)
  );
}

function twilioForm(creds: TwilioCreds, params: Record<string, string>, provider: string, deps: TransportDeps) {
  return call(
    provider,
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${creds.user}:${creds.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    },
    deps,
    (b) => b?.sid,
    // a Twilio devolve `error_code`/`error_message` no corpo de erro (e `code`/`message` em respostas 4xx)
    (b) => (b && (b.error_code || (b.code && b.status >= 400)) ? String(b.error_message ?? b.message ?? b.error_code ?? b.code) : undefined)
  );
}

export function sendSmsTwilio(env: NodeJS.ProcessEnv, to: string, text: string, deps: TransportDeps = {}): Promise<TransportResult> {
  const tw = twilioCreds(env);
  if (!tw.creds) return Promise.resolve({ ok: false, provider: 'twilio', error: 'not_configured', retryable: false });
  const params: Record<string, string> = { To: to, Body: toSmsText(text) };
  if (present(env.TWILIO_MESSAGING_SERVICE_SID)) params.MessagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID.trim();
  else if (present(env.ALERT_SMS_FROM)) params.From = env.ALERT_SMS_FROM.trim();
  else return Promise.resolve({ ok: false, provider: 'twilio', error: 'not_configured', retryable: false });
  return twilioForm(tw.creds, params, 'twilio', deps);
}

export function sendWhatsappTwilio(env: NodeJS.ProcessEnv, to: string, text: string, deps: TransportDeps = {}): Promise<TransportResult> {
  const tw = twilioCreds(env);
  if (!tw.creds || !present(env.TWILIO_WHATSAPP_FROM) || !present(env.TWILIO_WHATSAPP_CONTENT_SID)) return Promise.resolve({ ok: false, provider: 'twilio-whatsapp', error: 'not_configured', retryable: false });
  const wa = (n: string) => (n.toLowerCase().startsWith('whatsapp:') ? n : `whatsapp:${n}`);
  return twilioForm(
    tw.creds,
    { To: wa(to), From: wa(env.TWILIO_WHATSAPP_FROM.trim()), ContentSid: env.TWILIO_WHATSAPP_CONTENT_SID.trim(), ContentVariables: JSON.stringify({ '1': toTemplateParam(text) }) },
    'twilio-whatsapp',
    deps
  );
}

export function sendWhatsappMeta(env: NodeJS.ProcessEnv, to: string, text: string, deps: TransportDeps = {}): Promise<TransportResult> {
  if (!present(env.META_WHATSAPP_TOKEN) || !present(env.META_WHATSAPP_PHONE_NUMBER_ID) || !present(env.ALERT_WHATSAPP_TEMPLATE_NAME)) {
    return Promise.resolve({ ok: false, provider: 'meta-whatsapp', error: 'not_configured', retryable: false });
  }
  const version = present(env.META_WHATSAPP_API_VERSION) ? env.META_WHATSAPP_API_VERSION.trim() : 'v23.0';
  return call(
    'meta-whatsapp',
    `https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(env.META_WHATSAPP_PHONE_NUMBER_ID.trim())}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.META_WHATSAPP_TOKEN.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: env.ALERT_WHATSAPP_TEMPLATE_NAME.trim(),
          language: { code: present(env.ALERT_WHATSAPP_TEMPLATE_LANG) ? env.ALERT_WHATSAPP_TEMPLATE_LANG.trim() : 'pt_BR' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: toTemplateParam(text) }] }],
        },
      }),
    },
    deps,
    (b) => b?.messages?.[0]?.id,
    (b) => (b?.error ? String(b.error.message ?? b.error.code ?? 'erro') : undefined)
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Tentativas controladas e provedor alternativo
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface ProviderAttempt {
  provider: string;
  run: () => Promise<TransportResult>;
}

export interface FailoverOptions {
  /** Tentativas por provedor para falha repetível (padrão 2). Erro não repetível passa direto ao próximo provedor. */
  attemptsPerProvider?: number;
  /** Esperas entre tentativas do MESMO provedor, em ms (padrão 1000, 3000). */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

/** Tenta cada provedor na ordem, repetindo só falhas repetíveis, e para no primeiro aceito. Devolve também todas as tentativas (para o registro). */
export async function sendWithFailover(attempts: ProviderAttempt[], opts: FailoverOptions = {}): Promise<{ result: TransportResult; tried: TransportResult[] }> {
  const per = Math.max(1, opts.attemptsPerProvider ?? 2);
  const backoff = opts.backoffMs ?? [1000, 3000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tried: TransportResult[] = [];
  if (attempts.length === 0) {
    const none: TransportResult = { ok: false, provider: 'none', error: 'no_provider_configured', retryable: false };
    return { result: none, tried: [none] };
  }
  let last: TransportResult = { ok: false, provider: 'none', error: 'no_attempt', retryable: false };
  for (const a of attempts) {
    for (let i = 0; i < per; i++) {
      last = await a.run();
      tried.push(last);
      if (last.ok) return { result: last, tried };
      if (!last.retryable) break;
      if (i < per - 1) await sleep(backoff[Math.min(i, backoff.length - 1)] ?? 1000);
    }
  }
  return { result: last, tried };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Mensagem (texto único para os três canais)
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type IncidentPhase = 'OPEN' | 'ESCALATED' | 'RECOVERED' | 'REMINDER';

export interface IncidentMessageInput {
  phase: IncidentPhase;
  severity: string;
  /** Nome legível do alvo, ex.: "API" ou "empresa X". */
  target: string;
  /** Tipo técnico, ex.: EXTERNAL_API_DOWN. */
  type: string;
  detail?: string | null;
  since?: Date | null;
  /** Duração do incidente (só na recuperação), em ms. */
  durationMs?: number | null;
  /** Origem da medição, ex.: "monitor externo" ou "central". */
  source: string;
  panelUrl?: string | null;
}

const PHASE_LABEL: Record<IncidentPhase, string> = { OPEN: 'Novo alerta', ESCALATED: 'Alerta agravado', RECOVERED: 'RECUPERADO', REMINDER: 'Alerta ainda aberto' };

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Mensagem curta e sem dado sensível (nada de segredo, e-mail ou telefone): tipo, alvo, desde quando e orientação para abrir o painel. */
export function composeIncidentMessage(i: IncidentMessageInput): { subject: string; text: string } {
  const label = PHASE_LABEL[i.phase];
  const lines = [
    `${label}: ${i.severity} — ${i.target} (${i.type})`,
    i.detail ? `Detalhe: ${i.detail}` : null,
    i.since ? `Desde: ${i.since.toISOString().replace('T', ' ').slice(0, 16)} UTC` : null,
    i.phase === 'RECOVERED' && i.durationMs != null ? `Duração: ${formatDuration(i.durationMs)}` : null,
    `Origem da medição: ${i.source}`,
    i.panelUrl ? `Painel: ${i.panelUrl}` : null,
  ].filter((l): l is string => l !== null);
  return { subject: `[CÓRTEX] ${label} · ${i.severity} · ${i.target}`, text: lines.join('\n') };
}
