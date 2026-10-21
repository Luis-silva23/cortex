/**
 * Caos controlado (API real + Redis derrubado): todo erro do Redis caía no `catch` do middleware e a requisição passava —
 * 8 senhas erradas seguidas, 8 × 401, nenhum 429. A proteção contra força bruta sumia justamente com o Redis fora.
 * Aqui o cliente Redis falha em todo comando (como com o servidor parado): o limite tem de continuar valendo.
 */
import express from 'express';
import request from 'supertest';

jest.mock('ioredis', () => {
  const down = () => {
    const err = new Error("Stream isn't writeable and enableOfflineQueue options is false");
    return Promise.reject(err);
  };
  return jest.fn().mockImplementation(() =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'then') return undefined;
          if (prop === 'on' || prop === 'once' || prop === 'defineCommand') return () => undefined;
          if (prop === 'status') return 'reconnecting';
          if (prop === 'multi' || prop === 'pipeline') return () => ({ exec: down, set: () => ({}), pttl: () => ({}), incrby: () => ({}) });
          return (...args: unknown[]) => {
            const cb = args[args.length - 1];
            if (typeof cb === 'function') (cb as (e: Error) => void)(new Error("Stream isn't writeable"));
            return down();
          };
        },
      }
    )
  );
});

let rateLimitAuth: express.RequestHandler;

beforeAll(() => {
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    rateLimitAuth = require('./advancedRateLimit').rateLimitAuth;
  });
});
afterAll(() => {
  delete process.env.REDIS_URL;
});

it('Redis fora do ar: senhas erradas continuam sendo limitadas (429), não liberadas', async () => {
  const app = express();
  app.use(express.json());
  app.post('/login', rateLimitAuth, (_req, res) => res.status(401).json({ error: 'Credenciais inválidas' }));

  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await request(app).post('/login').send({})).status);
  expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
  expect(statuses.slice(5)).toEqual([429, 429, 429]);
});
