import { Router, Request, Response } from 'express';
import { z } from 'zod';
import paymentService from '../services/payment.service';
import { resolveListCompanyId } from '../utils/tenant-scope';
import { paymentSchema, paymentFilterSchema } from '@ln-system/shared/src/validators/pdv.validators';
import { authMiddleware, requireUserType, denyUserTypes } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { requirePermission } from '../middleware/permission';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { idempotency } from '../middleware/idempotency';
import { requireDeviceForCashOps } from '../middleware/device';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('VENDAS'));
// MECHANIC (oficina) não lê pagamentos (NSU, autorização, final do cartão).
router.use(denyUserTypes('MECHANIC'));

// Listar pagamentos
router.get('/', async (req: Request, res: Response) => {
  try {
    const filters = paymentFilterSchema.parse({
      ...req.query,
      page: req.query.page ? parseInt(req.query.page as string) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
    });

    const result = await paymentService.listPayments({
      ...filters,
      companyId: resolveListCompanyId((req as any).user, filters.companyId),
    });

    res.json(result);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Exceções de pagamento (provedor aprovou com a venda já cancelada/devolvida etc.): lista para quem administra a loja.
router.get('/exceptions', requireUserType('SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  try {
    const companyId = resolveListCompanyId((req as any).user, req.query.companyId as string | undefined);
    if (!companyId) return res.status(400).json({ error: 'Informe a empresa (companyId)' });
    const exceptions = await paymentService.listPaymentExceptions(companyId, { open: req.query.open === 'true' });
    return res.json({ data: exceptions });
  } catch (error: any) {
    return res.status(error.statusCode ?? 400).json({ error: error.message });
  }
});

// Tratar uma exceção: estorno no provedor (REFUND) ou registro de tratamento manual (MANUAL, com justificativa).
// A política comercial (qual escolher) é [DECISÃO NECESSÁRIA]; aqui só se executa a ação escolhida por quem pode estornar.
router.post('/exceptions/:id/resolve', requirePermission('finance:reverse'), auditLog(AuditAction.UPDATE, 'PaymentException'), async (req: Request, res: Response) => {
  try {
    const { action, note } = req.body ?? {};
    if (action !== 'REFUND' && action !== 'MANUAL') return res.status(400).json({ error: 'Ação inválida: use REFUND ou MANUAL' });
    const companyId = resolveListCompanyId((req as any).user, req.query.companyId as string | undefined);
    if (!companyId) return res.status(400).json({ error: 'Informe a empresa (companyId)' });
    const result = await paymentService.resolvePaymentException(req.params.id, companyId, (req as any).user.userId, action, note);
    return res.json(result);
  } catch (error: any) {
    return res.status(error.statusCode ?? 400).json({ error: error.message });
  }
});

// Consultar pagamento por transactionId
router.get('/transaction/:transactionId', async (req: Request, res: Response) => {
  try {
    const { transactionId } = req.params;

    const payment = await paymentService.getPaymentByTransactionId(
      transactionId,
      (req as any).user.companyId
    );

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    return res.json(payment);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

// ACHADO DE AUDITORIA: processar e reconciliar pagamento não tinham trava de
// papel (só cancel/refund tinham, por permissão) — VIEWER conseguia registrar
// um pagamento e disparar reconciliação com o gateway. Processar é chamado só
// pelo PDV (pdv-desktop/src/services/api.ts, OPERATOR/MANAGER), então exclui
// VIEWER/MECHANIC; reconciliar não tem chamador em nenhum frontend nem job
// (só a rota) e decide o status financeiro de um pagamento pendente, então
// fica com Gerência+ (mesmo padrão dos demais writes de backoffice).
const PAYMENT_PROCESSING_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR'] as const;
const PAYMENT_RECONCILE_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'] as const;

// Convênio: `employeeAgreementId` (EMPLOYEE_AGREEMENT) ou `agreementCompanyId` (COMPANY_AGREEMENT).
const agreementFieldsSchema = z.object({
  employeeAgreementId: z.string().uuid('employeeAgreementId inválido').optional(),
  agreementCompanyId: z.string().uuid('agreementCompanyId inválido').optional(),
});

// Processar pagamento
router.post('/', requireUserType(...PAYMENT_PROCESSING_ROLES), requireDeviceForCashOps, idempotency(), auditLog(AuditAction.CREATE, 'Payment'), async (req: Request, res: Response) => {
  try {
    const data = paymentSchema.parse({
      ...req.body,
      companyId: (req as any).user.companyId,
    });

    const payment = await paymentService.processPayment({
      ...data,
      transactionId: data.transactionId ?? undefined,
      notes: data.notes ?? undefined,
      authorizationCode: data.authorizationCode ?? undefined,
      cardBrand: data.cardBrand ?? undefined,
      cardLastDigits: data.cardLastDigits ?? undefined,
      nsuHost: data.nsuHost ?? undefined,
      nsuTef: data.nsuTef ?? undefined,
      // Convênio (contrato do PDV em docs/CORTEX/policies/CONVENIOS.md): ids lidos à parte, empresa sempre a do token.
      ...agreementFieldsSchema.parse(req.body ?? {}),
      userId: (req as any).user.userId,
    });

    res.status(201).json(payment);
  } catch (error: any) {
    // Venda cancelada/devolvida não recebe pagamento nem é reaberta (nova compra = nova venda): 409, venda intacta.
    if (error?.message === 'Cannot process payment for cancelled or returned sale') {
      res.status(409).json({ error: error.message, code: 'SALE_CLOSED_FOR_PAYMENT' });
    } else {
      res.status(typeof error?.statusCode === 'number' ? error.statusCode : 400).json({
        error: error.message,
        ...(typeof error?.statusCode === 'number' && error.code ? { code: error.code } : {}),
        // AGREEMENT_LIMIT_EXCEEDED: disponível/limite para o PDV mostrar
        ...(error?.details ? { details: error.details } : {}),
      });
    }
  }
});

// Reconciliar pagamento pendente (consulta o status atual junto ao
// adaptador/gateway em vez de recobrar cegamente — ver PaymentService.reconcilePayment)
router.post('/:id/reconcile', requireUserType(...PAYMENT_RECONCILE_ROLES), auditLog(AuditAction.UPDATE, 'Payment'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const companyId = (req as any).user.companyId;

    const payment = await paymentService.reconcilePayment(id, companyId);

    res.json(payment);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Cancelar pagamento
// ACHADO DE AUDITORIA DE INTEGRAÇÃO: sem trava nenhuma (qualquer usuário
// autenticado do tenant podia cancelar um pagamento já aprovado via chamada
// direta à API) — mesma classe financeira de payables/receivables reverse
// em financial.routes.ts, agora com o mesmo gate.
router.post('/:id/cancel', requirePermission('finance:reverse'), auditLog(AuditAction.UPDATE, 'Payment'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const companyId = (req as any).user.companyId;

    const payment = await paymentService.cancelPayment(id, companyId, (req as any).user.userId);

    res.json(payment);
  } catch (error: any) {
    // 409 quando o provedor recusa/não confirma, o pagamento mudou de situação ou está em exceção (ConflictError do service)
    res.status(error.statusCode ?? 400).json({ error: error.message, ...(error.code && { code: error.code }) });
  }
});

// Estornar pagamento
router.post('/:id/refund', idempotency(), requirePermission('finance:reverse'), auditLog(AuditAction.UPDATE, 'Payment'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const companyId = (req as any).user.companyId;

    const payment = await paymentService.refundPayment(id, companyId, (req as any).user.userId);

    res.json(payment);
  } catch (error: any) {
    // 409 quando o pagamento está em exceção (tratar pela tela de exceções) — ConflictError do service
    res.status(error.statusCode ?? 400).json({ error: error.message, ...(error.code && { code: error.code }) });
  }
});

export default router;
