'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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
import { Plus, Users as UsersIcon, ShieldCheck, AlertCircle, Lock, KeyRound, GitBranch } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { api, getCurrentUserClaims } from '@/lib/api';
import { Pagination } from '@/components/ui/pagination';

const USER_TYPES = ['COMPANY_ADMIN', 'MANAGER', 'OPERATOR', 'MECHANIC', 'VIEWER'];
// Papéis de empresa inteira enxergam todas as filiais da empresa e não recebem filial nem vínculo (o servidor recusa).
const COMPANY_WIDE = ['SUPER_ADMIN', 'COMPANY_ADMIN'];
const USER_TYPE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  COMPANY_ADMIN: 'Admin da Empresa',
  MANAGER: 'Gerente',
  OPERATOR: 'Operador',
  MECHANIC: 'Mecânico',
  VIEWER: 'Visualizador',
};

export default function UsersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Usuários, Perfis e Permissões</h1>
        <p className="text-gray-500 mt-1">
          Controle de acesso (RBAC). Só um Super Admin pode criar ou promover alguém a Super Admin.
        </p>
      </div>

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">
            <UsersIcon className="h-4 w-4 mr-1 inline" /> Usuários
          </TabsTrigger>
          <TabsTrigger value="roles">
            <ShieldCheck className="h-4 w-4 mr-1 inline" /> Perfis &amp; Permissões
          </TabsTrigger>
        </TabsList>
        <TabsContent value="users">
          <UsersPanel />
        </TabsContent>
        <TabsContent value="roles">
          <RolesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function UsersPanel() {
  const currentUser = getCurrentUserClaims();
  const [users, setUsers] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', password: '', userType: 'OPERATOR', branchId: '', requirePasswordChange: true });

  const [rolesDialogUser, setRolesDialogUser] = useState<any>(null);
  const [allRoles, setAllRoles] = useState<any[]>([]);
  const [userRoles, setUserRoles] = useState<any[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState('');

  const [passwordDialogUser, setPasswordDialogUser] = useState<any>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetRequireChange, setResetRequireChange] = useState(true);

  // Filiais da empresa (para a filial principal e para as filiais autorizadas — decisão 153)
  const [branches, setBranches] = useState<Array<{ id: string; name: string; isActive?: boolean }>>([]);
  const [branchesDialogUser, setBranchesDialogUser] = useState<any>(null);
  const [branchChecked, setBranchChecked] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesSaving, setBranchesSaving] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const branchName = (id?: string | null) => (id ? (branches.find((b) => b.id === id)?.name ?? 'Filial não encontrada') : null);

  // Só um Super Admin pode criar/promover outro Super Admin — mesma
  // restrição aplicada no backend (user.routes.ts). Escondido aqui em vez
  // de mostrado-e-rejeitado só evita uma viagem ao servidor para um 403
  // previsível; a garantia de verdade continua no backend.
  const availableUserTypes = currentUser?.userType === 'SUPER_ADMIN' ? ['SUPER_ADMIN', ...USER_TYPES] : USER_TYPES;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getUsers({ page, limit: 20 });
      setUsers(result?.data ?? []);
      setPages(result?.pagination?.pages ?? 1);
      setTotal(result?.pagination?.total ?? result?.data?.length ?? 0);
    } catch (err) {
      console.error('Erro ao carregar usuários:', err);
      setError('Não foi possível carregar os usuários. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    api
      .getBranches()
      .then((res) => setBranches((res?.data ?? []).map((b: any) => ({ id: b.id, name: b.name, isActive: b.isActive }))))
      .catch(() => setBranches([]));
  }, []);

  function openNew() {
    setEditingId(null);
    setForm({ name: '', email: '', password: '', userType: 'OPERATOR', branchId: '', requirePasswordChange: true });
    setFormError(null);
    setDialogOpen(true);
  }

  function openEdit(user: any) {
    setEditingId(user.id);
    setForm({ name: user.name, email: user.email, password: '', userType: user.userType, branchId: user.branchId ?? '', requirePasswordChange: true });
    setFormError(null);
    setDialogOpen(true);
  }

  async function save() {
    setFormError(null);
    if (!form.name.trim() || !form.email.trim()) {
      setFormError('Nome e e-mail são obrigatórios');
      return;
    }
    if (!editingId && form.password.length < 8) {
      setFormError('Senha precisa de pelo menos 8 caracteres');
      return;
    }
    // Quem não é de empresa inteira trabalha numa filial: sem filial principal o usuário não enxergaria nada.
    const needsBranch = !COMPANY_WIDE.includes(form.userType);
    if (needsBranch && !form.branchId) {
      setFormError('Escolha a filial principal: gerente, operador, mecânico e visualizador trabalham em uma filial.');
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await api.updateUser(editingId, { name: form.name, email: form.email, userType: form.userType, ...(needsBranch ? { branchId: form.branchId } : {}) });
      } else {
        await api.createUser({ name: form.name, email: form.email, password: form.password, userType: form.userType, requirePasswordChange: form.requirePasswordChange, ...(needsBranch ? { branchId: form.branchId } : {}) });
      }
      setDialogOpen(false);
      await load();
    } catch (err: any) {
      setFormError(err.response?.data?.error || 'Erro ao salvar usuário');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(id: string) {
    try {
      await api.toggleUserActive(id);
      await load();
    } catch (err) {
      console.error('Erro ao ativar/desativar usuário:', err);
    }
  }

  async function unlock(id: string) {
    try {
      await api.unlockUser(id);
      await load();
    } catch (err) {
      console.error('Erro ao desbloquear usuário:', err);
    }
  }

  async function openRolesDialog(user: any) {
    setRolesDialogUser(user);
    setSelectedRoleId('');
    try {
      const [roles, assigned] = await Promise.all([api.getRoles(), api.getUserRoles(user.id)]);
      setAllRoles(roles ?? []);
      setUserRoles(assigned ?? []);
    } catch (err) {
      console.error('Erro ao carregar perfis do usuário:', err);
      setAllRoles([]);
      setUserRoles([]);
    }
  }

  async function assignRole() {
    if (!rolesDialogUser || !selectedRoleId) return;
    try {
      await api.assignUserRole(rolesDialogUser.id, selectedRoleId);
      const assigned = await api.getUserRoles(rolesDialogUser.id);
      setUserRoles(assigned ?? []);
      setSelectedRoleId('');
    } catch (err: any) {
      alert(err.response?.data?.error || 'Erro ao atribuir perfil');
    }
  }

  async function revokeRole(roleId: string, branchId?: string | null) {
    if (!rolesDialogUser) return;
    try {
      await api.revokeUserRole(rolesDialogUser.id, roleId, branchId);
      const assigned = await api.getUserRoles(rolesDialogUser.id);
      setUserRoles(assigned ?? []);
    } catch (err) {
      console.error('Erro ao revogar perfil:', err);
    }
  }

  async function openBranchesDialog(user: any) {
    setBranchesDialogUser(user);
    setBranchesError(null);
    setBranchChecked([]);
    setBranchesLoading(true);
    try {
      const links = await api.getUserBranches(user.id);
      setBranchChecked(links.branchIds);
    } catch (err: any) {
      setBranchesError(err.response?.data?.error || 'Não foi possível carregar as filiais deste usuário');
    } finally {
      setBranchesLoading(false);
    }
  }

  function toggleBranch(id: string, checked: boolean) {
    setBranchChecked((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((b) => b !== id)));
  }

  async function saveBranches() {
    if (!branchesDialogUser) return;
    setBranchesSaving(true);
    setBranchesError(null);
    try {
      await api.setUserBranches(branchesDialogUser.id, branchChecked);
      setBranchesDialogUser(null);
      await load();
    } catch (err: any) {
      setBranchesError(err.response?.data?.error || 'Erro ao salvar as filiais');
    } finally {
      setBranchesSaving(false);
    }
  }

  async function submitPasswordReset() {
    if (!passwordDialogUser || newPassword.length < 8) return;
    try {
      await api.resetUserPassword(passwordDialogUser.id, newPassword, resetRequireChange);
      setPasswordDialogUser(null);
      setNewPassword('');
    } catch (err: any) {
      alert(err.response?.data?.error || 'Erro ao redefinir senha');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-2" />
          Novo Usuário
        </Button>
      </div>

      <Card>
        {loading ? (
          <div className="p-12 text-center text-gray-500">Carregando...</div>
        ) : error ? (
          <div className="p-12 text-center">
            <AlertCircle className="h-12 w-12 mx-auto text-red-400 mb-4" />
            <p className="text-gray-500 mb-4">{error}</p>
            <Button variant="outline" onClick={load}>
              Tentar novamente
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>E-mail</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Filial</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[420px]">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">
                    {u.name}
                    {u.id === currentUser?.userId && <span className="ml-1 text-xs text-gray-400">(você)</span>}
                  </TableCell>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>
                    <Badge variant={u.userType === 'SUPER_ADMIN' ? 'error' : 'secondary'}>
                      {USER_TYPE_LABELS[u.userType] ?? u.userType}
                    </Badge>
                  </TableCell>
                  <TableCell data-testid={`user-branch-${u.id}`}>
                    {COMPANY_WIDE.includes(u.userType) ? (
                      <span className="text-sm text-gray-500">Todas as filiais</span>
                    ) : u.branchId ? (
                      <span className="text-sm">{branchName(u.branchId)}</span>
                    ) : (
                      <Badge variant="error">Sem filial</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.isActive ? 'success' : 'secondary'}>{u.isActive ? 'Ativo' : 'Inativo'}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      <Button size="sm" variant="outline" onClick={() => openEdit(u)}>
                        Editar
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => openRolesDialog(u)}>
                        Perfis
                      </Button>
                      {!COMPANY_WIDE.includes(u.userType) && (
                        <Button size="sm" variant="outline" onClick={() => openBranchesDialog(u)} title="Filiais que este usuário pode acessar">
                          <GitBranch className="h-3.5 w-3.5 mr-1" />
                          Filiais
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => setPasswordDialogUser(u)}>
                        <KeyRound className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => unlock(u.id)} title="Desbloquear (após tentativas de login inválidas)">
                        <Lock className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => toggleActive(u.id)}>
                        {u.isActive ? 'Desativar' : 'Ativar'}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!loading && !error && (
          <Pagination page={page} pages={pages} total={total} itemCount={users.length} onPageChange={setPage} itemLabel="usuários" />
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? 'Editar Usuário' : 'Novo Usuário'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <div className="space-y-1">
              <Label>Nome</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>E-mail</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            {!editingId && (
              <div className="space-y-1">
                <Label>Senha</Label>
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                <label className="flex items-start gap-2 pt-1 text-xs text-gray-600">
                  <Checkbox
                    checked={form.requirePasswordChange}
                    onChange={(e) => setForm({ ...form, requirePasswordChange: e.target.checked })}
                    aria-label="Exigir troca de senha no primeiro acesso"
                  />
                  <span>
                    Exigir que a pessoa troque esta senha no primeiro acesso (recomendado). Sem isso, quem cadastrou conhece a senha dela.
                  </span>
                </label>
              </div>
            )}
            <div className="space-y-1">
              <Label>Tipo</Label>
              <Select value={form.userType} onChange={(e) => setForm({ ...form, userType: e.target.value })}>
                {availableUserTypes.map((t) => (
                  <option key={t} value={t}>
                    {USER_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </div>
            {!COMPANY_WIDE.includes(form.userType) && (
              <div className="space-y-1">
                <Label>Filial principal</Label>
                <Select value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
                  <option value="">Selecione a filial...</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                      {b.isActive === false ? ' (inativa)' : ''}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-gray-500">Para dar acesso a outras filiais, use o botão &quot;Filiais&quot; depois de salvar.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Salvando...' : 'Salvar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rolesDialogUser} onOpenChange={(open) => !open && setRolesDialogUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Perfis de {rolesDialogUser?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {rolesDialogUser?.id === currentUser?.userId && (
              <p className="text-xs text-amber-600">Não é permitido atribuir um perfil a si mesmo — peça a outro admin.</p>
            )}
            <div className="space-y-2">
              {userRoles.length === 0 ? (
                <p className="text-sm text-gray-500">Nenhum perfil atribuído.</p>
              ) : (
                userRoles.map((ur: any) => (
                  <div key={ur.id} className="flex items-center justify-between rounded border px-3 py-2">
                    <span className="text-sm">
                      {ur.role?.name}
                      {ur.branchId && <span className="text-xs text-gray-400"> (filial específica)</span>}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => revokeRole(ur.roleId, ur.branchId)}>
                      Remover
                    </Button>
                  </div>
                ))
              )}
            </div>
            <div className="flex gap-2">
              <Select value={selectedRoleId} onChange={(e) => setSelectedRoleId(e.target.value)}>
                <option value="">Selecione um perfil...</option>
                {allRoles.map((r: any) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
              <Button onClick={assignRole} disabled={!selectedRoleId || rolesDialogUser?.id === currentUser?.userId}>
                Atribuir
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRolesDialogUser(null)}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!branchesDialogUser} onOpenChange={(open) => !open && setBranchesDialogUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Filiais de {branchesDialogUser?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-gray-500">
              Este usuário enxerga dashboard, vendas, faturamento e convênios <strong>somente</strong> das filiais marcadas. Ao desmarcar uma filial o acesso
              é revogado na próxima requisição dele, sem precisar sair e entrar de novo.
            </p>
            {branchesError && <p className="text-sm text-red-600">{branchesError}</p>}
            {branchesLoading ? (
              <p className="text-sm text-gray-500">Carregando...</p>
            ) : branches.length === 0 ? (
              <p className="text-sm text-gray-500">Nenhuma filial cadastrada.</p>
            ) : (
              <div className="space-y-2" data-testid="branches-checklist">
                {branches.map((b) => {
                  const isPrimary = b.id === branchesDialogUser?.branchId;
                  return (
                    <label key={b.id} className="flex items-center gap-2 rounded border px-3 py-2 text-sm">
                      <Checkbox
                        checked={branchChecked.includes(b.id) || isPrimary}
                        disabled={isPrimary}
                        onChange={(e) => toggleBranch(b.id, e.target.checked)}
                        aria-label={`Filial ${b.name}`}
                      />
                      <span>{b.name}</span>
                      {isPrimary && <span className="text-xs text-gray-400">(principal)</span>}
                      {b.isActive === false && <span className="text-xs text-gray-400">(inativa)</span>}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBranchesDialogUser(null)}>
              Cancelar
            </Button>
            <Button onClick={saveBranches} disabled={branchesSaving || branchesLoading}>
              {branchesSaving ? 'Salvando...' : 'Salvar filiais'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!passwordDialogUser} onOpenChange={(open) => !open && setPasswordDialogUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Redefinir senha de {passwordDialogUser?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-500">Revoga todas as sessões ativas desse usuário.</p>
            <div className="space-y-1">
              <Label>Nova senha</Label>
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </div>
            <label className="flex items-start gap-2 text-xs text-gray-600">
              <Checkbox checked={resetRequireChange} onChange={(e) => setResetRequireChange(e.target.checked)} aria-label="Exigir troca de senha no próximo acesso" />
              <span>Exigir que a pessoa troque esta senha no próximo acesso (recomendado).</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordDialogUser(null)}>
              Cancelar
            </Button>
            <Button onClick={submitPasswordReset} disabled={newPassword.length < 8}>
              Redefinir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RolesPanel() {
  const [roles, setRoles] = useState<any[]>([]);
  const [permissions, setPermissions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleDescription, setNewRoleDescription] = useState('');

  const [permDialogOpen, setPermDialogOpen] = useState(false);
  const [newPermName, setNewPermName] = useState('');
  const [newPermDescription, setNewPermDescription] = useState('');

  const [managingRole, setManagingRole] = useState<any>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [rolesResult, permsResult] = await Promise.all([api.getRoles(), api.getPermissions()]);
      setRoles(rolesResult ?? []);
      setPermissions(permsResult ?? []);
    } catch (err) {
      console.error('Erro ao carregar perfis/permissões:', err);
      setError('Não foi possível carregar perfis e permissões. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function saveRole() {
    if (!newRoleName.trim()) return;
    try {
      await api.createRole({ name: newRoleName, description: newRoleDescription || undefined });
      setRoleDialogOpen(false);
      setNewRoleName('');
      setNewRoleDescription('');
      await load();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Erro ao criar perfil');
    }
  }

  async function savePermission() {
    if (!newPermName.trim()) return;
    try {
      await api.createPermission({ name: newPermName, description: newPermDescription || undefined });
      setPermDialogOpen(false);
      setNewPermName('');
      setNewPermDescription('');
      await load();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Erro ao criar permissão');
    }
  }

  async function togglePermission(role: any, permissionId: string, has: boolean) {
    try {
      if (has) {
        await api.revokeRolePermission(role.id, permissionId);
      } else {
        await api.assignRolePermission(role.id, permissionId);
      }
      const rolesResult = await api.getRoles();
      setRoles(rolesResult ?? []);
      setManagingRole(rolesResult.find((r: any) => r.id === role.id) ?? null);
    } catch (err) {
      console.error('Erro ao alterar permissão do perfil:', err);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => setPermDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Nova Permissão
        </Button>
        <Button onClick={() => setRoleDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Novo Perfil
        </Button>
      </div>

      <Card>
        {loading ? (
          <div className="p-12 text-center text-gray-500">Carregando...</div>
        ) : error ? (
          <div className="p-12 text-center">
            <AlertCircle className="h-12 w-12 mx-auto text-red-400 mb-4" />
            <p className="text-gray-500 mb-4">{error}</p>
            <Button variant="outline" onClick={load}>
              Tentar novamente
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Perfil</TableHead>
                <TableHead>Escopo</TableHead>
                <TableHead>Permissões</TableHead>
                <TableHead className="w-[140px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>{r.companyId ? 'Empresa' : 'Sistema'}</TableCell>
                  <TableCell>{r.rolePermissions?.length ?? 0}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => setManagingRole(r)}>
                      Gerenciar
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo Perfil</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Nome</Label>
              <Input value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Descrição (opcional)</Label>
              <Input value={newRoleDescription} onChange={(e) => setNewRoleDescription(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={saveRole}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={permDialogOpen} onOpenChange={setPermDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova Permissão</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Nome (ex: sales:create)</Label>
              <Input value={newPermName} onChange={(e) => setNewPermName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Descrição (opcional)</Label>
              <Input value={newPermDescription} onChange={(e) => setNewPermDescription(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPermDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={savePermission}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!managingRole} onOpenChange={(open) => !open && setManagingRole(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permissões de {managingRole?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {permissions.map((p: any) => {
              const has = managingRole?.rolePermissions?.some((rp: any) => rp.permission.id === p.id);
              return (
                <label key={p.id} className="flex items-center gap-2 rounded border px-3 py-2 cursor-pointer">
                  <input type="checkbox" checked={!!has} onChange={() => togglePermission(managingRole, p.id, !!has)} />
                  <span className="text-sm">{p.name}</span>
                </label>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManagingRole(null)}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
