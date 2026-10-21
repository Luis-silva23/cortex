import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import appointmentService, { COMPLETION_REASON_MIN } from '../services/appointment.service';
import { idempotency } from '../middleware/idempotency';
import { rateLimitAuthorizer } from '../middlewares/advancedRateLimit';
import {
  createAppointmentSchema,
  confirmAppointmentSchema,
  appointmentActionSchema,
  rescheduleAppointmentSchema,
  cancelAppointmentSchema,
  appointmentFilterSchema,
} from '@ln-system/shared/src/validators/revision.validators';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { requireWriteBranchId, resolveWriteBranchId } from '../utils/branch-context';
import { routeErrorMessage } from '../utils/route-error';
import { agendaAvailability, agendaUnavailabilityService } from '../services/agenda-capacity.service';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('POS_VENDA'));

// Erro de validação com a mensagem do campo (não o JSON do Zod), o status do service (403/404/409) e o `code` — a tela
// decide pelo code (APPOINTMENT_NOT_CONFIRMED abre o pedido de autorização; SLOT_FULL/OUTSIDE_BUSINESS_HOURS explicam).
const fail = (res: Response, error: any) =>
  res.status(error?.statusCode ?? 400).json({
    error: routeErrorMessage(error),
    ...(typeof error?.code === 'string' && !/^P\d{4}$/.test(error.code) ? { code: error.code } : {}),
  });

// Concluir: `authorization` só é exigida quando o cliente não confirmou (ver appointment.service.ts::complete).
const completeAppointmentSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
  authorization: z
    .object({
      authorizerNumericId: z.coerce.number({ invalid_type_error: 'Código do responsável inválido' }).int('Código do responsável inválido').positive('Código do responsável inválido'),
      authorizerPassword: z.string().min(1, 'Informe a senha do responsável'),
      authorizerMfaCode: z.string().trim().max(20).optional(),
      reason: z.string().trim().min(COMPLETION_REASON_MIN, `Informe o motivo (mínimo ${COMPLETION_REASON_MIN} caracteres)`).max(500),
    })
    .optional(),
});

// Senha de outra pessoa: mesmo limitador anti-força-bruta da autorização de venda/caixa, só quando há credencial.
const limitAuthorizerAttempts = (req: Request, res: Response, next: NextFunction) =>
  req.body?.authorization ? rateLimitAuthorizer(req, res, next) : next();

// Capacidade da agenda (docs/CORTEX/policies/AGENDA.md): duração e mecânico previstos ao propor/remarcar. Ausentes =
// duração da política da filial / sem mecânico (e, ao remarcar, mantém o que o agendamento já tinha).
const durationField = z
  .number({ invalid_type_error: 'A duração precisa ser um número de minutos' })
  .int('A duração precisa ser um número inteiro de minutos')
  .min(5, 'A duração mínima é de 5 minutos')
  .max(1440, 'A duração máxima é de 1440 minutos (24 h)');
const resourceSchema = z.object({
  durationMinutes: durationField.nullable().optional(),
  mechanicId: z.string().trim().min(1, 'Mecânico inválido').max(64).nullable().optional(),
});

const availabilityQuerySchema = z.object({
  date: z.string({ required_error: 'Informe a data (AAAA-MM-DD)' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD'),
  branchId: z.string().trim().min(1).optional(),
  mechanicId: z.string().trim().min(1).max(64).optional(),
  durationMinutes: z.coerce.number().pipe(durationField).optional(),
});

const unavailabilitySchema = z
  .object({
    branchId: z.string().trim().min(1).optional(),
    mechanicId: z.string().trim().min(1).max(64).nullable().optional(),
    startsAt: z.string({ required_error: 'Informe o início' }).datetime({ offset: true, message: 'Início inválido' }),
    endsAt: z.string({ required_error: 'Informe o fim' }).datetime({ offset: true, message: 'Fim inválido' }),
    reason: z
      .string({ required_error: 'Informe o motivo da indisponibilidade' })
      .trim()
      .min(3, 'Informe o motivo da indisponibilidade')
      .max(300, 'Motivo muito longo (máximo 300 caracteres)'),
  })
  .refine((d) => new Date(d.endsAt).getTime() > new Date(d.startsAt).getTime(), { message: 'O fim precisa ser depois do início', path: ['endsAt'] });

const unavailabilityQuerySchema = z.object({
  branchId: z.string().trim().min(1).optional(),
  mechanicId: z.string().trim().min(1).max(64).optional(),
  from: z.string().datetime({ offset: true, message: 'Data inicial inválida' }).optional(),
  to: z.string().datetime({ offset: true, message: 'Data final inválida' }).optional(),
});

// Leitura aberta a quem já passa pelo tenant (como GET /): usuário de filial vê só a própria filial.
router.get('/availability', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const q = availabilityQuerySchema.parse(req.query);
    const branchId = (await resolveWriteBranchId(user, q.branchId)) ?? null;
    res.json(await agendaAvailability({ companyId: user.companyId, branchId, date: q.date, mechanicId: q.mechanicId, durationMinutes: q.durationMinutes }));
  } catch (error: any) {
    fail(res, error);
  }
});

