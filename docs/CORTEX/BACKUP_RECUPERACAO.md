# Backup e recuperação de desastre — estratégia, estado real e evidências

Escrito para: o dono do produto (decisões e aprovações) e o responsável de infraestrutura/DBA (execução). Data-base: **2026-10-15** (atualizado na missão de segurança e liberação). Complementa [PRODUCAO §7](PRODUCAO.md) (procedimento de recuperação) e a decisão **106/149/150** em [DECISIONS](DECISIONS.md).

> **Regra deste documento:** cada afirmação diz se foi **executada nesta máquina de desenvolvimento** (com o comando e o número medido), **preparada e não executada** (falta infraestrutura) ou **proposta** (depende de aprovação). Nada abaixo é "validado para produção".

## 1. Estado em uma tabela

| Item | Estado | Evidência / o que falta |
| --- | --- | --- |
| Backup lógico completo (`pg_dump -Fc`) com papel dedicado, cifrado, com manifesto e SHA-256 | **Executado localmente** | `deploy/backup/backup.sh backup` contra um banco com papéis separados: ≈ 2,3 MB, **54 migrações** no manifesto, 2 s; o cofre do segredo de RLS **não vai no dump** (§6, §8.3) |
| Verificação de integridade do meio-dia **sem novo dump** | **Executado localmente** | `backup.sh verify`: hash confere + decifra + `pg_restore --list` (1.358–1.482 entradas conforme o banco) + uma amostra rotativa de um backup antigo (§6) |
| Falhas detectadas e alertadas (papel sem BYPASSRLS, arquivo corrompido, chave errada) | **Executado localmente** | 3 cenários negativos, 3 alertas disparados (§6.3) |
| Retenção 30 diários / 12 semanais / 12 mensais | **Executado localmente** com arquivos sintéticos | 8 arquivos de idades diferentes → 3 removidos, última cópia sempre preservada (§6.3) |
| Restauração em banco **isolado** com verificações | **Executado localmente** | `npm run backup:drill --anonymize` (dev, papel único): restauração ≈ 3 s; **com papéis separados (simulação do pipeline): 25 verificações aprovadas, 0 falhas**, restauração 4,4 s, ensaio completo 63 s (§7, §8.4) |
| API sobe contra o banco restaurado com o papel de execução | **Executado localmente** | `/api/health/ready` = 200 dentro do `backup:drill --boot` (§7) |
| PITR (WAL archiving + base backup + recuperação até um instante) | **Executado em laboratório isolado, com os scripts de produção** | `wal-archive.sh` (cifrado), `base-backup.sh`, `pitr-restore.sh`: 1.800 linhas recuperadas exatamente antes de um `DELETE` sem `WHERE`; 7 s num banco de 49 MB (§8.1). **Não está ligado no banco de desenvolvimento nem em produção** |
| Serviço de backup no `docker-compose.yml` (cron 00:00 e 12:00, volume próprio) | **Preparado, não executado** | não há daemon Docker na máquina; o `backup.sh`, o `entrypoint.sh` (lógica) e o pipeline de papéis/migração/`db-grants` foram exercitados fora do Docker (§6.1). Roteiro de execução real: `deploy/homologacao/validar-homologacao.sh` (**não executado**) |
| Cópia fora do servidor (off-site) | **Gancho pronto, destino inexistente** | `BACKUP_OFFSITE_CMD`; foi exercitado com uma cópia local **simulada** |
| Alerta de falha para pessoa/canal real | **Gancho pronto, destino inexistente** | `BACKUP_ALERT_CMD` + `alert-webhook.sh` (JSON, 3 tentativas): entrega provada contra um receptor HTTP **local**; falta o webhook de uma pessoa/canal real (§8.2) |
| Restauração em **outro host** / em staging Linux | **Não executado** | decisões 150/156; a cópia **anonimizada** já é gerada e provada (§8.4) |
| WAL archiving/PITR em produção | **Não ligado** | decisão 154: overlay `docker-compose.wal.yml` pronto e **não executado** (PostgreSQL gerenciado já traz) |
| Credencial de backup fora da API | **Código e testes locais** | modo delegado (decisão 152, §8.3) |
| RPO/RTO | **Propostos, pendentes de aprovação** | §9 |

