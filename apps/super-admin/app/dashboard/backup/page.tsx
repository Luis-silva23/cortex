'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { backupApi } from '@/lib/api';
import { LoadingState, ErrorState, EmptyState } from '../audit-logs/_components/states';
import { formatDateTime } from '../audit-logs/_lib/format';

interface BackupRow {
  filename: string;
  size: number;
  sizeFormatted: string;
  createdAt: string;
}

interface BackupStats {
  totalBackups: number;
  totalSize: number;
  totalSizeFormatted: string;
  oldestBackup: string | null;
  newestBackup: string | null;
}

export default function BackupPage() {
  const [backups, setBackups] = useState<BackupRow[] | null>(null);
  const [stats, setStats] = useState<BackupStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  // Mensagem CRUA devolvida pelo backend (result.error de BackupService,
  // ex.: falha real de pg_dump por FORCE ROW LEVEL SECURITY — TASK-003) —
  // nunca parafraseada como "sucesso" nem escondida atrás de um alert()
  // genérico.
  const [createResult, setCreateResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [listRes, statsRes] = await Promise.all([backupApi.list(), backupApi.stats()]);
      setBackups(listRes.data.data);
      setStats(statsRes.data.data);
    } catch (err: any) {
      setError(err.response?.data?.message || err.response?.data?.error || 'Erro ao carregar informações de backup');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    setCreating(true);
    setCreateResult(null);
    try {
      const res = await backupApi.create();
      setCreateResult({ ok: true, message: res.data.message || 'Backup criado com sucesso.' });
      await load();
    } catch (err: any) {
      // A rota devolve 500 com { error, message } quando o BackupService
      // falha (ver backup.routes.ts) — essa `message` é o motivo real
      // (hoje, neste ambiente: falta de um papel Postgres com BYPASSRLS,
      // ver docs/CORTEX/DATABASE.md, "Backup e restauração"), nunca um "erro
      // desconhecido" genérico.
      const message = err.response?.data?.message || err.response?.data?.error || 'Erro ao criar backup';
      setCreateResult({ ok: false, message });
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(filename: string) {
    if (!confirm(`Excluir o backup "${filename}"? Esta ação não pode ser desfeita.`)) return;
    try {
      await backupApi.remove(filename);
      await load();
    } catch (err: any) {
      alert(err.response?.data?.message || err.response?.data?.error || 'Erro ao excluir backup');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Backup</h1>
        <p className="text-muted-foreground">
          Backup do banco de dados inteiro (todas as empresas) — operação de plataforma, distinta do backup por
          empresa que porventura exista em outro lugar. Ver TASK-003 no registro de riscos: hoje, sem um papel
          Postgres dedicado com <code>BYPASSRLS</code> (exige superusuário), a criação de backup pode falhar de
          verdade — esta página mostra exatamente o que o servidor responde, nunca finge sucesso.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Backup manual</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              {stats
                ? stats.totalBackups > 0
                  ? `${stats.totalBackups} backup(s) · ${stats.totalSizeFormatted} · último em ${formatDateTime(stats.newestBackup!)}`
                  : 'Nenhum backup criado ainda.'
                : loading
                ? 'Carregando estatísticas...'
                : null}
            </div>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? 'Criando backup...' : 'Fazer backup agora'}
            </Button>
          </div>

          {createResult && (
            <div
              className={
                createResult.ok
                  ? 'rounded-lg border border-success/40 bg-success-soft p-3 text-sm text-success'
                  : 'rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger'
              }
            >
              {createResult.message}
            </div>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <LoadingState label="Carregando backups..." />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !backups || backups.length === 0 ? (
        <EmptyState message="Nenhum backup encontrado." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium">Arquivo</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Tamanho</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Criado em</th>
                    <th className="px-4 py-2 text-right text-xs font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map((b) => (
                    <tr key={b.filename} className="border-b last:border-0">
                      <td className="px-4 py-2 font-mono text-sm">{b.filename}</td>
                      <td className="px-4 py-2 text-sm text-muted-foreground">{b.sizeFormatted}</td>
                      <td className="px-4 py-2 text-sm text-muted-foreground">{formatDateTime(b.createdAt)}</td>
                      <td className="px-4 py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => handleDelete(b.filename)}>
                          Excluir
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
