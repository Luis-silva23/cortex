# Dashboard gerencial (Administrador e Gerente)

Implementado em 2026-10-05, a partir da [varredura](DASHBOARD_GERENCIAL_VARREDURA.md) e das decisões 60–81 ([DECISIONS](DECISIONS.md)). Este texto descreve **o que o código faz hoje** e serve de base para o Manual do CÓRTEX.
Vale para COMPANY_ADMIN e MANAGER. **Estado: IMPLEMENTADO E HOMOLOGADO** (2026-10-05), com o resíduo descrito em "Resíduo conhecido" abaixo. OPERATOR e VIEWER só têm o dashboard do PDV (o dia da própria filial); MECHANIC, o da oficina; SUPER_ADMIN em contexto de empresa, o painel CEO antigo.

## Como usar

- **Período** (botão com ícone de calendário, no topo): Hoje, Ontem, Últimos 7 dias, Últimos 30 dias (padrão), Mês atual, Mês anterior, Ano e Período personalizado (data de início e de fim, até 366 dias). O escolhido controla **todos** os blocos da tela.
- **Comparar com o período anterior** (ligado por padrão): mostra o valor anterior, a diferença e a variação.
- **Filial** (só Administrador, com mais de uma filial): "Todas as filiais" ou uma filial. O Gerente sempre vê a própria filial.
- Em cada gráfico de evolução: **Linha** (padrão) ou **Colunas**, e **Receita | Vendas | Ticket médio**. Essas trocas só mudam o desenho, não chamam o servidor.
- O ícone "i" ao lado de cada indicador explica como ele é calculado.

## Regra única de período

Quem calcula o intervalo é a API (`apps/api/src/utils/dashboard-period.ts`), em dias civis de `America/Sao_Paulo`. A tela só envia o **nome** do recorte (e, no personalizado, as duas datas) e mostra o que a API devolveu. Todas as chamadas do painel levam o mesmo recorte; nenhum componente faz conta de data (travado por teste).

| Recorte | Período atual | Comparado a |
|---|---|---|
| Hoje | o dia de hoje | ontem **até o mesmo horário** (o rótulo diz "ontem até 15:30") |
| Ontem | o dia de ontem | anteontem (dia inteiro) |
| Últimos 7 dias | hoje e os 6 dias anteriores | os 7 dias imediatamente antes |
| Últimos 30 dias | hoje e os 29 dias anteriores | os 30 dias imediatamente antes |
| Mês atual | do dia 1 até hoje | os mesmos dias do mês anterior (limitado ao tamanho dele: 31/03 não invade fevereiro) |
| Mês anterior | o mês inteiro | o mês antes dele, inteiro |
| Ano | 1º de janeiro até hoje | os mesmos dias do ano anterior |
| Personalizado | do início ao fim escolhidos (inclusive) | o período imediatamente anterior, de mesma duração |

- "30 dias" são **30 dias civis** (a série começa na meia-noite de Brasília, o primeiro dia nunca é parcial), não 30 × 24 horas.
- Intervalos são `[início, fim)`: 23:59:59 de Brasília ainda é o dia; 00:00 abre o seguinte. Vale para virada de dia, de mês e de ano (testes com instantes `02:59:59Z` e `03:00:00Z`).
- **Granularidade** do gráfico: um dia = por hora (de hoje, só até a hora atual); até 62 dias = por dia; acima disso = por mês.
- O período personalizado aceita no máximo 366 dias; datas inválidas, fim antes do início ou período maior que isso voltam erro 400 `INVALID_PERIOD`.
- Percentual com anterior **zero** não é inventado: aparece "sem base de comparação" (`null` na API); zero × zero é 0%.

## Indicadores (KPIs)

