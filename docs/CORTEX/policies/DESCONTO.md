# Política de desconto

> Regra decidida pelo dono em 2026-09-27. Implementação: `apps/api/src/services/discount-policy.service.ts`
> (avaliação/autorização/registro), `sale.service.ts` (venda do PDV), `service-order-discount.service.ts` (OS).

## Regra vigente

| Tipo | Sem autorização até | Chave de política | Padrão |
|---|---|---|---|
| Peças / produtos | `discount.productFreePercent` % do subtotal de peças/produtos | empresa, filial pode sobrescrever | **5%** |
| Serviços / mão de obra | `discount.serviceFreePercent` % do subtotal de mão de obra | empresa, filial pode sobrescrever | **0%** (qualquer desconto exige autorização) |
| Quem autoriza acima do limite | perfis de `discount.authorizerRoles` | só empresa | Gerente, Administrador |

- O limite de cada tipo é aplicado **sobre o subtotal do próprio tipo** (soma das peças / soma da mão de obra).
  10% de desconto na mão de obra não "cabe" nos 5% livres das peças.
- Venda do PDV: todos os itens são produtos; desconto de item + desconto geral somados contra o subtotal bruto dos
  produtos. OS: desconto informado por tipo (`partsDiscount`, `laborDiscount`).
- Tolerância de meio centavo (5% de R$ 33,33 = R$ 1,6665 → R$ 1,67 é livre).
- Acima do limite: autorização de **outra pessoa** com perfil permitido, com as próprias credenciais (ID numérico,
  senha e MFA se habilitado — `verifyDualAuthorization`). **Quem solicita nunca autoriza** — nem gerente dando
  desconto para si. **Motivo obrigatório** (mín. 5 caracteres) quando exige autorização.
- **Todo desconto é registrado**, inclusive dentro do limite livre, em `discount_events` (append-only: só INSERT/SELECT),
  item a item, na mesma transação da venda/OS: solicitante, autorizador, venda/OS, item (`itemRef`), tipo
  (`PRODUCT`/`PART`/`SERVICE`/`ORDER`), valor original, percentual, valor do desconto, valor final, limite livre vigente,
  se exigiu autorização, motivo, data/hora. Desconto geral da venda = `ORDER`; convênio (Partner) = `ORDER` com
  descrição "Convênio …".

### Combinação com a regra por papel (`DiscountRule`, tela Descontos)

A **política é a base**; uma `DiscountRule` ativa do papel (ou genérica da empresa) só **restringe mais**:

- regra excedida com `requiresApproval = true` → exige autorização (mesmo que a política libere);
- regra excedida com `requiresApproval = false` → **recusado** (409 `DISCOUNT_LIMIT_EXCEEDED`), nem com autorizador;
- sem regra cadastrada → vale só a política. A antiga regra "sem regra = desconto livre" **deixou de existir** (decisão
  do dono: o padrão é 5%).
- O convênio (Partner) não é desconto manual: não conta para o limite livre da política, mas continua contando para
  a `DiscountRule` e mantém a própria exigência de aprovação (`Partner.requiresApproval`).

### OS

- `POST /api/service-orders/:id/discount` — valores **substituem** o desconto vigente (0 remove). Só **antes do
  pagamento**: OS paga (409 `SERVICE_ORDER_ALREADY_PAID`), ENCERRADA/CANCELADA (409 `SERVICE_ORDER_CLOSED`).
- Desconto ≤ total do tipo (400 `DISCOUNT_EXCEEDS_TOTAL`). Recalcula `discountAmount` e `finalTotal`
  (= mão de obra + peças − desconto).
- Autorização só para o que **aumenta**: manter um desconto de mão de obra já autorizado e mudar só o de peças não pede
  nova autorização; reduzir também não.
- Guarda de concorrência: o `UPDATE` só acontece se a OS continua não paga, não encerrada, com os mesmos totais e o
  mesmo desconto lidos; senão 409 `SERVICE_ORDER_CHANGED` e nada é gravado.
