# Dashboard gerencial — varredura e proposta (2026-10-04)

> **Atualização (2026-10-05):** a Etapa D foi implementada: ver [DASHBOARD_GERENCIAL](DASHBOARD_GERENCIAL.md) (o que o painel faz hoje), [CANAIS](CANAIS.md) e [COMISSAO](policies/COMISSAO.md). Este documento fica como a varredura original.

Etapas A, B e C da fase (varredura, classificação, proposta). **Nada de produto foi alterado nem implementado nesta etapa.** Só leitura de código, esquema, migrações e do banco de **desenvolvimento** (consultas de leitura, um `EXPLAIN` sem executar).
Sem carga, sem dados inventados. Nomes de perfil: ADM = `COMPANY_ADMIN` (Administrador/CEO), GER = `MANAGER`, OPE = `OPERATOR`, VIS = `VIEWER`, MEC = `MECHANIC`. "EF" = respeita empresa e filial (RLS do Postgres).

## Resumo

**87 indicadores mapeados** (Vendas 28, Formas de pagamento 16, Caixa e retiradas 12, Financeiro 6, Oficina 14, Estoque e compras 9, Clientes 2).

| Situação | Quantidade | Significado |
|---|---|---|
| PRONTO | 14 | dado e regra já existem e a API já entrega |
| PARCIAL | 10 | o dado existe; falta tratamento, agregação ou campo na API |
| NOVO | 48 | o dado existe e o indicador ainda não foi criado |
| DECISÃO | 12 | há dado, mas falta uma definição de negócio (ver §6) |
| INDISPONÍVEL | 3 | não há informação suficiente (margem, bandeira/parcelas do cartão, retirada por motivo) |

Achados que mudam o desenho: (1) a **receita do painel é só de vendas** (balcão/PDV); a OS não passa por `sales`; (2) a contagem por forma de pagamento é de **pagamentos**, não de vendas; (3) a API resolve "período anterior" como mesma duração deslizante, então "hoje × ontem" e "mês × mês anterior" não existem; (4) os períodos de 7 e 30 dias são calculados no **navegador**; (5) as séries por dia leem todas as vendas para o Node; (6) a RLS de `payments` varre todas as vendas visíveis da empresa a cada consulta (não medido); (7) **OPE e VIS podem chamar `/dashboard/sales` e `/dashboard/stock` (valor de estoque a custo) pela API**; (8) o painel já abre 15–20 conexões frias (decisão 57), então os novos indicadores precisam de **dois endpoints**, não de dez chamadas.

## 1. O que o painel faz hoje

- **Endpoints** (`apps/api/src/routes/dashboard.routes.ts`, `services/dashboard.service.ts`): `/dashboard/sales`, `/financial`, `/stock`, `/workshop`, `/pdv`, `/ceo`, `/super-admin`. Autorização por **tipo de usuário** (nenhum código de permissão `dashboard:*`): `/financial` só SUPER_ADMIN/ADM/GER; `/sales`, `/stock`, `/pdv`, `/ceo` negam só MEC (**OPE e VIS passam na API**, embora a tela mostre só o PDV a eles); `/workshop` é aberto até ao MEC (só contagens).
- **Tela** (`apps/admin-web/app/dashboard/page.tsx`, 1220 linhas, uma visão por tipo de usuário): o ADM vê 4 KPIs (receita, vendas, ticket médio, estoque baixo) com variação sobre o período anterior, cartão Financeiro (4 números), evolução da receita (Linha ↔ Colunas), vendas por forma de pagamento (**só valor**), OS em aberto e, com mais de uma filial, receita por filial. O GER vê o mesmo da sua filial mais o PDV.
- **Chamadas ao abrir (ADM):** `/sales`, `/financial`, `/stock`, `/workshop`, `/branches` e, com mais de uma filial, `/ceo`: 5 a 6 chamadas, cada uma com 4 a 5 consultas em paralelo. É o painel que dispara a rajada de conexões da decisão 57.
- **Já devolvido pela API e não mostrado:** `topProducts` (10 mais vendidos), `previousRevenue`/`previousSales`, `avgTicket` por período.
- **Tela Relatórios** (`app/dashboard/reports`) é uma tela de intenção ("Em desenvolvimento: sem endpoint de relatórios na API"): nada a aproveitar.

## 2. Dados reais encontrados (banco de desenvolvimento, 2026-10-04)

Volume pequeno (31 vendas, 27 pagamentos, 43 movimentos de caixa, 18 caixas, 9 OS, 11 produtos): **serve para provar regra e fuso, não para medir desempenho.**