| KPI | Definição | Melhor quando |
|---|---|---|
| Receita | valor oficial das **vendas realizadas** (pagas e parcialmente pagas), na data da venda. **Não** é o valor recebido e **não** inclui a receita de OS (fica à parte). Não é receita líquida. | sobe |
| Vendas | quantidade de vendas realizadas | sobe |
| Ticket médio | receita ÷ **vendas distintas** (nunca ÷ registros de pagamento). Sem vendas, não há ticket | sobe |
| Saques | retiradas de caixa (`WITHDRAWAL`) no período: valor e quantidade, pela data do movimento. Reforço não conta | sem julgamento |
| Cancelamentos e devoluções | vendas canceladas + devoluções **totais**, pela data do cancelamento/devolução. Só quantidade (devolução parcial não tem data nem valor por item) | desce |
| Descontos | soma de `Sale.discountAmount` das vendas realizadas, % do valor bruto e quantas vendas tiveram desconto | desce |

Cada KPI mostra: valor atual, valor anterior, diferença absoluta, variação percentual e se **melhorou** (verde) ou **piorou** (vermelho); "sem julgamento" fica em cinza. O sentido de melhor vem da API.

## Formas de pagamento

Formas oficiais: **Cartão** (com detalhe de débito e crédito), **PIX**, **Dinheiro**, **Convênio funcionário**, **Convênio empresa**; "Outras formas" (transferência, cheque, vale, outro) só aparece quando houve uso. Só pagamentos **aprovados** contam; PIX pendente ou cancelado não entra.

- **Vendas** = vendas **distintas** que usaram a forma. Uma venda paga em duas formas conta uma vez em cada forma (a soma das formas pode passar o total de vendas).
- **Ticket médio da forma** = valor pago na forma ÷ essas vendas distintas.
- **Participação** = parte do valor pago na forma, entre os pagamentos aprovados do período.
- **Não** há bandeira, parcelas nem quantidade de parcelas: a origem atual (cartão manual) não as registra de forma confiável.

## Evolução

Um gráfico temporal com **Receita | Vendas | Ticket médio**, **Linha** padrão e **Colunas** alternativa, e o período anterior tracejado (só na Linha). A dica mostra a data/hora, o valor, o detalhe por forma de pagamento (vendas e valor) e o total; com a comparação ligada, também o ponto correspondente do período anterior.

- Dia (ou hora, ou mês) **sem venda é zero** nas séries de venda: a ausência de venda é zero real.
- **Ticket médio sem venda não é zero**: não existe ticket sem venda, e a linha interrompe (regra de lacunas já existente, `chart-gaps`). Telemetria ausente continua sem preenchimento (decisão 59).
- Sem nenhuma venda no período, a tela mostra "Nenhuma venda realizada no período selecionado" em vez de uma linha zerada.

## Origem das vendas

Donut + tabela (origem, receita, vendas, participação) sobre a receita do período, e, com **duas ou mais origens ativas**, a evolução da receita por origem (Linha padrão, Colunas alternativa; dica com vendas de cada origem e o total).

- Venda sem canal = **Loja física**. O nome exibido é o configurado no canal (padrão "Loja física").
- Só entram canais **ativos** e só com o módulo **CANAIS** ligado: canal desativado não aparece (nada de "iFood 0%"). Receita de canal desativado continua na receita total e a tela avisa quanto ficou fora da composição.
- Canal ativo sem vendas no período aparece com R$ 0,00 (0%); a loja física existe sempre.
- Detalhes de canais: [CANAIS](CANAIS.md).

## Caixa e saques

Caixas abertos agora (e o saldo esperado), fechamentos do período com diferença e a soma das diferenças, fechamentos forçados, e a evolução dos saques (Linha padrão / Colunas; a dica mostra a quantidade de retiradas).

## Operação

Faixa compacta: OS em aberto, OS atrasadas, estoque baixo e sem inventário, contas a pagar e a receber vencidas. Contas e OS vêm **no resumo** (mesma transação, nenhuma chamada extra) e respeitam os módulos Financeiro e Oficina: módulo desligado aparece como "—", nunca como zero. O estoque usa a consulta própria com cache do servidor.

## Estados da tela

Carregando (esqueletos), erro (mensagem e "Tentar novamente", sem número inventado), sem dados (mensagem própria por bloco), uma só origem e várias origens. Cada bloco falha sozinho.

## API

