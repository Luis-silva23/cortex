// Rodar: npx tsx --test scripts/device-enrollment.test.ts (também no npm run test:logic)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkServerUrl } from '../src/services/server-url';
import { gateStateFromError, gateStateFromStatus, GATE_MESSAGES } from '../src/services/device-state';

test('produção: só HTTPS é aceito; HTTP, endereço ausente, inválido ou com usuário/senha são recusados', () => {
  assert.equal(checkServerUrl('https://api.exemplo.com.br', true), null);
  assert.match(checkServerUrl('http://api.exemplo.com.br', true) ?? '', /sem HTTPS/);
  assert.match(checkServerUrl('http://192.168.0.10:3001', true) ?? '', /sem HTTPS/);
  assert.match(checkServerUrl(undefined, true) ?? '', /não foi configurado/);
  assert.match(checkServerUrl('   ', true) ?? '', /não foi configurado/);
  assert.match(checkServerUrl('isto não é url', true) ?? '', /inválido/);
  assert.match(checkServerUrl('https://usuario:senha@api.exemplo.com.br', true) ?? '', /usuário ou senha/);
  assert.match(checkServerUrl('ftp://api.exemplo.com.br', false) ?? '', /inválido/);
});

test('desenvolvimento: HTTP local é aceito, mas credencial na URL nunca', () => {
  assert.equal(checkServerUrl('http://localhost:3001', false), null);
  assert.equal(checkServerUrl(undefined, false), null);
  assert.match(checkServerUrl('http://u:p@localhost:3001', false) ?? '', /usuário ou senha/);
});

test('estado do equipamento: cada resposta do servidor vira uma tela', () => {
  assert.deepEqual(gateStateFromStatus({ deviceId: 'd', status: 'PENDING', enrollmentCode: 'ABCD-2345' }), { kind: 'pending', code: 'ABCD-2345' });
  assert.deepEqual(gateStateFromStatus({ deviceId: 'd', status: 'ACTIVE', company: { name: 'Loja X' }, branch: { name: 'Matriz' } }), { kind: 'authorized', company: 'Loja X', branch: 'Matriz' });
  assert.deepEqual(gateStateFromStatus({ deviceId: 'd', status: 'BLOCKED' }), { kind: 'blocked' });
  assert.deepEqual(gateStateFromStatus({ deviceId: 'd', status: 'REVOKED' }), { kind: 'revoked' });
  // estado desconhecido NUNCA libera o aplicativo
  assert.notEqual(gateStateFromStatus({ deviceId: 'd', status: 'QUALQUER' }).kind, 'authorized');
});

test('falha na consulta: 401 pede novo registro; sem resposta é "sem conexão"; nada libera o aplicativo', () => {
  assert.deepEqual(gateStateFromError(401), { kind: 'reenroll' });
  assert.deepEqual(gateStateFromError(undefined), { kind: 'offline' });
  assert.deepEqual(gateStateFromError(500), { kind: 'offline' });
  assert.deepEqual(gateStateFromError(429), { kind: 'offline' });
});

test('a mensagem de espera é a combinada com o produto', () => {
  assert.equal(GATE_MESSAGES.pending.title, 'Dispositivo aguardando autorização');
});
