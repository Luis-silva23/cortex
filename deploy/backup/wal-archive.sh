#!/bin/sh
# archive_command do PostgreSQL (PITR, decisão 149):   archive_command = 'sh /opt/wal/wal-archive.sh %p %f'
# Cada segmento de WAL é comprimido (gzip), opcionalmente CIFRADO (AES-256 com a chave do backup), gravado de forma atômica e NUNCA sobrescrito; só sai com 0 quando o
# segmento está DURÁVEL (no destino local e, se configurado, no destino EXTERNO) — qualquer falha devolve erro e o PostgreSQL tenta de novo (e acumula WAL até resolver:
# por isso o `pg_stat_archiver` precisa de alerta). Reenvio do MESMO segmento (depois de um erro) é aceito; segmento diferente com o mesmo nome é recusado.
# Variáveis: WAL_ARCHIVE_DIR (obrigatória) · WAL_ENCRYPTION_KEY_FILE (opcional; use a chave do backup) · WAL_OFFSITE_CMD (opcional; recebe o arquivo em $WAL_FILE).
set -eu
umask 077

src="${1:?uso: wal-archive.sh <caminho-do-segmento> <nome-do-segmento>}"
name="${2:?uso: wal-archive.sh <caminho-do-segmento> <nome-do-segmento>}"
: "${WAL_ARCHIVE_DIR:?defina WAL_ARCHIVE_DIR}"
[ -f "$src" ] || { echo "wal-archive: segmento $src não existe" >&2; exit 1; }
mkdir -p "$WAL_ARCHIVE_DIR"

if [ -n "${WAL_ENCRYPTION_KEY_FILE:-}" ]; then ext="gz.enc"; else ext="gz"; fi
dest="$WAL_ARCHIVE_DIR/$name.$ext"
tmp="$WAL_ARCHIVE_DIR/.$name.$ext.partial.$$"
trap 'rm -f "$tmp"' EXIT

# o conteúdo arquivado, lido de volta, tem que ser IGUAL ao segmento
same_as_src() {
  if [ -n "${WAL_ENCRYPTION_KEY_FILE:-}" ]; then
    openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$WAL_ENCRYPTION_KEY_FILE" -in "$1" 2>/dev/null | gunzip -c 2>/dev/null | cmp -s - "$src"
  else
    gunzip -c "$1" 2>/dev/null | cmp -s - "$src"
  fi
}

if [ -f "$dest" ]; then
  if same_as_src "$dest"; then
    : # já arquivado e idêntico (reenvio depois de uma falha): segue para o destino externo
  else
    echo "wal-archive: $name já existe no arquivo com conteúdo DIFERENTE — recusado (nunca sobrescreve)" >&2
    exit 1
  fi
else
  if [ -n "${WAL_ENCRYPTION_KEY_FILE:-}" ]; then
    [ -r "$WAL_ENCRYPTION_KEY_FILE" ] || { echo "wal-archive: chave de cifragem ilegível" >&2; exit 1; }
    gzip -c "$src" | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$WAL_ENCRYPTION_KEY_FILE" -out "$tmp"
  else
    gzip -c "$src" > "$tmp"
  fi
  same_as_src "$tmp" || { echo "wal-archive: a cópia de $name não confere com o original" >&2; exit 1; }
  mv "$tmp" "$dest"
  sync 2>/dev/null || true
fi

if [ -n "${WAL_OFFSITE_CMD:-}" ]; then
  WAL_FILE="$dest" sh -c "$WAL_OFFSITE_CMD" >/dev/null 2>&1 || { echo "wal-archive: envio externo de $name falhou (o segmento fica local e será reenviado)" >&2; exit 1; }
fi
exit 0
