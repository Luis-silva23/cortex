# Política de caixa — fechamento normal, fechamento forçado e conciliação

> Regra decidida pelo dono em 2026-09-27. Implementação: `apps/api/src/services/cash-register.service.ts`,
> `apps/api/src/routes/cash-register.routes.ts`; PDV `components/CashCloseModal.tsx`; Admin Web
> `app/dashboard/financial/reconciliation/page.tsx`.

## Esperado × informado — todo o movimento do caixa (regra definitiva, 2026-09-28)

O fechamento considera **todo o movimento financeiro do caixa**: dinheiro, cartão (débito/crédito), PIX, convênio de
funcionário, convênio de empresa e demais formas habilitadas. Exemplo do dono: vendas de R$ 5.000 (dinheiro 1.000,
cartão 2.000, PIX 1.200, convênios 800) → esperado das vendas R$ 5.000; o dinheiro soma ainda o fundo de troco e os
reforços e desconta as sangrias.

| Forma | Esperado |
|---|---|
| Dinheiro | fundo de troco + vendas em dinheiro + reforços − sangrias − estornos em dinheiro |
| Demais formas | vendas na forma − estornos na forma |
| `NAO_IDENTIFICADO` | estorno cuja forma não dá para identificar (entra no esperado, com sinal negativo; nunca some) |

- **Estornos:** o estorno de pagamento grava a forma no movimento (desde 2026-09-28; os antigos são identificados pelo
  pagamento referenciado). O cancelamento/devolução de venda é **rateado pelo que a venda pagou neste caixa** em cada
  forma (mesmo princípio do rateio do estorno, decidido em 2026-09-25).
- **Prévia:** `GET /cash-register/:id/pendencies` devolve `expected { total, byMethod[] }` (com fundo, vendas, reforços,
  sangrias e estornos de cada forma) e `requireDifferenceReason`. O relatório (`/closure-report`) traz `expectedNow`
  enquanto aberto e `closingSummary` depois de fechado.
- **Informado:** `POST /close` e `/force-close` aceitam `declaredByMethod` (`{ CASH: 1120, CREDIT_CARD: 2000, … }`);
  a soma precisa ser igual a `actualAmount` (**400 `DECLARED_TOTAL_MISMATCH`**); forma desconhecida → **400
  `INVALID_PAYMENT_METHOD`**. Sem `declaredByMethod` o total continua aceito (clientes antigos) e é comparado com o
  esperado de todas as formas.
- **Divergência:** com diferença (≥ R$ 0,01) e a política `cash.requireDifferenceReason` ligada (padrão, só empresa),
  `differenceReason` é obrigatório (mín. 5): **400 `DIFFERENCE_REASON_REQUIRED`** com `details` (esperado, informado,
  diferença total e por forma). O caixa continua aberto. No forçado, sem motivo próprio vale o motivo do forçado.
- **Registro (`cash_registers.closingSummary`):** tipo (normal/forçado), nº do caixa, filial, período (abertura →
  fechamento), operador, quem fechou, autorizador (forçado), esperado por forma, informado por forma, diferença total e
  por forma, motivo da divergência e as vendas do caixa (nº, situação, total). Também `expectedAmount`, `actualAmount`,
  `difference` e `differenceReason` nas colunas do caixa; auditoria da rota.
- **PDV:** a tela de fechamento lista cada forma com esperado, campo do realizado e diferença; pede o motivo quando há
  diferença (`src/services/cash-close.ts`, testado em `scripts/cash-close.test.ts`).

## Pendências de um caixa

- **Pagamento pendente**: pagamento `PENDING` (PIX/terminal aguardando confirmação) de venda deste caixa.
- **Venda em aberto**: venda deste caixa em `PENDING` ou `PARTIALLY_PAID`.

## Fechamento normal

| Chave | Padrão | Efeito |
|---|---|---|
| `cash.blockCloseWithPendingPayments` | `true` | com pagamento pendente, fechamento normal recusado |
| `cash.blockCloseWithOpenSales` | `true` | com venda em aberto, fechamento normal recusado |

- Recusa: **409 `CASH_CLOSE_PENDING`** com `details`: `pendingPayments[]`, `openSales[]`, `totals`
  (quantidades e valores), `blockedBy[]`, `forceCloseRoles`. O caixa continua aberto; nada é gravado.
- As pendências são conferidas **dentro da transação**, depois de travar o caixa (o `updateMany` que reivindica o
  fechamento): o throw desfaz tudo.
- Com a política desligada o fechamento normal segue e guarda a fotografia das pendências em `pendingSnapshot`.
- `GET /api/cash-register/:id/pendencies` mostra as pendências antes de fechar (e se o normal está bloqueado).

## Fechamento forçado

`POST /api/cash-register/:id/force-close` `{ actualAmount, reason (mín. 10), notes?, authorizerNumericId?, authorizerPassword?, authorizerMfaCode? }`

- Quem pode: perfis de `cash.forceCloseRoles` (padrão Gerente, Administrador; só empresa). Quem pede **sem** o perfil
  (ex.: operador do caixa, no PDV) informa as credenciais de um autorizador **com** o perfil — outra pessoa
  (`verifyDualAuthorization`). Sem credenciais: **403 `FORCE_CLOSE_AUTHORIZATION_REQUIRED`**.
