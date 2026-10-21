'use client';

export interface FunnelStageRow {
  stage: string;
  label: string;
  /** Oportunidades que ALGUMA VEZ chegaram à etapa (base da largura e da conversão). */
  reached: number;
  /** Oportunidades que estão na etapa agora. */
  current: number;
  avgDaysInStage: number | null;
}

/**
 * Funil visual: a largura de cada barra é proporcional ao número de oportunidades que chegaram à etapa; entre as etapas aparece a conversão (chegaram à seguinte ÷ chegaram à
 * anterior). Sem oportunidades, o funil fica vazio e diz isso. Etapas terminais (suspenso/cancelado) ficam fora do funil e entram só como contagem.
 */
export function FunnelChart({
  stages,
  conversions,
  testId,
}: {
  stages: FunnelStageRow[];
  conversions: Array<{ from: string; to: string; pct: number | null }>;
  testId?: string;
}) {
  const max = Math.max(1, ...stages.map((s) => s.reached));
  const conv = (from: string, to: string) => conversions.find((c) => c.from === from && c.to === to)?.pct ?? null;
  const total = stages.reduce((n, s) => n + s.reached, 0);
  if (total === 0) return <p className="py-6 text-center text-sm text-muted-foreground">Nenhuma oportunidade registrada: o funil só passa a existir quando as oportunidades forem cadastradas.</p>;
  return (
    <ol data-testid={testId} className="space-y-1" aria-label="Funil de clientes: oportunidades que chegaram a cada etapa">
      {stages.map((s, i) => (
        <li key={s.stage}>
          {i > 0 && (
            <p className="py-0.5 pl-2 text-xs text-muted-foreground" data-testid={`funnel-conv-${stages[i - 1].stage}-${s.stage}`}>
              ↓ conversão: <span className="font-medium tabular-nums text-foreground">{conv(stages[i - 1].stage, s.stage) === null ? 'sem base para calcular' : `${(conv(stages[i - 1].stage, s.stage) as number).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`}</span>
            </p>
          )}
          <div className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-sm">{s.label}</span>
            <div className="h-8 flex-1 rounded bg-muted">
              <div className="flex h-full items-center rounded bg-primary px-2 text-xs font-medium text-primary-foreground" style={{ width: `${Math.max(6, (s.reached / max) * 100)}%` }}>
                {s.reached}
              </div>
            </div>
            <span className="w-44 shrink-0 text-xs text-muted-foreground">
              agora: <span className="font-medium text-foreground">{s.current}</span> · tempo médio: {s.avgDaysInStage === null ? 'ainda não coletado' : `${s.avgDaysInStage.toLocaleString('pt-BR')} d`}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
