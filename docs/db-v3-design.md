# 集市收银台 · 数据库字段化改造（v3）设计方案

> 状态：**方案待确认，未执行任何建表/改表/迁移动作**
> 核查时间：2026-10-27
> 应用 ID：`wbapp_guTvZWDoSjTuFs6rthM30K`
> 数据库：PostgreSQL 17.11（CloudBase 底座，`auth.uid()` 返回 text）

---

## 一、现状核查结论（实测，非推断）

### 1.1 云端实际结构

11 张业务表 + 1 张备份表，除 `app_state` 外**全部是 `owner_id + id + data jsonb` 三列**：

| 表 | 行数 | 列 | 说明 |
|---|---|---|---|
| products | 36 | owner_id, id, data, updated_at | 商品，全部字段在 data |
| combos | 2 | 同上 | 套餐 |
| categories | 17 | 同上 | 分类（6 大类 + 11 中类） |
| orders | 30 | 同上 | 订单 |
| order_items | 56 | 同上 | 订单明细 |
| adjustments | 12 | 同上 | 金额调整 |
| movements | 97 | 同上 | 库存流水 |
| alerts | 7 | 同上 | 库存预警 |
| meta | 1 | owner_id, doc, updated_at | tags / balances / paymentCodes 三合一大 JSON |
| id_ranges | 8 | owner_id, name, base | id 区间申领 |
| app_state | 1 | owner_id, version, doc, updated_at | v1 整份 JSON（遗留） |
| app_state_backup_20261025 | 1 | 同上结构 | 迁移前备份 |

**索引现状**：每张表只有 `PRIMARY KEY (owner_id, id)` 一个索引，没有任何时间/状态/业务字段索引。分页与筛选届时必然全表扫。

### 1.2 正式环境当前写的是哪个版本

- `app_state`（v1 整份 JSON）：`version = 3`，最后写入 **2026-10-24 14:44**，此后无写入。
- 8 张行表 + meta：最后写入 **2026-10-26 10:19**（所有行 `updated_at` 落在同一分钟，是一次全量重推，符合「导入备份 / 恢复初始数据」的行为）；`meta.schema_version = 2`。
- **结论：正式环境当前运行的是 v2（分表 JSONB），不是 v1。** 手机端命中的也是 v2 代码（`index.html` importmap 版本 `csv-export-20261026`，GitHub Pages 已是最新提交）。

### 1.3 新旧两份数据是否有分叉

把 `app_state.doc` 与 8 张行表逐条比对（按 id 做 FULL JOIN + jsonb 相等判断）：

| 表 | v1 行数 | 只在 v1 | 只在 v2 | 内容不同 |
|---|---|---|---|---|
| orders | 30 | 0 | 0 | **0** |
| products | 36 | 0 | 0 | **0** |

**两份数据完全一致，没有分叉。** 这意味着迁移可以以行表为唯一来源，不需要人工裁决冲突；但仍会做一次「切换后追平」校验，防止迁移窗口里旧缓存设备写入。

### 1.4 迁移前基线（用于迁移后逐项核对）

| 指标 | 实测值 |
|---|---|
| 商品 | 36 行；`list_price` 合计 666.00；SKU 唯一 36；条码唯一 36；`category_id` 无空 |
| 标签 | 标签名 5 个；商品-标签关系 11 行 |
| 分类 | 17（6 大类 + 11 中类）；无孤立商品 |
| 套餐 | 2 行；固定明细 8 行；子套餐 8 行；子套餐可选商品 8 行；选品快照 0 行 |
| 订单 | 30 行（paid 30 / pending 0 / cancelled 0）；应收合计 **1138.00**；实收合计 **1144.00**；件数合计 **76**；订单号唯一 30 |
| 订单明细 | 56 行；数量 70（商品行 68 + 套餐行 2）；行金额合计 **1138.00**；赠品 1 行；套餐行 2 行 |
| 金额调整 | 12 行；合计 **+6.00**（负数 7 行）；类型：抹零让利 7 / 录入更正 4 / 多收待退 1 |
| 库存流水 | 97 行；数量合计 571；入库 36 行 / 出库 61 行；孤儿引用 0 |
| 库存余额 | 36 个商品全部已盘点；合计 **571**；含负库存 1 个（商品 32 = -1） |
| 预警 | 7 行，全部 open |
| 收款码 | 0 条（`paymentCodes = {}`） |
| 件数校验 | 68 商品件 + 2 套餐 × 4 件 = 76，与 `orders.item_count` 合计一致 |

### 1.5 核查中发现的既有问题（本次一并修）