- Vendas: 22 PAID, 5 PENDING, 2 CANCELLED, 2 RETURNED; nenhuma PARTIALLY_PAID. Em 4 vendas de teste `paidAmount = 0` embora o pagamento esteja APPROVED: **a verdade do recebido está em `payments`, não em `sales.paidAmount`**.
- Pagamentos: dinheiro (19 aprovados, 3 estornados), cartão de **débito** 1, PIX 1 pendente e 1 cancelado, convênio funcionário 1, convênio empresa 1. Nenhum crédito. Todos sem provedor (manual); o cartão não tem bandeira (`cardBrand` nulo) e parcelas = 1. 4 pagamentos aprovados sem `paidAt`.
- Caixa: 5 retiradas (todas com autorizador e motivo), 2 estornos de devolução, 18 caixas (11 fechados: 4 com diferença, 3 com motivo e 3 com o resumo por forma de pagamento, que só existe depois de 2026-09-28).
- Descontos: 2 vendas com desconto (R$ 2,00); `discount_events` vazio; nenhum desconto de parceiro; `business_hours` vazio.
- Fuso: as vendas desse banco caem nos mesmos dias em UTC e Brasília (nenhuma depois das 21h), então **o banco de desenvolvimento não exercita a virada**; a prova de fuso continua sendo a do SQL com instantes de teste.

## 3. Inventário de indicadores

Colunas: **Orig.** = origem (model → serviço → endpoint); **HCDM** = H histórico (datado), C comparável, D agrupável por dia, M por mês (`—` = não); **Sit.** = situação. Perfis: os que a API autoriza hoje (ver §1) ou "a definir" (decisão 69).

### 3.1 Vendas

| ID | Indicador | Orig. | Regra | Un. | HCDM | Perfis | Sit. | Observação |
|---|---|---|---|---|---|---|---|---|
| V01 | Receita | `Sale.totalAmount` → `getSalesDashboard` → `GET /dashboard/sales` | Σ `totalAmount` de vendas PAID e PARTIALLY_PAID com `saleDate` no período | R$ | H C D M | ADM GER (OPE VIS pela API) | PRONTO | É receita **vendida**, não recebida; não inclui OS (decisão 60) |
| V02 | Quantidade de vendas | `Sale` → idem | contagem das mesmas vendas | qtd | H C D M | idem | PRONTO | |
| V03 | Ticket médio | `Sale` → idem | receita ÷ quantidade | R$ | H C D M | idem | PRONTO | só o total; sem série nem valor anterior |
| V04 | Evolução da receita por dia | `Sale.saleDate` → `timeline` de `/sales` e `/ceo` | Σ por dia de Brasília (`localDayKey`) | R$ | H C D M | ADM GER | PARCIAL | dia correto, mas lê **todas as linhas** do período para o Node (`findMany`) em vez de agregar no banco; só dias com venda |
| V05 | Evolução da quantidade de vendas por dia | `Sale` | contagem por dia de Brasília | qtd | H C D M | ADM GER | NOVO | mesma consulta de V04 |
| V06 | Evolução do ticket médio por dia | `Sale` | V04 ÷ V05 | R$ | H C D M | ADM GER | NOVO | |
| V07 | Receita e vendas por mês | `Sale` | agrupar por mês de Brasília | R$ / qtd | H C — M | ADM GER | NOVO | agrupamento mensal não existe |
| V08 | Comparação com o período anterior equivalente (receita e vendas, %) | `comparison` de `/sales` | anterior = mesma duração imediatamente antes (`resolvePeriod`) | % | H C | ADM GER | PRONTO | só vale para períodos deslizantes (ver V09) |
| V09 | Comparação por calendário (hoje × ontem, mês × mês anterior, mês × mesmo mês do ano anterior) | `Sale` | exige início/fim em Brasília | % | H C D M | ADM GER | DECISÃO | hoje o "anterior" de "Hoje" são as horas anteriores à meia-noite, não "ontem"; o de "Mês atual" são N dias antes do dia 1 (decisões 67 e 68) |
| V10 | Diferença absoluta (R$ e quantidade) | `previousRevenue`, `previousSales` | atual − anterior | R$ / qtd | H C | ADM GER | PARCIAL | a API já devolve os dois valores; falta o campo calculado |
| V11 | Ticket médio anterior e variação | `Sale` | | R$ / % | H C | ADM GER | NOVO | a API não devolve o ticket do período anterior |
| V12 | Receita e vendas por filial | `getCeoDashboard.revenueByBranch` → `GET /dashboard/ceo` | `groupBy branchId` | R$ / qtd | H C — — | ADM (GER vê só a sua) | PRONTO | |
| V13 | Evolução por filial | `Sale` | série por filial | R$ | H C D M | ADM | NOVO | |
| V14 | Vendas por operador | `Sale.userId` | `groupBy userId` | R$ / qtd | H C D M | ADM GER | DECISÃO | quem vê o ranking de pessoas (decisão 70) |
| V15 | Vendas canceladas (quantidade) | `Sale.status = CANCELLED`, `cancelledAt` | contagem por data de cancelamento | qtd | H C D M | ADM GER | PARCIAL | hoje só "cancelamentos de hoje" na visão do PDV (`cancellationsToday`) |
| V16 | Valor das vendas canceladas | `Sale.totalAmount` ou estorno | | R$ | H C D M | ADM GER | DECISÃO | valor da venda × valor efetivamente estornado (decisão 73) |
| V17 | Devoluções totais (quantidade) | `Sale.status = RETURNED` | usa `cancelledAt` como data | qtd | H C D M | ADM GER | NOVO | |
| V18 | Devoluções — valor | `CashMovement(RETURN)`, `SaleItem.returnedQuantity`, `refundedValue` | | R$ | H — D M | ADM GER | DECISÃO | devolução **parcial** não tem data por item e o valor só vira movimento de caixa se o caixa estava aberto (decisão 72) |
| V19 | Receita líquida | `Sale`, devoluções, cancelamentos | | R$ | H C D M | ADM GER | DECISÃO | a venda parcialmente devolvida continua na receita pelo total (decisão 61) |
| V20 | Descontos concedidos (valor, % sobre o bruto, vendas com desconto) | `Sale.discountAmount`, `discountPercent`, `subtotal` | | R$ / % / qtd | H C D M | ADM GER | NOVO | |
| V21 | Descontos que exigiram autorização | `DiscountEvent.requiredAuthorization`, `authorizedBy` → `GET /discount-events` | | qtd / R$ | H C D M | ADM GER | PARCIAL | a rota lista até 500 eventos, não agrega |
| V22 | Desconto de parceiro | `Sale.partnerDiscountAmount` | | R$ | H C D M | ADM GER | NOVO | |
| V23 | Produtos mais vendidos | `SaleItem` → `topProducts` | top 10 por valor | R$ / qtd | H C — — | ADM GER | PRONTO | já devolvido pela API e **não exibido** |
| V24 | Receita por categoria de produto | `SaleItem` → `Product.categoryId` | | R$ | H C D M | ADM GER | NOVO | |
| V25 | Itens vendidos (linhas e unidades) | `SaleItem` → `GET /sales/stats` | | qtd | H C D M | ADM GER | PARCIAL | `/sales/stats` conta linhas, não unidades |
| V26 | Vendas pendentes (aguardando pagamento: quantidade, idade) | `Sale.status = PENDING` | | qtd | H — D — | ADM GER | NOVO | |
| V27 | Vendas por hora do dia e dia da semana | `Sale.saleDate` | agrupar em Brasília | R$ / qtd | H C — — | ADM GER | NOVO | |
| V28 | Margem bruta / lucro | — | — | R$ | — | — | INDISPONÍVEL | `SaleItem` não guarda o custo; `Product.costPrice` muda com a última compra e o movimento de venda não tem `unitCost` (decisão 71) |

