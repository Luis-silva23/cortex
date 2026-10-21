import { customerToForm, EMPTY_CUSTOMER_FORM, validateCustomerForm } from './customers';

const form = (over: Partial<typeof EMPTY_CUSTOMER_FORM>) => ({ ...EMPTY_CUSTOMER_FORM, name: 'Ana', ...over });

describe('validateCustomerForm', () => {
  it('CPF com dígito errado é apontado; válido com ou sem máscara passa; vazio passa', () => {
    expect(validateCustomerForm(form({ document: '123.456.789-00' })).document).toMatch(/inválido/);
    expect(validateCustomerForm(form({ document: '529.982.247-25' })).document).toBeUndefined();
    expect(validateCustomerForm(form({ document: '52998224725' })).document).toBeUndefined();
    expect(validateCustomerForm(form({ document: '' })).document).toBeUndefined();
  });

  it('documento legado que não mudou não é reavaliado', () => {
    expect(validateCustomerForm(form({ document: '999.888.777-66' }), { originalDocument: '99988877766' }).document).toBeUndefined();
  });

  it('contato preferencial precisa do contato correspondente', () => {
    expect(validateCustomerForm(form({ preferredContact: 'WHATSAPP' })).preferredContact).toMatch(/WhatsApp/);
    expect(validateCustomerForm(form({ preferredContact: 'WHATSAPP', whatsapp: '(11) 91234-5678' })).preferredContact).toBeUndefined();
    expect(validateCustomerForm(form({ preferredContact: 'EMAIL' })).preferredContact).toMatch(/e-mail/);
    expect(validateCustomerForm(form({ preferredContact: 'PHONE' })).preferredContact).toMatch(/telefone/);
    expect(validateCustomerForm(form({ preferredContact: 'IN_PERSON' })).preferredContact).toBeUndefined();
  });

  it('WhatsApp sem DDD e nascimento futuro são apontados', () => {
    expect(validateCustomerForm(form({ whatsapp: '91234' })).whatsapp).toBeDefined();
    expect(validateCustomerForm(form({ birthDate: '2999-01-01' })).birthDate).toBeDefined();
  });
});

it('customerToForm traz WhatsApp, contato preferencial e nascimento (AAAA-MM-DD)', () => {
  expect(customerToForm({ name: 'X', whatsapp: '11 9', preferredContact: 'WHATSAPP', birthDate: '1990-05-20T00:00:00.000Z' })).toMatchObject({
    whatsapp: '11 9',
    preferredContact: 'WHATSAPP',
    birthDate: '1990-05-20',
  });
});
