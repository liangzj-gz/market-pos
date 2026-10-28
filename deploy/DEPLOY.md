# 甲骨文（Oracle Cloud）部署手册

> 目标：在 Oracle Cloud Always Free 的 ARM 实例上，运行完全自托管的「摆摊订单管家」。
> 前端 + API + 数据库 + 图片全部在你自己的服务器，不依赖任何第三方云服务。

## 0. 实例规格（2026 年新口径，重要）

甲骨文 2026 年 6 月把 Always Free 的 ARM 配额**从 4C24G 砍到 2 OCPU / 12GB**
（月额度 1500 OCPU 时 + 9000 GB 时），8 月起强制执行，超配实例会被自动停机。
网上大量旧教程仍写 4C24G，不要照抄。

开实例时选：

| 项 | 建议 |
|---|---|
| 型号 | VM.Standard.A1.Flex，**2 OCPU / 12GB**（收银台只需约 0.5GB，留足余量） |
| 系统 | Ubuntu 22.04 / 24.04（Canonical Ubuntu，不是 Oracle Linux 也行） |
| 引导卷 | 50GB 足够（200GB 是三台实例共享总额） |
| 区域 | 就近选；若开不出（out of capacity）换可用域或过几天再试 |

另两台 1/8 OCPU 的 AMD micro 实例留着不用（1GB 内存跑不动 PG）。

**闲置回收**：CPU/内存/网络利用率连续 7 天都低于 20% 的实例可能被回收。
收银台日常流量小，建议在服务器上加个轻量心跳任务（手册末尾附）。

### 两层防火墙（最容易卡住的一步）

1. **VCN 安全列表**：控制台 → 网络 → 虚拟云网络 → 你的 VCN → 安全列表 → 添加入站规则：
   - 源 `0.0.0.0/0`，TCP，端口 `80`；再一条 `443`（HTTPS 用）
2. **系统 iptables**（Ubuntu 镜像自带规则，SSH 进服务器）：
   ```bash
   sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save 2>/dev/null || \
     { sudo apt-get update && sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save; }
   ```

## 1. 装 Docker（服务器上）

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
docker --version
```

## 2. 一键部署（本地 Mac 上）

```bash
cd ~/WorkBuddy/集市收银台
./deploy/deploy.sh ubuntu@<服务器IP>          # 纯 HTTP
./deploy/deploy.sh ubuntu@<服务器IP> pos.xx.com   # HTTPS（域名先解析 A 记录）
```

脚本自动：打包最新代码 → 上传 → 生成随机密码/密钥（`.env`）→ 启动 → 健康检查，
最后打印**访问地址**和**建号密钥（SETUP_KEY）**。

浏览器打开访问地址 →「首次建号」→ 手机号 + 密码（≥6 位）+ 建号密钥 → 进入。
建号入口在建好第一个账号后自动关闭。

## 3. 迁移 WorkBuddy 云端数据（可选）

1. 正式站（`https://market-pos-90848.app.workbuddy.host/`）登录 → 设置 → **导出当前数据（JSON 备份）**
2. 上传并导入：
   ```bash
   scp 备份.json ubuntu@<服务器IP>:~
   ssh ubuntu@<服务器IP>
   cd ~/market-pos
   docker cp ~/备份.json $(docker compose ps -q api):/tmp/b.json
   docker compose exec api node src/import-backup.mjs /tmp/b.json 你的手机号
   ```
   > 注意：备份文件在宿主机 `~` 下，**容器内看不到**，必须先 `docker cp` 进容器（上面的命令已包含）。
3. **核对**：脚本会输出各表行数。基线（2026-10-28 云端快照）：分类 17 / 商品 36 / 标签 5 /
   套餐 2 / 订单 30 / 明细 56 / 调整 12 / 流水 97 / 余额 36 / 预警 7 / 实收合计 1144.00。
   再进页面看：订单列表 30 单、统计页应收 1144、商品库存数字一致。
4. 脚本可重复执行（幂等，不产生重复行）；迁移后再开新单，订单 id / 编号自动接续不会撞车（已实测）。
5. 收款码图片不随 JSON 走：登录后在 设置 → 收款码 重新上传一次即可。

