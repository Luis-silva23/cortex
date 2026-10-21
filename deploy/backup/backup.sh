#!/bin/sh
# CÓRTEX — backup lógico do PostgreSQL (full diário) + verificação de integridade SEM novo dump + retenção + status.
# Uso:  backup.sh backup | verify | prune | status | wal-check | requests
#   backup  00h: pg_dump -Fc -> (cifra) -> hash -> manifesto -> off-site (gancho) ; falha dispara o gancho de alerta
#   verify  12h: confere o hash do backup mais recente e que o pg_restore consegue LISTAR o conteúdo (não gera dump novo, custo ≈ leitura do arquivo)
#   prune   remove cópias LOCAIS fora da política (diário 30 / semanal 12 / mensal 12), nunca a última cópia válida
#   status  imprime o último estado (ok/falha, idade, tamanho) e sai com 0 (ok), 1 (falha) ou 2 (backup velho demais)
#   wal-check  saúde do arquivamento de WAL (pg_stat_archiver): alerta se o arquivador está falhando ou parado com o banco gerando WAL (cron a cada 10 min)
#   requests  (root, a cada minuto) consome os PEDIDOS de backup que a API grava em BACKUP_REQUEST_DIR e roda `backup` — a API não tem a credencial de backup
#             (decisão 152). Nunca LÊ o conteúdo do pedido (só o remove, sem seguir link) e aceita no máximo um backup por pedido a cada 15 min.
# BACKUP_PUBLIC_DIR (opcional): depois de cada operação os MANIFESTOS (só metadados: nome, tamanho, instante, cifrado) e o status.txt são copiados para lá; a API monta
#   essa pasta SOMENTE LEITURA para listar os backups. O arquivo de backup em si nunca sai de BACKUP_DIR.
# Credenciais: SÓ por variáveis PG* (PGHOST, PGPORT, PGUSER, PGPASSWORD ou PGPASSFILE) — nunca por argumento, nunca escritas em log.
# O usuário do backup deve ser o papel `lnsystem_backup` (somente leitura + BYPASSRLS; ver deploy/db-runtime-role.sql), senão o dump sai incompleto
# por causa do FORCE RLS. O script se recusa a rodar se o papel não enxerga as tabelas inteiras (verificação `rolbypassrls`).
# Variáveis (todas opcionais, exceto PGDATABASE/PGUSER):
#   BACKUP_DIR (padrão ./backups)       BACKUP_PREFIX (padrão cortex)       KEEP_DAILY=30 KEEP_WEEKLY=12 KEEP_MONTHLY=12
#   BACKUP_ENCRYPTION_KEY_FILE          arquivo com a chave (AES-256-CBC + PBKDF2 via openssl); sem ele o arquivo sai SEM cifra e o log avisa
#   BACKUP_OFFSITE_CMD                  comando que recebe o caminho do arquivo em $BACKUP_FILE (ex.: rclone copyto "$BACKUP_FILE" remoto:cortex/)
#   BACKUP_ALERT_CMD                    comando chamado em falha com a mensagem em $BACKUP_ALERT_MSG (e-mail, webhook, chat)
#   BACKUP_MAX_AGE_HOURS (padrão 30)    idade máxima do último backup válido para `status` considerar saudável
#   PG_BIN_DIR                          pasta dos binários do PostgreSQL quando não estão no PATH
set -eu
umask 077

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_PREFIX="${BACKUP_PREFIX:-cortex}"
KEEP_DAILY="${KEEP_DAILY:-30}"
KEEP_WEEKLY="${KEEP_WEEKLY:-12}"
KEEP_MONTHLY="${KEEP_MONTHLY:-12}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-30}"
if [ -n "${PG_BIN_DIR:-}" ]; then PATH="$PG_BIN_DIR:$PATH"; fi
export PATH

LOG_FILE="$BACKUP_DIR/backup.log"
STATUS_FILE="$BACKUP_DIR/status.txt"
VERIFY_FILE="$BACKUP_DIR/verify.txt"
LOCK_DIR="$BACKUP_DIR/.lock"

mkdir -p "$BACKUP_DIR"

log() {
  # `requests` roda como root: não pode criar/gravar o backup.log do usuário do backup — nesse caso só stderr (o crond do contêiner o encaminha)
  if [ -n "${BACKUP_LOG_STDOUT_ONLY:-}" ]; then printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; return 0; fi
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2
}

