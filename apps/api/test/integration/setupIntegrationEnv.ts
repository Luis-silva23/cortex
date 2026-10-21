// Setup da suíte de INTEGRAÇÃO (real Postgres/Redis) — ao contrário de
// test/setupEnv.ts (só define segredos JWT fixos para a suíte mockada),
// aqui carregamos o .env real do pacote, porque packages/database lê
// DATABASE_URL na hora do import.
//
// SEGURANÇA DO BANCO (regra da rodada de 2026-09-21): os testes NUNCA rodam contra o banco de
// desenvolvimento/demonstração. Um teste destrutivo com filtro `undefined` já apagou dados do banco
// de dev (deleteMany sem filtro efetivo). Agora a suíte usa um banco DEDICADO (`lnsystem_test`, por
// padrão derivado do DATABASE_URL, ou TEST_DATABASE_URL) e RECUSA iniciar se o banco resolvido não
// for claramente de teste. Preparar/atualizar o banco de teste: `npm run test:integration:prepare`.
import * as dotenv from 'dotenv';
import * as path from 'path';
import { assertIsTestDatabase, deriveTestDatabaseUrl } from './helpers/test-database';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const devUrl = process.env.DATABASE_URL;
if (!devUrl && !process.env.TEST_DATABASE_URL) {
  throw new Error(
    'DATABASE_URL ausente — a suíte de integração precisa de apps/api/.env apontando para um PostgreSQL real (o banco de teste é derivado dele).'
  );
}

const testUrl = process.env.TEST_DATABASE_URL || deriveTestDatabaseUrl(devUrl!);
assertIsTestDatabase(testUrl, devUrl);
process.env.DATABASE_URL = testUrl;

// Redis separado do de desenvolvimento (chaves de cache/rate limit/sessão não se misturam com as do app rodando).
process.env.REDIS_DB = process.env.TEST_REDIS_DB ?? '1';