## 4. 日常更新（本地 Mac 上）

改完代码 → 本地测试（见下）→ 一条命令发版：

```bash
./deploy/update.sh ubuntu@<服务器IP>
```

脚本自动：**本地语法+冒烟预检（不过不发版）→ 上传 → 服务器先备份（数据库+图片，保留 5 份）
→ 重建容器 → 新增 SQL 迁移自动执行 → 健康检查，失败自动回滚旧版本**。

数据库结构变更时：在 `sql/migrations/` 加 `00NN_描述.sql`（必须幂等），
API 启动时按 `schema_migrations` 表记录自动补跑——`update.sh` 不需要你做任何额外操作。

## 5. 本地开发与测试（不碰正式数据）

```bash
cd ~/WorkBuddy/集市收银台
./package.sh && cd dist/market-pos-oracle && docker compose -p dev up -d --build
# 访问 http://localhost （?preview=1 仍是免登录演示模式）
```

本地栈跑在**本地容器和本地卷**里，与甲骨文的数据库物理隔离，
本地调试不可能读写到正式数据。测完 `docker compose -p dev down -v` 清掉即可。

改前端后快速自检（不用起容器）：
```bash
for f in $(git diff --name-only | grep '\.js$'); do cp "$f" /tmp/_c.mjs && node --check /tmp/_c.mjs || echo "语法错误 $f"; done
```

## 6. 备份与恢复（服务器上）

```bash
cd ~/market-pos
./deploy/backup.sh                 # 手动备份（数据库+图片，保留 10 份）
./deploy/restore.sh backups/db-20261028-1200.sql.gz     # 恢复数据库（覆盖，会要求确认）
./deploy/restore.sh backups/files-20261028-1200.tar.gz  # 恢复收款码图片
```

每周自动备份：`crontab -e` 加一行
```
0 4 * * 1 cd ~/market-pos && ./deploy/backup.sh >> ~/backups/cron.log 2>&1
```

把备份拉回 Mac（本机执行，异地留存）：
```bash
scp ubuntu@<服务器IP>:~/market-pos/backups/db-*.sql.gz ~/Downloads/
```

## 7. 常见问题

**Q: 忘记密码？**
保留数据重置（uid 不变，数据完好）：
```bash
cd ~/market-pos && docker compose exec api node src/reset-password.mjs 手机号 新密码
```
> 不要用「删号重建」：删除账号后新账号 uid 不同，旧数据（owner_id）会全部看不到。

**Q: 建号密钥（SETUP_KEY）在哪？**
`~/market-pos/.env`。改完 `docker compose up -d` 重建生效。建号完成后它就不再被需要。

**Q: 登录后一直「操作失败」？**
`docker compose logs api`。报「数据库缺少函数」→ `docker compose restart api`。

**Q: 换了 AUTH_SECRET 后全部要重新登录？**
是设计如此——会话签名密钥变了，旧登录全部失效。

**Q: 想换端口 / 加域名？**
改 `.env` 的 `WEB_PORT`，或设 `DOMAIN` 后 `docker compose --profile https up -d`。

**Q: 和 WorkBuddy 云端版还能同时用吗？**
能，两边数据完全独立。GitHub Pages 预览（`?preview=1`）也照常。

## 8. 自托管版与云端版差异

| 能力 | 云端版 | 自托管版 |
|---|---|---|
| 短信验证激活 | ✅ | ❌（首次建号：密码 + SETUP_KEY） |
| 页面内改密码 | ✅ | ❌（服务器一条命令重置，数据不丢） |
| 数据/图片存储 | WorkBuddy 云 | 你的服务器（PG + Docker 卷） |
| 备份 | 平台托管 | pg_dump + tar（本手册第 6 节） |

## 附：防闲置回收心跳（可选）

收银台流量小时，加个 cron 保持基础活动：
```bash
crontab -e
# 每小时拉一次自己的健康检查（产生网络流量）
0 * * * * curl -s http://localhost/api/health > /dev/null
```
