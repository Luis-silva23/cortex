import * as fs from 'fs';
import * as path from 'path';
import { prisma, prismaUnsafeBypassRLS, runWithRLSContext } from '@ln-system/database';
import { createFixture, destroyFixture, IntegrationFixture } from './helpers/fixture';
import { bypass } from './helpers/tenant-world';
import {
  assertDestroyable,
  checkDestructiveArgs,
  findUndefinedPath,
  SYNTHETIC_COMPANY_PREFIX,
  UnsafeDestructiveOperationError,
} from './helpers/destructive-guard';
import { assertIsTestDatabase, databaseNameOf, deriveTestDatabaseUrl } from './helpers/test-database';

/**
 * PROVA de que operação destrutiva com identificador ausente FALHA DE PROPÓSITO (banco real).
 *
 * Incidente que originou isto: `stockMovement.deleteMany({ where: { productId: undefined } })` — o Prisma ignora
 * `undefined` no where — apagou TODAS as movimentações de estoque do banco de desenvolvimento.
 */
describe('Proteção contra cleanup destrutivo (integração real)', () => {
  let fixture: IntegrationFixture;
  const SA = { companyId: null, userType: 'SUPER_ADMIN', branchId: null } as const;

  const movementCount = () =>
    bypass<number>(() => prismaUnsafeBypassRLS.stockMovement.count({ where: { companyId: fixture.companyId } }));

  beforeAll(async () => {
    fixture = await createFixture('guard');
    await bypass(() =>
      prismaUnsafeBypassRLS.stockMovement.create({
        data: { companyId: fixture.companyId, branchId: fixture.branchId, productId: fixture.productId, movementType: 'PURCHASE', quantity: 3, userId: fixture.userId, unitCost: 1 },
      })
    );
  }, 30000);

  afterAll(async () => {
    if (fixture) await destroyFixture(fixture);
  }, 30000);

  describe('funções puras', () => {
    it('findUndefinedPath acha undefined em qualquer profundidade e ignora null/valores', () => {
      expect(findUndefinedPath({ productId: undefined })).toBe('productId');
      expect(findUndefinedPath({ sale: { companyId: undefined } })).toBe('sale.companyId');
      expect(findUndefinedPath({ id: { in: ['a', undefined] } })).toBe('id.in.1');
      expect(findUndefinedPath({ companyId: 'x', deletedAt: null, when: new Date() })).toBeNull();
    });

    it('checkDestructiveArgs recusa where vazio/undefined em deleteMany e updateMany, e passa o resto', () => {
      expect(() => checkDestructiveArgs('StockMovement', 'deleteMany', { where: {} })).toThrow(UnsafeDestructiveOperationError);
      expect(() => checkDestructiveArgs('StockMovement', 'deleteMany', {})).toThrow(/vazio/);
      expect(() => checkDestructiveArgs('StockMovement', 'updateMany', { where: { productId: undefined }, data: {} })).toThrow(/undefined/);
      expect(() => checkDestructiveArgs('Company', 'delete', { where: { id: undefined } })).toThrow(/undefined/);
      // leituras e escritas com filtro válido passam
      expect(() => checkDestructiveArgs('StockMovement', 'findMany', { where: { productId: undefined } })).not.toThrow();
      expect(() => checkDestructiveArgs('StockMovement', 'deleteMany', { where: { companyId: 'c', productId: 'p' } })).not.toThrow();
    });

    it('a suíte roda num banco de TESTE, e um banco de dev/demonstração é recusado', () => {
      expect(databaseNameOf(process.env.DATABASE_URL!)).toMatch(/test/i);
      expect(() => assertIsTestDatabase('postgresql://u:p@localhost:5432/lnsystem_db')).toThrow(/não parece ser de teste/);
      expect(() => assertIsTestDatabase('postgresql://u:p@localhost:5432/lnsystem_test', 'postgresql://u:p@localhost:5432/lnsystem_test')).toThrow(/mesmo do DATABASE_URL/);
      expect(deriveTestDatabaseUrl('postgresql://u:p@localhost:5432/lnsystem_db?schema=public')).toBe('postgresql://u:p@localhost:5432/lnsystem_test?schema=public');
    });
  });

  describe('contra o Postgres real', () => {
    it('deleteMany com productId undefined LANÇA e NÃO apaga nada (o incidente original)', async () => {
      const before = await movementCount();
      expect(before).toBeGreaterThan(0);

      await expect(
        bypass(() => prismaUnsafeBypassRLS.stockMovement.deleteMany({ where: { productId: undefined as unknown as string } }))
      ).rejects.toThrow(/UnsafeDestructiveOperation/);

      expect(await movementCount()).toBe(before);
    });

    it('deleteMany com where vazio e updateMany com companyId undefined também lançam', async () => {
      const before = await movementCount();
      await expect(bypass(() => prismaUnsafeBypassRLS.stockMovement.deleteMany({ where: {} }))).rejects.toThrow(/vazio/);
      await expect(
        bypass(() => prismaUnsafeBypassRLS.stockMovement.updateMany({ where: { companyId: undefined as unknown as string }, data: { quantity: 999 } }))
      ).rejects.toThrow(/undefined/);
      expect(await movementCount()).toBe(before);
    });

    it('o mesmo vale pelo cliente ESTENDIDO (o que o código da aplicação e o destroyFixture usam)', async () => {
      const before = await movementCount();
      await expect(
        runWithRLSContext(SA, () => prisma.stockMovement.deleteMany({ where: { productId: undefined as unknown as string } }))
      ).rejects.toThrow(/UnsafeDestructiveOperation/);
      expect(await movementCount()).toBe(before);
    });

    it('destroyFixture com id ausente/inválido FALHA e não apaga nada', async () => {
      const before = await movementCount();
      await expect(destroyFixture({ ...fixture, companyId: undefined as unknown as string })).rejects.toThrow(/companyId ausente/);
      await expect(destroyFixture({} as IntegrationFixture)).rejects.toThrow(/companyId ausente/);
      await expect(destroyFixture(undefined as unknown as IntegrationFixture)).rejects.toThrow(/companyId ausente/);
      await expect(assertDestroyable('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/não existe/);
      expect(await movementCount()).toBe(before);
    });

    it('empresa NÃO sintética (demonstração/real) é PROTEGIDA: assertDestroyable e destroyFixture recusam', async () => {
      const demo = await bypass<{ id: string }>(() =>
        prismaUnsafeBypassRLS.company.create({
          data: { name: 'Empresa de Demonstração PROTEGIDA (teste do guard)', document: String(Math.floor(Math.random() * 1e14)).padStart(14, '0'), email: `guard-${Date.now()}@test.local`, isActive: true },
          select: { id: true },
        })
      );
      try {
        await expect(assertDestroyable(demo.id)).rejects.toThrow(/não é uma empresa sintética/);
        await expect(destroyFixture({ ...fixture, companyId: demo.id })).rejects.toThrow(/não é uma empresa sintética/);
        const still = await bypass<number>(() => prismaUnsafeBypassRLS.company.count({ where: { id: demo.id } }));
        expect(still).toBe(1);
      } finally {
        // remove só o artefato deste teste, por id (definido: acabou de ser criado)
        await bypass(() => prismaUnsafeBypassRLS.company.delete({ where: { id: demo.id } }));
      }
      // e a empresa sintética do próprio teste continua apagável
      await expect(assertDestroyable(fixture.companyId)).resolves.toBeUndefined();
      expect(SYNTHETIC_COMPANY_PREFIX).toBe('Integration Test Co');
    });
  });

  describe('varredura estática dos testes', () => {
    const root = path.resolve(__dirname, '..');
    const self = path.basename(__filename);

    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
        return e.name.endsWith('.ts') ? [p] : [];
      });

    it('todo deleteMany/updateMany em teste é escopado por companyId ou por id explícito', () => {
      const offenders: string[] = [];
      for (const file of walk(root)) {
        const base = path.basename(file);
        if (base === self || base === 'destructive-guard.ts') continue;
        fs.readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comentário
            if (!/\b(deleteMany|updateMany)\s*\(/.test(line)) return;
            if (!/companyId|\bid\s*:|\{\s*id\b/.test(line)) offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim().slice(0, 140)}`);
          });
      }
      expect(offenders).toEqual([]);
    });
  });
});
