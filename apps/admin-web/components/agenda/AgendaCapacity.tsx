'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card } from '@/components/ui/card';
import { api, getCurrentUserClaims } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { collectAllPages } from '@/lib/list-pagination';
import { pickMechanics } from '@/lib/service-orders';
import { isManagerOrAbove } from '@/lib/role-gates';
import {
  AGENDA_REFUSAL_LABEL,
  DURATION_MAX,
  DURATION_MIN,
  agendaApi,
  validateDuration,
  type AgendaAvailability,
  type AgendaUnavailability,
} from '@/lib/api/agenda';

/**
 * Capacidade configurável da agenda (docs/CORTEX/policies/AGENDA.md). A empresa/filial define a capacidade em
 * Configurações › Políticas; aqui a equipe vê, por horário, o que está livre e o que não está (cinza, com o motivo), e a
 * gerência registra indisponibilidades. Quem decide é a API — a tela só mostra o que ela devolve.
 */

export type Mechanic = { id: string; name: string };

/** Mecânicos ativos da empresa (a API recusa outro perfil, inativo ou de outra filial). */
export function useMechanics() {
  const [mechanics, setMechanics] = useState<Mechanic[]>([]);
  useEffect(() => {
    let cancelled = false;
    collectAllPages<any>((page) => api.getUsers({ userType: 'MECHANIC', isActive: true, page, limit: 100 }))
      .then((users) => !cancelled && setMechanics(pickMechanics(users)))
      .catch(() => !cancelled && setMechanics([]));
    return () => {
      cancelled = true;
    };
  }, []);
  return mechanics;
}

function localDateInput(d = new Date()) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DDTHH:mm' no fuso do navegador (valor de <input type="datetime-local">). */
export function toDateTimeLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Duração (min, vazio = padrão da filial) e mecânico previsto — usado ao propor e ao remarcar. */
export function AppointmentResourceFields({
  durationMinutes,
  mechanicId,
  mechanics,
  onChange,
  idPrefix,
}: {
  durationMinutes: string;
  mechanicId: string;
  mechanics: Mechanic[];
  onChange: (next: { durationMinutes: string; mechanicId: string }) => void;
  idPrefix: string;
}) {
  const durationError = validateDuration(durationMinutes);
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-duration`}>Duração (minutos)</Label>
        <Input
          id={`${idPrefix}-duration`}
          type="number"
          inputMode="numeric"
          min={DURATION_MIN}
          max={DURATION_MAX}
          value={durationMinutes}
          placeholder="Padrão da filial"
          onChange={(e) => onChange({ durationMinutes: e.target.value, mechanicId })}
        />
        {durationError && <p className="text-xs text-danger">{durationError}</p>}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-mechanic`}>Mecânico (opcional)</Label>
        <Select id={`${idPrefix}-mechanic`} value={mechanicId} onChange={(e) => onChange({ durationMinutes, mechanicId: e.target.value })}>
          <option value="">Sem mecânico definido</option>
          {mechanics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

function useBranches(enabled: boolean) {
  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (!enabled) return;
    api
      .getBranches()
      .then((res: any) => setBranches((res?.data ?? []).map((b: any) => ({ id: b.id, name: b.name }))))
      .catch(() => setBranches([]));
  }, [enabled]);
  return branches;
}

/**
 * Painel de capacidade: horários do dia (livres para escolher, ocupados em cinza com o motivo) e indisponibilidades.
 * `onPick` preenche a proposta com o horário escolhido (a API confere de novo ao gravar).
 */
