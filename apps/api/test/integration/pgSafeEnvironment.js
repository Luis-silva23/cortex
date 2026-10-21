/**
 * Ambiente de teste da suíte de INTEGRAÇÃO: fecha o pool do PostgreSQL de cada arquivo DEPOIS de tudo que o arquivo roda.
 *
 * CAUSA RAIZ do "Too many database connections opened" intermitente (medido com scripts/pg-sample.ts, 2026-10-14): a contagem de conexões
 * do banco de teste SOBE a cada arquivo de teste (1 → 13 → 33 → 53 → 75 → 91 de 97 permitidas numa rodada de ~107 arquivos) e a suíte só
 * passava enquanto o total de arquivos ficava abaixo do teto; qualquer arquivo novo empurrava a falha para um teste "aleatório".
 * Cada arquivo tem o seu PrismaClient (o Jest mantém um registro de módulos por arquivo). O `disconnectDb.ts` fecha o pool num `afterAll`,
 * mas o `afterAll` do PRÓPRIO teste (destroyFixture, limpezas) roda DEPOIS dele e o Prisma reconecta sozinho.
 *
 * O `teardown` do ambiente roda depois de TODOS os hooks do arquivo: aqui o pool é fechado de verdade. Não aumenta `max_connections`
 * e não cria cliente por operação. Com `PG_ENV_DEBUG=1` mede e imprime as conexões que sobraram depois de fechar (por arquivo).
 */
const path = require('path');
const { TestEnvironment } = require('jest-environment-node');

class PgSafeEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.testFile = path.basename(context?.testPath ?? 'desconhecido');
  }

  async teardown() {
    try {
      // 1) os workers do BullMQ (config/queue.ts) nascem na importação e sobrevivem ao arquivo: fechá-los ANTES do banco, senão consomem
      //    jobs dos arquivos seguintes com este cliente e o reabrem.
      if (typeof this.global.__ln_queue_close === 'function') await this.global.__ln_queue_close();
    } catch {
      // idem: o encerramento nunca derruba a suíte
    }
    try {
      const client = this.global.__ln_system_base_prisma;
      if (client && typeof client.$disconnect === 'function') await client.$disconnect();
      if (process.env.PG_ENV_DEBUG) await this.reportRemaining(client ? 'fechado' : 'AUSENTE');
    } catch {
      // o encerramento do pool nunca derruba a suíte
    }
    await super.teardown();
  }

  /** Somente investigação: quantas conexões do banco de teste continuam abertas logo depois de fechar o cliente deste arquivo. */
  async reportRemaining(state) {
    const { PrismaClient } = require('@prisma/client');
    const url = this.global.process.env.DATABASE_URL; // o setup define DATABASE_URL só dentro do sandbox do teste
    const probe = new PrismaClient({ datasources: { db: { url: `${url}${url.includes('?') ? '&' : '?'}connection_limit=1` } } });
    try {
      const rows = await probe.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND datname = current_database() AND pid <> pg_backend_pid()`
      );
      console.error(`[pgSafeEnvironment] ${this.testFile}: cliente ${state}; conexões restantes no banco: ${rows[0].n}`);
    } finally {
      await probe.$disconnect();
    }
  }
}

module.exports = PgSafeEnvironment;
