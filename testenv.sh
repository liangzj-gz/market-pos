#!/bin/bash
# ============================================================
# testenv.sh —— 本地手机测试环境（一键起 / 停 / 清）
#
# 用法（在项目根目录）：
#   ./testenv.sh            # 起测试环境（首次自动建号+灌演示数据）
#   ./testenv.sh stop       # 停止（保留数据，下次 start 秒起）
#   ./testenv.sh reset      # 清空数据重新灌演示数据（改代码调试用）
#   ./testenv.sh down       # 彻底删除（容器+数据卷）
#
# 起好后手机（与 Mac 同一 Wi-Fi）访问打印的局域网地址：
#   账号 13800000000 / 密码 test123456 / 建号密钥 demo-setup-key
# 数据全在本地 Docker 卷里，与 WorkBuddy 正式环境物理隔离。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

CMD="${1:-start}"
PORT="${TESTENV_PORT:-8080}"
PROJ=mptest            # compose 项目名（独立容器与卷）
DIR=dist/testenv
DEMO=tests/demo-data.json
TEST_PHONE=13800000000
TEST_PASS=test123456
TEST_KEY=demo-setup-key

case "$CMD" in
  stop)
    [ -d "$DIR" ] && (cd "$DIR" && docker compose -p $PROJ stop) && echo "已停止（数据保留，./testenv.sh 再启动）"
    exit 0 ;;
  down)
    [ -d "$DIR" ] && (cd "$DIR" && docker compose -p $PROJ down -v) && rm -rf "$DIR" && echo "已彻底删除"
    exit 0 ;;
  reset)
    [ -d "$DIR" ] && (cd "$DIR" && docker compose -p $PROJ down -v >/dev/null 2>&1) || true
    echo "已清空数据，将重新初始化…" ;;
  start) ;;
  *) echo "用法: ./testenv.sh [start|stop|reset|down]"; exit 1 ;;
esac

echo "==> [1/4] 打包当前代码…"
./package.sh > /dev/null
mkdir -p dist && rm -rf "$DIR" && mkdir "$DIR" \
  && tar xzf dist/market-pos-oracle.tar.gz -C "$DIR" --strip-components=1

# 测试环境固定配置（端口可覆盖；每次重灌演示数据）
cat > "$DIR/.env" << ENV
WEB_PORT=$PORT
PGDATABASE=marketpos
PGUSER=marketpos
PGPASSWORD=testenv-only
AUTH_SECRET=testenv-secret
SETUP_KEY=$TEST_KEY
ENV

echo "==> [2/4] 启动容器（postgres + api + web）…"
cd "$DIR" && docker compose -p $PROJ up -d --build 2>&1 | tail -1

echo "==> [3/4] 等待就绪…"
for i in $(seq 1 20); do
  sleep 3
  if curl -sf "http://localhost:$PORT/api/health" | grep -q '"ok":true'; then break; fi
done
curl -sf "http://localhost:$PORT/api/health" | grep -q '"ok":true' || { echo "❌ 启动失败：docker compose -p $PROJ logs api"; exit 1; }

echo "==> [4/4] 初始化测试数据…"
HAVE_USER=$(curl -s -X POST "http://localhost:$PORT/api/login" -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$TEST_PHONE\",\"password\":\"$TEST_PASS\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("ok"))' 2>/dev/null || echo False)
if [ "$HAVE_USER" != "True" ]; then
  # 首次：建号（带测试密钥）
  curl -s -X POST "http://localhost:$PORT/api/setup" -H 'Content-Type: application/json' \
    -d "{\"phone\":\"$TEST_PHONE\",\"password\":\"$TEST_PASS\",\"setupKey\":\"$TEST_KEY\"}" | grep -q '"ok":true' \
    || { echo "❌ 建号失败"; exit 1; }
fi
# 灌演示数据（幂等；reset 后是空库，全量灌入）
if [ -f "$OLDPWD/$DEMO" ]; then
  docker cp "$OLDPWD/$DEMO" "$(docker compose -p $PROJ ps -q api):/tmp/demo.json"
  docker compose -p $PROJ exec api node src/import-backup.mjs /tmp/demo.json $TEST_PHONE 2>&1 | grep -E "导入完成|分类|商品|订单" | head -4
fi

# 局域网地址
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<Mac的IP>')
# 注：macOS bash 3.2 在 set -u + 多字节 heredoc 下变量展开有 bug，改用 printf
printf '%s\n' \
  "" \
  "✅ 测试环境已就绪" \
  "" \
  "  手机（同一 Wi-Fi）访问：http://$IP:$PORT/" \
  "      Mac 本机：http://localhost:$PORT/" \
  "" \
  "  登录账号: $TEST_PHONE" \
  "  密码: $TEST_PASS" \
  "  首次建号密钥（如被问到）: $TEST_KEY" \
  "" \
  "  演示数据：6 个测试商品 / 5 笔订单 / 库存流水" \
  "  与正式环境完全隔离（数据在本地容器卷，随便造）" \
  "" \
  "命令：" \
  "  ./testenv.sh stop    停止（数据保留）" \
  "  ./testenv.sh reset   清数据重灌（改代码后重新调试）" \
  "  ./testenv.sh down    彻底删除"
