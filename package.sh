#!/bin/bash
# ============================================================
# package.sh —— 打「Oracle Cloud 自托管部署包」
#
# 用法：./package.sh
# 产物：dist/market-pos-oracle.tar.gz
#
# 包内容：
#   web/html/          前端静态文件（index.html 注入 __SELF_HOST__ 标记）
#   web/nginx.conf     反代配置
#   server/            Node.js API（Express + pg）
#   sql/               0000~0003（postgres 容器首次启动自动执行）
#   docker-compose.yml / .env.example / DEPLOY.md / README
#
# 本脚本不改仓库源文件：标记注入在临时目录里完成。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

DIST=dist
PKG=$DIST/market-pos-oracle
STAGE=$(mktemp -d /tmp/mp-pkg.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

rm -rf "$PKG"
mkdir -p "$PKG/web" "$PKG/server/src"

# ---------- 前端：复制 + 注入自托管标记 ----------
mkdir -p "$PKG/web/html"
cp -R index.html assets src "$PKG/web/html/"
rm -rf "$PKG/web/html/tests" 2>/dev/null || true
# 在 importmap 前注入标记（macOS sed 不支持 \n，用 perl；仓库源文件不动）
if ! grep -q "__SELF_HOST__" "$PKG/web/html/index.html"; then
  perl -pi -e 's{<script type="importmap">}{<script>window.__SELF_HOST__=true</script>\n<script type="importmap">}' "$PKG/web/html/index.html"
fi
grep -q "__SELF_HOST__" "$PKG/web/html/index.html" || { echo "❌ 标记注入失败"; exit 1; }
cp web/nginx.conf "$PKG/web/nginx.conf"

# ---------- 后端 ----------
cp server/package.json server/Dockerfile "$PKG/server/"
cp server/src/*.js server/src/*.mjs "$PKG/server/src/"

# ---------- SQL（首次建库 4 个 + 升级迁移目录） ----------
mkdir -p "$PKG/sql/migrations"
cp sql/0000_self_host.sql sql/0001_schema.sql sql/0002_indexes.sql sql/0003_functions.sql "$PKG/sql/"
cp sql/migrations/*.sql "$PKG/sql/migrations/"

# ---------- 运维脚本与 Caddy 配置 ----------
mkdir -p "$PKG/deploy/caddy"
cp deploy/deploy.sh deploy/update.sh deploy/backup.sh deploy/restore.sh "$PKG/deploy/"
cp deploy/caddy/Caddyfile "$PKG/deploy/caddy/"
chmod +x "$PKG/deploy/"*.sh

# ---------- 编排与文档 ----------
cp deploy/docker-compose.yml "$PKG/"
cp web/Dockerfile "$PKG/web/Dockerfile"
cp deploy/.env.example "$PKG/"
cp deploy/DEPLOY.md "$PKG/"
cp deploy/README.md "$PKG/"

# ---------- 打包 ----------
mkdir -p "$DIST"
tar --exclude='.DS_Store' --exclude='__pycache__' -czf "$DIST/market-pos-oracle.tar.gz" -C "$DIST" "market-pos-oracle"
echo ""
echo "✅ 打包完成：$DIST/market-pos-oracle.tar.gz"
tar -tzf "$DIST/market-pos-oracle.tar.gz" | head -20
echo "…（共 $(tar -tzf "$DIST/market-pos-oracle.tar.gz" | wc -l | tr -d ' ') 个文件）"
du -h "$DIST/market-pos-oracle.tar.gz"