router.get('/unavailabilities', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const q = unavailabilityQuerySchema.parse(req.query);
    const branchId = (await resolveWriteBranchId(user, q.branchId)) ?? null;
    const rows = await agendaUnavailabilityService.list({
      companyId: user.companyId,
      branchId,
      mechanicId: q.mechanicId,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
    res.json({ unavailabilities: rows });
  } catch (error: any) {
    fail(res, error);
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const filters = appointmentFilterSchema.parse({
      ...req.query,
      companyId: (req as any).user.companyId,
    });
    const result = await appointmentService.list({
      companyId: filters.companyId!,
      branchId: filters.branchId,
      status: filters.status,
      customerId: filters.customerId,
      from: filters.from ? new Date(filters.from) : undefined,
      to: filters.to ? new Date(filters.to) : undefined,
      page: filters.page,
      limit: filters.limit,
    });
    res.json(result);
  } catch (error: any) {
    fail(res, error);
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const appointment = await appointmentService.getById(req.params.id, (req as any).user.companyId);
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }
    return res.json(appointment);
  } catch (error: any) {
    return fail(res, error);
  }
});

// ACHADO DE AUDITORIA: nenhum write deste arquivo tinha trava de papel —
// inclusive VIEWER (papel só-leitura por definição no resto do sistema)
// conseguia criar/confirmar/reagendar/cancelar/concluir/marcar-no-show
// qualquer agendamento. Exclui só o VIEWER — confirmar/reagendar/cancelar
// são fluxos reais do app mobile usado por mecânicos em campo (client.ts),
// então restringir a Gerência+ quebraria essas telas.
router.use(requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC'));

router.post('/', auditLog(AuditAction.CREATE, 'Appointment'), async (req: Request, res: Response) => {
  try {
    // Filial resolvida a partir do token (ver utils/branch-context.ts): usuário de filial
    // grava na filial dele; sem isso o registro nascia NULL e a TV/mobile nunca o via.
    const branchId = await resolveWriteBranchId((req as any).user, req.body?.branchId);
    const data = createAppointmentSchema.parse({
      ...req.body,
      branchId,
      companyId: (req as any).user.companyId,
      proposedBy: (req as any).user.userId,
    });
    const resources = resourceSchema.parse(req.body ?? {});
    const appointment = await appointmentService.propose({ ...data, ...resources, scheduledAt: new Date(data.scheduledAt) });
    res.status(201).json(appointment);
  } catch (error: any) {
    fail(res, error);
  }
});

// Indisponibilidade da agenda (filial inteira ou um mecânico): só a gerência cria/remove; motivo obrigatório; auditado.
// Agendamentos já marcados na janela não são cancelados — a resposta diz quantos há (`overlappingAppointments`).
const managerOnly = requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER');

router.post(
  '/unavailabilities',
  managerOnly,
  auditLog(AuditAction.CREATE, 'AgendaUnavailability', {
    describe: (_req, body) => ({
      entityId: body?.id ?? null,
      newValue: {
        action: 'CREATE_AGENDA_UNAVAILABILITY',
        branchId: body?.branchId,
        mechanicId: body?.mechanicId ?? null,
        startsAt: body?.startsAt,
        endsAt: body?.endsAt,
        reason: body?.reason,
      },
    }),
  }),
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const data = unavailabilitySchema.parse(req.body ?? {});
      // Toda indisponibilidade é de uma filial (validada contra a empresa do token; usuário de filial = a dele).
      const branchId = await requireWriteBranchId(user, data.branchId);
      const created = await agendaUnavailabilityService.create({
        companyId: user.companyId,
        branchId,
        mechanicId: data.mechanicId ?? null,
        startsAt: new Date(data.startsAt),
        endsAt: new Date(data.endsAt),
        reason: data.reason,
        createdBy: user.userId,
      });
      res.status(201).json(created);
    } catch (error: any) {
      fail(res, error);
    }
  }
);

