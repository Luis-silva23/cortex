import { z } from 'zod';

// Todos os schemas aqui seguem o padrão "merge antes do parse" (a rota faz
// schema.parse({...req.body, companyId: req.user.companyId, ...}) — NUNCA
// schema.parse(req.body) cru) — companyId/branchId/*By ficam required
// porque SEMPRE estarão presentes nesse ponto. Ver commit 556e175 desta
// mesma sessão: o erro contrário (exigir um campo que a rota só injeta
// DEPOIS do parse) quebrou 6 endpoints inteiros da vez passada.

export const createRevisionSchema = z.object({
  companyId: z.string(),
  branchId: z.string().optional(),
  customerId: z.string(),
  motorcycleId: z.string(),
  serviceOrderId: z.string().optional(),
  // ISO, convertido na rota; revisão é registro do que JÁ foi feito — data futura é recusada.
  performedAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'Data da revisão inválida')
    // tolerância de 24 h: a tela manda o fim do dia (T23:59:59 local) e o fuso do cliente varia; amanhã em diante é recusado
    .refine((v) => Date.parse(v) <= Date.now() + 24 * 3_600_000, 'A data da revisão não pode estar no futuro'),
  kilometerAtService: z.number().nonnegative(),
  servicesPerformed: z.string().min(1),
  partsReplaced: z.string().optional(),
  recommendations: z.string().max(2000).optional(),
  notes: z.string().optional(),
  intervalMonths: z.number().int().positive().default(3),
  intervalKilometers: z.number().int().positive().optional(),
  recordedBy: z.string(),
});

export const revisionFilterSchema = z.object({
  companyId: z.string().optional(),
  branchId: z.string().optional(),
  customerId: z.string().optional(),
  motorcycleId: z.string().optional(),
  dueBefore: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const createFollowUpSchema = z.object({
  companyId: z.string(),
  branchId: z.string().optional(),
  revisionId: z.string().optional(),
  customerId: z.string(),
  motorcycleId: z.string(),
  dueDate: z.string(),
  notes: z.string().optional(),
  createdBy: z.string(),
});

export const followUpFilterSchema = z.object({
  companyId: z.string().optional(),
  branchId: z.string().optional(),
  status: z.enum(['PENDING', 'SCHEDULED', 'CANCELLED']).optional(),
  customerId: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().default(20),
});

export const logFollowUpContactSchema = z.object({
  channel: z.enum(['PHONE', 'WHATSAPP', 'EMAIL', 'SMS', 'IN_PERSON']),
  message: z.string().optional(),
  performedBy: z.string(),
});

export const declineOrCancelFollowUpSchema = z.object({
  reason: z.string().optional(),
  performedBy: z.string(),
});

export const createAppointmentSchema = z.object({
  companyId: z.string(),
  branchId: z.string().optional(),
  followUpId: z.string().optional(),
  customerId: z.string(),
  motorcycleId: z.string().optional(),
  scheduledAt: z.string().datetime({ offset: true, message: 'Data e hora inválidas' }),
  notes: z.string().optional(),
  proposedBy: z.string(),
});

/**
 * Confirmação = o CLIENTE (ou o responsável pelo veículo) aceitou o horário. O funcionário que registra
 * (`performedBy`) não é quem confirma: por isso quem confirmou e por qual canal são obrigatórios.
 */
export const confirmAppointmentSchema = z.object({
  performedBy: z.string(),
  channel: z.enum(['PHONE', 'WHATSAPP', 'EMAIL', 'SMS', 'IN_PERSON'], {
    errorMap: () => ({ message: 'Informe o canal em que o cliente confirmou' }),
  }),
  confirmedByName: z
    .string({ required_error: 'Informe quem confirmou (cliente ou responsável pelo veículo)' })
    .trim()
    .min(2, 'Informe quem confirmou (cliente ou responsável pelo veículo)')
    .max(120),
  notes: z.string().optional(),
});

/** Concluir / não compareceu: registro da equipe, sem confirmação do cliente. */
export const appointmentActionSchema = z.object({
  performedBy: z.string(),
  notes: z.string().optional(),
});

export const rescheduleAppointmentSchema = z.object({
  newScheduledAt: z.string().datetime({ offset: true, message: 'Data e hora inválidas' }),
  reason: z.string().optional(),
  performedBy: z.string(),
});

export const cancelAppointmentSchema = z.object({
  reason: z.string().optional(),
  performedBy: z.string(),
});

export const appointmentFilterSchema = z.object({
  companyId: z.string().optional(),
  branchId: z.string().optional(),
  status: z.enum(['PROPOSED', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW']).optional(),
  customerId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().default(20),
});
