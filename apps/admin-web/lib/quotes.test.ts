import {
  canWriteQuotes,
  isClosable,
  overdueLabel,
  computeQuoteTotals,
  endOfDayIso,
  isPastValidity,
  latestVersion,
  newItemDraft,
  quoteActions,
  toDateInputValue,
  validateItemDrafts,
  workflowSteps,
} from './quotes';

const draft = (overrides: Record<string, any> = {}) =>
  newItemDraft('SERVICE', { description: 'Troca de óleo', quantity: '1', unitPrice: '80', ...overrides });

describe('canWriteQuotes — mesmo gate de escrita de quotes.routes.ts (todos menos VIEWER)', () => {
  it.each(['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC'])('%s pode escrever', (role) => {
    expect(canWriteQuotes(role)).toBe(true);
  });

  it.each(['VIEWER', '', null, undefined, 'QUALQUER'])('%p não pode escrever', (role) => {
    expect(canWriteQuotes(role as any)).toBe(false);
  });
});

describe('computeQuoteTotals — mesma soma de computeTotals() do backend', () => {
  it('separa mão de obra e peças e soma o total; desconto é sempre 0', () => {
    const totals = computeQuoteTotals([
      { itemType: 'SERVICE', quantity: 1, unitPrice: 80 },
      { itemType: 'PART', quantity: 2, unitPrice: 45 },
      { itemType: 'PART', quantity: 1, unitPrice: 24 },
    ]);

    expect(totals).toEqual({ laborTotal: 80, partsTotal: 114, discountAmount: 0, totalAmount: 194 });
  });

  it('arredonda a 2 casas como o Decimal(10,2) (soma as linhas sem arredondar cada uma)', () => {
    // 3 x 0.335 = 1.005 -> 1.01 (soma bruta), não 3 x round2(0.335)
    expect(computeQuoteTotals([{ itemType: 'SERVICE', quantity: 3, unitPrice: 0.335 }]).laborTotal).toBe(1.01);
  });

  it('lista vazia dá zero', () => {
    expect(computeQuoteTotals([])).toEqual({ laborTotal: 0, partsTotal: 0, discountAmount: 0, totalAmount: 0 });
  });
});

describe('validateItemDrafts — espelha assertValidItems() do backend', () => {
  it('exige pelo menos um item', () => {
    expect(validateItemDrafts([]).message).toBe('Adicione pelo menos um item ao orçamento.');
  });

  it.each([
    ['descrição vazia', { description: '   ' }, 'informe a descrição'],
    ['quantidade zero', { quantity: '0' }, 'quantidade deve ser maior que zero'],
    ['quantidade negativa', { quantity: '-1' }, 'quantidade deve ser maior que zero'],
    ['quantidade em branco', { quantity: '' }, 'quantidade deve ser maior que zero'],
    ['preço em branco', { unitPrice: '' }, 'informe o valor unitário'],
    ['preço negativo', { unitPrice: '-5' }, 'informe o valor unitário'],
    ['valor acima do limite do Decimal', { quantity: '2', unitPrice: '60000000' }, 'excede o limite'],
  ])('recusa %s apontando o item', (_label, overrides, expected) => {
    const result = validateItemDrafts([draft(overrides)]);

    expect(result.payload).toHaveLength(0);
    expect(result.message).toContain('Item 1');
    expect(result.message).toContain(expected);
  });

  it('aceita vírgula decimal (pt-BR) e converte para o payload da API', () => {
    const result = validateItemDrafts([draft({ quantity: '1,5', unitPrice: '10,50' })]);

    expect(result.message).toBeNull();
    expect(result.payload).toEqual([{ itemType: 'SERVICE', description: 'Troca de óleo', quantity: 1.5, unitPrice: 10.5 }]);
  });

  it('só envia productId em PEÇA do catálogo (serviço nunca carrega productId)', () => {
    const part = newItemDraft('PART', { description: 'Óleo', unitPrice: '45', productId: 'p1' });
    const service = draft({ productId: 'p-ignorado' });

    const { payload } = validateItemDrafts([part, service]);

    expect(payload[0]).toMatchObject({ itemType: 'PART', productId: 'p1' });
    expect(payload[1]).not.toHaveProperty('productId');
  });

  it('aponta o item inválido pelo número da linha (Item 2)', () => {
    const result = validateItemDrafts([draft(), draft({ quantity: '0' })]);

    expect(result.message).toContain('Item 2');
  });

  it('recusa total acima do limite mesmo com cada item dentro dele', () => {
    const big = draft({ quantity: '1', unitPrice: '60000000' });

    expect(validateItemDrafts([big, { ...big, key: 'outro' }]).message).toBe('O total do orçamento excede o limite suportado.');
  });
});

