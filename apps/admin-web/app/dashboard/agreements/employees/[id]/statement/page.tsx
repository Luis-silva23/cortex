'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getApiErrorMessage } from '@/lib/errors';
import { agreementsApi, brl, DEDUCTION_STATUS_LABEL, formatCompetence, Statement } from '@/lib/api/agreements';

// Espelho/comprovante do convênio do funcionário numa competência — página para imprimir e entregar ao funcionário.
export default function EmployeeStatementPage() {
  const params = useParams() as { id: string };
  const [competence, setCompetence] = useState('');
  const [data, setData] = useState<Statement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (c?: string) =>
    agreementsApi
      .statement(params.id, c || undefined)
      .then((s) => {
        setData(s);
        setCompetence(s.competence);
        setError(null);
      })
      .catch((e) => setError(getApiErrorMessage(e, 'Não foi possível carregar o espelho.')));
  useEffect(() => {
    load();
  }, [params.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="text-danger">{error}</p>;
  if (!data) return <p className="text-muted-foreground">Carregando...</p>;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link href={`/dashboard/agreements/employees/${params.id}`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" /> Voltar
        </Link>
        <Input type="month" value={competence} onChange={(e) => setCompetence(e.target.value)} className="ml-auto w-44" aria-label="Competência" />
        <Button variant="outline" onClick={() => load(competence)}>
          Ver competência
        </Button>
        <Button onClick={() => window.print()}>
          <Printer className="mr-2 h-4 w-4" /> Imprimir
        </Button>
      </div>

      <article className="space-y-4 rounded-lg border border-border bg-card p-6 text-card-foreground print:border-0 print:p-0">
        <header className="border-b border-border pb-3">
          <p className="text-sm text-muted-foreground">{data.company?.legalName || data.company?.name}</p>
          <h1 className="text-xl font-bold">Espelho do convênio de funcionário — competência {formatCompetence(data.competence)}</h1>
          <p className="text-sm">
            {data.employee.name} · CPF {data.employee.cpf} · Matrícula {data.employee.registration ?? '—'}
          </p>
        </header>

        <section className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-muted-foreground">Limite do mês</p>
            <p className="font-semibold">{brl(data.limit)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Utilizado</p>
            <p className="font-semibold">{brl(data.used)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Disponível</p>
            <p className="font-semibold">{brl(data.available)}</p>
          </div>
        </section>

        <table className="w-full text-sm [&_td]:pr-3 [&_th]:pr-3">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="py-1">Data</th>
              <th>Venda / itens</th>
              <th>Compra</th>
              <th>Parcela</th>
              <th className="text-right">Desconto</th>
              <th>Situação</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.length === 0 && (
              <tr>
                <td colSpan={6} className="py-3 text-center text-muted-foreground">
                  Nenhum desconto nesta competência.
                </td>
              </tr>
            )}
            {data.lines.map((l) => (
              <tr key={l.deductionId} className="border-b border-border align-top">
                <td className="py-1">{new Date(l.purchaseDate).toLocaleDateString('pt-BR')}</td>
                <td>
                  {l.saleNumber ? `#${l.saleNumber}` : '—'}
                  <ul className="text-xs text-muted-foreground">
                    {l.items.map((i, idx) => (
                      <li key={idx}>
                        {i.quantity} × {i.productName} — {brl(i.totalPrice)}
                      </li>
                    ))}
                  </ul>
                </td>
                <td>{brl(l.purchaseAmount)}</td>
                <td>
                  {l.installmentNumber}/{l.installments}
                </td>
                <td className="text-right">{brl(l.amount)}</td>
                <td>
                  {DEDUCTION_STATUS_LABEL[l.status]}
                  {l.chargeCancelled && <span className="block text-xs">venda cancelada</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="text-sm">
          <p>
            Previsto nesta competência: <strong>{brl(data.totals.scheduled)}</strong> · Já descontado: <strong>{brl(data.totals.deducted)}</strong> · Parcelas
            futuras (saldo): <strong>{brl(data.futureScheduled)}</strong>
          </p>
        </section>

        <footer className="space-y-6 border-t border-border pt-3 text-xs text-muted-foreground">
          <p>{data.legalNotice}</p>
          <p>Emitido em {new Date(data.generatedAt).toLocaleString('pt-BR')}</p>
          <div className="grid grid-cols-2 gap-8 pt-6">
            <p className="border-t border-foreground pt-1 text-center">Funcionário</p>
            <p className="border-t border-foreground pt-1 text-center">Empresa</p>
          </div>
        </footer>
      </article>
    </div>
  );
}