### 3.2 Formas de pagamento

Enum `PaymentMethod`: `CASH`, `DEBIT_CARD`, `CREDIT_CARD`, `PIX`, `BANK_TRANSFER`, `CHECK`, `VOUCHER`, `OTHER`, `EMPLOYEE_AGREEMENT`, `COMPANY_AGREEMENT`. Só pagamentos `APPROVED` contam.

| ID | Indicador | Orig. | Regra | Un. | HCDM | Perfis | Sit. | Observação |
|---|---|---|---|---|---|---|---|---|
| P01 | Valor por forma | `Payment.amount` → `paymentMethods` de `/sales` | `groupBy paymentMethod` (APPROVED, vendas do período) | R$ | H C D M | ADM GER | PRONTO | `amount` é o aplicado à venda (sem troco) |
| P02 | Quantidade por forma | `paymentMethods.count` | hoje = nº de **pagamentos** | qtd | H C D M | ADM GER | PARCIAL | venda com duas formas conta duas vezes; "7 vendas" exige `COUNT(DISTINCT saleId)` (decisão 63) |
| P03 | Participação % | derivado de P01 | forma ÷ total | % | H C | ADM GER | NOVO | |
| P04 | Ticket médio por forma | P01 e P02 | | R$ | H C | ADM GER | DECISÃO | denominador e venda mista (decisão 62) |
| P05 | Cartão (débito + crédito) | `DEBIT_CARD`, `CREDIT_CARD` | agrupar | R$ / qtd | H C D M | ADM GER | DECISÃO | hoje são duas formas; "Cartão" do exemplo é a soma (decisão 64) |
| P06 | Cartão: bandeira e parcelas | `Payment.cardBrand`, `installments` | | — | — | — | INDISPONÍVEL | cartão é manual (sem provedor): bandeira nula e parcelas = 1 nos dados atuais |
| P07 | PIX: valor, quantidade, ticket | `Payment` (PIX, APPROVED) | | R$ / qtd | H C D M | ADM GER | NOVO | |
| P08 | PIX pendentes e cancelados (quantidade, valor, idade) | `Payment` (PIX, PENDING/CANCELLED) | | qtd / R$ | H — D — | ADM GER | NOVO | |
| P09 | Dinheiro: valor, quantidade, troco | `Payment.amount`, `changeAmount` | | R$ / qtd | H C D M | ADM GER | NOVO | |
| P10 | Convênio funcionário | `Payment` (EMPLOYEE_AGREEMENT), `EmployeeAgreementCharge` | | R$ / qtd | H C D M | ADM GER | NOVO | |
| P11 | Convênio empresa (e a receber da conveniada) | `Payment` (COMPANY_AGREEMENT), `AccountsReceivable.agreementCompanyId` | | R$ / qtd | H C D M | ADM GER | NOVO | |
| P12 | Outras formas (transferência, cheque, vale, outro) | enum | | R$ / qtd | H C D M | ADM GER | NOVO | uso real a confirmar |
| P13 | Evolução por forma (dia e mês) | `Payment` + `Sale.saleDate` | série por forma | R$ / qtd | H C D M | ADM GER | NOVO | alimenta a dica do gráfico |
| P14 | Comparação por forma com o período anterior | `Payment` | | % | H C | ADM GER | NOVO | |
| P15 | Estornos (quantidade, valor, forma) | `Payment.status = REFUNDED`, `refundedAt` | | qtd / R$ | H C D M | ADM GER | NOVO | cobre cancelamento e devolução total |
| P16 | Exceções de pagamento abertas | `PaymentException.resolvedAt IS NULL` → `GET /payments/exceptions` | | qtd | H — — — | ADM GER | PARCIAL | só lista; falta a contagem |

