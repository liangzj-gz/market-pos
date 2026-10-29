/* ============================================================
   0001_schema.sql —— v3 字段化表结构
   ------------------------------------------------------------
   设计文档：docs/db-v3-design.md
   执行顺序：0001 → 0002 → 0003 → 0004 → 0010 → 0020

   约定
   - 每张表都带 owner_id，并进入主键；所有外键都是 (owner_id, xxx_id) 复合外键，
     跨账号关联在数据库层就不成立。
   - 金额 numeric(12,2)：精确十进制，单位为元（不用整数分，见设计文档 §4.1）。
   - 时间一律 timestamptz，空值语义逐个保留（NULL = 未填写 / 未发生 / 未盘点）。
   - 业务表只允许服务端 SECURITY DEFINER 函数读写，客户端没有表级权限。

   注意：本文件会先把 v2 的 JSONB 表改名为 legacy_*（只改名、不删行），
   再建同名新表。legacy_* 既是回滚数据源，也是迁移后追平核对的比对对象。
   ============================================================ */

/* ---------- 1. 旧表改名保留（幂等） ---------- */
ALTER TABLE IF EXISTS categories        RENAME TO legacy_categories;
ALTER TABLE IF EXISTS products          RENAME TO legacy_products;
ALTER TABLE IF EXISTS combos            RENAME TO legacy_combos;
ALTER TABLE IF EXISTS orders            RENAME TO legacy_orders;
ALTER TABLE IF EXISTS order_items       RENAME TO legacy_order_items;
ALTER TABLE IF EXISTS adjustments       RENAME TO legacy_adjustments;
ALTER TABLE IF EXISTS movements         RENAME TO legacy_movements;
ALTER TABLE IF EXISTS alerts            RENAME TO legacy_alerts;
ALTER TABLE IF EXISTS meta              RENAME TO legacy_meta;
ALTER TABLE IF EXISTS app_state         RENAME TO legacy_app_state;
ALTER TABLE IF EXISTS id_ranges         RENAME TO legacy_id_ranges;

/* ---------- 2. 账号级 ---------- */

CREATE TABLE IF NOT EXISTS app_meta (
  owner_id        text        NOT NULL DEFAULT auth.uid(),
  schema_version  integer     NOT NULL DEFAULT 3,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id)
);
COMMENT ON TABLE app_meta IS '账号级元信息：schema 版本、初始化时间';

/* id 分配计数器：服务端串行分配，取代 v2 的区间申领，永不撞号 */
CREATE TABLE IF NOT EXISTS id_counters (
  owner_id    text    NOT NULL DEFAULT auth.uid(),
  name        text    NOT NULL,
  next_value  bigint  NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, name)
);
COMMENT ON COLUMN id_counters.next_value IS '下一个可用 id；分配时 UPDATE ... RETURNING next_value - 1';

/* 订单号按日流水：SO + yyyyMMdd + 3 位（超过 999 自动 4 位） */
CREATE TABLE IF NOT EXISTS order_no_counters (
  owner_id  text    NOT NULL DEFAULT auth.uid(),
  day       date    NOT NULL,
  last_seq  integer NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  PRIMARY KEY (owner_id, day)
);

/* 请求幂等记录：同一次用户操作的重试复用 request_id，只执行一次 */
CREATE TABLE IF NOT EXISTS client_requests (
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  request_id  text        NOT NULL,
  kind        text        NOT NULL,
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, request_id)
);
COMMENT ON TABLE client_requests IS '防重复提交：先 INSERT ON CONFLICT DO NOTHING，冲突即返回上次 result';

/* ---------- 3. 主数据 ---------- */

CREATE TABLE IF NOT EXISTS categories (
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  id          bigint      NOT NULL,
  name        text        NOT NULL,
  parent_id   bigint,
  sort        integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT categories_name_ck   CHECK (char_length(btrim(name)) BETWEEN 1 AND 12),
  CONSTRAINT categories_self_ck   CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT categories_parent_fk FOREIGN KEY (owner_id, parent_id)
    REFERENCES categories (owner_id, id) ON DELETE RESTRICT,
  /* 同级同名禁止，NULL 父级（大类）也生效 */
  CONSTRAINT categories_sibling_uk UNIQUE NULLS NOT DISTINCT (owner_id, parent_id, name)
);
COMMENT ON COLUMN categories.parent_id IS 'NULL = 大类；最多两级，层级由服务端函数校验';