## 2. O que foi medido (e o que não existe ainda)

| Medida | Valor | Como |
| --- | --- | --- |
| Versão do servidor e das ferramentas | PostgreSQL **18.6** (`pg_dump`, `pg_restore`, `pg_basebackup`, `pg_verifybackup`, `pg_amcheck`, `initdb`, `pg_ctl` 18.6) | `SHOW server_version` |
| Tamanho do banco de desenvolvimento | **43 MB**, 106 tabelas | `pg_database_size` |
| Quem ocupa o espaço | `request_logs` **18 MB**, `audit_logs` 1,2 MB, `system_logs` 0,7 MB, `refresh_tokens` 0,4 MB | `pg_total_relation_size` |
| Dump lógico (`-Fc`, comprimido) do banco de desenvolvimento | **2,23 MB** (≈ 5 % do banco); **0,75 MB** sem os dados de `request_logs` | `pg_dump -Fc \| wc -c` |
| `wal_level` / `archive_mode` / `max_wal_size` | `replica` / **off** / 1 GB | `SHOW` — o servidor já escreve WAL em formato arquivável, falta ligar o arquivamento |
| Crescimento em produção | **Não medido — não há produção.** O `manifest` de cada backup grava `bytes`; 30 dias de manifestos dão a curva real | §5 |

Os números acima são de **dados sintéticos de desenvolvimento**; não os extrapole para produção.

## 3. Decisão técnica proposta: qual tipo de backup

| Opção | Veredito | Por quê |
| --- | --- | --- |
| **Completo lógico diário (`pg_dump -Fc`) às 00:00** | **Adotar como base** | É o ponto de partida pedido; restaura em qualquer servidor/versão compatível, permite restaurar uma tabela, é verificável (`pg_restore --list`), e no tamanho atual custa segundos e poucos MB |
| **Verificação de integridade ao meio-dia, sem novo dump** | **Adotar** | Um segundo backup completo às 12:00 só reduziria o RPO de 24 h para 12 h com o dobro de leitura no banco em horário comercial; a verificação lê **apenas o arquivo** (hash + decifrar + sumário), não toca o banco, e descobre corrupção de armazenamento no mesmo dia |
| **WAL archiving + base backup semanal (PITR)** | **Necessário para RPO de minutos — proposto, depende de infraestrutura** | O dump diário **não** atende RPO ≤ 15 min: na pior hora perde-se até 24 h de vendas, caixa e estoque. O PITR provado em laboratório (§8) recupera até o segundo anterior ao incidente |
| Incremental/diferencial de arquivos (`pg_basebackup --incremental`, PostgreSQL 17+) | **Não agora** | Só compensa quando o *base backup* ficar grande; hoje é complexidade sem ganho. Reavaliar quando o banco passar de algumas dezenas de GB |
| Backup a cada hora ou menos (dump) | **Não** | Sem justificativa: custa leitura repetida do banco e não chega a RPO de minutos; quem entrega isso é o WAL |

**Em uma frase:** dump diário (dá a cópia portátil e verificável) **+** WAL contínuo (dá o RPO de minutos). Só o primeiro está pronto e testado aqui; o segundo é decisão/infraestrutura.

## 4. Agenda, retenção, armazenamento e proteção