# copia só os MANIFESTOS (metadados) e o status para a pasta que a API lê (somente leitura); remove manifesto cujo backup já não existe
publish() {
  [ -n "${BACKUP_PUBLIC_DIR:-}" ] || return 0
  mkdir -p "$BACKUP_PUBLIC_DIR" 2>/dev/null || return 0
  for m in "$BACKUP_DIR"/*.manifest; do
    [ -f "$m" ] && cp "$m" "$BACKUP_PUBLIC_DIR/" 2>/dev/null
  done
  for m in "$BACKUP_PUBLIC_DIR"/*.manifest; do
    [ -f "$m" ] || continue
    b=$(basename "$m" .manifest)
    [ -f "$BACKUP_DIR/$b" ] || rm -f "$m"
  done
  [ -f "$STATUS_FILE" ] && cp "$STATUS_FILE" "$BACKUP_PUBLIC_DIR/status.txt" 2>/dev/null
  # resultado da ÚLTIMA verificação (status.txt guarda só a última operação, e `backup` o sobrescreve): a Central distingue "criado" de "verificado"
  [ -f "$VERIFY_FILE" ] && cp "$VERIFY_FILE" "$BACKUP_PUBLIC_DIR/verify.txt" 2>/dev/null
  chmod 644 "$BACKUP_PUBLIC_DIR"/* 2>/dev/null || true
  return 0
}

alert() {
  # $1 = mensagem (sem segredos). O gancho é do operador: e-mail, webhook, chat.
  log "ALERTA: $1"
  if [ -n "${BACKUP_ALERT_CMD:-}" ]; then
    BACKUP_ALERT_MSG="$1" sh -c "$BACKUP_ALERT_CMD" >/dev/null 2>&1 || log "aviso: o gancho de alerta falhou"
  fi
}

write_status() {
  # $1 = ok|falha  $2 = operação  $3 = detalhe
  printf 'estado=%s\noperacao=%s\nquando=%s\ndetalhe=%s\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" > "$STATUS_FILE.tmp"
  mv "$STATUS_FILE.tmp" "$STATUS_FILE"
  if [ "$2" = "verify" ]; then
    printf 'estado=%s\nquando=%s\ndetalhe=%s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" > "$VERIFY_FILE.tmp"
    mv "$VERIFY_FILE.tmp" "$VERIFY_FILE"
  fi
  publish
}

fail() {
  write_status falha "$1" "$2"
  alert "$1 falhou: $2"
  exit 1
}

hash_of() { # imprime o SHA-256 (hex) do arquivo
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

size_of() { wc -c < "$1" | tr -d ' '; }

take_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    # trava velha (processo morto) não deve impedir backups para sempre: >6 h é considerada abandonada
    if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then
      log "aviso: removendo trava abandonada ($LOCK_DIR)"; rmdir "$LOCK_DIR"; mkdir "$LOCK_DIR"
    else
      log "outra execução em andamento ($LOCK_DIR); saindo sem erro"; exit 0
    fi
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM
}

decrypt_to_stdout() { # $1 arquivo (.enc ou não)
  case "$1" in
    *.enc)
      [ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ] || return 3
      openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" -in "$1" ;;
    *) cat "$1" ;;
  esac
}

latest_backup() { # arquivo de dump mais recente (nome tem timestamp UTC, ordenação lexicográfica = cronológica)
  ls -1 "$BACKUP_DIR" 2>/dev/null | grep -E "^${BACKUP_PREFIX}-[0-9]{8}T[0-9]{6}Z[.]dump([.]enc)?$" | sort | tail -n 1
}

cmd_backup() {
  take_lock
  : "${PGDATABASE:?defina PGDATABASE}"; : "${PGUSER:?defina PGUSER}"
  # 1. o papel enxerga tudo? (FORCE RLS: sem BYPASSRLS/superuser o dump sai vazio e parece sucesso)
  bypass=$(psql -X -At -c "SELECT (rolsuper OR rolbypassrls) FROM pg_roles WHERE rolname = current_user" 2>/dev/null || echo "?")
  [ "$bypass" = "t" ] || fail backup "o papel $PGUSER não é BYPASSRLS/superuser: o dump sairia incompleto (ver deploy/db-runtime-role.sql)"

  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  base="$BACKUP_PREFIX-$stamp"
  tmp="$BACKUP_DIR/.$base.dump.partial"
  started=$(date -u +%s)

  log "backup: iniciando ($PGDATABASE em ${PGHOST:-socket})"
  # Mantém dono e GRANTs no dump: o restore exige que os papéis (lnsystem, lnsystem_owner...) já existam no servidor de destino
  # (deploy/db-runtime-role.sql / deploy/postgres-init). Papéis não fazem parte do pg_dump de um banco.
  # --exclude-schema=app_ctx_vault: o segredo que ASSINA o contexto de RLS (decisão 151) nunca entra no backup. Depois de restaurar, o DBA roda
  # `app_ctx.provision` com o segredo do cofre; até lá o restaurado nega tudo (falha fechada). O papel de backup nem tem permissão nesse schema.
  pg_dump -Fc --exclude-schema=app_ctx_vault -f "$tmp" || { rm -f "$tmp"; fail backup "pg_dump retornou erro"; }

  # 2. o dump é legível? (lista o sumário; pega arquivo truncado)
  entries=$(pg_restore --list "$tmp" 2>/dev/null | grep -vc '^;' || true)
  [ "${entries:-0}" -gt 0 ] || { rm -f "$tmp"; fail backup "pg_restore --list não leu o dump"; }

  # 3. contagem de migrações aplicadas (prova de versão do esquema no manifesto)
  migs=$(psql -X -At -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL" 2>/dev/null || echo "?")
  pgver=$(psql -X -At -c "SHOW server_version" 2>/dev/null || echo "?")

  # 4. cifra (opcional, mas recomendada) — o hash do manifesto é do arquivo FINAL
  final="$BACKUP_DIR/$base.dump"
  if [ -n "${BACKUP_ENCRYPTION_KEY_FILE:-}" ]; then
    [ -r "$BACKUP_ENCRYPTION_KEY_FILE" ] || { rm -f "$tmp"; fail backup "chave de cifragem ilegível"; }
    openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" -in "$tmp" -out "$final.enc.partial" || { rm -f "$tmp" "$final.enc.partial"; fail backup "falha ao cifrar"; }
    rm -f "$tmp"; mv "$final.enc.partial" "$final.enc"; final="$final.enc"; enc=sim
  else
    mv "$tmp" "$final"; enc=NAO
    log "AVISO: BACKUP_ENCRYPTION_KEY_FILE ausente — arquivo gravado SEM cifra (aceitável só em disco já cifrado e com acesso restrito)"
  fi
  chmod 600 "$final"

  hash=$(hash_of "$final"); size=$(size_of "$final")
  finished=$(date -u +%s)
  {
    printf 'arquivo=%s\nsha256=%s\nbytes=%s\ncifrado=%s\nbanco=%s\npostgres=%s\nmigracoes_aplicadas=%s\nentradas_no_dump=%s\ncriado_em=%s\nduracao_segundos=%s\n' \
      "$(basename "$final")" "$hash" "$size" "$enc" "$PGDATABASE" "$pgver" "$migs" "$entries" "$stamp" "$((finished - started))"
  } > "$final.manifest"
  chmod 600 "$final.manifest"

  # 5. cópia externa (o disco local sozinho NÃO é backup: some junto com o servidor)
  if [ -n "${BACKUP_OFFSITE_CMD:-}" ]; then
    BACKUP_FILE="$final" sh -c "$BACKUP_OFFSITE_CMD" >/dev/null 2>&1 || fail backup "envio off-site falhou (o backup local existe: $(basename "$final"))"
    BACKUP_FILE="$final.manifest" sh -c "$BACKUP_OFFSITE_CMD" >/dev/null 2>&1 || log "aviso: manifesto não enviado off-site"
    offsite=sim
  else
    offsite=NAO
    log "AVISO: BACKUP_OFFSITE_CMD ausente — sem cópia externa, o backup NÃO protege contra perda do servidor"
  fi

  write_status ok backup "$(basename "$final") bytes=$size sha256=$hash migracoes=$migs offsite=$offsite cifrado=$enc"
  log "backup: ok $(basename "$final") bytes=$size migracoes=$migs duracao=$((finished - started))s offsite=$offsite cifrado=$enc"
}

verify_one() { # $1 = arquivo; retorna 0 se íntegro
  f="$BACKUP_DIR/$1"
  m="$f.manifest"
  [ -r "$f" ] || { log "verify: arquivo ausente $1"; return 1; }
  [ -r "$m" ] || { log "verify: manifesto ausente para $1"; return 1; }
  want=$(grep '^sha256=' "$m" | cut -d= -f2)
  got=$(hash_of "$f")
  [ "$want" = "$got" ] || { log "verify: HASH DIVERGENTE em $1"; return 1; }
  decrypt_to_stdout "$f" > "$BACKUP_DIR/.verify.tmp" 2>/dev/null || { rm -f "$BACKUP_DIR/.verify.tmp"; log "verify: não decifrou $1 (chave ausente/errada)"; return 1; }
  n=$(pg_restore --list "$BACKUP_DIR/.verify.tmp" 2>/dev/null | grep -vc '^;' || true)
  rm -f "$BACKUP_DIR/.verify.tmp"
  [ "${n:-0}" -gt 0 ] || { log "verify: dump ilegível em $1"; return 1; }
  log "verify: ok $1 (hash confere, $n entradas no sumário)"
  return 0
}

cmd_verify() {
  take_lock
  last=$(latest_backup)
  [ -n "$last" ] || fail verify "nenhum backup encontrado em $BACKUP_DIR"
  verify_one "$last" || fail verify "backup $last corrompido ou ilegível"
  # amostra rotativa: mais um backup antigo por dia, para pegar corrupção silenciosa do armazenamento sem ler tudo
  total=$(ls -1 "$BACKUP_DIR" | grep -cE "^${BACKUP_PREFIX}-[0-9]{8}T[0-9]{6}Z[.]dump([.]enc)?$" || true)
  if [ "${total:-0}" -gt 1 ]; then
    idx=$(( $(date -u +%j | sed 's/^0*//') % total + 1 ))
    sample=$(ls -1 "$BACKUP_DIR" | grep -E "^${BACKUP_PREFIX}-[0-9]{8}T[0-9]{6}Z[.]dump([.]enc)?$" | sort | sed -n "${idx}p")
    if [ -n "$sample" ] && [ "$sample" != "$last" ]; then verify_one "$sample" || fail verify "amostra $sample corrompida"; fi
  fi
  write_status ok verify "ultimo=$last"
}

