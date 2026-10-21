import { cn } from '@/lib/utils';

type Severity = 'ok' | 'warning' | 'critical';

const severityStyles: Record<Severity, string> = {
  ok: 'bg-success-soft text-success border-success/40',
  warning: 'bg-warning-soft text-warning border-warning/40',
  critical: 'bg-danger-soft text-danger border-danger/40',
};

const severityLabels: Record<Severity, string> = {
  ok: 'OK',
  warning: 'Atenção',
  critical: 'Crítico',
};

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium',
        severityStyles[severity] || severityStyles.ok,
        className
      )}
    >
      {severityLabels[severity] || severity}
    </span>
  );
}

export function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className={cn('h-2.5 w-2.5 rounded-full', ok ? 'bg-success' : 'bg-danger')} />
      {ok ? 'Conectado' : 'Indisponível'}
    </span>
  );
}