1. **匿名可读业务数据**：`app_state_backup_20261025` 关闭了 RLS，且被 `GRANT SELECT ... TO anon`。publishableKey 是公开的，等于**任何人可读你 30 笔订单与商品成本**。必须收权。
2. **首次加载失败仍可录入**：`enterApp()` 先把 `auth.status` 置 `ready` 再拉数据；拉取失败只把状态改成 `unsynced`，界面照常可开单。此时 `v2.ready=false`，`flushSave()` 直接 return，**录入的数据既不落盘也无法重试成功**（重试按钮同样走这条死路），只能刷新。
3. **编号区间语义错乱**：`pullFromCloud` 每次登录都 `ensureRanges(true)` 强制申领 1000 个 id；`id_ranges.order` 已经涨到 **16030**，而实际订单 id 只到 30。下一个新建订单会拿到 id ≈ 15031，与历史 id 断层，`app_state.seq.order=31` 与分表 id 空间已经不一致。
4. **编号区间不足无兜底**：`nextId()` 在 `act()` 里同步分配，若一次操作产生的行数超过剩余区间（如导入 2000 件商品），id 会越过 `range.end`，与另一台设备的区间重叠 → 主键冲突/覆盖。
5. **无防重复提交**：`createOrder` 是同步函数，`submitting` 标志挡不住同一 tick 内的双击；网络超时后用户重试会**再建一单**。库存、流水、调整都会重复。
6. **写入不成事务**：v2 保存按表分 8 次 RPC，中途失败会留下「订单已写、流水没写」的半截数据；前端只把状态标成 `unsynced`，不一致已经产生。
7. **金额是浮点**：JSON 里是 number，前端 `r2()` 兜。实测当前 0 条超过两位小数，但类型上没有约束。
8. **全量下载**：每次登录 `load_app_data()` 拉全部订单/明细/流水；`stats`、`orders` 全在浏览器算。数据量一大就卡。

---

## 二、目标模型总览

20 张表。命名保持业务语义，`owner_id` 一律为 **复合主键的一部分**，所有外键都是 `(owner_id, xxx_id)` 复合外键——**跨账号关联在数据库层就不成立**。

```
账号维度           主数据                     交易                     库存
────────           ──────                     ────                     ────
app_meta           categories ─┐              orders ─┬─ order_items ─┬─ order_item_selections
id_counters        products ───┼─ product_tags        │                └─ (套餐选品快照)
order_no_counters  tags ───────┘                      ├─ adjustments
                   combos ─┬─ combo_items             └─ movements ── inventory_balances
                           ├─ combo_groups                              stock_alerts
                           └─ combo_group_products
client_requests（幂等）      payment_codes（文件存储标识）
```

| # | 表 | 职责 | 行数预期（迁移后） |
|---|---|---|---|
| 1 | `products` | 商品主数据 | 36 |
| 2 | `categories` | 两级分类树 | 17 |
| 3 | `tags` | 标签词库 | 5 |
| 4 | `product_tags` | 商品↔标签 | 11 |
| 5 | `combos` | 套餐头 | 2 |
| 6 | `combo_items` | 套餐固定明细（历史展开依据） | 8 |
| 7 | `combo_groups` | 子套餐（中类 + 件数） | 8 |
| 8 | `combo_group_products` | 子套餐可选商品池 | 8 |
| 9 | `orders` | 订单头 | 30 |
| 10 | `order_items` | 订单明细（含名称/单价/金额快照） | 56 |
| 11 | `order_item_selections` | 套餐选品快照 | 0 |
| 12 | `adjustments` | 金额调整 | 12 |
| 13 | `movements` | 库存流水 | 97 |
| 14 | `inventory_balances` | 库存余额（每账号每商品一行） | 36 |
| 15 | `stock_alerts` | 库存预警 | 7 |
| 16 | `payment_codes` | 收款码（存文件标识） | 0 |
| 17 | `client_requests` | 请求幂等记录 | 0（运行时增长） |
| 18 | `id_counters` | id 分配计数器 | 8 |
| 19 | `order_no_counters` | 订单号按日流水 | 0（运行时增长） |
| 20 | `app_meta` | schema 版本、账号级元信息 | 1 |

被替换的旧对象（改名保留，不删）：`legacy_products / legacy_combos / legacy_categories / legacy_orders / legacy_order_items / legacy_adjustments / legacy_movements / legacy_alerts / legacy_meta / legacy_app_state / legacy_id_ranges`。

---

## 三、逐表字段清单

约定：所有表 `owner_id text NOT NULL DEFAULT auth.uid()`；所有表 `PK (owner_id, id)`（关系表用业务复合键）；均含 `updated_at timestamptz NOT NULL DEFAULT now()`。

### 3.1 products（商品）

| 列 | 类型 | 空 | 约束 / 默认 | 旧 JSON key |
|---|---|---|---|---|
| id | bigint | N | PK 组成 | `id` |
| sku_code | text | N | `UNIQUE (owner_id, sku_code)` | `sku_code` |
| name | text | N | 长度 ≤ 60（沿用前端校验） | `name` |
| category_id | bigint | Y | FK → categories(owner_id,id) ON DELETE RESTRICT | `category_id` |
| series | text | N | 默认 `''`，分类路径快照 | `series` |
| category_name | text | Y | 中类名快照（旧字段保留展示） | `category` |
| unit | text | N | 默认 `'件'` | `unit` |
| list_price | numeric(12,2) | N | 默认 0，`CHECK >= 0` | `list_price` |
| cost_price | numeric(12,2) | Y | `CHECK >= 0`；**null 表示未填成本，不是 0** | `cost_price` |
| safety_stock | integer | N | 默认 0，`CHECK >= 0` | `safety_stock` |
| barcode | text | Y | `UNIQUE (owner_id, barcode) WHERE barcode IS NOT NULL` | `barcode` |
| status | text | N | 默认 `'on_sale'`，`CHECK IN ('on_sale','off_sale')` | `status` |
| created_at | timestamptz | N | 默认 now() | `created_at` |

