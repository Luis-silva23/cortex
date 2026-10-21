# Relatório — missão de segurança, permissões, infraestrutura e liberação para produção

Escrito para: o dono do produto (aprovações) e o responsável de infraestrutura/DBA (execução). Execuções entre **2026-10-15 e 2026-10-18**, PostgreSQL 18.6 em Windows (sem Docker, WSL ou Linux). Decisões **151–156** em [DECISIONS](DECISIONS.md).

> **Regra deste relatório:** cada afirmação diz em qual nível está — **código corrigido** · **testes locais aprovados** · **simulado fora do Docker** · **staging validado** · **produção implantada**. Os dois últimos níveis **não foram atingidos**: não há acesso a staging nem a produção, e **nenhum deploy foi feito**. Nada aqui é "validado para produção".

## 1. Resumo

| Pedido da missão | Nível alcançado | Onde |
| --- | --- | --- |
| §2 Contexto da RLS escolhido por SQL arbitrário (risco crítico) | **Código corrigido + testes locais + simulação do pipeline** | decisão 151, [RLS_CONTEXTO_ASSINADO](RLS_CONTEXTO_ASSINADO.md) — **com risco residual documentado** (§4) |
| §3 Credencial de backup isolada da API | **Código corrigido + testes locais + simulação** | decisão 152 (§5) |
| §1 Permissões por filial (várias filiais por gerente) e convênios | **Código corrigido + testes locais (papel real)** | decisão 153, matriz (§3) |
| §4 Compose em Docker/Linux e staging HTTPS | **NÃO executado** — roteiro pronto | `validar-homologacao.sh` (§6, §7) |
| §5 Backup diário/meio-dia, WAL, PITR, alertas, cópia anonimizada | **Scripts provados em laboratório; destino externo, alerta real e outro host NÃO existem** | decisões 154/155/156 (§8) |
| §7 Migrações (checksums, replay, schema) | **Testes locais**: 54 do zero = catálogo do dev (3590 itens, 0 diferenças) | §9 |
| §9 Deploy | **NÃO executado** (sem acesso/aprovação); procedimento e reversão entregues | [PRODUCAO §17](PRODUCAO.md) |

Não foi criada conta Super Admin. Nenhum dado financeiro, ordem, histórico ou tabela foi apagado; o **recebível órfão** (3 FKs `NOT VALID`) foi **preservado** (e replicado igual nas simulações). RLS e restrições **não** foram desativadas. Nenhum módulo desativado foi habilitado. Nenhum segredo foi escrito em arquivo, log, relatório ou commit. Sem commit/push.

## 2. O que foi construído

- **Contexto de RLS assinado** (`20261017100000_rls_signed_context`): HMAC conferido pelo banco; sem assinatura válida a RLS nega tudo; 165 policies na forma de InitPlan; a API em produção recusa subir em configuração insegura.
- **Vários filiais por gerente** (`20261017110000_user_branches`): conjunto autorizado no banco, recalculado por requisição, assinado no contexto; rotas `GET/PUT /users/:id/branches` (só SA/COMPANY_ADMIN); dashboards, vendas, faturamento, convênios, usuários e auditoria seguem o conjunto.
- **Backup delegado:** a API pede/lista; só o serviço `backup` tem `BYPASSRLS`; restaurar/excluir pela API desligados em produção; cofre do segredo fora do dump.
- **WAL/PITR:** `wal-archive.sh`, `wal-fetch.sh`, `base-backup.sh`, `pitr-restore.sh`, `docker-compose.wal.yml`, `backup.sh wal-check`, `alert-webhook.sh`.
- **Anonimização** da cópia restaurada (`backup:anonymize`, `backup:drill --anonymize`).
- **Roteiro de homologação** `deploy/homologacao/validar-homologacao.sh` (PASS/FAIL por item; **não executado**).
- Correções achadas pelos próprios ensaios: veja §9.

## 3. Matriz de permissões por perfil, empresa e filial

Detalhe e provas: [tenant-branch-scope §10](contracts/tenant-branch-scope.md) e [permission-matrix](contracts/permission-matrix.md).

