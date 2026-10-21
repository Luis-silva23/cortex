# Devolução ao fornecedor — fluxo básico do CÓRTEX

Regra do dono (2026-09-28): diferenciar claramente **garantia para cliente** (relacionada à OS — ver `GARANTIA.md`) de
**devolução ao fornecedor** (produto/peça recebido da cadeia de fornecimento). Preparar o fluxo básico
*solicitação → análise/aprovação → retirada/ajuste de estoque → envio ao fornecedor → retorno/crédito/resultado →
histórico*. As políticas específicas podem ser configuradas depois pela empresa; **nenhuma regra fiscal/comercial
universal** foi criada.

Código: `apps/api/src/services/supplier-return.service.ts`, rotas `apps/api/src/routes/supplier-returns.routes.ts`
(montadas em `/api/supplier-returns`), telas `apps/admin-web/app/dashboard/purchases/returns/**` (menu "Devolução ao
fornecedor"). Schema: `supplier_returns`, `supplier_return_items`, `supplier_return_events` e o tipo de movimento
`SUPPLIER_RETURN` (migração `20260928100000_consolidation_cash_agenda_supplier_returns`, RLS FORCE por empresa + filial).
Testes: `apps/api/test/integration/supplier-returns.integration.test.ts`, `stock-ledger.integration.test.ts`,
`apps/admin-web/lib/supplier-returns.test.ts`.

## Quando usar

| Motivo (`reason`) | Exemplo |
|---|---|
| `DAMAGED` | Produto danificado (caixa amassada, peça quebrada no transporte) |
| `DEFECTIVE` | Defeito identificado (na conferência ou no uso) |
| `WRONG_ITEM` | Produto inadequado/errado (modelo, medida, aplicação) |
| `NOT_ORDERED` | Recebido sem ter sido pedido |
| `OTHER` | Outro motivo (ex.: evitar estoque inadequado) — descreva em `description` |

Não é garantia ao cliente: a tela mostra esse aviso em todas as páginas da devolução.

## Estados e transições

```
REQUESTED ──aprovar──▶ APPROVED ──enviar──▶ SENT ──encerrar(resultado)──▶ CLOSED
    │  └─recusar──▶ REJECTED        │
    └──cancelar──▶ CANCELLED ◀──cancelar─┘   (só antes do envio)
```

| Ação | Endpoint | De → Para | Quem |
|---|---|---|---|
| Solicitar | `POST /supplier-returns` | — → REQUESTED | OPERATOR, MANAGER, COMPANY_ADMIN, SUPER_ADMIN |
| Aprovar | `POST /:id/approve` `{ notes? }` | REQUESTED → APPROVED | perfis da política `supplierReturn.approverRoles` (padrão MANAGER + COMPANY_ADMIN; SUPER_ADMIN sempre), **nunca quem solicitou** |
| Recusar | `POST /:id/reject` `{ reason }` | REQUESTED → REJECTED | idem aprovar (motivo ≥ 5 caracteres) |
| Enviar | `POST /:id/send` `{ shippingInfo? }` | APPROVED → SENT | OPERATOR+ |
| Encerrar | `POST /:id/close` `{ outcome, outcomeAmount?, outcomeNotes?, receivedItems? }` | SENT → CLOSED | perfis da política |
| Cancelar | `POST /:id/cancel` `{ reason }` | REQUESTED/APPROVED → CANCELLED | REQUESTED: quem solicitou ou perfil da política; APPROVED: só perfil da política |
| Consultar | `GET /` (`status`, `supplierId`, `branchId`, `page`, `limit ≤ 100`) e `GET /:id` | — | todos exceto MECHANIC (VIEWER só consulta) |

- Módulo: **COMPRAS** (`requireModuleEnabled('COMPRAS')`). MECHANIC é negado em toda a rota (mesma regra de pedidos de compra).
- Empresa vem do token; a filial é a do token (usuário de filial) ou uma filial validada da empresa (usuário de empresa
  inteira precisa informar). `companyId`/`branchId` do corpo nunca são confiados.
- Toda troca de status é **atômica** (`updateMany … where status = <lido>`): duas ações simultâneas → uma vence, a outra
  recebe 409 `SUPPLIER_RETURN_STATUS_CHANGED`. Toda escrita aceita `Idempotency-Key` e é auditada
  (`entity = SupplierReturn`, `action` = `REQUEST_/APPROVE_/REJECT_/SEND_/CLOSE_/CANCEL_SUPPLIER_RETURN`).
- Numeração `returnNumber`: sequencial **por empresa**, sob advisory lock 4220 (chave = empresa). A leitura do maior
  número é feita no escopo da empresa inteira dentro da transação — com a RLS por filial, um operador da filial 2 só
  enxergava os números da filial 2 e colidia com os da filial 1.
- Isolamento: além da RLS, o serviço aplica o mesmo escopo de filial (usuário de filial só vê/age na própria filial;
  COMPANY_ADMIN/SUPER_ADMIN em todas as filiais da empresa). Outra empresa/filial → 404.

## Estoque

| Momento | Movimento (`stock_movements`) | Observação |
|---|---|---|
| Solicitar | nenhum | a solicitação não mexe no estoque |
| **Aprovar** | `SUPPLIER_RETURN` (saída) por item, `referenceType = 'SupplierReturn'`, `referenceId = id` | na **mesma transação** da aprovação; saldo conferido com a linha do produto travada (`FOR UPDATE`, ordem por id), como venda/avaria. Produto sem `allowNegativeStock` não fica negativo → **409 `SUPPLIER_RETURN_INSUFFICIENT_STOCK`** e nada muda. Grava `stockWithdrawnAt` |
| Cancelar aprovada | `RETURN` (entrada) por item, referenciado | o estoque volta; a devolução fica CANCELLED (nunca é apagada) |
| Encerrar com `REPLACEMENT` | `PURCHASE` (entrada), referenciado | **só** se o usuário informar `receivedItems` (produto da devolução, quantidade ≤ devolvida). Sem isso, nada entra |
| Enviar / recusar / outros resultados | nenhum | |

- `SUPPLIER_RETURN` é saída no livro (`stock-ledger.ts::OUTBOUND_TYPES`, usado no SQL do saldo e em
  `stock.service.ts::applyMovementToBalance`). Antes o tipo caía no `ELSE 0` e a mercadoria devolvida continuava no saldo.
- Item ligado a uma avaria (`damageRecordId`, mesma empresa/filial/produto, não revertida, quantidade ≤ avariada): a
  avaria já tirou a mercadoria do estoque (`LOSS`), então a aprovação **não** baixa de novo esse item (nem o
  cancelamento devolve). A mesma avaria não entra em duas devoluções ativas além da quantidade avariada (409
  `DAMAGE_RECORD_ALREADY_RETURNED`).

## Resultado (`outcome`)

`CREDIT` (crédito com o fornecedor), `REPLACEMENT` (reposição), `REFUND` (reembolso), `REFUSED_BY_SUPPLIER` (fornecedor
recusou). `outcomeAmount` (≥ 0) e `outcomeNotes` são opcionais e **apenas registrados**.

## Erros (todos com mensagem em português "o que aconteceu + o que fazer")

| HTTP | Código | Quando |
|---|---|---|
| 400 | `VALIDATION_ERROR` | corpo inválido (quantidade ≤ 0, motivo/resultado fora da lista, sem itens, motivo de recusa/cancelamento < 5) |
| 400 | `SUPPLIER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `PURCHASE_ORDER_NOT_FOUND` | cadastro de outra empresa/filial ou inexistente (produto cadastrado só para outra filial também) |
| 400 | `PURCHASE_ORDER_SUPPLIER_MISMATCH`, `PURCHASE_ORDER_BRANCH_MISMATCH` | pedido de compra de outro fornecedor/filial |
| 400 | `SUPPLIER_RETURN_DUPLICATE_ITEM`, `SUPPLIER_RETURN_SERVICE_ITEM` | produto repetido; item que é serviço |
| 400 | `DAMAGE_RECORD_*` | avaria inexistente, revertida, de outro produto/filial ou quantidade maior |
| 400 | `SUPPLIER_RETURN_RECEIPT_NOT_REPLACEMENT`, `SUPPLIER_RETURN_RECEIPT_UNKNOWN_PRODUCT`, `SUPPLIER_RETURN_RECEIPT_EXCEEDS` | entrada de reposição fora de REPLACEMENT, de produto fora da devolução ou acima do devolvido |
| 400 | `BRANCH_REQUIRED`, `BRANCH_NOT_FOUND` | usuário de empresa inteira sem filial / filial de outra empresa |
| 403 | `BRANCH_FORBIDDEN` | usuário de filial tentando registrar em outra filial |
| 403 | `SUPPLIER_RETURN_FORBIDDEN` | VIEWER tentando escrever |
| 403 | `SUPPLIER_RETURN_APPROVER_REQUIRED` | perfil fora da política aprovando/recusando/encerrando/cancelando aprovada |
| 403 | `SUPPLIER_RETURN_SELF_DECISION` | solicitante aprovando/recusando a própria devolução |
| 403 | `SUPPLIER_RETURN_CANCEL_FORBIDDEN` | quem não solicitou nem é aprovador cancelando uma solicitação |
| 403 | `MODULE_DISABLED` | módulo COMPRAS desligado |
| 404 | `SUPPLIER_RETURN_NOT_FOUND` | não existe, é de outra empresa ou de outra filial |
| 409 | `SUPPLIER_RETURN_INVALID_TRANSITION` | ação incompatível com a situação (ex.: enviar solicitada, cancelar enviada) |
| 409 | `SUPPLIER_RETURN_STATUS_CHANGED` | outra pessoa alterou a devolução no mesmo instante |
| 409 | `SUPPLIER_RETURN_INSUFFICIENT_STOCK` | saldo da filial menor que o a devolver (lista produto, disponível, a devolver) |
| 409 | `DAMAGE_RECORD_ALREADY_RETURNED`, `SUPPLIER_RETURN_NUMBER_CONFLICT` | avaria já devolvida; numeração concorrente esgotou as tentativas |

## Histórico

`supplier_return_events` (nunca apagado): `REQUESTED`, `APPROVED`, `STOCK_WITHDRAWN`, `REJECTED`, `SENT`, `CLOSED`,
`REPLACEMENT_RECEIVED`, `CANCELLED` (com o motivo), `STOCK_RESTORED` — com quem, quando, de/para e observação.
`GET /:id` devolve o histórico com nomes, os movimentos de estoque ligados e `allowedActions` (o que o usuário atual
pode fazer, calculado pela API: papel, política e solicitante).

## O que NÃO foi definido (depende de decisão da empresa/contador)

- **Crédito/reembolso financeiro**: o resultado não gera conta a pagar/receber, abatimento em título do fornecedor nem
  lançamento de caixa. Só o tipo e o valor ficam registrados.
- **Fiscal**: não há emissão de NF-e de devolução de compra (CFOP de devolução, destaque/estorno de impostos). O campo
  `shippingInfo` aceita o número do documento emitido fora do sistema.
- **Fornecedor recusou e a mercadoria voltou**: não há entrada automática; hoje use ajuste de estoque. Se a empresa
  quiser, dá para permitir `receivedItems` também em `REFUSED_BY_SUPPLIER`.
- **Prazos** (dias para o fornecedor responder), limite de valor para aprovação e exigência de foto/anexo: sem regra.
- Devolução parcial em mais de um envio: hoje um envio por devolução (abra outra devolução para o restante).
