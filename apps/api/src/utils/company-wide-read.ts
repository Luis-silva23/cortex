import { CONTEXT_SET_CONFIG_SQL, contextSqlParams } from '@ln-system/database';
import type { PrismaTransactionClient, RLSContext } from '@ln-system/database';

/**
 * Leitura "empresa inteira" dentro de uma transação que já está no contexto RLS de UMA empresa — o único ponto da API
 * que amplia a visão de um usuário de filial, para os poucos casos em que a regra precisa enxergar outras filiais da
 * MESMA empresa sem devolver esses dados ao usuário:
 *  - numeração única por empresa (devolução ao fornecedor): o maior número em uso;
 *  - conflito de agenda do mesmo mecânico em outra filial: só os intervalos ocupados dele.
 *
 * Garantias (testadas em company-wide-read.test.ts):
 *  - a empresa do contexto precisa ser a informada — nunca amplia para outra empresa nem sem empresa;
 *  - só troca perfil/filial do contexto (`app.user_type` → COMPANY_ADMIN, `app.current_branch_id` → vazio); a empresa
 *    (`app.current_company_id`) não muda, então a RLS de empresa continua valendo;
 *  - o contexto anterior volta ao final, com erro ou sem; `set_config(..., true)` é local à transação de qualquer forma;
 *  - quem chama só LÊ (agregados/intervalos filtrados por empresa) — não use para gravar nem para devolver linhas.
 */
export async function withCompanyWideRead<T>(tx: PrismaTransactionClient, companyId: string, fn: () => Promise<T>): Promise<T> {
  const [prev] = await tx.$queryRaw<Array<{ co: string | null; ut: string | null; br: string | null; brs: string | null; uid: string | null }>>`
    SELECT current_setting('app.current_company_id', true) AS co,
           current_setting('app.user_type', true) AS ut,
           current_setting('app.current_branch_id', true) AS br,
           current_setting('app.current_branch_ids', true) AS brs,
           current_setting('app.user_id', true) AS uid`;
  const userType = prev?.ut ?? '';
  // Administração já enxerga a empresa inteira: nada a ampliar (e a consulta de quem chama filtra por companyId).
  if (userType === 'SUPER_ADMIN' || userType === 'COMPANY_ADMIN') return fn();
  if (!companyId || !prev?.co || prev.co !== companyId) {
    throw new Error('withCompanyWideRead: contexto de empresa ausente ou diferente — leitura ampliada recusada');
  }
  // O contexto é ASSINADO: a ampliação (e a volta) são novos contextos assinados pela própria API, nunca `set_config` cru (o banco os ignora).
  const original: RLSContext = {
    companyId: prev.co,
    userType,
    branchId: prev.br || null,
    branchIds: prev.brs ? prev.brs.split(',') : undefined,
    userId: prev.uid || null,
  };
  await tx.$executeRawUnsafe(CONTEXT_SET_CONFIG_SQL, ...contextSqlParams({ companyId: prev.co, userType: 'COMPANY_ADMIN', branchId: null, userId: original.userId }));
  try {
    return await fn();
  } finally {
    await tx.$executeRawUnsafe(CONTEXT_SET_CONFIG_SQL, ...contextSqlParams(original));
  }
}
