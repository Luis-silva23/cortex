'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';

const MAX_BYTES = 1_048_576; // o servidor recusa acima de 1 MB (e confere o conteúdo de verdade)
const ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * Imagem OPCIONAL do produto (PNG, JPEG ou WebP, até 1 MB). O produto funciona igual sem ela. A imagem só é buscada com a sessão da
 * pessoa (rota autenticada) e mostrada por um endereço temporário do navegador; o servidor valida o conteúdo e remove metadados
 * (localização, aparelho) antes de guardar.
 */
export default function ImageCard({ productId }: { productId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const current = useRef<string | null>(null);

  const show = (url: string | null) => {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = url;
    setSrc(url);
  };

  const load = useCallback(async () => {
    try {
      const { data } = await api.http.get(`/products/${productId}/image`, { responseType: 'blob' });
      show(URL.createObjectURL(data));
      setError(null);
    } catch (err: any) {
      if (err?.response?.status === 404) show(null); // sem imagem: o normal
      else setError(getApiErrorMessage(err, 'Não foi possível carregar a imagem.'));
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void load();
    return () => {
      if (current.current) URL.revokeObjectURL(current.current);
    };
  }, [load]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busy) return;
    setError(null);
    if (file.size > MAX_BYTES) {
      setError('A imagem passa de 1 MB. Escolha uma menor.');
      return;
    }
    setBusy(true);
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
      await api.http.put(`/products/${productId}/image`, { contentBase64: btoa(binary) });
      await load();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível enviar a imagem.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.http.delete(`/products/${productId}/image`);
      show(null);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível remover a imagem.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="image-card">
      <CardHeader>
        <CardTitle className="text-base">Imagem do produto (opcional)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="Imagem do produto" className="max-h-48 rounded border border-border object-contain" data-testid="product-image" />
        ) : (
          <p className="text-sm text-muted-foreground">Este produto não tem imagem. Ela é opcional: o cadastro e as vendas funcionam sem ela.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={onFile} data-testid="image-file" aria-label="Escolher imagem do produto" />
          <Button type="button" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
            <ImagePlus className="mr-2 h-4 w-4" />
            {src ? 'Trocar imagem' : 'Enviar imagem'}
          </Button>
          {src && (
            <Button type="button" variant="outline" disabled={busy} onClick={remove}>
              <Trash2 className="mr-2 h-4 w-4" />
              Remover
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">PNG, JPEG ou WebP, até 1 MB. Os dados de localização e do aparelho presentes na foto são removidos ao guardar.</p>
      </CardContent>
    </Card>
  );
}
