'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// Mesmo padrão de app/dashboard/audit-logs/_components/states.tsx.
export function LoadingState({ label = 'Carregando...' }: { label?: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground" role="status">
        <Loader2 className="h-5 w-5 animate-spin" />
        <p className="text-sm">{label}</p>
      </CardContent>
    </Card>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="border-danger/40">
      <CardContent className="flex flex-col items-center justify-center gap-3 py-10 text-center" role="alert">
        <AlertTriangle className="h-6 w-6 text-danger" />
        <p className="text-sm text-danger">{message}</p>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            Tentar novamente
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function EmptyState({ message, children }: { message: string; children?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-10 text-center">
        <p className="text-sm text-muted-foreground">{message}</p>
        {children}
      </CardContent>
    </Card>
  );
}

/** Aviso curto dentro de um formulário/cartão (erro ou sucesso). */
export function InlineNotice({ tone, children, className }: { tone: 'error' | 'success' | 'info'; children: React.ReactNode; className?: string }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-md px-3 py-2 text-sm',
        tone === 'error' && 'bg-danger-soft text-danger',
        tone === 'success' && 'bg-success-soft text-success',
        tone === 'info' && 'bg-muted text-muted-foreground',
        className
      )}
    >
      {children}
    </p>
  );
}

export function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', className)}>{children}</span>;
}

export function PageTitle({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
