/* ============================================================
   0003_functions.sql —— v3 服务端接口
   ------------------------------------------------------------
   全部 SECURITY DEFINER + SET search_path，首行取 auth.uid() 并判空。
   业务表对客户端零授权，只能经这些函数读写；owner_id 全部由函数注入，
   所有查询都带 owner_id = auth.uid()，跨账号读写不可能成立。

   返回结构刻意保持 v2 前端的 JSON 形状（orders/orderItems/... 字段名不变），
   前端视图不用重写字段名，只换数据来源。

   函数分三类
   - 内部 helper（v3_ 前缀，不给客户端 EXECUTE 权限，只被下面函数调用）
   - 读：load_snapshot / dashboard / list_orders / get_order / list_movements
         / stats_summary / export_dataset
   - 写：create_order / order_action / stock_action / save_product
         / import_products / save_combo / delete_combo / save_category
         / delete_category / save_tag / resolve_alert / save_payment_code
   ============================================================ */

/* ============================================================
   内部 helper（SECURITY INVOKER：在被 SECURITY DEFINER 函数调用时
   以属主身份执行；客户端直接调用会因无表权限而失败）
   ============================================================ */

CREATE OR REPLACE FUNCTION public.v3_next_id(p_owner text, p_name text)
RETURNS bigint
LANGUAGE sql
AS $fn$
  INSERT INTO id_counters (owner_id, name, next_value)
  VALUES (p_owner, p_name, 2)
  ON CONFLICT (owner_id, name)
    DO UPDATE SET next_value = id_counters.next_value + 1, updated_at = now()
  RETURNING next_value - 1;
$fn$;
REVOKE ALL ON FUNCTION public.v3_next_id(text, text) FROM PUBLIC;

/* 订单号：SO + 本地日期 yyyyMMdd + 当日 3 位流水（超过 999 自动加位） */
CREATE OR REPLACE FUNCTION public.v3_next_order_no(p_owner text, p_at timestamptz)
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_day date := (p_at AT TIME ZONE 'Asia/Shanghai')::date;
  v_seq integer;
BEGIN
  INSERT INTO order_no_counters (owner_id, day, last_seq) VALUES (p_owner, v_day, 1)
  ON CONFLICT (owner_id, day)
    DO UPDATE SET last_seq = order_no_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;
  RETURN 'SO' || to_char(v_day, 'YYYYMMDD') || lpad(v_seq::text, 3, '0');
END;
$fn$;
REVOKE ALL ON FUNCTION public.v3_next_order_no(text, timestamptz) FROM PUBLIC;

/* 一天的战报（今日 / 昨日 / 最近营业日共用） */
CREATE OR REPLACE FUNCTION public.v3_day_summary(p_owner text, p_day date)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $fn$
  SELECT jsonb_build_object(
    'date', to_char(p_day, 'YYYY-MM-DD'),
    'revenue', COALESCE(round(sum(o.paid_amount), 2), 0),
    'count', count(o.id),
    'pieces', COALESCE(sum(o.item_count), 0),
    'avg', CASE WHEN count(o.id) > 0 THEN round(sum(o.paid_amount) / count(o.id), 2) ELSE 0 END,
    'channels', COALESCE((
      SELECT jsonb_object_agg(c.channel, c.amt)
      FROM (
        SELECT o2.channel, round(sum(o2.paid_amount), 2) AS amt
        FROM orders o2
        WHERE o2.owner_id = p_owner AND o2.status = 'paid' AND o2.paid_at IS NOT NULL
          AND (o2.paid_at AT TIME ZONE 'Asia/Shanghai')::date = p_day
        GROUP BY o2.channel
      ) c
    ), '{}'::jsonb),
    'cancelled', (
      SELECT count(*) FROM orders o3
      WHERE o3.owner_id = p_owner AND o3.status = 'cancelled' AND o3.cancelled_at IS NOT NULL
        AND (o3.cancelled_at AT TIME ZONE 'Asia/Shanghai')::date = p_day
    )
  )
  FROM orders o
  WHERE o.owner_id = p_owner AND o.status = 'paid' AND o.paid_at IS NOT NULL
    AND (o.paid_at AT TIME ZONE 'Asia/Shanghai')::date = p_day;
$fn$;
REVOKE ALL ON FUNCTION public.v3_day_summary(text, date) FROM PUBLIC;

/* 一张订单要出库的商品汇总，套餐按选品快照 / 固定明细展开 */
CREATE OR REPLACE FUNCTION public.v3_order_impact(p_owner text, p_order_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $fn$
  SELECT COALESCE(jsonb_object_agg(t.product_id::text, t.qty), '{}'::jsonb)
  FROM (
    SELECT oi.product_id AS product_id, sum(oi.quantity)::int AS qty
    FROM order_items oi
    WHERE oi.owner_id = p_owner AND oi.order_id = p_order_id AND oi.item_type = 'product'
    GROUP BY oi.product_id
    UNION ALL
    SELECT s.product_id, sum(s.quantity * oi.quantity)::int
    FROM order_items oi
    JOIN order_item_selections s
      ON s.owner_id = oi.owner_id AND s.order_item_id = oi.id
    WHERE oi.owner_id = p_owner AND oi.order_id = p_order_id AND oi.item_type = 'combo'
    GROUP BY s.product_id
    UNION ALL
    /* 旧套餐没有选品快照，按固定明细展开（且该套餐没有选品行时才走这支） */
    SELECT ci.product_id, sum(ci.quantity * oi.quantity)::int
    FROM order_items oi
    JOIN combo_items ci ON ci.owner_id = oi.owner_id AND ci.combo_id = oi.combo_id
    WHERE oi.owner_id = p_owner AND oi.order_id = p_order_id AND oi.item_type = 'combo'
      AND NOT EXISTS (
        SELECT 1 FROM order_item_selections s2
        WHERE s2.owner_id = oi.owner_id AND s2.order_item_id = oi.id
      )
    GROUP BY ci.product_id
  ) t;
$fn$;
REVOKE ALL ON FUNCTION public.v3_order_impact(text, bigint) FROM PUBLIC;

/* 商品字段化写入（供 save_product / import_products 复用） */
CREATE OR REPLACE FUNCTION public.v3_upsert_product(p_owner text, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_id       bigint := NULLIF(p_payload->>'id', '')::bigint;
  v_name     text := btrim(COALESCE(p_payload->>'name', ''));
  v_sku      text := btrim(COALESCE(p_payload->>'sku_code', ''));
  v_cat      bigint := NULLIF(p_payload->>'category_id', '')::bigint;
  v_series   text;
  v_cat_name text;
  v_barcode  text := NULLIF(btrim(COALESCE(p_payload->>'barcode', '')), '');
  v_tags     text[] := ARRAY[]::text[];
  v_tag      text;
  v_out      jsonb;
  v_prev     products%ROWTYPE;
BEGIN
  IF v_name = '' THEN RAISE EXCEPTION '请填写商品名称' USING ERRCODE = 'P0001'; END IF;
  IF char_length(v_name) > 60 THEN RAISE EXCEPTION '商品名称请控制在 60 个字以内' USING ERRCODE = 'P0001'; END IF;
  IF v_cat IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM categories WHERE owner_id = p_owner AND id = v_cat
  ) THEN RAISE EXCEPTION '分类不存在' USING ERRCODE = 'P0001'; END IF;
  IF v_barcode IS NOT NULL AND char_length(v_barcode) > 128 THEN
    RAISE EXCEPTION '条码请控制在 128 个字符以内' USING ERRCODE = 'P0001';
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_prev FROM products WHERE owner_id = p_owner AND id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION '商品不存在' USING ERRCODE = 'P0001'; END IF;
  END IF;

  /* 分类路径快照：换分类才刷新，只改价格时保留原系列 */
  IF v_cat IS NOT NULL THEN
    SELECT c.name INTO v_cat_name FROM categories c WHERE c.owner_id = p_owner AND c.id = v_cat;
    IF v_id IS NOT NULL AND v_prev.category_id IS NOT DISTINCT FROM v_cat AND COALESCE(v_prev.series, '') <> '' THEN
      v_series := v_prev.series;
    ELSE
      v_series := v_cat_name;
    END IF;
  ELSE
    v_cat_name := NULLIF(btrim(COALESCE(p_payload->>'category', '')), '');
    v_series := COALESCE(NULLIF(btrim(COALESCE(p_payload->>'series', '')), ''), '未分类');
  END IF;

  IF v_id IS NULL THEN
    IF v_sku = '' THEN RAISE EXCEPTION '请填写 SKU 编码' USING ERRCODE = 'P0001'; END IF;
    IF EXISTS (SELECT 1 FROM products WHERE owner_id = p_owner AND sku_code = v_sku) THEN
      RAISE EXCEPTION 'SKU 编码「%」已存在', v_sku USING ERRCODE = 'P0001';
    END IF;
    v_id := v3_next_id(p_owner, 'product');
    INSERT INTO products (owner_id, id, sku_code, name, category_id, series, category_name, unit,
                          list_price, cost_price, safety_stock, barcode, status, created_at, updated_at)
    VALUES (p_owner, v_id, v_sku, v_name, v_cat, v_series, v_cat_name,
            COALESCE(NULLIF(btrim(COALESCE(p_payload->>'unit', '')), ''), '件'),
            round(COALESCE((p_payload->>'list_price')::numeric, 0), 2),
            CASE WHEN p_payload->>'cost_price' IS NULL OR btrim(p_payload->>'cost_price') IN ('', 'null')
                 THEN NULL ELSE round((p_payload->>'cost_price')::numeric, 2) END,
            GREATEST(COALESCE((p_payload->>'safety_stock')::int, 0), 0),
            v_barcode,
            CASE WHEN p_payload->>'status' = 'off_sale' THEN 'off_sale' ELSE 'on_sale' END,
            now(), now());
  ELSE
    IF EXISTS (SELECT 1 FROM products WHERE owner_id = p_owner AND sku_code = v_sku AND id <> v_id) THEN
      RAISE EXCEPTION 'SKU 编码「%」已存在', v_sku USING ERRCODE = 'P0001';
    END IF;
    UPDATE products SET
      sku_code = COALESCE(NULLIF(v_sku, ''), sku_code), name = v_name, category_id = v_cat, series = v_series,
      category_name = v_cat_name,
      unit = COALESCE(NULLIF(btrim(COALESCE(p_payload->>'unit', '')), ''), unit),
      list_price = round(COALESCE((p_payload->>'list_price')::numeric, list_price), 2),
      cost_price = CASE WHEN p_payload->>'cost_price' IS NULL OR btrim(p_payload->>'cost_price') IN ('', 'null')
                        THEN NULL ELSE round((p_payload->>'cost_price')::numeric, 2) END,
      safety_stock = GREATEST(COALESCE((p_payload->>'safety_stock')::int, safety_stock), 0),
      barcode = COALESCE(v_barcode, barcode),
      status = CASE WHEN p_payload->>'status' = 'off_sale' THEN 'off_sale'
                    WHEN p_payload->>'status' = 'on_sale' THEN 'on_sale' ELSE status END,
      updated_at = now()
    WHERE owner_id = p_owner AND id = v_id;
  END IF;

  /* 标签：先补词库，再重建关系（最多 8 个，单个 ≤10 字） */
  IF jsonb_typeof(p_payload->'tags') = 'array' THEN
    FOR v_tag IN SELECT DISTINCT btrim(t) FROM jsonb_array_elements_text(p_payload->'tags') t
                 WHERE btrim(t) <> '' LIMIT 8 LOOP
      IF char_length(v_tag) > 10 THEN
        RAISE EXCEPTION '标签「%」太长，控制在 10 个字以内', v_tag USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO tags (owner_id, name) VALUES (p_owner, v_tag) ON CONFLICT DO NOTHING;
      v_tags := v_tags || v_tag;
    END LOOP;
    DELETE FROM product_tags WHERE owner_id = p_owner AND product_id = v_id;
    IF array_length(v_tags, 1) > 0 THEN
      INSERT INTO product_tags (owner_id, product_id, tag_name)
      SELECT p_owner, v_id, unnest(v_tags);
    END IF;
  END IF;

  SELECT to_jsonb(p) - 'updated_at' || jsonb_build_object('tags', COALESCE((
      SELECT jsonb_agg(pt.tag_name ORDER BY pt.tag_name)
      FROM product_tags pt WHERE pt.owner_id = p_owner AND pt.product_id = v_id
    ), '[]'::jsonb)) INTO v_out
  FROM products p WHERE p.owner_id = p_owner AND p.id = v_id;
  RETURN v_out;
END;
$fn$;
REVOKE ALL ON FUNCTION public.v3_upsert_product(text, jsonb) FROM PUBLIC;

/* 按阈值与余额补建预警（同一商品只保留一条未处理） */
CREATE OR REPLACE FUNCTION public.v3_raise_alert(p_owner text, p_product_id bigint, p_balance integer,
                                                p_ref_type text, p_ref_no text, p_at timestamptz)
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_th  integer;
  v_aid bigint;
BEGIN
  IF p_balance IS NULL THEN RETURN NULL; END IF;
  SELECT safety_stock INTO v_th FROM products WHERE owner_id = p_owner AND id = p_product_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_balance >= 0 AND (v_th <= 0 OR p_balance > v_th) THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM stock_alerts WHERE owner_id = p_owner AND product_id = p_product_id AND status = 'open') THEN
    RETURN NULL;
  END IF;
  v_aid := v3_next_id(p_owner, 'alert');
  INSERT INTO stock_alerts (owner_id, id, product_id, kind, quantity, threshold, status, ref_type, ref_no, created_at)
  VALUES (p_owner, v_aid, p_product_id, CASE WHEN p_balance < 0 THEN 'negative' ELSE 'low' END,
          p_balance, v_th, 'open', p_ref_type, p_ref_no, COALESCE(p_at, now()));
  RETURN v_aid;
