# Commerce API e canais — proposta de desenho (Fase 1A)

> **Desenho de 2026-10-05 para as decisões 82 a 92 de [DECISIONS](DECISIONS.md), usado como especificação de implementação** (o dono autorizou a execução técnica das fases em 2026-10-05). **O que é regra comercial continua PENDENTE e não foi inventado:** onde o desenho depende de decisão do dono, o código tem só a estrutura mais conservadora e a decisão segue aberta em DECISIONS.
> **Estado:** **Fases 1, 2 e 3 IMPLEMENTADAS** (a 3 só com provedor simulado) (ver [§0](#0-implementação--estado-em-2026-10-05)); as demais fases seguem como proposta (§4 em diante, onde não houver nota "implementado").
> Esta é a **fonte única** do desenho: [DECISIONS](DECISIONS.md), [ROADMAP](ROADMAP.md) e [CANAIS](CANAIS.md) apontam para cá e não repetem o conteúdo.
> Base: leitura do código e da documentação de 2026-10-05 (arquivos citados em cada ponto). O que é **fato do código** está separado do que é **proposta**.

## 0. Implementação — estado em 2026-10-05

### Fase 1 — Commerce API (feita)
Superfície `/commerce/v1` (roteador próprio, **fora** de `/api`, montado antes do CORS global, do limite geral e do parser de 5 MB). Contrato em [commerce-api.openapi.yaml](commerce-api.openapi.yaml).

| Recurso | Rota | Escopo | Observação |
|---|---|---|---|
| Catálogo | `GET /products`, `GET /products/:sku`, `GET /categories` | `CATALOG_READ` | só o **publicado** para o canal, ativo, da empresa e da filial do canal; sem custo nem ids internos; `inStock` e, se o canal configurar, `availableQuantity` |
| Pedido | `POST /orders` | `ORDERS_WRITE` | `Idempotency-Key` **obrigatória**; preço oficial do CÓRTEX; cria `RECEIVED`; **não** é venda |
| Pedido | `GET /orders/:id` | `ORDERS_READ` | só do próprio canal |
| Pedido | `POST /orders/:id/cancel` | `ORDERS_WRITE` | em `RECEIVED` ou `ACCEPTED` (libera a reserva); repetir é inofensivo |
| Pagamento | `POST /orders/:id/payment-events` | `PAYMENT_EVENTS_WRITE` | evento do provedor/canal; separado de pedido, venda e caixa |

Administração (JWT de COMPANY_ADMIN/SUPER_ADMIN, módulo `CANAIS`): `/api/sales-channels/:id/api-credentials` (listar, criar, trocar, revogar), `/:id/products` (listar e publicar/despublicar por SKU), `/:id/orders` (listar, detalhar, recusar, cancelar). Tela: Canais de venda → painel "Commerce API" nos canais de site e "outro".

**Banco** (migração `20261005100000_commerce_api_foundation`, aditiva, RLS `FORCE` empresa+filial): `channel_api_credentials`, `channel_product_links`, `external_order_items`, `external_payments` e 6 colunas novas em `external_orders`.

**Decisões técnicas tomadas na implementação** (não são regra comercial; registradas em [DECISIONS › Tomadas](DECISIONS.md#tomadas)):
- **Autenticação por canal, não por usuário.** Cabeçalhos `X-Cortex-Key` (identificador público `ck_…`), `X-Cortex-Timestamp` e `X-Cortex-Signature` (`v1=` + HMAC-SHA256 de `timestamp\nMÉTODO\ncaminho+query\nsha256(corpo)`), janela de 300 s, comparação em tempo constante. Todas as falhas de identidade (sem chave, chave desconhecida, assinatura errada, carimbo velho, credencial revogada ou vencida) respondem o **mesmo** 401.
- **Correção do desenho (§6.3):** o HMAC precisa do segredo; por isso o segredo é guardado **cifrado** (`enc:v1`, a mesma chave dos demais segredos) e **não** só com hash. Mostrado uma vez, nunca devolvido.
- A empresa, a filial e o canal vêm da **credencial**; o contexto RLS é aberto com o tipo de usuário `CHANNEL` (limitado à filial; falha fechada). A busca da credencial por `keyId` é a **única** consulta sem RLS da API pública.
- **O canal precisa de uma filial de atendimento** para emitir credencial (`CHANNEL_BRANCH_REQUIRED`): conservador, enquanto a decisão de produto sobre filial de atendimento e pedido dividido (§16) não existe. Só canais `SITE_PROPRIO` e `OUTRO` emitem credencial; no máximo 5 ativas por canal; troca com sobreposição (24 h por padrão, até 168 h).
- **Preço:** o canal envia o preço que mostrou; se for diferente do oficial ou o total não bater (calculado em centavos), o pedido **inteiro** é recusado (`PRICE_MISMATCH`/`TOTAL_MISMATCH`). É o comportamento conservador; a regra definitiva é a decisão 89, **pendente**.
- **Disponibilidade:** `max(0, saldo da filial − margem)` limitado por cota opcional; padrão sem margem, sem cota e **sem quantidade exata** (`inStock` apenas). Configurável por canal em `config` (`stockSafetyMargin`, `stockQuota`, `exposeStockQuantity`); os valores são decisão do dono (90), **pendentes**.
- **Conexão:** o site próprio não tem provedor (o site chama o CÓRTEX). `SITE_PROPRIO` deixou de ter provedor padrão; o canal vira `CONNECTED` na **primeira chamada assinada válida** (validação real) e fica `UNVALIDATED` ao emitir a credencial.
- **Pedido ≠ venda:** o pedido grava itens imutáveis e **nada mais**: nenhuma venda, pagamento do balcão, movimento de caixa ou de estoque (provado por teste). Repetição com o mesmo conteúdo devolve o pedido (200 `replayed`); com conteúdo diferente, 409.
- **Pagamento externo:** `external_payments` com `providerRef` único por canal e evento único por canal (`eventId`). Estados monotônicos (PENDING → CONFIRMED | FAILED; CONFIRMED → REFUNDED), evento mais antigo é `STALE`, duplicado é `DUPLICATE`, valor diferente do total ou pagamento em pedido encerrado geram alerta e **não** são descartados. Origem sempre `CHANNEL_REPORTED`: o CÓRTEX só recebe, não cobra.
- **Limites:** 300 requisições/min por credencial e 20 falhas de autenticação/min por IP (`COMMERCE_RATE_LIMIT_PER_MIN`, `COMMERCE_AUTH_FAILURES_PER_MIN`); corpo de até 256 KB; página de até 100. Contadores no Redis com seguro em memória; **nada de negócio** depende do Redis.

**Como um site assina uma chamada** (Node):
```js
const crypto = require('crypto');
function signedHeaders(keyId, secret, method, pathWithQuery, rawBody = '') {
  const ts = Math.floor(Date.now() / 1000);
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const mac = crypto.createHmac('sha256', secret).update(`${ts}\n${method.toUpperCase()}\n${pathWithQuery}\n${bodyHash}`).digest('hex');
  return { 'X-Cortex-Key': keyId, 'X-Cortex-Timestamp': String(ts), 'X-Cortex-Signature': `v1=${mac}` };
}
```
`pathWithQuery` é exatamente o que o servidor recebe (ex.: `/commerce/v1/products?limit=20`), e `rawBody` os mesmos bytes enviados.

**Códigos de erro estáveis:** `UNAUTHORIZED`, `INSUFFICIENT_SCOPE`, `CHANNEL_DISABLED`, `RATE_LIMITED` (com `Retry-After`), `INVALID_REQUEST`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `IDEMPOTENCY_KEY_REQUIRED`, `NOT_FOUND`, `PRODUCT_UNAVAILABLE`, `PRICE_MISMATCH`, `TOTAL_MISMATCH`, `ORDER_CONFLICT`, `INVALID_ORDER_STATE`, `PAYMENT_REF_IN_USE`, `INTERNAL_ERROR`. Toda resposta de erro leva `requestId` (também em `X-Request-Id`).

**Provado por** 43 testes de integração (Postgres e Redis reais: credencial, HMAC, escopos, catálogo, pedido, pagamento, administração, RLS, concorrência de 5 requisições) e 17 unitários.

**Ainda NÃO existe:** devolução e estorno de canal (a venda de canal cancela/devolve pelo fluxo normal, sem estorno ao canal), chave publicável e CORS por canal, sincronização **automática** para terceiros, integração real de qualquer provedor (a Fase 3 entregou o gateway genérico e um provedor simulado).


### Fase 2 — Reserva de estoque e conversão em venda (feita)
Rotas de administração novas (COMPANY_ADMIN/SUPER_ADMIN, módulo `CANAIS`): `POST /api/sales-channels/:id/orders/:orderId/accept`, `.../convert`, `PATCH .../fulfillment`; a listagem de pedidos passou a trazer `saleNumber` e `fulfillment`. O cancelamento (administração e canal) vale também para pedido **aceito** e libera a reserva.

**Banco** (migrações `20261005200000_stock_reservations_and_channel_sales` e `20261005210000_stock_movement_user_optional`, aditivas, com nota de reversão, RLS `FORCE` empresa+filial): `stock_reservations` (única por pedido+produto), `fulfillments` (uma por pedido e por venda); `sales.userId` e `sales.cashRegisterId` passaram a aceitar nulo **protegidos por `CHECK sales_physical_origin_check`** (venda sem usuário/caixa só existe com `channelId`); `stock_movements.userId` opcional; `external_orders` ganhou `saleId` (único, FK), `acceptedAt`, `acceptedBy`, `convertedAt` e o estado `EXPIRED`. 101 modelos, 47 enums, 29 migrações.

**Decisões técnicas tomadas (não são regra comercial):**
- **Reserva não é movimento do livro** (o inventário fixa saldo absoluto e apagaria uma promessa). **Disponível = saldo do livro da filial − reservas `ACTIVE` ainda não vencidas.** Reserva vencida deixa de contar **na hora** (sem depender de rotina); o job `expire-stock-reservations` (a cada minuto, BullMQ) só marca `EXPIRED`, expira o pedido e avisa. Idempotente.
- **Aceitar = reservar tudo ou nada**, na mesma transação que trava os produtos **em ordem de id**. **O prazo (`reservationTtlMinutes`) não tem valor padrão**: sem ele o aceite é recusado (`RESERVATION_TTL_NOT_CONFIGURED`). Política do canal em `config`: `reservationTtlMinutes`, `autoAcceptOrders`, `autoConvertOnPaymentConfirmed` — **tudo desligado por padrão**.
- **Todas as saídas comerciais conferem o disponível**, não o saldo físico: venda do balcão/PDV, peça de OS (adicionar e iniciar execução), envio de transferência, transferência direta, devolução ao fornecedor e movimento manual `SALE`/`SUPPLIER_RETURN`/`TRANSFER_OUT`. **Avaria, perda, ajuste e inventário NÃO são bloqueados** (a verdade física vence); a reserva que ficou sem lastro é sinalizada (`flagShortfalls`) e a conversão recusa (`INSUFFICIENT_PHYSICAL_STOCK`) em vez de criar saldo negativo.
- **Ordem fixa de trava corrigida no que já existia:** `createSale` travava os produtos na ordem de chegada (A: p1,p2 × B: p2,p1 podia dar deadlock); passou a travar por id, como a OS e a conversão. Ordem global: pedido externo → advisory lock do número da venda (4202) → produtos por id.
- **ConvertOrder** (única porta de pedido → venda; uma transação; idempotente — repetir ou converter em paralelo devolve a mesma venda): exige pagamento **CONFIRMADO cobrindo o total**; consome a reserva (se venceu e o dinheiro está confirmado, tenta reservar de novo só com estoque disponível); cria a venda `PAID` de canal (preço do pedido, `userId`/`cashRegisterId` nulos), o pagamento `APPROVED` (provider `external:<tipo>`, `transactionId = ext:<canal>:<referência>`), uma saída `SALE` por item e o fulfillment `PENDING`. **Não cria `CashMovement` nem altera `expectedAmount`**: dinheiro de canal não passa pela gaveta (provado).
- **Fulfillment mínimo:** `PENDING → READY → PICKED_UP | IN_TRANSIT → DELIVERED | FAILED_DELIVERY → …`, tipos `PICKUP`/`OWN_DELIVERY`/`CHANNEL_DELIVERY`; sem pular estados, finais não voltam, repetir é inofensivo. Quem separa/entrega, frete e endereço **não** foram decididos (pendência 101).
- Cancelar/devolver a venda de canal usa o fluxo normal (autorização dupla): repõe estoque e, sem caixa, **não inventa movimento de caixa**; o estorno ao canal/cliente é externo e manual (pendência 99).

**Provado por** 25 testes de integração (`commerce-reservations.integration`: aceite com e sem prazo, tudo ou nada, PDV × reserva, disputa da última unidade aceite × PDV e aceite × aceite, vendas simultâneas em ordem oposta, conversão com todas as verificações, idempotente e concorrente, webhook de pagamento duplicado sem segunda venda, reserva vencida/refeita/perdida, baixa física, fulfillment, RLS) e 4 unitários novos; regressão: API unitários 1016/1016, integração completa 89 suítes / 1354 testes, Admin Web 546/546; `db:check-rls` OK.

### Fase 3 — Integration Gateway (feita, só provedor simulado)
Documento próprio: **[INTEGRATION_GATEWAY](INTEGRATION_GATEWAY.md)** (contrato do provedor, webhook, consulta periódica, caixa de saída, política de falha, segurança, como implementar um provedor real). Resumo:
- **Entrada:** `POST /integrations/v1/webhooks/:channelId` (superfície própria): assinatura HMAC com janela de 300 s, mesmo 401 para qualquer falha de identidade, bloqueio de IP por falhas, limite por canal, empresa/filial do canal no banco; eventos normalizados de esquema fechado aplicados pelos **mesmos serviços** da Commerce API; idempotência por evento (webhook duplicado não cria segunda venda, cobrança nem movimento de estoque), fora de ordem guardado e aplicado quando o pedido chega, correlação por `X-Request-Id`. Job `poll-channel-events` cobre o webhook que não chegou.
- **Saída:** `channel_outbox` gravada na transação da mudança (aceitar, expirar, cancelar, recusar, converter, entrega), enviada por job por minuto com prazo, espera crescente, tratamento por classe de erro (401/403 pausa o canal, 429 respeita Retry-After, 4xx não repete, 5xx/timeout repetem), disjuntor por canal e prazo máximo de 24 h; sincronização sob demanda de estoque disponível, preço e catálogo. Nenhuma chamada externa no caminho do PDV.
- **Correções no que já existia:** o catálogo da Commerce API expunha o **saldo físico** em vez do **disponível** (saldo − reservas) — corrigido (a Fase 2 havia deixado essa lacuna); o tratador de erros das superfícies públicas passou a ser um só.
- **Banco:** migração `20261006100000_integration_gateway` (aditiva, reversão documentada): `channel_outbox` (RLS), colunas na caixa de entrada (`payload`, `occurredAt`, `orderRef`, `correlationId`, `attempts`, `processedAt`, `lastError`) e `sales_channels.inboundCursor`. 102 modelos, 48 enums, 30 migrações.
- **Pendências novas (decisões do dono):** 103 a 105 em [DECISIONS](DECISIONS.md#pendentes).

## 1. O que o código faz hoje (verificado)

| # | Fato | Onde |
|---|---|---|
| F1 | A venda exige **caixa aberto** (`cashRegisterId` obrigatório, da mesma filial) e **usuário interno** (`userId` obrigatório). Não tem endereço nem entrega | `schema.prisma` (`Sale`); `sale.service.ts` `createSale` |
| F2 | A venda nasce **PENDING e já baixa o estoque** (movimento `SALE` na mesma transação). Venda pendente **não expira** (decisão 5 aberta): hoje é uma "reserva" de fato, sem prazo | `sale.service.ts` (criação e laço de itens) |
| F3 | O estoque é o **livro** `stock_movements`; o saldo é calculado no banco por filial. `INVENTORY` **fixa** o saldo absoluto. **Não existe** o conceito de reservado | `stock-ledger.ts` (`applyMovement`) |
| F4 | Toda baixa trava a linha do produto (`SELECT … FOR UPDATE`) e relê o saldo dentro da transação; o número da venda usa trava consultiva por filial. Os itens são travados **na ordem em que chegam** (sem ordenação) | `sale.service.ts`, `stock.service.ts` |
| F5 | Pagamento aprovado cria `CashMovement` do tipo `SALE` **no caixa da venda**; o fechamento confere esperado × informado **por forma de pagamento**. Pagamento exige `saleId` | `payment.service.ts` (~l.699), `cash-register.service.ts` (`expectedByMethod`) |
| F6 | Pagamento externo é "intenção primeiro": grava `PENDING` com `transactionId` único, aciona o provedor, liquida com guarda atômica; sem resposta **nunca vira recusa**; mesma chave devolve o mesmo pagamento; job a cada 5 min concilia os `PENDING` | `payment.service.ts`, `config/scheduler.ts` |
| F7 | Pagamento aprovado depois da venda cancelada/devolvida vira **exceção** (`payment_exceptions`), tratada por pessoa autorizada; nada é apagado | `BUSINESS_RULES.md`, `payment.service.ts` |
| F8 | `Idempotency-Key` é **opcional**, vale 24 h, único por (empresa, endpoint, chave), e a empresa vem do **usuário do JWT** | `middleware/idempotency.ts` |
| F9 | Gateway: prazo 8 s, **1** retentativa (espera 250 ms × 2ⁿ), disjuntor (5 falhas seguidas, aberto por 60 s), assinatura HMAC de webhook com janela de tempo. **Registro de provedores vazio; nenhuma rota usa a assinatura** | `sales-channels/gateway.ts` |
| F10 | `ExternalOrder` tem estados `RECEIVED/ACCEPTED/REJECTED/CANCELLED/CONVERTED` e pagamento `UNKNOWN/PENDING/CONFIRMED/FAILED/REFUNDED`; chave única (canal, pedido externo); `saleId` **único mas sem chave estrangeira**; nada converte pedido em venda; cancelar pedido já convertido só pede revisão | `schema.prisma`; `external-order.service.ts` |
| F11 | `Product` tem **um** `salePrice`, `isActive`, `sku`, `barcode`, `categoryId`, `branchId` anulável, `minStock`. **Não tem** foto, slug, NCM, peso, preço por canal nem publicação | `schema.prisma` |
| F12 | Fiscal: só venda **PAID** ou **RETURNED** emite; política `fiscal.enabledOperations` (`SALE`, `RETURN`, `TRANSFER`); só existe o adaptador não configurado | `fiscal.service.ts`, `policy.service.ts` |
| F13 | Autenticação é só JWT de **usuário**; o contexto RLS vem de `req.user`. O CORS é uma lista fixa (`WEB_URL`, `SUPER_ADMIN_URL`). O limite de requisições é por usuário ou IP. Não há chave de API | `middleware/tenant.ts`, `config/cors.ts` |
| F14 | Rotinas agendadas: BullMQ repetível, varrendo todas as empresas com contexto de plataforma e depois uma por vez com o contexto da empresa | `config/scheduler.ts`, `payment.service.ts` (`reconcilePendingExternal`) |
| F15 | Comissão só de OS (mão de obra). `Sale.userId` guarda o operador; nada calcula comissão de venda | `service-order.service.ts`, `sale.service.ts` |

## 2. Divergências e achados (registrados, não resolvidos)

1. **"Até 3 retries" não é uma regra do servidor.** O número 3 existe só no contador da fila offline do PDV (`offline.service.ts`), que hoje **não enfileira venda** (comentário em `services/api.ts`). No servidor a regra é: mesma chave devolve o mesmo pagamento, `PENDING` é conciliado antes de qualquer nova cobrança, e o gateway faz 1 retentativa. O limite de tentativas de pagamento externo é, portanto, **decisão nova** (§8), não regra herdada.
2. **Uma venda de canal não cabe no modelo atual:** exige caixa e usuário (F1) e o pagamento aprovado mexe no caixa físico (F5). Reutilizar um caixa do balcão distorceria o fechamento por forma de pagamento.
3. **Pagamento exige venda** (F5), mas no desenho proposto o pagamento acontece **antes** da venda. Falta uma entidade de pagamento do pedido.
4. **`ExternalOrder.saleId` não tem chave estrangeira** (F10): a ligação pedido → venda não é garantida pelo banco.
5. **A idempotência é opcional e amarrada ao JWT** (F8): serve ao admin, não a uma credencial de canal.
6. **Venda PENDING abandonada fica com o estoque baixado para sempre** (F2, decisão 5). É o motivo de a proposta **não** usar venda pendente como reserva.
7. **Ordem de trava dos itens** (F4): duas vendas com os mesmos produtos em ordem oposta podem se bloquear. Não foi observado como incidente; é um ponto **a verificar** antes de aumentar a concorrência (Fase 2).
8. **A ordem das fases no ROADMAP tem uma dependência escondida:** aceitar um pedido do site (Fase 1) sem reserva (Fase 2) permite vender duas vezes a mesma peça. Ver §15.
9. **Decisão 57 (pool de conexões):** tráfego público na mesma API compartilha o pool do PDV. Ver §6.6.

## 3. Princípio: cinco conceitos, cinco responsabilidades

```
PEDIDO (external_orders)      o que o canal quer comprar        responsabilidade: aceitar/recusar
RESERVA (stock_reservations)  uma promessa temporária de peça   responsabilidade: garantir disponibilidade
PAGAMENTO (external_payments) dinheiro do pedido                responsabilidade: confirmar recebimento
VENDA (sales, channelId)      operação comercial oficial        responsabilidade: receita, estoque, fiscal
FULFILLMENT (fulfillments)    entrega física do que foi vendido responsabilidade: separar, entregar
```

Cada um tem **estado próprio**; nenhum estado "empurra" o do outro por acidente. Quem une os cinco é uma única operação transacional, **ConvertOrder** (§5).

**Sobre a sequência de exemplo** (`RECEBIDO → VALIDANDO → RESERVADO → AGUARDANDO_PAGAMENTO → PAGO → CONFIRMANDO → VENDA_CRIADA → EM_FULFILLMENT → CONCLUÍDO`): ela mistura **quatro máquinas** numa só linha. Proposta: separar.
- `VALIDANDO` e `CONFIRMANDO` são **passos internos** dentro de uma transação, não estados gravados (se gravados, um pedido pode ficar preso neles).
- `AGUARDANDO_PAGAMENTO` e `PAGO` são **estado do pagamento**, não do pedido.
- `EM_FULFILLMENT` e `CONCLUÍDO` são **estado do fulfillment**; uma venda existe sem o fulfillment concluído.
- O estado do **pedido** fica curto: `RECEIVED → ACCEPTED → CONVERTED`, mais os finais `REJECTED`, `CANCELLED` e `EXPIRED` (novo). O enum atual já tem cinco desses seis.

## 4. Decisão 82 — Reserva de estoque

### 4.1 O livro atual não suporta "Reservado" (verificado)
O saldo é a soma com sinal dos movimentos e `INVENTORY` o **fixa** (F3). Uma reserva é uma promessa **temporária e com prazo**; gravá-la como movimento (a) seria sobrescrita por um inventário, (b) poluiria o histórico físico e (c) teria de ser "desfeita" por outro movimento. Reserva **não é movimento físico**.

### 4.2 Proposta: tabela própria `stock_reservations`
- Uma reserva por pedido (linhas por produto). Campos conceituais: empresa, **filial**, pedido, canal, produto, quantidade, `status`, `expiresAt`, motivo de encerramento, quem/quando.
- **Disponível para venda = saldo do livro (filial) − soma das reservas ACTIVE não vencidas (filial).** O saldo físico continua sendo só o livro.
- **Estados** (entre parênteses, os nomes usados no pedido de análise): `ACTIVE` (RESERVADO) → `CONSUMED` (VENDIDO: virou venda e o movimento `SALE` foi gravado), `RELEASED` (LIBERADO: cancelamento, falha de pagamento ou liberação manual, com motivo) ou `EXPIRED`. **`CANCELADO` e `LIBERADO` têm o mesmo efeito**; proposta: um estado só (`RELEASED`) com o motivo registrado (`CANCELLED_BY_CUSTOMER`, `CANCELLED_BY_CHANNEL`, `PAYMENT_FAILED`, `MANUAL`).

### 4.3 Regras propostas
| Ponto | Proposta |
|---|---|
| Quem cria | Só a Commerce API / gateway, em nome de um canal, ao **aceitar** o pedido. PDV e Balcão **não** criam reserva (vendem direto; o PDV só enxerga o "disponível") |
| Quando nasce | No aceite, depois de validar itens, preço e filial. **Tudo ou nada**: reserva todas as linhas ou nenhuma (reserva parcial seria decisão de produto) |
| Atomicidade | Uma transação: trava os produtos (`FOR UPDATE`, **em ordem fixa por id**), relê saldo e reservas, grava a reserva. É a mesma trava que a venda do PDV usa, então PDV × canal × canal se serializam |
| Idempotência | Uma reserva por pedido (chave única); repetir o aceite devolve a mesma |
| Expiração | **Preguiçosa + varredura:** o cálculo do disponível já **ignora** reservas vencidas (a correção não depende de job) e uma rotina BullMQ marca `EXPIRED`, emite evento e avisa o canal. Prazo = política por canal/filial (`channel.reservationTtl…`) — **valor a decidir** |
| Pagamento falha | Falha **definitiva** informada pelo provedor libera na hora; incerteza (timeout) **mantém** a reserva até vencer |
| Cliente ou canal cancela | Libera (`RELEASED`) e o pedido vai a `CANCELLED` |
| Venda não confirmada | Reserva vence (`EXPIRED`) e o pedido vai a `EXPIRED` |
| Concorrência com PDV/Balcão | O PDV (e a peça da OS, a transferência e o ajuste que **retiram** saldo) passa a validar contra o **disponível**, não contra o saldo. Exige alterar o cálculo hoje feito por `getBalance` (Fase 2) |
| Ajuste físico abaixo do reservado | Inventário, avaria ou perda podem deixar reservas sem lastro: a reserva fica `AT_RISK` e gera alerta; **não** se cancela pedido sozinho |
| Auditoria | `channel_events` para cada transição; `audit_logs` para liberação manual |
| Empresa e filial | Linha com `companyId` e `branchId` (a **filial de atendimento**) sob a regra de RLS empresa+filial |

### 4.4 Alternativas analisadas e descartadas
1. **Venda PENDING como reserva** (o que existe de fato): não expira (F2), exige caixa e usuário (F1), mistura promessa com receita.
2. **Movimento `RESERVATION` no livro:** o inventário o apaga; polui o histórico físico.
3. **Chave com prazo no Redis:** o Redis não é fonte da verdade e a reserva sumiria numa reinicialização. Fica **proibido** como autoridade.

**Redis aqui:** nenhum papel de decisão. No máximo, cache de leitura do disponível para o catálogo (§10), que **nunca** é consultado na hora de reservar.

## 5. Decisão 83 — Pedido externo → venda

### 5.1 Definições
- **Pedido externo:** a intenção de compra recebida de um canal. **Pode existir sem venda** (recebido, recusado, cancelado, expirado).
- **Venda CÓRTEX:** a operação comercial oficial. Só nasce por **conversão deliberada**, nunca na chegada (já é regra de [CANAIS](CANAIS.md)).

### 5.2 Quando vira venda (proposta)
Condições **todas** necessárias, avaliadas **dentro** da transação de conversão:
1. pedido `ACCEPTED` e reserva `ACTIVE` (não vencida);
2. pagamento `CONFIRMED` — **ou** outra regra de recebimento que o produto aprovar (pagamento na entrega ou na loja: ver §16, produto);
3. valor pago igual ao total do pedido (diferença = exceção, não conversão).

**Eventos que disparam** a conversão: (a) confirmação de pagamento (webhook assinado ou conciliação) e (b) ação manual de pessoa autorizada. O resto é o mesmo código.

### 5.3 O que a conversão faz (uma transação)
Trava o pedido (`UPDATE … WHERE status='ACCEPTED'`, uma linha afetada ou nada) → trava os produtos → consome a reserva (`CONSUMED`) → grava os movimentos `SALE` → cria `Sale` (com `channelId`, `PAID`) e itens com o preço do pedido validado → cria `Payment` `APPROVED` ligado ao pagamento do pedido → grava `externalOrder.saleId` e `status = CONVERTED` → cria o fulfillment.

### 5.4 Duas vendas para o mesmo pedido: impossível por três camadas
`external_orders.saleId` **único**, a **guarda de estado** do `UPDATE` e a trava da linha do pedido. Proposta adicional: **chave estrangeira** `saleId → sales` (hoje não existe, F10).

### 5.5 Relação e idempotência
`ExternalOrder.saleId` + `Sale.channelId` (já existem). Na Commerce API, `Idempotency-Key` **obrigatório** em escrita; reenvio do provedor devolve o resultado guardado (`DUPLICATE`, já implementado para eventos).

### 5.6 O que a venda de canal precisa que o modelo não tem (decisão de arquitetura)
Pelo F1 e F5, é preciso permitir venda **sem caixa físico e sem usuário interno**, e o pagamento de canal **não** pode lançar movimento no caixa do balcão.
- **Proposta A (recomendada):** `Sale.cashRegisterId` e `Sale.userId` **anuláveis** só quando `channelId` não é nulo, protegido por **restrição no banco** (`channelId IS NOT NULL OR (cashRegisterId e userId NOT NULL)`), e o pagamento sem caixa **não gera** `CashMovement`. Venda física continua exatamente como hoje.
- **Proposta B:** um usuário de sistema por empresa e um "caixa virtual" por canal. Evita tornar colunas anuláveis, mas cria usuário falso (aparece em listas e perfis) e caixa que nunca fecha (suja o fechamento e as pendências).
- Impacto das duas: `sale.service`, `payment.service`, `cash-register.service`, dashboard e qualquer leitura de `sale.cashRegisterId`.

### 5.7 Efeitos
Receita do Dashboard (PAID) passa a incluir o canal pela data da venda — **qual data vale** (confirmação ou pedido) é decisão de produto. Número da venda segue a numeração da **filial de atendimento**.

## 6. Decisão 84 — Commerce API

### 6.1 Duas superfícies, sem mistura
| | **API administrativa (existe)** | **Commerce API (proposta)** |
|---|---|---|
| Caminho | `/api/*` | `/commerce/v1/*` (roteador próprio) |
| Quem chama | usuário do CÓRTEX (JWT, MFA, papéis) | um **canal** (credencial de máquina) |
| Escopo | empresa/filial do token | empresa/filial **do canal**, nunca do corpo |
| Pode | tudo que o papel permite | só os recursos abaixo, com escopos |

A Commerce API **não** reutiliza o JWT de usuário: ele carrega identidade humana, papéis e MFA, dura 15 min e daria a um site o raio de ação de um administrador.

### 6.2 Recursos propostos (v1)
| Recurso | Operação | Observação |
|---|---|---|
| Catálogo (produtos, categorias) | leitura paginada e por id | só o **publicado** para o canal; sem custo, sem dado interno |
| Preço | dentro do produto | calculado pelo CÓRTEX; o canal nunca escreve |
| Disponibilidade | leitura | projeção segura (§10), não o livro |
| Pedido | criar (com `Idempotency-Key`), consultar, cancelar | cria `RECEIVED`; aceite/reserva/conversão são internos |
| Status do pedido | leitura | pedido + pagamento + fulfillment, com os estados da §3 |
| Pagamento | receber **eventos** assinados do provedor de pagamento | o CÓRTEX não cobra na v1 (§8) |
| Webhook de saída (mudança de status) | envio ao canal | adiado: exige caixa de saída (§12) |

**Fora da v1:** carrinho no servidor (o site guarda o carrinho; o pedido valida tudo na entrada), conta de cliente final, busca textual avançada.

### 6.3 Autenticação (análise)
| Opção | Avaliação |
|---|---|
| JWT do admin | **Descartada** (identidade humana, MFA, amplitude) |
| Chave de API estática por canal | Simples; vaza mais fácil; sem proteção contra repetição |
| **Chave + assinatura HMAC por requisição** (carimbo de tempo, corpo assinado; reaproveita o que o gateway já faz) | **Recomendada** para servidor → servidor: o segredo não trafega a cada chamada, há anti-repetição e integridade do corpo |
| OAuth2 *client credentials* (token curto) | Mais forte e mais pesado; **caminho de evolução** se houver muitos integradores |
| Chave **publicável** (só leitura de catálogo, origem permitida por CORS) | Opcional, para o navegador do site ler catálogo; **nunca** cria pedido |

**Proposta:** duas classes de credencial por canal — **secreta** (servidor do site: pedidos e eventos, assinada) e **publicável** (leitura de catálogo e disponibilidade, só se aprovada). Armazenamento (**corrigido na implementação**: o HMAC precisa do segredo, então ele é guardado **cifrado** com `enc:v1`, não só com hash): identificador público `keyId` para a busca, escopos, validade, último uso, revogação e **troca com sobreposição**. Atenção: `SalesChannel.credentialsEncrypted` guarda a credencial que o CÓRTEX **usa** num provedor; a chave que o canal usa para chamar o CÓRTEX é **outra coisa** e **não** vai nesse campo.

### 6.4 Contexto de empresa e filial
A credencial resolve `companyId` e `branchId` do **canal** (nunca do pedido) e abre o contexto RLS com um tipo de usuário próprio (por exemplo `CHANNEL`), que as funções de RLS tratam como **limitado à filial** (falha fechada). A busca da credencial acontece **antes** do contexto existir; precisa de um caminho estreito e auditado (como o login). O isolamento forte depende também de a rota usar só serviços da Commerce API (lista de permissão), porque a RLS isola por empresa/filial, não por tabela.

### 6.5 Contrato transversal
Limite de payload **muito menor** que o global de 5 MB; paginação com teto (já há `limit ≤ 100`); limite de requisições **por credencial** e por IP (hoje só há por usuário/IP); `Idempotency-Key` obrigatório em escrita; versão na URL com mudanças só aditivas; erros com **código estável** e mensagem sem texto técnico (a camada `translate-errors` já impede vazamento); `X-Request-Id` devolvido e gravado (o `requestId` já existe), com o canal marcado nos registros de requisição; timeout de resposta; **CORS por canal** só para a chave publicável (a lista atual de origens do admin **não** serve); documentação **OpenAPI própria**, sem rotas administrativas.

### 6.6 Isolamento de falha (liga com a decisão 57)
Tráfego público usa o mesmo PostgreSQL e o mesmo pool do PDV. Proposta de arquitetura: limite de requisições em andamento por credencial, rotas de leitura leves e, **decisão a tomar**, rodar a Commerce API como **processo separado** (pool próprio) sobre o mesmo banco. Hoje não há medição que diga se é necessário; a decisão 57 continua do dono.

### 6.7 Abuso
Limite por credencial e por IP, tamanho de página máximo, respostas de disponibilidade sem quantidade exata se o produto decidir (§10), e registro de varredura incomum no monitoramento.

## 7. Decisão 85 — Comissão sobre vendas (modelo conceitual)

Fato: só existe comissão de OS (F15). Nada abaixo é regra.

- **Política** por empresa/filial (`commission.enabled` já liga/desliga): percentual **ou** valor fixo; abrangência (tudo, categoria, produto); vigência (de/até); canais elegíveis.
- **Registro por venda** (ou por item) com **retrato da regra aplicada** (como o `ruleSnapshot` da OS): mudar a política não recalcula o passado.
- **Atribuição:** venda física → operador responsável (`Sale.userId`); **venda de canal → sem vendedor por padrão, logo sem comissão**. Comissão em canal só com política explícita (nenhuma opção é assumida: vendedor designado, link de vendedor, retirada em loja…).
- **Estados:** sem política · calculada · aguardando fechamento · liquidada · estornada.
- **Cancelamento e devolução:** estorno proporcional (o rateio de devolução já existe), em **linha de estorno**, nunca editando a original; devolução depois da liquidação vira desconto no fechamento seguinte (a decidir).
- **Fechamento e liquidação:** por período e por pessoa; histórico imutável.
- **Pendências de produto:** base de cálculo (valor com ou sem desconto; líquido de devolução), momento (venda paga ou fim da garantia), tratamento de venda sem vendedor, ranking e privacidade (liga com a 70).
- **Impacto de arquitetura:** se aprovada a Proposta A da §5.6, `Sale.userId` pode ser nulo em venda de canal — a comissão **precisa** tratar vendedor ausente.

## 8. Decisão 86 — Pagamento externo

**Pedido ≠ Pagamento ≠ Venda** (§3). Pelo F5, `Payment` exige venda; como o pagamento acontece **antes** da venda, a proposta é uma entidade própria **`external_payments`** (pedido, provedor, referência do provedor **única**, valor, estado, tentativas, últimos eventos). Na conversão (§5.3) nasce o `Payment` `APPROVED` com `transactionId` = referência do provedor (a unicidade global já existente barra duplicidade).

### 8.1 Quem processa (decisão de produto e de segurança)
- **v1 proposta:** o pagamento é feito no PSP do site (ou no canal) e o CÓRTEX **recebe eventos assinados**; **não cobra**. Diferencia "confirmado pelo provedor" de "informado pelo canal" (níveis de confiança diferentes, registrados).
- **Futuro (Fase 3):** o CÓRTEX orquestra um PSP pelo mesmo contrato de adaptador de pagamento já existente (`registerPaymentProvider`).

### 8.2 Estados e eventos
Estado atual do enum: `UNKNOWN, PENDING, CONFIRMED, FAILED, REFUNDED`. Proposta de acréscimo (a aprovar): `AUTHORIZED` (autorizado, ainda não capturado), `PARTIALLY_REFUNDED`, `CHARGEBACK`.

| Situação | Comportamento proposto |
|---|---|
| Pendente | pedido segue `ACCEPTED` com reserva `ACTIVE` até o prazo |
| Recusado (definitivo) | pagamento `FAILED`; **libera a reserva**; pedido `CANCELLED` ou nova tentativa permitida (produto) |
| Timeout / sem resposta | **nunca** vira recusa (mesmo princípio de F6): fica `PENDING`/`UNKNOWN`, **concilia antes** de qualquer nova tentativa |
| Webhook duplicado | idempotente por (canal, evento, operação) — já implementado |
| Webhook fora de ordem | máquina de estados **monotônica**: nunca regride (`CONFIRMED` não volta a `PENDING`); evento mais velho é guardado e ignorado |
| Aprovado **depois** do prazo | tenta **reservar de novo**; se não há peça, abre **exceção** (padrão de F7: tipo "aprovado após expirar"), tratada por pessoa autorizada com estorno; **nunca** estoque negativo automático |
| Estorno (*refund*) | só marca `REFUNDED` com a **confirmação do provedor** (regra atual de F7) |
| *Chargeback* | disputa involuntária: gera exceção para tratamento manual; efeito na venda pela §9 |
| Valor diferente do total | exceção; não converte |

### 8.3 Conciliação e tentativas
Rotina BullMQ repetível, no mesmo molde da conciliação de 5 min existente (F6), consultando o provedor pela **chave de idempotência**. Tentativas: **nenhuma nova cobrança sem consultar antes**. O teto de tentativas (o "3") é **decisão nova** (divergência 1 da §2), não herança.

## 9. Decisão 87 — Cancelamento e devolução

Princípio: **nada é apagado**. Pedido, reserva, pagamento e venda mudam de **estado**, com motivo, quem, quando e auditoria (mesmo padrão de `cancelReason`/`cancelledBy` da venda).

| Situação | Efeito proposto |
|---|---|
| **Cancelar antes da venda** (`RECEIVED`/`ACCEPTED`) | pedido `CANCELLED`; reserva `RELEASED`; pagamento `PENDING` é cancelado **perguntando ao provedor primeiro** (regra atual); pagamento já `CONFIRMED` sem venda = exceção + estorno |
| **Cancelar depois da venda** | reaproveita `cancelSale` (estorno, movimento de estoque, histórico). Hoje exige **autorização humana dupla** (gerente com senha e MFA); um cancelamento iniciado pelo cliente no site **não tem** esse autorizador → **regra nova de produto**: janela e quem autoriza |
| **Devolução integral** | reaproveita `returnSale` (rateio do estorno, movimento `RETURN`) |
| **Devolução parcial** | **bloqueada pela decisão 72** (não há registro datado nem valor por item) e relacionada à 31 |
| **Refund** | dinheiro volta ao cliente pelo provedor; `Payment` só vira `REFUNDED` com confirmação |
| **Estorno** (contábil) | em venda física lança movimento no caixa; em venda de canal **não há caixa** (§5.6) |
| **Liberação de reserva** | automática no cancelamento antes da venda |
| **Ajuste de estoque** | depois da venda, o retorno entra por movimento `RETURN`; se a peça voltou **avariada**, segue o fluxo de avaria (a decidir) |
| **Ajuste financeiro** | refund/estorno; **taxa do canal** (devolvida ou não) é decisão de produto |
| **Ajuste fiscal** | emissão só de venda `PAID`/`RETURNED` (F12); a operação fiscal de devolução **depende das decisões 7 a 9** |

Pedido cancelado pelo canal quando já virou venda: continua só **sinalizando revisão** (comportamento atual); a proposta é abrir uma **tarefa de revisão** com prazo, não cancelar sozinho.

## 10. Decisões 88, 89 e 90 — Sincronização

### 10.1 Achado que simplifica
Para o **site próprio** (Commerce API) **não há sincronização**: o site **lê** catálogo, preço e disponibilidade **sob demanda** do CÓRTEX. Não existe cópia a manter. A sincronização (envio) só existe para plataformas de terceiros (iFood, marketplaces), na **Fase 3**.

### 10.2 Catálogo (88)
O CÓRTEX é o mestre. Tabela de integração só com **vínculo e estado**, nunca cópia do produto: produto, canal, identificador externo, **publicado** (sim/não), última sincronização, hash do conteúdo, estado e último erro. Proposta de segurança: **nada é público até ser publicado** para o canal.
- **Campos expostos:** SKU, nome, descrição, marca, unidade, categoria (com caminho), situação. **Imagem não existe** no modelo (F11): armazenamento de imagem é decisão nova.
- **Incremental:** por `updatedAt` + hash; **completa:** periódica, como conferência. **Falha:** por item, com nova tentativa e espera crescente (BullMQ). **Conflito:** o CÓRTEX vence; alteração no canal é ignorada e sinalizada.

### 10.3 Preço (89)
Hoje há **um** `salePrice` (F11). Preço por canal exigiria estrutura nova (canal, produto, preço, vigência, prioridade). O canal **nunca grava** preço. No pedido: o canal envia o preço que mostrou; o CÓRTEX **revalida** e, se mudou, **recusa** (`PRICE_CHANGED`) ou aceita o preço atual — **decisão de produto**. Arredondamento: 2 casas, regra única. Promoção e vigência: decisão de produto. Alterações de preço auditadas.

### 10.4 Estoque (90)
O canal **não** recebe `stock_movements`. Recebe uma **projeção por canal e produto**:

`exposto = max(0, disponível − margem de segurança)`, limitado por uma **cota** opcional,

onde `disponível = saldo físico da filial − reservado` (§4). Calculado **no PostgreSQL** na hora da leitura. Quantidade exata ou apenas "disponível/indisponível" é decisão de produto (anti-varredura). Cache de leitura no Redis com validade curta é **opcional e só para o catálogo**; a reserva sempre decide no banco. Atraso do provedor: mesmo que o canal mostre estoque velho, **o CÓRTEX recusa** o pedido sem disponibilidade. Falha de sincronização: marca o vínculo como **desatualizado** e alerta.

## 11. Decisão 91 — Fulfillment

**Venda ≠ fulfillment.** Entidade própria `fulfillments`, ligada ao pedido e à venda; a venda existe sem o fulfillment concluído.

**Proposta mínima** (sem criar etapas que o negócio ainda não pediu):
- Tipos: **retirada na loja**, **entrega própria**, **entrega do canal**.
- Estados: `PENDING → READY → (PICKED_UP | IN_TRANSIT) → DELIVERED`; finais de exceção: `FAILED_DELIVERY`, `RETURNED`, `CANCELLED`. **Separar, conferir e embalar** ficam como sub-etapas **só se** o dono pedir.
- Quem separa/confere/embala/entrega: **decisão de produto** (os papéis hoje são OPERATOR/Balcão e MANAGER; nenhum papel novo é proposto).
- **Quando baixa o estoque:** proposta de baixar **na conversão** (a reserva já protegia a peça) e não na entrega; a consequência é que a peça "vendida e ainda na prateleira" precisa aparecer no inventário (decisão de produto).
- Endereço, frete e prazos: a venda não os tem (F1); ficam num **retrato** no fulfillment; dados pessoais seguem a decisão de LGPD.
- Atraso, perda e devolução física: atraso é indicador (prazo × estado); perda usa o movimento `LOSS` e ajuste financeiro; devolução segue §9.

## 12. Decisão 92 — Falha do provedor

**Regra de ouro:** nenhuma chamada a provedor externo roda no caminho do PDV. Todo envio sai por **fila** (BullMQ) com **caixa de saída** (registro do que deve ser enviado, com prazo máximo), e a Commerce API, quando atende o site, só toca o banco do CÓRTEX.

| Situação | Comportamento proposto |
|---|---|
| Timeout | prazo (hoje 8 s) e retentativa com espera crescente (hoje 1); resultado incerto → **nenhuma mudança de estado**, concilia depois |
| HTTP 4xx | **sem retentativa** (erro de requisição); exceções que repetem: 408, 409 e 429 |
| 401/403 (credencial inválida) | canal vai a `ERROR` e **desativa** (comportamento atual do teste de conexão), alerta, nada é enviado até revalidar |
| HTTP 5xx | retentativa com espera crescente; **disjuntor** abre depois de falhas seguidas (hoje 5 em 60 s) e o canal fica **degradado** |
| 429 do provedor | respeita `Retry-After`; **não** conta para o disjuntor (a decidir) |
| Webhook ausente | rotina de **consulta periódica** do estado de pedidos e pagamentos pendentes, idempotente |
| Webhook duplicado | idempotente (já implementado) |
| Webhook fora de ordem | máquina monotônica; evento fora de sequência é guardado e sinalizado, não aplicado |
| Indisponibilidade longa | pausa do canal depois de um limite **a decidir**; reservas continuam vencendo; projeção de estoque marcada como desatualizada; saídas na caixa de saída até o prazo máximo |
| Resposta inconsistente | validada por esquema fechado (já feito na entrada); rejeitada **inteira**, registrada como erro; nunca aplicada pela metade |

**Garantia de isolamento:** falha de canal afeta só o canal (pedidos, sincronização, alertas); o balcão, o PDV e a oficina não dependem de nenhum provedor.

## 13. Impacto da proposta

### Banco (entidades prováveis — **nada criado**)
`channel_api_credentials` (chave hasheada, escopos, validade, revogação) · `stock_reservations` (+ linhas) · `external_payments` · `fulfillments` · `channel_product_links` (vínculo e estado de sincronização) · `channel_prices` (só se houver preço por canal) · `channel_outbox` (saídas pendentes) · tabelas de comissão de venda (futuro).
Alterações em tabelas existentes (a aprovar): `Sale.cashRegisterId`/`userId` anuláveis com restrição (§5.6); `ExternalOrder` com estado `EXPIRED`, filial de atendimento e chave estrangeira para a venda; `ExternalPaymentStatus` com novos valores; política de reserva e de comissão no catálogo de políticas.

### API
Commerce v1: catálogo, produto, disponibilidade, pedido (criar, consultar, cancelar), status, recebimento de evento de pagamento. Administrativa: chaves do canal (criar, trocar, revogar), pedidos (listar, aceitar/recusar, converter manualmente, cancelar), reservas (listar, liberar), exceções de pagamento de canal, fulfillment (mudar estado).

### Serviços afetados
`sale.service` (colunas anuláveis; disponível = saldo − reservado), `payment.service` (pagamento sem caixa; contrato de pagamento externo), estoque (função única de "disponível"), `fiscal.service` (venda de canal), `policy.service` (novas chaves), `external-order.service` (aceite, expiração, conversão), `module-settings` (gate), dashboard (origem já existe).

### Redis
Contadores de limite por credencial; cache **de leitura** de catálogo/disponibilidade com validade curta. **Nunca**: reserva, saldo, idempotência, estado de pedido ou pagamento (continuam no PostgreSQL).

### BullMQ (nenhum job criado)
Expiração de reservas; conciliação de pagamento externo; nova tentativa de conversão; sincronização de catálogo/preço/estoque (Fase 3); despachante da caixa de saída; consulta periódica de provedor. Todos no molde atual: varrem as empresas com contexto de plataforma e processam cada uma com o contexto dela.

### RLS
Todas as tabelas novas com a regra empresa+filial (`rls_company_branch_match`) e `FORCE`, como as 4 tabelas de canal. A tabela de credenciais precisa de leitura **antes** do contexto (caminho estreito). Verificar `db:check-rls` ao criar.

### Auditoria
Eventos: credencial criada/trocada/revogada/usada com falha; pedido recebido/aceito/recusado/expirado/cancelado/convertido; reserva criada/consumida/liberada/vencida/em risco; pagamento confirmado/falho/estornado/contestado; exceção aberta/tratada; fulfillment mudou; canal pausado/degradado; venda de canal cancelada/devolvida.

### Dashboard (futuro, **não alterado**)
Pedidos por estado, reservas ativas/vencidas, conversão pedido → venda, valor com pagamento pendente, pedidos em risco, falhas por canal, comissão (se aprovada).

### Comissão, fiscal, pagamentos
Comissão: vendedor ausente em venda de canal. Fiscal: emissão por venda de canal conforme `fiscal.enabledOperations`; depende de provedor e das decisões 7–9. Pagamentos: contrato de adaptador para o PSP e a entidade `external_payments`.

## 14. Arquitetura recomendada

```
 Site próprio ─(chave secreta + HMAC, servidor→servidor)──┐
 iFood / marketplace ─(webhook assinado / consulta)───────┤  [Fase 3]
                                                          ▼
              ┌───────────── Commerce API  /commerce/v1 ─────────────┐
              │ channelAuth → contexto RLS do canal (empresa/filial) │
              │ Idempotency-Key obrigatório · limite por credencial   │
              └──────────────────────────┬────────────────────────────┘
                                         ▼
                         PEDIDO (external_orders)            RECEIVED
                                         │ valida itens, preço, filial
                                         ▼
                         RESERVA (stock_reservations)        ACTIVE ── expira (preguiçosa + job)
                                         │ pedido ACCEPTED
                                         ▼
                         PAGAMENTO (external_payments)       PENDING → CONFIRMED
                                         │ confirmado
                                         ▼   ConvertOrder — UMA transação, idempotente
                         VENDA (sales, channelId)  ──► Payment APPROVED
                                         ├──► Estoque: reserva CONSUMED + movimento SALE
                                         ├──► Fiscal (política SALE; só venda PAID)
                                         ├──► Comissão (só com política; sem vendedor por padrão)
                                         └──► FULFILLMENT (fulfillments)

   Saídas e sincronização (Fase 3):  fila BullMQ + caixa de saída ──► provedor (prazo, retentativa, disjuntor)
   Fonte da verdade: PostgreSQL.  Redis: limite e cache de leitura.  Nada disso toca o PDV.
```

## 15. Ordem das fases (ajuste proposto)

Dependência escondida: **aceitar** pedido (reserva) é da Fase 2, mas a Commerce API é a Fase 1. Proposta, **a aprovar**:
- **Fase 1 (Commerce API somente leitura + entrada de pedido):** credenciais, catálogo, preço, disponibilidade (leitura) e **receber** o pedido como `RECEIVED`, **sem aceitar nem converter**. Nenhum risco de venda dupla.
- **Fase 2 (reserva e conversão):** reserva, aceite, pagamento do pedido, `ConvertOrder`, cancelamento/devolução de canal, fulfillment mínimo e as mudanças de venda/caixa (§5.6).
- **Fase 3:** integrações reais, sincronização de saída, caixa de saída.

Alternativa: manter como está e puxar a reserva para dentro da Fase 1.

## 16. O que precisa de aprovação humana

Nenhuma proposta acima é decisão até aprovada.

### Pode ser decidido tecnicamente (não muda regra de negócio)
Reserva em tabela própria e não no livro (§4.1); expiração preguiçosa + varredura; trava dos produtos em ordem fixa; `Idempotency-Key` obrigatório em escrita; roteador `/commerce/v1` separado; segredo cifrado (o HMAC o exige); `X-Request-Id`; estados separados de pedido/reserva/pagamento/fulfillment; máquina de estados monotônica; leitura sob demanda para o site próprio (sem catálogo replicado); fila + caixa de saída; chave estrangeira pedido → venda; Redis só como apoio.

### Precisa de decisão de produto
Prazo da reserva; reserva parcial × tudo ou nada; **quando** o pedido vira venda (pagamento confirmado × aceite × pagamento na entrega/na loja); filial de atendimento e pedido dividido entre filiais; preço do pedido × preço atual; janela e autorizador do cancelamento pelo cliente; devolução e taxa do canal; quem faz cada etapa do fulfillment e **quando baixa o estoque**; publicação por canal e imagens; margem de segurança, cota e exibir quantidade exata; data da receita da venda de canal; comissão em canal; teto de tentativas de pagamento (o "3"); pausa automática do canal; quem processa o pagamento.

### Precisa de decisão de segurança
Tipo de credencial (secreta + HMAC, publicável, OAuth); validade, troca e revogação; lista de IPs permitidos; CORS por canal; tipo de usuário do contexto de canal e acesso ao banco; limites por credencial; exposição de disponibilidade (varredura); LGPD do cliente final (dados, retenção, consentimento); guarda dos segredos do PSP.

### Precisa de decisão de arquitetura
`Sale.cashRegisterId`/`userId` anuláveis (A) × usuário e caixa de sistema (B); Commerce API em processo separado × mesmo processo (decisão 57); entidade `external_payments` e novos valores de estado; caixa de saída em tabela × só BullMQ; preço por canal (estrutura nova); chave estrangeira e restrição nas vendas de canal.

### Dependências de decisões já abertas
5 (venda pendente abandonada), 7–9 (devolução fiscal), 31 e 72 (devolução parcial), 57 (pool), 53 e 15 (papéis no balcão), 70 (ranking de pessoas).

## 17. O que esta fase **não** fez
Nenhum endpoint, serviço, tabela, migração, política, job ou alteração de banco, RLS, Redis, BullMQ, estoque, venda, pagamento ou Dashboard; nenhuma credencial, chamada externa ou integração; nenhum serviço foi iniciado. Só leitura do código e esta documentação.
