-- 0011_product_image.sql —— 商品图（2026-10-29）
-- 1) 商品表增加 image_path（Storage 路径，users/<uid>/products/...）
-- 2) 更新商品写入函数，接受 image_path；客户端不传则保留原图
-- 幂等，可重复执行。

ALTER TABLE products ADD COLUMN IF NOT EXISTS image_path text;

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
  v_image    text := NULLIF(btrim(COALESCE(p_payload->>'image_path', '')), '');
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
  IF v_image IS NOT NULL AND v_image NOT LIKE 'users/%' THEN
    RAISE EXCEPTION '图片路径不合法' USING ERRCODE = 'P0001';
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
                          list_price, cost_price, safety_stock, barcode, image_path, status, created_at, updated_at)
    VALUES (p_owner, v_id, v_sku, v_name, v_cat, v_series, v_cat_name,
            COALESCE(NULLIF(btrim(COALESCE(p_payload->>'unit', '')), ''), '件'),
            round(COALESCE((p_payload->>'list_price')::numeric, 0), 2),
            CASE WHEN p_payload->>'cost_price' IS NULL OR btrim(p_payload->>'cost_price') IN ('', 'null')
                 THEN NULL ELSE round((p_payload->>'cost_price')::numeric, 2) END,
            GREATEST(COALESCE((p_payload->>'safety_stock')::int, 0), 0),
            v_barcode,
            v_image,
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
      image_path = CASE WHEN p_payload ? 'image_path' THEN v_image ELSE image_path END,
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
