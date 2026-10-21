/** @type {import('jest').Config} */
// Testes unitários das regras puras do Admin Web (lib/**). jest/ts-jest vêm
// hoisted do workspace (mesmas versões de apps/api) — nenhuma dependência nova.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/lib/**/*.test.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          target: 'ES2020',
          esModuleInterop: true,
          strict: true,
          isolatedModules: true,
        },
      },
    ],
  },
};
