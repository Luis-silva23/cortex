'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { observabilityApi } from '@/lib/api';
import { LoadingState, ErrorState, EmptyState } from '../_components/states';
import { formatDateTime } from '../_lib/format';
import { cn } from '@/lib/utils';

interface SystemLogRow {
  id: string;
  level: string;
  category: string;
  service: string;
  event: string;
  message: string;
  requestId: string | null;
  companyId: string | null;
  branchId: string | null;
  userId: string | null;
  device: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  metadata: unknown;
  createdAt: string;
}

interface SystemLogDetail extends SystemLogRow {
  stackTrace: string | null;
}

interface RequestLogRow {
  id: string;
  requestId: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  companyId: string | null;
  branchId: string | null;
  userId: string | null;
  device: string | null;
  createdAt: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

type Tab = 'system' | 'requests';

const LEVEL_OPTIONS = ['', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const CATEGORY_OPTIONS = ['', 'application', 'security', 'integration', 'performance'];

const levelColors: Record<string, string> = {
  DEBUG: 'bg-gray-100 text-gray-700',
  INFO: 'bg-blue-100 text-blue-800',
  WARN: 'bg-amber-100 text-amber-800',
  ERROR: 'bg-red-100 text-red-800',
  FATAL: 'bg-red-200 text-red-900',
};

function statusColor(status: number): string {
  if (status >= 500) return 'bg-red-100 text-red-800';
  if (status >= 400) return 'bg-amber-100 text-amber-800';
  if (status >= 300) return 'bg-blue-100 text-blue-800';
  return 'bg-green-100 text-green-800';
}

const emptySystemFilters = {
  level: '',
  category: '',
  service: '',
  event: '',
  requestId: '',
  userId: '',
  companyId: '',
  branchId: '',
  device: '',
  startDate: '',
  endDate: '',
};

const emptyRequestFilters = {
  route: '',
  statusCode: '',
  method: '',
  requestId: '',
  companyId: '',
  branchId: '',
  userId: '',
  device: '',
  startDate: '',
  endDate: '',
};

export default function LogsPage() {
  const [tab, setTab] = useState<Tab>('system');

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <Button variant={tab === 'system' ? 'default' : 'outline'} size="sm" onClick={() => setTab('system')}>
          Logs do Sistema
        </Button>
        <Button variant={tab === 'requests' ? 'default' : 'outline'} size="sm" onClick={() => setTab('requests')}>
          Requisições
        </Button>
      </div>

      {tab === 'system' ? <SystemLogsPanel /> : <RequestLogsPanel />}
    </div>
  );
}

function SystemLogsPanel() {
  const [filters, setFilters] = useState(emptySystemFilters);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<SystemLogRow[] | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SystemLogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const load = useCallback(async (f: typeof emptySystemFilters, p: number) => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, string | number> = { page: p, limit: 50 };
      Object.entries(f).forEach(([key, value]) => {
        if (value) params[key] = value;
      });
      const res = await observabilityApi.getSystemLogs(params);
      setRows(res.data.data);
      setPagination(res.data.pagination);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar logs do sistema');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filters, page);
  }, [page]);

  function applyFilters() {
    setPage(1);
    load(filters, 1);
  }

  function clearFilters() {
    setFilters(emptySystemFilters);
    setPage(1);
    load(emptySystemFilters, 1);
  }

