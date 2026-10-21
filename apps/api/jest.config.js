/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/scripts/**/*.test.ts'],
  setupFiles: ['<rootDir>/test/setupEnv.ts'],
  clearMocks: true,
  // Without this, jest-haste-map scans the compiled dist/ output too and
  // complains about "duplicate manual mock" for every file under
  // config/__mocks__ (the same mock exists as both src/*.ts and the
  // compiled dist/*.js) — harmless but noisy once a build has run locally.
  modulePathIgnorePatterns: ['<rootDir>/dist'],
  moduleNameMapper: {
    // Isola os testes de infraestrutura real (Prisma/Redis/BullMQ) —
    // exigem PostgreSQL/Redis reais e não estão disponíveis neste ambiente.
    // Prisma é mockado explicitamente por teste (jest.mock('@prisma/client', ...)),
    // mas config/queue.ts e config/redis.ts abrem conexões reais como efeito
    // colateral do próprio `require` (Queue/Worker/Redis do BullMQ/ioredis) —
    // isso travava `npm test` inteiro assim que QUALQUER caminho de código
    // sob teste chamava Logger.security/critical/integrationPersisted (que
    // fazem `require('../config/queue')` tardio) sem que o teste mockasse
    // esse módulo manualmente. Mapear globalmente aqui garante que TODO
    // teste, presente ou futuro, use os mocks em config/__mocks__/ — não é
    // opt-in por arquivo de teste.
    '(.*)/config/queue$': '<rootDir>/src/config/__mocks__/queue.ts',
    '(.*)/config/redis$': '<rootDir>/src/config/__mocks__/redis.ts',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/index.ts', // bootstrap com efeitos colaterais (Redis/queue) — fora do escopo de teste unitário
  ],
};