| Aspecto | Configuração pronta | Observação |
| --- | --- | --- |
| Backup | **00:00** (fuso `America/Sao_Paulo`, variável `BACKUP_TZ`), seguido de `prune` | confirmar com o dono que 00:00 é mesmo o horário de menor uso |
| Verificação | **12:00**, sem dump novo | + 1 amostra rotativa de backup antigo por dia |
| Retenção | **30 diários + 12 semanais (domingo) + 12 mensais (dia 1)** — `KEEP_DAILY/KEEP_WEEKLY/KEEP_MONTHLY` | **prazos pendentes de aprovação jurídica/LGPD** (decisão 141); a última cópia nunca é removida |
| 1º nível | volume `backup_data` do compose (mesmo host) | protege de erro humano e de corrupção lógica; **não** protege de perda do servidor |
| 2º nível (obrigatório para valer como backup) | `BACKUP_OFFSITE_CMD` — outro provedor/região, bucket com **versionamento e bloqueio de objeto (retenção imutável)**, credencial **só de escrita** | exemplo: `rclone copyto "$BACKUP_FILE" remoto:cortex/`. Sem isso o script avisa a cada execução |
| Proteção contra sobrescrita/exclusão | nome de arquivo com timestamp UTC (nunca reutiliza nome); gravação em `.partial` + `mv` atômico; modo 600/700; a retenção só apaga localmente; no destino externo, bloqueio de objeto e credencial sem permissão de apagar | a expiração no destino é feita por regra de ciclo de vida do próprio bucket |
| Criptografia | `openssl enc -aes-256-cbc -pbkdf2` com arquivo de chave (`BACKUP_ENCRYPTION_KEY_FILE`) | **limitação honesta:** é cifra sem autenticação; a integridade vem do SHA-256 do manifesto, que fica ao lado do arquivo. Quem escrever no destino pode trocar arquivo **e** manifesto — por isso o bloqueio de objeto é parte do desenho, não opcional |
| Chaves | chave do backup **diferente** de `DATA_ENCRYPTION_KEY`; as duas no cofre, cópia separada do backup | perder qualquer uma = backup (ou MFA/certificados) irrecuperável |
| Acesso | papel `lnsystem_backup`: `NOSUPERUSER`, `BYPASSRLS`, só `SELECT`; o script **recusa** rodar com papel sem `BYPASSRLS` | a API em execução usa outro papel (§8 de [PRODUCAO](PRODUCAO.md) e `deploy/postgres-init/10-roles.sh`) |
| Monitoramento | `status.txt` (ok/falha, quando, detalhe), `backup.log`, `backup.sh status` (saída 0 saudável, 1 falha, 2 backup velho > `BACKUP_MAX_AGE_HOURS`=30 h) usado como `healthcheck` do serviço; `BACKUP_ALERT_CMD` em cada falha | o alerta precisa chegar a uma pessoa: **destino a definir** |
| Log | `backup.log` no volume; **nunca** registra senha, URL com senha nem chave | a senha vai por `PGPASSWORD`/`.pgpass`, não por argumento |

## 5. Custo — como estimar sem inventar preço

Fórmula: `espaço ≈ tamanho do banco × razão do dump × nº de cópias retidas (≈ 52) + WAL arquivado`. Razão **medida** no desenvolvimento: **≈ 5 %**; para planejar use **5–15 %** (dados reais comprimem menos que o dado sintético).

| Banco | Dump (5–15 %) | 52 cópias retidas | Observação |
| --- | --- | --- | --- |
| 1 GB | 50–150 MB | 2,6–7,8 GB | cabe em qualquer plano de armazenamento de objetos |
| 10 GB | 0,5–1,5 GB | 26–78 GB | considerar `--exclude-table-data=request_logs` (a tabela é log operacional com retenção de 30 dias; **decisão do dono**, não aplicada) |
| WAL | segmentos de 16 MB; com `archive_timeout` curto e pouco uso, comprimir no `archive_command` (segmentos quase vazios comprimem a poucos KB) | medir `pg_stat_archiver` e o volume arquivado por dia na 1ª semana | |

Multiplique o volume pelo preço por GB-mês e pela saída de dados do provedor **contratado** — o preço não está neste repositório e não foi presumido. A API de restauração não gera tráfego de saída além do dump baixado no momento da recuperação.

## 6. Execução real do `deploy/backup/backup.sh`

