/**
 * BOOTSTRAP SEGURO DO SUPER ADMIN DE TI e enrolamento de MFA (procedimento administrativo, no servidor).
 *
 *   # 1) ver o que seria feito (padrão, não grava nada):
 *   npm run admin:bootstrap -- bootstrap --email <e-mail> --name "<Nome Completo>" [--numeric-id 1]
 *   # 2) criar de verdade (a senha vem de BOOTSTRAP_SA_PASSWORD ou de um prompt oculto — NUNCA de argumento):
 *   npm run admin:bootstrap -- bootstrap --email <e-mail> --name "<Nome Completo>" --numeric-id 1 --apply
 *   # 3) ligar o MFA (obrigatório para Super Admin em produção); mostra o segredo e os códigos de backup UMA vez:
 *   npm run admin:bootstrap -- enroll-mfa --numeric-id 1 --apply
 *
 * Regras (ver src/services/super-admin-bootstrap.service.ts): idempotente; nunca promove outra conta; nunca escolhe outro
 * identificador por conta própria; nunca imprime a senha; em produção só roda com ALLOW_SUPER_ADMIN_BOOTSTRAP=true.
 */
import * as path from 'path';
import * as readline from 'readline';
import * as dotenv from 'dotenv';

// O .env do servidor (DATABASE_URL, DATA_ENCRYPTION_KEY) precisa estar carregado ANTES do serviço importar o Prisma.
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Import dinâmico: o serviço carrega o Prisma, que lê DATABASE_URL — só depois do dotenv acima.
const service = () => import('../src/services/super-admin-bootstrap.service');
const MAX_LOGIN_ID = 999_999;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** Pergunta no terminal; `hidden` não ecoa o que é digitado (senha, código). */
function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      (rl as any)._writeToOutput = (s: string) => {
        if (s.includes(question)) (rl as any).output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readPassword(email: string, name: string): Promise<string> {
  const fromEnv = process.env.BOOTSTRAP_SA_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) throw new Error('Sem terminal interativo: defina BOOTSTRAP_SA_PASSWORD (variável de ambiente, nunca argumento).');
  for (let tries = 0; tries < 3; tries++) {
    const p1 = await ask('Defina a senha do Super Admin (mín. 12 caracteres): ', true);
    const problem = (await service()).passwordProblem(p1, email, name);
    if (problem) {
      console.log(`  ✗ ${problem}`);
      continue;
    }
    const p2 = await ask('Repita a senha: ', true);
    if (p1 !== p2) {
      console.log('  ✗ As senhas não conferem.');
      continue;
    }
    return p1;
  }
  throw new Error('Senha não definida.');
}

async function bootstrap() {
  const email = arg('email') ?? process.env.BOOTSTRAP_SA_EMAIL ?? '';
  const name = arg('name') ?? process.env.BOOTSTRAP_SA_NAME ?? '';
  const rawId = arg('numeric-id');
  const numericId = rawId === undefined ? null : Number(rawId);
  const apply = flag('apply');

  const svc = await service();
  const plan = await svc.planSuperAdminBootstrap({ email, name, numericId });
  console.log(`[bootstrap] ambiente: ${process.env.NODE_ENV ?? 'development'} · modo: ${apply ? 'APLICAR' : 'SIMULAÇÃO (nada é gravado)'}`);
  if (plan.action === 'refuse') {
    console.error(`[bootstrap] RECUSADO (${plan.code}): ${plan.message}`);
    process.exitCode = 2;
    return;
  }
  if (plan.action === 'noop') {
    console.log(`[bootstrap] Nada a fazer: já existe um Super Admin com este e-mail (identificador ${plan.numericId}, MFA ${plan.mfaEnabled ? 'ligado' : 'DESLIGADO'}, ${plan.isActive ? 'ativo' : 'inativo'}).`);
    if (!plan.mfaEnabled) console.log('[bootstrap] Ligue o MFA: npm run admin:bootstrap -- enroll-mfa --numeric-id ' + plan.numericId + ' --apply');
    return;
  }
  console.log(`[bootstrap] Seria criado: Super Admin "${plan.name}" <${plan.email}>, identificador de login ${plan.numericId === 'auto' ? 'automático (sequência)' : plan.numericId} (limite ${MAX_LOGIN_ID}).`);
  if (!apply) {
    console.log('[bootstrap] Para criar, repita o comando com --apply (a senha será pedida de forma oculta).');
    return;
  }
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SUPER_ADMIN_BOOTSTRAP !== 'true') {
    console.error('[bootstrap] Em produção exige ALLOW_SUPER_ADMIN_BOOTSTRAP=true (defina só durante o procedimento e remova depois).');
    process.exitCode = 3;
    return;
  }
  const password = await readPassword(plan.email, plan.name);
  const user = await svc.applySuperAdminBootstrap({ email: plan.email, name: plan.name, numericId, password });
  console.log(`[bootstrap] ✓ Conta criada: identificador de login ${user.numericId}. MFA ainda DESLIGADO — rode enroll-mfa agora.`);
}

