'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Pagination } from '@/components/ui/pagination';
import { Ban, CheckCircle2, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface Device {
  id: string;
  deviceName: string;
  deviceType: string;
  status: string;
  lastSeenAt: string | null;
  license?: {
    company?: {
      id: string;
      name: string;
    };
  };
}

const statusColors: Record<string, string> = {
  PENDING: 'bg-warning-soft text-warning',
  ACTIVE: 'bg-success-soft text-success',
  BLOCKED: 'bg-danger-soft text-danger',
  REVOKED: 'bg-muted text-muted-foreground',
};

const statusLabels: Record<string, string> = {
  PENDING: 'Pendente',
  ACTIVE: 'Ativo',
  BLOCKED: 'Bloqueado',
  REVOKED: 'Revogado',
};

// Equipamento NOVO que se registrou sozinho (POST /api/device/enroll) e aguarda o administrador: ainda sem empresa nem filial.
interface PendingEnrollment {
  id: string;
  deviceName: string;
  deviceType: string;
  macAddress: string | null;
  ipAddress: string | null;
  enrollmentCode: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

interface LicenseOption {
  id: string;
  status: string;
  licenseType: string;
  company?: { id: string; name: string };
}

interface BranchOption {
  id: string;
  name: string;
  isActive?: boolean;
}

type ActionType = 'block' | 'revoke' | null;

const DEFAULT_PAGINATION = { page: 1, limit: 20, total: 0, pages: 1 };

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [pagination, setPagination] = useState(DEFAULT_PAGINATION);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionDevice, setActionDevice] = useState<Device | null>(null);
  const [actionType, setActionType] = useState<ActionType>(null);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [unblockingId, setUnblockingId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingEnrollment[]>([]);
  const [authorizing, setAuthorizing] = useState<PendingEnrollment | null>(null);
  const [licenses, setLicenses] = useState<LicenseOption[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [licenseId, setLicenseId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [authorizeError, setAuthorizeError] = useState('');
  const [authorizeSubmitting, setAuthorizeSubmitting] = useState(false);

  useEffect(() => {
    loadDevices(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    loadPending();
  }, []);

  async function loadPending() {
    try {
      const response = await api.get('/activations/enrollments');
      setPending(response.data.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar equipamentos aguardando autorização');
    }
  }

  async function openAuthorize(item: PendingEnrollment) {
    setAuthorizing(item);
    setLicenseId('');
    setBranchId('');
    setBranches([]);
    setAuthorizeError('');
    try {
      const response = await api.get('/licenses');
      setLicenses((response.data.data as LicenseOption[]).filter((l) => l.status === 'ACTIVE'));
    } catch (err: any) {
      setAuthorizeError(err.response?.data?.error || 'Erro ao carregar licenças');
    }
  }

  async function chooseLicense(id: string) {
    setLicenseId(id);
    setBranchId('');
    setBranches([]);
    const companyId = licenses.find((l) => l.id === id)?.company?.id;
    if (!companyId) return;
    try {
      const response = await api.get('/branches', { params: { companyId } });
      setBranches((response.data.data as BranchOption[]).filter((b) => b.isActive !== false));
    } catch (err: any) {
      setAuthorizeError(err.response?.data?.error || 'Erro ao carregar filiais');
    }
  }

  async function handleAuthorize() {
    if (!authorizing || !licenseId || !branchId) {
      setAuthorizeError('Escolha a licença (empresa) e a filial.');
      return;
    }
    setAuthorizeSubmitting(true);
    setAuthorizeError('');
    try {
      await api.post(`/activations/enrollments/${authorizing.id}/authorize`, { licenseId, branchId });
      setAuthorizing(null);
      await Promise.all([loadPending(), loadDevices()]);
    } catch (err: any) {
      setAuthorizeError(err.response?.data?.error || 'Erro ao autorizar equipamento');
    } finally {
      setAuthorizeSubmitting(false);
    }
  }

  async function loadDevices(pageToLoad = page) {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/activations/devices', { params: { page: pageToLoad, limit: 20 } });
      setDevices(response.data.data);
      setPagination(response.data.pagination || { ...DEFAULT_PAGINATION, page: pageToLoad, total: response.data.data.length });
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao carregar dispositivos');
    } finally {
      setLoading(false);
    }
  }

  function openAction(device: Device, type: ActionType) {
    setActionDevice(device);
    setActionType(type);
    setReason('');
    setActionError('');
  }

  function closeAction() {
    setActionDevice(null);
    setActionType(null);
    setReason('');
    setActionError('');
  }

  async function handleUnblock(device: Device) {
    setUnblockingId(device.id);
    setError('');
    try {
      await api.post(`/activations/devices/${device.id}/unblock`);
      await loadDevices();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Erro ao desbloquear dispositivo');
    } finally {
      setUnblockingId(null);
    }
  }

  async function handleConfirmAction() {
    if (!actionDevice || !actionType) return;

    if (!reason.trim()) {
      setActionError('Informe o motivo.');
      return;
    }

    setSubmitting(true);
    setActionError('');
    try {
      await api.post(`/activations/devices/${actionDevice.id}/${actionType}`, { reason });
      closeAction();
      await Promise.all([loadDevices(), loadPending()]);
    } catch (err: any) {
      setActionError(err.response?.data?.error || `Erro ao ${actionType === 'block' ? 'bloquear' : 'revogar'} dispositivo`);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div>Carregando...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Dispositivos</h1>
        <p className="text-muted-foreground">Gerencie os dispositivos ativados</p>
      </div>

      {error && (
        <div className="rounded-md border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
          {error}
        </div>
      )}

      {pending.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="border-b p-4">
              <h2 className="text-lg font-semibold">Aguardando autorização ({pending.length})</h2>
              <p className="text-sm text-muted-foreground">
                Equipamentos novos que abriram o aplicativo e se registraram. Confira o código mostrado na tela da máquina antes de autorizar.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium">Código</th>
                    <th className="px-4 py-3 text-left text-sm font-medium">Equipamento</th>
                    <th className="px-4 py-3 text-left text-sm font-medium">Tipo</th>
                    <th className="px-4 py-3 text-left text-sm font-medium">Identificação (MAC/IP)</th>
                    <th className="px-4 py-3 text-left text-sm font-medium">Pedido</th>
                    <th className="px-4 py-3 text-left text-sm font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((item) => (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="px-4 py-3 font-mono text-sm font-bold tracking-wider">{item.enrollmentCode || '-'}</td>
                      <td className="px-4 py-3 text-sm font-medium">{item.deviceName}</td>
                      <td className="px-4 py-3 text-sm">{item.deviceType}</td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {[item.macAddress, item.ipAddress].filter(Boolean).join(' · ') || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true, locale: ptBR })}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <div className="flex gap-2">
                          <Button size="sm" onClick={() => openAuthorize(item)}>
                            <CheckCircle2 className="mr-2 h-4 w-4" />
                            Autorizar
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => openAction(item as unknown as Device, 'revoke')}>
                            <Trash2 className="mr-2 h-4 w-4" />
                            Recusar
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium">Nome</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Tipo</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Empresa</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Status</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Última atividade</th>
                  <th className="px-4 py-3 text-left text-sm font-medium">Ações</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => (
                  <tr key={device.id} className="border-b last:border-0">
                    <td className="px-4 py-3 text-sm font-medium">{device.deviceName}</td>
                    <td className="px-4 py-3 text-sm">{device.deviceType}</td>
                    <td className="px-4 py-3 text-sm">{device.license?.company?.name || '-'}</td>
                    <td className="px-4 py-3 text-sm">
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-medium ${
                          statusColors[device.status] || 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {statusLabels[device.status] || device.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {device.lastSeenAt
                        ? formatDistanceToNow(new Date(device.lastSeenAt), {
                            addSuffix: true,
                            locale: ptBR,
                          })
                        : 'Nunca'}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex gap-2">
                        {device.status === 'BLOCKED' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={unblockingId === device.id}
                            onClick={() => handleUnblock(device)}
                          >
                            <CheckCircle2 className="mr-2 h-4 w-4" />
                            {unblockingId === device.id ? 'Desbloqueando...' : 'Desbloquear'}
                          </Button>
                        ) : (
                          device.status !== 'REVOKED' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openAction(device, 'block')}
                            >
                              <Ban className="mr-2 h-4 w-4" />
                              Bloquear
                            </Button>
                          )
                        )}
                        {device.status !== 'REVOKED' && (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => openAction(device, 'revoke')}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Revogar
                          </Button>
                        )}
                      </div>
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
          itemCount={devices.length}
          onPageChange={setPage}
          itemLabel="dispositivos"
        />
      </Card>

      {devices.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10">
            <p className="text-muted-foreground">Nenhum dispositivo cadastrado</p>
          </CardContent>
        </Card>
      )}

      <Dialog open={authorizing !== null} onOpenChange={(open) => !open && setAuthorizing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Autorizar equipamento</DialogTitle>
            <DialogDescription>
              {`"${authorizing?.deviceName}" (código ${authorizing?.enrollmentCode ?? '-'}) será vinculado à empresa e à filial escolhidas. O operador não escolhe empresa nem filial: elas vêm daqui.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="authorize-license">Licença (empresa) *</Label>
              <Select id="authorize-license" value={licenseId} onChange={(e) => chooseLicense(e.target.value)}>
                <option value="">Selecione…</option>
                {licenses.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.company?.name ?? l.id} — {l.licenseType}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="authorize-branch">Filial *</Label>
              <Select id="authorize-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} disabled={!licenseId}>
                <option value="">Selecione…</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {authorizeError && <p className="text-sm text-danger">{authorizeError}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={() => setAuthorizing(null)} disabled={authorizeSubmitting}>
              Cancelar
            </Button>
            <Button onClick={handleAuthorize} disabled={authorizeSubmitting || !licenseId || !branchId}>
              {authorizeSubmitting ? 'Autorizando...' : 'Autorizar equipamento'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={actionType !== null} onOpenChange={(open) => !open && closeAction()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionType === 'block' ? 'Bloquear dispositivo' : 'Revogar dispositivo'}
            </DialogTitle>
            <DialogDescription>
              {actionType === 'block'
                ? `O dispositivo "${actionDevice?.deviceName}" ficará bloqueado até ser desbloqueado manualmente.`
                : `Esta ação é permanente e não pode ser desfeita. O dispositivo "${actionDevice?.deviceName}" perderá acesso definitivamente.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="reason">Motivo *</Label>
            <Textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Descreva o motivo desta ação"
            />
          </div>

          {actionError && <p className="text-sm text-danger">{actionError}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={closeAction} disabled={submitting}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmAction}
              disabled={submitting}
            >
              {submitting
                ? 'Enviando...'
                : actionType === 'block'
                ? 'Confirmar bloqueio'
                : 'Confirmar revogação'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
