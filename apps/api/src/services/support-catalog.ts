/**
 * Catálogo central da Central de Suporte (docs/CORTEX/SUPPORT.md). O banco guarda texto; só valores daqui são aceitos —
 * o frontend lê este catálogo (GET /support-kb/catalog) e não inventa módulo, tipo, prioridade nem estado. Novo tipo ou
 * módulo = uma linha aqui (e o rótulo), sem mudar o domínio.
 */
export const SUPPORT_MODULES = {
  PDV: 'PDV',
  BALCAO: 'Balcão',
  OFICINA: 'Oficina',
  ESTOQUE: 'Estoque',
  COMPRAS: 'Compras',
  FINANCEIRO: 'Financeiro',
  FISCAL: 'Fiscal',
  CONVENIOS: 'Convênios',
  AGENDA: 'Agenda',
  POS_VENDA: 'Pós-venda',
  REVISOES: 'Revisões',
  GARANTIAS: 'Garantias',
  MOBILE: 'Mobile',
  ANDROID_TV: 'Android TV',
  USUARIOS: 'Usuários e permissões',
  CONFIGURACOES: 'Configurações',
  OUTRO: 'Outro',
} as const;
export type SupportModule = keyof typeof SUPPORT_MODULES;

export const SUPPORT_TYPES = {
  PROBLEMA: 'Problema',
  DUVIDA: 'Dúvida',
  SOLICITACAO: 'Solicitação',
  SUGESTAO: 'Sugestão',
} as const;
export type SupportType = keyof typeof SUPPORT_TYPES;

export const SUPPORT_PRIORITIES = {
  BAIXA: 'Baixa',
  NORMAL: 'Normal',
  ALTA: 'Alta',
  CRITICA: 'Crítica',
} as const;
export type SupportPriority = keyof typeof SUPPORT_PRIORITIES;

export const SUPPORT_STATUSES = {
  ABERTO: 'Aberto',
  EM_ANALISE: 'Em análise',
  AGUARDANDO_USUARIO: 'Aguardando você',
  AGUARDANDO_SUPORTE: 'Aguardando suporte',
  RESOLVIDO: 'Resolvido',
  ENCERRADO: 'Encerrado',
} as const;
export type SupportStatus = keyof typeof SUPPORT_STATUSES;

/** Estados que ainda pedem ação de alguém (filtro "abertos" e contadores). */
export const OPEN_STATUSES: SupportStatus[] = ['ABERTO', 'EM_ANALISE', 'AGUARDANDO_USUARIO', 'AGUARDANDO_SUPORTE'];

/** O suporte pode levar o chamado a qualquer estado, menos voltar para ABERTO (abertura é um fato). */
export const SUPPORT_SETTABLE_STATUSES: SupportStatus[] = ['EM_ANALISE', 'AGUARDANDO_USUARIO', 'AGUARDANDO_SUPORTE', 'RESOLVIDO', 'ENCERRADO'];

export const SUPPORT_SOURCES = {
  ADMIN_WEB: 'Admin Web',
  PDV: 'PDV',
  MOBILE: 'Mobile',
  ANDROID_TV: 'Android TV',
  SUPER_ADMIN: 'Console de suporte',
} as const;
export type SupportSource = keyof typeof SUPPORT_SOURCES;

/**
 * Entidades que um chamado pode referenciar. O servidor confere que a entidade existe NA EMPRESA/FILIAL de quem abre
 * (RLS + filtro) e monta o rótulo — o id enviado pelo frontend nunca é aceito sem essa conferência.
 */
export const SUPPORT_ENTITY_TYPES = {
  SALE: 'Venda',
  PAYMENT: 'Pagamento',
  SERVICE_ORDER: 'OS',
  QUOTE: 'Orçamento',
  PRODUCT: 'Produto',
  RECEIVABLE: 'Conta a receber',
  WARRANTY: 'Garantia',
  APPOINTMENT: 'Agendamento',
  SUPPLIER_RETURN: 'Devolução ao fornecedor',
  SUPPORT_TICKET: 'Chamado anterior',
} as const;
export type SupportEntityType = keyof typeof SUPPORT_ENTITY_TYPES;

export const SUPPORT_LIMITS = {
  subjectMax: 160,
  descriptionMax: 10_000,
  messageMax: 10_000,
  /** 2 MB por anexo (o corpo JSON da API aceita 5 MB; em base64 o arquivo cresce ~33%). */
  attachmentMaxBytes: 2 * 1024 * 1024,
  attachmentsPerTicket: 10,
  pageMax: 50,
} as const;

export const SUPPORT_ATTACHMENT_TYPES = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt', '.log'],
} as const;
export type SupportAttachmentMime = keyof typeof SUPPORT_ATTACHMENT_TYPES;

export const catalogView = () => ({
  modules: Object.entries(SUPPORT_MODULES).map(([value, label]) => ({ value, label })),
  types: Object.entries(SUPPORT_TYPES).map(([value, label]) => ({ value, label })),
  priorities: Object.entries(SUPPORT_PRIORITIES).map(([value, label]) => ({ value, label })),
  statuses: Object.entries(SUPPORT_STATUSES).map(([value, label]) => ({ value, label, open: OPEN_STATUSES.includes(value as SupportStatus) })),
  sources: Object.entries(SUPPORT_SOURCES).map(([value, label]) => ({ value, label })),
  entityTypes: Object.entries(SUPPORT_ENTITY_TYPES).map(([value, label]) => ({ value, label })),
  attachments: { maxBytes: SUPPORT_LIMITS.attachmentMaxBytes, perTicket: SUPPORT_LIMITS.attachmentsPerTicket, types: SUPPORT_ATTACHMENT_TYPES },
});
