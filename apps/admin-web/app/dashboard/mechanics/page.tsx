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
import { Plus, DollarSign, Percent, AlertCircle } from 'lucide-react';
import { api, getCurrentUserClaims } from '@/lib/api';
import { useUserType } from '@/lib/hooks/useUserType';
import { getApiErrorMessage } from '@/lib/errors';
import { collectAllPages } from '@/lib/list-pagination';

function formatMoney(v: number) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export default function MechanicsPage() {
  // MECHANIC vê só as PRÓPRIAS comissões (a API força isso) e não tem acesso às
  // regras de comissão nem a liquidar; o papel é lido depois de montar.
  const { userType } = useUserType();
  const isMechanic = userType === 'MECHANIC';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">{isMechanic ? 'Minhas comissões' : 'Mecânicos e Comissões'}</h1>
        <p className="text-gray-500 mt-1">
          Comissão é gerada automaticamente ao registrar o pagamento de uma OS, a partir da regra ativa — o valor
          fica congelado (ruleSnapshot) mesmo se a regra mudar depois.
        </p>
      </div>

      <Tabs defaultValue="commissions">
        <TabsList>
          <TabsTrigger value="commissions">
            <DollarSign className="h-4 w-4 mr-1 inline" /> Comissões
          </TabsTrigger>
          {!isMechanic && (
            <TabsTrigger value="rules">
              <Percent className="h-4 w-4 mr-1 inline" /> Regras de Comissão
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="commissions">
          <CommissionsPanel />
        </TabsContent>
        {!isMechanic && (
          <TabsContent value="rules">
            <RulesPanel />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function CommissionsPanel() {
  const [commissions, setCommissions] = useState<any[]>([]);
  const [mechanics, setMechanics] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mechanicFilter, setMechanicFilter] = useState('');
  const [paidFilter, setPaidFilter] = useState('');
  const [summary, setSummary] = useState<{ pendingCount: number; pendingAmount: number } | null>(null);
  // MECHANIC: só as próprias (o backend ignora ?mechanicId= para este papel), sem
  // seletor de outros mecânicos e sem "Liquidar" (é de gerência+).
  const { userType } = useUserType();
  const ownMechanicId = userType === 'MECHANIC' ? getCurrentUserClaims()?.userId : undefined;
  const isMechanic = userType === 'MECHANIC';

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getMechanicCommissions({
        mechanicId: ownMechanicId ?? (mechanicFilter || undefined),
        isPaid: paidFilter === '' ? undefined : paidFilter === 'true',
        limit: 50,
      });
      setCommissions(result.commissions ?? []);
      if (ownMechanicId || mechanicFilter) {
        const s = await api.getMechanicPendingSummary((ownMechanicId ?? mechanicFilter) as string);
        setSummary(s);
      } else {
        setSummary(null);
      }
    } catch (err) {
      console.error('Erro ao carregar comissões:', err);
      setError('Não foi possível carregar as comissões. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Roda de novo quando o papel chega (`ownMechanicId`): MECHANIC filtra pelo
    // próprio id (o backend também força).
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mechanicFilter, paidFilter, ownMechanicId]);

  useEffect(() => {
    if (isMechanic) return; // MECHANIC não precisa da lista de outros mecânicos
    // Só MECHANIC (o filtro "Todos os mecânicos" listava todos os perfis), e
    // também os inativos: comissões antigas continuam pertencendo a quem saiu.
    collectAllPages<{ id: string; name: string }>((page) =>
      api.getUsers({ userType: 'MECHANIC', page, limit: 100 })
    )
      .then(setMechanics)
      .catch(() => setMechanics([]));
  }, []);

  function mechanicName(id: string) {
    return mechanics.find((m) => m.id === id)?.name ?? id.slice(0, 8);
  }

  async function pay(id: string) {
    try {
      await api.payMechanicCommission(id);
      await load();
    } catch (err: any) {
      alert(getApiErrorMessage(err, 'Erro ao liquidar comissão'));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {!isMechanic && (
          <div className="w-64">
            <Select value={mechanicFilter} onChange={(e) => setMechanicFilter(e.target.value)}>
              <option value="">Todos os mecânicos</option>
              {mechanics.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="w-48">
          <Select value={paidFilter} onChange={(e) => setPaidFilter(e.target.value)}>
            <option value="">Pagas e pendentes</option>
            <option value="false">Só pendentes</option>
            <option value="true">Só pagas</option>
          </Select>
        </div>
        {summary && (
          <Badge variant="warning">
            {summary.pendingCount} pendente(s) — {formatMoney(summary.pendingAmount)}
          </Badge>
        )}
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
        ) : commissions.length === 0 ? (
          <div className="p-12 text-center text-gray-500">Nenhuma comissão encontrada.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mecânico</TableHead>
                <TableHead>OS</TableHead>
                <TableHead>Base</TableHead>
                <TableHead>%</TableHead>
                <TableHead>Comissão</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {commissions.map((c: any) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{mechanicName(c.mechanicId)}</TableCell>
                  <TableCell>#{c.serviceOrder?.osNumber}</TableCell>
                  <TableCell>{formatMoney(Number(c.baseAmount))}</TableCell>
                  <TableCell>{Number(c.percentage)}%</TableCell>
                  <TableCell className="font-medium">{formatMoney(Number(c.commissionAmount))}</TableCell>
                  <TableCell>
                    <Badge variant={c.isPaid ? 'success' : 'warning'}>{c.isPaid ? 'Paga' : 'Pendente'}</Badge>
                  </TableCell>
                  <TableCell>
                    {!c.isPaid && !isMechanic && (
                      <Button size="sm" onClick={() => pay(c.id)}>
                        Liquidar
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function RulesPanel() {
  const [rules, setRules] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [serviceType, setServiceType] = useState('');
  const [percentage, setPercentage] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getCommissionRules();
      setRules(result ?? []);
    } catch (err) {
      console.error('Erro ao carregar regras de comissão:', err);
      setError('Não foi possível carregar as regras de comissão. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openNew() {
    setName('');
    setServiceType('');
    setPercentage('');
    setFormError(null);
    setDialogOpen(true);
  }

  async function save() {
    setFormError(null);
    const pct = Number(percentage);
    if (!name.trim() || Number.isNaN(pct) || pct < 0 || pct > 100) {
      setFormError('Nome e percentual (0 a 100) são obrigatórios');
      return;
    }
    setSaving(true);
    try {
      await api.createCommissionRule({ name, serviceType: serviceType || undefined, percentage: pct });
      setDialogOpen(false);
      await load();
    } catch (err: any) {
      setFormError(getApiErrorMessage(err, 'Erro ao criar regra'));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(rule: any) {
    try {
      if (rule.isActive) {
        await api.deleteCommissionRule(rule.id);
      } else {
        await api.updateCommissionRule(rule.id, { isActive: true });
      }
      await load();
    } catch (err) {
      console.error('Erro ao alterar regra de comissão:', err);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-2" />
          Nova Regra
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
        ) : rules.length === 0 ? (
          <div className="p-12 text-center">
            <Percent className="h-12 w-12 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">Nenhuma regra de comissão</h3>
            <p className="text-gray-500">
              Sem uma regra ativa, o pagamento de uma OS não gera comissão nenhuma para o mecânico.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Tipo de serviço</TableHead>
                <TableHead>Percentual</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>{r.serviceType ?? 'Todos'}</TableCell>
                  <TableCell>{Number(r.percentage)}%</TableCell>
                  <TableCell>
                    <Badge variant={r.isActive ? 'success' : 'secondary'}>{r.isActive ? 'Ativa' : 'Inativa'}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => toggleActive(r)}>
                      {r.isActive ? 'Desativar' : 'Ativar'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova Regra de Comissão</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <div className="space-y-1">
              <Label>Nome</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Comissão padrão" />
            </div>
            <div className="space-y-1">
              <Label>Tipo de serviço (opcional — vazio vale para todos)</Label>
              <Input value={serviceType} onChange={(e) => setServiceType(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Percentual</Label>
              <Input type="number" step="0.01" min={0} max={100} value={percentage} onChange={(e) => setPercentage(e.target.value)} />
            </div>
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
    </div>
  );
}