CREATE TABLE IF NOT EXISTS products (
  owner_id      text          NOT NULL DEFAULT auth.uid(),
  id            bigint        NOT NULL,
  sku_code      text          NOT NULL,
  name          text          NOT NULL,
  category_id   bigint,
  series        text          NOT NULL DEFAULT '',
  category_name text,
  unit          text          NOT NULL DEFAULT '件',
  list_price    numeric(12,2) NOT NULL DEFAULT 0 CHECK (list_price >= 0),
  cost_price    numeric(12,2)          CHECK (cost_price IS NULL OR cost_price >= 0),
  safety_stock  integer       NOT NULL DEFAULT 0 CHECK (safety_stock >= 0),
  barcode       text,
  image_path    text,
  status        text          NOT NULL DEFAULT 'on_sale' CHECK (status IN ('on_sale','off_sale')),
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT products_name_ck     CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  CONSTRAINT products_category_fk FOREIGN KEY (owner_id, category_id)
    REFERENCES categories (owner_id, id) ON DELETE RESTRICT,
  CONSTRAINT products_sku_uk      UNIQUE (owner_id, sku_code),
  CONSTRAINT products_barcode_uk  UNIQUE (owner_id, barcode)
);
COMMENT ON COLUMN products.cost_price    IS 'NULL = 未填成本（不等同于 0）';
COMMENT ON COLUMN products.series        IS '分类路径快照，统计与开单筛选用';
COMMENT ON COLUMN products.category_name IS '中类名快照（旧字段 category），商品改名/换类不影响历史展示';

/* 标签词库与商品-标签关系（替代原 products.tags 数组） */
CREATE TABLE IF NOT EXISTS tags (
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  name        text        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 10),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, name)
);

