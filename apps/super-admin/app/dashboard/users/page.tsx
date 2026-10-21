'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
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
import { Pagination } from '@/components/ui/pagination';
import { Plus } from 'lucide-react';
import api from '@/lib/api';

interface User {
  id: string;
  numericId: number;
  name: string;
  email: string;
  userType: string;
  isActive: boolean;
  company?: {
    name: string;
  };
}

interface Company {
  id: string;
  name: string;
}

const userTypeOptions = [
  { value: 'SUPER_ADMIN', label: 'Super Admin' },
  { value: 'COMPANY_ADMIN', label: 'Admin da Empresa' },
  { value: 'MANAGER', label: 'Gerente' },
  { value: 'OPERATOR', label: 'Operador' },
  { value: 'VIEWER', label: 'Visualizador' },
];

const emptyForm = {
  name: '',
  email: '',
  password: '',
  userType: 'OPERATOR',
  companyId: '',
};

const PAGE_SIZE = 20;
const DEFAULT_PAGINATION = { page: 1, limit: PAGE_SIZE, total: 0, pages: 1 };

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [pagination, setPagination] = useState(DEFAULT_PAGINATION);
  const [page, setPage] = useState(1);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadUsers(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  async function loadUsers(pageToLoad = page) {
    setLoading(true);
    setError('');
    try {
      // /users é paginado (20 por página); antes a tela ignorava `pagination` e só mostrava a 1ª página
      // (20 de 37 usuários), sem nenhum aviso.
      const response = await api.get('/users', { params: { page: pageToLoad, limit: PAGE_SIZE } });
      setUsers(response.data.data);
      setPagination(
        response.data.pagination || { ...DEFAULT_PAGINATION, page: pageToLoad, total: response.data.data.length }
      );
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar usuários');
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
    if (form.name.trim().length < 3) {
      return 'Nome deve ter no mínimo 3 caracteres.';
    }
    if (!/^\S+@\S+\.\S+$/.test(form.email)) {
      return 'Email inválido.';
    }
    if (form.password.length < 8) {
      return 'Senha deve ter no mínimo 8 caracteres.';
    }
    if (form.userType !== 'SUPER_ADMIN' && !form.companyId) {
      return 'Selecione a empresa.';
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
      await api.post('/users', {
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        userType: form.userType,
        companyId: form.userType === 'SUPER_ADMIN' ? undefined : form.companyId,
      });
      closeForm();
      await loadUsers();
    } catch (err: any) {
      setFormError(err.response?.data?.error || 'Erro ao criar usuário');
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
          <h1 className="text-3xl font-bold">Usuários</h1>
          <p className="text-muted-foreground">Gerencie os usuários do sistema</p>
        </div>
        <Button onClick={openForm}>
          <Plus className="mr-2 h-4 w-4" />
          Novo Usuário
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium">ID</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Nome</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Email</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Tipo</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Empresa</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-b last:border-0">
                    <td className="px-4 py-3 text-sm">{user.numericId}</td>
                    <td className="px-4 py-3 text-sm font-medium">{user.name}</td>
                    <td className="px-4 py-3 text-sm">{user.email}</td>
                    <td className="px-4 py-3 text-sm">{user.userType}</td>
                    <td className="px-4 py-3 text-sm">{user.company?.name || '-'}</td>
                    <td className="px-4 py-3 text-sm">
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-medium ${
                          user.isActive
                            ? 'bg-success-soft text-success'
                            : 'bg-danger-soft text-danger'
                        }`}
                      >
                        {user.isActive ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
        <Pagination
          page={pagination.page}
          pages={pagination.pages}
          total={pagination.total}
          itemCount={users.length}
          onPageChange={setPage}
          itemLabel="usuários"
        />
      </Card>

      {users.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10">
            <p className="text-muted-foreground">Nenhum usuário cadastrado</p>
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={(value) => (value ? setOpen(true) : closeForm())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo Usuário</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="user-name">Nome *</Label>
              <Input
                id="user-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Nome completo"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-email">Email *</Label>
              <Input
                id="user-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="usuario@empresa.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-password">Senha *</Label>
              <Input
                id="user-password"
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder="Mínimo 8 caracteres"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-type">Tipo *</Label>
              <Select
                id="user-type"
                value={form.userType}
                onChange={(e) => setForm({ ...form, userType: e.target.value })}
              >
                {userTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            {form.userType !== 'SUPER_ADMIN' && (
              <div className="space-y-2">
                <Label htmlFor="user-company">Empresa *</Label>
                <Select
                  id="user-company"
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
            )}
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
