# CÓRTEX — Produção: configuração, deploy, rollback e operação

> **Estado (2026-10-06):** documento de **preparação**. Nada aqui foi executado em produção nem em staging: não há infraestrutura real, Git remoto, domínio, HTTPS, banco/Redis gerenciados, Docker nem CI remoto neste ambiente. O que é **verificado** (testes reais contra PostgreSQL e Redis locais) está marcado como tal; o que é **procedimento a executar** está marcado como "a executar". O veredito de prontidão está no [DIAGNOSTICO_PRODUCAO](DIAGNOSTICO_PRODUCAO.md).

## 1. Topologia alvo

```
 navegador / PDV / app ─HTTPS─► balanceador (TLS, WAF opcional) ─► API ×2+ (Node 20; HTTP + workers BullMQ + agendador)
                                                                      ├─► PostgreSQL 18 gerenciado (TLS, backup, PITR, réplica opcional)
                                                                      └─► Redis 7 gerenciado (senha, rede privada; só cache, sessão, limites, filas)
 Admin Web e Super Admin: Next.js `standalone` (imagens próprias) atrás do mesmo balanceador; **Balcão**: SPA estática em nginx (`apps/balcao/Dockerfile`, `balcao.<domínio>`), só fala com a API
```

- **PostgreSQL é a fonte da verdade** (dinheiro, estoque, vendas, pagamentos, auditoria). Redis guarda só o que pode ser reconstruído ou perdido sem dano ao negócio (cache, sessão/revogação, contadores de limite, filas, trava de apoio).
- A API é **sem estado** entre requisições: pode ter N instâncias. Cada instância também roda os workers e registra as rotinas recorrentes (idempotente: `jobId` fixo). `ENABLE_SCHEDULER=false` numa instância desliga só o registro das rotinas nela.
- **O que existe no repositório:** `docker-compose.yml` (desenvolvimento/homologação em um host, não é produção), **`docker-compose.staging.yml` + `deploy/Caddyfile`** (homologação **com HTTPS**: proxy com certificado automático à frente da API, porta 3001 fechada — §11), Dockerfiles da API, do Admin Web e do Super Admin, `.github/workflows/ci.yml`, `scripts/smoke-device-flow.js` (fumaça do fluxo de equipamento contra uma API real, §11). **Não validados com Docker nem no GitHub a partir daqui.**

## 2. Pré-requisitos (a executar)

| Item | Detalhe |
|---|---|
| Domínio e HTTPS | certificado válido no balanceador; HSTS no balanceador; API e web em origens HTTPS |
| PostgreSQL 18 | usuário **dono das tabelas** = usuário de runtime da API (senão as tabelas novas ficam sem permissão); `sslmode=require` na URL; role de backup dedicado com `BYPASSRLS` + `pg_read_all_data` |
| Redis 7 | senha, rede privada, persistência (AOF) opcional; nada de negócio depende dele |
| Segredos | cofre (secrets manager): `JWT_SECRET`, `JWT_REFRESH_SECRET` (diferentes), `DATA_ENCRYPTION_KEY` (guardada **junto do backup**, fora do repositório), senhas de banco/Redis, `BACKUP_DATABASE_URL` |
| Proxy | `TRUST_PROXY` com o número de saltos do balanceador |
| Monitoramento | coleta dos logs da API e alertas (§8) |
| Git remoto + CI | repositório remoto, proteção de branch exigindo os checks do `ci.yml` (hoje **não há remoto**) |

## 3. Configuração (variáveis de ambiente)

A API **valida a configuração na partida** (`apps/api/src/config/env.ts`). Em `NODE_ENV=production` um erro **impede a subida** (falha fechada, com todos os erros de uma vez e **sem imprimir valor de segredo**); fora de produção só avisa. Verificado por testes unitários.

