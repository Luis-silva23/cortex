import { buildAddItemPayload, canAddServiceOrderItem, parseDecimal, pickMechanics } from './service-orders';

describe('parseDecimal', () => {
  it('converte Decimal serializado como string (Prisma) em número', () => {
    expect(parseDecimal('129.90')).toBe(129.9);
  });

  it('aceita vírgula decimal e espaços', () => {
    expect(parseDecimal(' 12,5 ')).toBe(12.5);
  });

  it('valores inválidos viram 0', () => {
    expect(parseDecimal('abc')).toBe(0);
    expect(parseDecimal(null)).toBe(0);
    expect(parseDecimal(undefined)).toBe(0);
    expect(parseDecimal(NaN)).toBe(0);
  });

  it('número passa direto', () => {
    expect(parseDecimal(7)).toBe(7);
  });
});

describe('buildAddItemPayload', () => {
  const base = { itemType: 'PART' as const, description: 'Filtro', quantity: '2', unitPrice: '0' };

  it('peça do catálogo manda unitPrice NUMÉRICO mesmo com salePrice string (antes: 400 sempre)', () => {
    const result = buildAddItemPayload({ ...base, product: { id: 'p1', salePrice: '129.90' } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.unitPrice).toBe(129.9);
      expect(typeof result.payload.unitPrice).toBe('number');
      expect(result.payload.productId).toBe('p1');
      expect(result.payload.quantity).toBe(2);
    }
  });

  it('peça avulsa exige preço maior que zero', () => {
    const result = buildAddItemPayload({ ...base, product: null });
    expect(result.ok).toBe(false);
    const withPrice = buildAddItemPayload({ ...base, product: null, unitPrice: '15.5' });
    expect(withPrice.ok).toBe(true);
    if (withPrice.ok) {
      expect(withPrice.payload.productId).toBeUndefined();
      expect(withPrice.payload.unitPrice).toBe(15.5);
    }
  });

  it('serviço não referencia produto, mesmo que sobre um produto no estado', () => {
    const result = buildAddItemPayload({
      itemType: 'SERVICE',
      product: { id: 'p1', salePrice: '10' },
      description: 'Troca de óleo',
      quantity: '1',
      unitPrice: '80',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.productId).toBeUndefined();
      expect(result.payload.unitPrice).toBe(80);
    }
  });

  it('exige descrição e quantidade maior que zero', () => {
    expect(buildAddItemPayload({ ...base, description: '  ', product: null, unitPrice: '5' }).ok).toBe(false);
    expect(buildAddItemPayload({ ...base, quantity: '0', product: null, unitPrice: '5' }).ok).toBe(false);
  });
});

describe('canAddServiceOrderItem', () => {
  it('OS em andamento e não paga aceita item', () => {
    expect(canAddServiceOrderItem({ status: 'EXECUCAO', isPaid: false })).toBe(true);
  });

  it('OS paga não aceita item (a API recusa), mesmo antes de encerrar', () => {
    expect(canAddServiceOrderItem({ status: 'ENTREGA', isPaid: true })).toBe(false);
  });

  it('OS encerrada ou cancelada não aceita item', () => {
    expect(canAddServiceOrderItem({ status: 'ENCERRADA', isPaid: true })).toBe(false);
    expect(canAddServiceOrderItem({ status: 'CANCELADA', isPaid: false })).toBe(false);
  });

  it('sem OS carregada, não aceita', () => {
    expect(canAddServiceOrderItem(null)).toBe(false);
  });
});

describe('pickMechanics', () => {
  const users = [
    { id: 'u1', name: 'Zeca', userType: 'MECHANIC', isActive: true },
    { id: 'u2', name: 'Ana', userType: 'MECHANIC' },
    { id: 'u3', name: 'Bia', userType: 'VIEWER', isActive: true },
    { id: 'u4', name: 'Caio', userType: 'MANAGER', isActive: true },
    { id: 'u5', name: 'Davi', userType: 'MECHANIC', isActive: false },
  ];

  it('só devolve usuários MECHANIC ativos (a API recusa qualquer outro perfil)', () => {
    expect(pickMechanics(users).map((m) => m.id)).toEqual(['u2', 'u1']);
  });

  it('ordena por nome', () => {
    expect(pickMechanics(users).map((m) => m.name)).toEqual(['Ana', 'Zeca']);
  });

  it('lista ausente vira vazia', () => {
    expect(pickMechanics(null)).toEqual([]);
    expect(pickMechanics(undefined)).toEqual([]);
  });
});