- Continua valendo "quem opera o caixa" (operador só o próprio; gerente os da filial; administração os da empresa).
- Grava `closeType = FORCED`, `forcedReason`, `closedBy` (quem pediu) e `pendingSnapshot` com: pendências (lista e
  totais), valores envolvidos, operador do caixa, quem pediu, quem autorizou, filial, nº do caixa, data/hora, abertura,
  esperado, contado, diferença e resumo dos movimentos por tipo.
- Movimento `CLOSING` com `requestedBy`/`authorizedBy` e nota "Fechamento FORÇADO — motivo…".
- **Nada é escondido nem apagado**: sangrias, reforços, pagamentos, diferença, vendas e movimentos ficam como estão;
  a venda em aberto continua em aberto e o pagamento pendente continua pendente (a reconciliação continua valendo).
- Relatório de fechamento (`GET /:id/closure-report`): `summary.closeType`, `summary.forced`, `summary.forcedReason`,
  `pendingAtClose` (fotografia) e `currentPendencies` (o que ainda não foi resolvido).
- Auditoria da rota (`CashRegister`, operação `FECHAMENTO_FORCADO`) + evento de segurança `CASH_FORCE_CLOSE_*`.
- Idempotency e limitador da segunda autorização na rota.

## Reforço de caixa

- `POST /api/cash-register/movement` agora tem `idempotency()`. O PDV envia a mesma `Idempotency-Key` para o mesmo
  reforço digitado e trava o envio (Enter repetido não lança dois reforços). Erro do reforço mostra um toast só.
- Card "Vendas do Dia" do PDV soma só movimentos de venda (menos estornos) — antes era esperado − abertura, que
  somava reforços e descontava sangrias.

## Venda cancelada e pagamento (regra definitiva)

- Venda **cancelada não recebe pagamento e não é reaberta**; nova compra = nova venda. `POST /api/payments` em venda
  `CANCELLED`/`RETURNED` → **409 `SALE_CLOSED_FOR_PAYMENT`**, venda intacta, nenhum pagamento criado.
- Provedor aprova **depois** do cancelamento = **inconsistência de integração** (`payment_exceptions`): o pagamento
  guarda a verdade (APPROVED), a venda não muda, o caixa não recebe nada, não se inventa crédito nem estorno.
- **Financeiro › Conciliação** (Admin Web, gerência+): lista abertas / tratadas, detalhe, tratar por **estorno no
  provedor** (só marca estornado com a confirmação do provedor) ou **registro manual** com justificativa (mín. 10) —
  sem criar venda nem crédito. API: `GET /api/payments/exceptions[?open=true]`, `POST /api/payments/exceptions/:id/resolve`
  (`finance:reverse`).

## Erros

| HTTP | code | Quando |
|---|---|---|
| 409 | `CASH_CLOSE_PENDING` | fechamento normal com pendências bloqueadas pela política |
| 403 | `FORCE_CLOSE_AUTHORIZATION_REQUIRED` | forçado por quem não tem o perfil, sem autorizador |
| 400 | `FORCE_CLOSE_REASON_REQUIRED` / `INVALID_AMOUNT` | motivo curto / valor inválido |
| 400 | (PT-BR) | autorizador inválido, o próprio solicitante, sem perfil; caixa já fechado |
| 409 | `SALE_CLOSED_FOR_PAYMENT` | pagamento em venda cancelada/devolvida |
| 400 | `DIFFERENCE_REASON_REQUIRED` | informado ≠ esperado sem motivo (política `cash.requireDifferenceReason`) |
| 400 | `DECLARED_TOTAL_MISMATCH` / `INVALID_PAYMENT_METHOD` | soma por forma ≠ total informado / forma desconhecida |

## Testes que provam

- `apps/api/test/integration/discount-cash-fiscal-policies.integration.test.ts` — blocos "reforço de caixa com a mesma
  Idempotency-Key" (2), "fechamento de caixa com pendências" (7) e "venda cancelada/pendente: pagamento" (2).
  Os 9 de caixa **falham no código anterior** (rodado contra a versão do HEAD e restaurado).
- `apps/api/src/services/cash-register.service.close-race.test.ts` (+2: 409 com lista; política desligada fecha).
- `apps/api/test/integration/payment-exceptions.integration.test.ts` (textos de conciliação).
- `apps/pdv-desktop/scripts/cash-summary.test.ts` (3, `npx tsx --test`).
- `apps/api/test/integration/cash-close-by-method.integration.test.ts` (8, 2026-09-28; todos vermelhos antes da
  implementação): prévia por forma com o exemplo do dono, fechamento igual/diferente, motivo obrigatório e política
  desligada, soma por forma, forma desconhecida, só o total, forçado com resumo e autorizador.
- `apps/pdv-desktop/scripts/cash-close.test.ts` (5): formato brasileiro, diferença por forma, motivo, estorno sem forma.

## Limitações

- O Admin Web não tem tela de caixa; o detalhe do fechamento forçado está no relatório de fechamento (API) e no PDV.
- Uma venda criada exatamente durante o fechamento (a criação lê o caixa aberto fora da transação) pode ficar ligada
  a um caixa fechado — já era assim; a pendência aparece em `currentPendencies` do relatório.
