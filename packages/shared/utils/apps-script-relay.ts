/**
 * CLIENTE do relé de notificações em Google Apps Script (`integrations/google-apps-script/`). Funções PURAS (sem banco, sem log, `fetch` injetável), usadas pela API e pelo monitor.
 *
 * Contrato (idêntico ao de `Security.gs`): o `doPost` do Apps Script não lê cabeçalhos HTTP, então tudo que precisa ser assinado vai no CORPO:
 *   { v:1, ts:<segundos>, id:<único>, channel:'email'|'sms'|'whatsapp', payload:<JSON em TEXTO>, sig:<hex> }
 *   sig = HMAC-SHA256(APPS_SCRIPT_SECRET, `${v}\n${ts}\n${id}\n${channel}\n${payload}`)
 * Resposta (sempre HTTP 200 com JSON): { ok, status: sent|duplicate|rate_limited|not_configured|failed|unauthorized|invalid_request|dry_run, detail?, retryable?, ambiguous? }
 *
 * Vocabulário: `ok:true` = o script ACEITOU e o provedor aceitou (ou o envio já havia sido aceito: duplicate). `dry_run` NUNCA conta como enviado.
 * Nada aqui devolve texto vindo do servidor remoto em mensagens de erro: só códigos de um conjunto fechado (não há o que mascarar nem vazar).
 * Desligado por padrão: sem APPS_SCRIPT_CHANNELS nada muda no comportamento existente.
 */
import crypto from 'crypto';

export type RelayChannel = 'email' | 'sms' | 'whatsapp';
const CHANNELS: RelayChannel[] = ['email', 'sms', 'whatsapp'];

export interface RelayTransportResult {
  ok: boolean;
  provider: string;
  providerMessageId?: string;
  httpStatus?: number;
  error?: string;
  retryable: boolean;
}

export interface RelayDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  nowMs?: () => number;
}

const present = (v: string | undefined): v is string => typeof v === 'string' && v.trim().length > 0;
const DEFAULT_TIMEOUT_MS = 20_000; // o Apps Script leva alguns segundos para responder (partida a frio)

/** Só a URL de implantação oficial de um web app do Apps Script: `/macros/s/<id>/exec` ou, em conta Workspace, `/a/macros/<domínio>/s/<id>/exec`. */
const URL_RE = /^https:\/\/script\.google\.com\/(?:macros|a\/macros\/[A-Za-z0-9.-]+)\/s\/[A-Za-z0-9_-]{20,}\/exec$/;

export interface RelayConfig {
  /** Canais que o operador mandou usar pelo relé (APPS_SCRIPT_CHANNELS). Vazio = relé desligado. */
  channels: RelayChannel[];
  /** URL e segredo válidos? */
  urlOk: boolean;
  secretOk: boolean;
  /** Pronto para o canal = o canal foi pedido E URL E segredo estão válidos. */
  readyFor: Record<RelayChannel, boolean>;
  /** Pendências (nomes de variáveis; nunca valores). Vazio quando o relé está desligado. */
  missing: string[];
  /** Host (nunca o caminho, que contém o identificador da implantação). */
  host: string | null;
}

export function relayConfig(env: NodeJS.ProcessEnv): RelayConfig {
  const channels = (present(env.APPS_SCRIPT_CHANNELS) ? env.APPS_SCRIPT_CHANNELS : '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s, i, a): s is RelayChannel => (CHANNELS as string[]).includes(s) && a.indexOf(s) === i);
  const url = present(env.APPS_SCRIPT_URL) ? env.APPS_SCRIPT_URL.trim() : '';
  const urlOk = URL_RE.test(url);
  const secretOk = present(env.APPS_SCRIPT_SECRET) && env.APPS_SCRIPT_SECRET.trim().length >= 32;
  const missing: string[] = [];
  if (channels.length > 0) {
    if (!url) missing.push('APPS_SCRIPT_URL');
    else if (!urlOk) missing.push('APPS_SCRIPT_URL (endereço inválido: use a URL /exec do aplicativo da web)');
    if (!secretOk) missing.push('APPS_SCRIPT_SECRET (mínimo 32 caracteres)');
  }
  const ready = (c: RelayChannel) => channels.includes(c) && urlOk && secretOk;
  return { channels, urlOk, secretOk, readyFor: { email: ready('email'), sms: ready('sms'), whatsapp: ready('whatsapp') }, missing, host: urlOk ? 'script.google.com' : null };
}

/** Identificador único e ESTÁVEL por mensagem+destinatário (a repetição da mesma notificação gera o mesmo id; o script a recusa como duplicate). */
export function makeRelayId(parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40);
}

