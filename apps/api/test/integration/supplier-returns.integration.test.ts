import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { policyService } from '../../src/services/policy.service';
import { stockLedger } from '../../src/services/stock-ledger';
import cacheService, { CacheKeys } from '../../src/services/cache.service';
import { bearer, bypass, createWorld, destroyWorld, tokenFor, World, CompanyData, BranchKey } from './helpers/tenant-world';

/**
 * Devolução ao fornecedor (docs/CORTEX/policies/DEVOLUCAO-FORNECEDOR.md) — prova REAL (HTTP + Postgres/RLS + Redis).
 * Antes deste commit não existia /api/supplier-returns (toda chamada abaixo respondia 404 de rota) e o livro de estoque
 * não conhecia SUPPLIER_RETURN (o SQL do saldo caía no ELSE 0: a mercadoria devolvida continuava no estoque).
 */
describe('Devolução ao fornecedor: fluxo, estoque, papéis, corrida e isolamento (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let seq = 0;
  const users: Record<string, { id: string; token: string }> = {};
  const auditCalls = () => auditSpy.mock.calls.filter((c) => c[0] === 'audit-log').map((c) => c[1]);

  const A = () => world.A;
  const B = () => world.B;
  const as = (userType: string, branch: BranchKey | null = 1, co: CompanyData = A()) => bearer(tokenFor(co, branch, userType));
  const OPERATOR_A1 = () => as('OPERATOR');
  const MANAGER_A1 = () => bearer(users.managerA1.token);
  const ADMIN_A = () => bearer(users.adminA.token);

  async function makeUser(co: CompanyData, branch: BranchKey | null, userType: string, name: string) {
    const branchId = branch ? co.branches[branch].branchId : null;
    const u = await bypass<any>(() =>
      db.user.create({
        data: { companyId: co.companyId, branchId, name, email: `sr-${userType.toLowerCase()}-${Date.now()}-${++seq}@test.local`, password: 'not-a-real-hash', userType: userType as any, isActive: true },
      })
    );
    const token = generateAccessToken({ userId: u.id, email: u.email, companyId: co.companyId, branchId: (branchId ?? undefined) as any, userType });
    return { id: u.id as string, token };
  }

  /** Produto novo na filial, com saldo inicial (PURCHASE) — cada teste com o seu, para o saldo ser exato. */
  async function newProduct(opts: { co?: CompanyData; branch?: BranchKey; stock?: number; allowNegativeStock?: boolean } = {}) {
    const co = opts.co ?? A();
    const branchId = co.branches[opts.branch ?? 1].branchId;
    const p = await bypass<any>(() =>
      db.product.create({
        data: {
          companyId: co.companyId, branchId, sku: `SR-${Date.now()}-${++seq}`, name: `Peça devolvível ${seq}`, costPrice: 30, salePrice: 60,
          isActive: true, allowNegativeStock: opts.allowNegativeStock ?? false,
        },
      })
    );
    if (opts.stock) {
      await bypass(() =>
        db.stockMovement.create({ data: { companyId: co.companyId, branchId, productId: p.id, movementType: 'PURCHASE', quantity: opts.stock!, userId: co.fixture.userId } })
      );
    }
    return p.id as string;
  }

  const balance = (productId: string, co: CompanyData = A(), branch: BranchKey = 1) =>
    runWithRLSContext({ companyId: co.companyId, userType: 'COMPANY_ADMIN', branchId: null }, async () =>
      (await stockLedger.read({ productId, companyId: co.companyId, branchId: co.branches[branch].branchId })).balance
    );
  const movementsOf = (returnId: string, co: CompanyData = A()) =>
    bypass<any[]>(() => db.stockMovement.findMany({ where: { companyId: co.companyId, referenceType: 'SupplierReturn', referenceId: returnId }, orderBy: { createdAt: 'asc' } }));
  const row = (id: string, co: CompanyData = A()) => bypass<any>(() => db.supplierReturn.findFirst({ where: { id, companyId: co.companyId } }));

  const create = (body: Record<string, unknown>, headers = OPERATOR_A1()) => request(app).post('/api/supplier-returns').set(headers).send(body);
  const act = (id: string, action: string, body: Record<string, unknown> = {}, headers = MANAGER_A1()) =>
    request(app).post(`/api/supplier-returns/${id}/${action}`).set(headers).send(body);
  const requestReturn = async (productId: string, quantity = 4, headers = OPERATOR_A1(), extra: Record<string, unknown> = {}) => {
    const res = await create({ supplierId: A().supplierId, reason: 'DAMAGED', description: 'Caixa amassada na entrega', items: [{ productId, quantity, unitCost: 30 }], ...extra }, headers);
    expect(res.status).toBe(201);
    return res.body;
  };

  beforeAll(async () => {
    world = await createWorld();
    users.managerA1 = await makeUser(A(), 1, 'MANAGER', 'Gerente A1');
    users.managerA1b = await makeUser(A(), 1, 'MANAGER', 'Gerente A1 (2)');
    users.adminA = await makeUser(A(), null, 'COMPANY_ADMIN', 'Administrador A');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  });
  afterAll(async () => {
    auditSpy?.mockRestore();
    if (world) await destroyWorld(world);
  });

  it('fluxo completo: solicitar → aprovar (estoque sai) → enviar → encerrar com crédito; histórico com nomes e auditoria', async () => {
    const productId = await newProduct({ stock: 10 });
    const before = auditCalls().length;
    const payablesBefore = await bypass<number>(() => db.accountsPayable.count({ where: { companyId: A().companyId } }));
    const receivablesBefore = await bypass<number>(() => db.accountsReceivable.count({ where: { companyId: A().companyId } }));

    const created = await requestReturn(productId, 4);
    expect(created).toMatchObject({ status: 'REQUESTED', reason: 'DAMAGED', branchId: A().branches[1].branchId, requestedBy: A().branches[1].userId });
    expect(created.returnNumber).toBeGreaterThan(0);
    expect(created.allowedActions).toMatchObject({ approve: false, cancel: true });
    // solicitar NÃO mexe no estoque
    expect(await balance(productId)).toBe(10);
    expect(await movementsOf(created.id)).toHaveLength(0);

    const approved = await act(created.id, 'approve', { notes: 'Conferido com o fornecedor' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED', approvedBy: users.managerA1.id, decisionNotes: 'Conferido com o fornecedor' });
    expect(approved.body.stockWithdrawnAt).toBeTruthy();
    expect(await balance(productId)).toBe(6);
    const [out] = await movementsOf(created.id);
    expect(out).toMatchObject({ movementType: 'SUPPLIER_RETURN', productId, branchId: A().branches[1].branchId, userId: users.managerA1.id });
    expect(Number(out.quantity)).toBe(4);
    expect(Number(out.totalCost)).toBe(120);

    const sent = await act(created.id, 'send', { shippingInfo: 'Transportadora X, NF-e de devolução pelo contador' }, OPERATOR_A1());
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'SENT', sentBy: A().branches[1].userId, shippingInfo: 'Transportadora X, NF-e de devolução pelo contador' });

    const closed = await act(created.id, 'close', { outcome: 'CREDIT', outcomeAmount: 120.5, outcomeNotes: 'Crédito para o próximo pedido' });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: 'CLOSED', outcome: 'CREDIT', closedBy: users.managerA1.id });
    expect(Number(closed.body.outcomeAmount)).toBe(120.5);
    // crédito só é REGISTRADO: nenhuma conta a pagar/receber nasce daqui (política financeira não definida)
    expect(await bypass<number>(() => db.accountsPayable.count({ where: { companyId: A().companyId } }))).toBe(payablesBefore);
    expect(await bypass<number>(() => db.accountsReceivable.count({ where: { companyId: A().companyId } }))).toBe(receivablesBefore);
    expect(await balance(productId)).toBe(6);

    const detail = await request(app).get(`/api/supplier-returns/${created.id}`).set(OPERATOR_A1());
    expect(detail.status).toBe(200);
    expect(detail.body.events.map((e: any) => e.type)).toEqual(['REQUESTED', 'APPROVED', 'STOCK_WITHDRAWN', 'SENT', 'CLOSED']);
    expect(detail.body.events.find((e: any) => e.type === 'APPROVED').userName).toBe('Gerente A1');
    expect(detail.body.approvedByName).toBe('Gerente A1');
    expect(detail.body.requestedByName).toBeTruthy();
    expect(detail.body.stockMovements).toHaveLength(1);
    expect(detail.body.items[0].product.id).toBe(productId);
    expect(detail.body.allowedActions).toEqual({ approve: false, reject: false, send: false, close: false, cancel: false });

    const audits = auditCalls().slice(before).filter((c) => c.entity === 'SupplierReturn' && c.entityId === created.id);
    expect(audits.map((c) => JSON.parse(c.newValue).action)).toEqual([
      'REQUEST_SUPPLIER_RETURN',
      'APPROVE_SUPPLIER_RETURN',
      'SEND_SUPPLIER_RETURN',
      'CLOSE_SUPPLIER_RETURN',
    ]);
    expect(audits.every((c) => c.companyId === A().companyId)).toBe(true);
    expect(JSON.parse(audits[1].newValue).stockMovements[0]).toMatchObject({ type: 'SUPPLIER_RETURN', quantity: 4 });
  });

  it('reposição: entrada SÓ com as quantidades informadas (PURCHASE referenciado); acima do devolvido ou fora de reposição = 400', async () => {
    const productId = await newProduct({ stock: 5 });
    const r = await requestReturn(productId, 3);
    expect((await act(r.id, 'approve')).status).toBe(200);
    expect((await act(r.id, 'send', {}, OPERATOR_A1())).status).toBe(200);
    expect(await balance(productId)).toBe(2);

    const tooMuch = await act(r.id, 'close', { outcome: 'REPLACEMENT', receivedItems: [{ productId, quantity: 4 }] });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.code).toBe('SUPPLIER_RETURN_RECEIPT_EXCEEDS');
    const notReplacement = await act(r.id, 'close', { outcome: 'CREDIT', receivedItems: [{ productId, quantity: 1 }] });
    expect(notReplacement.status).toBe(400);
    expect(notReplacement.body.code).toBe('SUPPLIER_RETURN_RECEIPT_NOT_REPLACEMENT');
    expect((await row(r.id)).status).toBe('SENT');

    const ok = await act(r.id, 'close', { outcome: 'REPLACEMENT', receivedItems: [{ productId, quantity: 2 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('CLOSED');
    const moves = await movementsOf(r.id);
    expect(moves.map((m) => [m.movementType, Number(m.quantity)])).toEqual([
      ['SUPPLIER_RETURN', 3],
      ['PURCHASE', 2],
    ]);
    expect(await balance(productId)).toBe(4);
    expect(ok.body.events.map((e: any) => e.type)).toContain('REPLACEMENT_RECEIVED');
  });

  it('reposição sem quantidades informadas: nada entra no estoque (nada automático)', async () => {
    const productId = await newProduct({ stock: 5 });
    const r = await requestReturn(productId, 2);
    await act(r.id, 'approve');
    await act(r.id, 'send', {}, OPERATOR_A1());
    const ok = await act(r.id, 'close', { outcome: 'REPLACEMENT' });
    expect(ok.status).toBe(200);
    expect((await movementsOf(r.id)).map((m) => m.movementType)).toEqual(['SUPPLIER_RETURN']);
    expect(await balance(productId)).toBe(3);
  });

  it('cancelar aprovada: o estoque VOLTA (RETURN referenciado), nada é apagado; operador não cancela aprovada; enviada não cancela', async () => {
    const productId = await newProduct({ stock: 8 });
    const r = await requestReturn(productId, 5);
    await act(r.id, 'approve');
    expect(await balance(productId)).toBe(3);

    const byOperator = await act(r.id, 'cancel', { reason: 'Fornecedor pediu para aguardar' }, OPERATOR_A1());
    expect(byOperator.status).toBe(403);
    expect(byOperator.body.code).toBe('SUPPLIER_RETURN_APPROVER_REQUIRED');

    const noReason = await act(r.id, 'cancel', {});
    expect(noReason.status).toBe(400);

    const cancelled = await act(r.id, 'cancel', { reason: 'Fornecedor aceitou abatimento no lugar da devolução' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(await balance(productId)).toBe(8);
    const moves = await movementsOf(r.id);
    expect(moves.map((m) => [m.movementType, Number(m.quantity)])).toEqual([
      ['SUPPLIER_RETURN', 5],
      ['RETURN', 5],
    ]);
    expect(cancelled.body.events.map((e: any) => e.type)).toEqual(['REQUESTED', 'APPROVED', 'STOCK_WITHDRAWN', 'CANCELLED', 'STOCK_RESTORED']);
    expect(cancelled.body.events.find((e: any) => e.type === 'CANCELLED').notes).toBe('Fornecedor aceitou abatimento no lugar da devolução');
    expect(await row(r.id)).not.toBeNull();

    const again = await act(r.id, 'cancel', { reason: 'de novo, duplo clique' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('SUPPLIER_RETURN_INVALID_TRANSITION');
    expect(await balance(productId)).toBe(8);

    // enviada: não cancela
    const s = await requestReturn(productId, 1);
    await act(s.id, 'approve');
    await act(s.id, 'send', {}, OPERATOR_A1());
    const late = await act(s.id, 'cancel', { reason: 'tarde demais para cancelar' });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('SUPPLIER_RETURN_INVALID_TRANSITION');
    expect(late.body.error).toMatch(/encerre com o resultado/);
  });

  it('solicitante cancela a própria solicitação (REQUESTED), sem mexer no estoque', async () => {
    const productId = await newProduct({ stock: 3 });
    const r = await requestReturn(productId, 1);
    const res = await act(r.id, 'cancel', { reason: 'Registrei no produto errado' }, OPERATOR_A1());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(await movementsOf(r.id)).toHaveLength(0);
    expect(await balance(productId)).toBe(3);
  });

  it('saldo insuficiente: aprovação recusada 409 com mensagem humana, status e estoque intactos; produto que permite negativo aprova', async () => {
    const productId = await newProduct({ stock: 2 });
    const r = await requestReturn(productId, 5);
    const res = await act(r.id, 'approve');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUPPLIER_RETURN_INSUFFICIENT_STOCK');
    expect(res.body.error).toMatch(/disponível 2, a devolver 5/);
    expect((await row(r.id)).status).toBe('REQUESTED');
    expect((await row(r.id)).stockWithdrawnAt).toBeNull();
    expect(await movementsOf(r.id)).toHaveLength(0);
    expect(await balance(productId)).toBe(2);

    const negOk = await newProduct({ stock: 1, allowNegativeStock: true });
    const n = await requestReturn(negOk, 3);
    expect((await act(n.id, 'approve')).status).toBe(200);
    expect(await balance(negOk)).toBe(-2);
  });

  it('solicitante ≠ aprovador: quem pediu não aprova nem recusa a própria devolução (403)', async () => {
    const productId = await newProduct({ stock: 5 });
    const r = await requestReturn(productId, 1, MANAGER_A1());
    const approve = await act(r.id, 'approve', {}, MANAGER_A1());
    expect(approve.status).toBe(403);
    expect(approve.body.code).toBe('SUPPLIER_RETURN_SELF_DECISION');
    expect(approve.body.error).toMatch(/não pode aprovar a própria/);
    const reject = await act(r.id, 'reject', { reason: 'mudei de ideia' }, MANAGER_A1());
    expect(reject.status).toBe(403);
    expect(reject.body.code).toBe('SUPPLIER_RETURN_SELF_DECISION');
    expect((await row(r.id)).status).toBe('REQUESTED');
    // outro gerente aprova
    expect((await act(r.id, 'approve', {}, bearer(users.managerA1b.token))).status).toBe(200);
  });

  it('perfil sem permissão: operador não aprova/recusa/encerra; VIEWER só consulta; MECHANIC não entra; política muda quem aprova', async () => {
    const productId = await newProduct({ stock: 5 });
    const r = await requestReturn(productId, 1);

    const opApprove = await act(r.id, 'approve', {}, OPERATOR_A1());
    expect(opApprove.status).toBe(403);
    expect(opApprove.body.code).toBe('SUPPLIER_RETURN_APPROVER_REQUIRED');
    expect(opApprove.body.error).toMatch(/Gerente ou Administrador da empresa/);
    const opReject = await act(r.id, 'reject', { reason: 'não quero' }, OPERATOR_A1());
    expect(opReject.status).toBe(403);

    const viewerCreate = await create({ supplierId: A().supplierId, reason: 'OTHER', items: [{ productId, quantity: 1 }] }, as('VIEWER'));
    expect(viewerCreate.status).toBe(403);
    expect(viewerCreate.body.code).toBe('SUPPLIER_RETURN_FORBIDDEN');
    expect((await request(app).get('/api/supplier-returns').set(as('VIEWER'))).status).toBe(200);
    expect((await request(app).get('/api/supplier-returns').set(as('MECHANIC'))).status).toBe(403);
    expect((await create({ supplierId: A().supplierId, reason: 'OTHER', items: [{ productId, quantity: 1 }] }, as('MECHANIC'))).status).toBe(403);

    // Empresa restringe a aprovação ao administrador: gerente passa a receber 403, administrador aprova.
    const ctx = { companyId: A().companyId, userType: 'COMPANY_ADMIN' as const, branchId: null };
    await runWithRLSContext(ctx, () =>
      policyService.set({ companyId: A().companyId, key: 'supplierReturn.approverRoles', value: ['COMPANY_ADMIN'], reason: 'Teste: só administrador aprova', userId: users.adminA.id })
    );
    try {
      const mgr = await act(r.id, 'approve', {}, MANAGER_A1());
      expect(mgr.status).toBe(403);
      expect(mgr.body.code).toBe('SUPPLIER_RETURN_APPROVER_REQUIRED');
      expect(mgr.body.error).toMatch(/Administrador da empresa/);
      const adm = await act(r.id, 'approve', {}, ADMIN_A());
      expect(adm.status).toBe(200);
    } finally {
      await runWithRLSContext(ctx, () => policyService.reset({ companyId: A().companyId, key: 'supplierReturn.approverRoles', reason: 'Teste: volta ao padrão', userId: users.adminA.id }));
    }
  });

  it('transição inválida = 409 (nunca 500): enviar solicitada, encerrar aprovada, recusar aprovada, aprovar duas vezes', async () => {
    const productId = await newProduct({ stock: 5 });
    const r = await requestReturn(productId, 1);
    const send = await act(r.id, 'send', {}, OPERATOR_A1());
    expect(send.status).toBe(409);
    expect(send.body.code).toBe('SUPPLIER_RETURN_INVALID_TRANSITION');
    await act(r.id, 'approve');
    for (const [action, body] of [
      ['close', { outcome: 'CREDIT' }],
      ['reject', { reason: 'tarde demais' }],
      ['approve', {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const res = await act(r.id, action, body, ADMIN_A());
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SUPPLIER_RETURN_INVALID_TRANSITION');
    }
    expect((await movementsOf(r.id)).length).toBe(1);
    const unknownOutcome = await act(r.id, 'close', { outcome: 'VOUCHER' }, ADMIN_A());
    expect(unknownOutcome.status).toBe(400);
  });

  it('recusa exige motivo e não mexe no estoque', async () => {
    const productId = await newProduct({ stock: 5 });
    const r = await requestReturn(productId, 2);
    expect((await act(r.id, 'reject', {})).status).toBe(400);
    const res = await act(r.id, 'reject', { reason: 'Produto está bom, erro de conferência' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'REJECTED', decisionNotes: 'Produto está bom, erro de conferência' });
    expect(await movementsOf(r.id)).toHaveLength(0);
    expect(await balance(productId)).toBe(5);
  });

  it('corrida: duas aprovações simultâneas — só uma retira o estoque, a outra 409', async () => {
    const productId = await newProduct({ stock: 10 });
    const r = await requestReturn(productId, 4);
    const [a, b] = await Promise.all([act(r.id, 'approve', {}, MANAGER_A1()), act(r.id, 'approve', {}, ADMIN_A())]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(['SUPPLIER_RETURN_STATUS_CHANGED', 'SUPPLIER_RETURN_INVALID_TRANSITION']).toContain(loser.body.code);
    expect(await movementsOf(r.id)).toHaveLength(1);
    expect(await balance(productId)).toBe(6);
    const events = await bypass<any[]>(() => db.supplierReturnEvent.findMany({ where: { companyId: A().companyId, returnId: r.id, type: 'APPROVED' } }));
    expect(events).toHaveLength(1);
  });

  it('idempotência: a mesma Idempotency-Key na solicitação não cria duas devoluções', async () => {
    const productId = await newProduct({ stock: 5 });
    const body = { supplierId: A().supplierId, reason: 'WRONG_ITEM', items: [{ productId, quantity: 1 }] };
    const key = `sr-idem-${Date.now()}`;
    const first = await request(app).post('/api/supplier-returns').set({ ...OPERATOR_A1(), 'Idempotency-Key': key }).send(body);
    // A resposta é gravada na chave logo depois do envio (sem await no middleware): espera concluir antes de repetir.
    for (let i = 0; i < 50; i++) {
      const k = await bypass<any>(() => db.idempotencyKey.findFirst({ where: { companyId: A().companyId, key } }));
      if (k?.status === 'COMPLETED') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const second = await request(app).post('/api/supplier-returns').set({ ...OPERATOR_A1(), 'Idempotency-Key': key }).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    const count = await bypass<number>(() => db.supplierReturnItem.count({ where: { companyId: A().companyId, productId } }));
    expect(count).toBe(1);
  });

  it('item ligado a avaria: não sai do estoque de novo na aprovação; a mesma avaria não entra em duas devoluções', async () => {
    const productId = await newProduct({ stock: 6 });
    const damage = await bypass<any>(() =>
      db.damageRecord.create({ data: { companyId: A().companyId, branchId: A().branches[1].branchId, productId, quantity: 2, reason: 'DAMAGED', approvedBy: users.managerA1.id, recordedBy: users.managerA1.id } })
    );
    await bypass(() =>
      db.stockMovement.create({
        data: { companyId: A().companyId, branchId: A().branches[1].branchId, productId, movementType: 'LOSS', quantity: 2, referenceType: 'DamageRecord', referenceId: damage.id, userId: users.managerA1.id },
      })
    );
    expect(await balance(productId)).toBe(4);

    const res = await create({ supplierId: A().supplierId, reason: 'DAMAGED', items: [{ productId, quantity: 2, damageRecordId: damage.id }] });
    expect(res.status).toBe(201);
    expect((await act(res.body.id, 'approve')).status).toBe(200);
    expect(await movementsOf(res.body.id)).toHaveLength(0);
    expect(await balance(productId)).toBe(4);

    const dup = await create({ supplierId: A().supplierId, reason: 'DAMAGED', items: [{ productId, quantity: 1, damageRecordId: damage.id }] });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DAMAGE_RECORD_ALREADY_RETURNED');
  });

  it('validação: quantidade 0, sem itens, fornecedor/produto/filial de outra empresa → 400/403 com código', async () => {
    const productId = await newProduct({ stock: 5 });
    const zero = await create({ supplierId: A().supplierId, reason: 'DAMAGED', items: [{ productId, quantity: 0 }] });
    expect(zero.status).toBe(400);
    expect(zero.body.code).toBe('VALIDATION_ERROR');
    expect((await create({ supplierId: A().supplierId, reason: 'DAMAGED', items: [] })).status).toBe(400);
    expect((await create({ supplierId: A().supplierId, reason: 'BROKEN', items: [{ productId, quantity: 1 }] })).status).toBe(400);

    const otherSupplier = await create({ supplierId: B().supplierId, reason: 'DAMAGED', items: [{ productId, quantity: 1 }] });
    expect(otherSupplier.status).toBe(400);
    expect(otherSupplier.body.code).toBe('SUPPLIER_NOT_FOUND');
    const otherProduct = await create({ supplierId: A().supplierId, reason: 'DAMAGED', items: [{ productId: B().branches[1].productId, quantity: 1 }] });
    expect(otherProduct.status).toBe(400);
    expect(otherProduct.body.code).toBe('PRODUCT_NOT_FOUND');
    // produto cadastrado só na filial 2 não sai do estoque da filial 1
    const otherBranchProduct = await create({ supplierId: A().supplierId, reason: 'DAMAGED', items: [{ productId: A().branches[2].productId, quantity: 1 }] }, ADMIN_A());
    expect(otherBranchProduct.status).toBe(400);
    expect(otherBranchProduct.body.code).toBe('BRANCH_REQUIRED');
    const otherBranchProduct2 = await create(
      { supplierId: A().supplierId, branchId: A().branches[1].branchId, reason: 'DAMAGED', items: [{ productId: A().branches[2].productId, quantity: 1 }] },
      ADMIN_A()
    );
    expect(otherBranchProduct2.status).toBe(400);
    expect(otherBranchProduct2.body.code).toBe('PRODUCT_NOT_FOUND');
    // operador da filial 1 não grava na filial 2 (filial não vem do corpo sem validação)
    const otherBranch = await create({ supplierId: A().supplierId, branchId: A().branches[2].branchId, reason: 'DAMAGED', items: [{ productId, quantity: 1 }] });
    expect(otherBranch.status).toBe(403);
    expect(otherBranch.body.code).toBe('BRANCH_FORBIDDEN');
    // administrador (empresa inteira) informa filial de OUTRA empresa → 400
    const foreignBranch = await create({ supplierId: A().supplierId, branchId: B().branches[1].branchId, reason: 'DAMAGED', items: [{ productId, quantity: 1 }] }, ADMIN_A());
    expect(foreignBranch.status).toBe(400);
    expect(foreignBranch.body.code).toBe('BRANCH_NOT_FOUND');
    // companyId no corpo é ignorado: a devolução é da empresa do token
    const spoof = await create({ companyId: B().companyId, supplierId: A().supplierId, reason: 'DAMAGED', items: [{ productId, quantity: 1 }] });
    expect(spoof.status).toBe(201);
    expect(spoof.body.companyId).toBe(A().companyId);
  });

  it('isolamento: outra empresa 404 e não lista; outra filial não vê; administrador da empresa vê as duas filiais; numeração única por empresa', async () => {
    const p1 = await newProduct({ stock: 5 });
    const p2 = await newProduct({ branch: 2, stock: 5 });
    const r1 = await requestReturn(p1, 1);
    const r2 = await requestReturn(p2, 1, as('OPERATOR', 2));
    expect(r2.branchId).toBe(A().branches[2].branchId);
    // número único POR EMPRESA mesmo com operadores de filiais diferentes (a RLS esconde a outra filial)
    expect(r2.returnNumber).toBeGreaterThan(r1.returnNumber);

    const fromB = await request(app).get(`/api/supplier-returns/${r1.id}`).set(as('OPERATOR', 1, B()));
    expect(fromB.status).toBe(404);
    expect(fromB.body.code).toBe('SUPPLIER_RETURN_NOT_FOUND');
    const approveFromB = await act(r1.id, 'approve', {}, as('COMPANY_ADMIN', null, B()));
    expect(approveFromB.status).toBe(404);
    expect((await row(r1.id)).status).toBe('REQUESTED');
    const listB = await request(app).get('/api/supplier-returns?limit=100').set(as('COMPANY_ADMIN', null, B()));
    expect(listB.status).toBe(200);
    expect(listB.body.returns.some((x: any) => x.id === r1.id || x.id === r2.id)).toBe(false);

    const a2SeesA1 = await request(app).get(`/api/supplier-returns/${r1.id}`).set(as('OPERATOR', 2));
    expect(a2SeesA1.status).toBe(404);
    const listA2 = await request(app).get('/api/supplier-returns?limit=100').set(as('OPERATOR', 2));
    expect(listA2.body.returns.map((x: any) => x.id)).toContain(r2.id);
    expect(listA2.body.returns.map((x: any) => x.id)).not.toContain(r1.id);

    const listAdmin = await request(app).get('/api/supplier-returns?limit=100').set(ADMIN_A());
    const ids = listAdmin.body.returns.map((x: any) => x.id);
    expect(ids).toEqual(expect.arrayContaining([r1.id, r2.id]));
    expect(listAdmin.body.pagination.limit).toBe(100);
    const filtered = await request(app).get(`/api/supplier-returns?status=REQUESTED&supplierId=${A().supplierId}`).set(ADMIN_A());
    expect(filtered.body.returns.every((x: any) => x.status === 'REQUESTED' && x.supplierId === A().supplierId)).toBe(true);
    expect((await request(app).get('/api/supplier-returns?limit=500').set(ADMIN_A())).status).toBe(400);
  });

  it('módulo COMPRAS desligado: devolução ao fornecedor bloqueada (403 MODULE_DISABLED)', async () => {
    const co = B();
    await bypass(() => db.companyModuleSetting.create({ data: { companyId: co.companyId, branchId: null, module: 'COMPRAS', isEnabled: false, disabledReason: 'teste devolução' } }));
    await cacheService.delete(CacheKeys.moduleSettings(co.companyId));
    try {
      const list = await request(app).get('/api/supplier-returns').set(as('OPERATOR', 1, co));
      expect(list.status).toBe(403);
      expect(list.body.code).toBe('MODULE_DISABLED');
      const post = await create({ supplierId: co.supplierId, reason: 'DAMAGED', items: [{ productId: co.branches[1].productId, quantity: 1 }] }, as('OPERATOR', 1, co));
      expect(post.status).toBe(403);
      expect(post.body.code).toBe('MODULE_DISABLED');
    } finally {
      await bypass(() => db.companyModuleSetting.deleteMany({ where: { companyId: co.companyId, module: 'COMPRAS' } }));
      await cacheService.delete(CacheKeys.moduleSettings(co.companyId));
    }
  });
});
