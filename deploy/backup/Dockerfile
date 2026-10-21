# Imagem do serviço de backup do CÓRTEX: cliente PostgreSQL 18 (mesma versão do servidor — pg_dump não aceita servidor mais NOVO que ele),
# openssl (cifragem AES-256), curl (alerta por webhook), rclone (cópia EXTERNA do backup já cifrado: BACKUP_OFFSITE_CMD, ver docker-compose.free.yml),
# tzdata (agenda no fuso de Brasília) e o crond do busybox. Sem Node, sem código da aplicação.
FROM postgres:18-alpine
RUN apk add --no-cache openssl tzdata tini curl rclone
COPY deploy/backup/backup.sh /opt/backup/backup.sh
COPY deploy/backup/entrypoint.sh /opt/backup/entrypoint.sh
COPY deploy/backup/alert-webhook.sh /opt/backup/alert-webhook.sh
RUN chmod 0555 /opt/backup/backup.sh /opt/backup/entrypoint.sh /opt/backup/alert-webhook.sh && mkdir -p /backups && chown postgres:postgres /backups
# o cron do busybox precisa de root; o backup roda como `postgres` (sem privilégio no host) via su-exec embutido na linha do crontab
ENTRYPOINT ["/sbin/tini", "--", "/opt/backup/entrypoint.sh"]