END;
$fn$;
REVOKE ALL ON FUNCTION public.v3_raise_alert(text, bigint, integer, text, text, timestamptz) FROM PUBLIC;

/* ============================================================
   读接口
   ============================================================ */

/* 登录后主数据快照：不再包含订单与全量流水 */
CREATE OR REPLACE FUNCTION public.load_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);

  RETURN jsonb_build_object(
    'schema', 3,
    'meta', jsonb_build_object('schema_version', 3),
    'categories', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) - 'updated_at' ORDER BY c.parent_id NULLS FIRST, c.sort, c.id)
      FROM categories c WHERE c.owner_id = v_uid), '[]'::jsonb),
    'products', COALESCE((
      SELECT jsonb_agg(to_jsonb(p) - 'updated_at' - 'category_name'
        || jsonb_build_object('category', COALESCE(p.category_name, ''),
                              'tags', COALESCE((
                                SELECT jsonb_agg(pt.tag_name ORDER BY pt.tag_name)
                                FROM product_tags pt
                                WHERE pt.owner_id = v_uid AND pt.product_id = p.id), '[]'::jsonb))
        ORDER BY p.id)
      FROM products p WHERE p.owner_id = v_uid), '[]'::jsonb),
    'tags', COALESCE((SELECT jsonb_agg(t.name ORDER BY t.name) FROM tags t WHERE t.owner_id = v_uid), '[]'::jsonb),
    'combos', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) - 'updated_at'
        || jsonb_build_object(
             'items', COALESCE((
               SELECT jsonb_agg(jsonb_build_object('product_id', ci.product_id, 'quantity', ci.quantity)
                                ORDER BY ci.sort, ci.product_id)
               FROM combo_items ci WHERE ci.owner_id = v_uid AND ci.combo_id = c.id), '[]'::jsonb),
             'groups', COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'category_id', g.category_id,
                        'category_l1_id', g.category_l1_id,
                        'quantity', g.quantity,
                        'product_ids', COALESCE((
                          SELECT jsonb_agg(gp.product_id ORDER BY gp.product_id)
                          FROM combo_group_products gp
                          WHERE gp.owner_id = v_uid AND gp.combo_id = g.combo_id AND gp.category_id = g.category_id), '[]'::jsonb))
                      ORDER BY g.sort, g.category_id)
               FROM combo_groups g WHERE g.owner_id = v_uid AND g.combo_id = c.id), '[]'::jsonb))
        ORDER BY c.id)
      FROM combos c WHERE c.owner_id = v_uid), '[]'::jsonb),
    'balances', COALESCE((
      SELECT jsonb_object_agg(b.product_id::text, b.quantity)
      FROM inventory_balances b WHERE b.owner_id = v_uid), '{}'::jsonb),
    'alerts', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.created_at DESC, a.id DESC)
      FROM stock_alerts a WHERE a.owner_id = v_uid), '[]'::jsonb),
    /* 库存页展开时看的「最近变动」：每商品最近 12 条，一次取回，避免逐商品请求 */
    'movements', COALESCE((
      SELECT jsonb_agg(x.row ORDER BY x.created_at DESC, x.id DESC)
      FROM (
        SELECT to_jsonb(m) - 'updated_at' - 'order_id' - 'rn'
               || jsonb_build_object('ref_id', m.order_id) AS row, m.created_at, m.id
        FROM (
          SELECT m2.*, row_number() OVER (PARTITION BY m2.product_id ORDER BY m2.created_at DESC, m2.id DESC) AS rn
          FROM movements m2 WHERE m2.owner_id = v_uid
        ) m WHERE m.rn <= 12
      ) x), '[]'::jsonb),
    'paymentCodes', COALESCE((
      SELECT jsonb_object_agg(pc.channel, pc.storage_path)
      FROM payment_codes pc WHERE pc.owner_id = v_uid), '{}'::jsonb),
    'counts', jsonb_build_object(
      'products', (SELECT count(*) FROM products WHERE owner_id = v_uid),
      'counted', (SELECT count(*) FROM inventory_balances WHERE owner_id = v_uid),
      'orders', (SELECT count(*) FROM orders WHERE owner_id = v_uid),
      'paid', (SELECT count(*) FROM orders WHERE owner_id = v_uid AND status = 'paid'),
      'pending', (SELECT count(*) FROM orders WHERE owner_id = v_uid AND status = 'pending'),
      'cancelled', (SELECT count(*) FROM orders WHERE owner_id = v_uid AND status = 'cancelled'),
      'movements', (SELECT count(*) FROM movements WHERE owner_id = v_uid),
      'alerts', (SELECT count(*) FROM stock_alerts WHERE owner_id = v_uid AND status = 'open'),
      'firstDate', (SELECT to_char(min(created_at) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')
                    FROM orders WHERE owner_id = v_uid)
    )
  );
END;
$fn$;

/* 今日看板：今日/昨日/最近营业日 + 近 30 天 + 待收款 + 最近 6 单 + 常卖商品 */
CREATE OR REPLACE FUNCTION public.dashboard()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid   text := auth.uid();
  v_today date;
  v_last  date;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);
  v_today := (now() AT TIME ZONE 'Asia/Shanghai')::date;

  SELECT max((paid_at AT TIME ZONE 'Asia/Shanghai')::date) INTO v_last
  FROM orders
  WHERE owner_id = v_uid AND status = 'paid' AND paid_at IS NOT NULL
    AND (paid_at AT TIME ZONE 'Asia/Shanghai')::date < v_today;

  RETURN jsonb_build_object(
    'today', v3_day_summary(v_uid, v_today),
    'yesterday', v3_day_summary(v_uid, v_today - 1),
    'lastDay', CASE WHEN v_last IS NULL THEN NULL ELSE v3_day_summary(v_uid, v_last) END,
    'days', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'),
                                          'revenue', d.revenue, 'count', d.count)
                       ORDER BY d.day)
      FROM (
        SELECT gs::date AS day,
               COALESCE(round(sum(o.paid_amount), 2), 0) AS revenue,
               count(o.id) AS count
        FROM generate_series(v_today - 29, v_today, interval '1 day') gs
        LEFT JOIN orders o
          ON o.owner_id = v_uid AND o.status = 'paid' AND o.paid_at IS NOT NULL
         AND (o.paid_at AT TIME ZONE 'Asia/Shanghai')::date = gs::date
        GROUP BY gs
      ) d), '[]'::jsonb),
    'pending', COALESCE((
      SELECT jsonb_agg(to_jsonb(o) - 'updated_at' - 'request_id' ORDER BY o.created_at)
      FROM orders o WHERE o.owner_id = v_uid AND o.status = 'pending'), '[]'::jsonb),
    'recent', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'order', to_jsonb(o) - 'updated_at' - 'request_id',
               'items', COALESCE((
                 SELECT jsonb_agg(to_jsonb(i) - 'updated_at' ORDER BY i.line_no)
                 FROM order_items i WHERE i.owner_id = v_uid AND i.order_id = o.id), '[]'::jsonb))
             ORDER BY o.created_at DESC)
      FROM (
        SELECT * FROM orders WHERE owner_id = v_uid ORDER BY created_at DESC, id DESC LIMIT 6
      ) o), '[]'::jsonb),
    /* 近 30 天卖得最多的商品（开单页置顶），套餐按快照/明细展开 */
    'frequent', COALESCE((
      SELECT jsonb_agg(z.product_id ORDER BY z.qty DESC, z.product_id)
      FROM (
        SELECT t.product_id, sum(t.qty) AS qty
        FROM (
          SELECT oi.product_id, sum(oi.quantity) AS qty
          FROM orders o
          JOIN order_items oi ON oi.owner_id = o.owner_id AND oi.order_id = o.id
          WHERE o.owner_id = v_uid AND o.status = 'paid' AND o.paid_at IS NOT NULL
            AND o.paid_at >= now() - interval '30 days' AND oi.item_type = 'product'
          GROUP BY oi.product_id
          UNION ALL
          SELECT s.product_id, sum(s.quantity * oi.quantity) AS qty
          FROM orders o
          JOIN order_items oi ON oi.owner_id = o.owner_id AND oi.order_id = o.id
          JOIN order_item_selections s ON s.owner_id = oi.owner_id AND s.order_item_id = oi.id
          WHERE o.owner_id = v_uid AND o.status = 'paid' AND o.paid_at IS NOT NULL
            AND o.paid_at >= now() - interval '30 days'
          GROUP BY s.product_id
          UNION ALL
          SELECT ci.product_id, sum(ci.quantity * oi.quantity) AS qty
          FROM orders o
          JOIN order_items oi ON oi.owner_id = o.owner_id AND oi.order_id = o.id
          JOIN combo_items ci ON ci.owner_id = oi.owner_id AND ci.combo_id = oi.combo_id
          WHERE o.owner_id = v_uid AND o.status = 'paid' AND o.paid_at IS NOT NULL
            AND o.paid_at >= now() - interval '30 days' AND oi.item_type = 'combo'
            AND NOT EXISTS (SELECT 1 FROM order_item_selections s2
                            WHERE s2.owner_id = oi.owner_id AND s2.order_item_id = oi.id)
          GROUP BY ci.product_id
        ) t
        GROUP BY t.product_id
      ) z), '[]'::jsonb)
  );
END;
$fn$;

