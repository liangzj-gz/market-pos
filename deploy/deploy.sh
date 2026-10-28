#!/bin/bash
# ============================================================
# deploy.sh —— 一键部署到甲骨文（首次部署用）
#
# 用法（在项目根目录的上一级或任意位置）：
#   ./deploy.sh ubuntu@服务器IP [域名]
#
# 例：
#   ./deploy.sh ubuntu@140.238.10.10              # 纯 HTTP（IP 访问）
#   ./deploy.sh ubuntu@140.238.10.10 pos.xx.com   # HTTPS（域名已解析 A 记录到该 IP）
#
# 做什么：
#   1. 本地跑 package.sh 打最新部署包（顺带语法检查）
#   2. 上传并解压到服务器 ~/market-pos
#   3. 生成 .env：随机数据库密码 / AUTH_SECRET / SETUP_KEY（已存在则保留）
#   4. 启动三容器（有域名则带 caddy HTTPS profile）
#   5. 健康检查通过后打印：访问地址 / 首次建号密钥 / 迁移数据指引
# 重复执行安全：不会覆盖已有 .env 和数据卷。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:?用法: ./deploy/deploy.sh ubuntu@服务器IP [域名]}"
DOMAIN="${2:-}"

echo "==> [1/5] 打包最新版本…"
./package.sh > /dev/null
PKG=dist/market-pos-oracle.tar.gz

echo "==> [2/5] 上传到 $TARGET …"
scp -q "$PKG" "$TARGET":/tmp/market-pos-oracle.tar.gz

echo "==> [3/5] 服务器上解压与配置…"
ssh "$TARGET" bash -s << REMOTE
set -euo pipefail
cd ~
# 已有部署则只更新代码，不动 .env 与数据
if [ -d market-pos ]; then
  echo "    检测到已有 ~/market-pos，备份其 .env 后替换代码"
  [ -f market-pos/.env ] && cp market-pos/.env /tmp/mp-env-keep
  rm -rf market-pos-old && mv market-pos market-pos-old
fi
mkdir -p market-pos && tar xzf /tmp/market-pos-oracle.tar.gz -C market-pos --strip-components=1
cd market-pos

if [ -f /tmp/mp-env-keep ]; then
  cp /tmp/mp-env-keep .env
  echo "    已保留原 .env（密码/密钥不变）"
else
  cat > .env << ENV
PGDATABASE=marketpos
PGUSER=marketpos
PGPASSWORD=$(openssl rand -hex 16)
AUTH_SECRET=$(openssl rand -hex 24)
SETUP_KEY=$(openssl rand -hex 8)
WEB_PORT=80
ENV
  chmod 600 .env
  echo "    已生成新 .env（随机密码/密钥）"
fi
rm -f /tmp/mp-env-keep /tmp/market-pos-oracle.tar.gz
REMOTE

echo "==> [4/5] 启动容器…"
if [ -n "$DOMAIN" ]; then
  ssh "$TARGET" "cd ~/market-pos && sed -i.bak 's/^WEB_PORT=.*/WEB_PORT=8080/' .env && echo \"DOMAIN=$DOMAIN\" >> .env && docker compose --profile https up -d --build"
else
  ssh "$TARGET" "cd ~/market-pos && docker compose up -d --build"
fi

echo "==> [5/5] 健康检查…"
sleep 8
IP="${TARGET#*@}"
if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"; else URL="http://$IP"; fi
for i in $(seq 1 12); do
  if curl -sf "$URL/api/health" | grep -q '"ok":true'; then break; fi
  sleep 5
done
if curl -sf "$URL/api/health" | grep -q '"ok":true'; then
  echo ""
  echo "✅ 部署成功：$URL"
  ssh "$TARGET" "cd ~/market-pos && grep -E 'SETUP_KEY|PGPASSWORD' .env | sed 's/^/    /'"
  cat << TIP

首次使用：
  1. 浏览器打开上面的地址 → 「首次建号」→ 手机号 + 密码 + 建号密钥（SETUP_KEY）
  2. 迁移云端数据：正式站 设置→导出 JSON 备份，然后：
     scp 备份.json $TARGET:~
     ssh $TARGET
     cd ~/market-pos && docker cp ~/备份.json \$(docker compose ps -q api):/tmp/b.json
     docker compose exec api node src/import-backup.mjs /tmp/b.json 你的手机号
  3. 迁移后核对：订单/商品数、实收合计应与云端一致（详见 DEPLOY.md）
TIP
else
  echo "❌ 健康检查未通过，请排查：ssh $TARGET 'cd ~/market-pos && docker compose ps && docker compose logs api'"
  exit 1
fi
