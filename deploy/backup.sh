#!/bin/sh
# Резервная копия базы Lakonik (расшифровки, отчёты, задачи, учётные записи).
# Запуск вручную: ./backup.sh   |   в cron: 0 3 * * * cd /opt/lakonik && ./backup.sh >> backups/backup.log 2>&1
set -e
cd "$(dirname "$0")"
mkdir -p backups
FILE="backups/lakonik-$(date +%F-%H%M).sql.gz"
docker compose exec -T postgres pg_dump -U lakonik lakonik | gzip > "$FILE"
find backups -name 'lakonik-*.sql.gz' -mtime +30 -delete
echo "$(date '+%F %T') копия готова: $FILE ($(du -h "$FILE" | cut -f1))"
