/**
 * Dicas de interface por papel — NÃO são autorização. O backend (rotas + RLS) é a autoridade e continua recusando (403) o que o
 * papel não pode; aqui só se esconde o botão que sabidamente falharia, espelhando as travas de `quotes.routes.ts`,
 * `service-orders.routes.ts`, `motorcycles.routes.ts`, `customers.routes.ts` e `sales.routes.ts`.
 */
const WORKSHOP_WRITERS = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC'];
const COMPANY_WIDE = ['SUPER_ADMIN', 'COMPANY_ADMIN'];

const has = (list: string[], userType?: string | null) => !!userType && list.includes(userType);

/** Cria/edita orçamento e OS, cadastra cliente e veículo (todos menos VIEWER). */
export const canWrite = (userType?: string | null) => has(WORKSHOP_WRITERS, userType);
/** MECHANIC não lê vendas (custo, cartão, faturamento). */
export const canSeeSales = (userType?: string | null) => !!userType && userType !== 'MECHANIC';
/** Quem não tem filial no token (empresa toda) precisa escolher a filial da operação. */
export const needsBranchChoice = (user: { userType?: string | null; branchId?: string | null }) => has(COMPANY_WIDE, user.userType) && !user.branchId;