| Pergunta | Administrador empresarial (COMPANY_ADMIN / SA na empresa) | Gerente só da A | Gerente de A + B | Gerente de A + C (sem B) | Outra empresa |
| --- | --- | --- | --- | --- | --- |
| Dashboard consolidado, vendas, faturamento, indicadores | **todas as filiais da própria empresa** | só A | **A + B** | **A + C** | nada |
| Detalhe de uma filial (`?branchId=`) | qualquer da empresa | A; outra da empresa: **403 `BRANCH_FORBIDDEN`** | A ou B | A ou C | admin: **404**; papel de filial: 403 |
| Convênios (lista, filtro, id) | todos da empresa | A + "empresa toda" | A, B + "empresa toda" | A, C + "empresa toda" | nada |
| Convênios (criar/editar/mover) | qualquer | só A | A ou B (C e "empresa toda": 403) | A ou C (B: 403) | corpo com `companyId`/`branchIds` alheio **não grava** |
| Usuários e auditoria | toda a empresa | A + sem filial + administradores | A, B + … | A, C + … | nada |
| Promover, conceder perfil, ligar módulo, alterar vínculo | sim | **não** (rota + RLS + gatilho) | **não** | **não** | — |
| Módulo desativado (recebíveis, ordens…) | 403 `MODULE_DISABLED` | 403 | 403 | 403 | — |
| Vínculo removido (mesmo token) | — | — | B vira 403 na próxima requisição | — | — |
| `branchIds` no token, `X-Branch-Id(s)`, `companyId` em query/corpo, SQL cru com SUPER_ADMIN forjado | ignorados / **0 linhas** | idem | idem | idem | idem |

Autorização é por **vínculos armazenados** (`users.branchId` ∪ `user_branches`), não por lista enviada pelo cliente. **Decisões do dono ainda abertas** (não presumidas): (i) gerente vê administradores e usuários sem filial; (ii) convênio "da empresa toda" criado por gerente; (iii) teto de 50 filiais por usuário.

## 4. Manipulação do contexto da RLS — análise e medidas

Resumo (completo em [RLS_CONTEXTO_ASSINADO](RLS_CONTEXTO_ASSINADO.md)):

- **Antes:** qualquer SQL do papel de execução escrevia `app.user_type` etc. e virava SUPER_ADMIN. **Variável de sessão ou `SET LOCAL` sozinhas não impedem isso.**
- **Agora:** o banco exige assinatura HMAC (segredo em schema sem privilégio para o papel de execução); sem assinatura, nega tudo; secret fora do backup; API recusa subir em configuração insegura.
- **Provas:** papel sem posse sem contexto → 0 linhas; GUCs forjadas → 0; assinatura adulterada, expirada ou de outro segredo → negada; o papel não lê o cofre nem chama `provision`; rotação sem parada; `db:role-split-check` com a **suíte completa de integração (1684 testes) como papel sem posse**; simulação com a API em `NODE_ENV=production` (recusas A1–A3, B1, B3 e subida B2).
- **Risco residual (não é barreira inviolável):** código executando **dentro** da API tem o segredo; SQL injetado reaproveita a própria assinatura por até 120 s (mesmo contexto, nunca outro); superusuário/dono ignoram a RLS; relógio ±120 s; segredo é ponto único; DBA/leitura do servidor lê o cofre. A validação de escopo nas rotas permanece como outra camada.

## 5. Credencial de backup separada

Em produção a API roda em `BACKUP_MODE=delegated` sem `BACKUP_DATABASE_URL`/`DB_BACKUP_PASSWORD`; o papel `BYPASSRLS` existe só no serviço `backup`. Provado: testes (`DelegatedBackupService` 10, `backup-delegated` integração 6, `env.test`), `docs-consistency` (o compose não dá a credencial à API) e a **simulação**: a API recusou subir com `BACKUP_DATABASE_URL`, o pedido do arquivo foi consumido e removido pelo serviço, o `verify` passou, a API sobe sem a credencial. Restaurar/excluir pela API: 403. **Não executado:** o isolamento de volumes/contêineres no Docker real.

## 6. Resultado real do Compose em Docker/Linux

**Não há resultado: o Compose NÃO foi executado** (sem Docker/WSL/Linux). O YAML dos três arquivos (`docker-compose.yml`, `.wal.yml`, `.staging.yml`) foi **analisado** (js-yaml) e a lógica do pipeline foi **reproduzida** fora do Docker (§8.5), mas isso não prova `docker compose config/up`. Comando exato a rodar num host Linux: `sh deploy/homologacao/validar-homologacao.sh [--wal] [--tls <dominio>]`. **Pendente.**

## 7. Staging com HTTPS

