'use client';

import { useRef, useState } from 'react';
import { Download, Paperclip, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiErrorMessage, supportAdminApi } from '@/lib/api';
import { ConfirmDialog } from './confirm-dialog';
import { InlineNotice } from './states';
import { errorText, formatBytes, formatDateTime, newIdempotencyKey } from '../_lib/format';
import type { SupportCatalog, TicketAttachment } from '../_lib/types';

const DEFAULT_TYPES: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt', '.log'],
};

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler o arquivo'));
    reader.readAsDataURL(file);
  });
}

/** Erro de download vem como Blob (responseType: 'blob'): lê o JSON de dentro para mostrar a mensagem da API. */
async function blobErrorText(err: any, fallback: string): Promise<string> {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try {
      return apiErrorMessage(JSON.parse(await data.text()), fallback);
    } catch {
      return fallback;
    }
  }
  return errorText(err, fallback);
}

/** Baixa com o cabeçalho Authorization (blob + URL temporária) — o token nunca vai na URL. */
export async function downloadAttachment(a: Pick<TicketAttachment, 'id' | 'fileName'>) {
  const res = await supportAdminApi.downloadAttachment(a.id);
  const url = URL.createObjectURL(res.data as Blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = a.fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

interface Props {
  ticketId: string;
  attachments: TicketAttachment[];
  catalog: SupportCatalog | null;
  closed: boolean;
  onChanged: () => void;
}

export function TicketAttachments({ ticketId, attachments, catalog, closed, onChanged }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [toRemove, setToRemove] = useState<TicketAttachment | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const types = catalog?.attachments.types ?? DEFAULT_TYPES;
  const maxBytes = catalog?.attachments.maxBytes ?? 2 * 1024 * 1024;
  const perTicket = catalog?.attachments.perTicket ?? 10;
  const exts = Object.values(types).flat();
  const active = attachments.filter((a) => !a.removed);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setNotice('');
    const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
    const mime = Object.keys(types).find((m) => types[m].includes(ext));
    // Checagens de conveniência; quem decide é o servidor (confere o conteúdo do arquivo).
    if (!mime) {
      setError(`Tipo de arquivo não aceito. Envie ${exts.join(', ')}.`);
      return;
    }
    if (file.size > maxBytes) {
      setError(`Arquivo grande demais (${formatBytes(file.size)}). O limite é ${formatBytes(maxBytes)}.`);
      return;
    }
    if (file.size === 0) {
      setError('O arquivo está vazio.');
      return;
    }
    if (active.length >= perTicket) {
      setError(`Este chamado já tem ${perTicket} anexos. Remova um antes de enviar outro.`);
      return;
    }
    setBusy(true);
    try {
      const contentBase64 = await readAsBase64(file);
      await supportAdminApi.addAttachment(ticketId, { fileName: file.name, mimeType: mime, contentBase64 }, newIdempotencyKey());
      setNotice(`Anexo “${file.name}” enviado.`);
      onChanged();
    } catch (err) {
      setError(errorText(err, 'Não foi possível enviar o anexo.'));
    } finally {
      setBusy(false);
    }
  }

  async function onDownload(a: TicketAttachment) {
    setError('');
    setDownloading(a.id);
    try {
      await downloadAttachment(a);
    } catch (err) {
      setError(await blobErrorText(err, 'Não foi possível baixar o anexo.'));
    } finally {
      setDownloading(null);
    }
  }

  async function confirmRemove() {
    if (!toRemove) return;
    setBusy(true);
    setError('');
    try {
      await supportAdminApi.removeAttachment(toRemove.id);
      setNotice(`Anexo “${toRemove.fileName}” removido.`);
      setToRemove(null);
      onChanged();
    } catch (err) {
      setError(errorText(err, 'Não foi possível remover o anexo.'));
      setToRemove(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 p-4 pb-2">
        <div className="min-w-0">
          <CardTitle className="text-base">Anexos</CardTitle>
          <p className="text-xs text-muted-foreground">
            {active.length} de {perTicket} · até {formatBytes(maxBytes)} · {exts.join(' ')}
          </p>
        </div>
        {!closed && (
          <>
            <input ref={inputRef} type="file" className="hidden" accept={exts.join(',')} onChange={onPick} data-testid="attachment-input" />
            <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={busy} data-testid="attachment-upload">
              <Upload className="mr-2 h-4 w-4" />
              {busy ? 'Enviando...' : 'Enviar'}
            </Button>
          </>
        )}
      </CardHeader>
      <CardContent className="space-y-2 p-4 pt-2">
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        {notice && !error && <InlineNotice tone="success">{notice}</InlineNotice>}
        {attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum anexo neste chamado.</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="attachment-list">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-2 p-2" data-testid="attachment-item">
                <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className={a.removed ? 'truncate text-sm text-muted-foreground line-through' : 'truncate text-sm'} title={a.fileName}>
                    {a.fileName}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {a.removed ? 'Removido · ' : ''}
                    {formatBytes(a.size)} · {a.uploadedBy?.name} · {formatDateTime(a.createdAt)}
                  </p>
                </div>
                {!a.removed && (
                  <div className="flex shrink-0 gap-1">
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onDownload(a)} disabled={downloading === a.id} aria-label={`Baixar ${a.fileName}`}>
                      <Download className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setToRemove(a)} disabled={busy} aria-label={`Remover ${a.fileName}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {closed && <p className="text-xs text-muted-foreground">Chamado encerrado não recebe novos anexos.</p>}
      </CardContent>
      <ConfirmDialog
        open={!!toRemove}
        title="Remover anexo?"
        description={`“${toRemove?.fileName ?? ''}” deixará de poder ser baixado. A remoção fica registrada no histórico do chamado.`}
        confirmLabel="Remover"
        destructive
        busy={busy}
        onConfirm={confirmRemove}
        onCancel={() => setToRemove(null)}
      />
    </Card>
  );
}
