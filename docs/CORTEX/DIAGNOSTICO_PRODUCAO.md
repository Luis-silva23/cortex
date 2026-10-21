# Diagnóstico de prontidão para produção — Fase 4 (2026-10-06)

> Avaliação independente do estado técnico do CÓRTEX **depois** de uma auditoria sistemática com correções e provas. Não é "os testes passam": cada afirmação abaixo diz se foi **provada** (teste real contra PostgreSQL e Redis), **lida no código**, ou **não verificável aqui**. Complementa o runbook [PRODUCAO](PRODUCAO.md).
> **Restrição respeitada:** nenhum teste de carga, estresse, saturação, flood, força bruta ou processo em massa foi executado neste computador corporativo; o que exigiria isso está marcado **a validar em staging**.

## 0. Fechamento final (2026-10-06)

Rodada de fechamento depois da Fase 4: **autorização de dispositivos, conexão dos aplicativos e HTTPS**. Resultado: **🟡 TECNICAMENTE PRONTO, INFRAESTRUTURA PENDENTE** — o veredito da §1 continua valendo, agora com mais uma barreira de segurança fechada e provada.

| Ponto | Classe | Evidência / o que falta |
|---|---|---|
| Autorização de equipamento no login | **🔴 problema real → corrigido** | Antes: `deviceId` opcional; equipamento desconhecido ou pendente **entrava** sem sessão de equipamento; revogar não derrubava sessão nem renovação. Agora: portão `assertLoginDevice` (empresa + ATIVO + chave + filial), sessão presa ao token (`dsid`), revogação imediata. `device-authorization.integration` (32) |
| Entrada de equipamento novo (enroll → pendente → autoriza → login) | **⚪ inexistente → implementado** | rotas públicas sem dado de negócio, chave só em hash, fila do administrador, autorização auditada. Provado em integração |
| DeviceSession (uma por equipamento e por usuário, empresa/filial, revogação, logout, encerramento administrativo, isolamento) | ✅ pronto (já existia) + reforçado | índices únicos parciais mantidos; teste de DEVICE_BUSY/USER_ALREADY_ACTIVE; isolamento empresa/filial/equipamento |
| Isolamento (equipamento A×B, filial 1×2, usuário A×B, revogado, não autorizado) | ✅ provado | `device-authorization.integration`; RLS FORCE em `devices` e `db:check-rls` OK |
| HTTPS no servidor (426 em HTTP, `TRUST_PROXY` obrigatório, HSTS no proxy) | **🟡 código pronto e testado; homologação real pendente** | `https.test`, `env.test`. Certificado, 80→443 e 426 reais exigem domínio e proxy (**🔵 infraestrutura**) |
| HTTPS nos clientes (PDV recusa http em produção; mobile/TV falham na partida; nenhum ignora erro de certificado) | ✅ no código / 🟡 sem aparelho | `device-enrollment.test` do PDV; mobile/TV só por `tsc` |
| "APK Balcão" | **⚪ não existe APK** | o **Balcão é aplicativo web próprio** (`apps/balcao`, 2026-10-13: atendimento, sem caixa); o PDV desktop (frente de caixa) tem o portão; empacotamento = decisões 112/116 ([APLICATIVOS](APLICATIVOS.md)) |
| Portão de equipamento no mobile/TV | 🟡 pendente | só política + HTTPS (decisão 111) |
| Domínio oficial do servidor | **🔵 dependência externa** | o endereço é fixado na instalação; nenhum foi inventado |
| Backup contínuo, retenção, restauração testada, alertas | **🟡 homologação de infraestrutura pendente** | existe o backup semanal da API e o `backup:verify` (18/18 em 2026-09-26); contínuo/PITR/cópia externa/alerta não existem aqui |
| Staging equivalente à produção (Linux, HTTPS, Docker, SIGTERM real) | **🟡 preparado, não executado** | `docker-compose.staging.yml` + `deploy/Caddyfile` + `scripts/smoke-device-flow.js` — **PENDENTE: executar somente em staging/infraestrutura adequada** |
| Carga, estresse, força bruta, 60 RPS, `load.js`, `sampler.js` | **não executado (proibido neste computador)** | **PENDENTE — EXECUTAR SOMENTE EM STAGING/INFRAESTRUTURA ADEQUADA** |
| Canais/integrações (iFood, marketplace, site, provedores) | 🔵 + 🟣 | só gateway e provedor **simulado**; nada em produção; decisões 87 e 103–108 seguem abertas e **não** bloqueiam o núcleo |
| Perfis que exigem equipamento; corte dos legados | 🟣 decisão | 109 e 110 (política vazia por padrão: comportamento anterior preservado) |
| Caixa só por equipamento autorizado (`devices.requiredUserTypes`) | **PARCIAL — mecanismo VALIDADO, configuração vazia** | movido do login para a **operação de caixa** (o Admin Web usa o mesmo perfil); testado nos dois estados e por empresa; **lista vazia = caixa operável sem equipamento** até ligar por empresa (🟣 109) |
| Legado de equipamento por id/MAC | **VALIDADO (transição com prazo)** | conjunto fechado (antes de 2026-10-07) + corte em 31/12/2026 (`DEVICE_LEGACY_CUTOFF`); só no login; não burla a DeviceSession; evento `DEVICE_LEGACY_LOGIN`; data a confirmar (🟣 110) |
| Parcelamento em centavos | **CONCLUÍDO e VALIDADO** | função única (API+PDV), 100,00 em 3x = 33,33 + 33,33 + 33,34, varredura de 20.000 valores, integração com banco; cronograma do cartão **não** persistido (🟣 114) |
| Fiscal: IBS, CBS, Split Payment | **PENDENTE — BLOQUEADO POR DEPENDÊNCIA** (regulamentação, provedor) | nada implementado nem inventado; separação Venda/Parcelas/Liquidação/Fiscal **protegida por teste** (🟣 113) |
| HTTPS real, staging, backup contínuo, restauração em staging | **BLOQUEADO POR DEPENDÊNCIA** (domínio, certificado, Docker/Linux) | cadeia TLS local provada; `backup:verify` 18/18 em dev; compose de staging cobre API+painéis (não executado) |
| Aplicativos: PDV × Balcão × APK | **VALIDADO** | PDV = `pdv-desktop` (caixa); **Balcão = `apps/balcao` (atendimento, aplicativo próprio)**; Web/Admin = administração; sem APK ([APLICATIVOS](APLICATIVOS.md)) |

