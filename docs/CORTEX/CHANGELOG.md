# Changelog

Rodada a rodada, do mais recente para o mais antigo. Cada correção de defeito tem teste que falha no código antigo.
Até 2026-09-25 o detalhe (achado, prova, incidente) está no
[registro de auditoria](historico/registro-de-auditoria-2026-09-14-a-25.md).

## Homologação técnica pós-Next 15.5.28 (2026-10-22)

Detalhe, evidência e limites em [HOMOLOGACAO_POS_NEXT15](HOMOLOGACAO_POS_NEXT15.md).

| O quê |
|---|
| **Segunda falha de integração no CI (`bc62640`), causa PROVADA e corrigida:** `idempotency-key › chave VENCIDA`: o middleware grava `COMPLETED` sem esperar a resposta e o teste lia a chave logo depois; reproduzido de forma determinística atrasando a gravação (`Expected "COMPLETED" Received "PENDING"`), corrigido no teste (`waitStatus`, confere o vencimento) e validado com o mesmo atraso (5/5). Produto não alterado. |
| **Falha intermitente do build do Admin Web no CI (`7dce4f5`), causa NÃO determinada:** o commit só mudava 1 teste e documentos; o mesmo passo passa nos demais runs e localmente. Hipótese não confirmada: download da fonte Montserrat (`next/font/google`). O `ci.yml` agora publica os erros do build como anotações públicas; recomendação pendente: hospedar a fonte localmente. |
| **Falha isolada de integração (primeira ocorrência):** reproduzida **1 vez em 3** execuções completas com a CPU saturada (2 testes de `login-failed-audit`); passa sozinha. Causa raiz **não provada**; causa provável: `resetAuthLimits` seguia em silêncio quando o Redis do limitador não estava pronto em 5 s. Corrigido só em código de teste (espera 30 s, falha explícita, confere o balde) e o relatório do `db-role-split-check` agora traz a mensagem de cada teste reprovado. Estado final: integração completa **123 suítes / 1802 testes** aprovada (rodada final sem contenção). |
| **E2E (Next 15):** 1ª execução 85/93 testes (7 de 11 arquivos); as 8 falhas eram dado ausente do banco novo (artigos de ajuda, licença, OS encerrada, API em modo MFA), **nenhuma regressão do Next**; os 11 arquivos passaram em execuções separadas depois do preparo, documentado em [apps/e2e/README](../../apps/e2e/README.md). |
| **Regressão funcional/visual:** Admin Web 30 rotas e Super Admin 24 rotas sem erro de página/console e sem rolagem horizontal; login (com MFA no Super Admin), saída, 390 px, permissões por papel e isolamento entre empresas (API 403/404). Comparação com a captura de 2026-10-14 (Next 14) **qualitativa**. |
| **Documentação:** 106/107 → 113 tabelas e 50/55 → 57 migrations em BANCO_DE_DADOS, README e CURRENT_STATE (conferido por `db:inventory`/`db:docs`); o diff gerado de MAPA, RELATORIO e REVISAO foi descartado por descrever o banco isolado. Divergência do Balcão (SPA web × APK) registrada em [APLICATIVOS](APLICATIVOS.md), sem mudar o produto. |
| **Dependências:** `npm audit` 101 → 96 (0 críticas) com `express`, `body-parser`, `qs`, `fast-uri` e `joi` atualizados só no lock; o restante classificado por exposição em [HOMOLOGACAO_POS_NEXT15 §5](HOMOLOGACAO_POS_NEXT15.md). Pendente: `xlsx`, majors de Vite/React Router/Next. |

## Pilha real do compose executada no GitHub e endurecimento de segurança (2026-10-22)

Pela primeira vez a pilha do `docker-compose.yml` foi **executada** (runner Linux do GitHub, workflow `stack-smoke.yml`: `gen-env.sh` → `docker compose up --build` com o overlay WAL → `deploy/homologacao/validar-homologacao.sh --wal` → front-ends e API respondendo 200), com banco novo e segredos aleatórios descartados no fim. **Não prova** HTTPS, domínio/DNS, cópia off-site do backup, restauração em outro host, nem produção.

| O quê |
|---|
| **Execuções:** run 39709324819 reprovou em 3 min (Postgres não iniciava); run 39711336639 reprovou com 4 falhas do roteiro; run 39715194557 (`c59008c`) terminou com **0 falhas** em ~11 min: Postgres 18 com papéis separados, 57 migrations, `db-grants` (contexto assinado exigido), API saudável, backup cifrado gerado pelo serviço de backup, WAL arquivado sem falhas, base backup verificado e os 4 serviços HTTP respondendo. |
| **Defeito do compose:** `postgres:18` guarda os dados em `/var/lib/postgresql/18/docker` e recusa iniciar com o volume em `/var/lib/postgresql/data`; o volume passa a ser montado em `/var/lib/postgresql` (nenhum volume em uso existia: a pilha nunca tinha subido). |
| **Defeito de segurança (decisão 152):** o serviço `api` usava `env_file: .env` e recebia TODAS as senhas (superusuário do Postgres, dono das tabelas, que pode desligar a RLS, e a credencial de backup com BYPASSRLS), anulando a separação de papéis. O `env_file` saiu: a API recebe só 101 variáveis de aplicação (repasse; ausente continua ausente, igual ao comportamento anterior). Variável nova da API precisa entrar na lista do compose (`stack-config.test.ts` reprova se faltar ou se uma credencial de infraestrutura entrar). |
| **Bugs do roteiro e do script de base backup:** `sa`/`as_app` perdiam o código de saída do psql no pipe (todo `must_fail` reprovava mesmo com o banco negando "permission denied"); `base-backup.sh` conectava como a role `postgres`, que não existe no compose (usa `POSTGRES_USER`). |
| **Next 14 (`/_next/image`):** nenhum código usa `next/image`, mas o otimizador ficava ativo (200 para imagem local; o Admin Web ainda habilitava AVIF) e o `next@14` tem RCE crítico nele. `images: { unoptimized: true }` nos dois painéis: o endpoint responde 404 e `/login` continua 200 (provado com `next start`). O RCE crítico "em servidor Windows" não se aplica (implantação Linux). Os demais avisos do Next (rewrites, Server Actions, middleware) não se aplicam: o código não usa esses recursos. O upgrade do Next para a linha corrigida foi feito no mesmo dia (linha abaixo). |
| **Testes de regressão novos** (reprovam no código anterior): `stack-config.test.ts` (5 de 6) e `next-config-hardening.test.ts`. |
| **Next 14 → 15.5.28 (Admin Web e Super Admin) e dependências:** `npm audit` **sem nenhum crítico** (eram 5; 101 no total, 0 críticas, 69 altas, 32 moderadas). Breaking change tratado: o prop `params` das rotas dinâmicas virou `Promise`; 7 páginas do Admin Web passaram a usar `useParams()` (vale no Next 14 e no 15); o Super Admin compilou sem alterações; React segue em 18.3. Também: `bcrypt` 5→6 (sem a cadeia `tar`/`node-pre-gyp`), `handlebars`, `shell-quote`, `compression`, `follow-redirects`, `proxy-addr`. **Provado em navegador real** (Chrome, Next 15 compilado + API + dados sintéticos): login real e 33 carregamentos de página do Admin Web e 21 do Super Admin sem erro de console/página, 404 ou 5xx, 7/7 rotas dinâmicas migradas com o ID chegando à API, cabeçalhos de segurança e CSP preservados e `/_next/image` ainda 404. Testes: Admin Web 556, API 1290 (unitários), 18 suítes de autenticação e 8 de RLS/sessões como papel sem posse. O `next-env.d.ts` gerado pelo Next 15 **não** foi commitado (referencia `.next/types`, que só existe após o build, e quebraria o typecheck do CI). **Não provado:** regressão visual fina e fluxos longos de todas as telas (a suíte `apps/e2e` completa não foi executada). |
| **Consolidação das pastas (ver [CONSOLIDACAO_PASTAS](CONSOLIDACAO_PASTAS.md)):** os "328 itens" são **292 alterações de arquivo no original + 36 na publicação** (nenhum commit): 124 já publicados, 204 evidências de teste (não publicadas de propósito, recriáveis), 0 sensíveis, 0 conflitos, 0 ausentes. Pasta principal: `CORTEX-publicacao`. Backup recuperável criado fora dos repositórios (pacote Git de 314 commits + arquivo dos 292 itens + SHA-256); histórico acessível localmente pelo remoto somente leitura `original`. Varredura dos 314 commits: nenhum segredo nem `.env`/credencial jamais commitado. |
| **Cloudflare Workers Builds:** o projeto `cortex` está **conectado** ao repositório e o build falha a cada push (check "Workers Builds: cortex"); desconectar é ação manual no painel (procedimento em [PRODUCAO §19.7](PRODUCAO.md)). **Google Cloud:** preparação documentada em [GOOGLE_CLOUD](GOOGLE_CLOUD.md) (nada criado; aguarda o suporte); o Balcão é SPA web no código (não há APK), divergência registrada. |
| **Pendente/aberto:** `npm audit fix` não funciona com o npm 10.9 (endpoint de auditoria aposentado); correções de dependência sem versão maior precisam de `npm update` pontual. Pilha com HTTPS (staging/Caddy/Cloudflare), servidor, domínio, cópia off-site e restauração em outro host dependem de infraestrutura real. |

## Estabilização do repositório publicado e da integração contínua (2026-10-21)

Repositório publicado `Luis-silva23/cortex` (snapshot `5e9b941` na `main`; **não** carrega o histórico do projeto original). A 1ª execução do GitHub Actions (run 39671319539) reprovou 4 dos 7 jobs. Cada causa abaixo foi **reproduzida localmente** em um checkout limpo do commit publicado (o log remoto exige login; só o passo reprovado é público). Nenhuma regra de negócio, policy, permissão ou teste foi relaxado. **Produção continua NÃO declarada pronta**: Docker build real, HTTPS, staging, restauração de backup externo e os demais itens de [PRODUCAO](PRODUCAO.md) seguem pendentes; os números abaixo são de testes **locais** (Windows, Node 22, PostgreSQL 18.6 e Redis 8.10 descartáveis), não do GitHub.

| O quê |
|---|
| **Documentation links:** 17 links de documentos vigentes apontavam para `docs/evidencias/**`, pasta que o snapshot não publica. Viraram texto com "evidência arquivada fora do repositório publicado" (nenhuma evidência foi inventada ou copiada). Verificador: 823 links, 0 quebrados; `docs-consistency` passa. Contagem de migrations 55 → 57 em README, PRODUCAO e REVISAO_BANCO_PENDENCIAS (57 em disco e em banco novo; 113 tabelas, RLS habilitado e forçado em todas, 175 policies). **Pendente:** BANCO_DE_DADOS e o README ainda citam 106/107 tabelas (inventário de 2026-10-14/15); regenerar com `npm run db:docs -- --write` exige revisão do diff gerado. |
| **Typecheck e testes unitários:** o `npm ci` não gera o cliente Prisma nem compila `@ln-system/shared`/`@ln-system/database` (consumidos compilados). Sem isso, 85 de 126 suítes unitárias da API e o typecheck de `database`/`api` reprovavam. O CI agora gera o cliente e compila os dois pacotes nos jobs de lint/typecheck, unitários e integração. |
| **Infra (`docker compose config`):** o serviço `api` declara `env_file: .env` e o `.env` não é versionado (`env file .env not found`, reproduzido com o Compose v5.6.1, binário conferido pelo SHA-256 da release). O job copia `.env.example` (fluxo documentado) antes de validar; passou a validar também o overlay WAL (`WAL_KEY_FILE`). Combinações do CI validadas: base, base+staging, staging+cloudflare+free, e as duas com WAL. Na pilha de staging só 80/443 ficam publicadas; PostgreSQL e Redis em loopback. |
| **Invariantes de RLS no CI:** o passo rodava `db:check-rls` com o superusuário do serviço Postgres, e o verificador recusa superusuário/BYPASSRLS e banco sem contexto assinado (3 achados **corretos**). Agora o dono provisiona o contexto e o papel de execução sem posse roda a verificação (passa). Provado que o verificador detecta violações reais: com `NO FORCE ROW LEVEL SECURITY` em `customers` e com a policy de `products` removida ele reprova; restaurado, passa. |
| **`db:role-split-check`:** a prova "papel de execução não assume outro papel" usava `SET ROLE postgres`; no Postgres do CI não existe a role `postgres` (superusuário é `lnsystem`), então o erro virava "role does not exist" e a prova falhava por motivo errado. Passa a testar o papel administrativo e o dono das tabelas reais. O relatório de falhas filtrava `FAIL` e os avisos `..._FAILED` do logger escondiam suítes reprovadas; o filtro agora casa só linhas do Jest. |
| **Suíte de integração:** removida a 2ª execução "rápida" como superusuário (RLS não vale para superusuário: `monitoring-thresholds-alerts` e `policies-foundation` reprovam por isso). A suíte **completa** roda como papel sem posse: **123 suítes, 1802 testes, 0 falhas** (inclui isolamento entre empresas, contexto assinado forjado/expirado/adulterado negado, DDL negado). Armadilha de ambiente registrada: com PostgreSQL só em `127.0.0.1` e URL `localhost`, o fallback IPv6 do Windows estoura o `maxWait` de 2 s do Prisma e reprova testes de concorrência; não é defeito do código. |
| **Lint:** os 7 avisos apontados corrigidos (escape `\-` no fim de classe de caracteres, `catch` sem variável, `case` com bloco). Lint da API: 8 avisos → 1 (`Function` em `asyncHandler`; mudar o tipo afeta dezenas de chamadores); 0 erros nos 3 workspaces. |
| **Dependências:** `proxy-addr` 2.0.7 → 2.0.8 (crítico de runtime do Express: spoofing de IP via sub-rede IPv4 mapeada, relevante para `TRUST_PROXY` e limites por IP), só no `package-lock.json`. O `npm audit` ainda lista críticos: `next@14` (corrigido apenas em 15/16, upgrade de versão maior), `handlebars` e `shell-quote` (ferramentas de teste/dev) e `tar` via `bcrypt` (instalação). O job `security-audit` segue com `continue-on-error`. |
| **Execução remota (GitHub Actions) depois das correções:** run 39698112731 (`3f8d4c1`): Lint & Typecheck, Unit Tests, Build, Infra e Security Audit aprovados e **só a suíte completa de integração reprovou** (Docker Build ficou pulado por depender dela); o log é privado, a falha **não foi reproduzida** nas 3 rodadas locais e a causa **não foi identificada** (a hipótese de pool de conexões por número de CPUs foi testada com `connection_limit=5` e descartada). Runs 39700271321 (`1ab9e2f`) e 39701435271 (`f7c9de9`, mesma lógica de testes): **7 de 7 jobs aprovados**, inclusive o Docker Build das 4 imagens (API, Admin Web, Super Admin e Balcão), que nunca tinha sido construído. O workflow agora publica o relatório do role-split no resumo e as suítes reprovadas como anotações públicas para diagnosticar a próxima ocorrência. **Instabilidade observada e em aberto:** 1 reprovação em 3 execuções da suíte completa. |
| **Workflow:** `permissions: contents: read` (sem escrita nem segredos) e teste de regressão `apps/api/src/ci-workflow.test.ts` (6 testes) que **reprova 6 de 6 no `ci.yml` e no script originais** e passa nos corrigidos. |

