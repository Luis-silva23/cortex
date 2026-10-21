/**
 * ESTADO DOS SERVIÇOS EXTERNOS para a Central (Sentry, Resend, banco, domínio/HTTPS, Figma) — só LEITURA de configuração e dos resumos de entrega. NUNCA devolve valor de segredo:
 * só "configurado ou não", o host/domínio (que não é segredo) e contagens. "Configurado" quer dizer que as variáveis existem, não que a conexão foi testada: o que não foi testado
 * é dito como tal. Nada aqui contrata, liga ou altera serviço.
 */
import { sentryConfigStatus, sentryRuntime } from './sentry.service';
import { breakerState, resendConfig } from './resend.service';
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
  const [effective, emailD, sentryD] = await Promise.all([getEffective(env), deliverySummary('EMAIL', now), deliverySummary('SENTRY', now)]);
  const resend = resendConfig(env);
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
    resend: {
      configured: resend.configured,
      state: !resend.configured ? 'PENDING_CONFIGURATION' : effective.toggles.emailNotifications ? 'ACTIVE' : 'DISABLED',
      missing: resend.missing,
      senderDomain: resend.domain,
      recipients: resend.to.length,
      enabled: effective.toggles.emailNotifications,
      limits: { perHour: effective.limits.emailMaxPerHour, perDay: effective.limits.emailMaxPerDay, perMonth: effective.limits.emailMaxPerMonth, dedupeMinutes: effective.limits.emailDedupeMinutes },
      consumption: emailD,
      breaker: breakerState(),
      note: 'Só envia com chave, remetente em domínio VERIFICADO, destinatários e RESEND_DOMAIN_VERIFIED=true. O plano gratuito do provedor tem limite diário e mensal próprios (na última consulta: 100/dia e 3 mil/mês, 1 domínio); no limite a Central SUPRIME o envio, nunca contrata plano.',
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
