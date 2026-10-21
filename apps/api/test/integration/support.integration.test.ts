import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prisma, prismaUnsafeBypassRLS as db, runWithRLSContext } from '@ln-system/database';
import { generateAccessToken } from '@ln-system/shared/utils/token';
import { hashPassword } from '@ln-system/shared/utils/password';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * Central de Ajuda e Suporte (docs/CORTEX/SUPPORT.md) — Postgres/Redis reais, duas empresas com duas filiais.
 * Isolamento (empresa, filial, solicitante), contexto validado no servidor, estados e histórico imutável, anexos
 * seguros, base de conhecimento, console da plataforma e auditoria.
 */
describe('Central de Ajuda e Suporte (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  let saUser: { id: string; name: string };
  let colleague: { id: string };
  let companyAdmin: { id: string };
  let draftId: string | undefined;
  const stamp = `sup-${Date.now()}`;

  const tok = {
    opA1: () => bearer(tokenFor(world.A, 1, 'OPERATOR')),
    viewerA1: () => bearer(tokenFor(world.A, 1, 'VIEWER')),
    mgrA2: () => bearer(tokenFor(world.A, 2, 'MANAGER')),
    adminA: () =>
      bearer(generateAccessToken({ userId: companyAdmin.id, email: 'admin@test.local', companyId: world.A.companyId, branchId: undefined as any, userType: 'COMPANY_ADMIN' })),
    opB1: () => bearer(tokenFor(world.B, 1, 'OPERATOR')),
    colleagueA1: () =>
      bearer(generateAccessToken({ userId: colleague.id, email: 'colega@test.local', companyId: world.A.companyId, branchId: world.A.branches[1].branchId as any, userType: 'OPERATOR' })),
    sa: () => bearer(generateAccessToken({ userId: saUser.id, email: 'suporte@test.local', companyId: undefined as any, branchId: undefined as any, userType: 'SUPER_ADMIN' })),
  };
  const auditCalls = () => auditSpy.mock.calls.filter((c) => c[0] === 'audit-log').map((c) => c[1]);

  const newTicket = (auth: Record<string, string>, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    request(app)
      .post('/api/support/tickets')
      .set(auth)
      .set(headers)
      .send({ subject: `Problema ${stamp}`, module: 'PDV', type: 'PROBLEMA', description: 'O pagamento ficou aguardando e depois não confirmou.', ...extra });

  // PNG 1x1 real
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json({ limit: '5mb' })); // mesmo limite da API real (src/index.ts)
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
    const hash = await hashPassword('IntegrationTest123!');
    saUser = await bypass<any>(() =>
      db.user.create({ data: { name: `Suporte ${stamp}`, email: `suporte-${stamp}@test.local`, password: hash, userType: 'SUPER_ADMIN', isActive: true } })
    );
    colleague = await bypass<any>(() =>
      db.user.create({
        data: { companyId: world.A.companyId, branchId: world.A.branches[1].branchId, name: `Colega ${stamp}`, email: `colega-${stamp}@test.local`, password: hash, userType: 'OPERATOR', isActive: true },
      })
    );
    // administrador da empresa DISTINTO do solicitante (o usuário da fixture abre os chamados)
    companyAdmin = await bypass<any>(() =>
      db.user.create({ data: { companyId: world.A.companyId, name: `Admin ${stamp}`, email: `admin-${stamp}@test.local`, password: hash, userType: 'COMPANY_ADMIN', isActive: true } })
    );
  }, 180000);

  afterAll(async () => {
    auditSpy?.mockRestore();
    if (world) await destroyWorld(world);
    if (saUser?.id) await bypass(() => db.user.deleteMany({ where: { id: saUser.id, companyId: null, email: `suporte-${stamp}@test.local` } }));
    if (draftId) await bypass(() => db.supportKbArticle.deleteMany({ where: { id: draftId } }));
  }, 180000);

  // ---------------------------------------------------------------------------------------------------------- base
  describe('base de conhecimento', () => {
    it('catálogo central de módulos/tipos/prioridades/estados', async () => {
      const res = await request(app).get('/api/support-kb/catalog').set(tok.opA1());
      expect(res.status).toBe(200);
      expect(res.body.modules.map((m: any) => m.value)).toEqual(expect.arrayContaining(['PDV', 'OFICINA', 'FINANCEIRO', 'CONVENIOS', 'ANDROID_TV', 'OUTRO']));
      expect(res.body.types.map((t: any) => t.value)).toEqual(['PROBLEMA', 'DUVIDA', 'SOLICITACAO', 'SUGESTAO']);
    });

    it('pesquisa full-text em português encontra os artigos (sem IA)', async () => {
      const a = await request(app).get('/api/support-kb/articles').query({ q: 'pagamento não confirmado' }).set(tok.opA1());
      expect(a.status).toBe(200);
      expect(a.body[0].slug).toBe('pagamento-nao-confirmado');
      const b = await request(app).get('/api/support-kb/articles').query({ q: 'estornar' }).set(tok.opA1());
      expect(b.body.map((x: any) => x.slug)).toContain('como-estornar-um-pagamento');
      const c = await request(app).get('/api/support-kb/articles/como-cancelar-uma-venda').set(tok.viewerA1());
      expect(c.status).toBe(200);
      expect(c.body.body).toMatch(/autoriza/);
      const cats = await request(app).get('/api/support-kb/categories').set(tok.opA1());
      expect(cats.body.find((x: any) => x.slug === 'pdv').articles).toBeGreaterThanOrEqual(3);
    });

    it('rascunho só a plataforma vê; publicado aparece para a empresa; operador não escreve na base', async () => {
      const created = await request(app)
        .post('/api/support-admin/kb/articles')
        .set(tok.sa())
        .send({ title: `Rascunho ${stamp} teste de publicação`, body: 'Conteúdo do rascunho de teste suficiente.', categoryId: 'kbcat-outros', slug: `rascunho-${stamp}` });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('DRAFT');
      draftId = created.body.id;
      expect((await request(app).get(`/api/support-kb/articles/rascunho-${stamp}`).set(tok.opA1())).status).toBe(404);
      const pub = await request(app).post(`/api/support-admin/kb/articles/${created.body.id}/status`).set(tok.sa()).send({ status: 'PUBLISHED' });
      expect(pub.status).toBe(200);
      expect((await request(app).get(`/api/support-kb/articles/rascunho-${stamp}`).set(tok.opA1())).status).toBe(200);
      expect((await request(app).post('/api/support-admin/kb/articles').set(tok.opA1()).send({ title: 'x', body: 'y', categoryId: 'kbcat-outros' })).status).toBe(403);
      // escrita direta pela RLS (sem passar pela rota) também é negada a usuário de empresa
      const direct = await runWithRLSContext({ companyId: world.A.companyId, userType: 'COMPANY_ADMIN', branchId: null }, () =>
        prisma.supportKbArticle.updateMany({ where: { id: draftId }, data: { title: 'alterado pela empresa' } })
      );
      expect(direct.count).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------- abertura
  describe('abertura com contexto automático', () => {
    it('PDV → Venda → Pagamento: dados do usuário e do contexto vêm do servidor', async () => {
      const saleId = world.A.branches[1].saleId;
      const res = await newTicket(tok.opA1(), { context: { screen: 'Pagamento', terminal: 'PDV-02', entityType: 'SALE', entityId: saleId } }, { 'X-Client-Source': 'PDV', 'X-App-Version': '1.0.0' });
      expect(res.status).toBe(201);
      expect(res.body.ticketNumber).toBeGreaterThanOrEqual(1000);
      expect(res.body.status).toBe('ABERTO');
      expect(res.body.source).toBe('PDV');
      expect(res.body.company.id).toBe(world.A.companyId);
      expect(res.body.branch.id).toBe(world.A.branches[1].branchId);
      expect(res.body.requester.id).toBe(world.A.branches[1].userId);
      expect(res.body.context).toMatchObject({ module: 'PDV', screen: 'Pagamento', terminal: 'PDV-02', entityType: 'SALE', entityId: saleId });
      expect(res.body.context.label).toMatch(/^Venda #\d+$/);
      expect(res.body.appVersion).toBe('1.0.0');
      const row = await bypass<any>(() => db.supportTicket.findUnique({ where: { id: res.body.id } }));
      expect(row.requesterName).toBeTruthy();
      expect(row.companyName).toBeTruthy();
    });

    it('Oficina → OS, Financeiro → cobrança e Pós-venda → garantia: rótulo com cliente/veículo validado na empresa', async () => {
      const os = await newTicket(tok.opA1(), { module: 'OFICINA', context: { screen: 'OS', entityType: 'SERVICE_ORDER', entityId: world.A.branches[1].serviceOrderId } });
      expect(os.status).toBe(201);
      expect(os.body.context.label).toMatch(/^OS #\d+$/);
      expect(os.body.context.details.customer).toBeTruthy();

      const rec = await newTicket(tok.opA1(), { module: 'FINANCEIRO', context: { screen: 'Cobrança', entityType: 'RECEIVABLE', entityId: world.A.branches[1].receivableId } });
      expect(rec.status).toBe(201);
      expect(rec.body.context.label).toMatch(/^Conta a receber/);

      const warranty = await bypass<any>(() =>
        db.serviceOrderWarranty.create({
          data: {
            companyId: world.A.companyId, branchId: world.A.branches[1].branchId, serviceOrderId: world.A.branches[1].serviceOrderId,
            customerId: world.A.customerId, motorcycleId: world.A.motorcycleId, coverage: 'SERVICE', durationValue: 3, durationUnit: 'MONTHS',
            startDate: new Date(), validUntil: new Date(Date.now() + 90 * 86_400_000), createdBy: 'test',
          },
        })
      );
      const w = await newTicket(tok.opA1(), { module: 'POS_VENDA', context: { screen: 'Garantia', entityType: 'WARRANTY', entityId: warranty.id } });
      expect(w.status).toBe(201);
      expect(w.body.context.label).toMatch(/^Garantia da OS #\d+$/);
      expect(w.body.context.details).toHaveProperty('vehicle');

      const preview = await request(app).get('/api/support/context').query({ entityType: 'SERVICE_ORDER', entityId: world.A.branches[1].serviceOrderId }).set(tok.opA1());
      expect(preview.status).toBe(200);
      expect(preview.body.label).toMatch(/^OS #/);
    });

    it('parameter tampering: companyId/branchId/userId no corpo são recusados; entidade de outra empresa não entra no contexto', async () => {
      const forged = await newTicket(tok.opA1(), { companyId: world.B.companyId });
      expect(forged.status).toBe(400);
      expect(forged.body.error).toMatch(/Campo não aceito/);
      const forgedCtx = await newTicket(tok.opA1(), { context: { entityType: 'SALE', entityId: world.B.branches[1].saleId } });
      expect(forgedCtx.status).toBe(400);
      expect(forgedCtx.body.code).toBe('SUPPORT_CONTEXT_NOT_FOUND');
      expect((await request(app).get('/api/support/context').query({ entityType: 'SALE', entityId: world.B.branches[1].saleId }).set(tok.opA1())).status).toBe(400);
      const badModule = await newTicket(tok.opA1(), { module: 'INVENTADO' });
      expect(badModule.status).toBe(400);
      expect(badModule.body.error).toMatch(/módulo/);
    });

    it('número de cartão completo é recusado no assunto, na descrição e na mensagem (nada é gravado)', async () => {
      const inDescription = await newTicket(tok.opA1(), { description: 'O cartão 4111 1111 1111 1111 foi recusado na maquininha.' });
      expect(inDescription.status).toBe(400);
      expect(inDescription.body.error).toMatch(/número de cartão/);
      const inSubject = await newTicket(tok.opA1(), { subject: `Cartão 5500000000000004 ${stamp}` });
      expect(inSubject.status).toBe(400);
      expect(await bypass<number>(() => db.supportTicket.count({ where: { companyId: world.A.companyId, subject: { contains: '5500000000000004' } } }))).toBe(0);

      const ok = await newTicket(tok.opA1(), { description: 'Cartão com final 1111 foi recusado; NSU 123456789012.' });
      expect(ok.status).toBe(201);
      const leak = await request(app).post(`/api/support/tickets/${ok.body.id}/messages`).set(tok.opA1()).send({ body: 'Número: 4111-1111-1111-1111' });
      expect(leak.status).toBe(400);
      expect(leak.body.error).toMatch(/número de cartão/);
    });

    it('somente leitura (VIEWER) também pede ajuda; Super Admin não usa a rota da empresa', async () => {
      expect((await newTicket(tok.viewerA1(), { type: 'DUVIDA' })).status).toBe(201);
      const sa = await newTicket(tok.sa());
      expect(sa.status).toBe(403);
      expect(sa.body.code).toBe('SUPPORT_USE_CONSOLE');
      expect((await request(app).get('/api/support-admin/tickets').set(tok.opA1())).status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------------------------------------- isolamento
  describe('isolamento: empresa, filial e solicitante', () => {
    let ticketId: string;
    beforeAll(async () => {
      ticketId = (await newTicket(tok.opA1(), { subject: `Isolamento ${stamp}` })).body.id;
    });

    it('outra empresa: não vê, não responde, não anexa (404 sem revelar)', async () => {
      expect((await request(app).get(`/api/support/tickets/${ticketId}`).set(tok.opB1())).status).toBe(404);
      expect((await request(app).post(`/api/support/tickets/${ticketId}/messages`).set(tok.opB1()).send({ body: 'intruso' })).status).toBe(404);
      expect((await request(app).post(`/api/support/tickets/${ticketId}/attachments`).set(tok.opB1()).send({ fileName: 'a.png', contentBase64: PNG.toString('base64') })).status).toBe(404);
      const list = await request(app).get('/api/support/tickets').set(tok.opB1());
      expect(list.body.data.map((t: any) => t.id)).not.toContain(ticketId);
    });

    it('colega da mesma filial sem permissão não vê; gerente de outra filial sem permissão não vê', async () => {
      expect((await request(app).get(`/api/support/tickets/${ticketId}`).set(tok.colleagueA1())).status).toBe(404);
      expect((await request(app).get(`/api/support/tickets/${ticketId}`).set(tok.mgrA2())).status).toBe(404);
    });

    it('administração da empresa (support:view_company) vê e responde como EMPRESA', async () => {
      const list = await request(app).get('/api/support/tickets').set(tok.adminA());
      expect(list.body.companyWide).toBe(true);
      expect(list.body.data.map((t: any) => t.id)).toContain(ticketId);
      const reply = await request(app).post(`/api/support/tickets/${ticketId}/messages`).set(tok.adminA()).send({ body: 'Complemento da administração.' });
      expect(reply.status).toBe(201);
      const msgs = await bypass<any[]>(() => db.supportTicketMessage.findMany({ where: { ticketId, companyId: world.A.companyId } }));
      expect(msgs.find((m) => m.body === 'Complemento da administração.').authorRole).toBe('COMPANY');
    });

    it('histórico e mensagens não mudam em silêncio: UPDATE/DELETE pela aplicação são barrados pela RLS', async () => {
      const r = await runWithRLSContext({ companyId: world.A.companyId, userType: 'COMPANY_ADMIN', branchId: null }, async () => ({
        upd: await prisma.supportTicketMessage.updateMany({ where: { ticketId, companyId: world.A.companyId }, data: { body: 'reescrito' } }),
        del: await prisma.supportTicketEvent.deleteMany({ where: { ticketId, companyId: world.A.companyId } }),
      }));
      expect(r.upd.count).toBe(0);
      expect(r.del.count).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------- fluxo
  describe('atendimento: atribuição, respostas, estados, reabertura e encerramento', () => {
    it('fluxo completo com histórico em ordem e contador de não lidas', async () => {
      const t = (await newTicket(tok.opA1(), { subject: `Fluxo ${stamp}` })).body;
      const assign = await request(app).post(`/api/support-admin/tickets/${t.id}/assign`).set(tok.sa()).send({ assigneeId: saUser.id });
      expect(assign.status).toBe(200);
      expect(assign.body.status).toBe('EM_ANALISE');
      const invalidAssignee = await request(app).post(`/api/support-admin/tickets/${t.id}/assign`).set(tok.sa()).send({ assigneeId: world.A.branches[1].userId });
      expect(invalidAssignee.status).toBe(400);

      const answer = await request(app).post(`/api/support-admin/tickets/${t.id}/messages`).set(tok.sa()).send({ body: 'Estamos analisando o ocorrido.' });
      expect(answer.status).toBe(201);
      expect(answer.body.status).toBe('AGUARDANDO_USUARIO');
      expect((await request(app).get('/api/support/tickets/unread-count').set(tok.opA1())).body.unread).toBeGreaterThanOrEqual(1);
      await request(app).get(`/api/support/tickets/${t.id}`).set(tok.opA1());
      const listed = await request(app).get('/api/support/tickets').query({ q: String(t.ticketNumber) }).set(tok.opA1());
      expect(listed.body.data).toHaveLength(1);
      expect(listed.body.data[0].unread).toBe(false);

      const back = await request(app).post(`/api/support/tickets/${t.id}/messages`).set(tok.opA1()).send({ body: 'Aconteceu de novo agora.' });
      expect(back.body.status).toBe('AGUARDANDO_SUPORTE');
      expect((await request(app).post(`/api/support-admin/tickets/${t.id}/status`).set(tok.sa()).send({ status: 'RESOLVIDO' })).body.status).toBe('RESOLVIDO');
      expect((await request(app).post(`/api/support-admin/tickets/${t.id}/priority`).set(tok.sa()).send({ priority: 'ALTA' })).body.priority).toBe('ALTA');
      expect((await request(app).post(`/api/support/tickets/${t.id}/reopen`).set(tok.opA1())).body.status).toBe('AGUARDANDO_SUPORTE');
      expect((await request(app).post(`/api/support/tickets/${t.id}/close`).set(tok.opA1())).body.status).toBe('ENCERRADO');
      const late = await request(app).post(`/api/support/tickets/${t.id}/messages`).set(tok.opA1()).send({ body: 'mais uma' });
      expect(late.status).toBe(409);
      expect(late.body.error).toMatch(/Abra um novo chamado/);
      expect((await request(app).post(`/api/support/tickets/${t.id}/reopen`).set(tok.opA1())).status).toBe(409);

      const detail = await request(app).get(`/api/support/tickets/${t.id}`).set(tok.opA1());
      expect(detail.body.events.map((e: any) => e.type)).toEqual([
        'OPENED',
        'ASSIGNED',
        'STATUS_CHANGED',
        'REPLIED',
        'REPLIED',
        'STATUS_CHANGED',
        'PRIORITY_CHANGED',
        'REOPENED',
        'CLOSED',
      ]);
      expect(detail.body.messages.map((m: any) => m.author.role)).toEqual(['SUPPORT', 'REQUESTER']);
    });

    it('corrida: dois estados ao mesmo tempo → um aplica, o outro recebe 409', async () => {
      const t = (await newTicket(tok.opA1(), { subject: `Corrida ${stamp}` })).body;
      const [a, b] = await Promise.all([
        request(app).post(`/api/support-admin/tickets/${t.id}/status`).set(tok.sa()).send({ status: 'RESOLVIDO' }),
        request(app).post(`/api/support-admin/tickets/${t.id}/status`).set(tok.sa()).send({ status: 'AGUARDANDO_USUARIO' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    });

    it('paginação com teto e filtros por estado', async () => {
      await newTicket(tok.opA1(), { subject: `Pagina A ${stamp}` });
      await newTicket(tok.opA1(), { subject: `Pagina B ${stamp}` });
      const p = await request(app).get('/api/support/tickets').query({ limit: 2, page: 1 }).set(tok.opA1());
      expect(p.body.data).toHaveLength(2);
      expect(p.body.pagination.pages).toBeGreaterThan(1);
      expect((await request(app).get('/api/support/tickets').query({ limit: 5000 }).set(tok.opA1())).body.pagination.limit).toBe(50);
      const open = await request(app).get('/api/support/tickets').query({ status: 'open' }).set(tok.opA1());
      expect(open.body.data.every((t: any) => ['ABERTO', 'EM_ANALISE', 'AGUARDANDO_USUARIO', 'AGUARDANDO_SUPORTE'].includes(t.status))).toBe(true);
    });

    it('console: filtros por empresa/módulo; leitura do chamado pela plataforma é auditada', async () => {
      const t = (await newTicket(tok.opA1(), { module: 'FISCAL', subject: `Console ${stamp}` })).body;
      const list = await request(app).get('/api/support-admin/tickets').query({ companyId: world.A.companyId, module: 'FISCAL' }).set(tok.sa());
      expect(list.status).toBe(200);
      expect(list.body.data.every((x: any) => x.company.id === world.A.companyId && x.module === 'FISCAL')).toBe(true);
      expect(list.body.data.map((x: any) => x.id)).toContain(t.id);
      auditSpy.mockClear();
      expect((await request(app).get(`/api/support-admin/tickets/${t.id}`).set(tok.sa())).status).toBe(200);
      const read = auditCalls().find((a: any) => a.entity === 'SupportTicket' && a.action === 'READ');
      expect(read).toBeTruthy();
      expect(JSON.parse(read.newValue).operacao).toBe('LEITURA_PELA_PLATAFORMA');
      const dash = await request(app).get('/api/support-admin/dashboard').set(tok.sa());
      expect(dash.body.open).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------------------------------------- anexos
  describe('anexos seguros', () => {
    let ticketId: string;
    let attachmentId: string;
    beforeAll(async () => {
      ticketId = (await newTicket(tok.opA1(), { subject: `Anexos ${stamp}` })).body.id;
    });

    it('imagem válida: guarda, baixa como download com nosniff; outra empresa não baixa', async () => {
      const up = await request(app).post(`/api/support/tickets/${ticketId}/attachments`).set(tok.opA1()).send({ fileName: '../../tela do erro.png', mimeType: 'image/png', contentBase64: PNG.toString('base64') });
      expect(up.status).toBe(201);
      expect(up.body.fileName).toBe('tela do erro.png');
      attachmentId = up.body.id;
      const down = await request(app).get(`/api/support/attachments/${attachmentId}`).set(tok.opA1()).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(down.status).toBe(200);
      expect(down.headers['content-disposition']).toMatch(/^attachment;/);
      expect(down.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.compare(down.body as Buffer, PNG)).toBe(0);
      expect((await request(app).get(`/api/support/attachments/${attachmentId}`).set(tok.opB1())).status).toBe(404);
      expect((await request(app).get(`/api/support-admin/attachments/${attachmentId}`).set(tok.sa())).status).toBe(200);
    });

    it('executável disfarçado, extensão trocada, HTML em .txt e arquivo grande são recusados', async () => {
      const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 1)]);
      const r1 = await request(app).post(`/api/support/tickets/${ticketId}/attachments`).set(tok.opA1()).send({ fileName: 'foto.png', contentBase64: exe.toString('base64') });
      expect(r1.status).toBe(400);
      expect(r1.body.code).toBe('ATTACHMENT_TYPE_NOT_ALLOWED');
      const r2 = await request(app).post(`/api/support/tickets/${ticketId}/attachments`).set(tok.opA1()).send({ fileName: 'nota.pdf', contentBase64: PNG.toString('base64') });
      expect(r2.body.code).toBe('ATTACHMENT_EXTENSION_MISMATCH');
      const html = Buffer.from('<script>alert(1)</script>');
      const r3 = await request(app).post(`/api/support/tickets/${ticketId}/attachments`).set(tok.opA1()).send({ fileName: 'log.txt', contentBase64: html.toString('base64') });
      expect(r3.body.code).toBe('ATTACHMENT_TYPE_NOT_ALLOWED');
      const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
      const r4 = await request(app).post(`/api/support/tickets/${ticketId}/attachments`).set(tok.opA1()).send({ fileName: 'grande.png', contentBase64: big.toString('base64') });
      expect(r4.status).toBe(400);
      expect(r4.body.code).toBe('ATTACHMENT_TOO_LARGE');
      const log = await request(app).post(`/api/support/tickets/${ticketId}/attachments`).set(tok.opA1()).send({ fileName: 'pdv.log', contentBase64: Buffer.from('2026-09-28 erro ao confirmar pagamento\n').toString('base64') });
      expect(log.status).toBe(201);
      expect(log.body.mimeType).toBe('text/plain');
    });

    it('remoção é lógica e só de quem enviou; removido não baixa mais; histórico registra', async () => {
      expect((await request(app).delete(`/api/support/attachments/${attachmentId}`).set(tok.adminA())).status).toBe(403);
      expect((await request(app).delete(`/api/support/attachments/${attachmentId}`).set(tok.opA1())).status).toBe(200);
      expect((await request(app).get(`/api/support/attachments/${attachmentId}`).set(tok.opA1())).status).toBe(404);
      const row = await bypass<any>(() => db.supportTicketAttachment.findUnique({ where: { id: attachmentId } }));
      expect(row.removedAt).toBeTruthy();
      const detail = await request(app).get(`/api/support/tickets/${ticketId}`).set(tok.opA1());
      expect(detail.body.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED']));
    });
  });
});
