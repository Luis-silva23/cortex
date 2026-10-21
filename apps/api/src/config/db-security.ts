/**
 * CONFERÊNCIA DE SEGURANÇA DO BANCO NA PARTIDA (decisão 151/148): a RLS só protege se (1) o banco EXIGE o contexto assinado, (2) a API
 * consegue assinar de um jeito que o banco aceita e (3) a API NÃO conecta como superusuário/BYPASSRLS (que ignoram a RLS inteira — foi o que o
 * docker-compose fazia antes). Em produção qualquer falha recusa a subida; fora dela só avisa. Nada aqui lê, loga ou devolve o VALOR de
 * um segredo nem uma URL de conexão.
 */
export interface DbProbe {
  /** `SELECT enforced, secret_slots FROM app_ctx.status()` (função pública, sem segredo). */
  status(): Promise<{ enforced: boolean; secretSlots: number } | null>;
  /** O banco aceita um contexto de plataforma assinado agora? (assina, aplica e pergunta `app_ctx.is_super_admin()`). */
  signedContextAccepted(): Promise<boolean>;
  /** Papel da conexão: superusuário? BYPASSRLS? quantas tabelas de `public` ele possui? */
  role(): Promise<{ superuser: boolean; bypassRls: boolean; ownedTables: number }>;
}

export interface DbSecurityReport {
  errors: string[];
  warnings: string[];
}

export async function checkDatabaseSecurity(probe: DbProbe, env: NodeJS.ProcessEnv, canSign: boolean): Promise<DbSecurityReport> {
  const prod = env.NODE_ENV === 'production';
  const errors: string[] = [];
  const warnings: string[] = [];
  const bad = (msg: string) => (prod ? errors : warnings).push(prod ? msg : `${msg} (em produção a API não sobe)`);

  let status: Awaited<ReturnType<DbProbe['status']>> = null;
  try {
    status = await probe.status();
  } catch {
    status = null;
  }
  if (!status) {
    bad('o banco não tem o contexto de RLS assinado (migração 20261017100000 não aplicada?)');
  } else {
    if (!status.enforced) bad('o banco NÃO exige contexto de RLS assinado: o SQL arbitrário da conexão ainda escolhe o papel/empresa (rode `db:provision-context` ou o `db-grants` do compose com RLS_CONTEXT_SECRET)');
    if (status.enforced && status.secretSlots === 0) bad('o banco exige contexto assinado mas não tem segredo provisionado (após restaurar um backup é preciso provisionar de novo): toda consulta será negada');
    if (status.enforced && status.secretSlots > 0) {
      if (!canSign) bad('o banco exige contexto assinado e esta API não tem RLS_CONTEXT_SECRET: toda consulta será negada');
      else {
        let accepted = false;
        try {
          accepted = await probe.signedContextAccepted();
        } catch {
          accepted = false;
        }
        if (!accepted) bad('o banco REJEITOU o contexto assinado desta API (RLS_CONTEXT_SECRET diferente do provisionado, ou relógio do banco e da API diferem mais de ±120 s)');
      }
    }
  }

  try {
    const role = await probe.role();
    if ((role.superuser || role.bypassRls) && env.ALLOW_PRIVILEGED_DB_ROLE !== 'true') {
      bad(`a API conecta ao banco como ${role.superuser ? 'SUPERUSUÁRIO' : 'papel com BYPASSRLS'}: a RLS inteira é IGNORADA (use o papel de execução; deploy/postgres-init/10-roles.sh)`);
    } else if (role.superuser || role.bypassRls) {
      warnings.push('a API conecta como papel privilegiado (ALLOW_PRIVILEGED_DB_ROLE=true): a RLS é ignorada');
    }
    if (role.ownedTables > 0) {
      const msg = `a API é DONA de ${role.ownedTables} tabelas (pode desligar a RLS com ALTER TABLE): use o papel de execução sem posse (deploy/db-runtime-role.sql)`;
      if (prod && env.REQUIRE_NON_OWNER_DB_ROLE === 'true') errors.push(msg);
      else warnings.push(msg);
    }
  } catch {
    warnings.push('não foi possível conferir o papel da conexão com o banco');
  }
  return { errors, warnings };
}

/** Na partida: registra os avisos e, em produção, lança com todos os erros (a API não sobe). */
export async function assertDatabaseSecurity(
  probe: DbProbe,
  env: NodeJS.ProcessEnv,
  canSign: boolean,
  log: { warn: (m: string) => void; error: (m: string) => void }
): Promise<DbSecurityReport> {
  const report = await checkDatabaseSecurity(probe, env, canSign);
  for (const w of report.warnings) log.warn(`Banco: ${w}`);
  if (report.errors.length > 0) {
    for (const e of report.errors) log.error(`Banco: ${e}`);
    throw new Error(`Segurança do banco inválida para produção (${report.errors.length}): ${report.errors.join('; ')}`);
  }
  return report;
}
