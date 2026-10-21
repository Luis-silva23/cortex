import {
  branchIdForSale,
  buildFiscalConfigPayload,
  defaultFiscalForm,
  fiscalConfigToForm,
  hasStoredSecret,
  normalizeCancellationReason,
  isSaleOfferedForEmission,
} from './fiscal';

describe('isSaleOfferedForEmission — a tela fiscal só oferece venda concluída', () => {
  it.each([
    ['PAID', true],
    ['CANCELLED', false],
    ['PENDING', false],
    ['PARTIALLY_PAID', false],
    ['RETURNED', false],
    [undefined, false],
  ])('%s → %s', (status, expected) => {
    expect(isSaleOfferedForEmission({ id: 's', status: status as any })).toBe(expected);
  });
});

describe('hasStoredSecret', () => {
  it('usa os booleanos da API quando vêm', () => {
    expect(hasStoredSecret({ hasCertificatePassword: true, hasCscToken: false }, 'certificatePassword')).toBe(true);
    expect(hasStoredSecret({ hasCertificatePassword: true, hasCscToken: false }, 'cscToken')).toBe(false);
  });

  it('o booleano vence o campo antigo (que a API nova nem devolve)', () => {
    expect(hasStoredSecret({ hasCscToken: false, cscToken: 'segredo' }, 'cscToken')).toBe(false);
  });

  it('cai na checagem antiga quando a API ainda devolve o segredo', () => {
    expect(hasStoredSecret({ certificatePassword: 'abc' }, 'certificatePassword')).toBe(true);
    expect(hasStoredSecret({ certificatePassword: '' }, 'certificatePassword')).toBe(false);
    expect(hasStoredSecret({ certificatePassword: null }, 'certificatePassword')).toBe(false);
  });

  it('sem configuração, não há segredo', () => {
    expect(hasStoredSecret(null, 'cscToken')).toBe(false);
  });
});

describe('fiscalConfigToForm', () => {
  it('nunca pré-preenche os campos de segredo, mesmo que a API os devolva', () => {
    const form = fiscalConfigToForm({
      nfceEnabled: true,
      nfceSeriesNumber: 3,
      nfeEnabled: false,
      nfeSeriesNumber: 1,
      certificatePath: '/certs/a.pfx',
      certificatePassword: 'senha-em-texto-puro',
      cscId: '000001',
      cscToken: 'token-em-texto-puro',
      environment: 'PRODUCAO',
      cancelTimeLimit: 48,
    });
    expect(form.certificatePassword).toBe('');
    expect(form.cscToken).toBe('');
    expect(form.nfceSeriesNumber).toBe('3');
    expect(form.environment).toBe('PRODUCAO');
    expect(form.cancelTimeLimit).toBe('48');
  });

  it('filial sem configuração volta aos padrões (não herda a filial anterior)', () => {
    expect(fiscalConfigToForm(null)).toEqual(defaultFiscalForm());
  });
});

describe('buildFiscalConfigPayload', () => {
  it('não envia segredo quando o usuário não digitou nada', () => {
    const payload = buildFiscalConfigPayload('b1', { ...defaultFiscalForm(), cscId: '1' });
    expect(payload.certificatePassword).toBeUndefined();
    expect(payload.cscToken).toBeUndefined();
    expect(Object.keys(payload)).toContain('branchId');
    expect(payload.branchId).toBe('b1');
  });

  it('envia o segredo só quando há um valor novo digitado', () => {
    const payload = buildFiscalConfigPayload('b1', {
      ...defaultFiscalForm(),
      certificatePassword: ' nova senha ',
      cscToken: 'novo-token',
    });
    expect(payload.certificatePassword).toBe(' nova senha ');
    expect(payload.cscToken).toBe('novo-token');
  });

  it('converte séries e prazo para número', () => {
    const payload = buildFiscalConfigPayload('b1', {
      ...defaultFiscalForm(),
      nfceSeriesNumber: '2',
      nfeSeriesNumber: '5',
      cancelTimeLimit: '72',
    });
    expect(payload.nfceSeriesNumber).toBe(2);
    expect(payload.nfeSeriesNumber).toBe(5);
    expect(payload.cancelTimeLimit).toBe(72);
  });
});

describe('normalizeCancellationReason', () => {
  it('motivo vazio, só espaços ou ausente é inválido (a API responde 400)', () => {
    expect(normalizeCancellationReason('')).toBeNull();
    expect(normalizeCancellationReason('   ')).toBeNull();
    expect(normalizeCancellationReason(null)).toBeNull();
    expect(normalizeCancellationReason(undefined)).toBeNull();
  });

  it('devolve o motivo sem espaços nas pontas', () => {
    expect(normalizeCancellationReason('  erro de digitação ')).toBe('erro de digitação');
  });
});

describe('branchIdForSale', () => {
  const sales = [
    { id: 's1', branchId: 'b1' },
    { id: 's2', branchId: 'b2' },
    { id: 's3', branchId: null },
  ];

  it('deriva a filial da venda escolhida', () => {
    expect(branchIdForSale(sales, 's2')).toBe('b2');
  });

  it('venda inexistente ou sem filial não tem filial', () => {
    expect(branchIdForSale(sales, 'nope')).toBeNull();
    expect(branchIdForSale(sales, 's3')).toBeNull();
    expect(branchIdForSale(sales, '')).toBeNull();
  });
});