CREATE TABLE IF NOT EXISTS product_tags (
  owner_id    text   NOT NULL DEFAULT auth.uid(),
  product_id  bigint NOT NULL,
  tag_name    text   NOT NULL,
  PRIMARY KEY (owner_id, product_id, tag_name),
  CONSTRAINT product_tags_product_fk FOREIGN KEY (owner_id, product_id)
    REFERENCES products (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT product_tags_tag_fk FOREIGN KEY (owner_id, tag_name)
    REFERENCES tags (owner_id, name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS combos (
  owner_id        text          NOT NULL DEFAULT auth.uid(),
  id              bigint        NOT NULL,
  combo_code      text          NOT NULL,
  name            text          NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  combo_price     numeric(12,2) NOT NULL DEFAULT 0 CHECK (combo_price >= 0),
  original_price  numeric(12,2)          CHECK (original_price IS NULL OR original_price >= 0),
  status          text          NOT NULL DEFAULT 'on_sale' CHECK (status IN ('on_sale','off_sale')),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT combos_code_uk UNIQUE (owner_id, combo_code)
);

/* 套餐固定明细：历史订单按它展开库存与销量，编辑套餐时不得清空 */
CREATE TABLE IF NOT EXISTS combo_items (
  owner_id    text    NOT NULL DEFAULT auth.uid(),
  combo_id    bigint  NOT NULL,
  product_id  bigint  NOT NULL,
  quantity    integer NOT NULL CHECK (quantity > 0),
  sort        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, combo_id, product_id),
  CONSTRAINT combo_items_combo_fk   FOREIGN KEY (owner_id, combo_id)
    REFERENCES combos (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT combo_items_product_fk FOREIGN KEY (owner_id, product_id)
    REFERENCES products (owner_id, id) ON DELETE RESTRICT
);

/* 子套餐：某个中类里选 N 件 */
CREATE TABLE IF NOT EXISTS combo_groups (
  owner_id        text    NOT NULL DEFAULT auth.uid(),
  combo_id        bigint  NOT NULL,
  category_id     bigint  NOT NULL,
  category_l1_id  bigint,
  quantity        integer NOT NULL CHECK (quantity > 0),
  sort            integer NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_id, combo_id, category_id),
  CONSTRAINT combo_groups_combo_fk FOREIGN KEY (owner_id, combo_id)
    REFERENCES combos (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT combo_groups_category_fk FOREIGN KEY (owner_id, category_id)
    REFERENCES categories (owner_id, id) ON DELETE RESTRICT
);

/* 子套餐可选商品池；为空表示该中类全部在售商品都可选 */
CREATE TABLE IF NOT EXISTS combo_group_products (
  owner_id     text   NOT NULL DEFAULT auth.uid(),
  combo_id     bigint NOT NULL,
  category_id  bigint NOT NULL,
  product_id   bigint NOT NULL,
  PRIMARY KEY (owner_id, combo_id, category_id, product_id),
  CONSTRAINT combo_group_products_group_fk FOREIGN KEY (owner_id, combo_id, category_id)
    REFERENCES combo_groups (owner_id, combo_id, category_id) ON DELETE CASCADE,
  CONSTRAINT combo_group_products_product_fk FOREIGN KEY (owner_id, product_id)
    REFERENCES products (owner_id, id) ON DELETE RESTRICT
);

/* ---------- 4. 交易 ---------- */

CREATE TABLE IF NOT EXISTS orders (
  owner_id       text          NOT NULL DEFAULT auth.uid(),
  id             bigint        NOT NULL,
  order_no       text          NOT NULL,
  status         text          NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled')),
  channel        text                   CHECK (channel IN ('wechat','alipay','cash')),
  total_amount   numeric(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  paid_amount    numeric(12,2)          CHECK (paid_amount IS NULL OR paid_amount >= 0),
  item_count     integer       NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  note           text,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  paid_at        timestamptz,
  cancelled_at   timestamptz,
  cancel_reason  text,
  request_id     text,
  updated_at     timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT orders_no_uk UNIQUE (owner_id, order_no),
  /* 业务口径写进约束：已收款必须有渠道/金额/时间；待收款不允许有收款信息；已冲销必须有冲销时间 */
  CONSTRAINT orders_paid_ck      CHECK (status <> 'paid'      OR (paid_at IS NOT NULL AND paid_amount IS NOT NULL AND channel IS NOT NULL)),
  CONSTRAINT orders_pending_ck   CHECK (status <> 'pending'   OR (paid_amount IS NULL AND paid_at IS NULL)),
  CONSTRAINT orders_cancelled_ck CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);
COMMENT ON COLUMN orders.paid_amount IS 'NULL = 未收款；实收与应收的差额落在 adjustments';
COMMENT ON COLUMN orders.request_id  IS '建单幂等键，网络超时重试不会重复建单';

CREATE TABLE IF NOT EXISTS order_items (
  owner_id      text          NOT NULL DEFAULT auth.uid(),
  id            bigint        NOT NULL,
  order_id      bigint        NOT NULL,
  line_no       integer       NOT NULL CHECK (line_no >= 1),
  item_type     text          NOT NULL CHECK (item_type IN ('product','combo')),
  product_id    bigint,
  combo_id      bigint,
  product_name  text          NOT NULL,
  quantity      integer       NOT NULL CHECK (quantity > 0),
  unit_price    numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_amount   numeric(12,2) NOT NULL DEFAULT 0 CHECK (line_amount >= 0),
  is_gift       boolean       NOT NULL DEFAULT false,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  updated_at    timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT order_items_line_uk   UNIQUE (owner_id, order_id, line_no),
  CONSTRAINT order_items_order_fk  FOREIGN KEY (owner_id, order_id)
    REFERENCES orders (owner_id, id) ON DELETE RESTRICT,
  CONSTRAINT order_items_product_fk FOREIGN KEY (owner_id, product_id)
    REFERENCES products (owner_id, id) ON DELETE RESTRICT,
  CONSTRAINT order_items_combo_fk  FOREIGN KEY (owner_id, combo_id)
    REFERENCES combos (owner_id, id) ON DELETE RESTRICT,
  /* 商品行必须有商品、套餐行必须有套餐，二选一 */
  CONSTRAINT order_items_type_ck CHECK (
    (item_type = 'product' AND product_id IS NOT NULL AND combo_id IS NULL) OR
    (item_type = 'combo'   AND combo_id  IS NOT NULL AND product_id IS NULL)
  ),
  /* R2：赠品金额必须为 0 */
  CONSTRAINT order_items_gift_ck CHECK (NOT is_gift OR line_amount = 0)
);
COMMENT ON COLUMN order_items.product_name IS '名称快照：商品改名不影响历史订单展示';
COMMENT ON COLUMN order_items.line_no      IS '行序（1 起），保留原数组顺序';

/* 套餐选品快照：套餐后续被编辑，历史订单按快照扣减与展示 */
CREATE TABLE IF NOT EXISTS order_item_selections (
  owner_id       text    NOT NULL DEFAULT auth.uid(),
  order_item_id  bigint  NOT NULL,
  category_id    bigint  NOT NULL,
  product_id     bigint  NOT NULL,
  quantity       integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (owner_id, order_item_id, category_id, product_id),
  CONSTRAINT order_item_selections_item_fk FOREIGN KEY (owner_id, order_item_id)
    REFERENCES order_items (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT order_item_selections_category_fk FOREIGN KEY (owner_id, category_id)
    REFERENCES categories (owner_id, id) ON DELETE RESTRICT,
  CONSTRAINT order_item_selections_product_fk FOREIGN KEY (owner_id, product_id)
    REFERENCES products (owner_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS adjustments (
  owner_id     text          NOT NULL DEFAULT auth.uid(),
  id           bigint        NOT NULL,
  order_id     bigint        NOT NULL,
  adjust_type  text          NOT NULL,
  amount       numeric(12,2) NOT NULL CHECK (amount <> 0),
  reason       text,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT adjustments_order_fk FOREIGN KEY (owner_id, order_id)
    REFERENCES orders (owner_id, id) ON DELETE RESTRICT,
  /* 与前端 ADJUST_TYPES 同一份清单，脏值进不来；新增原因需一次 ALTER */
  CONSTRAINT adjustments_type_ck CHECK (adjust_type IN ('抹零让利','满赠赠送','临时改价','多收待退','少收挂账','录入更正'))
);
COMMENT ON COLUMN adjustments.amount IS '正数=多收待退/更正，负数=让价少收';

CREATE TABLE IF NOT EXISTS movements (
  owner_id       text        NOT NULL DEFAULT auth.uid(),
  id             bigint      NOT NULL,
  product_id     bigint      NOT NULL,
  movement_type  text        NOT NULL CHECK (movement_type IN ('in','out','adjust','reversal')),
  quantity       integer     NOT NULL CHECK (quantity <> 0),
  balance_after  integer,
  ref_type       text                 CHECK (ref_type IN ('order','purchase','stocktake')),
  order_id       bigint,
  ref_no         text,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT movements_product_fk FOREIGN KEY (owner_id, product_id)
    REFERENCES products (owner_id, id) ON DELETE RESTRICT,
  CONSTRAINT movements_order_fk FOREIGN KEY (owner_id, order_id)
    REFERENCES orders (owner_id, id) ON DELETE RESTRICT,
  /* 订单流水才有真实订单外键，采购/盘点单不复用 ref_id，避免假外键 */
  CONSTRAINT movements_ref_ck CHECK ((ref_type = 'order') = (order_id IS NOT NULL))
);
COMMENT ON COLUMN movements.quantity      IS '带符号：入库/回补为正，出库/盘亏为负';
COMMENT ON COLUMN movements.balance_after IS 'NULL = 当时该商品未盘点（不建账、不滚余额）';

/* 库存余额：无行 = 未盘点；有行且 quantity = 0 = 余额为零 */
CREATE TABLE IF NOT EXISTS inventory_balances (
  owner_id    text        NOT NULL DEFAULT auth.uid(),
  product_id  bigint      NOT NULL,
  quantity    integer     NOT NULL,
  counted_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, product_id),
  CONSTRAINT inventory_balances_product_fk FOREIGN KEY (owner_id, product_id)
    REFERENCES products (owner_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE inventory_balances IS '每个账号每个商品一条；没有行就是未盘点，行在且为 0 才是真的没货';

CREATE TABLE IF NOT EXISTS stock_alerts (
  owner_id      text        NOT NULL DEFAULT auth.uid(),
  id            bigint      NOT NULL,
  product_id    bigint      NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('low','negative')),
  quantity      integer     NOT NULL,
  threshold     integer     NOT NULL DEFAULT 0 CHECK (threshold >= 0),
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  ref_type      text,
  ref_no        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolve_note  text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  CONSTRAINT stock_alerts_product_fk FOREIGN KEY (owner_id, product_id)
    REFERENCES products (owner_id, id) ON DELETE RESTRICT
);
COMMENT ON COLUMN stock_alerts.threshold IS '触发当时的安全库存快照，后来改阈值不影响历史记录';

CREATE TABLE IF NOT EXISTS payment_codes (
  owner_id      text        NOT NULL DEFAULT auth.uid(),
  channel       text        NOT NULL CHECK (channel IN ('wechat','alipay')),
  storage_path  text        NOT NULL,
  file_id       text,
  mime          text,
  size_bytes    integer     CHECK (size_bytes IS NULL OR size_bytes <= 3145728),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, channel)
);
COMMENT ON TABLE payment_codes IS '收款码图片存文件存储，这里只保存路径与文件标识；不再把 base64 写进数据库';
