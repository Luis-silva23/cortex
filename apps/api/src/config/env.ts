/**
 * Validação da CONFIGURAÇÃO na partida (Fase 4, docs/CORTEX/PRODUCAO.md §3). Em produção, configuração inválida ou com valor de
 * exemplo faz a API RECUSAR a subida (falha fechada) em vez de iniciar "meio configurada". Fora de produção só avisa.
 * Nada aqui lê, loga ou devolve o VALOR de um segredo: só diz qual variável está errada e por quê.
 */
export interface EnvReport {
  errors: string[];
  warnings: string[];
}

/** Senhas dos arquivos de exemplo (`.env.example`, `docker-compose.yml`): nunca valem em produção. */
const SAMPLE_PASSWORDS = ['lnsystem123', 'password', 'postgres', 'changeme', 'change-me', 'senha123'];

const isProduction = (env: NodeJS.ProcessEnv) => env.NODE_ENV === 'production';
const present = (v: string | undefined) => typeof v === 'string' && v.trim().length > 0;

/** `TRUST_PROXY`: número de saltos de proxy confiáveis, `loopback`/`linklocal`/`uniquelocal`, ou lista de IP/CIDR separados por vírgula. */
export type TrustProxySetting = boolean | number | string | string[] | undefined;

export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  if (!present(raw)) return undefined;
  const v = raw!.trim();
  if (v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d{1,2}$/.test(v)) return Number(v);
  const parts = v.split(',').map((p) => p.trim()).filter(Boolean);
  const valid = (p: string) => ['loopback', 'linklocal', 'uniquelocal'].includes(p) || /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(p);
  if (parts.length === 0 || !parts.every(valid)) throw new Error('TRUST_PROXY inválido: use um número de saltos, loopback/linklocal/uniquelocal ou uma lista de IP/CIDR');
  return parts.length === 1 ? parts[0] : parts;
}

function passwordOf(url: string | undefined): string | null {
  if (!present(url)) return null;
  try {
    const u = new URL(url!);
    return u.password ? decodeURIComponent(u.password) : null;
  } catch {
    return null;
  }
}

const isSample = (pw: string | null | undefined) => !!pw && SAMPLE_PASSWORDS.includes(pw.toLowerCase());

