# Convênios — funcionário e empresa externa

> Área: convênios (2026-09-27). Código: `apps/api/src/services/employee-agreement.service.ts`,
> `agreement-company.service.ts`, `agreement-effects.ts`, `agreement-common.ts`, `payment.service.ts`
> (`processAgreementPayment`). Rotas: `employee-agreements.routes.ts`, `agreement-companies.routes.ts`.
> Testes: `apps/api/test/integration/agreements.integration.test.ts`.

O CÓRTEX tem **dois tipos de convênio, que não se misturam**:

| Tipo | Quem paga | O que a venda gera | Forma de pagamento |
|---|---|---|---|
| **A. Convênio de funcionário** | o funcionário, por desconto em folha | utilização + parcelas por competência (`employee_agreement_charges`, `employee_payroll_deductions`) | `EMPLOYEE_AGREEMENT` |
| **B. Convênio com empresa externa** | a empresa conveniada, no vencimento | conta a receber (`accounts_receivable.agreementCompanyId`) | `COMPANY_AGREEMENT` |

**Não é o "convênio/parceiro de desconto"** (`partners`, tela Descontos): aquele só concede desconto na venda e
continua intacto. A tela "Convênios" do Admin Web avisa isso no topo.

## Políticas (Configurações › Políticas)

| Chave | Padrão | Efeito |
|---|---|---|
| `employeeAgreement.enabled` | `false` | desligado: PDV recebe `400 AGREEMENT_DISABLED` (pagamento e lookup) |
| `employeeAgreement.limitType` | `FIXED` | `FIXED` = R$/mês; `SALARY_PERCENT` = % do salário/mês |
| `employeeAgreement.limitValue` | `0` | valor do limite padrão (R$ ou %) |
| `employeeAgreement.maxInstallments` | `1` | parcelas máximas em folha |
| `companyAgreement.enabled` | `false` | desligado: `400 AGREEMENT_DISABLED` |
| `companyAgreement.defaultPaymentTermDays` | `30` | prazo sugerido no cadastro da conveniada |
| `companyAgreement.defaultBlockAfterDaysOverdue` | vazio | vazio = só bloqueio manual |

As chaves `*.enabled` aceitam **valor por filial** (desde 2026-09-28: desligar o convênio só numa filial); as demais
valem para a empresa inteira. Desligado, o PDV **mostra a forma de pagamento cinza** com a mensagem "Convênio de
funcionário/com empresa não habilitado para esta filial. Entre em contato com o administrador." (a API recusa do mesmo
jeito). Cadastros podem ser feitos com a política desligada; só a venda é recusada.

**Autorização administrativa (2026-09-28):** cadastrar, mudar limite/situação/filiais e **desbloquear** convênio é da
**administração** (`SUPER_ADMIN`, `COMPANY_ADMIN`); a gerência consulta, bloqueia (proteção) e dá baixa na folha. O
caixa usa convênio respeitando **empresa + filial + convênio + usuário + permissão**: a filial é a da venda (nunca a do
corpo do pedido) e cada convênio pode ter a lista de filiais onde vale (`allowedBranchIds`; vazio = todas).

## A. Convênio de funcionário

- **Cadastro** (administração: `SUPER_ADMIN`, `COMPANY_ADMIN`; gerência só consulta): nome, CPF (validado; único por empresa),
  matrícula, salário, situação (`ACTIVE`/`SUSPENDED`/`ENDED`), vínculo opcional a usuário/cliente, e **limite próprio**
  opcional (`limitType` + `limitValue`, os dois ou nenhum; nulos = segue a política).
- **Salário** só aparece para gerência+ (lista/detalhe). O lookup do PDV não traz salário; a auditoria do cadastro
  também não grava salário.
- **Limite mensal por competência** (AAAA-MM, no fuso da política `company.timezone`):
  `FIXED` → valor; `SALARY_PERCENT` → salário × % (ex.: R$ 3.000 × 10% = R$ 300).
  **Disponível = limite − parcelas `SCHEDULED`/`DEDUCTED` daquela competência** (ex.: usou R$ 180 → disponível R$ 120).
- **Compra** (`POST /payments`, `EMPLOYEE_AGREEMENT`): numa única transação, com a venda travada e **a linha do convênio
  travada (`FOR UPDATE`)**, grava o pagamento `APPROVED`, divide o valor em N parcelas (centavos exatos, sobra nas
  primeiras) a partir da competência da compra e **confere o limite em cada competência**. Qualquer recusa desfaz tudo.
  Duas compras simultâneas do mesmo funcionário serializam — a segunda enxerga o uso da primeira (testado).
- Convênio, utilizações e parcelas ficam com `branchId` nulo (empresa inteira): o limite vale em todas as filiais e a
  RLS de filial não esconde o uso feito em outra filial (testado: filial A2 enxerga o uso da A1).
- Cada utilização registra: funcionário, CPF, matrícula, venda (itens pela venda), valor, data, parcelas, valor por
  competência, saldo futuro e quem registrou (`authorizedBy`/`createdBy` = operador).
- **Folha** (`GET /employee-agreements/deductions?competence=`): parcelas da competência com totais por funcionário.
  **Baixa** (`POST /employee-agreements/deductions/:id/process`, gerência+): `SCHEDULED → DEDUCTED` uma única vez
  (guarda atômica), com `processedAt/By`; competência futura é recusada (`409 DEDUCTION_FUTURE_COMPETENCE`).
- **Espelho do funcionário** (`GET /employee-agreements/:id/statement?competence=`; gerência+ ou o próprio usuário
  vinculado): empresa, funcionário, CPF, matrícula, limite/utilizado/disponível, compras com itens, parcela n/N, valor
  e situação, saldo futuro, aviso legal. Página imprimível no Admin Web com linhas de assinatura.
