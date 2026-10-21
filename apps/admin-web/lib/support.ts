// Central de Ajuda e Suporte (docs/CORTEX/SUPPORT.md) — regras de TELA, puras e testáveis (lib/support.test.ts).
// A API é a autoridade: empresa/filial/usuário vêm do token, o contexto (venda, OS, cobrança, garantia) é conferido no
// servidor e o catálogo (módulos, tipos, situações) vem de GET /support-kb/catalog. Aqui só montamos link, validamos o
// arquivo antes de enviar (para o usuário não esperar um upload que será recusado) e escrevemos o histórico em português.

export type SupportStatus = 'ABERTO' | 'EM_ANALISE' | 'AGUARDANDO_USUARIO' | 'AGUARDANDO_SUPORTE' | 'RESOLVIDO' | 'ENCERRADO';
export type AuthorRole = 'REQUESTER' | 'COMPANY' | 'SUPPORT';

export interface CatalogOption {
  value: string;
  label: string;
}

export interface SupportCatalog {
  modules: CatalogOption[];
  types: CatalogOption[];
  priorities: CatalogOption[];
  statuses: Array<CatalogOption & { open: boolean }>;
  sources: CatalogOption[];
  entityTypes: CatalogOption[];
  attachments: { maxBytes: number; perTicket: number; types: Record<string, string[]> };
}

export const SUPPORT_STATUS_VARIANT: Record<SupportStatus, 'default' | 'secondary' | 'success' | 'warning' | 'error' | 'outline'> = {
  ABERTO: 'outline',
  EM_ANALISE: 'secondary',
  AGUARDANDO_USUARIO: 'warning',
  AGUARDANDO_SUPORTE: 'secondary',
  RESOLVIDO: 'success',
  ENCERRADO: 'secondary',
};

export const AUTHOR_ROLE_LABEL: Record<AuthorRole, string> = {
  REQUESTER: 'Solicitante',
  COMPANY: 'Administração da empresa',
  SUPPORT: 'Suporte CÓRTEX',
};

/** Filtros de "Meus chamados" (valor = parâmetro `status` aceito pela API). */
export const TICKET_FILTERS: CatalogOption[] = [
  { value: 'all', label: 'Todos' },
  { value: 'open', label: 'Em aberto' },
  { value: 'EM_ANALISE', label: 'Em análise' },
  { value: 'AGUARDANDO_USUARIO', label: 'Aguardando você' },
  { value: 'AGUARDANDO_SUPORTE', label: 'Aguardando suporte' },
  { value: 'RESOLVIDO', label: 'Resolvidos' },
  { value: 'ENCERRADO', label: 'Encerrados' },
];

export const HELP_HOME = '/dashboard/help';
export const NEW_TICKET_PATH = '/dashboard/help/tickets/new';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Contexto que uma tela passa para o "Relatar problema". Só referência: o servidor confere e monta o rótulo. */
export interface ReportContext {
  module: string;
  screen?: string;
  route?: string;
  entityType?: string;
  entityId?: string;
}

export function buildReportHref(ctx: ReportContext): string {
  const params = new URLSearchParams();
  params.set('module', ctx.module);
  if (ctx.screen) params.set('screen', ctx.screen.slice(0, 80));
  if (ctx.route) params.set('route', ctx.route.slice(0, 200));
  if (ctx.entityType && ctx.entityId) {
    params.set('entityType', ctx.entityType);
    params.set('entityId', ctx.entityId);
  }
  return `${NEW_TICKET_PATH}?${params.toString()}`;
}

/**
 * Lê os parâmetros do link "Relatar problema". Valor fora do catálogo ou id malformado é descartado (o formulário abre
 * sem ele) — nunca vira erro na cara do usuário nem vai para a API sem conferência.
 */
