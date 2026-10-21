import { validateReceiveQuantities, validateSendQuantities } from './transfers';

const rows = [
  { id: 'i1', label: 'Filtro de óleo', max: 10 },
  { id: 'i2', label: 'Pastilha de freio', max: 4 },
];

describe('validateSendQuantities', () => {
  it('aceita quantidades entre 1 e o solicitado', () => {
    const result = validateSendQuantities(rows, { i1: '10', i2: '1' });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual({});
    expect(result.message).toBeNull();
  });

  it('campo limpo é inválido e aponta o item (antes virava 0 e a API recusava tudo)', () => {
    const result = validateSendQuantities(rows, { i1: '5', i2: '' });
    expect(result.ok).toBe(false);
    expect(result.errors.i2).toBeTruthy();
    expect(result.errors.i1).toBeUndefined();
    expect(result.message).toContain('Pastilha de freio');
  });

  it('item ausente do mapa também é inválido', () => {
    const result = validateSendQuantities(rows, { i1: '5' });
    expect(result.ok).toBe(false);
    expect(result.errors.i2).toBeTruthy();
  });

  it('zero e negativo são inválidos no envio (API: sentQuantity <= 0)', () => {
    const result = validateSendQuantities(rows, { i1: '0', i2: '-1' });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.errors).sort()).toEqual(['i1', 'i2']);
  });

  it('acima do solicitado é inválido (a API também recusa)', () => {
    const result = validateSendQuantities(rows, { i1: '11', i2: '4' });
    expect(result.ok).toBe(false);
    expect(result.errors.i1).toContain('10');
    expect(result.errors.i2).toBeUndefined();
  });

  it('texto não numérico é inválido', () => {
    expect(validateSendQuantities(rows, { i1: 'abc', i2: '1' }).ok).toBe(false);
  });

  it('a mensagem do topo cita o primeiro item inválido', () => {
    const result = validateSendQuantities(rows, { i1: '0', i2: '0' });
    expect(result.message).toContain('Filtro de óleo');
  });
});

describe('validateReceiveQuantities', () => {
  it('aceita zero (perda total no transporte) até o enviado', () => {
    const result = validateReceiveQuantities(rows, { i1: '0', i2: '4' });
    expect(result.ok).toBe(true);
  });

  it('rejeita negativo, vazio e acima do enviado', () => {
    expect(validateReceiveQuantities(rows, { i1: '-1', i2: '1' }).errors.i1).toBeTruthy();
    expect(validateReceiveQuantities(rows, { i1: '1', i2: '' }).errors.i2).toBeTruthy();
    expect(validateReceiveQuantities(rows, { i1: '11', i2: '1' }).errors.i1).toContain('enviado');
  });
});
