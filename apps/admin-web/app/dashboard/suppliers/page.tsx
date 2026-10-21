'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Plus, Search, Truck, Phone, MapPin, AlertCircle } from 'lucide-react';
import { api, getCurrentUserClaims } from '@/lib/api';
import { isManagerOrAbove } from '@/lib/role-gates';
import { useDebounce } from '@/lib/hooks/useDebounce';

interface Supplier {
  id: string;
  name: string;
  document: string;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  isActive: boolean;
}

const PAGE_SIZE = 20;

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  // Consulta efetiva (termo já com debounce + página). Termo e página vivem no
  // mesmo estado para que uma busca nova volte à página 1 NA MESMA atualização
  // — assim sai uma única requisição por consulta, sem buscar antes uma página
  // que não existe no filtro novo.
  const [query, setQuery] = useState({ search: '', page: 1 });
  // PUT /suppliers/:id exige Gerência+ (403 para os demais); lido no efeito
  // porque o token só existe no navegador.
  const [canEdit, setCanEdit] = useState(false);

  const debouncedSearch = useDebounce(searchTerm.trim(), 400);

  useEffect(() => {
    setCanEdit(isManagerOrAbove(getCurrentUserClaims()?.userType));
  }, []);

  useEffect(() => {
    setQuery((q) => (q.search === debouncedSearch ? q : { search: debouncedSearch, page: 1 }));
  }, [debouncedSearch]);

  useEffect(() => {
    // `cancelled` descarta a resposta de uma consulta que já foi substituída
    // (digitar rápido ou trocar de página não deixa a resposta velha vencer).
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        // ACHADO DE AUDITORIA: a chamada ia sem page/limit e ignorava
        // `pagination` — só os primeiros 20 fornecedores eram alcançáveis.
        const result = await api.getSuppliers({
          page: query.page,
          limit: PAGE_SIZE,
          search: query.search || undefined,
        });
        if (cancelled) return;
        setSuppliers(result?.suppliers ?? []);
        setPagination({
          page: result?.pagination?.page ?? query.page,
          pages: result?.pagination?.pages ?? 1,
          total: result?.pagination?.total ?? result?.suppliers?.length ?? 0,
        });
      } catch (err) {
        if (cancelled) return;
        console.error('Erro ao carregar fornecedores:', err);
        setError('Não foi possível carregar os fornecedores. Tente novamente.');
        setSuppliers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [query]);

  const changePage = (page: number) => setQuery((q) => ({ ...q, page }));
  // Objeto novo com o mesmo conteúdo: dispara o efeito de novo (tentar novamente).
  const reload = () => setQuery((q) => ({ ...q }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Fornecedores</h1>
          <p className="text-muted-foreground mt-1">Gerencie os fornecedores da sua empresa</p>
        </div>
        {/* Criar/editar fornecedor exige Gerência+ (a API responde 403 aos demais). */}
        {canEdit && (
          <Link href="/dashboard/suppliers/new">
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Novo Fornecedor
            </Button>
          </Link>
        )}
      </div>

      <Card>
        <div className="p-6 border-b border-border">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por nome ou CPF/CNPJ..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-muted-foreground">Carregando...</div>
        ) : error ? (
          <div className="p-12 text-center">
            <AlertCircle className="h-12 w-12 mx-auto text-danger mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-2">Erro ao carregar</h3>
            <p className="text-muted-foreground mb-4">{error}</p>
            <Button variant="outline" onClick={reload}>
              Tentar novamente
            </Button>
          </div>
        ) : suppliers.length === 0 ? (
          <div className="p-12 text-center">
            <Truck className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-2">
              Nenhum fornecedor encontrado
            </h3>
            <p className="text-muted-foreground mb-4">
              {query.search
                ? 'Tente ajustar sua busca'
                : 'Comece cadastrando seu primeiro fornecedor'}
            </p>
            {canEdit && (
              <Link href="/dashboard/suppliers/new">
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Novo Fornecedor
                </Button>
              </Link>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>CPF/CNPJ</TableHead>
                <TableHead>Contato</TableHead>
                <TableHead>Cidade/UF</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.map((supplier) => (
                <TableRow key={supplier.id}>
                  <TableCell className="font-medium">{supplier.name}</TableCell>
                  <TableCell>{supplier.document}</TableCell>
                  <TableCell>
                    {supplier.phone ? (
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Phone className="h-3 w-3 text-muted-foreground" />
                        {supplier.phone}
                      </div>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell>
                    {supplier.city ? (
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <MapPin className="h-3 w-3 text-muted-foreground" />
                        {supplier.city}
                        {supplier.state ? `/${supplier.state}` : ''}
                      </div>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell>
                    {/* Só Gerência+ consegue salvar (PUT /suppliers/:id), então o
                        botão some para os demais papéis. */}
                    {canEdit && (
                      <Link href={`/dashboard/suppliers/${supplier.id}`}>
                        <Button variant="ghost" size="sm">
                          Editar
                        </Button>
                      </Link>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {!loading && !error && (
          <Pagination
            page={pagination.page}
            pages={pagination.pages}
            total={pagination.total}
            itemCount={suppliers.length}
            onPageChange={changePage}
            itemLabel="fornecedores"
          />
        )}
      </Card>
    </div>
  );
}
