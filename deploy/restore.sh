#!/bin/bash
# restore.sh —— 从备份恢复（在服务器 ~/market-pos 下执行）
# 用法：
#   ./deploy/restore.sh backups/db-20261028-120000.sql.gz     # 恢复数据库（覆盖现有数据）
#   ./deploy/restore.sh backups/files-20261028-120000.tar.gz  # 恢复收款码图片
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:?用法: ./deploy/restore.sh backups/db-….sql.gz 或 files-….tar.gz}"
[ -f "$FILE" ] || { echo "❌ 文件不存在: $FILE"; exit 1; }

case "$FILE" in
  *db-*.sql.gz)
    echo "⚠️  将用备份覆盖现有数据库（当前数据会丢失）"
    read -p "确认继续？输入 yes：" ANS
    [ "$ANS" = "yes" ] || exit 1
    gunzip -c "$FILE" | docker compose exec -T postgres psql -U marketpos marketpos
    echo "✅ 数据库已恢复（页面刷新即可见）"
    ;;
  *files-*.tar.gz)
    docker run --rm -v marketpos_appfiles:/files -v "$(pwd)/$(dirname "$FILE"):/bk" alpine \
      sh -c "cd /files && tar xzf /bk/$(basename "$FILE")"
    echo "✅ 收款码图片已恢复"
    ;;
  *)
    echo "❌ 无法识别的备份类型（文件名应含 db-*.sql.gz 或 files-*.tar.gz）"
    exit 1
    ;;
esac
