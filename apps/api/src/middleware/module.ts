import { Request, Response, NextFunction } from 'express';
import { AuthorizationError } from '@ln-system/shared';
import moduleSettingsService from '../services/module-settings.service';
import { SystemModule } from '@ln-system/database';

// Texto exigido pelo produto para módulo desativado (o mesmo aparece na tela do Admin Web).
export const MODULE_DISABLED_MESSAGE = 'Módulo desativado para esta filial ou empresa. Favor entrar em contato com o administrador.';

/**
 * Gate de módulo — aplicado no `router.use(...)` de cada arquivo de rotas
 * do módulo (mesmo nível de authMiddleware/tenantIsolation), NUNCA como
 * substituto de requirePermission: um módulo desativado bloqueia TODO
 * mundo, inclusive quem teria permissão — desativação de módulo e
 * permissão são checagens independentes, a mais restritiva vence.
 *
 * SUPER_ADMIN nunca é bloqueado por módulo desativado — precisa continuar
 * acessando qualquer empresa para suporte/operação, mesmo que a própria
 * empresa tenha desligado o módulo para os usuários dela (mesmo critério
 * já usado em requirePermission).
 */
export const requireModuleEnabled = (module: SystemModule) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      if (!user) {
        throw new AuthorizationError('Usuário não autenticado');
      }
      if (user.userType === 'SUPER_ADMIN') {
        return next();
      }

      const enabled = await moduleSettingsService.isModuleEnabled(user.companyId, user.branchId ?? null, module);
      if (!enabled) {
        throw new AuthorizationError(MODULE_DISABLED_MESSAGE, 'MODULE_DISABLED');
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};
