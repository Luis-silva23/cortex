/**
 * LEGADO: equipamento aprovado pelo fluxo antigo (`/activations/:id/approve`) NÃO tem chave — a identidade dele é só o id/MAC, que
 * não é segredo (qualquer um que conheça o MAC de um equipamento ativo e tenha a senha de um usuário da empresa "é" esse equipamento).
 * Mantido só como compatibilidade de TRANSIÇÃO, com duas travas (docs/CORTEX/DISPOSITIVOS.md §8, decisão 110):
 *  1. CONJUNTO FECHADO: só vale para equipamento criado ANTES de `LEGACY_SET_CLOSED_AT` (a entrega do enrolamento com chave). O fluxo
 *     antigo continua podendo criar linhas, mas elas NÃO entram no login sem chave: o legado não cresce.
 *  2. DATA DE CORTE: depois de `DEVICE_LEGACY_CUTOFF` (padrão 31/12/2026, horário de Brasília) o legado deixa de valer de vez e o
 *     equipamento precisa ser registrado de novo (enrolamento + autorização). Ajustável por variável de ambiente (um dono pode
 *     antecipar); nunca "para sempre".
 * Cada login legado aceito é registrado como evento de segurança (`DEVICE_LEGACY_LOGIN`) para dar para medir quantos faltam migrar.
 */
export const LEGACY_SET_CLOSED_AT = new Date('2026-10-07T00:00:00.000Z');
export const DEFAULT_LEGACY_CUTOFF = new Date('2027-01-01T02:59:59.000Z'); // 2026-12-31 23:59:59 em Brasília (UTC-3)

export function legacyCutoff(env: NodeJS.ProcessEnv = process.env): Date {
  const raw = env.DEVICE_LEGACY_CUTOFF;
  if (!raw || !raw.trim()) return DEFAULT_LEGACY_CUTOFF;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? DEFAULT_LEGACY_CUTOFF : parsed;
}

export type LegacyVerdict = 'ALLOWED' | 'CLOSED_SET' | 'CUTOFF';

/** Pode um equipamento SEM chave entrar? `CLOSED_SET` = criado depois do fechamento do conjunto; `CUTOFF` = passou da data de corte. */
export function legacyLoginVerdict(input: { createdAt: Date; now?: Date; env?: NodeJS.ProcessEnv }): LegacyVerdict {
  const now = input.now ?? new Date();
  if (input.createdAt.getTime() >= LEGACY_SET_CLOSED_AT.getTime()) return 'CLOSED_SET';
  if (now.getTime() > legacyCutoff(input.env).getTime()) return 'CUTOFF';
  return 'ALLOWED';
}
