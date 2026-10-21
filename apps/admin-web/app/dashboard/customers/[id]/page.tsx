'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, Save } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CustomerFormFields } from '@/components/customers/CustomerFormFields';
import { api, getCurrentUserClaims } from '@/lib/api';
import { isManagerOrAbove, MANAGER_ONLY_NOTICE } from '@/lib/role-gates';
import { getApiErrorMessage } from '@/lib/errors';
import { CustomerFormData, CustomerFormErrors, customerToForm, EMPTY_CUSTOMER_FORM, formToPayload, validateCustomerForm } from '@/lib/customers';

// Edição de cliente (docs/CORTEX/policies/CLIENTE.md). Mesmos campos do cadastro (CustomerFormFields), com WhatsApp,
// contato preferencial e nascimento. Na edição, campo vazio LIMPA o valor na API. O documento só é reavaliado se os
// dígitos mudarem: cadastro antigo com documento fora do padrão continua editável.

type LoadState = 'loading' | 'ready' | 'not-found' | 'error';

export default function EditCustomerPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [formData, setFormData] = useState<CustomerFormData>(EMPTY_CUSTOMER_FORM);
  const [originalDocument, setOriginalDocument] = useState<string | null>(null);
  const [errors, setErrors] = useState<CustomerFormErrors>({});
  // PUT /customers/:id só aceita SUPER_ADMIN/COMPANY_ADMIN/MANAGER (403 para os
  // demais). Quem chega aqui por link direto vê os dados, mas só para leitura.
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    setCanEdit(isManagerOrAbove(getCurrentUserClaims()?.userType));
  }, []);

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      const customer = await api.getCustomer(params.id);
      setFormData(customerToForm(customer));
      setOriginalDocument(customer.document ?? null);
      setIsActive(customer.isActive !== false);
      setLoadState('ready');
    } catch (err: any) {
      console.error('Erro ao carregar cliente:', err);
      if (err?.response?.status === 404) {
        setLoadState('not-found');
      } else {
        setLoadError(getApiErrorMessage(err, 'Não foi possível carregar o cliente.'));
        setLoadState('error');
      }
    }
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleChange = (field: keyof CustomerFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;
    setSaveError(null);
    const found = validateCustomerForm(formData, { originalDocument });
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    setSaving(true);
    try {
      await api.updateCustomer(params.id, formToPayload(formData));
      router.push('/dashboard/customers');
    } catch (err) {
      console.error('Erro ao atualizar cliente:', err);
      setSaveError(getApiErrorMessage(err, 'Erro ao atualizar cliente'));
    } finally {
      setSaving(false);
    }
  };

  // DELETE é soft delete; antes não havia caminho de volta (o PUT descartava
  // `isActive`). Reativar mantém o mesmo cadastro, documento e histórico.
  const [reactivating, setReactivating] = useState(false);
  const handleReactivate = async () => {
    if (!canEdit) return;
    setReactivating(true);
    setSaveError(null);
    try {
      await api.updateCustomer(params.id, { isActive: true });
      setIsActive(true);
    } catch (err) {
      console.error('Erro ao reativar cliente:', err);
      setSaveError(getApiErrorMessage(err, 'Erro ao reativar cliente'));
    } finally {
      setReactivating(false);
    }
  };

  if (loadState === 'loading') {
    return <div className="p-12 text-center text-muted-foreground">Carregando cliente...</div>;
  }

  if (loadState === 'not-found' || loadState === 'error') {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-danger" aria-hidden />
          <h2 className="mb-2 text-lg font-medium text-foreground">
            {loadState === 'not-found' ? 'Cliente não encontrado' : 'Não foi possível carregar o cliente'}
          </h2>
          <p className="mb-4 text-muted-foreground">
            {loadState === 'not-found' ? 'Ele não existe ou pertence a outra empresa.' : loadError ?? 'Verifique a conexão e tente novamente.'}
          </p>
          <div className="flex justify-center gap-2">
            {loadState === 'error' && (
              <Button variant="outline" onClick={load}>
                Tentar novamente
              </Button>
            )}
            <Link href="/dashboard/customers">
              <Button variant="outline">Voltar para clientes</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard/customers">
          <Button variant="ghost" size="icon" aria-label="Voltar para clientes">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-foreground">{canEdit ? 'Editar Cliente' : 'Cliente'}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground">{formData.name}</p>
            {!isActive && <Badge variant="secondary">Inativo</Badge>}
            {!isActive && canEdit && (
              <Button type="button" size="sm" variant="outline" onClick={handleReactivate} disabled={reactivating}>
                {reactivating ? 'Reativando...' : 'Reativar cliente'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {!canEdit && (
        <Alert variant="warning">
          <AlertDescription>{MANAGER_ONLY_NOTICE}</AlertDescription>
        </Alert>
      )}

      {saveError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden />
          <AlertTitle>Não foi possível salvar</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleSubmit} noValidate>
        {/* fieldset disabled trava todos os campos de uma vez: somente leitura
            para quem não pode editar e sem edição enquanto o PUT está em voo. */}
        <fieldset disabled={!canEdit || saving} className="min-w-0">
          <CustomerFormFields value={formData} errors={errors} onChange={handleChange} />
        </fieldset>

        <div className="mt-6 flex justify-end gap-2">
          <Link href="/dashboard/customers">
            <Button type="button" variant="outline">
              {canEdit ? 'Cancelar' : 'Voltar'}
            </Button>
          </Link>
          {canEdit && (
            <Button type="submit" disabled={saving}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? 'Salvando...' : 'Salvar Cliente'}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
