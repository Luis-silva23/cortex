import { advancedRateLimiter } from '../../../src/middlewares/advancedRateLimit';

/**
 * As suítes que fazem login por HTTP chegam todas do mesmo IP (127.0.0.1) e dividem o balde de 5 falhas do limitador
 * (Redis do desenvolvimento). Juntas gastam exatamente o orçamento: dependendo da ordem em que o jest as roda, a
 * seguinte recebe 429 com a senha certa. Cada suíte começa de um balde limpo; o limitador em si não é alterado.
 *
 * Endurecimento DEFENSIVO (2026-10-22), não correção de uma causa provada: antes, se o Redis do limitador não estivesse pronto em 5 s,
 * o reset cairia SÓ na memória de reserva (insuranceLimiter) e deixaria as falhas das suítes anteriores no Redis, sem mensagem. Agora
 * espera até 30 s, confere que o balde voltou ao orçamento cheio e, se não der, FALHA dizendo qual balde está sujo. Medição (rodada R1,
 * CPU saturada, 65 resets): o Redis ficou pronto em no máximo 0,94 s e todos os resets limparam o balde, então esse cenário **não foi
 * observado**; já os baldes chegam à suíte seguinte com falhas acumuladas (19 de 65), o que mostra por que o reset é necessário.
 */
const IPS = ['::ffff:127.0.0.1', '::1', '127.0.0.1'];
const TYPES = ['auth', 'mfa'] as const;

async function dirtyBuckets(): Promise<string[]> {
  const dirty: string[] = [];
  for (const ip of IPS) {
    for (const type of TYPES) {
      const remaining = await advancedRateLimiter.getRemaining(type, ip).catch(() => null);
      if (remaining !== null && remaining < (await fullBudget(type))) dirty.push(`${type}:${ip} (restam ${remaining})`);
    }
  }
  return dirty;
}

async function fullBudget(type: (typeof TYPES)[number]): Promise<number> {
  // saldo de uma chave nunca usada = orçamento cheio configurado (getRemaining devolve `points` quando não há registro)
  return (await advancedRateLimiter.getRemaining(type, `__orcamento_cheio__${type}`)) ?? Infinity;
}

export async function resetAuthLimits(): Promise<void> {
  // A conexão do limitador não enfileira comandos offline: antes de ficar pronta, o reset cairia só na memória de reserva.
  for (let i = 0; i < 600 && !advancedRateLimiter.isUsingRedis(); i++) await new Promise((r) => setTimeout(r, 50));
  if (!advancedRateLimiter.isUsingRedis()) {
    throw new Error('resetAuthLimits: o Redis do limitador não ficou pronto em 30 s; o reset não valeria para o balde compartilhado.');
  }
  let dirty: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const ip of IPS) {
      for (const type of TYPES) await advancedRateLimiter.reset(type, ip);
    }
    dirty = await dirtyBuckets();
    if (dirty.length === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`resetAuthLimits: baldes do limitador continuam consumidos depois de 5 resets: ${dirty.join(', ')}`);
}
