# Relatório de finalização de produção — segurança multi-tenant, PostgreSQL, homologação e recuperação de desastre

> **Estado posterior (2026-10-15, missão de segurança e liberação).** Este relatório é o da finalização de 2026-10-16 e descreve o estado **daquela** rodada (52 migrações; gerente de uma filial só; credencial de backup ainda na API). Depois dele: **54 migrações**, contexto de RLS assinado (decisão 151), credencial de backup isolada da API (152), gerente com várias filiais (153), WAL/PITR e alertas (154), anonimização (155). Estado atual e evidências: [RELATORIO_SEGURANCA_PRODUCAO_2026-10-15](RELATORIO_SEGURANCA_PRODUCAO_2026-10-15.md).

Escrito para: o dono do produto (o que foi decidido, o que precisa aprovar) e o responsável técnico/infraestrutura (o que falta executar). Data-base **2026-10-15** (migrações datadas 2026-10-16). Este relatório só afirma o que foi **executado nesta sessão**; o resto está marcado como pendente. Evidências com a saída dos comandos: [evidencias-finalizacao-2026-10-16](revisao-banco/evidencias-finalizacao-2026-10-16.md).

## 1. Resumo executivo

| Nível de prontidão | Estado |
| --- | --- |
| **Código corrigido** | **Sim.** Regra de acesso por empresa/filial implementada em rotas, serviços, RLS e trigger; contrato dos dashboards; compose sem superusuário na API; scripts de backup, ensaio de restauração e PITR. |
| **Testes locais aprovados** | **Sim**, em máquina de desenvolvimento Windows com PostgreSQL 18.6 e Redis (números no §4). |
| **Pronto para homologação** | **Sim, com ressalva:** há procedimento e artefatos ([PRODUCAO §16](PRODUCAO.md)), mas o compose **nunca foi executado com Docker** — o pipeline de papéis foi reproduzido fora dele. |
| **Validado para produção** | **Não.** Faltam homologação em Linux/Docker, destino externo de backup, restauração em outro host, aprovação de RPO/RTO/retenção e confirmação de três regras de negócio (§9). |

**O que mudou de fato:** (1) o gerente de filial passou a enxergar **somente a própria filial** em 9 tabelas que só isolavam por empresa (usuários, equipamentos, convênios, auditoria, transferências, logs…), na API **e** no banco; (2) o administrador da empresa continua com o dashboard consolidado e o detalhe por filial **da própria empresa**; (3) o gerente deixou de poder, nem por SQL direto, promover-se, conceder perfil, **ligar um módulo desativado** ou mexer em filiais; (4) o compose conectava a API como **superusuário do PostgreSQL**, o que tornava a RLS inteira inerte — agora usa papéis separados; (5) backup diário cifrado com verificação ao meio-dia **sem novo dump**, ensaio de restauração com 21 verificações e PITR provado em laboratório.

## 2. Correções e arquivos alterados

| Área | Correção | Arquivos |
| --- | --- | --- |
| RLS por filial | leitura regra F, escrita estrita da própria filial; `users`, `user_roles`, `partners`, `installment_policies`, `devices`, `monitoring_thresholds`, `monitoring_threshold_changes`, `request_logs`, `system_logs`, `audit_logs`, `transfers` | `packages/database/prisma/migrations/20261016100000_branch_scope_rls/migration.sql` |
| Travas de privilégio | trigger em `users` (não muda `userType`/`companyId`/`branchId`/`isActive`); escrita empresarial em `user_roles`, `roles`, `permissions`, `role_permissions`, `company_module_settings`, `branches` | `…/20261016110000_privilege_escalation_guards/migration.sql` |
| Dashboards | `scopedBranchId`: gerente só a filial do token (403 `BRANCH_FORBIDDEN`), administrador só filial da empresa (404 `BRANCH_NOT_FOUND`), `branchId` inválido 400 | `apps/api/src/routes/dashboard.routes.ts` |
| Convênios / equipamentos | gerente só da própria filial; lista de equipamentos de uma licença fechada a OPERATOR/MECHANIC/VIEWER | `apps/api/src/routes/partners.routes.ts`, `activation.routes.ts` |
| Compose | papéis dono/execução/backup, `db-grants`, serviço `backup`, `ENABLE_AUTO_BACKUP=false` na API | `docker-compose.yml`, `deploy/postgres-init/10-roles.sh`, `deploy/postgres-init/after-migrate.sql`, `.env.example` |
| Backup | script POSIX (backup, verify, prune, status), contêiner com cron 00:00 e 12:00 | `deploy/backup/backup.sh`, `entrypoint.sh`, `Dockerfile` |
| Restauração | ensaio em banco isolado, 21 verificações | `apps/api/scripts/restore-drill.ts`, `apps/api/package.json` (`backup:drill`) |
| Ferramenta | `db:role-split-check` matava o jest com saída > 1 MB (resultado "Tests: ?"); `maxBuffer` | `apps/api/scripts/db-role-split-check.ts` |
| Testes | `branch-scope-access` (28, novo), `dashboard-management` (contrato 403), `mfa-company-admin` (token do gerente com filial), `partners.routes.test` (+7 do escopo de filial), `docs-consistency` (52 migrações, compose, backup) | `apps/api/test/integration/*`, `apps/api/src/routes/partners.routes.test.ts`, `apps/api/src/docs-consistency.test.ts` |
| Documentação | BACKUP_RECUPERACAO, este relatório, DECISIONS 143–150, contratos de escopo e de permissões, PRODUCAO §4/§7/§16, SECURITY, CHANGELOG, CURRENT_STATE, CODE_MAP, README, BANCO_DE_DADOS/RELATORIO_MIGRATIONS regerados | `docs/CORTEX/*` |