### 3.3 Caixa e retiradas

"Retirada" = `CashMovement` do tipo `WITHDRAWAL` (a política e o código chamam de sangria): exige 2º autorizador, motivo (`notes`) e grava `requestedBy`/`authorizedBy`. Reforço = `DEPOSIT` (não exige autorização).

| ID | Indicador | Orig. | Regra | Un. | HCDM | Perfis | Sit. | Observação |
|---|---|---|---|---|---|---|---|---|
| C01 | Caixas abertos agora e saldo esperado | `CashRegister` → `getPdvDashboard` → `GET /dashboard/pdv` | `status = OPEN` | qtd / R$ | — — — — | ADM GER | PRONTO | só da filial; sem consolidado da empresa |
| C02 | Retiradas: quantidade e valor | `CashMovement(WITHDRAWAL)` + `CashRegister.companyId/branchId` | por `createdAt` | qtd / R$ | H C D M | ADM GER | NOVO | dado real e completo (autorizador e motivo sempre presentes) |
| C03 | Retiradas × período anterior | idem | | % | H C | ADM GER | NOVO | |
| C04 | Retiradas por filial, operador e autorizador | `userId`, `requestedBy`, `authorizedBy` | | qtd / R$ | H C D M | ADM GER | DECISÃO | exposição por pessoa (decisão 66) |
| C05 | Evolução das retiradas | idem | série | R$ / qtd | H C D M | ADM GER | NOVO | |
| C06 | Reforços (quantidade e valor) | `CashMovement(DEPOSIT)` | | qtd / R$ | H C D M | ADM GER | NOVO | não tem segundo autorizador |
| C07 | Retiradas por motivo | `notes` (texto livre) | | — | — | — | INDISPONÍVEL | sem categoria; só texto (decisão 66) |
| C08 | Fechamentos com divergência (quantidade, soma, maiores) | `CashRegister.difference`, `differenceReason` | `difference ≠ 0` | qtd / R$ | H C D M | ADM GER | NOVO | |
| C09 | Fechamentos forçados | `CashRegister.closeType = FORCED`, `forcedReason` | | qtd | H C D M | ADM GER | NOVO | |
| C10 | Caixas abertos há muito tempo | `CashRegister.openedAt` | idade | h | — — — — | ADM GER | NOVO | |
| C11 | Esperado × informado por forma de pagamento | `CashRegister.closingSummary` (JSON) | | R$ | H — D — | ADM GER | PARCIAL | JSON; só caixas fechados depois de 2026-09-28 |
| C12 | Estornos no caixa (cancelamento e devolução) | `CashMovement(CANCELLATION/RETURN)` | | R$ / qtd | H C D M | ADM GER | PARCIAL | só quando o caixa da venda ainda estava aberto; com o caixa fechado o ajuste é manual e não é registrado |

### 3.4 Financeiro

