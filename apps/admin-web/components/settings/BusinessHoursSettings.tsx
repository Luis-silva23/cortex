'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { isCompanyAdminOrAbove } from '@/lib/role-gates';
import { useUserType } from '@/lib/hooks/useUserType';
import { BusinessDay, businessHoursApi, BusinessSchedule, CalendarException } from '@/lib/api/policies';

const WEEKDAYS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const KIND_LABELS: Record<CalendarException['kind'], string> = {
  HOLIDAY: 'Feriado (fechado)',
  CLOSED: 'Fechamento excepcional',
  SPECIAL_HOURS: 'Horário especial',
};

const emptyWeek = (): BusinessDay[] =>
  WEEKDAYS.map((_, weekday) => ({
    weekday,
    isClosed: weekday === 0,
    opensAt: weekday === 0 ? null : '08:00',
    closesAt: weekday === 0 ? null : '18:00',
    breakStart: null,
    breakEnd: null,
  }));

const toWeek = (days: BusinessDay[]): BusinessDay[] => {
  if (days.length !== 7) return emptyWeek();
  return [...days].sort((a, b) => a.weekday - b.weekday);
};

// Configurações → Funcionamento: horário por dia da semana da empresa, com horário próprio por filial quando
// necessário, e o calendário (feriados, fechamentos, horários especiais). A agenda usa este horário.
export function BusinessHoursSettings() {
  const { userType, ready } = useUserType();
  const canEdit = isCompanyAdminOrAbove(userType);
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [scope, setScope] = useState('company');
  const [schedule, setSchedule] = useState<BusinessSchedule | null>(null);
  const [week, setWeek] = useState<BusinessDay[]>(emptyWeek());
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exception, setException] = useState({ date: '', kind: 'HOLIDAY' as CalendarException['kind'], opensAt: '', closesAt: '', description: '' });

  const branchId = scope === 'company' ? null : scope;

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await businessHoursApi.get(branchId);
      setSchedule(s);
      // Filial sem horário próprio começa editando a partir do da empresa.
      setWeek(toWeek(branchId && s.source !== 'BRANCH' ? s.companyDays : s.days));
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível carregar o horário.'));
    }
  }, [branchId]);

  useEffect(() => {
    if (!ready) return;
    api
      .getBranches()
      .then((r: any) => setBranches((r?.data ?? []).map((b: any) => ({ id: b.id, name: b.name }))))
      .catch(() => setBranches([]));
  }, [ready]);

  useEffect(() => {
    if (ready) load();
  }, [ready, load]);

  const update = (weekday: number, patch: Partial<BusinessDay>) =>
    setWeek((w) => w.map((d) => (d.weekday === weekday ? { ...d, ...patch } : d)));

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
      setMessage(ok);
      await load();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível salvar.'));
    } finally {
      setSaving(false);
    }
  };

  const saveWeek = () =>
    run(
      () =>
        businessHoursApi.setWeek({
          branchId,
          days: week.map((d) => ({
            ...d,
            opensAt: d.isClosed ? null : d.opensAt || null,
            closesAt: d.isClosed ? null : d.closesAt || null,
            breakStart: d.isClosed ? null : d.breakStart || null,
            breakEnd: d.isClosed ? null : d.breakEnd || null,
          })),
        }),
      'Horário salvo.'
    );

  const visibleExceptions = (schedule?.exceptions ?? []).filter((e) => (branchId ? e.branchId === branchId || e.branchId === null : e.branchId === null));

  const sourceText =
    schedule?.source === 'BRANCH'
      ? 'Esta filial tem horário próprio.'
      : schedule?.source === 'COMPANY'
        ? branchId
          ? 'Esta filial segue o horário da empresa.'
          : 'Horário da empresa (vale para as filiais sem horário próprio).'
        : 'Nenhum horário cadastrado: nada é bloqueado por horário.';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Funcionamento</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Label htmlFor="hours-scope" className="shrink-0">
            Horário de
          </Label>
          <Select id="hours-scope" className="w-full sm:w-72" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="company">Empresa</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                Filial: {b.name}
              </option>
            ))}
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">
          {sourceText} {schedule ? `Fuso: ${schedule.timezone}.` : ''}
        </p>
        {!canEdit && <p className="text-xs text-muted-foreground">Somente leitura: só o administrador da empresa altera.</p>}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-foreground">
            {message}
          </p>
        )}

        <div className="space-y-2">
          {week.map((d) => (
            <div key={d.weekday} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-[10rem_7rem_1fr] sm:items-center">
              <span className="font-medium text-foreground">{WEEKDAYS[d.weekday]}</span>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={d.isClosed}
                  disabled={!canEdit}
                  onChange={(e) => update(d.weekday, { isClosed: e.target.checked, opensAt: e.target.checked ? null : '08:00', closesAt: e.target.checked ? null : '18:00' })}
                />
                Fechado
              </label>
              {!d.isClosed && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Input type="time" aria-label={`Abre — ${WEEKDAYS[d.weekday]}`} value={d.opensAt ?? ''} disabled={!canEdit} onChange={(e) => update(d.weekday, { opensAt: e.target.value })} />
                  <Input type="time" aria-label={`Fecha — ${WEEKDAYS[d.weekday]}`} value={d.closesAt ?? ''} disabled={!canEdit} onChange={(e) => update(d.weekday, { closesAt: e.target.value })} />
                  <Input type="time" aria-label={`Início do intervalo — ${WEEKDAYS[d.weekday]}`} value={d.breakStart ?? ''} disabled={!canEdit} onChange={(e) => update(d.weekday, { breakStart: e.target.value })} />
                  <Input type="time" aria-label={`Fim do intervalo — ${WEEKDAYS[d.weekday]}`} value={d.breakEnd ?? ''} disabled={!canEdit} onChange={(e) => update(d.weekday, { breakEnd: e.target.value })} />
                </div>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Colunas: abre, fecha, início e fim do intervalo (opcional).</p>
        </div>

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={saveWeek} disabled={saving}>
              {saving ? 'Salvando…' : branchId ? 'Salvar horário próprio da filial' : 'Salvar horário da empresa'}
            </Button>
            {branchId && schedule?.source === 'BRANCH' && (
              <Button variant="outline" disabled={saving} onClick={() => run(() => businessHoursApi.clearBranch(branchId), 'A filial voltou a seguir o horário da empresa.')}>
                Seguir o horário da empresa
              </Button>
            )}
          </div>
        )}

        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Feriados e datas especiais</h3>
          {visibleExceptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma data cadastrada.</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {visibleExceptions.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <span className="text-foreground">
                    {e.date.split('-').reverse().join('/')} · {KIND_LABELS[e.kind]}
                    {e.kind === 'SPECIAL_HOURS' ? ` ${e.opensAt}–${e.closesAt}` : ''}
                    {e.description ? ` · ${e.description}` : ''}
                    {branchId && e.branchId === null ? ' (empresa)' : ''}
                  </span>
                  {canEdit && (branchId ? e.branchId === branchId : true) && (
                    <Button variant="ghost" size="sm" aria-label={`Remover ${e.date}`} disabled={saving} onClick={() => run(() => businessHoursApi.removeException(e.id), 'Data removida.')}>
                      <Trash2 className="h-4 w-4 text-danger" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
              <div className="space-y-1">
                <Label htmlFor="exc-date">Data</Label>
                <Input id="exc-date" type="date" value={exception.date} onChange={(e) => setException({ ...exception, date: e.target.value })} />
              </div>
              <div className="space-y-1 lg:col-span-2">
                <Label htmlFor="exc-kind">Tipo</Label>
                <Select id="exc-kind" value={exception.kind} onChange={(e) => setException({ ...exception, kind: e.target.value as CalendarException['kind'] })}>
                  {Object.entries(KIND_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </div>
              {exception.kind === 'SPECIAL_HOURS' && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="exc-open">Abre</Label>
                    <Input id="exc-open" type="time" value={exception.opensAt} onChange={(e) => setException({ ...exception, opensAt: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="exc-close">Fecha</Label>
                    <Input id="exc-close" type="time" value={exception.closesAt} onChange={(e) => setException({ ...exception, closesAt: e.target.value })} />
                  </div>
                </>
              )}
              <div className="space-y-1 lg:col-span-2">
                <Label htmlFor="exc-desc">Descrição</Label>
                <Input id="exc-desc" value={exception.description} placeholder="Ex.: Tiradentes" onChange={(e) => setException({ ...exception, description: e.target.value })} />
              </div>
              <Button
                disabled={saving || !exception.date}
                onClick={() =>
                  run(
                    () =>
                      businessHoursApi
                        .addException({
                          branchId,
                          date: exception.date,
                          kind: exception.kind,
                          opensAt: exception.kind === 'SPECIAL_HOURS' ? exception.opensAt || null : null,
                          closesAt: exception.kind === 'SPECIAL_HOURS' ? exception.closesAt || null : null,
                          description: exception.description || null,
                        })
                        .then(() => setException({ date: '', kind: 'HOLIDAY', opensAt: '', closesAt: '', description: '' })),
                    'Data adicionada.'
                  )
                }
              >
                <Plus className="mr-1 h-4 w-4" /> Adicionar
              </Button>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
