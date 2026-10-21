# Relatório mestre — plano de finalização por fases (2026-10-04)

> **Documento histórico — estado de 2026-10-04.** O estado atual (2026-10-05) está em [MAPA_DE_ESTADO](MAPA_DE_ESTADO.md) e [CURRENT_STATE](CURRENT_STATE.md). Desde este relatório: o Dashboard gerencial foi implementado e homologado; a **base** de canais de venda foi criada (módulo `CANAIS`, desligado por padrão, **sem nenhuma integração real**; a frase "canais externos: inexistentes" abaixo era verdadeira em 2026-10-04 e **não é mais**); a política `commission.enabled` existe; o banco passou de 91 para 95 modelos e de 25 para 26 migrações; a decisão 54 ficou parcialmente respondida (ver [DECISIONS](DECISIONS.md)). Os números de teste abaixo (943/1239/495…) são os daquela data. O texto original foi mantido como estava.

Consolida as Fases 1 a 11 do plano. A Fase 12 (carga/stress) **não foi executada, de propósito**: este computador é corporativo e `apps/hml/LOAD_DISABLED` trava `load.js` e `sampler.js`.
Nenhuma funcionalidade nova foi construída e nenhuma regra de negócio, RLS, RBAC, MFA, sessão ou limite foi alterada.

## 1. Resultado por fase