| ID | Indicador | Orig. | Regra | Un. | HCDM | Perfis | Sit. | Observação |
|---|---|---|---|---|---|---|---|---|
| F01 | Contas a pagar: pendentes, vencidas, próximos 7 e 30 dias | `AccountsPayable` → `getFinancialDashboard` → `/dashboard/financial` | | R$ | — — — — | ADM GER | PRONTO | |
| F02 | Contas a receber: idem | `AccountsReceivable` → idem | | R$ | — — — — | ADM GER | PRONTO | |
| F03 | Fluxo de caixa (entradas pagas − saídas pagas) | `getCashFlowSummary` | por `dueDate` | R$ | H C — — | ADM GER | DECISÃO | **não inclui as vendas do PDV** (não geram conta a receber); só OS, convênio e lançamentos manuais (decisão 75) |
| F04 | Inadimplência (vencido ÷ a receber) | `AccountsReceivable` | | % | — — — — | ADM GER | NOVO | |
| F05 | Idade das contas vencidas | `AccountsReceivable.dueDate` | | R$ | — — — — | ADM GER | NOVO | |
| F06 | Convênio: cobranças e folha | `EmployeeAgreementCharge`, `EmployeePayrollDeduction` | | R$ | H — — M | ADM GER | NOVO | |

### 3.5 Oficina, orçamentos e pós-venda

| ID | Indicador | Orig. | Regra | Un. | HCDM | Perfis | Sit. | Observação |
|---|---|---|---|---|---|---|---|---|
| O01 | OS abertas por status | `ServiceOrder` → `getWorkshopDashboard` | | qtd | — — — — | ADM GER MEC | PRONTO | |
| O02 | OS atrasadas | idem | prazo prometido ou, sem prazo, `overdueDays` | qtd | — — — — | ADM GER MEC | PRONTO | |
| O03 | OS encerradas no período e tempo médio de ciclo | `ServiceOrderStatusHistory` | | qtd / h | H C — — | ADM GER MEC | PRONTO | |
| O04 | Receita de OS | `ServiceOrder.isPaid/paidAt/finalTotal`, `AccountsReceivable(ref ServiceOrder)` | | R$ | H C D M | ADM GER | DECISÃO | a OS **não passa por `sales`**: somar à receita ou mostrar à parte (decisão 76) |
| O05 | Ticket médio de OS | `ServiceOrder` | | R$ | H C D M | ADM GER | NOVO | |
| O06 | Mão de obra × peças | `laborTotal`, `partsTotal` | | R$ | H C D M | ADM GER | NOVO | |
| O07 | OS por mecânico | `mechanicId`, `mechanicStartedAt/CompletedAt` | | qtd / h | H C D M | ADM GER | NOVO | exposição por pessoa |
| O08 | Comissões de mecânico (a pagar e pagas) | `MechanicCommission.isPaid` | | R$ | H — — M | ADM | NOVO | |
| O09 | Orçamentos: criados, aprovados, convertidos, expirados e conversão | `Quote.status` | | qtd / % | H C D M | ADM GER | NOVO | |
| O10 | OS canceladas | `ServiceOrder.cancelledAt` | | qtd | H C D M | ADM GER | NOVO | |
| O11 | Garantias e retornos | `ServiceOrderWarranty`, `WarrantyClaim` | | qtd | H C D M | ADM GER | NOVO | |
| O12 | Agenda: agendamentos por status e não comparecimento | `Appointment.status` | | qtd / % | H C D M | ADM GER | NOVO | |
| O13 | Pós-venda: retornos pendentes e atrasados | `FollowUp` | | qtd | H — — — | ADM GER | NOVO | |
| O14 | Descontos em OS | `ServiceOrder.discountAmount`, `DiscountEvent.serviceOrderId` | | R$ | H C D M | ADM GER | NOVO | |

### 3.6 Estoque, compras e clientes

| ID | Indicador | Orig. | Regra | Un. | HCDM | Perfis | Sit. | Observação |
|---|---|---|---|---|---|---|---|---|
| E01 | Produtos ativos, estoque baixo, não inventariados, parados e valor a custo | `Product`, `stockLedger` → `getStockDashboard` → `/dashboard/stock` | | qtd / R$ | — — — — | ADM GER (OPE VIS pela API) | PRONTO | a API entrega o **valor de estoque a custo** também a OPE e VIS (decisão 69) |
| E02 | Perdas e avarias (por motivo) | `DamageRecord` | quantidade × custo atual | qtd / R$ | H C D M | ADM GER | PARCIAL | valor usa o custo de hoje, não o da época |
| E03 | Transferências pendentes e em trânsito | `Transfer.status` | | qtd | — — — — | ADM GER | NOVO | |
| E04 | Compras por status, valor e atraso | `PurchaseOrder` | `expectedDelivery` vencida | qtd / R$ | H C D M | ADM GER | NOVO | |
| E05 | Devoluções a fornecedor | `SupplierReturn` | | qtd / R$ | H C D M | ADM GER | NOVO | |
| E06 | Giro e cobertura de estoque | `StockMovement`, `stockLedger` | | dias | H C — M | ADM GER | DECISÃO | fórmula (decisão 79) |
| E07 | Ruptura (saldo ≤ 0 com venda recente) | `stockLedger`, `StockMovement` | | qtd | — — — — | ADM GER | NOVO | |
| E08 | Curva ABC de produtos | `SaleItem` | | % | H C — — | ADM GER | NOVO | derivada de V23 |
| E09 | Inventários em andamento e divergências | `Inventory`, `InventoryCount` | | qtd | H — — — | ADM GER | NOVO | |
| K01 | Clientes novos | `Customer.createdAt` | | qtd | H C D M | ADM GER | NOVO | |
| K02 | Clientes recorrentes | `Sale.customerId` | | qtd | H C — M | ADM GER | DECISÃO | definição de recorrente (decisão 79) |

