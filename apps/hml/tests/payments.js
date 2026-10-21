// Pagamentos contra a API HML (provedor MANUAL, o único existente no build): dinheiro com troco, cartão manual,
// PIX pendente + reconciliação honesta, valores inválidos, venda de outra empresa, venda cancelada, cancelar/estornar
// com permissão e auditoria, e o que o banco registra. Provedor real (timeout/5xx/resposta desconhecida) NÃO existe
// neste ambiente: esse comportamento é provado pelas integrações payment-terminal-reconciliation e payment-exceptions
// (provedor falso registrado, Postgres real). Dados levam [HML-STRESS], só empresa Alfa; nada é apagado.
const crypto = require('crypto');
const { suite, sessions, idOf, api } = require('../lib/harness');
const { totp } = require('../lib/api');
const db = require('../lib/db');

const S = suite('payments');
const { check } = S;
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const q1 = (sql) => Number(db.scalar(sql));
const cashExpected = (id) => q1(`SELECT coalesce(sum(CASE WHEN "movementType" IN ('OPENING','SALE','DEPOSIT') THEN amount
  WHEN "movementType" IN ('WITHDRAWAL','CANCELLATION','RETURN') THEN -amount ELSE 0 END), 0) FROM cash_movements WHERE "cashRegisterId" = '${id}'`);
const bodyOf = (r) => r.body?.data ?? r.body;

