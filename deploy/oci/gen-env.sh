#!/usr/bin/env bash
# Gera o .env do SERVIDOR com segredos ALEATÓRIOS (openssl) e a chave de cifragem do backup, sem imprimir nenhum valor.
#
# Uso (no servidor, na raiz do repositório):   deploy/oci/gen-env.sh <dominio> [pasta-de-segredos]
#   <dominio>           domínio real (ex.: exemplo.com.br). Nada é inventado: sem ele o script recusa.
#   pasta-de-segredos   onde fica a chave de cifragem do backup (padrão /opt/cortex-secrets; FORA do repositório; modo 700)
#
# Garantias:
#   - NUNCA sobrescreve: se o .env já existir, o script para (apague/renomeie você mesmo, depois de guardar uma cópia no cofre).
#   - NUNCA imprime segredo: só os NOMES das variáveis geradas. O .env nasce com modo 600; a chave do backup, com modo 600.
#   - Senhas do PostgreSQL/Redis só com letras e números (entram em URL de conexão); os demais segredos em base64.
#   - Cada segredo é independente (a API recusa JWT_SECRET igual a JWT_REFRESH_SECRET, ou RLS_CONTEXT_SECRET repetido — apps/api/src/config/env.ts).
#
# GUARDE UMA CÓPIA do .env e de backup.key num cofre (gerenciador de senhas): DATA_ENCRYPTION_KEY perdida impede abrir os segredos de MFA já gravados
# e a chave do backup perdida impede restaurar qualquer backup. NÃO FOI EXECUTADO em Linux nesta máquina de desenvolvimento (só `bash -n`).
set -euo pipefail
umask 077

DOMAIN="${1:-}"
SECRETS_DIR="${2:-/opt/cortex-secrets}"
ENV_FILE="${ENV_FILE:-.env}"

if [ -z "$DOMAIN" ]; then
  echo "uso: $0 <dominio> [pasta-de-segredos]   (informe o domínio real; nenhum é inventado)" >&2
  exit 2
fi
if ! printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'; then
  echo "domínio inválido: use letras minúsculas, números e hífens (ex.: exemplo.com.br)" >&2
  exit 2
fi
if [ -e "$ENV_FILE" ]; then
  echo "recusado: $ENV_FILE já existe (não sobrescrevo segredos). Guarde uma cópia no cofre e remova-o você mesmo se quiser gerar outro." >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "openssl não encontrado (instale o pacote openssl)" >&2; exit 1; }

hex() { openssl rand -hex "$1"; }                     # só [0-9a-f]
b64() { openssl rand -base64 "$1" | tr -d '\n'; }      # base64 (com = / +)

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
KEY_FILE="$SECRETS_DIR/backup.key"
if [ ! -e "$KEY_FILE" ]; then
  b64 48 > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
fi
# O serviço de backup roda como o usuário `postgres` da imagem (uid 70) e precisa LER a chave montada: dê a posse a ele quando for possível.
if [ "$(id -u)" = "0" ]; then
  chown 70:70 "$KEY_FILE"
else
  echo "AVISO: execute como root (ou rode depois: sudo chown 70:70 $KEY_FILE) — o contêiner de backup lê a chave como uid 70." >&2
fi

cat > "$ENV_FILE" <<EOF
# Gerado por deploy/oci/gen-env.sh em $(date -u +%Y-%m-%dT%H:%M:%SZ). NÃO versionar, NÃO enviar em chat, NÃO copiar para o Drive sem cifrar.
STAGING_DOMAIN=$DOMAIN
# um salto de proxy: o Caddy (a API só aceita X-Forwarded-For dele). Com a Cloudflare na frente, o Caddy do override já devolve o IP real.
TRUST_PROXY=1

# ---- banco e fila (senhas só de letras e números) ----
POSTGRES_PASSWORD=$(hex 24)
DB_OWNER_PASSWORD=$(hex 24)
DB_APP_PASSWORD=$(hex 24)
DB_BACKUP_PASSWORD=$(hex 24)
REDIS_PASSWORD=$(hex 24)

# ---- segredos da aplicação (independentes entre si) ----
JWT_SECRET=$(b64 48)
JWT_REFRESH_SECRET=$(b64 48)
DATA_ENCRYPTION_KEY=$(b64 32)
RLS_CONTEXT_SECRET=$(b64 32)

# ---- backup ----
BACKUP_KEY_FILE=$KEY_FILE
# Cópia EXTERNA (obrigatória para o backup valer): preencha o destino e o comando. Exemplo (Oracle Object Storage, API S3) — valores só aqui, no servidor:
#RCLONE_CONFIG_OFFSITE_TYPE=s3
#RCLONE_CONFIG_OFFSITE_PROVIDER=Other
#RCLONE_CONFIG_OFFSITE_ENDPOINT=https://<namespace>.compat.objectstorage.<regiao>.oraclecloud.com
#RCLONE_CONFIG_OFFSITE_REGION=<regiao>
#RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=
#RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=
#BACKUP_OFFSITE_CMD='rclone copy "\$BACKUP_FILE" offsite:<nome-do-bucket>/cortex/'
# Aviso de falha do backup que CHEGA a uma pessoa (webhook de Slack/Teams/Mattermost, opcional):
#BACKUP_ALERT_CMD='sh /opt/backup/alert-webhook.sh'
#ALERT_WEBHOOK_URL=

# ---- Cloudflare (só com docker-compose.cloudflare.yml): pasta com origin.pem e origin.key, FORA do repositório ----
#ORIGIN_CERT_DIR=/opt/cortex-secrets/cloudflare-origin

# ---- integrações opcionais (desligadas sem valor; ver .env.example e docs/CORTEX/PRODUCAO.md §18) ----
#SENTRY_DSN=
#RESEND_API_KEY=
#ALERT_EMAIL_FROM=
#ALERT_EMAIL_TO=
#RESEND_DOMAIN_VERIFIED=false
EOF
chmod 600 "$ENV_FILE"

echo "OK: $ENV_FILE criado (modo 600) com os segredos: POSTGRES_PASSWORD DB_OWNER_PASSWORD DB_APP_PASSWORD DB_BACKUP_PASSWORD REDIS_PASSWORD JWT_SECRET JWT_REFRESH_SECRET DATA_ENCRYPTION_KEY RLS_CONTEXT_SECRET"
echo "OK: chave de cifragem do backup em $KEY_FILE (modo 600)."
echo "PRÓXIMO: guarde uma cópia de ambos no cofre; configure a cópia externa do backup (variáveis RCLONE_* comentadas no .env); depois siga docs/CORTEX/PRODUCAO.md §19."