索引：`(owner_id, status, category_id)`、`(owner_id, name)`。
标签不落数组，走 `product_tags`。

### 3.2 categories（分类）

| 列 | 类型 | 空 | 约束 | 旧 key |
|---|---|---|---|---|
| id | bigint | N | PK | `id` |
| name | text | N | ≤12 字（沿用规则） | `name` |
| parent_id | bigint | Y | FK → categories(owner_id,id) ON DELETE RESTRICT；`CHECK (parent_id IS NULL OR parent_id <> id)` | `parent_id` |
| sort | integer | N | 默认 0 | `sort` |
| created_at | timestamptz | N | | `created_at` |

约束：`UNIQUE NULLS NOT DISTINCT (owner_id, parent_id, name)`（同级同名禁止，NULL 父级也生效）。
层级 ≤ 2 由服务端函数校验（与 `upsertCategory` 现有口径一致）。
索引：`(owner_id, parent_id, sort)`。

### 3.3 tags / product_tags

`tags`：`name text NOT NULL`，`PK (owner_id, name)`，`created_at`。
`product_tags`：`product_id bigint`、`tag_name text`，`PK (owner_id, product_id, tag_name)`，FK → products、tags，`ON DELETE CASCADE`。
索引：`(owner_id, tag_name)`（按标签筛商品）。

### 3.4 combos（套餐）

| 列 | 类型 | 约束 | 旧 key |
|---|---|---|---|
| id | bigint | PK | `id` |
| combo_code | text | `UNIQUE (owner_id, combo_code)` | `combo_code` |
| name | text | NOT NULL | `name` |
| combo_price | numeric(12,2) | `>= 0` | `combo_price` |
| original_price | numeric(12,2) | Y，`>= 0` | `original_price` |
| status | text | `CHECK IN ('on_sale','off_sale')` | `status` |
| created_at | timestamptz | | 迁移时补 `now()`（旧数据无此字段） |

`combo_items`（旧固定明细）：`combo_id`、`product_id`、`quantity integer CHECK > 0`、`sort`，`PK (owner_id, combo_id, product_id)`，FK combos / products，`ON DELETE CASCADE`（随套餐删）。**保留原因**：历史订单按它展开库存与销量（`expandCombo`），删了历史统计就断。

`combo_groups`：`combo_id`、`category_id`（中类）、`category_l1_id`（大类，可空）、`quantity integer CHECK > 0`、`sort`，`PK (owner_id, combo_id, category_id)`，FK combos / categories。

`combo_group_products`：`combo_id`、`category_id`、`product_id`，`PK (owner_id, combo_id, category_id, product_id)`，FK → combo_groups(owner_id,combo_id,category_id) `ON DELETE CASCADE`、products。

### 3.5 orders（订单）

| 列 | 类型 | 空 | 约束 | 旧 key |
|---|---|---|---|---|
| id | bigint | N | PK | `id` |
| order_no | text | N | `UNIQUE (owner_id, order_no)` | `order_no` |
| status | text | N | `CHECK IN ('pending','paid','cancelled')` | `status` |
| channel | text | Y | `CHECK IN ('wechat','alipay','cash')` | `channel` |
| total_amount | numeric(12,2) | N | 默认 0，`>= 0` | `total_amount` |
| paid_amount | numeric(12,2) | Y | `>= 0`；**pending 时为 NULL** | `paid_amount` |
| item_count | integer | N | 默认 0，`>= 0` | `item_count` |
| note | text | Y | 空串归一为 NULL | `note` |
| created_at | timestamptz | N | | `created_at` |
| paid_at | timestamptz | Y | | `paid_at` |
| cancelled_at | timestamptz | Y | | `cancelled_at` |
| cancel_reason | text | Y | | `cancel_reason` |
| request_id | text | Y | `UNIQUE (owner_id, request_id) WHERE request_id IS NOT NULL` | 新增（幂等键） |

行级一致性约束（把业务口径写进数据库，不改口径）：
- `CHECK (status <> 'paid' OR (paid_at IS NOT NULL AND paid_amount IS NOT NULL AND channel IS NOT NULL))`
- `CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)`
- `CHECK (status <> 'pending' OR (paid_amount IS NULL AND paid_at IS NULL))`

索引：`(owner_id, created_at DESC)`、`(owner_id, status, created_at DESC)`、`(owner_id, channel, created_at DESC)`、`(owner_id, paid_at)`（统计）、`(owner_id, order_no)`（唯一索引已含）。

### 3.6 order_items（订单明细）

