# 集市收银台 · Oracle Cloud 自托管部署包

一套完全自托管的「摆摊订单管家」：前端静态页 + Node API + PostgreSQL，全部跑在你自己的服务器（Oracle Cloud ARM 实例或任何装了 Docker 的主机）上，不依赖任何第三方云服务。

## 快速开始

**推荐（本地 Mac 一键部署）**：
```bash
./deploy/deploy.sh ubuntu@<服务器IP> [域名]
```

**手动（服务器上）**：
```bash
tar xzf market-pos-oracle.tar.gz && cd market-pos-oracle
cp .env.example .env && vi .env     # 改密码/密钥/SETUP_KEY
docker compose up -d
```

浏览器打开 `http://服务器IP/` → 「首次建号」（手机号 + 密码 + SETUP_KEY）。

## 日常

- 改代码后发版：本地 `./deploy/update.sh ubuntu@IP`（自动预检/备份/迁移/回滚）
- 备份/恢复：服务器 `./deploy/backup.sh` / `./deploy/restore.sh`
- 从 WorkBuddy 云端迁数据：见 DEPLOY.md 第 3 节（含核对基线）

## 包内容

```
market-pos-oracle/
├── web/html/          前端（注入自托管标记，走 /api）
├── server/            Node API（登录/RPC/收款码/迁移执行器/密码重置）
├── sql/               首次建库脚本（0000-0003）
├── sql/migrations/    升级迁移脚本（API 启动自动执行）
├── deploy/            deploy/update/backup/restore 脚本 + Caddy 配置
├── docker-compose.yml postgres + api + web (+ caddy HTTPS profile)
├── .env.example
└── DEPLOY.md          完整手册（含 2026 新资源口径与核对基线）
```
