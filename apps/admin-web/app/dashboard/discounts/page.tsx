'use client';

import { useEffect, useState } from 'react';
import { formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Plus, Percent, CreditCard, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';

interface Partner {
  id: string;
  name: string;
  description: string | null;
  branchId: string | null;
  discountType: 'PERCENTAGE' | 'FIXED';
  discountValue: string;
  maxDiscountAmount: string | null;
  stackable: boolean;
  requiresApproval: boolean;
  isActive: boolean;
}

interface InstallmentPolicy {
  id: string;
  branchId: string | null;
  paymentMethod: string;
  maxInstallments: number;
  interestFreeInstallments: number;
  isActive: boolean;
}

const PAYMENT_METHODS = ['CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'PIX', 'BANK_TRANSFER', 'CHECK', 'VOUCHER', 'OTHER'];
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: 'Dinheiro',
  DEBIT_CARD: 'Cartão Débito',
  CREDIT_CARD: 'Cartão Crédito',
  PIX: 'PIX',
  BANK_TRANSFER: 'Transferência',
  CHECK: 'Cheque',
  VOUCHER: 'Vale',
  OTHER: 'Outro',
};

export default function DiscountsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Descontos e Pagamentos</h1>
        <p className="text-gray-500 mt-1">
          Convênios/parceiros para desconto no PDV e limites de parcelamento — nunca um percentual fixo no código,
          sempre configurável por empresa.
        </p>
      </div>

      <Tabs defaultValue="partners">
        <TabsList>
          <TabsTrigger value="partners">
            <Percent className="h-4 w-4 mr-1 inline" /> Convênios
          </TabsTrigger>
          <TabsTrigger value="installments">
            <CreditCard className="h-4 w-4 mr-1 inline" /> Parcelamento
          </TabsTrigger>
        </TabsList>
        <TabsContent value="partners">
          <PartnersPanel />
        </TabsContent>
        <TabsContent value="installments">
          <InstallmentPoliciesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PartnersPanel() {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    description: '',
    discountType: 'PERCENTAGE' as 'PERCENTAGE' | 'FIXED',
    discountValue: '',
    maxDiscountAmount: '',
    stackable: false,
    requiresApproval: false,
  });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getPartners();
      setPartners(result ?? []);
    } catch (err) {
      console.error('Erro ao carregar convênios:', err);
      setError('Não foi possível carregar os convênios. Tente novamente.');
      setPartners([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openNew() {
    setForm({
      name: '',
      description: '',
      discountType: 'PERCENTAGE',
      discountValue: '',
      maxDiscountAmount: '',
      stackable: false,
      requiresApproval: false,
    });
    setFormError(null);
    setDialogOpen(true);
  }

  async function save() {
    setFormError(null);
    if (!form.name.trim()) {
      setFormError('Nome é obrigatório');
      return;
    }
    if (!form.discountValue || Number(form.discountValue) <= 0) {
      setFormError('Valor de desconto deve ser maior que zero');
      return;
    }
    setSaving(true);
    try {
      await api.createPartner({
        name: form.name,
        description: form.description || undefined,
        discountType: form.discountType,
        discountValue: Number(form.discountValue),
        maxDiscountAmount: form.maxDiscountAmount ? Number(form.maxDiscountAmount) : undefined,
        stackable: form.stackable,
        requiresApproval: form.requiresApproval,
      });
      setDialogOpen(false);
      await load();
    } catch (err: any) {
      setFormError(err.response?.data?.error || 'Erro ao salvar convênio');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(id: string) {
    try {
      await api.togglePartnerActive(id);
      await load();
    } catch (err) {
      console.error('Erro ao ativar/desativar convênio:', err);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-2" />
          Novo Convênio
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
        ) : partners.length === 0 ? (
          <div className="p-12 text-center">
            <Percent className="h-12 w-12 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">Nenhum convênio cadastrado</h3>
            <p className="text-gray-500 mb-4">
              Cadastre convênios como &quot;Posto Santa 10%&quot; para o operador selecionar no PDV.
            </p>
            <Button onClick={openNew}>
              <Plus className="h-4 w-4 mr-2" />
              Novo Convênio
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Desconto</TableHead>
                <TableHead>Teto</TableHead>
                <TableHead>Cumulativo</TableHead>
                <TableHead>Aprovação</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {partners.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    {p.name}
                    {p.branchId && <span className="ml-1 text-xs text-gray-400">(filial específica)</span>}
                  </TableCell>
                  <TableCell>
                    {p.discountType === 'PERCENTAGE' ? `${p.discountValue}%` : formatCurrency(Number(p.discountValue))}
                  </TableCell>
                  <TableCell>{p.maxDiscountAmount ? formatCurrency(Number(p.maxDiscountAmount)) : '-'}</TableCell>
                  <TableCell>{p.stackable ? 'Sim' : 'Não'}</TableCell>
                  <TableCell>{p.requiresApproval ? 'Sim' : 'Não'}</TableCell>
                  <TableCell>
                    <Badge variant={p.isActive ? 'default' : 'secondary'}>{p.isActive ? 'Ativo' : 'Inativo'}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => toggleActive(p.id)}>
                      {p.isActive ? 'Desativar' : 'Ativar'}
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
            <DialogTitle>Novo Convênio</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <div className="space-y-1">
              <Label>Nome</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex: Posto Santa" />
            </div>
            <div className="space-y-1">
              <Label>Descrição (opcional)</Label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Tipo</Label>
                <Select
                  value={form.discountType}
                  onChange={(e) => setForm({ ...form, discountType: e.target.value as 'PERCENTAGE' | 'FIXED' })}
                >
                  <option value="PERCENTAGE">Percentual</option>
                  <option value="FIXED">Valor fixo</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{form.discountType === 'PERCENTAGE' ? 'Percentual (%)' : 'Valor (R$)'}</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={form.discountValue}
                  onChange={(e) => setForm({ ...form, discountValue: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Teto de desconto em R$ (opcional)</Label>
              <Input
                type="number"
                step="0.01"
                value={form.maxDiscountAmount}
                onChange={(e) => setForm({ ...form, maxDiscountAmount: e.target.value })}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox checked={form.stackable} onChange={(e) => setForm({ ...form, stackable: e.target.checked })} />
              <Label className="!mb-0">Pode ser combinado com desconto manual na mesma venda</Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                checked={form.requiresApproval}
                onChange={(e) => setForm({ ...form, requiresApproval: e.target.checked })}
              />
              <Label className="!mb-0">Exige aprovação de Gerente/Admin</Label>
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

function InstallmentPoliciesPanel() {
  const [policies, setPolicies] = useState<InstallmentPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    paymentMethod: 'CREDIT_CARD',
    maxInstallments: '1',
    interestFreeInstallments: '1',
  });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getInstallmentPolicies();
      setPolicies(result ?? []);
    } catch (err) {
      console.error('Erro ao carregar políticas de parcelamento:', err);
      setError('Não foi possível carregar as políticas de parcelamento. Tente novamente.');
      setPolicies([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function openNew() {
    setForm({ paymentMethod: 'CREDIT_CARD', maxInstallments: '1', interestFreeInstallments: '1' });
    setFormError(null);
    setDialogOpen(true);
  }

  async function save() {
    setFormError(null);
    const max = Number(form.maxInstallments);
    const free = Number(form.interestFreeInstallments);
    if (!(max >= 1)) {
      setFormError('Máximo de parcelas deve ser pelo menos 1');
      return;
    }
    if (free < 0 || free > max) {
      setFormError('Parcelas sem juros deve estar entre 0 e o máximo de parcelas');
      return;
    }
    setSaving(true);
    try {
      await api.createInstallmentPolicy({
        paymentMethod: form.paymentMethod,
        maxInstallments: max,
        interestFreeInstallments: free,
      });
      setDialogOpen(false);
      await load();
    } catch (err: any) {
      setFormError(err.response?.data?.error || 'Erro ao salvar política de parcelamento');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openNew}>
          <Plus className="h-4 w-4 mr-2" />
          Nova Política
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
        ) : policies.length === 0 ? (
          <div className="p-12 text-center">
            <CreditCard className="h-12 w-12 mx-auto text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">Nenhuma política cadastrada</h3>
            <p className="text-gray-500 mb-4">
              Sem uma política, o PDV bloqueia qualquer parcelamento acima de 1x (à vista) para essa forma de
              pagamento.
            </p>
            <Button onClick={openNew}>
              <Plus className="h-4 w-4 mr-2" />
              Nova Política
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Forma de Pagamento</TableHead>
                <TableHead>Máximo de Parcelas</TableHead>
                <TableHead>Sem Juros Até</TableHead>
                <TableHead>Filial</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {policies.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{PAYMENT_METHOD_LABELS[p.paymentMethod] || p.paymentMethod}</TableCell>
                  <TableCell>{p.maxInstallments}x</TableCell>
                  <TableCell>{p.interestFreeInstallments}x</TableCell>
                  <TableCell>{p.branchId ? 'Específica' : 'Todas'}</TableCell>
                  <TableCell>
                    <Badge variant={p.isActive ? 'default' : 'secondary'}>{p.isActive ? 'Ativa' : 'Inativa'}</Badge>
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
            <DialogTitle>Nova Política de Parcelamento</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {formError && <p className="text-sm text-red-600">{formError}</p>}
            <div className="space-y-1">
              <Label>Forma de Pagamento</Label>
              <Select value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Máximo de Parcelas</Label>
                <Input
                  type="number"
                  min={1}
                  value={form.maxInstallments}
                  onChange={(e) => setForm({ ...form, maxInstallments: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>Parcelas Sem Juros</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.interestFreeInstallments}
                  onChange={(e) => setForm({ ...form, interestFreeInstallments: e.target.value })}
                />
              </div>
            </div>
            <p className="text-xs text-gray-400">Esta política vale para todas as filiais da empresa.</p>
            <p className="text-xs text-amber-700" data-testid="installment-interest-note">
              Atenção: o CÓRTEX ainda <strong>não calcula nem cobra juros</strong>. O número de parcelas limita o parcelamento e o
              valor da venda é dividido igualmente (em centavos); &quot;Parcelas Sem Juros&quot; fica registrado para uso futuro e
              não altera o total cobrado.
            </p>
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
