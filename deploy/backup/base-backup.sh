#!/bin/sh
# BASE BACKUP físico para PITR (decisão 149): ponto de partida da recuperação "até um instante" (junto do WAL arquivado por wal-archive.sh). Rodar SEMANALMENTE
# (e logo antes de uma migração arriscada), como superusuário/REPLICATION, onde o PostgreSQL aceita conexão de replicação (no contêiner do banco: socket local).
#   sh base-backup.sh <pasta-de-destino>        (variáveis PG* do ambiente: PGHOST/PGPORT/PGUSER/PGPASSWORD)
# Faz `pg_basebackup -Fp -X stream -c fast` numa subpasta com carimbo UTC, confere com `pg_verifybackup` (falha = apaga a subpasta incompleta e sai com erro) e imprime o
# caminho. O diretório gerado é o que o `pitr-restore.sh` copia. Cifre/envie para fora do servidor com o mesmo gancho do backup lógico (BACKUP_OFFSITE_CMD).
set -eu
umask 077
dest_root="${1:?uso: base-backup.sh <pasta-de-destino>}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dir="$dest_root/base-$stamp"
mkdir -p "$dest_root"

started=$(date -u +%s)
if ! pg_basebackup -D "$dir" -Fp -X stream -c fast --no-password >/dev/null 2>"$dest_root/.base-backup.err"; then
  echo "base-backup: pg_basebackup falhou: $(tail -n 3 "$dest_root/.base-backup.err" | tr '\n' ' ')" >&2
  rm -rf "$dir" "$dest_root/.base-backup.err"
  exit 1
fi
rm -f "$dest_root/.base-backup.err"
if ! pg_verifybackup "$dir" >/dev/null 2>&1; then
  echo "base-backup: pg_verifybackup REPROVOU $dir — removido" >&2
  rm -rf "$dir"
  exit 1
fi
echo "base-backup: ok $dir ($(du -sk "$dir" | cut -f1) KB, $(( $(date -u +%s) - started )) s, verificado por pg_verifybackup)"
