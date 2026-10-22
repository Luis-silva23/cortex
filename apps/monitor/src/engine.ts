/**
 * MOTOR de decisão do monitor: funções PURAS (sem rede, sem arquivo, sem relógio próprio) que transformam o resultado de cada sondagem em incidentes.
 *   • QUEDA (DOWN): N falhas SEGUIDAS (padrão 3, já depois das retentativas rápidas) abrem o incidente; M sucessos seguidos (padrão 2) dão a recuperação. Um soluço isolado
 *     nunca abre nada; e quando a rede do próprio monitor está fora (`inconclusive`), o resultado nem entra na conta.
 *   • LENTIDÃO (SLOW): a MEDIANA da latência das últimas sondagens boas acima do limite por N avaliações seguidas (ATTENTION; CRITICAL acima do limite crítico).
 *   • ERROS (ERRORS): taxa de falhas na janela (padrão ≥ 25% em 20 sondagens) sem queda aberta — falha intermitente que a regra de falhas seguidas não pega.
 *   • AGRUPAMENTO: se o alvo tem `parent` e o pai está fora, a queda do filho é registrada sob o pai e NÃO é notificada à parte (um problema, uma mensagem); se o pai volta e o
 *     filho continua fora, o filho é desagrupado e notificado.
 *   • LEMBRETE: incidente aberto e não agrupado lembra a cada `reminderMinutes`, até `maxReminders`.
 * Cada evento carrega uma CÓPIA do incidente: quem consome (notificações, painel) não compartilha estado mutável com o motor.
 */
import type { EngineEvent, Incident, IncidentKind, MonitorConfig, MonitorState, ProbeResult, Severity, TargetConfig, TargetState } from './types';

export function newTargetState(): TargetState {
  return { status: 'UNKNOWN', failStreak: 0, okStreak: 0, slowStreak: 0, fastStreak: 0, recent: [], last: null, incidents: {} };
}

export function newState(): MonitorState {
  return { version: 1, targets: {}, pending: [], sent: {}, outbox: { results: [], incidents: [] }, lastTickAt: null, lastNetworkDownAt: null };
}

export const incidentType = (targetId: string, kind: IncidentKind) => `EXTERNAL_${targetId.toUpperCase().replace(/-/g, '_')}_${kind}`;

const rank = (s: Severity) => (s === 'CRITICAL' ? 2 : 1);

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function causeOf(r: ProbeResult): string {
  if (r.failure === 'timeout') return 'tempo esgotado: o serviço não respondeu no prazo';
  if (r.failure === 'network') return 'falha de rede, DNS ou TLS ao conectar';
  if (r.failure === 'content') return 'o serviço respondeu, mas sem o conteúdo esperado';
  if (r.httpStatus !== null) return `resposta HTTP ${r.httpStatus} (esperado: sucesso)`;
  return 'falha sem detalhe';
}

export interface StepContext {
  cfg: MonitorConfig;
  target: TargetConfig;
  parentDown: boolean;
  now: number;
  newId: () => string;
}

function open(ctx: StepContext, kind: IncidentKind, severity: Severity, detail: string, cause: string | null, groupedUnder: string | null): Incident {
  return {
    id: ctx.newId(),
    target: ctx.target.id,
    kind,
    type: incidentType(ctx.target.id, kind),
    severity,
    startedAt: ctx.now,
    endedAt: null,
    detail,
    cause,
    groupedUnder,
    notifiedChannels: [],
    lastNotifiedAt: groupedUnder ? null : ctx.now,
    reminders: 0,
  };
}

