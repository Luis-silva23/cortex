import { createHash } from 'crypto';
import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { isSealed } from '@ln-system/shared/utils/secret-box';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { advancedRateLimiter } from '../../src/middlewares/advancedRateLimit';
import { purgeExpiredExports } from '../../src/services/privacy/privacy.service';
import { createFixture, destroyFixture, IntegrationFixture, purgeNewDomainData } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const database = require('@ln-system/database');

/**
 * DECISÃO 120 — pedidos de titular (LGPD): exportação e anonimização de UM cliente (PostgreSQL real, duas empresas).
 * Prova: só COMPANY_ADMIN; senha e justificativa; titular inexistente e acesso cruzado = 404; o arquivo só traz o titular, fica cifrado,
 * expira e tem limite de downloads; a anonimização SOBRESCREVE no banco (não é só ocultar) preservando valores e vínculos financeiros;
 * retenção fiscal e de garantia = PARCIAL; cobrança em aberto = BLOQUEADO; falha no meio desfaz tudo; o pedido nunca guarda o dado original.
 */
describe('Pedidos de titular — exportação e anonimização (decisão 120)', () => {
  let A: IntegrationFixture;
  let B: IntegrationFixture;
  let app: express.Express;
  const stamp = Date.now();
  const PASSWORD = `Admin-${stamp}-Xk!`;
  let seq = 0;
  const created: string[] = [];
  let adminA: any;
  let adminB: any;
  let operatorA: any;
  let managerA: any;
  let viewerA: any;
  const token = (u: { id: string; email: string }, userType: string, companyId?: string | null) =>
    generateAccessToken({ userId: u.id, email: u.email, userType, companyId: companyId === null ? undefined : (companyId ?? A.companyId) });
  const tAdminA = () => `Bearer ${token(adminA, 'COMPANY_ADMIN')}`;
  const tAdminB = () => `Bearer ${token(adminB, 'COMPANY_ADMIN', B.companyId)}`;
  // o balde do autorizador (3 recusas por 5 min) é zerado a cada chamada: aqui se testam as REGRAS, não o limitador
const post = async (url: string, auth: string, body: unknown) => {
    await resetLimits();
    return request(app).post(url).set('Authorization', auth).send(body as object);
  };
  const get = (url: string, auth: string) => request(app).get(url).set('Authorization', auth);
  const asSuperAdmin = () => `Bearer ${token(adminA, 'SUPER_ADMIN', null)}`;
  const JUSTIFICATION = 'Pedido do titular por e-mail, protocolo 2026-0001';

  const mkUser = async (label: string, userType: string, fx: IntegrationFixture) => {
    const password = await hashPassword(PASSWORD);
    const user = await bypass<any>(() =>
      db.user.create({ data: { companyId: fx.companyId, branchId: fx.branchId, name: `Priv ${label}`, email: `priv-${label}-${stamp}@teste-cortex.local`, password, userType: userType as any, isActive: true } })
    );
    created.push(user.id);
    return user;
  };

  const mkCustomer = async (label: string, fx = A) => {
    seq += 1;
    return bypass<any>(() =>
      db.customer.create({
        data: {
          companyId: fx.companyId,
          name: `Cliente ${label} ${stamp}`,
          document: `5${String(stamp).slice(-5)}${String(seq).padStart(5, '0')}`,
          email: `${label}-${stamp}@pessoa-teste.invalid`,
          phone: `1130${String(seq).padStart(6, '0')}`,
          mobile: `1198${String(seq).padStart(6, '0')}`,
          whatsapp: `1197${String(seq).padStart(6, '0')}`,
          birthDate: new Date('1990-05-17'),
          address: `Rua Segredo ${label}, 123`,
          city: 'São Paulo',
          state: 'SP',
          zipCode: '01001000',
          notes: `observacao-secreta-${label}`,
        },
      })
    );
  };
  const mkBike = (c: any, label: string, fx = A) => {
    seq += 1;
    const n = String(seq).padStart(3, '0');
    return bypass<any>(() =>
      db.motorcycle.create({ data: { companyId: fx.companyId, customerId: c.id, brand: 'Honda', model: 'CG 160', kilometerReading: 1000, licensePlate: `T${String(stamp).slice(-4)}${n}`, chassisNumber: `CHASSI-${label}-${n}`, engineNumber: `MOTOR-${label}-${n}` } })
    );
  };
  const mkSale = (c: any, label: string, fx = A) => {
    seq += 1;
    return bypass<any>(() =>
      db.sale.create({ data: { companyId: fx.companyId, branchId: fx.branchId, saleNumber: Number(`9${String(stamp).slice(-6)}${seq}`), customerId: c.id, userId: fx.userId, cashRegisterId: fx.cashRegisterId, subtotal: 100, totalAmount: 100, paidAmount: 100, status: 'PAID', notes: `nota-venda-${label}` } })
    );
  };
  const mkReceivable = (c: any, status: 'PAID' | 'PENDING', label: string, fx = A) =>
    bypass<any>(() =>
      db.accountsReceivable.create({ data: { companyId: fx.companyId, branchId: fx.branchId, customerId: c.id, description: `Fiado ${label}`, amount: 80, dueDate: new Date(), status, paidDate: status === 'PAID' ? new Date() : null, notes: `nota-receber-${label}` } })
    );
  const resetLimits = async () => {
    for (const u of [adminA, adminB, operatorA]) if (u) await advancedRateLimiter.reset('authorizer', `user:${u.id}`);
  };

  beforeAll(async () => {
    A = await createFixture('privA');
    B = await createFixture('privB');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    adminA = await mkUser('adminA', 'COMPANY_ADMIN', A);
    adminB = await mkUser('adminB', 'COMPANY_ADMIN', B);
    operatorA = await mkUser('operatorA', 'OPERATOR', A);
    managerA = await mkUser('managerA', 'MANAGER', A);
    viewerA = await mkUser('viewerA', 'VIEWER', A);
  }, 60000);

  beforeEach(resetLimits);

  afterAll(async () => {
    for (const fx of [A, B]) {
      if (!fx?.companyId) continue;
      await purgeNewDomainData(fx.companyId); // tentativas de cobrança são append-only: só saem pelo expurgo de teste
      await bypass(() => db.accountsReceivable.deleteMany({ where: { companyId: fx.companyId } }));
      await bypass(() => db.fiscalDocument.deleteMany({ where: { companyId: fx.companyId } }));
      await bypass(() => db.serviceOrderWarranty.deleteMany({ where: { companyId: fx.companyId } }));
      await bypass(() => db.revision.deleteMany({ where: { companyId: fx.companyId } }));
      await bypass(() => db.privacyRequest.deleteMany({ where: { companyId: fx.companyId } }));
    }
    if (created.length) await bypass(() => db.user.deleteMany({ where: { id: { in: created }, OR: [{ companyId: A?.companyId }, { companyId: B?.companyId }] } }));
    if (A?.companyId) await destroyFixture(A);
    if (B?.companyId) await destroyFixture(B);
  }, 60000);

  // ---------------------------------------------------------------------------------------------------- autorização
  it('só o COMPANY_ADMIN: operador, gerente, consulta, Super Admin e sem login são recusados em todas as rotas', async () => {
    const c = await mkCustomer('autz');
    const other = [
      [`Bearer ${token(operatorA, 'OPERATOR')}`, 403],
      [`Bearer ${token(managerA, 'MANAGER')}`, 403],
      [`Bearer ${token(viewerA, 'VIEWER')}`, 403],
    ] as const;
    for (const [auth, status] of other) {
      expect((await post('/api/privacy/requests', auth, { type: 'EXPORT', customerId: c.id, justification: JUSTIFICATION, password: PASSWORD })).status).toBe(status);
      expect((await get('/api/privacy/requests', auth)).status).toBe(status);
    }
    // Super Admin: sem empresa-alvo cai na exigência de empresa (400); com empresa-alvo informada, no perfil (403) — nunca atende
    expect((await get('/api/privacy/requests', asSuperAdmin())).status).toBe(400);
    expect((await get(`/api/privacy/requests?companyId=${A.companyId}`, asSuperAdmin())).status).toBe(403);
    expect((await post(`/api/privacy/requests?companyId=${A.companyId}`, asSuperAdmin(), { type: 'EXPORT', customerId: c.id, justification: JUSTIFICATION, password: PASSWORD })).status).toBe(403);
    expect((await request(app).get('/api/privacy/requests')).status).toBe(401);
    expect(await bypass<number>(() => db.privacyRequest.count({ where: { companyId: A.companyId } }))).toBe(0); // nada foi criado
  });

  it('exige justificativa, senha do administrador e titular da própria empresa (inexistente = 404)', async () => {
    const c = await mkCustomer('regras');
    const base = { type: 'EXPORT', customerId: c.id, justification: JUSTIFICATION, password: PASSWORD };
    expect((await post('/api/privacy/requests', tAdminA(), { ...base, justification: 'curta' })).status).toBe(400);
    expect((await post('/api/privacy/requests', tAdminA(), { ...base, password: undefined })).status).toBe(400);
    expect((await post('/api/privacy/requests', tAdminA(), { ...base, password: 'senha-errada-xyz' })).status).toBe(401);
    expect((await post('/api/privacy/requests', tAdminA(), { ...base, type: 'APAGAR_TUDO' })).status).toBe(400);
    const none = await post('/api/privacy/requests', tAdminA(), { ...base, customerId: '00000000-0000-0000-0000-000000000000' });
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('SUBJECT_NOT_FOUND');
    expect((await post('/api/privacy/requests', tAdminA(), { ...base, customerId: undefined })).status).toBe(400);
    expect(await bypass<number>(() => db.privacyRequest.count({ where: { companyId: A.companyId, subjectId: c.id } }))).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------------- exportação
  it('exportação autorizada: arquivo estruturado só do titular, cifrado em repouso, com hash e auditoria — sem dado de outro cliente', async () => {
    const c = await mkCustomer('exp');
    const other = await mkCustomer('outro');
    await mkBike(c, 'x');
    await mkSale(c, 'exp');
    await mkSale(other, 'outro');
    await mkReceivable(c, 'PAID', 'exp');
    const created1 = await post('/api/privacy/requests', tAdminA(), { type: 'EXPORT', customerId: c.id, justification: JUSTIFICATION, password: PASSWORD });
    expect(created1.status).toBe(201);
    const id = created1.body.data.id;
    expect(created1.body.data.status).toBe('COMPLETED');
    expect(created1.body.data.exportAvailable).toBe(true);
    expect(created1.body.data.result.counts).toMatchObject({ vehicles: 1, sales: 1, receivables: 1 });
    expect(created1.body.data).not.toHaveProperty('exportPayload');

    // em repouso: cifrado, sem o e-mail do titular em claro
    const row = await bypass<any>(() => db.privacyRequest.findUnique({ where: { id } }));
    expect(isSealed(row.exportPayload)).toBe(true);
    expect(row.exportPayload).not.toContain(c.email);
    expect(row.exportExpiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(row.exportExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600_000);

    const file = await get(`/api/privacy/requests/${id}/download`, tAdminA());
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="titular-/);
    expect(file.headers['cache-control']).toContain('no-store');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['x-content-sha256']).toBe(createHash('sha256').update(file.text).digest('hex'));
    const doc = JSON.parse(file.text);
    expect(doc.schema).toBe('cortex.data-subject-export.v1');
    expect(doc.subject).toEqual({ type: 'CUSTOMER', id: c.id });
    expect(doc.customer.email).toBe(c.email);
    expect(doc.customer.companyId).toBeUndefined();
    expect(doc.vehicles).toHaveLength(1);
    expect(doc.sales).toHaveLength(1);
    expect(doc.sales[0].itemsCount).toBe(0);
    // minimização: nada do outro cliente nem de pagamento
    expect(file.text).not.toContain(other.email);
    expect(file.text).not.toContain(other.document);
    expect(file.text).not.toContain('nota-venda-outro');

    const audits = await bypass<any[]>(() => db.auditLog.findMany({ where: { entity: 'PrivacyRequest', entityId: id } }));
    expect(audits.map((a) => a.newValue).join(' ')).toContain('PRIVACY_EXPORT_CREATED');
    expect(audits.map((a) => a.newValue).join(' ')).toContain('PRIVACY_EXPORT_DOWNLOADED');
    expect(JSON.stringify(audits)).not.toContain(c.email); // o ato é auditado, o dado pessoal não
  });

  it('acesso cruzado: o administrador de OUTRA empresa não exporta, não planeja, não lista, não vê nem baixa (404)', async () => {
    const c = await mkCustomer('cruz');
    const mine = await post('/api/privacy/requests', tAdminA(), { type: 'EXPORT', customerId: c.id, justification: JUSTIFICATION, password: PASSWORD });
    const id = mine.body.data.id;
    const attempt = await post('/api/privacy/requests', tAdminB(), { type: 'EXPORT', customerId: c.id, justification: JUSTIFICATION, password: PASSWORD });
    expect(attempt.status).toBe(404);
    expect((await post('/api/privacy/requests', tAdminB(), { type: 'ANONYMIZE', customerId: c.id, justification: JUSTIFICATION })).status).toBe(404);
    expect((await get(`/api/privacy/requests/${id}`, tAdminB())).status).toBe(404);
    expect((await get(`/api/privacy/requests/${id}/download`, tAdminB())).status).toBe(404);
    expect((await post(`/api/privacy/requests/${id}/execute`, tAdminB(), { password: PASSWORD })).status).toBe(404);
    const listB = await get('/api/privacy/requests', tAdminB());
    expect(listB.body.data.map((r: any) => r.id)).not.toContain(id);
    expect(await bypass<number>(() => db.privacyRequest.count({ where: { companyId: B.companyId } }))).toBe(0);
    // e o dono continua enxergando e baixando
    expect((await get(`/api/privacy/requests/${id}/download`, tAdminA())).status).toBe(200);
  });

  it('arquivo vence e some: no 4º download (limite 3), depois da validade e pela rotina de limpeza — conteúdo apagado do banco', async () => {
    const c = await mkCustomer('venc');
    const mk = async () => (await post('/api/privacy/requests', tAdminA(), { type: 'EXPORT', customerId: c.id, justification: JUSTIFICATION, password: PASSWORD })).body.data.id as string;
    const limited = await mk();
    for (let i = 0; i < 3; i += 1) expect((await get(`/api/privacy/requests/${limited}/download`, tAdminA())).status).toBe(200);
    const fourth = await get(`/api/privacy/requests/${limited}/download`, tAdminA());
    expect(fourth.status).toBe(410);
    expect(fourth.body.code).toBe('EXPORT_EXPIRED');
    expect((await bypass<any>(() => db.privacyRequest.findUnique({ where: { id: limited } }))).exportPayload).toBeNull();

    const expired = await mk();
    await bypass(() => db.privacyRequest.update({ where: { id: expired }, data: { exportExpiresAt: new Date(Date.now() - 1000) } }));
    expect((await get(`/api/privacy/requests/${expired}/download`, tAdminA())).status).toBe(410);
    expect((await bypass<any>(() => db.privacyRequest.findUnique({ where: { id: expired } }))).exportPayload).toBeNull();

    const forJob = await mk();
    await bypass(() => db.privacyRequest.update({ where: { id: forJob }, data: { exportExpiresAt: new Date(Date.now() - 1000) } }));
    expect(await purgeExpiredExports()).toBeGreaterThanOrEqual(1);
    const purged = await bypass<any>(() => db.privacyRequest.findUnique({ where: { id: forJob } }));
    expect(purged.exportPayload).toBeNull();
    expect(purged.exportPurgedAt).not.toBeNull();
    const view = await get(`/api/privacy/requests/${forJob}`, tAdminA());
    expect(view.body.data.exportAvailable).toBe(false);
  });

  it('limite de pedidos por hora: depois de 20 no mesmo administrador, 429', async () => {
    const c = await mkCustomer('taxa');
    const since = new Date();
    await bypass(() =>
      db.privacyRequest.createMany({
        data: Array.from({ length: 20 }, () => ({ companyId: A.companyId, requestType: 'EXPORT', subjectId: c.id, status: 'COMPLETED', justification: 'carga de teste do limite', requestedBy: adminA.id, requestedAt: since })),
      })
    );
    const res = await post('/api/privacy/requests', tAdminA(), { type: 'EXPORT', customerId: c.id, justification: JUSTIFICATION, password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('PRIVACY_RATE_LIMIT');
    await bypass(() => db.privacyRequest.deleteMany({ where: { companyId: A.companyId, justification: 'carga de teste do limite' } }));
  });

  // ---------------------------------------------------------------------------------------------------- anonimização
  const plan = async (c: any) => {
    const res = await post('/api/privacy/requests', tAdminA(), { type: 'ANONYMIZE', customerId: c.id, justification: JUSTIFICATION });
    expect(res.status).toBe(201);
    return res.body.data;
  };
  const execute = (id: string, password: string | null = PASSWORD) => post(`/api/privacy/requests/${id}/execute`, tAdminA(), { password: password ?? undefined });

  it('anonimização completa: o cadastro e os textos são SOBRESCRITOS no banco, valores e vínculos financeiros ficam, e o pedido não guarda o original', async () => {
    const c = await mkCustomer('anon');
    const bike = await mkBike(c, 'a');
    const sale = await mkSale(c, 'anon');
    const rec = await mkReceivable(c, 'PAID', 'anon');
    const planned = await plan(c);
    expect(planned.status).toBe('PLANNED');
    expect(planned.plan.blocked).toEqual([]);
    expect(planned.plan.willAnonymize.customerFields).toContain('name');
    expect((await execute(planned.id, null)).status).toBe(400); // sem senha
    expect((await execute(planned.id, 'senha-errada-xyz')).status).toBe(401);
    expect((await bypass<any>(() => db.customer.findUnique({ where: { id: c.id } }))).email).toBe(c.email); // nada mudou

    const done = await execute(planned.id);
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('COMPLETED');
    expect(done.body.data.result.counts).toMatchObject({ customer: 1, motorcycles: 1, sales: 1, receivables: 1 });
    expect(done.body.data.result.outOfScope).toContain('AUDIT_TRAIL');

    const after = await bypass<any>(() => db.customer.findUnique({ where: { id: c.id } }));
    expect(after.name).toBe(`Titular anonimizado ${c.id.slice(0, 8)}`);
    for (const f of ['document', 'email', 'phone', 'mobile', 'whatsapp', 'birthDate', 'address', 'city', 'state', 'zipCode', 'notes']) expect(after[f]).toBeNull();
    expect(after.isActive).toBe(false);
    expect(after.anonymizedAt).not.toBeNull();
    const bikeAfter = await bypass<any>(() => db.motorcycle.findUnique({ where: { id: bike.id } }));
    expect([bikeAfter.licensePlate, bikeAfter.chassisNumber, bikeAfter.engineNumber]).toEqual([null, null, null]);
    expect(bikeAfter.brand).toBe('Honda'); // o que não identifica a pessoa fica
    // financeiro intacto: mesma linha, mesmos valores, mesmo vínculo; só o texto livre saiu
    const saleAfter = await bypass<any>(() => db.sale.findUnique({ where: { id: sale.id } }));
    expect(Number(saleAfter.totalAmount)).toBe(100);
    expect(saleAfter.customerId).toBe(c.id);
    expect(saleAfter.notes).toBeNull();
    const recAfter = await bypass<any>(() => db.accountsReceivable.findUnique({ where: { id: rec.id } }));
    expect(Number(recAfter.amount)).toBe(80);
    expect(recAfter.notes).toBeNull();

    // o registro do pedido NÃO contém o dado original
    const requestRow = await bypass<any>(() => db.privacyRequest.findUnique({ where: { id: planned.id } }));
    const blob = JSON.stringify(requestRow);
    for (const secret of [c.email, c.document, c.phone, c.address, c.notes, bike.licensePlate, bike.chassisNumber, 'nota-venda-anon']) expect(blob).not.toContain(secret);
    // exportar depois: só o que sobrou (anonimizado)
    const exp = await post('/api/privacy/requests', tAdminA(), { type: 'EXPORT', customerId: c.id, justification: JUSTIFICATION, password: PASSWORD });
    const file = await get(`/api/privacy/requests/${exp.body.data.id}/download`, tAdminA());
    expect(file.text).not.toContain(c.email);
    expect(file.text).toContain('Titular anonimizado');
    // executar de novo: recusado; planejar de novo: já anonimizado
    expect((await execute(planned.id)).status).toBe(409);
    const again = await plan(c);
    expect(again.plan.blocked).toEqual([{ code: 'ALREADY_ANONYMIZED', count: 1 }]);
    const blocked = await execute(again.id);
    expect(blocked.body.data.status).toBe('BLOCKED');
  });

  it('retenção FISCAL: documento autorizado recente mantém nome e CPF/CNPJ (e as notas da venda) até o fim do prazo; o contato é apagado → PARCIAL', async () => {
    const c = await mkCustomer('fisc');
    const sale = await mkSale(c, 'fisc');
    seq += 1;
    await bypass(() => db.fiscalDocument.create({ data: { companyId: A.companyId, branchId: A.branchId, documentType: 'NFCE', status: 'AUTHORIZED', series: '1', number: Number(`8${String(stamp).slice(-6)}${seq}`), totalAmount: 100, saleId: sale.id, authorizedAt: new Date(), issuedAt: new Date() } }));
    const planned = await plan(c);
    expect(planned.plan.retain).toEqual([expect.objectContaining({ category: 'CUSTOMER_IDENTIFICATION', reason: 'FISCAL_DOCUMENT_RETENTION', fields: ['name', 'document'] })]);
    const done = await execute(planned.id);
    expect(done.body.data.status).toBe('PARTIAL');
    const retainedUntil = new Date(done.body.data.retainedUntil);
    expect(retainedUntil.getUTCFullYear()).toBe(new Date().getUTCFullYear() + 5);
    const after = await bypass<any>(() => db.customer.findUnique({ where: { id: c.id } }));
    expect(after.name).toBe(c.name);
    expect(after.document).toBe(c.document);
    expect([after.email, after.phone, after.mobile, after.whatsapp, after.address, after.notes]).toEqual([null, null, null, null, null, null]);
    expect((await bypass<any>(() => db.sale.findUnique({ where: { id: sale.id } }))).notes).toBe('nota-venda-fisc'); // venda com documento fiscal: intacta
  });

  it('retenção de GARANTIA: veículo com garantia vigente mantém placa/chassi/motor; o cadastro do titular é anonimizado → PARCIAL', async () => {
    const c = await mkCustomer('gar');
    const bike = await mkBike(c, 'g');
    seq += 1;
    const order = await bypass<any>(() =>
      db.serviceOrder.create({ data: { companyId: A.companyId, branchId: A.branchId, osNumber: Number(`7${String(stamp).slice(-6)}${seq}`), customerId: c.id, motorcycleId: bike.id, status: 'ENCERRADA', entryDate: new Date(), entryKilometer: 1000, finalTotal: 50, entryNotes: 'entrada-secreta', personalItems: 'capacete-com-nome' } })
    );
    await bypass(() => db.serviceOrderWarranty.create({ data: { companyId: A.companyId, branchId: A.branchId, serviceOrderId: order.id, customerId: c.id, motorcycleId: bike.id, coverage: 'Motor', durationValue: 6, durationUnit: 'MONTHS', startDate: new Date(), validUntil: new Date(Date.now() + 90 * 86400_000), createdBy: adminA.id, notes: 'garantia-obs' } }));
    const planned = await plan(c);
    expect(planned.plan.retain.map((r: any) => r.reason)).toEqual(['ACTIVE_WARRANTY']);
    const done = await execute(planned.id);
    expect(done.body.data.status).toBe('PARTIAL');
    const bikeAfter = await bypass<any>(() => db.motorcycle.findUnique({ where: { id: bike.id } }));
    expect(bikeAfter.licensePlate).toBe(bike.licensePlate);
    expect(bikeAfter.chassisNumber).toBe(bike.chassisNumber);
    const after = await bypass<any>(() => db.customer.findUnique({ where: { id: c.id } }));
    expect(after.name).toMatch(/^Titular anonimizado/);
    const orderAfter = await bypass<any>(() => db.serviceOrder.findUnique({ where: { id: order.id } }));
    expect([orderAfter.entryNotes, orderAfter.personalItems]).toEqual([null, null]);
    expect(Number(orderAfter.finalTotal)).toBe(50);
  });

  it('tentativa de cobrança é evidência append-only: o destinatário NÃO é reescrito e o pedido sai PARCIAL dizendo isso', async () => {
    const c = await mkCustomer('evid');
    const rec = await mkReceivable(c, 'PAID', 'evid');
    const attempt = await bypass<any>(() => db.collectionAttempt.create({ data: { companyId: A.companyId, receivableId: rec.id, channel: 'WHATSAPP', recipient: '11988887777', amount: 80, dueDate: new Date(), status: 'SENT', sentBy: adminA.id } }));
    const done = await execute((await plan(c)).id);
    expect(done.body.data.status).toBe('PARTIAL');
    expect(done.body.data.result.retained).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'COLLECTION_ATTEMPT_RECIPIENT', reason: 'APPEND_ONLY_EVIDENCE', count: 1 })]));
    expect((await bypass<any>(() => db.collectionAttempt.findUnique({ where: { id: attempt.id } }))).recipient).toBe('11988887777');
    expect((await bypass<any>(() => db.customer.findUnique({ where: { id: c.id } }))).email).toBeNull(); // o cadastro foi anonimizado
  });

  it('cobrança EM ABERTO bloqueia (nada muda); depois de quitada, a anonimização passa', async () => {
    const c = await mkCustomer('aberto');
    const rec = await mkReceivable(c, 'PENDING', 'aberto');
    const planned = await plan(c);
    expect(planned.plan.blocked).toEqual([{ code: 'OPEN_RECEIVABLES', count: 1 }]);
    const res = await execute(planned.id);
    expect(res.body.data.status).toBe('BLOCKED');
    expect(res.body.data.result.blocked).toEqual([{ code: 'OPEN_RECEIVABLES', count: 1 }]);
    const unchanged = await bypass<any>(() => db.customer.findUnique({ where: { id: c.id } }));
    expect(unchanged.email).toBe(c.email);
    expect(unchanged.anonymizedAt).toBeNull();
    await bypass(() => db.accountsReceivable.update({ where: { id: rec.id }, data: { status: 'PAID', paidDate: new Date() } }));
    const second = await plan(c);
    expect((await execute(second.id)).body.data.status).toBe('COMPLETED');
    expect((await bypass<any>(() => db.customer.findUnique({ where: { id: c.id } }))).email).toBeNull();
  });

  it('FALHA NO MEIO desfaz TUDO (uma transação): o pedido vira FAILED, nada foi alterado e dá para tentar de novo', async () => {
    const c = await mkCustomer('falha');
    const bike = await mkBike(c, 'f');
    await mkReceivable(c, 'PAID', 'falha');
    const planned = await plan(c);
    const real = database.runInTransaction;
    const spy = jest.spyOn(database, 'runInTransaction').mockImplementation(((fn: any, opts: any) =>
      real(
        async (tx: any) =>
          fn(
            new Proxy(tx, {
              get(target, prop, receiver) {
                if (prop === 'appointment') return { updateMany: () => Promise.reject(new Error('falha simulada no meio')) };
                return Reflect.get(target, prop, receiver);
              },
            })
          ),
        opts
      )) as any);
    let failed: any;
    try {
      failed = await execute(planned.id);
    } finally {
      spy.mockRestore();
    }
    expect(failed.status).toBe(500);
    expect(failed.body.code).toBe('ANONYMIZATION_FAILED');
    expect(failed.body.error).toMatch(/Nada foi alterado/);
    const customer = await bypass<any>(() => db.customer.findUnique({ where: { id: c.id } }));
    expect(customer.name).toBe(c.name);
    expect(customer.email).toBe(c.email);
    expect(customer.anonymizedAt).toBeNull();
    expect((await bypass<any>(() => db.motorcycle.findUnique({ where: { id: bike.id } }))).licensePlate).toBe(bike.licensePlate);
    expect((await bypass<any>(() => db.privacyRequest.findUnique({ where: { id: planned.id } }))).status).toBe('FAILED');
    // novo pedido, agora sem falha: conclui
    const retry = await plan(c);
    expect((await execute(retry.id)).body.data.status).toBe('COMPLETED');
  });
});
