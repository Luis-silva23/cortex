#!/bin/sh
# VALIDAÇÃO DE HOMOLOGAÇÃO do CÓRTEX num host Linux com Docker (decisões 149–152). *** NÃO FOI EXECUTADO ***: a máquina de desenvolvimento não tem Docker/WSL/Linux. Este script
# existe para que a validação real seja UM comando no ambiente certo, com resultado objetivo (PASS/FAIL por item) e sem inventar nada. Enquanto não rodar num host real, o
# estado oficial é "Compose NÃO validado / staging HTTPS NÃO validado".
#
#   cd <raiz do repositório> && cp .env.example .env && (preencha os segredos) && sh deploy/homologacao/validar-homologacao.sh [--wal] [--tls <dominio>]
#     --wal            inclui o overlay docker-compose.wal.yml (arquivamento de WAL cifrado + base backup + wal-check)
#     --tls <dominio>  inclui docker-compose.staging.yml (Caddy/HTTPS) e prova TLS real em https://api.<dominio> (precisa de DNS e portas 80/443 abertas)
# Usa SOMENTE dados sintéticos/vazios (banco novo do compose). Nunca aponte para um banco de produção: o script sobe a própria pilha. Não imprime segredos.
# Saída: uma linha PASS/FAIL por verificação + relatório em ./validacao-homologacao-<UTC>.txt; código de saída ≠ 0 se algo falhar.
set -u
WAL=0; TLS=""
while [ $# -gt 0 ]; do
  case "$1" in --wal) WAL=1 ;; --tls) shift; TLS="${1:-}" ;; *) echo "argumento desconhecido: $1" >&2; exit 64 ;; esac
  shift
done

REPORT="validacao-homologacao-$(date -u +%Y%m%dT%H%M%SZ).txt"
FAILS=0
say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
pass() { say "PASS  $1"; }
fail() { say "FAIL  $1"; FAILS=$((FAILS + 1)); }
check() { d="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$d"; else fail "$d"; fi; }          # tem que dar certo
must_fail() { d="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$d"; else pass "$d"; fi; }      # tem que ser RECUSADO
dc() { docker compose $FILES "$@"; }
envval() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '"'; }

say "== CÓRTEX — validação de homologação ($(date -u +%Y-%m-%dT%H:%M:%SZ)) host=$(hostname) =="
command -v docker >/dev/null 2>&1 || { fail "docker não encontrado neste host"; exit 2; }
if [ "$(uname -s)" = "Linux" ]; then pass "sistema operacional Linux"; else fail "este host não é Linux ($(uname -s))"; fi
check "docker compose v2 disponível" docker compose version
[ -f .env ] || { fail ".env ausente (copie .env.example e preencha)"; exit 2; }
APP_USER=$(envval DB_APP_USER); APP_USER=${APP_USER:-lnsystem_app}
BKP_USER=$(envval DB_BACKUP_USER); BKP_USER=${BKP_USER:-lnsystem_backup}

FILES="-f docker-compose.yml"
[ "$WAL" = 1 ] && FILES="$FILES -f docker-compose.wal.yml"
[ -n "$TLS" ] && FILES="$FILES -f docker-compose.staging.yml"

# 1. o compose é válido (interpolação das variáveis obrigatórias, YAML, !reset)
check "docker compose config (arquivos: $FILES)" dc config -q

# 2. sobe a pilha (build local) e espera a API ficar saudável
say "-- subindo a pilha (pode levar vários minutos no primeiro build)"
if dc up -d --build >>"$REPORT" 2>&1; then pass "docker compose up -d --build"; else fail "docker compose up falhou (veja $REPORT)"; dc logs --tail 60 >>"$REPORT" 2>&1; exit 1; fi
i=0; while ! dc ps api --format '{{.Health}}' 2>/dev/null | grep -q healthy; do i=$((i + 1)); [ "$i" -gt 60 ] && break; sleep 5; done
if dc ps api --format '{{.Health}}' 2>/dev/null | grep -q healthy; then pass "API saudável (/api/health/ready)"; else fail "API não ficou saudável em 5 min"; dc logs --tail 80 api >>"$REPORT" 2>&1; fi
exit_of() { docker inspect -f '{{.State.ExitCode}}' "$1" 2>/dev/null; }
[ "$(exit_of ln-system-migrate)" = 0 ] && pass "migrate terminou com sucesso" || fail "migrate não terminou com sucesso"
[ "$(exit_of ln-system-db-grants)" = 0 ] && pass "db-grants terminou com sucesso (inclui a provisão do segredo de contexto)" || fail "db-grants não terminou com sucesso"

