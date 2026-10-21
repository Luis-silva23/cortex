'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Building2,
  CreditCard,
  Receipt,
  Users,
  Bell,
  Shield,
  Database,
  Save,
  KeyRound,
  Plus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Palette,
  SlidersHorizontal,
  Clock,
} from 'lucide-react';
import { api } from '@/lib/api';
import { PASSWORD_RULES } from '@/components/auth/PasswordChange';
import { PaymentSettings } from '@/components/settings/PaymentSettings';
import { ThemeSettings } from '@/components/settings/ThemeSettings';
import { CompanyProfileSettings } from '@/components/settings/CompanyProfileSettings';
import { PolicySettings } from '@/components/settings/PolicySettings';
import { BusinessHoursSettings } from '@/components/settings/BusinessHoursSettings';
import { useUserType } from '@/lib/hooks/useUserType';
import { useModuleSettings } from '@/components/providers/ModuleSettingsProvider';

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('company');
  // Só oculta o que o backend também bloquearia (POST/GET /module-settings
  // exige requireUserType('SUPER_ADMIN','COMPANY_ADMIN') — ver
  // module-settings.routes.ts). Esconder a aba pra quem nunca teria acesso
  // é só UX melhor, não é o que impede o acesso de verdade: um MANAGER que
  // batesse direto na API continuaria recebendo 403 de qualquer forma.
  // O papel vem do JWT (localStorage), que não existe no render de servidor:
  // lido no corpo do componente, a aba "Módulos" aparecia só no cliente e o
  // React acusava hydration mismatch. `useUserType` lê depois de montar.
  const { userType } = useUserType();
  // SUPER_ADMIN não entra aqui: o JWT dele não tem empresa e a API agora exige
  // `companyId` explícito para ele (antes a alteração caía na primeira linha
  // daquele módulo de QUALQUER empresa). Escolher a empresa é um fluxo do painel
  // de plataforma, não desta tela — decisão registrada em docs/CORTEX/historico/registro-de-auditoria-2026-09-14-a-25.md.
  const canManageModules = userType === 'COMPANY_ADMIN';

  const tabs = [
    { id: 'company', label: 'Empresa', icon: Building2 },
    // Políticas e horário: leitura para gerência+, alteração só administração (a API decide).
    ...(['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'].includes(userType || '')
      ? [
          { id: 'policies', label: 'Políticas', icon: SlidersHorizontal },
          { id: 'hours', label: 'Funcionamento', icon: Clock },
        ]
      : []),
    { id: 'appearance', label: 'Aparência', icon: Palette },
    { id: 'payments', label: 'Pagamentos', icon: CreditCard },
    { id: 'taxes', label: 'Impostos', icon: Receipt },
    // Só UX (a API é a autoridade): a lista de usuários completa é de gerência+,
    // perfis são de administradores, e backup é da plataforma (SUPER_ADMIN) — as
    // demais abas davam 403/erro para quem não pode e o diálogo de perfis chegava
    // a dizer "nenhum perfil cadastrado".
    ...(['SUPER_ADMIN', 'COMPANY_ADMIN', 'MANAGER'].includes(userType || '')
      ? [{ id: 'users', label: 'Usuários', icon: Users }]
      : []),
    ...(['SUPER_ADMIN', 'COMPANY_ADMIN'].includes(userType || '')
      ? [{ id: 'roles', label: 'Perfis', icon: KeyRound }]
      : []),
    { id: 'notifications', label: 'Notificações', icon: Bell },
    { id: 'security', label: 'Segurança', icon: Shield },
    ...(canManageModules ? [{ id: 'modules', label: 'Módulos', icon: ToggleLeft }] : []),
    ...(userType === 'SUPER_ADMIN' ? [{ id: 'backup', label: 'Backup', icon: Database }] : []),
  ];

  // ---------- Usuários ----------
  const [users, setUsers] = useState<any[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [togglingUserId, setTogglingUserId] = useState<string | null>(null);

  const loadUsers = async () => {
    setUsersLoading(true);
    setUsersError(null);
    try {
      const result = await api.getUsers();
      setUsers(result?.data ?? []);
    } catch (err) {
      console.error('Erro ao carregar usuários:', err);
      setUsersError('Não foi possível carregar os usuários.');
    } finally {
      setUsersLoading(false);
    }
  };

  const handleToggleUserActive = async (id: string) => {
    setTogglingUserId(id);
    try {
      await api.toggleUserActive(id);
      await loadUsers();
    } catch (err) {
      console.error('Erro ao alterar status do usuário:', err);
      alert('Erro ao alterar status do usuário');
    } finally {
      setTogglingUserId(null);
    }
  };

  // ---------- Perfis (RBAC granular) ----------
  const [roles, setRoles] = useState<any[]>([]);
  const [permissions, setPermissions] = useState<any[]>([]);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRoleDesc, setNewRoleDesc] = useState('');
  const [newPermName, setNewPermName] = useState('');
  const [newPermDesc, setNewPermDesc] = useState('');
  const [savingRole, setSavingRole] = useState(false);
  const [savingPerm, setSavingPerm] = useState(false);

  const loadRolesAndPermissions = async () => {
    setRolesLoading(true);
    setRolesError(null);
    try {
      const [rolesResult, permsResult] = await Promise.all([api.getRoles(), api.getPermissions()]);
      setRoles(rolesResult ?? []);
      setPermissions(permsResult ?? []);
    } catch (err) {
      console.error('Erro ao carregar perfis/permissões:', err);
      setRolesError('Não foi possível carregar perfis e permissões.');
    } finally {
      setRolesLoading(false);
    }
  };

  const handleCreateRole = async () => {
    if (!newRoleName.trim()) return;
    setSavingRole(true);
    try {
      await api.createRole({ name: newRoleName, description: newRoleDesc || undefined });
      setNewRoleName('');
      setNewRoleDesc('');
      await loadRolesAndPermissions();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Erro ao criar perfil');
    } finally {
      setSavingRole(false);
    }
  };

  const handleDeleteRole = async (id: string) => {
    if (!confirm('Excluir este perfil? Usuários com este perfil perdem as permissões associadas.')) return;
    try {
      await api.deleteRole(id);
      await loadRolesAndPermissions();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Erro ao excluir perfil');
    }
  };

  const handleCreatePermission = async () => {
    if (!newPermName.trim()) return;
    setSavingPerm(true);
    try {
      await api.createPermission({ name: newPermName, description: newPermDesc || undefined });
      setNewPermName('');
      setNewPermDesc('');
      await loadRolesAndPermissions();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Erro ao criar permissão');
    } finally {
      setSavingPerm(false);
    }
  };

  const handleDeletePermission = async (id: string) => {
    if (!confirm('Excluir esta permissão? Ela será removida de todo perfil que a usa.')) return;
    try {
      await api.deletePermission(id);
      await loadRolesAndPermissions();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Erro ao excluir permissão');
    }
  };

  const handleToggleRolePermission = async (roleId: string, permissionId: string, currentlyAssigned: boolean) => {
    try {
      if (currentlyAssigned) {
        await api.revokeRolePermission(roleId, permissionId);
      } else {
        await api.assignRolePermission(roleId, permissionId);
      }
      await loadRolesAndPermissions();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Erro ao atualizar permissão do perfil');
    }
  };

  // ---------- Atribuir perfil a um usuário (a partir da aba Usuários) ----------
  const [roleDialogUserId, setRoleDialogUserId] = useState<string | null>(null);
  const [userRoles, setUserRoles] = useState<any[]>([]);
  const [userRolesLoading, setUserRolesLoading] = useState(false);

  const openRoleDialog = async (userId: string) => {
    setRoleDialogUserId(userId);
    setUserRolesLoading(true);
    try {
      const [userRolesResult] = await Promise.all([api.getUserRoles(userId), roles.length === 0 ? loadRolesAndPermissions() : Promise.resolve()]);
      setUserRoles(userRolesResult ?? []);
    } catch (err) {
      console.error('Erro ao carregar perfis do usuário:', err);
      setUserRoles([]);
    } finally {
      setUserRolesLoading(false);
    }
  };

  const handleToggleUserRole = async (roleId: string, currentlyAssigned: boolean) => {
    if (!roleDialogUserId) return;
    try {
      if (currentlyAssigned) {
        await api.revokeUserRole(roleDialogUserId, roleId);
      } else {
        await api.assignUserRole(roleDialogUserId, roleId);
      }
      const userRolesResult = await api.getUserRoles(roleDialogUserId);
      setUserRoles(userRolesResult ?? []);
    } catch (err: any) {
      alert(err.response?.data?.error || 'Erro ao atualizar perfil do usuário');
    }
  };

  // ---------- Backup ----------
  const [backups, setBackups] = useState<any[]>([]);
  const [backupStats, setBackupStats] = useState<any>(null);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [creatingBackup, setCreatingBackup] = useState(false);

  const loadBackups = async () => {
    setBackupLoading(true);
    setBackupError(null);
    try {
      const [listResult, statsResult] = await Promise.all([
        api.listBackups(),
        api.getBackupStats(),
      ]);
      setBackups(listResult?.data ?? []);
      setBackupStats(statsResult?.data ?? null);
    } catch (err) {
      console.error('Erro ao carregar backups:', err);
      setBackupError('Não foi possível carregar as informações de backup (verifique permissões).');
    } finally {
      setBackupLoading(false);
    }
  };

  const handleCreateBackup = async () => {
    setCreatingBackup(true);
    try {
      await api.createBackup();
      alert('Backup criado com sucesso!');
      await loadBackups();
    } catch (err) {
      console.error('Erro ao criar backup:', err);
      alert('Erro ao criar backup (verifique se você tem permissão).');
    } finally {
      setCreatingBackup(false);
    }
  };

  // ---------- Módulos (ativação/desativação por empresa/filial) ----------
  // O backend (requireModuleEnabled, apps/api/src/middleware/module.ts) é
  // SEMPRE a autoridade real — esta tela só chama a API e mostra o que ela
  // devolve. Nenhuma regra de bloqueio vive aqui.
  const MODULE_LABELS: Record<string, string> = {
    ESTOQUE: 'Estoque, Inventário e Transferências',
    COMPRAS: 'Compras',
    VENDAS: 'Vendas, PDV, Pagamentos e Caixa',
    FINANCEIRO: 'Financeiro (Contas a Pagar/Receber)',
    FISCAL: 'Fiscal (NF-e/NFC-e)',
    OFICINA: 'Oficina (OS, Orçamentos, Mecânicos, Comissões)',
    POS_VENDA: 'Pós-venda (Revisões e Agenda)',
    CANAIS: 'Canais de venda (site próprio, iFood, marketplaces) — nasce desativado',
  };
  const [moduleSettings, setModuleSettings] = useState<any[]>([]);
  const [modulesLoading, setModulesLoading] = useState(false);
  const [modulesError, setModulesError] = useState<string | null>(null);
  const [togglingModule, setTogglingModule] = useState<string | null>(null);
  const [disableDialogModule, setDisableDialogModule] = useState<string | null>(null);
  const [disableReason, setDisableReason] = useState('');
  const [disableBusy, setDisableBusy] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);
  const { refresh: refreshModuleMenu } = useModuleSettings();

  const loadModuleSettings = async () => {
    setModulesLoading(true);
    setModulesError(null);
    try {
      const result = await api.getModuleSettings();
      setModuleSettings(result?.modules ?? []);
      // Menu lateral e bloqueio de URL acompanham a alteração sem recarregar a página.
      refreshModuleMenu();
    } catch (err: any) {
      console.error('Erro ao carregar módulos:', err);
      setModulesError(
        err.response?.status === 403
          ? 'Você não tem permissão para ver/alterar módulos (só Super Admin/Admin da Empresa).'
          : 'Não foi possível carregar os módulos.'
      );
    } finally {
      setModulesLoading(false);
    }
  };

  const handleEnableModule = async (module: string) => {
    setTogglingModule(module);
    try {
      await api.setModuleEnabled(module, { isEnabled: true });
      await loadModuleSettings();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Erro ao habilitar módulo');
    } finally {
      setTogglingModule(null);
    }
  };

  const submitDisableModule = async () => {
    if (!disableDialogModule) return;
    if (disableReason.trim().length < 3) {
      setDisableError('Informe um motivo (mínimo 3 caracteres) — fica registrado no histórico.');
      return;
    }
    setDisableError(null);
    setDisableBusy(true);
    try {
      await api.setModuleEnabled(disableDialogModule, { isEnabled: false, reason: disableReason.trim() });
      setDisableDialogModule(null);
      setDisableReason('');
      await loadModuleSettings();
    } catch (err: any) {
      setDisableError(err.response?.data?.error || 'Erro ao desativar módulo');
    } finally {
      setDisableBusy(false);
    }
  };

  // ---------- MFA (2FA) do usuário logado ----------
  const [me, setMe] = useState<any>(null);
  const [meLoading, setMeLoading] = useState(false);
  const [mfaSetupData, setMfaSetupData] = useState<{ secret: string; qrCode: string; backupCodes: string[] } | null>(null);
  const [mfaSavedBackupCodes, setMfaSavedBackupCodes] = useState(false);
  const [mfaVerifyCode, setMfaVerifyCode] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaDisableDialogOpen, setMfaDisableDialogOpen] = useState(false);
  const [mfaDisablePassword, setMfaDisablePassword] = useState('');

  // ---------- Troca da PRÓPRIA senha (decisão 157) ----------
  const [pwdCurrent, setPwdCurrent] = useState('');
  const [pwdNew, setPwdNew] = useState('');
  const [pwdConfirm, setPwdConfirm] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdError, setPwdError] = useState<string | null>(null);

  async function submitPasswordChange(e: React.FormEvent) {
    e.preventDefault();
    if (!pwdCurrent || !pwdNew || pwdNew !== pwdConfirm) return;
    setPwdBusy(true);
    setPwdError(null);
    try {
      await api.changeOwnPassword(pwdCurrent, pwdNew);
      // o servidor encerrou TODAS as sessões desta conta (inclusive esta): limpa o que ficou no navegador e volta ao login
      localStorage.removeItem('token');
      localStorage.removeItem('refreshToken');
      window.location.href = '/login';
    } catch (err: any) {
      setPwdError(err.response?.data?.message || 'Não foi possível trocar a senha.');
    } finally {
      setPwdBusy(false);
    }
  }

  const loadMe = async () => {
    setMeLoading(true);
    try {
      const result = await api.getMe();
      setMe(result?.data ?? null);
    } catch (err) {
      console.error('Erro ao carregar usuário logado:', err);
      setMe(null);
    } finally {
      setMeLoading(false);
    }
  };

  const startMfaSetup = async () => {
    setMfaError(null);
    setMfaBusy(true);
    try {
      const result = await api.setupMfa();
      setMfaSetupData(result.data);
      setMfaSavedBackupCodes(false);
      setMfaVerifyCode('');
    } catch (err: any) {
      setMfaError(err.response?.data?.message || 'Erro ao iniciar configuração de MFA');
    } finally {
      setMfaBusy(false);
    }
  };

  const confirmMfaSetup = async () => {
    setMfaError(null);
    if (mfaVerifyCode.length !== 6) {
      setMfaError('Digite o código de 6 dígitos do seu app autenticador');
      return;
    }
    setMfaBusy(true);
    try {
      await api.verifyMfa(mfaVerifyCode);
      setMfaSetupData(null);
      setMfaVerifyCode('');
      await loadMe();
    } catch (err: any) {
      setMfaError(err.response?.data?.message || 'Código inválido');
    } finally {
      setMfaBusy(false);
    }
  };

  const submitMfaDisable = async () => {
    setMfaError(null);
    if (!mfaDisablePassword) return;
    setMfaBusy(true);
    try {
      await api.disableMfa(mfaDisablePassword);
      setMfaDisableDialogOpen(false);
      setMfaDisablePassword('');
      await loadMe();
    } catch (err: any) {
      setMfaError(err.response?.data?.message || 'Senha inválida');
    } finally {
      setMfaBusy(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'users') {
      loadUsers();
    }
    if (activeTab === 'backup') {
      loadBackups();
    }
    if (activeTab === 'roles') {
      loadRolesAndPermissions();
    }
    if (activeTab === 'security') {
      loadMe();
      setMfaSetupData(null);
      setMfaError(null);
    }
    if (activeTab === 'modules') {
      loadModuleSettings();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Configurações</h1>
        <p className="text-gray-500 mt-1">
          Gerencie as configurações do sistema
        </p>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Tabs Sidebar */}
        <div className="col-span-3">
          <Card>
            <CardContent className="p-4">
              <nav className="space-y-1">
                {tabs.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                        activeTab === tab.id
                          ? 'bg-blue-50 text-blue-600'
                          : 'text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <Icon className="h-5 w-5" />
                      {tab.label}
                    </button>
                  );
                })}
              </nav>
            </CardContent>
          </Card>
        </div>

        {/* Content Area */}
        <div className="col-span-9">
          {activeTab === 'appearance' && <ThemeSettings />}

          {activeTab === 'company' && <CompanyProfileSettings />}

          {activeTab === 'policies' && <PolicySettings />}

          {activeTab === 'hours' && <BusinessHoursSettings />}

          {activeTab === 'payments' && <PaymentSettings />}

          {activeTab === 'taxes' && (
            <Card>
              <CardHeader>
                <CardTitle>Configurações de Impostos</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  Em desenvolvimento: não existe hoje um endpoint na API para
                  configuração de regime tributário/alíquotas por empresa. Esta
                  tela é apenas ilustrativa.
                </div>

                <div className="space-y-2">
                  <Label htmlFor="tax-regime">Regime Tributário</Label>
                  <Select id="tax-regime" disabled>
                    <option value="">Selecione</option>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="icms">ICMS Padrão (%)</Label>
                    <Input id="icms" type="number" placeholder="0.00" disabled />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pis">PIS (%)</Label>
                    <Input id="pis" type="number" placeholder="0.00" disabled />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="cofins">COFINS (%)</Label>
                    <Input id="cofins" type="number" placeholder="0.00" disabled />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ipi">IPI (%)</Label>
                    <Input id="ipi" type="number" placeholder="0.00" disabled />
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button disabled title="Em desenvolvimento">
                    <Save className="h-4 w-4 mr-2" />
                    Em desenvolvimento
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === 'users' && (
            <Card>
              <CardHeader>
                <CardTitle>Gerenciar Usuários</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <Button disabled title="Cadastro de usuários ainda não tem tela própria aqui">
                    <Users className="h-4 w-4 mr-2" />
                    Adicionar Novo Usuário (em breve)
                  </Button>

                  {usersError && (
                    <p className="text-sm text-red-600">{usersError}</p>
                  )}

                  {usersLoading ? (
                    <p className="text-sm text-gray-500">Carregando usuários...</p>
                  ) : (
                    <div className="border rounded-lg overflow-hidden">
                      {users.length === 0 ? (
                        <p className="text-sm text-gray-500 p-4">Nenhum usuário encontrado.</p>
                      ) : (
                        users.map((u) => (
                          <div
                            key={u.id}
                            className="flex items-center justify-between p-4 border-b last:border-b-0"
                          >
                            <div>
                              <p className="font-medium">{u.name}</p>
                              <p className="text-sm text-gray-500">{u.email}</p>
                            </div>
                            <div className="flex items-center gap-3">
                              <span
                                className={`text-sm px-3 py-1 rounded-full ${
                                  u.isActive
                                    ? 'bg-blue-100 text-blue-700'
                                    : 'bg-gray-100 text-gray-600'
                                }`}
                              >
                                {u.userType}
                                {u.isActive ? '' : ' · inativo'}
                              </span>
                              <Button variant="outline" size="sm" onClick={() => openRoleDialog(u.id)}>
                                Perfis
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={togglingUserId === u.id}
                                onClick={() => handleToggleUserActive(u.id)}
                              >
                                {u.isActive ? 'Desativar' : 'Ativar'}
                              </Button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === 'roles' && (
            <div className="space-y-6">
              {rolesError && <p className="text-sm text-red-600">{rolesError}</p>}

              <Card>
                <CardHeader>
                  <CardTitle>Perfis</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Nome do novo perfil (ex: Mecânico Sênior)"
                      value={newRoleName}
                      onChange={(e) => setNewRoleName(e.target.value)}
                    />
                    <Input
                      placeholder="Descrição (opcional)"
                      value={newRoleDesc}
                      onChange={(e) => setNewRoleDesc(e.target.value)}
                    />
                    <Button onClick={handleCreateRole} disabled={savingRole || !newRoleName.trim()}>
                      <Plus className="h-4 w-4 mr-1" />
                      Criar
                    </Button>
                  </div>

                  {rolesLoading ? (
                    <p className="text-sm text-gray-500">Carregando...</p>
                  ) : roles.length === 0 ? (
                    <p className="text-sm text-gray-500">
                      Nenhum perfil cadastrado ainda. Perfis do sistema (se houver) aparecem aqui também, mas não
                      podem ser editados/excluídos.
                    </p>
                  ) : (
                    <div className="space-y-4">
                      {roles.map((role) => (
                        <div key={role.id} className="border rounded-lg p-4">
                          <div className="flex items-center justify-between mb-3">
                            <div>
                              <p className="font-medium">
                                {role.name}
                                {role.isSystem && (
                                  <span className="ml-2 text-xs text-gray-400">(sistema)</span>
                                )}
                              </p>
                              {role.description && <p className="text-sm text-gray-500">{role.description}</p>}
                            </div>
                            {!role.isSystem && (
                              <Button variant="ghost" size="sm" onClick={() => handleDeleteRole(role.id)}>
                                <Trash2 className="h-4 w-4 text-red-500" />
                              </Button>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {permissions.length === 0 ? (
                              <p className="text-xs text-gray-400">Cadastre uma permissão abaixo para poder atribuí-la a este perfil.</p>
                            ) : (
                              permissions.map((perm) => {
                                const assigned = (role.rolePermissions || []).some(
                                  (rp: any) => rp.permission.id === perm.id
                                );
                                return (
                                  <label
                                    key={perm.id}
                                    className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border cursor-pointer ${
                                      assigned ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-200 text-gray-600'
                                    }`}
                                  >
                                    <Checkbox
                                      checked={assigned}
                                      onChange={() => handleToggleRolePermission(role.id, perm.id, assigned)}
                                      className="h-3 w-3"
                                    />
                                    {perm.name}
                                  </label>
                                );
                              })
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Permissões</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Nome da permissão (ex: write:service-orders)"
                      value={newPermName}
                      onChange={(e) => setNewPermName(e.target.value)}
                    />
                    <Input
                      placeholder="Descrição (opcional)"
                      value={newPermDesc}
                      onChange={(e) => setNewPermDesc(e.target.value)}
                    />
                    <Button onClick={handleCreatePermission} disabled={savingPerm || !newPermName.trim()}>
                      <Plus className="h-4 w-4 mr-1" />
                      Criar
                    </Button>
                  </div>
                  {permissions.length === 0 ? (
                    <p className="text-sm text-gray-500">Nenhuma permissão cadastrada ainda.</p>
                  ) : (
                    <div className="border rounded-lg divide-y">
                      {permissions.map((perm) => (
                        <div key={perm.id} className="flex items-center justify-between p-3 text-sm">
                          <div>
                            <span className="font-medium">{perm.name}</span>
                            {perm.description && <span className="text-gray-500 ml-2">{perm.description}</span>}
                          </div>
                          <Button variant="ghost" size="sm" onClick={() => handleDeletePermission(perm.id)}>
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === 'notifications' && (
            <Card>
              <CardHeader>
                <CardTitle>Preferências de Notificações</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  Em desenvolvimento: não existe hoje um endpoint de preferências
                  de notificação na API. Esta tela é apenas ilustrativa.
                </div>

                {[
                  'Notificar estoque baixo',
                  'Notificar vendas canceladas',
                  'Notificar novos clientes',
                  'Relatórios automáticos por email',
                  'Alertas de segurança',
                ].map((label) => (
                  <div key={label} className="flex items-center justify-between p-4 border rounded-lg opacity-60">
                    <span className="font-medium">{label}</span>
                    <input type="checkbox" disabled className="h-4 w-4 text-blue-600 rounded" />
                  </div>
                ))}

                <div className="flex justify-end">
                  <Button disabled title="Em desenvolvimento">
                    <Save className="h-4 w-4 mr-2" />
                    Em desenvolvimento
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === 'security' && (
            <Card>
              <CardHeader>
                <CardTitle>Segurança</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <form onSubmit={submitPasswordChange} className="space-y-4" data-testid="change-password-form">
                  <p className="text-sm text-gray-600">
                    Ao trocar a senha, todas as suas sessões são encerradas e você entra de novo com a senha nova.
                  </p>
                  {pwdError && (
                    <p role="alert" className="text-sm text-red-600">
                      {pwdError}
                    </p>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="current-password">Senha atual</Label>
                    <Input id="current-password" type="password" autoComplete="current-password" value={pwdCurrent} onChange={(e) => setPwdCurrent(e.target.value)} />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="new-password">Nova senha</Label>
                    <Input id="new-password" type="password" autoComplete="new-password" value={pwdNew} onChange={(e) => setPwdNew(e.target.value)} />
                    <p className="text-xs text-gray-500">{PASSWORD_RULES}</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="confirm-password">Confirmar nova senha</Label>
                    <Input id="confirm-password" type="password" autoComplete="new-password" value={pwdConfirm} onChange={(e) => setPwdConfirm(e.target.value)} />
                    {pwdConfirm.length > 0 && pwdNew !== pwdConfirm && <p className="text-xs text-red-600">As senhas não são iguais.</p>}
                  </div>

                  <Button type="submit" disabled={pwdBusy || !pwdCurrent || !pwdNew || pwdNew !== pwdConfirm}>
                    {pwdBusy ? 'Salvando...' : 'Trocar senha'}
                  </Button>
                </form>

                <div className="border-t pt-4 mt-6">
                  <h3 className="font-medium mb-4">Autenticação em Dois Fatores (app autenticador)</h3>

                  {mfaError && <p className="text-sm text-red-600 mb-3">{mfaError}</p>}

                  {meLoading ? (
                    <p className="text-sm text-gray-500">Carregando...</p>
                  ) : mfaSetupData ? (
                    <div className="space-y-4 p-4 border rounded-lg">
                      <div>
                        <p className="text-sm font-medium mb-1">1. Adicione esta chave no seu app autenticador</p>
                        <p className="text-xs text-gray-500 mb-2">
                          Google Authenticator / Authy → Adicionar conta → Inserir uma chave de configuração manualmente.
                        </p>
                        <code className="block bg-gray-100 rounded p-3 text-sm font-mono break-all">{mfaSetupData.secret}</code>
                      </div>

                      {!mfaSavedBackupCodes ? (
                        <div>
                          <p className="text-sm font-medium mb-1 text-amber-700">2. Salve estes códigos de backup agora</p>
                          <p className="text-xs text-gray-500 mb-2">
                            Eles só aparecem uma vez — cada um permite entrar uma única vez se você perder o app autenticador.
                          </p>
                          <div className="grid grid-cols-2 gap-1 bg-gray-100 rounded p-3 font-mono text-xs">
                            {mfaSetupData.backupCodes.map((c) => (
                              <span key={c}>{c}</span>
                            ))}
                          </div>
                          <Button size="sm" className="mt-2" onClick={() => setMfaSavedBackupCodes(true)}>
                            Já salvei os códigos
                          </Button>
                        </div>
                      ) : (
                        <div>
                          <p className="text-sm font-medium mb-1">3. Digite o código gerado pelo app para confirmar</p>
                          <div className="flex gap-2">
                            <Input
                              value={mfaVerifyCode}
                              onChange={(e) => setMfaVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                              placeholder="000000"
                              className="w-40 font-mono tracking-widest"
                            />
                            <Button onClick={confirmMfaSetup} disabled={mfaBusy || mfaVerifyCode.length !== 6}>
                              {mfaBusy ? 'Confirmando...' : 'Confirmar e ativar'}
                            </Button>
                            <Button variant="outline" onClick={() => setMfaSetupData(null)}>
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center justify-between p-4 border rounded-lg">
                      <div>
                        <p className="font-medium">
                          {me?.mfaEnabled ? 'MFA está ativo na sua conta' : 'MFA está desativado'}
                        </p>
                        <p className="text-sm text-gray-500">
                          {me?.mfaEnabled
                            ? 'Um app autenticador (TOTP) é exigido a cada login.'
                            : 'Adicione uma camada extra de segurança com um app autenticador.'}
                        </p>
                      </div>
                      {me?.mfaEnabled ? (
                        <Button variant="outline" onClick={() => setMfaDisableDialogOpen(true)}>
                          Desativar
                        </Button>
                      ) : (
                        <Button onClick={startMfaSetup} disabled={mfaBusy}>
                          {mfaBusy ? 'Iniciando...' : 'Ativar MFA'}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === 'modules' && (
            <Card>
              <CardHeader>
                <CardTitle>Módulos do Sistema</CardTitle>
                <p className="text-sm text-gray-500 mt-1">
                  Ative ou desative módulos operacionais para esta empresa. Um módulo desativado é bloqueado
                  pela própria API para todos os usuários — não é apenas um item escondido do menu. O
                  histórico e os dados já lançados de um módulo desativado nunca são apagados.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {modulesError && <p className="text-sm text-red-600">{modulesError}</p>}
                {modulesLoading ? (
                  <p className="text-sm text-gray-500">Carregando...</p>
                ) : moduleSettings.length === 0 ? (
                  !modulesError && <p className="text-sm text-gray-500">Nenhum módulo encontrado.</p>
                ) : (
                  <div className="space-y-3">
                    {moduleSettings.map((m) => (
                      <div key={m.module} className="flex items-center justify-between border rounded-lg p-4">
                        <div>
                          <p className="font-medium">{MODULE_LABELS[m.module] || m.module}</p>
                          <p className="text-xs text-gray-400 mt-0.5">
                            {m.isEnabled ? 'Habilitado' : 'Desativado'}
                            {m.source === 'DEFAULT' && ' — padrão (nenhuma configuração registrada)'}
                            {m.source === 'COMPANY_WIDE' && ' — configurado para toda a empresa'}
                            {m.source === 'BRANCH_OVERRIDE' && ' — configurado só para esta filial'}
                          </p>
                        </div>
                        <Button
                          variant={m.isEnabled ? 'outline' : 'default'}
                          size="sm"
                          disabled={togglingModule === m.module}
                          onClick={() =>
                            m.isEnabled ? setDisableDialogModule(m.module) : handleEnableModule(m.module)
                          }
                        >
                          {m.isEnabled ? (
                            <>
                              <ToggleRight className="h-4 w-4 mr-1.5 text-green-600" />
                              Desativar
                            </>
                          ) : (
                            <>
                              <ToggleLeft className="h-4 w-4 mr-1.5 text-gray-400" />
                              {togglingModule === m.module ? 'Ativando...' : 'Ativar'}
                            </>
                          )}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {activeTab === 'backup' && (
            <Card>
              <CardHeader>
                <CardTitle>Backup e Restauração</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {backupError && (
                  <p className="text-sm text-red-600">{backupError}</p>
                )}

                <div className="border rounded-lg p-6 text-center">
                  <Database className="h-12 w-12 mx-auto text-gray-400 mb-4" />
                  <h3 className="font-medium mb-2">Backup Automático</h3>
                  <p className="text-sm text-gray-500 mb-4">
                    {backupLoading
                      ? 'Carregando...'
                      : backupStats?.newestBackup
                      ? `Último backup: ${new Date(backupStats.newestBackup).toLocaleString('pt-BR')}`
                      : 'Nenhum backup registrado ainda.'}
                  </p>
                  <div className="flex gap-3 justify-center">
                    <Button onClick={handleCreateBackup} disabled={creatingBackup}>
                      {creatingBackup ? 'Criando backup...' : 'Fazer Backup Agora'}
                    </Button>
                    <Button variant="outline" disabled title="Restauração disponível apenas via lista de backups abaixo (em desenvolvimento nesta tela)">
                      Restaurar Backup
                    </Button>
                  </div>
                </div>

                {backups.length > 0 && (
                  <div className="border rounded-lg divide-y">
                    {backups.map((b) => (
                      <div key={b.filename} className="flex items-center justify-between p-3 text-sm">
                        <span>{b.filename}</span>
                        <span className="text-gray-500">{b.sizeFormatted}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  Em desenvolvimento: a frequência de backup automático abaixo é
                  apenas ilustrativa — não existe hoje um endpoint na API para
                  configurar agendamento automático (os endpoints reais são
                  criação/listagem/estatísticas/restauração/remoção manuais).
                </div>

                <div className="space-y-2">
                  <Label>Frequência de Backup Automático</Label>
                  <Select disabled>
                    <option value="">Selecione</option>
                  </Select>
                </div>

                <div className="flex justify-end">
                  <Button disabled title="Em desenvolvimento">
                    <Save className="h-4 w-4 mr-2" />
                    Em desenvolvimento
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Dialog open={roleDialogUserId !== null} onOpenChange={(open) => !open && setRoleDialogUserId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Perfis do usuário</DialogTitle>
          </DialogHeader>
          {userRolesLoading ? (
            <p className="text-sm text-gray-500">Carregando...</p>
          ) : roles.length === 0 ? (
            <p className="text-sm text-gray-500">
              Nenhum perfil cadastrado ainda — crie um na aba &quot;Perfis&quot; primeiro.
            </p>
          ) : (
            <div className="space-y-2">
              {roles.map((role) => {
                const assigned = userRoles.some((ur: any) => ur.roleId === role.id || ur.role?.id === role.id);
                return (
                  <label
                    key={role.id}
                    className="flex items-center gap-2 p-2 border rounded-lg cursor-pointer hover:bg-gray-50"
                  >
                    <Checkbox checked={assigned} onChange={() => handleToggleUserRole(role.id, assigned)} />
                    <span className="text-sm font-medium">{role.name}</span>
                    {role.description && <span className="text-xs text-gray-400">{role.description}</span>}
                  </label>
                );
              })}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleDialogUserId(null)}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mfaDisableDialogOpen} onOpenChange={(open) => !open && setMfaDisableDialogOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Desativar MFA</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-amber-600">Confirme com sua senha atual — isso remove a exigência de código a cada login.</p>
            {mfaError && <p className="text-sm text-red-600">{mfaError}</p>}
            <div className="space-y-1">
              <Label>Senha</Label>
              <Input type="password" value={mfaDisablePassword} onChange={(e) => setMfaDisablePassword(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMfaDisableDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={submitMfaDisable} disabled={mfaBusy || !mfaDisablePassword}>
              {mfaBusy ? 'Desativando...' : 'Desativar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!disableDialogModule} onOpenChange={(open) => !open && setDisableDialogModule(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Desativar módulo {disableDialogModule ? MODULE_LABELS[disableDialogModule] || disableDialogModule : ''}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-amber-600">
              Todos os usuários desta empresa perderão acesso à API deste módulo imediatamente — inclusive quem
              tem permissão para usá-lo. O histórico e os dados já lançados não são apagados.
            </p>
            {disableError && <p className="text-sm text-red-600">{disableError}</p>}
            <div className="space-y-1">
              <Label>Motivo (fica registrado no histórico)</Label>
              <Input value={disableReason} onChange={(e) => setDisableReason(e.target.value)} placeholder="Ex: empresa ainda não usa este módulo" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDisableDialogModule(null); setDisableReason(''); setDisableError(null); }}>
              Cancelar
            </Button>
            <Button onClick={submitDisableModule} disabled={disableBusy || disableReason.trim().length < 3}>
              {disableBusy ? 'Desativando...' : 'Desativar módulo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