| 列 | 类型 | 约束 | 旧 key |
|---|---|---|---|
| id | bigint | PK | `id` |
| order_id | bigint | FK → orders `ON DELETE RESTRICT` | `order_id` |
| line_no | integer | 行序（1 起） | 新增（按原数组顺序） |
| item_type | text | `CHECK IN ('product','combo')` | `item_type` |
| product_id | bigint | FK → products，可空 | `product_id` |
| combo_id | bigint | FK → combos，可空 | `combo_id` |
| product_name | text | NOT NULL（**名称快照**，商品改名不影响历史） | `product_name` |
| quantity | integer | `CHECK > 0` | `quantity` |
| unit_price | numeric(12,2) | `>= 0` | `unit_price` |
| line_amount | numeric(12,2) | `>= 0` | `line_amount` |
| is_gift | boolean | NOT NULL DEFAULT false | `is_gift` |

约束：
- `CHECK ((item_type='product' AND product_id IS NOT NULL AND combo_id IS NULL) OR (item_type='combo' AND combo_id IS NOT NULL AND product_id IS NULL))`
- `CHECK (is_gift = false OR line_amount = 0)`（R2：赠品金额为 0）
- `UNIQUE (owner_id, order_id, line_no)`

索引：`(owner_id, order_id)`、`(owner_id, product_id)`（销量/流水回溯）。

### 3.7 order_item_selections（套餐选品快照）

`order_item_id bigint`、`category_id bigint`、`product_id bigint`、`quantity integer CHECK > 0`。
`PK (owner_id, order_item_id, category_id, product_id)`；FK → order_items `ON DELETE CASCADE`、products、categories。
迁移后 0 行（当前无选品快照），但新单必须有，保证「套餐编辑后历史订单不变」。

### 3.8 adjustments（金额调整）

| 列 | 类型 | 约束 | 旧 key |
|---|---|---|---|
| id | bigint | PK | `id` |
| order_id | bigint | FK → orders `ON DELETE RESTRICT` | `order_id` |
| adjust_type | text | `CHECK IN ('抹零让利','满赠赠送','临时改价','多收待退','少收挂账','录入更正')` | `adjust_type` |
| amount | numeric(12,2) | `CHECK (amount <> 0)`，正负数都允许 | `amount` |
| reason | text | Y | `reason` |
| created_at | timestamptz | N | `created_at` |

索引：`(owner_id, order_id)`、`(owner_id, created_at)`。
注：`adjust_type` 用 CHECK 而不是枚举表，与前端 `ADJUST_TYPES` 保持同一份清单；将来新增原因需一次 `ALTER TABLE ... DROP/ADD CONSTRAINT`（比自由文本更能挡住脏值）。

### 3.9 movements（库存流水）

| 列 | 类型 | 约束 | 旧 key |
|---|---|---|---|
| id | bigint | PK | `id` |
| product_id | bigint | FK → products `ON DELETE RESTRICT` | `product_id` |
| movement_type | text | `CHECK IN ('in','out','adjust','reversal')` | `movement_type` |
| quantity | integer | `CHECK (quantity <> 0)`，**带符号** | `quantity` |
| balance_after | integer | Y（未盘点商品流水为 NULL，语义保留） | `balance_after` |
| ref_type | text | Y，`CHECK IN ('order','purchase','stocktake')` | `ref_type` |
| order_id | bigint | Y，FK → orders（`ref_type='order'` 时才填） | `ref_id`（当 ref_type='order'） |
| ref_no | text | Y（订单号/单据号快照） | `ref_no` |
| note | text | Y | `note` |
| created_at | timestamptz | N | `created_at` |

约束：`CHECK ((ref_type = 'order') = (order_id IS NOT NULL))` —— 用 `order_id` 承载外键，`ref_type` 只表语义，避免「ref_id 既能指向订单又能指向采购」的假外键。
索引：`(owner_id, product_id, created_at DESC)`、`(owner_id, created_at DESC)`、`(owner_id, order_id)`。

### 3.10 inventory_balances（库存余额）

| 列 | 类型 | 约束 |
|---|---|---|
| product_id | bigint | PK 组成，FK → products `ON DELETE CASCADE` |
| quantity | integer | NOT NULL（**允许负数**，负库存是现行业务口径） |
| counted_at | timestamptz | NOT NULL（首次建账时间） |

`PK (owner_id, product_id)`。
**「未盘点」= 无行；「余额为 0」= 有行且 quantity = 0**——用行存在性表达，替代 `meta.balances` 的 `undefined` vs `0`。
索引：`(owner_id, quantity)`（低库存/负库存筛选）。

### 3.11 stock_alerts（预警）

| 列 | 类型 | 约束 | 旧 key |
|---|---|---|---|
| id | bigint | PK | `id` |
| product_id | bigint | FK → products | `product_id` |
| kind | text | `CHECK IN ('low','negative')` | `kind` |
| quantity | integer | 触发时余额 | `quantity` |
| threshold | integer | 触发时安全库存快照 | `threshold` |
| status | text | `CHECK IN ('open','resolved')` | `status` |
| ref_type | text | Y | `ref_type` |
| ref_no | text | Y | `ref_no` |
| created_at | timestamptz | N | `created_at` |
| resolved_at | timestamptz | Y | `resolved_at` |
| resolve_note | text | Y | `resolve_note`（旧数据无 → NULL） |

索引：`(owner_id, status, created_at DESC)`、部分索引 `(owner_id, product_id) WHERE status='open'`。

