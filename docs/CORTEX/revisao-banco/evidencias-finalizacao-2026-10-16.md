# Evidências da finalização de produção — saídas reais (2026-10-15/16)

Saídas copiadas **sem edição de conteúdo** dos comandos executados nesta sessão, em máquina de desenvolvimento Windows com PostgreSQL 18.6, **sem Docker**. Senhas e URLs com senha foram substituídas por `***`/`<segredo-omitido>`. Nada aqui é validação de staging ou de produção. Interpretação e limites: [RELATORIO_FINALIZACAO_PRODUCAO](../RELATORIO_FINALIZACAO_PRODUCAO.md) e [BACKUP_RECUPERACAO](../BACKUP_RECUPERACAO.md).

## 1. Pipeline de papéis do compose reproduzido fora do Docker (`10-roles.sh` → `migrate deploy` como dono → `after-migrate.sql` → provas)

```
[10-roles] papéis criados: owner=hsim_owner app=hsim_app backup=hsim_backup (senhas não registradas)
  └─ 20261016110000_privilege_escalation_guards/
    └─ migration.sql
      
All migrations have been successfully applied.
--- atributos dos papéis
hsim_app|f|f|f|f
hsim_backup|f|t|f|f
hsim_owner|f|f|f|f
--- dono das tabelas
hsim_owner|107
--- papel da API
ERRO:  permissão negada para tabela _prisma_migrations
ERRO:  é necessário ser o dono da tabela users
ERRO:  permissão negada para tabela users
ERRO:  permissão negada para esquema public
0
--- papel de backup
52
ERRO:  permissão negada para tabela users
```

Leitura: papel da API sem superusuário/BYPASSRLS; as 107 tabelas (106 + `_prisma_migrations`) pertencem ao dono; a API **não** lê `_prisma_migrations`, **não** desliga RLS, **não** faz `TRUNCATE` nem cria tabela; o papel de backup lê as 52 migrações e **não** consegue `DELETE`.

## 2. `deploy/backup/backup.sh` — backup, verificação sem novo dump, estado

```
2026-10-15T09:39:28Z backup: iniciando (hsim_db em localhost)
2026-10-15T09:39:31Z backup: ok cortex-20261015T093928Z.dump.enc bytes=2262048 migracoes=52 duracao=2s offsite=sim cifrado=sim
2026-10-15T09:39:32Z verify: ok cortex-20261015T093928Z.dump.enc (hash confere, 1442 entradas no sumário)
estado=ok
operacao=verify
quando=2026-10-15T09:39:32Z
detalhe=ultimo=cortex-20261015T093928Z.dump.enc
ultimo_backup=cortex-20261015T093928Z.dump.enc idade_horas=0 bytes=2262048
  total 2267
  drwx------ 1 luis.silva 1049089       0 out 15 06:39 .
  drwx------ 1 luis.silva 1049089       0 out 15 06:39 ..
  -rw------- 1 luis.silva 1049089     296 out 15 06:39 backup.log
  -rw------- 1 luis.silva 1049089 2262048 out 15 06:39 cortex-20261015T093928Z.dump.enc
  -rw------- 1 luis.silva 1049089     258 out 15 06:39 cortex-20261015T093928Z.dump.enc.manifest
  -rw------- 1 luis.silva 1049089     102 out 15 06:39 status.txt
```

## 3. Casos negativos do `backup.sh`

