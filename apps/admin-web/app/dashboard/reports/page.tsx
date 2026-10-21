'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  FileSpreadsheet,
  FileText,
  Download,
  Calendar,
  TrendingUp,
  Package,
  Users,
  DollarSign,
} from 'lucide-react';

export default function ReportsPage() {
  const [reportType, setReportType] = useState('sales');
  const [format, setFormat] = useState('excel');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const reportCategories = [
    {
      title: 'Relatórios de Vendas',
      icon: TrendingUp,
      color: 'blue',
      reports: [
        {
          id: 'sales-daily',
          name: 'Vendas Diárias',
          description: 'Relatório detalhado de vendas por dia',
        },
        {
          id: 'sales-monthly',
          name: 'Vendas Mensais',
          description: 'Consolidado mensal de vendas',
        },
        {
          id: 'sales-period',
          name: 'Vendas por Período',
          description: 'Vendas em período personalizado',
        },
        {
          id: 'sales-product',
          name: 'Vendas por Produto',
          description: 'Ranking de produtos mais vendidos',
        },
        {
          id: 'sales-payment',
          name: 'Vendas por Forma de Pagamento',
          description: 'Análise por método de pagamento',
        },
      ],
    },
    {
      title: 'Relatórios Financeiros',
      icon: DollarSign,
      color: 'green',
      reports: [
        {
          id: 'financial-cashflow',
          name: 'Fluxo de Caixa',
          description: 'Entradas e saídas do caixa',
        },
        {
          id: 'financial-profit',
          name: 'Lucro e Margem',
          description: 'Análise de lucratividade',
        },
        {
          id: 'financial-receivables',
          name: 'Contas a Receber',
          description: 'Vendas pendentes de pagamento',
        },
        {
          id: 'financial-payables',
          name: 'Contas a Pagar',
          description: 'Compromissos financeiros',
        },
      ],
    },
    {
      title: 'Relatórios de Estoque',
      icon: Package,
      color: 'slate',
      reports: [
        {
          id: 'inventory-current',
          name: 'Inventário Atual',
          description: 'Estoque atual de todos os produtos',
        },
        {
          id: 'inventory-movement',
          name: 'Movimentação de Estoque',
          description: 'Entradas e saídas de produtos',
        },
        {
          id: 'inventory-low-stock',
          name: 'Produtos com Estoque Baixo',
          description: 'Alertas de reposição',
        },
        {
          id: 'inventory-valuation',
          name: 'Valorização de Estoque',
          description: 'Valor total do estoque',
        },
      ],
    },
    {
      title: 'Relatórios de Clientes',
      icon: Users,
      color: 'orange',
      reports: [
        {
          id: 'customer-ranking',
          name: 'Ranking de Clientes',
          description: 'Clientes que mais compraram',
        },
        {
          id: 'customer-inactive',
          name: 'Clientes Inativos',
          description: 'Clientes sem compras recentes',
        },
        {
          id: 'customer-new',
          name: 'Novos Clientes',
          description: 'Clientes cadastrados no período',
        },
        {
          id: 'customer-segment',
          name: 'Segmentação de Clientes',
          description: 'Análise por perfil e comportamento',
        },
      ],
    },
  ];

  // TODO: sem endpoint de geração de relatórios no backend ainda
  // (não existe GET/POST /reports/* na API). Até que esse endpoint exista,
  // mantemos a ação honesta ao invés de simular um sucesso falso.
  const handleGenerateReport = () => {
    alert(
      'Geração de relatórios ainda não está disponível: o backend não possui um endpoint de relatórios implementado.'
    );
  };

  const getIconColor = (color: string) => {
    const colors: Record<string, string> = {
      blue: 'text-foreground bg-muted',
      green: 'text-foreground bg-muted',
      slate: 'text-foreground bg-muted',
      orange: 'text-foreground bg-muted',
    };
    return colors[color] || colors.blue;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Relatórios</h1>
        <p className="text-muted-foreground mt-1">
          Gere relatórios personalizados para análise do seu negócio
        </p>
      </div>

      <Card className="border-warning/30 bg-warning-soft">
        <CardContent className="p-4 text-sm text-warning">
          Em desenvolvimento: o backend ainda não possui endpoints de geração de
          relatórios (Excel/PDF). Os botões abaixo ficam desabilitados até que essa
          funcionalidade exista na API.
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gerar Relatório Personalizado</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-2">
              <Label htmlFor="report-type">Tipo de Relatório</Label>
              <Select
                id="report-type"
                value={reportType}
                onChange={(e) => setReportType(e.target.value)}
              >
                <option value="sales">Vendas</option>
                <option value="financial">Financeiro</option>
                <option value="inventory">Estoque</option>
                <option value="customers">Clientes</option>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="format">Formato</Label>
              <Select
                id="format"
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="excel">Excel (.xlsx)</option>
                <option value="pdf">PDF</option>
                <option value="csv">CSV</option>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="start-date">Data Inicial</Label>
              <Input
                id="start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="end-date">Data Final</Label>
              <Input
                id="end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-6 flex gap-3">
            <Button onClick={handleGenerateReport} className="flex-1" disabled title="Em desenvolvimento">
              <Download className="h-4 w-4 mr-2" />
              Gerar Relatório (em breve)
            </Button>
            <Button variant="outline" disabled title="Em desenvolvimento">
              <Calendar className="h-4 w-4 mr-2" />
              Agendar
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
        {reportCategories.map((category) => {
          const Icon = category.icon;
          return (
            <div key={category.title}>
              <div className="flex items-center gap-3 mb-4">
                <div className={`p-2 rounded-lg ${getIconColor(category.color)}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <h2 className="text-xl font-semibold text-foreground">
                  {category.title}
                </h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {category.reports.map((report) => (
                  <Card
                    key={report.id}
                    className="hover:shadow-md transition-shadow cursor-pointer"
                  >
                    <CardContent className="p-6">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1">
                          <h3 className="font-semibold text-foreground mb-1">
                            {report.name}
                          </h3>
                          <p className="text-sm text-muted-foreground">
                            {report.description}
                          </p>
                        </div>
                      </div>
                      <div className="flex gap-2 mt-4">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          disabled
                          title="Em desenvolvimento: sem endpoint de relatórios na API"
                          onClick={() => {
                            setReportType(report.id);
                            handleGenerateReport();
                          }}
                        >
                          <FileSpreadsheet className="h-4 w-4 mr-1" />
                          Excel
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          disabled
                          title="Em desenvolvimento: sem endpoint de relatórios na API"
                          onClick={() => {
                            setReportType(report.id);
                            setFormat('pdf');
                            handleGenerateReport();
                          }}
                        >
                          <FileText className="h-4 w-4 mr-1" />
                          PDF
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <Card className="border-border bg-muted">
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="p-3 bg-muted rounded-lg">
              <Calendar className="h-6 w-6 text-foreground" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-foreground mb-2">
                Relatórios Agendados
              </h3>
              <p className="text-sm text-foreground mb-4">
                Configure relatórios para serem gerados automaticamente e
                enviados por email em períodos específicos.
              </p>
              <Button variant="outline" size="sm" disabled title="Em desenvolvimento">
                Configurar Agendamentos (em breve)
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
