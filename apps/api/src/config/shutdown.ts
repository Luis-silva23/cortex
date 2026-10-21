import type { Server } from 'http';

/**
 * DESLIGAMENTO ORDENADO (Fase 4, docs/CORTEX/PRODUCAO.md §5). Um só orquestrador para SIGTERM/SIGINT, na ordem que não perde trabalho:
 *   1. marca "drenando": a sonda de prontidão passa a responder 503 (o balanceador tira a instância da rotação) e a de vida continua 200;
 *   2. para de aceitar conexões novas e fecha as ociosas; as requisições em andamento terminam; depois de `httpGraceMs` as conexões
 *      que sobraram (keep-alive preso) são derrubadas — o desligamento nunca fica pendurado esperando um cliente lento;
 *   3. só então fecha, em ordem, o que o HTTP usa (workers e filas — `worker.close()` espera o job ativo terminar —, Redis, bancos);
 *   4. prazo TOTAL (`timeoutMs`): estourou, sai com código 1 e deixa o registro. Fechamento que falha não impede os seguintes.
 * Idempotente: um segundo sinal não inicia outro desligamento.
 */
export interface Closer {
  name: string;
  close: () => Promise<unknown>;
}

export interface ShutdownLog {
  info: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ShutdownOptions {
  server: Pick<Server, 'close' | 'closeIdleConnections' | 'closeAllConnections'>;
  closers: Closer[];
  log: ShutdownLog;
  /** Termina o processo (injetável para teste). */
  exit: (code: number) => void;
  /** Prazo total. Padrão 25 s (abaixo dos 30 s que orquestradores costumam dar antes do SIGKILL). */
  timeoutMs?: number;
  /** Quanto esperar as requisições em andamento antes de derrubar as conexões que sobraram. Padrão 10 s. */
  httpGraceMs?: number;
  /** Prazo de cada fechamento. Padrão 8 s. */
  closerTimeoutMs?: number;
}

let draining = false;
let running: Promise<number> | null = null;

/** Verdadeiro desde o início do desligamento: a sonda de prontidão responde 503. */
export const isShuttingDown = () => draining;

/** Só para teste. */
export function resetShutdownState() {
  draining = false;
  running = null;
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} passou de ${ms} ms`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export function shutdown(signal: string, opts: ShutdownOptions): Promise<number> {
  if (running) return running;
  draining = true;
  const { server, closers, log, exit, timeoutMs = 25_000, httpGraceMs = 10_000, closerTimeoutMs = 8_000 } = opts;

  running = (async () => {
    log.info(`${signal} recebido — desligamento ordenado iniciado (a instância sai da rotação)`);
    let failures = 0;

    const hardStop = setTimeout(() => {
      log.error('Desligamento passou do prazo total — saída forçada');
      server.closeAllConnections?.();
      exit(1);
    }, timeoutMs);
    hardStop.unref?.();

    // 1) HTTP: para de aceitar, fecha as conexões ociosas e dá um prazo às que estão trabalhando.
    const httpClosed = new Promise<void>((resolve) => {
      server.close((err?: Error) => {
        if (err) log.error('Erro ao fechar o servidor HTTP', { error: err.message });
        resolve();
      });
    });
    server.closeIdleConnections?.();
    const grace = setTimeout(() => {
      log.info('Conexões HTTP ainda abertas depois do prazo: derrubando as que sobraram');
      server.closeAllConnections?.();
    }, httpGraceMs);
    grace.unref?.();
    await httpClosed;
    clearTimeout(grace);

    // 2) o que o HTTP usava, em ordem; uma falha não impede as seguintes
    for (const c of closers) {
      try {
        await withTimeout(c.close(), closerTimeoutMs, `fechar ${c.name}`);
        log.info(`Encerrado: ${c.name}`);
      } catch (err) {
        failures += 1;
        log.error(`Falha ao encerrar ${c.name}`, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    clearTimeout(hardStop);
    const code = failures > 0 ? 1 : 0;
    log.info('Desligamento concluído', { exitCode: code, closeFailures: failures });
    exit(code);
    return code;
  })();
  return running;
}

/** Liga SIGTERM e SIGINT ao orquestrador. */
export function registerGracefulShutdown(opts: Omit<ShutdownOptions, 'exit'> & { exit?: (code: number) => void }) {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void shutdown(signal, { ...opts, exit }));
}
