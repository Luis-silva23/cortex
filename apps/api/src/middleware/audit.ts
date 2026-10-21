import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { prisma, AuditAction, runWithRLSContext } from '@ln-system/database';
import { jobQueue } from '../config/queue';
import { persistAuditLog, type AuditJobData } from '../jobs/audit.job';

// Chaves cujo VALOR nunca pode ir para o audit log: o audit é legível por
// MANAGER/COMPANY_ADMIN/SUPER_ADMIN (GET /audit-logs) e fica também nos jobs da
// fila — segredo TOTP, códigos de backup, QR code (contém o segredo), senhas,
// tokens, chaves. Flags booleanas (`mfaEnabled`, `hasCertificatePassword`) e
// null passam: dizem que existe, não o que é.
// `credential`: a credencial (JWT de ~10 anos) que POST /activations/:id/approve devolve
// ao aprovar um dispositivo — antes ia em texto puro para audit_logs e para a fila.
const SENSITIVE_KEY = /(pass(word)?|secret|token|credential|authorization|cookie|backup_?codes?|qr_?code|mfa_?code|otpauth|^otp$|api_?key|private_?key|cvv)/i;
const REDACTED = '[REDACTED]';

export function redactSensitive(value: any): any {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key) && item !== null && item !== undefined && typeof item !== 'boolean') {
        out[key] = REDACTED;
      } else {
        out[key] = redactSensitive(item);
      }
    }
    return out;
  }
  return value;
}

/**
 * Middleware para log de auditoria
 * Registra ações importantes no sistema
 */
export interface AuditDescription {
  entityId?: string | null;
  companyId?: string | null;
  newValue?: unknown;
}

export interface AuditLogOptions {
  // Para rotas cuja resposta não traz `data` (ou não traz o que importa): monta
  // o que vai para o audit a partir da requisição e da resposta. Sem isto o
  // padrão continua sendo `body.data`. (Ex.: ativar/desativar módulo respondia a
  // linha crua e o audit gravava "null" — sem módulo, estado nem motivo.)
  describe?: (req: Request, body: any) => AuditDescription;
}

/** Prazo para a fila confirmar a auditoria antes de gravá-la direto no banco. */
export const AUDIT_ENQUEUE_TIMEOUT_MS = 1500;

/**
 * A auditoria NUNCA fica só na memória do processo nem só no Redis (fonte da verdade é o PostgreSQL). O caminho normal é a fila
 * (`jobId` = id da auditoria). Se o Redis estiver fora, `add` não rejeita: fica pendurado esperando a reconexão — daí o prazo. Passado
 * o prazo (ou se a fila rejeitar), grava DIRETO com o mesmo id; se a fila entregar depois, a gravação é idempotente (mesma linha).
 */
export async function recordAudit(auditData: AuditJobData & { id: string }): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      jobQueue.add('audit-log', auditData, { jobId: auditData.id }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('audit queue timeout')), AUDIT_ENQUEUE_TIMEOUT_MS);
      }),
    ]);
  } catch (queueError) {
    try {
      await persistAuditLog(auditData);
    } catch (dbError) {
      console.error('Falha ao registrar auditoria (fila e banco):', (queueError as Error).message, (dbError as Error).message);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function auditLog(action: AuditAction, entity: string, options: AuditLogOptions = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const originalSend = res.json.bind(res);

    res.json = function (body: any) {
      // Registrar auditoria apenas em caso de sucesso (2xx)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const described = options.describe?.(req, body);
        // Antes: sempre `req.user?.companyId` — para o Super Admin (sem
        // empresa própria), isso gravava `companyId: null` mesmo quando a
        // ação era SOBRE uma empresa específica (ex.: criar uma filial ou
        // usuário para a Empresa X). Resultado: a Empresa X nunca via essa
        // ação na própria tela de auditoria (RLS por companyId — ver
        // audit-log.service.ts — simplesmente não retornava a linha).
        // Corrigido: quando o ator não tem empresa própria (Super Admin),
        // usa a empresa do RECURSO afetado — `body.data.companyId` para a
        // maioria das entidades, ou o próprio `body.data.id` quando a
        // entidade É a empresa (rotas de Company).
        // Rotas envelopadas respondem `{ success, data }`; as de domínio (venda, pagamento, estoque, compra...)
        // respondem o próprio objeto — sem este fallback a auditoria gravava "null" e entityId nulo.
        const payload =
          body && typeof body === 'object' && !Array.isArray(body) ? (body.data !== undefined ? body.data : body) : body?.data;
        const resourceCompanyId =
          described?.companyId ?? payload?.companyId ?? (entity === 'Company' ? payload?.id : undefined) ?? null;
        const auditData = {
          id: randomUUID(),
          companyId: req.user?.companyId || resourceCompanyId,
          userId: req.user?.userId || null,
          action,
          entity,
          entityId: described?.entityId || payload?.id || req.params.id || null,
          // Estado anterior não é capturado de forma genérica (exige ler o registro antes, por entidade) — ver
          // docs/CORTEX/contracts/audit-event-matrix.md.
          oldValue: null,
          newValue: JSON.stringify(redactSensitive(described?.newValue ?? payload) ?? null),
          ipAddress: req.ip || req.socket.remoteAddress || null,
          userAgent: req.headers['user-agent'] || null,
        };

        // Registrar auditoria de forma assíncrona via fila, com gravação direta no PostgreSQL se a fila não confirmar (Redis fora).
        void recordAudit(auditData);
      }

      return originalSend(body);
    };

    next();
  };
}

/**
 * Criar log de auditoria diretamente
 */
export async function createAuditLog(data: {
  companyId?: string | null;
  userId?: string | null;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  try {
    // Hoje só é chamada por /auth/login e /auth/logout — rotas pré-tenant,
    // sem `tenantIsolation`, portanto sem contexto de RLS ativo. Mesmo
    // bypass usado nos jobs do BullMQ (ver audit.job.ts/observability.job.ts):
    // sem ele, a escrita era negada pela RLS e o erro ficava mascarado por
    // este próprio try/catch (silenciosamente perdido, nunca chegava a
    // aparecer como falha visível).
    await runWithRLSContext({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }, async () => {
      await prisma.auditLog.create({
        data: {
          companyId: data.companyId || null,
          userId: data.userId || null,
          action: data.action,
          entity: data.entity,
          entityId: data.entityId || null,
          oldValue: data.oldValue || null,
          newValue: data.newValue || null,
          ipAddress: data.ipAddress || null,
          userAgent: data.userAgent || null,
        },
      });
    });
  } catch (error) {
    console.error('Error creating audit log:', error);
  }
}
