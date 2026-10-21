'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DASHBOARD_PERIOD_LABELS, DASHBOARD_PERIOD_PRESETS, isCustomRangeValid, type DashboardPeriodPreset, type PeriodSelection } from '@/lib/dashboard-management';

// Controle de período do painel (aparência de seletor de datas, discreto): recortes prontos e um intervalo personalizado. Não calcula
// nenhuma data: envia o nome do recorte (e as duas datas escolhidas) e mostra o intervalo que a API resolveu (`rangeLabel`).
export function PeriodPicker({
  value,
  rangeLabel,
  onChange,
}: {
  value: PeriodSelection;
  /** Intervalo por extenso devolvido pela API ("05/09/2026 – 04/10/2026"); vazio enquanto carrega. */
  rangeLabel?: string;
  onChange: (next: PeriodSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(value.start ?? '');
  const [end, setEnd] = useState(value.end ?? '');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (preset: DashboardPeriodPreset) => {
    onChange({ preset });
    setOpen(false);
  };
  const customOk = isCustomRangeValid(start, end);

  return (
    <div ref={box} className="relative">
      <Button type="button" variant="outline" size="sm" className="h-9 max-w-full gap-2" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">
          {DASHBOARD_PERIOD_LABELS[value.preset]}
          {rangeLabel ? <span className="hidden text-muted-foreground sm:inline"> · {rangeLabel}</span> : null}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </Button>

      {open && (
        <div role="dialog" aria-label="Escolher período" className="absolute left-0 z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-2 shadow-sm sm:left-auto sm:right-0">
          <ul className="space-y-0.5">
            {DASHBOARD_PERIOD_PRESETS.filter((p) => p !== 'custom').map((p) => (
              <li key={p}>
                <button
                  type="button"
                  aria-pressed={value.preset === p}
                  onClick={() => pick(p)}
                  className={`flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors ${value.preset === p ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'}`}
                >
                  {DASHBOARD_PERIOD_LABELS[p]}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 border-t border-border pt-3">
            <p className={`px-1 text-xs font-medium ${value.preset === 'custom' ? 'text-foreground' : 'text-muted-foreground'}`}>Período personalizado</p>
            <div className="mt-2 grid grid-cols-2 gap-2 px-1">
              <label className="text-xs text-muted-foreground">
                Início
                <input type="date" value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground" />
              </label>
              <label className="text-xs text-muted-foreground">
                Fim
                <input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground" />
              </label>
            </div>
            <div className="mt-3 flex justify-end px-1">
              <Button
                type="button"
                size="sm"
                disabled={!customOk}
                onClick={() => {
                  onChange({ preset: 'custom', start, end });
                  setOpen(false);
                }}
              >
                Aplicar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
