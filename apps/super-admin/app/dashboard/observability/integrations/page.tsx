'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { observabilityApi } from '@/lib/api';
import { LoadingState, ErrorState, EmptyState } from '../_components/states';
import { PeriodFilter, Period, presetToPeriod } from '../_components/period-filter';

interface IntegrationStats {
  period: { start: string; end: string };
  tefPix: Array<{ method: string; status: string; count: number }>;
  fiscal: Array<{ status: string; count: number }>;
  integrationFailureLogCount: number;
}

export default function IntegrationsPage() {
  const [period, setPeriod] = useState<Period>(() => presetToPeriod(24, '24h'));
  const [data, setData] = useState<IntegrationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    setError('');
    try {
      const res = await observabilityApi.getIntegrations({
        startDate: p.startDate,
        endDate: p.endDate,
      });
      setData(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar dados de integrações');
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
        <LoadingState label="Carregando dados de integrações..." />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(period)} />
      ) : !data ? null : (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                Falhas de integração registradas (SystemLog)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{data.integrationFailureLogCount}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Pagamentos (PIX / TEF) por status</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.tefPix.length === 0 ? (
                <div className="p-6">
                  <EmptyState message="Nenhum pagamento PIX/TEF no período selecionado." />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b bg-muted/50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium">Método</th>
                        <th className="px-4 py-2 text-left text-xs font-medium">Status</th>
                        <th className="px-4 py-2 text-left text-xs font-medium">Quantidade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.tefPix.map((row, idx) => (
                        <tr key={idx} className="border-b last:border-0">
                          <td className="px-4 py-2 text-sm font-medium">{row.method}</td>
                          <td className="px-4 py-2 text-sm">{row.status}</td>
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
              <CardTitle className="text-base">Documentos fiscais por status</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.fiscal.length === 0 ? (
                <div className="p-6">
                  <EmptyState message="Nenhum documento fiscal no período selecionado." />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b bg-muted/50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium">Status</th>
                        <th className="px-4 py-2 text-left text-xs font-medium">Quantidade</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.fiscal.map((row, idx) => (
                        <tr key={idx} className="border-b last:border-0">
                          <td className="px-4 py-2 text-sm font-medium">{row.status}</td>
                          <td className="px-4 py-2 text-sm">{row.count}</td>
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
