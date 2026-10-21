/**
 * Empresa que uma rota de listagem deve consultar.
 *
 * Só SUPER_ADMIN (visão de plataforma, sem empresa no token) pode escolher a
 * empresa pela query string. Para qualquer outro papel vale SEMPRE a empresa
 * do token — um `?companyId=<outra empresa>` é ignorado.
 *
 * Por quê: os schemas de filtro (`productFilterSchema`, `saleFilterSchema`…)
 * aceitam `companyId`, e as rotas faziam `listX({ companyId: token, ...filters })`
 * — o `...filters` vinha depois e sobrescrevia a empresa do token. A RLS do
 * banco barrava o dado alheio na maioria das listas, mas a lista de produtos
 * é servida de um cache Redis com a chave montada a partir desse `companyId`
 * (não passa pela RLS): a empresa B pedindo `?companyId=<A>` recebia a lista
 * de A.
 */
export function resolveListCompanyId(
  user: { userType?: string; companyId?: string | null } | undefined,
  requestedCompanyId?: string
): string {
  // O tipo de retorno é `string` porque os services de listagem tipam
  // `companyId: string` (antes as rotas passavam `any`). Em runtime é
  // `undefined` quando SUPER_ADMIN não escolheu empresa (lista todas), igual
  // ao comportamento anterior.
  if (user?.userType === 'SUPER_ADMIN') {
    return (requestedCompanyId ?? user.companyId ?? undefined) as string;
  }
  return (user?.companyId ?? undefined) as string;
}
