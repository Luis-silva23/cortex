/**
 * ACHADO DE AUDITORIA (reproduzido por HTTP real antes desta correção):
 * - PDV cadastrando cliente de balcão SEM e-mail -> `email: ''` reprovava em
 *   `.email()` (400 "Invalid email") — o caso comum falhava;
 * - dois clientes sem documento -> `document: ''` colidia na unique
 *   [companyId, document], vazando erro cru do Prisma;
 * - Admin Web enviava document/tipo/endereço que o schema descartava.
 * Este teste usa o schema REAL (não mockado) com os payloads exatos dos dois
 * formulários.
 */
import { customerSchema, updateCustomerSchema } from '@ln-system/shared/src/validators/pdv.validators';

describe('customerSchema — campos opcionais em branco viram "não informado"', () => {
  it('payload exato do PDV (document/phone/email vazios) é aceito e os vazios somem', () => {
    const parsed = customerSchema.parse({ companyId: 'c1', name: 'Balcão A', document: '', phone: '', email: '' });

    expect(parsed.name).toBe('Balcão A');
    expect(parsed.email).toBeUndefined();
    expect(parsed.document).toBeUndefined();
    expect(parsed.phone).toBeUndefined();
  });

  it('só espaços também conta como não informado, e os campos preenchidos são aparados', () => {
    const parsed = customerSchema.parse({ companyId: 'c1', name: '  Ana  ', document: '   ', phone: ' 11 99999-0000 ' });

    expect(parsed.name).toBe('Ana');
    expect(parsed.document).toBeUndefined();
    expect(parsed.phone).toBe('11 99999-0000');
  });

  it('e-mail preenchido continua sendo validado', () => {
    expect(() => customerSchema.parse({ companyId: 'c1', name: 'Ana', email: 'nao-e-email' })).toThrow();
    expect(customerSchema.parse({ companyId: 'c1', name: 'Ana', email: 'ana@test.local' }).email).toBe('ana@test.local');
  });

  it('nome continua obrigatório (vazio ou só espaços reprova)', () => {
    expect(() => customerSchema.parse({ companyId: 'c1', name: '' })).toThrow();
    expect(() => customerSchema.parse({ companyId: 'c1', name: '   ' })).toThrow();
  });

  it('aceita os campos do model Customer que o Admin Web enviava (documento, tipo, endereço)', () => {
    const parsed = customerSchema.parse({
      companyId: 'c1',
      name: 'Oficina X',
      document: '12.345.678/0001-90',
      customerType: 'BUSINESS',
      address: 'Rua X, 10',
      city: 'São Paulo',
      state: 'SP',
      zipCode: '01000-000',
    });

    expect(parsed).toMatchObject({
      document: '12.345.678/0001-90',
      customerType: 'BUSINESS',
      address: 'Rua X, 10',
      city: 'São Paulo',
      state: 'SP',
      zipCode: '01000-000',
    });
  });

  it('rejeita tipo que não existe no enum do banco (o antigo option "COMPANY" nunca foi válido)', () => {
    expect(() => customerSchema.parse({ companyId: 'c1', name: 'X', customerType: 'COMPANY' })).toThrow();
  });
});

describe('customerSchema — WhatsApp, contato preferencial e nascimento (2026-09-27)', () => {
  it('aceita WhatsApp com DDD, contato preferencial do enum e data de nascimento', () => {
    const parsed = customerSchema.parse({ companyId: 'c1', name: 'Ana', whatsapp: '(11) 91234-5678', preferredContact: 'WHATSAPP', birthDate: '1990-05-20' });
    expect(parsed.whatsapp).toBe('(11) 91234-5678');
    expect(parsed.preferredContact).toBe('WHATSAPP');
    expect(parsed.birthDate?.toISOString().slice(0, 10)).toBe('1990-05-20');
  });

  it('vazios somem (PDV manda campos em branco)', () => {
    const parsed = customerSchema.parse({ companyId: 'c1', name: 'Ana', whatsapp: '', preferredContact: '', birthDate: '' });
    expect(parsed.whatsapp).toBeUndefined();
    expect(parsed.preferredContact).toBeUndefined();
    expect(parsed.birthDate).toBeUndefined();
  });

  it('recusa WhatsApp sem DDD, canal inexistente e nascimento no futuro', () => {
    expect(() => customerSchema.parse({ companyId: 'c1', name: 'Ana', whatsapp: '91234' })).toThrow(/WhatsApp inválido/);
    expect(() => customerSchema.parse({ companyId: 'c1', name: 'Ana', preferredContact: 'TELEGRAM' })).toThrow(/Contato preferencial inválido/);
    expect(() => customerSchema.parse({ companyId: 'c1', name: 'Ana', birthDate: '2999-01-01' })).toThrow(/Data de nascimento inválida/);
  });

  it('na edição, vazio LIMPA WhatsApp/contato preferencial/nascimento (null)', () => {
    const parsed = updateCustomerSchema.parse({ whatsapp: '', preferredContact: '', birthDate: '' });
    expect(parsed.whatsapp).toBeNull();
    expect(parsed.preferredContact).toBeNull();
    expect(parsed.birthDate).toBeNull();
  });
});

describe('updateCustomerSchema — mesma normalização, sem exigir campos', () => {
  // Na EDIÇÃO, campo em branco significa LIMPAR (null). Antes virava undefined e
  // o Prisma ignorava a chave: esvaziar telefone/e-mail no formulário "salvava
  // com sucesso" e o valor antigo continuava. O único chamador do PUT é o
  // formulário de edição do admin-web, que já carrega os valores atuais.
  // (Detalhes em update-schemas.test.ts.)
  it('campos em branco não reprovam e LIMPAM o valor gravado (null)', () => {
    const parsed = updateCustomerSchema.parse({ email: '', phone: '' });

    expect(parsed.email).toBeNull();
    expect(parsed.phone).toBeNull();
  });

  it('não aceita companyId vindo do corpo (continua omitido)', () => {
    const parsed = updateCustomerSchema.parse({ name: 'Novo', companyId: 'outra-empresa' } as any);

    expect((parsed as any).companyId).toBeUndefined();
  });
});
