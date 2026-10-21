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
import { Plus } from 'lucide-react';
import Link from 'next/link';
import api from '@/lib/api';

interface Company {
  id: string;
  name: string;
  document: string;
  email: string;
  isActive: boolean;
  _count?: {
    users?: number;
    branches?: number;
  };
}

const emptyForm = { name: '', document: '', email: '', phone: '' };

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Bloquear/reativar o acesso de uma empresa (suspensão por inadimplência ou fim de contrato): nada é apagado, só o acesso e as sessões (decisão 158).
  const [toggleTarget, setToggleTarget] = useState<Company | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState('');

  useEffect(() => {
    loadCompanies();
  }, []);

  async function loadCompanies() {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/companies');
      setCompanies(response.data.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar empresas');
    } finally {
      setLoading(false);
    }
  }

  async function confirmToggle() {
    if (!toggleTarget) return;
    setToggling(true);
    setToggleError('');
    try {
      await api.post(`/companies/${toggleTarget.id}/toggle-active`);
      setToggleTarget(null);
      await loadCompanies();
    } catch (err: any) {
      setToggleError(err.response?.data?.error || 'Não foi possível alterar o acesso da empresa');
    } finally {
      setToggling(false);
    }
  }

  function openForm() {
    setForm(emptyForm);
    setFormError('');
    setOpen(true);
  }

  function closeForm() {
    setOpen(false);
    setFormError('');
  }

  function validate(): string | null {
    if (form.name.trim().length < 3) {
      return 'Nome deve ter no mínimo 3 caracteres.';
    }
    const digits = form.document.replace(/\D/g, '');
    if (digits.length !== 14) {
      return 'CNPJ deve ter 14 dígitos.';
    }
    if (!/^\S+@\S+\.\S+$/.test(form.email)) {
      return 'Email inválido.';
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
      await api.post('/companies', {
        name: form.name.trim(),
        document: form.document.replace(/\D/g, ''),
        email: form.email.trim(),
        phone: form.phone.trim() || undefined,
      });
      closeForm();
      await loadCompanies();
    } catch (err: any) {
      setFormError(err.response?.data?.error || 'Erro ao criar empresa');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div>Carregando...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Empresas</h1>
          <p className="text-muted-foreground">Gerencie as empresas cadastradas</p>
        </div>
        <Button onClick={openForm}>
          <Plus className="mr-2 h-4 w-4" />
          Nova Empresa
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {companies.map((company) => (
          <Card key={company.id}>
            <CardHeader>
              <CardTitle className="text-lg">{company.name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-sm">
                <span className="font-medium">CNPJ:</span> {company.document}
              </div>
              <div className="text-sm">
                <span className="font-medium">Email:</span> {company.email}
              </div>
              <div className="text-sm">
                <span className="font-medium">Usuários:</span> {company._count?.users || 0}
              </div>
              <div className="text-sm">
                <span className="font-medium">Filiais:</span> {company._count?.branches || 0}
              </div>
              <div className="text-sm">
                <span className="font-medium">Status:</span>{' '}
                <span className={company.isActive ? 'text-success' : 'text-danger'}>
                  {company.isActive ? 'Ativa' : 'Inativa'}
                </span>
              </div>
              <Link
                href={`/dashboard/companies/${company.id}/health`}
                className="inline-flex text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                Saúde da empresa e filiais
              </Link>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setToggleError('');
                    setToggleTarget(company);
                  }}
                >
                  {company.isActive ? 'Bloquear acesso' : 'Reativar acesso'}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!toggleTarget} onOpenChange={(value) => !value && setToggleTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{toggleTarget?.isActive ? 'Bloquear acesso da empresa' : 'Reativar acesso da empresa'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {toggleTarget?.isActive ? (
              <p>
                <strong>{toggleTarget?.name}</strong> deixa de conseguir entrar (Admin Web, PDV, Balcão e aplicativos) e as sessões abertas são encerradas. Nenhum dado é
                apagado e o histórico financeiro e de auditoria continua guardado. Para voltar, reative o acesso.
              </p>
            ) : (
              <p>
                <strong>{toggleTarget?.name}</strong> volta a poder entrar. Quem teve a sessão encerrada precisa entrar de novo.
              </p>
            )}
            {toggleError && <p role="alert" className="text-danger">{toggleError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToggleTarget(null)}>
              Cancelar
            </Button>
            <Button onClick={confirmToggle} disabled={toggling}>
              {toggling ? 'Salvando...' : toggleTarget?.isActive ? 'Bloquear acesso' : 'Reativar acesso'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {companies.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10">
            <p className="text-muted-foreground">Nenhuma empresa cadastrada</p>
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={(value) => (value ? setOpen(true) : closeForm())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova Empresa</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="company-name">Nome *</Label>
              <Input
                id="company-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Razão social"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="company-document">CNPJ *</Label>
              <Input
                id="company-document"
                value={form.document}
                onChange={(e) => setForm({ ...form, document: e.target.value })}
                placeholder="00000000000000"
                maxLength={18}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="company-email">Email *</Label>
              <Input
                id="company-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="contato@empresa.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="company-phone">Telefone</Label>
              <Input
                id="company-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="(00) 00000-0000"
              />
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
    </div>
  );
}
