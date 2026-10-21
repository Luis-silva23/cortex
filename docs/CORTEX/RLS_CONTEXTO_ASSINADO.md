# Contexto de RLS assinado — risco, mitigação, garantias e limites

Decisão **151** (migração `20261017100000_rls_signed_context`). Escrito em 2026-10-15. Este documento diz **o que a medida garante, o que ela não garante e o que ainda depende de infraestrutura** — não declara barreira inviolável.

## 1. O risco

As policies de RLS decidem "quem é o usuário" lendo variáveis de sessão do PostgreSQL (`app.user_type`, `app.current_company_id`, `app.current_branch_id`). Qualquer comando SQL executado pelo papel de execução da API pode gravá-las com `set_config(...)`.

Consequência provada antes desta medida (decisão 132): **SQL arbitrário na conexão da API escolhia o contexto da RLS.** Uma injeção de SQL, um SQL cru com filtro frouxo ou uma conexão comprometida faziam `set_config('app.user_type','SUPER_ADMIN',true)` e a RLS inteira deixava de valer.

**Uma variável de sessão, sozinha, não impede isso**, nem uma configuração de transação (`SET LOCAL`): quem executa SQL na sessão escreve a mesma variável. Por isso a mitigação não confia na variável — confia numa **assinatura que o banco confere**.

## 2. A mitigação

1. A aplicação **assina** o contexto de cada requisição: HMAC-SHA256 sobre `v1|iat|empresa|filial ativa|filiais autorizadas|papel|usuário`, com o segredo `RLS_CONTEXT_SECRET` (base64, 32–64 bytes).
2. As GUCs `app.ctx_iat` e `app.ctx_sig` viajam na mesma transação do contexto (um único `set_config` em lote — `packages/database/src/context-signing.ts`).
3. O **banco** confere: `app_ctx._sig_ok()` (`SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`) recalcula o HMAC com o segredo guardado em `app_ctx_vault.secrets` e compara **por hash** (sem vazar prefixo por tempo). Janela de **±120 s** entre `iat` e o relógio do banco.
4. As funções `app_ctx.company_id()/branch_id()/branch_ids()/user_type()/user_id()/is_super_admin()/is_company_wide()` só devolvem o contexto **se a assinatura confere**; caso contrário devolvem `NULL`/falso e **a RLS nega tudo** (falha fechada).
5. O segredo vive num schema **sem nenhum privilégio** para o papel de execução (nem leitura, nem escrita, nem `provision`). Está guardado já derivado (ipad/opad do HMAC), em dois slots (rotação sem parada).
6. As 165 policies chamam os helpers como sub-select escalar `(SELECT app_ctx.x())`, que o PostgreSQL avalia **uma vez por consulta** (InitPlan). Medido: 200 mil linhas, 15 ms, contra 4 300 ms se a verificação fosse repetida por linha.
7. Os helpers antigos (`get_current_*`, `is_super_admin`, `rls_company_*`) continuam existindo e agora também **verificam** (seguros; usados por triggers e SQL avulso).
8. A **API recusa subir em produção** se o banco não exige assinatura, se rejeita a assinatura dela, ou se o papel de conexão é superusuário/`BYPASSRLS`/dono das tabelas (`apps/api/src/config/db-security.ts`; `REQUIRE_NON_OWNER_DB_ROLE`).

Em paralelo, o **conjunto de filiais autorizadas** passou a ser assinado (`app.current_branch_ids`): ver `docs/CORTEX/contracts/tenant-branch-scope.md` §10.

## 3. O que isso garante (e foi provado)

| Garantia | Prova |
| --- | --- |
| Papel de execução sem contexto assinado lê **0 linhas** | `rls-signed-context.integration.test.ts`; `db:role-split-check` §4b; simulação do pipeline (`hsim`) |
| `set_config('app.user_type','SUPER_ADMIN',…)` **sem assinatura válida** não dá acesso | idem |
| Assinatura **adulterada** (campo trocado), **expirada** (>120 s) ou feita com **outro segredo** é negada | `rls-signed-context` (7 testes); smoke SQL |
| O papel de execução **não lê** o cofre, **não chama** `provision`/`retire_previous`/`rewrite_policies` | `rls-signed-context`; `hsim` |
| Rotação do segredo sem parada (slot 2 aceita o anterior até `retire_previous`) | `rls-signed-context` |
| API **recusa subir** em produção: superusuário, dono das tabelas, banco sem exigência, segredo errado, credencial de backup | `db-security.test.ts` (8 testes) e `hsim` A1–A3, B1, B3 |
| Backup **não carrega o segredo**; banco restaurado **nega tudo** até provisionar de novo | `restore-drill` passo 3b (cofre fora do dump, restaurado exige assinatura, nega antes da provisão, volta depois) |

