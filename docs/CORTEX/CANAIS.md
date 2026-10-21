# Canais de venda (site próprio, iFood, marketplaces)

**Estado (2026-10-05): a Commerce API (Fase 1) foi implementada sobre esta base** — ver [COMMERCE_API §0](COMMERCE_API.md#0-implementação--estado-em-2026-10-05): credenciais de canal, catálogo publicado, pedido externo (`RECEIVED`, não é venda) e pagamento externo recebido, em `/commerce/v1`. Para o **site próprio** o canal não tem provedor (o site chama o CÓRTEX; o canal fica `CONNECTED` na primeira chamada assinada válida). O gateway de provedores (iFood, marketplaces) foi **implementado de forma genérica na Fase 3** ([INTEGRATION_GATEWAY](INTEGRATION_GATEWAY.md): webhook assinado, consulta, caixa de saída) com um provedor **simulado**; o registro de provedores reais continua **vazio** e nenhuma integração real existe. Reserva de estoque e conversão em venda foram implementadas na Fase 2 (ver [COMMERCE_API §0](COMMERCE_API.md#fase-2--reserva-de-estoque-e-conversão-em-venda-feita)); o restante seguem pendentes (Fase 2 em diante). O texto abaixo que diz "não existe Commerce API" descreve a base criada de manhã.

**Base arquitetural original — PREPARADA, não é a funcionalidade de e-commerce.** O que vem depois (Commerce API, reserva de estoque, integrações reais) está na [sequência oficial do ROADMAP](ROADMAP.md#sequência-oficial-de-evolução) e depende das decisões pendentes 82 a 92 de [DECISIONS](DECISIONS.md).

Base arquitetural criada em 2026-10-05. **Nenhuma integração real existe**: nada chama serviço externo, nenhuma credencial é inventada e nenhum canal nasce "Conectado". O objetivo é que ativar um canal real no futuro não exija reconstruir Dashboard, vendas, estoque nem regras de negócio.

## Módulo CANAIS

- Módulo do sistema `CANAIS`, por empresa e filial, como os demais ([módulos](ARCHITECTURE.md)). É o **único módulo que nasce DESATIVADO** (opt-in): sem configuração, vale como desligado. Os outros seguem "ausência de linha = ligado".
- **Desligado:** nada é processado, nenhuma chamada externa é feita, as rotas respondem `403 MODULE_DISABLED`, a tela de canais mostra "Módulo desativado" e **nenhum canal aparece no Dashboard** (só a loja física).
- **Ligado** (Configurações › Módulos, Administrador): aparece o item "Canais de venda" no menu, onde se cadastram e administram os canais.

## Canal

Tabela `sales_channels` (RLS por empresa e filial; `branchId` nulo = todas as filiais):

| Campo | Uso |
|---|---|
| `type` | **tipo técnico estável**: `LOJA_FISICA`, `SITE_PROPRIO`, `IFOOD`, `MARKETPLACE`, `OUTRO`. Não muda depois de criado (campo recusado na API) |
| `displayName` | **nome exibido** configurável ("E-commerce", "Vendas Online"); é o que o Dashboard mostra |
| `isActive` | só canais ativos entram no painel. Canal com integração só ativa com `connectionStatus = CONNECTED` |
| `provider` | chave do provedor de integração (ex.: `ifood`, `commerce-api`); nulo = origem sem integração |
| `connectionStatus` | `NOT_CONFIGURED` ("Configuração pendente"), `UNVALIDATED` ("Credencial salva, não validada"), `CONNECTED` (teste real feito), `ERROR` |
| `lastSyncAt`, `lastError`, `externalAccountId`, `config` | estado e configuração **não secreta** |
| `credentialsEncrypted`, `credentialsHint` | credencial **cifrada** (`enc:v1`, a mesma chave dos segredos fiscais) e uma dica "••••1234". A API **nunca** devolve a credencial, nem cifrada; a auditoria registra só os nomes dos campos |

- Venda sem canal = **Loja física**. `Sale.channelId` (nulo para todas as vendas existentes e para as do PDV).
- A **loja física** existe sempre; cadastrá-la serve só para trocar o nome exibido, e ela não desativa.
- Origem **manual** (tipos sem provedor, como `OUTRO`): pode ser ativada sem integração.

## Estados de conexão e o que cada um significa

1. Canal criado: desativado, `NOT_CONFIGURED`.
2. Credencial salva: `UNVALIDATED` (e, se tem provedor, o canal é desativado até novo teste). **Salvar não conecta.**
3. **Testar conexão**: sem provedor instalado, não chama nada e responde `NO_PROVIDER` com o motivo (status não muda); com provedor, a chamada tem prazo, retentativa limitada e disjuntor; só um sucesso real grava `CONNECTED`; falha grava `ERROR`, o erro (sem segredo) e desativa o canal.
4. Trocar ou remover a credencial volta o canal para `UNVALIDATED`/`NOT_CONFIGURED`.

Cada ação grava um evento em `channel_events` (sem segredo, com correlação por requisição). Hoje a tela mostra o registro por canal.

## Camada de integração (gateway)

`apps/api/src/services/sales-channels/gateway.ts`: contrato `ChannelProvider` (`testConnection` obrigatório; `syncCatalog`, `syncPrices`, `syncInventory` fixam o vocabulário), registro de provedores (**vazio** hoje), `callProviderSafely` (prazo, `retries` com espera crescente, disjuntor por canal: falha ou lentidão externa vira resultado de erro e **nunca derruba o PDV**), `sanitizeErrorMessage` (sem token, chave ou valor longo em log, evento ou tela) e assinatura de webhook HMAC-SHA256 com janela de tempo (anti-repetição) em tempo constante. Nada é específico de um provedor.

Fluxo futuro: site → Commerce API → camada de integração → CÓRTEX. O site **nunca** acessa o PostgreSQL, não altera estoque nem cria venda direto: toda entrada passa pelas regras de negócio, idempotência e autorização.

## Pedido externo não é venda

Tabelas `external_orders` (pedido), `channel_inbound_events` (idempotência) e `channel_events`. `ingestExternalEvent` (`external-order.service.ts`) recebe `ORDER_CREATED`, `PAYMENT_UPDATED` e `ORDER_CANCELLED`:

- guarda o **pedido** e o estado de pagamento **informado pelo canal**; **não** cria venda, pagamento, baixa de estoque nem documento fiscal. A venda só nasce por uma conversão deliberada (ainda inexistente);
- **idempotência**: (canal, id do evento, operação) é único; o mesmo evento repetido, inclusive ao mesmo tempo, não faz nada (`DUPLICATE`); o mesmo pedido em outro evento não duplica;
- corpo validado com esquema **fechado** (campo desconhecido é recusado; nada de dado de cartão), valores limitados, sem confiar no que vem de fora;
- canal desativado, módulo desligado ou canal de outra empresa: nada é processado;
- cancelamento de pedido que **já virou venda** não cancela a venda: sinaliza revisão (cancelar venda exige autorização, estorno e reposição de estoque pelo fluxo próprio);
- `REFUNDED` é final; nenhum estado volta a "desconhecido".

**Não há rota pública de webhook** nesta etapa (superfície de ataque sem provedor); ela só será montada quando houver um provedor homologado, usando a assinatura e a idempotência acima.

## Estoque

Continua um só: o livro de movimentos do CÓRTEX. Futuro: estoque disponível → reserva → confirmação → venda/movimentação → baixa; cancelamento → liberação/movimentação correspondente. Nenhum estoque paralelo foi criado.

## Dashboard

Origem = canal da venda; ver [DASHBOARD_GERENCIAL](DASHBOARD_GERENCIAL.md#origem-das-vendas).

## Ativar um canal real (futuro)

Módulo ativado → cadastrar canal → configurar a API → validar credenciais → testar conexão → testar webhook → validar catálogo, preço e estoque → validar pedido e pagamento → homologar → ativar a operação. **Nunca** marcar "Conectado" sem validação real.

## Limites desta etapa

Sem iFood, marketplace, site, gateway de pagamento, checkout externo, conversão de pedido em venda, reserva de estoque, sincronização de catálogo/preço/estoque nem rota de webhook. Comissão para venda externa **não** é automática: [COMISSAO](policies/COMISSAO.md).

## Pendências antes de ativar um canal real

O desenho proposto para a Commerce API, a reserva, o pedido → venda, o pagamento externo, a sincronização, o fulfillment e a falha de provedor está em [COMMERCE_API](COMMERCE_API.md) (**proposta, não aprovada**). Registradas em 2026-10-05, **sem decisão**: [DECISIONS](DECISIONS.md) itens 82 (reserva de estoque), 83 (conversão de pedido em venda), 84 (Commerce API), 85 (comissão sobre venda), 86 (pagamento externo), 87 (cancelamento e devolução de pedido externo), 88 a 90 (sincronização de catálogo, preço e estoque), 91 (fulfillment) e 92 (falha do provedor). Sequência: Fase 1 Commerce API, Fase 2 reserva de estoque, Fase 3 integrações reais ([ROADMAP](ROADMAP.md#sequência-oficial-de-evolução)). Princípios: PostgreSQL é a fonte da verdade, o CÓRTEX é a autoridade dos dados, o canal é só entrada e saída e **não existe banco paralelo de e-commerce**.

## Arquivos

API: `services/sales-channels/{gateway,sales-channel.service,external-order.service}.ts`, `routes/sales-channels.routes.ts`, `services/module-settings.service.ts` (módulo opt-in), migração `20261004200000_sales_channels`; testes `gateway.test.ts` (14) e `test/integration/sales-channels.integration.test.ts` (21, Postgres, RLS e JWT reais). Admin Web: `app/dashboard/channels/page.tsx`, `lib/sales-channels.ts`.
