// Concorrência de OFICINA e AGENDA contra a API HML: várias mudanças simultâneas na mesma OS e no mesmo agendamento.
// A prova é o banco (totais, histórico, saldo de estoque), nunca o HTTP 200. Dados levam [HML-STRESS], só na empresa Alfa;
// nada é apagado. A única configuração tocada (agenda.maxPerSlot da filial A2) é restaurada no final.
const { suite, sessions, idOf, api } = require('../lib/harness');
const db = require('../lib/db');

const S = suite('workshop-concurrency');
const { check } = S;
const par = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const ok2xx = (r) => r.status >= 200 && r.status < 300;
const count = (rs, pred) => rs.filter(pred).length;
const brief = (rs) => JSON.stringify(rs.map((r) => r.status));
const q1 = (sql) => Number(db.scalar(sql));

const balance = (pid, branchId) => Number(db.scalar(`
  WITH m AS (SELECT id, "movementType"::text t, quantity q, "createdAt" ts FROM stock_movements WHERE "productId" = '${pid}' AND "branchId" = '${branchId}'),
  li AS (SELECT ts, id, abs(q) iq FROM m WHERE t = 'INVENTORY' ORDER BY ts DESC, id DESC LIMIT 1)
  SELECT coalesce((SELECT iq FROM li), 0) + coalesce(sum(CASE WHEN t IN ('PURCHASE','RETURN','TRANSFER_IN','PRODUCTION') THEN abs(q)
    WHEN t IN ('SALE','TRANSFER_OUT','LOSS','SUPPLIER_RETURN') THEN -abs(q) WHEN t = 'ADJUSTMENT' THEN q ELSE 0 END)
    FILTER (WHERE NOT EXISTS (SELECT 1 FROM li) OR ts > (SELECT ts FROM li) OR (ts = (SELECT ts FROM li) AND id > (SELECT id FROM li))), 0) FROM m`));

