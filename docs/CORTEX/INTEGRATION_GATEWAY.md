# Integration Gateway (Fase 3)

> **Estado (2026-10-06):** IMPLEMENTADO com um provedor **simulado** (`sandbox`). **Nenhum provedor real** (iFood, marketplaces) existe, nenhuma credencial real foi usada e nenhuma chamada externa é feita. Para quem vai implementar um provedor real: este documento é o contrato. O desenho de origem (decisões 86 a 92) está em [COMMERCE_API](COMMERCE_API.md#12-decisão-92--falha-do-provedor); o que é regra comercial e segue pendente está em [DECISIONS](DECISIONS.md#pendentes) (103 a 105).

## 1. O que é

Uma camada **genérica** entre o CÓRTEX e plataformas de terceiros. O CÓRTEX é a autoridade dos dados (pedido, preço, estoque, venda); o provedor é canal de **entrada** (webhook assinado e consulta periódica) e de **saída** (caixa de saída). Nada aqui é específico de um fornecedor: um provedor novo implementa `ChannelProvider` ([gateway.ts](../../apps/api/src/services/sales-channels/gateway.ts)) com os tipos de [contract.ts](../../apps/api/src/services/integrations/contract.ts) e é registrado em `providerRegistry`. Hoje o registro nasce **vazio** em produção; o `sandbox` só entra fora de produção (ou com `CHANNEL_SANDBOX_PROVIDER=true` de propósito).

```
provedor ──webhook assinado──► /integrations/v1/webhooks/:channelId ─► validação ─► serviços da Commerce API (pedido, pagamento, cancelamento)
provedor ◄──consulta periódica (pollEvents)── job a cada 2 min ───────┘            (mesmas regras, mesmo preço oficial, mesma reserva)
provedor ◄──envio com prazo, retentativa, disjuntor── job por minuto ◄── caixa de saída (channel_outbox, gravada NA transação da mudança)
```

Pedido externo ≠ pagamento ≠ venda ≠ reserva (inalterado). O provedor **nunca** decide preço, estoque, venda nem pagamento.

## 2. Contrato do provedor (`ChannelProvider`)

| Parte | Método | Observação |
|---|---|---|
| Conexão | `testConnection(ctx)` | obrigatório; só um `ok` real marca o canal `CONNECTED` e permite ativar |
| Entrada | `webhook: { signatureHeader, toleranceSec? }`, `parseWebhook({ rawBody, headers, ctx })` | devolve **eventos normalizados**; lança se o corpo for ilegível (o gateway responde 400) |
| Entrada | `pollEvents(ctx, cursor)` → `{ events, nextCursor }` | cobre o webhook que não chegou; o cursor é opaco |
| Saída | `syncInventory`, `syncPrices`, `syncCatalog` | itens só do publicado para o canal; estoque = disponível (saldo − reservas), menos margem, limitado pela cota |
| Saída | `notifyOrderStatus` (`ACCEPTED`, `REJECTED`, `CANCELLED`, `EXPIRED`, `CONVERTED`; `RETURNED` só vocabulário), `notifyFulfillment` | disparadas pelas mudanças de estado do CÓRTEX |
| Erros | `ProviderError(kind, …)` com `AUTH`, `RATE_LIMIT`, `CLIENT`, `SERVER`, `TIMEOUT`, `NETWORK`; `providerErrorFromStatus(status, msg, retryAfter)` | a classificação decide a retentativa (§5) |

Toda saída recebe `opts.idempotencyKey` (o id da linha da caixa de saída): o provedor deve usá-la para não duplicar efeito quando o CÓRTEX repete um envio de resultado incerto (timeout).

**Credenciais:** gravadas cifradas (`enc:v1`) no canal, só escrita. O campo `webhookSecret` da credencial é o segredo da assinatura do webhook; o resto (`apiKey`, tokens) é do provedor. Nada disso aparece em tela, log, evento ou resposta.

## 3. Entrada — webhook

`POST /integrations/v1/webhooks/:channelId` (superfície própria, fora de `/api`, sem JWT, sem CORS, corpo de até 256 KB).

**Autenticação (`middleware/webhook-auth.ts`)** — nesta ordem; qualquer falha de identidade responde o **mesmo 401** (não diz se o canal existe nem por quê):
1. IP não bloqueado por falhas de assinatura (8/min por padrão → 429; `COMMERCE_AUTH_FAILURES_PER_MIN`);
2. `channelId` é UUID e o canal existe, tem provedor com webhook e `webhookSecret` guardado (única consulta sem RLS da superfície, por id exato);
3. cabeçalho de assinatura do provedor `t=<unix>,v1=<hex>`: HMAC-SHA256 de `"<t>.<corpo cru>"` com o `webhookSecret`, comparação em tempo constante, **janela de 300 s** (anti-repetição de captura antiga);
4. limite por canal (600/min por padrão);
5. canal ativo e módulo CANAIS ligado (senão 403 `CHANNEL_DISABLED`); a empresa e a filial vêm do **canal no banco**, nunca do corpo; tudo depois roda com o contexto RLS `CHANNEL`.

**Eventos normalizados** (esquema fechado — campo desconhecido, inclusive `companyId`/`branchId`, é recusado):
- `ORDER_CREATED { eventId, occurredAt?, order: { externalOrderId, items:[{sku,quantity,unitPrice}], total, currency?, customer?, notes? } }`
- `PAYMENT { eventId, occurredAt?, externalOrderId, payment: { providerRef, status: PENDING|CONFIRMED|FAILED|REFUNDED, amount, method? } }`
- `ORDER_CANCELLED { eventId, occurredAt?, externalOrderId, reason? }`

Cada evento é aplicado pelos **mesmos serviços** da Commerce API: preço e total conferidos contra o CÓRTEX, SKU só se publicado, pagamento monotônico, cancelamento só antes de virar venda.

**Idempotência e repetição.** O evento é reivindicado em `channel_inbound_events` por (canal, `eventId`, `GW:<tipo>`). Repetido → `DUPLICATE`, sem efeito: **nem segundo pedido, nem segunda cobrança, nem segunda venda, nem segundo movimento de estoque** (provado, inclusive com 4 entregas simultâneas e com o mesmo pagamento reenviado com outro `eventId`). Entrega que falhou por culpa nossa (`FAILED`) ou travou (`RECEIVED` há mais de 2 min) é refeita com segurança: cada serviço de destino também é idempotente.

**Fora de ordem.** Pagamento ou cancelamento de um pedido que ainda não chegou fica **guardado** (`DEFERRED`, com o evento normalizado) e é aplicado quando o pedido chega, em ordem de ocorrência. Se o pedido nunca chegar, em 24 h o evento vira `FAILED` e gera o alerta `INBOUND_EVENT_ORPHAN`. Evento de pagamento mais velho que o último aplicado é `STALE`; regressão de estado é `IGNORED`.

**Resposta.** `200 { received, results:[{eventId,type,outcome,code}] }` quando tudo foi tratado (`APPLIED`, `DUPLICATE`, `DEFERRED`, `REJECTED` por regra de negócio, `REVIEW`, `INVALID`) — repetir não adianta nos três últimos. `500 TEMPORARY_FAILURE` (com `results`) quando uma falha **nossa** e transitória impediu algo: o provedor deve reenviar (é seguro). `X-Request-Id` é devolvido e gravado como **correlação** na caixa de entrada, no pedido e nos eventos do canal.

**Cancelamento de pedido que já virou venda:** nada é desfeito; vira `REVIEW` e o alerta `ORDER_NEEDS_REVIEW` (cancelar venda exige autorização, estorno e reposição de estoque pelo fluxo próprio).

## 4. Entrada — consulta periódica

Job `poll-channel-events` (a cada 2 min): canais **ativos e conectados** cujo provedor implementa `pollEvents`; prazo de 8 s, disjuntor por canal; os eventos passam pelo **mesmo** processamento do webhook (um evento que chegou pelos dois caminhos é tratado uma vez). O cursor (`sales_channels.inboundCursor`) só avança se nenhum evento do lote falhou por culpa nossa. Credencial recusada → canal vai a `ERROR` e para. O mesmo job expira os eventos guardados há mais de 24 h.

## 5. Saída — caixa de saída

`channel_outbox` (RLS empresa+filial). O aviso é **gravado na mesma transação** da mudança que o originou (aceitar, expirar, cancelar, recusar, converter, mudar a entrega) e só existe para canal **com provedor** que implementa a operação — o site próprio não gera nada. `dedupeKey` único por canal: o mesmo aviso nunca é enfileirado duas vezes; quando foi o próprio provedor que cancelou, não há "eco". **Nenhuma chamada externa roda no caminho do PDV, da venda ou da conversão** (provado: com o provedor fora do ar, venda e conversão funcionam e o provedor não é chamado).

Job `process-channel-outbox` (a cada minuto, lote de 20, `FOR UPDATE SKIP LOCKED`, trava de 5 min para retomar instância que caiu). Política de falha (`planFailure`, pura e testada):

| Falha | Tratamento |
|---|---|
| `AUTH` (401/403) | canal vai a `ERROR` e **desativa** (mesma regra do teste de conexão); a linha espera **sem gastar tentativa**; nada é enviado até revalidar |
| `RATE_LIMIT` (429) | espera o `Retry-After` (piso 1 s, teto 1 h; sem cabeçalho, espera padrão); **não conta** para o disjuntor |
| `CLIENT` (outros 4xx) | **sem retentativa**: linha `DEAD` + alerta `OUTBOX_DEAD`; pessoa autorizada pode reenviar |
| `SERVER` (5xx, 408, 409), `TIMEOUT`, `NETWORK` | espera crescente 30 s, 1, 2, 4… até 30 min (±10%); conta para o disjuntor |
| 8ª tentativa ou prazo máximo de 24 h na caixa | `DEAD` + alerta |
| 5 falhas seguidas no canal | disjuntor abre por 60 s: o provedor não é chamado e as linhas esperam (nada se perde) |
| canal inativo, em erro ou módulo desligado | pausa (5 min), sem gastar tentativa |

**Sincronização sob demanda** (`POST /api/sales-channels/:id/sync/{inventory|price|catalog}`, só COMPANY_ADMIN/SUPER_ADMIN): enfileira o catálogo **publicado** em lotes de 200; o estoque enviado é `max(0, disponível − margem)` limitado pela cota, onde disponível = saldo − reservas vivas (a mesma conta do balcão e da conversão). Custo e ids internos nunca saem. Sincronização **automática** por gatilho/frequência **não existe** (decisão 103).

Administração: `GET /:id/outbox` (linhas, contagens da saída e da entrada), `POST /:id/outbox/:rowId/retry|cancel`.

## 6. Segurança (checklist do que um provedor real herda)

| Requisito | Onde |
|---|---|
| assinatura HMAC + janela de tempo + tempo constante | `verifyWebhookSignature` |
| mesmo 401 para qualquer falha de identidade; bloqueio de IP por falhas | `webhook-auth.ts`, `rate-limit.ts` |
| empresa/filial/canal do banco, nunca do corpo; RLS `CHANNEL` | `webhook-auth.ts` |
| esquema fechado, preço oficial, SKU publicado, estado monotônico | `inbound.service.ts` + serviços da Commerce API |
| idempotência e anti-repetição por evento; fora de ordem guardado | `channel_inbound_events` |
| correlação por requisição (`X-Request-Id`) | caixa de entrada, pedido, eventos |
| nenhum segredo em log, evento, caixa ou resposta; mensagens sanitizadas | `sanitizeErrorMessage`, teste que varre as tabelas |
| nenhuma chamada externa no caminho do PDV; falha de um canal só atrasa o canal | caixa de saída + disjuntor |
| Redis só em limite de taxa (com seguro em memória); a fila é o PostgreSQL | `rate-limit.ts`, `channel_outbox` |

## 7. Como implementar um provedor real (fase de homologação — não feita)

1. Implementar `ChannelProvider` (`testConnection`, `webhook`+`parseWebhook` ou `pollEvents`, e as saídas que a plataforma suportar), traduzindo para os eventos normalizados e lançando `ProviderError` classificado (`providerErrorFromStatus`).
2. Registrar em `providerRegistry` (partida da API) — **só** com credencial de homologação; credencial real nunca no código.
3. Mapear SKU ↔ identificador externo (`channel_product_links.externalId` já existe) e as formas de pagamento.
4. Decidir as pendências comerciais que a plataforma exige (preço, estoque, cancelamento, comissão, taxa de canal, fiscal) — ver [DECISIONS](DECISIONS.md#pendentes) (86 a 92, 95 a 105).
5. Rodar o roteiro dos testes de `integration-gateway.integration.test.ts` contra o ambiente de homologação do provedor.

## 8. Provado por

36 testes de integração (`integration-gateway.integration.test.ts`: assinatura/segredo por canal/janela/bloqueio de IP, canal desativado, idempotência byte a byte e simultânea, esquema fechado, fora de ordem e ordem de ocorrência, expiração do órfão, duplicado sem segunda venda/cobrança/estoque, consulta periódica, caixa de saída atômica, envio com chave de idempotência, 5xx/timeout/429/4xx/AUTH/limite/prazo/disjuntor/trava presa, sincronização, ausência de segredos, RLS) e 14 unitários (`integrations.test.ts`; mais 2 do teste de jobs agendados).

## 9. Revisão final de produção (Fase 4, 2026-10-06)

Confirmado por leitura e pelos testes: contrato genérico; `sandbox` isolado (só fora de produção; a validação de partida **avisa** se `CHANNEL_SANDBOX_PROVIDER=true` em produção); **nenhum provedor real registrado**; webhook com HMAC, janela de 300 s, mesmo 401, bloqueio de IP e limite por canal; idempotência por evento; fora de ordem guardado; caixa de saída com retentativa por classe de erro, disjuntor por canal e trava para linha presa; empresa/filial vindas do canal; segredos fora de log, evento e resposta; falha de um canal não afeta os outros nem o PDV (nenhuma chamada externa no caminho da venda); o CÓRTEX continua a autoridade. Com `TRUST_PROXY` configurado, o bloqueio de IP do webhook passa a usar o IP real do provedor (sem ele, todos aparecem como o IP do balanceador). **Ainda não existe:** provedor real, sincronização automática (decisão 103), medição dos limites (105).
