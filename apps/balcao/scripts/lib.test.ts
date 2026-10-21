// Rodar: npx tsx --test scripts/*.test.ts  (npm run test:logic) — regras PURAS do Balcão (nada de React, axios ou servidor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBRL, formatQuantity, parseInputNumber, toNumber } from '../src/lib/money';
import { lineCents, previewTotal } from '../src/lib/quote-preview';
import { canSeeSales, canWrite, needsBranchChoice } from '../src/lib/permissions';
import { canSearch, classifySearch } from '../src/lib/search';
import { apiErrorMessage } from '../src/lib/errors';
import { buildHandoffText } from '../src/lib/handoff';
import { buildItemsPayload, linesFromItems, type Line } from '../src/lib/quote-lines';
import { checkServerUrl } from '@ln-system/shared/utils/server-url';
import { splitInstallments } from '@ln-system/shared/utils/installments';

const nb = (s: string) => s.replace(/ /g, ' ');

test('dinheiro: Decimal do Prisma chega como string; entrada brasileira; nunca NaN na tela', () => {
  assert.equal(toNumber('129.90'), 129.9);
  assert.equal(toNumber(null), 0);
  assert.equal(toNumber('abc'), 0);
  assert.equal(nb(formatBRL('1234.5')), 'R$ 1.234,50');
  assert.equal(formatQuantity('2.000'), '2');
  assert.equal(parseInputNumber('1.234,50'), 1234.5);
  assert.equal(parseInputNumber('12,5'), 12.5);
  assert.equal(parseInputNumber('12.5'), 12.5);
  assert.equal(parseInputNumber(''), null);
  assert.equal(parseInputNumber('-3'), null);
  assert.equal(parseInputNumber('abc'), null);
});

test('prévia do orçamento: centavos inteiros (sem 0,1 + 0,2), quantidade fracionária, linha inválida vira zero', () => {
  assert.equal(previewTotal([{ quantity: 2, unitPrice: 10 }, { quantity: 1, unitPrice: 35.5 }]), 55.5);
  assert.equal(previewTotal([{ quantity: 1, unitPrice: 0.1 }, { quantity: 1, unitPrice: 0.2 }]), 0.3); // em ponto flutuante seria 0.30000000000000004
  assert.equal(lineCents({ quantity: '1.5', unitPrice: '10.01' }), 1502); // 15,015 → arredonda por linha
  assert.equal(previewTotal([{ quantity: -1, unitPrice: 'x' }]), 0);
  assert.equal(previewTotal([]), 0);
});

test('o parcelamento é o MESMO do servidor e do PDV (função compartilhada): 100,00 em 3x = 33,33 + 33,33 + 33,34', () => {
  assert.deepEqual(splitInstallments(100, 3), [33.33, 33.33, 33.34]);
});

test('papéis (dicas de tela; o servidor é a autoridade): VIEWER só consulta, MECHANIC não vê vendas, empresa toda escolhe filial', () => {
  assert.equal(canWrite('OPERATOR'), true);
  assert.equal(canWrite('MECHANIC'), true);
  assert.equal(canWrite('VIEWER'), false);
  assert.equal(canWrite(undefined), false);
  assert.equal(canSeeSales('MECHANIC'), false);
  assert.equal(canSeeSales('OPERATOR'), true);
  assert.equal(needsBranchChoice({ userType: 'COMPANY_ADMIN', branchId: null }), true);
  assert.equal(needsBranchChoice({ userType: 'COMPANY_ADMIN', branchId: 'b1' }), false);
  assert.equal(needsBranchChoice({ userType: 'OPERATOR', branchId: null }), false);
});

test('busca única: placa (antiga e Mercosul), número e texto; mínimo de 2 caracteres', () => {
  assert.deepEqual(classifySearch('abc-1234'), { kind: 'plate', term: 'ABC1234' });
  assert.deepEqual(classifySearch('ABC1D23'), { kind: 'plate', term: 'ABC1D23' });
  assert.deepEqual(classifySearch('(11) 98888-7777'), { kind: 'digits', term: '11988887777' });
  assert.deepEqual(classifySearch('529.982.247-25'), { kind: 'digits', term: '52998224725' });
  assert.deepEqual(classifySearch('João Silva'), { kind: 'text', term: 'João Silva' });
  assert.equal(classifySearch('   ').kind, 'empty');
  assert.equal(canSearch('a'), false);
  assert.equal(canSearch('ab'), true);
});