Ambiente: PostgreSQL 18.6 local, **sem Docker**, banco de simulação `hsim_db` (criado só para o ensaio) com os **papéis separados** exatamente como o compose os cria (`deploy/postgres-init/10-roles.sh` + `after-migrate.sql`), dados sintéticos do desenvolvimento (41 usuários, 35 vendas, 11 empresas).

### 6.1 Pipeline de papéis do compose (reproduzido fora do Docker)

- `10-roles.sh` criou `owner` (sem superusuário), `app` (sem superusuário, sem BYPASSRLS) e `backup` (BYPASSRLS).
- `prisma migrate deploy` **como o dono** aplicou as **54 migrações em banco vazio** sem superusuário.
- `after-migrate.sql` deu DML ao papel da API e leitura ao de backup.
- Provas com o papel da API: `SELECT` em `_prisma_migrations` → **permissão negada**; `ALTER TABLE users DISABLE ROW LEVEL SECURITY` → "é necessário ser o dono da tabela"; `TRUNCATE users` → **negado**; `CREATE TABLE` → **negado**. Dono de todas as 107 tabelas (106 + `_prisma_migrations`): o papel dono.
- Papel de backup: lê `_prisma_migrations` (54 concluídas) e **não consegue** `DELETE FROM users`.

### 6.2 Backup, verificação e status

```
backup: ok cortex-20261015T135940Z.dump.enc bytes=2305344 migracoes=54 duracao=2s offsite=NAO cifrado=sim
verify: ok cortex-20261015T084158Z.dump.enc (hash confere, 1442 entradas no sumário)
estado=ok operacao=verify … ultimo_backup=… idade_horas=0
```

`offsite=sim` foi uma **cópia local simulada** para outra pasta; não há destino externo real.

### 6.3 Casos negativos (todos detectados)

| Cenário | Resultado |
| --- | --- |
| Papel da API (sem BYPASSRLS) tenta fazer backup | recusado: "o papel … não é BYPASSRLS/superuser: o dump sairia incompleto"; **0 arquivos de dump**; alerta disparado |
| 1 byte alterado no arquivo cifrado | `verify`: "HASH DIVERGENTE"; `status` = `estado=falha`, saída 1; alerta disparado |
| Chave errada no `verify` (arquivo íntegro) | "não decifrou … (chave ausente/errada)"; alerta disparado |
| Retenção com 8 arquivos de 1 a 1.018 dias | removidos os de 1.018, 501 e 51 dias (fora de 30 d/12 sem/12 meses); mantidos o diário, os dois dia-1 e o domingo; a última cópia nunca é removida |

## 7. Ensaio de restauração (`npm run backup:drill`)

Comando (variáveis de ambiente do ensaio; segredos não aparecem): `restore-drill.ts <arquivo .dump.enc> --compare-source --boot`. Cria `lnsystem_restore_drill_<ts>` (nunca restaura por cima de banco existente), restaura, verifica, e **só esse banco** é removido no fim.

| # | Verificação | Resultado medido |
| --- | --- | --- |
| 1 | manifesto presente; SHA-256 do arquivo confere | OK (2.262.048 bytes) |
| 2 | decifra com a chave; **chave errada não abre** | OK / recusado |
| 3 | `pg_restore --list` lê o sumário | 1.442 entradas |
| 4 | `pg_restore --exit-on-error` em banco novo | OK — **3.132 ms** |
| 5 | `pg_amcheck` (tabelas e índices) | nenhum problema — 997 ms |
| 6 | migrações do restaurado = pastas do repositório; = manifesto; **checksum de cada uma = SHA-256 do `migration.sql`** | 54/54 concluídas, 0 incompletas (a tentativa revertida de uma migração é histórico do Prisma, não conta), 54/54 checksums |
| 7 | `prisma migrate diff` restaurado × `schema.prisma` | vazio (sem deriva) |
| 8 | RLS: FORCE em todas as tabelas de negócio; policies = origem | 106 de 106; 161 = 161 |
| 9 | dono das tabelas preservado (≠ papel de execução) | OK |
| 10 | papel de execução **sem contexto** não lê nada | 0 usuários |
| 11 | papel de execução **com a empresa** lê só a empresa | 11 = 11 |
| 12 | **gerente de filial** lê só a própria filial | vê 8 (esperado 8), 0 de outras filiais |
| 13 | FKs `NOT VALID` do restaurado = as da origem (legado documentado: recebível órfão) | 3 = 3, nenhuma a mais |
| 14 | nenhum índice inválido | 0 |
| 15 | linhas das 23 tabelas estáveis iguais às da origem | todas iguais |
| 16 | **a API sobe** contra o restaurado com o papel de execução e `/api/health/ready` = 200 | OK |

