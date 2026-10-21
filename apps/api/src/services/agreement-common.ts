import { z } from 'zod';
import { prisma } from '@ln-system/database';
import { AppError, ConflictError } from '@ln-system/shared';

/**
 * Utilitários comuns dos convênios (funcionário e empresa externa) e da cobrança manual — docs/CORTEX/policies/CONVENIOS.md.
 * Datas de negócio (competência de folha, vencimento) são calculadas no fuso da empresa (política `company.timezone`),
 * nunca no fuso do servidor.
 */

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const DAY_MS = 86_400_000;
export const COMPETENCE_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** Ano/mês/dia de um instante no fuso dado. */
export function localDateParts(date: Date, tz: string): { y: number; m: number; d: number } {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date)
    .split('-')
    .map(Number);
  return { y, m, d };
}

/** Competência (YYYY-MM) de um instante no fuso da empresa. */
export function competenceOf(date: Date, tz: string): string {
  const { y, m } = localDateParts(date, tz);
  return `${y}-${pad(m)}`;
}

export function addCompetence(competence: string, months: number): string {
  const [y, m] = competence.split('-').map(Number);
  const idx = y * 12 + (m - 1) + months;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

/** Diferença (ms) entre o relógio local do fuso e o UTC naquele instante. */
function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instante do fim (23:59:59) do dia local y-m-d no fuso dado. */
export function endOfLocalDay(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, 23, 59, 59, 0);
  return new Date(guess - tzOffsetMs(new Date(guess), tz));
}

/** Início (00:00) do mês local da data, no fuso dado. */
export function startOfLocalMonth(date: Date, tz: string): Date {
  const { y, m } = localDateParts(date, tz);
  const guess = Date.UTC(y, m - 1, 1, 0, 0, 0, 0);
  return new Date(guess - tzOffsetMs(new Date(guess), tz));
}

/** Vencimento = data local + prazo (dias corridos), no fim do dia local. */
export function dueDateAfterDays(from: Date, days: number, tz: string): Date {
  const { y, m, d } = localDateParts(from, tz);
  const target = new Date(Date.UTC(y, m - 1, d + days));
  return endOfLocalDay(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), tz);
}

/** Dias inteiros de atraso (0 quando ainda não venceu). */
export function daysOverdue(dueDate: Date, now: Date = new Date()): number {
  const diff = now.getTime() - new Date(dueDate).getTime();
  return diff > 0 ? Math.floor(diff / DAY_MS) : 0;
}

/**
 * Divisão em parcelas: UMA só regra para venda, convênio e PDV, em centavos inteiros (`@ln-system/shared/utils/installments`).
 * Os centavos que sobram vão 1 a 1 para as ÚLTIMAS parcelas (R$ 100,00 em 3x = 33,33 + 33,33 + 33,34). Antes: ponto flutuante e o
 * resto nas primeiras parcelas (33,34 + 33,33 + 33,33), fora do combinado.
 */
export { splitInstallments } from '@ln-system/shared/utils/installments';

export const onlyDigits = (v: string) => (v ?? '').replace(/\D/g, '');

export function maskCpf(cpf: string): string {
  const c = onlyDigits(cpf);
  if (c.length !== 11) return '***';
  return `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**`;
}

export function formatCpf(cpf: string): string {
  const c = onlyDigits(cpf);
  if (c.length !== 11) return cpf;
  return `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;
}

export function maskCnpj(cnpj: string): string {
  const c = onlyDigits(cnpj);
  if (c.length !== 14) return '***';
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.***/${c.slice(8, 12)}-**`;
}

export function formatCnpj(cnpj: string): string {
  const c = onlyDigits(cnpj);
  if (c.length !== 14) return cnpj;
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
}

/** Destinatário para log de sistema (nunca o valor inteiro). */
export function maskRecipient(value: string | null | undefined): string {
  if (!value) return '(vazio)';
  if (value.includes('@')) {
    const [user, domain] = value.split('@');
    return `${user.slice(0, 2)}***@${domain}`;
  }
  const d = onlyDigits(value);
  return d.length > 4 ? `***${d.slice(-4)}` : '***';
}

export function brl(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

export function formatLocalDate(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);
}

/** Estouro de limite de convênio: 409 com o disponível no corpo (o PDV mostra ao operador). */
export class AgreementLimitError extends ConflictError {
  public details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown>) {
    super(message, 'AGREEMENT_LIMIT_EXCEEDED');
    this.details = details;
    Object.setPrototypeOf(this, AgreementLimitError.prototype);
  }
  toJSON(): any {
    return { ...super.toJSON(), details: this.details };
  }
}

export const badRequest = (message: string, code: string) => new AppError(message, 400, code);
export const notFound = (message: string, code: string) => new AppError(message, 404, code);

export const MANAGEMENT_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'] as const;
export const SELLING_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR'] as const;
/** Quem AUTORIZA convênio (cadastrar, mudar limite/filiais/situação, desbloquear): a administração (regra do dono, 2026-09-28). */
export const ADMIN_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN'] as const;

export const NOT_ENABLED_FOR_BRANCH_MESSAGE = 'Convênio não habilitado para esta filial. Entre em contato com o administrador.';
export const DISABLED_MESSAGE = {
  employee: 'Convênio de funcionário não habilitado para esta filial. Entre em contato com o administrador.',
  company: 'Convênio com empresa não habilitado para esta filial. Entre em contato com o administrador.',
};

/** Lista vazia = todas as filiais da empresa. Usuário sem filial (administração) enxerga como disponível. */
export function availableAtBranch(allowedBranchIds: string[] | null | undefined, branchId: string | null | undefined) {
  if (!allowedBranchIds || allowedBranchIds.length === 0) return true;
  return branchId == null ? true : allowedBranchIds.includes(branchId);
}

export const allowedBranchIdsSchema = z.array(z.string().uuid('Filial inválida')).max(200).transform((ids) => [...new Set(ids)]);

/** Filiais informadas precisam ser da empresa do token (nunca confiar no id vindo do corpo). */
export async function assertBranchesOfCompany(companyId: string, ids: string[] | undefined | null) {
  if (!ids || ids.length === 0) return;
  const found = await prisma.branch.count({ where: { companyId, id: { in: ids } } });
  if (found !== ids.length) throw badRequest('Uma das filiais informadas não pertence a esta empresa. Confira a lista de filiais.', 'BRANCH_NOT_FOUND');
}