- **Venda cancelada ou devolvida (total)**: parcelas ainda `SCHEDULED` → `CANCELLED`, utilização marcada cancelada. Parcelas
  já `DEDUCTED` **ficam** e aparecem como "a compensar" — nenhum estorno é inventado ([DECISÃO NECESSÁRIA] abaixo).
  O mesmo vale para cancelar/estornar o pagamento (`/payments/:id/cancel|refund`).
- **Legislação**: o CÓRTEX **não presume limite legal** de desconto em folha. A empresa deve respeitar a legislação
  trabalhista aplicável e guardar a autorização assinada do funcionário (texto na tela e no espelho).

## B. Convênio com empresa externa

- **Cadastro** (administração; gerência só consulta): razão social, fantasia, CNPJ (validado; único por empresa), responsável, telefone,
  WhatsApp, e-mail, endereço, condições comerciais, limite de crédito, limite mensal, prazo (10/15/30/personalizado),
  juros ao mês, multa, bloqueio após X dias (vazio = política), situação (`ACTIVE`/`BLOCKED`/`INACTIVE`) e filiais
  onde pode comprar. Juros, multa, prazo, limite, bloqueio e condições (texto livre para renegociação/devolução) são
  **da empresa, por conveniada** — nada disso é fixo no CÓRTEX.
- **Compra** (`COMPANY_AGREEMENT`): trava a conveniada, confere situação (`BLOCKED` → `409 AGREEMENT_BLOCKED`;
  `INACTIVE` → `409 AGREEMENT_INACTIVE`) e limite; cria a **conta a receber** com `agreementCompanyId`,
  `referenceType='AgreementPayment'`, `referenceId=<pagamento>`, filial da venda e **vencimento = data + prazo** (fim do
  dia local). Fluxo financeiro em [FINANCEIRO.md](FINANCEIRO.md).
- **Disponível** = menor entre (limite de crédito − em aberto) e (limite mensal − compras do mês); limite vazio = sem
  limite naquela dimensão (`available: null` = sem limite).
- Venda cancelada/devolvida → conta em aberto `CANCELLED` com nota (nunca apagada); conta já recebida fica `PAID`.

## Contrato do PDV (implementado)

| Chamada | Quem | Resposta |
|---|---|---|
| `GET /api/employee-agreements/lookup?q=` | SUPER_ADMIN, COMPANY_ADMIN, MANAGER, OPERATOR | `[{ id, name, cpfMasked, registration, status, limit, used, available, maxInstallments, availableHere, unavailableReason }]` — só ativos, sem salário; `availableHere: false` = existe mas não vale nesta filial (PDV mostra cinza com `unavailableReason`) |
| `GET /api/agreement-companies/lookup?q=` | idem | `[{ id, legalName, tradeName, cnpjMasked, status, available, paymentTermDays, availableHere, unavailableReason }]` — ativas e bloqueadas (`BLOCKED` visível); inativas fora; `available: null` = sem limite |
| `POST /api/payments` | idem | `paymentMethod: 'EMPLOYEE_AGREEMENT'` + `employeeAgreementId` + `installments` (1..max) **ou** `paymentMethod: 'COMPANY_AGREEMENT'` + `agreementCompanyId` |

Erros (`{ error, code, details? }` no `POST /payments`; `{ message, code }` nos lookups):
`400 AGREEMENT_DISABLED` (política desligada — também nos lookups), `400 AGREEMENT_REQUIRED` (id ausente ou do tipo
errado), `400 INSTALLMENTS_INVALID`, `400 AGREEMENT_NOT_APPLICABLE` (id de convênio com outra forma de pagamento),
`404 AGREEMENT_NOT_FOUND` (inclusive de outra empresa), `409 AGREEMENT_LIMIT_EXCEEDED` com
`details: { available, limit, used, competence, requested }` (funcionário) ou
`details: { available, creditAvailable, monthlyAvailable, requested }` (conveniada), `409 AGREEMENT_BLOCKED`,
`409 AGREEMENT_INACTIVE`, `409 AGREEMENT_NOT_ENABLED_FOR_BRANCH` ("Convênio não habilitado para esta filial. Entre em
contato com o administrador." — convênio fora das filiais liberadas).

## Caixa

Segue a regra atual do caixa (`applyApprovedPaymentEffects`): o pagamento de convênio gera movimento `SALE` com a forma
de pagamento `EMPLOYEE_AGREEMENT`/`COMPANY_AGREEMENT` e soma ao esperado — **não é dinheiro da gaveta**. Regra do dono
(2026-09-28): o fechamento confronta esperado × informado **por forma de pagamento**, convênios incluídos
([CAIXA](CAIXA.md#esperado--informado--todo-o-movimento-do-caixa-regra-definitiva-2026-09-28)). Cancelamento/estorno revertem o movimento como nos demais métodos.

## [DECISÃO NECESSÁRIA]

1. **Parcela já descontada em folha de venda cancelada/devolvida**: devolver ao funcionário (como? na próxima folha?)
   ou compensar em compra futura. Hoje fica registrada "a compensar", sem movimento.
2. **Devolução PARCIAL de venda de convênio**: hoje não altera parcelas nem a conta a receber (só a devolução total).
3. **Corte de folha**: compra depois do fechamento da folha do mês deveria cair na competência seguinte? Hoje a 1ª
   parcela é sempre a competência da data da compra.
4. **Conta de conveniada já recebida e depois cancelada/devolvida**: como devolver o valor à conveniada.
