import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import { World, createWorld, destroyWorld, tokenFor, bearer } from './helpers/tenant-world';

/**
 * BACKUP SEM A CREDENCIAL NA API (decisão 152) — rotas reais `/api/backup/*` no modo DELEGADO: a API só pede e lista; nunca executa `pg_dump`, lê, apaga ou restaura.
 * O módulo é carregado DEPOIS de definir o modo e as pastas (o `backupService` escolhe a implementação na importação).
 */
describe('Backup no modo delegado: a API não tem credencial de backup (integração real)', () => {
  let world: World;
  let app: express.Express;
  let requestDir: string;
  let publicDir: string;
  const saved: Record<string, string | undefined> = {};
  const sa = () => bearer(tokenFor(world.A, null, 'SUPER_ADMIN'));

  beforeAll(async () => {
    requestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-int-req-'));
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-int-pub-'));
    for (const k of ['BACKUP_MODE', 'BACKUP_REQUEST_DIR', 'BACKUP_PUBLIC_DIR', 'BACKUP_DATABASE_URL']) saved[k] = process.env[k];
    process.env.BACKUP_MODE = 'delegated';
    process.env.BACKUP_REQUEST_DIR = requestDir;
    process.env.BACKUP_PUBLIC_DIR = publicDir;
    delete process.env.BACKUP_DATABASE_URL; // a API NÃO tem a credencial
    world = await createWorld();
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const routes = require('../../src/routes').default;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { errorHandler } = require('../../src/middleware/errorHandler');
    app = express();
    app.use(express.json());
    app.use('/api', routes);
    app.use(errorHandler);
    fs.writeFileSync(
      path.join(publicDir, 'cortex-20261015T000000Z.dump.enc.manifest'),
      `arquivo=cortex-20261015T000000Z.dump.enc\nsha256=${'b'.repeat(64)}\nbytes=1234\ncifrado=sim\nbanco=cortex\ncriado_em=20261015T000000Z\n`
    );
  }, 180000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(requestDir, { recursive: true, force: true });
    fs.rmSync(publicDir, { recursive: true, force: true });
    await destroyWorld(world);
  }, 180000);

  it('o processo da API não tem BACKUP_DATABASE_URL neste cenário (nada a herdar por quem a comprometer)', () => {
    expect(process.env.BACKUP_DATABASE_URL).toBeUndefined();
  });

  it('POST /backup/create PEDE o backup: 202 e um arquivo de pedido; nada é executado pela API', async () => {
    const res = await request(app).post('/api/backup/create').set(sa()).send({});
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, requested: true });
    expect(res.body.filePath).toBeUndefined();
    const files = fs.readdirSync(requestDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^request-.*\.json$/);
  });

  it('GET /backup/list e /backup/stats mostram os MANIFESTOS publicados (metadados), nunca caminho nem conteúdo de backup', async () => {
    const list = await request(app).get('/api/backup/list').set(sa());
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ filename: 'cortex-20261015T000000Z.dump.enc', size: 1234 });
    expect(JSON.stringify(list.body)).not.toContain(publicDir);
    const stats = await request(app).get('/api/backup/stats').set(sa());
    expect(stats.status).toBe(200);
    expect(stats.body.data.totalBackups).toBe(1);
  });

  it('POST /backup/restore é SEMPRE recusado (403 RESTORE_DISABLED): restaurar é procedimento de DBA em banco isolado', async () => {
    const res = await request(app).post('/api/backup/restore').set(sa()).send({ filename: 'cortex-20261015T000000Z.dump.enc' });
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'RESTORE_DISABLED' });
  });

  it('DELETE /backup/delete/:arquivo é recusado (403 BACKUP_DELETE_DISABLED): a retenção é do serviço de backup', async () => {
    const res = await request(app).delete('/api/backup/delete/cortex-20261015T000000Z.dump.enc').set(sa());
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'BACKUP_DELETE_DISABLED' });
    expect(fs.existsSync(path.join(publicDir, 'cortex-20261015T000000Z.dump.enc.manifest'))).toBe(true);
  });

  it('só SUPER_ADMIN usa estas rotas: administrador da empresa, gerente e operador recebem 403 (e nenhum pedido é gravado)', async () => {
    const before = fs.readdirSync(requestDir).length;
    for (const t of [bearer(tokenFor(world.A, null, 'COMPANY_ADMIN')), bearer(tokenFor(world.A, 1, 'MANAGER')), bearer(tokenFor(world.A, 2, 'OPERATOR'))]) {
      expect((await request(app).post('/api/backup/create').set(t).send({})).status).toBe(403);
      expect((await request(app).get('/api/backup/list').set(t)).status).toBe(403);
    }
    expect((await request(app).post('/api/backup/create').send({})).status).toBe(401);
    expect(fs.readdirSync(requestDir).length).toBe(before);
  });
});
