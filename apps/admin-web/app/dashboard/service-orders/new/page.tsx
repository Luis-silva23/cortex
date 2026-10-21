'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { getApiErrorMessage } from '@/lib/errors';
import { CustomerPicker, type CustomerOption } from '@/components/quotes/CustomerPicker';

export default function NewServiceOrderPage() {
  const router = useRouter();

  const [branches, setBranches] = useState<Array<{ id: string; name: string }>>([]);
  const [motorcycles, setMotorcycles] = useState<Array<{ id: string; brand: string; model: string; licensePlate?: string }>>([]);

  const [branchId, setBranchId] = useState('');
  // Cliente escolhido na busca (no servidor): a antiga lista fixa de 200
  // clientes era cortada em 100 pela API, então do 101º em diante não dava
  // para escolher.
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const customerId = customer?.id ?? '';
  const [motorcycleId, setMotorcycleId] = useState('');
  const [entryKilometer, setEntryKilometer] = useState('');
  const [fuelLevel, setFuelLevel] = useState('');
  const [visibleDamages, setVisibleDamages] = useState('');
  const [personalItems, setPersonalItems] = useState('');
  const [entryNotes, setEntryNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getBranches()
      .then((res) => setBranches(res?.data ?? []))
      .catch(() => setBranches([]));
  }, []);

  useEffect(() => {
    // Trocar de cliente sempre limpa a moto: uma moto do cliente anterior
    // ficaria selecionada em silêncio e a OS seria aberta com a moto errada.
    setMotorcycleId('');
    if (!customerId) {
      setMotorcycles([]);
      return;
    }
    let cancelled = false;
    api
      .getMotorcycles({ customerId, limit: 100 })
      .then((res) => {
        if (!cancelled) setMotorcycles(res.motorcycles ?? []);
      })
      .catch(() => {
        if (!cancelled) setMotorcycles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  async function handleSubmit() {
    setError(null);
    if (!branchId || !customerId || !motorcycleId || !entryKilometer) {
      setError('Filial, cliente, moto e quilometragem de entrada são obrigatórios');
      return;
    }
    setSaving(true);
    try {
      const os = await api.createServiceOrder({
        branchId,
        customerId,
        motorcycleId,
        entryKilometer: Number(entryKilometer),
        fuelLevel: fuelLevel || undefined,
        visibleDamages: visibleDamages || undefined,
        personalItems: personalItems || undefined,
        entryNotes: entryNotes || undefined,
      });
      router.push(`/dashboard/service-orders/${os.id}`);
    } catch (err: any) {
      setError(getApiErrorMessage(err, 'Erro ao abrir ordem de serviço'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/service-orders">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Nova Ordem de Serviço</h1>
          <p className="text-gray-500 mt-1">Registro de entrada do veículo na oficina.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Dados de entrada</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="space-y-1">
            <Label>Filial</Label>
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">Selecione...</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1">
            <p className="text-sm font-medium leading-none text-foreground">Cliente</p>
            <CustomerPicker value={customer} onChange={setCustomer} />
          </div>

          <div className="space-y-1">
            <Label>Moto</Label>
            <Select value={motorcycleId} onChange={(e) => setMotorcycleId(e.target.value)} disabled={!customerId}>
              <option value="">{customerId ? 'Selecione...' : 'Selecione o cliente primeiro'}</option>
              {motorcycles.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.brand} {m.model} {m.licensePlate ? `— ${m.licensePlate}` : ''}
                </option>
              ))}
            </Select>
            {customerId && motorcycles.length === 0 && (
              <p className="text-xs text-muted-foreground">Este cliente ainda não tem moto cadastrada.</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Quilometragem de entrada</Label>
              <Input type="number" value={entryKilometer} onChange={(e) => setEntryKilometer(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Nível de combustível (opcional)</Label>
              <Input value={fuelLevel} onChange={(e) => setFuelLevel(e.target.value)} placeholder="Ex: 1/2" />
            </div>
          </div>

          <div className="space-y-1">
            <Label>Avarias visíveis na entrada (opcional)</Label>
            <Input value={visibleDamages} onChange={(e) => setVisibleDamages(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Itens pessoais deixados no veículo (opcional)</Label>
            <Input value={personalItems} onChange={(e) => setPersonalItems(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Observações de entrada (opcional)</Label>
            <Input value={entryNotes} onChange={(e) => setEntryNotes(e.target.value)} />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Link href="/dashboard/service-orders">
              <Button variant="outline">Cancelar</Button>
            </Link>
            <Button onClick={handleSubmit} disabled={saving}>
              <Save className="h-4 w-4 mr-2" />
              {saving ? 'Abrindo...' : 'Abrir OS'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