test('erros: mensagem útil em português, sem detalhe técnico; códigos conhecidos; rede e 5xx', () => {
  assert.match(apiErrorMessage({ error: 'Conflict', code: 'OPEN_QUOTE_EXISTS' }, 409), /orçamento em aberto/);
  assert.equal(apiErrorMessage({ error: 'Unauthorized', message: 'Credenciais inválidas' }, 401), 'Credenciais inválidas');
  assert.equal(apiErrorMessage({ error: 'Forbidden' }, 403), 'Usuário sem autorização. Entre em contato com o administrador.');
  assert.equal(apiErrorMessage({ error: 'Acesso negado', code: 'INSUFFICIENT_PERMISSIONS' }, 403), 'Usuário sem autorização. Entre em contato com o administrador.');
  assert.equal(apiErrorMessage({ error: 'Not Found' }, 404), 'Registro não encontrado.');
  assert.match(apiErrorMessage({ error: 'PrismaClientKnownRequestError at /srv/app/file.ts' }, 500), /servidor teve um problema/);
  assert.match(apiErrorMessage({}, 429), /Muitas tentativas/);
  assert.match(apiErrorMessage(null), /Tente novamente/);
});

test('endereço do servidor: produção só https, sem credencial; desenvolvimento aceita localhost (regra compartilhada com o PDV)', () => {
  assert.equal(checkServerUrl('https://api.exemplo.com.br', true), null);
  assert.match(checkServerUrl('http://api.exemplo.com.br', true) ?? '', /sem HTTPS/);
  assert.match(checkServerUrl('', true) ?? '', /não foi configurado/);
  assert.match(checkServerUrl('https://u:p@api.exemplo.com.br', true) ?? '', /usuário ou senha/);
  assert.equal(checkServerUrl('http://localhost:3001', false), null);
});

test('itens do orçamento: validação óbvia antes do round-trip; peça do catálogo leva productId; serviço exige valor', () => {
  const part: Line = { key: 'a', itemType: 'PART', productId: 'p1', description: 'Óleo', quantity: '2', unitPrice: '10' };
  const svc: Line = { key: 'b', itemType: 'SERVICE', description: 'Troca', quantity: '1', unitPrice: '35,50' };
  const ok = buildItemsPayload([part, svc]);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.items[0], { itemType: 'PART', productId: 'p1', description: 'Óleo', quantity: 2, unitPrice: 10 });
    assert.equal(ok.items[1].unitPrice, 35.5);
  }
  assert.equal(buildItemsPayload([]).ok, false);
  assert.equal(buildItemsPayload([{ ...part, quantity: '0' }]).ok, false);
  assert.equal(buildItemsPayload([{ ...svc, unitPrice: '0' }]).ok, false);
  assert.equal(buildItemsPayload([{ ...part, description: '  ' }]).ok, false);
  assert.equal(linesFromItems([{ itemType: 'PART', productId: 'p1', description: 'Óleo', quantity: '2.000', unitPrice: '10.00' }])[0].quantity, '2');
});

test('ficha ao caixa: usa o total OFICIAL do servidor, nomeia o documento e deixa claro que não é comprovante', () => {
  const text = buildHandoffText({
    kind: 'ORCAMENTO',
    number: 42,
    status: 'Aprovado',
    customerName: 'Maria',
    customerPhone: '11 99999-0000',
    vehicle: 'Honda CG 160 ABC1D23',
    items: [{ description: 'Óleo', quantity: '2', unitPrice: '10.00', totalPrice: '20.00' }],
    totalAmount: '55.50',
    issuedAt: new Date('2026-10-13T12:00:00Z'),
  });
  const plain = nb(text);
  assert.match(plain, /Orçamento nº 42/);
  assert.match(plain, /TOTAL: R\$ 55,50/); // vem do servidor (a soma dos itens aqui seria 20,00)
  assert.match(plain, /Pagamento: no CAIXA \(PDV\)/);
  assert.match(plain, /não é comprovante de pagamento/);
});