epoch_of_stamp() { # cortex-YYYYMMDDTHHMMSSZ -> epoch
  s="$1"; d=$(printf '%s' "$s" | sed -E 's/^.*-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z.*$/\1-\2-\3 \4:\5:\6/')
  date -u -d "$d" +%s
}

cmd_prune() {
  take_lock
  now=$(date -u +%s)
  files=$(ls -1 "$BACKUP_DIR" | grep -E "^${BACKUP_PREFIX}-[0-9]{8}T[0-9]{6}Z[.]dump([.]enc)?$" | sort)
  newest=$(printf '%s\n' "$files" | tail -n 1)
  removed=0
  for f in $files; do
    [ "$f" = "$newest" ] && continue
    ep=$(epoch_of_stamp "$f"); age_days=$(( (now - ep) / 86400 ))
    dow=$(date -u -d "@$ep" +%u); dom=$(date -u -d "@$ep" +%d)
    keep=no
    [ "$age_days" -lt "$KEEP_DAILY" ] && keep=yes
    [ "$dow" = "7" ] && [ "$age_days" -lt $((KEEP_WEEKLY * 7)) ] && keep=yes
    [ "$dom" = "01" ] && [ "$age_days" -lt $((KEEP_MONTHLY * 31)) ] && keep=yes
    if [ "$keep" = "no" ]; then
      rm -f "$BACKUP_DIR/$f" "$BACKUP_DIR/$f.manifest"; removed=$((removed + 1)); log "prune: removido $f (idade ${age_days}d)"
    fi
  done
  log "prune: $removed removido(s); última cópia preservada: $newest"
  publish
}

