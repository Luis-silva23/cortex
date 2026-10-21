jest.mock('@ln-system/database', () => ({ prisma: { company: { findUnique: jest.fn().mockResolvedValue({ name: 'Loja Teste' }) } }, runWithRLSContext: (_ctx: unknown, fn: () => unknown) => fn() }));
jest.mock('./alert-events', () => ({ recordAlertEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./resend.service', () => ({ ...jest.requireActual('./resend.service'), sendEmail: jest.fn() }));

import { recordAlertEvent } from './alert-events';
import { sendEmail } from './resend.service';
import { alertDedupeKey, composeAlertEmail, minSeverityRank, notifyAlert, type NotifiableAlert } from './notifier';

const FULL = { RESEND_API_KEY: 're_k_123456789', ALERT_EMAIL_FROM: 'a@exemplo.test', ALERT_EMAIL_TO: 'o@exemplo.test', RESEND_DOMAIN_VERIFIED: 'true', SUPER_ADMIN_URL: 'https://super.exemplo.test/' } as unknown as NodeJS.ProcessEnv;
const alert = (over: Partial<NotifiableAlert> = {}): NotifiableAlert => ({ id: 'a1', type: 'DATABASE_DEGRADED', severity: 'CRITICAL', companyId: null, branchId: null, deviceId: null, detail: 'latência 1500 ms', value: 1500, threshold: 1000, ...over });

beforeEach(() => jest.clearAllMocks());

describe('texto do aviso', () => {
  it('leva só dados operacionais objetivos, a orientação e o link; nada de segredo', () => {
    const m = composeAlertEmail(alert({ companyId: 'c1' }), 'OPENED', 'Loja Teste', 'https://super.exemplo.test/');
    expect(m.subject).toBe('[CÓRTEX] CRITICAL · DATABASE_DEGRADED · Loja Teste');
    expect(m.text).toContain('Novo alerta CRITICAL — DATABASE (DATABASE_DEGRADED)');
    expect(m.text).toContain('Alvo: empresa Loja Teste');
    expect(m.text).toContain('Valor: 1500 (limite: 1000)');
    expect(m.text).toContain('Orientação:');
    expect(m.text).toContain('https://super.exemplo.test/dashboard/observability/alertas');
    expect(m.text).not.toMatch(/password|senha|token|secret/i);
  });
  it('infraestrutura central e reincidência', () => {
    const m = composeAlertEmail(alert(), 'REOPENED', null, undefined);
    expect(m.text).toContain('Alerta reincidente');
    expect(m.text).toContain('Alvo: infraestrutura central');
    expect(m.text).not.toContain('Central de alertas:');
  });
  it('mesma chave para o mesmo problema, alvo e gravidade', () => {
    expect(alertDedupeKey(alert())).toBe('alert:DATABASE_DEGRADED:central:-:-:CRITICAL');
    expect(alertDedupeKey(alert({ severity: 'ATTENTION' }))).not.toBe(alertDedupeKey(alert()));
  });
  it('gravidade mínima: CRITICAL por padrão; ATTENTION só por escolha', () => {
    expect(minSeverityRank({})).toBe(3);
    expect(minSeverityRank({ ALERT_EMAIL_MIN_SEVERITY: 'attention' } as unknown as NodeJS.ProcessEnv)).toBe(2);
  });
});

describe('notifyAlert', () => {
  it('sem provedor autorizado: não faz nada (nem consulta o banco)', async () => {
    await notifyAlert(alert(), 'OPENED', {} as NodeJS.ProcessEnv);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(recordAlertEvent).not.toHaveBeenCalled();
  });

  it('abaixo da gravidade mínima: não avisa', async () => {
    await notifyAlert(alert({ severity: 'ATTENTION' }), 'OPENED', FULL);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('crítico com provedor: envia e registra NOTIFICADO no histórico do alerta', async () => {
    (sendEmail as jest.Mock).mockResolvedValue({ status: 'SENT' });
    await notifyAlert(alert({ companyId: 'c1' }), 'OPENED', FULL);
    expect((sendEmail as jest.Mock).mock.calls[0][0]).toMatchObject({ dedupeKey: 'alert:DATABASE_DEGRADED:c1:-:-:CRITICAL', alertId: 'a1' });
    expect(recordAlertEvent).toHaveBeenCalledWith({ alertId: 'a1', companyId: 'c1', kind: 'NOTIFIED', note: 'e-mail de alerta enviado' });
  });

  it('suprimido por limite ou repetição: registra o motivo; falha de entrega: registra a falha; nunca lança', async () => {
    (sendEmail as jest.Mock).mockResolvedValueOnce({ status: 'SUPPRESSED', reason: 'HOUR_CAP' });
    await notifyAlert(alert(), 'OPENED', FULL);
    expect(recordAlertEvent).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'NOTIFICATION_SUPPRESSED', note: 'HOUR_CAP' }));
    (sendEmail as jest.Mock).mockResolvedValueOnce({ status: 'FAILED', reason: 'http_429' });
    await notifyAlert(alert(), 'OPENED', FULL);
    expect(recordAlertEvent).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'NOTIFICATION_FAILED', note: 'http_429' }));
    (sendEmail as jest.Mock).mockRejectedValueOnce(new Error('explodiu'));
    await expect(notifyAlert(alert(), 'OPENED', FULL)).resolves.toBeUndefined();
  });

  it('desligado ou não configurado não deixa rastro no histórico do alerta', async () => {
    (sendEmail as jest.Mock).mockResolvedValue({ status: 'SUPPRESSED', reason: 'DISABLED' });
    await notifyAlert(alert(), 'OPENED', FULL);
    expect(recordAlertEvent).not.toHaveBeenCalled();
  });
});
