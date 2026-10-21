import { apiErrorMessage } from '@/lib/api';
import type { Option, SupportCatalog, TicketEvent } from './types';

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '-';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "há 5 min", "há 3 h", "há 2 dias" — e a data completa quando passa de uma semana. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const diff = Date.now() - date.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d <= 7) return d === 1 ? 'há 1 dia' : `há ${d} dias`;
  return formatDateTime(date);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/** Mensagem da API como veio (`{ error }` em PT-BR); sem resposta = problema de rede. */
export function errorText(err: any, fallback: string): string {
  if (err && !err.response && err.message !== 'canceled') {
    if (err.request) return 'Sem conexão com o servidor. Verifique a rede e tente novamente.';
  }
  return apiErrorMessage(err?.response?.data, fallback);
}

export function errorCode(err: any): string | undefined {
  const code = err?.response?.data?.code;
  return typeof code === 'string' ? code : undefined;
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

// -------------------------------------------------------------------------------------------------- rótulos

/**
 * Na visão da plataforma, AGUARDANDO_USUARIO é "Aguardando cliente": o rótulo do backend ("Aguardando você") é
 * escrito para quem abriu o chamado.
 */
const PLATFORM_STATUS_LABELS: Record<string, string> = {
  AGUARDANDO_USUARIO: 'Aguardando cliente',
};

const FALLBACK_STATUS_LABELS: Record<string, string> = {
  ABERTO: 'Aberto',
  EM_ANALISE: 'Em análise',
  AGUARDANDO_USUARIO: 'Aguardando cliente',
  AGUARDANDO_SUPORTE: 'Aguardando suporte',
  RESOLVIDO: 'Resolvido',
  ENCERRADO: 'Encerrado',
};

const FALLBACK_PRIORITY_LABELS: Record<string, string> = {
  BAIXA: 'Baixa',
  NORMAL: 'Normal',
  ALTA: 'Alta',
  CRITICA: 'Crítica',
};

export function statusLabel(value: string | null | undefined, catalog?: SupportCatalog | null): string {
  if (!value) return '-';
  if (PLATFORM_STATUS_LABELS[value]) return PLATFORM_STATUS_LABELS[value];
  return catalog?.statuses.find((s) => s.value === value)?.label ?? FALLBACK_STATUS_LABELS[value] ?? value;
}

export function priorityLabel(value: string | null | undefined, catalog?: SupportCatalog | null): string {
  if (!value) return '-';
  return catalog?.priorities.find((s) => s.value === value)?.label ?? FALLBACK_PRIORITY_LABELS[value] ?? value;
}

export function optionLabel(options: Option[] | undefined, value: string | null | undefined): string {
  if (!value) return '-';
  return options?.find((o) => o.value === value)?.label ?? value;
}

/** Situações que o suporte pode definir (o backend recusa ABERTO manualmente). */
export const SETTABLE_STATUSES = ['EM_ANALISE', 'AGUARDANDO_USUARIO', 'AGUARDANDO_SUPORTE', 'RESOLVIDO', 'ENCERRADO'];

export const AUTHOR_ROLE_LABELS: Record<string, string> = {
  REQUESTER: 'Solicitante',
  COMPANY: 'Empresa',
  SUPPORT: 'Suporte CÓRTEX',
};

export const USER_TYPE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Suporte CÓRTEX',
  COMPANY_ADMIN: 'Administrador da empresa',
  MANAGER: 'Gerente',
  OPERATOR: 'Operador',
  MECHANIC: 'Mecânico',
  VIEWER: 'Visualizador',
};

