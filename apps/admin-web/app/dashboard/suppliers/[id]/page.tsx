'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, Save } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, getCurrentUserClaims } from '@/lib/api';
import { buildSupplierUpdatePayload, SupplierFormFields } from '@/lib/cadastros';
import { getApiErrorMessage } from '@/lib/errors';
import { isManagerOrAbove, MANAGER_ONLY_NOTICE } from '@/lib/role-gates';

// O botão "Editar" da lista de fornecedores apontava para esta rota, que não
// existia (404). Mesmos campos e validações de suppliers/new/page.tsx.
const EMPTY_FORM: SupplierFormFields = {
  name: '',
  document: '',
  email: '',
  phone: '',
  address: '',
  city: '',
  state: '',
  zipCode: '',
};

type LoadState = 'loading' | 'ready' | 'not-found' | 'error';

export default function EditSupplierPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);
  // E-mail que já estava cadastrado: ver a checagem em handleSubmit.
  const [originalEmail, setOriginalEmail] = useState('');
  const [formData, setFormData] = useState<SupplierFormFields>(EMPTY_FORM);
  // Toda escrita em /suppliers exige SUPER_ADMIN/COMPANY_ADMIN/MANAGER (403 para
  // os demais). Quem chega por link direto vê os dados, mas só para leitura.
  const [canEdit, setCanEdit] = useState(false);

  useEffect(() => {
    setCanEdit(isManagerOrAbove(getCurrentUserClaims()?.userType));
  }, []);

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      const supplier = await api.getSupplier(params.id);
      setFormData({
        name: supplier.name ?? '',
        document: supplier.document ?? '',
        email: supplier.email ?? '',
        phone: supplier.phone ?? '',
        address: supplier.address ?? '',
        city: supplier.city ?? '',
        state: supplier.state ?? '',
        zipCode: supplier.zipCode ?? '',
      });
      setOriginalEmail(supplier.email ?? '');
      setIsActive(supplier.isActive !== false);
      setLoadState('ready');
    } catch (err: any) {
      console.error('Erro ao carregar fornecedor:', err);
      if (err?.response?.status === 404) {
        setLoadState('not-found');
      } else {
        setLoadError(getApiErrorMessage(err, 'Não foi possível carregar o fornecedor.'));
        setLoadState('error');
      }
    }
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  const handleChange = (field: keyof SupplierFormFields, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;
    setSaveError(null);

    // O PUT valida `email` com `.email()`, que reprova string vazia, e omitir o
    // campo significa "não mexer". Sem este aviso, esvaziar o e-mail de um
    // fornecedor salvaria "com sucesso" e o e-mail antigo voltaria na lista.
    if (originalEmail && formData.email.trim() === '') {
      setSaveError(
        'Não é possível remover o e-mail de um fornecedor já cadastrado. Informe outro e-mail ou mantenha o atual.'
      );
      return;
    }

    setSaving(true);
    try {
      await api.updateSupplier(params.id, buildSupplierUpdatePayload(formData));
      router.push('/dashboard/suppliers');
    } catch (err) {
      console.error('Erro ao atualizar fornecedor:', err);
      setSaveError(getApiErrorMessage(err, 'Erro ao atualizar fornecedor'));
    } finally {
      setSaving(false);
    }
  };

  if (loadState === 'loading') {
    return <div className="p-12 text-center text-muted-foreground">Carregando fornecedor...</div>;
  }

  if (loadState === 'not-found' || loadState === 'error') {
    return (
      <Card>
        <CardContent className="p-12 text-center">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-danger" aria-hidden />
          <h2 className="mb-2 text-lg font-medium text-foreground">
            {loadState === 'not-found'
              ? 'Fornecedor não encontrado'
              : 'Não foi possível carregar o fornecedor'}
          </h2>
          <p className="mb-4 text-muted-foreground">
            {loadState === 'not-found'
              ? 'Ele não existe ou pertence a outra empresa.'
              : loadError ?? 'Verifique a conexão e tente novamente.'}
          </p>
          <div className="flex justify-center gap-2">
            {loadState === 'error' && (
              <Button variant="outline" onClick={load}>
                Tentar novamente
              </Button>
            )}
            <Link href="/dashboard/suppliers">
              <Button variant="outline">Voltar para fornecedores</Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard/suppliers">
          <Button variant="ghost" size="icon" aria-label="Voltar para fornecedores">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            {canEdit ? 'Editar Fornecedor' : 'Fornecedor'}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground">{formData.name}</p>
            {!isActive && <Badge variant="secondary">Inativo</Badge>}
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

      <form onSubmit={handleSubmit}>
        {/* fieldset disabled trava todos os campos de uma vez: somente leitura
            para quem não pode editar e sem edição enquanto o PUT está em voo. */}
        <fieldset disabled={!canEdit || saving} className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Informações Básicas</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="supplier-name">Nome/Razão Social *</Label>
                <Input
                  id="supplier-name"
                  required
                  placeholder="Nome do fornecedor"
                  value={formData.name}
                  onChange={(e) => handleChange('name', e.target.value)}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="supplier-document">CPF/CNPJ *</Label>
                  <Input
                    id="supplier-document"
                    required
                    placeholder="00.000.000/0000-00"
                    value={formData.document}
                    onChange={(e) => handleChange('document', e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="supplier-email">Email</Label>
                  <Input
                    id="supplier-email"
                    type="email"
                    placeholder="email@example.com"
                    value={formData.email}
                    onChange={(e) => handleChange('email', e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="supplier-phone">Telefone</Label>
                <Input
                  id="supplier-phone"
                  placeholder="(00) 00000-0000"
                  value={formData.phone}
                  onChange={(e) => handleChange('phone', e.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Endereço</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="supplier-address">Endereço</Label>
                <Input
                  id="supplier-address"
                  placeholder="Rua, número, complemento"
                  value={formData.address}
                  onChange={(e) => handleChange('address', e.target.value)}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="supplier-city">Cidade</Label>
                  <Input
                    id="supplier-city"
                    placeholder="São Paulo"
                    value={formData.city}
                    onChange={(e) => handleChange('city', e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="supplier-state">Estado</Label>
                  <Input
                    id="supplier-state"
                    placeholder="SP"
                    maxLength={2}
                    value={formData.state}
                    onChange={(e) => handleChange('state', e.target.value.toUpperCase())}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="supplier-zip">CEP</Label>
                  <Input
                    id="supplier-zip"
                    placeholder="00000-000"
                    value={formData.zipCode}
                    onChange={(e) => handleChange('zipCode', e.target.value)}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </fieldset>

        <div className="mt-6 flex justify-end gap-2">
          <Link href="/dashboard/suppliers">
            <Button type="button" variant="outline">
              {canEdit ? 'Cancelar' : 'Voltar'}
            </Button>
          </Link>
          {canEdit && (
            <Button type="submit" disabled={saving}>
              <Save className="w-4 h-4 mr-2" />
              {saving ? 'Salvando...' : 'Salvar Fornecedor'}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
