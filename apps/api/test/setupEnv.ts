// Variáveis de ambiente mínimas para rodar os testes unitários sem infraestrutura real.
// NUNCA reutilizar estes valores fora do ambiente de teste.
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-only-jwt-secret-32-chars-minimum-000000';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-only-refresh-secret-32-chars-minimum-000';
// 32 bytes fixos em base64 — só para testes (secret-box).
process.env.DATA_ENCRYPTION_KEY =
  process.env.DATA_ENCRYPTION_KEY || Buffer.from('test-only-data-key-32-bytes-0000').toString('base64');
process.env.NODE_ENV = 'test';
