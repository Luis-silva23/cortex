# Estado atual — 2026-10-14

## Resumo

O sistema funciona de ponta a ponta no ambiente de desenvolvimento (API, Postgres 18 com RLS, Redis, Admin Web, Super
Admin, PDV web/Electron) para balcão, PDV, oficina, estoque, compras, financeiro, pós-venda, Central de Ajuda, Dashboard
gerencial e operação da plataforma, com provas automatizadas e jornadas em navegador real. As regras que variam por
empresa/filial são **políticas** configuráveis e auditadas ([POLICIES](POLICIES.md)). **Não foi publicado em produção** e
depende de itens operacionais e de decisões do dono listados abaixo. Mapa por área, com o vocabulário abaixo:
[MAPA_DE_ESTADO](MAPA_DE_ESTADO.md). Sequência de evolução: [ROADMAP](ROADMAP.md#sequência-oficial-de-evolução).

Vocabulário: **IMPLEMENTADO** (existe e foi verificado) · **PARCIAL** (existe, falta parte conhecida) · **PREPARADO / BASE**
(estrutura para uma evolução futura; não é a funcionalidade) · **PENDENTE** (não existe) · **DECISÃO PENDENTE** (falta o dono
decidir) · **PRODUÇÃO** (depende de ambiente, contrato ou provedor).

## Estado por tema (2026-10-05)

| Tema | Situação | Resumo |
|---|---|---|
| Dashboard gerencial | **IMPLEMENTADO E HOMOLOGADO** (+ resíduo PARCIAL) | Administrador e Gerente: período único em Brasília, comparação, 6 KPIs, evolução Linha/Colunas, origem das vendas, formas de pagamento, caixa e saques, operação. Resíduo: SUPER_ADMIN, MECHANIC, OPERATOR e VIEWER seguem no painel antigo, que calcula a janela de 30 dias no navegador. Decisões 70–73, 75, 77–80 abertas. [DASHBOARD_GERENCIAL](DASHBOARD_GERENCIAL.md) |
| Canais de venda (CANAIS) e Commerce API | **BASE + Commerce API Fases 1 e 2 e Integration Gateway (Fase 3, só provedor simulado) IMPLEMENTADOS** (PARCIAL no e-commerce) | Módulo desligado por padrão; **`/commerce/v1`**: credencial de canal assinada (HMAC), catálogo publicado com disponibilidade, pedido externo idempotente com preço oficial (`RECEIVED`, **não é venda**), pagamento externo só recebido, administração e tela; gateway de provedores com registro **vazio**. **Nenhuma integração real ativa.** Sem aceitar/reservar/converter em venda, fulfillment nem sincronização para terceiros (Fase 2 em diante). [CANAIS](CANAIS.md), [COMMERCE_API](COMMERCE_API.md) |
| Comissão | **PARCIAL** | Política `commission.enabled` e comissão de mecânico da OS com `ruleSnapshot`. **PENDENTE:** comissão sobre venda (PDV e canais), estados, fechamento, liquidação, dashboard de comissão (decisão 85). [COMISSAO](policies/COMISSAO.md) |
| Estoque | **IMPLEMENTADO**; reserva **PENDENTE** | Livro `stock_movements` com saldo calculado no banco, inventário, transferência, avaria, importação. **Sem reserva** (Disponível → Reservado → Vendido) — Fase 2, decisão 82 |
| Financeiro e caixa | **IMPLEMENTADO** com decisões abertas | Contas, conciliação, caixa por forma de pagamento, saques, descontos, cancelamento e devolução, convênios, cobrança manual. Fluxo de caixa sem as vendas do PDV (75) |
| Fiscal | **PARCIAL** (configuração e documento) · **PREPARADO** (contrato do adaptador) · **PENDENTE / dependente de regulamentação e provedor** (IBS, CBS, Split Payment, cadastro tributário) | Configuração e documentos, política de operações, segredos cifrados; só `unconfigured-adapter`: **nada é emitido**. **IBS, CBS e Split Payment não existem** (nem tabela, campo ou cálculo; nada parcial foi inventado); não há NCM/CFOP/CST por produto. O operador do PDV não digita dado tributário e a separação Venda → Parcelas → Liquidação → Fiscal é protegida por teste. Devolução fiscal e provedor pendentes (7–9). [FISCAL](policies/FISCAL.md) |
| Parcelamento | **IMPLEMENTADO e provado** | Divisão em **centavos inteiros** (R$ 100,00 em 3x = 33,33 + 33,33 + 33,34; o resto vai 1 centavo para as últimas parcelas), uma só função para API e PDV; recusa parcelas 0/negativas/fracionárias, valor com fração de centavo e parcela menor que R$ 0,01; parcelas do convênio gravadas somam exatamente o total. Cronograma de recebimento do cartão **não** é persistido (depende de adquirente/decisão). [PARCELAMENTO](policies/PARCELAMENTO.md) |
| Central de Ajuda e Suporte | **IMPLEMENTADO** (PARCIAL em SLA e aviso externo) | Artigos por texto, chamados com contexto, Console no Super Admin. [SUPPORT](SUPPORT.md) |
| Super Admin de TI (2026-10-14) | **PROCEDIMENTO PRONTO e provado em integração** · conta **NÃO criada** | `npm run admin:bootstrap` (simulação, `--apply`, senha só por prompt/variável do comando, idempotente, sem promover outra conta, login 1 só se livre) + `enroll-mfa`; MFA obrigatório para Super Admin (`REQUIRE_MFA_PRIVILEGED`). Criar e conferir é ato de quem tem a senha: [PRODUCAO §13](PRODUCAO.md#13-primeiro-super-admin-bootstrap-e-mfa) |
| Catálogo: códigos de barras (2026-10-14) | **IMPLEMENTADO e provado** (integração 9 + E2E 7); imagem opcional do produto **IMPLEMENTADA** no mesmo dia (decisão 122, linha própria abaixo; a frase "PENDENTE" valia até a manhã de 2026-10-14) | Vários códigos por produto (texto, zeros preservados, único por empresa, desativar/reativar, principal sincronizado), ambiguidade legada `409 CODE_AMBIGUOUS`, importação por planilha |
| LGPD (2026-10-14) | **PARCIAL** — controles técnicos + minutas | [docs/privacidade](../privacidade/README.md): minutas **sem revisão jurídica**; exportação/anonimização do titular **implementadas** em 2026-10-14 (decisão 120, linha própria abaixo; "não automatizadas" valia até a manhã desse dia) |
| Sessão sem Redis (107), hash de senha (121), MFA de administradores (123) — 2026-10-14 | **IMPLEMENTADO e provado em integração** (10 + 8 + 14 testes) | revogação de sessão não falha mais aberta (PostgreSQL como fonte durável; 503 se nada responde); Argon2id com migração transparente do bcrypt; MFA obrigatório para COMPANY_ADMIN (configuração pela tela, anti-reuso de código, recuperação auditada). Falta: ensaio com Redis real derrubado e build da imagem Docker (staging) |
| Pedidos de titular — LGPD (120) — 2026-10-14 | **IMPLEMENTADO** (12 testes); pontos jurídicos **abertos** | exportação cifrada (24 h) e anonimização irreversível com retenção fiscal/garantia e bloqueio por cobrança em aberto; Admin Web › Privacidade (LGPD). Minutas em [docs/privacidade](../privacidade/README.md) |
| Imagem opcional do produto (122) — 2026-10-14 | **IMPLEMENTADO** (8 + 7 testes); PDV/Balcão não exibem | PNG/JPEG/WebP saneados (sem EXIF/GPS), 1 MB, sob RLS; Admin Web |
| Banco de dados — inventário (2026-10-14, atualizado em 2026-10-15) | **INVENTARIADO, reaplicado do zero e verificado em dev/teste**; staging/produção **não** | 107 tabelas, todas com RLS forçada; **55** migrações aplicadas em dev e teste; as 55 aplicadas do zero num banco vazio reproduzem o catálogo do dev (nada manual invisível; `migrate diff` vazio): [BANCO_DE_DADOS](BANCO_DE_DADOS.md), [MAPA_RELACIONAMENTOS](MAPA_RELACIONAMENTOS.md), [RELATORIO_MIGRATIONS](RELATORIO_MIGRATIONS.md). Os riscos registrados na revisão de 2026-10-14 (incluindo `refresh_tokens`) foram **corrigidos em 2026-10-15** — ver a linha seguinte e [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md) |
| Missão mestra de finalização (2026-10-18) | **CÓDIGO E TESTES LOCAIS APROVADOS; apps Android e PDV COMPILADOS; staging/produção, assinatura de código, provedores e comercial NÃO** | senha temporária e troca de senha (157), limite de usuários, bloqueio de empresa no Super Admin, filiais na tela (158), apps Android testados em emulador (159), PDV Electron 44 (160), preparação comercial (161): **estado único e vivo em [ESTADO_ATUAL_MISSAO_MESTRA](ESTADO_ATUAL_MISSAO_MESTRA.md)**, comercial em [PREPARACAO_COMERCIAL](PREPARACAO_COMERCIAL.md), apps em [DISTRIBUICAO_APLICATIVOS](DISTRIBUICAO_APLICATIVOS.md) |
| Central de Monitoramento do Super Admin (2026-10-18/19) | **IMPLEMENTADA e PROVADA LOCALMENTE** (unitários 1279; integração 123 suítes/1802, também como papel sem posse; E2E em navegador real 16/16); **nenhum serviço externo conectado** | Central, Empresas, Alertas (ciclo de tratamento), Funil e Serviços externos/custos em Observabilidade; 57 migrações, 113 tabelas; Sentry e Resend implementados **desligados** (sem credencial; só `fetch` simulado nos testes); Supabase = análise documental (nada migrado); Figma sem arquivo/conector; domínio/HTTPS/hospedagem/backup externo/destinatários **pendentes**; produção **não** declarada pronta: [PRODUCAO §18](PRODUCAO.md), [CHANGELOG](CHANGELOG.md) |
| Missão de segurança e liberação (2026-10-15 a 18) | **CÓDIGO CORRIGIDO e TESTES LOCAIS APROVADOS; pipeline SIMULADO fora do Docker; staging/produção NÃO validados; deploy NÃO executado** | contexto de RLS **assinado** (151; risco residual documentado), credencial de backup **fora da API** (152), gerente com **várias filiais** (153; `user_branches`), WAL/PITR cifrado + alertas (154, provado em laboratório), cópia restaurada **anonimizada** (155); **55 migrações** (2026-10-18), 107 tabelas; API: unitários **1202**, integração **122 suítes / 1705** (e **1705 como papel sem posse**), replay do zero 3593 itens iguais, `backup:drill` 25/25 com papéis separados, simulação do pipeline 0 falhas. **Pendente:** Docker/Linux, staging HTTPS, destino externo, alerta real, restauração em outro host (156); aprovação de RPO/RTO/retenção e das regras de visibilidade: [RELATORIO_SEGURANCA_PRODUCAO_2026-10-15](RELATORIO_SEGURANCA_PRODUCAO_2026-10-15.md) |
| Finalização de produção — escopo por filial, travas de privilégio, papéis do compose (2026-10-16) | **CÓDIGO CORRIGIDO e TESTES LOCAIS APROVADOS; pronto para homologação; NÃO validado para produção** | 2 migrations novas (**52** no total): gerente só a própria filial na API e na RLS (9 tabelas + `audit_logs` + `transfers`), gerente não se promove nem liga módulo desativado (nem por SQL direto), dashboards 403 ao pedir outra filial (decisão 145), compose sem superusuário na API (decisão 148, **não executado com Docker**). Integração 117 suítes / 1 643 testes em 2 ciclos e também como papel sem posse; Playwright 16/16 (subconjunto). Pendências: [RELATORIO_FINALIZACAO_PRODUCAO §9](RELATORIO_FINALIZACAO_PRODUCAO.md) |
| Backup e recuperação (2026-10-15/16) | **PRONTO E EXECUTADO LOCALMENTE; destino externo, alerta, outro host e WAL em produção NÃO existem** | `backup.sh` (00:00 + verificação 12:00 sem novo dump), `backup:drill` 21/21, PITR em laboratório; **RPO ≤ 15 min / RTO ≤ 1 h propostos, PENDENTE DE APROVAÇÃO**: [BACKUP_RECUPERACAO](BACKUP_RECUPERACAO.md) |
| Banco — revisão técnica e correção completa (2026-10-14/15) | **14 migrations novas (50 no total; 52 depois da finalização de 2026-10-16; 54 depois da missão de segurança de 2026-10-15; 55 depois da missão mestra de 2026-10-18 — senha temporária), diff banco → schema VAZIO**, todos os achados confirmados e seguros **corrigidos e provados** | sessões em hash e com `companyId` (D-01); FK composta (94), FK de empresa (65) e de filial (55), trigger de mesma empresa (3): referência cruzada entre empresas **impossível no banco**; histórico em `RESTRICT` e livros append-only; fuso UTC; índices; papéis dono × execução **provados** (`db:role-split-check`). **Pendentes (decisão/infra):** adoção do papel de execução em staging/produção, destino do recebível órfão legado (`NOT VALID`), prazos de retenção (jurídico), 34 índices-prefixo (medir em staging), regra de filial de 9 tabelas, staging/Linux/backup em outro host. [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md), [RELATORIO_EXECUCAO_REVISAO_BANCO](RELATORIO_EXECUCAO_REVISAO_BANCO.md), decisões 124–142 |
| Testes — correção do banco (2026-10-15) | **executados nesta rodada** | API: `tsc` limpo (todos os workspaces), lint 0 erros, unitários **1135 (114 suítes)**, integração completa **116 suítes: 1614 testes em 3 rodadas seguidas verdes e 1615 na rodada final** (uma com `PG_ENV_DEBUG=1`, 0 conexão sobrando por arquivo), `db:check-rls` OK, `db:replay-check` (4 cenários) idêntico, `db:role-split-check` aprovado (suíte completa 116 / 1614 como papel sem posse); detalhe em [resultados-testes](revisao-banco/resultados-testes.md) |
| Testes — rodada final (2026-10-14) | **executados nesta rodada** | API: `tsc` limpo, lint 0 erros, unitários **1118 (112 suítes)**, integração completa **1560 (108 suítes) em 2 rodadas seguidas verdes**, 0 conexão sobrando por arquivo; Admin Web **549**; PDV lógica **37**; Balcão **9**; `db:check-rls` OK; `backup:verify` 18/18; builds de API, Admin Web, Super Admin, Balcão e renderer do PDV; smoke do Electron (portão de equipamento; login/CORS não verificados); Playwright 6 + 22 + 14 (ver [CHANGELOG](CHANGELOG.md)). Não repetidos: `pdv-sale-flow` (cria venda persistente), instalador, HML, carga. Falha intermitente de `support-contextual-buttons`: causa = limite de 100 req/min por usuário (429), corrigida no teste |
| Segurança | **IMPLEMENTADO** com decisões abertas | RLS `FORCE`, RBAC, MFA (TOTP; também no login do PDV), refresh com rotação, revogação, segredos `enc:v1`, auditoria append-only. Abertas: `trust proxy`, bloqueio por IP e demais (47–50, 56); **corrigidos em 2026-10-14/15:** refresh token cru (agora SHA-256 e RLS estrita, decisão 128) e `WITH CHECK (true)` em logs (decisão 125) |
| Dispositivos (autorização) | **IMPLEMENTADO e provado em integração** (36 testes contra PostgreSQL/Redis reais); HTTPS real e aplicativo empacotado **PENDENTES** (infraestrutura) | Máquina nova se registra (pendente, sem empresa/filial), o Super Admin vincula licença e filial, e só então o login funciona; revogar/bloquear derruba a sessão na hora; chave só como hash; PDV com portão "Dispositivo aguardando autorização"; API responde 426 a HTTP em produção. **Não existe APK Balcão**: o Balcão é o aplicativo web próprio de atendimento (`apps/balcao`, sem caixa e fora do portão), e o PDV desktop é a frente de caixa — [APLICATIVOS](APLICATIVOS.md); mobile/TV sem o portão. Decisões 109–112. [DISPOSITIVOS](DISPOSITIVOS.md) |
| Infraestrutura | **IMPLEMENTADO em dev** / PRODUÇÃO pendente | Postgres 18 e Redis portáteis, BullMQ (6 filas) e agendador; `Dockerfile` (api, admin-web, super-admin) e CI **nunca executados**; nada publicado |
| Aplicativos | **IMPLEMENTADO** (6): PDV Desktop = caixa, **Balcão = atendimento (aplicativo próprio, 2026-10-13)**, Web/Admin = administração, Super Admin, Mobile, TV | Balcão não cobra, não cria venda/pagamento/caixa e não tem campo tributário (teste estático); encaminha ao caixa por ficha (importação automática = decisão 115); imagem/nginx e staging **prontos, não executados**. [APLICATIVOS](APLICATIVOS.md) |
| Testes | ver abaixo | **2026-10-14:** 1100 unitários da API (110 suítes), integração completa 1473/1474 (1 falha estática corrigida e reexecutada isolada), 548 do Admin Web, 28 do PDV, 9 do Balcão, **E2E de navegador 51** (Balcão 12, Admin Web 9, Super Admin 6, PDV 6, Suporte 18); `tsc` limpo; builds de 2026-10-13. [AUDITORIA_FINAL](AUDITORIA_FINAL_2026-10-14.md); **etapa de consolidação (2026-10-14):** PDV lógica 36, `reauthenticate` 5, dispositivos+logout 39, E2E Balcão 13 e PDV 9, smoke Electron OK (suíte completa de integração não repetida nesta etapa). [CONSOLIDACAO_FINAL](CONSOLIDACAO_FINAL.md) |

## Testes

Executados em **2026-10-05** (nesta atualização, sem carga; só testes leves e sequenciais): API unitários **994/994 (99 suítes)**, Admin Web **538/538 (31 suítes)**, `tsc --noEmit` limpo em API, Admin Web e Super Admin, e 4 suítes de integração (`dashboard-management`, `sales-channels`, `module-settings-scope`, `rbac`) **71/71**.
**Não reexecutados em 2026-10-05** (valem os números de 2026-10-04): integração completa, PDV lógica, smoke do Electron, e2e de navegador, `db:check-rls`, `backup:verify`, HML, e `tsc` do PDV, mobile e TV. **Nunca executados, de propósito:** as suítes HML de pressão `security`, `concurrency`, `workshop-concurrency` e `ui-profiles`, carga e stress.

| Suíte | Resultado | Quando |
|---|---|---|
| API — unitários | **1056/1056 (105 suítes)** (inclui `dashboard-period` 21, `gateway` 14, `commerce` 21, `integrations` 14, `env` 9, `shutdown` 4 e `health` 6) | **2026-10-06** |
| Admin Web (jest) | **548/548 (32 suítes)** (inclui `dashboard-management` 8 e `sales-channels` 10) | **2026-10-06** |
| API — integração, Commerce API, reserva, gateway e segurança | **1407/1407 na suíte completa (94 suítes)**; `commerce.integration` 43/43, `commerce-reservations.integration` 25/25, `integration-gateway.integration` 36/36 e as relacionadas (`sales-channels`, `rls-invariants`, `idempotency-key`, `dashboard-management`, `module-settings*`) | **2026-10-05** |
| API — integração, 4 suítes do dia anterior | 71/71 | 2026-10-05 (manhã) |
| API — integração (Postgres + Redis reais, banco `lnsystem_test`, papel da aplicação com RLS), rodada completa | 1239/1239 (85 suítes) | 2026-10-04; hoje são **87 arquivos** (`dashboard-management` 26 e `sales-channels` 21 vieram depois e foram executados acima); a rodada completa nova **não foi feita** |
| `tsc --noEmit` | limpo em API, Admin Web e Super Admin | **2026-10-05**; PDV, mobile e TV: 2026-10-04 |
| PDV — lógica (pagamento, resumo, fechamento de caixa, chamado) | 20/20 | 2026-10-04 |
| HML (ambiente isolado) | `profiles` 185/185, `profiles-extra` 121/121, `payments` 37/37, `rls` 26/26, `invariants` 45/45 | 2026-10-04 |
| PDV — smoke do Electron | OK: login por `file://`, rota `#/login`, ponte de impressão, `fetch` até a API sem bloqueio de CORS; exige `ELECTRON_RUN_AS_NODE` fora do ambiente | 2026-10-04 |
| RLS (`db:check-rls`, dev) | todas as invariantes OK (91 tabelas, 105 policies); as 4 tabelas de canais **não foram reverificadas** | 2026-10-04 |
| Navegador real (`walk-round2`) | 18/18 (PDV, convênios, devolução ao fornecedor, agenda) | 2026-09-28 |
| **E2E de navegador no repositório** (`apps/e2e`, Chrome, dev + empresa demo) | **18/18 (3 arquivos)**: Ajuda e Console, categorias e artigos, botão do PDV com duplo clique, botões contextuais em OS, garantia da OS, cobrança e Pós-venda › Garantias; HTML no texto não executa; empresa B não abre chamado da empresa A; sem erro de página nem 5xx. Exige o ambiente de desenvolvimento no ar ([README](../../apps/e2e/README.md)); não roda no CI | 2026-10-04 |
| Backup (`backup:verify`) | 18 verificações, banco temporário removido (restauração, RLS no restaurado, MFA recuperável com a chave certa e não sem ela) | 2026-10-04 |
| Homologação visual do Dashboard gerencial | capturas 101–132; defeito do cabeçalho de erro corrigido (`fca2b8e`) (HOMOLOGACAO_FINAL (evidência arquivada fora do repositório publicado: `docs/evidencias/2026-10-05-dashboard-gerencial/HOMOLOGACAO_FINAL.md`)) | 2026-10-05 |

Jornadas em navegador real com evidência: PDV completo, balcão/oficina, mecânico, cédulas, PIX, monitoramento, agenda,
importação, PDV sem rede, desconto, caixa, conciliação, fiscal, orçamentos, garantia, cliente, convênios, cobrança, estados
de pagamento do PDV, MFA do PDV, Configurações e o Dashboard gerencial (evidências (evidência arquivada fora do repositório publicado: `docs/evidencias/README.md`)).

## O que existe

- **Plataforma (Super Admin):** empresas, licenças, dispositivos com ativação, usuários, backup, auditoria,
  observabilidade, monitoramento Empresas → Filial com alertas e limites configuráveis.
- **Empresa (Admin Web):** cadastros (cliente com WhatsApp e contato preferencial), estoque com livro de movimentos,
  inventário, transferências, avarias, importação em lote, vendas, OS (desconto autorizado, garantia no encerramento),
  orçamentos (vencidos, encerrar em lote, reabrir), compras (com devolução ao fornecedor), financeiro (conciliação, recebíveis com cobrança manual),
  convênios (funcionário e empresa conveniada, folha, espelho), fiscal (sem provedor), pós-venda com agenda e garantias,
  usuários/perfis, módulos, pagamentos, **Dashboard gerencial** (Administrador e Gerente), **Canais de venda** (tela de
  administração; só com o módulo CANAIS ligado), **Configurações › Empresa, Políticas e Funcionamento**.
- **PDV:** caixa (fechamento por forma de pagamento — esperado × informado, motivo com divergência — com pendências e forçado), venda, pagamento (dinheiro/troco/cédulas, cartão manual, PIX
  pendente, convênio), estados reais de pagamento, desconto com autorizador, cancelamento/devolução/sangria com
  autorizador, login com MFA, telemetria.
- **Central de Ajuda e Suporte:** a empresa busca artigos (texto, sem IA), abre e acompanha chamados no Admin Web (com
  contexto automático e "Relatar problema" no PDV, OS, garantia, cobrança e pós-venda); a plataforma atende no Console de
  Suporte do Super Admin. Detalhes e limites: [SUPPORT](SUPPORT.md).
- **Mobile e TV:** agenda (concluir com autorização) e OS; painel da oficina.

## Requisitos de ambiente

- **`DATA_ENCRYPTION_KEY` é obrigatória** (32 bytes em base64): a API não sobe sem ela. Nunca no repositório nem em logs;
  guardar junto do backup, em local separado — sem ela os segredos cifrados não voltam ([SECURITY](SECURITY.md#data_encryption_key--obrigatória)).
- `JWT_SECRET`/`JWT_REFRESH_SECRET` fortes; `BACKUP_DATABASE_URL` (role de backup com BYPASSRLS); Postgres 18; Redis 7+.
- Modelo de variáveis: `.env.example` (há variáveis de exemplo de provedores — Mercado Pago, Stripe, SendGrid, AWS,
  Sentry — que o código **não** lê hoje).

## Limitações conhecidas

- Sem provedores reais: pagamento por terminal/PSP, emissão fiscal, envio de SMS/e-mail e WhatsApp oficial operam no
  modo manual honesto (cobrança por WhatsApp abre um link; e-mail aparece como "canal não configurado").
- **Sem canais externos reais:** o módulo CANAIS é base; não há iFood nem marketplace reais (o Integration Gateway genérico existe, com provedor simulado: [INTEGRATION_GATEWAY](INTEGRATION_GATEWAY.md)); a Commerce API, a reserva de estoque e a conversão de pedido em venda existem (Fases 1 e 2), com as regras comerciais pendentes (95 a 102) ([CANAIS](CANAIS.md)).
- Comissão só de OS; comissão sobre venda não existe ([COMISSAO](policies/COMISSAO.md)).
- O dashboard de SUPER_ADMIN, MECHANIC, OPERATOR e VIEWER é o antigo; ele calcula a janela de 30 dias no navegador ([MAPA_DE_ESTADO](MAPA_DE_ESTADO.md#dashboard-gerencial)).
- Mobile e TV não testados em aparelho (sem Android SDK/emulador aqui); impressora e leitor do PDV não testados em hardware.
- PDV não vende sem rede (de propósito — não enfileira venda).
- `next build` do Admin Web ainda ignora tipos e lint (o `tsc` separado está limpo).
- Algumas listas sem paginação no servidor (empresas, ativações pendentes, transferências, inventários).
- Detecção de "API fora do ar" precisa de sonda externa (a API não se mede quando cai).
- Com Redis fora, o limite de tentativas conta por instância; auditoria fica em memória até ele voltar.
- Ambiente de homologação (`apps/hml`): os 503 `P1001` do painel (14:08 e 18:00) têm **causa confirmada**: rajada de ~30 conexões com o pool frio passando dos 5 s do Prisma, com o Postgres de pé (ajustado só na HML; decisão 57 para o produto). O `P1017` das 16:40 segue sem causa
  ([DIAGNOSTICO_FASE6](DIAGNOSTICO_FASE6.md)). O Dashboard gerencial faz 3 chamadas ao abrir (antes 6) e **não** teve erro 5xx com o pool frio na medição de 2026-10-05; a decisão 57 segue do dono. Carga/stress está travada neste computador (`apps/hml/LOAD_DISABLED`).
- O repositório **não tem remoto Git**: nada está copiado fora desta máquina.
- Lacunas de produto levantadas (fiscal real, LGPD…): [AUDITORIA_PRODUTO](AUDITORIA_PRODUTO.md); mapa por área: [MAPA_DE_ESTADO](MAPA_DE_ESTADO.md).

Detalhes e próximos passos: [ROADMAP](ROADMAP.md). Decisões pendentes (74 itens em 2026-10-05; entre elas: devolução fiscal, regras de agenda além do mecanismo de capacidade, garantia por rede, juros/multa e devoluções de convênio,
provedor oficial de WhatsApp/e-mail, **reserva de estoque, Commerce API, conversão de pedido externo em venda e comissão sobre venda**): [DECISIONS](DECISIONS.md#pendentes).
