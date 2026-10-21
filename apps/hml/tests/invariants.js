// Invariantes de integridade do banco HML (seção 13 do brief). Leitura direta no Postgres — resposta HTTP 200 não prova
// nada. Cada consulta devolve as LINHAS EM VIOLAÇÃO; esperado: zero. Rode depois de cada suíte.
// O histórico (audit_logs, stock_movements, eventos) só pode crescer: compara contagens com a linha de base anterior.
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const { suite } = require('../lib/harness');

const S = suite('invariants');
const { check } = S;
const BASELINE = path.join(__dirname, '..', '.hml', 'results', 'invariants-baseline.json');

const none = (id, sql) => {
  let rows;
  try { rows = db.run(sql); } catch (e) { return check(id, false, `consulta falhou: ${e.message}`); }
  return check(id, rows.length === 0, `${rows.length} violação(ões) ${JSON.stringify(rows.slice(0, 3))}`);
};

// Saldo por (produto, filial) com a mesma regra do livro de estoque (services/stock-ledger.ts): o último INVENTORY
// fixa o saldo; depois dele, entradas somam |q|, saídas subtraem |q| e ajuste soma q com sinal.
const BALANCES = `
  WITH m AS (SELECT "productId" p, "branchId" b, id, "movementType"::text t, quantity q, "createdAt" ts FROM stock_movements),
  li AS (SELECT DISTINCT ON (p, b) p, b, ts its, id iid, abs(q) iq FROM m WHERE t = 'INVENTORY' ORDER BY p, b, ts DESC, id DESC),
  bal AS (
    SELECT m.p, m.b, coalesce(max(li.iq), 0) + coalesce(sum(CASE
        WHEN m.t IN ('PURCHASE','RETURN','TRANSFER_IN','PRODUCTION') THEN abs(m.q)
        WHEN m.t IN ('SALE','TRANSFER_OUT','LOSS','SUPPLIER_RETURN') THEN -abs(m.q)
        WHEN m.t = 'ADJUSTMENT' THEN m.q ELSE 0 END) FILTER (WHERE li.p IS NULL OR (m.ts, m.id) > (li.its, li.iid)), 0) AS balance
    FROM m LEFT JOIN li ON li.p = m.p AND li.b IS NOT DISTINCT FROM m.b GROUP BY m.p, m.b)
`;
const CASH_SIGNED = `CASE WHEN cm."movementType" IN ('OPENING','SALE','DEPOSIT') THEN cm.amount
                         WHEN cm."movementType" IN ('WITHDRAWAL','CANCELLATION','RETURN') THEN -cm.amount ELSE 0 END`;

