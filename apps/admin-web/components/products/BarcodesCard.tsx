'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';

interface BarcodeRow {
  id: string;
  code: string;
  isActive: boolean;
  isPrimary: boolean;
}

/**
 * Códigos de barras do produto: vários por produto, tratados como TEXTO (zeros à esquerda). Um código identifica UM produto na
 * empresa (a API recusa duplicado com 409). Desativar tira o código da leitura sem apagar o histórico; o produto (id, SKU) não muda.
 */
export default function BarcodesCard({ productId, onChanged }: { productId: string; onChanged?: () => void }) {
  const [rows, setRows] = useState<BarcodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.http.get(`/products/${productId}/barcodes`);
      setRows(data.barcodes ?? []);
      setError(null);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível carregar os códigos de barras.'));
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.http.post(`/products/${productId}/barcodes`, { code: code.trim() });
      setCode('');
      await load();
      onChanged?.();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível adicionar o código de barras.'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (row: BarcodeRow) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.http.patch(`/products/${productId}/barcodes/${row.id}`, { isActive: !row.isActive });
      await load();
      onChanged?.();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível alterar o código de barras.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-6" data-testid="barcodes-card">
      <CardHeader>
        <CardTitle>Códigos de barras</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Um produto pode ter vários códigos; cada código identifica um único produto. Desativar tira o código da leitura sem apagar o histórico.
        </p>
        {error && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum código de barras cadastrado.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2" data-testid="barcode-row">
                <span className="font-mono text-sm">
                  {row.code}
                  {row.isPrimary && <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs">Principal</span>}
                  {!row.isActive && <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs">Inativo</span>}
                </span>
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => toggle(row)}>
                  {row.isActive ? 'Desativar' : 'Reativar'}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={add} className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <label htmlFor="new-barcode" className="text-sm font-medium">
              Novo código de barras
            </label>
            <Input id="new-barcode" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Leia ou digite o código" inputMode="numeric" autoComplete="off" />
          </div>
          <Button type="submit" disabled={busy || !code.trim()}>
            <Plus className="mr-2 h-4 w-4" /> Adicionar
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
