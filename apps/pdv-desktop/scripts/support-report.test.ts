// Rodar: npx tsx --test scripts/support-report.test.ts (também no npm run test:logic)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTicketContext, buildTicketPayload, shouldRenewIdempotencyKey, validateReport } from '../src/services/support-report';

test('corpo do chamado: contexto aninhado, módulo PDV, sem empresa/filial/usuário', () => {
  const payload = buildTicketPayload({
    subject: '  Erro no PIX ',
    description: ' A maquininha não respondeu. ',
    type: 'PROBLEMA',
    context: { screen: 'Pagamento', terminal: 'Caixa #2' },
  });
  assert.deepEqual(payload, {
    subject: 'Erro no PIX',
    description: 'A maquininha não respondeu.',
    module: 'PDV',
    type: 'PROBLEMA',
    context: { screen: 'Pagamento', terminal: 'Caixa #2' },
  });
  for (const forbidden of ['companyId', 'branchId', 'userId', 'screen', 'terminal', 'entityId']) {
    assert.equal(forbidden in payload, false, `${forbidden} não pode estar no nível raiz`);
  }
});

const SALE = '3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b';
const PAY = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

test('pagamento tem prioridade; sem pagamento, a venda; sempre o caixa como terminal', () => {
  assert.deepEqual(buildTicketContext({ screen: 'Pagamento', saleId: SALE, paymentId: PAY, registerNumber: 2 }), {
    screen: 'Pagamento',
    terminal: 'Caixa #2',
    entityType: 'PAYMENT',
    entityId: PAY,
  });
  assert.deepEqual(buildTicketContext({ screen: 'Pagamento', saleId: SALE, registerNumber: '3' }), {
    screen: 'Pagamento',
    terminal: 'Caixa #3',
    entityType: 'SALE',
    entityId: SALE,
  });
});

test('id malformado ou ausente não vira referência; sem caixa não há terminal', () => {
  assert.deepEqual(buildTicketContext({ screen: 'Vendas', saleId: "1' OR 1=1", paymentId: 'abc' }), { screen: 'Vendas' });
  assert.deepEqual(buildTicketContext({ screen: 'Vendas', saleId: null, registerNumber: null }), { screen: 'Vendas' });
  assert.equal(buildTicketContext({ screen: 'x'.repeat(200) }).screen.length, 80);
});

test('validação de assunto e descrição espelha a API', () => {
  assert.equal(validateReport({ subject: 'Erro no PIX', description: 'A maquininha não respondeu.' }), null);
  assert.match(validateReport({ subject: 'ab', description: 'A maquininha não respondeu.' })!, /assunto/i);
  assert.match(validateReport({ subject: 'Erro', description: 'curto' })!, /10 caracteres/);
  assert.match(validateReport({ subject: 'a'.repeat(161), description: 'A maquininha não respondeu.' })!, /160/);
});

test('chave de idempotência: recusa do servidor (4xx) pede chave nova; sem resposta ou 5xx mantém a mesma', () => {
  // Regressão: depois de recusar número de cartão (400), corrigir o texto e reenviar com a MESMA chave dava 422.
  assert.equal(shouldRenewIdempotencyKey(400), true);
  assert.equal(shouldRenewIdempotencyKey(422), true);
  assert.equal(shouldRenewIdempotencyKey(409), true);
  // Falta de resposta/queda do servidor: reenviar com a mesma chave devolve o mesmo chamado, nunca um segundo.
  assert.equal(shouldRenewIdempotencyKey(undefined), false);
  assert.equal(shouldRenewIdempotencyKey(0), false);
  assert.equal(shouldRenewIdempotencyKey(500), false);
  assert.equal(shouldRenewIdempotencyKey(503), false);
});