async function enrollMfa() {
  const numericId = Number(arg('numeric-id'));
  if (!Number.isInteger(numericId)) throw new Error('Informe --numeric-id.');
  if (!flag('apply')) {
    console.log('[enroll-mfa] SIMULAÇÃO: com --apply gera o segredo, mostra-o UMA vez e pede um código para ativar. Nada foi gravado.');
    return;
  }
  if (!process.stdin.isTTY) throw new Error('enroll-mfa precisa de terminal interativo (o segredo e os códigos de backup são mostrados uma vez).');
  const svc = await service();
  const begun = await svc.beginMfaEnrollment(numericId);
  console.log('\n=== MFA — guarde agora (não será mostrado de novo) ===');
  console.log(`Segredo TOTP : ${begun.secret}`);
  console.log(`otpauth      : ${begun.otpauthUrl}`);
  console.log('Códigos de backup (uso único):');
  begun.backupCodes.forEach((c) => console.log(`  ${c}`));
  const code = (await ask('\nDigite o código atual do aplicativo autenticador para ATIVAR o MFA: ', true)).trim();
  await svc.confirmMfaEnrollment(numericId, code, begun.secret);
  console.log('[enroll-mfa] ✓ MFA ativado e auditado.');
}

async function resetMfa() {
  const numericId = Number(arg('numeric-id'));
  if (!Number.isInteger(numericId)) throw new Error('Informe --numeric-id.');
  if (!flag('apply')) {
    console.log('[reset-mfa] SIMULAÇÃO: com --apply apaga o segredo e os códigos de recuperação do Super Admin, encerra as sessões e audita. Nada foi gravado.');
    return;
  }
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SUPER_ADMIN_BOOTSTRAP !== 'true') {
    console.error('[reset-mfa] Em produção exige ALLOW_SUPER_ADMIN_BOOTSTRAP=true (defina só durante o procedimento e remova depois).');
    process.exitCode = 3;
    return;
  }
  const svc = await service();
  await svc.resetMfa(numericId);
  console.log(`[reset-mfa] ✓ Fator reiniciado e auditado. Configure de novo agora: npm run admin:bootstrap -- enroll-mfa --numeric-id ${numericId} --apply`);
}

(async () => {
  const command = process.argv[2];
  if (command === 'bootstrap') await bootstrap();
  else if (command === 'enroll-mfa') await enrollMfa();
  else if (command === 'reset-mfa') await resetMfa();
  else {
    console.log('Uso: bootstrap --email <e-mail> --name "<Nome>" [--numeric-id N] [--apply] | enroll-mfa --numeric-id N [--apply] | reset-mfa --numeric-id N [--apply]');
    process.exitCode = 1;
  }
})()
  .catch((error) => {
    console.error(`[erro] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
