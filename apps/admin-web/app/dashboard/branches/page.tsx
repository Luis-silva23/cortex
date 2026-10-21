'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Plus, Building2, Phone, Power } from 'lucide-react';
import { api } from '@/lib/api';
import { Select } from '@/components/ui/select';
import { useUserType } from '@/lib/hooks/useUserType';
import { getApiErrorMessage } from '@/lib/errors';

interface Branch {
  id: string;
  name: string;
  company?: { id: string; name: string } | null;
  document?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  phone?: string | null;
  isHeadquarter: boolean;
  isActive: boolean;
}

const emptyForm = {
  name: '',
  document: '',
  address: '',
  city: '',
  state: '',
  zipCode: '',
  phone: '',
  isHeadquarter: false,
};

export default function BranchesPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [formData, setFormData] = useState(emptyForm);
  // Criar/ativar/desativar filial é de COMPANY_ADMIN e SUPER_ADMIN (a API responde
  // 403 aos demais); o SUPER_ADMIN não tem empresa própria, então escolhe a empresa
  // da nova filial — sem isso a API recusava com "companyId é obrigatório".
  const { userType } = useUserType();
  const isSuperAdmin = userType === 'SUPER_ADMIN';
  const canManage = isSuperAdmin || userType === 'COMPANY_ADMIN';
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);
  const [companyId, setCompanyId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const loadBranches = async () => {
    setLoading(true);
    try {
      const result = await api.getBranches();
      setBranches(result?.data ?? []);
    } catch (error) {
      console.error('Erro ao carregar filiais:', error);
      setBranches([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBranches();
  }, []);

  const handleChange = (field: string, value: string | boolean) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleOpenDialog = () => {
    setFormData(emptyForm);
    setFormError(null);
    setCompanyId('');
    setDialogOpen(true);
    if (isSuperAdmin && companies.length === 0) {
      api
        .getCompanies()
        .then((result) => setCompanies((result?.data ?? []).map((c: any) => ({ id: c.id, name: c.name }))))
        .catch((err) => setFormError(getApiErrorMessage(err, 'Não foi possível carregar as empresas.')));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (isSuperAdmin && !companyId) {
      setFormError('Escolha a empresa da nova filial.');
      return;
    }
    setSaving(true);
    try {
      await api.createBranch({
        ...(isSuperAdmin ? { companyId } : {}),
        name: formData.name,
        document: formData.document || undefined,
        address: formData.address || undefined,
        city: formData.city || undefined,
        state: formData.state || undefined,
        zipCode: formData.zipCode || undefined,
        phone: formData.phone || undefined,
        isHeadquarter: formData.isHeadquarter,
      });
      setDialogOpen(false);
      await loadBranches();
    } catch (error) {
      console.error('Erro ao criar filial:', error);
      // A mensagem da API (ex.: "Limite de filiais do plano atingido") em vez de um "Erro ao criar filial" genérico.
      setFormError(getApiErrorMessage(error, 'Erro ao criar filial'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (id: string) => {
    setTogglingId(id);
    try {
      await api.toggleBranchActive(id);
      await loadBranches();
    } catch (error) {
      console.error('Erro ao alterar status da filial:', error);
      alert(getApiErrorMessage(error, 'Erro ao alterar status da filial'));
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Filiais</h1>
          <p className="text-gray-500 mt-1">Gerencie as unidades da sua empresa</p>
        </div>
        {canManage && (
          <Button onClick={handleOpenDialog}>
            <Plus className="h-4 w-4 mr-2" />
            Nova Filial
          </Button>
        )}
      </div>

      <Card>
        {loading ? (
          <div className="p-12 text-center text-gray-500">Carregando...</div>
        ) : branches.length === 0 ? (
          <div className="p-12 text-center">
            <Building2 className="h-12 w-12 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              Nenhuma filial cadastrada
            </h3>
            {canManage && (
              <>
                <p className="text-gray-500 mb-4">Comece cadastrando a primeira unidade</p>
                <Button onClick={handleOpenDialog}>
                  <Plus className="h-4 w-4 mr-2" />
                  Nova Filial
                </Button>
              </>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Endereço</TableHead>
                <TableHead>Cidade/UF</TableHead>
                <TableHead>Telefone</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[120px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {branches.map((branch) => (
                <TableRow key={branch.id}>
                  <TableCell className="font-medium">
                    {branch.name}
                    {/* SUPER_ADMIN vê as filiais de todas as empresas: mostra de qual. */}
                    {isSuperAdmin && branch.company?.name && (
                      <span className="block text-xs font-normal text-muted-foreground">{branch.company.name}</span>
                    )}
                  </TableCell>
                  <TableCell>{branch.address ?? '-'}</TableCell>
                  <TableCell>
                    {branch.city ? `${branch.city}${branch.state ? '/' + branch.state : ''}` : '-'}
                  </TableCell>
                  <TableCell>
                    {branch.phone ? (
                      <div className="flex items-center gap-1 text-sm">
                        <Phone className="h-3 w-3 text-gray-400" />
                        {branch.phone}
                      </div>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={branch.isHeadquarter ? 'default' : 'secondary'}>
                      {branch.isHeadquarter ? 'Matriz' : 'Filial'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={branch.isActive ? 'success' : 'error'}>
                      {branch.isActive ? 'Ativa' : 'Inativa'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={togglingId === branch.id}
                        onClick={() => handleToggleActive(branch.id)}
                      >
                        <Power className="h-4 w-4 mr-1" />
                        {branch.isActive ? 'Desativar' : 'Ativar'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <div className="p-4 border-t flex items-center justify-between">
          <p className="text-sm text-gray-500">
            Mostrando {branches.length} filial(is)
          </p>
        </div>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent onClose={() => setDialogOpen(false)}>
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Nova Filial</DialogTitle>
            </DialogHeader>
            <div className="p-6 space-y-4">
              {formError && (
                <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft p-3 text-sm text-foreground">
                  {formError}
                </p>
              )}
              {isSuperAdmin && (
                <div className="space-y-2">
                  <label className="text-sm font-medium">Empresa *</label>
                  <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} required>
                    <option value="">Selecione a empresa...</option>
                    {companies.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <label className="text-sm font-medium">Nome *</label>
                <Input
                  required
                  placeholder="Nome da filial"
                  value={formData.name}
                  onChange={(e) => handleChange('name', e.target.value)}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">CNPJ/CPF</label>
                  <Input
                    placeholder="00.000.000/0000-00"
                    value={formData.document}
                    onChange={(e) => handleChange('document', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Telefone</label>
                  <Input
                    placeholder="(00) 00000-0000"
                    value={formData.phone}
                    onChange={(e) => handleChange('phone', e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Endereço</label>
                <Input
                  placeholder="Rua, número, complemento"
                  value={formData.address}
                  onChange={(e) => handleChange('address', e.target.value)}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Cidade</label>
                  <Input
                    placeholder="São Paulo"
                    value={formData.city}
                    onChange={(e) => handleChange('city', e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Estado</label>
                  <Input
                    placeholder="SP"
                    maxLength={2}
                    value={formData.state}
                    onChange={(e) => handleChange('state', e.target.value.toUpperCase())}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">CEP</label>
                  <Input
                    placeholder="00000-000"
                    value={formData.zipCode}
                    onChange={(e) => handleChange('zipCode', e.target.value)}
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={formData.isHeadquarter}
                  onChange={(e) => handleChange('isHeadquarter', e.target.checked)}
                />
                Esta é a matriz
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Salvando...' : 'Salvar Filial'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
