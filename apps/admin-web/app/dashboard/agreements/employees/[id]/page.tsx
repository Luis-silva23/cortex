'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getApiErrorMessage } from '@/lib/errors';
import { agreementsApi, brl, DEDUCTION_STATUS_LABEL, EMPLOYEE_STATUS_LABEL, EmployeeDetail, formatCompetence } from '@/lib/api/agreements';

export default function EmployeeAgreementPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<EmployeeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    agreementsApi
      .getEmployee(params.id)
      .then(setData)
      .catch((e) => setError(getApiErrorMessage(e, 'Não foi possível carregar o funcionário conveniado.')));
  useEffect(() => {
    load();
  }, [params.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function changeStatus(status: string) {
    setSaving(true);
    try {
      setData(await agreementsApi.updateEmployee(params.id, { status }));
    } catch (e) {
      alert(getApiErrorMessage(e, 'Erro ao alterar a situação'));
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p className="text-danger">{error}</p>;
  if (!data) return <p className="text-muted-foreground">Carregando...</p>;
  return (
    <div className="space-y-6">
      <Link href="/dashboard/agreements" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-1 h-4 w-4" /> Convênios
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{data.name}</h1>
          <p className="text-muted-foreground">
            CPF {data.cpf} · Matrícula {data.registration ?? '—'} · Salário {data.salary == null ? '—' : brl(data.salary)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={data.status} onChange={(e) => changeStatus(e.target.value)} disabled={saving} aria-label="Situação do convênio">
            {Object.entries(EMPLOYEE_STATUS_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Link href={`/dashboard/agreements/employees/${data.id}/statement`}>
            <Button variant="outline">
              <Printer className="mr-2 h-4 w-4" /> Espelho do funcionário
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Kpi label={`Limite de ${formatCompetence(data.competence)}`} value={brl(data.limit)} hint={data.effectiveLimit.source === 'AGREEMENT' ? 'limite próprio' : 'política da empresa'} />
        <Kpi label="Utilizado no mês" value={brl(data.used)} />
        <Kpi label="Disponível" value={brl(data.available)} strong />
        <Kpi label="Previsto em folha (saldo)" value={brl(data.scheduledBalance)} hint={`até ${data.maxInstallments}x`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Compras pelo convênio e parcelas em folha</CardTitle>
        </CardHeader>
        <CardContent>
          {data.charges.length === 0 ? (
            <p className="text-muted-foreground">Nenhuma compra pelo convênio.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Venda</TableHead>
                  <TableHead>Valor</TableHead>
                  <TableHead>Parcelas (competência · valor · situação)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.charges.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{new Date(c.createdAt).toLocaleDateString('pt-BR')}</TableCell>
                    <TableCell>
                      {c.saleNumber ? `#${c.saleNumber}` : '—'}
                      {c.cancelledAt && <Badge variant="secondary" className="ml-2">venda cancelada/devolvida</Badge>}
                      {c.toCompensate > 0 && <span className="block text-xs text-danger">A compensar: {brl(c.toCompensate)} (já descontado em folha)</span>}
                    </TableCell>
                    <TableCell>{brl(c.amount)}</TableCell>
                    <TableCell>
                      <ul className="space-y-1 text-sm">
                        {c.deductions.map((d) => (
                          <li key={d.id}>
                            {d.installmentNumber}/{c.installments} · {formatCompetence(d.competence)} · {brl(d.amount)} ·{' '}
                            <Badge variant={d.status === 'DEDUCTED' ? 'success' : d.status === 'CANCELLED' ? 'secondary' : 'warning'}>{DEDUCTION_STATUS_LABEL[d.status]}</Badge>
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={`text-2xl text-foreground ${strong ? 'font-extrabold' : 'font-bold'}`}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}
