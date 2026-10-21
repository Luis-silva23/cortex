#!/bin/sh
# Ponto de entrada do serviço `backup`: monta o ambiente do cron e o agendamento e fica em primeiro plano (crond).
#   00:00 (fuso BACKUP_TZ, padrão America/Sao_Paulo)  backup completo + retenção
#   12:00                                             verificação de integridade (hash + leitura do sumário), SEM novo dump
#   a cada 10 min                                     wal-check: saúde do arquivamento de WAL (só age se archive_mode=on; ver docker-compose.wal.yml)
# Segredos: as variáveis PG* e as de backup são gravadas em /etc/backup.env (modo 600, dono postgres) para o cron — nunca em log.
set -eu

: "${PGHOST:?defina PGHOST}"; : "${PGUSER:?defina PGUSER}"; : "${PGPASSWORD:?defina PGPASSWORD}"; : "${PGDATABASE:?defina PGDATABASE}"
export TZ="${BACKUP_TZ:-America/Sao_Paulo}"

umask 077
{
  for v in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE BACKUP_DIR BACKUP_PREFIX KEEP_DAILY KEEP_WEEKLY KEEP_MONTHLY \
           BACKUP_ENCRYPTION_KEY_FILE BACKUP_OFFSITE_CMD BACKUP_ALERT_CMD ALERT_WEBHOOK_URL WAL_MAX_AGE_MINUTES BACKUP_MAX_AGE_HOURS BACKUP_PUBLIC_DIR BACKUP_REQUEST_DIR TZ \
           RCLONE_CONFIG_OFFSITE_TYPE RCLONE_CONFIG_OFFSITE_PROVIDER RCLONE_CONFIG_OFFSITE_ENDPOINT RCLONE_CONFIG_OFFSITE_REGION RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY; do
    eval "val=\${$v:-}"
    [ -n "$val" ] && printf "export %s='%s'\n" "$v" "$(printf '%s' "$val" | sed "s/'/'\\\\''/g")"
  done
} > /etc/backup.env
chown postgres:postgres /etc/backup.env; chmod 600 /etc/backup.env
export BACKUP_DIR="${BACKUP_DIR:-/backups}"
mkdir -p "$BACKUP_DIR"; chown postgres:postgres "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"

# Pastas de troca com a API (decisão 152), que NÃO tem a credencial de backup:
#  - BACKUP_PUBLIC_DIR: manifestos (só metadados) que a API lista; a API a monta SOMENTE LEITURA (755, do usuário do backup);
#  - BACKUP_REQUEST_DIR: pedidos de backup; a API só CRIA arquivo (1733: sem listar, sem ler, sem apagar o dos outros); quem consome é o root do contêiner.
if [ -n "${BACKUP_PUBLIC_DIR:-}" ]; then mkdir -p "$BACKUP_PUBLIC_DIR"; chown postgres:postgres "$BACKUP_PUBLIC_DIR"; chmod 755 "$BACKUP_PUBLIC_DIR"; fi
if [ -n "${BACKUP_REQUEST_DIR:-}" ]; then mkdir -p "$BACKUP_REQUEST_DIR"; chown root:root "$BACKUP_REQUEST_DIR"; chmod 1733 "$BACKUP_REQUEST_DIR"; fi

cat > /etc/crontabs/postgres <<'EOF'
0 0 * * * . /etc/backup.env; /opt/backup/backup.sh backup; /opt/backup/backup.sh prune
0 12 * * * . /etc/backup.env; /opt/backup/backup.sh verify
*/10 * * * * . /etc/backup.env; /opt/backup/backup.sh wal-check
EOF
chmod 600 /etc/crontabs/postgres
# o consumo dos pedidos da API roda como root (lê só o NOME do arquivo e o remove) e executa o backup como `postgres`
cat > /etc/crontabs/root <<'EOF'
* * * * * . /etc/backup.env; /opt/backup/backup.sh requests
EOF
chmod 600 /etc/crontabs/root

# primeira execução: se ainda não existe nenhum backup, não espere até a meia-noite (BACKUP_RUN_ON_START=0 desliga)
if [ "${BACKUP_RUN_ON_START:-1}" = "1" ] && ! ls "$BACKUP_DIR" | grep -q '[.]dump'; then
  su postgres -s /bin/sh -c '. /etc/backup.env; /opt/backup/backup.sh backup' || echo "[backup] primeiro backup falhou — veja $BACKUP_DIR/backup.log"
fi

echo "[backup] agenda ativa: 00:00 backup+retenção, 12:00 verificação, pedidos da API a cada minuto (fuso $TZ)"
exec crond -f -l 8 -L /dev/stdout
