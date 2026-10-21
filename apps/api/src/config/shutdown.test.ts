import http from 'http';
import { AddressInfo } from 'net';
import { isShuttingDown, resetShutdownState, shutdown } from './shutdown';

/**
 * Desligamento ORDENADO provado contra um servidor HTTP REAL em porta efêmera (só loopback): a requisição em andamento termina, a nova é
 * recusada, os fechamentos rodam na ordem e um que falha não impede os seguintes. (O sinal real SIGTERM não existe no Windows: o
 * orquestrador é chamado direto; `registerGracefulShutdown` só liga o sinal a ele.)
 */
const log = () => ({ info: jest.fn(), error: jest.fn() });

function startServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  return new Promise<{ server: http.Server; port: number }>((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })));
}

const get = (port: number, path = '/') =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });

beforeEach(() => resetShutdownState());

describe('desligamento ordenado', () => {
  it('a requisição em andamento TERMINA, a nova é recusada e os fechamentos rodam na ordem; sai com 0', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const handlerEntered = new Promise<void>((r) => (entered = r));
    const { server, port } = await startServer(async (_req, res) => {
      entered();
      await gate;
      res.end('feito');
    });

    const inFlight = get(port); // começa antes do sinal
    await handlerEntered; // só segue quando o servidor JÁ recebeu a requisição (uma espera fixa de 50 ms falhava com a máquina carregada: ECONNRESET)
    const exit = jest.fn();
    const done = shutdown('SIGTERM', {
      server,
      log: log(),
      exit,
      httpGraceMs: 5000,
      closers: [
        { name: 'workers', close: async () => void order.push('workers') },
        { name: 'redis', close: async () => void order.push('redis') },
        { name: 'banco', close: async () => void order.push('banco') },
      ],
    });
    expect(isShuttingDown()).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    await expect(get(port)).rejects.toBeDefined(); // conexão nova: recusada
    expect(order).toEqual([]); // ainda não fechou nada: o HTTP não terminou de drenar

    release();
    expect(await inFlight).toEqual({ status: 200, body: 'feito' }); // a em andamento terminou
    expect(await done).toBe(0);
    expect(order).toEqual(['workers', 'redis', 'banco']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('conexão keep-alive/lenta que não termina é derrubada depois do prazo: o desligamento não fica pendurado', async () => {
    const { server, port } = await startServer(() => {
      /* nunca responde */
    });
    const hang = get(port).catch(() => 'derrubada');
    await new Promise((r) => setTimeout(r, 50));
    const exit = jest.fn();
    const started = Date.now();
    const code = await shutdown('SIGTERM', { server, log: log(), exit, httpGraceMs: 150, closers: [] });
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await hang).toBe('derrubada');
  });

  it('um fechamento que falha (ou passa do prazo) não impede os seguintes; sai com 1 e registra', async () => {
    const { server } = await startServer((_req, res) => res.end());
    const l = log();
    const order: string[] = [];
    const exit = jest.fn();
    const code = await shutdown('SIGTERM', {
      server,
      log: l,
      exit,
      closerTimeoutMs: 80,
      closers: [
        { name: 'quebra', close: async () => { throw new Error('boom'); } },
        { name: 'trava', close: () => new Promise(() => undefined) },
        { name: 'banco', close: async () => void order.push('banco') },
      ],
    });
    expect(code).toBe(1);
    expect(order).toEqual(['banco']);
    expect(l.error).toHaveBeenCalledWith('Falha ao encerrar quebra', { error: 'boom' });
    expect(l.error).toHaveBeenCalledWith('Falha ao encerrar trava', expect.objectContaining({ error: expect.stringContaining('passou de 80 ms') }));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('é idempotente: um segundo sinal não inicia outro desligamento', async () => {
    const { server } = await startServer((_req, res) => res.end());
    const exit = jest.fn();
    const close = jest.fn().mockResolvedValue(undefined);
    const a = shutdown('SIGTERM', { server, log: log(), exit, closers: [{ name: 'x', close }] });
    const b = shutdown('SIGINT', { server, log: log(), exit, closers: [{ name: 'x', close }] });
    expect(b).toBe(a);
    await a;
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