  async function openDetail(id: string) {
    setSelectedId(id);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const res = await observabilityApi.getSystemLogById(id);
      setDetail(res.data);
    } catch (err: any) {
      setDetailError(err.response?.data?.error || 'Erro ao carregar detalhe do log');
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <FilterBar>
        <SelectField
          label="Nível"
          value={filters.level}
          onChange={(v) => setFilters({ ...filters, level: v })}
          options={LEVEL_OPTIONS}
        />
        <SelectField
          label="Categoria"
          value={filters.category}
          onChange={(v) => setFilters({ ...filters, category: v })}
          options={CATEGORY_OPTIONS}
        />
        <TextField label="Serviço" value={filters.service} onChange={(v) => setFilters({ ...filters, service: v })} />
        <TextField label="Evento" value={filters.event} onChange={(v) => setFilters({ ...filters, event: v })} />
        <TextField label="Request ID" value={filters.requestId} onChange={(v) => setFilters({ ...filters, requestId: v })} />
        <TextField label="Usuário" value={filters.userId} onChange={(v) => setFilters({ ...filters, userId: v })} />
        <TextField label="Empresa" value={filters.companyId} onChange={(v) => setFilters({ ...filters, companyId: v })} />
        <TextField label="Filial" value={filters.branchId} onChange={(v) => setFilters({ ...filters, branchId: v })} />
        <TextField label="Dispositivo" value={filters.device} onChange={(v) => setFilters({ ...filters, device: v })} />
        <DateField label="De" value={filters.startDate} onChange={(v) => setFilters({ ...filters, startDate: v })} />
        <DateField label="Até" value={filters.endDate} onChange={(v) => setFilters({ ...filters, endDate: v })} />
        <div className="flex items-end gap-2">
          <Button size="sm" onClick={applyFilters}>
            Filtrar
          </Button>
          <Button size="sm" variant="outline" onClick={clearFilters}>
            Limpar
          </Button>
        </div>
      </FilterBar>

      {loading ? (
        <LoadingState label="Carregando logs..." />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(filters, page)} />
      ) : !rows || rows.length === 0 ? (
        <EmptyState message="Nenhum log encontrado para os filtros selecionados." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium">Quando</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Nível</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Categoria</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Serviço</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Evento</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Mensagem</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                      onClick={() => openDetail(row.id)}
                    >
                      <td className="px-4 py-2 text-sm text-muted-foreground">{formatDateTime(row.createdAt)}</td>
                      <td className="px-4 py-2 text-sm">
                        <span className={cn('rounded-full px-2 py-1 text-xs font-medium', levelColors[row.level] || 'bg-gray-100 text-gray-800')}>
                          {row.level}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-sm">{row.category}</td>
                      <td className="px-4 py-2 text-sm">{row.service}</td>
                      <td className="px-4 py-2 text-sm font-medium">{row.event}</td>
                      <td className="max-w-md truncate px-4 py-2 text-sm text-muted-foreground" title={row.message}>
                        {row.message}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {pagination && <Pager pagination={pagination} onPageChange={setPage} />}

      <Dialog open={selectedId !== null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Detalhe do log</DialogTitle>
          </DialogHeader>
          {detailLoading ? (
            <p className="text-sm text-muted-foreground">Carregando...</p>
          ) : detailError ? (
            <p className="text-sm text-red-600">{detailError}</p>
          ) : detail ? (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nível" value={detail.level} />
                <Field label="Categoria" value={detail.category} />
                <Field label="Serviço" value={detail.service} />
                <Field label="Evento" value={detail.event} />
                <Field label="Request ID" value={detail.requestId || '-'} />
                <Field label="Usuário" value={detail.userId || '-'} />
                <Field label="Empresa" value={detail.companyId || '-'} />
                <Field label="Filial" value={detail.branchId || '-'} />
                <Field label="Dispositivo" value={detail.device || '-'} />
                <Field label="Duração" value={detail.durationMs ? `${detail.durationMs}ms` : '-'} />
                <Field label="Quando" value={formatDateTime(detail.createdAt)} />
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Mensagem</p>
                <p>{detail.message}</p>
              </div>
              {detail.errorMessage && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Erro</p>
                  <p className="text-red-700">{detail.errorMessage}</p>
                </div>
              )}
              {detail.metadata != null && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Metadados</p>
                  <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
                    {JSON.stringify(detail.metadata, null, 2)}
                  </pre>
                </div>
              )}
              {detail.stackTrace ? (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Stack trace</p>
                  <pre className="max-h-52 overflow-auto rounded bg-red-50 p-2 text-xs text-red-900">
                    {detail.stackTrace}
                  </pre>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Sem stack trace — este registro não representa um erro de execução.
                </p>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RequestLogsPanel() {
  const [filters, setFilters] = useState(emptyRequestFilters);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<RequestLogRow[] | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (f: typeof emptyRequestFilters, p: number) => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, string | number> = { page: p, limit: 50 };
      Object.entries(f).forEach(([key, value]) => {
        if (value) params[key] = key === 'statusCode' ? Number(value) : value;
      });
      const res = await observabilityApi.getRequestLogs(params);
      setRows(res.data.data);
      setPagination(res.data.pagination);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar logs de requisição');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filters, page);
  }, [page]);

  function applyFilters() {
    setPage(1);
    load(filters, 1);
  }

  function clearFilters() {
    setFilters(emptyRequestFilters);
    setPage(1);
    load(emptyRequestFilters, 1);
  }

  return (
    <div className="space-y-4">
      <FilterBar>
        <TextField label="Rota" value={filters.route} onChange={(v) => setFilters({ ...filters, route: v })} />
        <TextField label="Método" value={filters.method} onChange={(v) => setFilters({ ...filters, method: v })} />
        <TextField
          label="Status HTTP"
          value={filters.statusCode}
          onChange={(v) => setFilters({ ...filters, statusCode: v })}
        />
        <TextField label="Request ID" value={filters.requestId} onChange={(v) => setFilters({ ...filters, requestId: v })} />
        <TextField label="Usuário" value={filters.userId} onChange={(v) => setFilters({ ...filters, userId: v })} />
        <TextField label="Empresa" value={filters.companyId} onChange={(v) => setFilters({ ...filters, companyId: v })} />
        <TextField label="Filial" value={filters.branchId} onChange={(v) => setFilters({ ...filters, branchId: v })} />
        <TextField label="Dispositivo" value={filters.device} onChange={(v) => setFilters({ ...filters, device: v })} />
        <DateField label="De" value={filters.startDate} onChange={(v) => setFilters({ ...filters, startDate: v })} />
        <DateField label="Até" value={filters.endDate} onChange={(v) => setFilters({ ...filters, endDate: v })} />
        <div className="flex items-end gap-2">
          <Button size="sm" onClick={applyFilters}>
            Filtrar
          </Button>
          <Button size="sm" variant="outline" onClick={clearFilters}>
            Limpar
          </Button>
        </div>
      </FilterBar>

      {loading ? (
        <LoadingState label="Carregando requisições..." />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(filters, page)} />
      ) : !rows || rows.length === 0 ? (
        <EmptyState message="Nenhuma requisição encontrada para os filtros selecionados." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium">Quando</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Método</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Rota</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Status</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Duração</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Request ID</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="px-4 py-2 text-sm text-muted-foreground">{formatDateTime(row.createdAt)}</td>
                      <td className="px-4 py-2 text-sm font-medium">{row.method}</td>
                      <td className="px-4 py-2 text-sm font-mono">{row.route}</td>
                      <td className="px-4 py-2 text-sm">
                        <span className={cn('rounded-full px-2 py-1 text-xs font-medium', statusColor(row.statusCode))}>
                          {row.statusCode}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-sm">{row.durationMs}ms</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{row.requestId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {pagination && <Pager pagination={pagination} onPageChange={setPage} />}
    </div>
  );
}

function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5">{children}</CardContent>
    </Card>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input className="h-9 text-sm" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="datetime-local"
        className="h-9 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : '')}
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select className="h-9 text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt || 'Todos'}
          </option>
        ))}
      </Select>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="truncate">{value}</p>
    </div>
  );
}

function Pager({ pagination, onPageChange }: { pagination: Pagination; onPageChange: (p: number) => void }) {
  if (pagination.pages <= 1) return null;
  return (
    <div className="flex items-center justify-between text-sm">
      <p className="text-muted-foreground">
        Página {pagination.page} de {pagination.pages} · {pagination.total} registro(s)
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pagination.page <= 1}
          onClick={() => onPageChange(pagination.page - 1)}
        >
          Anterior
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pagination.page >= pagination.pages}
          onClick={() => onPageChange(pagination.page + 1)}
        >
          Próxima
        </Button>
      </div>
    </div>
  );
}
