#!/bin/bash
# ============================================================
# backup.sh / restore.sh —— 服务器上的备份与恢复（update.sh 会自动备份，此为手动/定时用）
#
# 备份（服务器上执行）：
#   ./backup.sh                    # 备份到 ~/backups，保留最近 10 份
# 恢复：
#   ./restore.sh db-20261028-120000.sql.gz      # 恢复数据库
#   ./restore.sh files-20261028-120000.tar.gz   # 恢复收款码图片
#
# 建议加 cron 每周备份：
#   crontab -e
#   0 4 * * 1 cd ~/market-pos && ./deploy/backup.sh >> ~/backups/cron.log 2>&1
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

TS=$(date +%Y%m%d-%H%M%S)
mkdir -p backups

echo "备份数据库…"
docker compose exec -T postgres pg_dump -U marketpos marketpos | gzip > backups/db-$TS.sql.gz

echo "备份收款码图片…"
docker run --rm -v marketpos_appfiles:/files:ro -v "$(pwd)/backups:/bk" alpine \
  tar czf /bk/files-$TS.tar.gz -C /files . 2>/dev/null || echo "（图片卷为空，跳过）"

# 只保留最近 10 份
ls -t backups/db-*.sql.gz backups/files-*.tar.gz 2>/dev/null | tail -n +11 | xargs -I{} rm -f {} || true

echo "✅ 备份完成："
ls -lh backups/ | tail -3
echo ""
echo "把备份拷回 Mac（本机执行）："
IP=$(curl -s ifconfig.me 2>/dev/null || echo '<服务器IP>')
echo "  scp ubuntu@$IP:~/market-pos/backups/db-$TS.sql.gz ~/Downloads/"
