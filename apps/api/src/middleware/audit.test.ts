/**
 * ACHADO DE AUDITORIA (segurança): `auditLog` gravava `newValue: JSON.stringify(body.data)`
 * cru. `POST /mfa/setup` responde `data: { secret, qrCode, backupCodes }` — o
 * segredo TOTP e os códigos de backup em texto puro iam parar em `audit_logs`,
 * legível por SUPER_ADMIN/COMPANY_ADMIN/MANAGER em `GET /audit-logs` (e nos
 * jobs guardados no Redis): quem lê o audit contorna o segundo fator do colega.
 */

const jobAddMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../config/queue', () => ({
  jobQueue: { add: (...args: any[]) => jobAddMock(...args) },
}));

jest.mock('@ln-system/database', () => ({
  prisma: {},
  AuditAction: { CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE' },
  runWithRLSContext: (_ctx: any, fn: () => any) => fn(),
}));

import { auditLog, redactSensitive } from './audit';

function run(body: any, statusCode = 200) {
  const originalSend = jest.fn();
  const req: any = { user: { companyId: 'company-A', userId: 'user-1' }, params: {}, ip: '127.0.0.1', socket: {}, headers: {} };
  const res: any = { statusCode, json: originalSend };
  auditLog('UPDATE' as any, 'User')(req, res, jest.fn());
  res.json(body);
  return { originalSend };
}

beforeEach(() => jobAddMock.mockClear());

describe('redactSensitive', () => {
  it('troca segredos, senhas, tokens, QR code e códigos de backup, em qualquer profundidade', () => {
    const out: any = redactSensitive({
      id: 'u1',
      secret: 'JBSWY3DPEHPK3PXP',
      qrCode: 'data:image/png;base64,AAAA',
      backupCodes: ['1111-1111', '2222-2222'],
      nested: { password: 'Senha123!', refreshToken: 'abc', keep: 'ok' },
      list: [{ mfaSecret: 'X-SECRET' }, { name: 'ok' }],
      certificatePassword: 'pfx-pass',
      cscToken: 'csc-value',
    });
    const text = JSON.stringify(out);
    for (const secret of ['JBSWY3DPEHPK3PXP', 'base64,AAAA', '1111-1111', '2222-2222', 'Senha123!', 'abc', 'pfx-pass', 'X-SECRET', 'csc-value']) {
      expect(text).not.toContain(secret);
    }
    expect(out.id).toBe('u1');
    expect(out.nested.keep).toBe('ok');
    expect(out.list[1].name).toBe('ok');
  });

  it('credencial de dispositivo (JWT de 10 anos emitido em POST /activations/:id/approve) NÃO vai para o audit', () => {
    // Formato real da resposta de approve: { success, data: { updatedActivation, updatedDevice, credential } }
    const deviceJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJkZXZpY2VJZCI6ImQxIn0.assinatura-fake';
    const out: any = redactSensitive({
      updatedActivation: { id: 'a1', status: 'APPROVED' },
      updatedDevice: { id: 'd1', status: 'ACTIVE' },
      credential: deviceJwt,
      headers: { authorization: 'Bearer abc.def.ghi', cookie: 'sid=123' },
    });
    const text = JSON.stringify(out);
    for (const secret of [deviceJwt, 'abc.def.ghi', 'sid=123']) expect(text).not.toContain(secret);
    expect(out.updatedDevice.status).toBe('ACTIVE');
    expect(out.updatedActivation.id).toBe('a1');
  });

  it('não mexe em flags booleanas nem em campos comuns (mfaEnabled, hasCertificatePassword)', () => {
    const out: any = redactSensitive({ mfaEnabled: true, hasCertificatePassword: false, hasCscToken: true, name: 'Ana', total: 10 });
    expect(out).toEqual({ mfaEnabled: true, hasCertificatePassword: false, hasCscToken: true, name: 'Ana', total: 10 });
  });

  it('null, undefined e primitivos passam intactos', () => {
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(undefined)).toBeUndefined();
    expect(redactSensitive('texto')).toBe('texto');
    expect(redactSensitive(3)).toBe(3);
  });

  it('não altera o objeto original (a resposta ao cliente continua completa)', () => {
    const original = { secret: 'S', backupCodes: ['a'] };
    redactSensitive(original);
    expect(original).toEqual({ secret: 'S', backupCodes: ['a'] });
  });
});

describe('auditLog — o que vai para a fila', () => {
  it('POST /mfa/setup: o segredo e os códigos de backup NÃO vão para o audit; o cliente ainda os recebe', () => {
    const body = {
      success: true,
      data: { secret: 'JBSWY3DPEHPK3PXP', qrCode: 'data:image/png;base64,AAAA', backupCodes: ['1111-1111', '2222-2222'] },
    };
    const { originalSend } = run(body);

    expect(jobAddMock).toHaveBeenCalledTimes(1);
    const payload = jobAddMock.mock.calls[0][1];
    expect(payload.newValue).not.toContain('JBSWY3DPEHPK3PXP');
    expect(payload.newValue).not.toContain('1111-1111');
    expect(payload.newValue).not.toContain('base64,AAAA');
    expect(payload).toMatchObject({ companyId: 'company-A', userId: 'user-1', action: 'UPDATE', entity: 'User' });
    // a resposta original (com o segredo) segue intacta para quem chamou
    expect(originalSend).toHaveBeenCalledWith(body);
  });

  it('dados comuns continuam sendo registrados como antes', () => {
    run({ success: true, data: { id: 'p1', name: 'Filtro', salePrice: '10.00' } });
    const payload = jobAddMock.mock.calls[0][1];
    expect(JSON.parse(payload.newValue)).toEqual({ id: 'p1', name: 'Filtro', salePrice: '10.00' });
    expect(payload.entityId).toBe('p1');
  });

  it('resposta que não é 2xx não gera auditoria', () => {
    run({ error: 'x' }, 400);
    expect(jobAddMock).not.toHaveBeenCalled();
  });
});
