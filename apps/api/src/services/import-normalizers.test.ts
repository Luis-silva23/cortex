import { buildProductUpdate, normalizeCustomerRow, normalizeProductRow, normalizeStockRow } from './import-normalizers';

describe('normalizeProductRow', () => {
  it('SKU é obrigatório — sem ele a linha é recusada (nunca casa "o primeiro produto")', () => {
    for (const raw of [{ name: 'X', price: 1 }, { sku: '', name: 'X' }, { sku: '   ' }, {}, null, undefined]) {
      const result = normalizeProductRow(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/SKU/);
    }
  });

  it('aceita os nomes que a tela manda: price → salePrice, stock → initialQuantity, category → categoryName', () => {
    const result = normalizeProductRow({ sku: 'A1', name: 'Óleo', price: '45', stock: '12', category: 'Lubrificantes' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ sku: 'A1', name: 'Óleo', salePrice: 45, initialQuantity: 12, categoryName: 'Lubrificantes' });
    }
  });

  it('os nomes do backend têm precedência (salePrice/costPrice/categoryName/initialQuantity)', () => {
    const result = normalizeProductRow({ sku: 'A1', salePrice: 10, price: 99, costPrice: 4, categoryName: 'X', category: 'Y', initialQuantity: 3, stock: 9 });
    expect(result.ok && result.value).toMatchObject({ salePrice: 10, costPrice: 4, categoryName: 'X', initialQuantity: 3 });
  });

  it('lê decimais de planilha: "99,90" e "1.234,56"', () => {
    const a = normalizeProductRow({ sku: 'A', price: '99,90' });
    const b = normalizeProductRow({ sku: 'B', price: '1.234,56', cost: '10,5' });
    expect(a.ok && a.value.salePrice).toBe(99.9);
    expect(b.ok && b.value.salePrice).toBe(1234.56);
    expect(b.ok && b.value.costPrice).toBe(10.5);
  });

  it('preço inválido ou negativo recusa a linha com a mensagem do campo', () => {
    expect(normalizeProductRow({ sku: 'A', price: 'abc' })).toEqual({ ok: false, error: 'Preço de venda inválido (abc)' });
    expect(normalizeProductRow({ sku: 'A', price: -1 })).toEqual({ ok: false, error: 'Preço de venda inválido (-1)' });
    expect(normalizeProductRow({ sku: 'A', cost: 'x' })).toEqual({ ok: false, error: 'Custo inválido (x)' });
  });

  it('estoque mínimo/máximo precisam ser inteiros (colunas Int)', () => {
    expect(normalizeProductRow({ sku: 'A', minStock: 1.5 })).toEqual({ ok: false, error: 'Estoque mínimo inválido (1.5)' });
    const ok = normalizeProductRow({ sku: 'A', minStock: '3', maxStock: 10 });
    expect(ok.ok && ok.value).toMatchObject({ minStock: 3, maxStock: 10 });
  });

  it('estoque inicial inválido só gera aviso (a tela já diz que "será ignorado") e não recusa a linha', () => {
    const result = normalizeProductRow({ sku: 'A', name: 'X', price: 1, stock: 'muitos' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.initialQuantity).toBeUndefined();
      expect(result.value.warnings[0]).toMatch(/Estoque inicial inválido/);
    }
  });

  it('texto vazio vira ausente (não sobrescreve campo existente com "")', () => {
    const result = normalizeProductRow({ sku: 'A', name: '  ', description: '', barcode: ' ', unit: '' });
    expect(result.ok && result.value).toMatchObject({ sku: 'A' });
    if (result.ok) {
      expect(result.value.name).toBeUndefined();
      expect(result.value.description).toBeUndefined();
      expect(result.value.barcode).toBeUndefined();
      expect(result.value.unit).toBeUndefined();
    }
  });
});

describe('buildProductUpdate — só o que veio na linha', () => {
  it('linha só com SKU e preço altera SÓ o preço (não zera minStock/maxStock nem troca unit)', () => {
    const result = normalizeProductRow({ sku: 'A1', price: 50 });
    expect(result.ok && buildProductUpdate(result.value)).toEqual({ salePrice: 50 });
  });

  it('linha só com SKU não tem nada para atualizar', () => {
    const result = normalizeProductRow({ sku: 'A1' });
    expect(result.ok && buildProductUpdate(result.value)).toEqual({});
  });

  it('inclui apenas os campos presentes, inclusive 0 (valor válido)', () => {
    const result = normalizeProductRow({ sku: 'A1', name: 'Novo', minStock: 0, cost: 0 });
    expect(result.ok && buildProductUpdate(result.value)).toEqual({ name: 'Novo', minStock: 0, costPrice: 0 });
  });
});

describe('normalizeStockRow', () => {
  it('exige SKU ou código de barras (senão o where viraria "qualquer produto")', () => {
    expect(normalizeStockRow({ quantity: 3 })).toEqual({ ok: false, error: 'Informe SKU ou código de barras' });
    expect(normalizeStockRow({ sku: ' ', barcode: '', quantity: 3 })).toEqual({ ok: false, error: 'Informe SKU ou código de barras' });
  });

  it('só barcode, só sku ou os dois — sem lado indefinido no resultado', () => {
    const a = normalizeStockRow({ barcode: '789', quantity: '5' });
    expect(a.ok && a.value).toEqual({ sku: undefined, barcode: '789', quantity: 5, reason: undefined });
    const b = normalizeStockRow({ sku: 'S1', quantity: 0 });
    expect(b.ok && b.value.quantity).toBe(0);
  });

  it('quantidade ausente, inválida ou negativa é recusada; aceita "2,5"', () => {
    expect(normalizeStockRow({ sku: 'S1' }).ok).toBe(false);
    expect(normalizeStockRow({ sku: 'S1', quantity: 'x' }).ok).toBe(false);
    expect(normalizeStockRow({ sku: 'S1', quantity: -1 }).ok).toBe(false);
    const ok = normalizeStockRow({ sku: 'S1', quantity: '2,5' });
    expect(ok.ok && ok.value.quantity).toBe(2.5);
  });
});

describe('normalizeCustomerRow', () => {
  it('aceita `zipcode` (nome da tela) e `cpfCnpj`, e descarta strings vazias', () => {
    const result = normalizeCustomerRow({ name: 'Ana', zipcode: '01000-000', cpfCnpj: '123', email: '', phone: '  ' }, 'company-A');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ name: 'Ana', zipCode: '01000-000', document: '123', companyId: 'company-A' });
      expect('email' in result.value).toBe(false);
      expect('phone' in result.value).toBe(false);
    }
  });

  it('e-mail inválido é recusado, com o campo apontado', () => {
    const emailRuim = normalizeCustomerRow({ name: 'Ana', email: 'nao-e-email' }, 'company-A');
    expect(emailRuim.ok).toBe(false);
    if (!emailRuim.ok) expect(emailRuim.error).toMatch(/email/);
  });

  it('linha de "atualizar" sem nome é válida na normalização (o nome só é exigido para criar, na rota)', () => {
    const result = normalizeCustomerRow({ document: '123', phone: '(11) 98765-4321', email: 'novo@example.com' }, 'company-A');
    expect(result.ok).toBe(true);
    if (result.ok) expect('name' in result.value).toBe(false);
  });
});
