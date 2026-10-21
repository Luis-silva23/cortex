import { advancedRateLimiter } from '../../../src/middlewares/advancedRateLimit';

/**
 * As suítes que fazem login por HTTP chegam todas do mesmo IP (127.0.0.1) e dividem o balde de 5 falhas do limitador
 * (Redis do desenvolvimento). Juntas gastam exatamente o orçamento: dependendo da ordem em que o jest as roda, a
 * seguinte recebe 429 com a senha certa. Cada suíte começa de um balde limpo; o limitador em si não é alterado.
 */
export async function resetAuthLimits(): Promise<void> {
  // A conexão do limitador não enfileira comandos offline: antes de ficar pronta, o reset cairia só na memória de reserva.
  for (let i = 0; i < 100 && !advancedRateLimiter.isUsingRedis(); i++) await new Promise((r) => setTimeout(r, 50));
  for (const ip of ['::ffff:127.0.0.1', '::1', '127.0.0.1']) {
    for (const type of ['auth', 'mfa'] as const) await advancedRateLimiter.reset(type, ip);
  }
}
