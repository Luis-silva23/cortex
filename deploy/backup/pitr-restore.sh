#!/bin/sh
# RECUPERAÇÃO PITR (decisão 149): prepara um diretório de dados NOVO a partir de um base backup + o WAL arquivado, para parar num instante (ou no fim do WAL).
#   sh pitr-restore.sh <base-backup> <pasta-de-wal> <alvo|latest> <novo-diretorio-de-dados> [porta]
#   alvo = instante ('2026-10-15 05:53:28-03') ou `latest`. NUNCA restaura por cima de um diretório existente nem de um servidor em uso: o destino precisa não existir.
# Não inicia o servidor: imprime o comando (`pg_ctl -D <dir> start`). Depois de subir e conferir (dados, `db:check-rls`, `RLS_CONTEXT_SECRET` provisionado),
# o DBA troca a DATABASE_URL das instâncias — nunca sobrescreve o banco de produção em uso. Variáveis: WAL_ENCRYPTION_KEY_FILE (se o WAL for cifrado).
set -eu
umask 077
base="${1:?uso: pitr-restore.sh <base-backup> <pasta-de-wal> <alvo|latest> <novo-diretorio> [porta]}"
wal="${2:?}"; target="${3:?}"; new="${4:?}"; port="${5:-55433}"
here=$(cd "$(dirname "$0")" && pwd)

[ -d "$base" ] || { echo "pitr-restore: base backup $base não existe" >&2; exit 1; }
[ -d "$wal" ] || { echo "pitr-restore: pasta de WAL $wal não existe" >&2; exit 1; }
[ ! -e "$new" ] || { echo "pitr-restore: o destino $new já existe — recusado (a recuperação é sempre num diretório NOVO)" >&2; exit 1; }
pg_verifybackup "$base" >/dev/null 2>&1 || { echo "pitr-restore: o base backup NÃO passa no pg_verifybackup — recusado" >&2; exit 1; }

cp -R "$base" "$new"
rm -f "$new/backup_manifest" "$new/postmaster.pid"
fetch="sh \"$here/wal-fetch.sh\" \"%f\" \"%p\""
{
  echo ""
  echo "# --- recuperação PITR (pitr-restore.sh) ---"
  echo "port = $port"
  echo "archive_mode = off"
  echo "restore_command = '$fetch'"
  if [ "$target" != "latest" ]; then
    echo "recovery_target_time = '$target'"
  fi
  echo "recovery_target_action = 'promote'"
} >> "$new/postgresql.auto.conf"
touch "$new/recovery.signal"
export WAL_ARCHIVE_DIR="$wal"
echo "pitr-restore: diretório pronto em $new (alvo: $target). Para iniciar:"
echo "  WAL_ARCHIVE_DIR='$wal' pg_ctl -D '$new' -l '$new/recuperacao.log' start"
