import express from 'express';
import request from 'supertest';
import { requireHttps, httpsEnforced } from './https';

// Cadeia real do Express: `trust proxy` + X-Forwarded-Proto (o que o proxy TLS do staging/produção envia).
const appWith = (trustProxy: number | undefined) => {
  const app = express();
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(requireHttps({ NODE_ENV: 'production' } as NodeJS.ProcessEnv));
  app.get('/api/health/ready', (_req, res) => res.json({ ok: true }));
  app.get('/api/data', (_req, res) => res.json({ secret: true }));
  app.post('/api/auth/login', (_req, res) => res.json({ token: 'x' }));
  return app;
};

describe('HTTPS obrigatório: cadeia com proxy confiável (Express real)', () => {
  it('atrás de proxy declarado (TRUST_PROXY=1): X-Forwarded-Proto https passa; http é 426; sem o cabeçalho é 426', async () => {
    const app = appWith(1);
    expect((await request(app).get('/api/data').set('X-Forwarded-Proto', 'https')).status).toBe(200);
    expect((await request(app).post('/api/auth/login').set('X-Forwarded-Proto', 'https')).status).toBe(200);
    const plain = await request(app).get('/api/data').set('X-Forwarded-Proto', 'http');
    expect(plain.status).toBe(426);
    expect(plain.body.code).toBe('HTTPS_REQUIRED');
    expect((await request(app).post('/api/auth/login')).status).toBe(426); // credencial nunca é aceita em HTTP
    expect((await request(app).get('/api/data')).status).toBe(426);
  });

  it('sem proxy declarado, X-Forwarded-Proto NÃO vale (cliente não forja HTTPS): sempre 426, menos a sonda de saúde', async () => {
    const app = appWith(undefined);
    expect((await request(app).get('/api/data').set('X-Forwarded-Proto', 'https')).status).toBe(426);
    expect((await request(app).get('/api/health/ready')).status).toBe(200);
  });
});

const run = (env: Record<string, string | undefined>, req: { secure: boolean; method?: string; path?: string }) => {
  const res: any = { statusCode: 200, status: jest.fn().mockImplementation((c: number) => ((res.statusCode = c), res)), json: jest.fn() };
  const next = jest.fn();
  requireHttps(env as NodeJS.ProcessEnv)({ method: 'POST', path: '/api/auth/login', ...req } as any, res, next);
  return { res, next };
};

describe('HTTPS obrigatório em produção', () => {
  const PROD = { NODE_ENV: 'production' };

  it('produção: requisição por HTTP puro é recusada com 426 (sem redirecionar e sem tocar a rota)', () => {
    const { res, next } = run(PROD, { secure: false });
    expect(res.status).toHaveBeenCalledWith(426);
    expect(res.json.mock.calls[0][0].code).toBe('HTTPS_REQUIRED');
    expect(next).not.toHaveBeenCalled();
  });

  it('produção: requisição que chegou por HTTPS (req.secure, via proxy confiável) passa', () => {
    const { next } = run(PROD, { secure: true });
    expect(next).toHaveBeenCalled();
  });

  it('produção: só as sondas de saúde por GET/HEAD passam por HTTP (rede privada do orquestrador)', () => {
    for (const path of ['/api/health', '/api/health/live', '/api/health/ready']) {
      expect(run(PROD, { secure: false, method: 'GET', path }).next).toHaveBeenCalled();
    }
    expect(run(PROD, { secure: false, method: 'POST', path: '/api/health/ready' }).res.status).toHaveBeenCalledWith(426);
    expect(run(PROD, { secure: false, method: 'GET', path: '/api/health/../auth/login' }).res.status).toHaveBeenCalledWith(426);
    expect(run(PROD, { secure: false, method: 'GET', path: '/api/products' }).res.status).toHaveBeenCalledWith(426);
  });

  it('fora de produção não interfere; ENFORCE_HTTPS=false é a saída explícita', () => {
    expect(run({ NODE_ENV: 'development' }, { secure: false }).next).toHaveBeenCalled();
    expect(run({ ...PROD, ENFORCE_HTTPS: 'false' }, { secure: false }).next).toHaveBeenCalled();
    expect(httpsEnforced(PROD as NodeJS.ProcessEnv)).toBe(true);
    expect(httpsEnforced({ ...PROD, ENFORCE_HTTPS: 'false' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
