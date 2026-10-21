import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS as db } from '@ln-system/database';
import { hashPassword } from '@ln-system/shared/utils/password';
import { World, BranchData, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * AÇÕES ESPECIAIS fora do escopo (a matriz tenant-branch-matrix cobre GET/listas/PUT/DELETE; aqui as ações de
 * estado: cancelar, estornar, aprovar, confirmar, fechar, atribuir…). Dois atores com PERMISSÃO para a ação:
 *  - COMPANY_ADMIN de A contra registros de B (outra empresa);
 *  - MANAGER de A1 com perfil que concede tudo contra registros de A2 (outra filial).
 * Toda chamada tem de ser recusada e a linha do banco tem de ficar idêntica. Um controle positivo por registro prova
 * que o corpo é válido (a recusa é de escopo, não de validação).
 */
type Model = 'payment' | 'sale' | 'serviceOrder' | 'quote' | 'purchaseOrder' | 'appointment' | 'followUp' | 'damageRecord' | 'inventory' | 'accountsPayable' | 'accountsReceivable';
type Action = { name: string; method: 'post' | 'put'; path: (id: string) => string; body: () => object; model: Model; id: (d: BranchData) => string };

describe('Ações especiais respeitam empresa e filial (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let authorizer: { numericId: number; password: string };
  let mechanicA: string;
  const stamp = `sa-${Date.now()}`;

  const A = () => world.A;
  const companyAdmin = () => bearer(tokenFor(A(), null, 'COMPANY_ADMIN'));
  const managerA1 = () => bearer(tokenFor(A(), 1, 'MANAGER'));
  const row = (model: Model, id: string) => bypass<any>(() => (db as any)[model].findUnique({ where: { id } }));

  const ACTIONS: Action[] = [
    { name: 'cancelar pagamento', method: 'post', path: (id) => `/api/payments/${id}/cancel`, body: () => ({ reason: 'teste de escopo' }), model: 'payment', id: (d) => d.paymentId },
    { name: 'estornar pagamento', method: 'post', path: (id) => `/api/payments/${id}/refund`, body: () => ({ reason: 'teste de escopo' }), model: 'payment', id: (d) => d.paymentId },
    { name: 'conciliar pagamento', method: 'post', path: (id) => `/api/payments/${id}/reconcile`, body: () => ({}), model: 'payment', id: (d) => d.paymentId },
    {
      name: 'cancelar venda', method: 'post', path: (id) => `/api/sales/${id}/cancel`, model: 'sale', id: (d) => d.saleId,
      body: () => ({ reason: 'teste de escopo', authorizerNumericId: authorizer.numericId, authorizerPassword: authorizer.password }),
    },
    { name: 'atribuir mecânico à OS', method: 'post', path: (id) => `/api/service-orders/${id}/mechanic`, body: () => ({ mechanicId: mechanicA }), model: 'serviceOrder', id: (d) => d.serviceOrderId },
    { name: 'previsão de entrega da OS', method: 'put', path: (id) => `/api/service-orders/${id}/estimated-delivery`, body: () => ({ estimatedDelivery: new Date(Date.now() + 86_400_000).toISOString() }), model: 'serviceOrder', id: (d) => d.serviceOrderId },
    { name: 'enviar orçamento', method: 'post', path: (id) => `/api/quotes/${id}/send`, body: () => ({ versionNumber: 1 }), model: 'quote', id: (d) => d.quoteId },
    { name: 'cancelar compra', method: 'post', path: (id) => `/api/purchase-orders/${id}/cancel`, body: () => ({ reason: 'teste de escopo' }), model: 'purchaseOrder', id: (d) => d.purchaseOrderId },
    { name: 'aprovar compra', method: 'post', path: (id) => `/api/purchase-orders/${id}/approve`, body: () => ({}), model: 'purchaseOrder', id: (d) => d.purchaseOrderId },
    { name: 'confirmar agendamento', method: 'post', path: (id) => `/api/appointments/${id}/confirm`, body: () => ({ channel: 'PHONE', confirmedByName: 'Cliente Teste' }), model: 'appointment', id: (d) => d.appointmentId },
    { name: 'cancelar agendamento', method: 'post', path: (id) => `/api/appointments/${id}/cancel`, body: () => ({ reason: 'teste' }), model: 'appointment', id: (d) => d.appointmentId },
    { name: 'concluir agendamento', method: 'post', path: (id) => `/api/appointments/${id}/complete`, body: () => ({}), model: 'appointment', id: (d) => d.appointmentId },
    { name: 'faltou ao agendamento', method: 'post', path: (id) => `/api/appointments/${id}/no-show`, body: () => ({}), model: 'appointment', id: (d) => d.appointmentId },
    { name: 'contato de pós-venda', method: 'post', path: (id) => `/api/follow-ups/${id}/contact`, body: () => ({ channel: 'PHONE' }), model: 'followUp', id: (d) => d.followUpId },
    { name: 'aceite de pós-venda', method: 'post', path: (id) => `/api/follow-ups/${id}/accept`, body: () => ({}), model: 'followUp', id: (d) => d.followUpId },
    { name: 'recusa de pós-venda', method: 'post', path: (id) => `/api/follow-ups/${id}/decline`, body: () => ({}), model: 'followUp', id: (d) => d.followUpId },
    { name: 'cancelar pós-venda', method: 'post', path: (id) => `/api/follow-ups/${id}/cancel`, body: () => ({}), model: 'followUp', id: (d) => d.followUpId },
    { name: 'reverter avaria', method: 'post', path: (id) => `/api/damage/${id}/reverse`, body: () => ({ reason: 'teste de escopo' }), model: 'damageRecord', id: (d) => d.damageId },
    { name: 'fechar inventário', method: 'post', path: (id) => `/api/inventory/${id}/close`, body: () => ({}), model: 'inventory', id: (d) => d.inventoryId },
    { name: 'cancelar inventário', method: 'post', path: (id) => `/api/inventory/${id}/cancel`, body: () => ({ reason: 'teste de escopo' }), model: 'inventory', id: (d) => d.inventoryId },
    { name: 'pagar conta a pagar', method: 'post', path: (id) => `/api/financial/payables/${id}/pay`, body: () => ({}), model: 'accountsPayable', id: (d) => d.payableId },
    { name: 'cancelar conta a pagar', method: 'post', path: (id) => `/api/financial/payables/${id}/cancel`, body: () => ({ reason: 'teste' }), model: 'accountsPayable', id: (d) => d.payableId },
    { name: 'receber conta a receber', method: 'post', path: (id) => `/api/financial/receivables/${id}/receive`, body: () => ({}), model: 'accountsReceivable', id: (d) => d.receivableId },
    { name: 'cancelar conta a receber', method: 'post', path: (id) => `/api/financial/receivables/${id}/cancel`, body: () => ({ reason: 'teste' }), model: 'accountsReceivable', id: (d) => d.receivableId },
  ];

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);

    const password = 'Autoriza-123!';
    const hashed = await hashPassword(password);
    const auth = await bypass<any>(() =>
      db.user.create({ data: { companyId: A().companyId, branchId: A().branches[1].branchId, name: 'Autorizador', email: `${stamp}-auth@test.local`, password: hashed, userType: 'MANAGER', isActive: true } })
    );
    authorizer = { numericId: auth.numericId, password };
    mechanicA = (
      await bypass<any>(() =>
        db.user.create({ data: { companyId: A().companyId, branchId: A().branches[1].branchId, name: 'Mecânico', email: `${stamp}-mec@test.local`, password: 'not-a-real-hash', userType: 'MECHANIC', isActive: true } })
      )
    ).id;

    // o gerente de A1 recebe (na empresa toda) todas as permissões das ações — só o escopo pode barrá-lo
    const role = await bypass<any>(() => db.role.create({ data: { companyId: A().companyId, name: `${stamp}-tudo` } }));
    for (const name of ['finance:manage', 'finance:pay', 'finance:reverse', 'purchases:manage', 'purchases:approve', 'purchases:receive', 'stock:adjust']) {
      const perm = await bypass<any>(() => db.permission.create({ data: { companyId: A().companyId, name } }));
      await bypass(() => db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } }));
    }
    await bypass(() => db.userRole.create({ data: { userId: A().branches[1].userId, roleId: role.id, branchId: null } }));
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    if (world) {
      await bypass(() => db.userRole.deleteMany({ where: { role: { companyId: A().companyId } } }));
      await bypass(() => db.rolePermission.deleteMany({ where: { role: { companyId: A().companyId } } }));
      await bypass(() => db.role.deleteMany({ where: { companyId: A().companyId, name: { startsWith: stamp } } }));
      await bypass(() => db.permission.deleteMany({ where: { companyId: A().companyId } }));
      await bypass(() => db.inventoryCount.deleteMany({ where: { inventory: { companyId: A().companyId } } }));
      await bypass(() => db.user.deleteMany({ where: { companyId: A().companyId, email: { startsWith: stamp } } }));
      await destroyWorld(world);
    }
  }, 120000);

  describe.each(ACTIONS)('$name', (action) => {
    it.each([
      ['COMPANY_ADMIN de A → registro de B1', () => world.B.branches[1], companyAdmin],
      ['MANAGER de A1 (com a permissão) → registro de A2', () => A().branches[2], managerA1],
    ] as const)('%s: recusado e intacto', async (_label, target, auth) => {
      const id = action.id(target());
      const before = await row(action.model, id);
      const res = await (request(app) as any)[action.method](action.path(id)).set(auth()).send(action.body());
      expect([action.name, res.status >= 400]).toEqual([action.name, true]);
      expect(JSON.stringify(await row(action.model, id))).toBe(JSON.stringify(before));
    });
  });

  // um controle por registro: a mesma chamada no registro da própria filial passa
  describe('controles positivos (corpo válido; a recusa acima é de escopo)', () => {
    const CONTROLS = ['cancelar pagamento', 'cancelar venda', 'atribuir mecânico à OS', 'enviar orçamento', 'cancelar compra', 'confirmar agendamento', 'contato de pós-venda', 'reverter avaria', 'cancelar inventário', 'pagar conta a pagar', 'receber conta a receber'];
    it.each(CONTROLS)('%s no registro de A1', async (name) => {
      const action = ACTIONS.find((a) => a.name === name)!;
      const res = await (request(app) as any)[action.method](action.path(action.id(A().branches[1]))).set(managerA1()).send(action.body());
      expect([name, res.status, res.status < 300]).toEqual([name, res.status, true]);
    });
  });
});
