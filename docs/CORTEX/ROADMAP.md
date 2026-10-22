# Roadmap — o que falta

Decisões de produto/negócio pendentes estão em [DECISIONS](DECISIONS.md#pendentes); aqui fica o trabalho de engenharia e
operação. Cada item diz por que existe, se bloqueia produção e o próximo passo.

## Sequência oficial de evolução

Definida pelo dono em 2026-10-05 ([DECISIONS › Tomadas](DECISIONS.md#tomadas)). **Fases 1, 2 e 3 implementadas em 2026-10-05/06; Fase 4 (auditoria e preparação técnica para produção) feita em 2026-10-06 — a produção em si depende de infraestrutura, ver [DIAGNOSTICO_PRODUCAO](DIAGNOSTICO_PRODUCAO.md)** (execução técnica autorizada pelo dono; regras comerciais seguem pendentes em [DECISIONS](DECISIONS.md), 82 a 105; a Fase 3 só com provedor simulado). A próxima é a **Fase 4** (produção). **Fase 1A (desenho, só documentação) feita em 2026-10-05 como proposta não aprovada:** [COMMERCE_API](COMMERCE_API.md), que também propõe um **ajuste de ordem** (§15): como aceitar pedido exige reserva, a Fase 1 entregaria leitura e recebimento de pedido, e a reserva e a conversão ficariam na Fase 2. Nada disso vale até o responsável aprovar.

Princípios que valem em todas as fases: PostgreSQL é a fonte da verdade; Redis é cache e apoio, nunca fonte da verdade; o CÓRTEX é a autoridade dos dados de negócio e as integrações externas são canais de entrada e saída; isolamento por empresa/filial, RLS e autorização no backend; **nenhum banco paralelo de e-commerce**; integração real de qualquer provedor só na fase própria.

| Fase | O que entrega | O que existe hoje | Depende de (decisões) | Fora do escopo da fase |
|---|---|---|---|---|
| **1 — Commerce API / E-commerce** | API pública para um site/e-commerce consumir o CÓRTEX com segurança | ✅ **IMPLEMENTADA em 2026-10-05** ([COMMERCE_API §0](COMMERCE_API.md#0-implementação--estado-em-2026-10-05)): `/commerce/v1` com credencial de canal assinada (HMAC), catálogo publicado com disponibilidade, pedido externo idempotente com preço oficial (`RECEIVED`, não é venda), pagamento externo recebido, administração e tela. **Falta** (Fase 2): aceitar, reservar, converter em venda; e as decisões comerciais pendentes (83–92) | 84, 83, 86, 91 (e 54, parcial) | reserva de estoque; iFood e marketplaces |
| **2 — Reserva de estoque para canais** | Disponível → Reservado → Vendido, com expiração, cancelamento, liberação, concorrência, atomicidade, integração com PDV/Balcão e auditoria | ✅ **IMPLEMENTADA em 2026-10-05** ([COMMERCE_API §0](COMMERCE_API.md#fase-2--reserva-de-estoque-e-conversão-em-venda-feita)): `stock_reservations` (aceite reserva tudo ou nada, prazo configurado no canal, expiração imediata + job), disponível conferido por balcão/PDV, OS, transferências e devolução ao fornecedor, `ConvertOrder` idempotente (venda de canal sem caixa físico), fulfillment mínimo, trava de produtos em ordem fixa. **Falta** decidir: prazo, momento da venda, pagamento na entrega, estorno, fiscal/comissão, responsáveis do fulfillment (95 a 102) | 82, 83, 87, 90 | integrações reais |
| **3 — Integration Gateway + integrações reais** | iFood, marketplaces e outros canais, sobre arquitetura **genérica** (nada rígido para um só fornecedor) | ✅ **Gateway genérico IMPLEMENTADO em 2026-10-06** ([INTEGRATION_GATEWAY](INTEGRATION_GATEWAY.md)): contrato de provedor completo, webhook assinado idempotente (fora de ordem, repetição, correlação), consulta periódica, caixa de saída com retentativa/disjuntor/classes de erro, sincronização sob demanda, provedor **simulado** (`sandbox`). 🔴 **Integração real de qualquer provedor NÃO existe** (precisa de credencial de homologação, formato do provedor e as decisões 86 a 92 e 103 a 105) | 86 a 92, 103 a 105 | produção |
| **4 — Produção** | Segurança, infraestrutura, secrets, backup, restore, observabilidade, CI/CD, HTTPS, domínio, migrações, PostgreSQL, Redis, RLS, autenticação, rate limiting, recuperação, rollback e hardening | 🟡 **Preparação técnica FEITA em 2026-10-06** ([DIAGNOSTICO_PRODUCAO](DIAGNOSTICO_PRODUCAO.md), [PRODUCAO](PRODUCAO.md)): auditoria de segurança com 2 vulnerabilidades corrigidas, validação de configuração, desligamento ordenado, sondas, auditoria durável, CI e compose revisados, runbook de deploy/rollback/backup. 🔴 **Nada publicado**: faltam domínio, HTTPS, banco/Redis gerenciados, cofre de segredos, Git remoto/CI executado, backup contínuo e as validações de staging (carga, SIGTERM real, restauração, Docker) | 47, 48, 51, 52, 55, 56, 57, 106 a 108 | — |
| **5 — Auditoria dos processos** | Auditoria operacional dos fluxos do ponto de vista de **negócio**, não só de código: venda, pagamento, estoque, cancelamento, devolução, transferência, compra, OS, comissão, convênio, caixa, canais, fiscal, permissões, Dashboard e empresa/filial/RLS | 🔴 não iniciada; depois da infraestrutura principal | as decisões abertas de cada fluxo (74 itens em 2026-10-05) | — |

**Resíduos técnicos conhecidos, sem fase atribuída** (registrados em 2026-10-05; decidir onde entram): o dashboard antigo de SUPER_ADMIN, MECHANIC, OPERATOR e VIEWER ainda calcula a janela de 30 dias no navegador (`resolvePeriodRange` em `apps/admin-web/app/dashboard/page.tsx`), fora da regra única de período do painel gerencial; a contagem de tabelas e policies com RLS não foi reverificada depois das tabelas de canais.

## Antes de produção (bloqueia go-live)

| # | Item | Por quê | Depende de | Próximo passo |
|---|---|---|---|---|
| P0 | HTTPS real e fumaça do fluxo de equipamento em staging; política `devices.requiredUserTypes` por empresa | O código (426 em HTTP, `TRUST_PROXY` obrigatório, autorização de equipamento, `DeviceGate` no PDV) está provado por teste; falta domínio, certificado e um host Linux para `docker-compose.staging.yml` + `scripts/smoke-device-flow.js` ([DISPOSITIVOS](DISPOSITIVOS.md#10-o-que-foi-provado-e-o-que-falta), decisão 109) | domínio, certificado, servidor | seguir [PRODUCAO §11](PRODUCAO.md#11-https-conexão-dos-aplicativos-e-autorização-de-equipamento-2026-10-06) |
| P1 | Aplicar migrações e conferir RLS em staging/produção | **50 migrações em 2026-10-15** (31 até `20261006200000_device_enrollment`; as 19 seguintes, de 2026-10-14/15, estão em [DECISIONS](DECISIONS.md) 107, 120–124 e 124–142; use o papel **dono** só para migrar e, em produção, o papel de execução de `deploy/db-runtime-role.sql`); inclui as de políticas de 2026-09-27/28, a da Central de Ajuda e a de canais de venda de 2026-10-05); aplicar com o **dono das tabelas da aplicação** (`lnsystem`) — aplicadas por outro papel (ex.: `postgres`), as tabelas novas ficam sem SELECT/INSERT para a aplicação (visto nos bancos de teste dos agentes) (inclui isolamento por filial, exceções de pagamento, append-only da auditoria) só foram aplicadas em dev/teste | acesso ao ambiente | `prisma migrate deploy` + `npm run db:check-rls` ([DATABASE](DATABASE.md)) |
| P2 | Segredos de produção | `DATA_ENCRYPTION_KEY`, `JWT_SECRET`/`JWT_REFRESH_SECRET`, role de backup | cofre do ambiente | gerar, guardar a chave junto do backup, `npm run secrets:encrypt -- --check` ([SECURITY](SECURITY.md)) |
| P3 | Expurgar auditoria antiga com segredo | linhas anteriores a 58290e7/73546a3 podem conter segredo de MFA/credencial de dispositivo | acesso ao banco | [SECURITY](SECURITY.md#ações-operacionais-pendentes-produção--sem-acesso-daqui) item 3 |
| P4 ✅ | ~~`docker-compose.yml` só para desenvolvimento~~ **corrigido em 2026-10-06** (senhas obrigatórias por variável, portas só em 127.0.0.1; **não validado com Docker**); continua sendo stack de desenvolvimento/homologação, não de produção | senhas de exemplo versionadas e 5432/6379 expostos com `NODE_ENV=production` | — | exigir as senhas por variável (`${VAR:?}`) e não publicar as portas; não foi feito porque não há Docker nesta máquina para validar |
| P5 | Provedores reais | PIX/TEF, fiscal (SEFAZ/certificado), SMS/e-mail de MFA e de cobrança, WhatsApp oficial não existem; o sistema opera no modo manual honesto | contrato com provedor | registrar adaptador (`registerPaymentProvider`, adaptador fiscal, `services/channels` para cobrança) seguindo os testes com provedor falso |
| P6 ✅ | ~~Build do Admin Web valida tipos e lint~~ **corrigido em 2026-10-06** (os 8 erros de lint foram corrigidos, o build valida e um `next build` real passou) | `next.config.js` ignora os dois no `next build` | — | desligar `ignoreBuildErrors`/`ignoreDuringBuilds` (o `tsc --noEmit` já está limpo) |

## Dependências externas / limitações deste ambiente

- **Android/Android TV em aparelho:** sem SDK/emulador aqui; mobile e TV verificados só por `tsc` e leitura de código.
- **Impressora térmica e leitor de código de barras** do PDV: não validados em hardware.
- **Provedor de pagamento real:** o fluxo externo é provado com terminal falso só nos testes.
- **CI no GitHub:** o arquivo foi corrigido (`DATA_ENCRYPTION_KEY` gerada a cada execução) mas não houve execução real no
  GitHub a partir daqui.

## Próximos passos de engenharia (não bloqueiam)

| Área | Item |
|---|---|
| PDV | Venda offline (exige decisão de estoque/numeração/caixa sem servidor — hoje nada é enfileirado, de propósito); roteiros antigos `walk-pix`/`walk-cedulas` procuram textos antigos (cobertos pelo roteiro novo) |
| Mobile | Agenda com `from` e paginação; propor/remarcar na `AgendaScreen` com duração/mecânico e grade de horários (hoje só concluir com autorização e ver duração/mecânico); OS com paginação; URL HTTPS no build |
| Convênios | Estilo de impressão do espelho (hoje sai com menu e cabeçalho); vínculo do funcionário com o usuário na tela (só na API) |
| Orçamentos | Rotina de expiração grava evento EXPIRED mas não linha em `audit_logs` |
| TV | Sair e "manter tela acesa" (`expo-keep-awake`); filtrar "em andamento" no servidor; papel `DISPLAY` (decisão) |
| Mobile/TV | Marca CÓRTEX (hoje "LN System"), junto com `design-identity.test.ts` e VISUAL_REFERENCES |
| Estoque | Saldo materializado (tabela de saldo atualizada na mesma transação do movimento) quando o volume por produto crescer: hoje a leitura agrega o livro no banco (34 ms com 20 mil movimentos) |
| Cadastros | Coerência pessoa física/jurídica × CPF/CNPJ (o dígito e a unicidade por dígitos já valem desde 2026-09-27) |
| Listas | Empresas e ativações pendentes do Super Admin sem paginação no servidor; transferências e inventários sem paginação |
| Relatórios | Geração no servidor (a tela diz que não existe) — depende da decisão de quais relatórios |
| Segredos | Rotação da `DATA_ENCRYPTION_KEY` (decifrar com a antiga, cifrar com a nova) |
| Resiliência | Auditoria durante queda longa do Redis fica em memória (perde-se se o processo morrer): gravar direto no banco como plano B |
| Testes | E2E de navegador existe só para a Central de Ajuda e Suporte (`apps/e2e`). Falta portar as demais jornadas (PDV completo, oficina, caixa, convênios, MFA do PDV: hoje são scripts da rodada + evidências) e rodar no CI, o que exige subir API, Admin Web, Super Admin e PDV web com banco de teste no pipeline |
| Ambiente de homologação | `next dev` do Admin Web chegou a ~1 GB de RAM (o `next start` do build ficou em ~90 MB: usar `NEXT_BUILD_CPUS=2 next build` + `next start`). Os 503 `P1001` do painel (14:08, 18:00) são rajada de conexões com o pool frio, causa confirmada e ajustada só na HML (decisão 57); o `P1017` de 16:40 segue sem causa. Ver [DIAGNOSTICO_FASE6](DIAGNOSTICO_FASE6.md) |
| Observabilidade | ~~Agrupamento por dia em UTC~~ **corrigido em 2026-10-04** (decisão 58, ver [DIAGNOSTICO_FASE6](DIAGNOSTICO_FASE6.md#fechamento-da-homologação-visual-2026-10-04)). Em aberto: os gráficos de monitoramento da filial usam `date_bin` com origem UTC (faixas de 6 h começam em 21h/03h/09h/15h de Brasília) |
| Pool de conexões | Causa do `P1001`/`P2028` **comprovada** (Postgres no Windows cria conexões em série; painel abre 15–20 de uma vez; o pool encolhe parado): aquecer o pool, ajustar `connect_timeout`/`connection_limit` ou reduzir o paralelismo do painel é a decisão 57, ainda do dono; medir em Linux |
| Dashboard gerencial — próximos | Implementado em 2026-10-05 ([DASHBOARD_GERENCIAL](DASHBOARD_GERENCIAL.md)). Falta decidir 70–73, 75, 77–80 (ranking por pessoa, margem, devolução parcial, valor de cancelada, fluxo de caixa, convênio, nome "Saque/Retirada", giro, índices) e medir com volume em ambiente próprio (RLS de `payments`, `cash_movements`) antes de qualquer índice. |
| Canais de venda — ativação | **Ver a [Sequência oficial](#sequência-oficial-de-evolução) (Fases 1 a 3).** Hoje 🧱 base pronta ([CANAIS](CANAIS.md)); sem integração real, sem conversão de pedido em venda, sem reserva de estoque, sem rota de webhook, sem comissão de venda externa. Cada provedor entra só depois de decididas as regras (82–92) e de homologado. |
| Dashboard gerencial (varredura) | **Histórico:** varredura de 2026-10-04 ([DASHBOARD_GERENCIAL_VARREDURA](DASHBOARD_GERENCIAL_VARREDURA.md)): 87 indicadores e 22 decisões (60–81). **Implementada em 2026-10-05** com as decisões 60–69, 74, 76 e 81 aplicadas; restam 70–73, 75, 77–80 |
| Dashboard antigo (SUPER_ADMIN, MECHANIC, OPERATOR, VIEWER) | Esses perfis seguem no painel antigo (`/ceo`, `/workshop`, `/pdv`); a janela de 30 dias dele é calculada no navegador, fora da regra única de período. Sem fase atribuída (ver [Sequência oficial](#sequência-oficial-de-evolução)) |
| Gráficos — dados | **Painel gerencial:** dia sem venda é **zero** e ticket sem venda interrompe a linha (decisão 74). **Demais gráficos** (monitoramento, observabilidade, painel antigo): sem dado interrompe a linha (decisão 59); telemetria ausente nunca vira zero |
| Gráficos | Homologação visual de 2026-10-04 (67 + novas capturas, RESULTADO (evidência arquivada fora do repositório publicado: `docs/evidencias/2026-10-04-homologacao-graficos/RESULTADO.md`), FECHAMENTO (evidência arquivada fora do repositório publicado: `docs/evidencias/2026-10-04-homologacao-graficos/FECHAMENTO.md`)) e do Dashboard gerencial em 2026-10-05 (RESULTADO (evidência arquivada fora do repositório publicado: `docs/evidencias/2026-10-05-dashboard-gerencial/RESULTADO.md`), HOMOLOGACAO_FINAL (evidência arquivada fora do repositório publicado: `docs/evidencias/2026-10-05-dashboard-gerencial/HOMOLOGACAO_FINAL.md`)). **Composição do painel frente à referência aprovada: PENDENTE DE AVALIAÇÃO DO USUÁRIO.** Figma não disponível para conferência (sem link oficial). Opcional: dar ao #10 (status HTTP) o mesmo desenho de grade e dica |
| Módulos | Travas ao desligar módulo com pendências (decisão) |
| Suporte | SLA e prazos; aviso por e-mail/WhatsApp (hoje só dentro do sistema); avaliação do atendimento; atribuição/escalonamento automáticos |
| Suporte | Tela "Configurações" do Console (sem endpoint no backend) e gestão de responsáveis (hoje somente leitura; a atribuição é feita no chamado) |
| Suporte | "Terminal" do chamado do PDV é o número do caixa; trocar pelo identificador do terminal quando houver provedor TEF real; detector de senha/token no texto (hoje só orientação, só cartão é recusado) |

## Registro

O histórico de itens abertos e fechados rodada a rodada está no
[registro de auditoria](historico/registro-de-auditoria-2026-09-14-a-25.md) (até 2026-09-25) e no [CHANGELOG](CHANGELOG.md).