export function AgendaCapacityPanel({
  mechanics,
  onPick,
  refreshKey,
}: {
  mechanics: Mechanic[];
  onPick: (pick: { scheduledAt: string; durationMinutes: string; mechanicId: string; branchId?: string }) => void;
  refreshKey: number;
}) {
  const [claims, setClaims] = useState<{ branchId?: string; userType?: string } | null>(null);
  useEffect(() => setClaims(getCurrentUserClaims()), []);
  const companyWide = !!claims && !claims.branchId;
  const canManage = isManagerOrAbove(claims?.userType);
  const branches = useBranches(companyWide);

  const [branchId, setBranchId] = useState('');
  const [date, setDate] = useState(localDateInput());
  const [durationMinutes, setDurationMinutes] = useState('');
  const [mechanicId, setMechanicId] = useState('');
  const [availability, setAvailability] = useState<AgendaAvailability | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (validateDuration(durationMinutes)) return;
    setLoading(true);
    setError(null);
    try {
      setAvailability(
        await agendaApi.availability({
          date,
          ...(branchId ? { branchId } : {}),
          ...(mechanicId ? { mechanicId } : {}),
          ...(durationMinutes.trim() ? { durationMinutes: Number(durationMinutes) } : {}),
        })
      );
    } catch (err) {
      setAvailability(null);
      setError(getApiErrorMessage(err, 'Não foi possível carregar os horários.'));
    } finally {
      setLoading(false);
    }
  }, [date, branchId, mechanicId, durationMinutes]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const limits = availability?.limits;
  const limitText = limits
    ? [
        limits.maxPerSlot !== null ? `${limits.maxPerSlot} por horário` : null,
        limits.boxCount !== null ? `${limits.boxCount} box(es)` : null,
        limits.maxPerDay !== null ? `${availability!.dayCount}/${limits.maxPerDay} no dia` : null,
        limits.maxPerMonth !== null ? `${availability!.monthCount}/${limits.maxPerMonth} no mês` : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-4" data-testid="agenda-availability">
        <div className="flex flex-wrap items-end gap-3">
          {companyWide && (
            <div className="space-y-1">
              <Label htmlFor="availability-branch">Filial</Label>
              <Select id="availability-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">Sem filial (empresa)</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="availability-date">Dia</Label>
            <Input id="availability-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="w-full sm:w-[28rem]">
            <AppointmentResourceFields
              idPrefix="availability"
              durationMinutes={durationMinutes}
              mechanicId={mechanicId}
              mechanics={mechanics}
              onChange={(next) => {
                setDurationMinutes(next.durationMinutes);
                setMechanicId(next.mechanicId);
              }}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {availability
            ? `Atendimento de ${availability.durationMinutes} min, horários de ${availability.slotMinutes} min (fuso ${availability.timezone}). ` +
              (limitText.length ? `Capacidade configurada: ${limitText.join(' · ')}.` : 'Sem limite de capacidade configurado.')
            : 'A capacidade (boxes, limites por horário/dia/mês, duração padrão) é definida em Configurações › Políticas.'}
        </p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {loading && !availability && <p className="text-sm text-muted-foreground">Carregando horários...</p>}
        {availability && (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" aria-label="Horários do dia">
            {availability.slots.map((slot) =>
              slot.available ? (
                <li key={slot.start}>
                  <button
                    type="button"
                    className="w-full rounded-md border border-border bg-card px-2 py-2 text-left text-sm text-foreground hover:bg-accent"
                    onClick={() => onPick({ scheduledAt: toDateTimeLocal(slot.start), durationMinutes, mechanicId, ...(branchId ? { branchId } : {}) })}
                    aria-label={`${slot.time} livre — propor neste horário`}
                  >
                    <span className="font-medium">{slot.time}</span>
                    <span className="block text-xs text-muted-foreground">Livre{slot.booked ? ` · ${slot.booked} marcado(s)` : ''}</span>
                  </button>
                </li>
              ) : (
                <li
                  key={slot.start}
                  className="rounded-md border border-border bg-muted px-2 py-2 text-sm text-muted-foreground"
                  title={slot.reason ?? undefined}
                  aria-disabled="true"
                  data-testid="agenda-slot-unavailable"
                >
                  <span className="font-medium">{slot.time}</span>
                  <span className="block text-xs">{slot.code ? AGENDA_REFUSAL_LABEL[slot.code] : 'Indisponível'}</span>
                  {slot.reason && <span className="sr-only">{slot.reason}</span>}
                </li>
              )
            )}
          </ul>
        )}
      </Card>

      <UnavailabilityManager
        canManage={canManage}
        companyWide={companyWide}
        branchId={branchId}
        branches={branches}
        mechanics={mechanics}
        onChanged={load}
      />
    </div>
  );
}

function UnavailabilityManager({
  canManage,
  companyWide,
  branchId,
  branches,
  mechanics,
  onChanged,
}: {
  canManage: boolean;
  companyWide: boolean;
  branchId: string;
  branches: Array<{ id: string; name: string }>;
  mechanics: Mechanic[];
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<AgendaUnavailability[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ startsAt: '', endsAt: '', mechanicId: '', reason: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await agendaApi.listUnavailabilities({ ...(branchId ? { branchId } : {}), from: new Date().toISOString() }));
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível carregar as indisponibilidades.'));
    }
  }, [branchId]);

  useEffect(() => {
    load();
  }, [load]);

  const branchName = (id: string) => branches.find((b) => b.id === id)?.name ?? '';

  async function save() {
    setError(null);
    setNotice(null);
    if (!form.startsAt || !form.endsAt) return setError('Informe o início e o fim.');
    if (new Date(form.endsAt) <= new Date(form.startsAt)) return setError('O fim precisa ser depois do início.');
    if (form.reason.trim().length < 3) return setError('Informe o motivo da indisponibilidade.');
    if (companyWide && !branchId) return setError('Escolha a filial acima: toda indisponibilidade é de uma filial.');
    setSaving(true);
    try {
      const created = await agendaApi.createUnavailability({
        ...(branchId ? { branchId } : {}),
        mechanicId: form.mechanicId || null,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        reason: form.reason.trim(),
      });
      setForm({ startsAt: '', endsAt: '', mechanicId: '', reason: '' });
      if (created.overlappingAppointments > 0) {
        setNotice(`Registrado. Há ${created.overlappingAppointments} agendamento(s) ativo(s) nesse período — eles não foram cancelados; remarque com o cliente.`);
      }
      await load();
      onChanged();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível registrar a indisponibilidade.'));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await agendaApi.removeUnavailability(id);
      await load();
      onChanged();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível remover a indisponibilidade.'));
    }
  }

  return (
    <Card className="p-4 space-y-3" data-testid="agenda-unavailabilities">
      <div>
        <h3 className="text-base font-semibold text-foreground">Indisponibilidades</h3>
        <p className="text-xs text-muted-foreground">
          Períodos em que a filial inteira ou um mecânico não atende (treinamento, manutenção, folga). Nenhum agendamento é
          aceito sobre eles. {canManage ? 'Registro e remoção ficam na auditoria.' : 'Só a gerência registra ou remove.'}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && <p className="rounded-md border border-border bg-warning-soft p-2 text-sm text-warning">{notice}</p>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma indisponibilidade futura.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="text-foreground">
                {new Date(u.startsAt).toLocaleString('pt-BR')} – {new Date(u.endsAt).toLocaleString('pt-BR')} ·{' '}
                {u.mechanicId ? `Mecânico ${u.mechanicName ?? ''}` : 'Filial inteira'}
                {companyWide && branchName(u.branchId) ? ` (${branchName(u.branchId)})` : ''}
                <span className="block text-xs text-muted-foreground">{u.reason}</span>
              </span>
              {canManage && (
                <Button size="sm" variant="outline" onClick={() => remove(u.id)}>
                  Remover
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="unavailability-start">Início</Label>
            <Input id="unavailability-start" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="unavailability-end">Fim</Label>
            <Input id="unavailability-end" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="unavailability-mechanic">Quem fica indisponível</Label>
            <Select id="unavailability-mechanic" value={form.mechanicId} onChange={(e) => setForm({ ...form, mechanicId: e.target.value })}>
              <option value="">A filial inteira</option>
              {mechanics.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="unavailability-reason">Motivo</Label>
            <Input
              id="unavailability-reason"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              placeholder="Ex.: treinamento da equipe"
            />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <Button onClick={save} disabled={saving}>
              {saving ? 'Registrando...' : 'Registrar indisponibilidade'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
