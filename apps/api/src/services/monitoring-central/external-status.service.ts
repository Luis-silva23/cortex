/**
 * ESTADO DOS SERVIÇOS EXTERNOS para a Central (Sentry, Resend, banco, domínio/HTTPS, Figma) — só LEITURA de configuração e dos resumos de entrega. NUNCA devolve valor de segredo:
 * só "configurado ou não", o host/domínio (que não é segredo) e contagens. "Configurado" quer dizer que as variáveis existem, não que a conexão foi testada: o que não foi testado
 * é dito como tal. Nada aqui contrata, liga ou altera serviço.
 */
import { emailConfig } from '@ln-system/shared/utils/alert-channels';
import { relayConfig } from '@ln-system/shared/utils/apps-script-relay';
import { sentryConfigStatus, sentryRuntime } from './sentry.service';
import { breakerState, resendConfig } from './resend.service';
import { smsBreaker, smsConfig } from './sms.service';
import { whatsappBreaker, whatsappConfig } from './whatsapp.service';
import { deliverySummary } from './deliveries';
import { getEffective, envRetention } from './settings.service';

export function databaseTarget(url: string | undefined) {
  if (!url) return { configured: false, kind: null as string | null, host: null as string | null, port: null as string | null, usesPooler: null as boolean | null, sslmode: null as string | null };
  try {
    const u = new URL(url);
    const host = u.hostname;
    const port = u.port || '5432';
    const kind = /(^|\.)supabase\.(co|com)$/.test(host) || host.includes('pooler.supabase') ? 'supabase' : ['localhost', '127.0.0.1', '::1', 'postgres'].includes(host) ? 'local' : 'other';
    return { configured: true, kind, host, port, usesPooler: port === '6543' || host.includes('pooler.') || u.searchParams.get('pgbouncer') === 'true', sslmode: u.searchParams.get('sslmode') };
  } catch {
    return { configured: true, kind: 'invalid', host: null, port: null, usesPooler: null, sslmode: null };
  }
}

export function domainReadiness(env: NodeJS.ProcessEnv = process.env) {
  const entries = ['WEB_URL', 'SUPER_ADMIN_URL', 'BALCAO_URL', 'API_ORIGIN'].map((key) => {
    const raw = env[key]?.trim();
    if (!raw) return { key, set: false, host: null as string | null, https: null as boolean | null, local: null as boolean | null };
    try {
      const u = new URL(raw);
      return { key, set: true, host: u.hostname, https: u.protocol === 'https:', local: ['localhost', '127.0.0.1', '::1'].includes(u.hostname) };
    } catch {
      return { key, set: true, host: null, https: null, local: null };
    }
  });
  return {
    entries,
    trustProxySet: Boolean(env.TRUST_PROXY?.trim()),
    productionReady: entries.every((e) => e.set && e.https === true && e.local === false) && Boolean(env.TRUST_PROXY?.trim()),
    note: 'Domínio, DNS, HTTPS e proteção de tráfego (ex.: Cloudflare) são externos à aplicação e não são verificáveis daqui: a aplicação só lê os endereços por variável de ambiente (nenhum domínio fixo no código).',
  };
}