export function buildRelayBody(secret: string, input: { id: string; channel: RelayChannel; payload: Record<string, unknown>; nowMs: number }): string {
  const payload = JSON.stringify(input.payload);
  const ts = Math.floor(input.nowMs / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`1\n${ts}\n${input.id}\n${input.channel}\n${payload}`).digest('hex');
  return JSON.stringify({ v: 1, ts, id: input.id, channel: input.channel, payload, sig });
}

const ok = (id: string, httpStatus: number): RelayTransportResult => ({ ok: true, provider: 'apps-script', providerMessageId: id, httpStatus, retryable: false });
const fail = (error: string, retryable: boolean, httpStatus?: number): RelayTransportResult => ({ ok: false, provider: 'apps-script', error, httpStatus, retryable });

/** Traduz a resposta do script para o resultado de transporte. Qualquer coisa fora do contrato é falha (nunca sucesso presumido). */
export function mapRelayResponse(httpStatus: number, text: string, id: string): RelayTransportResult {
  if (httpStatus === 429 || httpStatus >= 500) return fail(`apps_script_http_${httpStatus}`, true, httpStatus);
  if (httpStatus < 200 || httpStatus >= 300) return fail(`apps_script_http_${httpStatus}`, false, httpStatus);
  let body: { ok?: unknown; status?: unknown; detail?: unknown; retryable?: unknown } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  // 200 com HTML (página de login do Google quando a implantação não é pública, página de erro) não é uma resposta do relé
  if (!body || typeof body !== 'object' || typeof body.status !== 'string') return fail('apps_script_unexpected_response', false, httpStatus);
  const detail = typeof body.detail === 'string' ? body.detail.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) : '';
  switch (body.status) {
    case 'sent':
      return ok(id, httpStatus);
    case 'duplicate':
      return ok(id, httpStatus); // já aceito numa tentativa anterior: não é falha e NÃO deve ser reenviado
    case 'dry_run':
      return fail('apps_script_dry_run', false, httpStatus); // modo de teste do script: NADA foi enviado
    case 'rate_limited':
      return fail(`apps_script_rate_limited${detail ? `_${detail}` : ''}`, false, httpStatus);
    case 'not_configured':
      return fail(`apps_script_not_configured${detail ? `_${detail}` : ''}`, false, httpStatus);
    case 'unauthorized':
      return fail('apps_script_unauthorized', false, httpStatus);
    case 'invalid_request':
      return fail(`apps_script_invalid_request${detail ? `_${detail}` : ''}`, false, httpStatus);
    case 'failed':
      return fail(`apps_script_failed${detail ? `_${detail}` : ''}`, body.retryable === true, httpStatus);
    default:
      return fail('apps_script_unexpected_response', false, httpStatus);
  }
}

export async function sendViaAppsScript(env: NodeJS.ProcessEnv, input: { channel: RelayChannel; id: string; payload: Record<string, unknown> }, deps: RelayDeps = {}): Promise<RelayTransportResult> {
  const cfg = relayConfig(env);
  if (!cfg.readyFor[input.channel]) return fail('not_configured', false);
  const body = buildRelayBody(env.APPS_SCRIPT_SECRET!.trim(), { ...input, nowMs: (deps.nowMs ?? Date.now)() });
  try {
    const res = await (deps.fetchImpl ?? fetch)(env.APPS_SCRIPT_URL!.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      redirect: 'follow', // o /exec responde com um redirecionamento para o resultado
      // prazo mínimo de 15 s: o Apps Script tem partida a frio e o prazo curto dos outros provedores (5 s) geraria falsos "tempo esgotado"
      signal: AbortSignal.timeout(Math.max(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15_000)),
    });
    const text = await res.text().catch(() => '');
    return mapRelayResponse(res.status, text.slice(0, 4000), input.id);
  } catch (error) {
    // rede caiu / tempo esgotado: o script PODE ter executado; a repetição com o MESMO id volta como `duplicate` (sem reenviar)
    return fail(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'apps_script_timeout' : 'apps_script_network', true);
  }
}
