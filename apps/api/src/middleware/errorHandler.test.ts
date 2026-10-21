/**
 * ACHADO DE AUDITORIA: o errorHandler central respondia só
 * { message, code, statusCode }, mas o resto da API e todas as telas do
 * admin-web usam `{ error }` — a mensagem real (e-mail duplicado, permissão
 * negada, validação...) se perdia e a tela mostrava o texto genérico. Agora
 * o corpo também traz `error` (= message), sem remover nenhum campo.
 */

jest.mock('../services/logger.service', () => ({
  Logger: { critical: jest.fn() },
}));

import { Prisma } from '@prisma/client';
import { ZodError, z } from 'zod';
import { AppError, AuthorizationError } from '@ln-system/shared';
import { errorHandler, withLegacyErrorField } from './errorHandler';

function run(err: any) {
  const sent: { status?: number; body?: any } = {};
  const res: any = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: any) {
      sent.body = body;
      return res;
    },
    setHeader: jest.fn(),
  };
  const req: any = { path: '/x', method: 'POST', originalUrl: '/api/x' };
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  errorHandler(err, req, res, jest.fn());
  return sent;
}

describe('errorHandler — corpo de erro com `error` além de message/code/statusCode', () => {
  it('AppError: mantém message/code/statusCode e acrescenta error', () => {
    const { status, body } = run(new AppError('E-mail já cadastrado', 409, 'CONFLICT'));
    expect(status).toBe(409);
    expect(body).toEqual({ message: 'E-mail já cadastrado', code: 'CONFLICT', statusCode: 409, error: 'E-mail já cadastrado' });
  });

  it('AuthorizationError (módulo/permissão): a mensagem chega em `error`', () => {
    const { status, body } = run(new AuthorizationError('Módulo desativado para esta filial', 'MODULE_DISABLED'));
    expect(status).toBe(403);
    expect(body.error).toBe('Módulo desativado para esta filial');
    expect(body.code).toBe('MODULE_DISABLED');
  });

  it('ZodError: error = "Erro de validação" e os detalhes por campo continuam em details', () => {
    const parsed = z.object({ email: z.string().email() }).safeParse({ email: 'x' });
    const { status, body } = run((parsed as any).error as ZodError);
    expect(status).toBe(400);
    expect(body.error).toBe('Erro de validação');
    expect(body.details[0].field).toBe('email');
  });

  it('Prisma P2002 (duplicado): 409 com error', () => {
    const err = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: ['email'] } });
    const { status, body } = run(err);
    expect(status).toBe(409);
    expect(body.error).toBe('email já existe');
    expect(body.code).toBe('DUPLICATE_ENTRY');
  });

  it('erro genérico não operacional: 500 sem vazar a mensagem interna, e error idêntico a message', () => {
    const { status, body } = run(new Error('connection string postgres://user:senha@host'));
    expect(status).toBe(500);
    expect(body.message).toBe('Erro interno do servidor');
    expect(body.error).toBe('Erro interno do servidor');
    expect(JSON.stringify(body)).not.toContain('senha');
  });

  // Caos controlado (Postgres parado com a API no ar): vendas e painel respondiam 500 "Erro interno do servidor".
  it.each([
    ['PrismaClientInitializationError', () => new Prisma.PrismaClientInitializationError("Can't reach database server at `localhost:5432`", 'x')],
    ['P1001 (servidor inacessível)', () => new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'x' })],
    ['P1017 (conexão encerrada pelo servidor)', () => new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', { code: 'P1017', clientVersion: 'x' })],
    ['P2028 (transação não iniciou a tempo — rajada)', () => new Prisma.PrismaClientKnownRequestError('Transaction API error: Unable to start a transaction in the given time.', { code: 'P2028', clientVersion: 'x' })],
    ['P2024 (pool de conexões esgotado)', () => new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool', { code: 'P2024', clientVersion: 'x' })],
  ])('banco inacessível (%s): 503 DATABASE_UNAVAILABLE, sem detalhe técnico', (_l, make) => {
    const { status, body } = run(make());
    expect(status).toBe(503);
    expect(body.code).toBe('DATABASE_UNAVAILABLE');
    expect(body.error).toMatch(/Banco de dados indisponível/);
    expect(JSON.stringify(body)).not.toMatch(/localhost|5432|reach/);
  });
});

describe('withLegacyErrorField', () => {
  it('não sobrescreve um `error` que já exista', () => {
    expect(withLegacyErrorField({ message: 'a', error: 'b' })).toEqual({ message: 'a', error: 'b' });
  });

  it('não mexe em corpo sem message, em arrays nem em não-objetos', () => {
    expect(withLegacyErrorField({ ok: true })).toEqual({ ok: true });
    expect(withLegacyErrorField([1, 2])).toEqual([1, 2]);
    expect(withLegacyErrorField(null)).toBeNull();
    expect(withLegacyErrorField('texto')).toBe('texto');
  });
});