## 4. Análise

### 4.1 Filtros e comparativos possíveis
Todos os recortes abaixo são viáveis **no banco**, com `companyId`, `branchId` (opcional) e intervalo `[início, fim)` de instantes: Hoje, Ontem, 7 dias, 30 dias, Mês atual, Mês anterior e Personalizado. Hoje a API só recebe `startDate`/`endDate` calculados pelo **navegador** (`now − N×24 h` para 7 e 30 dias, meia-noite de Brasília só para "Hoje" e "Mês atual") e não existe início de mês no lado da API. Comparativos possíveis com dado real: período equivalente deslizante (já existe), hoje × ontem, mês × mês anterior (mês cheio ou até o mesmo dia), mês × mesmo mês do ano anterior e personalizado × equivalente anterior; valor atual, anterior, diferença absoluta e percentual (V08–V11). A definição de qual comparação vale para cada filtro é a decisão 67.

### 4.2 Cartão, PIX, retiradas, vendas e caixa (o que o dado permite)
- **Cartão:** valor, quantidade e ticket por débito e por crédito (juntos ou separados, decisão 64); sem bandeira nem parcelas hoje (P06).
- **PIX:** valor, quantidade, ticket e série diária de aprovados; os pendentes e cancelados (P08) mostram cobrança que não virou venda.
- **Retiradas:** quantidade, valor, série, comparação e autorizador, todos reais e completos; motivo só em texto livre.
- **Vendas:** quantidade, receita, ticket, séries por dia e por mês, cancelamentos, descontos e operador têm dado confiável; **margem não existe**; devolução parcial não tem data nem valor por item.
- **Caixa:** divergências, fechamentos forçados e idade do caixa aberto têm dado; esperado × informado por forma só nos fechamentos recentes.

### 4.3 Dica (tooltip)
Exemplo pedido ("28/09/2026: Cartão 7 vendas R$ 364,00; PIX 5 vendas R$ 212,50; Total 12 vendas R$ 576,50") é possível com dado real **se a API devolver por dia e por forma** a quantidade de **vendas distintas** e o valor. Hoje o gráfico temporal mostra um valor por série e a API não devolve esse detalhe. Cada dica só mostra o que a API entregar: sem detalhe, mostra data e valor, como agora.

### 4.4 Desempenho (problemas encontrados)
1. **Séries lidas no Node:** `timeline` de `/sales` e de `/ceo` faz `findMany` de todas as vendas do período e soma em JavaScript; o período personalizado não tem teto. Deve virar `GROUP BY` no banco com o dia de Brasília (mesma expressão da correção da observabilidade).
2. **RLS de `payments` e de `cash_movements`:** as políticas são `"saleId" IN (SELECT id FROM sales)` e `"cashRegisterId" IN (SELECT id FROM cash_registers)`. O `EXPLAIN` (sem `ANALYZE`, como COMPANY_ADMIN, nas tabelas pequenas do desenvolvimento) mostra um `hashed SubPlan` que **varre todas as vendas visíveis da empresa a cada consulta de pagamentos**, qualquer que seja o período. Com muitos milhares de vendas isso pesa; **não medido** (sem carga, sem volume). Mitigações possíveis (decisão 80): começar sempre pela venda do período, ou denormalizar `branchId`/data em `payments` (migração).
3. **Índices:** `sales` tem `(companyId, saleDate)` e `(branchId, saleDate)` (bons); faltam `cash_movements (movementType, createdAt)`, `service_orders (paidAt)`/`(deliveryDate)` e `payments` por data; só criar depois de medir (decisão 80).
4. **Rajada de conexões (decisão 57):** o painel já abre 15 a 20 conexões frias. Os novos indicadores **não podem** virar mais 10 chamadas: proposta de **um endpoint de resumo e um de séries**, cada um com no máximo 3 a 4 consultas simultâneas (o resto em sequência).
5. **Cache:** não há necessidade comprovada. Só o estoque tem cache (5 min, chave por escopo de visibilidade); qualquer cache novo precisa de `visibilityScope()` na chave. Nenhum cache por precaução.
6. **Paginação:** não se aplica a agregados; as listas já existentes (descontos, exceções) seguem paginadas/limitadas.

