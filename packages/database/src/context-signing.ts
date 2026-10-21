import { createHmac } from 'node:crypto';
import type { RLSContext } from './rls-context';

/**
 * ASSINATURA DO CONTEXTO DE RLS (decisão 151).
 *
 * Problema: as policies leem `app.user_type`, `app.current_company_id`... que são variáveis de sessão do PostgreSQL. Quem consegue
 * executar SQL pela conexão da aplicação (injeção de SQL, falha de filtro com SQL cru) conseguia `set_config('app.user_type',
 * 'SUPER_ADMIN', true)` e ler tudo. Agora a aplicação ASSINA o contexto com HMAC-SHA256 (segredo que só ela e o dono do banco
 * conhecem) e o banco só aceita contexto cuja assinatura confere (`app_ctx._sig_ok`, migração 20261017100000):
 *  - a mensagem assinada cobre empresa, filial ativa, filiais autorizadas, papel, usuário e o instante (`iat`);
 *  - o banco confere a assinatura com o segredo guardado num schema que o papel de execução NÃO lê nem altera;
 *  - assinatura inválida, ausente ou fora da janela de ±120 s ⇒ nenhum papel, nenhuma empresa ⇒ RLS nega tudo (falha fechada).
 *
 * LIMITES REAIS (ver docs/CORTEX/RLS_CONTEXTO_ASSINADO.md): (a) quem comprometer o PROCESSO da API (executa código nele) tem o segredo
 * e pode assinar o que quiser; (b) quem injeta SQL durante uma requisição continua com o contexto DAQUELA requisição (pode reutilizar
 * a própria assinatura por até 120 s), mas não vira outro usuário, outro papel nem outra empresa; (c) o dono do banco e superusuários
 * não passam por RLS. Isto reduz o risco de "SQL arbitrário ⇒ tudo"; não o elimina.
 */

export const CONTEXT_SIGNATURE_VERSION = 'v1';

export interface ContextGucs {
  'app.current_company_id': string;
  'app.current_branch_id': string;
  'app.current_branch_ids': string;
  'app.user_type': string;
  'app.user_id': string;
  'app.ctx_iat': string;
  'app.ctx_sig': string;
}

/** Contexto de plataforma (Super Admin sem empresa): usado por jobs, webhooks, scripts e leituras internas da própria API. */
export const PLATFORM_CONTEXT: RLSContext = Object.freeze({ companyId: null, userType: 'SUPER_ADMIN', branchId: null }) as RLSContext;

function secretKey(): Buffer | null {
  const raw = process.env.RLS_CONTEXT_SECRET;
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length < 32 || key.length > 64) {
    throw new Error('RLS_CONTEXT_SECRET inválido: precisa ter entre 32 e 64 bytes em base64 (use: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))")');
  }
  return key;
}

/** true se o processo tem o segredo para assinar (a API em produção exige; o banco só passa a exigir assinatura depois de `app_ctx.provision`). */
export function canSignContext(): boolean {
  return secretKey() !== null;
}

function field(value: string | null | undefined, name: string): string {
  const v = value ?? '';
  if (v.includes('|')) throw new Error(`contexto de RLS inválido: "${name}" contém "|"`);
  return v;
}

/**
 * Valores das variáveis de sessão para este contexto. Ordem e formato da mensagem são o contrato com `app_ctx._sig_ok`:
 * `v1|iat|empresa|filial|filiais|papel|usuario` (campos vazios = ''). Sem `RLS_CONTEXT_SECRET` a assinatura sai vazia: serve a bancos
 * ainda não migrados para o modo "assinado" (o banco aceita o contexto cru enquanto `app_ctx.settings.enforced` for falso).
 */
export function contextGucs(ctx: RLSContext, nowMs: number = Date.now()): ContextGucs {
  const company = field(ctx.companyId, 'companyId');
  const branch = field(ctx.branchId, 'branchId');
  const branches = field([...new Set(ctx.branchIds ?? [])].sort().join(','), 'branchIds');
  const userType = field(ctx.userType, 'userType');
  const userId = field(ctx.userId, 'userId');
  const iat = String(Math.floor(nowMs / 1000));
  const key = secretKey();
  const sig = key
    ? createHmac('sha256', key)
        .update([CONTEXT_SIGNATURE_VERSION, iat, company, branch, branches, userType, userId].join('|'), 'utf8')
        .digest('hex')
    : '';
  return {
    'app.current_company_id': company,
    'app.current_branch_id': branch,
    'app.current_branch_ids': branches,
    'app.user_type': userType,
    'app.user_id': userId,
    'app.ctx_iat': iat,
    'app.ctx_sig': sig,
  };
}

/** Um único `SELECT set_config(...)` (parâmetros $1..$7 na ordem de `contextSqlParams`) — para `$executeRawUnsafe`/`$queryRawUnsafe`. */
export const CONTEXT_SET_CONFIG_SQL =
  "SELECT set_config('app.current_company_id', $1, true), set_config('app.current_branch_id', $2, true), set_config('app.current_branch_ids', $3, true), " +
  "set_config('app.user_type', $4, true), set_config('app.user_id', $5, true), set_config('app.ctx_iat', $6, true), set_config('app.ctx_sig', $7, true)";

/** Argumentos de `CONTEXT_SET_CONFIG_SQL`. */
export function contextSqlParams(ctx: RLSContext): string[] {
  const g = contextGucs(ctx);
  return [g['app.current_company_id'], g['app.current_branch_id'], g['app.current_branch_ids'], g['app.user_type'], g['app.user_id'], g['app.ctx_iat'], g['app.ctx_sig']];
}

/**
 * Comandos `SELECT set_config(...)` como TEXTO, para clientes SQL externos (psql nos scripts de ensaio). `isLocal=false` vale a sessão
 * inteira — só para scripts descartáveis. Os valores são escapados (aspas simples dobradas).
 */
export function contextSqlStatements(ctx: RLSContext, isLocal = false): string[] {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const g = contextGucs(ctx);
  return (Object.keys(g) as Array<keyof ContextGucs>).map((k) => `SELECT set_config('${k}', ${q(g[k])}, ${isLocal ? 'true' : 'false'})`);
}
