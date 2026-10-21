/**
 * Mensagem para o balcão a partir da resposta de erro da API. O servidor devolve formatos diferentes (`{ error }`, `{ message,
 * code }`, `{ error: 'Unauthorized', message }`); o texto útil nem sempre está em `error`. Nenhum detalhe técnico (stack, SQL,
 * caminho de arquivo) chega à tela: só a mensagem em português ou uma frase genérica.
 */
const GENERIC_HTTP = /^(Unauthorized|Forbidden|Bad Request|Not Found|Conflict|Too Many Requests|Internal Server Error)$/i;

// Códigos conhecidos que merecem uma frase própria para quem está no balcão.
const BY_CODE: Record<string, string> = {
  OPEN_QUOTE_EXISTS: 'Este veículo já tem um orçamento em aberto. Abra o existente ou confirme que deseja criar outro.',
  MODULE_DISABLED: 'Este módulo não está habilitado para a empresa. Procure o administrador.',
  BRANCH_REQUIRED: 'Escolha a filial para continuar.',
  BRANCH_FORBIDDEN: 'Você só pode operar na sua própria filial.',
  PRODUCT_NOT_FOUND: 'Produto não encontrado nesta empresa.',
  DEVICE_SESSION_ENDED: 'A sessão deste equipamento foi encerrada. Entre novamente.',
  DEVICE_REQUIRED: 'Esta operação só pode ser feita em um equipamento autorizado.',
  FORBIDDEN: 'Usuário sem autorização. Entre em contato com o administrador.',
  INSUFFICIENT_PERMISSIONS: 'Usuário sem autorização. Entre em contato com o administrador.',
  READ_ONLY_ROLE: 'Usuário sem autorização. Entre em contato com o administrador.',
};

export function apiErrorMessage(data: any, status?: number, fallback = 'Não foi possível concluir a operação. Tente novamente.'): string {
  if (status === 429) return 'Muitas tentativas. Aguarde um instante e tente de novo.';
  if (status && status >= 500) return 'O servidor teve um problema. Tente novamente em instantes.';
  if (data && typeof data.code === 'string' && BY_CODE[data.code]) return BY_CODE[data.code];
  if (!data) return fallback;
  const candidates = [data.message, data.error].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const useful = candidates.find((v) => !GENERIC_HTTP.test(v.trim()));
  if (useful) return useful;
  if (status === 403) return 'Usuário sem autorização. Entre em contato com o administrador.';
  if (status === 404) return 'Registro não encontrado.';
  if (status === 401) return 'Sessão expirada. Entre novamente.';
  return fallback;
}

/** Falha sem resposta HTTP = rede/servidor inalcançável (a operação NÃO foi concluída). */
export const NETWORK_ERROR_MESSAGE = 'Sem conexão com o servidor — a operação NÃO foi concluída. Verifique a rede e tente novamente.';