**Números reais desta rodada** (nenhum teste de carga): ver [CHANGELOG](CHANGELOG.md#fechamento-final--autorização-de-dispositivos-https-e-conexão-automática-2026-10-06) e a tabela da §4, atualizada.

## 1. Veredito

### 🟡 TECNICAMENTE PREPARADO, MAS DEPENDENTE DE INFRAESTRUTURA

**O CÓRTEX está pronto para produção? Ainda não.** Não conheço nenhum defeito técnico no código que eu possa corrigir aqui e que impeça colocá-lo no ar: as duas vulnerabilidades reais encontradas (credencial de dispositivo aceita como sessão; login que revelava quais usuários existem) foram corrigidas e provadas, a autenticação cobre todas as 389 rotas, o isolamento por empresa/filial (RLS FORCE em 102 tabelas) está íntegro, e dinheiro, estoque, vendas, pagamentos e auditoria têm o PostgreSQL como única fonte da verdade. **Mas "pronto" exige o que não existe neste ambiente:** infraestrutura de produção (domínio, HTTPS, banco e Redis gerenciados, cofre de segredos, Git remoto com CI executado), **backup contínuo com uma restauração testada**, e as validações que só um ambiente de homologação permite (carga e pool de conexões em Linux, SIGTERM real com tráfego, rolagem sem indisponibilidade, build das imagens Docker). Sem isso o risco que sobra é **operacional** (perder dado por falta de backup contínuo, indisponibilidade por pool de conexões nunca medido), não de lógica de negócio.

## 2. O que foi auditado

Segurança (autenticação, autorização, JWT, refresh, MFA, bloqueio, RLS, CORS, headers, segredos, logs, endpoints públicos, Commerce API, webhook), banco (migrações, constraints, índices, transações, concorrência), estoque e reservas, vendas e financeiro, Redis e BullMQ, jobs, Integration Gateway, observabilidade, saúde e prontidão, desligamento, configuração, deploy/migrações, backup, CI/CD e as telas críticas. Método: leitura do código e da configuração, varredura de rotas e de segredos no repositório, execução dos testes e **testes novos que falhavam antes da correção** (regressão).

## 3. Correções realizadas

| Área | Problema (impacto) | Correção | Teste |
|---|---|---|---|
| **Autenticação** | A **credencial do dispositivo do PDV** (JWT de 10 anos, mesma chave, com `companyId`, sem usuário) era aceita por `verifyAccessToken` e abria as rotas da empresa (`200` em `/api/products`): quem tivesse extraído a credencial de um PDV lia dados da empresa. **Alto.** | `verifyAccessToken` exige `userId` e `userType`, recusa `deviceId`/`licenseId` e fixa HS256 (também no MFA pendente) | `token-confusion.integration` (7): falhava antes, passa |
| **Autenticação** | **Enumeração de usuários no login:** conta desativada/bloqueada era dita **antes** da senha e e-mail inexistente respondia na hora (resposta e tempo) | senha conferida primeiro, custo equalizado para inexistente, estado da conta só a quem acertou a senha | `login-enumeration.integration` (5) |
| **Autorização** | Não havia prova de que toda rota exige login | teste percorre as 389 rotas reais; só 8 públicas, com motivo escrito | `auth-coverage.integration` (2) |
| **Auditoria / Redis** | Com o Redis fora, `queue.add` ficava pendurado e a auditoria só existia na memória do processo | prazo de 1,5 s e gravação direta no PostgreSQL com o mesmo id (idempotente) | `audit.durable.test` (5), `audit-durable.integration` (3) |
| **Desligamento** | Dois handlers de SIGTERM disputando; o de `queue.ts` dava `exit(0)` e **matava requisições em andamento**; workers e Redis nunca drenados; sem estado "drenando" | orquestrador único: drena HTTP, fecha workers/filas/Redis/PostgreSQL em ordem, prazos e idempotência | `shutdown.test` (4, servidor HTTP real) |
| **Saúde** | Sondas sem prazo no banco, `ready` devolvia a mensagem do erro (host/usuário), não via workers nem desligamento | prazo 2 s, só o nome da dependência, workers, `draining` | `health.routes.test` (6) |
| **Configuração** | Sem validação (só JWT e chave de cifra); `TRUST_PROXY` inexistente (limite/bloqueio por IP veria só o balanceador); `ENABLE_SCHEDULER`/`ENABLE_AUTO_BACKUP` ignorados | `config/env.ts` (falha fechada em produção, sem valor de segredo no relatório), `TRUST_PROXY` validado (`true` recusado), flags honradas | `env.test` (9) |
| **Observabilidade** | Log de acesso sem requisição/empresa/filial/usuário e com query string | `requestId`, `companyId`, `branchId`, `userId`; sem query | lido; coberto indiretamente |
| **Infra** | `docker-compose.yml` com senha de exemplo versionada e portas abertas | senhas obrigatórias por variável, portas só em loopback, `stop_grace_period` | **não validado** (sem Docker) |
| **CI** | Passo de migração sem `DATABASE_URL` (falharia); Admin Web sem testes; sem `db:check-rls` e sem links | corrigido | **não executado** (sem remoto) |
| **Front** | `next build` ignorava tipos e lint (8 erros de lint ocultos); sem cabeçalhos de segurança | erros corrigidos, build valida (`next build` real passou), cabeçalhos básicos | build real; 548 testes |

## 4. Testes finais (números reais desta execução)

| Verificação | Resultado |
|---|---|
| API — unitários | **1098/1098** (110 suítes) |
| API — integração (PostgreSQL e Redis reais, sequencial) | **1457 testes / 96 suítes** em duas execuções completas: cada uma teve **1 suíte com falha intermitente** fora do código alterado (`support` na 1ª, 14 testes; `agenda-capacity` na 2ª, 1 teste de corrida), e ambas passam 3× isoladas (50/50) — **não considero a suíte "100% verde numa só execução"** |
| Admin Web (jest) | **548/548** (32 suítes) |
| TypeScript (`tsc --noEmit`) | limpo em `api`, `admin-web`, `super-admin`, `database`, `shared` |
| Lint | API 0 erros (9 avisos antigos); Admin Web 0 erros (avisos); Super Admin 0 erros |
| RLS (`db:check-rls`, banco de desenvolvimento, depois da migração de dispositivos) | todas as invariantes OK — 102 tabelas `FORCE`, 116 policies |
| PDV (lógica) | 25/25 (`npm run test:logic`, inclui o portão de dispositivo e a regra de HTTPS); `tsc` limpo no PDV, Super Admin, mobile e TV |
| Build | API (`tsc`) e Admin Web (`next build` com validação ligada) **OK** |
| Documentação | 402+ links relativos conferidos, 0 quebrados |

## 5. Segurança — situação

| Tema | Situação |
|---|---|
| Isolamento empresa/filial | **provado** (RLS FORCE + suítes de matriz por empresa/filial, 102 tabelas); única consulta sem RLS nas superfícies públicas: credencial/canal por id exato |
| Autenticação | JWT HS256 fixado, refresh com rotação e detecção de reuso, MFA, bloqueio por tentativas (provados por suítes existentes) + as correções acima |
| Autorização | 389 rotas exigem token; papéis por rota (matriz RBAC testada) |
| Segredos | nenhum segredo versionado (varredura); cifrados em repouso (`enc:v1`); validação de partida; senha de exemplo recusada em produção |
| Rate limiting | por IP, usuário, credencial e canal; **depende de `TRUST_PROXY` correto em produção** |
| Webhook / Commerce API | HMAC, janela de 300 s, mesmo 401, idempotência, esquema fechado, empresa/filial do canal (provado) |
| Idempotência financeira | provada: duplicata de webhook/evento/conversão não gera segunda venda, cobrança, caixa nem estoque |
| Auditoria | durável e idempotente; sem segredo (redação testada) |

## 6. Produção — o que fazer e o que falta

**Pode ser feito agora (já pronto):** subir a API com configuração validada; rodar migrações com `migrate deploy` + `db:check-rls`; usar as sondas `live`/`ready`; desligar com drenagem; operar PDV, oficina, estoque, caixa, convênios, dashboard e canais **no modo manual honesto** (sem pagamento/fiscal/mensagem de provedor real).

**Depende de infraestrutura (não existe aqui):** domínio e HTTPS; PostgreSQL 18 e Redis gerenciados; cofre de segredos; Git remoto e CI executado; balanceador com `TRUST_PROXY`; backup contínuo, retenção e restauração periódica; coleta de logs e alertas; build/execução das imagens Docker; **staging** para carga, failover, SIGTERM real e rolagem.

**Depende de decisão de negócio:** 82–92 e 95–105 (canais, reserva, conversão, estorno, comissão, fiscal, sincronização, limites); 106 (RPO/RTO/retenção); 107 (janela de sessão revogada com Redis fora); 108 (token em `localStorage` e CSP); 93 (LGPD); 57 (pool de conexões); 47 (valor de `TRUST_PROXY`).

**Bloqueadores reais:** apenas os P0 de infraestrutura abaixo. **Nenhum bloqueador técnico de código conhecido.**

## 7. Pendências

| Nível | Item |
|---|---|
| **P0** (bloqueia produção) | Infraestrutura de produção (domínio, HTTPS, banco/Redis gerenciados, cofre, Git remoto + CI executado); migrar e conferir RLS no banco real; **backup contínuo com RPO/RTO acordados e uma restauração testada** (decisão 106); expurgar a auditoria antiga que contém segredo (SECURITY, ação 3) |
| **P1** (antes ou logo após o go-live) | Teste de carga/concorrência e pool de conexões em Linux (decisão 57); SIGTERM real e rolagem em staging; build/execução das imagens Docker; alertas no coletor de logs; definir `TRUST_PROXY` com a topologia (47); decidir 107 e 108 (token no navegador/CSP); reexecutar `backup:verify` no ambiente real; triar `npm audit` |
| **P2** (evolução) | Rotação da `DATA_ENCRYPTION_KEY`; saldo materializado de estoque; CSP com nonce e cookie `HttpOnly`; paginação das listas sem paginação; E2E de navegador das demais jornadas; APM |
| **P3** (melhoria) | 9 avisos de lint antigos na API; registro de jobs recorrentes que recria tudo a cada partida (hoje inofensivo); unificar os dois loggers |

## 8. Decisões abertas

| # | Estado | Bloqueia produção? |
|---|---|---|
| **87** Cancelamento/devolução de pedido externo | **aberta**; a venda de canal cancela/devolve pelo fluxo do balcão sem estorno ao canal (manual) | **Não** o núcleo (PDV/Admin); **sim** para ligar qualquer canal externo real |
| **103** Sincronização automática de estoque/preço/catálogo | **aberta**; hoje só sob demanda | Não |
| **104** Cancelamento pelo provedor depois de virar venda; preço divergente | **aberta**; hoje vira revisão manual / recusa do pedido inteiro | Não (só canais reais) |
| **105** Limites operacionais do gateway | **aberta**; padrões técnicos sem medição com provedor real | Não (medir na homologação do 1º provedor) |
| **47** `trust proxy` | **mecanismo pronto** (`TRUST_PROXY`); falta só o valor da topologia | Sim, **como configuração** (P1), não como código |
| **106 a 108** | novas (RPO/RTO/retenção; sessão revogada com Redis fora; token no navegador/CSP) | 106 sim (P0); 107 e 108 não |

Nenhuma decisão foi convertida em regra comercial; as que puderam virar configuração técnica (`TRUST_PROXY`, `ENABLE_*`, `CHANNEL_SANDBOX_PROVIDER`) viraram.

## 9. Riscos residuais conhecidos (aceitos ou a validar)

1. **Backup:** o da API é semanal; sem backup contínuo, o RPO real hoje é de dias (P0).
2. **Pool de conexões/carga:** nunca medido em Linux; no Windows de homologação houve 503 `P1001` em rajada com o pool frio (decisão 57). Não executei carga aqui.
3. **Redis fora:** a API continua e a auditoria é preservada, mas a **revogação de sessão não é checada** por até 15 min (107) e os limites de tentativa passam a valer por instância.
4. **Token em `localStorage` e sem CSP** nos dois fronts: um XSS roubaria a sessão (108); não há `dangerouslySetInnerHTML` com dado do usuário (só o script de tema do layout).
5. **Docker, CI e SIGTERM real nunca executados** (sem daemon, sem remoto, Windows).
6. **Provedores reais** (PIX/TEF, fiscal, mensagens, canais) não existem: o sistema opera no modo manual.
