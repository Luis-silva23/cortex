'use client';

import { useCallback, useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { getApiErrorMessage } from '@/lib/errors';
import { isCompanyAdminOrAbove } from '@/lib/role-gates';
import { useUserType } from '@/lib/hooks/useUserType';
import { CompanyProfile, companyProfileApi } from '@/lib/api/policies';

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const TAX_REGIMES: Array<{ value: string; label: string }> = [
  { value: 'SIMPLES_NACIONAL', label: 'Simples Nacional' },
  { value: 'SIMPLES_NACIONAL_EXCESSO', label: 'Simples Nacional — excesso de sublimite' },
  { value: 'REGIME_NORMAL', label: 'Regime normal (Lucro Presumido/Real)' },
  { value: 'MEI', label: 'MEI' },
];

type Form = Record<keyof Omit<CompanyProfile, 'id'>, string>;

const toForm = (p: CompanyProfile): Form => ({
  name: p.name ?? '',
  legalName: p.legalName ?? '',
  document: p.document ?? '',
  stateRegistration: p.stateRegistration ?? '',
  municipalRegistration: p.municipalRegistration ?? '',
  taxRegime: p.taxRegime ?? '',
  email: p.email ?? '',
  phone: p.phone ?? '',
  whatsapp: p.whatsapp ?? '',
  contactName: p.contactName ?? '',
  zipCode: p.zipCode ?? '',
  street: p.street ?? '',
  number: p.number ?? '',
  complement: p.complement ?? '',
  district: p.district ?? '',
  city: p.city ?? '',
  state: p.state ?? '',
});

const formatDocument = (d: string) => {
  const digits = d.replace(/\D/g, '');
  if (digits.length === 14) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (digits.length === 11) return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d;
};

// Configurações → Empresa: cadastro real (antes esta aba era ilustrativa). CNPJ/CPF só o Super Admin altera.
export function CompanyProfileSettings() {
  const { userType, ready } = useUserType();
  const canEdit = isCompanyAdminOrAbove(userType);
  // Mesmo corte da API (GET /company-profile é de gerência+): os demais papéis nem pedem.
  const canRead = canEdit || userType === 'MANAGER';
  const isSuperAdmin = userType === 'SUPER_ADMIN';
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setForm(toForm(await companyProfileApi.get()));
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível carregar os dados da empresa.'));
    }
  }, []);

  useEffect(() => {
    if (ready && canRead) load();
  }, [ready, canRead, load]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const { document, ...rest } = form;
      const body: Record<string, unknown> = { ...rest, taxRegime: rest.taxRegime || null };
      if (isSuperAdmin) body.document = document;
      const res = await companyProfileApi.update(body as Partial<CompanyProfile>);
      setForm(toForm(res.profile));
      setMessage(res.changed.length ? 'Dados da empresa salvos.' : 'Nada mudou.');
    } catch (err) {
      setError(getApiErrorMessage(err, 'Não foi possível salvar.'));
    } finally {
      setSaving(false);
    }
  };

  const field = (id: keyof Form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="space-y-2">
      <Label htmlFor={`company-${id}`}>{label}</Label>
      <Input id={`company-${id}`} value={form?.[id] ?? ''} onChange={set(id)} disabled={!canEdit || saving} {...props} />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Dados da Empresa</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {ready && !canRead && (
          <p className="text-sm text-muted-foreground">Os dados cadastrais da empresa são consultados pela gerência e pela administração.</p>
        )}
        {canRead && !canEdit && <p className="text-xs text-muted-foreground">Somente leitura: só o administrador da empresa altera.</p>}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-foreground">
            {message}
          </p>
        )}
        {canRead && !form && !error && <p className="text-sm text-muted-foreground">Carregando…</p>}
        {form && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {field('legalName', 'Razão social')}
              {field('name', 'Nome fantasia')}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="company-document">CNPJ/CPF</Label>
                <Input
                  id="company-document"
                  value={isSuperAdmin ? form.document : formatDocument(form.document)}
                  onChange={set('document')}
                  disabled={!isSuperAdmin || saving}
                />
                {!isSuperAdmin && <p className="text-xs text-muted-foreground">Identifica a licença: só o Super Admin altera.</p>}
              </div>
              {field('stateRegistration', 'Inscrição estadual')}
              {field('municipalRegistration', 'Inscrição municipal')}
            </div>
            <div className="space-y-2">
              <Label htmlFor="company-taxRegime">Regime tributário</Label>
              <Select id="company-taxRegime" value={form.taxRegime} onChange={set('taxRegime')} disabled={!canEdit || saving}>
                <option value="">Não informado</option>
                {TAX_REGIMES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {field('email', 'E-mail', { type: 'email' })}
              {field('contactName', 'Responsável / contato')}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {field('phone', 'Telefone', { inputMode: 'tel' })}
              {field('whatsapp', 'WhatsApp', { inputMode: 'tel' })}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              {field('zipCode', 'CEP', { inputMode: 'numeric', placeholder: '00000-000' })}
              <div className="sm:col-span-2">{field('street', 'Logradouro')}</div>
              {field('number', 'Número')}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              {field('complement', 'Complemento')}
              {field('district', 'Bairro')}
              {field('city', 'Cidade')}
              <div className="space-y-2">
                <Label htmlFor="company-state">UF</Label>
                <Select id="company-state" value={form.state} onChange={set('state')} disabled={!canEdit || saving}>
                  <option value="">Selecione</option>
                  {UFS.map((uf) => (
                    <option key={uf} value={uf}>
                      {uf}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            {canEdit && (
              <div className="flex justify-end">
                <Button onClick={save} disabled={saving}>
                  <Save className="mr-2 h-4 w-4" />
                  {saving ? 'Salvando…' : 'Salvar'}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
