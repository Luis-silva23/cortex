import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { bypass } from './helpers/tenant-world';

/**
 * INVARIANTES ESTRUTURAIS DO BANCO (catálogo do Postgres real). Cada item abaixo foi um achado da revisão do banco e vira regressão permanente:
 * quem criar tabela/índice/FK fora do padrão quebra este teste em vez de o problema voltar sem aviso.
 */
const q = <T = any>(sql: string) => bypass<T[]>(() => db.$queryRawUnsafe(sql));

// FKs que NÃO podem apagar histórico em cascata (venda, pagamento, estoque, caixa, OS, orçamento, auditoria, LGPD, licença)
const HISTORY_TABLES = [
  'audit_logs',
  'branches',
  'users',
  'licenses',
  'privacy_requests',
  'cash_movements',
  'payments',
  'sale_items',
  'stock_movements',
  'purchase_order_items',
  'quote_events',
  'quote_items',
  'quote_versions',
  'service_order_items',
  'service_order_status_history',
  'transfer_items',
  'vehicle_entry_checklist_items',
  'vehicle_entry_checklists',
  'appointment_events',
  'follow_up_events',
  'inventory_counts',
];

describe('invariantes estruturais do banco (integração real)', () => {
  it('nenhum índice duplicado (mesmas colunas/classe/predicado) em nenhuma tabela', async () => {
    const rows = await q<{ t: string; idx: string[] }>(
      `SELECT indrelid::regclass::text AS t, array_agg(indexrelid::regclass::text ORDER BY indexrelid::regclass::text) AS idx
         FROM pg_index WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
        GROUP BY indrelid, indkey::text, indclass::text, coalesce(indpred::text, ''), coalesce(indexprs::text, '') HAVING count(*) > 1`
    );
    expect(rows).toEqual([]);
  });

  it('toda tabela com companyId tem índice que COMEÇA por companyId (a RLS filtra por ele em toda consulta)', async () => {
    const rows = await q<{ t: string }>(
      `SELECT c.relname AS t FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attname = 'companyId' AND NOT a.attisdropped
          AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisvalid AND (i.indkey::int2[])[0] = a.attnum)
        ORDER BY 1`
    );
    expect(rows.map((r) => r.t)).toEqual([]);
  });

  it('todo companyId NOT NULL de tabela de negócio referencia companies (só logs/telemetria/idempotência ficam de fora, por retenção)', async () => {
    const rows = await q<{ t: string }>(
      `SELECT c.relname AS t FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attname = 'companyId' AND a.attnotnull AND NOT a.attisdropped
          AND c.relname <> 'companies'
          AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.contype = 'f' AND k.conrelid = c.oid AND k.confrelid = 'companies'::regclass AND k.conkey = ARRAY[a.attnum])
        ORDER BY 1`
    );
    // exceções documentadas (docs/CORTEX/REVISAO_BANCO_PENDENCIAS.md): tabelas de retenção, sem dado de negócio a preservar
    const allowed = new Set(['request_logs', 'system_logs', 'idempotency_keys', 'device_telemetry', 'health_incidents']);
    expect(rows.map((r) => r.t).filter((t) => !allowed.has(t))).toEqual([]);
  });

  it('nenhuma FK com ON DELETE CASCADE sobre histórico (venda, pagamento, estoque, caixa, OS, orçamento, auditoria, LGPD, licença)', async () => {
    const list = HISTORY_TABLES.map((t) => `'${t}'`).join(',');
    const rows = await q<{ t: string; c: string }>(
      `SELECT conrelid::regclass::text AS t, conname AS c FROM pg_constraint WHERE contype = 'f' AND confdeltype = 'c' AND conrelid::regclass::text IN (${list})`
    );
    expect(rows).toEqual([]);
  });

  it('o fuso do banco é UTC (defaults CURRENT_TIMESTAMP não divergem do que a aplicação grava)', async () => {
    const rows = await q<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`);
    expect(rows[0].tz).toBe('UTC');
  });

  it('FKs validadas: a única NOT VALID permitida é a do recebível órfão legado (empresa inexistente, preservada sem associação por suposição)', async () => {
    const rows = await q<{ t: string }>(`SELECT DISTINCT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' AND NOT convalidated`);
    expect(rows.map((r) => r.t).filter((t) => t !== 'accounts_receivable')).toEqual([]);
  });

  it('totais documentados (BANCO_DE_DADOS / REVISAO_BANCO_PENDENCIAS): FKs compostas, FKs de empresa, CASCADE restantes e triggers de mesma empresa', async () => {
    const r = (
      await q<Record<string, number>>(
        `SELECT
          (SELECT count(*)::int FROM pg_constraint WHERE contype = 'f' AND cardinality(conkey) = 2 AND confrelid <> 'branches'::regclass
             AND (SELECT attname FROM pg_attribute WHERE attrelid = conrelid AND attnum = conkey[1]) = 'companyId') AS composite_rel,
          (SELECT count(*)::int FROM pg_constraint WHERE contype = 'f' AND cardinality(conkey) = 2 AND confrelid = 'branches'::regclass) AS composite_branch,
          (SELECT count(*)::int FROM pg_constraint k WHERE contype = 'f' AND confrelid = 'companies'::regclass AND cardinality(conkey) = 1
             AND (SELECT attname FROM pg_attribute WHERE attrelid = conrelid AND attnum = conkey[1]) = 'companyId') AS company_fk,
          (SELECT count(*)::int FROM pg_constraint WHERE contype = 'f' AND confdeltype = 'c') AS cascades,
          (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%same_company') AS same_company_triggers`
      )
    )[0];
    expect(r.composite_rel).toBeGreaterThanOrEqual(95);
    expect(r.composite_branch).toBeGreaterThanOrEqual(57);
    expect(r.company_fk).toBeGreaterThanOrEqual(77);
    // 22 de derivadas/configuração + 2 do vínculo de filial do usuário (user_branches: configuração, não histórico — decisão 153)
    expect(r.cascades).toBeLessThanOrEqual(24);
    expect(r.same_company_triggers).toBe(3);
  });

  it('o papel da aplicação não é superusuário nem tem BYPASSRLS (a RLS vale para ele)', async () => {
    const rows = await q<{ rolsuper: boolean; rolbypassrls: boolean }>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
