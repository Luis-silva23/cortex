import { envLimits, envRetention, resolveEffective, validateOverridesPatch } from './settings.service';

describe('limites do ambiente (o teto)', () => {
  it('padrões conservadores, abaixo dos planos gratuitos conhecidos', () => {
    const l = envLimits({});
    expect(l).toMatchObject({ emailMaxPerHour: 6, emailMaxPerDay: 30, emailMaxPerMonth: 600, sentryMaxPerHour: 30, sentryMaxPerDay: 200, sentrySampleRate: 0.25, sampleMinutes: 5 });
    expect(l.emailMaxPerDay).toBeLessThan(100);
    expect(l.emailMaxPerMonth).toBeLessThan(3000);
  });

  it('valor inválido volta ao padrão e fora da faixa é limitado', () => {
    expect(envLimits({ ALERT_EMAIL_MAX_PER_HOUR: 'abc' }).emailMaxPerHour).toBe(6);
    expect(envLimits({ SENTRY_SAMPLE_RATE: '7' }).sentrySampleRate).toBe(1);
    expect(envLimits({ MONITORING_SAMPLE_MINUTES: '0' }).sampleMinutes).toBe(1);
    expect(envRetention({ MONITORING_SAMPLE_RETENTION_DAYS: '-5' }).sampleDays).toBe(1);
  });
});

describe('ajuste em tempo de execução: só restringe, nunca aumenta consumo', () => {
  const env = { ALERT_EMAIL_MAX_PER_HOUR: '6', MONITORING_SAMPLE_MINUTES: '5' } as NodeJS.ProcessEnv;

  it('limite de teto: vale o MENOR entre o ambiente e o ajuste', () => {
    const e = resolveEffective(env, { limits: { emailMaxPerHour: 2, emailMaxPerDay: 9999 } });
    expect(e.limits.emailMaxPerHour).toBe(2);
    expect(e.limits.emailMaxPerDay).toBe(30); // tentar subir acima do ambiente não surte efeito
    expect(e.overridden).toContain('emailMaxPerHour');
    expect(e.overridden).not.toContain('emailMaxPerDay');
  });

  it('intervalo de coleta: só pode ficar MAIS lento (coletar menos vezes)', () => {
    expect(resolveEffective(env, { limits: { sampleMinutes: 15 } }).limits.sampleMinutes).toBe(15);
    expect(resolveEffective(env, { limits: { sampleMinutes: 1 } }).limits.sampleMinutes).toBe(5);
  });

  it('chaves liga/desliga só podem DESLIGAR', () => {
    expect(resolveEffective(env, null).toggles).toEqual({ emailNotifications: true, smsNotifications: true, whatsappNotifications: true, sentry: true, sampling: true });
    // SMS e WhatsApp: padrões conservadores (custam por mensagem) e o ambiente continua sendo o teto
    expect(resolveEffective(env, null).limits).toMatchObject({ smsMaxPerHour: 3, smsMaxPerDay: 10, whatsappMaxPerHour: 3, whatsappMaxPerDay: 10, smsDedupeMinutes: 120 });
    expect(resolveEffective(env, { limits: { smsMaxPerHour: 99 } }).limits.smsMaxPerHour).toBe(3);
    expect(resolveEffective(env, { limits: { whatsappMaxPerHour: 1 } }).limits.whatsappMaxPerHour).toBe(1);
    expect(resolveEffective(env, { toggles: { sentry: false } }).toggles.sentry).toBe(false);
    expect(resolveEffective(env, { toggles: { sentry: true, sampling: true } }).overridden).toEqual([]);
  });
});

describe('validação do pedido de ajuste', () => {
  it('aceita chaves conhecidas; null remove o ajuste', () => {
    expect(validateOverridesPatch({ toggles: { sentry: false, sampling: null }, limits: { emailMaxPerHour: 3 } })).toEqual({ toggles: { sentry: false, sampling: null }, limits: { emailMaxPerHour: 3 } });
  });
  it.each([
    [null, /Informe os ajustes/],
    [{}, /Nenhum ajuste/],
    [{ toggles: { qualquer: true } }, /desconhecido/],
    [{ toggles: { sentry: 'sim' } }, /verdadeiro, falso ou nulo/],
    [{ limits: { naoExiste: 1 } }, /desconhecido/],
    [{ limits: { emailMaxPerHour: -1 } }, /maior ou igual a zero/],
    [{ limits: { emailMaxPerHour: 'x' } }, /maior ou igual a zero/],
  ])('recusa %j', (patch, message) => {
    expect(() => validateOverridesPatch(patch)).toThrow(message);
  });
});
