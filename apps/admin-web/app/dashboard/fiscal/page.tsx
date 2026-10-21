'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Pagination } from '@/components/ui/pagination';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Settings2, FileText, AlertCircle, Plus, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { clampPage } from '@/lib/list-pagination';
import { getApiErrorMessage } from '@/lib/errors';
import { useUserType } from '@/lib/hooks/useUserType';
import { COMPANY_ADMIN_ONLY_NOTICE, isCompanyAdminOrAbove } from '@/lib/role-gates';
import {
  branchIdForSale,
  buildFiscalConfigPayload,
  defaultFiscalForm,
  fiscalConfigToForm,
  hasStoredSecret,
  normalizeCancellationReason,
  isSaleOfferedForEmission,
} from '@/lib/fiscal';

const PAGE_SIZE = 50;

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Rascunho',
  PENDING: 'Pendente',
  AUTHORIZED: 'Autorizado',
  REJECTED: 'Rejeitado',
  CANCELLED: 'Cancelado',
  CONTINGENCY: 'Contingência',
};
const STATUS_VARIANT: Record<string, 'secondary' | 'warning' | 'success' | 'error' | 'default'> = {
  DRAFT: 'secondary',
  PENDING: 'warning',
  AUTHORIZED: 'success',
  REJECTED: 'error',
  CANCELLED: 'secondary',
  CONTINGENCY: 'default',
};

