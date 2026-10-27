/* ============================================================
   0002_indexes.sql —— v3 业务索引
   ------------------------------------------------------------
   v2 每张表只有主键一个索引，任何筛选都是全表扫。
   这里按「实际查询路径」建索引：列表按时间倒序、状态/渠道筛选、
   订单号与关键词、按商品回溯流水、低库存筛选。

   命名规则：<表>_<用途>_idx；唯一约束已在 0001 里建，这里不重复。
   ============================================================ */

/* ---------- 主数据 ---------- */
CREATE INDEX IF NOT EXISTS categories_tree_idx
  ON categories (owner_id, parent_id, sort);

CREATE INDEX IF NOT EXISTS products_status_idx
  ON products (owner_id, status, category_id);
CREATE INDEX IF NOT EXISTS products_name_idx
  ON products (owner_id, name);
CREATE INDEX IF NOT EXISTS products_series_idx
  ON products (owner_id, series);

CREATE INDEX IF NOT EXISTS product_tags_tag_idx
  ON product_tags (owner_id, tag_name);

CREATE INDEX IF NOT EXISTS combos_status_idx
  ON combos (owner_id, status);
CREATE INDEX IF NOT EXISTS combo_items_product_idx
  ON combo_items (owner_id, product_id);
CREATE INDEX IF NOT EXISTS combo_groups_category_idx
  ON combo_groups (owner_id, category_id);

/* ---------- 订单 ---------- */
CREATE INDEX IF NOT EXISTS orders_created_idx
  ON orders (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_created_idx
  ON orders (owner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_channel_created_idx
  ON orders (owner_id, channel, created_at DESC);
/* 统计按收款时间聚合 */
CREATE INDEX IF NOT EXISTS orders_paid_at_idx
  ON orders (owner_id, paid_at)
  WHERE status = 'paid';
/* 待收款：只索引 pending，量很小，找得快 */
CREATE INDEX IF NOT EXISTS orders_pending_idx
  ON orders (owner_id, created_at)
  WHERE status = 'pending';

/* 关键词搜索明细商品名（list_orders 的 EXISTS 子查询） */
CREATE INDEX IF NOT EXISTS order_items_order_idx
  ON order_items (owner_id, order_id);
CREATE INDEX IF NOT EXISTS order_items_product_idx
  ON order_items (owner_id, product_id);
CREATE INDEX IF NOT EXISTS order_items_name_trgm_idx
  ON order_items (owner_id, lower(product_name));

CREATE INDEX IF NOT EXISTS order_item_selections_product_idx
  ON order_item_selections (owner_id, product_id);

/* ---------- 金额调整 / 流水 / 库存 ---------- */
CREATE INDEX IF NOT EXISTS adjustments_order_idx
  ON adjustments (owner_id, order_id);
CREATE INDEX IF NOT EXISTS adjustments_created_idx
  ON adjustments (owner_id, created_at);

CREATE INDEX IF NOT EXISTS movements_product_created_idx
  ON movements (owner_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS movements_created_idx
  ON movements (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS movements_order_idx
  ON movements (owner_id, order_id)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_balances_qty_idx
  ON inventory_balances (owner_id, quantity);

CREATE INDEX IF NOT EXISTS stock_alerts_status_idx
  ON stock_alerts (owner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_alerts_open_idx
  ON stock_alerts (owner_id, product_id)
  WHERE status = 'open';

/* ---------- 辅助 ---------- */
CREATE INDEX IF NOT EXISTS client_requests_created_idx
  ON client_requests (owner_id, created_at DESC);
