/**
 * MEDIÇÃO DO HASH DE SENHA (decisão 121) — tempo e memória no HARDWARE ONDE FOR EXECUTADA. Sem banco, sem senha real, sem carga:
 * amostra pequena e sequencial (20 hashes/verificações por perfil) e um único pico com 3 verificações simultâneas.
 *
 *   npm run password:bench
 *
 * Imprime JSON: CPU, núcleos, RAM, parâmetros, mediana e p95 em ms (hash e verificação) e o pico de RSS acima da linha de base.
 * O resultado só vale para a máquina em que rodou — para homologação/produção, rode no servidor-alvo (alvo usual: 50–100 ms por verificação).
 */
import * as os from 'os';
import * as crypto from 'crypto';
import { hashPassword, comparePassword } from '@ln-system/shared/utils/password';

const SAMPLES = 20;
const MB = 1024 * 1024;

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const round = (n: number) => Math.round(n * 10) / 10;

async function timeMs<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t0 = process.hrtime.bigint();
  const value = await fn();
  return [Number(process.hrtime.bigint() - t0) / 1e6, value];
}

async function peakRss<T>(fn: () => Promise<T>): Promise<{ value: T; peakMB: number }> {
  const base = process.memoryUsage().rss;
  let peak = base;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2);
  try {
    const value = await fn();
    peak = Math.max(peak, process.memoryUsage().rss);
    return { value, peakMB: (peak - base) / MB };
  } finally {
    clearInterval(timer);
  }
}

async function profile(label: string, env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try {
    const password = `bench-${crypto.randomBytes(12).toString('hex')}-Aa1!`;
    const first = await hashPassword(password); // aquecimento (carrega o módulo nativo)
    await comparePassword(password, first);
    const hashes: number[] = [];
    const verifies: number[] = [];
    let lastHash = first;
    for (let i = 0; i < SAMPLES; i++) {
      const [h, hashed] = await timeMs(() => hashPassword(password));
      hashes.push(h);
      lastHash = hashed;
      const [v, ok] = await timeMs(() => comparePassword(password, hashed));
      if (!ok) throw new Error('verificação falhou na medição');
      verifies.push(v);
    }
    const wrong = await timeMs(() => comparePassword('senha-errada-xyz', lastHash));
    const concurrent = await peakRss(() => Promise.all([0, 1, 2].map(() => comparePassword(password, lastHash))));
    const single = await peakRss(() => comparePassword(password, lastHash));
    hashes.sort((a, b) => a - b);
    verifies.sort((a, b) => a - b);
    return {
      perfil: label,
      parametros: lastHash.startsWith('$argon2id$') ? (/m=(\d+),t=(\d+),p=(\d+)/.exec(lastHash) ?? []).slice(1).map(Number) : 'bcrypt (custo ' + (/^\$2[aby]\$(\d+)\$/.exec(lastHash)?.[1] ?? '?') + ')',
      hashMs: { mediana: round(pct(hashes, 50)), p95: round(pct(hashes, 95)) },
      verificarMs: { mediana: round(pct(verifies, 50)), p95: round(pct(verifies, 95)) },
      senhaErradaMs: round(wrong[0]),
      picoRssMB: { umaVerificacao: round(single.peakMB), tresSimultaneas: round(concurrent.peakMB) },
    };
  } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

async function main() {
  const cpus = os.cpus();
  const result = {
    ambiente: {
      so: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: cpus[0]?.model?.replace(/\s+/g, ' ').trim(),
      nucleosLogicos: cpus.length,
      ramTotalGB: round(os.totalmem() / (1024 * MB)),
      node: process.version,
      amostrasPorPerfil: SAMPLES,
      observacao: 'medição na máquina de trabalho; NÃO representa o servidor de destino',
    },
    perfis: [
      await profile('Argon2id padrão do sistema (OWASP: 19 MiB, t=2, p=1)', { PASSWORD_HASH_ALGORITHM: undefined, ARGON2_MEMORY_KIB: undefined, ARGON2_TIME_COST: undefined, ARGON2_PARALLELISM: undefined }),
      await profile('Argon2id alternativa OWASP (46 MiB, t=1, p=1)', { PASSWORD_HASH_ALGORITHM: undefined, ARGON2_MEMORY_KIB: '47104', ARGON2_TIME_COST: '1', ARGON2_PARALLELISM: '1' }),
      await profile('bcrypt (algoritmo anterior; custo 12)', { PASSWORD_HASH_ALGORITHM: 'bcrypt', BCRYPT_ROUNDS: undefined }),
    ],
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`[erro] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
