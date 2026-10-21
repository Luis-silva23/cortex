#!/bin/sh
# restore_command do PostgreSQL na recuperação PITR (decisão 149):   restore_command = 'sh /caminho/wal-fetch.sh %f %p'
# Busca o segmento `%f` no arquivo de WAL (WAL_ARCHIVE_DIR), decifra (se WAL_ENCRYPTION_KEY_FILE) e descomprime para `%p`. Segmento ausente = erro (o PostgreSQL
# interpreta como "fim do WAL disponível" e termina a recuperação até onde há dado). Nunca escreve no arquivo de WAL.
set -eu
umask 077
name="${1:?uso: wal-fetch.sh <nome-do-segmento> <destino>}"
dest="${2:?uso: wal-fetch.sh <nome-do-segmento> <destino>}"
: "${WAL_ARCHIVE_DIR:?defina WAL_ARCHIVE_DIR}"

if [ -f "$WAL_ARCHIVE_DIR/$name.gz.enc" ]; then
  [ -n "${WAL_ENCRYPTION_KEY_FILE:-}" ] || { echo "wal-fetch: $name está cifrado e WAL_ENCRYPTION_KEY_FILE não foi informado" >&2; exit 1; }
  openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$WAL_ENCRYPTION_KEY_FILE" -in "$WAL_ARCHIVE_DIR/$name.gz.enc" | gunzip -c > "$dest"
elif [ -f "$WAL_ARCHIVE_DIR/$name.gz" ]; then
  gunzip -c "$WAL_ARCHIVE_DIR/$name.gz" > "$dest"
elif [ -f "$WAL_ARCHIVE_DIR/$name" ]; then
  cp "$WAL_ARCHIVE_DIR/$name" "$dest"
else
  exit 1
fi
