import { Request, Response, NextFunction } from 'express';
import { policyService } from '../services/policy.service';

/**
 * OPERAÇÕES DE CAIXA SÓ POR EQUIPAMENTO AUTORIZADO (docs/CORTEX/DISPOSITIVOS.md §8). A política `devices.requiredUserTypes` lista os
 * perfis que só operam a FRENTE DE CAIXA (abrir/fechar caixa, movimentar caixa, vender, receber pagamento) por um equipamento
 * autorizado: o token dessa sessão carrega `dsid` (a DeviceSession), que o `authMiddleware` já conferiu contra o PostgreSQL.
 *
 * Por que na OPERAÇÃO e não no login: o mesmo perfil (ex.: OPERATOR/Balcão) também usa o Admin Web para atendimento (orçamento, OS,
 * consulta), pelo navegador, que não é um equipamento. Exigir equipamento no login trancaria esse uso legítimo; exigir na operação de
 * caixa não depende de o cliente "se declarar terminal": quem omite o equipamento só perde a capacidade de mexer em dinheiro. O
 * Admin Web não cria venda, pagamento nem movimento de caixa (só lista, consulta e cancela com autorizador), então não é afetado.
 *
 * Lista vazia (padrão) = sem exigência (decisão 109: o dono define quando ligar). Super Admin (sem empresa) não passa por aqui.
 */
export async function requireDeviceForCashOps(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user;
    if (!user?.companyId || user.dsid) return next();
    const required = (await policyService.get(user.companyId, user.branchId ?? null, 'devices.requiredUserTypes')) as string[];
    if (!required.includes(user.userType)) return next();
    return res.status(403).json({
      success: false,
      error: 'Esta operação de caixa só pode ser feita em um equipamento autorizado pelo administrador.',
      code: 'DEVICE_REQUIRED',
    });
  } catch (error) {
    return next(error);
  }
}
