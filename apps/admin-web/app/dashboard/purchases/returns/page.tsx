'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Info, PackageX, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { clampPage } from '@/lib/list-pagination';
import { getApiErrorMessage } from '@/lib/errors';
import { getCurrentUserClaims } from '@/lib/api';
import { supplierReturnsApi, SupplierReturnSummary } from '@/lib/api/supplier-returns';
import {
  NOT_WARRANTY_NOTICE,
  OUTCOME_LABEL,
  REASON_LABEL,
  STATUS_LABEL,
  STATUS_VARIANT,
  SupplierReturnStatus,
} from '@/lib/supplier-returns';

const PAGE_SIZE = 20;
const STATUSES = Object.keys(STATUS_LABEL) as SupplierReturnStatus[];

export default function SupplierReturnsPage() {
  const [rows, setRows] = useState<SupplierReturnSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SupplierReturnStatus | ''>('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<{ page: number; pages: number; total: number } | null>(null);
  const [canRequest, setCanRequest] = useState(false);

  useEffect(() => {
    const t = getCurrentUserClaims()?.userType;
    setCanRequest(!!t && ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR'].includes(t));
  }, []);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await supplierReturnsApi.list({ ...(status ? { status } : {}), page, limit: PAGE_SIZE });
      const target = clampPage(page, result.pagination?.pages);
      if (target !== page) {
        setPage(target);
        return;
      }
      setRows(result.returns ?? []);
      setPagination(result.pagination ?? null);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível carregar as devoluções. Tente novamente.'));
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, page]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Devolução ao fornecedor</h1>
          <p className="mt-1 text-muted-foreground">Mercadoria recebida que volta para o fornecedor: solicitação, aprovação, envio e resultado.</p>
        </div>
        {canRequest && (
          <Link href="/dashboard/purchases/returns/new">
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              Nova devolução
            </Button>
          </Link>
        )}
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>{NOT_WARRANTY_NOTICE}</AlertDescription>
      </Alert>

      <Card>
        <div className="border-b border-border p-6">
          <div className="w-64">
            <label htmlFor="sr-status" className="sr-only">
              Filtrar por situação
            </label>
            <Select
              id="sr-status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as SupplierReturnStatus | '');
                setPage(1);
              }}
            >
              <option value="">Todas as situações</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-muted-foreground">Carregando...</div>
        ) : error ? (
          <div className="p-12 text-center">
            <AlertCircle className="mx-auto mb-4 h-12 w-12 text-danger" />
            <p className="mb-4 text-muted-foreground">{error}</p>
            <Button variant="outline" onClick={load}>
              Tentar novamente
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center">
            <PackageX className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
            <h3 className="mb-2 text-lg font-medium text-foreground">Nenhuma devolução encontrada</h3>
            <p className="text-muted-foreground">{status ? 'Tente outra situação no filtro.' : 'Quando um produto recebido precisar voltar ao fornecedor, registre aqui.'}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nº</TableHead>
                <TableHead>Fornecedor</TableHead>
                <TableHead>Motivo</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead className="text-right">Itens</TableHead>
                <TableHead>Resultado</TableHead>
                <TableHead>Solicitada em</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">#{r.returnNumber}</TableCell>
                  <TableCell>{r.supplier?.name ?? '-'}</TableCell>
                  <TableCell>{REASON_LABEL[r.reason] ?? r.reason}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[r.status] ?? 'secondary'}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{r._count?.items ?? '-'}</TableCell>
                  <TableCell>{r.outcome ? OUTCOME_LABEL[r.outcome] ?? r.outcome : '-'}</TableCell>
                  <TableCell>{new Date(r.createdAt).toLocaleDateString('pt-BR')}</TableCell>
                  <TableCell>
                    <Link href={`/dashboard/purchases/returns/${r.id}`}>
                      <Button variant="ghost" size="sm">
                        Ver
                      </Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {!loading && !error && rows.length > 0 && (
          <Pagination
            page={pagination?.page ?? page}
            pages={pagination?.pages ?? 1}
            total={pagination?.total ?? rows.length}
            itemCount={rows.length}
            onPageChange={setPage}
            itemLabel="devoluções"
          />
        )}
      </Card>
    </div>
  );
}
