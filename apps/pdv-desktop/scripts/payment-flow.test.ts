/**
 * Lógica pura do fluxo de pagamento e da segunda etapa do login do PDV.
 * Uso: `npm run test:logic` (tsx + node:test; o PDV não tem jest).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptFor,
  classifyApiError,
  closeAttempt,
  isUncertain,
  readableError,
  phaseFromPaymentStatus,
  stableSignature,
} from '../src/services/payment-flow';
import { isMfaCodeComplete, mfaErrorMessage, normalizeMfaCode } from '../src/services/mfa-login';

const httpError = (status: number, data: any) => ({ response: { status, data } });

test('só APPROVED conclui; desconhecido/pendente nunca vira aprovado', () => {
  assert.equal(phaseFromPaymentStatus('APPROVED'), 'APPROVED');
  assert.equal(phaseFromPaymentStatus('PENDING'), 'UNCONFIRMED');
  assert.equal(phaseFromPaymentStatus(undefined), 'UNCONFIRMED');
  assert.equal(phaseFromPaymentStatus('QUALQUER'), 'UNCONFIRMED');
  assert.equal(phaseFromPaymentStatus('REJECTED'), 'DECLINED');
  assert.equal(phaseFromPaymentStatus('CANCELLED'), 'CANCELLED');
  assert.equal(phaseFromPaymentStatus('REFUNDED'), 'CANCELLED');
});

test('assinatura estável independe da ordem das chaves e ignora undefined', () => {
  assert.equal(stableSignature({ a: 1, b: { c: 2, d: undefined } }), stableSignature({ b: { c: 2 }, a: 1 }));
  assert.notEqual(stableSignature({ a: 1 }), stableSignature({ a: 2 }));
});

test('mesma tentativa aberta reusa a chave; resultado definitivo ou corpo diferente gera chave nova', () => {
  const sig = stableSignature({ saleId: 's1', paymentMethod: 'CASH', amount: 10 });
  const a1 = attemptFor(null, sig);
  const a2 = attemptFor(a1, sig);
  assert.equal(a2.key, a1.key, 'reenvio após falta de resposta usa a MESMA chave');
  const a3 = attemptFor(closeAttempt(a2), sig);
  assert.notEqual(a3.key, a1.key, 'depois de recusado/cancelado, nova tentativa = nova chave');
  const a4 = attemptFor(a3, stableSignature({ saleId: 's1', paymentMethod: 'PIX', amount: 10 }));
  assert.notEqual(a4.key, a3.key, 'trocar a forma de pagamento = nova tentativa');
  assert.match(a1.key, /^PDV-/);
});

test('classificação de erros: incerto x definitivo', () => {
  const net = classifyApiError(new Error('Network Error'));
  assert.equal(net.kind, 'NETWORK');
  assert.ok(isUncertain(net.kind));
  assert.equal(classifyApiError(httpError(409, { success: false, error: 'Uma requisição com esta Idempotency-Key já está sendo processada' })).kind, 'IN_FLIGHT');
  assert.equal(classifyApiError(httpError(500, { error: 'boom' })).kind, 'SERVER');
  assert.ok(isUncertain('SERVER'));
  assert.equal(classifyApiError(httpError(400, { error: 'A venda já está paga (ou o saldo está reservado por pagamentos pendentes)' })).kind, 'COMMITTED_BY_PENDING');
  assert.equal(classifyApiError(httpError(400, { error: 'A venda já foi paga por outro pagamento aprovado ao mesmo tempo' })).kind, 'ALREADY_PAID');
  assert.equal(classifyApiError(httpError(400, { error: 'Sale is already fully paid (concurrent payment approved first)' })).kind, 'ALREADY_PAID');
  const biz = classifyApiError(httpError(400, { error: 'O valor passa do saldo a pagar. Saldo: 5' }));
  assert.equal(biz.kind, 'BUSINESS');
  assert.ok(!isUncertain(biz.kind));
  assert.equal(classifyApiError(httpError(403, { error: 'Forbidden' })).kind, 'FORBIDDEN');
});

test('erros de convênio pelo código do contrato, em PT-BR', () => {
  for (const code of ['AGREEMENT_DISABLED', 'AGREEMENT_LIMIT_EXCEEDED', 'AGREEMENT_BLOCKED', 'AGREEMENT_INACTIVE', 'AGREEMENT_REQUIRED', 'INSTALLMENTS_INVALID']) {
    const c = classifyApiError(httpError(code === 'AGREEMENT_LIMIT_EXCEEDED' || code === 'AGREEMENT_BLOCKED' || code === 'AGREEMENT_INACTIVE' ? 409 : 400, { error: 'x', code }));
    assert.equal(c.kind, 'BUSINESS');
    assert.equal(c.code, code);
    assert.doesNotMatch(c.message, /^x$/);
  }
  assert.match(classifyApiError(httpError(409, { error: 'x', code: 'AGREEMENT_LIMIT_EXCEEDED' })).message, /Limite do convênio/);
});

test('MFA: normalização e validação do código', () => {
  assert.equal(normalizeMfaCode('totp', ' 12a3 45 6789'), '123456');
  assert.ok(isMfaCodeComplete('totp', '123456'));
  assert.ok(!isMfaCodeComplete('totp', '12345'));
  assert.equal(normalizeMfaCode('backup', 'AB12-cd34 ef56 7890 zz'), 'ab12cd34ef567890');
  assert.ok(isMfaCodeComplete('backup', 'ab12cd34ef567890'));
  assert.ok(!isMfaCodeComplete('backup', 'ab12cd34'));
});

test('MFA: mensagens explicam o erro e dizem quando recomeçar', () => {
  const wrong = mfaErrorMessage(httpError(400, { error: 'Invalid Code', message: 'Código incorreto' }), 'totp');
  assert.equal(wrong.restart, false);
  assert.match(wrong.message, /Código incorreto.*30 segundos/);
  const expired = mfaErrorMessage(httpError(401, { error: 'Unauthorized', message: 'jwt expired' }), 'totp');
  assert.equal(expired.restart, true);
  assert.match(expired.message, /expirou/);
  const backup = mfaErrorMessage(httpError(400, { message: 'Invalid or already used backup code' }), 'backup');
  assert.match(backup.message, /recuperação inválido ou já usado/);
  assert.equal(mfaErrorMessage(new Error('Network Error'), 'totp').restart, false);
  assert.equal(mfaErrorMessage(httpError(409, { message: 'Usuário já conectado em outro PDV' }), 'totp').restart, true);
});

test("erro com CÓDIGO de máquina em `error` mostra o `message` legível (ex.: MFA obrigatório do administrador)", () => {
  assert.match(readableError({ error: 'MFA_ENROLLMENT_REQUIRED', message: 'Sua conta exige a verificação em duas etapas. Configure no Admin Web.' }), /verificação em duas etapas/);
  assert.equal(readableError({ error: 'Conflict', message: 'Já existe' }), 'Já existe');
  assert.equal(readableError({ error: 'Estoque insuficiente para o produto' }), 'Estoque insuficiente para o produto');
});
