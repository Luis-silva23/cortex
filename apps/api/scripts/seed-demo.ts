/**
 * Tenant de DEMONSTRAÇÃO/E2E (banco de desenvolvimento) — idempotente e PROTEGIDO.
 *
 *   npm run demo:seed
 *
 * Cria 3 empresas cujo nome começa com "CÓRTEX Demo" (o guard dos testes só apaga "Integration Test Co…",
 * então estes dados NUNCA são removidos por teste):
 *   Alfa    → filiais A1 (matriz) e A2       Beta    → filiais B1 (matriz) e B2
 *   Sandbox → uma filial (S1) — só para ligar/desligar MÓDULOS sem afetar os testes de perfil das outras.
 * Cada empresa recebe usuários DEDICADOS por papel e por filial (admin, gerentes, balcões, caixa, mecânico,
 * visualizador) e há um SUPER_ADMIN de E2E com MFA. Nenhuma conta compartilhada.
 *
 * A senha é aleatória, gerada na 1ª execução e gravada em apps/api/.demo/credentials.json (ignorada pelo git —
 * NENHUMA credencial vai para commit). Reexecutar não duplica nada e mantém a senha (`--rotate` gera outra).
 * Recusa rodar em produção ou em banco de teste.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import { hashPassword } from '@ln-system/shared/utils/password';
import { sealSecret } from '@ln-system/shared/utils/secret-box';

import { contextStatement, PLATFORM_CONTEXT } from '@ln-system/database';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const CREDENTIALS_FILE = path.resolve(__dirname, '../.demo/credentials.json');
const DEMO_PREFIX = 'CÓRTEX Demo';
const SA_MFA_SECRET = 'JBSWY3DPEHPK3PXP'; // segredo TOTP FIXO só de demonstração/E2E (dev)

type Role = 'COMPANY_ADMIN' | 'MANAGER' | 'OPERATOR' | 'MECHANIC' | 'VIEWER';
interface DemoUser { key: string; email: string; name: string; userType: Role | 'SUPER_ADMIN'; company: string | null; branch: string | null }

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('seed-demo recusado em produção');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL ausente');
  if (/test/i.test(new URL(url).pathname)) throw new Error('seed-demo é do banco de DESENVOLVIMENTO; o banco de teste é só dos testes automatizados');

  // imports tardios: packages/database lê DATABASE_URL no import
  const { prismaUnsafeBypassRLS: db } = await import('@ln-system/database');
  const { createWorld } = await import('../test/integration/helpers/tenant-world');
  const { createFixture } = await import('../test/integration/helpers/fixture');

  const bypass = async <T>(q: () => any): Promise<T> => {
    const r = await db.$transaction([
      contextStatement(db, PLATFORM_CONTEXT),
      q(),
    ]);
    return r[1] as T;
  };

  // ---- senha (estável entre execuções, nunca commitada)
  const rotate = process.argv.includes('--rotate');
  let password = '';
  if (fs.existsSync(CREDENTIALS_FILE) && !rotate) password = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8')).password;
  if (!password) password = `Cx${crypto.randomBytes(9).toString('base64url')}#9`;
  const hashed = await hashPassword(password);

  // ---- empresas
  const existing = await bypass<Array<{ id: string; name: string }>>(() => db.company.findMany({ where: { name: { startsWith: DEMO_PREFIX } }, select: { id: true, name: true } }));
  const byName = new Map(existing.map((c) => [c.name, c.id]));
  const NAMES = { alfa: `${DEMO_PREFIX} — Motos Alfa`, beta: `${DEMO_PREFIX} — Motos Beta`, sandbox: `${DEMO_PREFIX} — Sandbox de Módulos` };

  const ids: Record<'alfa' | 'beta' | 'sandbox', { companyId: string; branches: string[] }> = {} as any;
  if (byName.size === 0) {
    const world = await createWorld(); // 2 empresas × 2 filiais com dados de todos os módulos
    const sandbox = await createFixture('sandbox');
    const rename = async (companyId: string, name: string, branchNames: string[]) => {
      await bypass(() => db.company.update({ where: { id: companyId }, data: { name, email: `contato@${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.demo.local` } }));
      const branches = await bypass<Array<{ id: string }>>(() => db.branch.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' }, select: { id: true } }));
      for (let i = 0; i < branches.length; i++) {
        await bypass(() => db.branch.update({ where: { id: branches[i].id }, data: { name: branchNames[i] ?? `Filial ${i + 1}` } }));
      }
      return { companyId, branches: branches.map((b) => b.id) };
    };
    ids.alfa = await rename(world.A.companyId, NAMES.alfa, ['Alfa — Matriz (A1)', 'Alfa — Filial 2 (A2)']);
    ids.beta = await rename(world.B.companyId, NAMES.beta, ['Beta — Matriz (B1)', 'Beta — Filial 2 (B2)']);
    ids.sandbox = await rename(sandbox.companyId, NAMES.sandbox, ['Sandbox — Matriz (S1)']);
  } else {
    for (const [k, name] of Object.entries(NAMES) as Array<['alfa' | 'beta' | 'sandbox', string]>) {
      const companyId = byName.get(name);
      if (!companyId) throw new Error(`empresa demo "${name}" não encontrada (execução parcial anterior?)`);
      const branches = await bypass<Array<{ id: string }>>(() => db.branch.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' }, select: { id: true } }));
      ids[k] = { companyId, branches: branches.map((b) => b.id) };
    }
  }

  // ---- usuários dedicados por papel/filial
  const users: DemoUser[] = [];
  const add = (u: DemoUser) => users.push(u);
  for (const co of ['alfa', 'beta', 'sandbox'] as const) {
    const n = ids[co].branches.length;
    add({ key: `admin.${co}`, email: `admin.${co}@demo.local`, name: `Admin ${co}`, userType: 'COMPANY_ADMIN', company: co, branch: null });
    for (let b = 1; b <= n; b++) {
      add({ key: `gerente.${co}.${b}`, email: `gerente.${co}.${b}@demo.local`, name: `Gerente ${co} ${b}`, userType: 'MANAGER', company: co, branch: String(b) });
      add({ key: `balcao.${co}.${b}`, email: `balcao.${co}.${b}@demo.local`, name: `Balcão ${co} ${b}`, userType: 'OPERATOR', company: co, branch: String(b) });
    }
    add({ key: `caixa.${co}.1`, email: `caixa.${co}.1@demo.local`, name: `Caixa ${co} 1`, userType: 'OPERATOR', company: co, branch: '1' });
    add({ key: `mecanico.${co}.1`, email: `mecanico.${co}.1@demo.local`, name: `Mecânico ${co} 1`, userType: 'MECHANIC', company: co, branch: '1' });
    add({ key: `viewer.${co}.1`, email: `viewer.${co}.1@demo.local`, name: `Visualizador ${co} 1`, userType: 'VIEWER', company: co, branch: '1' });
  }
  add({ key: 'sa.e2e', email: 'sa.e2e@demo.local', name: 'Super Admin E2E', userType: 'SUPER_ADMIN', company: null, branch: null });

  const out: Record<string, { email: string; numericId: number; userType: string; company: string | null; branch: string | null }> = {};
  for (const u of users) {
    const companyId = u.company ? ids[u.company as 'alfa'].companyId : null;
    const branchId = u.company && u.branch ? ids[u.company as 'alfa'].branches[Number(u.branch) - 1] : null;
    const isSA = u.userType === 'SUPER_ADMIN';
    const data = { companyId, branchId, name: u.name, password: hashed, userType: u.userType as any, isActive: true, loginAttempts: 0, lockedUntil: null, ...(isSA ? { mfaEnabled: true, mfaSecret: sealSecret(SA_MFA_SECRET), mfaBackupCodes: [] } : {}) };
    const row = await bypass<{ numericId: number }>(() => db.user.upsert({ where: { email: u.email }, create: { email: u.email, ...data } as any, update: data as any, select: { numericId: true } }));
    out[u.key] = { email: u.email, numericId: row.numericId, userType: u.userType, company: u.company, branch: u.branch };
  }

  // ---- regra de desconto (10% para OPERATOR, exige gerente) e política de parcelamento, por empresa demo
  for (const co of ['alfa', 'beta', 'sandbox'] as const) {
    const companyId = ids[co].companyId;
    const has = await bypass<number>(() => db.discountRule.count({ where: { companyId, name: 'Demo — limite operador 10%' } }));
    if (!has) await bypass(() => db.discountRule.create({ data: { companyId, name: 'Demo — limite operador 10%', userType: 'OPERATOR', discountType: 'PERCENTAGE', maxDiscount: 10, requiresApproval: true } as any }));
    const p = await bypass<number>(() => db.installmentPolicy.count({ where: { companyId, paymentMethod: 'CREDIT_CARD' as any } }));
    if (!p) await bypass(() => db.installmentPolicy.create({ data: { companyId, paymentMethod: 'CREDIT_CARD' as any, maxInstallments: 6, interestFreeInstallments: 3 } as any }));
  }

  // ---- uma garantia de demonstração na empresa Alfa (OS da matriz), para as telas de garantia terem o que mostrar
  {
    const companyId = ids.alfa.companyId;
    const branchId = ids.alfa.branches[0];
    // A garantia só existe em OS ENCERRADA (é o encerramento que a gera). Corrige a de uma execução anterior que caiu em OS aberta.
    const existing = await bypass<{ id: string; serviceOrder: { status: string } }[]>(() =>
      db.serviceOrderWarranty.findMany({ where: { companyId, branchId }, select: { id: true, serviceOrder: { select: { status: true } } } })
    );
    const stale = existing.filter((w) => w.serviceOrder.status !== 'ENCERRADA').map((w) => w.id);
    if (stale.length) await bypass(() => db.serviceOrderWarranty.deleteMany({ where: { companyId, branchId, id: { in: stale } } }));
    const hasWarranty = existing.length - stale.length;
    const os = hasWarranty
      ? null
      : await bypass<{ id: string; customerId: string; motorcycleId: string; entryDate: Date } | null>(() =>
          db.serviceOrder.findFirst({ where: { companyId, branchId, status: 'ENCERRADA' }, orderBy: { osNumber: 'asc' }, select: { id: true, customerId: true, motorcycleId: true, entryDate: true } })
        );
    const admin = await bypass<{ id: string } | null>(() => db.user.findUnique({ where: { email: 'admin.alfa@demo.local' }, select: { id: true } }));
    if (os && admin) {
      const start = new Date();
      await bypass(() =>
        db.serviceOrderWarranty.create({
          data: {
            companyId, branchId, serviceOrderId: os.id, customerId: os.customerId, motorcycleId: os.motorcycleId,
            coverage: 'SERVICE', durationValue: 90, durationUnit: 'DAYS', startDate: start,
            validUntil: new Date(start.getTime() + 90 * 86_400_000), conditions: 'Garantia de demonstração', createdBy: admin.id,
          },
        })
      );
      await bypass(() => db.serviceOrder.updateMany({ where: { id: os.id, companyId }, data: { warrantyDecision: 'GRANTED' } }));
    }
  }

  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  fs.writeFileSync(
    CREDENTIALS_FILE,
    JSON.stringify({ password, saMfaSecret: SA_MFA_SECRET, companies: { alfa: ids.alfa, beta: ids.beta, sandbox: ids.sandbox }, users: out }, null, 2)
  );
  console.log(`[seed-demo] ${Object.keys(out).length} usuários, 3 empresas "${DEMO_PREFIX} …". Credenciais em ${CREDENTIALS_FILE} (ignorado pelo git).`);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