/* 订单列表：服务端筛选 + 分页；返回本页订单及其明细 */
CREATE OR REPLACE FUNCTION public.list_orders(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_channel text DEFAULT NULL,
  p_keyword text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_kw  text := NULLIF(btrim(COALESCE(p_keyword, '')), '');
  v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_off integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_rows jsonb;
  v_total bigint;
  v_paid numeric(12,2);
  v_pending bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);

  WITH f AS (
    SELECT o.*
    FROM orders o
    WHERE o.owner_id = v_uid
      AND (p_from IS NULL OR (o.created_at AT TIME ZONE 'Asia/Shanghai')::date >= p_from)
      AND (p_to IS NULL OR (o.created_at AT TIME ZONE 'Asia/Shanghai')::date <= p_to)
      AND (p_status IS NULL OR p_status = '' OR p_status = 'all' OR o.status = p_status)
      AND (p_channel IS NULL OR p_channel = '' OR p_channel = 'all' OR o.channel = p_channel)
      AND (v_kw IS NULL
           OR o.order_no ILIKE '%' || v_kw || '%'
           OR COALESCE(o.note, '') ILIKE '%' || v_kw || '%'
           OR EXISTS (SELECT 1 FROM order_items i
                      WHERE i.owner_id = v_uid AND i.order_id = o.id
                        AND i.product_name ILIKE '%' || v_kw || '%'))
  )
  SELECT count(*), COALESCE(sum(CASE WHEN status = 'paid' THEN paid_amount ELSE 0 END), 0),
         count(*) FILTER (WHERE status = 'pending')
  INTO v_total, v_paid, v_pending
  FROM f;

  WITH f AS (
    SELECT o.*
    FROM orders o
    WHERE o.owner_id = v_uid
      AND (p_from IS NULL OR (o.created_at AT TIME ZONE 'Asia/Shanghai')::date >= p_from)
      AND (p_to IS NULL OR (o.created_at AT TIME ZONE 'Asia/Shanghai')::date <= p_to)
      AND (p_status IS NULL OR p_status = '' OR p_status = 'all' OR o.status = p_status)
      AND (p_channel IS NULL OR p_channel = '' OR p_channel = 'all' OR o.channel = p_channel)
      AND (v_kw IS NULL
           OR o.order_no ILIKE '%' || v_kw || '%'
           OR COALESCE(o.note, '') ILIKE '%' || v_kw || '%'
           OR EXISTS (SELECT 1 FROM order_items i
                      WHERE i.owner_id = v_uid AND i.order_id = o.id
                        AND i.product_name ILIKE '%' || v_kw || '%'))
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order', to_jsonb(o) - 'updated_at' - 'request_id',
           'items', COALESCE((
             SELECT jsonb_agg(to_jsonb(i) - 'updated_at' ORDER BY i.line_no)
             FROM order_items i WHERE i.owner_id = v_uid AND i.order_id = o.id), '[]'::jsonb))
         ORDER BY o.created_at DESC, o.id DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT * FROM f ORDER BY created_at DESC, id DESC LIMIT v_lim OFFSET v_off
  ) o;

  RETURN jsonb_build_object('rows', v_rows, 'total', v_total,
                            'sumPaid', v_paid, 'pendingTotal', v_pending,
                            'limit', v_lim, 'offset', v_off);
END;
$fn$;

/* 单张订单详情：明细 + 选品快照 + 调整 + 关联流水 */
CREATE OR REPLACE FUNCTION public.get_order(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_order jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);

  SELECT to_jsonb(o) - 'updated_at' - 'request_id' INTO v_order
  FROM orders o WHERE o.owner_id = v_uid AND o.id = p_id;
  IF v_order IS NULL THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'order', v_order,
    'items', COALESCE((
      SELECT jsonb_agg(to_jsonb(i) - 'updated_at'
               || jsonb_build_object('combo_selections', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                             'category_id', g.category_id,
                             'items', g.items) ORDER BY g.category_id)
                    FROM (
                      SELECT s.category_id,
                             jsonb_agg(jsonb_build_object('product_id', s.product_id, 'quantity', s.quantity)
                                       ORDER BY s.product_id) AS items
                      FROM order_item_selections s
                      WHERE s.owner_id = v_uid AND s.order_item_id = i.id
                      GROUP BY s.category_id
                    ) g), '[]'::jsonb))
               ORDER BY i.line_no)
      FROM order_items i WHERE i.owner_id = v_uid AND i.order_id = p_id), '[]'::jsonb),
    'adjustments', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id)
      FROM adjustments a WHERE a.owner_id = v_uid AND a.order_id = p_id), '[]'::jsonb),
    'movements', COALESCE((
      SELECT jsonb_agg(to_jsonb(m) - 'updated_at' - 'order_id'
               || jsonb_build_object('ref_id', m.order_id) ORDER BY m.created_at, m.id)
      FROM movements m WHERE m.owner_id = v_uid AND m.order_id = p_id), '[]'::jsonb)
  );
END;
$fn$;

/* 流水：可按商品过滤，全表分页 */
CREATE OR REPLACE FUNCTION public.list_movements(
  p_product_id bigint DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_lim integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_off integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_rows jsonb;
  v_total bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);

  SELECT count(*) INTO v_total FROM movements m
  WHERE m.owner_id = v_uid AND (p_product_id IS NULL OR m.product_id = p_product_id);

  SELECT COALESCE(jsonb_agg(to_jsonb(m) - 'updated_at' - 'order_id'
           || jsonb_build_object('ref_id', m.order_id)
           ORDER BY m.created_at DESC, m.id DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT * FROM movements m
    WHERE m.owner_id = v_uid AND (p_product_id IS NULL OR m.product_id = p_product_id)
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT v_lim OFFSET v_off
  ) m;

  RETURN jsonb_build_object('rows', v_rows, 'total', v_total, 'limit', v_lim, 'offset', v_off);
END;
$fn$;

/* 统计：区间汇总、按日、TOP 商品、系列、渠道、差额原因，全部服务端聚合 */
CREATE OR REPLACE FUNCTION public.stats_summary(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid  text := auth.uid();
  v_from date := COALESCE(p_from, (now() AT TIME ZONE 'Asia/Shanghai')::date - 29);
  v_to   date := COALESCE(p_to, (now() AT TIME ZONE 'Asia/Shanghai')::date);
  v_out  jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);
  IF v_to < v_from THEN RAISE EXCEPTION '结束日期不能早于开始日期' USING ERRCODE = 'P0001'; END IF;

  WITH sel AS (
    SELECT o.* FROM orders o
    WHERE o.owner_id = v_uid AND o.status = 'paid' AND o.paid_at IS NOT NULL
      AND (o.paid_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN v_from AND v_to
  ),
  /* 单品销量：商品行 + 套餐选品快照 + 套餐固定明细 */
  top_raw AS (
    SELECT i.product_name AS name, sum(i.quantity)::int AS qty,
           round(sum(i.line_amount), 2) AS amount
    FROM order_items i JOIN sel o ON o.id = i.order_id
    WHERE i.owner_id = v_uid AND i.item_type = 'product'
    GROUP BY i.product_name
    UNION ALL
    SELECT p.name, sum(s.quantity * i.quantity)::int, 0
    FROM order_items i
    JOIN sel o ON o.id = i.order_id
    JOIN order_item_selections s ON s.owner_id = i.owner_id AND s.order_item_id = i.id
    JOIN products p ON p.owner_id = s.owner_id AND p.id = s.product_id
    WHERE i.owner_id = v_uid AND i.item_type = 'combo'
    GROUP BY p.name
    UNION ALL
    SELECT p.name, sum(ci.quantity * i.quantity)::int, 0
    FROM order_items i
    JOIN sel o ON o.id = i.order_id
    JOIN combo_items ci ON ci.owner_id = i.owner_id AND ci.combo_id = i.combo_id
    JOIN products p ON p.owner_id = ci.owner_id AND p.id = ci.product_id
    WHERE i.owner_id = v_uid AND i.item_type = 'combo'
      AND NOT EXISTS (SELECT 1 FROM order_item_selections s2
                      WHERE s2.owner_id = i.owner_id AND s2.order_item_id = i.id)
    GROUP BY p.name
  ),
  top_agg AS (
    SELECT name, sum(qty)::int AS qty, round(sum(amount), 2) AS amount
    FROM top_raw GROUP BY name
  ),
  head AS (
    SELECT COALESCE(round(sum(paid_amount), 2), 0) AS revenue,
           COALESCE(round(sum(total_amount), 2), 0) AS receivable,
           count(*) AS cnt,
           COALESCE(sum(item_count), 0) AS pieces
    FROM sel
  )
  SELECT jsonb_build_object(
    'from', to_char(v_from, 'YYYY-MM-DD'),
    'to', to_char(v_to, 'YYYY-MM-DD'),
    'summary', (
      SELECT jsonb_build_object(
        'revenue', h.revenue, 'receivable', h.receivable, 'count', h.cnt,
        'avg', CASE WHEN h.cnt > 0 THEN round(h.revenue / h.cnt, 2) ELSE 0 END,
        'pieces', h.pieces,
        'gifts', (SELECT COALESCE(sum(i.quantity), 0) FROM order_items i JOIN sel o ON o.id = i.order_id
                  WHERE i.owner_id = v_uid AND i.is_gift),
        'giftRate', CASE WHEN h.pieces > 0 THEN
          round((SELECT COALESCE(sum(i.quantity), 0) FROM order_items i JOIN sel o ON o.id = i.order_id
                 WHERE i.owner_id = v_uid AND i.is_gift) * 100.0 / h.pieces) ELSE 0 END,
        'diff', round(h.revenue - h.receivable, 2),
        'diffCount', (SELECT count(*) FROM adjustments a JOIN sel o ON o.id = a.order_id WHERE a.owner_id = v_uid),
        'diffRate', CASE WHEN h.cnt > 0 THEN
          round((SELECT count(*) FROM adjustments a JOIN sel o ON o.id = a.order_id WHERE a.owner_id = v_uid) * 100.0 / h.cnt) ELSE 0 END
      )
      FROM head h
    ),
    'daily', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'),
                                          'revenue', d.revenue, 'count', d.count) ORDER BY d.day)
      FROM (
        SELECT gs::date AS day, COALESCE(round(sum(o.paid_amount), 2), 0) AS revenue, count(o.id) AS count
        FROM generate_series(v_from, v_to, interval '1 day') gs
        LEFT JOIN sel o ON (o.paid_at AT TIME ZONE 'Asia/Shanghai')::date = gs::date
        GROUP BY gs
      ) d), '[]'::jsonb),
    'top', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', t.name, 'qty', t.qty, 'amount', t.amount) ORDER BY t.qty DESC, t.name)
      FROM (SELECT * FROM top_agg ORDER BY qty DESC, name LIMIT 10) t), '[]'::jsonb),
    'topAll', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', t.name, 'qty', t.qty, 'amount', t.amount) ORDER BY t.qty DESC, t.name)
      FROM top_agg t), '[]'::jsonb),
    'series', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('name', s.series, 'qty', s.qty, 'amount', s.amount) ORDER BY s.qty DESC, s.series)
      FROM (
        SELECT COALESCE(p.series, '未分类') AS series, sum(t.qty)::int AS qty, round(sum(t.amount), 2) AS amount
        FROM top_agg t
        LEFT JOIN LATERAL (
          SELECT pr.series FROM products pr WHERE pr.owner_id = v_uid AND pr.name = t.name LIMIT 1
        ) p ON true
        GROUP BY 1
      ) s), '[]'::jsonb),
    'channels', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('key', c.channel, 'amount', c.amount, 'count', c.count) ORDER BY c.amount DESC)
      FROM (
        SELECT COALESCE(channel, 'other') AS channel, round(sum(paid_amount), 2) AS amount, count(*) AS count
        FROM sel GROUP BY 1
      ) c), '[]'::jsonb),
    'adjustments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('type', a.adjust_type, 'amount', a.amount, 'count', a.count) ORDER BY abs(a.amount) DESC)
      FROM (
        SELECT a.adjust_type, round(sum(a.amount), 2) AS amount, count(*) AS count
        FROM adjustments a JOIN sel o ON o.id = a.order_id
        WHERE a.owner_id = v_uid
        GROUP BY a.adjust_type
      ) a), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$fn$;

