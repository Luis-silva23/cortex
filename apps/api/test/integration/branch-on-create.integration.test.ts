import express from 'express';
import request from 'supertest';
import routes from '../../src/routes';
import { errorHandler } from '../../src/middleware/errorHandler';
import { jobQueue } from '../../src/config/queue';
import { prismaUnsafeBypassRLS } from '@ln-system/database';
import { World, createWorld, destroyWorld, tokenFor, bearer, bypass } from './helpers/tenant-world';

/**
 * Filial na CRIAÇÃO de agendamento / follow-up / revisão — prova REAL (HTTP + Postgres/RLS).
 *
 * ACHADO (relato dos apps Android/TV, reproduzido aqui): as três rotas repassavam o
 * `branchId` do CORPO (que o admin-web não envia) e não o resolviam a partir do token.
 * Todo registro criado por um usuário de filial nascia com `branchId NULL` ("da empresa
 * toda"), então:
 *   - a "Agenda de hoje" da TV e os cards do app mobile (que filtram `branchId = filial`)
 *     ficavam vazios, embora o registro existisse;
 *   - o registro ficava visível para TODAS as filiais (a RLS trata NULL como da empresa);
 *   - um `branchId` de OUTRA empresa passava sem validação.
 * Regra (a mesma das tabelas-irmãs): usuário preso a uma filial grava NA filial dele; quem
 * é da empresa toda (COMPANY_ADMIN/SUPER_ADMIN) pode escolher uma filial DA PRÓPRIA empresa
 * ou deixar sem filial (empresa toda).
 */

type Kind = 'appointments' | 'follow-ups' | 'revisions';

describe('Filial na criação de agendamento/follow-up/revisão (integração real)', () => {
  let world: World;
  let app: express.Express;
  let auditSpy: jest.SpyInstance;
  const stamp = `bc-${Date.now()}`;
  let seq = 0;

  const A = () => world.A;
  const a1Operator = () => bearer(tokenFor(A(), 1, 'OPERATOR'));
  const aAdmin = () => bearer(tokenFor(A(), null, 'COMPANY_ADMIN'));

  const body = (kind: Kind, marker: string, extra: Record<string, unknown> = {}) => {
    const base = { customerId: A().customerId, notes: marker };
    if (kind === 'appointments') return { ...base, scheduledAt: new Date(Date.now() + 172_800_000).toISOString(), ...extra };
    if (kind === 'follow-ups') return { ...base, motorcycleId: A().motorcycleId, dueDate: new Date(Date.now() + 172_800_000).toISOString(), ...extra };
    return {
      ...base,
      motorcycleId: A().motorcycleId,
      performedAt: new Date().toISOString(),
      kilometerAtService: 1200,
      servicesPerformed: 'troca de óleo',
      ...extra,
    };
  };

  const find = (kind: Kind, marker: string) =>
    bypass(() => {
      const where = { notes: marker };
      if (kind === 'appointments') return prismaUnsafeBypassRLS.appointment.findMany({ where });
      if (kind === 'follow-ups') return prismaUnsafeBypassRLS.followUp.findMany({ where });
      return prismaUnsafeBypassRLS.revision.findMany({ where });
    }) as Promise<Array<{ id: string; companyId: string; branchId: string | null }>>;

  const marker = (kind: Kind, label: string) => `${stamp}-${kind}-${label}-${++seq}`;

  beforeAll(async () => {
    world = await createWorld();
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    auditSpy = jest.spyOn(jobQueue, 'add').mockResolvedValue(undefined as any);
  }, 120000);

  afterAll(async () => {
    auditSpy.mockRestore();
    // bypass() recebe UMA PrismaPromise por chamada (não uma função async com vários awaits).
    // escopado por empresa + marcador (o destroyWorld também apaga por companyId)
    if (world) {
      // retornos, agendamentos, revisões e seus eventos saem no destroyWorld (expurgo por empresa guiado pelas FKs).
      await destroyWorld(world);
    }
  }, 120000);

  describe.each(['appointments', 'follow-ups', 'revisions'] as Kind[])('POST /api/%s', (kind) => {
    it('usuário de filial SEM branchId no corpo: grava na filial do token (não fica "da empresa toda")', async () => {
      const m = marker(kind, 'implicit');
      const res = await request(app).post(`/api/${kind}`).set(a1Operator()).send(body(kind, m));
      expect(res.status).toBe(201);
      const rows = await find(kind, m);
      expect(rows).toHaveLength(1);
      expect(rows[0].branchId).toBe(A().branches[1].branchId);
    });

    it('a listagem filtrada pela filial (TV/mobile) enxerga o registro recém-criado', async () => {
      const m = marker(kind, 'listed');
      const created = await request(app).post(`/api/${kind}`).set(a1Operator()).send(body(kind, m));
      expect(created.status).toBe(201);
      const list = await request(app)
        .get(`/api/${kind}?branchId=${A().branches[1].branchId}&limit=100`)
        .set(a1Operator());
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).toContain(created.body.id);
    });

    it('usuário de filial com branchId de OUTRA filial no corpo: 403 e nada é gravado', async () => {
      const m = marker(kind, 'forged-branch');
      const res = await request(app)
        .post(`/api/${kind}`)
        .set(a1Operator())
        .send(body(kind, m, { branchId: A().branches[2].branchId }));
      expect(res.status).toBe(403);
      expect(await find(kind, m)).toHaveLength(0);
    });

    it('usuário de filial com o branchId da PRÓPRIA filial no corpo: aceito', async () => {
      const m = marker(kind, 'own-branch');
      const res = await request(app)
        .post(`/api/${kind}`)
        .set(a1Operator())
        .send(body(kind, m, { branchId: A().branches[1].branchId }));
      expect(res.status).toBe(201);
      expect((await find(kind, m))[0].branchId).toBe(A().branches[1].branchId);
    });

    it('COMPANY_ADMIN escolhe uma filial da própria empresa: grava nela', async () => {
      const m = marker(kind, 'admin-choice');
      const res = await request(app)
        .post(`/api/${kind}`)
        .set(aAdmin())
        .send(body(kind, m, { branchId: A().branches[2].branchId }));
      expect(res.status).toBe(201);
      expect((await find(kind, m))[0].branchId).toBe(A().branches[2].branchId);
    });

    it('COMPANY_ADMIN sem filial: grava "da empresa toda" (branchId NULL), regra já existente', async () => {
      const m = marker(kind, 'admin-none');
      const res = await request(app).post(`/api/${kind}`).set(aAdmin()).send(body(kind, m));
      expect(res.status).toBe(201);
      expect((await find(kind, m))[0].branchId).toBeNull();
    });

    it('COMPANY_ADMIN com branchId de OUTRA empresa: 4xx e nada é gravado', async () => {
      const m = marker(kind, 'foreign-branch');
      const res = await request(app)
        .post(`/api/${kind}`)
        .set(aAdmin())
        .send(body(kind, m, { branchId: world.B.branches[1].branchId }));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await find(kind, m)).toHaveLength(0);
    });
  });
});
