-- 0010_migrate_from_legacy.sql
-- 单事务迁移：legacy_* (owner_id, id, data jsonb) → v3 字段化表
-- 执行方式：整体作为一个 DO 块执行，任何一步失败全部回滚。
-- 前置：bak_20261027_* 表级备份已存在；legacy_* 为改名后的 v2 原表。

DO $mig$
DECLARE
  v_owner text;
  v_n integer;
BEGIN
  /* ---------- 1. 分类（先父后子，满足自引用外键） ---------- */
  INSERT INTO categories (owner_id, id, name, parent_id, sort, created_at, updated_at)
  SELECT owner_id, id, data->>'name', NULL,
         COALESCE((data->>'sort')::int, 0),
         COALESCE((data->>'created_at')::timestamptz, updated_at), updated_at
  FROM legacy_categories WHERE data->>'parent_id' IS NULL;

  INSERT INTO categories (owner_id, id, name, parent_id, sort, created_at, updated_at)
  SELECT owner_id, id, data->>'name', (data->>'parent_id')::bigint,
         COALESCE((data->>'sort')::int, 0),
         COALESCE((data->>'created_at')::timestamptz, updated_at), updated_at
  FROM legacy_categories WHERE data->>'parent_id' IS NOT NULL;

  /* ---------- 2. 商品（series 兜底 = 分类名 / 未分类；category_name 取自新分类表） ---------- */
  INSERT INTO products (owner_id, id, sku_code, name, category_id, series, category_name, unit,
                        list_price, cost_price, safety_stock, barcode, status, created_at, updated_at)
  SELECT l.owner_id, l.id,
         l.data->>'sku_code', l.data->>'name',
         (l.data->>'category_id')::bigint,
         COALESCE(NULLIF(l.data->>'series', ''),
                  COALESCE(c.name, '未分类')),
         c.name,
         COALESCE(NULLIF(l.data->>'unit', ''), '件'),
         round(COALESCE((l.data->>'list_price')::numeric, 0), 2),
         CASE WHEN l.data->>'cost_price' IS NULL OR l.data->>'cost_price' IN ('', 'null')
              THEN NULL ELSE round((l.data->>'cost_price')::numeric, 2) END,
         GREATEST(COALESCE((l.data->>'safety_stock')::int, 0), 0),
         NULLIF(l.data->>'barcode', ''),
         COALESCE(l.data->>'status', 'on_sale'),
         COALESCE((l.data->>'created_at')::timestamptz, l.updated_at), l.updated_at
  FROM legacy_products l
  LEFT JOIN categories c ON c.owner_id = l.owner_id AND c.id = (l.data->>'category_id')::bigint;

  /* ---------- 3. 标签 + 商品标签关系 ---------- */
  INSERT INTO tags (owner_id, name)
  SELECT DISTINCT l.owner_id, btrim(t)
  FROM legacy_products l, jsonb_array_elements_text(COALESCE(l.data->'tags', '[]'::jsonb)) t
  WHERE btrim(t) <> '';

  INSERT INTO product_tags (owner_id, product_id, tag_name)
  SELECT DISTINCT l.owner_id, l.id, btrim(t)
  FROM legacy_products l, jsonb_array_elements_text(COALESCE(l.data->'tags', '[]'::jsonb)) t
  WHERE btrim(t) <> '';

  /* ---------- 4. 套餐（头 + 固定明细 + 子套餐 + 可选商品池） ---------- */
  INSERT INTO combos (owner_id, id, combo_code, name, combo_price, original_price, status, created_at, updated_at)
  SELECT owner_id, id,
         COALESCE(data->>'combo_code', 'C' || lpad(id::text, 3, '0')),
         data->>'name',
         round(COALESCE((data->>'combo_price')::numeric, 0), 2),
         CASE WHEN data->>'original_price' IS NULL OR data->>'original_price' IN ('', 'null')
              THEN NULL ELSE round((data->>'original_price')::numeric, 2) END,
         COALESCE(data->>'status', 'on_sale'),
         COALESCE((data->>'created_at')::timestamptz, updated_at), updated_at
  FROM legacy_combos;

  INSERT INTO combo_items (owner_id, combo_id, product_id, quantity, sort)
  SELECT l.owner_id, l.id, (it->>'product_id')::bigint, COALESCE((it->>'quantity')::int, 1),
         COALESCE((it->>'sort')::int, row_number() OVER (PARTITION BY l.owner_id, l.id) - 1)::int
  FROM legacy_combos l, jsonb_array_elements(COALESCE(l.data->'items', '[]'::jsonb)) it;

  INSERT INTO combo_groups (owner_id, combo_id, category_id, category_l1_id, quantity, sort)
  SELECT l.owner_id, l.id, (g->>'category_id')::bigint,
         (g->>'category_l1_id')::bigint,
         COALESCE((g->>'quantity')::int, 1),
         COALESCE((g->>'sort')::int, 0)
  FROM legacy_combos l, jsonb_array_elements(COALESCE(l.data->'groups', '[]'::jsonb)) g;

  INSERT INTO combo_group_products (owner_id, combo_id, category_id, product_id)
  SELECT l.owner_id, l.id, (g->>'category_id')::bigint, (pid)::bigint
  FROM legacy_combos l, jsonb_array_elements(COALESCE(l.data->'groups', '[]'::jsonb)) g,
       jsonb_array_elements_text(COALESCE(g->'product_ids', '[]'::jsonb)) pid;

  /* ---------- 5. 订单 ---------- */
  INSERT INTO orders (owner_id, id, order_no, status, channel, total_amount, paid_amount,
                      item_count, note, created_at, paid_at, cancelled_at, cancel_reason,
                      request_id, updated_at)
  SELECT owner_id, id, data->>'order_no', data->>'status', data->>'channel',
         round((data->>'total_amount')::numeric, 2),
         CASE WHEN data->>'paid_amount' IS NULL OR data->>'paid_amount' IN ('', 'null')
              THEN NULL ELSE round((data->>'paid_amount')::numeric, 2) END,
         COALESCE((data->>'item_count')::int, 0),
         NULLIF(data->>'note', ''),
         (data->>'created_at')::timestamptz,
         NULLIF(data->>'paid_at', '')::timestamptz,
         NULLIF(data->>'cancelled_at', '')::timestamptz,
         NULLIF(data->>'cancel_reason', ''),
         NULL, updated_at
  FROM legacy_orders;

  /* ---------- 6. 订单明细（line_no 按 id 顺序生成）+ 套餐选品 ---------- */
  INSERT INTO order_items (owner_id, id, order_id, line_no, item_type, product_id, combo_id,
                           product_name, quantity, unit_price, line_amount, is_gift,
                           created_at, updated_at)
  SELECT owner_id, id, (data->>'order_id')::bigint,
         row_number() OVER (PARTITION BY owner_id, (data->>'order_id')::bigint ORDER BY id)::int,
         data->>'item_type',
         (data->>'product_id')::bigint,
         (data->>'combo_id')::bigint,
         data->>'product_name',
         (data->>'quantity')::int,
         round((data->>'unit_price')::numeric, 2),
         round((data->>'line_amount')::numeric, 2),
         COALESCE((data->>'is_gift')::boolean, false),
         COALESCE((data->>'created_at')::timestamptz, updated_at), updated_at
  FROM legacy_order_items;

  INSERT INTO order_item_selections (owner_id, order_item_id, category_id, product_id, quantity)
  SELECT l.owner_id, l.id, (sel->>'category_id')::bigint, (p->>'product_id')::bigint, (p->>'quantity')::int
  FROM legacy_order_items l, jsonb_array_elements(COALESCE(l.data->'combo_selections', '[]'::jsonb)) sel,
       jsonb_array_elements(COALESCE(sel->'items', '[]'::jsonb)) p;

  /* ---------- 7. 金额调整 ---------- */
  INSERT INTO adjustments (owner_id, id, order_id, adjust_type, amount, reason, created_at, updated_at)
  SELECT owner_id, id, (data->>'order_id')::bigint, data->>'adjust_type',
         round((data->>'amount')::numeric, 2), NULLIF(data->>'reason', ''),
         COALESCE((data->>'created_at')::timestamptz, updated_at), updated_at
  FROM legacy_adjustments;

  /* ---------- 8. 库存流水 ---------- */
  INSERT INTO movements (owner_id, id, product_id, movement_type, quantity, balance_after,
                         ref_type, order_id, ref_no, note, created_at, updated_at)
  SELECT owner_id, id, (data->>'product_id')::bigint, data->>'movement_type',
         (data->>'quantity')::int,
         CASE WHEN data->>'balance_after' IS NULL OR data->>'balance_after' = 'null'
              THEN NULL ELSE (data->>'balance_after')::int END,
         data->>'ref_type',
         NULLIF(data->>'ref_id', '')::bigint,
         NULLIF(data->>'ref_no', ''),
         NULLIF(data->>'note', ''),
         COALESCE((data->>'created_at')::timestamptz, updated_at), updated_at
  FROM legacy_movements;

  /* ---------- 9. 库存预警 ---------- */
  INSERT INTO stock_alerts (owner_id, id, product_id, kind, quantity, threshold, status,
                            ref_type, ref_no, created_at, resolved_at, resolve_note, updated_at)
  SELECT owner_id, id, (data->>'product_id')::bigint, data->>'kind',
         (data->>'quantity')::int, COALESCE((data->>'threshold')::int, 0), data->>'status',
         NULLIF(data->>'ref_type', ''), NULLIF(data->>'ref_no', ''),
         (data->>'created_at')::timestamptz,
         NULLIF(data->>'resolved_at', '')::timestamptz,
         NULLIF(data->>'resolve_note', ''), updated_at
  FROM legacy_alerts;

  /* ---------- 10. 库存余额（meta.balances → 独立表；counted_at 取 meta 写入时间） ---------- */
  INSERT INTO inventory_balances (owner_id, product_id, quantity, counted_at, updated_at)
  SELECT m.owner_id, (bal.key)::bigint, (bal.value)::int, m.updated_at, m.updated_at
  FROM legacy_meta m, jsonb_each_text(m.doc->'balances') bal
  WHERE bal.value ~ '^-?[0-9]+$';

  /* ---------- 11. id 计数器：各键 next = max(id)+1 ---------- */
  INSERT INTO id_counters (owner_id, name, next_value)
  SELECT o.owner_id, k.name, GREATEST(COALESCE(k.mx, 0) + 1, 1)
  FROM (SELECT DISTINCT owner_id FROM legacy_orders
        UNION SELECT DISTINCT owner_id FROM legacy_products
        UNION SELECT DISTINCT owner_id FROM legacy_meta) o
  CROSS JOIN (VALUES
    ('order',    (SELECT max(id) FROM legacy_orders)),
    ('item',     (SELECT max(id) FROM legacy_order_items)),
    ('adj',      (SELECT max(id) FROM legacy_adjustments)),
    ('mov',      (SELECT max(id) FROM legacy_movements)),
    ('alert',    (SELECT max(id) FROM legacy_alerts)),
    ('product',  (SELECT max(id) FROM legacy_products)),
    ('combo',    (SELECT max(id) FROM legacy_combos)),
    ('category', (SELECT max(id) FROM legacy_categories))
  ) AS k(name, mx);

  /* ---------- 12. 订单号日计数器（SO + YYYYMMDD + 3 位序号） ---------- */
  INSERT INTO order_no_counters (owner_id, day, last_seq)
  SELECT owner_id,
         substring(order_no from 3 for 8)::date AS day,
         max(substring(order_no from 11)::int) AS last_seq
  FROM (
    SELECT owner_id, data->>'order_no' AS order_no FROM legacy_orders
  ) t
  WHERE order_no ~ '^SO[0-9]{8}[0-9]{3,}$'
  GROUP BY owner_id, 2;

  /* ---------- 13. app_meta（schema_version = 3） ---------- */
  INSERT INTO app_meta (owner_id, schema_version)
  SELECT DISTINCT owner_id, 3 FROM legacy_meta
  ON CONFLICT (owner_id) DO UPDATE SET schema_version = 3, updated_at = now();

  /* ---------- 14. 迁移量回执 ---------- */
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'migration finished, last statement rows=%', v_n;
END;
$mig$;