### 4.5 Fuso (problemas encontrados)
1. **Período calculado no navegador:** "7 dias" e "30 dias" são `agora − N×24 h`; o primeiro dia da série é parcial e o relógio do cliente define o intervalo. O correto é a API receber só o nome do recorte (`today`, `7d`...) e resolver o intervalo **em Brasília**.
2. **Período anterior:** igual em duração e deslizante. "Hoje" compara com as horas anteriores à meia-noite (não com "ontem"); "Mês atual" compara com N dias antes do dia 1 (não com o mês anterior).
3. **Falta `startOfLocalMonth` na API** (só existe no navegador): necessário para mês atual, mês anterior e viradas de mês e de ano.
4. **Agrupamento diário das vendas:** correto (dia de Brasília calculado em JS); ao passar para SQL usar `date_trunc('day', ("saleDate" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')`, a mesma expressão provada na virada de dia, mês e ano.
5. **Vencimentos (`dueDate`):** são instantes; a tela de lançamento envia 23:59:59 **do fuso do navegador** (não de Brasília); quem opera fora de Brasília desloca o vencimento. Fuso por empresa continua aberto (decisão 58).
6. **Retiradas e caixas por dia:** devem usar o dia de Brasília (o caixa abre e fecha em horários que cruzam as 21h UTC).

### 4.6 Riscos de segurança e RLS
- **RLS cobre empresa e filial** nas tabelas usadas: `sales`, `cash_registers`, `service_orders`, `purchase_orders` (empresa + filial) e, desde a migração `20260921120000`, `payments` e `cash_movements` (derivadas da venda e do caixa), `accounts_*` e `discount_events` (empresa + filial). Nenhuma consulta nova pode usar `prismaUnsafeBypassRLS`.
- **GER** só enxerga a filial do token (a RLS devolve zero para outra `branchId` pedida). **SUPER_ADMIN** precisa de `?companyId=` (padrão `/ceo`); endpoint novo deve seguir o mesmo.
- **Autoridade no backend:** o tipo de usuário vem do JWT; nada do que a tela esconde pode ser tido como proteção. Hoje a **API entrega `/dashboard/sales` e `/dashboard/stock` (valor de estoque a custo) a OPE e VIS**, embora a tela não os mostre; decisão 69.
- **Dados de pessoas** (vendas por operador, retiradas por autorizador, OS por mecânico): sensíveis; decisões 70 e 66.
- **Cache:** chave sempre com o escopo de visibilidade.
- **Contagem por forma de pagamento** passa por `payments` com RLS derivada: usar sempre a relação com a venda do período.

## 5. Proposta de composição do Dashboard ADM/CEO (Etapa C)

Princípio: **informação e leitura, não quantidade.** Reaproveitar `TimeSeriesChart` (Linha padrão ↔ Colunas, sem nova chamada), `CategoryBarChart` e os cartões atuais; Design System CÓRTEX (preto, branco, cinzas, verde/vermelho/amarelo discretos).

1. **Barra de controle:** período (Hoje, Ontem, 7 dias, 30 dias, Mês atual, Mês anterior, Personalizado), "Comparar com o período anterior" (liga/desliga) e filial (ADM). A API resolve o intervalo em Brasília.
2. **KPIs (6 cartões, com valor, anterior, diferença e %):** Receita, Vendas, Ticket médio, Retiradas (quantidade e valor), Cancelamentos e devoluções (quantidade) e Descontos (valor e % do bruto). Estoque baixo e contas vencidas passam para a faixa operacional.
3. **Evolução (2/3 da largura):** um gráfico temporal com seletor de métrica (Receita | Vendas | Ticket médio) sobre os mesmos dados, Linha ↔ Colunas; com "comparar" ligado, a série do período anterior alinhada por dia (série tracejada, só se a decisão 67 permitir). Dica com data, valor e, quando houver, o detalhe por forma de pagamento.
4. **Formas de pagamento (1/3):** cartões por forma (Dinheiro, Cartão, PIX, Convênio funcionário, Convênio empresa, outras), cada um com vendas, valor, ticket médio e participação; barra horizontal de uma cor para a participação. Dica por dia: formas, vendas, valor e total.
5. **Caixa e retiradas:** retiradas no tempo (gráfico pequeno, Linha ↔ Colunas), caixas abertos agora, fechamentos com divergência e forçados no período.
6. **Operação (faixa compacta, o que já existe):** OS abertas e atrasadas, estoque baixo, contas a pagar e a receber vencidas.
7. **Multi-filial:** receita por filial (já existe).
8. **Mobile (390 px):** ordem Receita, Vendas, Ticket médio, Retiradas; um gráfico por vez com o seletor de métrica; formas de pagamento em lista; o restante recolhido em "Mais indicadores". Sem rolagem horizontal.
9. **GER:** a mesma composição da sua filial (a RLS limita), sem o seletor de filial e sem ranking de pessoas.

