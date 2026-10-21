// Rodar: npx tsx --test scripts/session-revocation.test.ts (também no npm run test:logic)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLogoutStatus,
  flushPending,
  revokeOrQueue,
  MAX_PENDING,
  type RevocationDeps,
  type RevokeResult,
} from '../src/services/session-revocation';

function makeDeps(responses: Array<RevokeResult | 'throw'>) {
  let stored: string | null = null;
  const calls: Array<{ refreshToken: string; accessToken?: string | null }> = [];
  const deps: RevocationDeps = {
    storage: {
      read: async () => stored,
      write: async (v) => {
        stored = v;
      },
    },
    revoke: async (refreshToken, accessToken) => {
      calls.push({ refreshToken, accessToken });
      const next = responses.shift() ?? 'unreachable';
      if (next === 'throw') throw new Error('network');
      return next;
    },
  };
  return { deps, calls, stored: () => stored };
}

test('status do /auth/logout: 2xx revogou; 4xx já era inválido; sem resposta, 408, 429 e 5xx ficam pendentes', () => {
  assert.equal(classifyLogoutStatus(200), 'revoked');
  assert.equal(classifyLogoutStatus(204), 'revoked');
  assert.equal(classifyLogoutStatus(400), 'rejected');
  assert.equal(classifyLogoutStatus(401), 'rejected');
  assert.equal(classifyLogoutStatus(404), 'rejected');
  assert.equal(classifyLogoutStatus(408), 'unreachable');
  assert.equal(classifyLogoutStatus(429), 'unreachable');
  assert.equal(classifyLogoutStatus(500), 'unreachable');
  assert.equal(classifyLogoutStatus(503), 'unreachable');
  assert.equal(classifyLogoutStatus(undefined), 'unreachable');
});

test('servidor confirmou: nada é guardado e o access token vai junto para ser revogado também', async () => {
  const { deps, calls, stored } = makeDeps(['revoked']);
  assert.equal(await revokeOrQueue(deps, 'refresh-1', 'access-1'), 'revoked');
  assert.deepEqual(calls, [{ refreshToken: 'refresh-1', accessToken: 'access-1' }]);
  assert.equal(stored(), null);
});

test('servidor recusou (token já inválido): nada é guardado', async () => {
  const { deps, stored } = makeDeps(['rejected']);
  assert.equal(await revokeOrQueue(deps, 'refresh-1', 'access-1'), 'rejected');
  assert.equal(stored(), null);
});

test('sem rede (resposta ou exceção): o refresh token entra na fila, sem duplicar', async () => {
  const { deps, stored } = makeDeps(['unreachable', 'throw']);
  assert.equal(await revokeOrQueue(deps, 'refresh-1', 'access-1'), 'unreachable');
  assert.equal(await revokeOrQueue(deps, 'refresh-1', 'access-1'), 'unreachable');
  assert.deepEqual(JSON.parse(stored()!), ['refresh-1']);
});

test('sem refresh token (sessão já encerrada): não faz nada', async () => {
  const { deps, calls, stored } = makeDeps([]);
  assert.equal(await revokeOrQueue(deps, null, null), 'nothing');
  assert.equal(calls.length, 0);
  assert.equal(stored(), null);
});

test('rede voltou: a fila é reenviada SEM access token; confirmados e recusados saem, o que falhou fica', async () => {
  const { deps, calls, stored } = makeDeps(['unreachable', 'unreachable', 'unreachable']);
  await revokeOrQueue(deps, 'r-a', 'x');
  await revokeOrQueue(deps, 'r-b', 'x');
  await revokeOrQueue(deps, 'r-c', 'x');
  assert.deepEqual(JSON.parse(stored()!), ['r-a', 'r-b', 'r-c']);

  calls.length = 0;
  const responses: RevokeResult[] = ['revoked', 'unreachable', 'rejected'];
  deps.revoke = async (refreshToken, accessToken) => {
    calls.push({ refreshToken, accessToken });
    return responses.shift()!;
  };
  const out = await flushPending(deps);
  assert.deepEqual(out, { remaining: 1, cleared: 2 });
  assert.deepEqual(JSON.parse(stored()!), ['r-b']);
  assert.ok(calls.every((c) => c.accessToken === null));

  deps.revoke = async () => 'revoked';
  assert.deepEqual(await flushPending(deps), { remaining: 0, cleared: 1 });
  assert.equal(stored(), null);
});

test('fila corrompida ou vazia não quebra; o limite descarta os mais antigos', async () => {
  const empty = makeDeps([]);
  assert.deepEqual(await flushPending(empty.deps), { remaining: 0, cleared: 0 });

  const broken = makeDeps(['unreachable']);
  await broken.deps.storage.write('{isto não é json');
  await revokeOrQueue(broken.deps, 'r-novo', 'x');
  assert.deepEqual(JSON.parse(broken.stored()!), ['r-novo']);

  const many = makeDeps(Array.from({ length: MAX_PENDING + 3 }, () => 'unreachable' as const));
  for (let i = 0; i < MAX_PENDING + 3; i++) await revokeOrQueue(many.deps, `r-${i}`, null);
  const queue = JSON.parse(many.stored()!) as string[];
  assert.equal(queue.length, MAX_PENDING);
  assert.equal(queue[queue.length - 1], `r-${MAX_PENDING + 2}`);
  assert.ok(!queue.includes('r-0'));
});

test('armazenamento que falha não derruba o logout', async () => {
  const deps: RevocationDeps = {
    storage: {
      read: async () => {
        throw new Error('safeStorage indisponível');
      },
      write: async () => {
        throw new Error('safeStorage indisponível');
      },
    },
    revoke: async () => 'unreachable',
  };
  assert.equal(await revokeOrQueue(deps, 'r', null), 'unreachable');
  assert.deepEqual(await flushPending(deps), { remaining: 0, cleared: 0 });
});