**Não validado** — não há staging, DNS nem portas. O overlay `docker-compose.staging.yml` (Caddy, `ENFORCE_HTTPS`, portas internas fechadas) e as provas de TLS do roteiro (`--tls`: redirecionamento, cadeia, HSTS, portas 3001/5432/6379 fechadas) estão prontos. **Pendente.**

## 8. Backup, WAL, alertas e recuperação — evidências

Detalhe e limites: [BACKUP_RECUPERACAO](BACKUP_RECUPERACAO.md) §8.1–8.4.

| Item | Resultado real | Limite |
| --- | --- | --- |
| Dump diário (00:00) com papel dedicado, cifrado, manifesto, SHA-256 | executado: ≈ 2,3 MB, 54 migrações, 2 s | destino externo inexistente (`BACKUP_OFFSITE_CMD` sem destino) |
| Verificação do meio-dia **sem novo dump** | `verify`: hash + decifra + sumário (1358–1482 entradas) | idem |
| PITR (scripts de produção, cifrado) | 5 segmentos `.gz.enc`, 0 falhas; reenvio diferente **recusado**; base adulterado **recusado**; recuperação parou **antes** do `DELETE`: **1800 linhas**; 7 s (49 MB) | 7 s **não** é RTO de produção; overlay Compose não executado |
| Alerta | `alert-webhook.sh` entregou JSON a receptor **local** (200; HTTP 500 → 3 tentativas e erro); `wal-check` alertou arquivador falhando | **sem webhook real de uma pessoa** — pendente |
| Restauração (`backup:drill`) | **25 verificações aprovadas, 0 falhas** com papéis separados (restauração 4,4 s; ensaio 63 s), RLS/escopo/policies (165 = origem), FKs `NOT VALID` = origem, checksums 54/54 | mesma máquina, não é outro servidor |
| Cópia **anonimizada** | 66 tabelas, linhas inalteradas, 158 valores originais amostrados, **nenhum** encontrado; 5 recusas de segurança provadas | texto livre não reconhecido pode conter dado pessoal: revisão humana |
| Só dump diário ⇒ perda possível | **até ~24 h** (explicado; WAL reduz) | RPO **15 min** e RTO **1 h** são **propostas NÃO aprovadas**; retenção 30/12/12 também **pendente de aprovação** |

### 8.5 Simulação do pipeline do compose, sem Docker (0 falhas, 136 s)

`10-roles.sh` real → 54 migrações como dono → API em `NODE_ENV=production` **recusa** como superusuário, como dono e com banco sem exigência → `after-migrate.sql` (grants + provisão) → **recusa** com segredo errado e com `BACKUP_DATABASE_URL` → API **sobe** (`/api/health/ready` 200) → papel da API sem contexto vê 0, GUCs forjadas 0, não lê o cofre, não chama `provision` → backup pelo serviço (pedido consumido) → `backup:drill` com papéis separados e anonimização. Redis e porta da API fechados ao fim; banco/papéis `hsim_*` removidos.

## 9. Testes — resultados reais, falhas e correções

| Verificação | Resultado |
| --- | --- |
| `tsc` (7 workspaces) e lint (api, admin-web, super-admin) | limpos |
| Unitários API | **1188/1188** (118 suítes), depois das correções abaixo |
| Unitários Admin Web / Balcão / PDV | 549 / 9 / 37 |
| Integração completa (banco de teste) | **120 suítes, 1684/1684** |
| Integração completa como **papel sem posse** (`db:role-split-check --all`) | **120 suítes, 1684/1684 — APROVADO** |
| `db:check-rls` | OK |
| `db:replay-check` (54 do zero + 4 cenários de dado inconsistente) | catálogo = dev: **3590 itens, 0 diferenças**; guardas abortaram sem deixar nada pela metade; recuperação concluiu |
| `backup:verify` | OK |
| Build da API (`tsc`, `dist/`) | OK |
| Playwright | **não reexecutado** nesta rodada (nenhuma tela foi alterada; sem servidores subidos) |