Decisões **143–150** em [DECISIONS](DECISIONS.md). Mudança de contrato deliberada: **decisão 145** (pedir outra filial agora é 403, antes era 200 silencioso).

## 3. Matriz de permissões por perfil, empresa, filial e módulo

Completa em [tenant-branch-scope §9](contracts/tenant-branch-scope.md) e [permission-matrix](contracts/permission-matrix.md). Resumo:

| Pergunta | COMPANY_ADMIN | MANAGER (filial A1) | OPERATOR / MECHANIC / VIEWER (A1) |
| --- | --- | --- | --- |
| Dashboard consolidado da empresa | ✅ | ❌ (recebe a própria filial) | ❌ |
| Detalhe de uma filial | ✅ qualquer da empresa | só A1; outra → **403** | só A1 |
| Outra empresa, sabendo ids/URLs/parâmetros | ❌ 404 | ❌ 404 | ❌ 404 |
| Faturamento / `/financial` (módulo FINANCEIRO ligado) | ✅ | ✅ só A1 | ❌ |
| Recebíveis ou OS com o módulo **desativado** | ❌ 403 `MODULE_DISABLED` | ❌ 403 | ❌ 403 |
| Usuários | lê/grava a empresa | lê A1 + sem filial + administradores; grava só A1 | diretório |
| Convênios | lê/grava todos | lê A1 + empresa toda; grava só A1 | — |
| Equipamentos | todos da empresa | só A1; encerrar sessão só de A1 | ❌ listar |
| Auditoria | empresa | só ações de usuários de A1 | ❌ |
| Logs de requisição/sistema e limiares de monitoramento | ✅ | ❌ | ❌ |
| Transferências | todas | só as com A1 como origem ou destino | — |
| Ligar módulo / conceder perfil / mudar o próprio `userType`, por API **ou SQL direto** | ✅ (API) | ❌ | ❌ |

Os módulos que devem ficar desativados **não foram habilitados**; os testes exercitam o 403 com o módulo desativado e a RLS impede o gerente de ligá-lo por SQL.