# SQL no contêiner do banco: `sa` = superusuário de emergência (só leitura aqui); `as_app` = o papel REAL da API, por TCP e com senha
# O código de saída do psql NÃO pode se perder no pipe (antes o `| tr` o escondia e todo `must_fail` reprovava mesmo com o banco NEGANDO: "permission denied" no log).
sa() { _o=$(dc exec -T postgres sh -c 'psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$1") || return 1; printf '%s\n' "$_o" | tr -d ' \r'; }
as_app() { _o=$(dc exec -T postgres sh -c 'PGPASSWORD="$DB_APP_PASSWORD" psql -X -At -h localhost -U "$DB_APP_USER" -d "$POSTGRES_DB" -c "$1"' sh "$1") || return 1; printf '%s\n' "$_o" | tr -d '\r'; }

# 3. papéis: a API não é superusuário, não é dona e não tem BYPASSRLS; o backup tem BYPASSRLS mas só leitura
say "-- papéis do banco"
[ "$(sa "select not (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole) from pg_roles where rolname='$APP_USER'")" = t ] && pass "papel da API sem superusuário/BYPASSRLS/CREATEDB/CREATEROLE" || fail "papel da API com privilégio excessivo"
[ "$(sa "select count(*) from pg_tables where schemaname='public' and tableowner='$APP_USER'")" = 0 ] && pass "papel da API NÃO é dono de tabela" || fail "papel da API é dono de tabela (a RLS não valeria)"
[ "$(sa "select rolbypassrls and not rolsuper from pg_roles where rolname='$BKP_USER'")" = t ] && pass "papel de backup: BYPASSRLS, sem superusuário" || fail "papel de backup mal configurado"
[ "$(sa "select has_table_privilege('$BKP_USER','users','INSERT') or has_table_privilege('$BKP_USER','users','UPDATE') or has_table_privilege('$BKP_USER','users','DELETE')")" = f ] && pass "papel de backup sem escrita" || fail "papel de backup consegue escrever"

# 4. RLS e contexto assinado, como o papel REAL da API
say "-- RLS e contexto assinado (papel real da API)"
[ "$(as_app "select (app_ctx.status()).enforced")" = t ] && pass "contexto assinado EXIGIDO (app_ctx enforced = true)" || fail "contexto assinado não está exigido"
[ "$(as_app "select count(*) from users")" = 0 ] && pass "sem contexto: o papel da API enxerga 0 usuários" || fail "sem contexto o papel da API enxergou linhas (RLS não vale)"
[ "$(as_app "select set_config('app.user_type','SUPER_ADMIN',false), set_config('app.current_company_id','x',false); select count(*) from users" | tail -1)" = 0 ] && pass "GUCs FORJADOS (SUPER_ADMIN sem assinatura) continuam sem acesso" || fail "contexto forjado deu acesso"
must_fail "papel da API não lê o cofre do segredo (app_ctx_vault.secrets)" as_app "select 1 from app_ctx_vault.secrets limit 1"
must_fail "papel da API não chama app_ctx.provision" as_app "select app_ctx.provision('\\x00'::bytea)"

# 5. a API NÃO tem a credencial de backup (decisão 152)
say "-- isolamento da credencial de backup"
api_env_has() { dc exec -T api env 2>/dev/null | grep -q "$1"; }
if api_env_has '^NODE_ENV=production'; then pass "API em NODE_ENV=production (a guarda de produção está ativa)"; else fail "API não está em produção (ou não responde)"; fi
if api_env_has '^BACKUP_DATABASE_URL=.'; then fail "a API tem BACKUP_DATABASE_URL"; else pass "ambiente da API sem BACKUP_DATABASE_URL"; fi
if api_env_has 'DB_BACKUP_PASSWORD'; then fail "a API tem DB_BACKUP_PASSWORD"; else pass "ambiente da API sem DB_BACKUP_PASSWORD"; fi
must_fail "API não enxerga o volume de backups (/backups)" dc exec -T api ls /backups

# 6. pedido de backup pela API → serviço de backup executa
say "-- backup delegado (pedido da API → serviço de backup)"
bk() { dc exec -T backup sh -c "su postgres -s /bin/sh -c '. /etc/backup.env; /opt/backup/backup.sh $1'"; }
dumps() { dc exec -T backup sh -c 'ls /backups 2>/dev/null | grep -c "[.]dump"' | tr -d ' \r'; }
sleep 20; BEFORE=$(dumps)
if dc exec -T api sh -c "echo '{}' > /backup-requests/request-$(date -u +%Y%m%dT%H%M%SZ)-0000abcd.json" >/dev/null 2>&1; then pass "a API consegue CRIAR pedido de backup"; else fail "a API não consegue criar o pedido"; fi
must_fail "a API não consegue LISTAR os pedidos (pasta 1733)" dc exec -T api ls /backup-requests
sleep 90; AFTER=$(dumps)
say "INFO  dumps no serviço de backup: antes=$BEFORE depois=$AFTER (o 1º backup também roda ao subir; o pedido repetido em <15 min é ignorado por desenho)"
[ "${AFTER:-0}" -ge 1 ] && pass "existe backup (>=1 dump)" || fail "nenhum backup gerado"
check "estado do backup = ok (backup.sh status)" bk status
check "verificação de integridade, sem novo dump (backup.sh verify)" bk verify
must_fail "a API não escreve em /backup-public (somente leitura)" dc exec -T api sh -c 'touch /backup-public/x'

# 7. WAL / PITR (opcional)
if [ "$WAL" = 1 ]; then
  say "-- WAL contínuo e base backup"
  [ "$(sa "show archive_mode")" = on ] && pass "archive_mode=on" || fail "archive_mode desligado"
  sa "select pg_switch_wal()" >/dev/null 2>&1; sleep 15
  [ "$(sa "select archived_count>0 and failed_count=0 from pg_stat_archiver")" = t ] && pass "WAL arquivado (cifrado) sem falhas" || fail "arquivador com falha (pg_stat_archiver)"
  check "arquivos de WAL cifrados (.gz.enc) no volume" dc exec -T postgres sh -c 'ls /wal-archive | grep -q "[.]gz[.]enc$"'
  check "base backup físico verificado (pg_verifybackup)" dc exec -T -u postgres postgres sh /opt/wal/base-backup.sh /wal-archive/bases
  check "wal-check saudável (serviço de backup)" bk wal-check
fi

# 8. TLS real (opcional): exige DNS e portas 80/443 do host
if [ -n "$TLS" ]; then
  say "-- HTTPS em staging (https://api.$TLS)"
  if curl -sSI --max-time 20 "http://api.$TLS/api/health/live" | head -1 | grep -qE ' 30[1278] '; then pass "HTTP redireciona para HTTPS"; else fail "HTTP não redireciona"; fi
  check "certificado válido (cadeia confiável e nome confere)" curl -sS --max-time 20 -o /dev/null "https://api.$TLS/api/health/live"
  [ "$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "https://api.$TLS/api/health/ready")" = 200 ] && pass "/api/health/ready responde 200 por HTTPS" || fail "/api/health/ready não respondeu 200"
  if curl -sSI --max-time 20 "https://api.$TLS/api/health/live" | grep -qi '^strict-transport-security:'; then pass "HSTS presente"; else fail "HSTS ausente"; fi
  must_fail "porta 3001 da API fechada para fora" curl -sS --max-time 5 "http://$TLS:3001/api/health/live"
  must_fail "PostgreSQL (5432) inacessível de fora" nc -z -w 3 "$TLS" 5432
  must_fail "Redis (6379) inacessível de fora" nc -z -w 3 "$TLS" 6379
fi

say ""
say "== RESULTADO: $FAILS falha(s). Relatório: $REPORT =="
say "Fora do alcance deste script (manual/outro servidor): restauração do backup em OUTRO servidor + anonimização (npm run backup:drill / backup:anonymize), cópia off-site e alerta de falha chegando a uma pessoa (BACKUP_OFFSITE_CMD/ALERT_WEBHOOK_URL)."
say "Reversão: docker compose $FILES down (mantém volumes); para voltar a versão, use a imagem/tag anterior e restaure o backup em banco NOVO — nunca sobre o banco em uso."
[ "$FAILS" = 0 ]
