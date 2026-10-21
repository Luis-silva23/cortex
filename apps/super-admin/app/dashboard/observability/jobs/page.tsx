'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { observabilityApi } from '@/lib/api';
import { LoadingState, ErrorState, EmptyState } from '../_components/states';
import { StatusDot } from '../_components/severity-badge';
import { formatDateTime } from '../_lib/format';
import { AlertTriangle } from 'lucide-react';

interface FailedJob {
  id: string | null;
  name: string;
  failedReason: string | null;
  attemptsMade: number;
  timestamp: string | null;
}

interface QueueEntry {
  queue: string;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  };
  workerRunning: boolean;
  recentFailedJobs: FailedJob[];
}

interface JobsResponse {
  queues: QueueEntry[];
  deadLetterQueue: { auditLogFailedCount: number; note: string };
}

export default function JobsPage() {
  const [data, setData] = useState<JobsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await observabilityApi.getJobs();
      setData(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar estado das filas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingState label="Carregando filas..." />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      {data.deadLetterQueue.auditLogFailedCount > 0 && (
        <Card className="border-danger/40 bg-danger-soft">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 text-danger" />
            <div>
              <p className="text-sm font-semibold text-danger">
                {data.deadLetterQueue.auditLogFailedCount} job(s) de auditoria em fila morta
                (DLQ)
              </p>
              <p className="text-sm text-danger">{data.deadLetterQueue.note}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {data.queues.map((q) => (
          <Card key={q.queue}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{q.queue}</CardTitle>
              <StatusDot ok={q.workerRunning} />
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-lg font-bold">{q.counts.waiting}</p>
                <p className="text-xs text-muted-foreground">Aguardando</p>
              </div>
              <div>
                <p className="text-lg font-bold">{q.counts.active}</p>
                <p className="text-xs text-muted-foreground">Ativos</p>
              </div>
              <div>
                <p className="text-lg font-bold">{q.counts.delayed}</p>
                <p className="text-xs text-muted-foreground">Atrasados</p>
              </div>
              <div>
                <p className="text-lg font-bold">{q.counts.completed}</p>
                <p className="text-xs text-muted-foreground">Concluídos</p>
              </div>
              <div>
                <p className="text-lg font-bold">{q.counts.failed}</p>
                <p className="text-xs text-muted-foreground">Falhados</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Falhas recentes por fila</h2>
        {data.queues.every((q) => q.recentFailedJobs.length === 0) ? (
          <EmptyState message="Nenhuma falha recente registrada em nenhuma fila." />
        ) : (
          data.queues
            .filter((q) => q.recentFailedJobs.length > 0)
            .map((q) => (
              <Card key={q.queue}>
                <CardHeader>
                  <CardTitle className="text-sm">{q.queue}</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="border-b bg-muted/50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium">Job</th>
                          <th className="px-4 py-2 text-left text-xs font-medium">Motivo</th>
                          <th className="px-4 py-2 text-left text-xs font-medium">Tentativas</th>
                          <th className="px-4 py-2 text-left text-xs font-medium">Quando</th>
                        </tr>
                      </thead>
                      <tbody>
                        {q.recentFailedJobs.map((job, idx) => (
                          <tr key={job.id || idx} className="border-b last:border-0">
                            <td className="px-4 py-2 text-sm font-medium">{job.name}</td>
                            <td className="max-w-md truncate px-4 py-2 text-sm text-danger" title={job.failedReason || ''}>
                              {job.failedReason || '-'}
                            </td>
                            <td className="px-4 py-2 text-sm text-muted-foreground">{job.attemptsMade}</td>
                            <td className="px-4 py-2 text-sm text-muted-foreground">
                              {formatDateTime(job.timestamp)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            ))
        )}
      </div>
    </div>
  );
}