/* 导出 / 备份 / 反向生成 v1 用：整份账在同一个响应里，形状与旧 db 一致 */
CREATE OR REPLACE FUNCTION public.export_dataset()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);

  RETURN jsonb_build_object(
    'exportedAt', to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'categories', COALESCE((SELECT jsonb_agg(to_jsonb(c) - 'updated_at' ORDER BY c.id)
                            FROM categories c WHERE c.owner_id = v_uid), '[]'::jsonb),
    'products', COALESCE((SELECT jsonb_agg(to_jsonb(p) - 'updated_at' - 'category_name'
                              || jsonb_build_object('category', COALESCE(p.category_name, ''),
                                'tags', COALESCE((SELECT jsonb_agg(pt.tag_name ORDER BY pt.tag_name)
                                                  FROM product_tags pt
                                                  WHERE pt.owner_id = v_uid AND pt.product_id = p.id), '[]'::jsonb))
                            ORDER BY p.id)
                          FROM products p WHERE p.owner_id = v_uid), '[]'::jsonb),
    'tags', COALESCE((SELECT jsonb_agg(t.name ORDER BY t.name) FROM tags t WHERE t.owner_id = v_uid), '[]'::jsonb),
    'combos', COALESCE((SELECT jsonb_agg(to_jsonb(c) - 'updated_at'
                            || jsonb_build_object(
                                 'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', ci.product_id, 'quantity', ci.quantity) ORDER BY ci.sort, ci.product_id)
                                                    FROM combo_items ci WHERE ci.owner_id = v_uid AND ci.combo_id = c.id), '[]'::jsonb),
                                 'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('category_id', g.category_id, 'category_l1_id', g.category_l1_id, 'quantity', g.quantity,
                                                       'product_ids', COALESCE((SELECT jsonb_agg(gp.product_id ORDER BY gp.product_id)
                                                                                FROM combo_group_products gp
                                                                                WHERE gp.owner_id = v_uid AND gp.combo_id = g.combo_id AND gp.category_id = g.category_id), '[]'::jsonb))
                                                     ORDER BY g.sort, g.category_id)
                                                    FROM combo_groups g WHERE g.owner_id = v_uid AND g.combo_id = c.id), '[]'::jsonb))
                          ORDER BY c.id)
                        FROM combos c WHERE c.owner_id = v_uid), '[]'::jsonb),
    'orders', COALESCE((SELECT jsonb_agg(to_jsonb(o) - 'updated_at' - 'request_id' ORDER BY o.id)
                        FROM orders o WHERE o.owner_id = v_uid), '[]'::jsonb),
    'orderItems', COALESCE((SELECT jsonb_agg(to_jsonb(i) - 'updated_at'
                              || jsonb_build_object('combo_selections', COALESCE((
                                   SELECT jsonb_agg(jsonb_build_object('category_id', g.category_id, 'items', g.items) ORDER BY g.category_id)
                                   FROM (SELECT s.category_id,
                                                jsonb_agg(jsonb_build_object('product_id', s.product_id, 'quantity', s.quantity) ORDER BY s.product_id) AS items
                                         FROM order_item_selections s
                                         WHERE s.owner_id = v_uid AND s.order_item_id = i.id
                                         GROUP BY s.category_id) g), '[]'::jsonb))
                              ORDER BY i.id)
                            FROM order_items i WHERE i.owner_id = v_uid), '[]'::jsonb),
    'adjustments', COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id)
                             FROM adjustments a WHERE a.owner_id = v_uid), '[]'::jsonb),
    'movements', COALESCE((SELECT jsonb_agg(to_jsonb(m) - 'updated_at' - 'order_id'
                              || jsonb_build_object('ref_id', m.order_id) ORDER BY m.id)
                           FROM movements m WHERE m.owner_id = v_uid), '[]'::jsonb),
    'alerts', COALESCE((SELECT jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id)
                        FROM stock_alerts a WHERE a.owner_id = v_uid), '[]'::jsonb),
    'balances', COALESCE((SELECT jsonb_object_agg(b.product_id::text, b.quantity)
                          FROM inventory_balances b WHERE b.owner_id = v_uid), '{}'::jsonb),
    'paymentCodes', COALESCE((SELECT jsonb_object_agg(pc.channel, pc.storage_path)
                              FROM payment_codes pc WHERE pc.owner_id = v_uid), '{}'::jsonb),
    'seq', jsonb_build_object(
      'order', COALESCE((SELECT next_value FROM id_counters WHERE owner_id = v_uid AND name = 'order'), 1),
      'item', COALESCE((SELECT next_value FROM id_counters WHERE owner_id = v_uid AND name = 'item'), 1),
      'adj', COALESCE((SELECT next_value FROM id_counters WHERE owner_id = v_uid AND name = 'adj'), 1),
      'mov', COALESCE((SELECT next_value FROM id_counters WHERE owner_id = v_uid AND name = 'mov'), 1),
      'alert', COALESCE((SELECT next_value FROM id_counters WHERE owner_id = v_uid AND name = 'alert'), 1),
      'product', COALESCE((SELECT next_value FROM id_counters WHERE owner_id = v_uid AND name = 'product'), 1),
      'combo', COALESCE((SELECT next_value FROM id_counters WHERE owner_id = v_uid AND name = 'combo'), 1),
      'category', COALESCE((SELECT next_value FROM id_counters WHERE owner_id = v_uid AND name = 'category'), 1)
    )
  );
END;
$fn$;

/* ============================================================
   写接口
   ============================================================ */

