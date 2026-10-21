# Auditoria de produto e lacunas (2026-10-04)

Levantamento de funcionalidades que o CÓRTEX **não tem** e que um sistema de lojas e oficinas de moto poderia precisar. **Nada foi
construído**: cada item é classificado e, quando depende do dono, vira decisão pendente. Fonte: schema Prisma (91 modelos em 2026-10-04; hoje 95), 79 arquivos de
rota, serviços, documentos de `docs/CORTEX` e varredura de código em 2026-10-04.

> **Atualização de 2026-10-05.** O levantamento abaixo é o de 2026-10-04 e foi mantido. Desde então a **base arquitetural** de canais foi criada ([CANAIS](CANAIS.md)): módulo `CANAIS` (desligado por padrão), `sales_channels`, `external_orders`, `channel_inbound_events`, `channel_events`, `Sale.channelId`, gateway genérico com credencial cifrada e idempotência. Isso muda 3 linhas da tabela da seção 1: "Entrada de pedido", "Credenciais por canal" e "Isolamento multiempresa" passam de lacuna para **PREPARADO** (a estrutura existe; a funcionalidade não); "Idempotência" já existia e agora também protege a entrada de eventos de canal. **Continuam inexistentes:** API pública/Commerce, conversão de pedido em venda, catálogo público, reserva de estoque, pagamento online, webhooks de entrada e saída, nenhum provedor e nenhuma integração real. A frase "nada será construído sem a decisão 54" foi superada pela sequência oficial de 2026-10-05 ([ROADMAP](ROADMAP.md#sequência-oficial-de-evolução)); a decisão 54 está parcialmente respondida e as regras de cada fase são as pendentes 82 a 92 de [DECISIONS](DECISIONS.md). Modelos e migrações hoje: 95 e 26.

Classificação: **P1** = bloqueia operar de verdade em produção (já está no ROADMAP quando existe) · **P2** = importante, depois do go-live ·
**Futuro** = só se o produto for nessa direção · **Decisão** = o dono precisa definir antes de qualquer trabalho.

## 1. Canais externos de venda (site próprio, e-commerce, iFood, marketplaces, API pública, Commerce)

**Estado em 2026-10-04: não existia nada** (em 2026-10-05 existe só a base — ver a atualização no topo). Varredura de `ifood`, `marketplace`, `e-commerce`, `webhook`, `apiKey`, `channel`, `externalId`, `reservation`
em `apps/api/src`, `apps/admin-web`, `apps/pdv-desktop` e `schema.prisma`: nenhuma ocorrência de produto (só `ContactChannel` do pós-venda e um
comentário em `observability.service.ts`).

| Requisito de um canal externo | O que o CÓRTEX tem hoje | Lacuna | Classe |
|---|---|---|---|
| Decidir se vende fora do balcão | — | O produto é balcão/PDV/oficina; nenhum documento define venda online | **Decisão** |
| API pública / de integração | Todas as rotas exigem usuário com JWT (`/auth`, `/health` e documentação são as únicas abertas); Swagger em `/api/docs` | Sem chave de API, conta de serviço, escopo por integração, limite por chave | Futuro |
| Entrada de pedido (iFood, site, marketplace) | `Sale` exige `cashRegisterId` aberto e `userId` interno; sem origem/canal, sem id do pedido externo, sem endereço ou entrega | Falta o conceito de pedido externo e o vínculo com a venda | Futuro |
| Idempotência | `Idempotency-Key` por empresa + endpoint + chave, com hash do corpo e validade (`idempotency_keys`) | Padrão pronto para reaproveitar na entrada de pedidos | (já existe) |
| Catálogo público | `Product` tem sku, código de barras, nome, descrição, marca, preço de venda | Sem fotos, slug, dimensões/peso, dados fiscais (NCM/CFOP), preço por canal, publicação por canal | Futuro |
| Estoque e reserva | Saldo calculado no livro `stock_movements` por filial; `allowNegativeStock` por produto | Sem reserva de estoque nem saldo por canal; pedido externo não seguraria peça | Futuro |
| Pagamento online | Interface de adaptador (`registerPaymentProvider`); só `MANUAL`; PIX pendente com conciliação a cada 5 min | Sem PSP/gateway real | P1 se houver pagamento sem balcão; **Decisão** de provedor |
| Cancelamento, devolução, reembolso por canal | Cancelamento e devolução de venda com rateio do estorno e dupla autorização | Não propagam para um canal externo | Futuro |
| Webhooks de entrada e de saída | Filas BullMQ (`email`, `report`, `notification`, `audit-log`, `request-metrics`, `system-log`) e agendador | Sem assinatura, repetição, caixa de saída | Futuro |
| Credenciais por canal | Cofre `enc:v1` (AES-256-GCM, `DATA_ENCRYPTION_KEY`) já guarda MFA e segredos fiscais | Falta tabela e tela para credenciais de canal | Futuro |
| Monitoramento da integração | Observabilidade, alertas com limites, saúde por filial | Sem métricas ou alertas por canal | Futuro |
| Isolamento multiempresa | RLS FORCE em toda tabela de empresa; módulos por empresa (`CompanyModuleSetting`) | Qualquer tabela de canal deve nascer com RLS; um módulo "Canais" ligaria/desligaria por empresa | (padrão existe) |

**Camada de integração recomendada se o dono decidir vender fora do balcão (não implementar agora):** um módulo "Canais" por empresa/filial
(entidade de canal + credenciais cifradas), entrada idempotente de pedido que cria a venda numa fila, reserva de estoque no livro, caixa de saída com
repetição para webhooks e conciliação por canal. Tudo sobre os padrões que já existem (idempotência, fila, cofre, RLS). **Antes**, as decisões 54 e 55.

## 2. Outras lacunas encontradas

| Lacuna | Evidência | Classe |
|---|---|---|
| **Emissão fiscal real** (NFC-e/NF-e): só `unconfigured-adapter`; devolução fiscal sem regra | ARCHITECTURE; DECISIONS 7–9 | **P1** para operar legalmente; **Decisão** de provedor e regras |
| **TEF/PIX reais** | só `MANUAL`; ROADMAP P5 | **P1** se o pagamento não for manual; **Decisão** |
| **LGPD** (consentimento, exportação e exclusão de dados do titular, retenção de cliente) | a palavra só aparece na decisão 14 (mecânico vê dados pessoais) | **P2**; **Decisão** jurídica |
| Produção: migrações, segredos, expurgo, `docker-compose` | ROADMAP P1–P4, P6 | **P1** |
| Notificações externas (e-mail, SMS, WhatsApp oficial) | decisão 36; só registro manual | **Decisão**; futuro |
| Relatórios gerados no servidor (Excel/PDF) | decisão 25; a tela diz que não existe | **Decisão**; P2 |
| Venda offline no PDV | de propósito não enfileira (decisão registrada) | **Decisão** |
| Aviso de bloqueio de login (admin, alerta, desbloqueio) | decisão 49 | **Decisão** |
| Contagens de painel sem endpoint próprio: Orçamentos faz 5 chamadas `GET /quotes?limit=1` só para os cartões; o painel e as telas fazem 5 a 17 chamadas | `quotes/page.tsx:101-114`; Sidebar com sonda de 60 s | P2 (engenharia): endpoint de resumo; **Decisão** 50 sobre o limite |
| Mobile e TV nunca testados em aparelho | CURRENT_STATE | P2 |
| Paginação no servidor (empresas, ativações, transferências, inventários) | ROADMAP | P2 |
| Marca "LN System" no mobile e na TV | ROADMAP | P2 |

## 3. O que NÃO deve ser implementado agora

- Qualquer canal externo, API pública, marketplace, iFood ou e-commerce **fora da sequência oficial e sem as decisões 82 a 92** (a regra "sem a decisão 54" foi superada em 2026-10-05; ver a atualização no topo).
- Agentes de IA dentro do CÓRTEX (os agentes são ferramentas externas de desenvolvimento; a arquitetura deles é decisão posterior).
- Robô de cobrança, conversa automática ou lembrete recorrente (proibidos pela decisão de cobrança manual).
- Simulação de emissão fiscal ou de integração com SEFAZ/PSP.
- Aumentar o limite geral de 100 req/min como "solução" para 429 (decisão 50).
