import { Check, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { workflowSteps, type StepState } from '@/lib/quotes';

// Cores semânticas só como indicador de progresso: verde = etapa cumprida,
// vermelho = bloqueada (cliente recusou); o restante é neutro.
const MARKER: Record<StepState, string> = {
  done: 'border-success/40 bg-success-soft text-success',
  current: 'border-foreground bg-card text-foreground',
  pending: 'border-border bg-card text-muted-foreground',
  blocked: 'border-danger/40 bg-danger-soft text-danger',
};

export function QuoteStepper({ status }: { status: string }) {
  const steps = workflowSteps(status);

  return (
    <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Andamento do orçamento">
      {steps.map((step, index) => (
        <li
          key={step.label}
          className="flex min-w-0 items-center gap-2"
          aria-current={step.state === 'current' ? 'step' : undefined}
          data-step-state={step.state}
        >
          <span
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
              MARKER[step.state]
            )}
          >
            {step.state === 'done' ? (
              <Check className="h-4 w-4" aria-hidden />
            ) : step.state === 'blocked' ? (
              <X className="h-4 w-4" aria-hidden />
            ) : (
              index + 1
            )}
          </span>
          <span
            className={cn(
              'text-sm leading-tight',
              step.state === 'current' ? 'font-semibold text-foreground' : 'text-muted-foreground'
            )}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
