'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { observabilityApi } from '@/lib/api';
import { LoadingState, ErrorState, EmptyState } from '../_components/states';
import { PeriodFilter, Period, presetToPeriod } from '../_components/period-filter';
import { formatDateTime } from '../_lib/format';

interface SecurityEvent {
  event: string;
  message: string;
  userId: string | null;
  createdAt: string;
}

interface SecurityStats {
  period: { start: string; end: string };
  failedLogins: number;
  accountsLocked: number;
  loginAttemptsOnLockedAccounts: number;
  topOffendingIPs: Array<{ ip: string; count: number }>;
  recentEvents: SecurityEvent[];
}

export default function SecurityPage() {
  const [period, setPeriod] = useState<Period>(() => presetToPeriod(24, '24h'));
  const [data, setData] = useState<SecurityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    setError('');
    try {
      const res = await observabilityApi.getSecurity({
        startDate: p.startDate,
        endDate: p.endDate,
      });
      setData(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar dados de segurança');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(period);
  }, [period.startDate, period.endDate]);

  return (
    <div className="space-y-6">
      <PeriodFilter period={period} onChange={setPeriod} />

      {loading ? (
        <LoadingState label="Carregando dados de segurança..." />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(period)} />
      ) : !data ? null : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Logins falhos</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{data.failedLogins}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Contas bloqueadas</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{data.accountsLocked}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  Tentativas em contas bloqueadas
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{data.loginAttemptsOnLockedAccounts}</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">IPs com mais ocorrências</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.topOffendingIPs.length === 0 ? (
                <div className="p-6">
                  <EmptyState message="Nenhum IP com ocorrências de segurança no período selecionado." />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b bg-muted/50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium">IP</th>
                        <th className="px-4 py-2 text-left text-xs font-medium">Ocorrências</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topOffendingIPs.map((row) => (
                        <tr key={row.ip} className="border-b last:border-0">
                          <td className="px-4 py-2 text-sm font-mono">{row.ip}</td>
                          <td className="px-4 py-2 text-sm">{row.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Eventos recentes</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.recentEvents.length === 0 ? (
                <div className="p-6">
                  <EmptyState message="Nenhum evento de segurança no período selecionado." />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b bg-muted/50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium">Quando</th>
                        <th className="px-4 py-2 text-left text-xs font-medium">Evento</th>
                        <th className="px-4 py-2 text-left text-xs font-medium">Mensagem</th>
                        <th className="px-4 py-2 text-left text-xs font-medium">Usuário</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentEvents.map((ev, idx) => (
                        <tr key={idx} className="border-b last:border-0">
                          <td className="px-4 py-2 text-sm text-muted-foreground">
                            {formatDateTime(ev.createdAt)}
                          </td>
                          <td className="px-4 py-2 text-sm font-medium">{ev.event}</td>
                          <td className="px-4 py-2 text-sm">{ev.message}</td>
                          <td className="px-4 py-2 text-sm text-muted-foreground">
                            {ev.userId || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
