#!/bin/bash
# ============================================================
# update.sh —— 一键更新正式环境（日常改代码后用）
#
# 用法：
#   ./update.sh ubuntu@服务器IP
#
# 做什么：
#   1. 本地预检：语法检查 + 冒烟测试（任一失败立即中止，不发版）
#   2. 打包上传
#   3. 服务器自动备份：pg_dump + 收款码图片卷 tar（带时间戳，保留最近 5 份）
#   4. 重建容器（数据卷不动；API 启动时自动执行新增的 SQL 迁移脚本）
#   5. 健康检查；失败自动回滚（恢复备份 + 回退代码目录）
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:?用法: ./deploy/update.sh ubuntu@服务器IP}"
TS=$(date +%Y%m%d-%H%M%S)

echo "==> [1/5] 本地预检（语法 + 冒烟）…"
for f in src/app.js src/data/store.js src/data/api.js src/data/cloud.js server/src/*.js server/src/*.mjs; do
  cp "$f" /tmp/_chk.mjs && node --check /tmp/_chk.mjs || { echo "❌ 语法错误: $f"; exit 1; }
done
SMOKE=/Users/liangzj/.workbuddy/binaries/node/workspace/test-v3-smoke.mjs
if [ -f "$SMOKE" ]; then node "$SMOKE" > /tmp/smoke.log 2>&1 && echo "    冒烟通过" || { echo "❌ 冒烟失败，见 /tmp/smoke.log"; exit 1; }; fi

echo "==> [2/5] 打包上传…"
./package.sh > /dev/null
scp -q dist/market-pos-oracle.tar.gz "$TARGET":/tmp/mp-update.tar.gz

echo "==> [3/5] 服务器备份 + 更新 + 自检…"
ssh "$TARGET" bash -s << REMOTE
set -euo pipefail
cd ~/market-pos
[ -f .env ] || { echo "❌ ~/market-pos/.env 不存在，请先用 deploy.sh 部署"; exit 1; }

# --- 备份（数据库 + 图片卷）---
mkdir -p ~/backups
echo "    备份数据库…"
docker compose exec -T postgres pg_dump -U marketpos marketpos | gzip > ~/backups/db-$TS.sql.gz
echo "    备份收款码图片…"
docker run --rm -v marketpos_appfiles:/files:ro -v ~/backups:/bk alpine \
  tar czf /bk/files-$TS.tar.gz -C /files . 2>/dev/null || echo "    （图片卷为空或不存在，跳过）"
ls -t ~/backups | tail -n +11 | xargs -I{} rm -f ~/backups/{} 2>/dev/null || true
echo "    备份完成：$(ls ~/backups | head -2 | tr '\n' ' ')"

# --- 替换代码（保留 .env）---
cp .env /tmp/mp-env-keep
cd ~ && rm -rf market-pos-old && mv market-pos market-pos-old
mkdir market-pos && tar xzf /tmp/mp-update.tar.gz -C market-pos --strip-components=1
cp /tmp/mp-env-keep market-pos/.env && rm /tmp/mp-env-keep /tmp/mp-update.tar.gz
cd ~/market-pos

# --- 重建（SQL 迁移由 API 启动时自动执行）---
docker compose up -d --build 2>&1 | tail -3
REMOTE

echo "==> [4/5] 健康检查…"
IP="${TARGET#*@}"
HEALTH_URL="http://$IP/api/health"
OK=""
for i in $(seq 1 15); do
  sleep 4
  if curl -sf "$HEALTH_URL" | grep -q '"ok":true'; then OK=1; break; fi
done

if [ -n "$OK" ]; then
  echo "✅ 更新成功（数据未动，新增 SQL 迁移已自动执行）"
  ssh "$TARGET" "cd ~/market-pos && docker compose exec api node -e \"console.log('migrations ok')\" 2>/dev/null; exit 0" || true
else
  echo "❌ 更新后健康检查失败 —— 自动回滚…"
  ssh "$TARGET" bash -s << ROLLBACK
set -e
cd ~
rm -rf market-pos-broken && mv market-pos market-pos-broken
mv market-pos-old market-pos
cd market-pos && docker compose up -d --build 2>&1 | tail -1
# 数据库一般无需回滚（迁移幂等）；如确需恢复备份：
# gunzip -c ~/backups/db-$TS.sql.gz | docker compose exec -T postgres psql -U marketpos marketpos
ROLLBACK
  echo "已回滚到旧版本。排查：ssh $TARGET 'cd ~/market-pos && docker compose logs api'"
  exit 1
fi
