'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ExcelImportDialog } from '@/components/import/ExcelImportDialog';
import {
  Plus,
  Search,
  Upload,
  Edit,
  Trash2,
  Users,
  Phone,
  Mail,
} from 'lucide-react';
import Link from 'next/link';
import { api, getCurrentUserClaims } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { canImportData, canRegisterCustomer, isManagerOrAbove } from '@/lib/role-gates';
import { Pagination } from '@/components/ui/pagination';
import { Badge } from '@/components/ui/badge';

const CUSTOMER_SCENARIOS = [
  {
    id: 'simple',
    label: 'Importação Simples',
    description: 'Importar clientes com informações básicas (nome, CPF/CNPJ, telefone)',
    requiredFields: ['name', 'document'],
  },
  {
    id: 'complete',
    label: 'Importação Completa',
    description: 'Importar clientes com todas as informações incluindo endereço',
    requiredFields: ['name', 'document', 'phone', 'email'],
  },
  {
    id: 'update',
    label: 'Atualizar Existentes',
    description: 'Atualizar clientes existentes usando CPF/CNPJ',
    requiredFields: ['document'],
  },
];

export default function CustomersPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [customers, setCustomers] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  // Só clientes ativos (DELETE é soft delete: o cliente continua na lista, com
  // isActive=false, e antes entrava na contagem do card).
  const [activeTotal, setActiveTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // PUT /customers/:id exige Gerência+ (a API responde 403 para os demais) —
  // lido no efeito, não no useState, porque o token só existe no navegador.
  const [canEdit, setCanEdit] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  // POST /import/* exige `data:import` e a API recusa o VIEWER sempre: o botão some para ele.
  const [canImport, setCanImport] = useState(false);

  useEffect(() => {
    const userType = getCurrentUserClaims()?.userType;
    setCanEdit(isManagerOrAbove(userType));
    setCanCreate(canRegisterCustomer(userType));
    setCanImport(canImportData(userType));
  }, []);

  useEffect(() => {
    loadCustomers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (page === 1) {
        loadCustomers();
      } else {
        setPage(1);
      }
    }, 400);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm]);

  const loadCustomers = async () => {
    setLoading(true);
    setError(null);
    try {
      const search = searchTerm || undefined;
      // A contagem de ativos é uma consulta separada (limit 1: só interessa o
      // `pagination.total`) para não depender da página atual. Se ela falhar, a
      // lista continua funcionando e o card mostra "—" em vez de um número errado.
      const [result, activeResult] = await Promise.all([
        api.getCustomers({ page, limit: 20, search }),
        api.getCustomers({ page: 1, limit: 1, search, isActive: true }).catch(() => null),
      ]);
      setCustomers(result?.customers ?? []);
      setTotal(result?.pagination?.total ?? result?.customers?.length ?? 0);
      setPages(result?.pagination?.pages ?? 1);
      setActiveTotal(activeResult?.pagination?.total ?? null);
    } catch (err) {
      console.error('Erro ao carregar clientes:', err);
      setError('Não foi possível carregar os clientes.');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Deseja realmente remover este cliente?')) return;
    setDeletingId(id);
    try {
      await api.deleteCustomer(id);
      await loadCustomers();
    } catch (err) {
      console.error('Erro ao remover cliente:', err);
      alert(getApiErrorMessage(err, 'Erro ao remover cliente'));
    } finally {
      setDeletingId(null);
    }
  };

  const handleImport = async (data: any[], _scenario: string) => {
    try {
      const result = await api.importCustomers(data);
      await loadCustomers();

      const rowErrors: Array<{ index: number; name?: string; error: string }> = result?.details?.errors ?? [];
      return {
        // Nunca "tudo importado" quando o backend relatou falha em alguma
        // linha (antes a tela ignorava `errors` e mostrava sucesso).
        success: rowErrors.length === 0,
        imported: result?.imported ?? 0,
        errors:
          rowErrors.length > 0
            ? rowErrors.map((e) => `Linha ${e.index}${e.name ? ` (${e.name})` : ''} — ${e.error}`)
            : undefined,
        warnings: (result?.details?.warnings ?? []).map((w: { index: number; warning: string }) => `Linha ${w.index} — ${w.warning}`),
      };
    } catch (err: any) {
      console.error('Erro ao importar clientes:', err);
      return {
        success: false,
        errors: [err?.response?.data?.error ?? err?.response?.data?.message ?? 'Erro ao importar clientes'],
      };
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Clientes</h1>
          <p className="text-muted-foreground mt-1">
            Gerencie seus clientes
          </p>
        </div>
        <div className="flex gap-3">
          {canImport && (
            <Button
              variant="outline"
              onClick={() => setImportDialogOpen(true)}
            >
              <Upload className="h-4 w-4 mr-2" />
              Importar Excel
            </Button>
          )}
          {canCreate && (
            <Link href="/dashboard/customers/new">
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Novo Cliente
              </Button>
            </Link>
          )}
        </div>
      </div>

      {error && (
        <Card className="p-4 border-danger/30 bg-danger-soft text-sm text-foreground">{error}</Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-1 gap-6">
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Clientes ativos</p>
              <p className="text-2xl font-bold mt-1">{activeTotal ?? '—'}</p>
            </div>
            <Users className="h-10 w-10 text-muted-foreground opacity-40" />
          </div>
        </Card>
      </div>

      <Card>
        <div className="p-6 border-b border-border">
          <div className="flex items-center gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome, CPF/CNPJ ou email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-muted-foreground">Carregando clientes...</div>
        ) : customers.length === 0 ? (
          <div className="p-12 text-center">
            <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-2">
              Nenhum cliente encontrado
            </h3>
            <p className="text-muted-foreground mb-4">
              {searchTerm
                ? 'Tente ajustar sua busca'
                : 'Comece adicionando seus primeiros clientes'}
            </p>
            {canImport && (
              <Button onClick={() => setImportDialogOpen(true)}>
                <Upload className="h-4 w-4 mr-2" />
                Importar do Excel
              </Button>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>CPF/CNPJ</TableHead>
                <TableHead>Contato</TableHead>
                <TableHead>Cidade</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((customer) => (
                <TableRow key={customer.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={customer.isActive === false ? 'text-muted-foreground' : undefined}>
                        {customer.name}
                      </span>
                      {/* DELETE é soft delete (isActive=false): o cliente segue na
                          lista, então precisa estar marcado como inativo. */}
                      {customer.isActive === false && <Badge variant="secondary">Inativo</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>{customer.document ?? '-'}</TableCell>
                  <TableCell>
                    <div className="text-sm">
                      <div className="flex items-center gap-1">
                        <Phone className="h-3 w-3 text-muted-foreground" />
                        {customer.phone ?? customer.mobile ?? '-'}
                      </div>
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Mail className="h-3 w-3 text-muted-foreground" />
                        {customer.email ?? '-'}
                      </div>
                      {customer.whatsapp && (
                        <div className="text-muted-foreground">
                          WhatsApp: {customer.whatsapp}
                          {customer.preferredContact === 'WHATSAPP' ? ' (preferencial)' : ''}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{customer.city ?? '-'}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      {canEdit && (
                        <Link href={`/dashboard/customers/${customer.id}`}>
                          <Button variant="ghost" size="icon" aria-label={`Editar ${customer.name}`}>
                            <Edit className="h-4 w-4" />
                          </Button>
                        </Link>
                      )}
                      {/* DELETE exige Gerência+ (a API responde 403 aos demais). */}
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remover ${customer.name}`}
                          disabled={deletingId === customer.id}
                          onClick={() => handleDelete(customer.id)}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Pagination page={page} pages={pages} total={total} itemCount={customers.length} onPageChange={setPage} itemLabel="clientes" />
      </Card>

      <ExcelImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        type="customer"
        scenarios={CUSTOMER_SCENARIOS}
        onImport={handleImport}
      />
    </div>
  );
}
