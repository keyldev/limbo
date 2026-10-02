#!/usr/bin/env sh
# Ночной бэкап базы. Запускать по cron на VPS:
#   15 3 * * * /opt/loadline/deploy/backup.sh >> /var/log/loadline-backup.log 2>&1
# Отправку в объектное хранилище (rclone, aws s3 cp и т.п.) добавьте под свой провайдер.
set -eu

STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
OUT="/var/backups/loadline/loadline-$STAMP.sql.gz"
mkdir -p "$(dirname "$OUT")"

docker compose -f "$(dirname "$0")/compose.yaml" exec -T postgres \
  pg_dump -U loadline -d loadline --no-owner | gzip > "$OUT"

# Храним локально 14 последних копий
ls -1t /var/backups/loadline/*.sql.gz | tail -n +15 | xargs -r rm --
echo "backup ok: $OUT"