/** Chaves de `context.details` (resolveContext no backend) em português. */
export const CONTEXT_DETAIL_LABELS: Record<string, string> = {
  saleNumber: 'Venda nº',
  osNumber: 'OS nº',
  quoteNumber: 'Orçamento nº',
  returnNumber: 'Devolução nº',
  ticketNumber: 'Chamado nº',
  status: 'Situação no sistema',
  paymentMethod: 'Forma de pagamento',
  customer: 'Cliente',
  vehicle: 'Veículo',
  name: 'Produto',
  sku: 'SKU',
  description: 'Descrição',
  dueDate: 'Vencimento',
  scheduledAt: 'Agendado para',
  subject: 'Assunto',
};

const DATE_DETAIL_KEYS = new Set(['dueDate', 'scheduledAt']);

export function contextDetailValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (DATE_DETAIL_KEYS.has(key) && typeof value === 'string') return formatDateTime(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// -------------------------------------------------------------------------------------------------- histórico

/** Frase humana para cada evento imutável do chamado. */
export function eventPhrase(e: TicketEvent, catalog?: SupportCatalog | null): string {
  const who = e.actor?.name || 'Alguém';
  const st = (v: string | null) => statusLabel(v, catalog);
  const pr = (v: string | null) => priorityLabel(v, catalog);
  switch (e.type) {
    case 'OPENED':
      return `Chamado aberto por ${who}`;
    case 'ASSIGNED':
      if (e.toValue && e.toValue === who) {
        return e.fromValue ? `${who} assumiu o chamado (antes com ${e.fromValue})` : `${who} assumiu o chamado`;
      }
      return e.fromValue
        ? `Responsável alterado de ${e.fromValue} para ${e.toValue ?? '-'} por ${who}`
        : `Chamado atribuído a ${e.toValue ?? '-'} por ${who}`;
    case 'UNASSIGNED':
      return e.fromValue ? `${who} removeu ${e.fromValue} como responsável` : `${who} deixou o chamado sem responsável`;
    case 'STATUS_CHANGED':
      return `Situação alterada de ${st(e.fromValue)} para ${st(e.toValue)} por ${who}`;
    case 'PRIORITY_CHANGED':
      return `Prioridade alterada de ${pr(e.fromValue)} para ${pr(e.toValue)} por ${who}`;
    case 'REPLIED': {
      const role = AUTHOR_ROLE_LABELS[e.actor?.role] ?? '';
      const base = `${who}${role ? ` (${role})` : ''} respondeu`;
      return e.fromValue && e.toValue && e.fromValue !== e.toValue
        ? `${base}; situação passou de ${st(e.fromValue)} para ${st(e.toValue)}`
        : base;
    }
    case 'REOPENED':
      return `Chamado reaberto por ${who} (${st(e.fromValue)} → ${st(e.toValue)})`;
    case 'CLOSED':
      return `Chamado encerrado por ${who}`;
    case 'ATTACHMENT_ADDED':
      return `Anexo “${e.toValue ?? ''}” adicionado por ${who}`;
    case 'ATTACHMENT_REMOVED':
      return `Anexo “${e.fromValue ?? ''}” removido por ${who}`;
    default:
      return `${e.type} por ${who}`;
  }
}

// -------------------------------------------------------------------------------------------------- selos

/** Verde/amarelo/vermelho só como indicador semântico (tokens do tema); o resto em cinza. */
export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'ABERTO':
    case 'AGUARDANDO_SUPORTE':
      return 'bg-warning-soft text-warning';
    case 'EM_ANALISE':
      return 'bg-secondary text-foreground';
    case 'AGUARDANDO_USUARIO':
      return 'bg-muted text-muted-foreground';
    case 'RESOLVIDO':
      return 'bg-success-soft text-success';
    case 'ENCERRADO':
      return 'bg-muted text-muted-foreground';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

export function priorityBadgeClass(priority: string): string {
  switch (priority) {
    case 'CRITICA':
      return 'bg-danger-soft text-danger';
    case 'ALTA':
      return 'bg-warning-soft text-warning';
    case 'BAIXA':
      return 'bg-muted text-muted-foreground';
    default:
      return 'bg-secondary text-foreground';
  }
}
