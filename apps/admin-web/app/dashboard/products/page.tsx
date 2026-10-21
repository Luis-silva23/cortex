'use client';

import { useEffect, useState } from 'react';
import { formatCurrency } from '@/lib/utils';
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
import { Pagination } from '@/components/ui/pagination';
import {
  Plus,
  Search,
  Upload,
  Edit,
  Trash2,
  Package,
} from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { canImportData, isManagerOrAbove } from '@/lib/role-gates';
import { useUserType } from '@/lib/hooks/useUserType';

// O SKU é obrigatório em TODOS os cenários: é o identificador do produto (o
// modelo o exige) e a única chave segura para criar-ou-atualizar. Sem coluna
// SKU, a importação antiga sobrescrevia o primeiro produto da empresa.
const PRODUCT_SCENARIOS = [
  {
    id: 'basic',
    label: 'Importação Básica',
    description: 'Importar produtos com informações essenciais (SKU, nome, preço, estoque)',
    requiredFields: ['sku', 'name', 'price'],
  },
  {
    id: 'with-categories',
    label: 'Com Categorias',
    description: 'Importar produtos incluindo categorias',
    requiredFields: ['sku', 'name', 'price', 'category'],
  },
  {
    id: 'update',
    label: 'Atualizar Existentes',
    description: 'Atualizar produtos existentes usando SKU',
    requiredFields: ['sku', 'price'],
  },
];

const STOCK_SCENARIOS = [
  {
    id: 'initial',
    label: 'Estoque Inicial / Ajuste',
    description:
      'Mapeie SKU (e opcionalmente código de barras) para a quantidade. É criada uma movimentação de ajuste por produto encontrado.',
    requiredFields: ['sku', 'quantity'],
  },
];