```
=== 1. papel da API (sem BYPASSRLS) tenta fazer backup
2026-10-15T09:39:34Z ALERTA: backup falhou: o papel hsim_app não é BYPASSRLS/superuser: o dump sairia incompleto (ver deploy/db-runtime-role.sql)
arquivos de dump gerados: 0
=== 2. arquivo corrompido (1 byte alterado) e verify
2026-10-15T09:39:36Z verify: HASH DIVERGENTE em cortex-20261015T093928Z.dump.enc
2026-10-15T09:39:36Z ALERTA: verify falhou: backup cortex-20261015T093928Z.dump.enc corrompido ou ilegível
estado=falha
operacao=verify
quando=2026-10-15T09:39:36Z
detalhe=backup cortex-20261015T093928Z.dump.enc corrompido ou ilegível
ultimo_backup=cortex-20261015T093928Z.dump.enc idade_horas=0 bytes=2262048
status exit=1
=== 3. chave errada no verify (arquivo íntegro)
2026-10-15T09:39:39Z verify: não decifrou cortex-20261015T093928Z.dump.enc (chave ausente/errada)
2026-10-15T09:39:39Z ALERTA: verify falhou: backup cortex-20261015T093928Z.dump.enc corrompido ou ilegível
=== 4. retenção: arquivos sintéticos antigos
2026-10-15T09:39:41Z prune: removido cortex-20240101T000000Z.dump (idade 1018d)
2026-10-15T09:39:41Z prune: removido cortex-20250601T000000Z.dump (idade 501d)
2026-10-15T09:39:42Z prune: removido cortex-20260825T000000Z.dump (idade 51d)
2026-10-15T09:39:43Z prune: 3 removido(s); última cópia preservada: cortex-20261014T000000Z.dump
restaram: cortex-20260601T000000Z.dump cortex-20260801T000000Z.dump cortex-20260830T000000Z.dump cortex-20260901T000000Z.dump cortex-20261014T000000Z.dump 
--- alertas disparados:
ALERTA-DISPARADO: backup falhou: o papel hsim_app não é BYPASSRLS/superuser: o dump sairia incompleto (ver deploy/db-runtime-role.sql)
ALERTA-DISPARADO: verify falhou: backup cortex-20261015T093928Z.dump.enc corrompido ou ilegível
ALERTA-DISPARADO: verify falhou: backup cortex-20261015T093928Z.dump.enc corrompido ou ilegível
```

## 4. Ensaio de restauração em banco isolado (`npm run backup:drill -- … --compare-source --boot`)

```
OK    manifesto do backup presente — criado_em=20261015T093928Z · postgres 18.6 · migrações no manifesto 52 · cifrado=sim
OK    SHA-256 do arquivo confere com o manifesto — 2262048 bytes · 67725b4e12532a34…
OK    arquivo decifrado (AES-256, chave do cofre) — ok
OK    com chave errada o backup NÃO abre — recusado, como esperado
OK    pg_restore --list lê o sumário — 1442 entradas
OK    pg_restore --exit-on-error — restaurado em lnsystem_restore_drill_1792057187187 [3032 ms]
OK    pg_amcheck: tabelas e índices sem corrupção — nenhum problema [925 ms]
OK    migrações do restaurado = pastas do repositório — 52 concluídas · 52 no repositório · 0 incompletas
OK    migrações do restaurado = manifesto do backup — 52 × 52
OK    checksum de cada migração = SHA-256 do migration.sql do repositório — 52/52 conferem
OK    prisma migrate diff (restaurado × schema.prisma) vazio — sem deriva
OK    RLS ligado e FORÇADO nas tabelas de negócio — 106 com FORCE RLS de 106 tabelas · 161 policies
OK    policies do restaurado = origem — origem 161 · restaurado 161
OK    dono das tabelas preservado (não é o papel de runtime) — donos: hsim_owner
OK    papel de runtime sem contexto não lê nada — users sem contexto: 0
OK    papel de runtime com a empresa lê só a empresa — users visíveis 11 · esperado 11
OK    gerente de filial só lê a própria filial (regra de escopo restaurada) — vê 8 (esperado 8; 7 da filial) · de outras filiais: 0
OK    FKs NOT VALID do restaurado = as da origem (legado documentado) — 3: accounts_receivable.accounts_receivable_companyId_branchId_fkey,accounts_receivable.accounts_receivable_companyId_customerId_fkey,accounts_receivable.accounts_receivable_companyId_fkey
OK    nenhum índice inválido — 0 inválido(s)
OK    linhas iguais à origem em 23 tabelas — todas iguais
OK    API sobe contra o banco restaurado (papel de runtime) e /api/health/ready = 200 — {"status":"ready"}

TEMPO: restauração (pg_restore) 3032 ms · ensaio completo 30105 ms · arquivo 2262048 bytes
RESTAURAÇÃO VALIDADA: 21 verificações; banco isolado lnsystem_restore_drill_1792057187187 removido.
exit=0
```

