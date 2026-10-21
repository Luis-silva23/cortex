'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Plus, Check, X } from 'lucide-react';
import api from '@/lib/api';

interface License {
  id: string;
  status: string;
  licenseType: string;
  maxDevices: number;
  maxUsers: number;
  maxBranches: number;
  company?: {
    name: string;
    document: string;
  };
  _count?: {
    devices?: number;
  };
}

interface Company {
  id: string;
  name: string;
}

const statusColors: Record<string, string> = {
  PENDING_APPROVAL: 'bg-warning-soft text-warning',
  ACTIVE: 'bg-success-soft text-success',
  SUSPENDED: 'bg-danger-soft text-danger',
  EXPIRED: 'bg-muted text-muted-foreground',
  CANCELLED: 'bg-muted text-muted-foreground',
};

const statusLabels: Record<string, string> = {
  PENDING_APPROVAL: 'Pendente',
  ACTIVE: 'Ativa',
  SUSPENDED: 'Suspensa',
  EXPIRED: 'Expirada',
  CANCELLED: 'Cancelada',
};

const licenseTypeOptions = [
  { value: 'TRIAL', label: 'Trial' },
  { value: 'BASIC', label: 'Básica' },
  { value: 'PROFESSIONAL', label: 'Profissional' },
  { value: 'ENTERPRISE', label: 'Enterprise' },
];

const emptyForm = {
  companyId: '',
  licenseType: 'BASIC',
  maxDevices: '1',
  maxUsers: '1',
  maxBranches: '1',
};

export default function LicensesPage() {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  useEffect(() => {
    loadLicenses();
  }, []);

  async function loadLicenses() {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/licenses');
      setLicenses(response.data.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar licenças');
    } finally {
      setLoading(false);
    }
  }

  async function loadCompanies() {
    try {
      const response = await api.get('/companies');
      setCompanies(response.data.data);
    } catch (err) {
      console.error('Error loading companies:', err);
    }
  }

  async function approveLicense(licenseId: string) {
    setApprovingId(licenseId);
    setError('');
    try {
      const startDate = new Date().toISOString();
      const expiryDate = new Date();
      expiryDate.setFullYear(expiryDate.getFullYear() + 1);

      await api.post(`/licenses/${licenseId}/approve`, {
        startDate,
        expiryDate: expiryDate.toISOString(),
      });

      await loadLicenses();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao aprovar licença');
    } finally {
      setApprovingId(null);
    }
  }

  function openForm() {
    setForm(emptyForm);
    setFormError('');
    setOpen(true);
    loadCompanies();
  }

  function closeForm() {
    setOpen(false);
    setFormError('');
  }

  function validate(): string | null {
    if (!form.companyId) {
      return 'Selecione a empresa.';
    }
    const maxDevices = Number(form.maxDevices);
    const maxUsers = Number(form.maxUsers);
    const maxBranches = Number(form.maxBranches);
    if (!Number.isInteger(maxDevices) || maxDevices < 1) {
      return 'Máximo de dispositivos deve ser um número inteiro positivo.';
    }
    if (!Number.isInteger(maxUsers) || maxUsers < 1) {
      return 'Máximo de usuários deve ser um número inteiro positivo.';
    }
    if (!Number.isInteger(maxBranches) || maxBranches < 1) {
      return 'Máximo de filiais deve ser um número inteiro positivo.';
    }
    return null;
  }

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    setSubmitting(true);
    setFormError('');
    try {
      await api.post('/licenses', {
        companyId: form.companyId,
        licenseType: form.licenseType,
        maxDevices: Number(form.maxDevices),
        maxUsers: Number(form.maxUsers),
        maxBranches: Number(form.maxBranches),
      });
      closeForm();
      await loadLicenses();
    } catch (err: any) {
      setFormError(err.response?.data?.error || 'Erro ao criar licença');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject() {
    if (!rejectId) return;
    setRejecting(true);
    setError('');
    try {
      await api.post(`/licenses/${rejectId}/cancel`);
      setRejectId(null);
      await loadLicenses();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao rejeitar licença');
    } finally {
      setRejecting(false);
    }
  }

  if (loading) {
    return <div>Carregando...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Licenças</h1>
          <p className="text-muted-foreground">Gerencie as licenças do sistema</p>
        </div>
        <Button onClick={openForm}>
          <Plus className="mr-2 h-4 w-4" />
          Nova Licença
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {licenses.map((license) => (
          <Card key={license.id}>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-lg">{license.company?.name}</CardTitle>
                  <p className="text-sm text-muted-foreground">{license.company?.document}</p>
                </div>
                <span
                  className={`rounded-full px-2 py-1 text-xs font-medium ${
                    statusColors[license.status]
                  }`}
                >
                  {statusLabels[license.status]}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-4">
                <div>
                  <p className="text-sm font-medium">Tipo</p>
                  <p className="text-sm text-muted-foreground">{license.licenseType}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Dispositivos</p>
                  <p className="text-sm text-muted-foreground">
                    {license._count?.devices || 0} / {license.maxDevices}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium">Usuários</p>
                  <p className="text-sm text-muted-foreground">Max: {license.maxUsers}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Filiais</p>
                  <p className="text-sm text-muted-foreground">Max: {license.maxBranches}</p>
                </div>
              </div>

              {license.status === 'PENDING_APPROVAL' && (
                <div className="mt-4 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => approveLicense(license.id)}
                    disabled={approvingId === license.id}
                  >
                    <Check className="mr-2 h-4 w-4" />
                    {approvingId === license.id ? 'Aprovando...' : 'Aprovar'}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setRejectId(license.id)}>
                    <X className="mr-2 h-4 w-4" />
                    Rejeitar
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {licenses.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10">
            <p className="text-muted-foreground">Nenhuma licença cadastrada</p>
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={(value) => (value ? setOpen(true) : closeForm())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova Licença</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="license-company">Empresa *</Label>
              <Select
                id="license-company"
                value={form.companyId}
                onChange={(e) => setForm({ ...form, companyId: e.target.value })}
              >
                <option value="">Selecione uma empresa</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="license-type">Tipo de licença *</Label>
              <Select
                id="license-type"
                value={form.licenseType}
                onChange={(e) => setForm({ ...form, licenseType: e.target.value })}
              >
                {licenseTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="license-devices">Máx. dispositivos *</Label>
                <Input
                  id="license-devices"
                  type="number"
                  min={1}
                  value={form.maxDevices}
                  onChange={(e) => setForm({ ...form, maxDevices: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="license-users">Máx. usuários *</Label>
                <Input
                  id="license-users"
                  type="number"
                  min={1}
                  value={form.maxUsers}
                  onChange={(e) => setForm({ ...form, maxUsers: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="license-branches">Máx. filiais *</Label>
                <Input
                  id="license-branches"
                  type="number"
                  min={1}
                  value={form.maxBranches}
                  onChange={(e) => setForm({ ...form, maxBranches: e.target.value })}
                />
              </div>
            </div>
          </div>

          {formError && <p className="text-sm text-danger">{formError}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={closeForm} disabled={submitting}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Salvando...' : 'Salvar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectId !== null} onOpenChange={(value) => !value && setRejectId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rejeitar licença</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Tem certeza que deseja rejeitar (cancelar) esta licença? Esta ação não pode ser
            desfeita.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectId(null)} disabled={rejecting}>
              Voltar
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={rejecting}>
              {rejecting ? 'Rejeitando...' : 'Confirmar rejeição'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