## Identidade visual aplicada, CSP, defeito das filas e validações de banco/Redis (2026-10-20)

Sem commit, push nem deploy desta rodada; **Super Admin não criado**; RLS/FORCE RLS, MFA e GateGuard **não** desativados; nada apagado. Marca: [VISUAL_REFERENCES](VISUAL_REFERENCES.md) (seção "Ativos da marca").

| O quê |
|---|
| **Marca:** símbolo hexagonal vetorizado das 3 pranchas oficiais (`brand/`, gerado por `brand/build-assets.js`); favicons (`/favicon.ico`, `/icon.png`, `/apple-icon.png` respondem 200 no Admin Web e no Super Admin; Balcão e PDV com `public/favicon.*`; o PDV apontava para `/vite.svg`, inexistente); símbolo ao lado do texto nos logins e na navegação de Admin Web, Super Admin, Balcão e PDV; ícones Android (Equipe/Painel) e do instalador do PDV (`resources/icon.ico`). Tema escuro do Super Admin alinhado à paleta (`#050A10`); placeholder `admin@lnsystem.com` trocado; apps Android sem o azul/slate fora da paleta. Layout de login dividido **não** aplicado (aguarda aprovação). |
| **Segurança:** `Content-Security-Policy` no Admin Web e no Super Admin (mesma origem + API configurada, sem objetos/frames; `script-src` mantém `'unsafe-inline'` por causa do script de tema — sem nonce). 60 páginas reais (13 do Admin Web e 17 do Super Admin, em tema escuro e claro) sem nenhuma violação de CSP. `.gitattributes` (LF para `.sh`/Docker/compose; binários marcados). |
| **Defeito corrigido (BullMQ):** `jobId` com `:` é recusado pelo BullMQ 5 ("Custom Id cannot contain :"): as notificações de estoque baixo, licença a vencer, fatura, venda e backup falhavam (10 jobs falhos reais no Redis de dev em 2026-10-13 e 2026-10-18); os testes não viam porque a fila é simulada. `config/job-id.ts` (`jobKey`) + teste de regressão que varre o código; prova com BullMQ real (id antigo recusado, novo aceito e deduplicado). |
| **Banco/Redis (provado):** PostgreSQL 18.6, 114 tabelas públicas, todas as com `companyId` têm FORCE RLS; 12 suítes de integração de isolamento/RLS/filas/sessões = 501 testes; `db:check-rls`, `db:replay-check`, `db:role-split-check` (papel de execução não escala privilégio) e `backup:verify` (restauração em banco temporário, 19 verificações) aprovados; BullMQ+Redis 8.10.1 ponta a ponta (publicar → processar → resultado, nova tentativa, falha permanente retida, duplicidade ignorada, encerramento, fila de prova removida). |
| **CI:** `RLS_CONTEXT_SECRET` independente no `.env` do job de integração; job novo `infra-static` (`bash -n` dos scripts, `docker compose config` das combinações, build da imagem de backup). **Nunca executado no GitHub.** `.env.example` agora avisa quais variáveis (SendGrid/SES/S3/Mercado Pago/PagSeguro/Stripe/Datadog) **não** são lidas pelo código. |
| **Rodada de continuação (2026-10-20):** CI com a suíte de integração completa como papel de execução SEM posse (script db:role-split-check com --all), porque o superusuário do serviço Postgres ignora a RLS; jobs antigos do Redis de dev classificados (nada apagado/reexecutado), decisão provisória de cores/tipografia, CSP com limite documentado, checklist executável de homologação (PRODUCAO §20) e o script deploy/homologacao/validar-backup-externo.sh (preparado, não executado). APKs/PDV finais reabertos no emulador/smoke; nenhum é distribuível (API de homologação inexistente, sem assinatura). |
| **Não provado / pendente:** Docker/Linux, servidor Oracle, domínio/Cloudflare, backup externo, Sentry/Resend reais, assinatura de código (PDV) e keystore (Android), logotipo vetorial original, layout de login da prancha, decisões de verde/amarelo/Inter. **Homologação online e produção: não.** |

## Integração final, hospedagem gratuita preparada e aplicativos gerados (2026-10-19)

Sem push nem deploy; nenhum recurso de nuvem criado; **Super Admin não criado**; RLS/FORCE RLS, MFA e GateGuard **não** desativados; nenhum dado apagado (recebível órfão preservado); nenhuma credencial, domínio ou conexão inventados. Detalhe: [PRODUCAO §19](PRODUCAO.md) e [DISTRIBUICAO_APLICATIVOS §6](DISTRIBUICAO_APLICATIVOS.md).

| O quê |
|---|
| **Defeito corrigido:** o commit `5905a0f` trocou o `productName` do PDV para "CORTEX PDV" contra a regra documentada (a pasta de dados do Electron deriva dele: perderia sessão/caixa/`safeStorage`) e quebrava o teste de identidade visual do Admin Web; revertido para `LN System PDV` (nome do instalador e atalho mantêm a marca). Admin Web unitários **549/549**. |
| **Gráficos provados contra o banco:** Central de Monitoramento 18/18 valores iguais ao SQL; Dashboard do Admin Web 11/11 + isolamento por empresa 3/3; 390 px sem rolagem horizontal; E2E `monitoring-central` 18/18 e `admin-web-flow` 9/9. Evidências em `docs/evidencias/2026-10-19-integracao-final/`. Achado não corrigido: `GET /favicon.ico` 404 no Admin Web e no Super Admin (falta o logotipo oficial em arquivo). |
| **Hospedagem gratuita (preparada, nunca executada — sem Docker/Linux aqui):** decisão Oracle Cloud Always Free (A1 2 OCPU/12 GB) + Cloudflare Free (tabela e riscos em PRODUCAO §19); `docker-compose.free.yml` (limites de memória, logs rotacionados, ajuste do PostgreSQL, variáveis da cópia externa), `docker-compose.cloudflare.yml` + `deploy/Caddyfile.cloudflare` (IP real do cliente, origem fechada à Cloudflare, certificado de origem), `deploy/oci/gen-env.sh` (gera segredos aleatórios sem imprimi-los; saída validada contra o validador de produção da API) e `deploy/oci/bootstrap-host.sh` (Docker oficial, swap, fail2ban; `bash -n` OK). |
| **Backup:** a imagem do serviço passa a incluir `rclone` (cópia externa pelo gancho `BACKUP_OFFSITE_CMD`) e o `entrypoint.sh` agora repassa as variáveis `RCLONE_CONFIG_OFFSITE_*` ao cron (sem isso a cópia externa falharia em silêncio). Cópia externa e restauração a partir dela **não** provadas. |
| **Aplicativos:** APKs Equipe e Painel (assinados com chave de debug, URL de API inválida de propósito) e instalador do PDV (não assinado) gerados com caminho, tamanho e SHA-256 em DISTRIBUICAO §6; APK do mecânico instalado e aberto em emulador Android 15; PDV com `smoke:electron` OK. |
| **Testes:** API integração **123 suítes / 1802 testes** passando; E2E de navegador citados acima. |
| **Não provado / pendente (externo):** servidor Oracle (conta, região, capacidade A1), domínio e Cloudflare, certificado de origem, buckets e chaves, Sentry/Resend (desligados), assinatura de código do PDV, keystore Android, logotipo oficial, ícones/banner/favicon. **Produção não está pronta.** |

## Central de Monitoramento do Super Admin: gráficos gerenciais, alertas com tratamento, funil, Sentry/Resend opcionais (2026-10-18/19)

Sem commit, push nem deploy; **Super Admin não criado**; nenhum dado financeiro apagado; recebível órfão preservado; RLS e FORCE RLS **não** desativadas; nenhuma credencial, domínio ou conexão inventados. Detalhe operacional: [PRODUCAO §18](PRODUCAO.md) e [SECURITY](SECURITY.md).

| O quê |
|---|
| **Telas (Super Admin › Observabilidade):** Central (6 KPIs, infraestrutura, 8 gráficos, backup criado × verificado × restauração testada, incidentes), Empresas (comparação com filtros, ordenação, paginação e detalhe por empresa), Alertas (ciclo reconhecer → atribuir → tratar → resolver com nota → reabrir, histórico imutável, orientação de diagnóstico), Funil comercial (etapas, conversão, tempo por etapa, implantação parada, evolução mensal), Serviços externos e custos. Tabs em `observability/layout.tsx`; "Resumo técnico" é a antiga visão geral. |
| **Fórmulas sem invenção:** disponibilidade = amostras sem estado "Fora do ar" ÷ amostras coletadas (lacuna ≠ disponibilidade; cobertura baixa é sinalizada); saúde das integrações = (saudáveis + ½ degradadas) ÷ verificadas, **sem dado = "Sem dados"** (nunca 100%); fiscal/pagamento automático aparecem como não configurado/não verificado. |
| **Banco (migrações 56 e 57):** `20261019100000_monitoring_central` (6 tabelas de plataforma com RLS forçada, histórico append-only, colunas de tratamento em `monitoring_alerts`) e `20261019110000_monitoring_alert_events_company_index` (índice por empresa, achado pelo teste de invariantes). Replay do zero: 3 712 itens iguais ao dev, `migrate diff` vazio, `db:check-rls` OK. |
| **API:** `routes/monitoring-central.routes.ts` (só Super Admin, auditada), serviços em `services/monitoring-central/*` (overview, sampler, alert-center, funnel, retention, backup-status, settings, notifier, Sentry sem SDK e Resend por `fetch` — ambos **desligados sem credencial**, com mascaramento, amostragem, limites, deduplicação e disjuntor). Falha externa nunca interrompe a operação. |
| **Defeito corrigido (já existia):** consultas cruas do painel de Performance rodavam **fora** de contexto de RLS e devolviam 0 linhas (p95 = 0, séries vazias); agora passam por `runInTransaction` (teste de regressão). |
| **Testes:** API unitários **1279/1279** (125 suítes); integração **123 suítes / 1802 testes** (a suíte de invariantes achou o índice faltante; corrigido pela migração 57) e **a mesma suíte completa como papel SEM posse: 123/1802**; `monitoring-central.integration` 96 testes; E2E em navegador real `monitoring-central.e2e.test.js` **16/16** (Super Admin em produção `next start` + API de dev; capturas em `docs/evidencias/2026-10-18-playwright/central-monitoramento/`); `tsc` API e Super Admin limpos, `next build` OK; `db:check-rls`, `db:replay-check`, `backup:verify` (19 verificações) OK. |
| **Não provado / pendente (externo):** Sentry e Resend **nunca falaram com o provedor real** (só `fetch` simulado nos testes); Supabase = análise documental (nada migrado); Figma sem arquivo/token/conector (tokens do repositório); domínio, DNS, HTTPS, hospedagem, backup externo e destinatários de alerta **não existem**; produção **não** declarada pronta. |