/* 开单（可同时收款）：订单 + 明细 + 选品 + 调整 + 扣库存 + 流水 + 预警，同一事务 */
CREATE OR REPLACE FUNCTION public.create_order(p_payload jsonb, p_request_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid      text := auth.uid();
  v_out      jsonb;
  v_lines    jsonb := COALESCE(p_payload->'lines', '[]'::jsonb);
  v_settle   boolean;
  v_channel  text := NULLIF(btrim(COALESCE(p_payload->>'channel', '')), '');
  v_note     text := NULLIF(btrim(COALESCE(p_payload->>'note', '')), '');
  v_created  timestamptz := COALESCE(NULLIF(p_payload->>'createdAt', '')::timestamptz, now());
  v_paid_at  timestamptz;
  v_paid     numeric(12,2);
  v_total    numeric(12,2) := 0;
  v_pieces   integer := 0;
  v_order_id bigint;
  v_order_no text;
  v_item_id  bigint;
  v_line_no  integer := 0;
  v_line     jsonb;
  v_saved    jsonb := '[]'::jsonb;
  v_itype    text;
  v_pid      bigint;
  v_cid      bigint;
  v_name     text;
  v_qty      integer;
  v_price    numeric(12,2);
  v_gift     boolean;
  v_amt      numeric(12,2);
  v_c        combos%ROWTYPE;
  v_grp      combo_groups%ROWTYPE;
  v_sel      jsonb;
  v_entry    jsonb;
  v_unit_qty integer;
  v_cnt      integer;
  v_parts    jsonb;
  v_part     jsonb;
  v_selout   jsonb;
  v_group_items jsonb;
  v_diff     numeric(12,2);
  v_adj      jsonb := NULL;
  v_impact   jsonb := '[]'::jsonb;
  v_pids     bigint[];
  v_bal      integer;
  v_after    integer;
  v_deduct   integer;
  v_aid      bigint;
  v_alerts   jsonb := '[]'::jsonb;
  v_items    jsonb;
  v_order    jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  IF p_request_id IS NULL OR btrim(p_request_id) = '' THEN
    RAISE EXCEPTION '缺少请求编号，请重试' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);

  /* 幂等：同一个 request_id 只执行一次，重试直接返回上次结果 */
  INSERT INTO client_requests (owner_id, request_id, kind)
  VALUES (v_uid, p_request_id, 'create_order')
  ON CONFLICT (owner_id, request_id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT result INTO v_out FROM client_requests WHERE owner_id = v_uid AND request_id = p_request_id;
    IF v_out IS NOT NULL THEN RETURN v_out; END IF;
    RAISE EXCEPTION '上一次提交还在处理中，请稍后刷新' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(v_lines) <> 'array' OR jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION '订单为空，请先选择商品' USING ERRCODE = 'P0001';
  END IF;

  v_settle := COALESCE((p_payload->>'settle')::boolean, true)
              AND NULLIF(btrim(COALESCE(p_payload->>'paidAmount', '')), '') IS NOT NULL;

  /* ---- 逐行校验，累计应收 / 件数 / 出库影响 ---- */
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_lines) LOOP
    v_itype := COALESCE(NULLIF(v_line->>'item_type', ''), 'product');
    v_qty   := COALESCE((v_line->>'quantity')::int, 0);
    v_price := round(COALESCE((v_line->>'unit_price')::numeric, 0), 2);
    v_gift  := COALESCE((v_line->>'is_gift')::boolean, false);
    v_name  := btrim(COALESCE(v_line->>'product_name', ''));
    v_selout := NULL;
    v_unit_qty := 1;

    IF v_qty < 1 THEN
      RAISE EXCEPTION '「%」数量无效', COALESCE(NULLIF(v_name, ''), '商品') USING ERRCODE = 'P0001';
    END IF;
    IF v_price < 0 THEN
      RAISE EXCEPTION '「%」价格无效', COALESCE(NULLIF(v_name, ''), '商品') USING ERRCODE = 'P0001';
    END IF;

    IF v_itype = 'combo' THEN
      v_cid := (v_line->>'combo_id')::bigint;
      SELECT * INTO v_c FROM combos WHERE owner_id = v_uid AND id = v_cid;
      IF NOT FOUND THEN RAISE EXCEPTION '套餐不存在或已停售' USING ERRCODE = 'P0001'; END IF;
      IF v_c.status <> 'on_sale' THEN RAISE EXCEPTION '套餐「%」已停售', v_c.name USING ERRCODE = 'P0001'; END IF;
      v_name := COALESCE(NULLIF(v_name, ''), v_c.name);
      v_gift := false;

      IF EXISTS (SELECT 1 FROM combo_groups g WHERE g.owner_id = v_uid AND g.combo_id = v_cid) THEN
        v_sel := COALESCE(v_line->'selections', '[]'::jsonb);
        IF jsonb_typeof(v_sel) <> 'array' OR jsonb_array_length(v_sel) = 0 THEN
          RAISE EXCEPTION '套餐「%」需要先选够品再下单', v_c.name USING ERRCODE = 'P0001';
        END IF;
        v_parts := '[]'::jsonb;
        v_selout := '[]'::jsonb;
        FOR v_grp IN SELECT * FROM combo_groups g
                     WHERE g.owner_id = v_uid AND g.combo_id = v_cid
                     ORDER BY g.sort, g.category_id LOOP
          SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) INTO v_entry
          FROM jsonb_array_elements(v_sel) e
          WHERE (e->>'category_id')::bigint = v_grp.category_id;
          IF jsonb_array_length(v_entry) = 0 THEN
            RAISE EXCEPTION '套餐「%」需要从「%」选 % 件', v_c.name,
              COALESCE((SELECT name FROM categories WHERE owner_id = v_uid AND id = v_grp.category_id), '该分类'),
              v_grp.quantity USING ERRCODE = 'P0001';
          END IF;
          v_cnt := 0;
          v_group_items := '[]'::jsonb;
          FOR v_part IN
            SELECT it FROM jsonb_array_elements(v_entry) e2,
                          LATERAL jsonb_array_elements(COALESCE(e2->'items', '[]'::jsonb)) AS it
          LOOP
            v_pid := (v_part->>'product_id')::bigint;
            v_unit_qty := COALESCE((v_part->>'quantity')::int, 0);
            IF v_unit_qty < 1 THEN RAISE EXCEPTION '选品数量无效' USING ERRCODE = 'P0001'; END IF;
            IF NOT EXISTS (SELECT 1 FROM products p WHERE p.owner_id = v_uid AND p.id = v_pid AND p.status = 'on_sale') THEN
              RAISE EXCEPTION '选品里有已停售或不存在的商品，请重新选' USING ERRCODE = 'P0001';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM products p
                           WHERE p.owner_id = v_uid AND p.id = v_pid AND p.category_id = v_grp.category_id) THEN
              RAISE EXCEPTION '选品与子套餐「%」的中类不匹配', 
                COALESCE((SELECT name FROM categories WHERE owner_id = v_uid AND id = v_grp.category_id), '') USING ERRCODE = 'P0001';
            END IF;
            IF EXISTS (SELECT 1 FROM combo_group_products gp
                       WHERE gp.owner_id = v_uid AND gp.combo_id = v_cid AND gp.category_id = v_grp.category_id)
               AND NOT EXISTS (SELECT 1 FROM combo_group_products gp
                               WHERE gp.owner_id = v_uid AND gp.combo_id = v_cid AND gp.category_id = v_grp.category_id
                                 AND gp.product_id = v_pid) THEN
              RAISE EXCEPTION '该商品不在子套餐「%」的可选范围里',
                COALESCE((SELECT name FROM categories WHERE owner_id = v_uid AND id = v_grp.category_id), '') USING ERRCODE = 'P0001';
            END IF;
            v_cnt := v_cnt + v_unit_qty;
            v_parts := v_parts || jsonb_build_object('product_id', v_pid, 'quantity', v_unit_qty);
            v_group_items := v_group_items || jsonb_build_array(
              jsonb_build_object('product_id', v_pid, 'quantity', v_unit_qty));
          END LOOP;
          v_selout := v_selout || jsonb_build_array(
            jsonb_build_object('category_id', v_grp.category_id, 'items', v_group_items));
          IF v_cnt <> v_grp.quantity THEN
            RAISE EXCEPTION '子套餐「%」需选 % 件，当前 % 件',
              COALESCE((SELECT name FROM categories WHERE owner_id = v_uid AND id = v_grp.category_id), ''),
              v_grp.quantity, v_cnt USING ERRCODE = 'P0001';
          END IF;
        END LOOP;
      ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object('product_id', ci.product_id, 'quantity', ci.quantity)
                                  ORDER BY ci.sort, ci.product_id), '[]'::jsonb)
        INTO v_parts
        FROM combo_items ci WHERE ci.owner_id = v_uid AND ci.combo_id = v_cid;
        IF jsonb_array_length(v_parts) = 0 THEN
          RAISE EXCEPTION '套餐「%」缺少明细，无法扣减库存', v_c.name USING ERRCODE = 'P0001';
        END IF;
      END IF;
    ELSE
      v_pid := (v_line->>'product_id')::bigint;
      IF NOT EXISTS (SELECT 1 FROM products p WHERE p.owner_id = v_uid AND p.id = v_pid) THEN
        RAISE EXCEPTION '商品不存在' USING ERRCODE = 'P0001';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM products p WHERE p.owner_id = v_uid AND p.id = v_pid AND p.status = 'on_sale') THEN
        RAISE EXCEPTION '「%」已停售，不能加入新订单', 
          COALESCE((SELECT name FROM products WHERE owner_id = v_uid AND id = v_pid), '商品') USING ERRCODE = 'P0001';
      END IF;
      v_name := COALESCE(NULLIF(v_name, ''), (SELECT name FROM products WHERE owner_id = v_uid AND id = v_pid));
      v_cid := NULL;
      v_parts := jsonb_build_array(jsonb_build_object('product_id', v_pid, 'quantity', 1));
    END IF;

    v_amt := CASE WHEN v_gift THEN 0 ELSE round(v_qty * v_price, 2) END;
    v_total := v_total + v_amt;
    v_line_no := v_line_no + 1;

    v_saved := v_saved || jsonb_build_object(
      'line_no', v_line_no, 'item_type', CASE WHEN v_itype = 'combo' THEN 'combo' ELSE 'product' END,
      'product_id', CASE WHEN v_itype = 'combo' THEN NULL ELSE v_pid END,
      'combo_id', CASE WHEN v_itype = 'combo' THEN v_cid ELSE NULL END,
      'product_name', v_name, 'quantity', v_qty, 'unit_price', v_price,
      'line_amount', v_amt, 'is_gift', v_gift, 'selections', v_selout);

    FOR v_part IN SELECT * FROM jsonb_array_elements(v_parts) LOOP
      v_pieces := v_pieces + (v_part->>'quantity')::int * v_qty;
      v_impact := v_impact || jsonb_build_object(
        'product_id', (v_part->>'product_id')::bigint,
        'quantity', (v_part->>'quantity')::int * v_qty);
    END LOOP;
  END LOOP;

  v_total := round(v_total, 2);

  /* ---- 收款信息与差额校验（R1） ---- */
  IF v_settle THEN
    IF v_channel IS NULL THEN RAISE EXCEPTION '请选择收款渠道' USING ERRCODE = 'P0001'; END IF;
    v_paid := round((p_payload->>'paidAmount')::numeric, 2);
    IF v_paid IS NULL THEN RAISE EXCEPTION '请填写实收金额' USING ERRCODE = 'P0001'; END IF;
    IF v_paid < 0 THEN RAISE EXCEPTION '实收金额无效' USING ERRCODE = 'P0001'; END IF;
    v_diff := round(v_paid - v_total, 2);
    IF v_diff <> 0 THEN
      IF NULLIF(btrim(COALESCE(p_payload->>'adjustType', '')), '') IS NULL THEN
        RAISE EXCEPTION '实收与应收差 % 元，请选择差额原因', v_diff USING ERRCODE = 'P0001';
      END IF;
      v_adj := jsonb_build_object(
        'adjust_type', btrim(p_payload->>'adjustType'),
        'amount', v_diff,
        'reason', NULLIF(btrim(COALESCE(p_payload->>'adjustReason', '')), ''));
    END IF;
    v_paid_at := COALESCE(NULLIF(p_payload->>'paidAt', '')::timestamptz, v_created);
  ELSE
    v_paid := NULL;
    v_paid_at := NULL;
  END IF;

  /* ---- 订单头 ---- */
  v_order_id := v3_next_id(v_uid, 'order');
  v_order_no := v3_next_order_no(v_uid, v_created);

  INSERT INTO orders (owner_id, id, order_no, status, channel, total_amount, paid_amount,
                      item_count, note, created_at, paid_at, request_id, updated_at)
  VALUES (v_uid, v_order_id, v_order_no, CASE WHEN v_settle THEN 'paid' ELSE 'pending' END,
          CASE WHEN v_settle THEN v_channel ELSE NULL END, v_total, v_paid, v_pieces, v_note,
          v_created, v_paid_at, p_request_id, now());

  /* ---- 明细与选品快照 ---- */
  FOR v_line IN SELECT * FROM jsonb_array_elements(v_saved) LOOP
    v_item_id := v3_next_id(v_uid, 'item');
    INSERT INTO order_items (owner_id, id, order_id, line_no, item_type, product_id, combo_id,
                             product_name, quantity, unit_price, line_amount, is_gift, created_at, updated_at)
    VALUES (v_uid, v_item_id, v_order_id, (v_line->>'line_no')::int, v_line->>'item_type',
            (v_line->>'product_id')::bigint, (v_line->>'combo_id')::bigint,
            v_line->>'product_name', (v_line->>'quantity')::int, (v_line->>'unit_price')::numeric,
            (v_line->>'line_amount')::numeric, (v_line->>'is_gift')::boolean,
            COALESCE(v_paid_at, v_created), now());

    IF v_line->'selections' IS NOT NULL AND jsonb_typeof(v_line->'selections') = 'array' THEN
      INSERT INTO order_item_selections (owner_id, order_item_id, category_id, product_id, quantity)
      SELECT v_uid, v_item_id, (e->>'category_id')::bigint,
             (it->>'product_id')::bigint, (it->>'quantity')::int
      FROM jsonb_array_elements(v_line->'selections') e,
           LATERAL jsonb_array_elements(COALESCE(e->'items', '[]'::jsonb)) AS it;
    END IF;
  END LOOP;

  /* ---- 差额落库（R1） ---- */
  IF v_adj IS NOT NULL THEN
    INSERT INTO adjustments (owner_id, id, order_id, adjust_type, amount, reason, created_at, updated_at)
    VALUES (v_uid, v3_next_id(v_uid, 'adj'), v_order_id, v_adj->>'adjust_type',
            (v_adj->>'amount')::numeric, NULLIF(v_adj->>'reason', ''), COALESCE(v_paid_at, v_created), now());
  END IF;

  /* ---- 扣库存 + 流水 + 预警（R3/R5，仅已收款） ---- */
  IF v_settle THEN
    SELECT ARRAY(SELECT DISTINCT (e->>'product_id')::bigint FROM jsonb_array_elements(v_impact) e ORDER BY 1)
    INTO v_pids;
    PERFORM 1 FROM inventory_balances
    WHERE owner_id = v_uid AND product_id = ANY(v_pids)
    ORDER BY product_id FOR UPDATE;

    FOR v_pid IN SELECT DISTINCT (e->>'product_id')::bigint FROM jsonb_array_elements(v_impact) e ORDER BY 1 LOOP
      SELECT COALESCE(sum((e->>'quantity')::int), 0) INTO v_deduct
      FROM jsonb_array_elements(v_impact) e WHERE (e->>'product_id')::bigint = v_pid;

      SELECT quantity INTO v_bal FROM inventory_balances WHERE owner_id = v_uid AND product_id = v_pid;
      IF FOUND THEN
        v_after := v_bal - v_deduct;
        UPDATE inventory_balances SET quantity = v_after, updated_at = now()
        WHERE owner_id = v_uid AND product_id = v_pid;
      ELSE
        v_after := NULL;
      END IF;

      INSERT INTO movements (owner_id, id, product_id, movement_type, quantity, balance_after,
                             ref_type, order_id, ref_no, created_at, updated_at)
      VALUES (v_uid, v3_next_id(v_uid, 'mov'), v_pid, 'out', -v_deduct, v_after,
              'order', v_order_id, v_order_no, v_paid_at, now());

      v_aid := v3_raise_alert(v_uid, v_pid, v_after, 'order', v_order_no, v_paid_at);
      IF v_aid IS NOT NULL THEN
        v_alerts := v_alerts || jsonb_build_array((
          SELECT to_jsonb(a) - 'updated_at' FROM stock_alerts a WHERE a.owner_id = v_uid AND a.id = v_aid));
      END IF;
    END LOOP;
  END IF;

  /* ---- 组装返回（与 v2 视图字段一致） ---- */
  SELECT to_jsonb(o) - 'updated_at' - 'request_id' INTO v_order
  FROM orders o WHERE o.owner_id = v_uid AND o.id = v_order_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(i) - 'updated_at' ORDER BY i.line_no), '[]'::jsonb) INTO v_items
  FROM order_items i WHERE i.owner_id = v_uid AND i.order_id = v_order_id;

  v_out := jsonb_build_object(
    'order', v_order, 'items', v_items,
    'adjustment', CASE WHEN v_adj IS NULL THEN NULL ELSE
      (SELECT to_jsonb(a) - 'updated_at' FROM adjustments a
       WHERE a.owner_id = v_uid AND a.order_id = v_order_id ORDER BY a.id DESC LIMIT 1) END,
    'alerts', v_alerts, 'total', v_total, 'pieces', v_pieces);

  UPDATE client_requests SET result = v_out WHERE owner_id = v_uid AND request_id = p_request_id;
  RETURN v_out;
END;
$fn$;

