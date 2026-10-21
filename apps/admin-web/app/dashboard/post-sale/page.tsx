'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
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
import { Plus, Calendar, Wrench, Bell, AlertCircle, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { CustomerPicker, type CustomerOption } from '@/components/quotes/CustomerPicker';
import { WarrantyPanel } from '@/components/post-sale/WarrantyPanel';
import { CompleteAppointmentDialog } from '@/components/agenda/CompleteAppointmentDialog';
import { agendaApi, agendaErrorCode, resourcesPayload, validateDuration } from '@/lib/api/agenda';
import { AgendaCapacityPanel, AppointmentResourceFields, useMechanics } from '@/components/agenda/AgendaCapacity';

export default function PostSalePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Pós-venda, Agenda e Revisões</h1>
        <p className="text-gray-500 mt-1">
          Acompanhamento de revisões periódicas, contato com o cliente e agendamento — a confirmação definitiva de
          um horário é sempre feita pelo cliente/responsável pelo veículo, nunca automaticamente.
        </p>
      </div>

      <Tabs defaultValue="post-sale">
        <TabsList>
          <TabsTrigger value="post-sale">
            <Bell className="h-4 w-4 mr-1 inline" /> Pós-venda
          </TabsTrigger>
          <TabsTrigger value="agenda">
            <Calendar className="h-4 w-4 mr-1 inline" /> Agenda
          </TabsTrigger>
          <TabsTrigger value="revisions">
            <Wrench className="h-4 w-4 mr-1 inline" /> Revisões
          </TabsTrigger>
          <TabsTrigger value="warranties">Garantias</TabsTrigger>
        </TabsList>
        <TabsContent value="post-sale">
          <PostSalePanel />
        </TabsContent>
        <TabsContent value="agenda">
          <AgendaPanel />
        </TabsContent>
        <TabsContent value="revisions">
          <RevisionsPanel />
        </TabsContent>
        <TabsContent value="warranties">
          <WarrantyPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seleção de cliente + moto reutilizada nos 3 formulários (Revisão/Follow-up/
// Agendamento) — motos ficam vazias até um cliente ser escolhido (a lista é
// filtrada por customerId, mesma regra do backend em motorcycle.service.ts).
// O cliente é escolhido por BUSCA no servidor (CustomerPicker): a antiga lista
// fixa de 200 era cortada em 100 pela API e o 101º cliente em diante não
// aparecia. Os formulários guardam só os ids; o cliente escolhido (para exibir
// o nome) fica aqui — o Dialog desmonta ao fechar, então cada abertura começa
// sem cliente.
// ---------------------------------------------------------------------------
function CustomerMotorcycleFields({
  customerId,
  motorcycleId,
  onCustomerChange,
  onMotorcycleChange,
}: {
  customerId: string;
  motorcycleId: string;
  onCustomerChange: (id: string) => void;
  onMotorcycleChange: (id: string) => void;
}) {
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [motorcycles, setMotorcycles] = useState<Array<{ id: string; brand: string; model: string; licensePlate?: string }>>([]);

  useEffect(() => {
    if (!customerId) {
      setMotorcycles([]);
      return;
    }
    let cancelled = false;
    api
      .getMotorcycles({ customerId, limit: 100 })
      .then((res) => {
        if (!cancelled) setMotorcycles(res.motorcycles ?? []);
      })
      .catch(() => {
        if (!cancelled) setMotorcycles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium leading-none text-foreground">Cliente</p>
        <CustomerPicker
          value={customer}
          onChange={(picked) => {
            setCustomer(picked);
            // Os pais atualizam o formulário com setForm funcional — os dois
            // avisos abaixo se acumulam (com `setForm({ ...form, ... })` o
            // segundo sobrescrevia o primeiro e o cliente nunca ficava salvo).
            onCustomerChange(picked?.id ?? '');
            onMotorcycleChange('');
          }}
        />
      </div>
      <div className="space-y-1">
        <Label>Moto</Label>
        <Select value={motorcycleId} onChange={(e) => onMotorcycleChange(e.target.value)} disabled={!customerId}>
          <option value="">{customerId ? 'Selecione...' : 'Selecione o cliente primeiro'}</option>
          {motorcycles.map((m) => (
            <option key={m.id} value={m.id}>
              {m.brand} {m.model} {m.licensePlate ? `— ${m.licensePlate}` : ''}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

function LoadingErrorEmpty({
  loading,
  error,
  empty,
  emptyIcon: EmptyIcon,
  emptyTitle,
  emptyDescription,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyIcon: any;
  emptyTitle: string;
  emptyDescription: string;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  if (loading) return <div className="p-12 text-center text-gray-500">Carregando...</div>;
  if (error)
    return (
      <div className="p-12 text-center">
        <AlertCircle className="h-12 w-12 mx-auto text-red-400 mb-4" />
        <p className="text-gray-500 mb-4">{error}</p>
        <Button variant="outline" onClick={onRetry}>
          Tentar novamente
        </Button>
      </div>
    );
  if (empty)
    return (
      <div className="p-12 text-center">
        <EmptyIcon className="h-12 w-12 mx-auto text-gray-400 mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">{emptyTitle}</h3>
        <p className="text-gray-500">{emptyDescription}</p>
      </div>
    );
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// PÓS-VENDA: exatamente os 3 baldes do dashboard (follow-up.service.ts::
// dashboard) — de propósito NÃO existe um 4º card "Aguardando contato":
// tentativas de contato são histórico (FollowUpEvent), nunca mudam o balde.
// ---------------------------------------------------------------------------
function PostSalePanel() {
  const [dashboard, setDashboard] = useState<{ upcomingRevisions: number; scheduled: number; cancelled: number } | null>(null);
  const [followUps, setFollowUps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'PENDING' | 'SCHEDULED' | 'CANCELLED' | ''>('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({ customerId: '', motorcycleId: '', dueDate: '', notes: '' });
  const [contactDialog, setContactDialog] = useState<{ id: string } | null>(null);
  const [contactChannel, setContactChannel] = useState<'PHONE' | 'WHATSAPP' | 'SMS' | 'EMAIL'>('WHATSAPP');
  const [contactMessage, setContactMessage] = useState('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [dash, list] = await Promise.all([
        api.getFollowUpDashboard(),
        api.getFollowUps({ status: statusFilter || undefined, limit: 50 }),
      ]);
      setDashboard(dash);
      setFollowUps(list.followUps ?? []);
    } catch (err) {
      console.error('Erro ao carregar pós-venda:', err);
      setError('Não foi possível carregar os dados de pós-venda. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  function openNew() {
    setForm({ customerId: '', motorcycleId: '', dueDate: '', notes: '' });
    setFormError(null);
    setDialogOpen(true);
  }

  async function save() {
    setFormError(null);
    if (!form.customerId || !form.motorcycleId || !form.dueDate) {
      setFormError('Cliente, moto e data prevista são obrigatórios');
      return;
    }
    setSaving(true);
    try {
      await api.createFollowUp({
        customerId: form.customerId,
        motorcycleId: form.motorcycleId,
        // Mesmo achado de auditoria de financial/page.tsx (dueDate): <input
        // type="date"> devolve "YYYY-MM-DD" puro, que `new Date()`
        // interpreta como meia-noite UTC, não local — exibia um dia a
        // menos para usuários em UTC-3. "T23:59:59" (sem fuso, portanto
        // horário local) corrige.
        dueDate: new Date(`${form.dueDate}T23:59:59`).toISOString(),
        notes: form.notes || undefined,
      });
      setDialogOpen(false);
      await load();
    } catch (err: any) {
      setFormError(getApiErrorMessage(err, 'Erro ao criar follow-up'));
    } finally {
      setSaving(false);
    }
  }

  async function submitContact() {
    if (!contactDialog) return;
    try {
      await api.logFollowUpContact(contactDialog.id, { channel: contactChannel, message: contactMessage || undefined });
      setContactDialog(null);
      setContactMessage('');
      await load();
    } catch (err) {
      console.error('Erro ao registrar contato:', err);
    }
  }

  async function accept(id: string) {
    try {
      await api.acceptFollowUp(id);
      await load();
    } catch (err) {
      console.error('Erro ao registrar aceite:', err);
    }
  }

  async function decline(id: string) {
    try {
      await api.declineFollowUp(id, 'Cliente recusou');
      await load();
    } catch (err) {
      console.error('Erro ao registrar recusa:', err);
    }
  }

  async function cancel(id: string) {
    try {
      await api.cancelFollowUp(id, 'Cancelado manualmente');
      await load();
    } catch (err) {
      console.error('Erro ao cancelar follow-up:', err);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <button
          onClick={() => setStatusFilter(statusFilter === 'PENDING' ? '' : 'PENDING')}
          className={`text-left rounded-lg border p-5 transition-colors ${statusFilter === 'PENDING' ? 'border-amber-400 bg-amber-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
        >
          <div className="flex items-center gap-2 text-amber-600 mb-1">
            <Clock className="h-4 w-4" />
            <span className="text-sm font-medium">Próximas revisões</span>
          </div>
          <p className="text-3xl font-bold text-gray-900">{dashboard?.upcomingRevisions ?? '—'}</p>
        </button>
        <button
          onClick={() => setStatusFilter(statusFilter === 'SCHEDULED' ? '' : 'SCHEDULED')}
          className={`text-left rounded-lg border p-5 transition-colors ${statusFilter === 'SCHEDULED' ? 'border-green-400 bg-green-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
        >
          <div className="flex items-center gap-2 text-green-600 mb-1">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-sm font-medium">Agendadas</span>
          </div>
          <p className="text-3xl font-bold text-gray-900">{dashboard?.scheduled ?? '—'}</p>
        </button>
        <button
          onClick={() => setStatusFilter(statusFilter === 'CANCELLED' ? '' : 'CANCELLED')}
          className={`text-left rounded-lg border p-5 transition-colors ${statusFilter === 'CANCELLED' ? 'border-red-400 bg-red-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
        >
          <div className="flex items-center gap-2 text-red-600 mb-1">
            <XCircle className="h-4 w-4" />
            <span className="text-sm font-medium">Canceladas</span>
          </div>
          <p className="text-3xl font-bold text-gray-900">{dashboard?.cancelled ?? '—'}</p>
        </button>
      </div>

      <div className="flex justify-end">
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-2" />
          Novo Follow-up
        </Button>
      </div>

      <Card>
        <LoadingErrorEmpty
          loading={loading}
          error={error}
          empty={followUps.length === 0}
          emptyIcon={Bell}
          emptyTitle="Nenhum follow-up encontrado"
          emptyDescription="Follow-ups aparecem aqui a partir de uma revisão registrada, ou podem ser criados manualmente."
          onRetry={load}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Moto</TableHead>
                <TableHead>Previsto para</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[320px]">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {followUps.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="font-medium">{f.customer?.name}</TableCell>
                  <TableCell>
                    {f.motorcycle ? `${f.motorcycle.brand} ${f.motorcycle.model}` : '-'}
                  </TableCell>
                  <TableCell>{new Date(f.dueDate).toLocaleDateString('pt-BR')}</TableCell>
                  <TableCell>
                    <Badge variant={f.status === 'PENDING' ? 'warning' : f.status === 'SCHEDULED' ? 'success' : 'error'}>
                      {f.status === 'PENDING' ? 'Próxima revisão' : f.status === 'SCHEDULED' ? 'Agendada' : 'Cancelada'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {f.status === 'PENDING' && (
                      <div className="flex gap-1 flex-wrap">
                        <Button size="sm" variant="outline" onClick={() => setContactDialog({ id: f.id })}>
                          Registrar contato
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => accept(f.id)}>
                          Aceitou
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => decline(f.id)}>
                          Recusou
                        </Button>
                      </div>
                    )}
                    {f.status !== 'CANCELLED' && f.status !== 'PENDING' && (
                      <Button size="sm" variant="outline" onClick={() => cancel(f.id)}>
                        Cancelar
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </LoadingErrorEmpty>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo Follow-up</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <CustomerMotorcycleFields
              customerId={form.customerId}
              motorcycleId={form.motorcycleId}
              onCustomerChange={(id) => setForm((f) => ({ ...f, customerId: id }))}
              onMotorcycleChange={(id) => setForm((f) => ({ ...f, motorcycleId: id }))}
            />
            <div className="space-y-1">
              <Label>Data prevista</Label>
              <Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Observações (opcional)</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Salvando...' : 'Salvar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!contactDialog} onOpenChange={(open) => !open && setContactDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Registrar tentativa de contato</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-500">
              Isso só adiciona ao histórico — não muda o status do follow-up (não existe &quot;Aguardando
              contato&quot; neste sistema).
            </p>
            <div className="space-y-1">
              <Label>Canal</Label>
              <Select value={contactChannel} onChange={(e) => setContactChannel(e.target.value as any)}>
                <option value="WHATSAPP">WhatsApp</option>
                <option value="PHONE">Telefone</option>
                <option value="SMS">SMS</option>
                <option value="EMAIL">E-mail</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Mensagem (opcional)</Label>
              <Input value={contactMessage} onChange={(e) => setContactMessage(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setContactDialog(null)}>
              Cancelar
            </Button>
            <Button onClick={submitContact}>Registrar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const APPOINTMENT_STATUS_LABEL: Record<string, string> = {
  PROPOSED: 'Proposto',
  CONFIRMED: 'Confirmado',
  CANCELLED: 'Cancelado',
  COMPLETED: 'Concluído',
  NO_SHOW: 'Não compareceu',
};
const APPOINTMENT_STATUS_VARIANT: Record<string, 'warning' | 'success' | 'error' | 'secondary'> = {
  PROPOSED: 'warning',
  CONFIRMED: 'success',
  CANCELLED: 'error',
  COMPLETED: 'secondary',
  NO_SHOW: 'secondary',
};

// ---------------------------------------------------------------------------
// AGENDA — REGRA FUNDAMENTAL: a oficina pode propor um horário, mas só
// "Confirmar" (appointment.service.ts::confirm) grava que o cliente/
// responsável pelo veículo de fato aceitou. Quem clica é sempre um
// funcionário atestando isso, nunca uma confirmação automática.
// ---------------------------------------------------------------------------
function AgendaPanel() {
  const [appointments, setAppointments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const emptyForm = { customerId: '', motorcycleId: '', scheduledAt: '', notes: '', durationMinutes: '', mechanicId: '', branchId: '' };
  const [form, setForm] = useState(emptyForm);
  const [rescheduleTarget, setRescheduleTarget] = useState<{ id: string } | null>(null);
  const [rescheduleAt, setRescheduleAt] = useState('');
  // [capacidade 2026-09-28] duração/mecânico ao propor e remarcar; horários ocupados em cinza com o motivo.
  const [rescheduleResources, setRescheduleResources] = useState({ durationMinutes: '', mechanicId: '' });
  const mechanics = useMechanics();
  const [capacityRefresh, setCapacityRefresh] = useState(0);
  const [confirmTarget, setConfirmTarget] = useState<{ id: string } | null>(null);
  const [confirmChannel, setConfirmChannel] = useState<'PHONE' | 'WHATSAPP' | 'SMS' | 'EMAIL' | 'IN_PERSON'>('WHATSAPP');
  const [confirmName, setConfirmName] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [completeTarget, setCompleteTarget] = useState<{ id: string; customerName?: string; scheduledAt?: string } | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getAppointments({ limit: 50 });
      setAppointments(result.appointments ?? []);
      setCapacityRefresh((n) => n + 1);
    } catch (err) {
      console.error('Erro ao carregar agenda:', err);
      setError('Não foi possível carregar a agenda. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openNew(prefill: Partial<typeof emptyForm> = {}) {
    setForm({ ...emptyForm, ...prefill });
    setFormError(null);
    setDialogOpen(true);
  }

  async function save() {
    setFormError(null);
    if (!form.customerId || !form.scheduledAt) {
      setFormError('Cliente e data/hora são obrigatórios');
      return;
    }
    const durationError = validateDuration(form.durationMinutes);
    if (durationError) {
      setFormError(durationError);
      return;
    }
    setSaving(true);
    try {
      await agendaApi.propose({
        customerId: form.customerId,
        motorcycleId: form.motorcycleId || undefined,
        scheduledAt: new Date(form.scheduledAt).toISOString(),
        notes: form.notes || undefined,
        ...resourcesPayload(form),
        ...(form.branchId ? { branchId: form.branchId } : {}),
      });
      setDialogOpen(false);
      await load();
    } catch (err: any) {
      setFormError(getApiErrorMessage(err, 'Erro ao propor agendamento'));
    } finally {
      setSaving(false);
    }
  }

  // Confirmar = registrar que o CLIENTE/responsável pelo veículo aceitou o horário: quem confirmou e por qual canal
  // são obrigatórios (o funcionário que clica só registra).
  function confirm(id: string) {
    setConfirmTarget({ id });
    setConfirmChannel('WHATSAPP');
    setConfirmName('');
    setConfirmError(null);
  }

  async function submitConfirm() {
    if (!confirmTarget) return;
    setConfirmError(null);
    try {
      await api.confirmAppointment(confirmTarget.id, { channel: confirmChannel, confirmedByName: confirmName.trim() });
      setConfirmTarget(null);
      await load();
    } catch (err) {
      setConfirmError(getApiErrorMessage(err, 'Não foi possível confirmar o agendamento'));
    }
  }

  // [agenda 2026-09-27] Horário lotado / fora do funcionamento (409 SLOT_FULL / OUTSIDE_BUSINESS_HOURS) e demais
  // recusas aparecem na tela em vez de só no console.
  async function submitReschedule() {
    if (!rescheduleTarget || !rescheduleAt) return;
    setRescheduleError(null);
    const durationError = validateDuration(rescheduleResources.durationMinutes);
    if (durationError) {
      setRescheduleError(durationError);
      return;
    }
    try {
      // Campos já vêm preenchidos com os do agendamento: vazio = volta à duração padrão / tira o mecânico.
      await agendaApi.reschedule(rescheduleTarget.id, {
        newScheduledAt: new Date(rescheduleAt).toISOString(),
        reason: 'Reagendado pela oficina',
        durationMinutes: rescheduleResources.durationMinutes.trim() ? Number(rescheduleResources.durationMinutes) : null,
        mechanicId: rescheduleResources.mechanicId || null,
      });
      setRescheduleTarget(null);
      setRescheduleAt('');
      await load();
    } catch (err) {
      setRescheduleError(getApiErrorMessage(err, 'Não foi possível reagendar'));
    }
  }

  async function cancel(id: string) {
    setActionError(null);
    try {
      await api.cancelAppointment(id, 'Cancelado manualmente');
      await load();
    } catch (err) {
      setActionError(getApiErrorMessage(err, 'Não foi possível cancelar o agendamento'));
    }
  }

  // Concluir: sem a confirmação do cliente a API recusa (409 APPOINTMENT_NOT_CONFIRMED) e a tela abre o pedido de
  // autorização de um responsável — o funcionário não conclui sozinho.
  async function complete(appointment: any) {
    setActionError(null);
    try {
      await agendaApi.complete(appointment.id);
      await load();
    } catch (err) {
      if (agendaErrorCode(err) === 'APPOINTMENT_NOT_CONFIRMED') {
        setCompleteTarget({ id: appointment.id, customerName: appointment.customer?.name, scheduledAt: appointment.scheduledAt });
        return;
      }
      setActionError(getApiErrorMessage(err, 'Não foi possível concluir o agendamento'));
    }
  }

  async function noShow(id: string) {
    setActionError(null);
    try {
      await api.markAppointmentNoShow(id);
      await load();
    } catch (err) {
      setActionError(getApiErrorMessage(err, 'Não foi possível marcar o não comparecimento'));
    }
  }

  return (
    <div className="space-y-4">
      {actionError && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" data-testid="agenda-action-error">
          {actionError}
        </p>
      )}
      <div className="flex justify-end">
        <Button onClick={() => openNew()}>
          <Plus className="h-4 w-4 mr-2" />
          Propor Agendamento
        </Button>
      </div>

      <AgendaCapacityPanel mechanics={mechanics} refreshKey={capacityRefresh} onPick={(pick) => openNew(pick)} />

      <Card>
        <LoadingErrorEmpty
          loading={loading}
          error={error}
          empty={appointments.length === 0}
          emptyIcon={Calendar}
          emptyTitle="Nenhum agendamento"
          emptyDescription="Proponha um horário para um cliente — a confirmação definitiva é sempre dele."
          onRetry={load}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Moto</TableHead>
                <TableHead>Data/Hora</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[380px]">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {appointments.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.customer?.name}</TableCell>
                  <TableCell>{a.motorcycle ? `${a.motorcycle.brand} ${a.motorcycle.model}` : '-'}</TableCell>
                  <TableCell>
                    {new Date(a.scheduledAt).toLocaleString('pt-BR')}
                    <span className="block text-xs text-muted-foreground">
                      {a.effectiveDurationMinutes ? `${a.effectiveDurationMinutes} min` : ''}
                      {a.mechanic ? ` · ${a.mechanic.name ?? 'mecânico'}` : ''}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={APPOINTMENT_STATUS_VARIANT[a.status] ?? 'secondary'}>
                      {APPOINTMENT_STATUS_LABEL[a.status] ?? a.status}
                    </Badge>
                    {a.customerConfirmed && <span className="ml-1 text-xs text-green-600">✓ cliente confirmou</span>}
                    {a.completedWithoutConfirmation && <span className="ml-1 text-xs text-amber-600">concluído sem confirmação (autorizado)</span>}
                  </TableCell>
                  <TableCell>
                    {(a.status === 'PROPOSED' || a.status === 'CONFIRMED') && (
                      <div className="flex gap-1 flex-wrap">
                        {a.status === 'PROPOSED' && (
                          <Button size="sm" onClick={() => confirm(a.id)}>
                            Cliente confirmou
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRescheduleTarget({ id: a.id });
                            setRescheduleError(null);
                            setRescheduleAt('');
                            setRescheduleResources({ durationMinutes: a.durationMinutes ? String(a.durationMinutes) : '', mechanicId: a.mechanicId ?? '' });
                          }}
                        >
                          Reagendar
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => complete(a)} data-testid="appointment-complete">
                          Concluir
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => noShow(a.id)}>
                          Não compareceu
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => cancel(a.id)}>
                          Cancelar
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </LoadingErrorEmpty>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Propor Agendamento</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <CustomerMotorcycleFields
              customerId={form.customerId}
              motorcycleId={form.motorcycleId}
              onCustomerChange={(id) => setForm((f) => ({ ...f, customerId: id }))}
              onMotorcycleChange={(id) => setForm((f) => ({ ...f, motorcycleId: id }))}
            />
            <div className="space-y-1">
              <Label>Data e hora propostas</Label>
              <Input type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} />
            </div>
            <AppointmentResourceFields
              idPrefix="propose"
              durationMinutes={form.durationMinutes}
              mechanicId={form.mechanicId}
              mechanics={mechanics}
              onChange={(next) => setForm((f) => ({ ...f, ...next }))}
            />
            <div className="space-y-1">
              <Label>Observações (opcional)</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <p className="text-xs text-gray-400">
              Isto só propõe o horário — o status fica &quot;Proposto&quot; até o cliente confirmar.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Salvando...' : 'Propor'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rescheduleTarget} onOpenChange={(open) => !open && setRescheduleTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reagendar</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-500">Reagendar reseta a confirmação — o cliente precisa confirmar o novo horário de novo.</p>
            {rescheduleError && (
              <p role="alert" className="text-sm text-red-600" data-testid="reschedule-error">
                {rescheduleError}
              </p>
            )}
            <div className="space-y-1">
              <Label>Nova data e hora</Label>
              <Input type="datetime-local" value={rescheduleAt} onChange={(e) => setRescheduleAt(e.target.value)} />
            </div>
            <AppointmentResourceFields
              idPrefix="reschedule"
              durationMinutes={rescheduleResources.durationMinutes}
              mechanicId={rescheduleResources.mechanicId}
              mechanics={mechanics}
              onChange={setRescheduleResources}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRescheduleTarget(null)}>
              Cancelar
            </Button>
            <Button onClick={submitReschedule} disabled={!rescheduleAt}>
              Reagendar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmTarget} onOpenChange={(open) => !open && setConfirmTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmação do cliente</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-500">
              Registre só quando o cliente ou o responsável pelo veículo aceitou este horário. Fica gravado quem
              confirmou e por qual canal.
            </p>
            <div className="space-y-1">
              <Label htmlFor="confirm-name">Quem confirmou</Label>
              <Input id="confirm-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder="Ex.: Carlos (dono da moto)" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="confirm-channel">Canal</Label>
              <Select id="confirm-channel" value={confirmChannel} onChange={(e) => setConfirmChannel(e.target.value as any)}>
                <option value="WHATSAPP">WhatsApp</option>
                <option value="PHONE">Telefone</option>
                <option value="IN_PERSON">Pessoalmente</option>
                <option value="SMS">SMS</option>
                <option value="EMAIL">E-mail</option>
              </Select>
            </div>
            {confirmError && (
              <p role="alert" className="text-sm text-red-600">
                {confirmError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTarget(null)}>
              Voltar
            </Button>
            <Button onClick={submitConfirm} disabled={confirmName.trim().length < 2}>
              Registrar confirmação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CompleteAppointmentDialog
        appointment={completeTarget}
        onClose={() => setCompleteTarget(null)}
        onCompleted={async () => {
          setCompleteTarget(null);
          await load();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// REVISÕES — histórico imutável: só create + leitura (ver revision.service.
// ts). nextDueDate/nextDueKilometer já vêm calculados do backend.
// ---------------------------------------------------------------------------
function RevisionsPanel() {
  const [revisions, setRevisions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    customerId: '',
    motorcycleId: '',
    performedAt: '',
    kilometerAtService: '',
    servicesPerformed: '',
    partsReplaced: '',
    recommendations: '',
    notes: '',
    intervalMonths: '3',
    intervalKilometers: '',
  });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getRevisions({ limit: 50 });
      setRevisions(result.revisions ?? []);
    } catch (err) {
      console.error('Erro ao carregar revisões:', err);
      setError('Não foi possível carregar as revisões. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openNew() {
    setForm({
      customerId: '',
      motorcycleId: '',
      performedAt: '',
      kilometerAtService: '',
      servicesPerformed: '',
      partsReplaced: '',
      recommendations: '',
      notes: '',
      intervalMonths: '3',
      intervalKilometers: '',
    });
    setFormError(null);
    setDialogOpen(true);
  }

  async function save() {
    setFormError(null);
    if (!form.customerId || !form.motorcycleId || !form.performedAt || !form.kilometerAtService || !form.servicesPerformed.trim()) {
      setFormError('Cliente, moto, data, quilometragem e serviços realizados são obrigatórios');
      return;
    }
    setSaving(true);
    try {
      await api.createRevision({
        customerId: form.customerId,
        motorcycleId: form.motorcycleId,
        // Mesmo achado de auditoria de financial/page.tsx (dueDate): <input
        // type="date"> devolve "YYYY-MM-DD" puro, que `new Date()`
        // interpreta como meia-noite UTC, não local — exibia um dia a
        // menos para usuários em UTC-3. "T23:59:59" (sem fuso, portanto
        // horário local) corrige.
        performedAt: new Date(`${form.performedAt}T23:59:59`).toISOString(),
        kilometerAtService: Number(form.kilometerAtService),
        servicesPerformed: form.servicesPerformed,
        partsReplaced: form.partsReplaced || undefined,
        recommendations: form.recommendations.trim() || undefined,
        notes: form.notes || undefined,
        intervalMonths: Number(form.intervalMonths) || 3,
        intervalKilometers: form.intervalKilometers ? Number(form.intervalKilometers) : undefined,
      });
      setDialogOpen(false);
      await load();
    } catch (err: any) {
      setFormError(getApiErrorMessage(err, 'Erro ao registrar revisão'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-2" />
          Nova Revisão
        </Button>
      </div>

      <Card>
        <LoadingErrorEmpty
          loading={loading}
          error={error}
          empty={revisions.length === 0}
          emptyIcon={Wrench}
          emptyTitle="Nenhuma revisão registrada"
          emptyDescription="Registre a revisão de um veículo para calcular automaticamente a próxima data."
          onRetry={load}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Moto</TableHead>
                <TableHead>Realizada em</TableHead>
                <TableHead>Km</TableHead>
                <TableHead>Serviços</TableHead>
                <TableHead>Próxima revisão</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {revisions.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.customer?.name}</TableCell>
                  <TableCell>{r.motorcycle ? `${r.motorcycle.brand} ${r.motorcycle.model}` : '-'}</TableCell>
                  <TableCell>{new Date(r.performedAt).toLocaleDateString('pt-BR')}</TableCell>
                  <TableCell>{r.kilometerAtService}</TableCell>
                  <TableCell className="max-w-[240px] truncate">{r.servicesPerformed}</TableCell>
                  <TableCell>{new Date(r.nextDueDate).toLocaleDateString('pt-BR')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </LoadingErrorEmpty>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova Revisão</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <CustomerMotorcycleFields
              customerId={form.customerId}
              motorcycleId={form.motorcycleId}
              onCustomerChange={(id) => setForm((f) => ({ ...f, customerId: id }))}
              onMotorcycleChange={(id) => setForm((f) => ({ ...f, motorcycleId: id }))}
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Data da revisão</Label>
                <Input type="date" value={form.performedAt} onChange={(e) => setForm({ ...form, performedAt: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>Quilometragem</Label>
                <Input
                  type="number"
                  value={form.kilometerAtService}
                  onChange={(e) => setForm({ ...form, kilometerAtService: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Serviços realizados</Label>
              <Input value={form.servicesPerformed} onChange={(e) => setForm({ ...form, servicesPerformed: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Itens/peças substituídos (opcional)</Label>
              <Input value={form.partsReplaced} onChange={(e) => setForm({ ...form, partsReplaced: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="revision-recommendations">Recomendação ao cliente (opcional)</Label>
              <Input
                id="revision-recommendations"
                value={form.recommendations}
                onChange={(e) => setForm({ ...form, recommendations: e.target.value })}
                placeholder="Ex.: trocar a relação na próxima revisão"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Validade (meses)</Label>
                <Input type="number" min={1} value={form.intervalMonths} onChange={(e) => setForm({ ...form, intervalMonths: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label>Validade (km, opcional)</Label>
                <Input
                  type="number"
                  value={form.intervalKilometers}
                  onChange={(e) => setForm({ ...form, intervalKilometers: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Observações (opcional)</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Salvando...' : 'Salvar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