## Missão mestra de finalização, integração, implantação e lançamento comercial (2026-10-18)

Sem commit, push nem deploy; **Super Admin não criado**; nenhum dado financeiro apagado; recebível órfão preservado; RLS e restrições **não** desativadas. Estado vivo: [ESTADO_ATUAL_MISSAO_MESTRA](ESTADO_ATUAL_MISSAO_MESTRA.md); comercial: [PREPARACAO_COMERCIAL](PREPARACAO_COMERCIAL.md).

| O quê |
|---|
| **Migração 55:** `20261018100000_user_password_change` (`users.mustChangePassword`, `passwordChangedAt`; trava de privilégio de `users` estendida a senha e exigência de troca). |
| **Senha temporária e troca de senha (decisão 157):** usuário criado/redefinido por administrador nasce com senha temporária; login devolve 403 `PASSWORD_CHANGE_REQUIRED` + credencial de troca (10 min, sem `userType`); `POST /auth/password-change/complete` e `POST /auth/change-password`; política (10+; administradores 12+ e 3 tipos); troca derruba sessões; senha atual errada conta para o bloqueio. Admin Web (login e Configurações › Segurança) e Super Admin com a tela de troca. |
| **Ciclo de uso (decisão 158):** limite de usuários da licença (409 `USER_LIMIT_REACHED`); Super Admin bloqueia/reativa empresa; Admin Web › Usuários com filial principal obrigatória e diálogo **Filiais**; fixtures de E2E com contexto RLS assinado; jornada de onboarding de empresa provada (9 casos). |
| **Aplicativos Android (decisão 159):** marca CÓRTEX Equipe/Painel; build isolado em caminho ASCII; plugin de assinatura de release que **recusa** release sem keystore; `allowBackup=false`; permissões de armazenamento/sobreposição bloqueadas; APK do mecânico testado em emulador; release de teste interno gerado (v2-assinado com chave de debug, não distribuível). |
| **PDV Desktop (decisão 160):** Electron 44.9.0, instalador NSIS x64 sem assinatura. |
| **Documentação:** `PREPARACAO_COMERCIAL`, `TERMOS_DE_USO_MINUTA`, `MOBILE`, `ANDROID_TV`, `SECURITY`, `PRODUCAO` (migração 55), decisões 157–161, matriz de permissões; `.gitignore` bloqueia keystores, certificados, APK/AAB e `android/`. |
| **Resultado:** type-check 9 workspaces; unitários API 1202, Admin Web 549, Balcão 9, PDV 37; integração **122 suítes / 1705** (também como papel sem posse); `db:replay-check` 55 do zero = dev (3593 itens); `backup:verify` 19/19; builds API/Admin Web/Super Admin/Balcão; E2E Playwright 79 testes em 9 suítes (sem `pdv-sale-flow`). |
| **Testes ajustados:** `auth-coverage` (nova rota pública documentada), mock de `auth.service` no teste de login com banco fora, testes antigos que criavam usuário e logavam com a senha (agora `requirePasswordChange:false`), `db-replay-check` (SQL direto para o estado anterior às migrações novas), `docs-consistency` (55 migrações; decisões 157–161). |

## Missão de segurança e liberação: contexto de RLS assinado, backup delegado, várias filiais, WAL/PITR e anonimização (2026-10-15 a 18)

Sem commit, push nem deploy; **Super Admin não criado**; nenhum dado financeiro apagado; recebível órfão preservado; RLS e restrições **não** desativadas. Relatório: [RELATORIO_SEGURANCA_PRODUCAO_2026-10-15](RELATORIO_SEGURANCA_PRODUCAO_2026-10-15.md).

| O quê |
|---|
| **Migrações 53–54:** `20261017100000_rls_signed_context` (contexto assinado, 165 policies em InitPlan) e `20261017110000_user_branches` (várias filiais). |
| **API:** `tenantIsolation` assíncrono com escopo do banco (503 em falha), rotas `GET/PUT /users/:id/branches`, dashboards/convênios/usuários/auditoria pelo conjunto, `db-security` (recusa subir inseguro), backup delegado (202/403), `env.ts` recusa credencial de backup na API. |
| **Infra:** `docker-compose.yml` (API sem credencial de backup, `RLS_CONTEXT_SECRET`), `docker-compose.wal.yml`, `wal-archive/fetch/base-backup/pitr-restore.sh`, `backup.sh wal-check`, `alert-webhook.sh`, `validar-homologacao.sh` (não executado). |
| **Scripts:** `backup:anonymize`, `backup:drill --anonymize`, `db:provision-context`; `verify-backup-restore` e `restore-drill` ajustados ao cofre fora do dump. |
| **Testes novos/alterados:** `multi-branch-access` (28), `rls-signed-context` (7), `backup-delegated` (6), `branch-scope.service` (8), `db-security` (8), `DelegatedBackupService` (10), `anonymize` (7), `docs-consistency` ampliado; 18 testes de rota com mock de unidade do escopo. |
| **Resultado:** unitários API 1188; integração 120 suítes / 1684 (também como papel sem posse); `db:replay-check` 54 do zero = dev (3590 itens); `backup:drill` 25/25; simulação do pipeline sem Docker 0 falhas. |
| **Pendente:** Docker/Linux, staging HTTPS, off-site, alerta real, outro host, aprovações (decisão 156). |

## Finalização de produção: escopo por filial, travas de privilégio, papéis do compose, backup e ensaio de restauração (2026-10-16)

Sem commit, push, deploy nem alteração em produção; **Super Admin não criado**; nenhum dado financeiro apagado; o recebível órfão conhecido (3 FKs `NOT VALID`) foi **preservado e documentado**; RLS e restrições de integridade **não** foram desativadas para nenhum teste. Detalhe, números e bloqueios: [RELATORIO_FINALIZACAO_PRODUCAO](RELATORIO_FINALIZACAO_PRODUCAO.md); decisões 143–150 em [DECISIONS](DECISIONS.md). **2 migrations novas (52 no total).**

| O quê |
|---|
| **Escopo por filial na RLS** (`20261016100000_branch_scope_rls`): 9 tabelas que só isolavam por empresa + `audit_logs` + `transfers`; leitura regra F, escrita estrita da própria filial. Prova vermelha: 16 de 28 testes falhavam contra a RLS antiga. |
| **Travas de privilégio** (`20261016110000_privilege_escalation_guards`): gerente não muda o próprio `userType`/`branchId`, não concede perfil, **não liga módulo desativado**, não cria/apaga filial — nem por SQL direto. |
| **Dashboards** (`dashboard.routes.ts`): papel de filial pedindo outra filial → **403 `BRANCH_FORBIDDEN`** (antes: 200 com a própria filial, em silêncio); administrador pedindo filial de outra empresa → 404. **Mudança de contrato** (decisão 145). |
| **Convênios e equipamentos** (`partners.routes.ts`, `activation.routes.ts`): gerente só da própria filial; listagem de equipamentos de uma licença fechada a OPERATOR/MECHANIC/VIEWER. |
| **Compose**: a API deixa de conectar como superusuário (RLS inerte antes); papéis dono/execução/backup (`deploy/postgres-init`), serviço `db-grants`, serviço `backup` (cron 00:00 + verificação 12:00). Não executado com Docker; pipeline reproduzido fora dele. |
| **Backup**: `deploy/backup/backup.sh` (cifrado, manifesto, retenção, alerta); `npm run backup:drill` (21 verificações em banco isolado, inclui a API subindo); PITR provado em laboratório. RPO/RTO **propostos, pendentes de aprovação**. |
| **Testes novos/alterados**: `branch-scope-access.integration` (28), `dashboard-management`, `mfa-company-admin`, `docs-consistency` (52 migrations, backup, compose). |

## Correção completa do banco: sessões em hash, FK de empresa/filial, livros append-only, RESTRICT no histórico, papéis, fuso e 3 falhas intermitentes (2026-10-15)

Sem commit, push, deploy nem migração fora do desenvolvimento/teste; **Super Admin não criado**; nenhum dado de banco compartilhado apagado (as únicas remoções foram órfãs **sintéticas do banco de teste**). Detalhe: [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md), [RELATORIO_EXECUCAO_REVISAO_BANCO](RELATORIO_EXECUCAO_REVISAO_BANCO.md), decisões 128–142 em [DECISIONS](DECISIONS.md). **14 migrations novas (50 no total).**

| O quê |
|---|
| **Sessões (D-01, Alta):** `refresh_tokens` passa a guardar **SHA-256** do token e `companyId` (só pelo usuário), RLS sem o ramo `IS NULL`; o mesmo cálculo em SQL e na aplicação **preservou as sessões existentes**. `refresh-token-isolation` (7) + cenário de dados do `db:replay-check`. **Reiniciar a API depois da migration.** |
| **Referência cruzada entre empresas eliminada no banco:** FK composta em **94** relações, `companyId → companies` em **65** tabelas, `(companyId, branchId) → branches` em **55**, trigger de mesma empresa em 3 referências (`sales.partnerId`, `service_orders.mechanicId`, `users.branchId`). Cada migration com **guarda** que aborta com dado cruzado; linha de empresa inexistente fica com a FK `NOT VALID` (1 recebível órfão no dev, **preservado**). Provado em **3 bancos temporários** com dado inconsistente. |
| **Histórico não some em cascata:** 21 FKs `CASCADE` → `RESTRICT` (+ 8 `SET NULL`); livros de estoque/caixa/política/status de OS **append-only** (UPDATE negado, DELETE só com expurgo sinalizado). Testes `append-only-ledgers` (6), `company-branch-fk-restrict` (9), `database-schema-invariants` (7), `same-company-ref-triggers` (5). |
| **Papéis do banco:** modelo `deploy/db-runtime-role.sql` e prova `npm run db:role-split-check` (DDL negado ao papel de execução, RLS intacta, a suíte de integração completa (116 / 1614) passa como esse papel). **Adoção em staging/produção = infraestrutura.** |
| **Fuso do banco = UTC** (`ALTER DATABASE`), 6 índices idênticos + 13 redundantes removidos, 16 índices ausentes criados. |
| **Achados na aplicação (corrigidos):** **deadlock real** de pagamento por convênio (a FK composta fez o `INSERT` tomar `KEY SHARE` antes do `FOR UPDATE` do serviço — agora trava o convênio antes); `ON DELETE RESTRICT` chegava como **500** (23001 sem código no Prisma) — agora **409** `RECORD_IN_USE`/`BRANCH_IN_USE`; `Idempotency-Key` **nunca expirava** — agora vale 24 h e o job expurga; detector de cartão do suporte recusava **chave de NF-e/boleto/carimbo** ao acaso (Luhn aprova ~10% de qualquer número). |
| **Falhas intermitentes de teste, causa encontrada:** `support.integration` (14 testes; o carimbo de 13 dígitos do texto do chamado passava no Luhn e era recusado como "cartão" — ocorrência anterior "não explicada" agora explicada); `mfa-company-admin` (virada do passo TOTP de 30 s entre dois testes e leitura de auditoria assíncrona). Corrigidas no produto (detector) e nos testes (folga no passo TOTP; leitura com tentativas). |
| **Teste:** limpeza de empresa sintética guiada pelo **catálogo** (`purge-company.ts`) em vez de lista à mão; `test:integration:prepare` remove só no banco de teste as órfãs sintéticas de empresas apagadas e valida as FKs. |
| **Testes desta rodada:** API `tsc` limpo (todos os workspaces), lint 0 erros (8 avisos), unitários **114 suítes / 1135**, integração completa **116 suítes / 1614** em três rodadas seguidas verdes e **1615** na rodada final (uma com `PG_ENV_DEBUG=1`: 0 conexão sobrando em cada arquivo), `db:check-rls` OK, `db:replay-check` com 4 cenários, `db:role-split-check`. Ver [resultados-testes](revisao-banco/resultados-testes.md). |

## Revisão técnica do banco (2ª rodada): achados A/B/C, FK composta, RLS de logs e perfis globais, guarda de migration (2026-10-14) — HISTÓRICO: as pendências listadas nesta entrada foram corrigidas em 2026-10-15 (entrada acima)

Sem commit, push, deploy nem migração fora do desenvolvimento/teste; nenhum dado de banco compartilhado foi apagado ou reescrito. Detalhe em [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md) e [RELATORIO_EXECUCAO_REVISAO_BANCO](RELATORIO_EXECUCAO_REVISAO_BANCO.md); decisões 124–135 em [DECISIONS](DECISIONS.md).

