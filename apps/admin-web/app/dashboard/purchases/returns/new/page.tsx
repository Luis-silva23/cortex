'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Info, Plus, Save, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, getCurrentUserClaims } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { supplierReturnsApi } from '@/lib/api/supplier-returns';
import { buildCreatePayload, NOT_WARRANTY_NOTICE, REASON_LABEL, ReturnItemRow, SupplierReturnReason } from '@/lib/supplier-returns';

interface SupplierOption {
  id: string;
  name: string;
  document?: string;
}
interface ProductOption {
  id: string;
  name: string;
  sku: string;
  costPrice?: number | string;
}
interface Row extends ReturnItemRow {
  key: string;
  search: string;
  results: ProductOption[];
  searching: boolean;
}

const newRow = (): Row => ({
  key: Math.random().toString(36).slice(2),
  productId: '',
  productLabel: '',
  quantity: '1',
  unitCost: '',
  notes: '',
  search: '',
  results: [],
  searching: false,
});

const REASONS = Object.keys(REASON_LABEL) as SupplierReturnReason[];

export default function NewSupplierReturnPage() {
  const router = useRouter();
  const [companyWide, setCompanyWide] = useState(false);
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [branchId, setBranchId] = useState('');

  const [supplierSearch, setSupplierSearch] = useState('');
  const [supplierResults, setSupplierResults] = useState<SupplierOption[]>([]);
  const [supplier, setSupplier] = useState<SupplierOption | null>(null);

  const [reason, setReason] = useState<SupplierReturnReason | ''>('');
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<Row[]>([newRow()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const claims = getCurrentUserClaims();
    // Usuário preso a uma filial registra na própria filial (a API valida); empresa inteira escolhe a filial.
    const wide = !claims?.branchId;
    setCompanyWide(wide);
    if (!wide) return;
    api
      .getBranches()
      .then((res: any) => {
        const list = (res?.data ?? []).filter((b: any) => b.isActive !== false);
        setBranches(list);
        if (list.length === 1) setBranchId(list[0].id);
      })
      .catch(() => setBranches([]));
  }, []);

  useEffect(() => {
    if (!supplierSearch.trim() || supplier) {
      setSupplierResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.getSuppliers({ search: supplierSearch, limit: 10 });
        setSupplierResults(res?.suppliers ?? []);
      } catch {
        setSupplierResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [supplierSearch, supplier]);

  const update = (key: string, patch: Partial<Row>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  useEffect(() => {
    const timers = rows
      .filter((r) => r.search.trim() && !r.productId)
      .map((r) =>
        setTimeout(async () => {
          update(r.key, { searching: true });
          try {
            const res = await api.getProducts({ search: r.search, limit: 10 });
            update(r.key, { results: res?.products ?? [], searching: false });
          } catch {
            update(r.key, { results: [], searching: false });
          }
        }, 300)
      );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => `${r.key}:${r.search}:${r.productId}`).join('|')]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const built = buildCreatePayload(
      { supplierId: supplier?.id ?? '', branchId, reason, description, items: rows },
      { branchRequired: companyWide }
    );
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setSaving(true);
    try {
      const created = await supplierReturnsApi.create(built.payload);
      router.push(`/dashboard/purchases/returns/${created.id}`);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível registrar a devolução.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard/purchases/returns">
          <Button variant="ghost" size="icon" aria-label="Voltar">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-foreground">Nova devolução ao fornecedor</h1>
          <p className="mt-1 text-muted-foreground">A solicitação não mexe no estoque: a mercadoria sai do estoque só quando um responsável aprovar.</p>
        </div>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>{NOT_WARRANTY_NOTICE}</AlertDescription>
      </Alert>

      <form onSubmit={submit} className="space-y-6">
        {error && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
            {error}
          </p>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Fornecedor e motivo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative space-y-2">
              <Label htmlFor="sr-supplier">Fornecedor *</Label>
              {supplier ? (
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">{supplier.name}</p>
                    {supplier.document && <p className="text-xs text-muted-foreground">{supplier.document}</p>}
                  </div>
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setSupplier(null); setSupplierSearch(''); }}>
                    Trocar
                  </Button>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="sr-supplier"
                      className="pl-10"
                      placeholder="Buscar fornecedor por nome ou CPF/CNPJ"
                      value={supplierSearch}
                      onChange={(e) => setSupplierSearch(e.target.value)}
                    />
                  </div>
                  {supplierResults.length > 0 && (
                    <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-card shadow-lg">
                      {supplierResults.map((s) => (
                        <button
                          type="button"
                          key={s.id}
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                          onClick={() => { setSupplier(s); setSupplierResults([]); }}
                        >
                          <span className="font-medium text-foreground">{s.name}</span>
                          {s.document && <span className="block text-xs text-muted-foreground">{s.document}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {companyWide && (
              <div className="space-y-2">
                <Label htmlFor="sr-branch">Filial de onde sai a mercadoria *</Label>
                <Select id="sr-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  <option value="">Selecione a filial</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="sr-reason">Motivo *</Label>
              <Select id="sr-reason" value={reason} onChange={(e) => setReason(e.target.value as SupplierReturnReason | '')}>
                <option value="">Selecione o motivo</option>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {REASON_LABEL[r]}
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sr-description">Descrição do problema</Label>
              <Textarea
                id="sr-description"
                rows={3}
                maxLength={2000}
                placeholder="Ex.: caixa amassada na entrega; peça com rosca espanada; modelo diferente do pedido"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Produtos a devolver</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {rows.map((row) => (
              <div key={row.key} className="grid items-start gap-3 border-b border-border pb-4 last:border-b-0 last:pb-0 md:grid-cols-[1fr_110px_130px_1fr_40px]">
                <div className="relative">
                  <Label htmlFor={`p-${row.key}`} className="md:sr-only">
                    Produto
                  </Label>
                  <Input
                    id={`p-${row.key}`}
                    placeholder="Buscar produto por nome ou SKU"
                    value={row.search}
                    onChange={(e) => update(row.key, { search: e.target.value, productId: '', productLabel: '' })}
                  />
                  {!row.productId && row.search.trim() && (row.searching || row.results.length > 0) && (
                    <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border bg-card shadow-lg">
                      {row.searching ? (
                        <p className="p-3 text-sm text-muted-foreground">Buscando...</p>
                      ) : (
                        row.results.map((p) => (
                          <button
                            type="button"
                            key={p.id}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                            onClick={() =>
                              update(row.key, {
                                productId: p.id,
                                productLabel: `${p.name} (${p.sku})`,
                                search: `${p.name} (${p.sku})`,
                                unitCost: p.costPrice !== undefined && p.costPrice !== null ? String(p.costPrice) : '',
                                results: [],
                              })
                            }
                          >
                            <span className="font-medium text-foreground">{p.name}</span>
                            <span className="block text-xs text-muted-foreground">SKU: {p.sku}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <Label htmlFor={`q-${row.key}`} className="md:sr-only">
                    Quantidade
                  </Label>
                  <Input id={`q-${row.key}`} type="number" min="0" step="any" placeholder="Qtd" value={row.quantity} onChange={(e) => update(row.key, { quantity: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor={`c-${row.key}`} className="md:sr-only">
                    Custo unitário
                  </Label>
                  <Input id={`c-${row.key}`} type="number" min="0" step="0.01" placeholder="Custo unit." value={row.unitCost} onChange={(e) => update(row.key, { unitCost: e.target.value })} />
                </div>
                <div>
                  <Label htmlFor={`n-${row.key}`} className="md:sr-only">
                    Observação do item
                  </Label>
                  <Input id={`n-${row.key}`} placeholder="Observação (opcional)" maxLength={500} value={row.notes} onChange={(e) => update(row.key, { notes: e.target.value })} />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remover item"
                  disabled={rows.length === 1}
                  onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== row.key) : prev))}
                >
                  <Trash2 className="h-4 w-4 text-danger" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setRows((prev) => [...prev, newRow()])}>
              <Plus className="mr-2 h-4 w-4" />
              Adicionar produto
            </Button>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Link href="/dashboard/purchases/returns">
            <Button type="button" variant="outline">
              Cancelar
            </Button>
          </Link>
          <Button type="submit" disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? 'Registrando...' : 'Registrar solicitação'}
          </Button>
        </div>
      </form>
    </div>
  );
}