## 4. O que isso **não** garante — risco residual

1. **Quem executa código dentro do processo da API tem o segredo** (`RLS_CONTEXT_SECRET` está no ambiente do processo). Execução remota de código na API = contexto arbitrário. A medida **reduz** a superfície de "SQL injetado" para "código executado no processo", não a elimina.
2. **SQL injetado numa requisição fica com o contexto daquela requisição.** Não vira outro usuário, papel ou empresa — mas pode **reaproveitar a própria assinatura** (legível por `current_setting`) em outras transações da mesma conexão por até 120 s. É o limite da janela de validade.
3. **Superusuário e dono das tabelas ignoram a RLS** (e o dono pode `ALTER TABLE ... NO FORCE`). A medida só vale com o papel de execução **sem posse e sem BYPASSRLS** — por isso a guarda de partida e o `docker-compose.yml` separado em dono/execução/backup. Em desenvolvimento ainda se usa um papel só (aviso, não erro).
4. **Relógio do banco × API** precisa diferir menos que ±120 s; fora disso a assinatura é rejeitada (a guarda de partida acusa).
5. **Quem tem acesso de leitura ao `postgresql.conf`/memória do servidor ou é DBA** pode ler o cofre. A defesa aí é operacional (cofre de segredos, auditoria de acesso ao servidor), não do banco.
6. **O segredo é um ponto único.** Vazou = trocar (seção 5) e tratar a janela de exposição.
7. Esta medida **não** substitui a validação de escopo na aplicação (as rotas continuam checando papel, empresa e filial); é a **última camada**, não a única.

## 5. Operação

### Ordem de implantação (produção)
1. Gerar o segredo (`openssl rand -base64 32`) e guardá-lo no **cofre de segredos** — diferente de `JWT_SECRET` e `DATA_ENCRYPTION_KEY`.
2. `prisma migrate deploy` (como **dono**): cria as funções e as policies na forma rápida. **Não liga a exigência.**
3. `db-grants` (`deploy/postgres-init/after-migrate.sql`, como dono): concede DML ao papel de execução e executa `app_ctx.provision(<segredo>)`, que **liga a exigência**.
4. Subir a API com o **mesmo** `RLS_CONTEXT_SECRET`. A guarda confere antes de aceitar tráfego.

### Rotação
`SELECT app_ctx.provision(<novo>)` (como dono): o segredo anterior passa ao slot 2 e continua aceito. Atualizar o ambiente das instâncias da API, depois `SELECT app_ctx.retire_previous();`.

### Banco restaurado de backup
O backup exclui o schema do cofre (`pg_dump --exclude-schema=app_ctx_vault`). Depois de restaurar, **toda consulta com contexto é negada** (erro de cofre ausente = falha fechada) até provisionar: `npm run db:provision-context` (ou `app_ctx.provision` como dono). O script também alinha o dono do cofre ao dono das funções quando quem provisiona é superusuário (as funções `SECURITY DEFINER` rodam como o dono delas).

### Rollback
`UPDATE app_ctx.settings SET enforced = false;` volta a aceitar contexto cru (comportamento anterior) — a API em produção passa a **recusar subir** (a guarda exige a assinatura). Para desfazer a forma das policies, recriá-las pelas migrações anteriores; só então remover `app_ctx`/`app_ctx_vault`.

## 6. Como verificar

```
npm run db:check-rls                       # invariantes: FORCE RLS, policies na forma verificada, funções SECURITY DEFINER com search_path seguro, cofre sem grants
npm run db:role-split-check -- --all       # banco temporário com dono × execução: acesso cruzado, elevação e falsificação como papel real
npm run db:provision-context               # provisiona/confere o segredo do ambiente
npm test -- db-security                    # guarda de partida
```

Evidência de 2026-10-15 e limites do que foi executado: `docs/CORTEX/RELATORIO_SEGURANCA_PRODUCAO_2026-10-15.md`.