export function stepTarget(prev: TargetState, r: ProbeResult, ctx: StepContext): { state: TargetState; events: EngineEvent[] } {
  const s = clone(prev);
  const events: EngineEvent[] = [];
  s.last = r;
  // rede do próprio monitor fora: o resultado não conta nem a favor nem contra
  if (r.inconclusive) return { state: s, events };

  const { cfg, target, now } = ctx;
  s.recent.push({ ok: r.ok, latencyMs: r.latencyMs });
  if (s.recent.length > cfg.errorRateWindow) s.recent = s.recent.slice(-cfg.errorRateWindow);

  // ---------------- queda e recuperação ----------------
  if (r.ok) {
    s.okStreak += 1;
    s.failStreak = 0;
  } else {
    s.failStreak += 1;
    s.okStreak = 0;
  }
  let down = s.incidents.DOWN;
  if (!down && s.failStreak >= cfg.failThreshold) {
    down = open(ctx, 'DOWN', target.severity, `${s.failStreak} verificações seguidas sem sucesso (${r.error ?? 'sem detalhe'})`, causeOf(r), ctx.parentDown ? target.parent : null);
    s.incidents.DOWN = down;
    events.push({ kind: 'OPENED', incident: clone(down) });
    // a queda é mais grave que lentidão/erros: encerra esses incidentes (sem aviso próprio — a recuperação da queda cobre)
    for (const k of ['SLOW', 'ERRORS'] as const) {
      const other = s.incidents[k];
      if (other) {
        other.endedAt = now;
        delete s.incidents[k];
      }
    }
  } else if (down && r.ok && s.okStreak >= cfg.recoverThreshold) {
    down.endedAt = now;
    events.push({ kind: 'RECOVERED', incident: clone(down) });
    delete s.incidents.DOWN;
    down = undefined;
  } else if (down && down.groupedUnder && !ctx.parentDown) {
    // o pai voltou e o filho continua fora: deixa de ser "consequência" e passa a ser avisado
    down.groupedUnder = null;
    down.lastNotifiedAt = now;
    events.push({ kind: 'OPENED', incident: clone(down) });
  }

  // ---------------- lentidão ----------------
  if (r.ok && !s.incidents.DOWN) {
    const goods = s.recent.filter((x) => x.ok).slice(-cfg.latencyWindow);
    if (goods.length >= cfg.latencyWindow) {
      const med = median(goods.map((g) => g.latencyMs)) as number;
      const level: Severity | null = med > target.latencyCritMs ? 'CRITICAL' : med > target.latencyWarnMs ? 'ATTENTION' : null;
      if (level) {
        s.slowStreak += 1;
        s.fastStreak = 0;
      } else {
        s.fastStreak += 1;
        s.slowStreak = 0;
      }
      const slow = s.incidents.SLOW;
      const detail = `latência mediana ${med} ms nas últimas ${cfg.latencyWindow} sondagens (limite ${level === 'CRITICAL' ? target.latencyCritMs : target.latencyWarnMs} ms)`;
      if (!slow && level && s.slowStreak >= cfg.latencyStreak) {
        const inc = open(ctx, 'SLOW', level, detail, 'latência acima do limite', ctx.parentDown ? target.parent : null);
        s.incidents.SLOW = inc;
        events.push({ kind: 'OPENED', incident: clone(inc) });
      } else if (slow) {
        if (level && rank(level) > rank(slow.severity)) {
          slow.severity = level;
          slow.detail = detail;
          slow.lastNotifiedAt = now;
          events.push({ kind: 'ESCALATED', incident: clone(slow) });
        } else if (!level && s.fastStreak >= cfg.latencyStreak) {
          slow.endedAt = now;
          events.push({ kind: 'RECOVERED', incident: clone(slow) });
          delete s.incidents.SLOW;
        }
      }
    }
  }

  // ---------------- taxa de erros (falha intermitente) ----------------
  if (s.recent.length >= Math.min(cfg.errorRateWindow, 10)) {
    const fails = s.recent.filter((x) => !x.ok).length;
    const pct = Math.round((fails / s.recent.length) * 100);
    const errors = s.incidents.ERRORS;
    if (!errors && !s.incidents.DOWN && pct >= cfg.errorRatePct) {
      const inc = open(ctx, 'ERRORS', 'ATTENTION', `${pct}% das últimas ${s.recent.length} sondagens falharam (limite ${cfg.errorRatePct}%)`, 'falhas intermitentes', ctx.parentDown ? target.parent : null);
      s.incidents.ERRORS = inc;
      events.push({ kind: 'OPENED', incident: clone(inc) });
    } else if (errors && pct < Math.floor(cfg.errorRatePct / 2)) {
      errors.endedAt = now;
      events.push({ kind: 'RECOVERED', incident: clone(errors) });
      delete s.incidents.ERRORS;
    }
  }

  // ---------------- lembretes ----------------
  for (const inc of Object.values(s.incidents)) {
    if (!inc || inc.groupedUnder || inc.reminders >= cfg.maxReminders) continue;
    const since = inc.lastNotifiedAt ?? inc.startedAt;
    if (now - since >= cfg.reminderMinutes * 60_000 && !events.some((e) => e.incident.id === inc.id)) {
      inc.reminders += 1;
      inc.lastNotifiedAt = now;
      events.push({ kind: 'REMINDER', incident: clone(inc) });
    }
  }

  const hasIncident = Object.keys(s.incidents).length > 0;
  s.status = s.incidents.DOWN ? 'DOWN' : hasIncident || s.failStreak > 0 ? 'DEGRADED' : 'UP';
  return { state: s, events };
}

/** Pais antes dos filhos (o estado do pai precisa estar atualizado quando o filho é avaliado). */
export function orderTargets(targets: TargetConfig[]): TargetConfig[] {
  const out: TargetConfig[] = [];
  const done = new Set<string>();
  const visit = (t: TargetConfig) => {
    if (done.has(t.id)) return;
    const parent = t.parent ? targets.find((x) => x.id === t.parent) : undefined;
    if (parent) visit(parent);
    done.add(t.id);
    out.push(t);
  };
  targets.forEach(visit);
  return out;
}

/** Aplica um conjunto de resultados (um por alvo) ao estado, na ordem pai → filho. */
export function runTick(state: MonitorState, results: ProbeResult[], cfg: MonitorConfig, now: number, newId: () => string): { state: MonitorState; events: EngineEvent[] } {
  const next = clone(state);
  const events: EngineEvent[] = [];
  const byTarget = new Map(results.map((r) => [r.target, r]));
  for (const target of orderTargets(cfg.targets)) {
    const r = byTarget.get(target.id);
    if (!r) continue;
    const prev = next.targets[target.id] ?? newTargetState();
    const parentDown = target.parent ? Boolean(next.targets[target.parent]?.incidents.DOWN) : false;
    const step = stepTarget(prev, r, { cfg, target, parentDown, now, newId });
    next.targets[target.id] = step.state;
    events.push(...step.events);
  }
  next.lastTickAt = now;
  return { state: next, events };
}