### Novos endpoints necessários
- `GET /api/dashboard/management/summary?period=&start=&end=&compare=&branchId=`: KPIs, formas de pagamento, retiradas, cancelamentos, devoluções, descontos, divergências de caixa, cada bloco com o período atual e o anterior.
- `GET /api/dashboard/management/timeseries?period=&metric=&branchId=`: série diária ou mensal (agregada no banco, Brasília) com o detalhe por forma de pagamento para a dica.
- Reaproveitar sem mudança: `/dashboard/financial`, `/dashboard/stock`, `/dashboard/workshop`, `/dashboard/ceo` (receita por filial) e `/dashboard/pdv`.
- Reaproveitáveis com ajuste: `/dashboard/sales` (passar a agregar no banco e devolver ticket anterior e diferença), `getCashFlowSummary`.

### Arquivos que seriam alterados (Etapa D)
- **API:** `services/dashboard-management.service.ts` (novo), `routes/dashboard.routes.ts`, `utils/time-zone.ts` (início de mês, intervalos por recorte), `utils/period-range.ts` (novo: recorte → intervalo atual e anterior), testes de unidade (virada de dia, mês e ano; recortes) e de integração (RLS por filial, perfis), possivelmente uma migração de índices **só depois de medir**.
- **Admin Web:** `lib/api.ts`, `app/dashboard/page.tsx` (hoje 1220 linhas: dividir em componentes), `components/dashboard/*` (filtro de período, cartão de KPI com comparação, painel de formas de pagamento), `components/charts/ChartTooltip.tsx` e `TimeSeriesChart.tsx` (detalhe na dica; cópia idêntica no Super Admin, travada por `chart-parity.test.ts`).
- **Docs:** `DECISIONS`, `FRONTEND`, `CHANGELOG`, `ROADMAP`.

### O que NÃO deve ser implementado ainda
Margem e lucro (V28); receita líquida (V19); valor de devolução parcial e de venda cancelada (V16, V18); vendas por operador, retiradas por autorizador e OS por mecânico (V14, C04, O07); retiradas por motivo (C07); bandeira e parcelas do cartão (P06); receita de OS somada à receita de vendas (O04); fluxo de caixa consolidado (F03); giro e recorrência (E06, K02); comparação "mesmo mês do ano anterior"; cache; índices e migrações; fuso por empresa. Também **não** criar mais chamadas independentes na abertura do painel.

## 6. Decisões necessárias (numeração a partir da 60; texto completo em [DECISIONS](DECISIONS.md))

| Nº | Decisão | Bloqueia a implementação? |
|---|---|---|
| 60 | O que é "receita": vendida (hoje) ou recebida; incluir PARTIALLY_PAID; incluir OS | Sim |
| 61 | Receita líquida: tratar cancelamento, devolução total e parcial, e em que data | Sim |
| 62 | Ticket médio geral e por forma de pagamento (venda com mais de uma forma) | Sim |
| 63 | Quantidade por forma: vendas distintas ou pagamentos | Sim |
| 64 | Cartão: agrupar débito e crédito, separar ou os dois | Sim |
| 65 | Data de referência do pagamento: data da venda (hoje) ou da aprovação (PIX confirmado depois) | Não |
| 66 | Retirada: definição, reforço, motivo categorizado, exposição por pessoa | Parcial (retirada em total e série não depende) |
| 67 | Período anterior e comparações por calendário (hoje × ontem, mês, "até o mesmo dia") | Sim |
| 68 | Recortes do filtro, teto do personalizado e agrupamento automático (dia/mês) | Sim |
| 69 | Perfis por indicador e acesso de OPE/VIS pela API a `/sales` e `/stock` | Sim |
| 70 | Vendas por operador: quem vê | Não |
| 71 | Margem: estimar com custo atual ou guardar o custo na venda (mudança de esquema) | Não |
| 72 | Devolução parcial: registro datado de devolução (esquema) | Não |
| 73 | Valor da venda cancelada: valor da venda ou estornado | Não |
| 74 | Dia sem venda: zero real ou lacuna (usar o calendário de expediente, hoje vazio) | Sim |
| 75 | Fluxo de caixa do financeiro: incluir as vendas do PDV? | Não |
| 76 | Receita de OS no painel: somar ou separar | Sim |
| 77 | Convênio: receita na data da venda, a receber à parte; devolução parcial (já pendente) | Não |
| 78 | Nome na tela: "Retirada" ou "Sangria" | Não |
| 79 | Giro/cobertura de estoque e cliente recorrente: fórmulas | Não |
| 80 | Índices novos e mudança na RLS de `payments`, só depois de medir | Não |
| 81 | Fan-out do painel versus a decisão 57 (pool frio) | Sim (o desenho de endpoints depende) |
