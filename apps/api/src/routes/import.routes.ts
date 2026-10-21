import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware as authenticate } from '../middleware/auth';
import { tenantIsolation as requireTenant } from '../middleware/tenant';
import { requirePermission } from '../middleware/permission';
import { requireModuleEnabled } from '../middleware/module';
import { AppError } from '@ln-system/shared';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';
import { idempotency } from '../middleware/idempotency';
import { resolveWriteBranchId } from '../utils/branch-context';
import importService, { RowResult } from '../services/import.service';

const router = Router();

router.use(authenticate);
router.use(requireTenant);
// Importação em lote contorna a revisão registro-a-registro da UI normal: ferramenta administrativa, com permissão.
router.use(requirePermission('data:import'));

// A regra de cada linha fica em services/import.service.ts (lote rastreável, transação por linha, simulação,
// duplicidade na planilha, CPF/CNPJ por dígitos). Aqui: escopo (empresa do token, filial validada), simulação e
// resposta compatível com a tela.

/** Auditoria com o RESUMO do lote (antes gravava o corpo inteiro da resposta, com todos os registros importados). */
const auditSummary = (entity: string) =>
  auditLog(AuditAction.CREATE, entity, {
    describe: (_req, body) => ({
      entityId: body?.batchId ?? null,
      newValue: { batchId: body?.batchId ?? null, imported: body?.imported, errors: body?.errors, unchanged: body?.unchanged },
    }),
  });

const isDryRun = (req: Request) => req.query.dryRun === 'true' || req.body?.dryRun === true;

async function context(req: Request) {
  const { companyId, userId } = req.user!;
  if (!companyId) throw new AppError('Usuário não associado a uma empresa', 400);
  // Filial do token; administrador da empresa pode indicar uma filial DA EMPRESA (validada).
  const branchId = await resolveWriteBranchId(req.user!, req.body?.branchId);
  return { companyId, userId, branchId, dryRun: isDryRun(req), fileName: typeof req.body?.fileName === 'string' ? req.body.fileName : undefined };
}

/** Resposta: resumo + resultado por linha (novo) + os campos que a tela e as integrações já usam. */
function respond(res: Response, outcome: Awaited<ReturnType<typeof importService.importProducts>>, keyName: string) {
  const ok = outcome.results.filter((r) => r.action !== 'ERROR');
  const failed = outcome.results.filter((r) => r.action === 'ERROR');
  const warnings = outcome.results.flatMap((r) => (r.warnings ?? []).map((warning) => ({ index: r.row, row: r.row, [keyName]: r.key, warning })));
  return res.json({
    success: true,
    batchId: outcome.batchId,
    dryRun: outcome.dryRun,
    imported: ok.length,
    unchanged: outcome.unchangedRows,
    errors: failed.length,
    results: outcome.results,
    details: {
      imported: ok.map(legacyImported),
      errors: failed.map((r) => ({ index: r.row, row: r.row, [keyName]: r.key, error: r.error })),
      warnings,
    },
  });
}

function legacyImported(r: RowResult) {
  return r.detail ? { ...r.detail, ...(r.action === 'UNCHANGED' ? { note: 'Sem alteração — saldo já correspondia ao importado' } : {}) } : { id: r.id, key: r.key, action: r.action };
}

/**
 * @route   POST /api/import/products   (?dryRun=true simula sem gravar)
 */
router.post('/products', idempotency(), auditSummary('ProductImport'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    respond(res, await importService.importProducts(req.body?.products, await context(req)), 'sku');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/import/customers   (?dryRun=true simula sem gravar)
 */
router.post('/customers', idempotency(), auditSummary('CustomerImport'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    respond(res, await importService.importCustomers(req.body?.customers, await context(req)), 'name');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/import/stock   (?dryRun=true simula sem gravar)
 * Grava StockMovement: com ESTOQUE desativado para a empresa/filial não pode continuar operável direto pela API.
 */
router.post('/stock', requireModuleEnabled('ESTOQUE'), idempotency(), auditSummary('StockImport'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    respond(res, await importService.importStock(req.body?.stockItems, await context(req)), 'identifier');
  } catch (error) {
    next(error);
  }
});

/** Histórico de importações da empresa (lote, quem, quando, contagens). */
router.get('/batches', async (req: Request, res: Response, next: NextFunction) => {
  try {
    return res.json({ batches: await importService.listBatches(req.user!.companyId!, Number(req.query.limit) || 20) });
  } catch (error) {
    return next(error);
  }
});

/** Um lote com o resultado de cada linha. */
router.get('/batches/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const batch = await importService.getBatch(req.params.id, req.user!.companyId!);
    if (!batch) return res.status(404).json({ error: 'Importação não encontrada' });
    return res.json(batch);
  } catch (error) {
    return next(error);
  }
});

export default router;
