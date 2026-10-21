import { prismaUnsafeBypassRLS, contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';

/**
 * TRAVAS CONTRA OPERAÇÃO DESTRUTIVA EM TESTE (regra de 2026-09-21).
 *
 * O Prisma IGNORA chaves `undefined` no `where`: `deleteMany({ where: { productId: undefined } })` vira
 * `deleteMany({ where: {} })` e apaga a TABELA INTEIRA (aconteceu: um teste apagou todas as movimentações de
 * estoque do banco de dev quando o `beforeAll` falhou antes de atribuir o id). Aqui:
 *   - `checkDestructiveArgs`: recusa `undefined` em qualquer profundidade do `where` e `where` vazio;
 *   - `installDestructiveGuard`: aplica isso a TODA escrita destrutiva do cliente Prisma durante a suíte;
 *   - `assertDestroyable`: só deixa apagar uma empresa SINTÉTICA, e nunca com id ausente/inválido.
 */

export class UnsafeDestructiveOperationError extends Error {
  constructor(message: string) {
    super(`UnsafeDestructiveOperation: ${message}`);
    this.name = 'UnsafeDestructiveOperationError';
  }
}

/** Prefixo obrigatório do nome de toda empresa que os testes podem criar E apagar. Empresas de demonstração/reais nunca o usam. */
export const SYNTHETIC_COMPANY_PREFIX = 'Integration Test Co';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Caminho (ex.: "sale.companyId") do primeiro valor `undefined` dentro do filtro, ou null se não houver. */
export function findUndefinedPath(value: unknown, path: string[] = []): string | null {
  if (value === undefined) return path.join('.') || '<raiz>';
  if (value === null || typeof value !== 'object' || value instanceof Date) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findUndefinedPath(value[i], [...path, String(i)]);
      if (found) return found;
    }
    return null;
  }
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const found = findUndefinedPath(inner, [...path, key]);
    if (found) return found;
  }
  return null;
}

const FILTERED_ACTIONS = new Set(['deleteMany', 'updateMany', 'delete', 'update']);
const MANY_ACTIONS = new Set(['deleteMany', 'updateMany']);

/** Lança se a operação destrutiva tiver um filtro inseguro. Operações não destrutivas passam. */
export function checkDestructiveArgs(model: string | undefined, action: string, args: any): void {
  if (!FILTERED_ACTIONS.has(action)) return;
  const label = `${model ?? '?'}.${action}`;
  const where = args?.where;

  if (MANY_ACTIONS.has(action) && (where === undefined || where === null || (typeof where === 'object' && Object.keys(where).length === 0))) {
    throw new UnsafeDestructiveOperationError(`${label} com "where" vazio apagaria/alteraria a tabela inteira`);
  }
  const bad = findUndefinedPath(where);
  if (bad) {
    throw new UnsafeDestructiveOperationError(
      `${label} com "where.${bad}" === undefined — o Prisma ignora chaves undefined e o filtro deixaria de existir. ` +
        'Garanta o identificador antes (ex.: if (!id) throw) e escope SEMPRE por companyId.'
    );
  }
}

type MiddlewareClient = { $use: (fn: (params: any, next: (params: any) => Promise<any>) => Promise<any>) => void };

const installedOn = new WeakSet<object>();

/** Instala a checagem como middleware do cliente (idempotente por instância). */
export function installDestructiveGuard(client: MiddlewareClient): void {
  if (installedOn.has(client)) return;
  installedOn.add(client);
  client.$use(async (params, next) => {
    checkDestructiveArgs(params.model, params.action, params.args);
    return next(params);
  });
}

async function readCompanyName(companyId: string): Promise<string | null> {
  const db = prismaUnsafeBypassRLS;
  const [, rows] = await db.$transaction([
    contextStatement(db, PLATFORM_CONTEXT),
    db.company.findMany({ where: { id: companyId }, select: { name: true } }) as any,
  ]);
  const list = rows as Array<{ name: string }>;
  return list.length ? list[0].name : null;
}

/**
 * Chamada por destroyFixture/destroyWorld ANTES de qualquer delete: o id precisa existir (uuid válido) e a
 * empresa precisa ser SINTÉTICA. Nunca apaga empresa de demonstração ("CÓRTEX Demo …") nem antiga/real.
 */
export async function assertDestroyable(companyId: unknown): Promise<void> {
  if (typeof companyId !== 'string' || !UUID_RE.test(companyId)) {
    throw new UnsafeDestructiveOperationError(`teardown recusado: companyId ausente/inválido (${String(companyId)})`);
  }
  const name = await readCompanyName(companyId);
  if (name === null) {
    throw new UnsafeDestructiveOperationError(`teardown recusado: a empresa ${companyId} não existe`);
  }
  if (!name.startsWith(SYNTHETIC_COMPANY_PREFIX)) {
    throw new UnsafeDestructiveOperationError(
      `teardown recusado: "${name}" não é uma empresa sintética (o nome precisa começar com "${SYNTHETIC_COMPANY_PREFIX}")`
    );
  }
}