| Variável | Produção | Observação |
|---|---|---|
| `NODE_ENV=production` | obrigatória | liga a validação estrita, esconde o Swagger |
| `DATABASE_URL` | obrigatória | recusada se tiver senha de exemplo (`lnsystem123`, `password`...); aviso sem `sslmode=require` |
| `REDIS_URL` ou `REDIS_HOST` (+ `REDIS_PASSWORD`, `REDIS_PORT`, `REDIS_DB`) | obrigatória | senha de exemplo recusada; aviso sem senha |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | obrigatórias | fortes (mínimo exigido em `shared/utils/token.ts`), **diferentes** entre si; `JWT_EXPIRES_IN` (padrão 15 min) é a janela de validade de uma sessão revogada com o Redis fora (§8) |
| `DATA_ENCRYPTION_KEY` | obrigatória | 32 bytes em base64; perder = perder MFA/certificado cifrados |
| `TRUST_PROXY` | **obrigatória** (a API não sobe sem ela, salvo `ENFORCE_HTTPS=false`) | número de saltos (`1`), `loopback`/`linklocal`/`uniquelocal` ou IP/CIDR; **`true` é recusado** (qualquer cliente forjaria o IP); sem ela o limite de tentativas e o bloqueio por IP veem todos como o IP do balanceador **e a API não reconhece a conexão HTTPS** (`X-Forwarded-Proto`) |
| `ENFORCE_HTTPS` | padrão **ligado** em produção | `false` desliga a exigência de HTTPS (só rede interna sem TLS; a API avisa). Ver §11 |
| `DEVICE_LEGACY_CUTOFF` | opcional | data ISO do corte do **legado de equipamento sem chave** (padrão `2026-12-31T23:59:59-03:00`); inválida = a API não sobe. Ver [DISPOSITIVOS §8](DISPOSITIVOS.md#8-configuração-obrigatória-e-legado) |
| `WEB_URL`, `SUPER_ADMIN_URL` | recomendadas | origens CORS (HTTPS); sem elas nenhuma origem de navegador é liberada |
| `API_PORT` | opcional | padrão 3001 |
| `REQUIRE_MFA_PRIVILEGED` | opcional | Super Admin sem MFA recebe 403 `MFA_ENROLLMENT_REQUIRED` no login; **padrão ligado em produção**, `true`/`false` força (§13) |
| `REQUIRE_MFA_COMPANY_ADMIN` | opcional | administrador da empresa sem MFA recebe 403 `MFA_ENROLLMENT_REQUIRED` + credencial de configuração (configura na tela); **padrão ligado em produção**; `false` em produção **impede a API de subir** (decisão 123) |
| `PASSWORD_HASH_ALGORITHM`, `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`, `PASSWORD_LEGACY_BCRYPT` | opcionais | hash de senha: Argon2id por padrão (19456 KiB, 2, 1); `PASSWORD_HASH_ALGORITHM=bcrypt` reverte a gravação; `PASSWORD_LEGACY_BCRYPT=false` desliga o custo extra de bcrypt quando não restar hash `$2…` no banco. **Medir** o tempo no hardware real (alvo 50–100 ms) e dimensionar a memória pela concorrência de login (decisão 121) |
| `AUTH_REDIS_TIMEOUT_MS`, `AUTH_DB_TIMEOUT_MS` | opcionais | prazos da checagem de revogação de sessão (750 e 3000 ms); estourar = cai para o PostgreSQL / 503 (decisão 107) |
| `PRIVACY_FISCAL_RETENTION_YEARS` | opcional | anos de retenção do nome e CPF/CNPJ de cliente com documento fiscal autorizado ao anonimizar (padrão 5; **confirmar com o contador/jurídico**; decisão 120) |
| `ALLOW_SUPER_ADMIN_BOOTSTRAP` | **só durante** o procedimento | `true` libera `npm run admin:bootstrap` em produção; remover depois (§13). Nunca guarda senha |
| `COMMERCE_RATE_LIMIT_PER_MIN`, `COMMERCE_AUTH_FAILURES_PER_MIN` | opcionais | 300 e 20 por padrão; sem medição com tráfego real (decisão 94) |
| `CHANNEL_SANDBOX_PROVIDER` | **deixar vazio** | `true` registra o provedor SIMULADO em produção; a API avisa no log. Nenhum provedor real existe |
| `BACKUP_DATABASE_URL` | obrigatória se `ENABLE_AUTO_BACKUP` ≠ `false` | role de backup; sem BYPASSRLS o backup sai vazio e o job falha com mensagem clara |
| `ENABLE_SCHEDULER`, `ENABLE_AUTO_BACKUP` | opcionais | `false` desliga o registro das rotinas / o backup semanal da própria API (agora são honrados; antes eram ignorados) |
| `DEFAULT_TRIAL_DAYS`, `LOG_LEVEL`, `LOG_FILE_PATH`, e-mail/SMS/pagamento/fiscal | opcionais | integrações reais não existem (modo manual honesto) |

Os prazos do desligamento são constantes em `config/shutdown.ts` (25 s no total). `docker-compose.yml` não traz mais senhas: `POSTGRES_PASSWORD`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `DB_BACKUP_PASSWORD`, `REDIS_PASSWORD` e `BACKUP_KEY_FILE` são obrigatórias no `.env` (o compose recusa subir sem elas) e as portas do banco e do Redis só escutam em `127.0.0.1`. Desde 2026-10-16 o compose **separa os papéis do banco** (decisão 148): nenhum serviço usa o superusuário `POSTGRES_USER`; `migrate` usa o dono, `api` o papel de execução e `backup` o papel de leitura. **Não validado com `docker compose config`/`up`** (sem Docker aqui — o pipeline de papéis foi reproduzido fora do Docker, §16).

## 4. Banco de dados

- **Migrações:** **57** (14 da revisão do banco de 2026-10-14/15, 2 da finalização de 2026-10-16 — escopo por filial e travas de privilégio —, a `20261018100000_user_password_change`, senha temporária, de 2026-10-18, e as 2 da Central de Monitoramento de 2026-10-19 — `20261019100000_monitoring_central` e `20261019110000_monitoring_alert_events_company_index`; lista e decisões 124–150 em [DECISIONS](DECISIONS.md); inventário em [BANCO_DE_DADOS](BANCO_DE_DADOS.md)), cada uma com problema, guarda e reversão no cabeçalho. **Atenção:** `20261014170000_refresh_tokens_hash_and_company` troca `refresh_tokens.token` por `tokenHash` — **reiniciar a API logo depois** (o código novo lê o hash; as sessões existentes continuam valendo) — e as migrations de FK têm **guarda de dados**: se abortarem (`FKs … abortadas: N linha(s)`), **não** forçar: corrigir o dado por procedimento documentado, `prisma migrate resolve --rolled-back <migration>` e reaplicar ([RELATORIO_MIGRATIONS §4](RELATORIO_MIGRATIONS.md)). Aplicar com `npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma` **usando o usuário dono das tabelas**. Nunca `migrate dev`/`db push` em produção; nunca editar o banco à mão.
- **Depois de migrar:** `npm run db:check-rls` (em `apps/api`, com `DATABASE_URL` do alvo). Verificado no banco de desenvolvimento em 2026-10-06: **102 tabelas com RLS `FORCE`, 116 policies, "todas as invariantes de RLS OK"**; o mesmo verificador roda no `rls-invariants.integration` e no CI.
- **Três papéis no banco (compose desde 2026-10-16 — decisões 132 e 148):** `deploy/postgres-init/10-roles.sh` (1º start do volume) cria **dono**, **execução** e **backup**; o serviço `db-grants` roda `deploy/postgres-init/after-migrate.sql` depois de cada `migrate deploy`. **Sem isso a API roda como o superusuário da imagem oficial e a RLS é ignorada.** Para um banco que já existe, aplique à mão `deploy/db-runtime-role.sql`. Detalhe do modelo anterior, ainda válido: o **dono** das tabelas só roda `migrate deploy` (`DATABASE_URL=<url-do-dono> npx prisma migrate deploy …`); a API em execução usa um papel **sem posse e sem DDL** (modelo e `GRANT`s em `deploy/db-runtime-role.sql`; repetir os `GRANT`s — ou `ALTER DEFAULT PRIVILEGES` — depois de cada migration que crie tabela). Prova antes de adotar: `CORTEX_DB_ADMIN_URL=<superusuário> npm run db:role-split-check -- --suites` (banco e papel temporários; resultado em `docs/CORTEX/revisao-banco/role-split-resultado.md`). Sem esse papel, quem executar SQL arbitrário com o papel da aplicação consegue `ALTER TABLE … DISABLE ROW LEVEL SECURITY`.
- **Fuso do banco = UTC:** a migration `20261015150000` executa `ALTER DATABASE <banco> SET timezone TO 'UTC'` (só novas sessões; reiniciar a API/pool). Se o papel que migra **não** for dono do banco ela só avisa — o DBA executa `ALTER DATABASE "<banco>" SET timezone TO 'UTC';` e confere com `SHOW timezone` numa sessão nova.
- **FK `NOT VALID` (legado):** uma FK pode ficar `NOT VALID` quando existe linha de **empresa que não existe mais** (sobra de teste/limpeza antiga; no dev, 1 recebível). A migration **não** apaga nem associa a linha a empresa alguma. Listar: `SELECT conrelid::regclass, conname FROM pg_constraint WHERE contype='f' AND NOT convalidated;`. Tratar cada linha com o dono do negócio (arquivar/excluir com autorização) e só então `ALTER TABLE … VALIDATE CONSTRAINT …` (como Super Admin: `set_config('app.user_type','SUPER_ADMIN',true)` na mesma transação).
- **Excluir filial/empresa/venda com histórico passa a ser recusado pelo banco** (`ON DELETE RESTRICT`): a API responde **409** (`BRANCH_IN_USE`, `RECORD_IN_USE`) — desativar em vez de excluir. Livros de estoque, caixa, política e histórico de OS são **append-only** (UPDATE negado; DELETE só de Super Admin com `app.audit_purge = on` na mesma transação — nunca por rotina de negócio).
- **Retenção** (já existente, por env): `AUDIT_LOG_RETENTION_DAYS` 90, `SYSTEM_LOG_RETENTION_DAYS` 90, `REQUEST_LOG_RETENTION_DAYS` 30, `TELEMETRY_RETENTION_DAYS` 30, `INCIDENT_RETENTION_DAYS` 365; `Idempotency-Key` expira em 24 h (e o job expurga as vencidas). **Prazos aguardam aprovação do dono/jurídico** (decisão 141).
- **Reversão de migração:** o caminho de produção é **restaurar o backup tirado antes da migração** (as migrações são só para frente). Os comentários `ROLLBACK` de cada arquivo servem de apoio e dizem quando a reversão manual é segura.
- **Pool de conexões:** não alterado (decisão 57 pendente: medir em Linux). Ao dimensionar, ajustar `connection_limit` e `pool_timeout` na `DATABASE_URL` por instância de API (instâncias × limite ≤ `max_connections` do banco).

## 5. Saúde e desligamento

| Sonda | Rota | Responde |
|---|---|---|
| Vida | `GET /api/health/live` | 200 se o processo responde; **não** consulta dependência (banco fora não reinicia a API); continua 200 enquanto drena |
| Prontidão | `GET /api/health/ready` | 200 com PostgreSQL, Redis e workers de pé; 503 `{status:'not ready', failing:[...]}` (só o nome da dependência, nunca a mensagem do erro); **503 `draining`** durante o desligamento |
| Detalhe | `GET /api/health` | estado de banco, Redis, fila e workers; 503 se algo estiver fora ou drenando |

Cada verificação tem prazo de 2 s (nunca pendura). Use `live` para reinício e `ready` para tirar a instância do balanceador.

**Desligamento ordenado** (`config/shutdown.ts`, SIGTERM/SIGINT): marca "drenando" (a prontidão vira 503) → para de aceitar conexões e fecha as ociosas → as requisições em andamento terminam (conexões que sobrarem são derrubadas depois de 10 s) → fecha workers (esperam o job ativo) e filas → Redis (cache e limitador) → PostgreSQL → `exit(0)`; prazo total 25 s, cada fechamento 8 s, falha em um não impede os seguintes (`exit(1)` e registro). Configure o orquestrador com **`terminationGracePeriod`/`stop_grace_period` ≥ 30 s** e, se possível, aguarde alguns segundos entre tirar da rotação e enviar o SIGTERM. **Verificado** com servidor HTTP real e fechamentos simulados; o **sinal real SIGTERM não existe no Windows**: o teste com o processo completo é **a executar em Linux/staging**.

## 6. Deploy (a executar)

1. **Congelar e conferir:** `git status` limpo, tag da versão, CI verde (lint, tipos, testes unitários e de integração, `db:check-rls`, build, links da documentação, build das imagens).
2. **Backup:** dump com o role de backup (§7) **e** guardar a `DATA_ENCRYPTION_KEY` correspondente. Confirmar que o arquivo restaura (`npm run backup:verify` em staging).
3. **Migrar:** `prisma migrate deploy` + `npm run db:check-rls` contra o banco alvo, **antes** de subir a nova versão. Se falhar: parar; restaurar o backup se a migração tiver deixado o banco inconsistente.
4. **Subir a API** em rolagem, uma instância por vez: a nova instância só entra na rotação quando `/api/health/ready` responde 200; a antiga sai (SIGTERM, drenagem de §5). Atenção: a partida de uma instância recria as rotinas recorrentes (remove e adiciona com os mesmos `jobId`): pode pular **um** disparo de uma rotina curta durante a rolagem (inofensivo: todas são idempotentes).
5. **Subir Admin Web e Super Admin** (`NEXT_PUBLIC_API_URL` é fixado **no build**: a URL pública HTTPS da API).
6. **Smoke test** (sem carga, sequencial): `/api/health` 200 OK; login de um usuário de teste do tenant de homologação; listar produtos; abrir e fechar um caixa de teste; criar uma venda de R$ 1,00 e cancelá-la com o autorizador; abrir o painel gerencial; `GET /api/health/ready` com o Redis derrubado (esperado 503) e religado; conferir no log da API a linha de partida sem avisos de configuração inesperados.
7. **Observar** 30 min: erros 5xx, `Slow Request`, filas (jobs falhos), `DEAD` na caixa de saída dos canais, conexões do banco.

**Rollback (a executar):** (a) código: reimplantar a imagem/tag anterior (a API anterior continua compatível com o banco **enquanto as migrações forem aditivas**, que é a regra do projeto); (b) banco: só restaurar backup se a migração tiver sido destrutiva ou corrompido dado — perde o que foi gravado depois do backup; por isso a migração é feita em janela e com o backup imediatamente antes; (c) configuração: a validação de partida recusa subir com configuração inválida, então a versão antiga continua atendendo.

## 7. Backup e recuperação

**O que existe:** `BackupService` (pg_dump com o role de backup), rota do Super Admin, job semanal da própria API (domingo 02:00; desligável por `ENABLE_AUTO_BACKUP=false`; **retenção de 30 dias** no diretório `BACKUP_DIR`, na **mesma máquina**), e `npm run backup:verify` (backup real + restauração num banco **temporário** + comparação de tabelas, RLS, policies, constraints, índices, donos e migrações + teste de segredos cifrados). **Reexecutado em 2026-10-06 (dev, depois da migração de equipamentos): 18/18 OK** — backup gerado pelo `BackupService` (1,8 MB), `pg_restore --exit-on-error` sem erro, **24 tabelas de negócio com as mesmas linhas** (inclui `devices`, `_prisma_migrations=31`), RLS **102 FORCE / 116 policies** idênticas, constraints/índices/funções/donos idênticos, **RLS funcional no restaurado** (sem contexto: 0 usuários; com a empresa, só a empresa), segredos de MFA `enc:v1` abrem com a `DATA_ENCRYPTION_KEY` e **não** abrem com chave errada, arquivo sem segredo em texto puro, banco temporário removido. **Isso valida a integridade e a recuperabilidade do backup no ambiente de desenvolvimento; não é a homologação de produção/staging.**

**Desde 2026-10-16 (estratégia completa, estado real e evidências em [BACKUP_RECUPERACAO](BACKUP_RECUPERACAO.md)):** `deploy/backup/backup.sh` faz o backup completo diário às 00:00 (cifrado, com manifesto e SHA-256), a **verificação de integridade às 12:00 sem novo dump**, retenção 30/12/12 e alerta por gancho; o serviço `backup` do compose o agenda; `npm run backup:drill` restaura o arquivo gerado num banco isolado e confere 21 pontos (inclui a API subindo). Tudo **executado só em máquina de desenvolvimento, sem Docker**.

**O que NÃO existe (a configurar na infraestrutura):** destino **externo** do backup (`BACKUP_OFFSITE_CMD`) com bloqueio de objeto, canal de alerta que chegue a uma pessoa, WAL archiving/PITR ligado no servidor real (provado só em laboratório isolado), restauração em **outro host** e a **aprovação** de RPO/RTO/retenção (decisões 149 e 150).

**Procedimento de recuperação (DBA, nunca pela API; sempre num banco NOVO, nunca sobre o de produção em uso):** (1) anunciar a janela e **parar as instâncias da API** (ou tirá-las da rotação); (2) criar um banco vazio e restaurar nele o dump mais recente com `pg_restore --exit-on-error` (o `backup:verify` e o `backup:drill` rodam esta sequência num banco temporário; o dump leva dono e GRANTs, então os papéis do §4 precisam existir no servidor **antes** do `pg_restore`); (3) conferir **no banco restaurado**: `DATABASE_URL=<banco_novo> npm run db:check-rls` (todas as invariantes OK) e a contagem de `_prisma_migrations` igual à da versão em produção; (4) `prisma migrate deploy` se a versão do código for mais nova que o dump; (5) trocar a `DATABASE_URL` das instâncias para o banco restaurado **com a mesma `DATA_ENCRYPTION_KEY` do backup** (sem ela, MFA e certificados fiscais não abrem); (6) subir **uma** instância e esperar `/api/health/ready` 200, depois as demais; (7) fumaça: login de um usuário de teste e uma consulta de produto; (8) registrar RPO real (hora do dump × hora da falha) e RTO real. **Multiempresa/multifilial:** o dump é do banco inteiro (todas as empresas) e a RLS volta junto (provado no `backup:verify`); **não existe restauração de UMA empresa isolada** — se for preciso, restaura-se num banco paralelo e exporta-se só aquela empresa (procedimento manual de DBA). **Credenciais:** o role de backup (`BACKUP_DATABASE_URL`, BYPASSRLS + `pg_read_all_data`) e a `DATA_ENCRYPTION_KEY` ficam no cofre; o arquivo de backup nunca contém segredo em texto puro. **Não executado em staging/produção** (não há infraestrutura): a restauração periódica agendada, a cópia fora do host, o alerta de backup que falhou e o RPO/RTO medidos continuam **a executar**.

| Parâmetro | Recomendação técnica (a confirmar pelo dono — decisão 106) |
|---|---|
| RPO | ≤ 15 min (WAL/PITR do banco gerenciado) — **PENDENTE DE APROVAÇÃO**; com apenas o dump diário o RPO real é de até 24 h; o job semanal da API **não** atende isso: tratá-lo como cópia extra, não como estratégia |
| RTO | ≤ 1 h (restaurar o último dump + reaplicar WAL; trocar `DATABASE_URL`; `ready` 200) — **PENDENTE DE APROVAÇÃO**; medido só com volume de desenvolvimento (restauração 3,1 s; ensaio completo 30,4 s) |
| Retenção | diários por 30 dias, semanais por 12 semanas, mensais por 12 meses (ajustar à LGPD, decisão 93) |
| Teste de restauração | mensal em staging com `backup:verify`; a restauração de produção é procedimento de DBA, nunca pela API |
| Chave | `DATA_ENCRYPTION_KEY` guardada com o backup; sem ela MFA e certificados fiscais não voltam |

## 8. Observabilidade e operação

- **Rastreio:** toda requisição tem `X-Request-Id` (aceita o do cliente) e o log de acesso registra `requestId`, `companyId`, `branchId`, `userId`, método, caminho **sem query string**, status e duração; eventos de canal, caixa de entrada/saída e pedidos guardam a mesma correlação. Com isso se responde empresa, filial, canal, requisição, evento e etapa **sem dado sensível** (senha, token e segredo são cortados dos logs e da auditoria).
- **Alertas a configurar no coletor de logs** (padrões que a API já emite): `Slow Request Detected`; `Erro no Redis`; `Auto backup failed`; `OUTBOX_DEAD`, `PROVIDER_AUTH_FAILED`, `ORDER_NEEDS_REVIEW`, `INBOUND_EVENT_ORPHAN`, `PAYMENT_ON_CLOSED_ORDER` (eventos de canal); `UNHANDLED_REJECTION`/`UNCAUGHT_EXCEPTION`; jobs falhos das filas (`Job ... failed`).
- **Painel interno:** monitoramento e incidentes do Super Admin (`evaluate-health` a cada minuto).
- **Redis fora do ar** (comportamento projetado e testado; decisão 107): a API continua; cache degrada para "sem cache"; limites de tentativa contam em memória por instância (não somam entre instâncias); **a auditoria é gravada direto no PostgreSQL** quando a fila não confirma em 1,5 s (id idempotente); a **revogação de sessão NÃO falha aberta**: toda revogação é gravada também em `access_revocations` (PostgreSQL), com o Redis fora a checagem consulta o PostgreSQL e, se os dois estiverem fora, a API responde 503 `AUTH_UNAVAILABLE` (nunca aceita, nunca 401); ao voltar, o Redis recebe de volta as revogações vigentes antes de ser a fonte de novo. Refresh tokens ficam no PostgreSQL. **Ensaio com o Redis real derrubado: feito em desenvolvimento (2026-10-14)** — token revogado seguiu 401, válido 200, revogação durante a queda valeu, login funcionou, `/health` DEGRADED e, ao religar, as revogações foram ressincronizadas; **a executar em staging com 2+ instâncias** (teste `session-revocation-redis-outage` cobre a queda simulada).
- **Segurança operacional:** `TRUST_PROXY` correto; HTTPS no balanceador; CORS só para as origens do front; limites por usuário/IP/credencial; troca periódica dos segredos (rotação da `DATA_ENCRYPTION_KEY` **não** está implementada).

## 9. CI/CD

`ci.yml` (nunca executado de verdade: sem remoto): lint (API, Admin Web, Super Admin), documentação (links), tipos (todos os pacotes), testes unitários (API e Admin Web), integração com PostgreSQL e Redis reais (migrações aplicadas, **`db:check-rls`**, suíte completa), build de todos, build das três imagens Docker e `npm audit` (informativo: há vulnerabilidades transitivas a triar). Corrigido nesta fase: o passo de migrações não recebia `DATABASE_URL` (falharia), o Admin Web não tinha testes no pipeline, e o build do Admin Web **ignorava tipos e lint** (agora valida; ambos estavam limpos e um `next build` real passou).

## 10. O que só dá para validar em staging (não executado — restrição do ambiente corporativo)

Carga e concorrência em escala (pool de conexões, Postgres em Linux), failover do Redis e do PostgreSQL, SIGTERM real com tráfego, rolagem sem indisponibilidade, restauração de backup completa, throttling real atrás do balanceador (`TRUST_PROXY`), HTTPS/HSTS, e o build/execução das imagens Docker.

## 11. HTTPS, conexão dos aplicativos e autorização de equipamento (2026-10-06)

- **HTTPS obrigatório:** em produção a API responde **426 `HTTPS_REQUIRED`** a qualquer requisição que não chegou por HTTPS (`middleware/https.ts`; só `GET /api/health`, `/live`, `/ready` passam por HTTP, para o orquestrador). A API **não termina TLS**: o certificado, o redirecionamento 80→443 e o HSTS ficam no proxy/balanceador, que envia `X-Forwarded-Proto` e é declarado em `TRUST_PROXY`. Sem `TRUST_PROXY` a API **recusa subir** em produção (ou `ENFORCE_HTTPS=false` explícito). Provado por testes unitários (`https.test`, `env.test`); **o certificado real e o redirecionamento 80→443 são a executar em staging.**
- **Aplicativos:** o PDV em produção recusa endereço sem HTTPS; mobile e TV lançam erro na partida de um build de produção sem URL https; **nenhum aplicativo ignora erro de certificado**. O endereço é fixado na instalação (`VITE_API_URL`/`EXPO_PUBLIC_API_URL`) com o **domínio oficial — ainda não definido** (nada foi inventado). Detalhe e fluxo: [DISPOSITIVOS](DISPOSITIVOS.md).
- **Topologia de rede:** Internet → HTTPS → proxy → API → PostgreSQL/Redis/workers. **Nunca** Internet→PostgreSQL nem aplicativo→PostgreSQL; Redis nunca exposto; banco e Redis só aceitam a rede privada da API (**regra de firewall/security group: infraestrutura**; no `docker-compose.yml` já escutam só em `127.0.0.1`).
- **Equipamento autorizado:** máquina nova se registra (PENDENTE, sem empresa/filial), o administrador vincula licença e filial, e só então o login funciona; revogar derruba a sessão na hora. Migração **`20261006200000_device_enrollment`** (aditiva; reversão no cabeçalho): aplicar com `migrate deploy` + `db:check-rls` como as demais. **Para o go-live, configurar por empresa a política `devices.requiredUserTypes`** com os perfis de balcão (decisão 109).
- **Homologação com HTTPS** (a executar numa máquina Linux com Docker e um domínio real): `docker compose -f docker-compose.yml -f docker-compose.staging.yml up -d --build` com `STAGING_DOMAIN`, `TRUST_PROXY=1`, `WEB_URL`, `SUPER_ADMIN_URL` no `.env`; depois `node scripts/smoke-device-flow.js` (variáveis de ambiente descritas no cabeçalho do script; usa uma empresa de **teste**, cria e revoga **um** equipamento, sem carga). Conferir ainda: `curl -i http://<dominio>/api/auth/login` redireciona (proxy) e `curl -i` direto na API por HTTP devolve 426; `ss -tln` mostra 5432/6379 só em loopback/rede privada.
- **Aplicações atrás do mesmo proxy (staging):** `docker-compose.staging.yml` publica **só** o Caddy (80/443); `api.<domínio>`, `admin.<domínio>`, `super.<domínio>` e `balcao.<domínio>` precisam existir no DNS; `NEXT_PUBLIC_API_URL` dos painéis e `WEB_URL`/`SUPER_ADMIN_URL`/`BALCAO_URL` da API (CORS) e o `VITE_API_URL` do Balcão (sem `/api`; fixado no build, https obrigatório em produção). O container do Balcão recebe `API_ORIGIN` (origem https da API) para o `connect-src` da CSP do nginx (template em `/etc/nginx/templates`) são montados a partir de `STAGING_DOMAIN`. O `next build` de **produção** dos dois painéis **recusa** `NEXT_PUBLIC_API_URL` que não seja `https://` (exceto `http://localhost`). Corrigido junto: o `docker-compose.yml` passava a mesma URL sem `/api` aos dois painéis e o Admin Web (que espera o sufixo) chamava `/sales` em vez de `/api/sales`.
- **Provado localmente em 2026-10-06 (sem Docker, sem domínio):** cadeia **TLS real** com proxy HTTPS (certificado autoassinado, sockets reais) → `middleware/https.ts` com `TRUST_PROXY=1`: o cliente com a validação padrão **recusa** o certificado autoassinado; com o certificado confiado a API responde 200; **HTTP direto → 426**; sonda de saúde por HTTP → 200 ([DISPOSITIVOS §10](DISPOSITIVOS.md#10-o-que-foi-provado-e-o-que-falta)). **Não** é a prova de um certificado emitido para um domínio real nem do Caddy/Docker.

## 12. Checklist de go-live

| P | Item | Estado |
|---|---|---|
| P0 | Infraestrutura: domínio, HTTPS, PostgreSQL e Redis gerenciados, segredos no cofre, `TRUST_PROXY`, Git remoto + CI executado | **a executar** (nada disponível aqui) |
| P0 | Migrar (inclui `20261006200000_device_enrollment`) e conferir RLS no banco de produção; expurgar auditoria antiga com segredo (SECURITY, ação 3) | **a executar** |
| P0 | HTTPS real (certificado, 80→443, 426 em HTTP direto) e a **fumaça do fluxo de equipamento** em staging (§11); política `devices.requiredUserTypes` configurada por empresa (decisão 109) | **a executar** (código pronto e provado em teste; falta domínio/certificado) |
| P0 | Backup contínuo com RPO/RTO acordados e **uma restauração testada** | **a executar** |
| P0 | Criar o Super Admin de TI (§13) com MFA e **conferir** o login; publicar a Central de Ajuda | **a executar** (conta ainda não criada) |
| P1 | Teste de carga/concorrência e do desligamento real em staging | **a executar** |
| P1 | Alertas configurados (§8) | **a executar** |
| P1 | Decisões de dono ligadas a canais antes de ligar qualquer canal real (82–92, 95–105) | **abertas** |
| P2 | Rotação da `DATA_ENCRYPTION_KEY`; saldo materializado; pool (decisão 57) | evolução |

## 13. Primeiro Super Admin (bootstrap) e MFA

Procedimento **administrativo, no servidor da API** (acesso ao `.env` com `DATABASE_URL` e `DATA_ENCRYPTION_KEY`). **Não há conta padrão**: nenhuma senha fixa existe no código, nas migrations ou nos logs. **Estado em 2026-10-14: a conta ainda NÃO foi criada** — a simulação no banco de desenvolvimento mostrou o login `1` livre; criar é uma execução com `--apply` por quem tem a senha.

1. **Simular** (não grava nada): `cd apps/api && npm run admin:bootstrap -- bootstrap --email <e-mail> --name "<Nome Completo>" --numeric-id 1`. O plano diz se criaria, se já existe (no-op) ou por que recusa (`EMAIL_INVALID`, `NAME_INVALID`, `NUMERIC_ID_INVALID`, `NUMERIC_ID_TAKEN`, `EMAIL_BELONGS_TO_OTHER_ROLE`). Nunca promove conta existente de outro perfil e nunca troca o identificador por conta própria.
2. **Criar:** `BOOTSTRAP_SA_PASSWORD` definida **só no terminal desse comando** (ou digitada no prompt oculto), depois `… bootstrap … --apply`. Em produção, antes: `ALLOW_SUPER_ADMIN_BOOTSTRAP=true` (remover ao terminar). Senha: 12+ caracteres, 3 tipos, sem nome/e-mail, fora da lista de comuns. Gravada só como hash; o comando não a imprime; a auditoria registra o ato sem segredo.
3. **Conferir o resultado real** (não presumir): repetir o passo 1 (deve responder "já é Super Admin") e tentar o login pela tela do Super Admin.
4. **Ligar o MFA** (obrigatório em produção): `npm run admin:bootstrap -- enroll-mfa --numeric-id 1 --apply`; o segredo e os códigos de backup aparecem **uma vez** — guardar no cofre; confirmar com um código do autenticador. Sem MFA o Super Admin é barrado com 403 enquanto `REQUIRE_MFA_PRIVILEGED` estiver ligado.
5. **Recuperação:** perda do autenticador/senha = repetir `enroll-mfa`/redefinir a senha por procedimento de TI no servidor (auditado). Não existe "esqueci a senha" por e-mail para conta privilegiada.
6. **Central de Ajuda:** `npm run help:seed` (simulação) e `npm run help:seed -- --apply --publish` publicam os 13 artigos de [docs/ajuda](../ajuda/CENTRAL_DE_AJUDA.md) de forma idempotente (o autor é o primeiro Super Admin ativo — **depois** do passo 2).
7. **Migrações de 2026-10-14 (reversão no cabeçalho de cada uma):** as 5 aditivas `20261014100000_product_barcodes`, `20261014120000_access_revocations`, `20261014130000_mfa_replay_guard`, `20261014140000_privacy_requests`, `20261014150000_product_images` e as 4 da revisão do banco — `20261014155900_guard_product_children_same_company` (**guarda**: aborta se houver código de barras/imagem apontando para produto de outra empresa; roda antes da seguinte), `20261014160000_product_children_same_company` (FKs compostas), `20261014161000_product_images_company_product_unique` e `20261014162000_rls_logs_roles_tighten` (RLS de logs e de perfis/permissões globais). `migrate deploy` + `db:check-rls` + `db:replay-check` como as demais, **depois de um backup restaurável** ([BANCO_DE_DADOS §3](BANCO_DE_DADOS.md)). Se a guarda abortar: corrigir as linhas por procedimento documentado (nunca apagando histórico), `prisma migrate resolve --rolled-back 20261014155900_guard_product_children_same_company` e repetir o deploy (roteiro testado em banco temporário).
8. **Recuperar o acesso do Super Admin** (perdeu o autenticador): `npm run admin:bootstrap -- reset-mfa --numeric-id 1` (simulação) e `… --apply` (com `ALLOW_SUPER_ADMIN_BOOTSTRAP=true` em produção); depois `enroll-mfa --numeric-id 1 --apply`. Reinicia o fator, derruba as sessões e audita. A senha esquecida segue o passo 2 por outra conta de Super Admin ou por procedimento de TI no banco.

## 14. Operações manuais restantes (comandos exatos) — 2026-10-14

| Operação | Comando / procedimento | Estado |
|---|---|---|
| Criar o Super Admin de TI + MFA | §13 (passos 1–4), a senha só por prompt oculto | **a executar pelo responsável** (conta ainda não criada) |
| Migrar staging/produção | `prisma migrate deploy --schema=packages/database/prisma/schema.prisma` + `npm run db:check-rls` + `npm run db:inventory` (comparar com [BANCO_DE_DADOS](BANCO_DE_DADOS.md)) | **a executar** |
| Medir o Argon2id no hardware real | em `apps/api`: `npm run password:bench` (20 amostras sequenciais e um pico de 3 verificações simultâneas; sem banco, sem carga; imprime CPU, mediana/p95 e memória); ajustar `ARGON2_*` para 50–100 ms por verificação | **a executar no servidor-alvo/contêiner Linux** (na máquina de trabalho, 2026-10-14: verificação 26 ms com 19 MiB, t=2, +38 MB com 3 simultâneas; bcrypt custo 12: 257 ms — [SECURITY](SECURITY.md)) |
| Auditar o banco antes de migrar (deriva e RLS) | em `apps/api`: `npm run db:replay-check` (cria banco temporário, aplica as migrations do zero, compara com o dev, remove) · `npm run db:docs -- --write --orphans` (regera [BANCO_DE_DADOS](BANCO_DE_DADOS.md) Anexo A, [MAPA_RELACIONAMENTOS](MAPA_RELACIONAMENTOS.md), [RELATORIO_MIGRATIONS](RELATORIO_MIGRATIONS.md) e [REVISAO_BANCO_PENDENCIAS](REVISAO_BANCO_PENDENCIAS.md)) | **feito em dev em 2026-10-14**; repetir contra o **staging** depois de migrar (e incluir `db:replay-check` na CI: **não incluído**, não dá para exercitar a CI daqui) |
| Acompanhar o fim do bcrypt | contar `users.password LIKE '$2%'`; zerou → `PASSWORD_LEGACY_BCRYPT=false` | **a acompanhar** |
| Publicar a Central de Ajuda | `npm run help:seed` (simulação) e `npm run help:seed -- --apply --publish` (depois de criar o Super Admin) | **a executar** por ambiente |
| Ensaio do Redis real derrubado com 2+ instâncias | derrubar o Redis com login/logout em duas instâncias; esperado: revogado segue 401, válido 200, 503 só se o PostgreSQL também cair | **a executar em staging** (em dev: feito) |
| Instalador do PDV (Windows) | em `apps/pdv-desktop`: `npx electron-builder --win nsis --x64 --publish never` (usa `build.electronVersion`, fixado em 28.3.3). **Assinatura:** exige o certificado de assinatura (não existe aqui) e, no Windows, privilégio de criar links simbólicos (Modo de Desenvolvedor ou administrador) para o cache `winCodeSign`; **ícone do aplicativo não definido** (usa o padrão do Electron); **marca antiga no instalador:** `build.productName` = "LN System PDV" e `appId` = `com.lnsystem.pdv` (a janela já é "CÓRTEX PDV") — alinhar a CÓRTEX **antes da 1ª distribuição** (decisão do dono: trocar o `appId` muda a identidade da instalação e não atualiza instalações antigas); arquivo conferido em 2026-10-14: 82 MB, `NotSigned` | **gerado sem assinar** (dev); instalação real em máquina isolada **não executada** |
| Restauração em ambiente separado | `npm run backup:verify` prova a restauração em banco temporário da mesma instância (18/18, 2026-10-14); falta restaurar o dump em **outro host** e rodar `db:check-rls` lá | **a executar** |
| HTTPS, domínio e certificado | §11 (compose de staging + Caddy + `smoke-device-flow.js`) | **a executar** (sem domínio/Docker aqui) |

## 15. Staging — recursos externos que faltam e roteiro (2026-10-14)

Os arquivos existem e foram **revisados, não executados** (a máquina de trabalho não tem Docker nem domínio): [docker-compose.yml](../../docker-compose.yml), [docker-compose.staging.yml](../../docker-compose.staging.yml) (Caddy com TLS automático, portas 3000/3001/3002 fechadas, `ENFORCE_HTTPS`), [deploy/Caddyfile](../../deploy/Caddyfile), os Dockerfiles de `apps/*` e a CI ([.github/workflows/ci.yml](../../.github/workflows/ci.yml): lint, tipos, unitários, **integração com PostgreSQL 18 e Redis 7 reais**, `db:check-rls`, build, build das imagens, auditoria de dependências). Para a homologação real faltam:

| Recurso | O que é | Quem fornece |
|---|---|---|
| Servidor Linux | Docker Engine + Compose ≥ 2.24.4 (usa `!reset`), acesso por SSH, firewall liberando só 80/443 (nunca 5432/6379/3000–3002) | infraestrutura |
| Domínio e DNS | `STAGING_DOMAIN` real e registros `api.`, `admin.`, `super.` e `balcao.` apontando ao servidor (o Caddy emite e renova o certificado de cada nome; sem DNS não há certificado) | infraestrutura |
| Segredos (gerados na hora; nunca versionados, nunca copiados do desenvolvimento) | `.env` do servidor com `POSTGRES_PASSWORD`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `DB_BACKUP_PASSWORD` (três senhas **diferentes**), `BACKUP_KEY_FILE` (arquivo da chave de cifragem do backup, fora do repositório), `REDIS_PASSWORD` (só letras e números), `JWT_SECRET`, `JWT_REFRESH_SECRET`, `DATA_ENCRYPTION_KEY` (32 bytes em base64; perdê-la inutiliza MFA e segredos fiscais), `STAGING_DOMAIN`, `TRUST_PROXY=1`; `REQUIRE_MFA_*` ficam no padrão (ligados em produção); `ALLOW_SUPER_ADMIN_BOOTSTRAP=true` só durante a criação do Super Admin | responsável de TI |
| CI/CD de implantação | a CI atual valida, mas **não implanta** e não tem credenciais de registro de imagens nem de acesso ao servidor | infraestrutura |
| Backup fora do host | destino, retenção e **RPO/RTO** (decisão 106 — só o responsável define; nada foi inventado aqui) e a restauração testada em **outro** host | dono + infraestrutura |
| Observabilidade | `SENTRY_DSN`/APM opcionais (hoje não configurados); logs de contêiner e `/api/health` | infraestrutura |
| Certificado de assinatura e ícone do PDV | para assinar o instalador (§14) | dono |

Roteiro: (1) `docker compose -f docker-compose.yml -f docker-compose.staging.yml config` (valida o YAML e as variáveis obrigatórias) → (2) backup do banco → (3) `… up -d --build` (o serviço `migrate` roda `prisma migrate deploy` antes da API; a API só sobe com `service_completed_successfully`) → (4) `npm run db:check-rls` e `npm run db:replay-check` contra o banco do staging → (5) `scripts/smoke-device-flow.js` e a verificação 80→443 / 426 em HTTP direto (§11) → (6) criar o Super Admin (§13) → (7) `npm run password:bench` no contêiner. **Rollback:** imagens anteriores (`docker compose up -d` com a tag anterior) e, se uma migration precisar voltar, o SQL de reversão do cabeçalho dela — todas as migrations desta rodada são aditivas (apagar a tabela/coluna nova); restaurar o backup só se houver dado novo que dependa da estrutura. **Diagnóstico:** `docker compose ps`, `docker compose logs --tail=200 api`, `curl -fsS https://api.<domínio>/api/health/ready`, `/api/health` (detalha banco, Redis e workers), `npm run db:check-rls`; conexões do banco: `npx tsx scripts/pg-sample.ts <arquivo.log> 2000` em `apps/api` (amostrador somente leitura; §7 de [BANCO_DE_DADOS](BANCO_DE_DADOS.md)).

## 16. Finalização para produção (2026-10-16): homologação com papéis separados, rollback e checklist de liberação

**Níveis de prontidão — não os confunda:** *código corrigido* (está no repositório) → *testes locais aprovados* (suíte rodou contra PostgreSQL/Redis locais) → *pronto para homologação* (há procedimento e artefatos, falta o ambiente) → *validado para produção* (executado em ambiente equivalente à produção). **Hoje: código corrigido e testes locais aprovados; pronto para homologação; NÃO validado para produção.** O que falta está em [RELATORIO_FINALIZACAO_PRODUCAO §9](RELATORIO_FINALIZACAO_PRODUCAO.md).

### 16.1 Procedimento de homologação (num host Linux com Docker — **a executar**)

1. **Segredos** (gerados na hora, nunca copiados do desenvolvimento): `.env` com `POSTGRES_PASSWORD`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `DB_BACKUP_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `DATA_ENCRYPTION_KEY`, `BACKUP_KEY_FILE` (+ `STAGING_DOMAIN` e `TRUST_PROXY=1` para o overlay de staging).
2. `docker compose config` (e com `-f docker-compose.staging.yml`): valida YAML e variáveis obrigatórias.
3. `docker compose up -d --build postgres` e **só então** conferir os papéis (volume **novo**; o `10-roles.sh` só roda na 1ª inicialização): `\du` mostra o dono e a execução **sem** superusuário nem BYPASSRLS, e o de backup só com BYPASSRLS.
4. `docker compose up -d --build`: `migrate` (dono) → `db-grants` → `api` (papel de execução) → `backup` → front-ends. A API só sobe com `service_completed_successfully` de `db-grants`.
5. **Provar a separação de papéis no ambiente real**, como o papel da API: `ALTER TABLE users DISABLE ROW LEVEL SECURITY` e `TRUNCATE users` **devem falhar**; `SELECT count(*) FROM _prisma_migrations` **deve falhar**; `SELECT count(*) FROM users` sem contexto **deve devolver 0**.
6. `npm run db:check-rls` e `npm run db:replay-check` contra o banco de homologação; `CORTEX_DB_ADMIN_URL=<superusuário> npm run db:role-split-check -- --all` (suíte completa com o papel de execução).
7. **Backup**: esperar o primeiro backup do serviço (ele roda no start se não houver nenhum), conferir `docker compose exec backup su postgres -s /bin/sh -c '. /etc/backup.env; /opt/backup/backup.sh status'`, configurar `BACKUP_OFFSITE_CMD`/`BACKUP_ALERT_CMD` e **provocar** uma falha (parar o banco, ou trocar a senha do papel de backup) para ver o alerta chegar.
8. **Restauração**: copiar o `.dump.enc` para **outro host** e rodar `npm run backup:drill -- <arquivo> --compare-source --boot` lá; registrar a duração (insumo do RTO).
9. Smoke test (sem carga) de §6 passo 6, mais as provas de escopo: login do gerente da filial A → `GET /api/dashboard/management/summary?branchId=<filial B>` deve dar **403**; login do administrador → mesmo pedido **200** e, sem `branchId`, a empresa consolidada; ambos pedindo `/api/dashboard/financial` com o módulo FINANCEIRO desativado → **403 `MODULE_DISABLED`**.
10. Observar 30 min (§6 passo 7) e registrar tudo em um relatório de homologação **com data, versão, comandos e saídas** — sem isso a etapa não conta como executada.

### 16.2 Rollback

| Situação | Ação |
| --- | --- |
| Falha antes de `migrate deploy` terminar | não subir a API; o Prisma aplica cada migração em transação — o banco fica na versão anterior; corrigir e repetir |
| Migração de FK/colunas abortada pela guarda de dados | **não forçar**: corrigir o dado por procedimento aprovado, `prisma migrate resolve --rolled-back <migration>` e reaplicar ([RELATORIO_MIGRATIONS §4](RELATORIO_MIGRATIONS.md)) |
| Versão nova da API com defeito, banco compatível | reimplantar a imagem anterior (as migrações são aditivas; as duas de 2026-10-16 só trocam policies/funções/trigger) |
| Migrações `20261016100000` e `20261016110000` precisam voltar | SQL de reversão no cabeçalho de cada uma (recriar as policies anteriores e `DROP TRIGGER users_guard_privileged_columns`); **atenção:** voltar a RLS reabre o vazamento entre filiais — só em emergência e com a API anterior |
| Corrupção ou perda de dados | restaurar em banco **novo** (§7), nunca sobre o de produção; RPO = hora do último backup/WAL |
| Papel de execução sem permissão após uma migração nova | rodar `after-migrate.sql` (o serviço `db-grants` já o faz a cada `up`) |

### 16.3 Checklist de liberação controlada para produção (marque só o que foi **executado e registrado**)

- [ ] CI verde na versão exata (lint, tipos, unitários, integração, `db:check-rls`, build, links, imagens).
- [ ] Homologação 16.1 concluída em ambiente **Linux com Docker**, com relatório datado.
- [ ] Papéis separados provados no ambiente real (16.1 passo 5); a API **não** conecta como superusuário.
- [ ] `sslmode=require` (ou equivalente do provedor) na `DATABASE_URL`; HTTPS ligado (`ENFORCE_HTTPS`, `TRUST_PROXY`).
- [ ] Backup: destino externo com bloqueio de objeto, alerta recebido num teste real, **restauração em outro host** com cópia anonimizada do volume real, RTO medido e **aprovado**.
- [ ] RPO/RTO e retenção **aprovados** pelo dono/jurídico (decisões 106, 141, 149); WAL archiving ligado se o RPO aprovado for de minutos.
- [ ] Decisões do negócio sobre escopo confirmadas (decisões 145–147: gerente e COMPANY_ADMIN visíveis, convênio da empresa toda).
- [ ] Recebível órfão conhecido tratado **com autorização** (3 FKs `NOT VALID`; §4) ou aceito formalmente.
- [ ] Janela de manutenção, backup imediatamente antes da migração e plano de comunicação.
- [ ] Super Admin criado pelo procedimento do §13 (**não** foi criado nesta entrega).
- [ ] Primeira hora monitorada; critério de reversão definido antes.

## 17. Missão de segurança e liberação (2026-10-15): contexto assinado, credencial de backup isolada, vários filiais, WAL — implantação e reversão

**O que mudou para quem implanta** (decisões 151–156). **Estado:** *código corrigido* e *testes locais aprovados*; o pipeline foi reproduzido **fora do Docker** (PostgreSQL 18.6 local, 0 falhas); **Docker/Linux, staging com HTTPS, destino externo, alerta real e restauração em outro host continuam não executados** — nada abaixo é "validado para produção".

### 17.1 Novas variáveis e arquivos

| Item | Para quê | Observação |
| --- | --- | --- |
| `RLS_CONTEXT_SECRET` (base64, 32–64 bytes) | segredo que assina o contexto da RLS ([RLS_CONTEXTO_ASSINADO](RLS_CONTEXTO_ASSINADO.md)) | **obrigatório** em produção (a API e o `db-grants` recusam sem ele); `openssl rand -base64 32`; cofre de segredos; **diferente** de `JWT_SECRET`/`DATA_ENCRYPTION_KEY` |
| `BACKUP_MODE=delegated` | a API não tem a credencial de backup | já é o padrão do `docker-compose.yml`; `BACKUP_DATABASE_URL` **não** pode existir no ambiente da API (ela recusa subir) |
| `ALERT_WEBHOOK_URL` + `BACKUP_ALERT_CMD="sh /opt/backup/alert-webhook.sh"` | alerta que chega a uma pessoa | webhook de Slack/Teams/Mattermost/endpoint próprio; sem ele o aviso só vai ao log |
| `docker-compose.wal.yml`, `WAL_KEY_FILE`, `WAL_OFFSITE_CMD`, `WAL_ARCHIVE_TIMEOUT` | WAL contínuo cifrado + PITR | **opcional e não executado**; chave diferente da do backup lógico, legível pelo uid 70 |

### 17.2 Ordem de implantação (banco novo ou existente)

1. **Backup imediato** do banco atual (`backup.sh backup`) e conferir `status`/`verify`. Guardar a chave do backup no cofre.
2. Gerar `RLS_CONTEXT_SECRET` e guardar no cofre. Colocar no `.env` do compose (ou no cofre do provedor).
3. `docker compose config` e, no host Linux, `sh deploy/homologacao/validar-homologacao.sh [--wal] [--tls <dominio>]` **em homologação primeiro** (PASS/FAIL por item; gera relatório datado).
4. `migrate deploy` como **dono** (57 migrações, as 2 últimas de 2026-10-19 da Central de Monitoramento; as três anteriores — `20261017100000_rls_signed_context`, `20261017110000_user_branches` e `20261018100000_user_password_change` — são aditivas e **não ligam** a exigência; a última acrescenta `users.mustChangePassword`/`passwordChangedAt` e estende a trava de privilégio de `users`: **reiniciar a API** depois, pois o código novo lê as colunas).
5. `db-grants` (`after-migrate.sql`): concede DML ao papel de execução e executa `app_ctx.provision(<segredo>)`, que **liga a exigência** de contexto assinado. Em banco **existente** fora do Docker: `npm run db:provision-context` (como dono).
6. Subir a API **com o mesmo segredo**. Ela confere na partida e **recusa subir** se o banco não exige assinatura, rejeita a assinatura, ou o papel é superusuário/dono/BYPASSRLS. Subir uma instância primeiro e conferir `/api/health/ready`; depois as demais.
7. Vínculos de filial: depois de implantar, o administrador concede filiais adicionais a cada gerente (`PUT /users/:id/branches`); **gerentes existentes continuam só com a filial principal** (nada é ampliado sozinho).
8. Conferir como o papel real: usuário sem contexto vê 0 linhas; GUCs forjadas não dão acesso; gerente de A não alcança B (403 `BRANCH_FORBIDDEN`); outra empresa dá 404.

### 17.3 Reversão (sem apagar dados)

| Situação | Ação |
| --- | --- |
| API nova com defeito | reimplantar a imagem anterior **com a exigência ainda ligada só se a anterior assinar**; a versão anterior à decisão 151 **não assina** — antes dela é preciso `UPDATE app_ctx.settings SET enforced = false;` (volta a aceitar contexto cru; **reabre** o risco da decisão 151 — só em emergência) |
| Segredo vazou ou foi trocado | `SELECT app_ctx.provision(<novo>)` (o anterior fica no slot 2), atualizar as instâncias, depois `SELECT app_ctx.retire_previous();` |
| Banco restaurado de backup | tudo é **negado** até provisionar: `npm run db:provision-context`; a API se recusa a subir antes disso (mensagem orienta) |
| Vínculo de filial concedido por engano | `PUT /users/:id/branches` com a lista correta; a revogação vale **na próxima requisição**, com o mesmo token |
| `user_branches` precisa sair | SQL de reversão no cabeçalho de `20261017110000_user_branches` (a tabela é configuração; nenhum dado de negócio depende dela); sem ela, o gerente volta a só a filial principal |
| Perda de dados | restaurar em banco **novo** (§7), nunca sobre o de produção; o segredo é reprovisionado depois |

### 17.4 Checklist adicional (marque só o que foi **executado e registrado**)

- [ ] `RLS_CONTEXT_SECRET` no cofre real, com responsável pela rotação.
- [ ] `validar-homologacao.sh` executado num host Linux com Docker e o relatório arquivado (inclui provas de papéis, RLS forjada, credencial de backup fora da API, pedido de backup).
- [ ] Staging com HTTPS provado (`--tls`), 80/443 abertas, 5432/6379/3001 fechadas.
- [ ] Webhook de alerta real recebido num teste (derrubar o banco/trocar a chave do backup de propósito).
- [ ] Restauração do backup em **outro servidor** a partir do destino externo + `backup:anonymize`; RTO medido.
- [ ] (opcional) overlay de WAL executado e `wal-check` saudável; base backup semanal agendado.
- [ ] Dono confirmou as regras abertas de visibilidade (gerente vê administradores/usuários sem filial; convênio "da empresa toda" por gerente; teto de 50 filiais) e **aprovou RPO/RTO/retenção**.

## 18. Central de Monitoramento (2026-10-18/19): configuração, serviços externos opcionais, Supabase, domínio e custos

**Estado:** *código implementado* e *testado localmente* (unitários, integração e navegador real contra o ambiente de desenvolvimento). **Nada externo está conectado**: sem `SENTRY_DSN`, sem chave do Resend, sem conta Supabase, sem domínio. O monitoramento **nativo** (saúde, métricas, alertas, funil, backups) funciona sem nenhum serviço de terceiros e é o que está provado. Migrações **56** e **57**: `20261019100000_monitoring_central` (aditiva; 6 tabelas novas — `monitoring_alert_events`, `service_health_samples`, `commercial_leads`, `commercial_lead_events`, `external_deliveries`, `monitoring_settings` — e colunas de tratamento em `monitoring_alerts`; todas com RLS forçada, só o Super Admin lê/escreve; histórico append-only). Mais `20261019110000_monitoring_alert_events_company_index` (índice por empresa no histórico de alertas, achado pelo teste de invariantes). Reaplicadas do zero: 3 712 itens iguais ao dev.

### 18.1 Variáveis (todas opcionais; padrões em `.env.example`)

| Grupo | Variáveis | Regra |
| --- | --- | --- |
| Sentry | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `SENTRY_SAMPLE_RATE`, `SENTRY_MAX_EVENTS_PER_HOUR`, `SENTRY_MAX_EVENTS_PER_DAY`, `SENTRY_DEDUPE_MINUTES` | sem DSN nada é enviado; dados mascarados (sem corpo, cabeçalho, e-mail, token ou senha), amostragem, limites por hora/dia, repetição agrupada, disjuntor após falhas; **falha do provedor nunca afeta a operação**. O plano gratuito do provedor tem limite mensal próprio (na última consulta: 5 mil erros/mês, 1 usuário) — **confira a página de preços antes de ligar** |
| Resend | `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`, `RESEND_DOMAIN_VERIFIED`, `RESEND_TRANSACTIONAL`, `ALERT_EMAIL_MIN_SEVERITY`, `ALERT_EMAIL_MAX_PER_HOUR/DAY/MONTH`, `ALERT_EMAIL_DEDUPE_MINUTES` | só envia com chave **e** remetente em domínio **verificado** **e** destinatários **e** `RESEND_DOMAIN_VERIFIED=true`; e-mail transacional (senha temporária) exige ainda `RESEND_TRANSACTIONAL=true`; no limite o envio é **suprimido** (nunca contrata plano); sem conteúdo sensível no corpo; sem e-mail real em teste. O plano gratuito do provedor tem limite diário/mensal próprio (na última consulta: 100/dia, 3 mil/mês, 1 domínio) |
| Coleta e retenção | `MONITORING_SAMPLE_MINUTES`, `MONITORING_SAMPLES_MAX_PER_DAY`, `MONITORING_SAMPLE_RETENTION_DAYS`, `MONITORING_DELIVERY_RETENTION_DAYS`, `MONITORING_ALERT_RETENTION_DAYS` | o expurgo diário só apaga amostras/entregas/alertas **resolvidos** vencidos; a tela "Serviços externos" só **restringe** (o ambiente é o teto) |
| Backup exibido | `BACKUP_PUBLIC_DIR`, `BACKUP_MAX_AGE_HOURS` | a Central distingue **criado** (manifesto), **verificado** (`verify.txt`, restauração em banco temporário) e **restauração testada** (nunca afirmada: o ensaio é manual); sem a pasta mostra "sem fonte de dados" |
| Endereços | `WEB_URL`, `SUPER_ADMIN_URL`, `BALCAO_URL`, `API_ORIGIN`, `TRUST_PROXY` | a Central só lê e diz se estão em HTTPS e fora de `localhost`; nenhum domínio fixo no código |

Para ligar um serviço: criar a conta/chave **fora** do repositório, colocar no cofre de segredos do ambiente, reiniciar a API e conferir na tela "Serviços externos" (estado "Ativo (configurado)" quer dizer *variáveis presentes*; o Resend tem o botão somente-leitura "Verificar domínio no provedor"). **Só dê o serviço como conectado depois de um envio/recebimento real registrado na própria tela (último envio bem-sucedido).**

### 18.2 Supabase — análise de compatibilidade (documental; **nada foi migrado nem conectado**)

O projeto **não usa Supabase**; o banco é PostgreSQL próprio (18.6 local; `postgres:18-alpine` no compose) com Prisma, autenticação própria (JWT + MFA + sessões em hash) e RLS por contexto assinado. Conclusão: **Supabase só serve como PostgreSQL gerenciado**; adotar Auth, Storage, Realtime ou a Data API não é compatível com a arquitetura atual e não deve ser feito sem decisão nova.

| Ponto | Situação | O que fazer se a decisão for adotar |
| --- | --- | --- |
| Segunda fonte de verdade / Auth | **Incompatível se usado**: o login, MFA, revogação e papéis são da API | manter a autenticação da API; **não** usar Supabase Auth |
| Data API (PostgREST) e chaves `anon`/`service_role` | **Risco**: expõe o schema público por HTTP; a RLS FORCE com contexto assinado negaria o acesso sem contexto, mas a exposição não deve existir | desativar a Data API do projeto e revogar privilégios de `anon`/`authenticated`; `service_role` **nunca** no front nem em aplicativo; o front nunca fala com o banco |
| Conexão e migrações | O Prisma precisa de **duas URLs**: pooler em modo transação (porta 6543, `pgbouncer=true`) para a API e **conexão direta** para `migrate deploy` | `DATABASE_URL` = pooler, `DIRECT_URL` = direta (exige ajuste do `schema.prisma`, **não feito**); o contexto de RLS usa `set_config(..., true)` dentro da transação, compatível com pooler em modo transação — **a provar em staging** |
| Papéis (dono × execução × backup) | O desenho exige papel de execução **sem posse** e papel de backup com `BYPASSRLS`; criar papel com `BYPASSRLS` costuma exigir superusuário, **não verificado** no Supabase | criar o papel de execução e rodar `db:role-split-check`; se o `BYPASSRLS` não for possível, o backup lógico por essa credencial **não** vale — usar o backup do próprio provedor **e** provar a restauração |
| Versão do PostgreSQL | Cadeia de migrations provada no 18.6; a versão do Supabase pode ser outra | rodar `db:replay-check` e a integração **no banco alvo antes** de qualquer dado real |
| Backup/PITR | Dependente do plano do provedor (**custo**); RPO/RTO não aprovados | decisão 106/156; ensaio de restauração em outro host |
| Retenção/LGPD | dados em outra jurisdição/região | região e contrato (DPA) definidos pelo dono |

Para qualquer destino novo (Supabase ou outro) rode **antes** de migrar: backup restaurável do atual → `prisma migrate deploy` com o dono → `db:check-rls` → `db:replay-check` → `db:role-split-check --all` → integração completa → só então apontar a API. **Não declare a conexão ativa sem esse teste real.**

### 18.3 Domínio, DNS, HTTPS, proteção de tráfego e hospedagem (Cloudflare ou equivalente)

O domínio **ainda não foi escolhido**: nada foi comprado nem alterado em DNS. A aplicação lê os endereços **por variável de ambiente** (18.1) e a Central mostra, sem inventar, quais estão definidos, em HTTPS e fora de `localhost`. O que é externo à aplicação e **não é verificável daqui** (cada item tem estado próprio — não os misture): **DNS** (registros `A/AAAA/CNAME` para web, Super Admin, Balcão e API), **HTTPS** (certificado e redirecionamento; o roteiro do proxy está nas §11 e §15), **proteção/CDN** (ex.: Cloudflare: proxy, WAF, limites de requisição — atenção a `TRUST_PROXY` e ao IP real do cliente para o limitador e a auditoria), **hospedagem** (servidor/VPS ou PaaS), **PostgreSQL gerenciado**, **Redis**, **workers/filas** (sobem com a API), **armazenamento** (imagens/anexos) e **backups fora do host**. Nenhum deles foi provisionado.

### 18.4 Controle de custo e limites

Coleta local limitada (intervalo e teto diário de amostras), retenção configurável, envio de erro com **amostragem**, limite de e-mails por hora/dia/mês e janela anti-repetição (proteção contra tempestade de alertas), telemetria não essencial desligável na tela sem tocar na operação, indicadores de consumo e aviso de proximidade do limite em "Serviços externos". **Nenhum plano é contratado e nenhum excedente é autorizado automaticamente**; os limites dos planos gratuitos citados são da última consulta e **mudam**: confirme na página do provedor.

### 18.5 Checklist adicional (marque só o que foi **executado e registrado**)

- [ ] Destinatários de alerta definidos pelo dono e um e-mail de teste **real** recebido (Resend com domínio verificado).
- [ ] `SENTRY_DSN` real num projeto próprio; um erro de teste visível lá e o "último envio" na tela.
- [ ] Domínio escolhido, DNS e HTTPS provados; `WEB_URL`/`SUPER_ADMIN_URL`/`BALCAO_URL`/`API_ORIGIN` em HTTPS e `TRUST_PROXY` definido (a tela "Serviços externos" mostra "Endereços prontos").
- [ ] `BACKUP_PUBLIC_DIR` apontando para a saída do serviço de backup e o painel mostrando backup **criado** e **verificado** do ambiente real.
- [ ] (se Supabase) todas as linhas da 18.2 resolvidas e a integração completa passando **no banco alvo**.
- [ ] Arquivo oficial do Figma informado (hoje: dependência externa pendente; os tokens vêm do repositório).

## 19. Hospedagem gratuita para a demonstração e os dois primeiros clientes (2026-10-19): Oracle Always Free + Cloudflare Free

> **Atualização 2026-10-22: o destino de implantação passou a ser o Google Cloud** (aguarda resposta do suporte); a Oracle **não** é mais o destino. Veja [GOOGLE_CLOUD](GOOGLE_CLOUD.md). Esta seção permanece como referência dos arquivos preparados: `deploy/oci/*` são scripts genéricos para Ubuntu e servem em qualquer VM, e a Cloudflare continua sendo DNS/proxy/HTTPS.

**Estado:** *arquivos preparados e validados só em sintaxe* (YAML dos 5 compose, `bash -n` dos scripts, `.env` gerado aceito pela validação de produção da API). **Nada foi criado na nuvem, nenhum domínio foi comprado, nenhum DNS alterado, nada foi publicado.** Docker nunca rodou nesta máquina: tudo abaixo precisa ser provado no servidor.

### 19.1 Decisão (comparação curta, só com o que foi verificado em fontes oficiais em 2026-10-19)

| Opção | Cabe no CÓRTEX? | Motivo |
| --- | --- | --- |
| **Oracle Cloud Always Free — VM Ampere A1 (Arm)** | **Sim — escolhida** | Uma VM com Docker roda API, Admin Web, Super Admin, Balcão, PostgreSQL, Redis, workers e backup. Limite oficial: 2 OCPU + 12 GB de memória (A1), 200 GB de disco (boot + volumes), 5 backups de volume, 10 TB/mês de saída, 20 GB de Object Storage (cópia externa). |
| Google Cloud Run (gratuito) | Não, sozinho | Quota gratuita de 2 milhões de requisições, 180 mil vCPU-s e 360 mil GiB-s por mês (cobrança por requisição), mas **sem banco gratuito**: o Cloud SQL só tem teste de 30 dias e o Memorystore não aparece como gratuito. Exige conta de faturamento. Não atende PostgreSQL + Redis + workers persistentes. |
| Google Compute Engine e2-micro (gratuito) | Não | 1 VM com 1 e2-micro, só nas regiões us-west1/us-central1/us-east1: a pilha (PostgreSQL 18 + Redis + API + dois Next.js + Balcão + proxy + backup) não cabe em ~1 GB de memória. |

Outras plataformas não foram avaliadas em documentação oficial nesta sessão: **não há afirmação sobre elas**. Fontes: [Always Free da Oracle](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) e [recursos gratuitos do Google Cloud](https://docs.cloud.google.com/free/docs/free-cloud-features). A página comercial da Oracle (oracle.com/cloud/free) respondeu 403 ao acesso automático: requisitos de cadastro abaixo vêm de resultados de busca que a citam e **precisam ser conferidos por você na tela de cadastro**.

### 19.2 Limites e riscos da Oracle que mudam o plano

- **O limite da A1 é 2 OCPU e 12 GB** (frase oficial verificada: "Para tenancies Always Free, isto equivale a 2 OCPUs e 12 GB de memória"). Materiais antigos falam em 4 OCPU/24 GB: **não vale mais** na documentação atual.
- **Sem garantia de capacidade:** o erro "out of host capacity" é documentado ("falta temporária de shapes Always Free na região"). A VM precisa ser criada na **região-base (home region)**, que **não se troca depois**: escolha com cuidado (a documentação oficial permite tentar outro domínio de disponibilidade, esperar ou migrar para Pay As You Go).
- **Recuperação de VM ociosa:** a Oracle "pode recuperar" instância Always Free ociosa — durante 7 dias, P95 de CPU < 20%, rede < 20% e (na A1) memória < 20%. A pilha do CÓRTEX usa bem mais de 20% da memória; ainda assim **acompanhe** e mantenha um verificador externo de disponibilidade que gere tráfego leve.
- **Disco:** 200 GB no total entre boot e volumes; o mínimo de boot é 47–50 GB (a documentação cita os dois valores). Sugestão: boot de 100 GB, deixando o restante para backups locais.
- **Sem garantia de custo zero:** fora do Always Free há cobrança (ver 19.3).

### 19.3 Custos e risco de cobrança (nada é prometido além do verificado)

- **Gratuito de forma contínua (documentação oficial):** os recursos Always Free acima, **dentro da região-base**. Volumes criados fora da região-base geram cobrança.
- **Não é gratuito contínuo:** créditos do período de teste da Oracle; Object Storage acima de 20 GB quando o teste acaba ("todos os objetos serão apagados" se passar de 20 GB ao fim do teste — documentação oficial); qualquer recurso fora dos limites após o upgrade para Pay As You Go.
- **Pode exigir cartão/verificação:** cadastro da Oracle (resultados de busca que citam a página oficial: verificação por cartão com retenção temporária; cartão pré-pago/virtual pode ser recusado) e conta de faturamento do Google Cloud para qualquer uso. **Confirme na tela de cadastro antes de aceitar termos**; se pedir ativar faturamento ou upgrade, **pare e decida conscientemente**.
- **Domínio:** registrar um domínio tem custo anual do registrador (não incluso no R$ 0). A Cloudflare Free não cobra DNS/TLS/WAF gerenciada/DDoS (página oficial de planos), mas **não vende o domínio de graça**.
- **Controles recomendados:** (1) usar só os shapes Always Free e a região-base; (2) **não** fazer upgrade para Pay As You Go sem necessidade; (3) criar um orçamento com alerta no console da Oracle e conferir periodicamente a página de custos (a existência e os limites de orçamentos no Always Free **não foram verificados aqui**); (4) manter `docker-compose.free.yml` (tetos de memória e rotação de logs) para não encher o disco.
- **Sem domínio ainda:** o que dá para preparar já está pronto (arquivos, scripts, dimensionamento). Para uma demonstração com HTTPS **antes** de comprar o domínio, a opção é um nome de DNS curinga gratuito apontando para o IP da VM (ex.: `sslip.io`) usado como `STAGING_DOMAIN` com o Caddy + Let's Encrypt do `docker-compose.staging.yml` — **hipótese não verificada** (limites do Let's Encrypt e disponibilidade do serviço de terceiros). Os aplicativos (PDV, APKs) fixam a URL da API no build: **não os distribua com endereço provisório**.

### 19.4 Arquivos preparados (todos novos ou ajustados; nenhum segredo)

| Arquivo | Função |
| --- | --- |
| `docker-compose.free.yml` | rotação de logs (10 MB × 3), teto de memória por serviço (soma ≈ 8 GB de 12 GB), ajuste mínimo do PostgreSQL, variáveis `RCLONE_CONFIG_OFFSITE_*` para a cópia externa do backup |
| `docker-compose.cloudflare.yml` + `deploy/Caddyfile.cloudflare` | proxy atrás da Cloudflare: certificado de origem (Origin CA) em "Full (strict)", **IP real do cliente** por `CF-Connecting-IP` (sem isto o limitador de requisições da API trataria todos os clientes como um só) e **403 para quem não vier de IP da Cloudflare**; lista de IPs oficiais de 2026-10-19 (reconferir a cada 3 meses) |
| `deploy/oci/bootstrap-host.sh` | prepara o Ubuntu (ARM64/AMD64): Docker oficial, Compose ≥ 2.24.4, swap de 4 GB, rotação de logs do Docker, fail2ban e atualizações automáticas; **não** abre portas nem cria recursos |
| `deploy/oci/gen-env.sh` | gera o `.env` do servidor com segredos aleatórios (modo 600, nunca imprime valor, nunca sobrescreve) e a chave de cifragem do backup |
| `deploy/backup/Dockerfile` e `entrypoint.sh` | `rclone` na imagem de backup e repasse das variáveis `RCLONE_CONFIG_OFFSITE_*` ao cron (sem isto a cópia externa falharia em silêncio) |

Pilha completa, sempre nesta ordem (o `free` por último; o `cloudflare` só no modo Cloudflare):
`COMPOSE_PARALLEL_LIMIT=1 docker compose -f docker-compose.yml -f docker-compose.staging.yml -f docker-compose.cloudflare.yml -f docker-compose.free.yml up -d --build`

**Compatibilidade ARM64 (verificada no `package-lock.json`):** `@node-rs/argon2-linux-arm64-gnu`, `@next/swc-linux-arm64-gnu`, `@esbuild/linux-arm64`, `@rollup/rollup-linux-arm64-gnu` e `lightningcss-linux-arm64-gnu` estão no lockfile; o Prisma gera o motor nativo no próprio build; `bcrypt` compila no `npm ci` (a imagem tem `build-essential`). As imagens-base (`node:20-bookworm-slim`, `postgres:18-alpine`, `redis:7-alpine`, `caddy:2-alpine`, `nginx:1.27-alpine`) são oficiais multi-arquitetura (conhecimento geral: **confirme com `docker buildx imagetools inspect`**). **Nenhuma imagem foi construída** (sem Docker aqui).

### 19.5 Roteiro — o que SÓ você pode fazer, na ordem (agrupado para não interromper)

1. **Conta Oracle** (https://www.oracle.com/cloud/free/): criar a conta, escolher a **região-base com cuidado** (não muda depois) e conferir se pedem cartão/ativação de faturamento. Parar se pedirem upgrade.
2. **VM:** Compute → criar instância, shape **VM.Standard.A1.Flex com 2 OCPU e 12 GB**, imagem Ubuntu 24.04 (aarch64), boot 100 GB, chave SSH sua (a chave privada fica com você). Se aparecer "out of host capacity", tentar outro domínio de disponibilidade ou aguardar — **não** fazer upgrade sem decidir.
3. **Grupo de segurança (NSG/Security List) da VM:** entrada **somente**: 22 do **seu IP**; 80 e 443 dos IPs da Cloudflare (listas oficiais) — **nada de 5432, 6379, 3000–3002**.
4. **No servidor:** `sudo bash deploy/oci/bootstrap-host.sh` → obter o projeto (o pacote de transferência `CORTEX_HISTORICO_GIT.bundle`) → `sudo bash deploy/oci/gen-env.sh <seu-dominio>` → guardar cópia de `.env` e `backup.key` no cofre.
5. **Domínio e Cloudflare** (https://www.cloudflare.com/plans/): domínio no seu nome; DNS dos 4 nomes (`api`, `admin`, `super`, `balcao`) apontando para o IP da VM com a **nuvem laranja** (proxy); SSL/TLS **Full (strict)**; gerar o **Origin Certificate** (curinga) e salvar `origin.pem`/`origin.key` em `ORIGIN_CERT_DIR` no servidor (modo 600); ativar "Always Use HTTPS", TLS mínimo 1.2, ruleset gerenciado gratuito do WAF e "Bot Fight Mode"; regra de cache para **não** fazer cache de `api.*`; limitação de taxa em `/api/auth/*` **se** o plano Free oferecer (não verificado).
6. **Subir a pilha** (comando acima), conferir `docker compose ps` (todos "healthy"), rodar `deploy/homologacao/validar-homologacao.sh --tls` e **só então** criar o Super Admin pelo roteiro da §13 (este roteiro **não** cria o Super Admin).
7. **Cópia externa do backup:** criar um bucket no Object Storage da Oracle e uma chave do tipo "Customer Secret Key"; preencher no `.env` as variáveis `RCLONE_CONFIG_OFFSITE_*` e `BACKUP_OFFSITE_CMD` (exemplo comentado pelo `gen-env.sh`); depois **provar**: forçar um backup, ver o arquivo no bucket e **restaurar em outra máquina** (BACKUP_RECUPERACAO). Até lá o backup **não** é confiável.
8. **Aplicativos:** reconstruir o PDV e os APKs com `https://api.<seu-dominio>` (a URL é fixada no build) e assinar com o seu certificado/keystore ([DISTRIBUICAO_APLICATIVOS](DISTRIBUICAO_APLICATIVOS.md)).
9. **Monitoramento:** Sentry/Resend (§18) só com credenciais suas, e um verificador externo gratuito de disponibilidade (limites **não verificados** aqui). **Alertas só valem depois de uma notificação de teste recebida.**

Nunca envie senhas ou tokens no chat: coloque-os direto no `.env` do servidor ou no cofre.

### 19.6 Prontidão (honesta)

| Item | Estado |
| --- | --- |
| Arquivos de infraestrutura gratuita | **preparado**; a pilha base + WAL foi **executada no runner Linux do GitHub** (workflow Stack, 0 falhas, 2026-10-22); os overlays staging/cloudflare/free só tiveram `config` validado; **nunca executados em servidor real** |
| Servidor Oracle | **bloqueado**: depende da sua conta, da região e da capacidade disponível |
| Cloudflare/HTTPS/DNS | **preparado, depende de domínio e conta** |
| Backup externo e restauração em outro host | **preparado, depende de bucket e credenciais; não provado** |
| Produção | **não pronta** (HTTPS, backup externo restaurado, alertas reais e homologação no servidor pendentes) |

### 19.7 Admin Web na Cloudflare Workers: avaliado em 2026-10-22

> **ATUALIZAÇÃO (2026-10-22, tarde): a conclusão "NÃO viável sem migração relevante" abaixo foi SUPERADA.** Com o Next em 15.5.28, o adaptador OpenNext **constrói e roda** o Admin Web e o Super Admin no runtime do Workers (build no Windows e no Linux, pacote de 2,1 MiB gzip, login/sessão/CORS/rotas/permissões no workerd), sem migração de código. **Nada foi implantado e a integração NÃO está homologada para produção**; o Workers Builds continua reprovando até a configuração manual do painel (raiz `apps/admin-web`, comandos e variáveis). Tudo isso, com a causa comprovada da falha, as limitações e o passo a passo, está em **[CLOUDFLARE](CLOUDFLARE.md)**. O texto abaixo fica como registro da avaliação anterior (feita antes de o Next ser atualizado e de o adaptador ser testado); onde divergir do CLOUDFLARE, vale o CLOUDFLARE. O destino de implantação é o Google Cloud, não a Oracle.

O Workers Builds falhou com "application detection logic has been run in the root of a workspace" porque o repositório é um monorepo (`workspaces: apps/*, packages/*`) sem nenhum `wrangler.jsonc` e a raiz foi usada como diretório. Apontar o diretório para `apps/admin-web` não resolve: não há o que publicar nesse caminho hoje.

| Caminho | Resultado verificado |
| --- | --- |
| **OpenNext para Cloudflare** (`@opennextjs/cloudflare` 1.20.13, o adaptador oficial para Next no Workers) | Na avaliação, era **incompatível**: exige `next >=15.5.28 <16` ou `>=16.4.1` e o Admin Web estava no `next@14.2.35`. **Atualização (mesmo dia): o Next foi migrado para 15.5.28** (ver [CHANGELOG](CHANGELOG.md)), então esse pré-requisito deixou de existir; o adaptador em si **não foi instalado nem testado**. |
| **Exportação estática** (`output: 'export'`) + Workers Static Assets | **Falha no build** (testado): `Page "/dashboard/agreements/employees/[id]/statement" is missing "generateStaticParams()"`. Há 15 pastas de rota dinâmica `[id]`/`[slug]`; além disso os cabeçalhos de segurança e a CSP de `next.config.js` deixam de valer e teriam de ir para um arquivo `_headers`. |
| `@cloudflare/next-on-pages` (Pages, edge) | Descartado: caminho em descontinuação, exige `runtime = 'edge'` em todas as rotas. |

**O que o Admin Web é hoje:** 54 páginas, todas componentes de cliente (única exceção: o `layout.tsx` do painel), **sem** route handlers, middleware, Server Actions nem APIs de Node; as únicas variáveis são `NEXT_PUBLIC_*`, fixadas no build. Isso torna a migração tecnicamente viável, mas ela é um projeto (não uma configuração).

**Recomendação (mais segura): não publicar o Admin Web na Cloudflare Workers agora.** Manter o caminho já validado (contêiner `admin-web` do `docker-compose.yml`, construído e executado no CI) no servidor Oracle, com a Cloudflare apenas como DNS/proxy/HTTPS na frente (§19.4, `docker-compose.cloudflare.yml`). Além disso, o painel sozinho não funciona: ele precisa da API (`NEXT_PUBLIC_API_URL`, HTTPS) e do banco, que só existem no servidor. **Estado verificado em 2026-10-22:** o projeto Worker **`cortex` está conectado** a este repositório pelo Workers Builds: o commit `6b76f3d` recebeu o check "Cloudflare Workers and Pages / Workers Builds: cortex" com resultado **falha** (build `1a527e74…`), e cada push novo na `main` dispara outro build com falha até a conexão ser desfeita. Não há como interromper isso pelo repositório (não há arquivo de configuração da Cloudflare aqui); **é ação manual sua**, por um destes caminhos (os nomes dos menus podem variar um pouco na interface):

1. **Cloudflare** → *Workers & Pages* → projeto **cortex** → *Settings* → *Builds* → *Git repository* → **Disconnect**. Não apague o Worker; só desconecte o repositório.
2. Alternativa sem perder a conexão: no mesmo painel, *Build watch paths* com um caminho que nunca muda (por exemplo `/nao-construir`) ou deixar o *Deploy command* vazio; o build deixa de rodar de forma útil.
3. **GitHub** (garantia total): *Settings* → *Integrations/Applications* → *Cloudflare Workers and Pages* → *Configure* → remover o acesso a `Luis-silva23/cortex`.

Depois de desconectar, o check "Workers Builds: cortex" deixa de aparecer nos próximos commits. Nenhum recurso da Cloudflare foi alterado ou apagado nesta etapa.

**Se a opção Workers for desejada depois** (projeto próprio, após a API estar publicada): (1) ~~migrar Next para 15.5.28+~~ **feito em 2026-10-22** (React segue em 18.3; o Next 15 usa a própria cópia do React no App Router), o que também fechou o último crítico do `npm audit`; (2) adicionar `@opennextjs/cloudflare` e `wrangler` ao `apps/admin-web` com um `wrangler.jsonc` e `open-next.config.ts` (nome do Worker, `compatibility_flags: ["nodejs_compat"]`, `assets`); (3) no painel: **Root directory** `apps/admin-web`, **Build command** `npx opennextjs-cloudflare build`, **Deploy command** `npx opennextjs-cloudflare deploy`, variável de build `NEXT_PUBLIC_API_URL=https://api.<dominio>` (não é segredo; é fixada no build) e Node ≥ 22; (4) liberar a origem do Worker em `WEB_URL` da API (CORS) e conferir a CSP (`connect-src` com a API). Estes valores de (3) são o plano esperado pela documentação do adaptador e **não foram executados**.

## 20. Checklist executável de homologação (Oracle + Cloudflare) e verificações da rodada de 2026-10-20

Nada abaixo foi executado em servidor: **não há** Docker, Linux/WSL, conta Oracle, domínio nem Cloudflare neste computador. Os arquivos e comandos existem e foram validados só estaticamente (sintaxe YAML dos 5 compose, `bash -n` dos 11 scripts, workflow de CI). Ordem (cada passo só começa quando o anterior passou):

| # | Quem | Ação | Comando / prova de que passou |
|---|---|---|---|
| 1 | dono | Conta Oracle, região, VM Ubuntu 24.04 **A1 (2 OCPU/12 GB, arm64)**; grupo de segurança: entrada 22 (só o seu IP), 80 e 443 (só IPs da Cloudflare) | VM acessível por SSH com chave; nenhuma outra porta aberta |
| 2 | dono | Domínio e conta Cloudflare (plano Free); DNS `api.`, `admin.`, `super.`, `balcao.` apontando para o IP da VM, **com proxy ligado** | `dig +short api.<dominio>` devolve IP da Cloudflare |
| 3 | servidor | Levar o projeto (`git bundle`/ZIP **de dentro do Git**, não da pasta do Windows: `.gitattributes` fixa LF nos `.sh`) e preparar o host | `sudo bash deploy/oci/bootstrap-host.sh` termina com "Pronto"; `docker compose version` ≥ 2.24.4 |
| 4 | servidor | Gerar o `.env` (segredos aleatórios, nada impresso) | `deploy/oci/gen-env.sh <dominio>`; guardar cópia de `.env` e `backup.key` num cofre |
| 5 | dono | Cloudflare: certificado de origem (Origin CA) salvo em `ORIGIN_CERT_DIR` (`origin.pem`, `origin.key`); SSL **Full (strict)** | `ls $ORIGIN_CERT_DIR` mostra os 2 arquivos (modo 600) |
| 6 | servidor | Subir a pilha | `COMPOSE_PARALLEL_LIMIT=1 docker compose -f docker-compose.yml -f docker-compose.staging.yml -f docker-compose.cloudflare.yml -f docker-compose.free.yml up -d --build`; `docker compose ps` com tudo `healthy` |
| 7 | servidor | Validação pós-implantação | `deploy/homologacao/validar-homologacao.sh`; `https://api.<dominio>/api/health` 200 com `database/redis/queue/workers` ok; PostgreSQL e Redis **não** respondem de fora (`nmap`/porta 5432 e 6379 fechadas) |
| 8 | servidor | Autenticação e isolamento (usuário de teste criado de forma autorizada, **nunca** Super Admin com senha padrão): login, MFA, rota protegida sem token = 401, empresa A não vê dados da B | repetir os E2E apontando `E2E_*_URL` **só** se o ambiente for descartável |
| 9 | dono | Cópia externa do backup: bucket + chave (Object Storage Oracle, API S3) em `RCLONE_CONFIG_OFFSITE_*` e `BACKUP_OFFSITE_CMD` no `.env` do servidor | `sh deploy/homologacao/validar-backup-externo.sh <bucket>` (gera backup, confere o objeto no bucket e o SHA-256); o arquivo cifrado aparece no bucket |
| 10 | servidor | **Restauração a partir do bucket** num banco descartável | `npm run backup:drill` (ou `backup:verify`) com o arquivo baixado; só então o backup conta como provado |
| 11 | dono | Sentry/Resend só com chaves reais e um destinatário permitido; sem isso seguem desligados | e-mail de teste entregue (caixa de entrada conferida pelo dono) |
| 12 | dono | Aplicativos reconstruídos com `https://api.<dominio>` (PDV: `VITE_API_URL`; Android: `EXPO_PUBLIC_API_URL`); PDV assinado; APK com keystore do dono, incluindo `armeabi-v7a` se houver aparelho 32 bits | `apksigner verify --print-certs` com certificado de **produção** |

Reversão: `docker compose down` (volumes preservados), voltar o DNS/proxy da Cloudflare para "somente DNS" e restaurar o último backup verificado. **Homologação só é "online" quando os passos 6 a 8 passarem com o endereço acessível.**

**CI (`.github/workflows/ci.yml`, nunca executado no GitHub):** o usuário do serviço Postgres é superusuário e superusuário/dono ignoram a RLS — uma suíte rodada com ele passa mesmo com a RLS quebrada. O job de integração agora roda a suíte completa como o papel de execução **sem posse e sem BYPASSRLS** (`db:role-split-check -- --all`, que cria banco e papel temporários e prova que o papel não escala privilégio); a execução rápida como superusuário ficou só como regressão funcional. Validado localmente: o mesmo script com `--suites` (8 arquivos, 64 testes) passou como papel sem posse; `--all` equivale à suíte completa e não foi repetido nesta rodada. Os arquivos `docs/CORTEX/revisao-banco/{replay,role-split}-resultado.md` regenerados hoje diferem dos anteriores só na linha da execução (data/resultado): correspondem às verificações atuais.

**CSP (Admin Web e Super Admin):** `default-src 'self'`, conexões só para a própria origem e a API do build, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`. **Limite:** `script-src` mantém `'unsafe-inline'` — o Next injeta scripts inline de hidratação que mudam por página (hash fixo não serve) e o layout tem o script de tema; por isso a CSP **não** barra XSS por injeção de script inline. Correção segura = nonce por requisição via middleware, o que força renderização dinâmica de todas as páginas (mudança de arquitetura/desempenho, não feita nesta rodada). Validada em navegador real: 60 páginas (tema claro e escuro) sem violação.

**Jobs antigos que falharam no Redis de desenvolvimento (db 0; nada foi apagado nem reexecutado):** `audit-log` 57 (setembro; violação de chave estrangeira — a empresa/usuário do registro já não existia; sem como reaplicar; a fila retém falhas de auditoria de propósito); `request-metrics` 21 e `system-log` 6 (27/09; banco desligado durante o teste de caos; métricas obsoletas); `report` 5 (04/10; `date.toLocaleDateString is not a function` — o código atual já não contém essa chamada); `notification` 10 (13 e 18/10; `Custom Id cannot contain :` — corrigido em 2026-10-20 por `config/job-id.ts`; as rotinas recorrentes enfileiram de novo sozinhas, reexecutar os antigos só repetiria e-mails). Decisão: manter como evidência; limpar só com autorização.