| O quê |
|---|
| **Achados A e B (numeração dos chamados e índice da busca):** o SQL apresentado (`SET DEFAULT … DROP DEFAULT … DROP SEQUENCE`, `DROP INDEX support_kb_articles_search_idx`) **nunca foi migration** — era a saída do `prisma migrate diff` com o schema antigo, que não descrevia a sequência, a coluna gerada nem o GIN. Corrigido **só no `schema.prisma`** (`@default(autoincrement())`, `search` com `dbgenerated`, `@@index([search], type: Gin)`, `updatedAt @default(now())`); o diff banco → schema ficou **vazio**; nenhuma mudança de banco; números de chamados e índice preservados. Teste `support-schema-objects` (5): 12 chamados em paralelo → 12 números distintos; coluna gerada; GIN válido. |
| **Achado C (referência cruzada entre empresas) — reproduzido e corrigido:** uma sessão da empresa A gravava `product_barcodes`/`product_images` apontando para produto da B. FK composta `(companyId, productId) → products(companyId, id)` (migrations `20261014160000` e `20261014161000`), com as mesmas regras de exclusão. Teste `product-children-same-company` (8): 6 vermelhos antes, verdes depois. |
| **Achado derivado — a validação de FK é cega sob FORCE RLS:** o `ADD CONSTRAINT` do dono, sem contexto, enxerga 0 linhas e passa mesmo com dado violando (experimento revertido). Nova migration-guarda `20261014155900` (lê como plataforma e aborta), testada em banco temporário **com dado cruzado**: falha, nada fica pela metade, recuperação por `migrate resolve --rolled-back` conclui. As 109 FKs existentes: 0 violações. Cabeçalho de `20261014160000` corrigido (checksum de dev/teste reconciliado, documentado). |
| **RLS de logs e perfis/permissões globais (`20261014162000`):** uma empresa lia 371 `system_logs` e 3 540 `request_logs` de plataforma, gravava log em nome de outra e alcançava o `UPDATE`/`DELETE` dos perfis/permissões globais. Corrigido; teste `rls-logs-roles-tighten` (6; vermelho antes). Os logs continuam sendo gravados (worker em contexto de plataforma). |
| **[CORRIGIDAS em 2026-10-15 — ver a entrada acima] Pendências para decisão (nada alterado nesta rodada):** `refresh_tokens` sem isolamento e com token em texto (**Alta**), FK composta nas outras 66 FKs, livros mutáveis pela RLS, 41 `CASCADE` sobre histórico, relações sem FK (1 recebível órfão de teste, mantido), fuso horário (110 defaults), papel da aplicação = dono das tabelas, 6 índices idênticos a um UNIQUE. |
| **Novos:** `npm run db:replay-check` agora inclui o cenário com dado inconsistente; `db:docs --orphans` confere as 109 FKs, 183 relações sem FK e 66 candidatas a referência cruzada; seções de tipos/fuso e de índices redundantes. **Testes:** unitários 112/1118; integração **111 suítes / 1579, duas rodadas seguidas verdes** (0 conexão sobrando por arquivo na rodada com medição); `db:check-rls` OK; `backup:verify` 18/18; replay do zero idêntico (40 migrations, 3 339 itens); Playwright `admin-web-flow` + `catalog-and-help` + `support-contextual-buttons` 22/22. |

## Rodada final: banco para revisão externa, código MFA de uso único, falha intermitente do Playwright e medição do Argon2id (2026-10-14)

Sem commit, push, deploy nem migração fora do desenvolvimento/teste. Sem teste de carga. **Nenhuma migration nova** (o banco não precisou mudar). A conta do Super Admin **segue não criada**.

| O quê |
|---|
| **Banco para revisão externa (item 18):** gerados do catálogo, do schema e das migrations — [BANCO_DE_DADOS](BANCO_DE_DADOS.md) (Anexo A: as 106 tabelas com colunas, PK, FKs, constraints, índices, RLS e triggers), [MAPA_RELACIONAMENTOS](MAPA_RELACIONAMENTOS.md), [RELATORIO_MIGRATIONS](RELATORIO_MIGRATIONS.md), [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md), quadro de decisões em [DECISIONS](DECISIONS.md) e o pacote [revisao-banco/](revisao-banco/LEIA-ME.md) (schema + 36 migrations + SHA-256). Novos: `npm run db:docs`, `npm run db:replay-check`, `npm run password:bench`. **Prova:** as 36 migrations aplicadas do zero num banco temporário reproduzem **exatamente** o catálogo do dev (3 331 itens iguais) — nenhuma alteração manual invisível. Achados (nada alterado, aguardam aprovação): `refresh_tokens` sem isolamento por empresa e com o token em texto (**Alta**), policies que aceitam `companyId` nulo / `WITH CHECK true`, livros mutáveis pela RLS, 41 FKs em cascata, 1 recebível órfão de teste. |
| **Código MFA de uso único em todo caminho (risco registrado, fechado):** a dupla autorização (retirada de caixa, cancelamento/devolução, desconto, agenda) aceitava o mesmo código mais de uma vez na janela de 30 s, e o código de recuperação e o do Redis tinham a mesma corrida. Novo ponto único `services/mfa-consume.ts`: TOTP por atualização condicional de `mfaLastStep`, código de recuperação por compare-and-swap, código SMS/e-mail por script Lua atômico. Teste `dual-authorization-mfa-once` (7, Postgres e Redis reais): 8 autorizações simultâneas → 1; 3 retiradas simultâneas → 1 movimentação; 6 usos do mesmo código de recuperação → 1. |
| **Falha intermitente do `support-contextual-buttons` — causa encontrada e corrigida:** não era compilação a frio (com o cache `.next` apagado a 1ª navegação leva ~6,5 s) nem sincronização do teste, e sim o **limite geral da API (100 requisições/min por usuário)**: o arquivo faz ~50 chamadas com `admin.alfa` e duas execuções seguidas (ou logo depois de `admin-web-flow`) estouram o balde → **429** → a tela perde dados → timeout. Reproduzido de forma determinística (a 2ª execução seguida falhava em 3 testes) e, depois da correção, 3 execuções seguidas passam. Correção só no teste (o limitador do produto não mudou): `launchBrowser()` zera os baldes do Redis de dev e `watch()` registra recusas 401/403/429. `catalog-and-help` falhou por timeout logo depois de `admin-web-flow`, passou sozinho e passa em sequência depois da correção (causa 429 **inferida**: esse arquivo ainda não registra as recusas). Detalhe em [apps/e2e/README](../../apps/e2e/README.md). |
| **Argon2id medido** (`npm run password:bench`, máquina de trabalho): verificação 26 ms (19 MiB, t=2, p=1) × 257 ms do bcrypt anterior; +38 MB com 3 simultâneas. Parâmetros mantidos (mínimo OWASP); **medição no servidor-alvo/Linux pendente**. [SECURITY](SECURITY.md). |
| **Testes desta rodada:** API tsc limpo; lint 0 erros (8 avisos); unitários 112 suítes / 1118; Admin Web 549; Balcão 9; PDV 37; **integração completa 108 suítes / 1560, duas rodadas seguidas verdes**, 0 conexão sobrando em cada um dos 108 arquivos (rodada com medição por arquivo) e pico de 16 conexões no amostrador (rodada 2); `db:check-rls` OK; `backup:verify` 18/18; builds de API, Admin Web, Super Admin, Balcão e renderer do PDV; smoke do Electron; Playwright: `mfa-privacy-image` 6/6 (API com `REQUIRE_MFA_COMPANY_ADMIN=true`), `admin-web-flow` + `catalog-and-help` + `support-contextual-buttons` 22/22 em sequência, `super-admin-flow` + `support-ticket-flow` 14/14. `pdv-sale-flow` **não** foi repetido (cria venda persistente no sandbox). |
| **Staging/infraestrutura:** compose, Caddy, Dockerfiles e CI **revisados, não executados** (sem Docker/domínio); lista objetiva do que falta e roteiro de implantação/rollback/diagnóstico em [PRODUCAO §15](PRODUCAO.md). Os binários Linux do `@node-rs/argon2` constam no `package-lock.json`. |
| **Instalador do PDV:** artefato NSIS x64 de 11:12 do mesmo dia (82 MB, **NotSigned**) conferido; o `productName` (`LN System PDV`) e o `appId` (`com.lnsystem.pdv`) ainda levam a marca antiga, enquanto a tela é "CÓRTEX PDV" — alinhar antes da 1ª distribuição (decisão do dono; mudar o `appId` muda a identidade da instalação). Instalação real e assinatura **não** executadas. |

## Fechamento técnico: decisões 107 e 120–123, banco, conexões e instalador (2026-10-14)

Sem commit, push, deploy nem migração em produção. Sem teste de carga. Detalhe nas decisões ([DECISIONS](DECISIONS.md)), em [BANCO_DE_DADOS](BANCO_DE_DADOS.md) e em [PRODUCAO §13–14](PRODUCAO.md). A conta do Super Admin **segue não criada** (a senha é do responsável).

| O quê |
|---|
| **Decisão 107 — revogação de sessão sem Redis:** deixou de falhar aberta. Toda revogação é gravada também no PostgreSQL (`access_revocations`); Redis fora → consulta o PostgreSQL; os dois fora → 503 `AUTH_UNAVAILABLE` (nunca aceita, nunca 401); ao voltar o Redis é ressincronizado antes de ser a fonte. Prova: 10 testes + **ensaio ao vivo com o Redis real derrubado** (revogado 401, válido 200, revogação durante a queda valeu, ressincronização conferida). |
| **Decisão 123 — MFA obrigatório para COMPANY_ADMIN:** configuração pela tela (QR gerado no navegador), código TOTP que **não vale duas vezes**, erro de código conta como tentativa, perfil obrigado não desliga o MFA, mudar de perfil revoga sessões, recuperação por código/novos códigos/reinicialização pelo Super Admin (auditada) e `admin:bootstrap reset-mfa`. A API **recusa subir** em produção com `REQUIRE_MFA_*=false`. 14 testes + Playwright. |
| **Decisão 121 — Argon2id:** `@node-rs/argon2` (19 MiB, t=2, p=1), bcrypt legado aceito e migrado no login válido (troca compare-and-set), custo de tempo equalizado, reversão por variável. 7 + 8 testes. |
| **Decisão 120 — pedidos de titular (LGPD):** `/api/privacy` (só COMPANY_ADMIN, senha + justificativa), exportação cifrada (24 h, 3 downloads, rotina de limpeza), anonimização irreversível em transação com retenção fiscal/garantia e bloqueio por cobrança em aberto; Admin Web › Privacidade (LGPD). 12 testes + Playwright. Minutas em `docs/privacidade` atualizadas (sem revisão jurídica). |
| **Decisão 122 — imagem opcional do produto:** PNG/JPEG/WebP validados e saneados (sem EXIF/GPS, sem bytes depois do fim), 1 MB, sob RLS; cartão no Admin Web. 8 + 7 testes + Playwright. |
| **Banco:** 5 migrações aditivas (`product_barcodes`, `access_revocations`, `mfa_replay_guard`, `privacy_requests`, `product_images`) aplicadas em dev e teste; 106 tabelas, todas com RLS forçada; schema Prisma alinhado ao banco (só ficam as diferenças intencionais); `npm run db:inventory`; [BANCO_DE_DADOS](BANCO_DE_DADOS.md). `backup:verify` 18/18 com as tabelas novas. |
| **Conexões do PostgreSQL na suíte de integração (causa raiz):** vazamento — os workers do BullMQ criados na importação sobreviviam ao arquivo de teste e reabriam o pool do cliente já fechado (pico medido 91 de 97; a falha caía num teste "aleatório"). Corrigido por ambiente de teste que fecha filas e pool depois de todos os hooks: **0 conexões sobrando por arquivo, pico 20**. |
| **Instalador do PDV:** `electron-builder` falhava ("não consegue calcular a versão do Electron"); `build.electronVersion` fixado em 28.3.3 — instalador NSIS x64 gerado (82 MB, **sem assinatura**, ícone padrão) e o aplicativo empacotado abre ("CÓRTEX PDV"). Instalação real e assinatura **não** executadas. |
| **Outros:** o PDV mostra o texto legível quando `error` vem como código de máquina; `demo:tools totp` respeita o anti-reuso; `support-console-pdv` passou a entrar pela tela (o PDV não restaura sessão desde 2026-10-14); `mfa-secret-at-rest` zera o marcador de passo; `auth-coverage` lista as 2 rotas públicas novas com justificativa. |

## Segurança, Super Admin, códigos de barras e Central de Ajuda (2026-10-14, rodada de homologação)

