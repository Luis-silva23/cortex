#!/bin/sh
# Gancho de ALERTA do backup que ENTREGA a mensagem a um destino real (decisão 149): webhook HTTPS (Slack, Microsoft Teams, Mattermost, Discord com /slack, ou um
# endpoint próprio). Uso:  BACKUP_ALERT_CMD='sh /opt/backup/alert-webhook.sh'   +   ALERT_WEBHOOK_URL=<url do webhook>   (segredo: só no ambiente do serviço).
# A mensagem vem em $BACKUP_ALERT_MSG (o backup.sh nunca a preenche com segredo). Corpo: {"text","source","host","at"} — `text` é o campo que Slack/Teams/Mattermost
# esperam. Sai com erro se a entrega falhar depois de 3 tentativas (o backup.sh registra "o gancho de alerta falhou" no log). Nunca imprime a URL.
# Para testar sem esperar uma falha:  BACKUP_ALERT_MSG="teste de alerta do CÓRTEX" sh alert-webhook.sh
set -eu

: "${ALERT_WEBHOOK_URL:?defina ALERT_WEBHOOK_URL (URL do webhook de alerta)}"
msg="${BACKUP_ALERT_MSG:-alerta de backup sem mensagem}"
host="$(hostname 2>/dev/null || echo desconhecido)"
at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# JSON seguro sem jq: escapa barra invertida, aspas e quebras de linha
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' ' | tr '\r\t' '  '; }
body=$(printf '{"text":"[CÓRTEX backup] %s","source":"cortex-backup","host":"%s","at":"%s"}' "$(esc "$msg")" "$(esc "$host")" "$at")

i=1
while [ "$i" -le 3 ]; do
  # --fail: HTTP >= 400 é falha; --max-time evita pendurar o cron; -sS: sem barra de progresso, mas mostra o erro (sem URL: --silent não a imprime)
  if curl --fail --silent --show-error --max-time 15 --retry 0 -H 'Content-Type: application/json' -d "$body" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1; then
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done
echo "alert-webhook: entrega falhou depois de 3 tentativas" >&2
exit 1