describe('datas — validade vale até o FIM do dia local (evita o bug do UTC)', () => {
  it('endOfDayIso mantém o dia escolhido às 23:59:59 locais', () => {
    const iso = endOfDayIso('2026-09-30')!;
    const local = new Date(iso);

    expect(local.getFullYear()).toBe(2026);
    expect(local.getMonth()).toBe(8);
    expect(local.getDate()).toBe(30);
    expect(local.getHours()).toBe(23);
    expect(local.getMinutes()).toBe(59);
  });

  it('endOfDayIso vazio vira undefined; toDateInputValue faz o caminho de volta', () => {
    expect(endOfDayIso('')).toBeUndefined();
    expect(toDateInputValue(endOfDayIso('2026-09-30'))).toBe('2026-09-30');
    expect(toDateInputValue(null)).toBe('');
    expect(toDateInputValue('lixo')).toBe('');
  });

  it('isPastValidity só sinaliza orçamento ainda em aberto e vencido', () => {
    const now = new Date('2026-10-10T12:00:00');
    const past = '2026-10-01T23:59:59';

    expect(isPastValidity({ status: 'DRAFT', validUntil: past }, now)).toBe(true);
    expect(isPastValidity({ status: 'SENT', validUntil: past }, now)).toBe(true);
    expect(isPastValidity({ status: 'APPROVED', validUntil: past }, now)).toBe(true);
    expect(isPastValidity({ status: 'CONVERTED', validUntil: past }, now)).toBe(false);
    expect(isPastValidity({ status: 'REJECTED', validUntil: past }, now)).toBe(false);
    expect(isPastValidity({ status: 'DRAFT', validUntil: '2026-12-01T23:59:59' }, now)).toBe(false);
    expect(isPastValidity({ status: 'DRAFT', validUntil: null }, now)).toBe(false);
  });
});

