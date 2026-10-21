'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Inbox, UserX, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supportAdminApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ErrorState, LoadingState, PageTitle } from './_components/states';
import { errorText, statusBadgeClass, statusLabel } from './_lib/format';
import type { SupportDashboard } from './_lib/types';

const TICKETS = '/dashboard/support/tickets';

export default function SupportDashboardPage() {
  const [data, setData] = useState<SupportDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await supportAdminApi.dashboard();
      setData(res.data);
    } catch (err) {
      setError(errorText(err, 'Não foi possível carregar o painel de suporte.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const kpis = data
    ? [
        { key: 'open', label: 'Em aberto', value: data.open, hint: 'Todos os chamados ainda não resolvidos', href: `${TICKETS}?status=open`, icon: Inbox },
        { key: 'unassigned', label: 'Sem responsável', value: data.unassigned, hint: 'Em aberto e sem ninguém da equipe', href: `${TICKETS}?status=open&assignedToId=unassigned`, icon: UserX },
        { key: 'waiting', label: 'Aguardando suporte', value: data.waitingSupport, hint: 'O cliente respondeu e espera a equipe', href: `${TICKETS}?status=AGUARDANDO_SUPORTE`, icon: Clock },
      ]
    : [];

  return (
    <div className="space-y-6">
      <PageTitle title="Painel" description="Visão rápida da fila de atendimento. Clique em um número para abrir a lista já filtrada." />

      {loading && !data ? (
        <LoadingState label="Carregando painel de suporte..." />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            {kpis.map((k) => (
              <Link key={k.key} href={k.href} data-testid={`support-kpi-${k.key}`} className="group rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Card className="h-full transition-colors group-hover:border-foreground/30">
                  <CardContent className="flex items-start justify-between gap-3 p-5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-muted-foreground">{k.label}</p>
                      <p className="mt-1 text-3xl font-bold tabular-nums">{k.value}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{k.hint}</p>
                    </div>
                    <k.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Chamados por situação</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y">
                {data.byStatus.map((s) => (
                  <li key={s.status}>
                    <Link
                      href={`${TICKETS}?status=${s.status}`}
                      className="flex items-center justify-between gap-3 px-6 py-3 text-sm hover:bg-accent/50"
                      data-testid={`support-status-${s.status}`}
                    >
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', statusBadgeClass(s.status))}>{statusLabel(s.status)}</span>
                      <span className="flex items-center gap-2">
                        <span className="font-semibold tabular-nums">{s.count}</span>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            Ainda não há metas de tempo de atendimento (SLA) — estão no roadmap. <Link className="underline" href={`${TICKETS}?status=all`}>Ver todos os chamados</Link>
          </p>
        </>
      ) : null}
    </div>
  );
}