**Falhas encontradas e corrigidas (nenhum teste teve a cobertura reduzida nem o resultado esperado trocado para passar):**
1. `status()` e a consulta de assinatura falhavam no banco **restaurado** (cofre ausente): a guarda de partida diz agora para reprovisionar; o ensaio aceita a negação por erro de cofre (falha fechada) e prova o retorno após provisionar.
2. Cofre provisionado por **superusuário** ficava com dono diferente do das funções `SECURITY DEFINER` (permissão negada): a rotina de provisão alinha o dono.
3. O ensaio contava a **tentativa revertida** de uma migração como "incompleta".
4. 18 testes de rota passaram a receber 503 porque o escopo agora vem do banco: usam um mock de unidade do escopo (o escopo real tem 8 testes de serviço, o do middleware e 28 de integração).
5. Teste de rotação do segredo falhava como papel sem posse: agora afirma que o papel é **negado** e o dono faz a rotação completa.
6. `psql` e o Windows: SQL com acento por argumento chegava inválido (anonimização) — passou por stdin; `cmd.exe` quebra comando com aspas/caminho com espaço (ambiente do laboratório, não do Linux).
7. `docs-consistency` ainda esperava o estado antigo (52 migrações; credencial de backup na API): atualizado para o estado correto e **ampliado** (compose, overlay, scripts sem segredo, roteiro não executado, `.env.example`).

## 10. Riscos residuais e aprovações pendentes

| Item | Situação |
| --- | --- |
| Risco residual do contexto assinado (§4) | **aceitar formalmente** ou tratar (cofre de segredos, auditoria de acesso ao servidor, rotação) |
| RPO 15 min / RTO 1 h / retenção 30-12-12 | **propostas — aprovação do dono/jurídico pendente** |
| Regras de visibilidade (gerente vê administradores/usuários sem filial; convênio "da empresa toda"; teto de 50 filiais) | **decisão do dono** |
| Recebível órfão (3 FKs `NOT VALID`) | **preservado**; tratar só com autorização |
| Conta Super Admin | **não criada** (procedimento: PRODUCAO §13) |
| Docker/Linux, staging HTTPS, off-site, alerta real, restauração em outro host, WAL em produção | **pendente de infraestrutura** (decisão 156) |
| Instalador do PDV sem assinatura de código | inalterado (pendência anterior) |

## 11. Implantação e reversão

[PRODUCAO §17](PRODUCAO.md): ordem (backup imediato → segredo no cofre → `validar-homologacao.sh` em homologação → `migrate deploy` como dono → `db-grants` com provisão → API com o mesmo segredo → vínculos de filial), tabela de reversão sem apagar dados e checklist. **Deploy de produção não executado**: não há acesso aos procedimentos/credenciais de produção, e as verificações críticas de infraestrutura (Docker, HTTPS, off-site, alerta, outro host) não puderam ser feitas — pelo critério da própria missão, não se libera produção com verificação ausente.

## 12. Hashes (SHA-256, primeiros 16 hex) dos artefatos principais

| Artefato | SHA-256 |
| --- | --- |
| `20261017100000_rls_signed_context/migration.sql` | `c65fad178561bc30…` |
| `20261017110000_user_branches/migration.sql` | `8e91210b00b807ad…` |
| `deploy/backup/backup.sh` | `3d66b86866848f18…` |
| `deploy/backup/wal-archive.sh` | `dccb8b1ae4779970…` |
| `deploy/backup/wal-fetch.sh` | `27c469c503353764…` |
| `deploy/backup/base-backup.sh` | `ac6cce72869dda0f…` |
| `deploy/backup/pitr-restore.sh` | `0ce049d59fbdd49e…` |
| `deploy/backup/alert-webhook.sh` | `7cdb6feb3b97f706…` |
| `deploy/backup/entrypoint.sh` | `bc0f096994078eb4…` |
| `deploy/backup/Dockerfile` | `67ae1f38fdc96bd3…` |
| `docker-compose.yml` | `8c36631072041e7f…` |
| `docker-compose.wal.yml` | `f8818553f34eadc5…` |
| `docker-compose.staging.yml` | `45cdad5eb350dc06…` |
| `deploy/postgres-init/after-migrate.sql` | `ff84e05b4ff7e75b…` |
| `deploy/homologacao/validar-homologacao.sh` | `2256f2a61655ca26…` |
| `apps/api/scripts/lib/anonymize.ts` | `0e4bd218f2cf78c9…` |
| `apps/api/scripts/restore-drill.ts` | `9d1abca16fd898d9…` |
| `apps/api/src/config/db-security.ts` | `d85315e4e48d29fb…` |
| `apps/api/src/services/branch-scope.service.ts` | `9707b7a2dce76a04…` |

Os scripts de PITR testados no laboratório são byte a byte os acima (SHA-256 conferido no laboratório). O pacote ZIP final e o SHA-256 completo de cada arquivo estão em `SHA256SUMS-seguranca-producao-2026-10-15.txt` (o ZIP não pode conter o próprio hash).