export default function ProductsPage() {
  const [searchTerm, setSearchTerm] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [applicationFilter, setApplicationFilter] = useState('');
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [stockImportDialogOpen, setStockImportDialogOpen] = useState(false);
  const [products, setProducts] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Criar/editar/excluir produto exige Gerência+ (a API responde 403 aos demais).
  const { userType } = useUserType();
  const canEdit = isManagerOrAbove(userType);
  // POST /import/* exige `data:import` e a API recusa o VIEWER sempre: os botões de importação somem para ele.
  const canImport = canImportData(userType);

  useEffect(() => {
    loadProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const loadProducts = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getProducts({
        page,
        limit: 20,
        search: searchTerm || undefined,
        brand: brandFilter || undefined,
        application: applicationFilter || undefined,
      });
      setProducts(result?.products ?? []);
      setTotal(result?.pagination?.total ?? result?.products?.length ?? 0);
      setPages(result?.pagination?.pages ?? 1);
    } catch (err) {
      console.error('Erro ao carregar produtos:', err);
      setError('Não foi possível carregar os produtos.');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (value: string) => {
    setSearchTerm(value);
  };

  // Qualquer mudança de filtro/busca volta pra página 1 — continuar na
  // página 5 de um filtro novo poderia mostrar "nenhum resultado" mesmo
  // havendo resultados na página 1.
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (page === 1) {
        loadProducts();
      } else {
        setPage(1);
      }
    }, 400);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, brandFilter, applicationFilter]);

  const handleDelete = async (id: string) => {
    if (!confirm('Deseja realmente remover este produto?')) return;
    setDeletingId(id);
    try {
      await api.deleteProduct(id);
      await loadProducts();
    } catch (err) {
      console.error('Erro ao remover produto:', err);
      alert('Erro ao remover produto');
    } finally {
      setDeletingId(null);
    }
  };

  const handleImport = async (data: any[], _scenario: string) => {
    try {
      const result = await api.importProducts(data);
      await loadProducts();

      const rowErrors: Array<{ index: number; sku?: string; error: string }> = result?.details?.errors ?? [];
      return {
        // Nunca "tudo importado" quando o backend relatou falha em alguma
        // linha (antes a tela ignorava `errors` e mostrava sucesso).
        success: rowErrors.length === 0,
        imported: result?.imported ?? 0,
        errors:
          rowErrors.length > 0
            ? rowErrors.map((e) => `Linha ${e.index}${e.sku ? ` (SKU ${e.sku})` : ''} — ${e.error}`)
            : undefined,
        // avisos do servidor (ex.: custo não informado) — antes eram descartados
        warnings: (result?.details?.warnings ?? []).map(
          (w: { index: number; sku?: string; warning: string }) => `Linha ${w.index}${w.sku ? ` (SKU ${w.sku})` : ''} — ${w.warning}`
        ),
      };
    } catch (err: any) {
      console.error('Erro ao importar produtos:', err);
      return {
        success: false,
        errors: [getApiErrorMessage(err, 'Erro ao importar produtos')],
      };
    }
  };

  // Verifica, antes de confirmar, quais linhas (SKU/código de barras) casam
  // com produtos existentes. Nunca descarta silenciosamente uma linha sem
  // correspondência — o wizard mostra isso explicitamente ao usuário.
  const handlePreviewStockMatch = async (items: Array<{ sku?: string; barcode?: string }>) => {
    return api.previewStockImport(items);
  };

  const handleStockImport = async (data: any[], _scenario: string) => {
    try {
      const stockItems = data.map((row) => ({
        sku: row.sku,
        barcode: row.barcode,
        quantity: Number(row.quantity),
        reason: 'Importação de estoque via Excel/CSV',
      }));

      const result = await api.importStock(stockItems);
      await loadProducts();

      const backendErrors: Array<{ index: number; identifier?: string; error: string }> =
        result?.details?.errors ?? [];

      return {
        // Só reporta sucesso total se o backend não relatou nenhuma falha por
        // linha — resultado nunca é fabricado.
        success: backendErrors.length === 0,
        imported: result?.imported ?? 0,
        errors:
          backendErrors.length > 0
            ? backendErrors.map(
                (e) => `Linha ${e.index}: ${e.identifier ?? '-'} — ${e.error}`
              )
            : undefined,
      };
    } catch (err: any) {
      console.error('Erro ao importar estoque:', err);
      return {
        success: false,
        errors: [err?.response?.data?.error ?? 'Erro ao importar estoque'],
      };
    }
  };

  // Nota: a listagem de produtos (GET /products) não retorna o estoque atual
  // (isso exige uma chamada separada a GET /products/:id/stock por item), então
  // aqui usamos apenas o campo real "isActive" em vez de inventar um status de estoque.
  const getStatus = (product: any) => {
    return product.isActive
      ? { label: 'Ativo', color: 'bg-green-100 text-green-700' }
      : { label: 'Inativo', color: 'bg-gray-100 text-gray-700' };
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Produtos</h1>
          <p className="text-gray-500 mt-1">
            Gerencie seu catálogo de produtos
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {canImport && (
            <>
              <Button
                variant="outline"
                onClick={() => setImportDialogOpen(true)}
              >
                <Upload className="h-4 w-4 mr-2" />
                Importar Excel
              </Button>
              <Button
                variant="outline"
                onClick={() => setStockImportDialogOpen(true)}
              >
                <Upload className="h-4 w-4 mr-2" />
                Importar Estoque
              </Button>
            </>
          )}
          {canEdit && (
            <Link href="/dashboard/products/new">
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Novo Produto
              </Button>
            </Link>
          )}
        </div>
      </div>

      {error && (
        <Card className="p-4 border-red-200 bg-red-50 text-sm text-red-700">{error}</Card>
      )}

      <Card>
        <div className="p-6 border-b">
          <div className="flex flex-wrap items-center gap-4">
            <div className="relative flex-1 min-w-[220px] max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Buscar por nome, SKU, código de barras, marca ou aplicação..."
                value={searchTerm}
                onChange={(e) => handleSearch(e.target.value)}
                className="pl-10"
              />
            </div>
            <Input
              placeholder="Filtrar por marca"
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
              className="flex-1 min-w-[160px] max-w-xs"
            />
            <Input
              placeholder="Filtrar por aplicação (ex: CG 160)"
              value={applicationFilter}
              onChange={(e) => setApplicationFilter(e.target.value)}
              className="flex-1 min-w-[200px] max-w-xs"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-12 text-center text-gray-500">Carregando produtos...</div>
        ) : products.length === 0 ? (
          <div className="p-12 text-center">
            <Package className="h-12 w-12 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              Nenhum produto encontrado
            </h3>
            <p className="text-gray-500 mb-4">
              {searchTerm
                ? 'Tente ajustar sua busca'
                : 'Comece adicionando seus primeiros produtos'}
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
                <TableHead>SKU</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Marca</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Localização</TableHead>
                <TableHead className="text-right">Preço</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => {
                const status = getStatus(product);
                return (
                  <TableRow key={product.id}>
                    <TableCell className="font-medium">{product.sku}</TableCell>
                    <TableCell>{product.name}</TableCell>
                    <TableCell>{product.brand ?? '-'}</TableCell>
                    <TableCell>{product.category?.name ?? '-'}</TableCell>
                    <TableCell>{product.location ?? '-'}</TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(Number(product.salePrice ?? 0))}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`px-2 py-1 rounded-full text-xs font-medium ${status.color}`}
                      >
                        {status.label}
                      </span>
                    </TableCell>
                    <TableCell>
                      {canEdit && (
                        <div className="flex gap-2">
                          <Link href={`/dashboard/products/${product.id}`}>
                            <Button variant="ghost" size="icon" aria-label={`Editar ${product.name}`}>
                              <Edit className="h-4 w-4" />
                            </Button>
                          </Link>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Excluir ${product.name}`}
                            disabled={deletingId === product.id}
                            onClick={() => handleDelete(product.id)}
                          >
                            <Trash2 className="h-4 w-4 text-danger" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <Pagination page={page} pages={pages} total={total} itemCount={products.length} onPageChange={setPage} itemLabel="produtos" />
      </Card>

      <ExcelImportDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        type="product"
        scenarios={PRODUCT_SCENARIOS}
        onImport={handleImport}
      />

      <ExcelImportDialog
        open={stockImportDialogOpen}
        onOpenChange={setStockImportDialogOpen}
        type="stock"
        scenarios={STOCK_SCENARIOS}
        onImport={handleStockImport}
        onPreviewMatch={handlePreviewStockMatch}
      />
    </div>
  );
}
