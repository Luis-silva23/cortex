'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Building2, CalendarClock, Info, Plus, Users } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getApiErrorMessage } from '@/lib/errors';
import { isCompanyAdminOrAbove } from '@/lib/role-gates';
import { useUserType } from '@/lib/hooks/useUserType';
import { BranchScopePicker } from '@/components/agreements/BranchScopePicker';
import {
  agreementsApi,
  AgreementCompany,
  brl,
  COMPANY_STATUS_LABEL,
  DEDUCTION_STATUS_LABEL,
  EMPLOYEE_STATUS_LABEL,
  EmployeeList,
  formatCompetence,
  Payroll,
  shiftCompetence,
} from '@/lib/api/agreements';

// Convênios: (A) de FUNCIONÁRIO — compra com desconto em folha; (B) com EMPRESA EXTERNA — venda a prazo que gera conta a
// receber. Não confundir com "Descontos › convênio/parceiro de desconto", que só dá desconto na venda.
export default function AgreementsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Convênios</h1>
        <p className="mt-1 text-muted-foreground">
          Convênio de funcionário (desconto em folha) e convênio com empresa externa (venda a prazo → contas a receber).
        </p>
      </div>
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Não é o convênio de desconto</AlertTitle>
        <AlertDescription>
          O &quot;convênio/parceiro de desconto&quot; (tela Descontos) só concede desconto na venda. Aqui a compra é paga depois: pelo
          funcionário em folha, ou pela empresa conveniada no vencimento. Habilite cada tipo em Configurações › Políticas.
        </AlertDescription>
      </Alert>
      <Tabs defaultValue="employees">
        <TabsList>
          <TabsTrigger value="employees">
            <Users className="mr-1 inline h-4 w-4" /> Funcionários
          </TabsTrigger>
          <TabsTrigger value="companies">
            <Building2 className="mr-1 inline h-4 w-4" /> Empresas conveniadas
          </TabsTrigger>
          <TabsTrigger value="payroll">
            <CalendarClock className="mr-1 inline h-4 w-4" /> Folha (competência)
          </TabsTrigger>
        </TabsList>
        <TabsContent value="employees">
          <EmployeesPanel />
        </TabsContent>
        <TabsContent value="companies">
          <CompaniesPanel />
        </TabsContent>
        <TabsContent value="payroll">
          <PayrollPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="p-10 text-center">
      <AlertCircle className="mx-auto mb-3 h-10 w-10 text-danger" />
      <p className="mb-4 text-muted-foreground">{message}</p>
      <Button variant="outline" onClick={onRetry}>
        Tentar novamente
      </Button>
    </Card>
  );
}

const statusVariant = (s: string) => (s === 'ACTIVE' ? 'success' : s === 'BLOCKED' ? 'error' : 'secondary');

