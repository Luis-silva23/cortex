'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, BookOpen, Info, Paperclip, X } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { HelpTabs } from '@/components/support/HelpTabs';
import { getCurrentUserClaims } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { supportApi, type KbArticleSummary } from '@/lib/api/support';
import { checkAttachment, contextTrail, formatBytes, parseReportParams, type ReportContext, type SupportCatalog } from '@/lib/support';

type Preview = { label: string; entityTypeLabel: string; details: Record<string, unknown> };

const DETAIL_LABEL: Record<string, string> = { customer: 'Cliente', vehicle: 'Veículo', status: 'Situação', dueDate: 'Vencimento' };

function NewTicketForm() {
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();
  const [catalog, setCatalog] = useState<SupportCatalog | null>(null);
  const [ctx, setCtx] = useState<ReportContext | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [module, setModule] = useState('');
  const [type, setType] = useState('');
  const [priority, setPriority] = useState('NORMAL');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<KbArticleSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [platformUser, setPlatformUser] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPlatformUser(getCurrentUserClaims()?.userType === 'SUPER_ADMIN');
    supportApi
      .catalog()
      .then(setCatalog)
      .catch((err) => setLoadError(getApiErrorMessage(err, 'Não foi possível carregar o formulário. Recarregue a página.')));
  }, []);

  // Contexto vindo do "Relatar problema": módulo pré-selecionado, tipo "Problema" e a referência conferida pelo servidor.
  useEffect(() => {
    if (!catalog) return;
    const parsed = parseReportParams(params, catalog);
    setCtx(parsed);
    if (parsed) {
      setModule(parsed.module);
      setType((t) => t || 'PROBLEMA');
    }
    setPreview(null);
    setPreviewError(null);
    if (parsed?.entityType && parsed.entityId) {
      supportApi
        .contextPreview(parsed.entityType, parsed.entityId)
        .then(setPreview)
        .catch((err) => {
          setPreviewError(getApiErrorMessage(err, 'A referência desta tela não foi encontrada.'));
          setCtx({ ...parsed, entityType: undefined, entityId: undefined });
        });
    }
  }, [catalog, params]);

  // Sugestões da base de conhecimento enquanto o usuário escreve o assunto (nunca bloqueiam a abertura).
  useEffect(() => {
    const term = subject.trim();
    if (term.length < 4) {
      setSuggestions([]);
      return undefined;
    }
    const t = setTimeout(() => {
      supportApi
        .searchArticles({ q: term, limit: 5 })
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 400);
    return () => clearTimeout(t);
  }, [subject]);

  const limits = catalog?.attachments;
  const addFiles = (list: FileList | null) => {
    if (!list || !limits) return;
    setFileError(null);
    const next = [...files];
    for (const f of Array.from(list)) {
      const problem = checkAttachment(f, limits);
      if (problem) {
        setFileError(problem);
        continue;
      }
      if (next.length >= limits.perTicket) {
        setFileError(`No máximo ${limits.perTicket} anexos por chamado.`);
        break;
      }
      next.push(f);
    }
    setFiles(next);
    if (fileInput.current) fileInput.current.value = '';
  };

  const canSubmit = useMemo(
    () => subject.trim().length >= 3 && !!module && !!type && description.trim().length >= 10 && !submitting,
    [subject, module, type, description, submitting]
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const ticket = await supportApi.create({
        subject: subject.trim(),
        module,
        type,
        priority,
        description: description.trim(),
        context: {
          screen: ctx?.screen ?? 'Central de Ajuda — Novo chamado',
          route: ctx?.route ?? pathname ?? undefined,
          ...(ctx?.entityType && ctx.entityId ? { entityType: ctx.entityType, entityId: ctx.entityId } : {}),
        },
      });
      let failed = 0;
      for (const f of files) {
        try {
          await supportApi.attach(ticket.id, f);
        } catch {
          failed += 1;
        }
      }
      router.push(`/dashboard/help/tickets/${ticket.id}?novo=1${failed ? `&anexosFalharam=${failed}` : ''}`);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível abrir o chamado. Tente novamente.'));
      setSubmitting(false);
    }
  };

  if (platformUser) {
    return <Card className="p-8 text-center text-muted-foreground">A equipe CÓRTEX registra e responde chamados pelo Console de Suporte (Super Admin).</Card>;
  }
  if (loadError) {
    return (
      <p className="flex items-center gap-2 text-danger" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden /> {loadError}
      </p>
    );
  }
  if (!catalog) return <p className="text-muted-foreground">Carregando…</p>;

  const detailEntries = preview ? Object.entries(preview.details ?? {}).filter(([k, v]) => DETAIL_LABEL[k] && v) : [];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <form onSubmit={submit} className="space-y-5" noValidate>
        {(preview || ctx?.screen) && (
          <Alert data-testid="ticket-context">
            <Info className="h-4 w-4" aria-hidden />
            <AlertDescription>
              <span className="font-medium">Você está relatando um problema em: </span>
              {contextTrail(catalog.modules.find((m) => m.value === ctx?.module)?.label, ctx?.screen, preview?.label)}
              {detailEntries.length > 0 && (
                <span className="mt-1 block text-sm text-muted-foreground">
                  {detailEntries.map(([k, v]) => `${DETAIL_LABEL[k]}: ${k === 'dueDate' ? new Date(String(v)).toLocaleDateString('pt-BR') : String(v)}`).join(' · ')}
                </span>
              )}
            </AlertDescription>
          </Alert>
        )}
        {previewError && <p className="text-sm text-muted-foreground">{previewError} O chamado será aberto sem essa referência.</p>}

        <div className="space-y-2">
          <Label htmlFor="t-subject">Assunto *</Label>
          <Input id="t-subject" data-testid="ticket-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} placeholder="Ex.: Pagamento com cartão não confirmou" />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="t-module">Módulo *</Label>
            <Select id="t-module" data-testid="ticket-module" value={module} onChange={(e) => setModule(e.target.value)}>
              <option value="">Escolha…</option>
              {catalog.modules.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="t-type">Tipo *</Label>
            <Select id="t-type" data-testid="ticket-type" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Escolha…</option>
              {catalog.types.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="t-priority">Prioridade</Label>
            <Select id="t-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {catalog.priorities.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="t-description">Descrição *</Label>
          <Textarea
            id="t-description"
            data-testid="ticket-description"
            rows={7}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={10000}
            placeholder="O que você estava fazendo, o que esperava e o que aconteceu. Se apareceu uma mensagem, copie aqui."
          />
          <p className="text-xs text-muted-foreground">Não escreva senhas, códigos de acesso, tokens nem o número completo de cartão.</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="t-files">Anexos (opcional)</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={!!limits && files.length >= limits.perTicket}>
              <Paperclip className="mr-2 h-4 w-4" aria-hidden /> Escolher arquivos
            </Button>
            <span className="text-xs text-muted-foreground">PNG, JPG, PDF, TXT ou LOG · até {limits ? formatBytes(limits.maxBytes) : '2 MB'} cada</span>
          </div>
          <input
            ref={fileInput}
            id="t-files"
            data-testid="ticket-files"
            type="file"
            multiple
            className="sr-only"
            accept=".png,.jpg,.jpeg,.pdf,.txt,.log"
            onChange={(e) => addFiles(e.target.files)}
          />
          {fileError && (
            <p className="text-sm text-danger" role="alert">
              {fileError}
            </p>
          )}
          {files.length > 0 && (
            <ul className="space-y-1 text-sm">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center gap-2">
                  <span className="truncate text-foreground">{f.name}</span>
                  <span className="text-xs text-muted-foreground">{formatBytes(f.size)}</span>
                  <button type="button" aria-label={`Remover ${f.name}`} className="text-muted-foreground hover:text-foreground" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs text-muted-foreground">Seu nome, e-mail, telefone, empresa, filial, data e versão do sistema vão automaticamente com o chamado.</p>

        {error && (
          <p className="flex items-center gap-2 text-sm text-danger" role="alert">
            <AlertCircle className="h-4 w-4" aria-hidden /> {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!canSubmit} data-testid="ticket-submit">
            {submitting ? 'Abrindo chamado…' : 'Abrir chamado'}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.back()} disabled={submitting}>
            Cancelar
          </Button>
        </div>
      </form>

      <aside aria-label="Artigos que podem ajudar">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-4 w-4" aria-hidden /> Talvez isto ajude
            </CardTitle>
          </CardHeader>
          <CardContent>
            {suggestions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Escreva o assunto e mostraremos artigos da base de conhecimento relacionados.</p>
            ) : (
              <ul className="space-y-2" data-testid="ticket-suggestions">
                {suggestions.map((a) => (
                  <li key={a.id}>
                    <Link href={`/dashboard/help/articles/${a.slug}`} target="_blank" rel="noopener" className="text-sm font-medium text-foreground underline-offset-4 hover:underline">
                      {a.title}
                    </Link>
                    {a.summary && <p className="text-xs text-muted-foreground">{a.summary}</p>}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">Os artigos abrem em outra aba — o que você já escreveu aqui não se perde.</p>
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

/** Novo chamado. Empresa/filial/usuário vêm do token (a API ignora o que viesse do navegador). */
export default function NewTicketPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Ajuda e Suporte</h1>
        <p className="mt-1 text-muted-foreground">Conte o que aconteceu. A equipe CÓRTEX responde por aqui, e você acompanha em Meus chamados.</p>
      </div>
      <HelpTabs />
      <Suspense fallback={<p className="text-muted-foreground">Carregando…</p>}>
        <NewTicketForm />
      </Suspense>
    </div>
  );
}
