/* ============================================================
   0004_grants.sql —— 权限收紧
   ------------------------------------------------------------
   目标（server-only 模式）：
   - 业务表：ENABLE RLS + 零策略 + 不给 anon/authenticated 任何表权限。
     客户端只能通过 SECURITY DEFINER 函数读写，账号隔离由函数里的 auth.uid() 保证。
   - 函数：REVOKE ALL FROM PUBLIC / anon，只 GRANT EXECUTE TO authenticated。
   - 顺手修掉 v2 遗留的两个安全隐患：
     ① app_state_backup_20261025 曾对 anon 开放 SELECT（publishableKey 是公开的，
        等于任何人能读全部订单与商品成本）；
     ② legacy_* 旧表同样不允许客户端直连。
   ============================================================ */

/* ---------- 1. 业务表：关掉直连 ---------- */
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'app_meta','id_counters','order_no_counters','client_requests',
    'categories','products','tags','product_tags','combos',
    'combo_items','combo_groups','combo_group_products',
    'orders','order_items','order_item_selections','adjustments','movements',
    'inventory_balances','stock_alerts','payment_codes'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', t);
  END LOOP;
END $$;

/* ---------- 2. 旧表与备份表：只留给服务端对账，客户端一律读不到 ---------- */
DO $$
DECLARE
  t text;
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND (c.relname LIKE 'legacy\_%' OR c.relname LIKE 'bak\_%' OR c.relname = 'app_state_backup_20261025')
  LOOP
    t := r.relname;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', t);
  END LOOP;
END $$;

/* ---------- 3. 函数：只给已登录用户；内部 helper 谁都不给 ---------- */
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig, p.prosecdef, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f.sig);
    /* 只有 SECURITY DEFINER 的对外接口给登录用户；v3_ 前缀的内部 helper 只供服务端调用 */
    IF f.prosecdef AND f.proname NOT LIKE 'v3\_%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
    END IF;
  END LOOP;
END $$;

/* ---------- 4. 自检：以下查询应返回 0 行 ---------- */
-- SELECT c.relname, a.grantee, a.privilege_type
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- CROSS JOIN LATERAL aclexplode(c.relacl) a
-- WHERE n.nspname='public' AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole);
