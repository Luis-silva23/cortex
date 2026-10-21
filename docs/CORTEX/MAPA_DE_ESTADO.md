# Mapa de estado — CÓRTEX em 2026-10-05

Mapa por área, atualizado em 2026-10-05 a partir do **código** (contagens e leituras feitas nesta data) e dos documentos. A versão anterior (recuperação de 2026-10-04, Fase 2) continua no Git (commit `27cd2b3`); o que mudou desde então está no [CHANGELOG](CHANGELOG.md).
O que foi **executado** nesta data e o que vem de rodadas anteriores está separado em [Testes](#testes): nada herdado aparece como se fosse de hoje.

Vocabulário (usado igual em [CURRENT_STATE](CURRENT_STATE.md) e [ROADMAP](ROADMAP.md)):

| Marca | Significa |
|---|---|
| ✅ **IMPLEMENTADO** | existe, foi verificado (código e teste) |
| 🟡 **PARCIAL** | existe, mas tem parte conhecida que não existe |
| 🧱 **PREPARADO / BASE** | estrutura criada para receber uma evolução; **não é** a funcionalidade |
| 🔴 **PENDENTE** | não existe |
| 🔵 **DECISÃO PENDENTE** | falta decisão do dono antes de implementar |
| 🟣 **PRODUÇÃO / EXTERNO** | depende de ambiente de produção, contrato ou provedor |
| ⚪ não testado · 🟠 risco aberto | |

## Inventário (contado em 2026-10-05)

| Item | Valor |
|---|---|
| Aplicações | 8: `api`, `admin-web`, `super-admin`, `pdv-desktop`, `mobile`, `tv`, `e2e`, `hml`; pacotes `database` e `shared` |
| API | 58 arquivos de rota (com `index.ts`), 96 de serviço (sem testes, com subpastas), 13 de middleware, 5 jobs, 6 filas BullMQ |
| Banco | **102 modelos Prisma, 48 enums, 30 migrações** em 2026-10-05 (a última: `20261006100000_integration_gateway`). **Em 2026-10-15: 106 modelos/tabelas e 50 migrações** — ver [CURRENT_STATE](CURRENT_STATE.md) e [BANCO_DE_DADOS](BANCO_DE_DADOS.md) |
| Módulos (`SystemModule`) | 8: ESTOQUE, COMPRAS, VENDAS, FINANCEIRO, FISCAL, OFICINA, POS_VENDA e **CANAIS** (único que nasce desligado) |
| Perfis (`UserType`) | 6: SUPER_ADMIN, COMPANY_ADMIN, MANAGER, OPERATOR, MECHANIC, VIEWER. Caixa e Balcão **não** são papéis (são OPERATOR; decisão 15) |
| Testes (arquivos) | 100 unitários da API, 88 de integração, 32 do Admin Web, 4 de lógica do PDV, 3 de navegador (`apps/e2e`), 10 scripts HML |
| Repositório | `master`, 270 commits, **sem remoto configurado** |
| Contagem dos documentos antigos | "79 rotas / 126 serviços" contava de outro jeito (incluía testes: 81 / 139); a tabela acima é a de hoje, sem testes |

## Estado por área

| Área | Estado | Base (onde está a prova) |
|---|---|---|
| Isolamento empresa/filial (RLS `FORCE`) | ✅ 🟠 | matriz de 444 casos; `db:check-rls` OK em 2026-10-04 (91 tabelas, 105 policies); as 4 tabelas de canais entraram depois e **não foram reverificadas** (banco parado nesta fase); 🟠 políticas com `companyId IS NULL` em `permissions`, `refresh_tokens`, `request_logs`, `system_logs` |
| Autenticação, sessão, MFA, revogação | ✅ 🟡 🟠 | `refresh-token-reuse`, `logout-revokes-access`; **MFA no login do PDV existe** (`LoginPage.tsx`, [SEGURANCA-PDV](policies/SEGURANCA-PDV.md)); SMS e e-mail de MFA não existem em produção; 🟠 refresh token cru em `refresh_tokens` |
| Limite de login / rate limit | ✅ 🔵 🟠 | dois baldes (falhas × reservas); sem `trust proxy`, balde por IP (NAT), sem desbloqueio administrativo, 100 req/min contra 5–17 chamadas por tela |
| Permissões por papel/perfil | ✅ 🔵 | matriz de 8 perfis; decisões 14–18 abertas; dashboards de gestão fechados a OPERATOR/VIEWER/MECHANIC em 2026-10-05 |
| PDV (venda, pagamento, caixa) | ✅ 🟣 ⚪ | jornadas em navegador, `payment-flow`, caixa por forma de pagamento; PIX/TEF reais não existem; impressora/leitor sem hardware |
| Oficina (orçamento → OS → entrega) | ✅ 🔵 | `quote-lifecycle`, `workshop-*`, garantia; decisões 13, 26–29 |
| Estoque, compras, devolução ao fornecedor | ✅ 🔵 | livro de estoque no banco, `supplier-returns`; decisões 24, 41–45; **sem reserva** (ver Canais) |
| Financeiro, convênios, cobrança manual | ✅ 🔵 | `agreements`; juros/multa e devoluções de convênio: decisões 30–37; fluxo de caixa sem as vendas do PDV: decisão 75 |
| Fiscal | 🟣 🔵 | só `unconfigured-adapter` (nada é emitido); devolução fiscal: decisões 7–9 |
| Agenda e pós-venda | ✅ 🔵 | capacidade configurável; regras avançadas: decisões 10–12 |
| Central de Ajuda e Suporte | ✅ 🟡 | e2e de navegador 18/18 (2026-10-04); sem SLA, aviso externo nem Configurações do Console |
| Super Admin (empresas, licenças, monitoramento, backup) | ✅ | e2e e evidências; `backup:verify` 18/18 (2026-10-04) |
| Monitoramento e telemetria | ✅ 🟡 🟣 | alertas com limites; bloqueio de login e 429 **não** aparecem; API fora só com sonda externa |
| Mobile e TV | ⚪ 🟡 | só `tsc`; nunca testados em aparelho; marca ainda "LN System" |
| Resiliência (Redis/PG fora) | ✅ | caos controlado de 2026-09-27 |
| Erros em PT-BR sem vazamento técnico | ✅ | `translate-errors` |
| Ferramentas HML (`apps/hml`) | ✅ ⚪ | processos ocultos e rastreados, trava de carga (`LOAD_DISABLED`); `ui-evidence.js` tem a fase `gerencial` |
| **Dashboard gerencial** (Administrador e Gerente) | ✅ 🟡 | ver [abaixo](#dashboard-gerencial) |
| **Canais de venda (CANAIS)** | 🧱 🟡 | base + **Commerce API Fases 1 e 2 e Integration Gateway (Fase 3, provedor simulado) implementados** (2026-10-05/06); ver [abaixo](#canais-de-venda) |
| **Comissão** | 🟡 | ver [abaixo](#comissão) |
| Commerce API (`/commerce/v1`) | ✅ 🟡 | **Fase 1 IMPLEMENTADA em 2026-10-05** ([COMMERCE_API §0](COMMERCE_API.md#0-implementação--estado-em-2026-10-05)): credencial de canal assinada, catálogo publicado, pedido externo (não é venda), pagamento externo recebido; 43 testes de integração. 🟡 sem aceitar/reservar/converter (Fase 2) |
| E-commerce completo (checkout, fulfillment, venda de canal) | 🔴 🔵 | não existe; depende da Fase 2 e das decisões 83–92 |
| Reserva de estoque para canais | 🔴 🔵 | não existe; Fase 2 do ROADMAP |
| Integrações reais (iFood, marketplaces, site) | 🔴 🟣 🔵 | **nenhuma real**: o gateway genérico existe (Fase 3, [INTEGRATION_GATEWAY](INTEGRATION_GATEWAY.md)) e só o provedor simulado está registrado (fora de produção); falta o primeiro provedor real, com credencial de homologação |
| Agentes / orquestração | 🔴 | não existem no produto (só ferramentas externas de desenvolvimento; decisão registrada) |
| Produção | 🔴 🟣 🟠 | nada publicado; ver [Produção](#produção) |
| Carga/stress | ⚪ | rodados só até o nível 2, **antes** da regra; hoje proibidos neste computador (`apps/hml/LOAD_DISABLED`) |

## Dashboard gerencial

**IMPLEMENTADO E HOMOLOGADO** (2026-10-05; [DASHBOARD_GERENCIAL](DASHBOARD_GERENCIAL.md); evidências em `docs/evidencias/2026-10-05-dashboard-gerencial/`).

- **Implementado:** período único resolvido só na API em Brasília (Hoje, Ontem, 7 e 30 dias, Mês atual e anterior, Ano, Personalizado); comparação com o período anterior; seis KPIs (Receita, Vendas, Ticket, Saques, Cancelamentos/devoluções, Descontos); evolução em Linha (padrão) ou Colunas, com ponto em cada observação e linha interrompida onde falta dado; formas de pagamento por vendas distintas; origem das vendas (donut e tabela, só canais ativos); caixa e saques; operação (OS, estoque, contas vencidas). Dois endpoints (`GET /api/dashboard/management/summary` e `/timeseries`), uma transação de leitura cada, agregação no PostgreSQL, RLS; Admin e Gerente só; OPERATOR/VIEWER/MECHANIC recebem 403.
- **Parcial / resíduo (não é defeito do painel gerencial):** o painel do **SUPER_ADMIN** em contexto de empresa, o do **MECHANIC** e o do **OPERATOR/VIEWER** continuam sendo o dashboard antigo (`app/dashboard/page.tsx`, endpoints `/ceo`, `/workshop`, `/pdv`), e esse código ainda calcula no navegador a janela de 30 dias (`resolvePeriodRange`), fora da regra única de período. Registrado no [ROADMAP](ROADMAP.md); não alterado nesta fase.
- **Pendente (decisões 70–73, 75, 77–80):** vendas por operador, margem, devolução parcial, valor de venda cancelada, fluxo de caixa, convênio, nome "Saque/Retirada", giro/recorrência, índices e RLS de `payments`.

## Canais de venda

**BASE ARQUITETURAL + Commerce API (Fase 1)** — ainda não é e-commerce completo. [CANAIS](CANAIS.md); registro em [DECISIONS › Tomadas](DECISIONS.md#tomadas) (2026-10-05, "Canais de venda: base pronta").

- **Existe e foi verificado (21 testes de integração e 14 de gateway):** módulo `CANAIS` desligado por padrão (opt-in por empresa/filial); `sales_channels` com tipo técnico estável e nome exibido configurável; estados de conexão (`NOT_CONFIGURED`, `UNVALIDATED`, `CONNECTED`, `ERROR`), com "Conectado" só depois de teste real; credencial cifrada (`enc:v1`) e nunca devolvida; `Sale.channelId` (nulo = loja física); `external_orders`, `channel_inbound_events` e `channel_events` com idempotência (canal, evento, operação); gateway genérico (`ChannelProvider`, prazo, retentativa, disjuntor, assinatura HMAC de webhook com janela de tempo); tela de administração (só COMPANY_ADMIN/SUPER_ADMIN); origem no Dashboard.
- **Pedido externo ≠ venda ≠ pagamento ≠ estoque:** o pedido é só registrado; nada cria venda, pagamento, baixa de estoque ou documento fiscal.
- **Commerce API (Fase 1, implementada em 2026-10-05):** `/commerce/v1` fora de `/api`; credencial de canal com HMAC (segredo cifrado, mostrado uma vez); catálogo só do publicado com disponibilidade; pedido externo com preço oficial (`RECEIVED`, **não é venda**); pagamento externo só recebido; administração e tela; `SITE_PROPRIO` sem provedor (`CONNECTED` na 1ª chamada assinada). Provado por 43 testes de integração. Desenho e decisões: [COMMERCE_API](COMMERCE_API.md).
- **Não existe:** nenhum provedor de integração (o registro de provedores está **vazio**), **nenhuma integração real ativa**, rota pública de webhook de provedor, aceitar/reservar/converter pedido em venda, venda sem caixa físico, reserva de estoque, fulfillment, sincronização de catálogo/preço/estoque para terceiros, comissão de canal.

## Comissão

**PARCIAL** — [COMISSAO](policies/COMISSAO.md); registro em [DECISIONS › Tomadas](DECISIONS.md#tomadas) (2026-10-05, "Comissão: política `commission.enabled`").

- **Implementado:** política `commission.enabled` por empresa/filial (padrão ligada); comissão de mecânico sobre a mão de obra da OS, com `ruleSnapshot` da regra aplicada (regra alterada depois não recalcula o passado); testes de OS preservados.
- **Registrado para o futuro, sem código:** `Sale.userId` guarda o operador responsável (a comissão de venda deve seguir o operador, não o número do PDV).
- **Pendente:** comissão sobre venda (PDV e canais), produto/categoria elegível, vigência, cancelamento/devolução, fechamento e liquidação, estados completos, dashboard de comissão; canal externo **não** é comissionado automaticamente. Regra ainda não definida: decisão 85.

## Produção

Nada foi publicado. Para o projeto virar uma aplicação de produção (**Fase 4** do [ROADMAP](ROADMAP.md)), faltam, com o que já existe no repositório:

| Item | Situação hoje |
|---|---|
| Migrações e RLS fora de dev/teste | 🟣 nunca aplicadas em staging/produção (P1) |
| Segredos (`DATA_ENCRYPTION_KEY`, JWT, role de backup) | 🟣 só no `.env` de dev (P2) |
| Expurgo de auditoria antiga com segredo | 🟣 pendente (P3) |
| `docker-compose.yml` | 🟡 corrigido em 2026-10-06 (senhas obrigatórias por variável, portas em loopback; **não validado com Docker**); continua sendo stack de desenvolvimento/homologação |
| `Dockerfile` | existe para `api`, `admin-web` e `super-admin`; **nunca validado aqui** (sem Docker); não há para PDV, mobile e TV |
| CI/CD | existe `.github/workflows/ci.yml`; **nunca rodou no GitHub** (e o repositório não tem remoto); não há entrega (CD) |
| HTTPS, domínio, `trust proxy` | 🔴 domínio/HTTPS não existem (a API não termina TLS); 🟡 `TRUST_PROXY` configurável e validado (decisão 47: falta o valor da topologia real) |
| Backup e restauração | ✅ `backup:verify` 18/18 (dev); 🟣 rotina em produção e teste de restauração no ambiente real |
| Observabilidade em produção | 🟡 métricas internas, log de acesso com `requestId`/empresa/filial/usuário, sondas `live`/`ready`/`health`; sem APM/alerta externo (alertas a configurar: [PRODUCAO §8](PRODUCAO.md#8-observabilidade-e-operação)) |
| Rollback, recuperação | 🟡 documentados em [PRODUCAO](PRODUCAO.md) (**nada executado**: sem infraestrutura); backup contínuo e restauração periódica não existem (decisão 106) |
| Provedores reais (fiscal, PIX/TEF, mensagens) | 🟣 nenhum (P5) |
| `next build` valida tipos e lint | ✅ corrigido em 2026-10-06 (P6; `next build` real passou) |
| Validação da configuração, desligamento ordenado, auditoria durável | ✅ implementados e testados em 2026-10-06 (SIGTERM real só em Linux/staging) |
| Pool de conexões, rate limit, hardening | 🔵 decisões 47–52, 56, 57 |

## Decisões do dono pendentes

Fonte: [DECISIONS](DECISIONS.md). **90 itens abertos em 2026-10-06:** 4–57 (54; a 54 parcialmente respondida, a 47 com o mecanismo pronto), 70–73, 75, 77–80 (9) e **82–108 (27)**: canais, Commerce API, reserva e conversão, gateway, comissão, LGPD, limites e produção (106 RPO/RTO, 107 janela de sessão revogada, 108 token no navegador/CSP).

## Testes

| Suíte | Resultado | Quando |
|---|---|---|
| API — unitários | **1056/1056 (105 suítes)** | **executado em 2026-10-06** (depois da Fase 4) |
| Admin Web — jest | **548/548 (32 suítes)** | **executado em 2026-10-06** (depois da Fase 4) |
| API — integração completa (94 suítes) | **1407/1407**, inclui `integration-gateway` 36/36, `auth-coverage` (389 rotas), `token-confusion` 7/7 e `login-enumeration` 5/5 | **executado em 2026-10-06** (depois da Fase 4) |
| API — integração da Commerce API (`commerce`, Fase 1) | **43/43** + 6 suítes relacionadas (RLS, idempotência, canais, painel gerencial, módulos) **77/77** | **executado em 2026-10-05** |
| `tsc --noEmit` | limpo em API, Admin Web e Super Admin | **executado em 2026-10-05** |
| API — integração, 4 suítes (`dashboard-management`, `sales-channels`, `module-settings-scope`, `rbac`) | **71/71** | **executado em 2026-10-05** |
| API — integração, rodada completa | 1239/1239 (85 suítes) | 2026-10-04 — **não reexecutada**; hoje são 87 arquivos (as 2 suítes novas somam 47 casos, executadas acima) |
| PDV — lógica | 20/20 | 2026-10-04 |
| e2e de navegador (`apps/e2e`, Central de Ajuda) | 18/18 | 2026-10-04; não roda no CI |
| HML | `profiles` 185, `profiles-extra` 121, `payments` 37, `rls` 26, `invariants` 45 | 2026-10-04 |
| `db:check-rls` · `backup:verify` | OK · 18 verificações | 2026-10-04 |
| Navegador real (homologação visual do Dashboard) | capturas 101–132, defeito do cabeçalho corrigido | 2026-10-05 |
| **Nunca executados / proibidos** | carga, stress, força bruta em massa, `security`/`concurrency`/`workshop-concurrency`/`ui-profiles`; aparelho (mobile/TV) e hardware (impressora/leitor) | — |

## Divergências entre documentação e código

**Corrigidas nesta atualização (2026-10-05):** canais "inexistentes" (`MAPA_DE_ESTADO`, `AUDITORIA_PRODUTO`, `RELATORIO_MESTRE`, decisão 54); contagens de modelos/migrações/rotas (`MAPA_DE_ESTADO`, `DATABASE`, `ROADMAP`, `AUDITORIA_PRODUTO`); números de teste (`CURRENT_STATE`, `FINAL_ACCEPTANCE`); "PDV não suporta MFA" (`SECURITY`); estado da comissão; linhas antigas do ROADMAP (varredura "só depois da aprovação", dia sem venda "fica para decisão"); permissões dos dashboards (`permission-matrix`); módulo CANAIS e tabelas de canais nos contratos; `ARCHITECTURE`/`CODE_MAP`/`FRONTEND` sem Dashboard gerencial e Canais.

**Ainda abertas (registradas, não alteradas):**
1. Dashboard antigo para SUPER_ADMIN, MECHANIC, OPERATOR e VIEWER, com janela de 30 dias calculada no navegador (resíduo acima).
2. Contagem de policies/tabelas com RLS no banco real não reverificada depois das tabelas de canais (banco parado).
3. Os commits da frente Dashboard/Canais estão datados de 2026-10-04 e 2026-10-05 porque a rodada atravessou a meia-noite; os documentos novos usam 2026-10-05.
4. `docker-compose.yml`, `Dockerfile`s e `.github/workflows/ci.yml` não foram executados nesta máquina.
