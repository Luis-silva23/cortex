/**
 * REGRESSÃO (Fase 4): com o Redis fora, `jobQueue.add` não rejeita — fica pendurado esperando a reconexão, e a auditoria só existia na
 * memória do processo (perdida se ele caísse). Agora, passado o prazo, ela é gravada DIRETO no PostgreSQL com o mesmo id da fila.
 */
const addMock = jest.fn();
const persistMock = jest.fn();
jest.mock('../config/queue', () => ({ jobQueue: { add: (...a: any[]) => addMock(...a) } }));
jest.mock('../jobs/audit.job', () => ({ persistAuditLog: (...a: any[]) => persistMock(...a) }));
jest.mock('@ln-system/database', () => ({ prisma: {}, AuditAction: {}, runWithRLSContext: (_c: any, fn: () => any) => fn() }));

import { AUDIT_ENQUEUE_TIMEOUT_MS, auditLog, recordAudit } from './audit';

const data = { id: 'aud-1', companyId: 'c1', userId: 'u1', action: 'UPDATE', entity: 'Sale', entityId: 's1', newValue: '{}' } as any;

beforeEach(() => {
  addMock.mockReset();
  persistMock.mockReset().mockResolvedValue(undefined);
});

describe('auditoria durável (Redis fora)', () => {
  it('fila confirma: nada é gravado direto', async () => {
    addMock.mockResolvedValue({ id: 'aud-1' });
    await recordAudit(data);
    expect(addMock).toHaveBeenCalledWith('audit-log', data, { jobId: 'aud-1' });
    expect(persistMock).not.toHaveBeenCalled();
  });

  it('fila que REJEITA: grava direto com o mesmo id', async () => {
    addMock.mockRejectedValue(new Error('redis down'));
    await recordAudit(data);
    expect(persistMock).toHaveBeenCalledWith(data);
  });

  it('fila que NUNCA responde (Redis fora, comando pendurado): passado o prazo, grava direto — a auditoria não fica só em memória', async () => {
    jest.useFakeTimers();
    try {
      addMock.mockReturnValue(new Promise(() => undefined));
      const done = recordAudit(data);
      await jest.advanceTimersByTimeAsync(AUDIT_ENQUEUE_TIMEOUT_MS + 10);
      await done;
      expect(persistMock).toHaveBeenCalledTimes(1);
      expect(persistMock).toHaveBeenCalledWith(data);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fila e banco fora: não lança (a resposta HTTP já saiu) e registra a falha', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    addMock.mockRejectedValue(new Error('redis down'));
    persistMock.mockRejectedValue(new Error('db down'));
    await expect(recordAudit(data)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('o middleware gera um id por auditoria e o usa como jobId da fila', async () => {
    addMock.mockResolvedValue(undefined);
    const req: any = { user: { companyId: 'c1', userId: 'u1' }, params: { id: 'x1' }, ip: '1.1.1.1', socket: {}, headers: {} };
    const res: any = { statusCode: 200, json: jest.fn() };
    await auditLog('UPDATE' as any, 'Sale')(req, res, jest.fn());
    res.json({ id: 'x1' });
    await new Promise((r) => setImmediate(r));
    const [name, payload, opts] = addMock.mock.calls[0];
    expect(name).toBe('audit-log');
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(opts).toEqual({ jobId: payload.id });
  });
});