export async function externalStatus(env: NodeJS.ProcessEnv = process.env, now = new Date()) {
  const [effective, emailD, sentryD, smsD, whatsappD] = await Promise.all([
    getEffective(env),
    deliverySummary('EMAIL', now),
    deliverySummary('SENTRY', now),
    deliverySummary('SMS', now),
    deliverySummary('WHATSAPP', now),
  ]);
  const resend = resendConfig(env);
  // e-mail "pronto" = qualquer provedor (Resend e/ou relé do Apps Script); o bloco `resend` descreve o CANAL de e-mail
  const email = emailConfig(env);
  const relay = relayConfig(env);
  const sms = smsConfig(env);
  const whatsapp = whatsappConfig(env);
  const sentry = sentryConfigStatus(env);
  const retention = envRetention(env);
  return {
    generatedAt: now.toISOString(),
    sentry: {
      ...sentry,
      state: !sentry.configured ? (sentry.invalidDsn ? 'INVALID' : 'PENDING_CONFIGURATION') : effective.toggles.sentry ? 'ACTIVE' : 'DISABLED',
      enabled: effective.toggles.sentry,
      sampleRate: effective.limits.sentrySampleRate,
      limits: { perHour: effective.limits.sentryMaxPerHour, perDay: effective.limits.sentryMaxPerDay, dedupeMinutes: effective.limits.sentryDedupeMinutes },
      consumption: sentryD,
      runtime: sentryRuntime(),
      note: 'Sem SENTRY_DSN nada é enviado. O plano gratuito do provedor tem limite mensal próprio (na última consulta: 5 mil erros/mês, 1 usuário — confira a página de preços antes de ligar); a Central limita por hora/dia e amostra os erros.',
    },
    // Relé de notificações em Google Apps Script: só mostra o ESTADO (nunca a URL de implantação, que carrega o identificador, nem o segredo). Desligado por padrão.
    appsScript: {
      enabledChannels: relay.channels,
      ready: relay.readyFor,
      state: relay.channels.length === 0 ? 'OFF' : relay.urlOk && relay.secretOk ? 'READY_UNTESTED' : 'PENDING_CONFIGURATION',
      missing: relay.missing,
      host: relay.host,
      note: 'Estado de configuração apenas: o relé NÃO foi publicado nem testado no Google por este sistema. Antes de confiar nele, faça o autoteste em modo simulado e um envio real controlado.',
    },
    resend: {
      configured: email.configured,
      providers: email.providers,
      state: !email.configured ? 'PENDING_CONFIGURATION' : effective.toggles.emailNotifications ? 'ACTIVE' : 'DISABLED',
      missing: email.missing,
      senderDomain: resend.domain,
      recipients: email.to.length,
      enabled: effective.toggles.emailNotifications,
      limits: { perHour: effective.limits.emailMaxPerHour, perDay: effective.limits.emailMaxPerDay, perMonth: effective.limits.emailMaxPerMonth, dedupeMinutes: effective.limits.emailDedupeMinutes },
      consumption: emailD,
      breaker: breakerState(),
      note: 'Só envia com chave, remetente em domínio VERIFICADO, destinatários e RESEND_DOMAIN_VERIFIED=true. O plano gratuito do provedor tem limite diário e mensal próprios (na última consulta: 100/dia e 3 mil/mês, 1 domínio); no limite a Central SUPRIME o envio, nunca contrata plano.',
    },
    sms: {
      configured: sms.configured,
      state: !sms.configured ? 'PENDING_CONFIGURATION' : effective.toggles.smsNotifications ? 'ACTIVE' : 'DISABLED',
      missing: sms.missing,
      providers: sms.providers,
      recipients: sms.to.length,
      invalidRecipients: sms.invalidRecipients,
      enabled: effective.toggles.smsNotifications,
      limits: { perHour: effective.limits.smsMaxPerHour, perDay: effective.limits.smsMaxPerDay, perMonth: effective.limits.smsMaxPerMonth, dedupeMinutes: effective.limits.smsDedupeMinutes },
      consumption: smsD,
      breaker: smsBreaker.state(),
      note: 'Provedor: Twilio. Só envia com credenciais, remetente, números válidos e ALERT_SMS_SENDER_VERIFIED=true (remetente registrado para o Brasil). "Enviado" = aceito pelo provedor; a confirmação de entrega no aparelho não é lida.',
    },
    whatsapp: {
      configured: whatsapp.configured,
      state: !whatsapp.configured ? 'PENDING_CONFIGURATION' : effective.toggles.whatsappNotifications ? 'ACTIVE' : 'DISABLED',
      missing: whatsapp.missing,
      providers: whatsapp.providers,
      recipients: whatsapp.to.length,
      invalidRecipients: whatsapp.invalidRecipients,
      enabled: effective.toggles.whatsappNotifications,
      limits: { perHour: effective.limits.whatsappMaxPerHour, perDay: effective.limits.whatsappMaxPerDay, perMonth: effective.limits.whatsappMaxPerMonth, dedupeMinutes: effective.limits.whatsappDedupeMinutes },
      consumption: whatsappD,
      breaker: whatsappBreaker.state(),
      note: 'Integração oficial: Meta WhatsApp Cloud API ou Twilio (parceiro autorizado), com modelo de mensagem APROVADO (ALERT_WHATSAPP_TEMPLATE_APPROVED=true). "Enviado" = aceito pelo provedor; entrega/leitura não são lidas.',
    },
    database: { ...databaseTarget(env.DATABASE_URL), note: 'Detecção só pelo endereço configurado. A análise de compatibilidade com Supabase (papéis, RLS, pooler, migrações) está em PRODUCAO.md; nada foi migrado.' },
    domain: domainReadiness(env),
    figma: { configured: false, note: 'Não há arquivo, link ou token Figma no projeto nem conector Figma disponível nesta sessão: os tokens visuais vêm do repositório (docs/CORTEX/VISUAL_REFERENCES.md). Dependência externa pendente: o link do arquivo oficial.' },
    costControls: {
      toggles: effective.toggles,
      limits: effective.limits,
      envCeilings: effective.env,
      overridden: effective.overridden,
      retentionDays: retention,
      note: 'O ambiente é o teto: o ajuste da tela só restringe. Nenhum serviço é contratado nem autorizado a gerar excedente automaticamente.',
    },
  };
}