(async () => {
  const s = await sessions(['ceo.a', 'gerente.a1', 'caixa.a1']);
  const A = s.cred.companies.A;
  const B1 = A.branches[0].id;
  const B2 = A.branches[1].id;
  const run = `${Date.now()}`;
  const tok = (k) => ({ token: s[k].token });
  let policyTouched = false;

  try {
    const cust = await api.post('/api/customers', { name: `[HML-STRESS] oficina ${run}` }, tok('ceo.a'));
    const cid = idOf(cust);
    const moto = await api.post('/api/motorcycles', { customerId: cid, brand: 'HML', model: 'Stress', licensePlate: `HC${run.slice(-5)}`, kilometerReading: 100 }, tok('ceo.a'));
    const mid = idOf(moto);
    if (!cid || !mid) throw new Error(`cliente/moto: ${cust.status} ${moto.status}`);

    const newOs = async (branchId = B1) => {
      const r = await api.post('/api/service-orders', { branchId, customerId: cid, motorcycleId: mid, entryKilometer: 100 }, tok('caixa.a1'));
      if (r.status !== 201) throw new Error(`OS: ${r.status} ${r.text}`);
      return idOf(r);
    };
    const move = (os, toStatus, who = 'caixa.a1') => api.post(`/api/service-orders/${os}/status`, { toStatus }, tok(who));
    const advance = async (os, path) => { for (const st of path) { const r = await move(os, st); if (!ok2xx(r)) throw new Error(`OS ${os} -> ${st}: ${r.status} ${r.text}`); } };
    const toApproval = (os) => advance(os, ['DIAGNOSTICO', 'ORCAMENTO', 'APROVACAO']);
    const osRow = (os) => db.run(`SELECT status::text, "laborTotal", "partsTotal", "finalTotal" FROM service_orders WHERE id = '${os}' AND "companyId" = '${A.id}'`)[0];
    const histCount = (os, from, to) => q1(`SELECT count(*) FROM service_order_status_history WHERE "serviceOrderId" = '${os}' AND "fromStatus"::text = '${from}' AND "toStatus"::text = '${to}'`);
    const mkPart = async (label, stock) => {
      const r = await api.post('/api/products', { sku: `HMLW-${label}-${run}`, name: `[HML-STRESS] peça ${label} ${run}`, costPrice: 10, salePrice: 30, unit: 'UN' }, tok('ceo.a'));
      if (r.status !== 201) throw new Error(`produto: ${r.status} ${r.text}`);
      const pid = idOf(r);
      const a = await api.post('/api/stock/adjustment', { productId: pid, branchId: B1, newQuantity: stock, reason: 'HML-STRESS oficina' }, tok('ceo.a'));
      if (a.status !== 201) throw new Error(`estoque: ${a.status} ${a.text}`);
      return pid;
    };
    const part = (os, pid, qty = 1) => api.post(`/api/service-orders/${os}/items`, { itemType: 'PART', productId: pid, description: '[HML-STRESS] peça', quantity: qty, unitPrice: 1 }, tok('caixa.a1'));
    const saleMoves = (pid) => q1(`SELECT count(*) FROM stock_movements WHERE "productId" = '${pid}' AND "movementType"::text = 'SALE' AND "referenceType" = 'ServiceOrder'`);

    // O1 — 20 itens de mão de obra ao mesmo tempo na mesma OS: nenhum "lost update" nos totais
    const burst = (os) => par(20, (i) => api.post(`/api/service-orders/${os}/items`, { itemType: 'SERVICE', description: `[HML-STRESS] serviço ${i}`, quantity: 1, unitPrice: 10 }, tok('caixa.a1')));
    // O1a — rajada com o pool de conexões possivelmente frio (1ª rajada após subir a API): cada resposta é 201 ou 503
    // com nova tentativa possível (nunca 400/500) e o banco bate EXATAMENTE com o que foi aceito.
    {
      const os = await newOs();
      const rs = await burst(os);
      const accepted = count(rs, (r) => r.status === 201);
      const row = osRow(os);
      const items = q1(`SELECT count(*) FROM service_order_items WHERE "serviceOrderId" = '${os}'`);
      check('O1a/rajada de 20: só 201 ou 503 (Retry-After), nunca 400/500', rs.every((r) => r.status === 201 || r.status === 503), brief(rs));
      check('O1a/itens gravados = itens aceitos e laborTotal = 10 × aceitos (nada perdido, nada fantasma)', items === accepted && Number(row[1]) === 10 * accepted, `aceitos=${accepted} itens=${items} labor=${row[1]}`);
      check('O1a/finalTotal = mão de obra + peças', Number(row[3]) === Number(row[1]) + Number(row[2]), JSON.stringify(row));
    }
    // O1b — com o pool aquecido (tráfego de leitura de outro usuário antes), as 20 são aceitas e nenhum total se perde.
    {
      await par(30, () => api.get('/api/customers?limit=1', tok('gerente.a1')));
      const os = await newOs();
      const rs = await burst(os);
      const row = osRow(os);
      const items = q1(`SELECT count(*) FROM service_order_items WHERE "serviceOrderId" = '${os}'`);
      check('O1b/20 itens simultâneos na mesma OS (pool quente): todos aceitos, nenhum 5xx', count(rs, (r) => r.status === 201) === 20, brief(rs));
      check('O1b/20 linhas de item gravadas e laborTotal = 200 (sem atualização perdida)', items === 20 && Number(row[1]) === 200, `itens=${items} labor=${row[1]}`);
      check('O1b/finalTotal = mão de obra + peças', Number(row[3]) === Number(row[1]) + Number(row[2]), JSON.stringify(row));
    }

    // O2 — 10 mudanças iguais de status (duplo clique em escala): uma vence, um registro de histórico
    {
      const os = await newOs();
      const rs = await par(10, () => move(os, 'DIAGNOSTICO'));
      check('O2/10 transições iguais: exatamente 1 aceita, as outras recusadas sem 5xx', count(rs, ok2xx) === 1 && count(rs, (r) => r.status >= 500) === 0, brief(rs));
      check('O2/1 linha de histórico ENTRADA→DIAGNOSTICO e OS em DIAGNOSTICO', histCount(os, 'ENTRADA', 'DIAGNOSTICO') === 1 && osRow(os)[0] === 'DIAGNOSTICO', `hist=${histCount(os, 'ENTRADA', 'DIAGNOSTICO')} status=${osRow(os)[0]}`);
    }

    // O3 — duas telas decidem destinos diferentes (avançar × cancelar): um só resultado coerente com o histórico
    {
      const os = await newOs();
      await advance(os, ['DIAGNOSTICO']);
      const rs = await Promise.all([move(os, 'ORCAMENTO'), move(os, 'CANCELADA', 'gerente.a1'), move(os, 'ORCAMENTO'), move(os, 'CANCELADA')]);
      const final = osRow(os)[0];
      const hist = q1(`SELECT count(*) FROM service_order_status_history WHERE "serviceOrderId" = '${os}' AND "fromStatus"::text = 'DIAGNOSTICO'`);
      check('O3/avançar × cancelar: só uma decisão vale (1 histórico a partir de DIAGNOSTICO), sem 5xx', hist === 1 && count(rs, ok2xx) === 1 && count(rs, (r) => r.status >= 500) === 0, `${brief(rs)} hist=${hist}`);
      check('O3/status final bate com a transição que venceu', ['ORCAMENTO', 'CANCELADA'].includes(final) && q1(`SELECT count(*) FROM service_order_status_history WHERE "serviceOrderId" = '${os}' AND "toStatus"::text = '${final}'`) === 1, final);
    }

    // O4 — duas OS disputam a ÚLTIMA peça no início da execução: uma executa, a outra é recusada, saldo nunca negativo
    {
      const pid = await mkPart('ultima', 1);
      const [o1, o2] = [await newOs(), await newOs()];
      for (const o of [o1, o2]) { const r = await part(o, pid); if (r.status !== 201) throw new Error(`peça na OS: ${r.status} ${r.text}`); }
      await toApproval(o1);
      await toApproval(o2);
      const rs = await Promise.all([move(o1, 'EXECUCAO'), move(o2, 'EXECUCAO')]);
      const bal = balance(pid, B1);
      check('O4/última peça disputada por 2 OS: exatamente 1 vai para EXECUCAO, sem 5xx', count(rs, ok2xx) === 1 && count(rs, (r) => r.status >= 500) === 0, brief(rs));
      check('O4/saldo da peça = 0 (nunca -1) e 1 baixa de estoque da OS vencedora', bal === 0 && saleMoves(pid) === 1, `saldo=${bal} baixas=${saleMoves(pid)}`);
      const losers = [o1, o2].filter((o) => osRow(o)[0] === 'APROVACAO');
      check('O4/a OS que perdeu continua em APROVACAO (transação revertida por inteiro)', losers.length === 1, JSON.stringify([o1, o2].map((o) => osRow(o)[0])));
    }

    // O5 — a mesma OS iniciada 6 vezes ao mesmo tempo: uma única baixa de peça
    {
      const pid = await mkPart('execucao', 5);
      const os = await newOs();
      await part(os, pid, 2);
      await toApproval(os);
      const rs = await par(6, () => move(os, 'EXECUCAO'));
      check('O5/6 inícios de execução simultâneos da mesma OS: 1 aceito, sem 5xx', count(rs, ok2xx) === 1 && count(rs, (r) => r.status >= 500) === 0, brief(rs));
      check('O5/baixa única: 1 movimentação de SALE e saldo 5-2 = 3', saleMoves(pid) === 1 && balance(pid, B1) === 3, `baixas=${saleMoves(pid)} saldo=${balance(pid, B1)}`);
    }

    // O6 — com a OS já em EXECUCAO, 5 peças simultâneas para a última unidade: 1 aceita, estoque nunca negativo
    {
      const pid = await mkPart('meio', 1);
      const os = await newOs();
      await advance(os, ['DIAGNOSTICO', 'ORCAMENTO', 'APROVACAO', 'EXECUCAO']);
      const rs = await par(5, () => part(os, pid, 1));
      const bal = balance(pid, B1);
      check('O6/5 peças simultâneas na última unidade (OS em execução): exatamente 1 aceita, sem 5xx', count(rs, (r) => r.status === 201) === 1 && count(rs, (r) => r.status >= 500) === 0, brief(rs));
      check('O6/saldo = 0 (nunca negativo) e 1 baixa', bal === 0 && saleMoves(pid) === 1, `saldo=${bal} baixas=${saleMoves(pid)}`);
      const row = osRow(os);
      check('O6/total de peças da OS = 1 item (o recusado não entrou na conta)', Number(row[2]) === 30 && q1(`SELECT count(*) FROM service_order_items WHERE "serviceOrderId" = '${os}' AND "itemType"::text = 'PART'`) === 1, JSON.stringify(row));
    }

    // Limite geral de 100 req/min por usuário (comportamento do produto, não contornado): espera a janela virar antes da agenda.
    await new Promise((r) => setTimeout(r, 62000));

    // Agenda
    const at = (days, hour) => { const d = new Date(Date.now() + days * 864e5); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };
    const newAppt = async (when, branchId = B1) => {
      const r = await api.post('/api/appointments', { customerId: cid, motorcycleId: mid, branchId, scheduledAt: when }, tok('caixa.a1'));
      if (r.status !== 201) throw new Error(`agendamento: ${r.status} ${r.text}`);
      return idOf(r);
    };
    const confirm = (id, who = 'caixa.a1') => api.post(`/api/appointments/${id}/confirm`, { channel: 'PHONE', confirmedByName: 'Cliente HML' }, tok(who));
    const apptRow = (id) => db.run(`SELECT status::text, "scheduledAt", "customerConfirmed" FROM appointments WHERE id = '${id}' AND "companyId" = '${A.id}'`)[0];

    // G1 — 10 confirmações simultâneas do mesmo agendamento
    {
      const id = await newAppt(at(10, 14));
      const rs = await par(10, () => confirm(id));
      check('G1/10 confirmações simultâneas: nenhum 5xx e agendamento CONFIRMED', count(rs, (r) => r.status >= 500) === 0 && apptRow(id)[0] === 'CONFIRMED', `${brief(rs)} status=${apptRow(id)[0]}`);
    }

    // G2 — confirmar × cancelar ao mesmo tempo: estado final é um dos dois, nunca misto
    {
      const id = await newAppt(at(11, 14));
      const rs = await Promise.all([confirm(id), api.post(`/api/appointments/${id}/cancel`, { reason: 'HML-STRESS corrida' }, tok('gerente.a1')), confirm(id), api.post(`/api/appointments/${id}/cancel`, { reason: 'HML-STRESS corrida' }, tok('caixa.a1'))]);
      const row = apptRow(id);
      check('G2/confirmar × cancelar: sem 5xx e estado final coerente (CANCELLED, ou CONFIRMED com confirmação)', count(rs, (r) => r.status >= 500) === 0 && ((row[0] === 'CANCELLED') || (row[0] === 'CONFIRMED' && row[2] === 't')), `${brief(rs)} ${JSON.stringify(row)}`);
      const rs2 = await confirm(id);
      if (row[0] === 'CANCELLED') check('G2/agendamento cancelado não é confirmado depois (4xx)', rs2.status >= 400 && rs2.status < 500 && apptRow(id)[0] === 'CANCELLED', `${rs2.status}`);
    }

    // G3 — 5 reagendamentos simultâneos para horários diferentes: um estado final válido, sem 5xx
    {
      const id = await newAppt(at(12, 14));
      const whens = [15, 16, 17, 18, 19].map((h) => at(13, h));
      const rs = await par(5, (i) => api.post(`/api/appointments/${id}/reschedule`, { newScheduledAt: whens[i], reason: 'HML-STRESS' }, tok('caixa.a1')));
      const row = apptRow(id);
      const finalTs = new Date(row[1].replace(' ', 'T') + (/[zZ+]/.test(row[1]) ? '' : 'Z')).toISOString();
      check('G3/5 reagendamentos simultâneos: sem 5xx e o horário final é um dos pedidos', count(rs, (r) => r.status >= 500) === 0 && whens.includes(finalTs), `${brief(rs)} final=${row[1]}`);
    }

    // G4 — 10 cancelamentos simultâneos: um efeito só
    {
      const id = await newAppt(at(14, 14));
      const rs = await par(10, () => api.post(`/api/appointments/${id}/cancel`, { reason: 'HML-STRESS duplo clique' }, tok('caixa.a1')));
      check('G4/10 cancelamentos simultâneos: sem 5xx e CANCELLED', count(rs, (r) => r.status >= 500) === 0 && apptRow(id)[0] === 'CANCELLED', `${brief(rs)} ${apptRow(id)[0]}`);
      const audits = q1(`SELECT count(*) FROM audit_logs WHERE "companyId" = '${A.id}' AND entity = 'Appointment' AND "entityId" = '${id}' AND action::text = 'UPDATE' AND "createdAt" > now() - interval '5 minutes'`);
      check('G4/auditoria registrada para o cancelamento (nenhuma ação sem trilha)', audits >= 1, `audits=${audits}`);
    }

    // G5 — concluir 5 vezes com chaves de idempotência diferentes: uma conclusão
    {
      const id = await newAppt(at(15, 14));
      await confirm(id);
      const rs = await par(5, (i) => api.post(`/api/appointments/${id}/complete`, { notes: 'HML-STRESS' }, { ...tok('caixa.a1'), headers: { 'Idempotency-Key': `hml-ws-${run}-${i}` } }));
      check('G5/5 conclusões simultâneas (chaves diferentes): sem 5xx e COMPLETED', count(rs, (r) => r.status >= 500) === 0 && apptRow(id)[0] === 'COMPLETED', `${brief(rs)} ${apptRow(id)[0]}`);
    }

    // G6 — capacidade: limite de 2 por horário na filial A2; 8 propostas ao mesmo tempo para o MESMO horário
    {
      const set = await api.put('/api/policies/agenda.maxPerSlot', { value: 2, branchId: B2, reason: 'HML-STRESS teste de capacidade' }, tok('ceo.a'));
      policyTouched = ok2xx(set);
      check('G6/controle: política agenda.maxPerSlot = 2 gravada na filial A2 (CEO)', policyTouched, `${set.status} ${set.text.slice(0, 120)}`);
      const when = at(30 + (Math.floor(Date.now() / 60000) % 300), 15); // horário novo a cada execução (a suíte é repetível)
      const rs = await par(8, () => api.post('/api/appointments', { customerId: cid, motorcycleId: mid, branchId: B2, scheduledAt: when }, tok('ceo.a')));
      const created = count(rs, (r) => r.status === 201);
      const inDb = q1(`SELECT count(*) FROM appointments WHERE "companyId" = '${A.id}' AND "branchId" = '${B2}' AND "scheduledAt" = '${when}' AND status::text <> 'CANCELLED'`);
      check('G6/8 propostas simultâneas no mesmo horário com limite 2: exatamente 2 criadas (nunca 3+)', created === 2 && inDb === 2, `${brief(rs)} noBanco=${inDb}`);
      check('G6/as recusadas dizem SLOT_FULL (409), sem 5xx', count(rs, (r) => r.status === 409) === 6 && count(rs, (r) => r.status >= 500) === 0, brief(rs));
    }
  } finally {
    if (policyTouched) {
      const r = await api.del(`/api/policies/agenda.maxPerSlot?branchId=${B2}`, { token: s['ceo.a'].token, body: { reason: 'HML-STRESS restauração do padrão' } });
      check('restauração: política agenda.maxPerSlot da filial A2 voltou ao padrão', ok2xx(r), `${r.status} ${r.text.slice(0, 120)}`);
    }
  }
  S.finish();
})().catch((e) => { console.error(e); process.exit(2); });
