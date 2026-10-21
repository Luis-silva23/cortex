/**
 * MODELO PURO da Central de Monitoramento (sem banco, sem rede): fórmulas e classificações que a tela e a API compartilham. Cada indicador tem aqui a sua
 * DEFINIÇÃO escrita — a tela mostra o texto de `INDICATOR_DEFINITIONS` ao lado do número, para ninguém confundir medição, estimativa e falta de dado.
 */
import type { HealthStatus } from '../health-status';

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Definições dos indicadores (mostradas na tela)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const INDICATOR_DEFINITIONS = {
  availability:
    'Disponibilidade = amostras sem estado OFFLINE ÷ amostras coletadas no período. Medida pelo coletor da própria plataforma (uma amostra a cada intervalo configurado). ' +
    'Intervalo SEM amostra é "lacuna": não conta como disponível nem como indisponível e reduz a cobertura (cobertura = amostras ÷ amostras esperadas).',
  apiLatency: 'Latência p95 da API = percentil 95 da duração das requisições registradas (request_logs) no período. Sem requisição no período: sem dado.',
  errorRate: 'Taxa de erros = requisições com status 5xx ÷ requisições registradas no período (4xx é erro do cliente e não entra).',
  integrationHealth:
    'Saúde das integrações = (saudáveis + ½ × degradadas) ÷ (saudáveis + degradadas + com erro). Só entram integrações ATIVAS e VERIFICADAS (conexão testada). ' +
    'Não configurada, não verificada e desativada ficam fora da conta e são mostradas à parte; sem nenhuma verificada, o resultado é "sem dados" — nunca 100%.',
  companies: 'Ativa = empresa ativa, com licença ativa e ao menos um acesso de usuário. Em implantação = empresa ativa sem licença ativa ou sem nenhum acesso ainda. Suspensa = empresa inativa.',
  backup:
    'Criado = existe backup com manifesto. Verificado = a verificação periódica do serviço de backup (hash + leitura do conteúdo) terminou OK. ' +
    'Restauração testada = só vale com registro de ensaio de restauração; não é inferida de arquivo existente.',
  funnel: 'Funil = oportunidades registradas no módulo comercial. Conversão entre etapas = oportunidades que chegaram à etapa seguinte ÷ as que chegaram à etapa anterior.',
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Disponibilidade
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type SampleLike = { status: string };

export function availability(samples: SampleLike[], expected: number) {
  const n = samples.length;
  const down = samples.filter((s) => s.status === 'OFFLINE').length;
  return {
    samples: n,
    down,
    availabilityPct: n === 0 ? null : Math.round(((n - down) / n) * 10_000) / 100,
    coveragePct: expected > 0 ? Math.min(100, Math.round((n / expected) * 10_000) / 100) : null,
  };
}

/** Dado desatualizado: a última amostra é mais velha que `factor` vezes o intervalo de coleta. Sem amostra, não há dado recente (devolve true). */
export function isStale(lastAt: Date | null, now: Date, intervalMs: number, factor = 3): boolean {
  if (!lastAt) return true;
  return now.getTime() - lastAt.getTime() > intervalMs * factor;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Ciclo de vida da empresa (calculado de dados reais)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type CompanyLifecycle = 'ACTIVE' | 'ONBOARDING' | 'SUSPENDED';

export function companyLifecycle(input: { isActive: boolean; hasActiveLicense: boolean; hasEverLoggedIn: boolean }): CompanyLifecycle {
  if (!input.isActive) return 'SUSPENDED';
  return input.hasActiveLicense && input.hasEverLoggedIn ? 'ACTIVE' : 'ONBOARDING';
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Integrações por empresa
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type IntegrationState = 'HEALTHY' | 'DEGRADED' | 'ERROR' | 'NOT_VERIFIED' | 'NOT_CONFIGURED' | 'DISABLED';

export interface IntegrationItem {
  key: string;
  kind: 'CHANNEL' | 'FISCAL' | 'PAYMENT';
  label: string;
  state: IntegrationState;
  reason: string;
}

export interface ChannelInput {
  id: string;
  name: string;
  provider: string | null;
  isActive: boolean;
  connectionStatus: 'NOT_CONFIGURED' | 'UNVALIDATED' | 'CONNECTED' | 'ERROR';
  lastSyncAt: Date | null;
  /** Entregas da caixa de saída que chegaram a DEAD nas últimas 24 h. */
  deadOutbox24h: number;
}

export interface IntegrationInputs {
  channels: ChannelInput[];
  fiscal: { branchesConfigured: number; fiscalEnabled: number; withCertificate: number };
  /** Existe provedor de pagamento automático (TEF/PSP) configurado? Hoje só há o provedor manual. */
  automaticPaymentProvider: boolean;
}

export function classifyChannel(c: ChannelInput): IntegrationItem {
  const base = { key: `channel:${c.id}`, kind: 'CHANNEL' as const, label: `${c.name}${c.provider ? ` (${c.provider})` : ''}` };
  if (!c.isActive) return { ...base, state: 'DISABLED', reason: 'canal desativado' };
  switch (c.connectionStatus) {
    case 'NOT_CONFIGURED':
      return { ...base, state: 'NOT_CONFIGURED', reason: 'sem credenciais configuradas' };
    case 'UNVALIDATED':
      return { ...base, state: 'NOT_VERIFIED', reason: 'credenciais salvas, conexão ainda não testada' };
    case 'ERROR':
      return { ...base, state: 'ERROR', reason: 'o último teste/sincronização de conexão falhou' };
    case 'CONNECTED':
      return c.deadOutbox24h > 0
        ? { ...base, state: 'DEGRADED', reason: `${c.deadOutbox24h} entrega(s) esgotaram as tentativas nas últimas 24 h` }
        : { ...base, state: 'HEALTHY', reason: 'conexão testada e sem entregas esgotadas nas últimas 24 h' };
  }
}

/** Itens de integração da empresa: canais reais + fiscal + pagamento (sempre listados, para a tela mostrar a verdade sobre o que NÃO existe). */
export function classifyIntegrations(input: IntegrationInputs): IntegrationItem[] {
  const items: IntegrationItem[] = input.channels.map(classifyChannel);
  const f = input.fiscal;
  items.push(
    f.fiscalEnabled === 0
      ? { key: 'fiscal', kind: 'FISCAL', label: 'Emissão fiscal', state: 'NOT_CONFIGURED', reason: f.branchesConfigured === 0 ? 'nenhuma filial configurou emissão fiscal' : 'emissão fiscal desligada em todas as filiais' }
      : f.withCertificate < f.fiscalEnabled
        ? { key: 'fiscal', kind: 'FISCAL', label: 'Emissão fiscal', state: 'NOT_CONFIGURED', reason: 'emissão habilitada em filial sem certificado' }
        : { key: 'fiscal', kind: 'FISCAL', label: 'Emissão fiscal', state: 'NOT_VERIFIED', reason: 'configurada, mas não há provedor fiscal com verificação ativa nesta versão' }
  );
  items.push(
    input.automaticPaymentProvider
      ? { key: 'payment', kind: 'PAYMENT', label: 'Pagamentos automáticos', state: 'NOT_VERIFIED', reason: 'provedor configurado, sem verificação ativa' }
      : { key: 'payment', kind: 'PAYMENT', label: 'Pagamentos automáticos', state: 'NOT_CONFIGURED', reason: 'provedor manual: o operador confirma o recebimento (sem integração automática)' }
  );
  return items;
}

export function integrationSummary(items: IntegrationItem[]) {
  const count = (s: IntegrationState) => items.filter((i) => i.state === s).length;
  const healthy = count('HEALTHY');
  const degraded = count('DEGRADED');
  const error = count('ERROR');
  const verified = healthy + degraded + error;
  return {
    healthy,
    degraded,
    error,
    notVerified: count('NOT_VERIFIED'),
    notConfigured: count('NOT_CONFIGURED'),
    disabled: count('DISABLED'),
    verified,
    healthPct: verified === 0 ? null : Math.round(((healthy + 0.5 * degraded) / verified) * 1000) / 10,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Alertas: categoria, estado exposto, transições e orientação
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type AlertCategory = 'DATABASE' | 'REDIS' | 'QUEUES' | 'API' | 'HOST' | 'NETWORK' | 'DEVICE' | 'BACKUP' | 'INTEGRATION' | 'NOTIFICATION' | 'OTHER';
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'RESOLVED';

export function alertCategory(type: string): AlertCategory {
  if (type.startsWith('DATABASE')) return 'DATABASE';
  if (type.startsWith('REDIS')) return 'REDIS';
  if (type.startsWith('QUEUE') || type.startsWith('JOB_')) return 'QUEUES';
  if (type.startsWith('API_')) return 'API';
  if (type.startsWith('HOST_') || type.startsWith('SERVER_')) return 'HOST';
  if (type.startsWith('NETWORK')) return 'NETWORK';
  if (type.startsWith('DEVICE')) return 'DEVICE';
  if (type.startsWith('BACKUP')) return 'BACKUP';
  if (type.startsWith('INTEGRATION')) return 'INTEGRATION';
  if (type.startsWith('NOTIFICATION') || type.startsWith('EMAIL') || type.startsWith('SENTRY')) return 'NOTIFICATION';
  return 'OTHER';
}

/** Estado exposto: encerrado (`endedAt`) é RESOLVIDO; aberto usa o tratamento humano registrado. */
export function alertStatus(a: { endedAt: Date | null; handling: string }): AlertStatus {
  if (a.endedAt) return 'RESOLVED';
  return a.handling === 'ACKNOWLEDGED' || a.handling === 'IN_PROGRESS' ? a.handling : 'OPEN';
}

export type AlertAction = 'ACKNOWLEDGE' | 'ASSIGN' | 'START' | 'RESOLVE' | 'REOPEN' | 'NOTE';

/** Valida a ação sobre o estado atual. Devolve o motivo da recusa ou null. NOTE vale em qualquer estado. */
export function actionRefusal(status: AlertStatus, action: AlertAction): string | null {
  if (action === 'NOTE') return null;
  if (status === 'RESOLVED') return action === 'REOPEN' ? null : 'alerta já resolvido: reabra para tratá-lo de novo';
  if (action === 'REOPEN') return 'só um alerta resolvido pode ser reaberto';
  if (action === 'ACKNOWLEDGE' && status !== 'OPEN') return 'alerta já foi reconhecido';
  if (action === 'START' && status === 'IN_PROGRESS') return 'alerta já está em tratamento';
  return null;
}

const GUIDANCE: Array<[RegExp, string]> = [
  [/^DATABASE/, 'Confira se o PostgreSQL está de pé e aceitando conexões (pg_isready), o uso de conexões (pg_stat_activity) e consultas longas. Se a latência subiu junto com a carga, veja índices e o disco do servidor.'],
  [/^REDIS/, 'Confira se o Redis responde (PING) e a memória usada. Sem Redis a API continua, mas sessões, filas e limites de requisição degradam: restaure o serviço antes de reiniciar a API.'],
  [/^QUEUE_WORKER_DOWN/, 'Há worker parado: reinicie a API (os workers sobem com ela) e confira o log de partida. Jobs enfileirados não se perdem.'],
  [/^QUEUE|^JOB_/, 'Veja a tela Jobs: falhas recentes por fila e atrasos. Falha repetida costuma ser dependência externa ou dado inválido; atraso, worker lento ou parado.'],
  [/^API_LATENCY/, 'Veja Performance: rotas mais lentas no período. Compare com a latência do banco; pico isolado após deploy sugere consulta nova sem índice.'],
  [/^API_ERRORS/, 'Veja Logs › Requisições com status 5xx e o requestId do erro. Erro concentrado em uma rota aponta para a mudança mais recente nela.'],
  [/^HOST_|^SERVER_/, 'Uso alto do servidor: identifique o processo (CPU/RAM) ou o que ocupa disco (logs, backups, WAL). Disco acima de 95% pode parar o banco: libere espaço antes de tudo.'],
  [/^NETWORK/, 'Rede entre o equipamento e a API: confira a conexão local da filial e o endereço do servidor configurado no equipamento.'],
  [/^DEVICE/, 'Equipamento sem contato: confira energia, internet e se o aplicativo está aberto. Se foi desligado de propósito, desative o equipamento.'],
  [/^BACKUP_VERIFY/, 'A verificação do backup falhou: NÃO confie neste arquivo. Rode a verificação de novo, confira a chave de cifra e gere um backup novo.'],
  [/^BACKUP/, 'Backup velho demais ou ausente: confira o serviço de backup (agenda, espaço, credencial) e o destino externo. Gere um backup manualmente e verifique-o.'],
  [/^INTEGRATION/, 'Integração com erro: abra a empresa › Integrações, veja o último erro e teste a conexão do canal. Erro de credencial exige nova credencial da empresa.'],
  [/^NOTIFICATION|^EMAIL|^SENTRY/, 'Falha ao entregar notificação externa: confira a chave do provedor, o domínio remetente verificado e os limites do plano. O alerta interno continua funcionando.'],
];

export function alertGuidance(type: string): string | null {
  return GUIDANCE.find(([re]) => re.test(type))?.[1] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Funil comercial
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const FUNNEL_STAGES = ['INTERESTED', 'DEMO', 'PROPOSAL', 'ONBOARDING', 'ACTIVE'] as const;
export const TERMINAL_STAGES = ['SUSPENDED', 'CANCELLED'] as const;
export const ALL_STAGES = [...FUNNEL_STAGES, ...TERMINAL_STAGES] as const;
export type FunnelStage = (typeof ALL_STAGES)[number];
export const isStage = (s: unknown): s is FunnelStage => typeof s === 'string' && (ALL_STAGES as readonly string[]).includes(s);

export const STAGE_LABELS: Record<FunnelStage, string> = {
  INTERESTED: 'Interessado',
  DEMO: 'Demonstração',
  PROPOSAL: 'Proposta',
  ONBOARDING: 'Implantação',
  ACTIVE: 'Cliente ativo',
  SUSPENDED: 'Suspenso',
  CANCELLED: 'Cancelado',
};

export interface LeadLike {
  id: string;
  stage: string;
  stageEnteredAt: Date;
  createdAt: Date;
  companyId?: string | null;
}
export interface LeadEventLike {
  leadId: string;
  fromStage: string | null;
  toStage: string;
  createdAt: Date;
}

const DAY_MS = 86_400_000;

/**
 * Funil a partir das oportunidades e do histórico de etapas. `reached[e]` = oportunidades distintas que alguma vez estiveram na etapa; a conversão de uma
 * etapa para a seguinte usa `reached`. O tempo médio por etapa usa só PERMANÊNCIAS CONCLUÍDAS (entrada → saída); quem ainda está na etapa não entra na média.
 * Sem eventos suficientes o indicador fica `null` (a tela diz "ainda não coletado").
 */
export function computeFunnel(leads: LeadLike[], events: LeadEventLike[], now: Date, stuckDays = 14) {
  const current: Record<string, number> = {};
  for (const s of ALL_STAGES) current[s] = 0;
  for (const l of leads) if (l.stage in current) current[l.stage]++;

  const byLead = new Map<string, LeadEventLike[]>();
  // evento "de→para" na MESMA etapa é só anotação (ex.: vínculo com a empresa): não é mudança de etapa e não entra em tempo nem em conversão
  for (const e of events) if (e.fromStage === null || e.fromStage !== e.toStage) byLead.set(e.leadId, [...(byLead.get(e.leadId) ?? []), e]);
  for (const list of byLead.values()) list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const reachedSets: Record<string, Set<string>> = {};
  const durations: Record<string, number[]> = {};
  for (const s of ALL_STAGES) {
    reachedSets[s] = new Set();
    durations[s] = [];
  }
  for (const [leadId, list] of byLead) {
    list.forEach((e, i) => {
      if (e.toStage in reachedSets) reachedSets[e.toStage].add(leadId);
      const next = list[i + 1];
      if (next && e.toStage in durations) durations[e.toStage].push((next.createdAt.getTime() - e.createdAt.getTime()) / DAY_MS);
    });
  }
  // oportunidade sem nenhum evento (criada antes do histórico): conta a etapa atual como alcançada
  for (const l of leads) if (!byLead.has(l.id) && l.stage in reachedSets) reachedSets[l.stage].add(l.id);

  const reached: Record<string, number> = {};
  for (const s of ALL_STAGES) reached[s] = reachedSets[s].size;

  const conversions = FUNNEL_STAGES.slice(1).map((to, i) => {
    const from = FUNNEL_STAGES[i];
    return { from, to, pct: reached[from] === 0 ? null : Math.round((reached[to] / reached[from]) * 1000) / 10 };
  });

  const avgDaysInStage: Record<string, number | null> = {};
  for (const s of ALL_STAGES) {
    const d = durations[s];
    avgDaysInStage[s] = d.length === 0 ? null : Math.round((d.reduce((a, b) => a + b, 0) / d.length) * 10) / 10;
  }

  const stuckOnboarding = leads
    .filter((l) => l.stage === 'ONBOARDING' && (now.getTime() - l.stageEnteredAt.getTime()) / DAY_MS > stuckDays)
    .map((l) => ({ id: l.id, days: Math.floor((now.getTime() - l.stageEnteredAt.getTime()) / DAY_MS) }));

  return { current, reached, conversions, avgDaysInStage, stuckOnboarding, total: leads.length };
}

/** Agrupa em meses (YYYY-MM, UTC) as datas informadas. */
export function monthlyCounts(dates: Date[]): Array<{ month: string; count: number }> {
  const map = new Map<string, number>();
  for (const d of dates) {
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, count]) => ({ month, count }));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Estados → severidade exposta
// ---------------------------------------------------------------------------------------------------------------------------------------------
export function severityRank(s: string): number {
  return s === 'OFFLINE' ? 4 : s === 'CRITICAL' ? 3 : s === 'ATTENTION' ? 2 : s === 'NORMAL' ? 1 : 0;
}

export function toHealthStatus(s: string): HealthStatus {
  return (['NORMAL', 'ATTENTION', 'CRITICAL', 'OFFLINE', 'NO_DATA'] as const).find((x) => x === s) ?? 'NO_DATA';
}
