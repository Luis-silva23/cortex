# Financeiro do convênio — contas a receber, inadimplência e bloqueio

> Área: convênios (2026-09-27). Código: `agreement-company.service.ts`, `financial.service.ts`,
> `config/scheduler.ts` (job `auto-block-agreement-companies`). Ver também [CONVENIOS.md](CONVENIOS.md) e
> [COBRANCA.md](COBRANCA.md).

## Ciclo

```
VENDA/CONSUMO (COMPANY_AGREEMENT) → CONTA A RECEBER (agreementCompanyId, vencimento = data + prazo)
  → VENCIMENTO (job mark-overdue-accounts: PENDING → OVERDUE) → COBRANÇA (manual, por pessoa autorizada)
  → PAGAMENTO → BAIXA (POST /financial/receivables/:id/receive — fluxo existente)
```

- A conta nasce `PENDING`, com a filial da venda, `referenceType='AgreementPayment'` e `referenceId` = pagamento.
- Baixa: fluxo existente de contas a receber (`finance:pay`). Agora com guarda atômica no status (`updateMany`
  `PENDING/OVERDUE → PAID`): baixa concorrente com cancelamento, ou duplo clique, não passa duas vezes.
- Cancelamento/estorno: fluxo existente (`finance:reverse`); nada é apagado. Venda de convênio cancelada ou devolvida
  (total) cancela automaticamente a conta ainda em aberto (mesma transação do cancelamento).

## Controle por conveniada (`GET /api/agreement-companies/:id/summary`, gerência+)

| Campo | Significado |
|---|---|
| `openBalance` / `openCount` | utilizado = contas `PENDING`/`OVERDUE` |
| `overdueAmount` / `overdueCount` | em aberto com vencimento passado |
| `maxDaysOverdue` | dias de atraso da conta mais antiga |
| `monthUsed` | compras do mês (não canceladas) |
| `creditLimit` / `monthlyLimit` | limites (vazio = sem limite) |
| `available` | menor entre crédito disponível e mensal disponível; `null` = sem limite |
| `delinquent` | inadimplente (há conta vencida) |

O detalhe (`GET /api/agreement-companies/:id`) acrescenta as contas (com dias de atraso e juros/multa informativos),
o nº de tentativas de cobrança e o histórico (auditoria de cadastro, bloqueios e desbloqueios).

## Juros e multa

Juros e multa **não são fixos no CÓRTEX**: cada conveniada tem os seus (`finePercent`, `interestPercentMonthly`), definidos
pela empresa no cadastro (vazio = sem encargo). Com eles, o CÓRTEX **mostra** o valor calculado sobre o atraso
(multa sobre o valor + juros simples pro rata dia, mês de 30 dias) — **só informação; nada é lançado na conta**.
Lançar encargos, quando e como é [DECISÃO NECESSÁRIA].

## Bloqueio

- **Automático** — job diário `auto-block-agreement-companies` (01:20; lista única em `config/scheduled-jobs.ts`):
  conveniada `ACTIVE` com conta em aberto vencida há **mais de X dias** → `BLOCKED`, `blockedBy='SYSTEM'`, motivo com os
  dias e o limite, auditoria `AgreementCompanyBlock`. X = `blockAfterDaysOverdue` da conveniada, senão
  `companyAgreement.defaultBlockAfterDaysOverdue`; vazio nos dois = **só bloqueio manual**. O job **não envia nada**.
- **Manual** — `POST /api/agreement-companies/:id/block` (gerência+) e `/unblock` (administração, desde 2026-09-28), motivo obrigatório (≥ 5 caracteres),
  auditados (o desbloqueio registra o bloqueio anterior). Guarda atômica no status.
- **Bloqueada**: não compra pelo convênio (`409 AGREEMENT_BLOCKED`); aparece `BLOCKED` no lookup do PDV. Histórico,
  dívida e cobrança continuam. Nunca se apaga nada.
- Desbloqueio manual com atraso ainda acima de X: o job do dia seguinte bloqueia de novo ([DECISÃO NECESSÁRIA]:
  desbloqueio negociado deveria suspender o bloqueio automático por um prazo?).

## Correção encontrada nesta rodada

`mark-overdue-accounts` rodava **sem contexto RLS**: com RLS `FORCE`, os `updateMany` afetavam 0 linhas em silêncio e
nenhuma conta a pagar/receber virava `OVERDUE` em produção. Agora roda no contexto de Super Admin, como os demais jobs
(comprovado: lógica antiga → 0 linhas; nova → marca; teste "rotina diária marca vencidas como OVERDUE").

## [DECISÃO NECESSÁRIA]

1. Lançar (ou não) juros/multa na conta vencida; regra de cálculo.
2. Desbloqueio automático quando a conveniada quita o atraso? (hoje só manual)
3. Desbloqueio negociado × bloqueio automático do dia seguinte.
4. Devolução de valor já recebido de conveniada em venda cancelada/devolvida.