/* 收款 / 冲销：状态机用 UPDATE ... WHERE status=... 做 CAS，重复操作影响 0 行即报错 */
CREATE OR REPLACE FUNCTION public.order_action(p_action text, p_payload jsonb, p_request_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid    text := auth.uid();
  v_out    jsonb;
  v_id     bigint := NULLIF(p_payload->>'id', '')::bigint;
  v_row    orders%ROWTYPE;
  v_channel text := NULLIF(btrim(COALESCE(p_payload->>'channel', '')), '');
  v_paid   numeric(12,2);
  v_diff   numeric(12,2);
  v_at     timestamptz := COALESCE(NULLIF(p_payload->>'paidAt', '')::timestamptz, now());
  v_reason text := NULLIF(btrim(COALESCE(p_payload->>'reason', '')), '');
  v_impact jsonb;
  v_pids   bigint[];
  v_pid    bigint;
  v_qty    integer;
  v_bal    integer;
  v_after  integer;
  v_aid    bigint;
  v_alerts jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  IF p_request_id IS NULL OR btrim(p_request_id) = '' THEN
    RAISE EXCEPTION '缺少请求编号，请重试' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);

  INSERT INTO client_requests (owner_id, request_id, kind)
  VALUES (v_uid, p_request_id, COALESCE(p_action, 'order'))
  ON CONFLICT (owner_id, request_id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT result INTO v_out FROM client_requests WHERE owner_id = v_uid AND request_id = p_request_id;
    IF v_out IS NOT NULL THEN RETURN v_out; END IF;
    RAISE EXCEPTION '上一次提交还在处理中，请稍后刷新' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_row FROM orders WHERE owner_id = v_uid AND id = v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '订单不存在' USING ERRCODE = 'P0001'; END IF;

  IF p_action = 'confirm' THEN
    IF v_row.status <> 'pending' THEN
      RAISE EXCEPTION '订单已收款或已冲销，请刷新后重试' USING ERRCODE = 'P0001';
    END IF;
    IF v_channel IS NULL THEN RAISE EXCEPTION '请选择收款渠道' USING ERRCODE = 'P0001'; END IF;
    v_paid := round((p_payload->>'paidAmount')::numeric, 2);
    IF v_paid IS NULL THEN RAISE EXCEPTION '请填写实收金额' USING ERRCODE = 'P0001'; END IF;
    v_diff := round(v_paid - v_row.total_amount, 2);
    IF v_diff <> 0 AND NULLIF(btrim(COALESCE(p_payload->>'adjustType', '')), '') IS NULL THEN
      RAISE EXCEPTION '实收与应收差 % 元，请选择差额原因', v_diff USING ERRCODE = 'P0001';
    END IF;

    UPDATE orders SET status = 'paid', channel = v_channel, paid_amount = v_paid,
                      paid_at = v_at, updated_at = now()
    WHERE owner_id = v_uid AND id = v_id AND status = 'pending';
    IF NOT FOUND THEN RAISE EXCEPTION '订单已收款或已冲销，请刷新后重试' USING ERRCODE = 'P0001'; END IF;

    IF v_diff <> 0 THEN
      INSERT INTO adjustments (owner_id, id, order_id, adjust_type, amount, reason, created_at, updated_at)
      VALUES (v_uid, v3_next_id(v_uid, 'adj'), v_id, btrim(p_payload->>'adjustType'), v_diff,
              NULLIF(btrim(COALESCE(p_payload->>'adjustReason', '')), ''), v_at, now());
    END IF;

    v_impact := v3_order_impact(v_uid, v_id);
    SELECT ARRAY(SELECT (k)::bigint FROM jsonb_object_keys(v_impact) k ORDER BY 1) INTO v_pids;
    PERFORM 1 FROM inventory_balances WHERE owner_id = v_uid AND product_id = ANY(v_pids)
    ORDER BY product_id FOR UPDATE;

    FOR v_pid, v_qty IN SELECT (k)::bigint, (v_impact->>k)::int FROM jsonb_object_keys(v_impact) k ORDER BY 1 LOOP
      SELECT quantity INTO v_bal FROM inventory_balances WHERE owner_id = v_uid AND product_id = v_pid;
      IF FOUND THEN
        v_after := v_bal - v_qty;
        UPDATE inventory_balances SET quantity = v_after, updated_at = now()
        WHERE owner_id = v_uid AND product_id = v_pid;
      ELSE
        v_after := NULL;
      END IF;
      INSERT INTO movements (owner_id, id, product_id, movement_type, quantity, balance_after,
                             ref_type, order_id, ref_no, created_at, updated_at)
      VALUES (v_uid, v3_next_id(v_uid, 'mov'), v_pid, 'out', -v_qty, v_after,
              'order', v_id, v_row.order_no, v_at, now());
      v_aid := v3_raise_alert(v_uid, v_pid, v_after, 'order', v_row.order_no, v_at);
      IF v_aid IS NOT NULL THEN
        v_alerts := v_alerts || jsonb_build_array((
          SELECT to_jsonb(a) - 'updated_at' FROM stock_alerts a WHERE a.owner_id = v_uid AND a.id = v_aid));
      END IF;
    END LOOP;
  ELSIF p_action = 'cancel' THEN
    IF v_row.status = 'cancelled' THEN
      RAISE EXCEPTION '订单已冲销，不能重复操作' USING ERRCODE = 'P0001';
    END IF;
    IF v_row.status = 'paid' AND v_reason IS NULL THEN
      RAISE EXCEPTION '冲销已收款订单必须填写原因' USING ERRCODE = 'P0001';
    END IF;

    UPDATE orders SET status = 'cancelled', cancelled_at = v_at,
                      cancel_reason = COALESCE(v_reason, '取消订单'), updated_at = now()
    WHERE owner_id = v_uid AND id = v_id AND status <> 'cancelled';
    IF NOT FOUND THEN RAISE EXCEPTION '订单已冲销，不能重复操作' USING ERRCODE = 'P0001'; END IF;

    /* R4：已收款才回补库存，生成反向流水，原单保留 */
    IF v_row.status = 'paid' THEN
      v_impact := v3_order_impact(v_uid, v_id);
      SELECT ARRAY(SELECT (k)::bigint FROM jsonb_object_keys(v_impact) k ORDER BY 1) INTO v_pids;
      PERFORM 1 FROM inventory_balances WHERE owner_id = v_uid AND product_id = ANY(v_pids)
      ORDER BY product_id FOR UPDATE;

      FOR v_pid, v_qty IN SELECT (k)::bigint, (v_impact->>k)::int FROM jsonb_object_keys(v_impact) k ORDER BY 1 LOOP
        SELECT quantity INTO v_bal FROM inventory_balances WHERE owner_id = v_uid AND product_id = v_pid;
        IF FOUND THEN
          v_after := v_bal + v_qty;
          UPDATE inventory_balances SET quantity = v_after, updated_at = now()
          WHERE owner_id = v_uid AND product_id = v_pid;
        ELSE
          v_after := NULL;
        END IF;
        INSERT INTO movements (owner_id, id, product_id, movement_type, quantity, balance_after,
                               ref_type, order_id, ref_no, note, created_at, updated_at)
        VALUES (v_uid, v3_next_id(v_uid, 'mov'), v_pid, 'reversal', v_qty, v_after, 'order', v_id,
                v_row.order_no, '冲销回补：' || COALESCE(v_reason, '取消订单'), v_at, now());
      END LOOP;

      /* 回补后已脱离阈值的未处理预警一并关闭 */
      UPDATE stock_alerts a SET status = 'resolved', resolved_at = v_at,
             resolve_note = '冲销回补后库存恢复', updated_at = now()
      FROM inventory_balances b, products p
      WHERE a.owner_id = v_uid AND a.status = 'open'
        AND b.owner_id = a.owner_id AND b.product_id = a.product_id
        AND p.owner_id = a.owner_id AND p.id = a.product_id
        AND b.quantity >= 0
        AND (p.safety_stock <= 0 OR b.quantity > p.safety_stock);
    END IF;
  ELSE
    RAISE EXCEPTION '未知的操作类型：%', COALESCE(p_action, '') USING ERRCODE = 'P0001';
  END IF;

  SELECT to_jsonb(o) - 'updated_at' - 'request_id' INTO v_out
  FROM orders o WHERE o.owner_id = v_uid AND o.id = v_id;
  v_out := jsonb_build_object('order', v_out, 'alerts', v_alerts);

  UPDATE client_requests SET result = v_out WHERE owner_id = v_uid AND request_id = p_request_id;
  RETURN v_out;
END;
$fn$;

/* 入库 / 盘点：同一事务写余额与流水 */
CREATE OR REPLACE FUNCTION public.stock_action(p_action text, p_payload jsonb, p_request_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid  text := auth.uid();
  v_out  jsonb;
  v_at   timestamptz := COALESCE(NULLIF(p_payload->>'at', '')::timestamptz, now());
  v_note text := NULLIF(btrim(COALESCE(p_payload->>'note', '')), '');
  v_item jsonb;
  v_pid  bigint;
  v_qty  integer;
  v_bal  integer;
  v_after integer;
  v_diff integer;
  v_first boolean;
  v_written jsonb := '[]'::jsonb;
  v_alerts jsonb := '[]'::jsonb;
  v_aid  bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  IF p_request_id IS NULL OR btrim(p_request_id) = '' THEN
    RAISE EXCEPTION '缺少请求编号，请重试' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);

  INSERT INTO client_requests (owner_id, request_id, kind)
  VALUES (v_uid, p_request_id, COALESCE(p_action, 'stock'))
  ON CONFLICT (owner_id, request_id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT result INTO v_out FROM client_requests WHERE owner_id = v_uid AND request_id = p_request_id;
    IF v_out IS NOT NULL THEN RETURN v_out; END IF;
    RAISE EXCEPTION '上一次提交还在处理中，请稍后刷新' USING ERRCODE = 'P0001';
  END IF;

  IF p_action = 'in' THEN
    IF jsonb_typeof(p_payload->'items') <> 'array' OR jsonb_array_length(p_payload->'items') = 0 THEN
      RAISE EXCEPTION '请选择要入库的商品' USING ERRCODE = 'P0001';
    END IF;
    /* 固定加锁顺序，防并发入库死锁 */
    PERFORM 1 FROM inventory_balances
    WHERE owner_id = v_uid AND product_id IN (
      SELECT (e->>'product_id')::bigint FROM jsonb_array_elements(p_payload->'items') e)
    ORDER BY product_id FOR UPDATE;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
      v_pid := (v_item->>'product_id')::bigint;
      v_qty := COALESCE((v_item->>'quantity')::int, 0);
      IF v_qty < 1 THEN RAISE EXCEPTION '入库数量必须大于 0' USING ERRCODE = 'P0001'; END IF;
      IF NOT EXISTS (SELECT 1 FROM products p WHERE p.owner_id = v_uid AND p.id = v_pid) THEN
        RAISE EXCEPTION '商品不存在' USING ERRCODE = 'P0001';
      END IF;

      INSERT INTO inventory_balances (owner_id, product_id, quantity, counted_at, updated_at)
      VALUES (v_uid, v_pid, 0, v_at, now())
      ON CONFLICT (owner_id, product_id) DO NOTHING;

      SELECT quantity INTO v_bal FROM inventory_balances WHERE owner_id = v_uid AND product_id = v_pid;
      v_after := v_bal + v_qty;
      UPDATE inventory_balances SET quantity = v_after, updated_at = now()
      WHERE owner_id = v_uid AND product_id = v_pid;

      INSERT INTO movements (owner_id, id, product_id, movement_type, quantity, balance_after,
                             ref_type, ref_no, note, created_at, updated_at)
      VALUES (v_uid, v3_next_id(v_uid, 'mov'), v_pid, 'in', v_qty, v_after, 'purchase', NULL, v_note, v_at, now());

      v_aid := v3_raise_alert(v_uid, v_pid, v_after, 'purchase', NULL, v_at);
      IF v_aid IS NOT NULL THEN
        v_alerts := v_alerts || jsonb_build_array((
          SELECT to_jsonb(a) - 'updated_at' FROM stock_alerts a WHERE a.owner_id = v_uid AND a.id = v_aid));
      END IF;

      v_written := v_written || jsonb_build_array(jsonb_build_object(
        'product_id', v_pid, 'quantity', v_qty, 'balance', v_after));
    END LOOP;
  ELSIF p_action = 'set' THEN
    v_pid := NULLIF(p_payload->>'product_id', '')::bigint;
    v_qty := COALESCE((p_payload->>'counted')::int, -1);
    IF v_qty < 0 THEN RAISE EXCEPTION '盘点数量无效' USING ERRCODE = 'P0001'; END IF;
    IF NOT EXISTS (SELECT 1 FROM products p WHERE p.owner_id = v_uid AND p.id = v_pid) THEN
      RAISE EXCEPTION '商品不存在' USING ERRCODE = 'P0001';
    END IF;

    PERFORM 1 FROM inventory_balances WHERE owner_id = v_uid AND product_id = v_pid FOR UPDATE;
    SELECT quantity INTO v_bal FROM inventory_balances WHERE owner_id = v_uid AND product_id = v_pid;
    v_first := NOT FOUND;

    IF v_first THEN
      /* 首次盘点 = 建账：余额直接取实盘数，记一条 in 流水 */
      INSERT INTO inventory_balances (owner_id, product_id, quantity, counted_at, updated_at)
      VALUES (v_uid, v_pid, v_qty, v_at, now());
      INSERT INTO movements (owner_id, id, product_id, movement_type, quantity, balance_after,
                             ref_type, ref_no, note, created_at, updated_at)
      VALUES (v_uid, v3_next_id(v_uid, 'mov'), v_pid, 'in', v_qty, v_qty, 'stocktake', NULL,
              '期初建账' || COALESCE('：' || v_note, ''), v_at, now());
      v_diff := v_qty;
      v_after := v_qty;
    ELSE
      v_diff := v_qty - v_bal;
      v_after := v_qty;
      IF v_diff <> 0 THEN
        UPDATE inventory_balances SET quantity = v_after, updated_at = now()
        WHERE owner_id = v_uid AND product_id = v_pid;
        INSERT INTO movements (owner_id, id, product_id, movement_type, quantity, balance_after,
                               ref_type, ref_no, note, created_at, updated_at)
        VALUES (v_uid, v3_next_id(v_uid, 'mov'), v_pid, 'adjust', v_diff, v_after, 'stocktake', NULL, v_note, v_at, now());
        v_aid := v3_raise_alert(v_uid, v_pid, v_after, 'stocktake', NULL, v_at);
        IF v_aid IS NOT NULL THEN
          v_alerts := v_alerts || jsonb_build_array((
            SELECT to_jsonb(a) - 'updated_at' FROM stock_alerts a WHERE a.owner_id = v_uid AND a.id = v_aid));
        END IF;
      END IF;
    END IF;

    v_written := jsonb_build_array(jsonb_build_object(
      'product_id', v_pid, 'first', v_first, 'before', CASE WHEN v_first THEN NULL ELSE v_qty - v_diff END,
      'balance', v_after, 'diff', v_diff, 'changed', (v_diff <> 0)));
  ELSE
    RAISE EXCEPTION '未知的库存操作：%', COALESCE(p_action, '') USING ERRCODE = 'P0001';
  END IF;

  v_out := jsonb_build_object('written', v_written, 'alerts', v_alerts, 'at', to_char(v_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24:MI:SS'));
  UPDATE client_requests SET result = v_out WHERE owner_id = v_uid AND request_id = p_request_id;
  RETURN v_out;
END;
$fn$;

/* 商品保存（含批量导入）：SKU / 条码唯一由数据库兜底，整批一次事务 */
CREATE OR REPLACE FUNCTION public.save_product(p_payload jsonb, p_request_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);

  IF p_request_id IS NOT NULL AND btrim(p_request_id) <> '' THEN
    INSERT INTO client_requests (owner_id, request_id, kind)
    VALUES (v_uid, p_request_id, 'save_product')
    ON CONFLICT (owner_id, request_id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT result INTO v_out FROM client_requests WHERE owner_id = v_uid AND request_id = p_request_id;
      IF v_out IS NOT NULL THEN RETURN v_out; END IF;
    END IF;
  END IF;

  v_out := jsonb_build_object('product', v3_upsert_product(v_uid, p_payload));
  IF p_request_id IS NOT NULL AND btrim(p_request_id) <> '' THEN
    UPDATE client_requests SET result = v_out WHERE owner_id = v_uid AND request_id = p_request_id;
  END IF;
  RETURN v_out;
END;
$fn$;

/* 批量导入：单行失败不影响其他行，返回成功清单与错误清单 */
CREATE OR REPLACE FUNCTION public.import_products(p_rows jsonb, p_request_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid  text := auth.uid();
  v_out  jsonb;
  v_row  jsonb;
  v_ok   jsonb := '[]'::jsonb;
  v_bad  jsonb := '[]'::jsonb;
  v_line integer := 0;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);

  IF p_request_id IS NOT NULL AND btrim(p_request_id) <> '' THEN
    INSERT INTO client_requests (owner_id, request_id, kind)
    VALUES (v_uid, p_request_id, 'import_products')
    ON CONFLICT (owner_id, request_id) DO NOTHING;
    IF NOT FOUND THEN
      SELECT result INTO v_out FROM client_requests WHERE owner_id = v_uid AND request_id = p_request_id;
      IF v_out IS NOT NULL THEN RETURN v_out; END IF;
    END IF;
  END IF;

  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION '没有可导入的行' USING ERRCODE = 'P0001';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    BEGIN
      v_ok := v_ok || jsonb_build_array(v3_upsert_product(v_uid, v_row));
    EXCEPTION WHEN OTHERS THEN
      v_line := COALESCE((v_row->>'line')::int, v_line + 1);
      v_bad := v_bad || jsonb_build_array(jsonb_build_object(
        'name', COALESCE(v_row->>'name', ''), 'line', v_line, 'error', SQLERRM));
    END;
  END LOOP;

  v_out := jsonb_build_object('ok', v_ok, 'bad', v_bad);
  IF p_request_id IS NOT NULL AND btrim(p_request_id) <> '' THEN
    UPDATE client_requests SET result = v_out WHERE owner_id = v_uid AND request_id = p_request_id;
  END IF;
  RETURN v_out;
END;
$fn$;

/* 套餐保存：头 + 固定明细 + 子套餐 + 可选商品池，整体替换 */
CREATE OR REPLACE FUNCTION public.save_combo(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid   text := auth.uid();
  v_id    bigint := NULLIF(p_payload->>'id', '')::bigint;
  v_name  text := btrim(COALESCE(p_payload->>'name', ''));
  v_code  text := NULLIF(btrim(COALESCE(p_payload->>'combo_code', '')), '');
  v_group jsonb;
  v_item  jsonb;
  v_cat   bigint;
  v_out   jsonb;
  v_pid   bigint;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);
  IF v_name = '' THEN RAISE EXCEPTION '请填写套餐名称' USING ERRCODE = 'P0001'; END IF;

  IF jsonb_typeof(p_payload->'groups') IS DISTINCT FROM 'array'
     OR jsonb_array_length(COALESCE(p_payload->'groups', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION '请至少配置一个子套餐' USING ERRCODE = 'P0001';
  END IF;

  IF v_id IS NULL THEN
    v_id := v3_next_id(v_uid, 'combo');
    INSERT INTO combos (owner_id, id, combo_code, name, combo_price, original_price, status, created_at, updated_at)
    VALUES (v_uid, v_id, COALESCE(v_code, 'C' || lpad(v_id::text, 3, '0')), v_name,
            round(COALESCE((p_payload->>'combo_price')::numeric, 0), 2),
            CASE WHEN p_payload->>'original_price' IS NULL OR btrim(p_payload->>'original_price') IN ('', 'null')
                 THEN NULL ELSE round((p_payload->>'original_price')::numeric, 2) END,
            CASE WHEN p_payload->>'status' = 'off_sale' THEN 'off_sale' ELSE 'on_sale' END, now(), now());
  ELSE
    IF NOT EXISTS (SELECT 1 FROM combos WHERE owner_id = v_uid AND id = v_id) THEN
      RAISE EXCEPTION '套餐不存在' USING ERRCODE = 'P0001';
    END IF;
    UPDATE combos SET name = v_name,
      combo_price = round(COALESCE((p_payload->>'combo_price')::numeric, combo_price), 2),
      original_price = CASE WHEN p_payload->>'original_price' IS NULL OR btrim(p_payload->>'original_price') IN ('', 'null')
                            THEN NULL ELSE round((p_payload->>'original_price')::numeric, 2) END,
      status = CASE WHEN p_payload->>'status' = 'off_sale' THEN 'off_sale'
                    WHEN p_payload->>'status' = 'on_sale' THEN 'on_sale' ELSE status END,
      updated_at = now()
    WHERE owner_id = v_uid AND id = v_id;
  END IF;

  /* 子套餐整体替换 */
  DELETE FROM combo_groups WHERE owner_id = v_uid AND combo_id = v_id;
  FOR v_group IN SELECT * FROM jsonb_array_elements(p_payload->'groups') LOOP
    v_cat := (v_group->>'category_id')::bigint;
    IF v_cat IS NULL THEN RAISE EXCEPTION '子套餐缺少中类' USING ERRCODE = 'P0001'; END IF;
    IF NOT EXISTS (SELECT 1 FROM categories c WHERE c.owner_id = v_uid AND c.id = v_cat) THEN
      RAISE EXCEPTION '子套餐的中类不存在' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM categories c WHERE c.owner_id = v_uid AND c.id = v_cat AND c.parent_id IS NOT NULL) THEN
      RAISE EXCEPTION '子套餐只能选择中类（第二级分类）' USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE((v_group->>'quantity')::int, 0) < 1 THEN
      RAISE EXCEPTION '子套餐件数必须大于 0' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO combo_groups (owner_id, combo_id, category_id, category_l1_id, quantity, sort)
    VALUES (v_uid, v_id, v_cat,
            (SELECT parent_id FROM categories WHERE owner_id = v_uid AND id = v_cat),
            (v_group->>'quantity')::int,
            COALESCE((v_group->>'sort')::int, 0))
    ON CONFLICT (owner_id, combo_id, category_id) DO UPDATE
      SET quantity = EXCLUDED.quantity, category_l1_id = EXCLUDED.category_l1_id, sort = EXCLUDED.sort;

    IF jsonb_typeof(v_group->'product_ids') = 'array' THEN
      FOR v_pid IN SELECT DISTINCT (t)::bigint FROM jsonb_array_elements_text(v_group->'product_ids') t LOOP
        IF NOT EXISTS (SELECT 1 FROM products p WHERE p.owner_id = v_uid AND p.id = v_pid AND p.category_id = v_cat) THEN
          RAISE EXCEPTION '商品不属于子套餐的中类' USING ERRCODE = 'P0001';
        END IF;
        INSERT INTO combo_group_products (owner_id, combo_id, category_id, product_id)
        VALUES (v_uid, v_id, v_cat, v_pid) ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;
  END LOOP;

  /* 固定明细：只在显式传入时整体替换（旧客户端兼容） */
  IF jsonb_typeof(p_payload->'items') = 'array' THEN
    DELETE FROM combo_items WHERE owner_id = v_uid AND combo_id = v_id;
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload->'items') LOOP
      INSERT INTO combo_items (owner_id, combo_id, product_id, quantity, sort)
      VALUES (v_uid, v_id, (v_item->>'product_id')::bigint,
              COALESCE((v_item->>'quantity')::int, 1), COALESCE((v_item->>'sort')::int, 0))
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  SELECT to_jsonb(c) - 'updated_at' || jsonb_build_object(
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', ci.product_id, 'quantity', ci.quantity) ORDER BY ci.sort, ci.product_id)
                       FROM combo_items ci WHERE ci.owner_id = v_uid AND ci.combo_id = v_id), '[]'::jsonb),
    'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('category_id', g.category_id, 'category_l1_id', g.category_l1_id, 'quantity', g.quantity,
                     'product_ids', COALESCE((SELECT jsonb_agg(gp.product_id ORDER BY gp.product_id)
                                              FROM combo_group_products gp
                                              WHERE gp.owner_id = v_uid AND gp.combo_id = g.combo_id AND gp.category_id = g.category_id), '[]'::jsonb))
                   ORDER BY g.sort, g.category_id)
                   FROM combo_groups g WHERE g.owner_id = v_uid AND g.combo_id = v_id), '[]'::jsonb))
  INTO v_out
  FROM combos c WHERE c.owner_id = v_uid AND c.id = v_id;

  RETURN jsonb_build_object('combo', v_out);