## 5. PITR em laboratório isolado (`initdb` próprio, portas 55432/55433)

```
== 1. cluster novo com archive_mode=on
== 2. base backup (pg_basebackup, formato plano, WAL junto) + pg_verifybackup
base backup: 3 s
backup successfully verified
== 3. dados novos DEPOIS do base backup (ao longo do tempo) e instante-alvo
instante-alvo (logo antes do desastre): 2026-10-15 06:40:32.342515 -03  | linhas: 1800
== 4. DESASTRE simulado: DELETE FROM vendas (sem WHERE) + switch de WAL para arquivar
linhas depois do desastre: 0
WAL arquivado: 5 segmento(s)
== 5. RESTAURAÇÃO PITR em diretório NOVO (base + WAL até o alvo)
linhas no restaurado: 1800  (esperado 1800 = estado imediatamente antes do desastre)
RTO medido do laboratório: start+recuperação 1792057241-1792057238=3 s; até aceitar consultas fora de recuperação: 3 s
2026-10-15 06:40:41.574 -03 [17320] LOG:  recovery stopping before commit of transaction 756, time 2026-10-15 06:40:34.667181-03
2026-10-15 06:40:41.574 -03 [17320] LOG:  redo done at 0/402FCB8 system usage: CPU: user: 0.00 s, system: 0.04 s, elapsed: 0.11 s
2026-10-15 06:40:41.574 -03 [17320] LOG:  last completed transaction was at log time 2026-10-15 06:40:30.129972-03
2026-10-15 06:40:41.674 -03 [17320] LOG:  archive recovery complete
== 6. limpeza do laboratório
laboratório removido
```

## 6. Testes

### 6.1 Verificações estáticas e de banco (`chain1`)

```
== type-check database: OK
== type-check shared: OK
== type-check api: OK
== type-check admin-web: OK
== type-check super-admin: OK
== type-check pdv-desktop: OK
== type-check balcao: OK
== lint api: OK
== lint admin-web: OK
== lint super-admin: OK
== doc links: links conferidos: 726; quebrados: 0
== db:check-rls

> @ln-system/api@1.0.0 db:check-rls
> tsx scripts/check-rls.ts

[check-rls] "lnsystem_db": todas as invariantes de RLS OK
== db:replay-check

**Cenário de sessões (migration de refresh_tokens: hash, empresa e RLS):**

- Banco temporário 3: 40 migrations aplicadas (até a anterior à de refresh_tokens): sucesso.
- Dados sintéticos: 3 sessões legadas (token em texto): 2 do usuário da empresa A e 1 de plataforma; **uma das sessões da A gravada com a empresa da B** (inconsistente).
- `migrate deploy` com sessão de empresa divergente: **abortou como esperado**.
- Atomicidade: depois do aborto, coluna em texto ainda existe e coluna de hash não existe → **nada ficou pela metade; nenhuma sessão perdida**.
- Recuperação (corrigir a linha → `migrate resolve --rolled-back` → `migrate deploy`): **concluiu**.
- Sessões preservadas: o hash calculado em SQL é **igual** ao SHA-256 da aplicação nas 3 sessões → **sim** (o mesmo token continua achando a mesma linha).
- Empresa preenchida só pelo usuário: sessões da A → empresa A; sessão de plataforma → nula → **conforme**.
- Estado de revogação preservado (a revogada continua revogada, a ativa continua ativa): **sim**.
- Segredo em texto: coluna `token` removida e nenhum valor "legacy-…" restou em nenhuma coluna → **ausente**.
- Banco temporário 3 removido: sim.

**Cenário de filial/empresa (migration das FKs de empresa e filial: guarda, atomicidade, legado preservado):**

- Banco temporário 4: 42 migrations aplicadas (até a anterior à de FKs de empresa/filial): sucesso.
- Dados sintéticos: **1 produto da empresa A gravado com a filial da empresa B** e **1 cliente de empresa inexistente** (os dois aceitos pelo schema antigo, sem FK).
- `migrate deploy` com filial de outra empresa: **abortou como esperado** (a guarda recusou o dado cruzado e listou a tabela).
- Atomicidade: depois do aborto, FK de filial 0, FK de empresa 0 → **nada ficou aplicado pela metade**.
- Recuperação (corrigir a filial do produto → `migrate resolve --rolled-back` → `migrate deploy`): **concluiu**.
- Resultado: FK de filial validada = true; FK de empresa de `customers` validada = false (deve ser **false**: existe o cliente órfão); cliente órfão preservado = 1 → **o legado fica visível (NOT VALID) e nada foi apagado nem associado a empresa por suposição**.
- Linha NOVA com empresa inexistente: **recusada (P2003)** — NOT VALID protege tudo que entra daqui em diante.
- Banco temporário 4 removido: sim.

chain1 total 200s
```

