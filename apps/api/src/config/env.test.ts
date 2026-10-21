import { assertEnv, parseTrustProxy, validateEnv } from './env';

const GOOD_PROD = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app:Zq7-forte-9xK@db.interno:5432/cortex?schema=public&sslmode=require',
  REDIS_HOST: 'redis.interno',
  REDIS_PASSWORD: 'outra-senha-forte-123',
  JWT_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  DATA_ENCRYPTION_KEY: 'c'.repeat(44),
  RLS_CONTEXT_SECRET: Buffer.alloc(32, 7).toString('base64'),
  WEB_URL: 'https://app.exemplo.com.br',
  SUPER_ADMIN_URL: 'https://admin.exemplo.com.br',
  TRUST_PROXY: '1',
} as unknown as NodeJS.ProcessEnv;

const withEnv = (over: Record<string, string | undefined>) => {
  const env = { ...GOOD_PROD, ...over } as Record<string, string | undefined>;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env as NodeJS.ProcessEnv;
};

describe('validação da configuração na partida', () => {
  it('configuração de produção correta: sem erro e sem aviso', () => {
    expect(validateEnv(GOOD_PROD)).toEqual({ errors: [], warnings: [] });
  });

  it('segredo ausente é erro em produção (a API não sobe) e só aviso fora dela', () => {
    for (const key of ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'DATA_ENCRYPTION_KEY']) {
      expect(validateEnv(withEnv({ [key]: undefined })).errors.join(' ')).toContain(key);
      const dev = validateEnv(withEnv({ NODE_ENV: 'development', [key]: undefined }));
      expect(dev.errors).toEqual([]);
      expect(dev.warnings.join(' ')).toContain(key);
    }
    expect(validateEnv(withEnv({ REDIS_HOST: undefined, REDIS_URL: undefined })).errors.join(' ')).toContain('Redis não configurado');
  });

  it('senha de exemplo (.env.example/docker-compose) é recusada em produção, no banco e no Redis', () => {
    expect(validateEnv(withEnv({ DATABASE_URL: 'postgresql://lnsystem:lnsystem123@localhost:5432/lnsystem_db' })).errors.join(' ')).toContain('DATABASE_URL usa uma senha de exemplo');
    expect(validateEnv(withEnv({ REDIS_PASSWORD: 'lnsystem123' })).errors.join(' ')).toContain('Redis usa uma senha de exemplo');
    expect(validateEnv(withEnv({ REDIS_PASSWORD: undefined, REDIS_URL: 'redis://:lnsystem123@redis:6379/0' })).errors.join(' ')).toContain('Redis usa uma senha de exemplo');
    // fora de produção a senha de exemplo é normal (desenvolvimento): nenhum erro nem aviso por isso
    const dev = validateEnv(withEnv({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://lnsystem:lnsystem123@localhost:5432/lnsystem_db', REDIS_PASSWORD: 'lnsystem123' }));
    expect(dev.errors).toEqual([]);
    expect(dev.warnings).toEqual([]);
  });

  it('JWT_SECRET igual ao JWT_REFRESH_SECRET é recusado', () => {
    expect(validateEnv(withEnv({ JWT_REFRESH_SECRET: 'a'.repeat(48) })).errors.join(' ')).toContain('independentes');
  });

  it('TRUST_PROXY=true é recusado em produção (X-Forwarded-For forjável); número de saltos e IPs são aceitos; valor inválido é erro', () => {
    expect(validateEnv(withEnv({ TRUST_PROXY: 'true' })).errors.join(' ')).toContain('TRUST_PROXY=true');
    expect(validateEnv(withEnv({ TRUST_PROXY: '2' })).errors).toEqual([]);
    expect(validateEnv(withEnv({ TRUST_PROXY: '10.0.0.0/8, 172.16.0.1' })).errors).toEqual([]);
    expect(validateEnv(withEnv({ TRUST_PROXY: 'qualquer-coisa!' })).errors.join(' ')).toContain('TRUST_PROXY inválido');
    expect(validateEnv(withEnv({ TRUST_PROXY: undefined })).warnings.join(' ')).toContain('TRUST_PROXY não definido');
  });

  it('HTTPS obrigatório: sem proxy declarado (TRUST_PROXY) a API não sobe em produção; ENFORCE_HTTPS=false é a saída explícita, com aviso', () => {
    for (const trust of [undefined, 'false']) {
      expect(validateEnv(withEnv({ TRUST_PROXY: trust })).errors.join(' ')).toContain('HTTPS é obrigatório');
    }
    const optOut = validateEnv(withEnv({ TRUST_PROXY: undefined, ENFORCE_HTTPS: 'false' }));
    expect(optOut.errors).toEqual([]);
    expect(optOut.warnings.join(' ')).toContain('ENFORCE_HTTPS=false');
    expect(validateEnv(withEnv({ NODE_ENV: 'development', TRUST_PROXY: undefined })).errors).toEqual([]);
  });

  it('DEVICE_LEGACY_CUTOFF: data inválida é recusada em produção; data ISO válida e ausente (padrão) passam', () => {
    expect(validateEnv(withEnv({ DEVICE_LEGACY_CUTOFF: 'amanhã' })).errors.join(' ')).toContain('DEVICE_LEGACY_CUTOFF');
    expect(validateEnv(withEnv({ DEVICE_LEGACY_CUTOFF: '2026-11-30T23:59:59-03:00' })).errors).toEqual([]);
    expect(validateEnv(GOOD_PROD).errors).toEqual([]);
  });

  it('avisa (sem recusar) origem sem HTTPS, ausência de origens, Redis sem senha, banco sem TLS e o provedor SIMULADO ligado em produção', () => {
    expect(validateEnv(withEnv({ WEB_URL: 'http://app.exemplo.com.br' })).warnings.join(' ')).toContain('sem HTTPS');
    expect(validateEnv(withEnv({ WEB_URL: undefined, SUPER_ADMIN_URL: undefined })).warnings.join(' ')).toContain('nenhuma origem');
    expect(validateEnv(withEnv({ REDIS_PASSWORD: undefined })).warnings.join(' ')).toContain('Redis sem senha');
    expect(validateEnv(withEnv({ DATABASE_URL: 'postgresql://app:Zq7-forte-9xK@db.externo.com:5432/cortex' })).warnings.join(' ')).toContain('sslmode');
    const sandbox = validateEnv(withEnv({ CHANNEL_SANDBOX_PROVIDER: 'true' }));
    expect(sandbox.errors).toEqual([]);
    expect(sandbox.warnings.join(' ')).toContain('SIMULADO');
    expect(validateEnv(withEnv({ ENABLE_AUTO_BACKUP: 'true' })).warnings.join(' ')).toContain('serviço dedicado');
  });

  it('RLS_CONTEXT_SECRET (assina o contexto de RLS): ausente, curto ou repetido de outro segredo é erro em produção', () => {
    expect(validateEnv(withEnv({ RLS_CONTEXT_SECRET: undefined })).errors.join(' ')).toContain('RLS_CONTEXT_SECRET ausente');
    expect(validateEnv(withEnv({ RLS_CONTEXT_SECRET: Buffer.alloc(16, 1).toString('base64') })).errors.join(' ')).toContain('entre 32 e 64 bytes');
    expect(validateEnv(withEnv({ RLS_CONTEXT_SECRET: 'a'.repeat(48) })).errors.join(' ')).toContain('repete outro segredo');
    const dev = validateEnv(withEnv({ NODE_ENV: 'development', RLS_CONTEXT_SECRET: undefined }));
    expect(dev.errors).toEqual([]);
    expect(dev.warnings.join(' ')).toContain('RLS_CONTEXT_SECRET');
    expect(JSON.stringify(validateEnv(withEnv({ RLS_CONTEXT_SECRET: Buffer.alloc(16, 9).toString('base64') })))).not.toContain(Buffer.alloc(16, 9).toString('base64'));
  });

  it('a credencial de backup (lê todas as empresas) não pode estar no ambiente da API em produção; a exceção é explícita e avisa', () => {
    const url = 'postgresql://lnsystem_backup:Zq7-forte-9xK@db.interno:5432/cortex';
    expect(validateEnv(withEnv({ BACKUP_DATABASE_URL: url })).errors.join(' ')).toContain('BACKUP_DATABASE_URL não pode estar no ambiente da API');
    expect(validateEnv(withEnv({ BACKUP_MODE: 'local' })).errors.join(' ')).toContain('BACKUP_MODE=local');
    const exception = validateEnv(withEnv({ BACKUP_DATABASE_URL: url, ALLOW_API_BACKUP_CREDENTIAL: 'true' }));
    expect(exception.errors).toEqual([]);
    expect(exception.warnings.join(' ')).toContain('herda uma credencial');
    expect(validateEnv(withEnv({ BACKUP_DATABASE_URL: url, NODE_ENV: 'development' })).errors).toEqual([]);
    expect(JSON.stringify(validateEnv(withEnv({ BACKUP_DATABASE_URL: url })))).not.toContain('Zq7-forte-9xK');
  });

  it('o relatório nunca contém o VALOR de um segredo', () => {
    const env = withEnv({ DATABASE_URL: 'postgresql://lnsystem:lnsystem123@localhost:5432/x', JWT_REFRESH_SECRET: 'a'.repeat(48), REDIS_PASSWORD: 'lnsystem123' });
    const text = JSON.stringify(validateEnv(env));
    expect(text).not.toContain('lnsystem123');
    expect(text).not.toContain('a'.repeat(48));
  });

  it('assertEnv lança com TODOS os erros de uma vez em produção; fora dela só registra', () => {
    const log = { warn: jest.fn(), error: jest.fn() };
    expect(() => assertEnv(withEnv({ JWT_SECRET: undefined, DATA_ENCRYPTION_KEY: undefined }), log)).toThrow(/Configuração inválida para produção \(2\)/);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(() => assertEnv(withEnv({ NODE_ENV: 'development', JWT_SECRET: undefined }), log)).not.toThrow();
  });
});

describe('parseTrustProxy', () => {
  it('interpreta cada forma aceita', () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy('')).toBeUndefined();
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toEqual(['loopback', '10.0.0.0/8']);
    expect(() => parseTrustProxy('abc def')).toThrow();
  });
});
