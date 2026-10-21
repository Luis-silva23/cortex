/** @type {import('jest').Config} */
// Config SEPARADA da suíte unitária (jest.config.js na raiz do pacote).
// A suíte unitária mocka Prisma/Redis/BullMQ globalmente — esta suíte é o
// oposto de propósito: roda contra PostgreSQL e Redis REAIS (os mesmos já
// usados pelo `npm run dev` local), sem nenhum mock, para pegar a classe de
// bug que só aparece com RLS/concorrência reais (TASK-005 do
// quadro de tarefas original — o bug de `error.meta.target` sumindo
// sob a extensão de RLS só foi encontrado por teste de carga real, nunca
// pela suíte mockada).
module.exports = {
  preset: 'ts-jest',
  // Ambiente próprio: fecha o pool do PostgreSQL de cada arquivo DEPOIS de todos os hooks (ver pgSafeEnvironment.js — causa do
  // "Too many database connections opened" intermitente).
  testEnvironment: '<rootDir>/test/integration/pgSafeEnvironment.js',
  rootDir: '../..',
  testMatch: ['<rootDir>/test/integration/**/*.integration.test.ts'],
  setupFiles: ['<rootDir>/test/integration/setupIntegrationEnv.ts'],
  // Fecha o PrismaClient de cada arquivo ao terminar (senão as conexões se acumulam e estouram o
  // max_connections do Postgres de dev — ver comentário em disconnectDb.ts).
  setupFilesAfterEnv: ['<rootDir>/test/integration/dbSafetyGuard.ts', '<rootDir>/test/integration/disconnectDb.ts'],
  // Concorrência real + várias tentativas de retry com jitter podem levar
  // alguns segundos por teste — bem mais que o padrão de 5s do Jest.
  testTimeout: 30000,
  modulePathIgnorePatterns: ['<rootDir>/dist'],
  // --runInBand é aplicado via script npm (test:integration), não aqui:
  // testes de concorrência precisam controlar a paralelização DENTRO de um
  // teste (Promise.all), não entre arquivos de teste do Jest.
};