| Fase | Resultado |
|---|---|
| **1 — HML** | Causa do incidente das janelas: `sampler.js` com `for (;;)` e ~5 processos de console por ciclo sem `windowsHide`; `load.js` só o encerrava no sucesso. Corrigido: `apps/hml/lib/proc.js` (processos ocultos, com prazo, orçamento e limpeza na saída/sinais), amostrador com duração máxima, pai vivo e canal IPC, trava `LOAD_DISABLED` + `HML_ALLOW_LOAD`, guarda `hml-tooling.guard.test.ts` (6/6, executado na Fase 5). Commit 7a1bc29 |
| **2 — Estado** | [MAPA_DE_ESTADO](MAPA_DE_ESTADO.md): 8 apps, 79 rotas, 126 serviços, 91 modelos, 25 migrações; tudo ✅ exceto agentes (não existem no repositório), canais externos (nada), produção e provedores (🟣), mobile/TV/hardware (⚪) |
| **3 — Decisões** | 3 decisões tomadas registradas (login simultâneo, sem carga em máquina corporativa, processos HML) e pendentes 47–56 em [DECISIONS](DECISIONS.md); tabelas dos contratos de auditoria corrigidas (a falta de `auditLog` já estava resolvida no código); erro do próprio mapa da Fase 2 corrigido |
| **4 — Agentes** | Só levantamento ([AGENTES](AGENTES.md)): nenhum agente no repositório; agentes são ferramentas externas (Claude Code/ECC) e não fazem parte do CÓRTEX; nada criado |
| **5 — Testes** | API unitários 939/939 e integração 1239/1239 (depois reexecutados, ver Fase 10), `tsc` API e Admin Web limpos, Admin Web 495/495, HML `rls.js` 26/26 e `invariants.js` 45/45. Falha: a 1ª execução do `rls.js` quebrou porque o Postgres aceitou conexão antes de estar pronto (passou na 2ª) |
| **6 — Visual e Postgres** | Evidências: Admin (a01–a13), Super Admin (s01–s07), PDV (p01–p08) e erro/bloqueio de login (e01–e03). Falha do Postgres HML por instantes em duas execuções com navegador (14:08 e 16:40); investigação isolada **não reproduziu** (13,5 min sem navegador + 2 min com Next e Chrome em carga leve); defeito de código achado no login e corrigido. [DIAGNOSTICO_FASE6](DIAGNOSTICO_FASE6.md) |
| **7 — Segurança** | Sem vulnerabilidade explorável nova; pontos de defesa em profundidade e limites viraram decisões 47–52 e 55; limite de 100 req/min **não foi aumentado**; ver [SECURITY](SECURITY.md#revisão-de-segurança-e-multi-tenant--2026-10-04-homologação) |
| **8 — Produto** | [AUDITORIA_PRODUTO](AUDITORIA_PRODUTO.md): canais externos não existem (decisão 54); fiscal real, TEF/PIX e produção são P1; LGPD, relatórios e demais P2/decisão |
| **9 — Integrações controladas** | **Não executada, por falta de objeto:** não há provedor, credencial nem canal a integrar sem a decisão 54; os adaptadores falsos já existem só nos testes de integração |
| **10 — Regressão** | API unitários **943/943 (96 suítes)**, integração **1239/1239 (85 suítes, 463 s)**, `tsc` da API limpo, Admin Web 495/495 e `tsc` limpo (rodados antes das últimas edições, que não tocaram o Admin Web) |
| **11 — Consolidação** | CURRENT_STATE, FINAL_ACCEPTANCE, ROADMAP, README, CODE_MAP, CHANGELOG e SECURITY atualizados; 230 links conferidos, 0 quebrados; commits por assunto |
| **12 — Stress** | Fora do plano, de propósito |

## 2. Corrigido

- Login simultâneo colidindo no token de refresh (500) — commit 80dec4e.
- Erro cru do Prisma com caminho do disco chegando à resposta; transação expirada virando 400 — 80dec4e.
- Logins corretos simultâneos bloqueando o IP por 60 min (dois baldes: falhas × reservas) — 80dec4e, decisão do dono.
- Estoque −1 na última unidade da OS; token de usuário excluído vivo por 15 min — rodada anterior.
- Processos filhos do HML: janelas de CMD/PowerShell, amostrador em laço infinito, trava de carga — 7a1bc29.
- Erro de banco no login tratado como credencial inválida (e `LOGIN_FAILED` falso): 503 + `Retry-After` — 5404c04, com teste (3 de 4 falham no código antigo).
- Testes de login isolados do limitador; teste do refresh redimensionado; eixo dos gráficos do painel legível — 37aad75.
- Documentação: contratos de auditoria, números de teste, 25 migrações, índice do README, CODE_MAP.

## 3. Ainda errado ou aberto

| Item | Causa conhecida ou hipótese | Impacto | Prioridade | Depende de |
|---|---|---|---|---|
| Postgres HML some por instantes com o navegador rodando (14:08, 16:40) | **Hipótese não provada:** falta de recursos do Windows (17–23 `conhost`, Next dev ~1 GB, hooks). Não reproduzido isolado. WAL mostra `CHECKPOINT_SHUTDOWN` sem comando meu | Só homologação; produção não afetada pelo que se viu | Média | Repetir com o log do Postgres ligado; log de eventos do Windows |
| Next dev do Admin Web ~1 GB de RAM | Cache do compilador em modo desenvolvimento | Pesa na máquina corporativa | Média | `next build`+`start` ou limite de memória (768 MB funcionou nas 3 capturas) |
| `infra.js start` e `rls.js` não esperam o Postgres aceitar consultas | `waitPort` só testa a porta | Falso erro confuso nos scripts HML | Baixa | nada |
| Capturas a01–a06 da 1ª execução (14:07) foram substituídas e não existem mais | Harness sobrescrevia; já corrigido (sufixo de execução) | Perda de evidência equivalente | Baixa | nada |
| `a02-ceo-dashboard.png` capturado com cartões ainda carregando | Espera curta frente a chamadas de 2–3,7 s | Evidência menos clara | Baixa | nada |
| Botão "Importar Excel" visível ao Visualizador (API nega) | Gate de tela incompleto | UX | Baixa | nada |
| PDV abre a tela para Mecânico e Visualizador (API nega a venda) | Login do PDV não filtra tipo de usuário | UX/segurança leve | Média | decisão 53 |
| 5ª falha de login sem aviso; 6ª bloqueia 60 min, inclusive a senha certa | Desenho do limitador por IP | Loja em NAT inteira bloqueada | Alta | decisões 47, 48, 49, 56 |
| Sem `trust proxy` | Não configurado | Atrás de proxy, um balde para todos | Alta (antes de produção) | decisão 47 e topologia |
| `refresh_tokens` com JWT cru e `companyId` nulo; `request_logs`/`system_logs` com `WITH CHECK (true)` | Desenho pré-existente | Defesa em profundidade (hoje só um defeito de código expõe) | Média | decisões 51, 55 |
| Revogação de token libera com Redis fora | Falha aberta por disponibilidade | Até 15 min | Média | decisão 52 |
| 429 com navegação rápida (100 req/min × 5–17 chamadas por tela; `StrictMode` dobra em dev) | Chamadas por tela; Orçamentos faz 5 chamadas só de contagem | UX em uso intenso | Média | decisão 50 |
| Docs: `FINAL_ACCEPTANCE` e demais contêm números de rodadas anteriores para PDV, mobile/TV, e2e, backup | Não reexecutados | Confiança | Baixa | reexecutar |
| Produção: migrações, segredos, expurgo de auditoria, `docker-compose`, fiscal e TEF reais | ROADMAP P1–P6 | Bloqueia go-live | **P1** | ambiente, contratos, decisões |
| Mobile e TV nunca em aparelho; impressora/leitor sem hardware | sem SDK/hardware | Risco no campo | P2 | hardware |

## 4. Decisões que precisam de nós

Pendentes novas desta rodada (47–56): `trust proxy`; chave do bloqueio de login (IP × NAT); desbloqueio administrativo e alerta; limite de 100 req/min; `refresh_tokens` e `companyId` nulo; revogação com Redis fora;
login do PDV por tipo; **canais externos de venda**; RLS de `request_logs`/`system_logs`; aviso antes do bloqueio de login. Mais as 43 anteriores (fiscal, agenda, orçamento, convênios, garantia, caixa, mecânico…).
Sugestão de ordem: 47, 48 e 51 (afetam produção) → 54 (define o rumo do produto) → fiscal/TEF.

## 5. Funcionalidades novas identificadas (nada construído)

Canais externos (site, e-commerce, iFood, marketplaces, API pública/Commerce, webhooks, reserva de estoque, catálogo público, credenciais por canal): **inexistentes**, dependem da decisão 54; camada recomendada em
[AUDITORIA_PRODUTO](AUDITORIA_PRODUTO.md). Também: LGPD (consentimento/exportação/exclusão), relatórios no servidor, endpoint de resumo para os cartões de Orçamentos, notificações externas oficiais.

## 6. Inconsistências de documentação (encontradas e tratadas)

Contratos de auditoria diziam "[LACUNA]" para itens já corrigidos; ROADMAP dizia 24 migrações (são 25); CURRENT_STATE e FINAL_ACCEPTANCE com 922/1235 (agora 943/1239); FINAL_ACCEPTANCE dizia "git limpo";
README e CODE_MAP não citavam SUPPORT, HML, e2e nem os novos documentos; meu mapa da Fase 2 afirmou, errado, falta de auditoria (corrigido). Links: 230 conferidos, 0 quebrados.

## 7. Riscos

- **Segurança:** os de `trust proxy`, bloqueio por IP/NAT, refresh cru com política nula, logs com `WITH CHECK (true)`, revogação com Redis fora (seção 3).
- **Infraestrutura:** Postgres HML intermitente com navegador; Next dev ~1 GB; hooks do ECC criam muitos processos curtos (configuração do usuário, não alterada); produção sem nenhuma implantação feita.

## 8. Itens para implementar × NÃO implementar

**Implementar (A, sem decisão):** endurecer `infra.js start`/`rls.js`; ligar o log do Postgres HML por padrão; `ui-evidence.js` falhar rápido e esperar o carregamento do painel; esconder "Importar Excel" ao Visualizador; reexecutar as suítes não repetidas.
**NÃO implementar agora:** canais externos/API pública sem a decisão 54; agentes dentro do CÓRTEX; robô de cobrança; simulação fiscal ou de PSP; aumentar o limite geral como solução de 429; carga/stress neste computador.

## 9. CORREÇÕES NECESSÁRIAS

**A. Pode corrigir sem decisão** — (1) `infra.js start` esperar o Postgres aceitar consulta e `rls.js` distinguir banco indisponível de "sem tabelas"; (2) subir o Postgres HML com log por padrão; (3) `ui-evidence.js`: falhar na hora com erro de login e esperar os cartões do painel; (4) esconder "Importar Excel" para Visualizador; (5) reexecutar PDV, `tsc` de Super Admin/PDV/mobile/TV, smoke do Electron, RLS em dev, e2e e `backup:verify` para atualizar os números dos documentos; (6) capturar as telas com `next start` (menos memória) se for repetir a homologação visual.

**B. Precisa da nossa decisão** — 47 a 56 e as 43 anteriores; em especial `trust proxy`, bloqueio por IP, tokens de refresh, canais externos, fiscal e TEF.

**C. Futuro/backlog** — canais externos (após 54); endpoint de resumo de contagens; LGPD; relatórios no servidor; paginação no servidor; testes em aparelho (mobile/TV); marca CÓRTEX no mobile/TV; e2e das demais jornadas no CI; hash do refresh token (após 51).

**D. Não corrigir — comportamento intencional** — PDV não vende sem rede; sem provedores reais (modo manual honesto); cobrança só manual; fiscal sem simulação; 429 de 2 s para logins simultâneos acima do limite (sem bloqueio longo); bloqueio de 60 min após 5 falhas (regra definida); limite de 100 req/min mantido; carga/stress travada neste computador.

## 9.1 Atualização — rodada do grupo A e do painel (2026-10-04, depois deste relatório)

Executados os itens A1 a A5 e A6 (parcial: `next start` usado nas capturas), mais a correção visual do painel. Resultados e evidências: [CHANGELOG](CHANGELOG.md), [FRONTEND](FRONTEND.md),
[DIAGNOSTICO_FASE6](DIAGNOSTICO_FASE6.md) e [evidências](../evidencias/README.md). Pontos que mudam este relatório:

- **Causa confirmada** dos 503 `P1001` do painel: rajada de conexões com o pool frio (5 s do Prisma) com o Postgres de pé; o `P1017` de 16:40 segue aberto. Decisão nova 57 (pool) e 58 (fuso do dia).
- **Corrigido:** `infra.js` (pronto de verdade + log), `rls.js`, `ui-evidence.js`, "Importar" para o Visualizador, `payments.js`, API HML com tempos de conexão maiores, painel com linha/barras na identidade da marca e evolução da receita para Gerente e empresa de uma filial.
- **Figma:** o conector existe no ambiente (autenticado, assento de visualização), mas não há link de arquivo do CÓRTEX no projeto; os tokens seguem o quadro de marca. Pendente: informar o link.
- **Regressão reexecutada, verde:** API 943 e 1239, Admin Web 508, PDV 20, `tsc` dos seis apps, `db:check-rls`, `backup:verify` (18), HML 185/121/37/26/45. Segue **não executado**: smoke do Electron, e2e de navegador, `security`/`concurrency`/`workshop-concurrency` e `ui-profiles` (pressão ou peso).

## 9.2 Atualização — ajustes finais do painel (2026-10-04)

Evolução da receita com **Linha | Colunas** (mesma série, 0 chamada à API ao alternar); categorias seguem só em barras. **Decisão 58 aplicada:** dia de Brasília (`America/Sao_Paulo`) na evolução de vendas e do CEO, no "hoje" do PDV e
em "Hoje"/"Mês atual" do front, com teste da virada do dia. Decisão 58 **deixou de ser pendente**. O Figma segue dependente do link oficial. Detalhes: [CHANGELOG](CHANGELOG.md), [FRONTEND](FRONTEND.md), [DECISIONS](DECISIONS.md).

## 10. Git, evidências e testes

- **Commits desta rodada:** 7a1bc29 (HML), 5404c04 (login), 37aad75 (testes e eixo), 2141dd3 (HML evidência), e o commit de documentação e evidências. Sem `push`.
- **Evidências:** `docs/evidencias/2026-10-04-homologacao/` (a, s, p, e, notas e `notas-admin-execucao-fase6-interrompida.json`), `apps/hml/.hml/api.log` e `pg-hml.log` (gitignorados, não apagar), WAL do Postgres HML.
- **Executados:** guard HML 6/6; unitários 943/943; integração 1239/1239; `tsc` API e Admin Web; Admin Web 495/495; HML `rls.js` 26/26 e `invariants.js` 45/45; links 230/0; investigação do Postgres (13,5 min) e captura de erro de login (3 cenários).
- **Não executados:** `load.js`, `sampler.js`, carga/stress; suítes HML `profiles`, `profiles-extra`, `security`, `payments`, `concurrency`, `workshop-concurrency` e `ui-profiles` (verdes na rodada anterior, não repetidos); PDV lógica, `tsc` de Super Admin/PDV/mobile/TV, smoke do Electron, e2e de navegador, `backup:verify`, `db:check-rls` em dev; qualquer teste em aparelho ou hardware; Fase 9 (sem objeto) e Fase 12 (proibida).
