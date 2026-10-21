# Frontends web e desktop

Portas, títulos e marca de cada app: [VISUAL_REFERENCES](VISUAL_REFERENCES.md). Em todos: a autorização real é da API
(esconder botão é conforto); mensagens de erro chegam em português; `/auth/*` fica fora do "renova e repete" e a
renovação do token é única por vez (single-flight).

## Admin Web (`apps/admin-web`, Next 14, porta 3002)

Painel da empresa: dashboard por perfil, clientes, motos, produtos, estoque (inventário, transferências, avarias),
vendas, OS, orçamentos, compras, fornecedores, financeiro, fiscal, pós-venda (revisões, contatos, agenda), relatórios
(tela honesta: "em desenvolvimento", sem geração no servidor), usuários, filiais, descontos e configurações (módulos,
pagamentos/cédulas).

- **Gates de tela:** `RoleGate`/`ModuleGate` (`components/layout/DashboardShell.tsx`) — URL digitada de tela proibida ou
  de módulo desligado mostra "Acesso restrito"/"Módulo desativado" (a API responde 403 de qualquer forma).
- **Importação por planilha** (`components/import/ExcelImportDialog.tsx`, `lib/excel-parser.ts`): XLSX e CSV (UTF-8 ou
  Windows-1252, `;` ou `,`), vírgula decimal, CPF/CNPJ com dígito verificador, modelos para baixar, avisos e erros por
  linha vindos do servidor. Regras: [BUSINESS_RULES](BUSINESS_RULES.md#importação-produtos-clientes-estoque).
- **Pós-venda:** confirmar agendamento pede "Quem confirmou" e o canal.
- **Design system CÓRTEX:** tokens em `app/globals.css`/`tailwind.config.js`/`lib/theme.ts`, tema claro/escuro,
  Montserrat, 404 própria; guardas automáticas em `lib/design-*.test.ts` (paleta, cores proibidas, KPIs neutros, moeda só
  por `formatCurrency`, identidade dos apps).
- **Gráficos** (`components/charts/`, recharts) — padrão único, ver o [mapa de gráficos](#mapa-de-gráficos): **evolução no tempo = Linha | Colunas, abrindo em LINHA**, sempre pelo mesmo
  componente `TimeSeriesChart` (uma ou várias séries; padrão e ordem em `lib/chart-mode.ts`; alternância `ChartModeToggle`: mesma série, mesmo período e filtros, troca só de estado local — sem nova
  chamada à API nem recarga; eixo X em escala de tempo, pontos vazados e segmentos retos na linha, colunas lado a lado com várias séries) e **comparação entre categorias = barras horizontais de uma
  cor** (`CategoryBarChart`), **sem** alternância: categorias não têm ordem, então uma linha entre elas não teria leitura válida. Dica própria em `ChartTooltip`; cores só por tokens, claro e escuro;
  sem paleta categórica. No **painel gerencial** (Administrador e Gerente) a evolução vem de `GET /api/dashboard/management/timeseries` (dia sem venda é zero; ticket sem venda interrompe a linha — decisão 74); nos
  painéis antigos (SUPER_ADMIN em contexto de empresa) a receita ainda vem de `timeline` em `GET /api/dashboard/sales` e `/ceo` (soma real por dia; sem dado, estado vazio — nada é inventado) e `RevenueTimeChart` só adapta essa série
  (moeda e dia pronto). Guardas: `lib/chart-mode.test.ts` (padrão Linha) e `lib/chart-parity.test.ts` (os arquivos compartilhados são idênticos no Admin Web e no Super Admin; nenhum gráfico
  temporal avulso; biblioteca de gráfico só em `components/charts`).
- **Fuso do painel (decisão 58):** o dia é o de Brasília (`America/Sao_Paulo`). A API agrupa as séries por dia e devolve `YYYY-MM-DD` pronto (`apps/api/src/utils/time-zone.ts`); o front só calcula
  o início de "Hoje" e do mês no mesmo fuso (`lib/time-zone.ts`) e não reconverte as datas da API.
- Testes: `cd apps/admin-web && npx jest` (lógica em `lib/**/*.test.ts`, sem navegador); `npx tsc --noEmit`.
- Para capturas de tela em máquina limitada: `NEXT_BUILD_CPUS=2 npx next build` + `npx next start -p 3002` em vez de `next dev` (que chegou a ~1 GB).
- **[LIMITAÇÃO]** `next build` ignora erros de tipo e lint (`next.config.js`); o `tsc --noEmit` roda à parte
  ([ROADMAP](ROADMAP.md)). Sem testes de componente/E2E no repositório: as jornadas são validadas no navegador real com
  scripts Playwright da rodada (evidências em `docs/evidencias/`).

## Mapa de gráficos

Auditoria de 2026-10-04: **10 gráficos** (6 temporais, 4 categóricos); PDV, mobile e TV não têm gráficos. Perfil de acesso só muda os dados, nunca o componente.

| # | Gráfico | Onde / perfil | Natureza | Componente | Modo |
|---|---|---|---|---|---|
| 1 | Evolução da receita *(2026-10-05: no painel gerencial de Administrador e Gerente é o `TimeSeriesChart` direto, com Receita/Vendas/Ticket; `RevenueTimeChart` segue no painel de Super Admin em contexto de empresa)* | Admin Web, painel: Administrador/CEO, Gerente, Super Admin em contexto de empresa | temporal | `TimeSeriesChart` (gerencial) · `RevenueTimeChart` → `TimeSeriesChart` (Super Admin) | **Linha** (padrão) ↔ Colunas |
| 2 | Vendas por forma de pagamento *(2026-10-05: no painel gerencial virou o painel "Formas de pagamento", com cartões e barras de participação; não é mais um gráfico)* | Admin Web, painel: Administrador, Gerente | categórico | `PaymentMethodsPanel` (gerencial) | cartões |
| 3 | Receita por filial | Admin Web, painel: Administrador (multi-filial), Super Admin em contexto | categórico | `CategoryBarChart` | barras |
| 3b | Origem das vendas *(novo, 2026-10-05)* | Admin Web, painel gerencial | categórico (e temporal por origem com 2+ origens) | `DonutChart` + tabela · `TimeSeriesChart` | donut; Linha ↔ Colunas na evolução por origem |
| 4 | Formas de pagamento de hoje | Admin Web, painel: Operador, Visualizador | categórico | `CategoryBarChart` | barras |
| 5–8 | Latência da API; requisições e erros 5xx; CPU, RAM e disco; rede (latência e perda) | Super Admin › empresa › filial (monitoramento) | temporais, 2–3 séries | `TimeSeriesChart` | **Linha** (padrão) ↔ Colunas |
| 9 | Requisições ao longo do tempo | Super Admin › observabilidade › performance | temporal | `TimeSeriesChart` | **Linha** (padrão) ↔ Colunas |
| 10 | Distribuição de status HTTP | Super Admin › observabilidade › performance | categórico (cor semântica por status) | `BarChart` próprio | barras (sem alternância) |

Operador e Visualizador não têm gráfico temporal; quando tiverem, usam o mesmo componente. O #10 não passou pelo visual do `CategoryBarChart` porque tem cor por status (2xx, 3xx, 4xx e 5xx são estados, o único uso permitido de cor semântica);
unificar só o desenho dele (grade e dica) fica como melhoria opcional.

## Super Admin (`apps/super-admin`, Next 14, porta 3000)

Operação da plataforma: empresas, licenças, usuários, dispositivos (ativação por MAC), backup, auditoria, observabilidade
e **monitoramento** (Empresas → Empresa → Filiais → Filial com séries de 24 h, saúde de banco/cache/filas/jobs, alertas
ativos, incidentes, página de **limites** com histórico e restauração ao padrão). Login com desafio MFA; tema escuro;
menu em gaveta abaixo de 768 px.

- **Console de Suporte** (`app/dashboard/support/**`, grupo "Suporte" no menu): painel, chamados (atribuir, situação,
  prioridade, resposta, anexos, histórico), base de conhecimento (listar, criar, editar, publicar), categorias e
  responsáveis (somente leitura). Sem tela de configurações: o backend não tem endpoint ([ROADMAP](ROADMAP.md)).
  Regras: [SUPPORT](SUPPORT.md).
- **Dashboard gerencial** (`app/dashboard/page.tsx` → `components/dashboard/ManagementDashboard`): Administrador e Gerente. O período (seletor com recortes e intervalo personalizado) é enviado como **nome do recorte** a todas as chamadas; quem calcula as datas é a API (`dashboard-period.ts`), e um teste impede conta de data nos componentes. Linha ↔ Colunas e a métrica (Receita, Vendas, Ticket médio) são estado local, sem nova chamada. Donut de origem em `components/charts/DonutChart.tsx` (tons da família do tema). Tela de canais em `app/dashboard/channels` (menu "Canais de venda", só Administrador, só com o módulo CANAIS ligado). Ver [DASHBOARD_GERENCIAL](DASHBOARD_GERENCIAL.md).
- **Gráficos temporais** (monitoramento da filial e performance): o mesmo `TimeSeriesChart` do Admin Web (cópia idêntica, travada por `lib/chart-parity.test.ts` do Admin Web), Linha por
  padrão e Colunas como alternativa; tokens próprios em `lib/chart-theme.ts`; rótulos de tempo no fuso de Brasília (`lib/chart-time.ts`). "Requisições ao longo do tempo" agrupa por hora e por dia **em Brasília** na API (decisão 58, corrigido em 2026-10-04).
  **Sem dado interrompe a linha** (decisão 59; no **painel gerencial**, para vendas, dia sem venda é zero — decisão 74 —, e a regra de lacuna vale para ticket e telemetria): `lib/chart-gaps.ts` + `stepMs` em cada tela; ponto sem vizinho aparece como ponto isolado; ponto único ganha aviso. A dica abre do lado com mais espaço, sem animação;
  rótulo longo do eixo é "21/09 09h"; a largura da coluna é a que cabe sem encostar na vizinha (3 a 18 px); série em zero sobe 10 px acima do eixo na Linha (valor intacto).
- Testes: sem suíte automatizada no app; `npx tsc --noEmit`; jornadas no navegador real (evidências 2026-09-24 e 26;
  suporte em 2026-10-04).

## PDV (`apps/pdv-desktop`, Electron + Vite/React)

Frente de caixa: login (sessão de equipamento com o MAC ativado), abrir/fechar caixa (número do caixa por terminal),
venda (busca por código/nome, cliente, desconto com autorizador), pagamento (dinheiro com troco e cédulas, cartão
confirmado na maquininha, PIX aguardando confirmação), cancelamento/devolução/sangria com autorizador, consulta de vendas,
impressão, telemetria do equipamento (versão do app e do runtime).

- **Sem rede:** busca de produto/cliente usa cache local (somente leitura). Venda, pagamento e caixa **nunca** são
  enfileirados para depois: a tela diz "Sem conexão com o servidor — a operação NÃO foi concluída" e nada é gravado; ao
  voltar a rede, uma nova tentativa gera uma única venda ([evidência](../evidencias/2026-09-27/02-resiliencia-caos-controlado.md)).
  Vender offline é feature pendente ([ROADMAP](ROADMAP.md)).
- **Relatar problema** (`ReportProblemModal`, `services/support-report.ts`): botão no menu lateral e no modal de
  pagamento; envia tela, caixa (`Caixa #N`), venda e pagamento pendente; recusa cartão completo; mesma abertura reusa a
  chave de idempotência. Lógica coberta em `scripts/support-report.test.ts`.
- Teclas: F-keys valem com foco no campo de busca; com modal aberto só ESC age. HashRouter no app empacotado (`file://`).
- **[LIMITAÇÃO]** MFA não suportado no login do PDV; impressão térmica e leitor de código de barras não validados em
  hardware (sem impressora/leitor aqui).
- Testes: `npm run smoke:electron` (Electron real: janela carrega, versão do app = `package.json`); `npx tsc --noEmit`
  (`tsconfig.json` e `tsconfig.node.json`); regras de venda/caixa no backend.

## Balcão / oficina

O atendimento de balcão tem **aplicativo próprio — `apps/balcao`** (Vite + React; cliente → veículo → produto/disponível →
orçamento → OS → encaminhar ao caixa; ver [APLICATIVOS](APLICATIVOS.md)). A gerência continua com orçamento/OS no Admin Web
(cliente → moto → OS/orçamento → execução → entrega → pagamento), o PDV cobra e o mobile/TV atendem a equipe. Jornada do Admin
Web validada em 2026-09-25 (`docs/evidencias/2026-09-25`). O Balcão não compartilha componentes de UI com o Admin Web nem
com o PDV (só `packages/shared`).
