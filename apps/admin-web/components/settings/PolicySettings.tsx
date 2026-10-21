'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { History, Pencil, RotateCcw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { isCompanyAdminOrAbove } from '@/lib/role-gates';
import { useUserType } from '@/lib/hooks/useUserType';
import { policiesApi, PolicyChange, PolicyRow } from '@/lib/api/policies';
import { fieldFor, formatPolicyValue, GROUP_LABELS, parsePolicyInput, SOURCE_LABELS } from '@/lib/policies';

type Branch = { id: string; name: string };

// Configurações → Políticas: a empresa define o padrão; a filial só muda o que o catálogo permite. A API valida,
// exige motivo, guarda o histórico e audita; a tela só mostra de onde vem cada valor e envia a mudança.
export function PolicySettings() {
  const { userType, ready } = useUserType();
  const canEdit = isCompanyAdminOrAbove(userType);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [scope, setScope] = useState<string>('company');
  const [rows, setRows] = useState<PolicyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<PolicyRow | null>(null);
  const [resetting, setResetting] = useState<PolicyRow | null>(null);
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const [history, setHistory] = useState<PolicyChange[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  const branchId = scope === 'company' ? null : scope;
  const branchName = branches.find((b) => b.id === branchId)?.name;

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setRows(await policiesApi.catalog(branchId));
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível carregar as políticas.'));
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    if (!ready) return;
    (async () => {
      try {
        const list = (await api.getBranches())?.data ?? [];
        setBranches(list.map((b: any) => ({ id: b.id, name: b.name })));
      } catch {
        setBranches([]);
      }
      try {
        const users = (await api.getUsers({ limit: 100 }))?.data ?? [];
        setNames(Object.fromEntries(users.map((u: any) => [u.id, u.name])));
      } catch {
        setNames({});
      }
    })();
  }, [ready]);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  const groups = useMemo(() => {
    const map = new Map<string, PolicyRow[]>();
    for (const r of rows) map.set(r.group, [...(map.get(r.group) ?? []), r]);
    return [...map.entries()].sort((a, b) => Object.keys(GROUP_LABELS).indexOf(a[0]) - Object.keys(GROUP_LABELS).indexOf(b[0]));
  }, [rows]);

  const openHistory = async (key: string) => {
    if (historyKey === key) {
      setHistoryKey(null);
      return;
    }
    setHistoryKey(key);
    setHistory([]);
    try {
      setHistory(await policiesApi.history({ key, branchId: branchId ?? 'company' }));
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível carregar o histórico.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Políticas</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Regras de funcionamento do CÓRTEX para esta empresa. O valor da empresa vale para todas as filiais; uma filial só
          tem valor próprio nas regras que permitem. Toda alteração exige motivo e fica no histórico e na auditoria.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Label htmlFor="policy-scope" className="shrink-0">
            Mostrar para
          </Label>
          <Select id="policy-scope" className="w-full sm:w-72" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="company">Empresa (padrão de todas as filiais)</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                Filial: {b.name}
              </option>
            ))}
          </Select>
        </div>

        {!canEdit && <p className="text-xs text-muted-foreground">Somente leitura: só o administrador da empresa altera as políticas.</p>}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {loading && <p className="text-sm text-muted-foreground">Carregando…</p>}

        {groups.map(([group, items]) => (
          <section key={group} className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{GROUP_LABELS[group] ?? group}</h3>
            <div className="divide-y divide-border rounded-lg border border-border">
              {items.map((row) => {
                const lockedForBranch = Boolean(branchId) && !row.branchOverridable;
                const canReset = canEdit && ((branchId && row.source === 'BRANCH') || (!branchId && row.companyValue !== null));
                return (
                  <div key={row.key} className="space-y-2 p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium text-foreground">{row.label}</p>
                        <p className="text-sm text-muted-foreground">{row.description}</p>
                        {lockedForBranch && <p className="text-xs text-muted-foreground">Vale para a empresa inteira (não muda por filial).</p>}
                      </div>
                      <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                        <span className="text-base font-semibold text-foreground">{formatPolicyValue(row.key, row.effective, row.default)}</span>
                        <Badge variant={row.source === 'DEFAULT' ? 'secondary' : 'outline'}>{SOURCE_LABELS[row.source]}</Badge>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {canEdit && !lockedForBranch && (
                        <Button variant="outline" size="sm" onClick={() => setEditing(row)} aria-label={`Alterar ${row.label}`}>
                          <Pencil className="mr-1 h-3.5 w-3.5" /> Alterar
                        </Button>
                      )}
                      {canReset && (
                        <Button variant="ghost" size="sm" onClick={() => setResetting(row)} aria-label={`Restaurar ${row.label}`}>
                          <RotateCcw className="mr-1 h-3.5 w-3.5" /> {branchId ? 'Voltar ao valor da empresa' : 'Voltar ao padrão'}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => openHistory(row.key)} aria-expanded={historyKey === row.key}>
                        <History className="mr-1 h-3.5 w-3.5" /> Histórico
                      </Button>
                    </div>
                    {historyKey === row.key && (
                      <div className="rounded-md bg-muted p-3 text-sm">
                        {history.length === 0 ? (
                          <p className="text-muted-foreground">Nenhuma alteração registrada {branchId ? 'nesta filial' : 'na empresa'}.</p>
                        ) : (
                          <ul className="space-y-2">
                            {history.map((h) => (
                              <li key={h.id}>
                                <span className="font-medium text-foreground">
                                  {formatPolicyValue(row.key, h.oldValue ?? row.default, row.default)} →{' '}
                                  {h.newValue === null ? 'padrão' : formatPolicyValue(row.key, h.newValue, row.default)}
                                </span>
                                <span className="block text-muted-foreground">
                                  {new Date(h.createdAt).toLocaleString('pt-BR')} · {names[h.changedBy] ?? 'usuário'} · “{h.reason}”
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        {editing && (
          <EditPolicyDialog
            row={editing}
            branchId={branchId}
            branchName={branchName}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await load();
            }}
          />
        )}
        {resetting && (
          <ResetPolicyDialog
            row={resetting}
            branchId={branchId}
            branchName={branchName}
            onClose={() => setResetting(null)}
            onDone={async () => {
              setResetting(null);
              await load();
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function EditPolicyDialog({
  row,
  branchId,
  branchName,
  onClose,
  onSaved,
}: {
  row: PolicyRow;
  branchId: string | null;
  branchName?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const field = fieldFor(row.key, row.default);
  const initial = field.kind === 'number' ? (row.effective === null || row.effective === undefined ? '' : String(row.effective).replace('.', ',')) : row.effective;
  const [raw, setRaw] = useState<unknown>(initial);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setError(null);
    const parsed = parsePolicyInput(field, raw);
    if ('error' in parsed) return setError(parsed.error);
    if (reason.trim().length < 5) return setError('Informe o motivo da alteração (mínimo 5 caracteres).');
    setSaving(true);
    try {
      await policiesApi.set(row.key, { value: parsed.value, branchId, reason: reason.trim() });
      onSaved();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível salvar.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onClose={onClose}>
        <DialogHeader>
          <DialogTitle>{row.label}</DialogTitle>
          <DialogDescription>{branchId ? `Valor próprio da filial ${branchName ?? ''}` : 'Valor da empresa (padrão de todas as filiais)'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6">
          <p className="text-sm text-muted-foreground">{row.description}</p>
          {field.kind === 'boolean' && (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" className="h-4 w-4" checked={Boolean(raw)} onChange={(e) => setRaw(e.target.checked)} />
              Ligado
            </label>
          )}
          {field.kind === 'number' && (
            <div className="space-y-1">
              <Label htmlFor="policy-value">Valor{field.suffix ? ` (${field.suffix})` : ''}</Label>
              <Input id="policy-value" inputMode="decimal" value={String(raw ?? '')} onChange={(e) => setRaw(e.target.value)} placeholder={field.nullable ? field.nullLabel : undefined} />
              {field.nullable && <p className="text-xs text-muted-foreground">Deixe vazio para “{field.nullLabel}”.</p>}
            </div>
          )}
          {field.kind === 'text' && (
            <div className="space-y-1">
              <Label htmlFor="policy-value">Valor</Label>
              <Input id="policy-value" value={String(raw ?? '')} onChange={(e) => setRaw(e.target.value)} />
            </div>
          )}
          {field.kind === 'enum' && (
            <div className="space-y-1">
              <Label htmlFor="policy-value">Valor</Label>
              <Select id="policy-value" value={String(raw ?? '')} onChange={(e) => setRaw(e.target.value)}>
                {field.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {field.kind === 'multi' && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">Selecione</legend>
              {field.options.map((o) => {
                const list = Array.isArray(raw) ? (raw as string[]) : [];
                return (
                  <label key={o.value} className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={list.includes(o.value)}
                      onChange={(e) => setRaw(e.target.checked ? [...list, o.value] : list.filter((v) => v !== o.value))}
                    />
                    {o.label}
                  </label>
                );
              })}
            </fieldset>
          )}
          <div className="space-y-1">
            <Label htmlFor="policy-reason">Motivo da alteração</Label>
            <Textarea id="policy-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: margem das peças mudou" />
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="pt-4">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPolicyDialog({
  row,
  branchId,
  branchName,
  onClose,
  onDone,
}: {
  row: PolicyRow;
  branchId: string | null;
  branchName?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (reason.trim().length < 5) return setError('Informe o motivo (mínimo 5 caracteres).');
    setSaving(true);
    setError(null);
    try {
      await policiesApi.reset(row.key, { branchId, reason: reason.trim() });
      onDone();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível restaurar.'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onClose={onClose}>
        <DialogHeader>
          <DialogTitle>{branchId ? 'Voltar ao valor da empresa' : 'Voltar ao padrão do sistema'}</DialogTitle>
          <DialogDescription>
            {row.label}
            {branchId ? ` — filial ${branchName ?? ''}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 px-6">
          <Label htmlFor="policy-reset-reason">Motivo</Label>
          <Textarea id="policy-reset-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="pt-4">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Restaurando…' : 'Restaurar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
