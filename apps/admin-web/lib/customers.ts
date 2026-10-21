import { isValidDocument } from '@ln-system/shared/utils/validation';

// Cadastro de cliente (docs/CORTEX/policies/CLIENTE.md). A API confere tudo de novo (dígito do CPF/CNPJ, duplicidade
// por dígitos, coerência do contato preferencial); aqui a checagem só evita a ida e volta e aponta o campo certo.

export type ContactChannel = 'PHONE' | 'WHATSAPP' | 'EMAIL' | 'SMS' | 'IN_PERSON';

export const CONTACT_CHANNEL_LABEL: Record<ContactChannel, string> = {
  WHATSAPP: 'WhatsApp',
  PHONE: 'Telefone',
  SMS: 'SMS',
  EMAIL: 'E-mail',
  IN_PERSON: 'Presencial',
};

export interface CustomerFormData {
  name: string;
  document: string;
  customerType: 'INDIVIDUAL' | 'BUSINESS';
  birthDate: string; // AAAA-MM-DD
  email: string;
  phone: string;
  whatsapp: string;
  preferredContact: '' | ContactChannel;
  address: string;
  city: string;
  state: string;
  zipCode: string;
}

export const EMPTY_CUSTOMER_FORM: CustomerFormData = {
  name: '',
  document: '',
  customerType: 'INDIVIDUAL',
  birthDate: '',
  email: '',
  phone: '',
  whatsapp: '',
  preferredContact: '',
  address: '',
  city: '',
  state: '',
  zipCode: '',
};

const digits = (s: string) => s.replace(/\D/g, '');

export type CustomerFormErrors = Partial<Record<keyof CustomerFormData, string>>;

export function validateCustomerForm(f: CustomerFormData, opts: { originalDocument?: string | null } = {}): CustomerFormErrors {
  const errors: CustomerFormErrors = {};
  if (!f.name.trim()) errors.name = 'Informe o nome.';
  const doc = f.document.trim();
  // Documento que não mudou (mesmos dígitos) não é reavaliado: cadastro antigo continua editável.
  const unchanged = !!opts.originalDocument && digits(opts.originalDocument) === digits(doc);
  if (doc && !unchanged && !isValidDocument(doc)) errors.document = 'CPF/CNPJ inválido: confira os dígitos.';
  if (f.whatsapp.trim()) {
    const d = digits(f.whatsapp);
    if (d.length < 10 || d.length > 13) errors.whatsapp = 'Informe DDD + número.';
  }
  if (f.birthDate) {
    const d = new Date(`${f.birthDate}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() || d.getUTCFullYear() < 1900) errors.birthDate = 'Data de nascimento inválida.';
  }
  switch (f.preferredContact) {
    case 'WHATSAPP':
      if (!f.whatsapp.trim()) errors.preferredContact = 'Para preferir WhatsApp, informe o WhatsApp.';
      break;
    case 'EMAIL':
      if (!f.email.trim()) errors.preferredContact = 'Para preferir e-mail, informe o e-mail.';
      break;
    case 'PHONE':
    case 'SMS':
      if (!f.phone.trim()) errors.preferredContact = `Para preferir ${f.preferredContact === 'SMS' ? 'SMS' : 'telefone'}, informe o telefone.`;
      break;
    default:
      break;
  }
  return errors;
}

/** Cliente da API → formulário. */
export function customerToForm(c: any): CustomerFormData {
  return {
    name: c?.name ?? '',
    document: c?.document ?? '',
    customerType: c?.customerType === 'BUSINESS' ? 'BUSINESS' : 'INDIVIDUAL',
    birthDate: c?.birthDate ? String(c.birthDate).slice(0, 10) : '',
    email: c?.email ?? '',
    phone: c?.phone ?? '',
    whatsapp: c?.whatsapp ?? '',
    preferredContact: (c?.preferredContact as ContactChannel) ?? '',
    address: c?.address ?? '',
    city: c?.city ?? '',
    state: c?.state ?? '',
    zipCode: c?.zipCode ?? '',
  };
}

/** Formulário → corpo da API (vazio = não informado no cadastro; na edição a API entende como "limpar"). */
export function formToPayload(f: CustomerFormData) {
  return { ...f, name: f.name.trim() };
}