(async () => {
  // ---- 1. Pagamento duplicado ----
  none('1/pagamento: soma dos aprovados por venda não passa do total da venda',
    `SELECT s.id, s."totalAmount", sum(p.amount) FROM sales s JOIN payments p ON p."saleId" = s.id AND p.status = 'APPROVED'
     GROUP BY s.id HAVING sum(p.amount) > s."totalAmount" + 0.005`);
  none('1/pagamento: transactionId do provedor não se repete na empresa',
    `SELECT "companyId", provider, "transactionId", count(*) FROM payments WHERE "transactionId" IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1`);
  none('1/pagamento: TEF — uma transação do provedor vira um único registro por empresa',
    `SELECT "companyId", provider, "transactionId", count(*) FROM tef_payments GROUP BY 1,2,3 HAVING count(*) > 1`);
  none('1/pagamento: TEF aprovado aponta para pagamento da mesma venda e valor',
    `SELECT t.id FROM tef_payments t JOIN payments p ON p.id = t."paymentId"
     WHERE t.status = 'APPROVED' AND (p."saleId" IS DISTINCT FROM t."saleId" OR abs(p.amount - t.amount) > 0.005 OR p."companyId" <> t."companyId")`);
  none('1/pagamento: a mesma chave de idempotência não existe duas vezes para o mesmo usuário/rota',
    `SELECT "companyId", "userId", endpoint, key, count(*) FROM idempotency_keys GROUP BY 1,2,3,4 HAVING count(*) > 1`);

  // ---- 2. Estoque impossível ----
  none('2/estoque: nenhum saldo negativo em produto que não permite negativo',
    `${BALANCES} SELECT bal.p, bal.b, bal.balance FROM bal JOIN products pr ON pr.id = bal.p WHERE pr."allowNegativeStock" = false AND bal.balance < 0`);

  // ---- 3. Transferência parcial ----
  none('3/transferência direta: todo TRANSFER_OUT sem referência tem exatamente um TRANSFER_IN',
    `SELECT o.id FROM stock_movements o WHERE o."movementType" = 'TRANSFER_OUT' AND o."referenceType" IS NULL
     AND (SELECT count(*) FROM stock_movements i WHERE i."movementType" = 'TRANSFER_IN' AND i."referenceType" = 'StockTransfer' AND i."referenceId" = o.id) <> 1`);
  none('3/transferência direta: o TRANSFER_IN espelha o OUT (produto, quantidade, empresa; filial diferente)',
    `SELECT i.id FROM stock_movements i JOIN stock_movements o ON o.id = i."referenceId"
     WHERE i."movementType" = 'TRANSFER_IN' AND i."referenceType" = 'StockTransfer'
     AND (o."productId" <> i."productId" OR abs(o.quantity) <> abs(i.quantity) OR o."companyId" <> i."companyId" OR o."branchId" IS NOT DISTINCT FROM i."branchId")`);
  none('3/transferência direta: TRANSFER_IN sempre aponta para um OUT existente',
    `SELECT i.id FROM stock_movements i WHERE i."movementType" = 'TRANSFER_IN' AND i."referenceType" = 'StockTransfer'
     AND NOT EXISTS (SELECT 1 FROM stock_movements o WHERE o.id = i."referenceId" AND o."movementType" = 'TRANSFER_OUT')`);
  none('3/transferência por solicitação: PENDENTE não moveu estoque; só RECEBIDA tem entrada, igual à saída por produto',
    `SELECT t.id, t.status FROM transfers t WHERE
       (t.status IN ('PENDING') AND EXISTS (SELECT 1 FROM stock_movements WHERE "referenceType" = 'Transfer' AND "referenceId" = t.id))
       OR (t.status <> 'RECEIVED' AND EXISTS (SELECT 1 FROM stock_movements WHERE "referenceType" = 'Transfer' AND "referenceId" = t.id AND "movementType" = 'TRANSFER_IN'))
       OR (t.status = 'RECEIVED' AND EXISTS (SELECT 1 FROM transfer_items ti WHERE ti."transferId" = t.id AND
          (SELECT coalesce(sum(abs(quantity)),0) FROM stock_movements WHERE "referenceType" = 'Transfer' AND "referenceId" = t.id AND "productId" = ti."productId" AND "movementType" = 'TRANSFER_OUT')
          <> (SELECT coalesce(sum(abs(quantity)),0) FROM stock_movements WHERE "referenceType" = 'Transfer' AND "referenceId" = t.id AND "productId" = ti."productId" AND "movementType" = 'TRANSFER_IN')))`);

  // ---- 4. Caixa inconsistente ----
  none('4/caixa fechado: expectedAmount = abertura + vendas + reforços − sangrias − estornos − devoluções',
    `SELECT cr.id, cr."expectedAmount", sum(${CASH_SIGNED}) calc FROM cash_registers cr JOIN cash_movements cm ON cm."cashRegisterId" = cr.id
     WHERE cr.status = 'CLOSED' GROUP BY cr.id HAVING abs(cr."expectedAmount" - sum(${CASH_SIGNED})) > 0.005`);
  none('4/caixa fechado: diferença = informado − esperado, com data de fechamento e quem fechou',
    `SELECT id FROM cash_registers WHERE status = 'CLOSED' AND ("closedAt" IS NULL OR "closedBy" IS NULL OR "actualAmount" IS NULL
      OR abs(difference - ("actualAmount" - "expectedAmount")) > 0.005)`);
  none('4/caixa aberto: sem data de fechamento', `SELECT id FROM cash_registers WHERE status = 'OPEN' AND "closedAt" IS NOT NULL`);
  none('4/caixa: no máximo um caixa aberto por filial e número de caixa',
    `SELECT "companyId", "branchId", "registerNumber", count(*) FROM cash_registers WHERE status = 'OPEN' GROUP BY 1,2,3 HAVING count(*) > 1`);
  none('4/caixa: venda no caixa da própria empresa e filial',
    `SELECT s.id FROM sales s JOIN cash_registers cr ON cr.id = s."cashRegisterId" WHERE cr."companyId" <> s."companyId" OR cr."branchId" IS DISTINCT FROM s."branchId"`);

  // ---- 5/10. Autorização e permissão ----
  none('10/permissão: toda atribuição de perfil a usuário tem auditoria do usuário (UPDATE/PERMISSION_CHANGED)',
    `SELECT ur.id FROM user_roles ur WHERE NOT EXISTS
     (SELECT 1 FROM audit_logs a WHERE a.entity = 'User' AND a."entityId" = ur."userId" AND a.action IN ('UPDATE','PERMISSION_CHANGED'))`);
  none('10/permissão: todo usuário criado tem auditoria de criação',
    `SELECT u.id FROM users u WHERE u."userType" <> 'SUPER_ADMIN' AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity = 'User' AND a."entityId" = u.id AND a.action = 'CREATE')`);
  none('5/autorização: desconto autorizado por usuário da mesma empresa',
    `SELECT de.id FROM discount_events de JOIN users u ON u.id = de."authorizedBy" WHERE u."companyId" IS DISTINCT FROM de."companyId" AND u."userType" <> 'SUPER_ADMIN'`);
  none('5/autorização: autorizador de movimento de caixa pertence à empresa do caixa',
    `SELECT cm.id FROM cash_movements cm JOIN cash_registers cr ON cr.id = cm."cashRegisterId" JOIN users u ON u.id = cm."authorizedBy"
     WHERE u."companyId" IS DISTINCT FROM cr."companyId" AND u."userType" <> 'SUPER_ADMIN'`);

  // ---- 6/7. Empresa e filial ----
  const same = (id, child, parent, fk) => none(id,
    `SELECT c.id FROM ${child} c JOIN ${parent} p ON p.id = c."${fk}" WHERE c."companyId" IS DISTINCT FROM p."companyId"`);
  same('6/empresa: venda × cliente', 'sales', 'customers', 'customerId');
  same('6/empresa: pagamento × venda', 'payments', 'sales', 'saleId');
  same('6/empresa: movimento de estoque × produto', 'stock_movements', 'products', 'productId');
  same('6/empresa: OS × cliente', 'service_orders', 'customers', 'customerId');
  same('6/empresa: OS × moto', 'service_orders', 'motorcycles', 'motorcycleId');
  same('6/empresa: conta a receber × cliente', 'accounts_receivable', 'customers', 'customerId');
  same('6/empresa: pedido de compra × fornecedor', 'purchase_orders', 'suppliers', 'supplierId');
  same('6/empresa: usuário × filial', 'users', 'branches', 'branchId');
  none('6/empresa: usuário comum só recebe perfil da própria empresa',
    `SELECT ur.id FROM user_roles ur JOIN users u ON u.id = ur."userId" JOIN roles r ON r.id = ur."roleId"
     WHERE u."userType" <> 'SUPER_ADMIN' AND r."companyId" IS NOT NULL AND r."companyId" IS DISTINCT FROM u."companyId"`);
  none('6/empresa: perfil de filial só aponta para filial da empresa do usuário',
    `SELECT ur.id FROM user_roles ur JOIN users u ON u.id = ur."userId" JOIN branches b ON b.id = ur."branchId" WHERE b."companyId" IS DISTINCT FROM u."companyId"`);
  none('6/empresa: perfil só carrega permissão global (sem empresa) ou da mesma empresa',
    `SELECT rp.id FROM role_permissions rp JOIN roles r ON r.id = rp."roleId" JOIN permissions p ON p.id = rp."permissionId"
     WHERE p."companyId" IS NOT NULL AND p."companyId" IS DISTINCT FROM r."companyId"`);
  none('7/filial: estoque, venda e caixa em filial da própria empresa',
    `SELECT sm.id FROM stock_movements sm JOIN branches b ON b.id = sm."branchId" WHERE b."companyId" <> sm."companyId"
     UNION ALL SELECT s.id FROM sales s JOIN branches b ON b.id = s."branchId" WHERE b."companyId" <> s."companyId"
     UNION ALL SELECT cr.id FROM cash_registers cr JOIN branches b ON b.id = cr."branchId" WHERE b."companyId" <> cr."companyId"
     UNION ALL SELECT t.id FROM transfers t JOIN branches b ON b.id IN (t."fromBranchId", t."toBranchId") WHERE b."companyId" <> t."companyId"`);
  none('7/filial: caixa/gerente preso a uma filial só vende na própria filial',
    `SELECT s.id FROM sales s JOIN users u ON u.id = s."userId" WHERE u."branchId" IS NOT NULL AND u."userType" IN ('OPERATOR','MANAGER') AND s."branchId" IS DISTINCT FROM u."branchId"`);

  // ---- 8. Órfãos críticos ----
  none('8/órfãos: item de venda sem venda ou produto; pagamento sem venda; caixa sem usuário',
    `SELECT si.id FROM sale_items si WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = si."saleId") OR NOT EXISTS (SELECT 1 FROM products p WHERE p.id = si."productId")
     UNION ALL SELECT p.id FROM payments p WHERE p."saleId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.id = p."saleId")
     UNION ALL SELECT cr.id FROM cash_registers cr WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = cr."userId")
     UNION ALL SELECT cm.id FROM cash_movements cm WHERE NOT EXISTS (SELECT 1 FROM cash_registers cr WHERE cr.id = cm."cashRegisterId")`);
  none('8/órfãos: linhas operacionais sem empresa',
    `SELECT id FROM sales WHERE "companyId" IS NULL UNION ALL SELECT id FROM payments WHERE "companyId" IS NULL
     UNION ALL SELECT id FROM stock_movements WHERE "companyId" IS NULL UNION ALL SELECT id FROM customers WHERE "companyId" IS NULL`);

  // ---- 9. Histórico não apagado (contagens só crescem) ----
  const tables = ['audit_logs', 'stock_movements', 'discount_events', 'support_ticket_events', 'support_ticket_messages',
    'service_order_status_history', 'quote_events', 'appointment_events', 'policy_changes', 'payments', 'cash_movements'];
  const counts = {};
  for (const t of tables) counts[t] = Number(db.scalar(`SELECT count(*) FROM ${t}`));
  const prev = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
  if (prev) {
    for (const [t, n] of Object.entries(counts)) if (t in prev) check(`9/histórico: ${t} só cresce (${prev[t]} → ${n})`, n >= prev[t], `${prev[t]} → ${n}`);
  } else check('9/histórico: linha de base criada na primeira execução', true);
  if (!S.rows.some((r) => !r.ok)) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(counts, null, 2));
  }
  console.log('contagens:', JSON.stringify(counts));
  S.finish();
})().catch((e) => { console.error('ERRO NA SUÍTE:', e); process.exit(2); });
