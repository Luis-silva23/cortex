import type { PrismaClient } from '@prisma/client';
import { CONTEXT_SET_CONFIG_SQL, contextSqlParams, PLATFORM_CONTEXT } from '@ln-system/database';

/**
 * Provisionamento do segredo do CONTEXTO DE RLS ASSINADO num banco (decisão 151; migração 20261017100000).
 *
 * Quem pode chamar: o DONO do banco (ou superusuário) — `app_ctx.provision` não tem EXECUTE para o papel de execução. O segredo vem de
 * `RLS_CONTEXT_SECRET` (base64, 32–64 bytes; no ambiente real, do cofre de segredos) e NUNCA é impresso.
 *
 * `ensureContextSecret` é idempotente: se o banco já exige assinatura E aceita a assinatura gerada com o segredo do ambiente, não faz
 * nada; senão provisiona (o segredo anterior fica no slot 2 até `app_ctx.retire_previous()`).
 */
export function contextSecretHex(): string {
  const raw = process.env.RLS_CONTEXT_SECRET;
  if (!raw) throw new Error('RLS_CONTEXT_SECRET ausente (apps/api/.env em desenvolvimento; cofre de segredos em produção).');
  const key = Buffer.from(raw, 'base64');
  if (key.length < 32 || key.length > 64) throw new Error('RLS_CONTEXT_SECRET inválido: precisa ter entre 32 e 64 bytes em base64.');
  return key.toString('hex');
}

/** O banco aceita um contexto de plataforma assinado com o segredo do ambiente E está em modo "exige assinatura"? */
export async function contextSecretWorks(db: PrismaClient): Promise<boolean> {
  try {
    const status = (await db.$queryRawUnsafe('SELECT enforced FROM app_ctx.status()')) as Array<{ enforced: boolean }>;
    if (!status[0]?.enforced) return false;
    const [, rows] = (await db.$transaction([
      db.$executeRawUnsafe(CONTEXT_SET_CONFIG_SQL, ...contextSqlParams(PLATFORM_CONTEXT)),
      db.$queryRawUnsafe('SELECT app_ctx.is_super_admin() AS ok'),
    ])) as [number, Array<{ ok: boolean }>];
    return rows[0]?.ok === true;
  } catch (error) {
    if (process.env.CTX_DEBUG) console.error(`[ctx] contextSecretWorks: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
    return false;
  }
}

export async function ensureContextSecret(db: PrismaClient): Promise<'already' | 'provisioned'> {
  const hex = contextSecretHex();
  if (await contextSecretWorks(db)) return 'already';
  await db.$executeRawUnsafe(`SELECT app_ctx.provision(decode($1, 'hex'))`, hex);
  // As funções de verificação são SECURITY DEFINER: rodam como o DONO delas. Provisionado pelo próprio dono (db-grants/db:provision-context) o cofre já é dele; provisionado por
  // um SUPERUSUÁRIO (DBA restaurando um backup à mão) o cofre nasceria de outro dono e as funções não o leriam ("permissão negada para esquema app_ctx_vault").
  await db.$executeRawUnsafe(`DO $do$
    DECLARE o regrole;
    BEGIN
      SELECT proowner::regrole INTO o FROM pg_proc WHERE oid = 'app_ctx._sig_ok()'::regprocedure;
      IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AND o::oid <> (SELECT oid FROM pg_roles WHERE rolname = current_user) THEN
        EXECUTE format('ALTER SCHEMA app_ctx_vault OWNER TO %s', o);
        EXECUTE format('ALTER TABLE app_ctx_vault.secrets OWNER TO %s', o);
      END IF;
    END $do$`);
  if (!(await contextSecretWorks(db))) throw new Error('segredo provisionado, mas o banco não aceita a assinatura do ambiente (relógio do banco × aplicação fora de ±120 s?)');
  return 'provisioned';
}