(async () => {
  const s = await sessions(['ceo.a', 'ceo.b', 'gerente.a1', 'caixa.a1', 'caixa.b1']);
  const A = s.cred.companies.A;
  const B1 = A.branches[0].id;
  const run = `${Date.now()}`;
  const tok = (k) => ({ token: s[k].token });

  const pr = await api.post('/api/products', { sku: `HMLP-${run}`, name: `[HML-STRESS] pagamento ${run}`, costPrice: 10, salePrice: 100, unit: 'UN' }, tok('ceo.a'));
  if (pr.status !== 201) throw new Error(`produto: ${pr.status} ${pr.text}`);
  const P = idOf(pr);
  await api.post('/api/stock/adjustment', { productId: P, branchId: B1, newQuantity: 200, reason: 'HML-STRESS pagamentos' }, tok('ceo.a'));

  const uid = s['caixa.a1'].user.id;
  // Qualquer caixa aberto deste operador nesta empresa (o 75 de execuções anteriores ou o 71 aberto pela evidência visual do PDV):
  // a API só permite um caixa aberto por operador e filial, e a suíte precisa do seu próprio (75).
  for (const [id] of db.run(`SELECT id FROM cash_registers WHERE "companyId" = '${A.id}' AND "userId" = '${uid}' AND status = 'OPEN'`)) {
    await api.post(`/api/cash-register/${id}/close`, { actualAmount: cashExpected(id) }, tok('caixa.a1'));
  }
  const open = await api.post('/api/cash-register/open', { branchId: B1, registerNumber: 75, openingAmount: 100 }, tok('caixa.a1'));
  if (open.status !== 201) throw new Error(`abrir caixa: ${open.status} ${open.text}`);
  const R = idOf(open);

  const sale = async (qty) => {
    const r = await api.post('/api/sales', { branchId: B1, cashRegisterId: R, items: [{ productId: P, quantity: qty, unitPrice: 100 }], notes: `[HML-STRESS] pag ${run}` }, tok('caixa.a1'));
    if (r.status !== 201) throw new Error(`venda: ${r.status} ${r.text}`);
    return idOf(r);
  };
  const pay = (saleId, body, who = 'caixa.a1', key) =>
    api.post('/api/payments', { saleId, ...body }, { ...tok(who), headers: { 'Idempotency-Key': key || crypto.randomUUID() } });
  const saleStatus = (id) => db.scalar(`SELECT status::text FROM sales WHERE id = '${id}'`);
  const payStatus = (id) => db.scalar(`SELECT status::text FROM payments WHERE id = '${id}'`);
  const cashMov = (sid) => q1(`SELECT count(*) FROM cash_movements cm JOIN payments p ON cm."referenceId" = p.id WHERE cm."cashRegisterId" = '${R}' AND cm."referenceType" = 'Payment' AND p."saleId" = '${sid}'`);
  const reversals = (sid) => q1(`SELECT count(*) FROM cash_movements cm JOIN payments p ON cm."referenceId" = p.id WHERE cm."cashRegisterId" = '${R}' AND cm."referenceType" = 'PaymentReversal' AND p."saleId" = '${sid}'`);
  const mgrKey = () => ({ ...tok('ceo.a'), headers: { 'Idempotency-Key': crypto.randomUUID() } });
  const authz = (reason) => { const c = s['ceo.a'].def; return { reason, authorizerNumericId: c.numericId, authorizerPassword: c.password, authorizerMfaCode: totp(c.mfaSecret) }; };

  // 1. Dinheiro com troco
  {
    const sv = await sale(1);
    const r = await pay(sv, { paymentMethod: 'CASH', amount: 100, receivedAmount: 150 });
    check('1/dinheiro com troco: 201 e pagamento aprovado', r.status === 201 && bodyOf(r)?.status === 'APPROVED', `${r.status} ${r.text}`.slice(0, 200));
    check('1/venda fica paga e entra um lançamento no caixa', saleStatus(sv) === 'PAID' && cashMov(sv) === 1, `${saleStatus(sv)} mov=${cashMov(sv)}`);
    const aud = q1(`SELECT count(*) FROM audit_logs WHERE "companyId" = '${A.id}' AND entity = 'Payment' AND action = 'CREATE' AND "createdAt" > now() - interval '2 minutes'`);
    check('1/o pagamento tem registro de auditoria', aud >= 1, `audit=${aud}`);
  }

  // 2. Cartão manual e pagamento parcial até quitar
  {
    const sv = await sale(2);
    const p1 = await pay(sv, { paymentMethod: 'CREDIT_CARD', amount: 120, cardBrand: 'VISA', cardLastDigits: '4242' });
    check('2/cartão parcial aprovado e venda ainda não quitada', p1.status === 201 && saleStatus(sv) !== 'PAID', `${p1.status} ${saleStatus(sv)}`);
    const p2 = await pay(sv, { paymentMethod: 'CASH', amount: 80 });
    check('2/segunda parte em dinheiro quita a venda', p2.status === 201 && saleStatus(sv) === 'PAID', `${p2.status} ${saleStatus(sv)}`);
    const p3 = await pay(sv, { paymentMethod: 'CASH', amount: 10 });
    check('2/pagar de novo uma venda quitada é recusado (4xx) e a soma não passa do total', p3.status >= 400 && p3.status < 500 &&
      q1(`SELECT coalesce(sum(amount),0) FROM payments WHERE "saleId" = '${sv}' AND status = 'APPROVED'`) === 200, `${p3.status} ${p3.text}`.slice(0, 200));
  }

  // 3. Excesso e valores inválidos
  {
    const sv = await sale(1);
    for (const [label, body] of [
      ['de cartão maior que o saldo', { paymentMethod: 'CREDIT_CARD', amount: 100.01 }],
      ['parcelado além do máximo configurado', { paymentMethod: 'CREDIT_CARD', amount: 50, installments: 2 }],
      ['zero', { paymentMethod: 'CASH', amount: 0 }],
      ['negativo', { paymentMethod: 'CASH', amount: -50 }],
      ['texto', { paymentMethod: 'CASH', amount: '10' }],
      ['objeto', { paymentMethod: 'CASH', amount: { $gt: 0 } }],
      ['método inexistente', { paymentMethod: 'BITCOIN', amount: 10 }],
    ]) {
      const r = await pay(sv, body);
      check(`3/pagamento ${label}: 4xx, nunca 5xx nem aprovado`, r.status >= 400 && r.status < 500, `${r.status} ${r.text}`.slice(0, 160));
    }
    check('3/nada foi aprovado na venda após as tentativas inválidas', q1(`SELECT count(*) FROM payments WHERE "saleId" = '${sv}' AND status = 'APPROVED'`) === 0);
    const chg = await sale(1);
    const rc = await pay(chg, { paymentMethod: 'CASH', amount: 100.01 });
    check('3/dinheiro acima do saldo é troco: aplica 100, recebido 100.01, troco 0.01, soma aprovada = total', rc.status === 201 && q1(`SELECT coalesce(sum(amount),0) FROM payments WHERE "saleId" = '${chg}' AND status = 'APPROVED'`) === 100 && Number(bodyOf(rc)?.changeAmount) === 0.01, `${rc.status} ${rc.text}`.slice(0, 200));
    const noSale = await pay(crypto.randomUUID(), { paymentMethod: 'CASH', amount: 10 });
    check('3/venda inexistente: 4xx', noSale.status >= 400 && noSale.status < 500, noSale.status);
  }

  // 4. PIX: sem gateway real fica PENDING e a reconciliação não inventa aprovação
  {
    const sv = await sale(1);
    const r = await pay(sv, { paymentMethod: 'PIX', amount: 100 });
    const pid = idOf(r);
    check('4/PIX sem gateway: pagamento PENDING, venda não vira paga', r.status === 201 && bodyOf(r)?.status === 'PENDING' && saleStatus(sv) !== 'PAID', `${r.status} ${saleStatus(sv)}`);
    check('4/PIX pendente não lança dinheiro no caixa', cashMov(sv) === 0, `mov=${cashMov(sv)}`);
    const rec = await api.post(`/api/payments/${pid}/reconcile`, {}, tok('gerente.a1'));
    check('4/reconciliar PIX sem gateway segue PENDING (honesto)', ok2xx(rec) && bodyOf(rec)?.status === 'PENDING', `${rec.status} ${rec.text}`.slice(0, 160));
    const recCaixa = await api.post(`/api/payments/${pid}/reconcile`, {}, tok('caixa.a1'));
    check('4/caixa não reconcilia (só gerência): 403', recCaixa.status === 403, recCaixa.status);
    const dbl = await pay(sv, { paymentMethod: 'PIX', amount: 100 });
    check('4/segundo PIX para o mesmo saldo é barrado pelo saldo reservado (sem cobrança duplicada)', dbl.status >= 400 && dbl.status < 500, `${dbl.status} ${dbl.text}`.slice(0, 160));
    const cancelP = await api.post(`/api/payments/${pid}/cancel`, {}, tok('ceo.a'));
    const cancelMgr = await api.post(`/api/payments/${pid}/cancel`, {}, tok('gerente.a1'));
    check('4/gerente sem permissão de estorno (finance:reverse) não cancela pagamento: 403', cancelMgr.status === 403, cancelMgr.status);
    check('4/Administrador da empresa cancela o PIX pendente', ok2xx(cancelP), `${cancelP.status} ${cancelP.text}`.slice(0, 160));
    const again = await pay(sv, { paymentMethod: 'CASH', amount: 100 });
    check('4/depois do cancelamento a venda é paga em dinheiro', again.status === 201 && saleStatus(sv) === 'PAID', `${again.status} ${saleStatus(sv)}`);
  }

  // 5. Cancelar e estornar: permissão, estado final, caixa e auditoria
  {
    const sv = await sale(1);
    const p = await pay(sv, { paymentMethod: 'CASH', amount: 100 });
    const pid = idOf(p);
    const byMgr = await api.post(`/api/payments/${pid}/refund`, {}, { ...tok('gerente.a1'), headers: { 'Idempotency-Key': crypto.randomUUID() } });
    check('5/gerente sem finance:reverse não estorna: 403 e o pagamento segue aprovado', byMgr.status === 403 && payStatus(pid) === 'APPROVED', byMgr.status);
    const byCaixa = await api.post(`/api/payments/${pid}/refund`, {}, { ...tok('caixa.a1'), headers: { 'Idempotency-Key': crypto.randomUUID() } });
    check('5/caixa não estorna: 403 e o pagamento segue aprovado', byCaixa.status === 403 && payStatus(pid) === 'APPROVED', byCaixa.status);
    const key = crypto.randomUUID();
    const rs = await Promise.all(Array.from({ length: 3 }, () => api.post(`/api/payments/${pid}/refund`, {}, { ...tok('ceo.a'), headers: { 'Idempotency-Key': key } })));
    check('5/estorno em triplo clique (mesma chave): REFUNDED, sem 5xx', payStatus(pid) === 'REFUNDED' && rs.filter(ok2xx).length >= 1 && rs.every((r) => r.status < 500), JSON.stringify(rs.map((r) => r.status)));
    check('5/estorno em dinheiro devolve do caixa uma única vez', reversals(sv) === 1, `reversões=${reversals(sv)}`);
    const aud = q1(`SELECT count(*) FROM audit_logs WHERE "companyId" = '${A.id}' AND entity = 'Payment' AND action = 'UPDATE' AND "createdAt" > now() - interval '2 minutes'`);
    check('5/estorno auditado', aud >= 1, `audit=${aud}`);
    const again = await api.post(`/api/payments/${pid}/refund`, {}, mgrKey());
    check('5/estornar de novo (chave nova) não devolve dinheiro de novo', reversals(sv) === 1 && again.status < 500, `${again.status} reversões=${reversals(sv)}`);
  }

  // 6. Venda cancelada não recebe pagamento
  {
    const sv = await sale(1);
    const c = await api.post(`/api/sales/${sv}/cancel`, authz('HML-STRESS cancelada antes de pagar'), tok('caixa.a1'));
    const r = await pay(sv, { paymentMethod: 'CASH', amount: 100 });
    check('6/venda cancelada: pagamento recusado com 409 SALE_CLOSED_FOR_PAYMENT', ok2xx(c) && r.status === 409 && r.body?.code === 'SALE_CLOSED_FOR_PAYMENT', `${c.status}/${r.status} ${r.text}`.slice(0, 200));
  }

  // 7. Isolamento: outra empresa, outro usuário
  {
    const sv = await sale(1);
    const xB = await pay(sv, { paymentMethod: 'CASH', amount: 100 }, 'caixa.b1');
    check('7/caixa da empresa B não paga venda da empresa A', xB.status >= 400 && xB.status < 500 && q1(`SELECT count(*) FROM payments WHERE "saleId" = '${sv}'`) === 0, `${xB.status} ${xB.text}`.slice(0, 160));
    const forged = await pay(sv, { paymentMethod: 'CASH', amount: 100, companyId: s.cred.companies.A.id }, 'caixa.b1');
    check('7/companyId da empresa A forjado no corpo não vale (vale o do token)', forged.status >= 400 && forged.status < 500 && q1(`SELECT count(*) FROM payments WHERE "saleId" = '${sv}'`) === 0, `${forged.status}`);
    const list = await api.get('/api/payments?limit=100', tok('ceo.b'));
    const rows = list.body?.data ?? list.body?.payments ?? [];
    check('7/lista de pagamentos da empresa B não mostra pagamentos da A', ok2xx(list) && Array.isArray(rows) && rows.every((p) => p.companyId === undefined || p.companyId !== A.id), `${list.status}`);
    const ex = await api.get('/api/payments/exceptions', tok('caixa.a1'));
    check('7/caixa não lista exceções de pagamento (403)', ex.status === 403, ex.status);
    const pay0 = await pay(sv, { paymentMethod: 'CASH', amount: 100 });
    check('7/controle: a venda continua pagável pela empresa dona', pay0.status === 201, pay0.status);
  }

  // 8. Fechamento do caixa bate com o ledger de movimentos
  {
    for (const [id] of db.run(`SELECT id FROM sales WHERE "cashRegisterId" = '${R}' AND "companyId" = '${A.id}' AND status NOT IN ('CANCELLED','RETURNED','PAID')`)) {
      await api.post(`/api/sales/${id}/cancel`, authz('HML-STRESS limpeza de venda em aberto'), tok('caixa.a1'));
    }
    let r = await api.post(`/api/cash-register/${R}/close`, { actualAmount: cashExpected(R) }, tok('caixa.a1'));
    if (r.status === 409) {
      const g = s['gerente.a1'].def;
      r = await api.post(`/api/cash-register/${R}/force-close`, { actualAmount: cashExpected(R), reason: 'HML-STRESS encerramento da suíte de pagamentos', authorizerNumericId: g.numericId, authorizerPassword: g.password, authorizerMfaCode: totp(g.mfaSecret) }, tok('caixa.a1'));
    }
    check('8/caixa fecha com o saldo do ledger de movimentos', ok2xx(r) && db.scalar(`SELECT status::text FROM cash_registers WHERE id = '${R}'`) === 'CLOSED', `${r.status} ${r.text}`.slice(0, 200));
  }

  S.finish();
})().catch((e) => { console.error('ERRO DA SUÍTE', e); process.exit(2); });