router.delete(
  '/unavailabilities/:id',
  managerOnly,
  auditLog(AuditAction.DELETE, 'AgendaUnavailability', {
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: {
        action: 'REMOVE_AGENDA_UNAVAILABILITY',
        branchId: body?.branchId,
        mechanicId: body?.mechanicId ?? null,
        startsAt: body?.startsAt,
        endsAt: body?.endsAt,
        reason: body?.reason,
      },
    }),
  }),
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const removed = await agendaUnavailabilityService.remove(user.companyId, req.params.id, user.branchId ?? null);
      res.json(removed);
    } catch (error: any) {
      fail(res, error);
    }
  }
);

// REGRA FUNDAMENTAL: esta é a única rota que grava confirmação de fato — quem chama é sempre um funcionário
// registrando que o CLIENTE/responsável pelo veículo confirmou (o cliente não tem login neste sistema). Quem
// confirmou e por qual canal são obrigatórios (confirmAppointmentSchema).
router.post('/:id/confirm', auditLog(AuditAction.UPDATE, 'Appointment'), async (req: Request, res: Response) => {
  try {
    const data = confirmAppointmentSchema.parse({ ...req.body, performedBy: (req as any).user.userId });
    const appointment = await appointmentService.confirm(req.params.id, (req as any).user.companyId, data);
    res.json(appointment);
  } catch (error: any) {
    fail(res, error);
  }
});

router.post('/:id/reschedule', auditLog(AuditAction.UPDATE, 'Appointment'), async (req: Request, res: Response) => {
  try {
    const data = rescheduleAppointmentSchema.parse({ ...req.body, performedBy: (req as any).user.userId });
    const resources = resourceSchema.parse(req.body ?? {});
    const appointment = await appointmentService.reschedule(req.params.id, (req as any).user.companyId, {
      ...data,
      ...resources,
      newScheduledAt: new Date(data.newScheduledAt),
    });
    res.json(appointment);
  } catch (error: any) {
    fail(res, error);
  }
});

router.post('/:id/cancel', auditLog(AuditAction.UPDATE, 'Appointment'), async (req: Request, res: Response) => {
  try {
    const data = cancelAppointmentSchema.parse({ ...req.body, performedBy: (req as any).user.userId });
    const appointment = await appointmentService.cancel(req.params.id, (req as any).user.companyId, data);
    res.json(appointment);
  } catch (error: any) {
    fail(res, error);
  }
});

router.post(
  '/:id/complete',
  limitAuthorizerAttempts,
  idempotency(),
  auditLog(AuditAction.UPDATE, 'Appointment', {
    // A senha do autorizador nunca vai para o audit (e o redactSensitive já cobre); grava quem autorizou e o motivo.
    describe: (req, body) => ({
      entityId: req.params.id,
      newValue: {
        action: 'COMPLETE_APPOINTMENT',
        status: body?.status,
        completedWithoutConfirmation: body?.completedWithoutConfirmation,
        completionAuthorizedBy: body?.completionAuthorizedBy ?? null,
        completionReason: body?.completionReason ?? null,
      },
    }),
  }),
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const data = completeAppointmentSchema.parse(req.body ?? {});
      const appointment = await appointmentService.complete(req.params.id, user.companyId, {
        performedBy: user.userId,
        notes: data.notes,
        authorization: data.authorization,
        securityContext: { requestId: (req as any).requestId, branchId: user.branchId ?? undefined, device: req.headers['x-device-type'] as string | undefined },
      });
      res.json(appointment);
    } catch (error: any) {
      fail(res, error);
    }
  }
);

router.post('/:id/no-show', auditLog(AuditAction.UPDATE, 'Appointment'), async (req: Request, res: Response) => {
  try {
    const data = appointmentActionSchema.parse({ ...req.body, performedBy: (req as any).user.userId });
    const appointment = await appointmentService.markNoShow(req.params.id, (req as any).user.companyId, data);
    res.json(appointment);
  } catch (error: any) {
    fail(res, error);
  }
});

export default router;
