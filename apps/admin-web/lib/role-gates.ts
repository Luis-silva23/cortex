// Papéis aceitos pela API em ações gerenciais. A API (requireUserType) continua
// sendo a autoridade — isto só decide o que DESENHAR na tela, para não mostrar
// um botão que responderia 403 (transferência aprovar/rejeitar/cancelar,
// inventário fechar/cancelar, avaria registrar/reverter, configuração fiscal).
// Papel desconhecido (token ausente/ilegível) conta como "sem permissão": é
// melhor esconder um botão do que oferecer uma ação que vai falhar.

const MANAGER_AND_ABOVE = ['MANAGER', 'COMPANY_ADMIN', 'SUPER_ADMIN'];
const COMPANY_ADMIN_AND_ABOVE = ['COMPANY_ADMIN', 'SUPER_ADMIN'];
const CUSTOMER_REGISTRARS = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC'];

// Gerente ou acima: aprovações de estoque (transferência, inventário, avaria).
export function isManagerOrAbove(userType?: string | null): boolean {
  return !!userType && MANAGER_AND_ABOVE.includes(userType);
}

// Cadastrar cliente e moto (customers/motorcycles.routes.ts): todos menos VIEWER.
export function canRegisterCustomer(userType?: string | null): boolean {
  return !!userType && CUSTOMER_REGISTRARS.includes(userType);
}

// Importação em lote (`data:import`): a API recusa o VIEWER sempre (papel somente leitura, mesmo com perfil granular).
// Os demais papéis dependem de permissão atribuída, que a tela não conhece: continuam vendo o botão.
export function canImportData(userType?: string | null): boolean {
  return !!userType && userType !== 'VIEWER';
}

// Administrador da empresa ou acima: configuração fiscal (contém credenciais).
export function isCompanyAdminOrAbove(userType?: string | null): boolean {
  return !!userType && COMPANY_ADMIN_AND_ABOVE.includes(userType);
}

export const MANAGER_ONLY_NOTICE =
  'Somente leitura: esta ação exige perfil de Gerente ou Administrador.';

export const COMPANY_ADMIN_ONLY_NOTICE =
  'Somente leitura: a configuração fiscal (que guarda credenciais) só pode ser vista e alterada por um Administrador da empresa.';