export function parseReportParams(
  params: { get(name: string): string | null },
  catalog: Pick<SupportCatalog, 'modules' | 'entityTypes'> | null
): ReportContext | null {
  const moduleKey = params.get('module') ?? '';
  const validModule = catalog ? catalog.modules.some((m) => m.value === moduleKey) : !!moduleKey;
  if (!moduleKey || !validModule) return null;
  const ctx: ReportContext = { module: moduleKey };
  const screen = (params.get('screen') ?? '').trim();
  const route = (params.get('route') ?? '').trim();
  if (screen) ctx.screen = screen.slice(0, 80);
  if (route.startsWith('/')) ctx.route = route.slice(0, 200);
  const entityType = params.get('entityType') ?? '';
  const entityId = params.get('entityId') ?? '';
  const validType = catalog ? catalog.entityTypes.some((t) => t.value === entityType) : !!entityType;
  if (entityType && validType && UUID.test(entityId)) {
    ctx.entityType = entityType;
    ctx.entityId = entityId;
  }
  return ctx;
}

/** "Módulo → Tela → Registro" sem repetir trechos (a tela já costuma começar pelo módulo e pelo número do registro). */
export function contextTrail(moduleLabel?: string, screen?: string, entityLabel?: string): string {
  const parts = [moduleLabel, ...(screen ? screen.split(' → ') : []), entityLabel].filter((p): p is string => !!p);
  return parts.filter((p, i) => parts.indexOf(p) === i).join(' → ');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** Checagem de UX antes do envio (tamanho e extensão). O servidor valida de novo PELO CONTEÚDO do arquivo. */
export function checkAttachment(file: { name: string; size: number }, limits: SupportCatalog['attachments']): string | null {
  const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
  const allowed = Object.values(limits.types).flat();
  if (!allowed.includes(ext)) return `"${file.name}": tipo não aceito. Envie imagem (PNG ou JPG), PDF ou arquivo de texto/log.`;
  if (file.size === 0) return `"${file.name}": o arquivo está vazio.`;
  if (file.size > limits.maxBytes) return `"${file.name}" tem ${formatBytes(file.size)}. O limite é ${formatBytes(limits.maxBytes)} por arquivo.`;
  return null;
}

export interface SupportEvent {
  type: string;
  fromValue: string | null;
  toValue: string | null;
  actor: { name: string; role: string };
}

/** Uma linha do histórico, em português. `labels` traduz situação/prioridade (vem do catálogo). */
export function eventPhrase(e: SupportEvent, labels: Record<string, string>): string {
  const who = e.actor.role === 'SUPPORT' ? `${e.actor.name} (Suporte CÓRTEX)` : e.actor.name;
  const l = (v: string | null) => (v ? labels[v] ?? v : '—');
  switch (e.type) {
    case 'OPENED':
      return `Chamado aberto por ${who}`;
    case 'ASSIGNED':
      return `Atendimento assumido por ${e.toValue ?? who}`;
    case 'UNASSIGNED':
      return `Atendimento liberado por ${who}`;
    case 'STATUS_CHANGED':
      return `Situação alterada de ${l(e.fromValue)} para ${l(e.toValue)} por ${who}`;
    case 'PRIORITY_CHANGED':
      return `Prioridade alterada de ${l(e.fromValue)} para ${l(e.toValue)} por ${who}`;
    case 'REPLIED':
      return `Mensagem de ${who}`;
    case 'REOPENED':
      return `Chamado reaberto por ${who}`;
    case 'CLOSED':
      return `Chamado encerrado por ${who}`;
    case 'ATTACHMENT_ADDED':
      return `Anexo "${e.toValue ?? ''}" incluído por ${who}`;
    case 'ATTACHMENT_REMOVED':
      return `Anexo "${e.fromValue ?? ''}" removido por ${who}`;
    default:
      return `${e.type} — ${who}`;
  }
}

/** Ações do solicitante conforme a situação (a API recusa o resto com mensagem própria). */
export function requesterActions(status: SupportStatus, isRequester: boolean) {
  return {
    canReply: status !== 'ENCERRADO',
    canAttach: status !== 'ENCERRADO',
    canClose: isRequester && status !== 'ENCERRADO',
    canReopen: status === 'RESOLVIDO',
  };
}