| Chamada | O que devolve |
|---|---|
| `GET /api/dashboard/management/summary?period=&start=&end=&branchId=` | período resolvido e o anterior, os KPIs com comparação, formas de pagamento, origem, receita por filial, caixa e operação |
| `GET /api/dashboard/management/timeseries?period=&start=&end=&branchId=` | pontos por hora/dia/mês (zero preenchido nas vendas), com detalhe por forma e por canal, e os pontos do período anterior alinhados por posição |

- Abrir o painel faz **3 chamadas ao painel** (resumo, séries e estoque), cada uma de resumo/séries numa **única transação de leitura** (uma só conexão, nível `REPEATABLE READ`, prazo explícito de 20 s) com a RLS de empresa e filial aplicada pela transação. Antes eram 6 chamadas com 4 a 5 consultas em paralelo cada. Nenhum timeout de conexão, tamanho de pool ou aquecimento foi alterado (decisão 57 continua do dono).
- Tudo é agregado no PostgreSQL (`SUM`, `COUNT`, `COUNT(DISTINCT)`, `GROUP BY`) no dia/mês/hora de Brasília (`AT TIME ZONE`); o banco continua guardando instantes UTC. Sem cache e sem índice novo (nada foi medido que os justifique).
- `period` também vale para `/dashboard/sales`, `/financial`, `/workshop` e `/ceo` (clientes antigos podem seguir com `startDate`/`endDate`).

## Segurança

- `management/*`, `/dashboard/sales`, `/dashboard/stock` e `/dashboard/ceo`: **SUPER_ADMIN (numa empresa), COMPANY_ADMIN e MANAGER**. **OPERATOR, VIEWER e MECHANIC recebem 403** (antes a API entregava vendas e o valor de estoque a custo a OPERATOR e VIEWER, embora a tela os escondesse). `/dashboard/pdv` segue aberto a OPERATOR e VIEWER; `/workshop`, ao MECHANIC.
- O Gerente é limitado à própria filial pelo servidor (a filial do token), mesmo que peça outra; a RLS (`rls_company_branch_match`) garante o isolamento também nas tabelas derivadas (`payments`, `cash_movements`).
- Gate de módulo: `VENDAS` para o resumo e as séries; contas e OS do resumo seguem `FINANCEIRO` e `OFICINA`.

## O que ainda não existe (de propósito)

Receita líquida, margem, valor de devolução parcial e de venda cancelada, ranking de pessoas (vendas por operador, saques por autorizador), retirada por motivo, bandeira e parcelas do cartão, receita de OS somada à de vendas, dashboard de comissão, cache e índices novos. Estão em [DECISIONS](DECISIONS.md) (pendentes) e no [ROADMAP](ROADMAP.md).

## Resíduo conhecido (registrado em 2026-10-05; não alterado)

O painel gerencial vale só para Administrador e Gerente. Os demais continuam no dashboard antigo de `app/dashboard/page.tsx`: SUPER_ADMIN em contexto de empresa (`/ceo`), MECHANIC (`/workshop`) e OPERATOR/VIEWER (`/pdv`). Esse código calcula **no navegador** a janela de 30 dias (`resolvePeriodRange`) que envia ao `/ceo` e ao `/workshop`, ou seja, não usa a regra única de período da API. Não afeta Administrador nem Gerente. Falta decidir em que fase isso entra ([ROADMAP](ROADMAP.md#sequência-oficial-de-evolução)).

## Arquivos

- API: `utils/dashboard-period.ts` (regra única, +testes), `services/dashboard-management.service.ts`, `routes/dashboard.routes.ts`; testes `test/integration/dashboard-management.integration.test.ts`.
- Admin Web: `lib/dashboard-management.ts`, `components/dashboard/*`, `components/charts/{TimeSeriesChart,ChartTooltip,DonutChart}.tsx`, `app/dashboard/page.tsx`.
- Evidências visuais: evidencias/2026-10-05-dashboard-gerencial (evidência arquivada fora do repositório publicado: `docs/evidencias/2026-10-05-dashboard-gerencial/RESULTADO.md`).
