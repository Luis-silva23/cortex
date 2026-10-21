/**
 * Mock global de config/redis.ts para testes — mesmo motivo de
 * config/__mocks__/queue.ts: `new Redis(...)` real trava o Jest sem um
 * servidor Redis disponível. Aplicado via moduleNameMapper.
 */
const redisMock = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  setex: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  exists: jest.fn().mockResolvedValue(0),
  mget: jest.fn().mockResolvedValue([]),
  ping: jest.fn().mockResolvedValue('PONG'),
  on: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
};

export const redis = redisMock;
export default redisMock;
