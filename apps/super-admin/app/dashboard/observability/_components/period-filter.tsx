'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export interface Period {
  startDate: string;
  endDate: string;
  presetKey: string;
}

export const PERIOD_PRESETS = [
  { key: '1h', label: 'Última hora', hours: 1 },
  { key: '24h', label: 'Últimas 24h', hours: 24 },
  { key: '7d', label: 'Últimos 7 dias', hours: 24 * 7 },
] as const;

export function presetToPeriod(hours: number, key: string): Period {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  return { startDate: start.toISOString(), endDate: end.toISOString(), presetKey: key };
}

interface PeriodFilterProps {
  period: Period;
  onChange: (period: Period) => void;
}

export function PeriodFilter({ period, onChange }: PeriodFilterProps) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex gap-1">
        {PERIOD_PRESETS.map((preset) => (
          <Button
            key={preset.key}
            type="button"
            size="sm"
            variant={period.presetKey === preset.key ? 'default' : 'outline'}
            onClick={() => onChange(presetToPeriod(preset.hours, preset.key))}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="period-start" className="text-xs">
            De
          </Label>
          <Input
            id="period-start"
            type="datetime-local"
            className={cn('h-9 text-xs')}
            value={toLocalInputValue(period.startDate)}
            onChange={(e) =>
              onChange({
                ...period,
                presetKey: 'custom',
                startDate: e.target.value ? new Date(e.target.value).toISOString() : period.startDate,
              })
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="period-end" className="text-xs">
            Até
          </Label>
          <Input
            id="period-end"
            type="datetime-local"
            className={cn('h-9 text-xs')}
            value={toLocalInputValue(period.endDate)}
            onChange={(e) =>
              onChange({
                ...period,
                presetKey: 'custom',
                endDate: e.target.value ? new Date(e.target.value).toISOString() : period.endDate,
              })
            }
          />
        </div>
      </div>
    </div>
  );
}

function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}