export default function FiscalPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Fiscal</h1>
        <p className="text-gray-500 mt-1">
          Sem provedor fiscal (SEFAZ/Focus NFe/eNotas) integrado neste ambiente — toda tentativa de emissão fica{' '}
          <strong>Pendente</strong>, nunca é falsamente marcada como autorizada.
        </p>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 flex gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-amber-800">
          Esta tela permite configurar os dados fiscais e acompanhar tentativas de emissão, mas nenhum documento é
          realmente autorizado pela SEFAZ sem um provedor real configurado no backend.
        </p>
      </div>

      <Tabs defaultValue="documents">
        <TabsList>
          <TabsTrigger value="documents">
            <FileText className="h-4 w-4 mr-1 inline" /> Documentos
          </TabsTrigger>
          <TabsTrigger value="config">
            <Settings2 className="h-4 w-4 mr-1 inline" /> Configuração
          </TabsTrigger>
        </TabsList>
        <TabsContent value="documents">
          <DocumentsPanel />
        </TabsContent>
        <TabsContent value="config">
          <ConfigPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DocumentsPanel() {
  const [documents, setDocuments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  // A API devolve `pagination` e a tela descartava: acima de 50 documentos, os
  // mais antigos ficavam inacessíveis.
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<{ page: number; pages: number; total: number } | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [sales, setSales] = useState<Array<{ id: string; saleNumber: number; totalAmount: number; branchId?: string | null }>>([]);
  const [saleId, setSaleId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [cancelTarget, setCancelTarget] = useState<any>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // A filial NÃO é escolhida à parte: a API só emite se `sale.branchId ===
  // branchId` (senão responde "Sale not found"), então ela vem sempre da venda
  // escolhida — escolher as duas de forma independente só permitia combinações
  // que a API recusava.
  const selectedBranchId = branchIdForSale(sales, saleId);
  const branchName = (id: string | null | undefined) => branches.find((b) => b.id === id)?.name ?? null;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getFiscalDocuments({ status: statusFilter || undefined, page, limit: PAGE_SIZE });
      // A página atual pode ter deixado de existir (ex.: a última linha dela foi
      // paga/cancelada): volta para a última página válida em vez de mostrar
      // uma tela vazia sem controle de paginação.
      const target = clampPage(page, result?.pagination?.pages);
      if (target !== page) {
        setPage(target);
        return;
      }
      setDocuments(result.documents ?? []);
      setPagination(result?.pagination ?? null);
    } catch (err) {
      console.error('Erro ao carregar documentos fiscais:', err);
      setError('Não foi possível carregar os documentos fiscais. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  // Trocar o filtro volta para a página 1 (no onChange do filtro) — a página 3
  // de um filtro novo pode nem existir. Um único efeito cobre filtro e página.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, page]);

  function openNew() {
    setSaleId('');
    setFormError(null);
    setDialogOpen(true);
    if (branches.length === 0) {
      api.getBranches().then((res) => setBranches(res?.data ?? [])).catch(() => setBranches([]));
    }
    if (sales.length === 0) {
      // Só vendas concluídas (pagas): cancelada/pendente não gera documento fiscal (a API também recusa).
      api
        .getSales({ limit: 50, status: 'PAID' })
        .then((res) => setSales((res?.sales ?? []).filter(isSaleOfferedForEmission)))
        .catch(() => setSales([]));
    }
  }

  async function save() {
    setFormError(null);
    if (!saleId) {
      setFormError('Escolha a venda para a qual tentar emitir o documento');
      return;
    }
    if (!selectedBranchId) {
      setFormError('Não foi possível identificar a filial desta venda');
      return;
    }
    setSaving(true);
    try {
      await api.emitFiscalDocument(saleId, selectedBranchId);
      setDialogOpen(false);
      await load();
    } catch (err: any) {
      setFormError(getApiErrorMessage(err, 'Erro ao tentar emitir documento fiscal'));
    } finally {
      setSaving(false);
    }
  }

  function openCancel(doc: any) {
    setCancelTarget(doc);
    setCancelReason('');
    setCancelError(null);
  }

  // A API exige o motivo ("Cancellation reason is required" → 400): antes o
  // prompt dizia "(opcional)" e mandava vazio, o que sempre falhava.
  async function submitCancel() {
    if (!cancelTarget) return;
    const reason = normalizeCancellationReason(cancelReason);
    if (!reason) {
      setCancelError('Informe o motivo do cancelamento (obrigatório).');
      return;
    }
    setCancelling(true);
    setCancelError(null);
    try {
      await api.cancelFiscalDocument(cancelTarget.id, reason);
      setCancelTarget(null);
      setCancelReason('');
      await load();
    } catch (err: any) {
      setCancelError(getApiErrorMessage(err, 'Erro ao cancelar documento fiscal'));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="w-64">
          <Select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos os status</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-2" />
          Tentar emitir para uma venda
        </Button>
      </div>

      <Card>
        {loading ? (
          <div className="p-12 text-center text-gray-500">Carregando...</div>
        ) : error ? (
          <div className="p-12 text-center">
            <AlertCircle className="h-12 w-12 mx-auto text-red-400 mb-4" />
            <p className="text-gray-500 mb-4">{error}</p>
            <Button variant="outline" onClick={load}>
              Tentar novamente
            </Button>
          </div>
        ) : documents.length === 0 ? (
          <div className="p-12 text-center text-gray-500">Nenhum documento fiscal encontrado.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Série/Número</TableHead>
                <TableHead>Valor</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Criado em</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((d: any) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.documentType}</TableCell>
                  <TableCell>
                    {d.series}/{d.number}
                  </TableCell>
                  <TableCell>{Number(d.totalAmount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[d.status] ?? 'secondary'}>{STATUS_LABEL[d.status] ?? d.status}</Badge>
                    {d.rejectionReason && <p className="text-xs text-danger mt-1">{d.rejectionReason}</p>}
                  </TableCell>
                  <TableCell>{new Date(d.createdAt).toLocaleString('pt-BR')}</TableCell>
                  <TableCell>
                    {['PENDING', 'AUTHORIZED', 'CONTINGENCY'].includes(d.status) && (
                      <Button size="sm" variant="outline" onClick={() => openCancel(d)}>
                        Cancelar
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {!loading && !error && documents.length > 0 && (
          <Pagination
            page={pagination?.page ?? page}
            pages={pagination?.pages ?? 1}
            total={pagination?.total ?? documents.length}
            itemCount={documents.length}
            onPageChange={setPage}
            itemLabel="documentos"
          />
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tentar emitir documento fiscal</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {formError && <p className="text-sm text-danger">{formError}</p>}
            <p className="text-xs text-amber-600">
              Sem provedor configurado, isto sempre fica Pendente — é o comportamento honesto do sistema, não um erro.
            </p>
            <div className="space-y-1">
              <Label>Venda</Label>
              <Select value={saleId} onChange={(e) => setSaleId(e.target.value)}>
                <option value="">Selecione...</option>
                {sales.map((s) => (
                  <option key={s.id} value={s.id}>
                    Venda #{s.saleNumber} — {Number(s.totalAmount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                    {branches.length > 1 && branchName(s.branchId) ? ` — ${branchName(s.branchId)}` : ''}
                  </option>
                ))}
              </Select>
              {sales.length >= 50 && (
                <p className="text-xs text-muted-foreground">Mostrando as 50 vendas mais recentes.</p>
              )}
            </div>
            {selectedBranchId && (
              <p className="text-sm text-muted-foreground" data-testid="fiscal-sale-branch">
                Filial da venda: <span className="font-medium text-foreground">{branchName(selectedBranchId) ?? selectedBranchId}</span>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Enviando...' : 'Tentar emitir'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancelTarget} onOpenChange={(open) => !open && setCancelTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Cancelar documento {cancelTarget ? `${cancelTarget.series}/${cancelTarget.number}` : ''}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {cancelError && <p className="text-sm text-danger">{cancelError}</p>}
            <div className="space-y-1">
              <Label>Motivo do cancelamento (obrigatório)</Label>
              <Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>
              Voltar
            </Button>
            <Button onClick={submitCancel} disabled={cancelling}>
              {cancelling ? 'Cancelando...' : 'Cancelar documento'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// A API só entrega a configuração fiscal a COMPANY_ADMIN/SUPER_ADMIN (ela guarda
// certificado e CSC): para os demais papéis a aba mostra um aviso de somente
// leitura em vez de tentar carregar e falhar com 403 "em silêncio".
function ConfigPanel() {
  const { userType, ready } = useUserType();
  if (!ready) return null;
  if (!isCompanyAdminOrAbove(userType)) {
    return (
      <Alert className="max-w-2xl">
        <AlertDescription>{COMPANY_ADMIN_ONLY_NOTICE}</AlertDescription>
      </Alert>
    );
  }
  return <ConfigEditor />;
}

function ConfigEditor() {
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [branchId, setBranchId] = useState('');
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [form, setForm] = useState(defaultFiscalForm());

  useEffect(() => {
    api
      .getBranches()
      .then((res) => setBranches(res?.data ?? []))
      .catch((err) => {
        setBranches([]);
        setBranchesError(getApiErrorMessage(err, 'Não foi possível carregar as filiais.'));
      });
  }, []);

  useEffect(() => {
    // Ao trocar de filial, zera tudo ANTES de buscar: sem isso, uma filial sem
    // configuração herdava os valores da anterior no formulário e "Salvar"
    // gravaria a configuração de uma filial na outra.
    setConfig(null);
    setForm(defaultFiscalForm());
    setSaved(false);
    setSaveError(null);
    setLoadError(null);
    setLoading(Boolean(branchId));
    if (!branchId) return undefined;

    // `cancelled` evita que a resposta de uma filial anterior (chegando fora de
    // ordem) sobrescreva a da filial atualmente escolhida.
    let cancelled = false;
    api
      .getFiscalConfig(branchId)
      .then((c) => {
        if (cancelled) return;
        // A API devolve `null` (200) quando a filial ainda não tem configuração
        // — isso é diferente de erro (403/500), que é mostrado abaixo.
        setConfig(c);
        setForm(fiscalConfigToForm(c));
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(getApiErrorMessage(err, 'Não foi possível carregar a configuração fiscal desta filial.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, reloadKey]);

  async function save() {
    if (!branchId) return;
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      // Só envia senha/token se o usuário digitou um valor NOVO — campo vazio
      // significa "manter o que já está gravado" (ver buildFiscalConfigPayload).
      const payload = buildFiscalConfigPayload(branchId, form);
      await api.upsertFiscalConfig(payload);
      setSaved(true);
      // Os campos de segredo voltam a ficar vazios e os indicadores "já
      // configurado" passam a refletir o que acabou de ser gravado.
      setForm((f) => ({ ...f, certificatePassword: '', cscToken: '' }));
      try {
        const fresh = await api.getFiscalConfig(branchId);
        setConfig(fresh);
      } catch {
        setConfig((c: any) => ({
          ...(c ?? {}),
          hasCertificatePassword: hasStoredSecret(c, 'certificatePassword') || Boolean(payload.certificatePassword),
          hasCscToken: hasStoredSecret(c, 'cscToken') || Boolean(payload.cscToken),
        }));
      }
    } catch (err: any) {
      setSaveError(getApiErrorMessage(err, 'Erro ao salvar configuração fiscal'));
    } finally {
      setSaving(false);
    }
  }

  const hasCertificatePassword = hasStoredSecret(config, 'certificatePassword');
  const hasCscToken = hasStoredSecret(config, 'cscToken');

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="space-y-1">
        <Label>Filial</Label>
        <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">Selecione uma filial...</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
        {branchesError && <p className="text-xs text-danger">{branchesError}</p>}
      </div>

      {branchId && (
        <Card className="p-5 space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Carregando...</p>
          ) : loadError ? (
            <div className="space-y-3">
              <p className="text-sm text-danger" role="alert">
                {loadError}
              </p>
              <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                Tentar novamente
              </Button>
            </div>
          ) : (
            <>
              {saveError && <p className="text-sm text-danger">{saveError}</p>}
              {saved && <p className="text-sm text-success">Configuração salva.</p>}
              {!config && (
                <p className="text-xs text-muted-foreground">
                  Nenhuma configuração ainda para esta filial — preencha e salve.
                </p>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-center gap-2">
                  <Checkbox checked={form.nfceEnabled} onChange={(e) => setForm({ ...form, nfceEnabled: e.target.checked })} />
                  <Label className="!mb-0">NFC-e habilitada</Label>
                </div>
                <div className="space-y-1">
                  <Label>Série NFC-e</Label>
                  <Input type="number" value={form.nfceSeriesNumber} onChange={(e) => setForm({ ...form, nfceSeriesNumber: e.target.value })} />
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox checked={form.nfeEnabled} onChange={(e) => setForm({ ...form, nfeEnabled: e.target.checked })} />
                  <Label className="!mb-0">NF-e habilitada</Label>
                </div>
                <div className="space-y-1">
                  <Label>Série NF-e</Label>
                  <Input type="number" value={form.nfeSeriesNumber} onChange={(e) => setForm({ ...form, nfeSeriesNumber: e.target.value })} />
                </div>
              </div>

              <div className="space-y-1">
                <Label>Caminho do certificado digital (.pfx)</Label>
                <Input value={form.certificatePath} onChange={(e) => setForm({ ...form, certificatePath: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>
                  Senha do certificado{' '}
                  {hasCertificatePassword && (
                    <span className="text-xs text-muted-foreground">(já configurada — deixe vazio para manter)</span>
                  )}
                </Label>
                {/* autoComplete="new-password": impede o navegador de preencher
                    aqui a senha de login salva — o campo só é enviado quando o
                    usuário digita um valor novo. */}
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={form.certificatePassword}
                  onChange={(e) => setForm({ ...form, certificatePassword: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label>CSC ID</Label>
                  <Input value={form.cscId} onChange={(e) => setForm({ ...form, cscId: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label>
                    CSC Token{' '}
                    {hasCscToken && (
                      <span className="text-xs text-muted-foreground">(já configurado — deixe vazio para manter)</span>
                    )}
                  </Label>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={form.cscToken}
                    onChange={(e) => setForm({ ...form, cscToken: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label>Ambiente</Label>
                  <Select value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>
                    <option value="HOMOLOGACAO">Homologação</option>
                    <option value="PRODUCAO">Produção</option>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Prazo de cancelamento (horas)</Label>
                  <Input type="number" value={form.cancelTimeLimit} onChange={(e) => setForm({ ...form, cancelTimeLimit: e.target.value })} />
                </div>
              </div>

              <Button onClick={save} disabled={saving}>
                {saving ? 'Salvando...' : 'Salvar configuração'}
              </Button>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