cmd_requests() {
  [ -n "${BACKUP_REQUEST_DIR:-}" ] || exit 0
  BACKUP_LOG_STDOUT_ONLY=1; export BACKUP_LOG_STDOUT_ONLY
  n=0
  for f in "$BACKUP_REQUEST_DIR"/request-*.json; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    rm -f "$f" && n=$((n + 1))      # só remove: o conteúdo do pedido NÃO é lido e um link não é seguido
  done
  [ "$n" -gt 0 ] || exit 0
  last="$BACKUP_DIR/.last_request_run"
  now=$(date -u +%s)
  if [ -f "$last" ] && [ $((now - $(cat "$last" 2>/dev/null || echo 0))) -lt 900 ]; then
    log "pedido(s) de backup da API ignorado(s) ($n): já houve backup por pedido há menos de 15 min"
    exit 0
  fi
  echo "$now" > "$last"
  log "pedido de backup recebido da API ($n arquivo(s)): executando backup"
  if [ "$(id -u)" = "0" ] && command -v su >/dev/null 2>&1; then
    su postgres -s /bin/sh -c '. /etc/backup.env; /opt/backup/backup.sh backup' || log "backup pedido pela API falhou (veja o status e o alerta)"
  else
    "$0" backup || log "backup pedido pela API falhou (veja o status e o alerta)"
  fi
}