describe('quoteActions — o que cada estado permite (espelha quote.service.ts)', () => {
  const v = (n: number, extra: Record<string, any> = {}) => ({ versionNumber: n, ...extra });
  const actions = (status: string, versions: any[], canWrite = true) => quoteActions({ status, versions }, canWrite);

  it('DRAFT com versão não enviada: pode enviar e criar nova versão; não decide nem converte', () => {
    expect(actions('DRAFT', [v(1)])).toMatchObject({ canSend: true, canDecide: false, canConvert: false, canAddVersion: true });
  });

  it('SENT: pode registrar a decisão e criar nova versão; não reenvia', () => {
    expect(actions('SENT', [v(1, { sentAt: '2026-09-20' })])).toMatchObject({
      canSend: false,
      canDecide: true,
      canConvert: false,
      canAddVersion: true,
    });
  });

  it('APPROVED: só converter (sem nova versão, sem nova decisão)', () => {
    expect(actions('APPROVED', [v(1, { sentAt: 'x', approvedAt: 'y', isApproved: true })])).toMatchObject({
      canSend: false,
      canDecide: false,
      canConvert: true,
      canAddVersion: false,
    });
  });

  it('REJECTED: só nova versão (a decisão já foi registrada)', () => {
    expect(actions('REJECTED', [v(1, { sentAt: 'x', approvedAt: 'y', isApproved: false })])).toMatchObject({
      canSend: false,
      canDecide: false,
      canConvert: false,
      canAddVersion: true,
    });
  });

  it('nova versão depois de REJECTED volta a poder ser enviada (o backend reseta o status para DRAFT)', () => {
    expect(actions('DRAFT', [v(1, { sentAt: 'x', approvedAt: 'y' }), v(2)])).toMatchObject({ canSend: true, canDecide: false });
  });

  it('CONVERTED: nenhuma ação, e aponta a OS gerada', () => {
    const result = actions('CONVERTED', [v(1, { serviceOrder: { id: 'os-1', osNumber: 7, status: 'ENTRADA' } })]);

    expect(result).toMatchObject({ canSend: false, canDecide: false, canConvert: false, canAddVersion: false });
    expect(result.linkedServiceOrder).toEqual({ id: 'os-1', osNumber: 7, status: 'ENTRADA' });
  });

  it('VIEWER (sem escrita) não tem ação nenhuma em nenhum estado', () => {
    for (const status of ['DRAFT', 'SENT', 'APPROVED', 'REJECTED']) {
      expect(actions(status, [v(1, { sentAt: 'x' })], false)).toMatchObject({
        canSend: false,
        canDecide: false,
        canConvert: false,
        canAddVersion: false,
      });
    }
  });

  it('latestVersion pega o maior versionNumber, independente da ordem', () => {
    expect(latestVersion([v(2), v(3), v(1)])!.versionNumber).toBe(3);
    expect(latestVersion([])).toBeUndefined();
    expect(latestVersion(undefined)).toBeUndefined();
  });
});

describe('workflowSteps — Salvo → Enviado → Decisão → OS', () => {
  const states = (status: string) => workflowSteps(status).map((s) => s.state);

  it('DRAFT', () => expect(states('DRAFT')).toEqual(['done', 'current', 'pending', 'pending']));
  it('SENT', () => expect(states('SENT')).toEqual(['done', 'done', 'current', 'pending']));
  it('APPROVED', () => expect(states('APPROVED')).toEqual(['done', 'done', 'done', 'current']));
  it('CONVERTED', () => expect(states('CONVERTED')).toEqual(['done', 'done', 'done', 'done']));

  it('REJECTED bloqueia a decisão e rotula "Cliente recusou"', () => {
    const steps = workflowSteps('REJECTED');

    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'blocked', 'pending']);
    expect(steps[2].label).toBe('Cliente recusou');
  });
});

describe('encerramento e reabertura (espelha quote.service.ts close/reopen)', () => {
  it('seleção de encerramento: rascunho sempre; aguardando aprovação só vencido; demais nunca', () => {
    expect(isClosable({ status: 'DRAFT' })).toBe(true);
    expect(isClosable({ status: 'SENT', overdue: true })).toBe(true);
    expect(isClosable({ status: 'SENT', overdue: false })).toBe(false);
    for (const status of ['APPROVED', 'REJECTED', 'EXPIRED', 'CONVERTED']) expect(isClosable({ status, overdue: true })).toBe(false);
  });

  it('rótulo de vencido com os dias sem resposta', () => {
    expect(overdueLabel({ overdue: true, daysWithoutResponse: 6 })).toBe('Vencido · sem resposta há 6 dias');
    expect(overdueLabel({ overdue: true, daysWithoutResponse: 1 })).toBe('Vencido · sem resposta há 1 dia');
    expect(overdueLabel({ overdue: false, daysWithoutResponse: 2 })).toBeNull();
  });

  it('encerrado: nenhuma ação do fluxo (só a reabertura) e passo "Encerrado sem resposta" bloqueado', () => {
    const actions = quoteActions({ status: 'EXPIRED', versions: [{ versionNumber: 1, sentAt: '2026-09-01' }] }, true);
    expect(actions).toMatchObject({ canSend: false, canDecide: false, canConvert: false, canAddVersion: false });
    const steps = workflowSteps('EXPIRED');
    expect(steps[2]).toEqual({ label: 'Encerrado sem resposta', state: 'blocked' });
  });
});
