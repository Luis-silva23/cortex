'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { CONTACT_CHANNEL_LABEL, ContactChannel, CustomerFormData, CustomerFormErrors } from '@/lib/customers';

interface Props {
  value: CustomerFormData;
  errors: CustomerFormErrors;
  onChange: (field: keyof CustomerFormData, value: string) => void;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-danger" role="alert">
      {message}
    </p>
  );
}

/**
 * Campos do cadastro de cliente (docs/CORTEX/policies/CLIENTE.md): nome, tipo, CPF/CNPJ, nascimento, contatos
 * (telefone, WhatsApp, e-mail), contato preferencial e endereço. Usado no cadastro e na edição.
 */
export function CustomerFormFields({ value, errors, onChange }: Props) {
  const individual = value.customerType === 'INDIVIDUAL';
  const input = (field: keyof CustomerFormData, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <Input
      id={`customer-${field}`}
      value={value[field]}
      onChange={(e) => onChange(field, e.target.value)}
      aria-invalid={errors[field] ? true : undefined}
      aria-describedby={errors[field] ? `customer-${field}-error` : undefined}
      {...props}
    />
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Informações Básicas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="customer-name">Nome *</Label>
            {input('name', { required: true, placeholder: 'Nome completo ou razão social' })}
            <FieldError id="customer-name-error" message={errors.name} />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="customer-customerType">Tipo</Label>
              <Select id="customer-customerType" value={value.customerType} onChange={(e) => onChange('customerType', e.target.value)}>
                <option value="INDIVIDUAL">Pessoa Física</option>
                <option value="BUSINESS">Pessoa Jurídica</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer-document">{individual ? 'CPF' : 'CNPJ'}</Label>
              {input('document', { placeholder: individual ? '000.000.000-00' : '00.000.000/0000-00', inputMode: 'numeric' })}
              <FieldError id="customer-document-error" message={errors.document} />
            </div>
            {individual && (
              <div className="space-y-2">
                <Label htmlFor="customer-birthDate">Data de nascimento</Label>
                {input('birthDate', { type: 'date' })}
                <FieldError id="customer-birthDate-error" message={errors.birthDate} />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contato</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="customer-phone">Telefone</Label>
              {input('phone', { placeholder: '(00) 0000-0000', inputMode: 'tel' })}
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer-whatsapp">WhatsApp</Label>
              {input('whatsapp', { placeholder: '(00) 00000-0000', inputMode: 'tel' })}
              <FieldError id="customer-whatsapp-error" message={errors.whatsapp} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer-email">E-mail</Label>
              {input('email', { type: 'email', placeholder: 'email@exemplo.com' })}
            </div>
          </div>
          <div className="space-y-2 md:w-1/3">
            <Label htmlFor="customer-preferredContact">Contato preferencial</Label>
            <Select
              id="customer-preferredContact"
              value={value.preferredContact}
              onChange={(e) => onChange('preferredContact', e.target.value)}
              aria-invalid={errors.preferredContact ? true : undefined}
              aria-describedby={errors.preferredContact ? 'customer-preferredContact-error' : undefined}
            >
              <option value="">Não informado</option>
              {(Object.keys(CONTACT_CHANNEL_LABEL) as ContactChannel[]).map((c) => (
                <option key={c} value={c}>
                  {CONTACT_CHANNEL_LABEL[c]}
                </option>
              ))}
            </Select>
            <FieldError id="customer-preferredContact-error" message={errors.preferredContact} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Endereço</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="customer-address">Endereço</Label>
            {input('address', { placeholder: 'Rua, número, complemento' })}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="customer-city">Cidade</Label>
              {input('city', { placeholder: 'São Paulo' })}
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer-state">Estado</Label>
              <Input id="customer-state" placeholder="SP" maxLength={2} value={value.state} onChange={(e) => onChange('state', e.target.value.toUpperCase())} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer-zipCode">CEP</Label>
              {input('zipCode', { placeholder: '00000-000', inputMode: 'numeric' })}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