### 3.12 payment_codes（收款码）

| 列 | 类型 | 约束 |
|---|---|---|
| channel | text | PK 组成，`CHECK IN ('wechat','alipay')` |
| storage_path | text | NOT NULL（Storage 内路径，如 `users/<uid>/payment-codes/wechat-1729...jpg`） |
| file_id | text | Y（Storage 返回的 id） |
| mime | text | Y |
| size_bytes | integer | Y，`CHECK <= 3*1024*1024`（沿用 3MB 限制） |

`PK (owner_id, channel)`。
前端取图走 `storage.createSignedUrl(path, 3600)`；**不再把 base64 存进数据库**。`paymentCodes` 里的旧 base64 若将来有值，迁移脚本会上传到 Storage 再写路径（当前 0 条，跳过）。

### 3.13 辅助表

- `client_requests`：`request_id text`、`kind text`、`result jsonb`、`created_at`，`PK (owner_id, request_id)`。用于防重复提交与超时重试。
- `id_counters`：`name text`、`next_value bigint`，`PK (owner_id, name)`。服务端分配 id（order/item/adj/mov/alert/product/combo/category 八个键），迁移时分别 seed 为 `max(id)+1`。
- `order_no_counters`：`day date`、`last_seq integer`，`PK (owner_id, day)`。订单号 = `SO` + `yyyyMMdd` + 3 位（超过 999 自动 4 位）。
- `app_meta`：`schema_version integer NOT NULL`、`updated_at`，`PK (owner_id)`。

---

## 四、类型与转换规则

### 4.1 金额 —— 用 `numeric(12,2)`（元），不用整数分

理由：
1. 实测当前 **0 条**金额超过两位小数（订单应收/实收、明细单价/行金额、商品售价/成本、调整额全部是 2 位），`numeric` 是精确十进制，不存在浮点误差；
2. 前端 UI、`rules.js`、CSV 导出、统计全部以「元」为单位且已有 `r2()` 收口，用分需要全链路 ×100/÷100，改造面大且易漏；
3. `numeric(12,2)` 上限 99 亿，足够摊位业务。

转换规则：
- 写库：`round((p_payload->>'x')::numeric, 2)`；前端提交前 `r2()`；
- 读库：JSON 里下发 number（`numeric::float8`），前端继续 `Number()` 与 `money()` 格式化；
- 服务端禁止用 `float`/`real` 做金额运算，一律 `numeric`；
- `CHECK >= 0` 打在售价、成本、应收、实收、单价、行金额上；`adjustments.amount` 允许负。

### 4.2 时间 —— `timestamptz`

JSON 里都是带偏移的 ISO 串（`...Z` 或 `+08:00`），直接 `::timestamptz` 无损。前端接口层继续收发 ISO 字符串，显示继续用本地时区格式化。
统计按**本地日历日**（`Asia/Shanghai`）：`(paid_at AT TIME ZONE 'Asia/Shanghai')::date`，与原 `dayKeyOf()`（本地日）语义一致，不会把晚间订单算到第二天。

### 4.3 布尔 / 文本 / 空值

- `is_gift`：jsonb `true/false` → `boolean NOT NULL DEFAULT false`。
- 文本 `trim()` 后为空串 → 存 `NULL`（`note`、`cancel_reason`、`reason`、`resolve_note`），避免 `''` 与 `NULL` 两种空值。
- 空值语义明确保留：`cost_price NULL`=未填成本；`paid_amount NULL`=未收款；`balance_after NULL`=当时未盘点；`barcode NULL`=无条码；`original_price NULL`=未设原价。
- 枚举一律 CHECK，不用自由文本。

---

## 五、服务端接口（v3 RPC）

全部 `SECURITY DEFINER` + `SET search_path = public, auth`，首行取 `v_uid := auth.uid()` 并判空；`REVOKE EXECUTE FROM PUBLIC, anon`，只 `GRANT EXECUTE TO authenticated`。业务表 **ENABLE RLS 且不建任何策略、不给 anon/authenticated 任何表权限**（server-only 模式，只能通过函数访问）。

### 5.1 读

| 函数 | 说明 |
|---|---|
| `load_snapshot()` | 主数据：categories / tags / products（含标签数组）/ combos（含 items/groups/group_products）/ balances / open alerts / payment_codes / meta(schema_version, counts)。**不再返回订单与流水** |
| `list_orders(p_from date, p_to date, p_status text, p_channel text, p_keyword text, p_limit int, p_offset int)` | 服务端筛选 + 分页，返回 `{ rows, total, sum_paid }`；关键词匹配 `order_no` / `note` / 明细 `product_name`（EXISTS 子查询） |
| `get_order(p_id bigint)` | 订单 + 明细（含选品）+ 调整 + 关联流水 + 轨迹时间点 |
| `list_movements(p_product_id bigint, p_limit int, p_offset int)` | 流水分页 |
| `dashboard()` | 今日/昨日/最近营业日汇总、最近 5 单、未处理预警数、近 30 天热销商品 id |
| `stats_summary(p_from date, p_to date)` | 汇总（应收/实收/件数/赠品/差额）、按日、TOP 商品、系列、渠道、差额原因 —— 全部 SQL 聚合 |
| `list_alerts(p_status text, p_limit int, p_offset int)` | 预警分页 |