Sem commit, push nem migração destrutiva. Sem teste de carga/estresse. A conta do Super Admin **não** foi criada (procedimento pronto, ver [PRODUCAO §13](PRODUCAO.md#13-primeiro-super-admin-bootstrap-e-mfa)).

| O quê |
|---|
| **Bootstrap seguro do Super Admin de TI** (`npm run admin:bootstrap`): simulação por padrão, `--apply`, senha só por variável do comando ou prompt oculto, política de senha, idempotente, nunca promove outra conta, login de até 6 dígitos só se livre, produção só com `ALLOW_SUPER_ADMIN_BOOTSTRAP=true`, auditado sem segredo. `enroll-mfa` liga o TOTP (segredo cifrado, só com código válido). Teste `super-admin-bootstrap` (9). |
| **MFA obrigatório para Super Admin** (`REQUIRE_MFA_PRIVILEGED`, padrão ligado em produção): 403 `MFA_ENROLLMENT_REQUIRED` só depois da senha correta. |
| **Auditoria de permissões:** atribuir/revogar perfil e conceder/revogar permissão de perfil gravam `PERMISSION_CHANGED` (autor, alvo, escopo, mudança). Teste `permission-audit` (3). |
| **Mensagem padrão de falta de autorização** ("Usuário sem autorização. Entre em contato com o administrador.") no Admin Web, Balcão e PDV; o servidor segue recusando com 403. |
| **Vários códigos de barras por produto** (tabela `product_barcodes`, migração `20261014100000`): texto (zeros preservados), único por empresa (`409 BARCODE_IN_USE`), desativar/reativar, principal sincronizado, ambiguidade legada `409 CODE_AMBIGUOUS`, importação por planilha com o código principal. Admin Web: cartão "Códigos de barras" na edição. Testes: integração `product-barcodes` (9) e E2E `catalog-and-help` (7). |
| **Central de Ajuda da loja:** 13 artigos em [docs/ajuda](../ajuda/CENTRAL_DE_AJUDA.md) publicados de forma idempotente por `npm run help:seed` (texto puro, sem segredo, só o que existe). |
| **LGPD (técnico + minutas):** [docs/privacidade](../privacidade/README.md) — políticas, titulares e incidentes, inventário e fornecedores, cláusulas e avaliação de RIPD. **Minutas sem revisão jurídica**; nada declara conformidade integral nem certificação. |
| **Verificação (2026-10-14, servidores desligados, um por vez):** integração completa **102/102 suítes, 1502/1502 testes** (3ª execução). As duas anteriores tiveram falhas **diferentes a cada rodada**, todas `Too many database connections opened` (a classe de oscilação já descrita em `disconnectDb.ts`: `cash-movement-race`, `rbac`, `concurrency`, `purchase-order-integrity`, `dashboard-management`), todas verdes isoladas; as falhas **determinísticas** introduzidas por esta rodada (limpeza fora do escopo da guarda de destruição, FK `product_barcodes`, balde de login compartilhado) foram corrigidas. Unitários API **1100/1100**; Admin Web **549/549**; Balcão lógica **9/9**; PDV lógica **36/36**; `tsc` limpo (API, Admin Web, Balcão, PDV); lint 0 erros; builds API, Admin Web (`next build`), Balcão e renderer do PDV OK; 507 links de documentação, 0 quebrados. **Não** executado: instalador do PDV (`electron-builder`), Docker, HTTPS real, mobile/TV. |
| **Correção de teste:** `destroyFixture` apaga `product_barcodes` antes de `products` (FK Restrict); limpezas dos novos testes escopadas por id/empresa (guarda de destruição); suíte do bootstrap zera o balde de login do IP compartilhado. |

## Consolidação final — sessão do operador, bloqueio de tela e sessão por equipamento (2026-10-14)

Detalhe em [CONSOLIDACAO_FINAL](CONSOLIDACAO_FINAL.md). Sem commit nem push; sem teste de carga.

| O quê |
|---|
| **Sessão do PDV não é mais restaurada:** o par de tokens vive só na memória; reabrir, reiniciar ou recarregar exige login (antes o `safeStorage` devolvia o último operador). Legado apagado na primeira abertura. O Balcão segue a mesma regra (antes `sessionStorage`). |
| **Encerramento ao fechar a janela** (Electron): o processo principal segura o `close`, o renderer revoga a sessão no servidor e libera (prazo 4,5 s). **Revogação pendente** (sem rede) fica numa fila cifrada pelo SO, reenviada na abertura e quando a rede volta; nunca autentica. |
| **Bloquear tela** no PDV (`POST /api/auth/reauthenticate`: só a senha do próprio usuário do token, sem sessão nova, 3 erros/5 min, auditado). Sair da conta e fechar o caixa continuam operações distintas. |
| **Sessão de equipamento:** o mesmo operador que reentra no mesmo equipamento após queda substitui a própria sessão presa (`SUPERSEDED_BY_RELOGIN`); logout encerra só a sessão do refresh token que saiu (antes derrubava o PDV ao sair do Balcão/Admin Web). |
| **Instalador:** removida a referência a `public/icon.ico` inexistente; smoke do Electron atualizado (portão de equipamento + fechamento com encerramento de sessão). |
| **Parcelamento:** aviso na tela de que não há juros (`interestFreeInstallments` não é usado em cálculo); decisões **118** (offline) e **119** (juros). |
| **Testes (2026-10-14, esta etapa):** PDV lógica **36/36**; `reauthenticate` **5/5**; `device-authorization` + `logout-revokes-access` **39/39** (inclui os 2 casos novos, reproduzidos antes da correção); E2E Balcão **13/13** e PDV web **9/9**; smoke do Electron real OK; `tsc` limpo em API, PDV, Admin Web e Balcão. A suíte completa de integração **não** foi repetida nesta etapa. |

## Auditoria final com Playwright, correções e CSP do Balcão (2026-10-14)

Detalhe, evidências e quadro das decisões 109 a 117 em [AUDITORIA_FINAL](AUDITORIA_FINAL_2026-10-14.md). **Nenhum teste de carga/estresse foi executado**; nada foi enviado a remoto; **nenhum commit foi criado** nesta rodada (as alterações ficam na árvore para revisão).

| O quê |
|---|
| **Playwright (Chrome real, sequencial):** novas suítes `balcao-flow` (12), `admin-web-flow` (9), `super-admin-flow` (6, com MFA TOTP) e `pdv-sale-flow` (6, empresa sandbox) em `apps/e2e`; as 3 suítes de suporte já existentes seguem **18/18**. Capturas em `docs/evidencias/2026-10-13-playwright/`. Mobile, TV e PDV Electron empacotado **não** foram validados visualmente (sem ambiente). |
| **Leitura de código ambígua (defeito):** SKU de um produto = código de barras de outro (ou dois ativos com o mesmo código) devolvia um produto **ao acaso**. Agora `409 CODE_AMBIGUOUS`; ativo vence inativo; ordem determinística. Teste novo `product-code-resolution` (6), reproduzido antes da correção. |
| **Custo para quem compra (defeito da redação de `costPrice`):** perfil com `purchases:manage/approve/receive` volta a ver o custo (o pedido de compra saía com custo 0); VIEWER nunca. |
| **Login do Admin Web:** rótulos associados aos campos (`htmlFor`/`id`), `autoComplete` e rótulo do código MFA. |
| **nginx do Balcão:** os cabeçalhos de segurança **não eram enviados** (`add_header` em `location` anula os do `server`); agora só no `server`, cache por `expires`, e **CSP** (`script-src 'self'`, `connect-src 'self' <API>`, `frame-ancestors 'none'`); `API_ORIGIN` no compose/staging; imagem do Balcão no job `docker-build` do CI. Provado no navegador com um servidor de cabeçalhos equivalentes (12/12, zero violação); **nginx real não executado**. |
| **Decisão 108:** inventário de tokens por aplicativo e alternativas A/B/C com recomendação (A: CSP com nonce no Next, depois B: refresh em cookie HttpOnly). Admin Web e Super Admin **sem CSP** (exige nonce). |
| **Códigos de barras e fiscal:** lacunas documentadas, **sem migração** — um único `barcode` por produto, sem unicidade; `sku` editável; sem cadastro fiscal do produto; a **tabela fiscal legada não foi anexada** (não analisada). Proposta de `product_barcodes` aguarda aprovação. |
| **Testes (2026-10-14):** API unitários **1100/1100 (110 suítes)**; integração completa **1473/1474** na execução inteira (a única falha foi a varredura estática `destructive-guard` apontando a limpeza do meu teste novo; corrigida e **reexecutada isolada: 26/26** nas três suítes afetadas — a suíte completa não foi repetida depois da correção); Admin Web **548/548**; PDV lógica **28/28**; Balcão lógica **9/9**; `tsc` limpo em API, Admin Web, Balcão e PDV; lint API 0 erros (9 avisos); `db:check-rls` OK; links 474/0 quebrados. |

## Fase final — aplicativo Balcão, auditoria e preparação para produção (2026-10-13)

Detalhe em [APLICATIVOS](APLICATIVOS.md), [SECURITY](SECURITY.md#aplicativo-balcão-2026-10-13), [PRODUCAO](PRODUCAO.md) e decisões 115 a 117 ([DECISIONS](DECISIONS.md)). **Nenhum teste de carga, estresse ou saturação foi executado**; nada foi enviado a repositório remoto.

| O quê |
|---|
| **Balcão é aplicativo próprio (`apps/balcao`)**, separado do PDV (caixa) e do Web/Admin (administração): Vite + React + TS, :5174, identidade e sessão próprias, `X-Client-Source: BALCAO`, endereço da API fixado no build e recusado sem https em produção. Telas: login (MFA), atendimento, cliente, veículo, produtos/disponível, orçamentos (lista, novo, detalhe), OS (lista, detalhe). **Substitui** as frases "o Balcão é o PDV Desktop" e "não existe aplicativo Balcão". |
| **Backend (para o Balcão, sem regra paralela):** `GET /api/stock/availability` (saldo − reservas vivas por filial, produto da empresa ou 404); filtros `customerId`/`motorcycleId` em `GET /api/service-orders` (histórico por cliente/veículo); CORS e `env` com `BALCAO_URL`. Orçamento, OS, cliente, veículo e produto usam as rotas existentes. |
| **Achado de segurança corrigido:** `GET /api/products` (lista, `/search/:code`, `/:id`) devolvia **`costPrice` a qualquer usuário autenticado**. Agora só SUPER_ADMIN, COMPANY_ADMIN e MANAGER o recebem. |
| **Compartilhado:** `packages/shared/utils/server-url.ts` (regra do endereço do servidor, usada por PDV e Balcão; o PDV passou a reexportá-la). |
| **Separação provada por teste:** `domain-separation.test.ts` (6): o Balcão não chama escrita em pagamento/caixa/venda/fiscal, não tem termo tributário e não importa o PDV; o PDV não importa o Balcão. |
| **Encaminhamento ao caixa:** ficha (copiar/imprimir) com o total oficial do servidor; importação automática no PDV = **decisão 115** (o modelo não tem "venda aguardando pagamento"). |
| **Infraestrutura:** `apps/balcao/Dockerfile` + `nginx.conf`, serviço `balcao` no `docker-compose.yml`, `balcao.<domínio>` no staging/Caddy, `BALCAO_URL` no `.env.example`, Balcão no CI (type-check, testes de lógica, build) e `package-lock.json`. **Não executado:** `docker build`/`compose up`, HTTPS real, domínio (sem Docker nem domínio nesta máquina). |
| **Parcelamento:** regra mantida (centavos; resto para as últimas parcelas; 100/3 = 33,33 + 33,33 + 33,34; 10/3 = 3,33 + 3,33 + 3,34; 100,01/3 = 33,33 + 33,34 + 33,34). O exemplo "R$ 0,01 em 3x = 0,00 + 0,00 + 0,01" **conflita** com a recusa de parcela zerada em vigor: não foi alterado (dinheiro) — **decisão 117**. |
| **Dispositivos:** nenhuma regra nova. `devices.requiredUserTypes` continua **vazia por padrão** (decisão 109); o corte do legado id/MAC é único em código, `.env.example` e docs (31/12/2026 23:59:59, Brasília). O Balcão não opera caixa e por isso não passa pelo portão (decisão 112 reescrita). |
| **Documentação:** APLICATIVOS reescrito; CODE_MAP, FRONTEND, CORTEX_BRAIN, MAPA_DE_ESTADO, DISPOSITIVOS, DIAGNOSTICO_PRODUCAO, DECISIONS, SECURITY, PRODUCAO, PARCELAMENTO e CURRENT_STATE atualizados; links conferidos (461, 0 quebrados). |
| **Testes (2026-10-13):** API unitários **1100/1100 (110 suítes)**; Admin Web **548/548 (32 suítes)**; PDV lógica **28/28**; Balcão lógica **9/9**; integração completa **1467/1467 (97 suítes)** — a primeira execução completa teve 14 suítes com `Too many database connections` (o servidor de desenvolvimento da API estava ligado e ocupava conexões do PostgreSQL portátil, fora o próprio teste); desligado o servidor, as 14 foram reexecutadas e passaram (98/98) — **não é defeito do código**: antes de uma rodada completa, desligue os servidores de desenvolvimento. `tsc --noEmit` limpo em shared, API, Balcão, PDV, Admin Web e Super Admin; lint da API 0 erros (9 avisos antigos); `db:check-rls` OK; builds de API, Admin Web, Super Admin, Balcão e PDV (renderer) OK. **Pendentes (ambiente controlado):** `docker build` das imagens, HTTPS real, carga/estresse/flood, restauração em outro host. |

## Fechamento consolidado — parcelamento, legado de equipamento, caixa por equipamento, HTTPS/staging, backup (2026-10-06)

Segue o ciclo de dispositivos abaixo; detalhe em [DISPOSITIVOS](DISPOSITIVOS.md), [PARCELAMENTO](policies/PARCELAMENTO.md), [FISCAL](policies/FISCAL.md), [APLICATIVOS](APLICATIVOS.md) e [DIAGNOSTICO_PRODUCAO §0](DIAGNOSTICO_PRODUCAO.md#0-fechamento-final-2026-10-06). **Nenhum teste de carga/estresse.**

| O quê |
|---|
| **Parcelamento em centavos (problema real):** `splitInstallments` usava ponto flutuante e dava o centavo que sobrava às **primeiras** parcelas (100,00 em 3x = 33,34 + 33,33 + 33,33). Agora é uma função única em `packages/shared/utils/installments.ts` (API e PDV), em centavos inteiros, o resto vai 1 centavo para as **últimas** (33,33 + 33,33 + 33,34), recusa parcelas 0/negativas/fracionárias, valor com fração de centavo e parcela menor que R$ 0,01 (`POST /payments`: `installments ≥ 1`, `amount` em centavos exatos). O PDV mostrava `total / n` ("3x de R$ 33,33", escondendo o centavo): agora usa a mesma função. Provado por 20 testes unitários (inclui varredura de 20.000 valores × 12 parcelas, soma exata), integração (cartão e folha do convênio gravados somam o total) e 3 testes do PDV. |
| **Domínios (Venda → Parcelas → Liquidação → Fiscal):** protegidos por teste estático (`domain-separation.test.ts`, 5): só a rota fiscal chama o serviço fiscal; parcelas/pagamento/venda sem tributo; `Sale`/`SaleItem`/`Payment` sem coluna tributária; PDV sem campo tributário. **IBS, CBS e Split Payment não existem** e nada parcial foi inventado (dependem de regulamentação e provedor: decisão 113). |
| **`devices.requiredUserTypes` (lista vazia = fallback permissivo):** exigir equipamento no **login** trancaria o uso legítimo do mesmo perfil no Admin Web (que não cria venda/pagamento/caixa). A exigência foi para a **operação de caixa** (`middleware/device.ts`: `POST /sales`, `/payments`, `/cash-register/{open,close,movement,withdrawal}` → `403 DEVICE_REQUIRED` sem sessão de equipamento), que não depende de o cliente "se declarar terminal". O login deixou de recusar por política (o que informa equipamento continua estrito). Padrão ainda **vazio** (transição; decisão 109), agora documentado como **não adequado a go-live** e testado nos dois estados, por empresa. |
| **Legado de equipamento por id/MAC (clonável):** só aceito em `POST /auth/login`; agora com **conjunto fechado** (só equipamento criado antes de 2026-10-07) e **data de corte** (`DEVICE_LEGACY_CUTOFF`, padrão 31/12/2026; depois `403 DEVICE_REENROLL_REQUIRED`), evento `DEVICE_LEGACY_LOGIN` a cada uso. Testado (unitário + integração). |
| **HTTPS/staging:** cadeia TLS real local provada (proxy com certificado autoassinado → API: validação padrão recusa o certificado, HTTP direto 426, sonda 200); testes de `trust proxy`/`X-Forwarded-Proto`. `docker-compose.staging.yml` + `Caddyfile` agora cobrem API, Admin Web e Super Admin (`api.`/`admin.`/`super.<domínio>`), com portas fechadas e URLs montadas do domínio; `next build` de produção dos painéis recusa `NEXT_PUBLIC_API_URL` não-https (exceto localhost). **Corrigido:** o `docker-compose.yml` passava a URL sem `/api` ao Admin Web (que a usa como base → 404 em tudo). Certificado real/Caddy/Docker: **não executados** (sem domínio nem Docker). |
| **Backup/restore:** `backup:verify` reexecutado (18/18: dump, `pg_restore`, 24 tabelas iguais, RLS 102/116, constraints/índices, RLS funcional, segredos cifrados) e procedimento de recuperação documentado ([PRODUCAO §7](PRODUCAO.md#7-backup-e-recuperação)). Homologação em staging, backup contínuo, cópia fora do host e alerta: **pendentes**. |
| **Aplicativos:** diagnóstico em [APLICATIVOS](APLICATIVOS.md): PDV = `apps/pdv-desktop` (frente de caixa); **(superado em 2026-10-13: o Balcão passou a ser o aplicativo próprio `apps/balcao`)** — na época não havia aplicação nem APK Balcão (Balcão = atendimento no Admin Web + perfil); a frase do ciclo anterior "o Balcão é o PDV desktop" foi corrigida. |
| **Testes (final):** API unitários **1098/1098** (110 suítes); integração **1457** testes em 96 suítes (duas execuções completas; em cada uma 1 suíte teve falha **intermitente de corrida/dados, fora do código alterado** — `support` na 1ª e `agenda-capacity` na 2ª —, e as duas passam 3× seguidas isoladas, 50/50); Admin Web 548/548; PDV lógica 28/28; `tsc` limpo (api, shared, admin-web, super-admin, pdv, mobile, tv); lint API 0 erros; `db:check-rls` OK; builds de Admin Web e Super Admin OK; PDV `vite build` OK; links 442/0. Decisões novas: 113, 114. |

## Fechamento final — autorização de dispositivos, HTTPS e conexão automática (2026-10-06)

Detalhe em [DISPOSITIVOS](DISPOSITIVOS.md) e [DIAGNOSTICO_PRODUCAO](DIAGNOSTICO_PRODUCAO.md#0-fechamento-final-2026-10-06). **Nenhum teste de carga, estresse ou saturação foi executado** (restrição do ambiente corporativo).

| O quê |
|---|
| **Problema real corrigido (segurança):** a autorização de equipamento **não valia nada no login** — `deviceId` era opcional e um equipamento desconhecido ou pendente entrava assim mesmo (sem sessão de equipamento); a identidade era o MAC/hostname; revogar/bloquear não derrubava a sessão aberta nem a renovação. Agora o login só passa com equipamento **da empresa do usuário, ATIVO, com a chave certa e da filial do usuário**; bloquear/revogar encerra a sessão e as renovações **na mesma transação** e o token (`dsid`) é conferido a cada requisição. |
| **Entrada de equipamento novo (não existia):** `POST /api/device/enroll` e `/status` (públicas, sem dado de negócio, limite por IP, erro uniforme) → o administrador (Super Admin → Dispositivos) vê a fila com o código, escolhe licença e filial e **autoriza** (`POST /api/activations/enrollments/:id/authorize`, auditado). Chave só como hash SHA-256 no banco. Migração `20261006200000_device_enrollment`. Política `devices.requiredUserTypes`. |
| **PDV (frente de caixa):** portão `DeviceGate` ("Dispositivo aguardando autorização" com código), credencial guardada com `safeStorage`, login com id + chave, recusa endereço sem HTTPS em produção. Mobile e TV: build de produção sem URL https falha na partida. **Não existe "APK Balcão" no repositório.** |
| **HTTPS:** em produção a API responde 426 a HTTP puro (exceto sondas) e não sobe sem `TRUST_PROXY` (ou `ENFORCE_HTTPS=false` explícito); `docker-compose.staging.yml` + `deploy/Caddyfile` (proxy com TLS automático, porta da API fechada) **preparados e não executados**. |
| **Correções de efeito colateral (achadas pelos testes):** recusa por equipamento não autorizado não conta como tentativa de senha no limitador por IP (senão um PDV pendente bloquearia a loja); renovação recusada de equipamento encerrado não aciona a detecção de token roubado (não derruba as outras sessões do usuário). |
| **Testes novos:** `device-authorization.integration` (32), `https.test` (4), `env.test` (+1), `device-enrollment.test` do PDV (5); `pdv-device-login` atualizado (equipamento desconhecido agora é recusado — o teste antigo codificava o comportamento inseguro); `auth-coverage` com as 2 rotas públicas novas. Script de fumaça para staging: `scripts/smoke-device-flow.js`. |
| **Pendências novas:** 109 a 112 (perfis que exigem equipamento, corte dos legados, portão no mobile/TV, APK Balcão/domínio). |

## Fase 4 — auditoria e preparação técnica para produção (2026-10-06)

Auditoria sistemática de segurança, banco, estoque/financeiro, Redis/BullMQ, jobs, Gateway, Commerce API, observabilidade, saúde, desligamento, configuração, deploy, backup, CI e telas. Veredito e riscos em [DIAGNOSTICO_PRODUCAO](DIAGNOSTICO_PRODUCAO.md); runbook em [PRODUCAO](PRODUCAO.md). **Nenhum teste de carga, estresse ou saturação foi executado** (restrição do ambiente corporativo).

| O quê |
|---|
| **Segurança (2 vulnerabilidades reais):** (1) a **credencial de 10 anos do dispositivo do PDV** (mesma chave de assinatura, sem usuário) era aceita como sessão e lia as rotas da empresa; `verifyAccessToken` agora exige `userId`/`userType`, recusa `deviceId`/`licenseId` e fixa HS256. (2) o **login revelava quais e-mails existem**: conta desativada/bloqueada era dita antes de conferir a senha e e-mail inexistente respondia na hora; agora a senha é conferida primeiro (custo equalizado) e o estado da conta só é dito a quem acertou. Provados por testes de regressão. Também: cobertura de autenticação de **todas as 389 rotas** por teste que percorre a árvore real do Express. |
| **Resiliência:** auditoria **durável** (com o Redis fora, a fila não confirma em 1,5 s → gravação direta no PostgreSQL com o mesmo id, idempotente); **desligamento ordenado** único (antes dois handlers de SIGTERM disputavam e o de `queue.ts` dava `exit(0)` matando requisições; workers e Redis nunca eram drenados); sondas `live`/`ready`/`health` com prazo de 2 s, estado "drenando" e sem a mensagem do erro; `ENABLE_SCHEDULER` e `ENABLE_AUTO_BACKUP` agora são honrados. |
| **Configuração:** `config/env.ts` valida a partida (em produção recusa subir com senha de exemplo, segredos ausentes ou iguais, `TRUST_PROXY=true`; avisa HTTP, Redis sem senha, banco sem TLS, provedor simulado ligado); `TRUST_PROXY` configurável; log de acesso com `requestId`/empresa/filial/usuário e sem query string. |
| **Infra/CI:** `docker-compose.yml` sem senha escrita e com portas só em loopback; CI corrigido (migração sem `DATABASE_URL`, Admin Web sem testes, sem `db:check-rls`, sem verificação de links); build do Admin Web **valida tipos e lint** (8 erros de lint corrigidos; `next build` real passou); cabeçalhos de segurança nos dois fronts. |
| **Testes novos:** 39 unitários (configuração, desligamento, sondas, auditoria durável) e 17 de integração (cobertura de autenticação, confusão de tokens, auditoria idempotente, enumeração de login). Regressão: API unitários 1056/1056 (105 suítes), integração 1407/1407 (94 suítes), Admin Web 548/548, `tsc` limpo em todos os pacotes, `db:check-rls` OK (102 tabelas FORCE, 116 policies), 402 links, builds da API e do Admin Web. |
| **Pendências novas:** 106 (RPO/RTO/retenção), 107 (janela de sessão revogada com Redis fora), 108 (token em `localStorage` e CSP). |

## Fase 3 — Integration Gateway (2026-10-06)

Terceira fase do [ROADMAP](ROADMAP.md#sequência-oficial-de-evolução), conforme [INTEGRATION_GATEWAY](INTEGRATION_GATEWAY.md). **Nenhum provedor real, nenhuma credencial real, nenhuma chamada externa**: só o provedor simulado, que não existe em produção. Nenhuma regra comercial inventada (pendências 103 a 105).

| O quê |
|---|
| **Banco:** migração `20261006100000_integration_gateway` (aditiva, reversão documentada, RLS `FORCE`): `channel_outbox`; colunas de reprocessamento em `channel_inbound_events`; `sales_channels.inboundCursor`. 102 modelos, 48 enums, 30 migrações. |
| **API:** webhook `/integrations/v1/webhooks/:channelId` (assinatura HMAC com janela, mesmo 401, bloqueio de IP, limite por canal, esquema fechado, idempotência, fora de ordem, correlação); caixa de saída com envio por job (espera crescente, 429/4xx/401/5xx tratados por classe, disjuntor, prazo de 24 h, trava para instância que caiu); consulta periódica; sincronização sob demanda; escolha de provedor ao criar o canal; rotas administrativas da fila. |
| **Corrigido no que já existia:** (1) o catálogo da Commerce API mostrava o **saldo físico** em vez do **disponível** (saldo − reservas), lacuna da Fase 2: o canal podia ver estoque que já estava reservado; (2) o tratador de erros das superfícies públicas foi unificado; (3) o aceite automático passou a ser uma função só, usada pela Commerce API e pelo gateway. |
| **Tela:** painel "Integração" no canal com provedor (endereço do webhook sem segredo, contagens e linhas da fila, reenviar/cancelar, enviar estoque/preço/catálogo). |
| **Testes:** 36 de integração novos (`integration-gateway`), 14 unitários da API (mais 2 do teste de jobs agendados), 2 do Admin Web; regressão: API unitários 1032/1032, integração completa 90 suítes / 1390 testes, Admin Web 548/548, `db:check-rls` OK (102 tabelas com RLS `FORCE`, 116 policies). |

## Fase 2 — Reserva de estoque e conversão de pedido em venda (2026-10-05)

Segunda fase do [ROADMAP](ROADMAP.md#sequência-oficial-de-evolução), conforme [COMMERCE_API](COMMERCE_API.md#fase-2--reserva-de-estoque-e-conversão-em-venda-feita). Nenhuma integração real; nenhuma regra comercial inventada (prazo, momento da venda, estorno, fiscal e comissão ficam pendentes: 95 a 102).

| O quê |
|---|
| **Banco:** migrações `20261005200000_stock_reservations_and_channel_sales` e `20261005210000_stock_movement_user_optional` (aditivas, com reversão documentada, RLS `FORCE` empresa+filial): `stock_reservations`, `fulfillments`; `sales.userId`/`cashRegisterId` e `stock_movements.userId` opcionais **protegidos por `CHECK`** (só com `channelId`); `external_orders.saleId` único. 101 modelos, 47 enums, 29 migrações. |
| **API:** aceitar (reserva tudo ou nada, prazo obrigatório no canal), converter em venda (idempotente, pagamento confirmado, sem caixa físico), cancelar pedido aceito (libera reserva), fulfillment mínimo; job `expire-stock-reservations` por minuto; aceite e conversão automáticos existem desligados. |
| **Corrigido no que já existia:** (1) `createSale` travava os produtos na ordem de chegada (risco de deadlock entre vendas com os mesmos produtos em ordem oposta): passou a travar por id; (2) a lista de jobs agendados não conhecia o novo job (`scheduled-jobs.ts`; o teste `scheduled-jobs.test` pegou); (3) o balcão, a OS, as transferências e a devolução ao fornecedor passaram a conferir **saldo − reservas**; (4) testes de integração antigos faziam `updateMany` sem `companyId` (a varredura `destructive-guard` pegou) e a limpeza da fixture ganhou as tabelas novas na ordem certa de FK. |
| **Tela:** Canais → pedidos: Aceitar (reservar), Converter em venda, Cancelar (também aceito), entrega com próximos estados, número da venda. |
| **Testes:** 25 de integração novos (`commerce-reservations`), 4 unitários da API, 3 do Admin Web; regressão: API unitários 1016/1016, integração completa 89 suítes / 1354 testes, Admin Web 546/546, `db:check-rls` OK (101 tabelas com RLS `FORCE`, 115 policies). |

## Fase 1 — Commerce API (2026-10-05)

Implementação da Fase 1 do [ROADMAP](ROADMAP.md#sequência-oficial-de-evolução), seguindo [COMMERCE_API](COMMERCE_API.md). Nenhuma integração real; nenhuma regra comercial inventada (as pendências 83 a 94 seguem abertas).

| O quê |
|---|
| **Banco:** migração `20261005100000_commerce_api_foundation` (aditiva, RLS `FORCE` empresa+filial): `channel_api_credentials`, `channel_product_links`, `external_order_items`, `external_payments` e 6 colunas em `external_orders`. 99 modelos, 27 migrações. |
| **API:** `/commerce/v1` (catálogo publicado, pedido idempotente com preço oficial, cancelamento, consulta e eventos de pagamento) e administração em `/api/sales-channels/:id/{api-credentials,products,orders}`. Autenticação por credencial de canal (HMAC, escopos, janela de 300 s, limite por credencial e por IP). `Idempotency-Key` ganhou modo obrigatório e passou a funcionar com a empresa do canal. [Contrato OpenAPI](commerce-api.openapi.yaml). |
| **Corrigido no que já existia:** o tipo `SITE_PROPRIO` exigia um "teste de conexão" de provedor que não faz sentido (o site chama o CÓRTEX); passou a ficar `CONNECTED` na primeira chamada assinada válida. O desenho previa o segredo só com hash; o HMAC exige o segredo, então ele é guardado cifrado (`enc:v1`). |
| **Tela:** Canais de venda → painel "Commerce API" (credenciais com segredo mostrado uma vez, produtos publicados, pedidos recebidos) nos canais de site e "outro". |
| **Testes:** 43 de integração novos (Postgres e Redis reais), 17 unitários da API, 5 do Admin Web; regressão: API unitários 1011/1011, Admin Web 543/543, 6 suítes de integração relacionadas (RLS, idempotência, canais, painel gerencial, módulos) 77/77. |
| **Pendente de decisão do dono:** 83–92 (o que a Fase 1 faz de forma conservadora está em COMMERCE_API §0), 93 (LGPD do cliente final) e 94 (limites em produção). |

## Fase 1A — desenho da Commerce API e dos canais — 2026-10-05

Somente análise e documentação; **nenhum código, banco, schema, migração, endpoint, serviço, Redis ou BullMQ foi alterado**, nada foi executado.

| O quê |
|---|
| Novo [COMMERCE_API](COMMERCE_API.md): proposta de desenho das decisões 82 a 92, com os fatos do código verificados (15), 9 divergências/achados, as cinco máquinas de estado separadas (pedido, reserva, pagamento, venda, fulfillment), a arquitetura recomendada, o impacto (banco, API, serviços, Redis, BullMQ, RLS, auditoria, Dashboard, comissão, fiscal, pagamentos) e as listas de aprovação (técnica, produto, segurança, arquitetura). **Nada foi decidido.** |
| Achados: o "limite de 3 tentativas" não é regra do servidor (é o contador da fila offline do PDV); uma venda de canal não cabe no modelo atual (exige caixa e usuário internos e o pagamento mexe no caixa do balcão); `ExternalOrder.saleId` não tem chave estrangeira; aceitar pedido (Fase 1) depende de reserva (Fase 2). |
| `DECISIONS`, `ROADMAP`, `CANAIS`, `README`, `MAPA_DE_ESTADO`: apenas ponteiros para o novo documento. |

## Atualização da documentação mestre — 2026-10-05

Somente documentação; **nenhum código, banco, migração ou configuração foi alterado**, e nenhum teste de carga foi executado. Contexto: o inventário de 2026-10-05 achou documentos com números e afirmações de 2026-10-04.

| O quê |
|---|
| `MAPA_DE_ESTADO` e `CURRENT_STATE` reescritos para 2026-10-05, com o vocabulário IMPLEMENTADO / PARCIAL / PREPARADO / PENDENTE / DECISÃO PENDENTE / PRODUÇÃO; testes separados em "executados hoje" e "de rodadas anteriores". |
| `ROADMAP`: nova seção **Sequência oficial de evolução** (Fase 1 Commerce API, 2 reserva de estoque, 3 Integration Gateway e integrações reais, 4 produção, 5 auditoria dos processos); linhas antigas do Dashboard e dos gráficos corrigidas; 26 migrações. |
| `DECISIONS`: linha "Sequência oficial e princípios" em Tomadas; decisão 54 marcada como parcialmente respondida; **11 pendências novas (82 a 92)**: reserva de estoque, conversão de pedido externo em venda, Commerce API, comissão sobre venda, pagamento externo, cancelamento/devolução de pedido externo, sincronização de catálogo, de preço e de estoque, fulfillment e falha do provedor. Nenhuma foi decidida. Total de itens abertos: 74. |
| Contradições corrigidas: "canais não existem" (`MAPA_DE_ESTADO`, `AUDITORIA_PRODUTO`, `RELATORIO_MESTRE`, decisão 54); "o PDV não suporta MFA" (`SECURITY`); contagem de modelos, migrações e rotas (`DATABASE`, `ROADMAP`, `MAPA_DE_ESTADO`); números de teste (`CURRENT_STATE`, `FINAL_ACCEPTANCE`); permissões dos dashboards e canais (`permission-matrix`); módulo `CANAIS` e tabelas de canais (`module-license-matrix`, `tenant-branch-scope`, `audit-event-matrix`); `ARCHITECTURE`, `CODE_MAP`, `FRONTEND`, `README`, `CORTEX_BRAIN`, `POLICIES`, `DASHBOARD_GERENCIAL`, `CANAIS` e `COMISSAO`. O `RELATORIO_MESTRE_2026-10-04` ficou como histórico, com aviso. |
| Registrado, não corrigido: o dashboard antigo de SUPER_ADMIN, MECHANIC, OPERATOR e VIEWER ainda calcula a janela de 30 dias no navegador; RLS das 4 tabelas de canais não reverificada no banco real. |
| Os commits da frente Dashboard/Canais aparecem datados de 2026-10-04 e 2026-10-05 porque a rodada atravessou a meia-noite. |

## Homologação por perfil — 2026-10-04

Resultados, matriz de perfis, análise do bloqueio por IP e capacidade medida em [HML_HOMOLOGACAO](HML_HOMOLOGACAO.md).

| O quê |
|---|
| Login simultâneo não colide mais no token de refresh (antes 20 de 25 falhavam com 500). |
| Erro cru do Prisma (cliente de transação, `details`, caminho do disco) nunca chega à resposta; transação expirada vira 503 repetível. |
| Limite de login separa FALHAS (mesmo bloqueio de 60 min) de tentativas SIMULTÂNEAS (429 de 2 s): logins corretos em rajada não bloqueiam mais o IP. |
| Últimos itens da OS: trava da linha do produto na execução (estoque nunca −1); usuário excluído perde o token na hora. |
| Usuários HML novos: Balcão, Mecânico, Visualizador; suítes `profiles-extra` (118) e `ui-profiles` (Chrome, 7 perfis). |
| Ferramentas HML: processos filhos ocultos e rastreados (`lib/proc.js`), amostrador com fim garantido, trava de carga `LOAD_DISABLED`, teste de guarda (commit 7a1bc29). |
| Login com banco indisponível: 503 + `Retry-After` sem registrar `LOGIN_FAILED` e sem tratar erro do Prisma como credencial inválida (`isDatabaseUnavailableError`); teste novo, 3 dos 4 casos falham no código antigo. |
| Testes de integração de login isolam o limitador (`reset-auth-limits`); teste do refresh token redimensionado (12 logins, 6 renovações); eixo dos gráficos do painel legível. |
| Documentação: mapa de estado, levantamento de agentes de desenvolvimento, diagnóstico da queda do Postgres HML, auditoria de produto (canais externos), decisões 47–56. Evidências visuais de erro e bloqueio de login (e01–e03). |
| Regressão: API unitários 943/943, integração 1239/1239, Admin Web 495/495, `tsc` limpo; HML `rls.js` 26/26 e `invariants.js` 45/45. |
| **Painel (Admin Web) com identidade CÓRTEX:** evolução da receita em **linha** (escala de tempo, azul naval, pontos vazados, dica própria), categorias em **barras horizontais de uma cor**; azul vivo e cor por barra removidos (`--chart-1`/`--chart-3`); componentes em `components/charts/`; rótulos dos convênios; evolução também para Gerente e para empresa de uma filial (antes nunca aparecia). |
| API: `GET /api/dashboard/sales` ganhou `timeline` (soma real por dia, aditivo; testado). |
| Grupo A: `infra.js` espera o Postgres aceitar consultas e sobe com log; `rls.js` separa banco indisponível de banco sem tabelas; `ui-evidence.js` falha rápido, espera o painel e não sobrescreve; "Importar" some para o Visualizador (`canImportData`); `payments.js` fecha caixa aberto antes de abrir o seu; API HML com `connect_timeout=30`. |
| Regressão da rodada: API 943/943 e 1239/1239, Admin Web 508/508, PDV 20/20, `tsc` dos seis apps, `db:check-rls`, `backup:verify` (18), HML 185/121/37/26/45. |
| **Ajustes finais do painel:** evolução da receita com alternância **Linha \| Colunas** (mesma série, sem nova chamada à API; categorias seguem só em barras). **Decisão 58 aplicada:** o dia do painel é o de Brasília (`America/Sao_Paulo`) na evolução de vendas e do CEO e no "hoje" do PDV (antes UTC/relógio do servidor), e "Hoje"/"Mês atual" do front usam o mesmo fuso; testes da virada do dia (3 falham no código antigo). |
| **Dashboard gerencial implementado (2026-10-05):** período único resolvido só na API em Brasília (hoje, ontem, 7 e 30 dias, mês atual/anterior, ano, personalizado até 366 dias; período anterior por calendário; hora/dia/mês); `GET /dashboard/management/summary` e `/timeseries` (uma transação de leitura cada, agregação no PostgreSQL, RLS); KPIs com atual, anterior, diferença, % e melhora/piora; ticket = receita ÷ vendas distintas; formas de pagamento por vendas distintas; evolução receita/vendas/ticket (Linha padrão, Colunas, anterior tracejado, dica com detalhe por forma); origem das vendas (donut + tabela, só canais ativos); caixa e saques; operação no mesmo resumo. **Canais de venda**: tabelas `sales_channels`, `channel_events`, `external_orders`, `channel_inbound_events`, `Sale.channelId`, módulo `CANAIS` (único opt-in), gateway genérico, pedido externo idempotente que não vira venda, tela de administração; **sem integração real**. **Comissão**: política `commission.enabled`. **Correção de segurança**: `/dashboard/sales`, `/stock` e `/ceo` passam a negar OPERATOR e VIEWER (a tela já os escondia, a API entregava). Abrir o painel: 3 chamadas (antes 6); a rajada de conexões do primeiro carregamento (decisão 57) não ocorreu com o pool frio nesse desenho (0 erros 5xx; antes 4 × 503). [DASHBOARD_GERENCIAL](DASHBOARD_GERENCIAL.md), [CANAIS](CANAIS.md), [COMISSAO](policies/COMISSAO.md) |
| **Dashboard gerencial — varredura (2026-10-04):** inventário de 87 indicadores com origem, regra, escopo, perfis e situação; análise de desempenho (séries lidas no Node, RLS de `payments`, índices), de fuso (período calculado no navegador, período anterior deslizante, sem início de mês na API) e de RLS/RBAC (OPE e VIS alcançam `/dashboard/sales` e `/dashboard/stock` pela API); proposta de composição ADM/CEO com dois endpoints novos; decisões 60–81. **Nenhum código de produto alterado.** [DASHBOARD_GERENCIAL_VARREDURA](DASHBOARD_GERENCIAL_VARREDURA.md) |
| **Fechamento da homologação visual dos gráficos (2026-10-04):** a linha **interrompe onde não há dado** (decisão 59, `lib/chart-gaps.ts` + `stepMs`); "Requisições ao longo do tempo" agrupa por hora e dia **em Brasília** (decisão 58 concluída; SQL conferido no Postgres na virada de dia, mês e ano); dica sem animação, do lado com mais espaço e escondida até ser posicionada; rótulo "21/09 09h"; coluna que cabe sem encostar (3–18 px); zero sobe 10 px acima do eixo na Linha; ponto único com aviso. **`P1001`/`P2028` explicados** (Postgres no Windows cria conexões em série; painel abre 15–20; o pool encolhe parado), **não corrigidos** (decisão 57). Composição do painel do Admin segue **PENDENTE DE AVALIAÇÃO DO USUÁRIO**. Testes: API 39/39 nas suítes de observabilidade, monitoramento e fuso (inclui as 2 novas); Admin Web 226/226 nas suítes de gráfico e design (inclui `chart-gaps` e a paridade); `tsc` de API, Admin Web e Super Admin limpos; navegador: 25 trocas Linha ↔ Colunas com 0 requisição e sem recarregar, 0 erro 5xx. FECHAMENTO (evidência arquivada fora do repositório publicado: `docs/evidencias/2026-10-04-homologacao-graficos/FECHAMENTO.md`) |
| Gráficos de evolução no tempo **abrem em Linha** (padrão e ordem do controle em `lib/chart-mode.ts`, travados por teste que também confere que Colunas segue disponível, que a troca não chama a API e que nenhuma tela força Colunas). Categorias seguem só em barras. Admin Web: 516/516 (28 suítes), `tsc` limpo; validação no navegador reservada para a máquina de homologação. |
| **Padronização global dos gráficos:** auditoria de 10 gráficos (6 temporais, 4 categóricos). Um só componente temporal (`TimeSeriesChart`, uma ou várias séries, Linha por padrão ↔ Colunas) no Admin Web e no Super Admin; os 5 gráficos temporais do Super Admin (4 de monitoramento da filial e requisições ao longo do tempo) trocaram linha suavizada, grade tracejada e dica padrão pelo desenho do CÓRTEX e ganharam a alternância; rótulos de tempo no fuso de Brasília. Categóricos seguem em barras. Guardas: `chart-mode.test` e `chart-parity.test` (cópias idênticas entre os apps). Admin Web 522/522 (29 suítes), `tsc` do Admin Web e do Super Admin limpos. |
| Regressão dos ajustes finais: API 955/955 (97 suítes), Admin Web 512/512 (27), `tsc` API e Admin Web limpos, 4 suítes de integração do painel 139/139; navegador: 0 requisição ao alternar, 0 erro 5xx. |

## Central de Ajuda e Suporte — 2026-09-28 a 2026-10-04

Detalhes, regras e limites em [SUPPORT](SUPPORT.md).

| Commit | O quê |
|---|---|
| bbadab5 | Backend: chamados, mensagens, anexos, eventos e base de conhecimento (RLS FORCE, histórico append-only, busca em português, leitura da plataforma auditada, permissão `support:view_company`). |
| 0faf430 | Número de cartão completo (Luhn) recusado em chamado e mensagem. |
| 2e20f50 | PDV: "Relatar problema" com tela, caixa, venda e pagamento. |
| b3494f5 | Admin Web: Ajuda (busca, artigos), meus chamados, novo chamado com contexto, detalhe, contador de não lidos e botões em OS, garantia, cobrança e pós-venda. |
| 4c1ab7a | Super Admin: Console de Suporte (painel, chamados, base de conhecimento, categorias, responsáveis); sem "Configurações" por falta de endpoint. |
| 2651a53 | Achados da caminhada no navegador: PDV renova a chave de idempotência após recusa 4xx (422 ao reenviar); caminho de contexto sem repetição no novo chamado; página do console sem export inválido. Dois testes novos, vermelhos antes. |
| 55f34de | Testes de navegador no repositório (`apps/e2e`, 18/18; Chrome real, desenvolvimento + empresa demo, limpeza com `companyId` explícito). `demo:seed` cria uma garantia numa OS encerrada da Alfa (idempotente; repara a que uma execução anterior pusera em OS aberta). Fecha a lacuna dos botões "OS → Garantia" e "Pós-venda › Garantias". Nenhuma alteração de regra, de API ou de migração. |

## Consolidação das políticas — 2026-09-28

| Commit | O quê |
|---|---|
| dd0f6a0 | Migração da rodada (resumo do fechamento, convênio por filial, duração/mecânico da agenda, indisponibilidades, devolução ao fornecedor, `SUPPLIER_RETURN`) e políticas novas. |
| 8be1553 | Caixa: esperado × informado por forma de pagamento (todo o movimento, convênios incluídos), motivo com divergência, resumo gravado; PDV por forma. Convênios: autorização da administração, uso por filial, indisponível aparece cinza com mensagem humana. |
| d1e5ff9 | Devolução ao fornecedor (API, livro de estoque, Admin Web) e `withCompanyWideRead`, a única leitura ampliada filial→empresa (auditada, testada). |
| 268d597 | Agenda: capacidade configurável (duração, boxes, dia, mês, mecânico, indisponibilidades, disponibilidade por horário). |
| c45a6db | Ajustes visuais achados na caminhada real (tabela do fechamento, filtros da agenda). |

## Políticas por empresa/filial — 2026-09-27/28

Brief de políticas do dono transformado em regras configuráveis, auditadas, documentadas ([POLICIES](POLICIES.md)) e
testadas. Detalhe por área em `docs/CORTEX/policies/`; decisões em [DECISIONS](DECISIONS.md).

| Commit | O quê |
|---|---|
| 06ef69d | Fundação: catálogo de políticas (padrão → empresa → filial, motivo, histórico, auditoria), horário de funcionamento com exceções, cadastro real da empresa; migração única com todas as tabelas novas (RLS FORCE; `discount_events` e `collection_attempts` só leitura/inserção). |
| 532d52c | Admin Web: Configurações › Empresa (deixa de ser ilustrativa), Políticas e Funcionamento. |
| d5351dd | API: desconto 5%/0% com autorização e evento; fechamento de caixa com pendências e forçado; venda cancelada não recebe pagamento; fiscal não emite venda cancelada/pendente; orçamento vencido/encerrar/reabrir; agenda com autorização, capacidade e horário; garantia no encerramento; cadastro de cliente; convênios de funcionário e de empresa; cobrança manual. Correções: rotina de vencidas não marcava nada (sem contexto RLS); corridas de OS e de conta a receber em 409 PT-BR; pagamento da OS não grava total velho. |
| 220ea8f | Admin Web: convênios, cobrança, Conciliação, desconto e garantia da OS, pós-venda › Garantias, orçamentos, agenda, cliente. |
| 07dc644 | PDV: estados reais de pagamento ("não confirmado"), idempotência por tentativa, MFA no login, convênio no caixa, desconto autorizado, fechamento forçado; item em dobro, F10, foco do leitor, impressora aplicada. |
| 27f7bd2 | Mobile: concluir agendamento não confirmado com autorização. |
| 04df9c7 | Cadastro da empresa não salvava pela tela quando o endereço estava vazio (achado na caminhada real); mensagens com o nome do campo; pagamento de OS fora de PRONTO/ENTREGA em 409 PT-BR (escapava da tradução). |

## Continuação pós-rodada — 2026-09-25 a 2026-09-27

| Commit | O quê |
|---|---|
| 593d2cc | Exceção de pagamento: provedor aprova com a venda cancelada/devolvida → APPROVED + exceção, sem mexer na venda nem no caixa; tratamento por estorno confirmado ou registro manual. |
| 0871bf8 | Telemetria do PDV: versão do app (package.json) separada da versão do runtime (Electron/Node/Chrome). |
| ba2daab | Limites de monitoramento configuráveis pelo Super Admin (empresa/filial, teto, motivo, histórico, auditoria); alertas de API, latência, servidor, disco, rede, perda, equipamento offline, job atrasado, fila, banco e Redis, com deduplicação e fechamento automático. |
| ac12414 | Restauração de backup verificada de verdade (18 itens, banco temporário), role de backup dedicado; policy de `users` escondia mal os usuários da plataforma. |
| b7b6481 | Mensagens de erro em inglês chegavam ao operador: tradução na saída + teste que varre o código. |
| 2e7a4fa | Agenda: confirmação com canal e quem confirmou; transições com guarda; pós-venda e agendamento consistentes. |
| 5cbcac6 | Revisões: próxima data transbordava o mês; recomendação ao cliente; validações de data. |
| 1464f19 | Importação: lote rastreável por linha, simulação, duplicidade na planilha, CPF/CNPJ por dígitos, produto + estoque na mesma transação, limite de 5.000 linhas; planilhas brasileiras na tela. |
| 17d7278 | Performance: saldo de estoque no banco (371 ms → 34 ms com 20 mil movimentos), fim do N+1 no relatório, painel e jobs; "última compra" do cliente era uma venda qualquer. |
| 25ccf98 | Limites: `page` inválida derrubava listagens (500 e erro do Prisma com caminho de arquivo); rede de segurança na saída de erro. |
| ac7cc64 | Cancelamento/estorno comum de pagamento em exceção lançava saída de caixa sem entrada — recusado (achado pela regressão completa). |
| f6c4533 | Resiliência (caos controlado): limite de tentativas desligava com o Redis fora; banco fora respondia 400/401/500 culpando o usuário → 503. |
| 51c5970 | Limpeza: build da API recria `dist` (arquivos órfãos de fontes removidas); componente e dependência sem uso; log de depuração do Electron. |
| 60e9eec | Detalhe de erro interno vai ao log sem valores sensíveis. |
| (fechamento) | Migração de segredos `enc:v1` testada de ponta a ponta; CI com `DATA_ENCRYPTION_KEY` gerada por execução; diálogo de importação com recuo e rótulos em português; teste do limite geral espera a conexão Redis real; `zustand` declarado na TV. |
| (docs) | Documentação consolidada em `docs/CORTEX/` (14 documentos + aceite final), contratos e histórico movidos sem perda, referências quebradas a `docs/ln-system` removidas do código, 113 links conferidos. |

## Rodada de finalização e continuação — 2026-09-24/25

Contratos normativos, marca CÓRTEX (paleta oficial, Montserrat, 404), jornadas reais (PDV, balcão/oficina, mecânico),
dinheiro com troco e cédulas, pagamento por provedor com intenção primeiro e reconciliação, monitoramento com telemetria
real, tema escuro e layout de telefone no Super Admin, revogação imediata de access tokens, segredos cifrados.
Commits de 8ac7a0b a a2684b9 (lista completa: `git log 004c221..a2684b9`); detalhe no registro de auditoria §H.

## Auditoria integral — 2026-09-21

Isolamento por filial em pagamentos/comissões/contas, contexto obrigatório do Super Admin, cache com escopo, PDV
empacotado funcionando, proteção do banco de desenvolvimento contra testes destrutivos, tenant de demonstração.
Detalhe: registro de auditoria §F e §G.

## Base — 2026-09-14

Commit inicial do código existente ("LN System"). Os documentos da época estão em [historico/](historico/) e **não**
descrevem o estado atual.