## 4. Resultados dos testes (todos sequenciais; nenhum teste de carga)

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Tipos | `npm run type-check` em database, shared, api, admin-web, super-admin, pdv-desktop, balcao | **7/7 limpos** |
| Lint | `npm run lint` em api, admin-web, super-admin | **0 erros** |
| Links da documentação | `node scripts/check-doc-links.js` | **762 links, 0 quebrados** (rodada final, com os documentos novos) |
| RLS | `npm run db:check-rls` | **"todas as invariantes de RLS OK"** (106/106 tabelas com FORCE, 161 policies) |
| Migrações do zero | `npm run db:replay-check` | 52 migrações do zero = catálogo do dev (**3 565 itens**, 0 diferenças), `migrate diff` vazio, 3 cenários com dado inconsistente (guarda aborta, recuperação conclui) |
| Unitários API | `npm test --workspace=@ln-system/api` | **1 145 testes, 114 suítes** aprovados (inclui `docs-consistency` e os 7 novos de `partners.routes`) |
| Build API | `npm run build --workspace=@ln-system/api` (+ `type-check`, `lint` desta rodada final) | **limpos** |
| Unitários Admin Web | `npm test --workspace=@ln-system/admin-web` | **549 testes, 32 suítes** aprovados |
| Lógica PDV / Balcão | `npm run test:logic` | **37 / 9** aprovados |
| Integração completa (2 ciclos limpos, o 2º com `PG_ENV_DEBUG=1`) | `npm run test:integration` | **117 suítes, 1 643 testes**, nos dois ciclos |
| **Papel sem posse** (a suíte completa com a API conectada como papel sem superusuário e sem BYPASSRLS) | `db:role-split-check -- --all` | **117 suítes / 1 643 testes aprovados**; DDL negado (desligar RLS, apagar policy/tabela, `TRUNCATE`, `CREATE TABLE`, apagar restrição) |
| Backup do `BackupService` + restauração | `npm run backup:verify` | **18/18** |
| Ensaio de restauração do arquivo do agendador | `backup:drill -- … --compare-source --boot` | **21/21** (§6) |
| Playwright (Chrome real, subconjunto controlado) | `admin-web-flow` + `catalog-and-help` | **16/16**. **Não** foram executados os outros 7 arquivos (`pdv-sale-flow` grava venda permanente na trilha financeira; os de MFA exigem a API com variáveis especiais) |

Falhas encontradas **nesta rodada** e corrigidas sem reduzir cobertura nem enfraquecer verificações:

1. `dashboard-management`: esperava o contrato antigo (200 silencioso) → atualizado para 403 `BRANCH_FORBIDDEN` **de propósito** (decisão 145).
2. `mfa-company-admin`: token do gerente sem `branchId` (irreal) → o token passa a carregar a filial, como o login real.
3. `branch-scope-access`: três ajustes de expectativa do PostgreSQL (UPDATE de linha visível mas proibida levanta 42501; `INSERT … RETURNING` exige policy de SELECT; seção de módulos desativados reordenada).
4. `destructive-guard` (varredura estática) reprovou um `deleteMany` do novo teste escopado só por `roleId` → passou a escopar por `id`.
5. `partners.routes.test` (unitário): a rota agora consulta `getById` antes de autorizar → mock completado e **+7 casos** do gerente (empresa toda, outra filial, própria filial, sem filial, 404, administrador).
6. `db:role-split-check`: saída de jest > 1 MB matava o processo (resultado "Tests: ?") → `maxBuffer` + registro de erro; a rodada seguinte aprovou 117/1 643.
7. `restore-drill`: booleano do PostgreSQL lido como `t` em vez de `true` → corrigido (reprovava as migrações).
8. **Prova vermelha** do escopo: contra a RLS antiga, **16 dos 28** testes de `branch-scope-access` falham; contra a nova, 28/28.

## 5. PostgreSQL e migrações — evidências

- **52 migrações** (36 + 14 da revisão do banco + 2 desta finalização), `0_init` e as demais **sem alteração de checksum**; as duas novas aplicadas em dev e teste. Nenhuma migração antiga foi editada; o cabeçalho da `20261016100000` mostra "2026-10-16" só no nome/rótulo (a data real de criação é 2026-10-15).
- Do zero: `db:replay-check` (52 migrações) e, de novo, `prisma migrate deploy` **como papel dono sem superusuário** num banco vazio (simulação de homologação) → "All migrations have been successfully applied".
- Consistência: `prisma migrate diff` banco × `schema.prisma` **vazio** (dev, reaplicado e restaurado do backup); checksums de 52/52 migrações do restaurado = SHA-256 dos `migration.sql` do repositório.
- RLS/FORCE: 106/106 tabelas; 161 policies. FKs compostas, índices, restrições e livros append-only: cobertos pelos testes `database-schema-invariants`, `company-branch-fk-restrict`, `append-only-ledgers`, `same-company-ref-triggers` (todos aprovados nos dois ciclos).
- Idempotência/concorrência/impasse: `idempotency-key` e a regra de travar o pai antes do filho (decisões 138–139) aprovados; **nenhum impasse** nos dois ciclos.
- Papéis: dono (migrações), execução (API) e backup separados; provado com o papel de execução que ele não lê `_prisma_migrations`, não desliga RLS, não faz `TRUNCATE`/`CREATE TABLE`. Comportamento da aplicação diante de integridade: `RESTRICT` → 409 `RECORD_IN_USE`/`BRANCH_IN_USE`.
- **Recebível órfão preservado:** 1 linha de `accounts_receivable` de empresa que não existe mais mantém **3 FKs `NOT VALID`**; nada foi apagado, associado ou validado; o backup e a restauração as devolvem idênticas (3 = 3). Tratar exige autorização do dono ([PRODUCAO §4](PRODUCAO.md)).
- **Segredos:** nenhuma senha ou URL com senha nos arquivos entregues (varredura no §11).

