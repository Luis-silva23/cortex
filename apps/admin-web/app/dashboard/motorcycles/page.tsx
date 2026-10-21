'use client';

import { useEffect, useState } from 'react';
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
import { Plus, Search, Bike, Gauge, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { api, getCurrentUserClaims } from '@/lib/api';
import { canRegisterCustomer } from '@/lib/role-gates';
import { formatKilometers } from '@/lib/cadastros';
import { useDebounce } from '@/lib/hooks/useDebounce';

interface Motorcycle {
  id: string;
  brand: string;
  model: string;
  year?: number | null;
  licensePlate?: string | null;
  chassisNumber?: string | null;
  color?: string | null;
  // Decimal(10,1) no Prisma: a API serializa como string ("12000.0").
  kilometerReading?: number | string | null;
  customer?: { id: string; name: string; phone?: string | null } | null;
}

const PAGE_SIZE = 20;

export default function MotorcyclesPage() {
  const [searchTerm, setSearchTerm] = useState('');
  // Lido no efeito: o token só existe no navegador.
  const [canCreate, setCanCreate] = useState(false);
  useEffect(() => {
    setCanCreate(canRegisterCustomer(getCurrentUserClaims()?.userType));
  }, []);
  const [motorcycles, setMotorcycles] = useState<Motorcycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  // Consulta efetiva (termo já com debounce + página). Termo e página vivem no
  // mesmo estado para que uma busca nova volte à página 1 NA MESMA atualização
  // — assim sai uma única requisição por consulta, sem buscar antes uma página
  // que não existe no filtro novo.
  const [query, setQuery] = useState({ search: '', page: 1 });

  const debouncedSearch = useDebounce(searchTerm.trim(), 400);

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
        // `pagination` — só as primeiras 20 motos eram alcançáveis e o rodapé
        // dizia "Mostrando 20" mesmo com mais registros.
        const result = await api.getMotorcycles({
          page: query.page,
          limit: PAGE_SIZE,
          search: query.search || undefined,
        });
        if (cancelled) return;
        setMotorcycles(result?.motorcycles ?? []);
        setPagination({
          page: result?.pagination?.page ?? query.page,
          pages: result?.pagination?.pages ?? 1,
          total: result?.pagination?.total ?? result?.motorcycles?.length ?? 0,
        });
      } catch (err) {
        if (cancelled) return;
        console.error('Erro ao carregar motos:', err);
        setError('Não foi possível carregar as motos. Tente novamente.');
        setMotorcycles([]);
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
          <h1 className="text-3xl font-bold text-foreground">Motocicletas</h1>
          <p className="text-muted-foreground mt-1">
            Gerencie as motos cadastradas para seus clientes
          </p>
        </div>
        {canCreate && (
          <Link href="/dashboard/motorcycles/new">
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Nova Moto
            </Button>
          </Link>
        )}
      </div>

      <Card>
        <div className="p-6 border-b border-border">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por placa, chassi, marca ou modelo..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-muted-foreground">Carregando...</div>
        ) : error ? (
          // Antes a falha da API caía na mesma tela de "Nenhuma moto encontrada".
          <div className="p-12 text-center">
            <AlertCircle className="h-12 w-12 mx-auto text-danger mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-2">Erro ao carregar</h3>
            <p className="text-muted-foreground mb-4">{error}</p>
            <Button variant="outline" onClick={reload}>
              Tentar novamente
            </Button>
          </div>
        ) : motorcycles.length === 0 ? (
          <div className="p-12 text-center">
            <Bike className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-2">
              Nenhuma moto encontrada
            </h3>
            <p className="text-muted-foreground mb-4">
              {query.search
                ? 'Tente ajustar sua busca'
                : 'Comece cadastrando a primeira moto'}
            </p>
            {canCreate && (
              <Link href="/dashboard/motorcycles/new">
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Nova Moto
                </Button>
              </Link>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Marca / Modelo</TableHead>
                <TableHead>Ano</TableHead>
                <TableHead>Placa</TableHead>
                <TableHead>Proprietário</TableHead>
                <TableHead className="text-right">Km</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {motorcycles.map((moto) => (
                <TableRow key={moto.id}>
                  <TableCell className="font-medium">
                    {moto.brand} {moto.model}
                  </TableCell>
                  <TableCell>{moto.year ?? '-'}</TableCell>
                  <TableCell>{moto.licensePlate ?? '-'}</TableCell>
                  <TableCell>{moto.customer?.name ?? '-'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Gauge className="h-3 w-3 text-muted-foreground" />
                      {/* Decimal chega como string: formatKilometers converte com
                          Number() e trata null. */}
                      {formatKilometers(moto.kilometerReading)}
                    </div>
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
            itemCount={motorcycles.length}
            onPageChange={changePage}
            itemLabel="motos"
          />
        )}
      </Card>
    </div>
  );
}