- A divisão peças/mão de obra fica nos `discount_events` (último evento de cada tipo); `service_orders.discountAmount`
  guarda o total.

## Endpoints

| Método | Rota | Quem | Observação |
|---|---|---|---|
| POST | `/api/sales` | Operador+ | campos novos: `discountReason`; autorizador em `discountAuthorizer*` |
| GET | `/api/service-orders/:id/discount` | Operador, Gerente, Admin, Viewer | desconto vigente por tipo + histórico |
| POST | `/api/service-orders/:id/discount` | Operador, Gerente, Admin (mecânico não) | idempotency, auditoria, limitador da segunda autorização |
| GET | `/api/discount-events?saleId=&serviceOrderId=&from=&to=&itemType=&requiredAuthorization=` | Gerente+ | usuário de filial vê só a filial; traz nome de quem pediu/autorizou |
| GET | `/api/policies/effective` | todos | limites vigentes para PDV/Admin mostrarem |

## Erros

| HTTP | code | Quando |
|---|---|---|
| 409 | `DISCOUNT_AUTHORIZATION_REQUIRED` | passou o limite e não veio autorizador. `details`: `freeLimitPercent`, `requestedPercent`, `itemType`, `violations[]`, `authorizerRoles` |
| 409 | `DISCOUNT_LIMIT_EXCEEDED` | `DiscountRule` sem aprovação excedida |
| 400 | `DISCOUNT_REASON_REQUIRED` | autorizador informado sem motivo |
| 400 | (mensagem PT-BR) | autorizador inexistente, é o próprio solicitante, sem perfil, senha/MFA inválidos (mesmo padrão das demais duplas autorizações) |
| 400 | `DISCOUNT_EXCEEDS_TOTAL` / `INVALID_DISCOUNT` / `DISCOUNT_UNCHANGED` | OS: valores inválidos |
| 409 | `SERVICE_ORDER_ALREADY_PAID` / `SERVICE_ORDER_CLOSED` / `SERVICE_ORDER_CHANGED` | OS |

## Telas

- **PDV**: ao receber o 409, `api.createSale` abre o diálogo "Autorização de desconto" (limite livre vigente vindo de
  `/policies/effective`, percentual pedido, motivo, credenciais do autorizador) e reenvia a MESMA venda com nova chave
  de idempotência. Autorizador recusado → a mensagem aparece no diálogo e ele pede de novo; "Voltar" → venda não
  registrada.
- **Admin Web**: painel "Desconto" na tela da OS (`components/service-orders/ServiceOrderDiscountPanel.tsx`) com
  desconto por tipo, percentuais, limites vigentes, pedido de autorização quando o 409 chega e histórico.

## Auditoria

`discount_events` (evidência append-only), auditoria da rota (`ServiceOrder`/`Sale`), evento de segurança
`SALE_DISCOUNT_*` / `SERVICE_ORDER_DISCOUNT_*` (autorização, recusa, autoautorização bloqueada).

## Testes que provam

- `apps/api/src/services/discount-policy.service.test.ts` (12): limite por tipo, tolerância, filial, `DiscountRule`, 409/400.
- `apps/api/test/integration/discount-cash-fiscal-policies.integration.test.ts` — blocos "desconto na venda do PDV" e
  "desconto na ordem de serviço" (15), Postgres/Redis reais.

## Limitações

- O limitador da segunda autorização (3 recusas / 5 min por usuário) também conta recusas de regra (409) nas rotas que
  o usam (desconto de OS, fechamento forçado).
- `registerPayment` da OS lê o total antes da sua transação: um desconto aplicado exatamente entre essa leitura e o
  pagamento não entra no valor cobrado (código do fechamento/pagamento da OS, fora desta área).
- Orçamento (`quoteId`) ainda não grava `discount_events` (orçamento não tem desconto hoje).
