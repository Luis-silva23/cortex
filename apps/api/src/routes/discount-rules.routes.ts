import { Router, Request, Response } from 'express';
import { prisma } from '@ln-system/database';
import { authMiddleware, requireUserType } from '../middleware/auth';
import { tenantIsolation } from '../middleware/tenant';
import { requireModuleEnabled } from '../middleware/module';
import { auditLog } from '../middleware/audit';
import { AuditAction } from '@ln-system/database';

const router = Router();

router.use(authMiddleware);
router.use(tenantIsolation);
router.use(requireModuleEnabled('VENDAS'));

const VALID_DISCOUNT_TYPES = ['PERCENTAGE', 'FIXED'];
const VALID_USER_TYPES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC', 'VIEWER'];

// ACHADO DE AUDITORIA (PRE-PRODUCTION HARDENING, Backend/API): ao contrário
// de commission-rules.routes.ts (mesmo padrão de rota, mesma sessão),
// `maxDiscount` aqui só era validado quanto à PRESENÇA (`undefined`/`null`),
// nunca quanto ao valor — um `maxDiscount` negativo, NaN (string não
// numérica no body) ou, para `discountType: 'PERCENTAGE'`, maior que 100,
// passava direto para `prisma.discountRule.create()`. `maxDiscount` é
// `Decimal(5,2)` no schema (máximo 999.99) — um valor negativo faz TODO
// desconto de operador exigir aprovação (nunca mais dá pra aplicar
// desconto sem gerência, mesmo desconto zero), e um valor >100% num tipo
// PERCENTAGE equivale a "sem limite nenhum" (checkSaleDiscount.ts nunca
// bloqueia), o oposto do que a tela de configuração normalmente pretende
// comunicar. `Number(NaN)` é hoje silenciosamente rejeitado pelo Prisma
// como "Argument maxDiscount is missing" (mensagem confusa para quem
// mandou um valor, só que não numérico) — validado aqui explicitamente
// para dar um erro claro em vez de deixar o Prisma reportar errado.
function validateMaxDiscount(maxDiscount: unknown, discountType: string | undefined): string | null {
  const value = Number(maxDiscount);
  if (!Number.isFinite(value)) {
    return 'maxDiscount precisa ser um número válido';
  }
  if (value < 0) {
    return 'maxDiscount não pode ser negativo';
  }
  if (discountType === 'PERCENTAGE' && value > 100) {
    return 'maxDiscount não pode ser maior que 100 para discountType PERCENTAGE';
  }
  return null;
}

// Só Gerente/Admin/Super Admin configuram limites de desconto — a mesma
// gente que os aplicaria manualmente numa venda acima do limite alheio.
router.use(requireUserType('MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'));

router.get('/', async (req: Request, res: Response) => {
  try {
    const rules = await prisma.discountRule.findMany({
      where: { companyId: (req as any).user.companyId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ rules });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/', auditLog(AuditAction.CREATE, 'DiscountRule'), async (req: Request, res: Response) => {
  try {
    const { name, description, userType, discountType, maxDiscount, requiresApproval } = req.body;
    if (!name || !discountType || maxDiscount === undefined || maxDiscount === null) {
      return res.status(400).json({ error: 'name, discountType e maxDiscount são obrigatórios' });
    }
    if (!VALID_DISCOUNT_TYPES.includes(discountType)) {
      return res.status(400).json({ error: `discountType inválido — use um de: ${VALID_DISCOUNT_TYPES.join(', ')}` });
    }
    if (userType !== undefined && userType !== null && !VALID_USER_TYPES.includes(userType)) {
      return res.status(400).json({ error: `userType inválido — use um de: ${VALID_USER_TYPES.join(', ')} ou omita para aplicar a todos` });
    }
    const maxDiscountError = validateMaxDiscount(maxDiscount, discountType);
    if (maxDiscountError) {
      return res.status(400).json({ error: maxDiscountError });
    }
    const rule = await prisma.discountRule.create({
      data: {
        companyId: (req as any).user.companyId,
        name,
        description,
        userType: userType || null,
        discountType,
        maxDiscount: Number(maxDiscount),
        requiresApproval: Boolean(requiresApproval),
      },
    });
    return res.status(201).json(rule);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

router.put('/:id', auditLog(AuditAction.UPDATE, 'DiscountRule'), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.discountRule.findFirst({
      where: { id: req.params.id, companyId: (req as any).user.companyId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Regra de desconto não encontrada' });
    }
    const { name, description, userType, discountType, maxDiscount, requiresApproval, isActive } = req.body;
    if (discountType !== undefined && !VALID_DISCOUNT_TYPES.includes(discountType)) {
      return res.status(400).json({ error: `discountType inválido — use um de: ${VALID_DISCOUNT_TYPES.join(', ')}` });
    }
    if (maxDiscount !== undefined) {
      // discountType efetivo para a checagem de <=100%: o novo valor, se
      // vier no mesmo PUT, senão o que já está salvo na regra.
      const effectiveDiscountType = discountType !== undefined ? discountType : existing.discountType;
      const maxDiscountError = validateMaxDiscount(maxDiscount, effectiveDiscountType);
      if (maxDiscountError) {
        return res.status(400).json({ error: maxDiscountError });
      }
    }
    const rule = await prisma.discountRule.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(userType !== undefined && { userType }),
        ...(discountType !== undefined && { discountType }),
        ...(maxDiscount !== undefined && { maxDiscount: Number(maxDiscount) }),
        ...(requiresApproval !== undefined && { requiresApproval: Boolean(requiresApproval) }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
      },
    });
    return res.json(rule);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

router.delete('/:id', auditLog(AuditAction.DELETE, 'DiscountRule'), async (req: Request, res: Response) => {
  try {
    const existing = await prisma.discountRule.findFirst({
      where: { id: req.params.id, companyId: (req as any).user.companyId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Regra de desconto não encontrada' });
    }
    // Desativa em vez de apagar — histórico de vendas antigas referenciando
    // esta regra (via nome/limite no momento) continua íntegro.
    await prisma.discountRule.update({ where: { id: existing.id }, data: { isActive: false } });
    return res.json({ success: true });
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

export default router;
