# Oracle Cloud 部署手册（从零到能用）

> 目标：在一台 Oracle Cloud VM（Ubuntu 22.04/24.04， ARM 或 x86 均可）上跑起完整的「摆摊订单管家」自托管版。
> 全程约 20 分钟。所有命令都在服务器终端执行（SSH 连上去）。

## 0. 前置条件

- Oracle Cloud 账号，已开一台 VM（Always Free 的 ARM 4C24G 或 x86 1C1G 都够用）
- 能 SSH 登录服务器
- 本地已拿到 `market-pos-oracle.tar.gz` 部署包

### Oracle Cloud 安全组（重要，最容易卡住的一步）

Oracle VM 有**两层防火墙**，两层都要放行 80 端口：

1. **VCN 安全列表（Security List）**：控制台 → 网络 → 虚拟云网络 → 你的 VCN → 安全列表 → 添加入站规则：
   - 源 CIDR：`0.0.0.0/0`，协议 TCP，目标端口 `80`
2. **系统 iptables（Ubuntu 镜像自带）**：SSH 进服务器执行：
   ```bash
   sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
   # 持久化（重启不丢）
   sudo netfilter-persistent save
   # 若提示没有 netfilter-persistent：
   sudo apt-get update && sudo apt-get install -y iptables-persistent
   ```

## 1. 装 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker   # 或者退出重登一次
docker --version   # 能打印版本即成功
```

## 2. 上传部署包并启动

本地 Mac 上传（IP 换成你的服务器公网 IP）：

```bash
scp market-pos-oracle.tar.gz ubuntu@<服务器IP>:~
```

服务器上：

```bash
cd ~
tar xzf market-pos-oracle.tar.gz
cd market-pos-oracle
cp .env.example .env
```

编辑 `.env`，**必改两项**：

```bash
# 生成随机密码/密钥的快捷方式（贴进 .env）：
openssl rand -hex 24
```

- `PGPASSWORD`：数据库密码
- `AUTH_SECRET`：登录会话签名密钥（不设则每次重启服务器后需重新登录）

启动：

```bash
docker compose up -d
docker compose ps    # 三个容器都应是 running / healthy
```

首次启动时 postgres 容器会自动执行 `sql/` 里的 4 个脚本建库（约 10 秒）。

## 3. 验证

```bash
curl http://localhost/api/health
# 期望：{"ok":true,"db":"up",...}
```

浏览器打开 `http://<服务器公网IP>/`：
1. 看到登录页 →「首次建号」→ 输入手机号 + 至少 6 位密码 → 创建并进入
2. 应用里已有 36 个演示商品？（没有——自托管库是空的，这是正常的）
3. 开一单测试：开单 → 收款 → 库存扣减

> 打不开？按顺序查：① `docker compose ps` 容器状态；② `curl http://localhost/api/health`；③ 上面第 0 步的两层防火墙。

## 4. 迁移 WorkBuddy 云端的既有数据

1. 打开正式站 `https://market-pos-90848.app.workbuddy.host/`，登录
2. 设置 → **导出当前数据（JSON 备份）**，把下载的文件传到服务器（scp）
3. 服务器上执行（账号 = 你在第 3 步建号用的手机号）：
   ```bash
   docker compose exec api node src/import-backup.mjs /home/ubuntu/备份.json 13800000000
   ```
4. 手机刷新页面 → 全部订单 / 商品 / 库存 / 流水都在
5. 收款码图片不随 JSON 走，重新上传一次即可

## 5. HTTPS（可选但推荐）

自托管版没配证书时用的是 `http://`。要上 `https://` 最简单是 Caddy：

```bash
# 前提：你有域名并已解析 A 记录到服务器 IP
docker run -d --name caddy --restart unless-stopped \
  -p 80:80 -p 443:443 \
  -v /srv/caddy/Caddyfile:/etc/caddy/Caddyfile \
  -v caddy_data:/data \
  alpine/caddy caddy run --config /etc/caddy/Caddyfile
```

`/srv/caddy/Caddyfile`：

```
pos.example.com {
    reverse_proxy localhost:8080
}
```

同时把 `.env` 里 `WEB_PORT` 改成 `8080` 并 `docker compose up -d` 重建（避免和 Caddy 抢 80）。

## 6. 日常运维

```bash
docker compose logs -f api                              # 实时日志
docker compose restart api                              # 重启 API
docker compose down                                     # 停止（数据保留在卷里）
docker compose down -v                                  # ⚠️ 连数据一起删（慎用）

# 数据库备份（建议每周一次，文件拷回 Mac 或对象存储）
docker compose exec postgres pg_dump -U marketpos marketpos > pos-$(date +%F).sql

# 数据库恢复
cat pos-2026-10-28.sql | docker compose exec -T postgres psql -U marketpos marketpos
```

## 7. 常见问题

**Q: 登录后一直「操作失败」？**
`docker compose logs api` 看报错。数据库函数缺失（`数据库缺少函数 xxx`）说明 postgres 首次初始化没跑完就启动了 api，`docker compose restart postgres api` 一次即可。

**Q: 换了 AUTH_SECRET 后全部要重新登录？**
是设计如此——会话签名密钥变了，旧 token 全部失效。

**Q: 忘记密码？**
服务器上直接重置：
```bash
docker compose exec postgres psql -U marketpos marketpos \
  -c "DELETE FROM local_users WHERE phone='13800000000'"
```
然后回登录页重新「首次建号」。

**Q: 和 WorkBuddy 云端版还能同时用吗？**
能。两边数据完全独立，互不影响。GitHub Pages 预览站（`?preview=1`）也照常可用。

## 8. 自托管版与云端版的差异

| 能力 | 云端版 | 自托管版 |
|---|---|---|
| 短信验证激活 | ✅ | ❌（首次建号直接设密码，之后关闭） |
| 页面内改密码 | ✅ | ❌（删号重建，见上文 FAQ） |
| 数据存储 | WorkBuddy 云数据库 | 你自己的 PostgreSQL |
| 收款码图片 | 云端 Storage | 服务器本地磁盘（Docker 卷） |
| 数据隔离 | 平台级 RLS | API 层按账号隔离（单管理员场景） |

> 自托管版默认单账号自用。要给多人用（多个摊主），每个手机号建一个账号即可（首个建号后在 API 里手工建：见 server/src 代码），数据按 owner_id 隔离。
