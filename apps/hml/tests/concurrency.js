// Concorrência real contra a API HML: o que acontece quando duas pessoas (ou o mesmo clique duas vezes) tocam a mesma
// entidade ao mesmo tempo. A prova NÃO é o HTTP 200: cada cenário confere o banco (saldo, contagem de linhas, soma de
// pagamentos). Dados criados levam o rótulo [HML-STRESS] e ficam só na empresa Alfa; nada é apagado.
const crypto = require('crypto');
const { suite, sessions, idOf, api } = require('../lib/harness');
const { totp } = require('../lib/api');
const db = require('../lib/db');

let finalClose = null;
const S = suite('concurrency');
const { check } = S;
const par = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const count = (rs, pred) => rs.filter(pred).length;
const brief = (rs) => JSON.stringify(rs.map((r) => r.status));

const balance = (pid, branchId) => Number(db.scalar(`
  WITH m AS (SELECT id, "movementType"::text t, quantity q, "createdAt" ts FROM stock_movements WHERE "productId" = '${pid}' AND "branchId" = '${branchId}'),
  li AS (SELECT ts, id, abs(q) iq FROM m WHERE t = 'INVENTORY' ORDER BY ts DESC, id DESC LIMIT 1)
  SELECT coalesce((SELECT iq FROM li), 0) + coalesce(sum(CASE WHEN t IN ('PURCHASE','RETURN','TRANSFER_IN','PRODUCTION') THEN abs(q)
    WHEN t IN ('SALE','TRANSFER_OUT','LOSS','SUPPLIER_RETURN') THEN -abs(q) WHEN t = 'ADJUSTMENT' THEN q ELSE 0 END)
    FILTER (WHERE NOT EXISTS (SELECT 1 FROM li) OR ts > (SELECT ts FROM li) OR (ts = (SELECT ts FROM li) AND id > (SELECT id FROM li))), 0) FROM m`));
const q1 = (sql) => Number(db.scalar(sql));
const cashExpected = (id) => q1(`SELECT coalesce(sum(CASE WHEN "movementType" IN ('OPENING','SALE','DEPOSIT') THEN amount
  WHEN "movementType" IN ('WITHDRAWAL','CANCELLATION','RETURN') THEN -amount ELSE 0 END), 0) FROM cash_movements WHERE "cashRegisterId" = '${id}'`);

