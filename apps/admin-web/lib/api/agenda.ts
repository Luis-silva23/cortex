import { api } from '@/lib/api';

// Agenda: concluir agendamento (API: /appointments/:id/complete). Sem a confirmação do cliente, a API exige a
// autorização de um responsável (código + senha, MFA se ele tiver) e o motivo — senão responde 409
// APPOINTMENT_NOT_CONFIRMED e a tela abre o pedido de autorização.

export const COMPLETION_REASON_MIN = 10;

export interface CompletionAuthorizationInput {
  authorizerNumericId: number;
  authorizerPassword: string;
  authorizerMfaCode?: string;
  reason: string;
}

// Capacidade configurável (docs/CORTEX/policies/AGENDA.md): duração e mecânico previstos, horários livres/ocupados com o
// motivo e indisponibilidades (gerência). A API é quem decide; a tela só mostra o que ela devolve.

export type AgendaRefusalCode =
  | 'OUTSIDE_BUSINESS_HOURS'
  | 'SLOT_FULL'
  | 'NO_BOX_AVAILABLE'
  | 'DAY_FULL'
  | 'MONTH_FULL'
  | 'MECHANIC_CONFLICT'
  | 'MECHANIC_UNAVAILABLE'
  | 'AGENDA_UNAVAILABLE';

export interface AgendaSlot {
  start: string;
  end: string;
  time: string;
  booked: number;
  available: boolean;
  code: AgendaRefusalCode | null;
  reason: string | null;
}

export interface AgendaAvailability {
  date: string;
  branchId: string | null;
  timezone: string;
  slotMinutes: number;
  durationMinutes: number;
  limits: { maxPerSlot: number | null; maxPerDay: number | null; maxPerMonth: number | null; boxCount: number | null };
  dayCount: number;
  monthCount: number;
  slots: AgendaSlot[];
}

export interface AgendaUnavailability {
  id: string;
  branchId: string;
  mechanicId: string | null;
  mechanicName: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
  createdBy: string;
  createdAt: string;
}

export interface AppointmentResources {
  /** minutos (5–1440); vazio = duração padrão da filial */
  durationMinutes?: number | null;
  mechanicId?: string | null;
}

/** Rótulo curto do motivo (a mensagem completa vem da API em `reason`). */
export const AGENDA_REFUSAL_LABEL: Record<AgendaRefusalCode, string> = {
  OUTSIDE_BUSINESS_HOURS: 'Fora do funcionamento',
  SLOT_FULL: 'Horário lotado',
  NO_BOX_AVAILABLE: 'Sem box livre',
  DAY_FULL: 'Dia lotado',
  MONTH_FULL: 'Mês lotado',
  MECHANIC_CONFLICT: 'Mecânico ocupado',
  MECHANIC_UNAVAILABLE: 'Mecânico indisponível',
  AGENDA_UNAVAILABLE: 'Agenda indisponível',
};

export const DURATION_MIN = 5;
export const DURATION_MAX = 1440;

/** Campo de duração do formulário ('' = padrão da filial). Devolve a mensagem de erro ou null. */
export function validateDuration(value: string): string | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < DURATION_MIN || n > DURATION_MAX) return `A duração precisa ser de ${DURATION_MIN} a ${DURATION_MAX} minutos.`;
  return null;
}

/** Corpo com duração/mecânico só quando informados (vazio = a API usa o padrão da filial / sem mecânico). */
export function resourcesPayload(form: { durationMinutes: string; mechanicId: string }): AppointmentResources {
  return {
    ...(form.durationMinutes.trim() ? { durationMinutes: Number(form.durationMinutes) } : {}),
    ...(form.mechanicId ? { mechanicId: form.mechanicId } : {}),
  };
}

export const agendaApi = {
  async complete(id: string, body: { notes?: string; authorization?: CompletionAuthorizationInput } = {}) {
    return (await api.http.post(`/appointments/${id}/complete`, body)).data;
  },

  async propose(body: { customerId: string; motorcycleId?: string; scheduledAt: string; notes?: string } & AppointmentResources) {
    return (await api.http.post('/appointments', body)).data;
  },

  async reschedule(id: string, body: { newScheduledAt: string; reason?: string } & AppointmentResources) {
    return (await api.http.post(`/appointments/${id}/reschedule`, body)).data;
  },

  async availability(params: { date: string; branchId?: string; mechanicId?: string; durationMinutes?: number }): Promise<AgendaAvailability> {
    return (await api.http.get('/appointments/availability', { params })).data;
  },

  async listUnavailabilities(params: { branchId?: string; from?: string; to?: string } = {}): Promise<AgendaUnavailability[]> {
    return ((await api.http.get('/appointments/unavailabilities', { params })).data?.unavailabilities ?? []) as AgendaUnavailability[];
  },

  async createUnavailability(body: { branchId?: string; mechanicId?: string | null; startsAt: string; endsAt: string; reason: string }) {
    return (await api.http.post('/appointments/unavailabilities', body)).data as AgendaUnavailability & { overlappingAppointments: number };
  },

  async removeUnavailability(id: string) {
    return (await api.http.delete(`/appointments/unavailabilities/${id}`)).data;
  },
};

/** Códigos de recusa da agenda que a tela trata de forma específica. */
export function agendaErrorCode(err: unknown): string | null {
  const code = (err as any)?.response?.data?.code;
  return typeof code === 'string' ? code : null;
}

/** Valida o formulário de autorização antes de enviar (a API valida de novo). */
export function validateCompletionAuthorization(form: { numericId: string; password: string; reason: string }): string | null {
  if (!/^\d+$/.test(form.numericId.trim()) || Number(form.numericId) <= 0) return 'Informe o código (ID numérico) do responsável.';
  if (form.password === '') return 'Informe a senha do responsável.';
  if (form.reason.trim().length < COMPLETION_REASON_MIN) return `Informe o motivo (mínimo ${COMPLETION_REASON_MIN} caracteres).`;
  return null;
}