export function validateEnv(env: NodeJS.ProcessEnv): EnvReport {
  const prod = isProduction(env);
  const errors: string[] = [];
  const warnings: string[] = [];
  const bad = (msg: string) => (prod ? errors : warnings).push(prod ? msg : `${msg} (em produção a API não sobe)`);

  // ---- banco ----
  if (!present(env.DATABASE_URL)) bad('DATABASE_URL ausente');
  else {
    if (prod && isSample(passwordOf(env.DATABASE_URL))) bad('DATABASE_URL usa uma senha de exemplo');
    if (prod && !/sslmode=(require|verify-ca|verify-full)/i.test(env.DATABASE_URL!) && !/@(localhost|127\.0\.0\.1|postgres)[:/]/i.test(env.DATABASE_URL!)) {
      warnings.push('DATABASE_URL sem sslmode=require: a conexão com o banco não está forçada a usar TLS');
    }
  }

  // ---- Redis ----
  if (!present(env.REDIS_URL) && !present(env.REDIS_HOST)) bad('Redis não configurado (REDIS_URL ou REDIS_HOST)');
  else {
    if (prod && (isSample(env.REDIS_PASSWORD) || isSample(passwordOf(env.REDIS_URL)))) bad('Redis usa uma senha de exemplo');
    if (prod && !present(env.REDIS_PASSWORD) && !passwordOf(env.REDIS_URL)) warnings.push('Redis sem senha: só aceitável em rede privada isolada');
  }

  // ---- segredos ----
  if (!present(env.JWT_SECRET)) bad('JWT_SECRET ausente');
  if (!present(env.JWT_REFRESH_SECRET)) bad('JWT_REFRESH_SECRET ausente');
  if (present(env.JWT_SECRET) && env.JWT_SECRET === env.JWT_REFRESH_SECRET) bad('JWT_SECRET e JWT_REFRESH_SECRET são iguais (devem ser independentes)');
  if (!present(env.DATA_ENCRYPTION_KEY)) bad('DATA_ENCRYPTION_KEY ausente');
  // Segredo que ASSINA o contexto de RLS (decisão 151): sem ele o banco, que exige a assinatura, nega tudo. 32 a 64 bytes em base64; diferente dos demais segredos.
  if (!present(env.RLS_CONTEXT_SECRET)) bad('RLS_CONTEXT_SECRET ausente (assina o contexto de RLS; ver docs/CORTEX/RLS_CONTEXTO_ASSINADO.md)');
  else {
    const bytes = Buffer.from(env.RLS_CONTEXT_SECRET!.trim(), 'base64').length;
    if (bytes < 32 || bytes > 64) bad('RLS_CONTEXT_SECRET inválido: precisa ter entre 32 e 64 bytes em base64');
    if ([env.JWT_SECRET, env.JWT_REFRESH_SECRET, env.DATA_ENCRYPTION_KEY].some((s) => present(s) && s!.trim() === env.RLS_CONTEXT_SECRET!.trim())) {
      bad('RLS_CONTEXT_SECRET repete outro segredo (JWT/DATA_ENCRYPTION_KEY): cada segredo deve ser independente');
    }
  }

  // ---- porta ----
  if (present(env.API_PORT) && !/^\d{2,5}$/.test(env.API_PORT!.trim())) bad('API_PORT inválida');

  // ---- proxy / IP real ----
  try {
    const trust = parseTrustProxy(env.TRUST_PROXY);
    if (trust === true) bad('TRUST_PROXY=true confia em QUALQUER X-Forwarded-For (o IP pode ser falsificado: limite de tentativas e bloqueio por IP perdem o sentido); informe o número de saltos ou os IPs do proxy');
    if (prod && trust === undefined) warnings.push('TRUST_PROXY não definido: atrás de proxy/balanceador todas as requisições parecem vir do mesmo IP (limites e bloqueios por IP ficam agregados)');
    // HTTPS obrigatório (middleware/https.ts): a API não termina TLS, então só reconhece a conexão segura pelo X-Forwarded-Proto de um
    // proxy declarado em TRUST_PROXY. Sem isso, com a exigência ligada, TODA requisição seria recusada (426): melhor não subir.
    if (prod && env.ENFORCE_HTTPS !== 'false' && (trust === undefined || trust === false)) {
      errors.push('HTTPS é obrigatório em produção e a API não termina TLS: defina TRUST_PROXY (proxy com TLS à frente, enviando X-Forwarded-Proto) ou, só em rede interna sem TLS, ENFORCE_HTTPS=false');
    }
    if (prod && env.ENFORCE_HTTPS === 'false') warnings.push('ENFORCE_HTTPS=false em produção: a API aceita HTTP puro (credenciais e dados sem criptografia em trânsito); só aceitável em rede interna isolada');
  } catch (err) {
    bad((err as Error).message);
  }

  // ---- corte do legado de equipamento sem chave (services/device-legacy.ts) ----
  if (present(env.DEVICE_LEGACY_CUTOFF) && Number.isNaN(new Date(env.DEVICE_LEGACY_CUTOFF!).getTime())) {
    bad('DEVICE_LEGACY_CUTOFF inválida (use uma data ISO, ex.: 2026-12-31T23:59:59-03:00)');
  }

  // ---- origens (CORS) ----
  const origins = [env.WEB_URL, env.SUPER_ADMIN_URL, env.BALCAO_URL].filter(present) as string[];
  if (prod) {
    if (origins.length === 0) warnings.push('WEB_URL/SUPER_ADMIN_URL ausentes: nenhuma origem de navegador será liberada (CORS)');
    for (const o of origins) {
      if (!/^https:\/\//i.test(o)) warnings.push(`Origem ${o.replace(/^[a-z]+:\/\//i, '').split('/')[0]} sem HTTPS`);
    }
  }

  // ---- MFA obrigatório (decisões 123 e bootstrap): em produção a política não pode ser desligada por variável ----
  if (prod && env.REQUIRE_MFA_PRIVILEGED?.trim().toLowerCase() === 'false') errors.push('REQUIRE_MFA_PRIVILEGED=false é recusado em produção: o Super Admin exige MFA');
  if (prod && env.REQUIRE_MFA_COMPANY_ADMIN?.trim().toLowerCase() === 'false') errors.push('REQUIRE_MFA_COMPANY_ADMIN=false é recusado em produção: o administrador da empresa exige MFA');

  // ---- provedor simulado e integrações ----
  if (prod && env.CHANNEL_SANDBOX_PROVIDER === 'true') warnings.push('CHANNEL_SANDBOX_PROVIDER=true em produção: o provedor SIMULADO está registrado de propósito; confirme que é intencional');
  // ---- credencial de backup: o papel de backup LÊ TUDO (BYPASSRLS); o processo da API não deve tê-la (decisão 152). O backup é do serviço dedicado. ----
  if (prod && present(env.BACKUP_DATABASE_URL)) {
    if (env.ALLOW_API_BACKUP_CREDENTIAL === 'true') warnings.push('BACKUP_DATABASE_URL presente na API (exceção ALLOW_API_BACKUP_CREDENTIAL=true): quem comprometer a API herda uma credencial que lê todas as empresas');
    else errors.push('BACKUP_DATABASE_URL não pode estar no ambiente da API em produção: o backup roda no serviço dedicado (deploy/backup) com credencial própria. Remova a variável (ou, como exceção consciente, ALLOW_API_BACKUP_CREDENTIAL=true)');
  }
  if (prod && env.BACKUP_MODE === 'local' && env.ALLOW_API_BACKUP_CREDENTIAL !== 'true') errors.push('BACKUP_MODE=local exige a credencial de backup na API: recusado em produção (use BACKUP_MODE=delegated)');
  if (prod && env.ENABLE_AUTO_BACKUP === 'true' && !present(env.BACKUP_DATABASE_URL) && env.BACKUP_MODE !== 'delegated') warnings.push('ENABLE_AUTO_BACKUP=true sem credencial de backup na API: o agendamento é do serviço dedicado (BACKUP_MODE=delegated)');

  return { errors, warnings };
}

/** Chamada na partida: registra os avisos e, em produção, lança com TODOS os erros de uma vez (a API não sobe). */
export function assertEnv(env: NodeJS.ProcessEnv, log: { warn: (m: string) => void; error: (m: string) => void }): EnvReport {
  const report = validateEnv(env);
  for (const w of report.warnings) log.warn(`Configuração: ${w}`);
  if (report.errors.length > 0) {
    for (const e of report.errors) log.error(`Configuração inválida: ${e}`);
    throw new Error(`Configuração inválida para produção (${report.errors.length}): ${report.errors.join('; ')}`);
  }
  return report;
}
