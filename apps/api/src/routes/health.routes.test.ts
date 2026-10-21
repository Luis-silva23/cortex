import express from 'express';
import request from 'supertest';

const queryRaw = jest.fn();
const ping = jest.fn();
const workersRunning = jest.fn();
let draining = false;

jest.mock('@ln-system/database', () => ({ prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) } }));
jest.mock('../config/redis', () => ({ redis: { ping: (...args: unknown[]) => ping(...args) } }));
jest.mock('../config/queue', () => ({ workersRunning: () => workersRunning() }));
jest.mock('../config/shutdown', () => ({ isShuttingDown: () => draining }));

import healthRoutes from './health.routes';

const app = express();
app.use('/health', healthRoutes);

beforeEach(() => {
  queryRaw.mockResolvedValue([{ '?column?': 1 }]);
  ping.mockResolvedValue('PONG');
  workersRunning.mockReturnValue(true);
  draining = false;
});

describe('sondas de saúde', () => {
  it('tudo de pé: /health 200 OK, /ready 200, /live 200', async () => {
    const h = await request(app).get('/health');
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ message: 'OK', services: { database: 'connected', redis: 'connected', workers: 'running' } });
    expect((await request(app).get('/health/ready')).body).toEqual({ status: 'ready' });
    expect((await request(app).get('/health/live')).status).toBe(200);
  });

  it('banco fora: 503 e a prontidão diz QUAL dependência caiu, sem a mensagem do erro (que pode ter host e usuário)', async () => {
    queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:5432 user=app'));
    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: 'not ready', failing: ['database'] });
    expect(JSON.stringify(ready.body)).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|user=/);
    const h = await request(app).get('/health');
    expect(h.status).toBe(503);
    expect(h.body.services.database).toBe('disconnected');
    expect(JSON.stringify(h.body)).not.toMatch(/ECONNREFUSED/);
    // viva continua 200: um banco fora não deve fazer o orquestrador REINICIAR a API
    expect((await request(app).get('/health/live')).status).toBe(200);
  });

  it('Redis que NUNCA responde não pendura a sonda: cai no prazo e responde 503', async () => {
    ping.mockReturnValue(new Promise(() => undefined));
    const started = Date.now();
    const r = await request(app).get('/health/ready');
    expect(r.status).toBe(503);
    expect(r.body.failing).toEqual(['redis']);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10000);

  it('banco que NUNCA responde não pendura a sonda', async () => {
    queryRaw.mockReturnValue(new Promise(() => undefined));
    const r = await request(app).get('/health/ready');
    expect(r.status).toBe(503);
    expect(r.body.failing).toEqual(['database']);
  }, 10000);

  it('worker parado: não está pronto (aceitaria HTTP mas nunca processaria auditoria/rotinas)', async () => {
    workersRunning.mockReturnValue(false);
    const r = await request(app).get('/health/ready');
    expect(r.status).toBe(503);
    expect(r.body.failing).toEqual(['workers']);
    expect((await request(app).get('/health')).body.services.workers).toBe('stopped');
  });

  it('durante o desligamento: /ready e /health 503 (sai da rotação), /live continua 200', async () => {
    draining = true;
    expect(await request(app).get('/health/ready')).toMatchObject({ status: 503, body: { status: 'draining' } });
    const h = await request(app).get('/health');
    expect(h.status).toBe(503);
    expect(h.body.message).toBe('DRAINING');
    expect((await request(app).get('/health/live')).status).toBe(200);
  });
});
