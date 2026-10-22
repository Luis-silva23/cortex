'use client';

import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { CentralRange } from '@/lib/api';
import { RANGE_OPTIONS, fmtTime, STATUS_LABEL, STATUS_STYLE } from './format';

/** Pílula de estado: o TEXTO diz o estado; a cor só reforça (verde/amarelo/vermelho são sinais semânticos do tema). */
export function Pill({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <span data-testid={testId} className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', className)}>
      {children}
    </span>
  );
}

export function StatusPill({ status, label, testId }: { status: string; label?: string; testId?: string }) {
  return (
    <Pill testId={testId} className={STATUS_STYLE[status] ?? STATUS_STYLE.NO_DATA}>
      {label ?? STATUS_LABEL[status] ?? status}
    </Pill>
  );
}

/** Seletor de período (botões com `aria-pressed`). Mudar o período não muda as permissões: o backend continua decidindo o que cada pedido pode ver. */
export function RangeSelector({ value, onChange, options = RANGE_OPTIONS }: { value: CentralRange; onChange: (r: CentralRange) => void; options?: typeof RANGE_OPTIONS }) {
  return (
    <div role="group" aria-label="Período" className="flex flex-wrap gap-1" data-testid="range-selector">
      {options.map((o) => (
        <Button key={o.key} type="button" size="sm" variant={value === o.key ? 'default' : 'outline'} aria-pressed={value === o.key} data-testid={`range-${o.key}`} onClick={() => onChange(o.key)}>
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/** Horário da última atualização + aviso de dado desatualizado e botão de atualizar. */
export function Freshness({ generatedAt, stale, staleNote, onRefresh, refreshing }: { generatedAt: string | null | undefined; stale?: boolean; staleNote?: string; onRefresh: () => void; refreshing?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground" data-testid="freshness">
      <span>
        Atualizado às <span className="font-medium text-foreground">{fmtTime(generatedAt)}</span>
      </span>
      {stale && (
        <Pill className={STATUS_STYLE.ATTENTION} testId="stale-badge">
          {staleNote ?? 'Dados desatualizados'}
        </Pill>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing} aria-label="Atualizar agora">
        <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
      </Button>
    </div>
  );
}

/** Definição do indicador, sempre ao alcance (leitor de tela e teclado): medição, estimativa e falta de dado não se misturam. */
export function Definition({ text, label = 'Como é calculado' }: { text: string; label?: string }) {
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">{label}</summary>
      <p className="mt-1 leading-relaxed">{text}</p>
    </details>
  );
}

export function Kpi({
  title,
  value,
  hint,
  status,
  statusLabel,
  definition,
  testId,
  children,
}: {
  title: string;
  value: ReactNode;
  hint?: ReactNode;
  status?: string;
  statusLabel?: string;
  definition?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-muted-foreground">{title}</p>
          {status && <StatusPill status={status} label={statusLabel} />}
        </div>
        <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid={testId ? `${testId}-value` : undefined}>
          {value}
        </p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        {children}
        {definition && <Definition text={definition} />}
      </CardContent>
    </Card>
  );
}

/** Cartão de gráfico: título, unidade, período e a definição do que está desenhado. */
export function ChartCard({ title, unit, subtitle, definition, children, testId, right }: { title: string; unit?: string; subtitle?: string; definition?: string; children: ReactNode; testId?: string; right?: ReactNode }) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {unit ? `Unidade: ${unit}` : null}
              {unit && subtitle ? ' · ' : null}
              {subtitle}
            </p>
          </div>
          {right}
        </div>
      </CardHeader>
      <CardContent>
        {children}
        {definition && <Definition text={definition} />}
      </CardContent>
    </Card>
  );
}

/** Faixa de aviso (ambiente local, dado antigo, coleta desligada). */
export function Notice({ tone = 'info', children, testId }: { tone?: 'info' | 'warn'; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} role="note" className={cn('rounded-md border px-3 py-2 text-sm', tone === 'warn' ? STATUS_STYLE.ATTENTION : 'bg-muted text-muted-foreground border-border')}>
      {children}
    </div>
  );
}

/** Mensagem de erro de leitura, sem esconder o resto da tela. */
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className={cn('flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm', STATUS_STYLE.CRITICAL)}>
      <span>{message}</span>
      {onRetry && (
        <Button type="button" size="sm" variant="outline" onClick={onRetry}>
          Tentar novamente
        </Button>
      )}
    </div>
  );
}