cmd_status() {
  [ -r "$STATUS_FILE" ] && cat "$STATUS_FILE" || echo "estado=desconhecido (sem status.txt)"
  last=$(latest_backup)
  [ -n "$last" ] || { echo "ultimo_backup=NENHUM"; exit 1; }
  ep=$(epoch_of_stamp "$last"); age_h=$(( ($(date -u +%s) - ep) / 3600 ))
  echo "ultimo_backup=$last idade_horas=$age_h bytes=$(size_of "$BACKUP_DIR/$last")"
  grep -q '^estado=ok' "$STATUS_FILE" 2>/dev/null || exit 1
  [ "$age_h" -le "$BACKUP_MAX_AGE_HOURS" ] || { echo "ALERTA: último backup tem ${age_h}h (limite ${BACKUP_MAX_AGE_HOURS}h)"; exit 2; }
}

# Saúde do arquivamento contínuo de WAL (PITR, decisão 149): sem WAL novo no arquivo a janela de perda cresce em silêncio (e o disco do banco enche de WAL
# não arquivado). Lê pg_stat_archiver (legível por qualquer papel). Sem archive_mode=on não há o que checar (só o dump diário protege: perda de até ~24 h).
# Falha do arquivador AGORA (última falha mais nova que o último sucesso) ou último segmento arquivado há mais de WAL_MAX_AGE_MINUTES (padrão 30) => alerta, exit 2.
cmd_wal_check() {
  mode=$(psql -X -At -c "SHOW archive_mode" 2>/dev/null || echo erro)
  case "$mode" in
    on|always) ;;
    erro) alert "wal-check: não consegui consultar o banco (PGHOST/credencial/rede)"; exit 2 ;;
    *) echo "wal=desligado (archive_mode=$mode): só o backup lógico diário protege os dados"; exit 0 ;;
  esac
  row=$(psql -X -At -F '|' -c "SELECT archived_count, failed_count, COALESCE(floor(extract(epoch FROM now() - last_archived_time)/60)::int, -1), (last_failed_time IS NOT NULL AND (last_archived_time IS NULL OR last_failed_time > last_archived_time)) FROM pg_stat_archiver" 2>/dev/null) || { alert "wal-check: não consegui ler pg_stat_archiver"; exit 2; }
  archived=${row%%|*}; rest=${row#*|}; failed=${rest%%|*}; rest=${rest#*|}; age=${rest%%|*}; failing=${rest#*|}
  max_age="${WAL_MAX_AGE_MINUTES:-30}"
  echo "wal=ligado arquivados=$archived falhas_acumuladas=$failed minutos_desde_o_ultimo=$age falhando_agora=$failing (limite ${max_age} min)"
  if [ "$failing" = "t" ]; then alert "arquivamento de WAL FALHANDO (PITR comprometido; o WAL se acumula no disco do banco)"; exit 2; fi
  # Defasagem só vale quando o banco está PRODUZINDO WAL: num banco ocioso o archive_timeout não troca de segmento (não há o que arquivar). Compara o LSN atual com o
  # da checagem anterior (guardado em BACKUP_DIR/.wal_lsn); a 1ª checagem só registra.
  lsn=$(psql -X -At -c "SELECT pg_current_wal_lsn()" 2>/dev/null || echo "")
  prev=$(cat "$BACKUP_DIR/.wal_lsn" 2>/dev/null || echo "")
  [ -n "$lsn" ] && printf '%s' "$lsn" > "$BACKUP_DIR/.wal_lsn"
  if [ "$age" = "-1" ]; then echo "wal: nenhum segmento arquivado ainda"; exit 0; fi
  if [ "$age" -gt "$max_age" ] && [ -n "$prev" ] && [ "$lsn" != "$prev" ]; then
    alert "o banco gera WAL mas nenhum segmento foi arquivado há ${age} min (limite ${max_age} min)"; exit 2
  fi
}

case "${1:-}" in
  wal-check) cmd_wal_check ;;
  backup) cmd_backup ;;
  requests) cmd_requests ;;
  verify) cmd_verify ;;
  prune) cmd_prune ;;
  status) cmd_status ;;
  *) echo "uso: $0 backup|verify|prune|status|requests|wal-check" >&2; exit 64 ;;
esac