## 6. Backup e restauração

Estratégia, retenção, criptografia, custo e riscos: [BACKUP_RECUPERACAO](BACKUP_RECUPERACAO.md). Estado real:

- **Pronto e executado localmente:** `deploy/backup/backup.sh` — backup 00:00, verificação 12:00 sem novo dump (hash + decifrar + sumário + amostra rotativa), retenção 30/12/12, `status` com saída 0/1/2, alerta por gancho. Backup real: **2 262 048 bytes, 52 migrações, 2 s**. Três cenários de falha detectados e alertados (papel sem BYPASSRLS, arquivo adulterado, chave errada).
- **Ensaio de restauração (banco isolado `lnsystem_restore_drill_<ts>`, removido ao fim):** manifesto e SHA-256 conferem; chave errada não abre; `pg_restore --exit-on-error` em **3,0–3,1 s**; `pg_amcheck` sem problemas (1,0 s); 52/52 migrações e checksums; `migrate diff` vazio; RLS 106/106 e 161 policies iguais à origem; papel de execução sem contexto lê 0, com a empresa lê só a empresa, **gerente lê só a própria filial**; 3 FKs `NOT VALID` iguais; 23 tabelas com as mesmas linhas; **a API sobe** e `/api/health/ready` = 200. **21/21; ensaio completo 30,1 s** para um arquivo de 2,26 MB.
- **PITR em laboratório isolado** (`initdb` próprio): base backup 4 s verificado por `pg_verifybackup`; `DELETE` sem `WHERE` desfeito recuperando até o instante anterior (**1 800 linhas**), 3 s.
- **Não executado:** serviço `backup` no Docker; cópia off-site real (só simulada por cópia local); alerta para uma pessoa real; restauração em outro host; WAL archiving no servidor de verdade.

## 7. RPO e RTO — propostos, **PENDENTE DE APROVAÇÃO**

| | Proposta | Condição para valer |
| --- | --- | --- |
| RPO | **≤ 15 min** | WAL archiving ligado em produção + destino externo + alerta. **Só com o dump diário o RPO real é de até 24 h.** |
| RTO | **≤ 1 h** | medir uma restauração com cópia anonimizada do volume real; o medido aqui (3 s / 30 s) é de um banco de 43 MB e **não** se extrapola |
| Retenção | 30 diários / 12 semanais / 12 mensais | aprovação do dono e do jurídico (decisão 141) |

**Aprovações necessárias:** RPO/RTO (dono), retenção (dono/jurídico), destino externo e plantão de alerta (infraestrutura), manter ou retirar `request_logs` do dump (dono).

## 8. Homologação e liberação

Procedimento passo a passo, rollback e **checklist de liberação controlada**: [PRODUCAO §16](PRODUCAO.md). Nada do checklist foi marcado como executado.

## 9. Bloqueios e pendências que permanecem (objetivo)

