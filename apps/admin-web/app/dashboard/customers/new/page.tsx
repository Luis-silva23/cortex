'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Save, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { CustomerFormFields } from '@/components/customers/CustomerFormFields';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { CustomerFormData, CustomerFormErrors, EMPTY_CUSTOMER_FORM, formToPayload, validateCustomerForm } from '@/lib/customers';

// Cadastro de cliente (docs/CORTEX/policies/CLIENTE.md). Os nomes dos campos seguem a API (`document`/`customerType`,
// WhatsApp e contato preferencial). A API confere de novo o dígito do CPF/CNPJ, a duplicidade por dígitos e a coerência
// do contato preferencial — a checagem aqui só aponta o campo antes do envio.
export default function NewCustomerPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<CustomerFormData>(EMPTY_CUSTOMER_FORM);
  const [errors, setErrors] = useState<CustomerFormErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleChange = (field: keyof CustomerFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    const found = validateCustomerForm(formData);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    setSaving(true);
    try {
      await api.createCustomer(formToPayload(formData));
      router.push('/dashboard/customers');
    } catch (error) {
      console.error('Erro ao criar cliente:', error);
      setSaveError(getApiErrorMessage(error, 'Erro ao criar cliente'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard/customers">
          <Button variant="ghost" size="icon" aria-label="Voltar para clientes">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-foreground">Novo Cliente</h1>
          <p className="mt-1 text-muted-foreground">Cadastre um novo cliente</p>
        </div>
      </div>

      {saveError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden />
          <AlertTitle>Não foi possível salvar</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <fieldset disabled={saving} className="min-w-0">
          <CustomerFormFields value={formData} errors={errors} onChange={handleChange} />
        </fieldset>
        <div className="mt-6 flex justify-end gap-2">
          <Link href="/dashboard/customers">
            <Button type="button" variant="outline">
              Cancelar
            </Button>
          </Link>
          <Button type="submit" disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? 'Salvando...' : 'Salvar Cliente'}
          </Button>
        </div>
      </form>
    </div>
  );
}
