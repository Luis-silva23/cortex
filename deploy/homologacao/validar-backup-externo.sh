#!/bin/sh
# VALIDAÇÃO DO BACKUP EXTERNO (passos 9 e 10 do checklist de docs/CORTEX/PRODUCAO.md §20). *** NÃO FOI EXECUTADO ***: exige o servidor com a pilha no ar e o
# bucket configurado (RCLONE_CONFIG_OFFSITE_* e BACKUP_OFFSITE_CMD no .env). Rode NO SERVIDOR, na raiz do repositório:
#   sh deploy/homologacao/validar-backup-externo.sh <bucket> [prefixo=cortex]      (USE_CLOUDFLARE=1 inclui o overlay da Cloudflare)
# O que faz (e só isto): 1) pede um backup ao serviço `backup` (que cifra e envia ao bucket pelo BACKUP_OFFSITE_CMD); 2) lista o bucket e exige que o arquivo
# novo esteja lá; 3) baixa o arquivo para uma pasta temporária e compara o SHA-256 com o do volume local; 4) roda a verificação de integridade do próprio
# serviço de backup. NÃO apaga nada (nem no bucket), não imprime segredo. A RESTAURAÇÃO em banco descartável (prova final) é `npm run backup:drill`
# (apps/api) com o arquivo baixado — só depois dela o backup externo conta como "provado".
set -u
BUCKET="${1:-}"; PREFIX="${2:-cortex}"
[ -n "$BUCKET" ] || { echo "uso: $0 <bucket> [prefixo]" >&2; exit 64; }
FILES="-f docker-compose.yml -f docker-compose.staging.yml -f docker-compose.free.yml"
[ -n "${USE_CLOUDFLARE:-}" ] && FILES="-f docker-compose.yml -f docker-compose.staging.yml -f docker-compose.cloudflare.yml -f docker-compose.free.yml"
dc() { docker compose $FILES "$@"; }
FAILS=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILS=$((FAILS + 1)); }

dc ps backup >/dev/null 2>&1 || { echo "serviço backup não está no ar (suba a pilha antes)" >&2; exit 2; }
dc exec -T backup sh -c 'test -n "$BACKUP_OFFSITE_CMD"' && pass "BACKUP_OFFSITE_CMD definido no contêiner de backup" || fail "BACKUP_OFFSITE_CMD vazio: sem cópia externa o backup não protege contra perda do servidor"

BEFORE="$(dc exec -T backup rclone lsf "offsite:$BUCKET/$PREFIX/" 2>/dev/null | wc -l)"
dc exec -T backup su postgres -s /bin/sh -c '. /etc/backup.env; /opt/backup/backup.sh backup' >/dev/null 2>&1 && pass "backup executado" || fail "backup falhou (veja o log do serviço)"
AFTER="$(dc exec -T backup rclone lsf "offsite:$BUCKET/$PREFIX/" 2>/dev/null | wc -l)"
[ "$AFTER" -gt "$BEFORE" ] && pass "arquivo novo no bucket ($BEFORE -> $AFTER objetos)" || fail "nenhum objeto novo no bucket ($BEFORE -> $AFTER)"

LATEST="$(dc exec -T backup rclone lsf "offsite:$BUCKET/$PREFIX/" 2>/dev/null | grep -E '\.dump(\.enc)?$' | sort | tail -n1 | tr -d '\r')"
[ -n "$LATEST" ] && pass "último arquivo no bucket: $LATEST" || fail "nenhum .dump no bucket"
if [ -n "$LATEST" ]; then
  TMP="$(mktemp -d)"
  dc exec -T backup rclone cat "offsite:$BUCKET/$PREFIX/$LATEST" 2>/dev/null > "$TMP/$LATEST"
  REMOTE_SUM="$(sha256sum "$TMP/$LATEST" | cut -d' ' -f1)"
  LOCAL_SUM="$(dc exec -T backup sh -c "sha256sum /backups/$LATEST 2>/dev/null | cut -d' ' -f1" | tr -d '\r')"
  [ -n "$LOCAL_SUM" ] && [ "$REMOTE_SUM" = "$LOCAL_SUM" ] && pass "SHA-256 do bucket = SHA-256 do volume local" || fail "hash diferente ou arquivo local ausente (bucket $REMOTE_SUM / local ${LOCAL_SUM:-?})"
  echo "arquivo baixado (cifrado) em: $TMP/$LATEST — use-o no ensaio de restauração e apague a pasta depois"
fi
dc exec -T backup su postgres -s /bin/sh -c '. /etc/backup.env; /opt/backup/backup.sh verify' >/dev/null 2>&1 && pass "verificação de integridade do serviço de backup" || fail "verificação de integridade falhou"

echo; echo "Resultado: $FAILS falha(s). Falta a RESTAURAÇÃO em banco descartável (npm run backup:drill) para provar o backup externo."
[ "$FAILS" -eq 0 ]