| # | Pendência | Tipo | Quem |
| --- | --- | --- | --- |
| 1 | Executar o `docker compose` (papéis, `db-grants`, serviço `backup`) em Linux com Docker | infraestrutura | infra |
| 2 | Staging com PostgreSQL 18 em Linux, HTTPS e domínio ([PRODUCAO §15](PRODUCAO.md)) | infraestrutura | infra |
| 3 | Destino externo do backup com bloqueio de objeto; canal de alerta; plantão | infraestrutura | infra |
| 4 | Restauração em **outro host** com cópia anonimizada do volume real e RTO medido | infraestrutura | infra |
| 5 | WAL archiving/PITR ligado no servidor de verdade | infraestrutura | infra |
| 6 | Aprovar RPO/RTO e retenção (decisões 106, 141, 149) | negócio/jurídico | dono |
| 7 | Confirmar regras de escopo: gerente vê COMPANY_ADMIN e usuários sem filial; gerente não cria convênio "da empresa toda"; nenhum cliente depende do 200 silencioso (decisões 145–147) | negócio | dono |
| 8 | Recebível órfão (3 FKs `NOT VALID`): tratar com autorização ou aceitar formalmente | negócio | dono |
| 9 | Super Admin **não foi criado** (procedimento em PRODUCAO §13) | operação | responsável de TI |
| 10 | Limite arquitetural: quem executa SQL arbitrário na conexão da API ainda escolhe o contexto da RLS (`set_config`); não resolvido | arquitetura | decisão futura |
| 11 | A API recebe `BACKUP_DATABASE_URL` (BYPASSRLS) para o backup manual do Super Admin; remover se não for necessário | segurança | dono/infra |
| 12 | Adotar o papel de execução no banco de produção existente (`deploy/db-runtime-role.sql`) | infraestrutura | DBA |
| 13 | Playwright: 7 dos 9 arquivos não foram reexecutados (persistem dado financeiro ou exigem configuração especial) | cobertura | QA |
| 14 | Pendências herdadas e não tocadas: decisões 109–112, 113–119, 120 (jurídico), instalador sem assinatura | negócio/infra | dono |

## 10. O que NÃO foi feito (por restrição ou por falta de ambiente)

Sem commit, push, deploy ou alteração em produção. Super Admin **não** criado. Nenhum dado financeiro, histórico ou inconsistência existente foi apagado (as únicas remoções foram bancos/papéis **descartáveis de simulação** criados e removidos por esta sessão). RLS e restrições de integridade **não** foram desativadas para contornar falha. Nenhum módulo desativado foi habilitado. Não existe nem foi criado módulo "PDV Web": o produto usa o PDV Desktop (Electron). Nenhum teste de carga ou estresse.

## 11. Integridade dos artefatos entregues

Pacote: `docs/CORTEX/CORTEX-finalizacao-producao-2026-10-15.zip`. Manifesto com o SHA-256 **de cada arquivo e do próprio ZIP**: `docs/CORTEX/SHA256SUMS-finalizacao-producao-2026-10-15.txt` (o hash do ZIP não pode ficar dentro do ZIP nem deste relatório; está no manifesto e na mensagem de entrega). Dentro do ZIP há ainda um `SHA256SUMS.txt` por arquivo.

Como conferir:
1. `sha256sum CORTEX-finalizacao-producao-2026-10-15.zip` (ou `Get-FileHash -Algorithm SHA256`) e comparar com a última linha do manifesto;
2. extrair o ZIP numa pasta **nova e vazia** e rodar `sha256sum -c SHA256SUMS.txt` dentro dela (todas as linhas `OK`);
3. conferir que `packages/database/prisma/migrations` tem **52** pastas com `migration.sql`.

Varredura de segredos no conteúdo do pacote (JWT, chave privada, URL com senha, URL de Redis com senha, segredo `enc:v1`, chave AWS): resultado no rodapé de verificação final.

## Verificação final

Conferido por extração do ZIP numa pasta separada (script de empacotamento, execução final):

- **124 arquivos** no pacote = 123 arquivos listados + `SHA256SUMS.txt`; **52** `migration.sql`;
- **123/123 hashes conferem** e os 123 arquivos são idênticos aos do repositório no momento do empacotamento (0 divergentes);
- varredura de segredos: **0 ocorrências** (JWT, chave privada, URL com senha, URL de Redis com senha, `enc:v1`, chave AWS);
- ficaram **fora** do pacote, de propósito, `.env.example` (traz senhas de exemplo documentadas, que a API recusa em produção; as variáveis novas estão em `docker-compose.yml` e [PRODUCAO §16](PRODUCAO.md)) e `destructive-guard.integration.test.ts` (contém `u:p@` fictício e não foi alterado); continuam no repositório;
- o pacote **não** contém `.env`, credenciais de demonstração (`apps/api/.demo`), chaves, backups nem bancos.

Estado do ambiente ao final: servidores de desenvolvimento parados; bancos e papéis de simulação (`hsim_*`) e o cluster de PITR **removidos**; bancos de desenvolvimento e teste preservados.