END;
$fn$;

/* 套餐删除：被历史订单引用时只停售，不物理删（R4 精神） */
CREATE OR REPLACE FUNCTION public.delete_combo(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM combos WHERE owner_id = v_uid AND id = p_id) THEN
    RAISE EXCEPTION '套餐不存在' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM order_items WHERE owner_id = v_uid AND combo_id = p_id) THEN
    UPDATE combos SET status = 'off_sale', updated_at = now() WHERE owner_id = v_uid AND id = p_id;
    RETURN jsonb_build_object('deleted', false, 'reason', '历史订单已引用该套餐，已改为停售');
  END IF;
  DELETE FROM combos WHERE owner_id = v_uid AND id = p_id;
  RETURN jsonb_build_object('deleted', true);
END;
$fn$;

/* 分类：新建 / 改名 / 同级排序，都在一个入口 */
CREATE OR REPLACE FUNCTION public.save_category(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid     text := auth.uid();
  v_id      bigint := NULLIF(p_payload->>'id', '')::bigint;
  v_name    text := btrim(COALESCE(p_payload->>'name', ''));
  v_parent  bigint := NULLIF(p_payload->>'parent_id', '')::bigint;
  v_dir     integer := NULLIF(p_payload->>'direction', '')::int;
  v_target  bigint := NULLIF(p_payload->>'target_id', '')::bigint;
  v_sort    integer;
  v_row     categories%ROWTYPE;
  v_sib     bigint[];
  v_idx     integer;
  v_to      integer;
  v_i       integer;
  v_idlist  bigint[];
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;

  /* 排序：方向或目标二选一 */
  IF v_id IS NOT NULL AND (v_dir IS NOT NULL OR v_target IS NOT NULL) THEN
    SELECT * INTO v_row FROM categories WHERE owner_id = v_uid AND id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION '分类不存在' USING ERRCODE = 'P0001'; END IF;
    SELECT array_agg(id ORDER BY sort, name) INTO v_sib
    FROM categories
    WHERE owner_id = v_uid AND parent_id IS NOT DISTINCT FROM v_row.parent_id;
    v_idx := array_position(v_sib, v_id);
    IF v_target IS NOT NULL THEN
      v_to := array_position(v_sib, v_target);
      IF v_to IS NULL THEN RAISE EXCEPTION '目标分类不存在' USING ERRCODE = 'P0001'; END IF;
    ELSE
      v_to := v_idx + v_dir;
    END IF;
    IF v_to < 1 OR v_to > array_length(v_sib, 1) OR v_to = v_idx THEN
      RETURN jsonb_build_object('category',
        (SELECT to_jsonb(c) - 'updated_at' FROM categories c WHERE c.owner_id = v_uid AND c.id = v_id));
    END IF;
    v_sib := v_sib[1:v_idx - 1] || v_sib[v_idx + 1:array_length(v_sib, 1)];
    v_sib := v_sib[1:v_to - 1] || v_id || v_sib[v_to:array_length(v_sib, 1)];
    FOR v_i IN 1 .. array_length(v_sib, 1) LOOP
      UPDATE categories SET sort = v_i - 1, updated_at = now()
      WHERE owner_id = v_uid AND id = v_sib[v_i];
    END LOOP;
    RETURN jsonb_build_object('category', (SELECT to_jsonb(c) - 'updated_at' FROM categories c WHERE c.owner_id = v_uid AND c.id = v_id));
  END IF;

  IF v_name = '' THEN RAISE EXCEPTION '请填写分类名称' USING ERRCODE = 'P0001'; END IF;
  IF char_length(v_name) > 12 THEN RAISE EXCEPTION '分类名称请控制在 12 个字以内' USING ERRCODE = 'P0001'; END IF;
  IF v_parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM categories WHERE owner_id = v_uid AND id = v_parent) THEN
    RAISE EXCEPTION '上级分类不存在' USING ERRCODE = 'P0001';
  END IF;
  IF v_parent IS NOT NULL AND EXISTS (SELECT 1 FROM categories WHERE owner_id = v_uid AND id = v_parent AND parent_id IS NOT NULL) THEN
    RAISE EXCEPTION '最多支持两级分类' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM categories
             WHERE owner_id = v_uid AND parent_id IS NOT DISTINCT FROM v_parent
               AND name = v_name AND id IS DISTINCT FROM v_id) THEN
    RAISE EXCEPTION '同级下已有「%」', v_name USING ERRCODE = 'P0001';
  END IF;

  IF v_id IS NULL THEN
    v_id := v3_next_id(v_uid, 'category');
    SELECT COALESCE(max(sort), -1) + 1 INTO v_sort
    FROM categories WHERE owner_id = v_uid AND parent_id IS NOT DISTINCT FROM v_parent;
    INSERT INTO categories (owner_id, id, name, parent_id, sort, created_at, updated_at)
    VALUES (v_uid, v_id, v_name, v_parent, v_sort, now(), now());
  ELSE
    IF NOT EXISTS (SELECT 1 FROM categories WHERE owner_id = v_uid AND id = v_id) THEN
      RAISE EXCEPTION '分类不存在' USING ERRCODE = 'P0001';
    END IF;
    UPDATE categories SET name = v_name, updated_at = now()
    WHERE owner_id = v_uid AND id = v_id;
  END IF;

  RETURN jsonb_build_object('category',
    (SELECT to_jsonb(c) - 'updated_at' FROM categories c WHERE c.owner_id = v_uid AND c.id = v_id));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.delete_category(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid text := auth.uid();
  v_name text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  SELECT name INTO v_name FROM categories WHERE owner_id = v_uid AND id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION '分类不存在' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM categories WHERE owner_id = v_uid AND parent_id = p_id) THEN
    RAISE EXCEPTION '「%」下还有子分类，请先处理', v_name USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM products WHERE owner_id = v_uid AND category_id = p_id) THEN
    RAISE EXCEPTION '还有商品挂在「%」下，不能删除', v_name USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM categories WHERE owner_id = v_uid AND id = p_id;
  RETURN jsonb_build_object('deleted', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.toggle_product(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  UPDATE products SET status = CASE WHEN status = 'on_sale' THEN 'off_sale' ELSE 'on_sale' END, updated_at = now()
  WHERE owner_id = v_uid AND id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION '商品不存在' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('product',
    (SELECT to_jsonb(p) - 'updated_at' - 'category_name' || jsonb_build_object('category', COALESCE(p.category_name, ''))
     FROM products p WHERE p.owner_id = v_uid AND p.id = p_id));
END;
$fn$;

/* 标签：新增 / 改名（同步商品标签关系）/ 删除 */
CREATE OR REPLACE FUNCTION public.save_tag(p_action text, p_from text, p_to text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid  text := auth.uid();
  v_from text := btrim(COALESCE(p_from, ''));
  v_to   text := btrim(replace(COALESCE(p_to, ''), '#', ''));
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;

  IF p_action = 'add' THEN
    IF v_to = '' THEN RAISE EXCEPTION '请填写标签名称' USING ERRCODE = 'P0001'; END IF;
    IF char_length(v_to) > 10 THEN RAISE EXCEPTION '标签太长，控制在 10 个字以内' USING ERRCODE = 'P0001'; END IF;
    INSERT INTO tags (owner_id, name) VALUES (v_uid, v_to) ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('name', v_to);
  ELSIF p_action = 'rename' THEN
    IF v_to = '' THEN RAISE EXCEPTION '请填写标签名称' USING ERRCODE = 'P0001'; END IF;
    IF char_length(v_to) > 10 THEN RAISE EXCEPTION '标签太长，控制在 10 个字以内' USING ERRCODE = 'P0001'; END IF;
    IF v_to <> v_from AND EXISTS (SELECT 1 FROM tags WHERE owner_id = v_uid AND name = v_to) THEN
      RAISE EXCEPTION '标签「%」已存在', v_to USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO tags (owner_id, name) VALUES (v_uid, v_to) ON CONFLICT DO NOTHING;
    /* 关系表没有改名语义，先按新名字补关系，再删旧名字 */
    INSERT INTO product_tags (owner_id, product_id, tag_name)
    SELECT v_uid, pt.product_id, v_to FROM product_tags pt
    WHERE pt.owner_id = v_uid AND pt.tag_name = v_from
    ON CONFLICT DO NOTHING;
    DELETE FROM product_tags WHERE owner_id = v_uid AND tag_name = v_from;
    DELETE FROM tags WHERE owner_id = v_uid AND name = v_from;
    RETURN jsonb_build_object('name', v_to);
  ELSIF p_action = 'delete' THEN
    DELETE FROM product_tags WHERE owner_id = v_uid AND tag_name = v_from;
    DELETE FROM tags WHERE owner_id = v_uid AND name = v_from;
    RETURN jsonb_build_object('deleted', true);
  END IF;

  RAISE EXCEPTION '未知的标签操作：%', COALESCE(p_action, '') USING ERRCODE = 'P0001';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.resolve_alert(p_id bigint, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  PERFORM set_config('TimeZone', 'Asia/Shanghai', true);
  UPDATE stock_alerts SET status = 'resolved', resolved_at = now(),
         resolve_note = COALESCE(NULLIF(btrim(COALESCE(p_note, '')), ''), '已处理'), updated_at = now()
  WHERE owner_id = v_uid AND id = p_id AND status = 'open';
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM stock_alerts WHERE owner_id = v_uid AND id = p_id) THEN
      RETURN jsonb_build_object('alert',
        (SELECT to_jsonb(a) - 'updated_at' FROM stock_alerts a WHERE a.owner_id = v_uid AND a.id = p_id));
    END IF;
    RAISE EXCEPTION '预警记录不存在' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('alert',
    (SELECT to_jsonb(a) - 'updated_at' FROM stock_alerts a WHERE a.owner_id = v_uid AND a.id = p_id));
END;
$fn$;

/* 收款码：只存文件存储路径与文件标识 */
CREATE OR REPLACE FUNCTION public.save_payment_code(p_channel text, p_storage_path text,
                                                   p_file_id text DEFAULT NULL, p_mime text DEFAULT NULL,
                                                   p_size integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid text := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION '登录已过期，请重新登录' USING ERRCODE = 'P0001'; END IF;
  IF p_channel NOT IN ('wechat', 'alipay') THEN
    RAISE EXCEPTION '收款渠道不支持' USING ERRCODE = 'P0001';
  END IF;
  IF NULLIF(btrim(COALESCE(p_storage_path, '')), '') IS NULL THEN
    DELETE FROM payment_codes WHERE owner_id = v_uid AND channel = p_channel;
    RETURN jsonb_build_object('channel', p_channel, 'storage_path', NULL);
  END IF;
  IF p_size IS NOT NULL AND p_size > 3145728 THEN
    RAISE EXCEPTION '收款码图片超过 3MB' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO payment_codes (owner_id, channel, storage_path, file_id, mime, size_bytes, updated_at)
  VALUES (v_uid, p_channel, p_storage_path, p_file_id, p_mime, p_size, now())
  ON CONFLICT (owner_id, channel) DO UPDATE
    SET storage_path = EXCLUDED.storage_path, file_id = EXCLUDED.file_id,
        mime = EXCLUDED.mime, size_bytes = EXCLUDED.size_bytes, updated_at = now();

  RETURN jsonb_build_object('channel', p_channel, 'storage_path', p_storage_path);
END;
$fn$;