**Resultado: 21 verificações, 0 falhas. Tempo de restauração (`pg_restore`): 3,1 s; ensaio completo (inclui boot da API): 30,4 s; arquivo de 2,26 MB.** Esses tempos valem para **este volume**; o RTO de produção depende do tamanho real do banco e **precisa ser medido lá** (não extrapole).

O que o ensaio **não** prova: restauração em **outro servidor/sistema operacional**, com Redis e filas de produção, em PostgreSQL de provedor gerenciado, ou com o volume real. Isso é a decisão 150.

Achados do próprio ensaio (corrigidos): (a) o primeiro `pg_restore` falhou porque a *simulação* tinha carregado a linha órfã sob FKs válidas — não é estado possível no banco real; recriar as 3 FKs como `NOT VALID`, como no desenvolvimento, resolveu e **provou que o backup preserva o legado** em vez de escondê-lo; (b) o script lia o booleano do PostgreSQL como `t` em vez de `true` e reprovava as migrações; corrigido no `restore-drill.ts`.

## 8. PITR em laboratório isolado

Cluster novo (`initdb`, portas 55432/55433, dados sintéticos), **não** o cluster de desenvolvimento:

1. `archive_mode=on`, `archive_command` copiando cada segmento de WAL, `archive_timeout=60`.
2. `pg_basebackup -Fp -X stream` — **4 s**; `pg_verifybackup`: "backup successfully verified".
3. Depois do base backup, +800 linhas em dois momentos; instante-alvo anotado (1.800 linhas).
4. **Desastre simulado:** `DELETE FROM vendas` sem `WHERE` → 0 linhas; 5 segmentos de WAL arquivados.
5. Restauração em diretório **novo**: base + `restore_command` + `recovery_target_time` → **1.800 linhas**, parando "antes do commit da transação do `DELETE`"; **3 s** até aceitar consultas.

Isto prova a *mecânica* (arquivar, verificar, recuperar até um instante). **Não prova** RPO de produção: isso depende do arquivamento ligado no servidor real, do destino externo e do monitoramento de `pg_stat_archiver`. Configuração mínima a aplicar no servidor (ou o equivalente no PostgreSQL gerenciado): `wal_level=replica`, `archive_mode=on`, `archive_timeout=300`, `archive_command` que comprime e envia para o destino externo e **falha** se o envio falhar, base backup semanal verificado com `pg_verifybackup`, alerta se `pg_stat_archiver.last_failed_time` for recente.

## 8.1 Scripts de PITR de produção — provados em laboratório (2026-10-15, decisão 154)

`deploy/backup/wal-archive.sh` (archive_command), `wal-fetch.sh` (restore_command), `base-backup.sh`, `pitr-restore.sh`. Laboratório: cluster novo (`initdb`, portas 55432/55433), PostgreSQL 18.6, **os próprios scripts do repositório** (cópias byte a byte, SHA-256 conferido).

