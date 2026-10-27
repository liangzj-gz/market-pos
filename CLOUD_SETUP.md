# 集市收银台 · 云数据库接入规格（v3 字段化）

> 当前版本：v3（2026-10-27 完成）。v1「整份 JSONB 一行」与 v2「行表 + data JSONB」均已被 v3 取代；
> 旧函数已下线，`app_state` 行与 `legacy_*` 备份表保留作回滚数据源。

## 目标

- 手机号验证码登录（WorkBuddy 内置身份认证），数据按账号隔离
- 商品 / 分类 / 标签 / 套餐 / 订单 / 明细 / 选品快照 / 调整 / 流水 / 余额 / 预警 / 收款码全部**字段化存储**
- 金额 `numeric(12,2)`、时间 `timestamptz`、主外键 + 唯一约束 + 索引齐备，外键全部含 `owner_id` 复合
- 业务规则（R1–R9）在**服务端事务**内执行：下单 = 订单 + 明细 + 选品 + 调整 + 扣库存 + 流水 + 预警一次落库
- 订单 / 流水服务端筛选分页；统计服务端聚合
- 幂等：所有写接口带 `request_id`，重复提交（网络重试 / 双击）只生效一次（`client_requests` 表去重）

## 表结构（20 张）

行表：`categories products tags product_tags combos combo_items combo_groups combo_group_products
orders order_items order_item_selections adjustments movements inventory_balances stock_alerts payment_codes`
单行/辅助：`app_meta`（保留）、`id_counters`（服务端 id 分配）、`order_no_counters`（订单号日计数）、
`client_requests`（幂等去重）、`app_state`（v1 遗留，保留只读）。

- 库存余额独立成表 `inventory_balances`：**无行 = 未盘点；0 = 余额为零**
- 收款码存文件存储路径（`payment_codes.storage_path`），图片本体在 Storage `users/<uid>/payment-codes/`
- 完整 DDL 见 `sql/0001_schema.sql` + `sql/0002_indexes.sql`

## 服务端接口（26 个 SECURITY DEFINER 函数，`sql/0003_functions.sql`）

| 类别 | 函数 |
|---|---|
| 读 | `load_snapshot`（主数据快照）、`dashboard`（今日看板）、`list_orders`（订单分页筛选）、`get_order`（订单详情）、`list_movements`（流水分页）、`stats_summary`（统计聚合）、`export_dataset`（全量导出/备份） |
| 写 | `create_order`、`order_action`（confirm/cancel，CAS 状态机）、`stock_action`（in/set）、`save_product`、`import_products`、`save_combo`、`delete_combo`、`save_category`、`delete_category`、`save_tag`、`toggle_product`、`resolve_alert`、`save_payment_code` |
| 内部 | `v3_next_id`、`v3_next_order_no`（`SO+yyyyMMdd+3位流水`）、`v3_day_summary`、`v3_order_impact`、`v3_upsert_product`、`v3_raise_alert`（不给客户端 EXECUTE） |

安全收口：所有 public 表 ENABLE RLS；客户端对业务表零 GRANT，只能经函数读写；
`owner_id` 由函数注入 `auth.uid()`，跨账号读写不成立（`sql/0004_grants.sql`）。

## 前端数据层

```
src/cloud-config.js   应用标识（publishableKey，无权限语义）
src/data/cloud.js     SDK 客户端 / 登录会话
src/data/api.js       rpc() 封装 + newRequestId() 幂等键 + Storage 收款码上传/签名
src/data/store.js     服务端权威 + 前端缓存：登录拉快照；写操作立即 RPC，成功后按返回值更新缓存并后台刷新
```

- 登录后 `load_snapshot()` 装配主数据（商品/分类/套餐/标签/余额/预警），`dashboard()` 拉今日看板
- 订单页 `list_orders` 服务端筛选 + 分页（每页 30 条，加载更多）；详情 `get_order`（含选品快照展开）
- 统计页 `stats_summary` 服务端聚合；库存页流水来自快照（每商品近 12 条）
- 所有写动作带 `request_id`；`?preview=1` 预览分支保留（跳过登录灌种子数据，写操作走前端规则引擎，不调云端）
- 缓存版本号：改任何被 import 的模块必须同步升级 `index.html` importmap 的 `?v=`（当前 `v3-rpc-20261027`）

## 数据迁移与回滚

- 迁移脚本 `sql/0010_migrate_from_legacy.sql`（单事务 DO 块，逐字段映射，2026-10-27 已执行并核对通过）
- 基线核对：分类 17 / 商品 36 / 标签 5+11 / 套餐 2 / 订单 30 / 明细 56 / 调整 12 / 流水 97 / 余额 36 / 预警 7；
  应收 1138.00 = 实收 1144.00 − 调整 6.00；孤儿行 0
- 双备份：`bak_20261027_*`（data JSONB 快照表）+ `legacy_*`（改名留存）；`app_state` 原行保留
- 代码回滚点：git tag `pre-v2-tables`（v2 代码）；v1 应急回滚数据源 = `app_state` 原行
- 切换后产生的 v3 新数据如需回滚，用 `export_dataset()` 导出的 JSON 反向生成 v1 doc 写回 `app_state`（恢复 `save_state` 函数即可），或以 `bak_20261027_*` 为底、手工补差异

## 发布与验收

1. WorkBuddy 云数据库 + 身份认证已开通（应用 `wbapp_guTvZWDoSjTuFs6rthM30K`）
2. 桌面端「发布为应用」触发正式上线，与 `git push` 互不影响
3. 验收项：
   - 登录后快照数字与上表基线一致
   - 开单 → 库存扣减、流水、预警同事务；断网提交不落库、重试不重复
   - 双设备并发开单不撞订单号、不撞 id（服务端原子分配）
   - 冲销回补库存并生成反向流水，原单保留
   - `?preview=1` 免登录分支可用（本机调试）
   - 收款码上传后换设备登录可见

## 验收底线

- 云端数据库是唯一数据源；前端只做缓存，不落 localStorage
- 业务表客户端零直连权限；`publishableKey` 之外不得出现任何密钥
- 任何写接口失败即整体回滚，不允许出现「订单有了库存没扣」的中间态
