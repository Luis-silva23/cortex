'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Building2, Key, Monitor, Users } from 'lucide-react';
import api from '@/lib/api';

export default function DashboardPage() {
  const [stats, setStats] = useState({
    companies: 0,
    licenses: 0,
    devices: 0,
    users: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function loadStats() {
      try {
        // /users é paginado (20 por página): o total real vem de `pagination.total`, não de `data.length`
        // (antes o painel mostrava 20 mesmo com 37 usuários). `limit=1` evita trazer as linhas à toa.
        const [companiesRes, licensesRes, usersRes] = await Promise.all([
          api.get('/companies'),
          api.get('/licenses'),
          api.get('/users', { params: { page: 1, limit: 1 } }),
        ]);

        setStats({
          companies: companiesRes.data.data.length,
          licenses: licensesRes.data.data.length,
          devices: licensesRes.data.data.reduce(
            (acc: number, license: any) => acc + (license._count?.devices || 0),
            0
          ),
          users: usersRes.data.pagination?.total ?? usersRes.data.data.length,
        });
      } catch (err: any) {
        console.error('Error loading stats:', err);
        setError(err.response?.data?.error || 'Erro ao carregar os indicadores');
      } finally {
        setLoading(false);
      }
    }

    loadStats();
  }, []);

  // Cor de KPI/ícone é neutra (regra CÓRTEX): verde/amarelo/vermelho só para status.
  const cards = [
    { title: 'Empresas', value: stats.companies, icon: Building2 },
    { title: 'Licenças', value: stats.licenses, icon: Key },
    { title: 'Dispositivos', value: stats.devices, icon: Monitor },
    { title: 'Usuários', value: stats.users, icon: Users },
  ];

  if (loading) {
    return <div>Carregando...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">Visão geral do sistema</p>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.title}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
              <card.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{card.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