| Prova | Resultado |
| --- | --- |
| Segmentos arquivados **comprimidos e cifrados** (AES-256) | 5 arquivos `.gz.enc`, 0 em texto simples, `pg_stat_archiver`: 5 arquivados, **0 falhas** |
| Base backup físico verificado | `pg_basebackup` + `pg_verifybackup` aprovados (49 MB, 4–7 s) |
| Reenvio de segmento **diferente** com o nome de um já arquivado | **recusado** (nunca sobrescreve) |
| Destino externo falhando | o `archive_command` **falha** (o PostgreSQL tenta de novo e acumula WAL — por isso o `wal-check`, §8.2) |
| Base backup adulterado | `pitr-restore.sh` **recusa** e não cria o diretório |
| Restaurar sobre um diretório existente | **recusado** (a recuperação é sempre num diretório novo) |
| Recuperação até o instante anterior ao `DELETE FROM vendas` | parou **antes** do commit do `DELETE`; **1.800 linhas** (o esperado); restaurar + recuperar + aceitar consultas: **7 s** |

**Limites:** 7 s é de um banco de 49 MB, **não** é estimativa de RTO de produção. Peculiaridades do Windows (comando chamado pelo `cmd.exe`, caminho com acento) exigiram `sh` no PATH e cópia dos scripts para um caminho ASCII **no laboratório**; no Linux/Docker o caminho é `/opt/wal/...`. O overlay Compose não foi executado.

## 8.2 Alertas que chegam a uma pessoa

- `backup.sh backup|verify` falhando dispara `BACKUP_ALERT_CMD`; `alert-webhook.sh` entrega JSON (`text`, `source`, `host`, `at`) a Slack/Teams/Mattermost/endpoint próprio (`ALERT_WEBHOOK_URL`), 3 tentativas, sai com erro se não entregar e nunca imprime a URL. Provado contra receptor HTTP local (200 entrega; HTTP 500 → 3 tentativas e erro; sem destino → erro).
- `backup.sh wal-check` (cron a cada 10 min no serviço `backup`): alerta com o **arquivador falhando** ou **parado com o banco gerando WAL** (compara o LSN com o da checagem anterior; banco ocioso não alarma); sem `archive_mode=on` informa "só o dump diário protege" (perda de até ~24 h). Provado em cluster descartável: falhando → alerta e saída 2; saudável → 0; desligado → aviso. O ramo "parado sem falha" é simples e **não foi exercitado**.
- **Falta** o webhook real de uma pessoa/canal: sem `ALERT_WEBHOOK_URL` o gancho sai com erro e o log registra o aviso.

## 8.3 Credencial de backup isolada da API (decisão 152)

Em produção a API roda com `BACKUP_MODE=delegated` e **não recebe** `BACKUP_DATABASE_URL`/`DB_BACKUP_PASSWORD`: o papel `lnsystem_backup` (BYPASSRLS) existe só no serviço `backup`. O "Backup" do Super Admin grava um **pedido** (`request-<ISO>-<8hex>.json`, pasta `1733`: a API só cria, não lista nem lê) e **lista manifestos** publicados pelo serviço (a API monta `/backup-public` em **somente leitura**); o serviço consome o pedido (nunca lê o conteúdo; máx. um backup por pedido a cada 15 min). **Restaurar e excluir pela API estão desligados em produção** (403 `RESTORE_DISABLED` / `BACKUP_DELETE_DISABLED`). `pg_dump` roda com `--exclude-schema=app_ctx_vault` (o segredo do contexto de RLS não entra no backup; [RLS_CONTEXTO_ASSINADO](RLS_CONTEXTO_ASSINADO.md)). A API em NODE_ENV=production **recusa subir** se vir `BACKUP_DATABASE_URL` (provado na simulação do pipeline, caso B3). Nenhum segredo vai a arquivo, log, relatório ou commit.

## 8.4 Cópia restaurada e anonimizada (decisão 155)

`npm run backup:drill -- <arquivo> --anonymize` (ou `npm run backup:anonymize -- <url-isolada> --confirm=<banco>`) anonimiza a **cópia restaurada** (nunca a origem): pessoas, contatos, documentos, endereços, placas/chassi, segredos, IPs, textos livres e logs; sessões e chaves de idempotência esvaziadas. Recusas (provadas): sem confirmação, confirmação diferente, banco sem nome de cópia, nome que indica produção, alvo igual ao `DATABASE_URL`/`BACKUP_DATABASE_URL`. Resultado no ensaio com papéis separados: **66 tabelas, contagem de linhas inalterada, 158 valores originais amostrados e nenhum encontrado** em qualquer coluna de texto/JSON, cobertura estrita sem coluna sensível fora das regras. **Limite:** texto livre em coluna não reconhecida pode conter dado pessoal; a revisão humana é o critério final antes de compartilhar a cópia fora do ambiente seguro.