### 5.2 写（每个写接口都收 `p_request_id text` 做幂等）

| 函数 | 事务内做的事 |
|---|---|
| `create_order(p_payload jsonb, p_request_id text)` | 校验停售/套餐选品/数量价格 → 分配 order/item/adj/mov/alert id → 生成 order_no（按日计数）→ 写 orders + order_items + selections + adjustments → 按商品汇总扣减 balances（`FOR UPDATE` 按 product_id 排序加锁）→ 写 movements → 触发预警 → 记 `client_requests` → 返回订单 |
| `confirm_order(p_id, p_payload, p_request_id)` | 状态机 `pending→paid`（`UPDATE ... WHERE status='pending'` 乐观锁，影响 0 行即报「已收款」）→ 调整 → 扣库存 → 流水 → 预警 |
| `cancel_order(p_id, p_reason, p_request_id)` | `pending→cancelled` 或 `paid→cancelled`（已收款必须给原因）→ 反向流水回补 → 关闭已脱离阈值的预警 |
| `stock_in(p_items jsonb, p_note, p_at, p_request_id)` | 入库 + 首次建账 + 流水 |
| `set_stock(p_product_id, p_counted, p_reason, p_at, p_request_id)` | 盘点；首次为建账（+1 条 in 流水） |
| `save_product(p_payload, p_request_id)` / `import_products(p_rows, p_request_id)` | 商品字段化写入；SKU/条码唯一由数据库兜底；批量走单次事务 |
| `toggle_product(p_id)` / `save_combo(p_payload)` / `delete_combo(p_id)` | 套餐被历史订单引用时只停售，不物理删（沿用现规则） |
| `save_category` / `move_category` / `delete_category` | 分类同名/层级/占用校验 |
| `add_tag` / `rename_tag` / `delete_tag` | 标签；改名同步 `product_tags` |
| `resolve_alert(p_id, p_note)` | 关闭预警 |
| `save_payment_code(p_channel, p_storage_path, p_mime, p_size)` | 收款码只存文件标识 |

### 5.3 幂等协议

1. 每次提交生成 `request_id = crypto.randomUUID()`，随请求提交；同一次用户操作的重试复用同一个 id。
2. 服务端先 `INSERT INTO client_requests ... ON CONFLICT (owner_id, request_id) DO NOTHING`；若已存在，**直接返回上次的 result**，不重复执行。
3. 因此网络超时重试、双击、弱网重发都不会重复建单/重复扣库存。

### 5.4 并发控制

- **id**：`id_counters` 行级锁 `UPDATE ... RETURNING`，服务端串行分配，永不撞号，也不再依赖登录时预领区间（现有 `id_ranges` 的 15031 断层问题随之消失）。
- **库存**：同一事务内 `SELECT ... FROM inventory_balances WHERE product_id = ANY(...) ORDER BY product_id FOR UPDATE`，固定加锁顺序防死锁；余额 = 余额 + 增量（允许为负，维持现状）。
- **订单状态**：`UPDATE ... WHERE status = 'pending' RETURNING` 做 CAS，重复收款第二次影响 0 行 → 明确报错「订单已收款」。

---

## 六、前端改造范围与影响面

| 文件 | 改动 | 影响 |
|---|---|---|
| `src/data/cloud.js` | 新增 v3 RPC 封装；删除 `saveState/loadState` 写路径 | 中 |
| `src/data/sync.js` | **整体重写为 `src/data/api.js`**（RPC 调用 + ISO/数值转换 + 错误文案） | 大 |
| `src/data/store.js` | 由「本地全量 + diff 上传」改为「服务端为权威 + 主数据缓存 + 分页查询」 | **大（重写 ~60%）** |
| `src/domain/rules.js` | 只保留纯校验/纯计算（`computeTotal`、套餐选品校验、分类树、预警判定），不再直接改数组 | 大 |
| `src/views/orders.js` | 列表改为服务端分页 + 筛选，滚动加载 | 中 |
| `src/views/stats.js` | 改为 `stats_summary` 一次取回 | 中 |
| `src/views/today.js` | 改为 `dashboard()` | 中 |
| `src/views/inventory.js` | 余额表 + 流水分页 | 中 |
| `src/views/register.js` | 开单走 `create_order` RPC；提交中禁用 + 复用 request_id | 中 |
| `src/views/catalog.js` | 商品/套餐/分类/标签走各自 RPC | 中 |
| `src/views/settings.js` | 显示 schema 版本、同步状态、导出（CSV 保持）；去掉 v1/v2 模式文案 | 小 |
| `src/components/pay-sheet.js` | 防重复提交（禁用 + request_id） | 小 |
| `index.html` | importmap 版本号统一升级（缓存铁律） | 小 |
| 新增 `sql/` | `0001_schema.sql`、`0002_indexes.sql`、`0003_functions.sql`、`0004_grants.sql`、`0010_migrate_from_legacy.sql`、`0020_verify.sql`、`0030_backfill_to_v1.sql` | 新增 |
| `CLOUD_SETUP.md` | 按 v3 重写（现在写的还是「单行 JSONB」，已过期） | 中 |
| `tests/` | 新增 v3 断言（纯函数 + 迁移校验脚本） | 中 |

