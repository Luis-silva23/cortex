/** Tipos do monitor independente. Tudo aqui é dado simples (JSON): o estado inteiro cabe em um arquivo e sobrevive a reinício. */
import type { AlertChannel } from '../../../packages/shared/utils/alert-channels';

export type Severity = 'ATTENTION' | 'CRITICAL';
export type IncidentKind = 'DOWN' | 'SLOW' | 'ERRORS';
export type TargetStatus = 'UNKNOWN' | 'UP' | 'DEGRADED' | 'DOWN';
export type FailureKind = 'http' | 'timeout' | 'network' | 'content';

export interface TargetConfig {
  /** Identificador estável (minúsculas, números, - e _). Vira parte do tipo do alerta: `EXTERNAL_<ID>_DOWN`. */
  id: string;
  name: string;
  /** Endereço sondado (https). Nenhuma credencial na URL. */
  url: string;
  method: 'GET' | 'HEAD';
  /** Códigos HTTP considerados saudáveis (padrão: 200). */
  expectStatus: number[];
  /** Texto que a resposta precisa conter (opcional; só para GET). Não é gravado. */
  bodyIncludes: string | null;
  timeoutMs: number;
  /** Gravidade quando o serviço CAI (padrão CRITICAL). */
  severity: Severity;
  latencyWarnMs: number;
  latencyCritMs: number;
  /** Alvo "pai": se ele estiver fora, a queda deste é agrupada sob ele (um alerta só, sem tempestade). */
  parent: string | null;
}

export interface NotifyPolicy {
  /** Canais para queda CRITICAL (padrão: os três). */
  criticalChannels: AlertChannel[];
  /** Canais para ATTENTION (padrão: só e-mail). */
  attentionChannels: AlertChannel[];
  /** Teto de mensagens por canal e hora (proteção de custo e de tempestade). */
  maxPerHourPerChannel: number;
  /** Tentativas de entrega por mensagem antes de desistir. */
  maxAttempts: number;
  /** Esperas entre tentativas, em segundos (a última se repete). */
  retryDelaysSec: number[];
}

export interface MonitorConfig {
  monitorId: string;
  location: string;
  targets: TargetConfig[];
  intervalSec: number;
  /** Falhas SEGUIDAS (já depois das retentativas rápidas) para abrir a queda. */
  failThreshold: number;
  /** Sucessos seguidos para dar a recuperação. */
  recoverThreshold: number;
  quickRetries: number;
  quickRetryDelayMs: number;
  latencyWindow: number;
  latencyStreak: number;
  errorRateWindow: number;
  errorRatePct: number;
  /** Pontos de referência (de preferência de outro provedor) para saber se a PRÓPRIA rede do monitor está de pé antes de acusar um alvo. */
  controlUrls: string[];
  reminderMinutes: number;
  maxReminders: number;
  stateDir: string;
  ingest: { url: string; secret: string } | null;
  /** Endereço do painel para o link da mensagem (opcional). */
  panelUrl: string | null;
  notify: NotifyPolicy;
  /** Linhas do histórico antes de girar o arquivo. */
  historyMaxLines: number;
  /** Resultados que podem esperar o envio ao painel (a API pode ficar fora por horas). */
  outboxMax: number;
}

export interface ProbeResult {
  target: string;
  /** Instante da sondagem (ms desde 1970). */
  at: number;
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  failure: FailureKind | null;
  /** Detalhe curto e já mascarado (nunca o corpo da resposta). */
  error: string | null;
  /** A rede do próprio monitor estava fora (pontos de referência também falharam): o resultado NÃO conta contra o alvo. */
  inconclusive: boolean;
}

export interface Incident {
  id: string;
  target: string;
  kind: IncidentKind;
  /** Tipo do alerta no painel, ex.: EXTERNAL_API_DOWN. */
  type: string;
  severity: Severity;
  startedAt: number;
  endedAt: number | null;
  detail: string;
  cause: string | null;
  /** Alvo pai sob o qual este incidente foi agrupado (não é notificado à parte). */
  groupedUnder: string | null;
  /** Canais cujo aviso de abertura/agravamento foi ACEITO pelo provedor. */
  notifiedChannels: AlertChannel[];
  lastNotifiedAt: number | null;
  reminders: number;
}

export interface TargetState {
  status: TargetStatus;
  failStreak: number;
  okStreak: number;
  slowStreak: number;
  fastStreak: number;
  recent: Array<{ ok: boolean; latencyMs: number }>;
  last: ProbeResult | null;
  incidents: Partial<Record<IncidentKind, Incident>>;
}

export interface NotificationJob {
  id: string;
  channel: AlertChannel;
  phase: 'OPEN' | 'ESCALATED' | 'RECOVERED' | 'REMINDER';
  incidentId: string;
  subject: string;
  text: string;
  attempts: number;
  nextTryAt: number;
  createdAt: number;
}

export interface MonitorState {
  version: 1;
  targets: Record<string, TargetState>;
  pending: NotificationJob[];
  /** Instantes (ms) das mensagens ACEITAS por canal na última hora (teto por hora). */
  sent: Record<string, number[]>;
  /** Resultados e incidentes ainda não entregues ao painel. */
  outbox: { results: ProbeResult[]; incidents: Incident[] };
  lastTickAt: number | null;
  /** Último tick em que a rede do monitor estava fora (para o log). */
  lastNetworkDownAt: number | null;
}

export type EngineEvent =
  | { kind: 'OPENED'; incident: Incident }
  | { kind: 'ESCALATED'; incident: Incident }
  | { kind: 'RECOVERED'; incident: Incident }
  | { kind: 'REMINDER'; incident: Incident };
