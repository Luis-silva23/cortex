/**
 * Entrada do monitor independente: autenticação por assinatura, desligada sem segredo, limite por IP em falha, validação de corpo e nenhum vazamento na resposta.
 * Banco, Redis e o serviço de gravação são simulados; a assinatura é a REAL (mesmo código que o monitor usa para assinar).
 */
jest.mock('../middleware/channel-auth', () => {
  const express = require('express');
  return {
    commerceJson: express.json({ limit: '256kb', type: ['application/json'], verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; } }),
  };
});
const isAuthBlockedMock = jest.fn().mockResolvedValue(false);
const noteAuthFailureMock = jest.fn().mockResolvedValue(undefined);
const consumeMock = jest.fn().mockResolvedValue({ allowed: true, retryAfterSec: 0, remaining: 10, limit: 300 });
jest.mock('../services/commerce/rate-limit', () => ({
  isAuthBlocked: (...a: unknown[]) => isAuthBlockedMock(...a),
  noteAuthFailure: (...a: unknown[]) => noteAuthFailureMock(...a),
  consumeCredential: (...a: unknown[]) => consumeMock(...a),
}));
const ingestMock = jest.fn().mockResolvedValue({ samples: 1, skippedSamples: 0, incidents: {}, staleIncidents: 0 });
jest.mock('../services/monitoring-central/external-monitor.service', () => ({
  ...jest.requireActual('../services/monitoring-central/external-monitor.service'),
  ingest: (...a: unknown[]) => ingestMock(...a),
}));
jest.mock('../services/logger.service', () => ({ Logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import express from 'express';
import request from 'supertest';
import { signRequest } from '@ln-system/shared/utils/request-signature';
import router from './monitor-ingest.routes';

const SECRET = 's'.repeat(40);
const app = express();
app.use('/monitor/v1', router);

const now = Date.now();
const body = {
  monitorId: 'monitor-a',
  location: 'Região B',
  sentAt: now,
  targets: [{ id: 'api', name: 'API', status: 'UP' }],
  results: [{ target: 'api', at: now - 1000, ok: true, httpStatus: 200, latencyMs: 90, failure: null }],
  incidents: [],
};

function signed(payload: unknown, opts: { secret?: string; ts?: number; path?: string } = {}) {
  const raw = JSON.stringify(payload);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const path = opts.path ?? '/monitor/v1/ingest';
  const sig = signRequest(opts.secret ?? SECRET, { timestampSec: ts, method: 'POST', path, rawBody: raw });
  return request(app).post('/monitor/v1/ingest').set('Content-Type', 'application/json').set('X-Cortex-Timestamp', String(ts)).set('X-Cortex-Signature', sig).send(raw);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MONITOR_INGEST_SECRET = SECRET;
  isAuthBlockedMock.mockResolvedValue(false);
  consumeMock.mockResolvedValue({ allowed: true, retryAfterSec: 0, remaining: 10, limit: 300 });
});
afterAll(() => {
  delete process.env.MONITOR_INGEST_SECRET;
});

describe('POST /monitor/v1/ingest', () => {
  it('aceita requisição assinada e grava', async () => {
    const r = await signed(body);
    expect(r.status).toBe(200);
    expect(r.body.accepted).toBe(true);
    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('sem o segredo configurado a entrada está DESLIGADA (503) e nada é gravado', async () => {
    delete process.env.MONITOR_INGEST_SECRET;
    const r = await signed(body);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('INGEST_DISABLED');
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it('segredo curto demais também desliga', async () => {
    process.env.MONITOR_INGEST_SECRET = 'curto';
    expect((await signed(body)).status).toBe(503);
  });

  it.each([
    ['assinatura de outro segredo', () => signed(body, { secret: 'z'.repeat(40) })],
    ['timestamp velho (reenvio)', () => signed(body, { ts: Math.floor(Date.now() / 1000) - 3600 })],
    ['caminho diferente do assinado', () => signed(body, { path: '/monitor/v1/outra' })],
  ])('recusa %s com 401 e conta a falha por IP', async (_n, send) => {
    const r = await send();
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHORIZED');
    expect(noteAuthFailureMock).toHaveBeenCalledTimes(1);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it('sem cabeçalhos de assinatura: 401', async () => {
    const r = await request(app).post('/monitor/v1/ingest').send(body);
    expect(r.status).toBe(401);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it('corpo adulterado depois de assinado: 401', async () => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = signRequest(SECRET, { timestampSec: ts, method: 'POST', path: '/monitor/v1/ingest', rawBody: raw });
    const r = await request(app).post('/monitor/v1/ingest').set('Content-Type', 'application/json').set('X-Cortex-Timestamp', String(ts)).set('X-Cortex-Signature', sig).send(raw.replace('Região B', 'Região C'));
    expect(r.status).toBe(401);
  });

  it('IP bloqueado por falhas: 429 antes de olhar a assinatura', async () => {
    isAuthBlockedMock.mockResolvedValue(true);
    const r = await signed(body);
    expect(r.status).toBe(429);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it('limite global do canal estourado: 429 com Retry-After', async () => {
    consumeMock.mockResolvedValue({ allowed: false, retryAfterSec: 12, remaining: 0, limit: 300 });
    const r = await signed(body);
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('12');
  });

  it('corpo inválido (assinado, mas fora do formato): 400 com os campos, sem gravar', async () => {
    const r = await signed({ ...body, results: [{ ...body.results[0], target: "x'; DROP TABLE y;--" }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_REQUEST');
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it('corpo acima de 256 KB: 413', async () => {
    const big = { ...body, incidents: [], pad: 'x'.repeat(300 * 1024) };
    const r = await signed(big);
    expect(r.status).toBe(413);
  });

  it('a resposta e o erro não repetem o segredo', async () => {
    const ok = await signed(body);
    const bad = await signed(body, { secret: 'z'.repeat(40) });
    expect(JSON.stringify(ok.body) + JSON.stringify(bad.body)).not.toContain(SECRET);
  });

  it('outras rotas e métodos: 404 padronizado', async () => {
    const r = await request(app).get('/monitor/v1/ingest');
    expect(r.status).toBe(404);
  });
});