**行为变化（要提前接受）**：
1. 开单从「先本地后同步」变成「服务端事务成功才算成功」。断网时不能开单，界面提示「未保存，请重试」。这是「交易完整性」的必然代价。
2. 订单/流水不再全量常驻内存，`store.db.orders` 变成当前页缓存；统计与汇总改由服务端算。
3. `?preview=1` 保留：仍是纯本地种子数据，不碰云（`?preview=1` 不参与 v3 写路径）。
4. `?sync=v1` **删除写入分支**（半套代码写新表会制造脏数据）；只保留只读的旧数据查看能力（可选）。

---

## 七、迁移步骤

### 阶段 0 · 冻结与备份（必做，不可跳过）

1. 请你在手机上**退出应用、停止录入**，窗口开始时间记 `T0`。
2. 云端表级备份（新表，不覆盖）：
   ```sql
   CREATE TABLE bak_20261027_orders AS SELECT * FROM orders;
   -- products / combos / categories / order_items / adjustments / movements / alerts / meta / app_state / id_ranges 同理
   ```
3. 本地 JSON 快照导出到 `backups/`（`.gitignore` 已排除，不入公开仓库），同时保留给用户下载一份。
4. 记录本方案 §1.4 的全部基线数字，作为迁移后核对依据。

### 阶段 1 · 建结构（旧表改名，新表用回正式名）

```sql
ALTER TABLE orders RENAME TO legacy_orders;   -- 8 张行表 + meta + app_state + id_ranges 全部改名
-- 然后执行 0001_schema.sql / 0002_indexes.sql / 0004_grants.sql
```
旧表**只改名不删行**，`legacy_*` 即是回滚数据源，也是「切换后追平」的比对对象。
改名会让 v2 的 4 个旧函数失效（引用旧表名），必须同时完成阶段 2，冻结窗口内一气做完。

### 阶段 2 · 建函数

`0003_functions.sql`：v3 全部 RPC + `REVOKE/GRANT`；随后 `DROP FUNCTION save_table_rows / load_app_data / save_meta / claim_id_range / save_state`，让仍在跑旧缓存的设备**报错而不是静默写坏数据**。

### 阶段 3 · 迁数（`0010_migrate_from_legacy.sql`，单事务）

按外键依赖顺序：`categories → products → tags → product_tags → combos → combo_items → combo_groups → combo_group_products → orders → order_items → order_item_selections → adjustments → movements → inventory_balances → stock_alerts → payment_codes → id_counters → order_no_counters → app_meta`。

关键映射（其余同 §3 表内「旧 key」列）：

| 目标 | 来源表达式 |
|---|---|
| `products.category_id` | `(data->>'category_id')::bigint`（实测无空） |
| `products.cost_price` | `NULLIF(data->>'cost_price','')::numeric`，NULL 保持 NULL |
| `products.created_at` | `(data->>'created_at')::timestamptz` |
| `product_tags` | `jsonb_array_elements_text(data->'tags')`，同事务补 `tags` 词库 |
| `orders.paid_amount` | `NULLIF(data->>'paid_amount','')::numeric`（pending 保留 NULL） |
| `order_items.line_no` | `row_number() over (partition by order_id order by id)`（保原顺序） |
| `order_item_selections` | 展开 `data->'combo_selections'`（当前 0 行，脚本保留逻辑） |
| `movements.order_id` | `CASE WHEN data->>'ref_type'='order' THEN (data->>'ref_id')::bigint END` |
| `inventory_balances` | `jsonb_each_text(meta.doc->'balances')`；**缺键不建行 = 未盘点** |
| `id_counters` | `GREATEST(max(id)+1, legacy_seq)`，**重置到真实最大值+1**（修掉 15031 断层） |
| `order_no_counters` | 按 `order_no` 前缀日期反算当日最大流水 |
| `payment_codes` | 旧 base64 若存在，脚本先上传 Storage 再写路径（当前 0 条） |

`meta` 不再承载业务数据，只落 `app_meta.schema_version = 3`。

### 阶段 4 · 校验（`0020_verify.sql`）

逐项与 §1.4 对比，全部相等才算迁移完成：

- 各表行数；`sum(total_amount)=1138.00`、`sum(paid_amount)=1144.00`、`sum(line_amount)=1138.00`、`sum(adjustments.amount)=6.00`、`sum(movements.quantity)=571`、`sum(balances.quantity)=571`、`sum(item_count)=76`；
- 孤儿检查：明细无订单 / 流水无商品 / 调整无订单 / 余额无商品 / 套餐组无分类 全部为 0；
- 余额一致性：每个商品 `inventory_balances.quantity` = 该商品 `sum(movements.quantity)`；
- 订单件数一致性：`item_count` = 商品行数量 + 套餐行展开件数；
- 订单号唯一、SKU 唯一、条码唯一。

### 阶段 5 · 前端切换

