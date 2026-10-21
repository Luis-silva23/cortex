import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '@ln-system/shared/utils/token';
import type { JwtPayload } from '@ln-system/shared/types';
import { isAccessTokenRevoked } from '../services/access-token-revocation';
import { isDeviceSessionLive } from '../services/device-session.service';

// Extender tipo Request do Express
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Token não fornecido' });
  }

  const token = authHeader.substring(7);
  let payload: JwtPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    // Assinatura inválida ou token expirado: falha de AUTENTICAÇÃO (401).
    return res.status(401).json({ success: false, error: 'Token inválido ou expirado' });
  }

  // Defesa em profundidade: um token de MFA pendente (emitido após senha
  // válida mas antes da verificação do segundo fator) nunca deve servir
  // como token de sessão completo. Ele é assinado com o mesmo segredo,
  // então sem esta checagem passaria despercebido por verifyAccessToken.
  if ((payload as any).mfaPending) {
    return res.status(401).json({ success: false, error: 'MFA verification pending' });
  }

  try {
    if (await isAccessTokenRevoked(token, payload as any)) {
      return res.status(401).json({ success: false, error: 'Sessão encerrada' });
    }

    // Token de um equipamento: só vale enquanto a sessão de equipamento estiver ativa e o equipamento autorizado. Revogar/bloquear/
    // encerrar a sessão derruba o acesso na hora (e não só no próximo login).
    if (payload.dsid && !(await isDeviceSessionLive(payload.dsid))) {
      return res.status(401).json({ success: false, error: 'Sessão do equipamento encerrada', code: 'DEVICE_SESSION_ENDED' });
    }
  } catch {
    // INDISPONIBILIDADE de dependência (Redis e PostgreSQL fora na checagem de revogação, ou banco fora na do equipamento): não dá
    // para provar que a sessão vale, então NÃO se aceita — mas também não é 401 (o aplicativo não deve deslogar quem não fez nada
    // de errado) nem 403 (não é falta de autorização).
    res.setHeader('Retry-After', '5');
    return res.status(503).json({
      success: false,
      error: 'Não foi possível verificar a sessão agora. Tente novamente em instantes.',
      code: 'AUTH_UNAVAILABLE',
    });
  }

  req.user = payload;
  return next();
}

// Middleware para verificar tipo de usuário
export function requireUserType(...allowedTypes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Não autenticado' });
    }

    if (!allowedTypes.includes(req.user.userType)) {
      return res.status(403).json({ success: false, error: 'Acesso negado' });
    }

    return next();
  };
}

// Nega explicitamente certos tipos de usuário (o inverso de requireUserType).
// Serve para áreas em que quase todo papel tem motivo para entrar e só um papel
// operacional não tem — ex.: MECHANIC (oficina) em vendas/caixa/financeiro/
// compras/fiscal — sem precisar listar (e manter) todos os papéis permitidos.
export function denyUserTypes(...deniedTypes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Não autenticado' });
    }

    if (deniedTypes.includes(req.user.userType)) {
      return res.status(403).json({ success: false, error: 'Acesso negado' });
    }

    return next();
  };
}

// Middleware específico para Super Admin
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  return requireUserType('SUPER_ADMIN')(req, res, next);
}