(async () => {
  const s = await sessions(['ceo.a', 'gerente.a1', 'caixa.a1', 'caixa.a1b']);
  const A = s.cred.companies.A;
  const B1 = A.branches[0].id;
  const B2 = A.branches[1].id;
  const run = `${Date.now()}`;
  const tok = (k) => ({ token: s[k].token });

  const mkProduct = async (label, price = 25) => {
    const r = await api.post('/api/products', { sku: `HMLC-${label}-${run}`, name: `[HML-STRESS] conc ${label} ${run}`, costPrice: 10, salePrice: price, unit: 'UN' }, tok('ceo.a'));
    if (r.status !== 201) throw new Error(`produto ${label}: ${r.status} ${r.text}`);
    return idOf(r);
  };
  const setStock = async (pid, branchId, qty) => {
    const r = await api.post('/api/stock/adjustment', { productId: pid, branchId, newQuantity: qty, reason: 'HML-STRESS conc' }, tok('ceo.a'));
    if (r.status !== 201 && !/same as current balance/.test(r.text || '')) throw new Error(`estoque: ${r.status} ${r.text}`);
  };
  const openReg = async (who, n, amount = 100) => {
    const r = await api.post('/api/cash-register/open', { branchId: B1, registerNumber: n, openingAmount: amount }, tok(who));
    if (r.status !== 201) throw new Error(`abrir caixa ${who}/${n}: ${r.status} ${r.text}`);
    return idOf(r);
  };
  const closeReg = (who, id, actual) => api.post(`/api/cash-register/${id}/close`, { actualAmount: actual }, tok(who));
  const sale = (who, cr, pid, qty = 1, extra = {}) => api.post('/api/sales', { branchId: B1, cashRegisterId: cr, items: [{ productId: pid, quantity: qty, unitPrice: 25 }], ...(extra.body || {}) }, { ...tok(who), ...(extra.opts || {}) });

  // Caixas 71-74 desta suíte que uma execução interrompida tenha deixado abertos (só os dela, só empresa Alfa).
  for (const [who, uid] of [['caixa.a1', s['caixa.a1'].user.id], ['caixa.a1b', s['caixa.a1b'].user.id]]) {
    for (const [id] of db.run(`SELECT id FROM cash_registers WHERE "companyId" = '${A.id}' AND "userId" = '${uid}' AND status = 'OPEN' AND "registerNumber" BETWEEN 71 AND 74`)) {
      let r = await closeReg(who, id, cashExpected(id));
      if (r.status === 409) {
        const g = s['gerente.a1'].def;
        r = await api.post(`/api/cash-register/${id}/force-close`, { actualAmount: cashExpected(id), reason: 'HML-STRESS limpeza de execução interrompida', authorizerNumericId: g.numericId, authorizerPassword: g.password, authorizerMfaCode: totp(g.mfaSecret) }, tok(who));
      }
      if (!ok2xx(r)) throw new Error(`não consegui fechar caixa residual ${id}: ${r.status} ${r.text}`);
    }
  }

  const P1 = await mkProduct('P1'); await setStock(P1, B1, 50);
  const R1 = await openReg('caixa.a1', 71);
  const R2 = await openReg('caixa.a1b', 72);

  // ---------- 1. Duplo clique: mesma Idempotency-Key ----------
  {
    const key = crypto.randomUUID();
    const notes = `dc-${run}`;
    const rs = await par(6, () => sale('caixa.a1', R1, P1, 1, { body: { notes }, opts: { headers: { 'Idempotency-Key': key } } }));
    const ids = new Set(rs.filter(ok2xx).map(idOf));
    check('1/duplo clique (6 requisições, mesma chave): uma única venda criada', q1(`SELECT count(*) FROM sales WHERE notes = '${notes}'`) === 1, brief(rs));
    check('1/duplo clique: todas as respostas bem-sucedidas apontam para a mesma venda', ids.size <= 1, `${ids.size} ids`);
    check('1/duplo clique: nenhuma resposta 5xx (a concorrente recebe 409/replay, não erro)', count(rs, (r) => r.status >= 500 || r.status === 0) === 0, brief(rs));
    const again = await sale('caixa.a1', R1, P1, 1, { body: { notes }, opts: { headers: { 'Idempotency-Key': key } } });
    check('1/reenvio depois de concluído devolve a mesma venda (replay)', ok2xx(again) && ids.has(idOf(again)), again.status);
    check('1/baixa de estoque só uma vez', balance(P1, B1) === 49, `saldo ${balance(P1, B1)}`);
  }

  // ---------- 2. Mesma chave, corpo diferente ----------
  {
    const key = crypto.randomUUID();
    const a = await sale('caixa.a1', R1, P1, 1, { body: { notes: `k2a-${run}` }, opts: { headers: { 'Idempotency-Key': key } } });
    const b = await sale('caixa.a1', R1, P1, 2, { body: { notes: `k2b-${run}` }, opts: { headers: { 'Idempotency-Key': key } } });
    check('2/mesma chave + corpo diferente: segunda recusada com 422 e sem venda nova', ok2xx(a) && b.status === 422 && q1(`SELECT count(*) FROM sales WHERE notes = 'k2b-${run}'`) === 0, `${a.status}/${b.status}`);
  }

  // ---------- 3. Chaves diferentes, mesmo corpo (dois cliques com renovação de chave) ----------
  {
    const notes = `k3-${run}`;
    const rs = await par(2, () => sale('caixa.a1', R1, P1, 1, { body: { notes } }));
    check('3/chaves diferentes = duas vendas distintas (a chave é o que identifica a operação)', count(rs, ok2xx) === 2 && q1(`SELECT count(*) FROM sales WHERE notes = '${notes}'`) === 2, brief(rs));
  }

  // ---------- 4. Última unidade: dois caixas disputam ----------
  {
    const P2 = await mkProduct('P2'); await setStock(P2, B1, 1);
    const rs = await Promise.all([sale('caixa.a1', R1, P2, 1), sale('caixa.a1b', R2, P2, 1)]);
    const sold = q1(`SELECT count(*) FROM sale_items si JOIN sales s ON s.id = si."saleId" WHERE si."productId" = '${P2}' AND s.status <> 'CANCELLED'`);
    check('4/última unidade, dois caixas: exatamente uma venda leva o produto', count(rs, ok2xx) === 1 && sold === 1, `${brief(rs)} vendidos=${sold}`);
    check('4/última unidade: saldo final 0 (nunca negativo)', balance(P2, B1) === 0, `saldo ${balance(P2, B1)}`);
    check('4/última unidade: a recusada explica o motivo (4xx, sem 5xx)', count(rs, (r) => r.status >= 400 && r.status < 500) === 1, brief(rs));
  }

  // ---------- 5. Duas tentativas de pagamento na mesma venda ----------
  {
    const sv = idOf(await sale('caixa.a1', R1, P1, 2)); // 50
    const rs = await par(2, () => api.post('/api/payments', { saleId: sv, paymentMethod: 'CASH', amount: 50 }, tok('caixa.a1')));
    const approved = q1(`SELECT count(*) FROM payments WHERE "saleId" = '${sv}' AND status = 'APPROVED'`);
    const sum = q1(`SELECT coalesce(sum(amount),0) FROM payments WHERE "saleId" = '${sv}' AND status = 'APPROVED'`);
    check('5/dois pagamentos totais simultâneos (chaves diferentes): soma aprovada nunca passa do total', sum <= 50, `${brief(rs)} aprovados=${approved} soma=${sum}`);
    check('5/dois pagamentos totais: exatamente um aprovado', approved === 1, `${brief(rs)} aprovados=${approved}`);

    const sv2 = idOf(await sale('caixa.a1', R1, P1, 2));
    const key = crypto.randomUUID();
    const rs2 = await par(5, () => api.post('/api/payments', { saleId: sv2, paymentMethod: 'CASH', amount: 50 }, { ...tok('caixa.a1'), headers: { 'Idempotency-Key': key } }));
    check('5/duplo clique em pagar (mesma chave): um único pagamento', q1(`SELECT count(*) FROM payments WHERE "saleId" = '${sv2}'`) === 1, brief(rs2));

    const sv3 = idOf(await sale('caixa.a1', R1, P1, 2));
    const rs3 = await par(2, () => api.post('/api/payments', { saleId: sv3, paymentMethod: 'CASH', amount: 30 }, tok('caixa.a1')));
    const sum3 = q1(`SELECT coalesce(sum(amount),0) FROM payments WHERE "saleId" = '${sv3}' AND status = 'APPROVED'`);
    check('5/dois pagamentos parciais que somam mais que o total (30+30 de 50): nunca excede', sum3 <= 50, `${brief(rs3)} soma=${sum3}`);
  }

  // ---------- 6. Duas alterações de estoque simultâneas (lost update) ----------
  {
    const P3 = await mkProduct('P3'); await setStock(P3, B1, 0);
    const rs = await par(8, () => api.post('/api/stock/movement', { productId: P3, branchId: B1, movementType: 'PURCHASE', quantity: 5, notes: 'HML-STRESS conc' }, tok('gerente.a1')));
    check('6/8 entradas de +5 simultâneas: saldo exato 40 (sem lost update)', balance(P3, B1) === 40 && count(rs, ok2xx) === 8, `${brief(rs)} saldo=${balance(P3, B1)}`);
    const out = await par(6, () => sale(['caixa.a1', 'caixa.a1b'][Math.floor(Math.random() * 2)], R1, P3, 10));
    const okc = count(out, ok2xx);
    check('6/6 vendas de 10 sobre saldo 40: no máximo 4 passam e o saldo nunca fica negativo', okc <= 4 && balance(P3, B1) >= 0 && balance(P3, B1) === 40 - okc * 10, `${brief(out)} saldo=${balance(P3, B1)}`);
  }

  // ---------- 7. Duas transferências simultâneas do mesmo saldo ----------
  {
    const P4 = await mkProduct('P4'); await setStock(P4, B2, 3); await setStock(P4, B1, 0);
    const rs = await par(2, () => api.post('/api/stock/transfer', { productId: P4, fromBranchId: B2, toBranchId: B1, quantity: 3 }, tok('ceo.a')));
    const b2 = balance(P4, B2); const b1 = balance(P4, B1);
    check('7/duas transferências de 3 sobre saldo 3: uma passa, a outra é recusada', count(rs, ok2xx) === 1, brief(rs));
    check('7/transferência atômica: origem 0 + destino 3, nada se perde nem duplica', b2 === 0 && b1 === 3, `origem=${b2} destino=${b1}`);
  }

  // ---------- 8. Dois recebimentos do mesmo título ----------
  {
    const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const rec = await api.post('/api/financial/receivables', { description: `[HML-STRESS] titulo ${run}`, amount: 80, dueDate: due }, tok('ceo.a'));
    check('8/título a receber criado (CEO tem finance:manage)', rec.status === 201, `${rec.status} ${rec.text?.slice(0, 120)}`);
    const rid = idOf(rec);
    const rs = await par(4, () => api.post(`/api/financial/receivables/${rid}/receive`, {}, tok('ceo.a')));
    const paid = q1(`SELECT count(*) FROM accounts_receivable WHERE id = '${rid}' AND status = 'PAID'`);
    check('8/4 recebimentos simultâneos do mesmo título: um sucesso, título PAID uma vez', count(rs, ok2xx) === 1 && paid === 1, `${brief(rs)} paid=${paid}`);
    check('8/recebimento gerou auditoria (uma linha por sucesso)', q1(`SELECT count(*) FROM audit_logs WHERE entity = 'AccountsReceivable' AND "entityId" = '${rid}' AND action = 'UPDATE'`) >= 1, '');
  }

  // ---------- 9. Dois fechamentos do mesmo caixa ----------
  // Regra real: um operador só tem um caixa aberto por filial — encerra o ciclo anterior (forçado, há venda aberta).
  {
    let r = await closeReg('caixa.a1b', R2, cashExpected(R2));
    if (r.status === 409) {
      const g = s['gerente.a1'].def;
      r = await api.post(`/api/cash-register/${R2}/force-close`, { actualAmount: cashExpected(R2), reason: 'HML-STRESS encerra ciclo para testar fechamento concorrente', authorizerNumericId: g.numericId, authorizerPassword: g.password, authorizerMfaCode: totp(g.mfaSecret) }, tok('caixa.a1b'));
    }
    check('9/pré-condição: caixa anterior do operador encerrado (forçado quando há venda aberta; regra: 1 caixa aberto por operador/filial)', ok2xx(r), `${r.status}`);
  }
  {
    const R9 = await openReg('caixa.a1b', 73, 50);
    const rs = await par(2, () => closeReg('caixa.a1b', R9, 50));
    check('9/dois fechamentos simultâneos: um sucesso', count(rs, ok2xx) === 1, brief(rs));
    check('9/caixa fechado uma só vez (no máximo 1 movimento de fechamento)', q1(`SELECT count(*) FROM cash_movements WHERE "cashRegisterId" = '${R9}' AND "movementType" = 'CLOSING'`) <= 1, '');
    const again = await closeReg('caixa.a1b', R9, 50);
    check('9/fechar caixa já fechado é recusado', again.status >= 400 && again.status < 500, again.status);
  }

  // ---------- 10. Duas aberturas do mesmo número de caixa ----------
  {
    const rs = await par(2, () => api.post('/api/cash-register/open', { branchId: B1, registerNumber: 74, openingAmount: 10 }, tok('caixa.a1b')));
    const opened = q1(`SELECT count(*) FROM cash_registers WHERE "branchId" = '${B1}' AND "registerNumber" = 74 AND status = 'OPEN'`);
    check('10/duas aberturas simultâneas do mesmo caixa: uma só aberta', count(rs, ok2xx) === 1 && opened === 1, `${brief(rs)} abertos=${opened}`);
    for (const id of rs.filter(ok2xx).map(idOf)) await closeReg('caixa.a1b', id, 10);
  }

  // ---------- 11. Dois cancelamentos simultâneos da mesma venda (com autorizador real, MFA) ----------
  {
    const P5 = await mkProduct('P5'); await setStock(P5, B1, 10);
    const sv = idOf(await sale('caixa.a1', R1, P5, 2));
    await api.post('/api/payments', { saleId: sv, paymentMethod: 'CASH', amount: 50 }, tok('caixa.a1'));
    const ceo = s['ceo.a'].def;
    const authz = () => ({ reason: 'HML-STRESS cancelamento concorrente', authorizerNumericId: ceo.numericId, authorizerPassword: ceo.password, authorizerMfaCode: totp(ceo.mfaSecret) });
    const rs = await par(2, () => api.post(`/api/sales/${sv}/cancel`, authz(), tok('caixa.a1')));
    check('11/dois cancelamentos simultâneos: no máximo um efetivo', count(rs, ok2xx) <= 1, brief(rs));
    check('11/estoque devolvido uma única vez (10)', balance(P5, B1) === 10, `saldo ${balance(P5, B1)}`);
    check('11/venda cancelada e pagamento estornado uma vez', q1(`SELECT count(*) FROM sales WHERE id = '${sv}' AND status = 'CANCELLED'`) === 1 && q1(`SELECT count(*) FROM cash_movements WHERE "referenceId" = '${sv}' AND "movementType" = 'CANCELLATION'`) <= 1, '');
    check('11/cancelamento autorizado por outro usuário deixou auditoria', q1(`SELECT count(*) FROM audit_logs WHERE entity = 'Sale' AND "entityId" = '${sv}' AND action = 'UPDATE'`) >= 1, '');
  }

  // ---------- 12. Mesmo cliente editado por dois usuários ao mesmo tempo ----------
  {
    const c = await api.post('/api/customers', { name: `[HML-STRESS] cliente ${run}` }, tok('caixa.a1'));
    const cid = idOf(c);
    const rs = await Promise.all([
      api.put(`/api/customers/${cid}`, { name: `[HML-STRESS] A ${run}` }, tok('ceo.a')),
      api.put(`/api/customers/${cid}`, { name: `[HML-STRESS] B ${run}` }, tok('gerente.a1')),
    ]);
    const final = db.scalar(`SELECT name FROM customers WHERE id = '${cid}'`);
    check('12/dois usuários editam o mesmo cliente: sem erro e o resultado é inteiro de um deles', count(rs, (r) => r.status >= 500) === 0 && [`[HML-STRESS] A ${run}`, `[HML-STRESS] B ${run}`].includes(final), `${brief(rs)} final=${final}`);
  }

  // Fecha só os caixas que esta suíte abriu, contando exatamente o esperado pelos movimentos.
  // Vendas abertas bloqueiam o fechamento normal (409 CASH_CLOSE_PENDING): o caminho real é o fechamento forçado por
  // gerente/administrador, com segunda autorização (senha + MFA) — também validado aqui.
  finalClose = async () => { for (const [who, id] of [['caixa.a1', R1], ['caixa.a1b', R2]]) {
    if (q1(`SELECT count(*) FROM cash_registers WHERE id = '${id}' AND status = 'OPEN'`) === 0) continue;
    let r = await closeReg(who, id, cashExpected(id));
    if (r.status === 409 && r.body?.code === 'CASH_CLOSE_PENDING') {
      check(`fechamento normal do caixa ${who} é bloqueado por venda em aberto (409 CASH_CLOSE_PENDING)`, true);
      const g = s['gerente.a1'].def;
      r = await api.post(`/api/cash-register/${id}/force-close`, {
        actualAmount: cashExpected(id), reason: 'HML-STRESS encerramento do ciclo de concorrência',
        authorizerNumericId: g.numericId, authorizerPassword: g.password, authorizerMfaCode: totp(g.mfaSecret),
      }, tok(who));
      check(`fechamento forçado do caixa ${who} com autorização do gerente`, ok2xx(r), `${r.status} ${r.text?.slice(0, 200)}`);
      check('fechamento forçado deixou auditoria', q1(`SELECT count(*) FROM audit_logs WHERE entity = 'CashRegister' AND "entityId" = '${id}' AND action = 'UPDATE'`) >= 1, '');
    } else {
      check(`fechamento final do caixa ${who} bate com o esperado`, ok2xx(r), `${r.status} ${r.text?.slice(0, 150)}`);
    }
  } };
  await finalClose();
  S.finish();
})().catch(async (e) => { console.error('ERRO NA SUÍTE:', e); try { if (finalClose) await finalClose(); } catch (e2) { console.error('limpeza falhou:', e2.message); } process.exit(2); });
