'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { auditApi } from '@/lib/api';
import { LoadingState, ErrorState, EmptyState } from './_components/states';
import { formatDateTime } from './_lib/format';
import { cn } from '@/lib/utils';

interface AuditLogRow {
  id: string;
  companyId: string | null;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  oldValue: string | null;
  newValue: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  user: { id: string; name: string; numericId: number; userType: string } | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

// Espelha AuditAction em packages/database/prisma/schema.prisma — mantido
// em sincronia manual (é um enum pequeno e estável; se crescer muito,
// trocar por um endpoint que devolva os valores do enum diretamente).
const ACTION_OPTIONS = [
  '',
  'CREATE',
  'READ',
  'UPDATE',
  'DELETE',
  'LOGIN',
  'LOGOUT',
  'LOGIN_FAILED',
  'PASSWORD_RESET',
  'PERMISSION_CHANGED',
  'LICENSE_APPROVED',
  'LICENSE_SUSPENDED',
  'DEVICE_ACTIVATED',
  'DEVICE_BLOCKED',
];

const actionColors: Record<string, string> = {
  CREATE: 'bg-success-soft text-success',
  UPDATE: 'bg-muted text-foreground',
  DELETE: 'bg-danger-soft text-danger',
  LOGIN: 'bg-muted text-muted-foreground',
  LOGOUT: 'bg-muted text-muted-foreground',
  LOGIN_FAILED: 'bg-warning-soft text-warning',
  PASSWORD_RESET: 'bg-muted text-foreground',
  PERMISSION_CHANGED: 'bg-muted text-foreground',
  LICENSE_APPROVED: 'bg-success-soft text-success',
  LICENSE_SUSPENDED: 'bg-warning-soft text-warning',
  DEVICE_ACTIVATED: 'bg-success-soft text-success',
  DEVICE_BLOCKED: 'bg-danger-soft text-danger',
};

const emptyFilters = {
  companyId: '',
  userId: '',
  action: '',
  entity: '',
  entityId: '',
  startDate: '',
  endDate: '',
};

export default function AuditLogsPage() {
  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AuditLogRow[] | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditLogRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const load = useCallback(async (f: typeof emptyFilters, p: number) => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, string | number> = { page: p, limit: 50 };
      Object.entries(f).forEach(([key, value]) => {
        if (value) params[key] = value;
      });
      const res = await auditApi.list(params);
      setRows(res.data.data);
      setPagination(res.data.pagination);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar registros de auditoria');
    } finally {
      setLoading(false);
    }
  }, []);

  // filters é intencionalmente omitido do array de dependências — só muda
  // via applyFilters/clearFilters, que já resetam page e chamam load()
  // diretamente; mesmo padrão de app/dashboard/observability/logs/page.tsx.
  useEffect(() => {
    load(filters, page);
  }, [page]);

  function applyFilters() {
    setPage(1);
    load(filters, 1);
  }

  function clearFilters() {
    setFilters(emptyFilters);
    setPage(1);
    load(emptyFilters, 1);
  }

  async function openDetail(id: string) {
    setSelectedId(id);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const res = await auditApi.getById(id);
      setDetail(res.data.data);
    } catch (err: any) {
      setDetailError(err.response?.data?.error || 'Erro ao carregar detalhe do registro');
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Auditoria</h1>
        <p className="text-muted-foreground">
          Trilha de quem fez o quê, quando — todas as empresas (Super Admin). Ações do próprio Super Admin sobre uma
          empresa específica também aparecem no painel de auditoria daquela empresa.
        </p>
      </div>

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
          <TextField label="Empresa (ID)" value={filters.companyId} onChange={(v) => setFilters({ ...filters, companyId: v })} />
          <TextField label="Usuário (ID)" value={filters.userId} onChange={(v) => setFilters({ ...filters, userId: v })} />
          <SelectField label="Ação" value={filters.action} onChange={(v) => setFilters({ ...filters, action: v })} options={ACTION_OPTIONS} />
          <TextField label="Entidade" value={filters.entity} onChange={(v) => setFilters({ ...filters, entity: v })} />
          <TextField label="ID da entidade" value={filters.entityId} onChange={(v) => setFilters({ ...filters, entityId: v })} />
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
        </CardContent>
      </Card>

      {loading ? (
        <LoadingState label="Carregando registros de auditoria..." />
      ) : error ? (
        <ErrorState message={error} onRetry={() => load(filters, page)} />
      ) : !rows || rows.length === 0 ? (
        <EmptyState message="Nenhum registro de auditoria encontrado para os filtros selecionados." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium">Quando</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Ação</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Entidade</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">Usuário</th>
                    <th className="px-4 py-2 text-left text-xs font-medium">IP</th>
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
                        <span className={cn('rounded-full px-2 py-1 text-xs font-medium', actionColors[row.action] || 'bg-muted text-muted-foreground')}>
                          {row.action}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-sm font-medium">
                        {row.entity}
                        {row.entityId && <span className="ml-1 font-mono text-xs text-muted-foreground">#{row.entityId.slice(0, 8)}</span>}
                      </td>
                      <td className="px-4 py-2 text-sm">{row.user ? `${row.user.name} (${row.user.userType})` : '-'}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{row.ipAddress || '-'}</td>
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
            <DialogTitle>Detalhe do registro de auditoria</DialogTitle>
          </DialogHeader>
          {detailLoading ? (
            <p className="text-sm text-muted-foreground">Carregando...</p>
          ) : detailError ? (
            <p className="text-sm text-danger">{detailError}</p>
          ) : detail ? (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Ação" value={detail.action} />
                <Field label="Entidade" value={detail.entity} />
                <Field label="ID da entidade" value={detail.entityId || '-'} />
                <Field label="Empresa" value={detail.companyId || '-'} />
                <Field label="Usuário" value={detail.user ? `${detail.user.name} (${detail.user.userType})` : '-'} />
                <Field label="IP" value={detail.ipAddress || '-'} />
                <Field label="Quando" value={formatDateTime(detail.createdAt)} />
              </div>
              {detail.newValue && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Novo valor</p>
                  <pre className="max-h-52 overflow-auto rounded bg-muted p-2 text-xs">
                    {(() => {
                      try {
                        return JSON.stringify(JSON.parse(detail.newValue), null, 2);
                      } catch {
                        return detail.newValue;
                      }
                    })()}
                  </pre>
                </div>
              )}
              <div>
                <p className="text-xs font-medium text-muted-foreground">User-Agent</p>
                <p className="break-all text-xs text-muted-foreground">{detail.userAgent || '-'}</p>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
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
            {opt || 'Todas'}
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
        <Button size="sm" variant="outline" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)}>
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
