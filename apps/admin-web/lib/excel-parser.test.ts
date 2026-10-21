import { ExcelParser, decodeCsv, detectCsvSeparator, parseNumberBR } from './excel-parser';

describe('planilhas brasileiras', () => {
  it.each([
    ['99,90', 99.9],
    ['1.234,56', 1234.56],
    ['99.90', 99.9],
    [45, 45],
    ['', NaN],
  ])('parseNumberBR(%p) = %p', (input, expected) => {
    expect(parseNumberBR(input)).toBe(expected);
  });

  it('preço com vírgula decimal é aceito (antes Number("45,50") = NaN recusava a linha)', () => {
    expect(ExcelParser.validateProductData([['PROD001', 'Óleo', '45,50']], { sku: 0, name: 1, price: 2 }, 'basic').valid).toBe(true);
  });

  it('CSV em UTF-8 com BOM e em Windows-1252 (Excel pt-BR) decodificam "Preço" corretamente', () => {
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('SKU;Preço')]);
    expect(decodeCsv(utf8)).toBe('SKU;Preço');
    const win1252 = new Uint8Array([0x53, 0x4b, 0x55, 0x3b, 0x50, 0x72, 0x65, 0xe7, 0x6f]); // "SKU;Preço" com ç = 0xE7
    expect(decodeCsv(win1252)).toBe('SKU;Preço');
  });

  it('separador ";" (Excel pt-BR) ou ","', () => {
    expect(detectCsvSeparator('SKU;Nome;Preço\nA;B;9,90')).toBe(';');
    expect(detectCsvSeparator('SKU,Nome,Preço\nA,B,9.90')).toBe(',');
  });

  it('CPF com dígito verificador errado é recusado (antes só o tamanho era conferido)', () => {
    const result = ExcelParser.validateCustomerData([['Maria', '123.456.789-00'], ['João', '529.982.247-25']], { name: 0, document: 1 }, 'simple');
    expect(result.errors).toEqual(['Linha 2: CPF/CNPJ inválido (12345678900)']);
  });
});

// A importação antiga aceitava linhas sem SKU e o backend sobrescrevia o
// primeiro produto da empresa; agora o SKU é exigido em todo cenário.
describe('ExcelParser.validateProductData — SKU obrigatório em todos os cenários', () => {
  const rows = [
    ['PROD001', 'Óleo', '45,50'],
    ['', 'Filtro', '20'],
  ];

  it.each(['basic', 'with-categories', 'update'] as const)('cenário %s: sem a coluna SKU mapeada a validação falha', (scenario) => {
    const map: Record<string, number> = scenario === 'update' ? { price: 2 } : { name: 1, price: 2, category: 1 };
    const result = ExcelParser.validateProductData(rows, map, scenario);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/"sku"/);
  });

  it('linha com SKU vazio é apontada pelo número da linha da planilha', () => {
    const result = ExcelParser.validateProductData(rows, { sku: 0, name: 1, price: 2 }, 'basic');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Linha 3: SKU é obrigatório');
  });

  it('todas as linhas com SKU, nome e preço válidos passam', () => {
    const ok = [
      ['PROD001', 'Óleo', '45'],
      ['PROD002', 'Filtro', '20'],
    ];
    expect(ExcelParser.validateProductData(ok, { sku: 0, name: 1, price: 2 }, 'basic').valid).toBe(true);
  });

  it('atualização por SKU não exige nome', () => {
    const update = [['PROD001', '129.90']];
    expect(ExcelParser.validateProductData(update, { sku: 0, price: 1 }, 'update').valid).toBe(true);
  });
});