## 9. RPO e RTO — propostos, **PENDENTE DE APROVAÇÃO** (decisão 106)

| Objetivo | Proposta | Fundamento | O que precisa existir para valer |
| --- | --- | --- | --- |
| **RPO** (perda máxima de dados) | **≤ 15 min** | WAL arquivado a cada `archive_timeout`=300 s mais o tempo de envio; o laboratório recuperou até o segundo anterior ao incidente | WAL archiving ligado em produção + destino externo + alerta. **Com apenas o dump diário o RPO real é de até 24 h** — não declare ≤ 15 min enquanto o item anterior não existir |
| **RTO** (tempo para voltar) | **≤ 1 h** | restauração medida em 3,1 s para 2,3 MB e 3 s no PITR — **muito abaixo do alvo, mas com volume trivial**; o tempo de produção é dominado pelo tamanho do banco, pela decisão de acionar a recuperação e pelo download do backup | medir uma restauração com cópia **anonimizada** do volume real em staging; manter o procedimento de [PRODUCAO §7](PRODUCAO.md) ensaiado trimestralmente |
| Retenção | 30 diários / 12 semanais / 12 mensais | prática comum; **fiscal/LGPD podem exigir mais ou menos** | aprovação do dono e do jurídico (decisão 141) |

**Aprovações necessárias:** (1) dono — aceitar ou ajustar RPO/RTO; (2) dono/jurídico — retenção; (3) infraestrutura — destino externo com bloqueio de objeto, canal de alerta e responsável por plantão; (4) dono — manter ou retirar `request_logs` do dump.

## 10. Riscos conhecidos

| # | Risco | Mitigação |
| --- | --- | --- |
| B1 | A API recebe `BACKUP_DATABASE_URL` (papel `BYPASSRLS`) para o backup **manual** do Super Admin; um comprometimento da API herda essa credencial | o `docker-compose.yml` traz um aviso sobre a linha; **remova-a** se o backup manual pela tela não for necessário (o agendamento é do serviço `backup`) |
| B2 | Backup só no mesmo host | gancho off-site obrigatório; o script avisa em todo `backup` sem ele |
| B3 | Cifra sem autenticação | bloqueio de objeto no destino; manifesto também copiado; considerar assinatura (`openssl dgst -sign`) numa evolução |
| B4 | Chave de backup perdida | duas cópias em cofres distintos; restauração de teste trimestral prova que a chave guardada funciona |
| B5 | O dump não leva papéis (`CREATE ROLE`) | os papéis nascem por `10-roles.sh`/`db-runtime-role.sql` antes do `pg_restore`; o dump leva dono e GRANTs e **exige** que os papéis existam |
| B6 | O restore em produção sobre o mesmo banco | o procedimento manda restaurar em banco **novo** e trocar a `DATABASE_URL`; o ensaio nunca restaura por cima |

## 11. Como repetir (comandos)

```
# backup + verificação + estado (variáveis PG* e BACKUP_* no ambiente; nunca no repositório)
sh deploy/backup/backup.sh backup && sh deploy/backup/backup.sh verify && sh deploy/backup/backup.sh status

# ensaio de restauração em banco isolado (apps/api; RESTORE_ADMIN_URL, DATABASE_URL, BACKUP_ENCRYPTION_KEY_FILE no ambiente)
npm run backup:drill -- <arquivo.dump.enc> --compare-source --boot
```

O `backup:verify` (backup pelo `BackupService` + restauração + segredos cifrados) continua válido e complementar: o `backup:drill` verifica o arquivo gerado pelo **agendador**.
