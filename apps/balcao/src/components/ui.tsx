import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, AlertTriangle, Inbox } from 'lucide-react';
import clsx from 'clsx';
import type { Tone } from '../lib/labels';
import { toApiError } from '../api/http';

/** Carrega dados de uma função assíncrona com estados explícitos de carregando / erro / dado (e recarregar). */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      if (alive.current) setData(result);
    } catch (e) {
      const err = toApiError(e);
      if (alive.current) {
        setError(err.message);
        setStatus(err.status);
      }
    } finally {
      if (alive.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    alive.current = true;
    void run();
    return () => {
      alive.current = false;
    };
  }, [run]);
  return { data, error, status, loading, reload: run };
}

/**
 * Proteção contra operação duplicada: enquanto uma execução está em andamento, outra chamada é ignorada (duplo clique, Enter
 * repetido). O servidor continua sendo a trava final (estado/unique), mas o balcão não dispara duas vezes.
 */
export function useSubmitOnce() {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);
  return { run, busy };
}

export function Spinner({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-6 text-sm text-gray-600">
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">{message}</div>
      {onRetry && (
        <button onClick={onRetry} className="font-semibold underline">
          Tentar de novo
        </button>
      )}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-gray-500">
      <Inbox className="h-6 w-6" />
      {children}
    </div>
  );
}

/** Bloco com os três estados (carregando, erro, vazio) resolvidos; só renderiza `children` com dado. */
export function AsyncBlock<T>({
  state,
  isEmpty,
  empty,
  children,
}: {
  state: { data: T | null; error: string | null; loading: boolean; reload: () => void };
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (state.loading && state.data === null) return <Spinner />;
  if (state.error) return <ErrorBox message={state.error} onRetry={state.reload} />;
  if (state.data === null) return null;
  if (isEmpty?.(state.data)) return <EmptyState>{empty ?? 'Nada por aqui.'}</EmptyState>;
  return <>{children(state.data)}</>;
}

const TONE: Record<Tone, string> = {
  neutral: 'bg-gray-100 text-gray-700',
  warning: 'bg-amber-100 text-amber-800',
  success: 'bg-green-100 text-green-800',
  danger: 'bg-red-100 text-red-800',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={clsx('inline-block rounded-full px-2 py-0.5 text-xs font-semibold', TONE[tone])}>{children}</span>;
}

export function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-primary-200 bg-white shadow-sm">
      <header className="flex items-center justify-between border-b border-primary-100 px-4 py-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-primary-600">{title}</h2>
        {action}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

export function Button({
  variant = 'primary',
  loading,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger'; loading?: boolean }) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60';
  const styles = {
    primary: 'bg-primary-600 text-white hover:bg-primary-700',
    secondary: 'border border-primary-300 bg-white text-primary-600 hover:bg-primary-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  }[variant];
  return (
    <button {...rest} disabled={rest.disabled || loading} className={clsx(base, styles, className)}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export const inputClass = 'w-full rounded-lg border border-primary-300 px-3 py-2 text-sm outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-200';
