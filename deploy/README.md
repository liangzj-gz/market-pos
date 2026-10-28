# 集市收银台 · Oracle Cloud 自托管部署包

一套完全自托管的「摆摊订单管家」：前端静态页 + Node API + PostgreSQL，全部跑在你自己的服务器（Oracle Cloud VM 或任何装了 Docker 的主机）上，不依赖任何第三方云服务。

## 包内容

```
market-pos-oracle/
├── web/html/          前端（已注入自托管标记，走 /api）
├── web/nginx.conf     nginx：静态 + /api 反代
├── server/            Node.js API（登录 / RPC / 收款码文件）
├── sql/               建库脚本（postgres 容器首次启动自动执行）
├── docker-compose.yml 三容器编排（postgres / api / web）
├── .env.example       环境变量模板
└── DEPLOY.md          详细部署手册（从零到能用）
```

## 快速开始（服务器上已有 Docker）

```bash
tar xzf market-pos-oracle.tar.gz && cd market-pos-oracle
cp .env.example .env && vi .env        # 改 PGPASSWORD / AUTH_SECRET
docker compose up -d
```

浏览器打开 `http://服务器IP/` → 登录页 →「首次建号」建第一个账号。

## 从 WorkBuddy 云端迁移数据

1. 在正式站点：设置 → 导出当前数据（JSON 备份），得到备份文件
2. 上传到服务器，在部署目录执行：
   ```bash
   docker compose exec api node src/import-backup.mjs /path/备份.json 你的手机号
   ```
3. 刷新页面即可看到全部历史数据（收款码图片需重新上传）

## 常用运维

```bash
docker compose logs -f api          # 看日志
docker compose pull && docker compose up -d   # 升级
docker compose exec postgres pg_dump -U marketpos marketpos > backup.sql   # 备份数据库
```

详见 DEPLOY.md。
