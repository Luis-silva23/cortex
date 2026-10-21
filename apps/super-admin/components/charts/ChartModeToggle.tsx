'use client';

import { cn } from '@/lib/utils';

export interface ChartModeOption<T extends string> {
  value: T;
  label: string;
}

// Alternância de visualização dos gráficos (Linha | Colunas): mesmo desenho do seletor de período do painel (tokens do design
// system), sem navegação nem requisição: só troca o estado do componente que a recebe.
export function ChartModeToggle<T extends string>({
  value,
  onChange,
  options,
  ariaLabel = 'Tipo de gráfico',
}: {
  value: T;
  onChange: (value: T) => void;
  options: ChartModeOption<T>[];
  ariaLabel?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-3 py-1 text-xs transition-colors',
            o.value === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