v3 代码合并 → GitHub Pages 预览验证（`?preview=1` 先验证纯前端逻辑，再登真实账号验证读）→ 真机开一单（冻结窗口内允许自己测试，测试完删掉或用测试订单号）→ 确认 `list_orders` / `dashboard` / `stats_summary` 返回正确。

### 阶段 6 · 追平（切换窗口的增量核对）

迁移完成到新代码上线之间，理论上还可能有旧缓存设备写入 `legacy_*`。核对：

```sql
-- 找出迁移后又被旧代码改过的行
SELECT count(*) FROM legacy_orders WHERE updated_at > :T_migrated;
```
若为 0，直接进入阶段 7；若不为 0，执行 `0011_resync_from_legacy.sql`：把这些 id 逐字段 upsert 回新表（含明细），再跑一遍阶段 4 校验。
**不允许**在没做这一步的情况下假定「新表就是全的」。

### 阶段 7 · 正式发布

桌面端「发布为应用」→ 手机端强制刷新（版本号已升级，命中新 importmap）→ 观察 30 分钟同步状态。

### 阶段 8 · 收尾

- `legacy_*` 保留 ≥ 7 天，确认无投诉后再 `DROP`（需二次确认）。
- **收回 `app_state_backup_20261025` 的 anon SELECT 权限**（§1.5 第 1 条），确认后按需删除。
- 更新 `CLOUD_SETUP.md` 为 v3 说明；`sql/` 全部入库；状态表（§九）如实填写。

### 回滚方案（考虑切换后新增数据，不是只加 `?sync=v1`）

- **代码回滚**：`git revert` + 重新发布上一版。但新表里切换后产生的订单，v2 代码看不到 → **单独回滚代码等于丢数据**，所以必须配套下面的数据回滚。
- **数据回滚（无损）**：`0030_backfill_to_v1.sql` 把 v3 全量反向生成 v1 兼容的 `doc`（products/orders/orderItems/movements/balances/…），写入 `app_state`（version+1），再恢复 `app_state` 的 RLS 策略 → 旧版界面即可读到**包含切换后新增数据**的完整账。反向生成后再 `DROP` 新表即可回到 v2 结构。
- **紧急只读**：`legacy_*` 表与 `bak_*` 表始终可查，用于人工对账。
- **不可回滚点**：一旦执行阶段 8 的 `DROP legacy_*` 且没做 v1 反向导出，就只能依赖 `bak_*` 与本地 JSON 快照。

---

## 八、验收清单

### 8.1 数据核对
- [ ] 各表行数与 §1.4 一致
- [ ] 应收 1138.00 / 实收 1144.00 / 明细金额 1138.00 / 调整 6.00 / 流水 571 / 余额 571 / 件数 76
- [ ] 孤儿引用 0；余额 = 流水累计；件数 = 明细展开
- [ ] 订单号、SKU、条码唯一性约束生效（故意插重复应被拒）

### 8.2 并发与异常
- [ ] 两设备同时开单（同一商品、余额 1）：两单都成功或一单被合理拒绝，但流水与余额始终自洽（不出现「扣两次但只记一次流水」）
- [ ] 同一订单重复收款：第二次明确报「已收款」，不产生第二条流水/调整
- [ ] 重复提交（同一 `request_id` 连发两次）：只生成 1 个订单
- [ ] 网络中断后重试：成功后仅 1 单；失败时无半截数据
- [ ] 部分失败回滚：构造一条非法明细（停售商品），整单不落库，库存不动
- [ ] 跨账号访问：账号 B 用自己 token 调 `get_order(账号A的id)` 返回空 / 报错，读不到任何 A 的数据

### 8.3 数据页面与查询
- [ ] WorkBuddy 数据管理页可直接看到订单号、商品名、数量、金额、状态、时间等真实列（附截图）
- [ ] 按订单号查询、按状态筛选、按日期区间筛选均可用
- [ ] 新增订单后：刷新可见、换设备可见，订单/明细/流水/余额四处一致

---

## 九、交付状态跟踪（实施时逐项填）

| 项 | 状态 |
|---|---|
| 设计确认 | 待你确认 |
| SQL 入库（`sql/`） | 未开始 |
| 云端建表 + 索引 + 约束 | 未开始 |
| 云端函数 + 权限 | 未开始 |
| 旧数据迁移 | 未开始 |
| 迁移校验 | 未开始 |
| 前端 v3 改造 | 未开始 |
| 追平核对 | 未开始 |
| 正式发布 | 未开始 |
| 验收通过 | 未开始 |

---

## 十、待你确认的四个决策

1. **金额类型**：采用 `numeric(12,2)`（元，精确小数），而非整数分。若你更想要「整数分」，我改，但前端所有金额展示与 CSV 都要跟着改。
2. **断网可开单**：v3 是否接受「必须联网才能开单」（事务完整性要求）？如果必须离线可开，需要额外做本地待提交队列 + 冲突合并，工作量显著增加。
3. **迁移窗口**：需要一个 10~20 分钟的停写窗口（迁移 + 校验 + 追平）。建议选在非营业时段（例如晚上收摊后）。
4. **旧表处置**：`legacy_*` 保留 7 天后删除，还是长期保留（占 11MB 里很小一部分）？