// ---------------------------------------------------------------- Funcionários
function EmployeesPanel() {
  const [data, setData] = useState<EmployeeList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', cpf: '', registration: '', salary: '', ownLimit: false, limitType: 'FIXED', limitValue: '' });
  const [branchIds, setBranchIds] = useState<string[]>([]);
  // Autorizar convênio (cadastrar, limite, filiais) é da administração; a gerência consulta (a API decide).
  const { userType } = useUserType();
  const canAuthorize = isCompanyAdminOrAbove(userType);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setError(null);
    agreementsApi
      .listEmployees({ q: q || undefined })
      .then(setData)
      .catch((e) => setError(getApiErrorMessage(e, 'Não foi possível carregar os funcionários conveniados.')));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setFormError(null);
    setSaving(true);
    try {
      await agreementsApi.createEmployee({
        name: form.name,
        cpf: form.cpf,
        registration: form.registration || null,
        salary: form.salary ? Number(form.salary) : null,
        limitType: form.ownLimit ? form.limitType : null,
        limitValue: form.ownLimit && form.limitValue ? Number(form.limitValue) : null,
        allowedBranchIds: branchIds,
      });
      setBranchIds([]);
      setOpen(false);
      setForm({ name: '', cpf: '', registration: '', salary: '', ownLimit: false, limitType: 'FIXED', limitValue: '' });
      load();
    } catch (e) {
      setFormError(getApiErrorMessage(e, 'Erro ao cadastrar'));
    } finally {
      setSaving(false);
    }
  }

  if (error) return <ErrorCard message={error} onRetry={load} />;
  const policy = data?.policy;
  return (
    <div className="space-y-4">
      {policy && (
        <p className="text-sm text-muted-foreground">
          Política: {policy.enabled ? 'habilitado' : <strong className="text-danger">desabilitado (o PDV recusa)</strong>} · limite padrão{' '}
          {policy.limitType === 'FIXED' ? brl(policy.limitValue) : `${policy.limitValue}% do salário`} por mês · até {policy.maxInstallments}x em folha ·
          competência {data ? formatCompetence(data.competence) : ''}. A empresa deve respeitar a legislação trabalhista aplicável.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
        >
          <Input placeholder="Nome, CPF ou matrícula" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
          <Button type="submit" variant="outline">
            Buscar
          </Button>
        </form>
        {canAuthorize ? (
          <Button onClick={() => setOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> Novo funcionário conveniado
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Cadastrar e autorizar convênio é da administração da empresa.</p>
        )}
      </div>
      <Card>
        {!data ? (
          <div className="p-10 text-center text-muted-foreground">Carregando...</div>
        ) : data.data.length === 0 ? (
          <div className="p-10 text-center text-muted-foreground">Nenhum funcionário conveniado.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Funcionário</TableHead>
                <TableHead>CPF</TableHead>
                <TableHead>Matrícula</TableHead>
                <TableHead>Limite do mês</TableHead>
                <TableHead>Utilizado</TableHead>
                <TableHead>Disponível</TableHead>
                <TableHead>Situação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">
                    <Link className="text-primary hover:underline" href={`/dashboard/agreements/employees/${e.id}`}>
                      {e.name}
                    </Link>
                  </TableCell>
                  <TableCell>{e.cpf}</TableCell>
                  <TableCell>{e.registration ?? '—'}</TableCell>
                  <TableCell>
                    {brl(e.limit)}
                    <span className="block text-xs text-muted-foreground">{e.effectiveLimit.source === 'AGREEMENT' ? 'limite próprio' : 'política'}</span>
                  </TableCell>
                  <TableCell>{brl(e.used)}</TableCell>
                  <TableCell className="font-semibold">{brl(e.available)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(e.status) as any}>{EMPLOYEE_STATUS_LABEL[e.status]}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Novo funcionário conveniado</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {formError && <p className="text-sm text-danger">{formError}</p>}
            <div className="space-y-1">
              <Label htmlFor="emp-name">Nome</Label>
              <Input id="emp-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="emp-cpf">CPF</Label>
                <Input id="emp-cpf" value={form.cpf} onChange={(e) => setForm({ ...form, cpf: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="emp-reg">Matrícula</Label>
                <Input id="emp-reg" value={form.registration} onChange={(e) => setForm({ ...form, registration: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="emp-salary">Salário (usado no limite por % do salário; visível só para gerência)</Label>
              <Input id="emp-salary" type="number" step="0.01" value={form.salary} onChange={(e) => setForm({ ...form, salary: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.ownLimit} onChange={(e) => setForm({ ...form, ownLimit: e.target.checked })} />
              Limite próprio (senão segue a política da empresa)
            </label>
            {form.ownLimit && (
              <div className="grid grid-cols-2 gap-3">
                <Select value={form.limitType} onChange={(e) => setForm({ ...form, limitType: e.target.value })}>
                  <option value="FIXED">Valor fixo (R$/mês)</option>
                  <option value="SALARY_PERCENT">% do salário/mês</option>
                </Select>
                <Input type="number" step="0.01" placeholder="Valor" value={form.limitValue} onChange={(e) => setForm({ ...form, limitValue: e.target.value })} />
              </div>
            )}
            <BranchScopePicker value={branchIds} onChange={setBranchIds} idPrefix="emp-branch" />
            <p className="text-xs text-muted-foreground">
              Registre a autorização de desconto em folha assinada pelo funcionário. A empresa deve respeitar a legislação trabalhista aplicável.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
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

// ---------------------------------------------------------------- Empresas conveniadas
const EMPTY_COMPANY = {
  legalName: '',
  tradeName: '',
  cnpj: '',
  contactName: '',
  phone: '',
  whatsapp: '',
  email: '',
  street: '',
  number: '',
  district: '',
  city: '',
  state: '',
  zipCode: '',
  commercialTerms: '',
  creditLimit: '',
  monthlyLimit: '',
  term: '30',
  customTerm: '',
  interestPercentMonthly: '',
  finePercent: '',
  blockAfterDaysOverdue: '',
};

function CompaniesPanel() {
  const [rows, setRows] = useState<AgreementCompany[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_COMPANY);
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const { userType } = useUserType();
  const canAuthorize = isCompanyAdminOrAbove(userType);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setError(null);
    agreementsApi
      .listCompanies()
      .then(setRows)
      .catch((e) => setError(getApiErrorMessage(e, 'Não foi possível carregar as empresas conveniadas.')));
  };
  useEffect(load, []);

  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  async function save() {
    setFormError(null);
    setSaving(true);
    try {
      const { term, customTerm, creditLimit, monthlyLimit, interestPercentMonthly, finePercent, blockAfterDaysOverdue, ...text } = form;
      await agreementsApi.createCompany({
        ...text,
        paymentTermDays: Number(term === 'custom' ? customTerm : term),
        creditLimit: num(creditLimit),
        monthlyLimit: num(monthlyLimit),
        interestPercentMonthly: num(interestPercentMonthly),
        finePercent: num(finePercent),
        blockAfterDaysOverdue: num(blockAfterDaysOverdue),
        allowedBranchIds: branchIds,
      });
      setOpen(false);
      setForm(EMPTY_COMPANY);
      setBranchIds([]);
      load();
    } catch (e) {
      setFormError(getApiErrorMessage(e, 'Erro ao cadastrar'));
    } finally {
      setSaving(false);
    }
  }
  const field = (key: keyof typeof EMPTY_COMPANY, label: string, props: Record<string, unknown> = {}) => (
    <div className="space-y-1">
      <Label htmlFor={`ac-${key}`}>{label}</Label>
      <Input id={`ac-${key}`} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} {...props} />
    </div>
  );

  if (error) return <ErrorCard message={error} onRetry={load} />;
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {canAuthorize ? (
          <Button onClick={() => setOpen(true)}>
            <Plus className="mr-2 h-4 w-4" /> Nova empresa conveniada
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">Cadastrar e autorizar empresa conveniada é da administração da empresa.</p>
        )}
      </div>
      <Card>
        {!rows ? (
          <div className="p-10 text-center text-muted-foreground">Carregando...</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-muted-foreground">Nenhuma empresa conveniada.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Empresa</TableHead>
                <TableHead>CNPJ</TableHead>
                <TableHead>Prazo</TableHead>
                <TableHead>Em aberto</TableHead>
                <TableHead>Vencido</TableHead>
                <TableHead>Disponível</TableHead>
                <TableHead>Situação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    <Link className="text-primary hover:underline" href={`/dashboard/agreements/companies/${c.id}`}>
                      {c.tradeName || c.legalName}
                    </Link>
                    {c.tradeName && <span className="block text-xs text-muted-foreground">{c.legalName}</span>}
                  </TableCell>
                  <TableCell>{c.cnpj}</TableCell>
                  <TableCell>{c.paymentTermDays} dias</TableCell>
                  <TableCell>{brl(c.financials?.openBalance ?? 0)}</TableCell>
                  <TableCell className={c.financials?.overdueAmount ? 'font-semibold text-danger' : ''}>
                    {brl(c.financials?.overdueAmount ?? 0)}
                    {c.financials?.maxDaysOverdue ? <span className="block text-xs">{c.financials.maxDaysOverdue} dias de atraso</span> : null}
                  </TableCell>
                  <TableCell>{brl(c.financials?.available ?? null)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(c.status) as any}>{COMPANY_STATUS_LABEL[c.status]}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nova empresa conveniada</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {formError && <p className="text-sm text-danger">{formError}</p>}
            {field('legalName', 'Razão social')}
            <div className="grid grid-cols-2 gap-3">
              {field('tradeName', 'Nome fantasia')}
              {field('cnpj', 'CNPJ')}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {field('contactName', 'Responsável')}
              {field('phone', 'Telefone')}
              {field('whatsapp', 'WhatsApp (DDD + número)')}
              {field('email', 'E-mail', { type: 'email' })}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {field('street', 'Rua')}
              {field('number', 'Número')}
              {field('district', 'Bairro')}
              {field('city', 'Cidade')}
              {field('state', 'UF', { maxLength: 2 })}
              {field('zipCode', 'CEP')}
            </div>
            {field('commercialTerms', 'Condições comerciais')}
            <div className="grid grid-cols-2 gap-3">
              {field('creditLimit', 'Limite de crédito (R$, vazio = sem limite)', { type: 'number', step: '0.01' })}
              {field('monthlyLimit', 'Limite mensal (R$, vazio = sem limite)', { type: 'number', step: '0.01' })}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="ac-term">Prazo de pagamento</Label>
                <Select id="ac-term" value={form.term} onChange={(e) => setForm({ ...form, term: e.target.value })}>
                  <option value="10">10 dias</option>
                  <option value="15">15 dias</option>
                  <option value="30">30 dias</option>
                  <option value="custom">Personalizado</option>
                </Select>
              </div>
              {form.term === 'custom' && field('customTerm', 'Dias', { type: 'number' })}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {field('finePercent', 'Multa (%)', { type: 'number', step: '0.01' })}
              {field('interestPercentMonthly', 'Juros ao mês (%)', { type: 'number', step: '0.01' })}
              {field('blockAfterDaysOverdue', 'Bloquear após X dias de atraso', { type: 'number' })}
            </div>
            <BranchScopePicker value={branchIds} onChange={setBranchIds} idPrefix="ac-branch" />
            <p className="text-xs text-muted-foreground">
              Juros e multa são exibidos só como informação sobre o atraso — não são lançados na conta. Bloqueio vazio segue a política da empresa
              (vazio na política = só bloqueio manual).
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
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

// ---------------------------------------------------------------- Folha por competência
function PayrollPanel() {
  const [competence, setCompetence] = useState<string | undefined>(undefined);
  const [data, setData] = useState<Payroll | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = (c = competence) => {
    setError(null);
    agreementsApi
      .payroll(c)
      .then((d) => {
        setData(d);
        setCompetence(d.competence);
      })
      .catch((e) => setError(getApiErrorMessage(e, 'Não foi possível carregar a folha.')));
  };
  useEffect(() => load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function process(id: string) {
    setBusy(id);
    try {
      await agreementsApi.processDeduction(id);
      load();
    } catch (e) {
      alert(getApiErrorMessage(e, 'Erro ao dar baixa'));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorCard message={error} onRetry={() => load()} />;
  if (!data) return <Card className="p-10 text-center text-muted-foreground">Carregando...</Card>;
  const canProcess = data.competence <= data.currentCompetence;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => load(shiftCompetence(data.competence, -1))}>
          ‹ Anterior
        </Button>
        <span className="text-lg font-semibold">Competência {formatCompetence(data.competence)}</span>
        <Button variant="outline" onClick={() => load(shiftCompetence(data.competence, 1))}>
          Próxima ›
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          Previsto {brl(data.totals.scheduled)} · Descontado {brl(data.totals.deducted)} · Cancelado {brl(data.totals.cancelled)}
        </span>
      </div>
      {!canProcess && <p className="text-sm text-muted-foreground">Competência futura: as parcelas só podem ser baixadas a partir do mês delas.</p>}
      <Card>
        {data.items.length === 0 ? (
          <div className="p-10 text-center text-muted-foreground">Nenhuma parcela nesta competência.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Funcionário</TableHead>
                <TableHead>Matrícula</TableHead>
                <TableHead>Venda</TableHead>
                <TableHead>Parcela</TableHead>
                <TableHead>Valor</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead>Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium">
                    {i.employee.name}
                    <span className="block text-xs text-muted-foreground">{i.employee.cpfMasked}</span>
                  </TableCell>
                  <TableCell>{i.employee.registration ?? '—'}</TableCell>
                  <TableCell>{i.saleNumber ? `#${i.saleNumber}` : '—'}</TableCell>
                  <TableCell>
                    {i.installmentNumber}/{i.installments}
                  </TableCell>
                  <TableCell>{brl(i.amount)}</TableCell>
                  <TableCell>
                    <Badge variant={i.status === 'DEDUCTED' ? 'success' : i.status === 'CANCELLED' ? 'secondary' : 'warning'}>{DEDUCTION_STATUS_LABEL[i.status]}</Badge>
                    {i.chargeCancelled && i.status === 'DEDUCTED' && <span className="block text-xs text-danger">venda cancelada: a compensar</span>}
                  </TableCell>
                  <TableCell>
                    {i.status === 'SCHEDULED' && canProcess && (
                      <Button size="sm" onClick={() => process(i.id)} disabled={busy === i.id}>
                        Dar baixa (descontado na folha)
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