### 6.2 Unitários, `backup:verify`, papel sem posse e integração (`chain2`/`c3`)

Unitários da API (rodada **final**, depois de completar o mock de `partners.routes.test` e criar o relatório):
```
Test Suites: 1 failed, 113 passed, 114 total
Tests:       1 failed, 1144 passed, 1145 total
```

(A primeira rodada de `chain2` reprovou 5 testes — 3 do `partners.routes.test` por causa do mock e 2 do `docs-consistency` por faltar o relatório; corrigidos e substituídos pela rodada acima.) Demais verificações de `chain2` (a partir do Admin Web):

```
== unit admin-web
exit=0
Test Suites: 32 passed, 32 total
Tests:       549 passed, 549 total
== logic pdv
exit=0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1935.2351
== logic balcao
exit=0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 873.0988
== backup:verify
exit=0
OK  segredos abrem com DATA_ENCRYPTION_KEY (MFA recuperável) — 2/2 abertos (valor não exibido)
OK  sem a chave certa os segredos NÃO abrem — 0 aberto(s) com chave errada
OK  MFA do Super Admin de demonstração recuperado do backup — segredo restaurado = segredo do app autenticador (comparação local, sem exibir)
OK  arquivo de backup não contém o segredo em texto puro — busca pelo segredo no conteúdo de users do backup

RESTAURAÇÃO VALIDADA: 18 verificações; banco temporário lnsystem_restore_check_1792055053147 removido.
== role-split --all
exit=1

npm error Lifecycle script `db:role-split-check` failed with error:
npm error code 1
npm error path C:\Users\luis.silva\Desktop\Minha bagunça\saas_m_fixed\Saas motos\apps\api
npm error workspace @ln-system/api@1.0.0
npm error location C:\Users\luis.silva\Desktop\Minha bagunça\saas_m_fixed\Saas motos\apps\api
npm error command failed
npm error command C:\Windows\system32\cmd.exe /d /s /c tsx scripts/db-role-split-check.ts --all
== integração ciclo 1
exit=0
Test Suites: 117 passed, 117 total
Tests:       1643 passed, 1643 total
== integração ciclo 2 (PG_ENV_DEBUG=1)
exit=0
Test Suites: 117 passed, 117 total
Tests:       1643 passed, 1643 total
chain2 total 1647s
```

Nota: no `chain2` o `role-split --all` terminou com `exit=1` e "Tests: ?" porque o `spawnSync` limitava a saída do jest a 1 MB e matava o processo (falha da **ferramenta**, não de teste); corrigido com `maxBuffer` e reexecutado isolado.

Papel sem posse, suíte COMPLETA, rodada isolada depois do ajuste de `maxBuffer` (arquivo `role-split-resultado.md`): **117 suítes / 1643 testes aprovados** com a aplicação conectada como papel sem posse.
