/* ============================================================
   数据仓库（云端字段化 v3）

   v3 起云端按 20 张字段化表存储（商品/订单/明细/调整/流水/余额…），
   客户端对表零直连权限，读写全部走服务端 SECURITY DEFINER 函数：

   - load_snapshot()   登录后拉主数据快照（商品/分类/套餐/余额/预警）
   - dashboard()       今日看板聚合（今日/昨日/近30天/待收款/最近订单）
   - list_orders()     订单分页查询（服务端筛选 + 聚合）
   - get_order()       订单详情（明细 + 选品快照 + 调整 + 流水）
   - list_movements()  库存流水分页
   - stats_summary()   统计聚合（服务端计算）
   - create_order / order_action / stock_action / save_product /
     import_products / save_combo / delete_combo / save_category /
     delete_category / save_tag / toggle_product / resolve_alert /
     save_payment_code … 全部写接口，带幂等键防重复提交

   前端 db 只做缓存：主数据在快照里，订单/流水按页拉取进缓存池。
   所有写操作立即调 RPC，成功后按返回值更新缓存并后台刷新快照。

   ?preview=1 预览模式：跳过登录灌种子数据，写操作退回前端规则引擎，
   不调用任何云端接口（用于 iPad / 手机等非同源环境的本地调试）。
   ============================================================ */

import {
  createDb, productById, comboById, orderById, balanceOf, isCounted,
  itemsOfOrder, adjustmentsOfOrder, movementsOf, openAlertsOf,
  createOrder, confirmOrder, cancelOrder, stockIn, setStock,
  upsertProduct, toggleProductStatus, upsertCombo, deleteCombo,
  resolveAlert, buildStats, syncAlerts, expandCombo, computeTotal,
  deriveComboGroups, comboPartsOfOrderItem, comboSelectionsFromItems, productsInMid,
  buildCategoryTree, collapseCategoryDepth, categoryById, categoryPath, categoryLabel, categoryLevel,
  childrenOf, categoryProductCount, upsertCategory, moveCategory, moveCategoryTo,
  deleteCategory as deleteCategoryRule,
  addTag as addTagRule, renameTag as renameTagRule, deleteTag as deleteTagRule
} from '../domain/rules.js';
import { num, r2, int, ymd, pad, startOfDay, addDays, daysBetween } from '../util/format.js';
import { matchCategoryPath } from '../domain/import.js';
import { fillProductBarcodes } from '../domain/barcode.js';
import { SEED_PRODUCTS, SEED_COMBOS, SEED_ORDERS, SEED_OPENING_AT, SEED_TAGS } from './seed.js';
import {
  cloudAvailable, getSession, phoneOf,
  signInWithPassword, sendOtp, verifyOtp, signOut as cloudSignOut,
  changePassword as changePasswordRemote
} from './cloud.js';
import {
  rpc, newRequestId, uploadPaymentCodeImage, signPaymentCodePath, signProductImagePath, removeStorageObject,
  SELF_HOSTED, selfHostLogin, selfHostSetup, setSelfHostToken, selfHostToken
} from './api.js';

/* 登录页据此切换形态：自托管 = 密码登录 + 首次建号（无短信） */
export const SELF_HOST_LOGIN = SELF_HOSTED;

const { reactive, computed } = window.Vue;

/* 预览模式：URL 带 ?preview=1 时跳过登录，直接灌 29 笔种子数据 */
export const PREVIEW = typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('preview');

/* 只记「上次登录的手机号」这一条 UI 偏好，绝不存业务数据 */
const PHONE_KEY = 'stall.cloud.phone.v1';

/* 预览模式的商品图（仅本机演示，512px 小图，最多几 MB） */
const PREVIEW_IMAGE_KEY = 'market-pos-preview-product-images';
function loadPreviewImages() {
  try { return JSON.parse(localStorage.getItem(PREVIEW_IMAGE_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function persistPreviewImage(productId, dataUrl) {
  const map = { ...(store.db.previewImages || {}) };
  if (dataUrl) map[productId] = dataUrl;
  else delete map[productId];
  localStorage.setItem(PREVIEW_IMAGE_KEY, JSON.stringify(map));
  store.db.previewImages = map;
}

/* 图片路径 → 可展示地址：预览读本机、云端按需签名（同一张只签一次）。
   签名 URL 有效期 3600 秒，缓存 45 分钟视为过期并后台续签，页面长开图片不会失效。 */
const SIGNED_URL_TTL_MS = 45 * 60 * 1000;
const pendingImages = new Set();
export function productImageSrc(p) {
  if (!p) return '';
  if (PREVIEW) return store.db.previewImages?.[p.id] || '';
  if (!p.image_path || /^data:image\//.test(p.image_path)) return p.image_path || '';
  if (!store.db.productImageUrls) store.db.productImageUrls = {};
  const cached = store.db.productImageUrls[p.id];
  if (cached && Date.now() - cached.at < SIGNED_URL_TTL_MS) return cached.url;
  if (!pendingImages.has(p.id)) {
    pendingImages.add(p.id);
    /* 过期缓存先顶着显示，签好新地址再无缝换掉 */
    signProductImagePath(p.image_path)
      .then(url => { if (url) store.db.productImageUrls[p.id] = { url, at: Date.now() }; })
      .finally(() => pendingImages.delete(p.id));
  }
  return cached ? cached.url : '';
}

export async function loadProductImage(p) {
  if (!p || !p.image_path) return '';
  if (PREVIEW) return store.db.previewImages?.[p.id] || '';
  if (/^data:image\//.test(p.image_path)) return p.image_path;
  if (!store.db.productImageUrls) store.db.productImageUrls = {};
  const cached = store.db.productImageUrls[p.id];
  if (cached && Date.now() - cached.at < SIGNED_URL_TTL_MS) return cached.url;
  const url = await signProductImagePath(p.image_path);
  if (url) store.db.productImageUrls[p.id] = { url, at: Date.now() };
  return url;
}

/* ============================================================
   建库（仅预览模式）：主数据 → 期初建账 → 回放 29 笔历史订单
   ============================================================ */
export function buildSeedDb() {
  const db = createDb();

  const idByName = {};
  /* 第 8 列原为货位，现已废弃，跳过不写入商品 */
  SEED_PRODUCTS.forEach(([name, series, category, list_price, cost_price, opening, safety_stock, , sku_code]) => {
    const p = {
      id: db.seq.product++, sku_code, name, series, category, unit: '件',
      list_price, cost_price, safety_stock, barcode: null,
      status: 'on_sale', created_at: SEED_OPENING_AT,
      tags: SEED_TAGS[name] ? [...SEED_TAGS[name]] : []
    };
    db.products.push(p);
    idByName[name] = p.id;
  });

  /* 由品类生成两级分类树，并把每个商品挂到中类 */
  buildCategoryTree(db);
  db.tags = Array.from(new Set(db.products.flatMap(p => p.tags || [])));

  SEED_COMBOS.forEach(([name, combo_price, original_price, items]) => {
    const combo = {
      id: db.seq.combo++, combo_code: 'C' + String(db.combos.length + 1).padStart(2, '0'),
      name, combo_price, original_price, status: 'on_sale',
      items: items.map(([pname, quantity]) => ({ product_id: idByName[pname], quantity }))
    };
    combo.groups = deriveComboGroups(db, combo.items);
    db.combos.push(combo);
  });

  /* 期初建账：一次入库，把库存余额从「未盘点」变成有账可查 */
  stockIn(db, SEED_PRODUCTS.map(([name, , , , , opening]) => ({
    product_id: idByName[name], quantity: opening
  })), '期初建账', SEED_OPENING_AT);

  /* 历史订单：原表有「收款时间早于下单日期」的补录错位，取早者为下单、晚者为收款 */
  const rows = SEED_ORDERS.map(o => {
    const a = new Date(o.at).getTime();
    const b = new Date(o.paidAt).getTime();
    return { ...o, createdIso: new Date(Math.min(a, b)).toISOString(), paidIso: new Date(Math.max(a, b)).toISOString() };
  }).sort((x, y) => (x.createdIso < y.createdIso ? -1 : 1));

  rows.forEach(o => {
    const lines = o.items.map(([ref, quantity, unit_price, gift]) => {
      if (String(ref).startsWith('#')) {
        const name = String(ref).slice(1);
        const c = db.combos.find(x => x.name === name);
        return {
          item_type: 'combo', combo_id: c.id, product_name: name, quantity, unit_price, is_gift: false,
          selections: comboSelectionsFromItems(db, c.items || [])
        };
      }
      return {
        item_type: 'product', product_id: idByName[ref], product_name: ref,
        quantity, unit_price, is_gift: !!gift
      };
    });
    const total = computeTotal(db, lines);
    const diff = r2(num(o.paid) - total);
    createOrder(db, {
      lines,
      note: o.note || null,
      channel: o.channel,
      paidAmount: o.paid,
      settle: true,
      createdAt: o.createdIso,
      paidAt: o.paidIso,
      adjustType: diff === 0 ? null : (o.adjustType || (diff < 0 ? '抹零让利' : '录入更正')),
      adjustReason: diff === 0 ? null : (o.adjustReason || '历史数据导入：实收与明细合计差额')
    });
  });

  syncAlerts(db);
  fillProductBarcodes(db);
  if (PREVIEW) {
    try { db.paymentCodes = JSON.parse(localStorage.getItem('market-pos-preview-payment-codes') || '{}'); } catch { db.paymentCodes = {}; }
  }
  return db;
}

/* ============================================================
   数据整形
   ============================================================ */
/* reactive 代理不能直接丢给 JSON 序列化，先拍平成纯对象 */
function toPlain(db) { return JSON.parse(JSON.stringify(db)); }

/* 老数据补字段：只补分类树与标签，不动订单和库存（预览与导入用） */
function migrate(db) {
  if (!db || typeof db !== 'object') return createDb();
  ['products', 'combos', 'orders', 'orderItems', 'adjustments', 'movements', 'alerts'].forEach(k => {
    if (!Array.isArray(db[k])) db[k] = [];
  });
  if (!db.categories) db.categories = [];
  if (!db.tags) db.tags = [];
  if (!db.seq) db.seq = {};
  if (!db.balances || typeof db.balances !== 'object') db.balances = {};
  db.products.forEach(p => {
    if (!Array.isArray(p.tags)) p.tags = [];
    delete p.location;
  });
  buildCategoryTree(db);
  collapseCategoryDepth(db);
  fillProductBarcodes(db);
  db.combos.forEach(c => {
    if (!Array.isArray(c.items)) c.items = [];
    if (!Array.isArray(c.groups)) c.groups = [];
    /* 旧套餐按固定商品所属中类派生出自选子套餐；items 继续留给历史订单 */
    if (!c.groups.length) c.groups = deriveComboGroups(db, c.items);
    c.groups = c.groups.map(g => {
      const mid = categoryById(db, g.category_id);
      if (!mid) return g;
      let productIds = Array.isArray(g.product_ids) ? g.product_ids.map(Number).filter(Boolean) : [];
      if (!productIds.length) {
        const fromItems = [];
        (c.items || []).forEach(it => {
          const p = productById(db, it.product_id);
          if (p && p.category_id && categoryPath(db, p.category_id).some(cat => cat.id === mid.id) && !fromItems.includes(p.id)) {
            fromItems.push(p.id);
          }
        });
        productIds = fromItems.length ? fromItems : productsInMid(db, mid.id).map(p => p.id);
      }
      return {
        category_l1_id: mid.parent_id || null,
        category_id: mid.id,
        quantity: Math.max(1, int(g.quantity) || 1),
        product_ids: productIds
      };
    });
  });
  db.tags = Array.from(new Set([...db.tags, ...db.products.flatMap(p => p.tags || [])]));
  return db;
}

/* ============================================================
   Store
   ============================================================ */
export const store = reactive({
  ready: false,
  loaded: false,
  uid: null,                     // 登录用户 id（Storage 路径要用）
  db: createDb(),                // 缓存：主数据 + 已拉取的订单/流水
  counts: null,                  // load_snapshot 的 counts（数据总览）
  dash: null,                    // dashboard() 结果（今日页）
  ordersPage: {                  // 订单页分页状态
    rows: [], total: 0, sumPaid: 0, pendingTotal: 0,
    limit: 30, offset: 0, loading: false, loaded: false, hasMore: false, query: null
  },
  details: {},                   // 订单详情缓存 id -> get_order 结果
  detailsLoading: {},
  stats: null,                   // stats_summary() 结果
  statsLoading: false,
  savedAt: null,
  auth: { status: 'loading', phone: '', error: '' },   // loading | anon | ready
  sync: { state: 'idle', error: '' },                  // idle | saving | saved | unsynced
  ui: {
    view: 'today',
    sheet: null,          // { type, ...payload }
    toasts: [],
    cart: [],             // [{ key, type, id, name, price, qty, gift }]
    cartNote: '',
    cartOpen: false,
    register: { search: '', series: '全部', onlyFrequent: false }
  }
});

let toastSeq = 0;
export function toast(message, kind = 'info') {
  const id = ++toastSeq;
  store.ui.toasts.push({ id, message, kind });
  setTimeout(() => {
    const i = store.ui.toasts.findIndex(t => t.id === id);
    if (i >= 0) store.ui.toasts.splice(i, 1);
  }, kind === 'warn' ? 4200 : 2800);
}

/* ============================================================
   CSV 导出（给 Excel 看账用）
   buildCsv 是纯函数：传 plain db，返回 { filename, label, text }
   ============================================================ */
const CSV_KINDS = {
  orders:   { label: '订单',     header: ['订单号', '状态', '下单时间', '收款时间', '收款渠道', '件数', '应收', '实收', '备注'] },
  items:    { label: '订单明细', header: ['订单号', '下单时间', '类型', '商品', '数量', '单价', '行金额', '赠品'] },
  products: { label: '商品库存', header: ['ID', '商品名', '分类', '系列', '单位', '售价', '成本', '安全库存', '当前库存', '状态', '条码'] }
};
const csvEsc = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvLocal = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const CSV_CHANNEL = { wechat: '微信', alipay: '支付宝', cash: '现金' };
const CSV_STATUS = { pending: '待收款', paid: '已收款', cancelled: '已冲销' };

export function buildCsv(kind, db) {
  const kindCfg = CSV_KINDS[kind];
  if (!kindCfg || !db) return null;
  let rows;
  if (kind === 'orders') {
    rows = (db.orders || []).slice().sort((a, b) => a.id - b.id).map(o => [
      o.order_no, CSV_STATUS[o.status] || o.status, csvLocal(o.created_at), csvLocal(o.paid_at),
      CSV_CHANNEL[o.channel] || '', o.item_count, o.total_amount,
      o.status === 'paid' ? o.paid_amount : '', o.note || ''
    ]);
  } else if (kind === 'items') {
    const byId = new Map((db.orders || []).map(o => [o.id, o]));
    rows = (db.orderItems || []).slice().sort((a, b) => a.id - b.id).map(it => {
      const o = byId.get(it.order_id) || {};
      return [
        o.order_no !== undefined ? o.order_no : it.order_id, csvLocal(o.created_at),
        it.item_type === 'combo' ? '套餐' : '商品', it.product_name,
        it.quantity, it.unit_price, it.line_amount, it.is_gift ? '是' : ''
      ];
    });
  } else {
    rows = (db.products || []).slice().sort((a, b) => a.id - b.id).map(p => [
      p.id, p.name, p.category || '', p.series || '', p.unit || '件',
      p.list_price, p.cost_price === null || p.cost_price === undefined ? '' : p.cost_price,
      p.safety_stock === null || p.safety_stock === undefined ? '' : p.safety_stock,
      db.balances && db.balances[p.id] !== undefined ? db.balances[p.id] : '',
      p.status === 'off_sale' ? '停售' : '在售', p.barcode || ''
    ]);
  }
  /* BOM 头：Excel 直接打开中文不乱码；CRLF 兼容 Excel 换行 */
  const text = '\uFEFF' + [kindCfg.header, ...rows].map(r => r.map(csvEsc).join(',')).join('\r\n');
  return { filename: `摆摊订单管家-${kindCfg.label}-${ymd(new Date())}.csv`, label: kindCfg.label, text };
}

/* ============================================================
   云端快照装配
   ============================================================ */

/* 服务端返回的 numeric 序列化为 JSON number，个别字段可能是字符串，统一转 */
function normalizeProduct(p) {
  const out = { ...p };
  if (out.category === undefined) out.category = out.category_name || '';
  delete out.category_name;
  if (!Array.isArray(out.tags)) out.tags = [];
  return out;
}

function mergeProduct(rec) {
  const p = normalizeProduct(rec);
  /* 图片路径变了才丢掉旧签名地址（同路径保留缓存，省一次签名请求） */
  const i = store.db.products.findIndex(x => Number(x.id) === Number(p.id));
  const prev = i >= 0 ? store.db.products[i] : null;
  if (prev && prev.image_path !== p.image_path && store.db.productImageUrls) {
    delete store.db.productImageUrls[p.id];
  }
  if (i >= 0) store.db.products.splice(i, 1, { ...prev, ...p });
  else store.db.products.push(p);
}

/* 收款码路径 → 签名 URL（异步 hydrate，失败留空）。
   签名有效期 3600 秒：登录/保存时签名一次；settings 页打开时若已过 45 分钟则后台续签 */
async function hydratePaymentCodes(paths) {
  const out = {};
  await Promise.all(Object.entries(paths || {}).map(async ([ch, path]) => {
    out[ch] = await signPaymentCodePath(path);
  }));
  store.db.paymentCodes = out;
  store.db.paymentCodesAt = Date.now();
}

/* 收款码签名到期续签（供设置页打开时调用：过期则重签，未到期直接返回） */
export async function refreshPaymentCodesIfNeeded() {
  if (PREVIEW) return;
  const paths = store.db.paymentCodePaths || {};
  if (!Object.keys(paths).length) return;
  if (store.db.paymentCodesAt && Date.now() - store.db.paymentCodesAt < SIGNED_URL_TTL_MS) return;
  await hydratePaymentCodes(paths);
}

/* 把 load_snapshot 的返回装配进 store（orders/orderItems 由各页按需拉取） */
function assembleSnapshot(d) {
  const db = store.db;
  db.categories = d.categories || [];
  db.products = (d.products || []).map(normalizeProduct);
  db.productImageUrls = {};
  db.tags = d.tags || [];
  db.combos = d.combos || [];
  db.balances = d.balances && typeof d.balances === 'object' ? d.balances : {};
  db.alerts = d.alerts || [];
  db.movements = d.movements || [];
  db.orders = [];
  db.orderItems = [];
  db.adjustments = [];
  db.seq = { order: 1, item: 1, adj: 1, mov: 1, alert: 1, product: 1, combo: 1, category: 1 };
  store.counts = d.counts || null;
  migrate(db);
  store.db.paymentCodePaths = d.paymentCodes || {};
  hydratePaymentCodes(d.paymentCodes || {});
}

/* 后台静默刷新主数据（写操作成功后调用，不阻断 UI） */
let refreshing = null;
export async function refreshMaster() {
  if (PREVIEW) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await rpc('load_snapshot');
      if (res.ok) assembleSnapshot(res.data);
    } finally { refreshing = null; }
  })();
  return refreshing;
}

/* ---------- dashboard ---------- */
export async function ensureDashboard(force) {
  if (PREVIEW) return;
  if (!force && store.dash) return;
  const res = await rpc('dashboard');
  if (res.ok) store.dash = res.data;
}

/* ---------- 订单分页查询 ---------- */
export async function fetchOrdersPage(query, opts = {}) {
  if (PREVIEW) return;
  const page = store.ordersPage;
  const q = {
    from: query.from || null, to: query.to || null,
    status: query.status || null, channel: query.channel || null,
    keyword: query.keyword || null
  };
  const reset = !!opts.reset;
  const offset = reset ? 0 : page.offset;
  page.loading = true;
  const res = await rpc('list_orders', {
    p_from: q.from, p_to: q.to, p_status: q.status, p_channel: q.channel,
    p_keyword: q.keyword, p_limit: page.limit, p_offset: offset
  });
  page.loading = false;
  if (!res.ok) { store.sync.error = res.error; return; }
  const d = res.data || {};
  page.query = q;
  page.total = Number(d.total) || 0;
  page.sumPaid = Number(d.sumPaid) || 0;
  page.pendingTotal = Number(d.pendingTotal) || 0;
  page.offset = offset + (d.rows ? d.rows.length : 0);
  page.hasMore = page.offset < page.total;
  page.loaded = true;
  page.rows = reset ? (d.rows || []) : page.rows.concat(d.rows || []);
}

/* ---------- 订单详情 ---------- */
function buildTimeline(o) {
  const ev = [{ at: o.created_at, kind: 'create', text: '创建订单' }];
  if (o.paid_at) ev.push({ at: o.paid_at, kind: 'pay', text: '确认收款' });
  if (o.cancelled_at) ev.push({ at: o.cancelled_at, kind: 'cancel', text: o.status === 'cancelled' && o.paid_at ? '冲销并回补库存' : '取消订单' });
  return ev.sort((a, b) => (a.at < b.at ? -1 : 1));
}

export async function fetchOrderDetail(id) {
  if (store.details[id]) return store.details[id];
  if (PREVIEW) {
    /* 预览模式本地生成同样形状 */
    const o = orderById(store.db, id);
    if (!o) return null;
    const items = itemsOfOrder(store.db, id).map(it => {
      if (it.item_type === 'combo') {
        const parts = comboPartsOfOrderItem(store.db, it).map(part => ({
          product: productById(store.db, part.product_id), quantity: part.quantity
        }));
        return { ...it, parts };
      }
      return { ...it, product: productById(store.db, it.product_id), parts: [] };
    });
    const detail = {
      order: o, items,
      adjustments: adjustmentsOfOrder(store.db, id),
      movements: store.db.movements
        .filter(m => m.ref_type === 'order' && m.ref_id === id)
        .map(m => ({ ...m, product: productById(store.db, m.product_id) }))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1)),
      timeline: buildTimeline(o)
    };
    store.details[id] = detail;
    return detail;
  }
  store.detailsLoading[id] = true;
  const res = await rpc('get_order', { p_id: id });
  store.detailsLoading[id] = false;
  if (!res.ok || !res.data) { toast(res.error || '读取订单详情失败', 'warn'); return null; }
  const d = res.data;
  const items = (d.items || []).map(it => {
    const parts = (it.combo_selections || []).flatMap(sel =>
      (sel.items || []).map(x => ({
        product: productById(store.db, Number(x.product_id)),
        quantity: int(x.quantity)
      })));
    return {
      ...it, parts,
      product: it.product_id ? productById(store.db, Number(it.product_id)) : null
    };
  });
  const detail = {
    order: d.order,
    items,
    adjustments: d.adjustments || [],
    movements: (d.movements || []).map(m => ({
      ...m, product: productById(store.db, Number(m.product_id))
    })),
    timeline: buildTimeline(d.order)
  };
  store.details[id] = detail;
  return detail;
}

/* ---------- 统计 ---------- */
export async function fetchStats(from, to) {
  if (PREVIEW) return null;
  store.statsLoading = true;
  const res = await rpc('stats_summary', { p_from: from, p_to: to });
  store.statsLoading = false;
  if (!res.ok) { toast(res.error || '读取统计失败', 'warn'); return null; }
  store.stats = res.data;
  return store.stats;
}

/* ============================================================
   登录后的数据加载
   ============================================================ */
async function pullFromCloud() {
  const snap = await rpc('load_snapshot');
  if (!snap.ok) {
    store.sync.state = 'unsynced';
    store.sync.error = snap.error || '读取云端数据失败';
    return false;
  }
  assembleSnapshot(snap.data);
  store.sync.state = 'saved';
  store.sync.error = '';
  store.savedAt = new Date().toISOString();
  await ensureDashboard(true);
  return true;
}

/* ============================================================
   登录 / 退出
   ============================================================ */
function rememberPhone(phone) {
  try { if (phone) localStorage.setItem(PHONE_KEY, phone); } catch (e) { /* 隐私模式忽略 */ }
}

export function lastPhone() {
  try { return localStorage.getItem(PHONE_KEY) || ''; } catch (e) { return ''; }
}

async function enterApp(session) {
  const phone = phoneOf(session) || store.auth.phone || lastPhone();
  store.auth.phone = phone;
  store.auth.error = '';
  rememberPhone(phone);
  const u = (session && session.user) || {};
  store.uid = u.id || u.uid || null;
  store.auth.status = 'ready';
  await pullFromCloud();
  store.loaded = true;
  /* 首屏拉取失败也不白屏：留在应用里，顶部显示未同步 */
  if (store.sync.state === 'unsynced') toast(store.sync.error || '云端数据读取失败', 'warn');
}

export async function bootstrap() {
  if (PREVIEW) {
    store.auth.status = 'ready';
    store.auth.phone = '本地预览';
    store.db = buildSeedDb();
    store.db.previewImages = loadPreviewImages();
    store.db.productImageUrls = {};
    store.loaded = true;
    store.sync.state = 'local';
    return;
  }
  store.auth.status = 'loading';
  if (SELF_HOSTED) {
    /* 自托管：有 token 直接进，没有则到登录页 */
    if (selfHostToken()) {
      const res = await rpc('load_snapshot');
      if (res.ok) {
        await enterApp({ user: { id: res.data && res.data.uid } });
        return;
      }
      if (res.status === 401) setSelfHostToken('');
    }
    store.auth.status = 'anon';
    return;
  }
  if (!cloudAvailable()) {
    store.auth.status = 'anon';
    store.auth.error = '云端 SDK 没有加载成功，请刷新页面重试';
    return;
  }
  const s = await getSession();
  if (!s.signedIn) {
    store.auth.status = 'anon';
    store.auth.error = s.ok ? '' : (s.error || '');
    return;
  }
  await enterApp(s.session);
}

export async function signIn(phone, password) {
  store.auth.error = '';
  if (SELF_HOSTED) {
    const r = await selfHostLogin(phone, password);
    if (!r.ok) {
      store.auth.error = r.error || '登录失败';
      return r;
    }
    setSelfHostToken(r.data.token);
    store.uid = r.data.user.uid;
    await enterApp({ user: { id: r.data.user.uid, name: r.data.user.name } });
    return { ok: true };
  }
  const res = await signInWithPassword(phone, password);
  if (!res.ok) {
    store.auth.error = res.error;
    return res;
  }
  await enterApp(res.session);
  return { ok: true };
}

/* 首次激活：发一次短信验证码，验完就用初始密码建账号 */
export async function requestCode(phone) {
  if (SELF_HOSTED) return { ok: false, error: '' };
  const res = await sendOtp(phone);
  if (res.ok) {
    store.auth.error = '';
  } else {
    store.auth.error = res.error;
  }
  return res;
}

export async function activate({ phone, verificationId, token, isExistingUser, password, setupKey }) {
  if (SELF_HOSTED) {
    /* 自托管「首次使用」：直接建号（需服务器 .env 的 SETUP_KEY；仅当库为空时可用） */
    store.auth.error = '';
    const r = await selfHostSetup(phone, password || '123456', phone, setupKey);
    if (!r.ok) {
      store.auth.error = r.error || '创建账号失败';
      return r;
    }
    setSelfHostToken(r.data.token);
    store.uid = r.data.user.uid;
    await enterApp({ user: { id: r.data.user.uid, name: r.data.user.name } });
    return { ok: true };
  }
  store.auth.error = '';
  const res = await verifyOtp({ phone, verificationId, token, isExistingUser, password });
  if (!res.ok) {
    store.auth.error = res.error;
    return res;
  }
  await enterApp(res.session);
  return { ok: true, isExistingUser: !!isExistingUser };
}

export async function changePassword(oldPassword, newPassword) {
  if (SELF_HOSTED) {
    toast('自托管版请在服务器上改密码（详见部署文档）', 'info');
    return { ok: false, error: 'not supported' };
  }
  const res = await changePasswordRemote(oldPassword, newPassword);
  if (res.ok) toast('密码已更新，下次用新密码登录', 'ok');
  else toast(res.error || '修改密码失败', 'warn');
  return res;
}

export async function logout() {
  if (PREVIEW) { toast('预览模式无需退出', 'info'); return; }
  if (SELF_HOSTED) {
    setSelfHostToken('');
  } else {
    await cloudSignOut();
  }
  store.db = createDb();
  store.counts = null;
  store.dash = null;
  store.ordersPage = { rows: [], total: 0, sumPaid: 0, pendingTotal: 0, limit: 30, offset: 0, loading: false, loaded: false, hasMore: false, query: null };
  store.details = {};
  store.stats = null;
  store.uid = null;
  store.savedAt = null;
  store.loaded = false;
  store.auth = { status: 'anon', phone: '', error: '' };
  store.sync = { state: 'idle', error: '' };
  store.ui.view = 'today';
  store.ui.sheet = null;
  store.ui.cart = [];
  store.ui.cartOpen = false;
  store.ui.moreOpen = false;
}

/* 包一层：RPC 动作统一走这里，错误转提示、同步态转指示灯 */
async function actR(fn, okMsg) {
  if (PREVIEW) {
    try {
      const res = fn();
      if (okMsg) toast(okMsg, 'ok');
      return typeof res === 'object' && res !== null && 'ok' in res ? res : { ok: true, data: res };
    } catch (e) {
      toast(e && e.message ? e.message : '操作失败，请重试', 'warn');
      return { ok: false, error: e };
    }
  }
  store.sync.state = 'saving';
  try {
    const res = await fn();
    if (res.ok) {
      store.sync.state = 'saved';
      store.sync.error = '';
      store.savedAt = new Date().toISOString();
      if (okMsg) toast(okMsg, 'ok');
    } else {
      store.sync.state = 'unsynced';
      store.sync.error = res.error || '操作失败，请重试';
      toast(res.error || '操作失败，请重试', 'warn');
    }
    return res;
  } catch (e) {
    store.sync.state = 'unsynced';
    store.sync.error = (e && e.message) || '网络连接失败';
    toast((e && e.message) || '操作失败，请重试', 'warn');
    return { ok: false, error: e };
  }
}

/* 批量导入时按 `大类>中类` 建分类（云端 save_category），返回最终分类 id */
async function ensureCategoryIdRemote(raw, created) {
  const parts = String(raw || '')
    .split(/[>＞/／]/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 2);
  let parentId = null;
  for (const part of parts) {
    const name = part.slice(0, 12);
    const found = store.db.categories.find(c => (c.parent_id || null) === parentId && c.name === name)
      || (created.get(parentId + '/' + name) !== undefined ? { id: created.get(parentId + '/' + name) } : null);
    if (found) { parentId = found.id; continue; }
    const res = await rpc('save_category', { p_payload: { name, parent_id: parentId } });
    if (!res.ok) return parentId;
    const cat = res.data && res.data.category;
    if (!cat) return parentId;
    if (!store.db.categories.some(c => Number(c.id) === Number(cat.id))) {
      store.db.categories.push({ ...cat, sort: store.db.categories.length });
    }
    created.set((parentId || '') + '/' + name, cat.id);
    parentId = cat.id;
  }
  return parentId;
}

/* ============================================================
   选择器
   ============================================================ */
export const productsOnSale = computed(() => store.db.products.filter(p => p.status === 'on_sale'));
export const combosOnSale = computed(() => store.db.combos.filter(c => c.status === 'on_sale'));

export const seriesList = computed(() => {
  const set = new Set();
  store.db.products.forEach(p => { if (p.status === 'on_sale') set.add(p.series || '未分类'); });
  return ['全部', ...Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))];
});

/* ---------- 分类与标签 ---------- */
export const categoryRows = computed(() => {
  const out = [];
  const walk = (parentId, depth) => {
    childrenOf(store.db, parentId).forEach(c => {
      out.push({
        ...c, depth,
        path: categoryLabel(store.db, c.id),
        count: categoryProductCount(store.db, c.id)
      });
      if (depth < 2) walk(c.id, depth + 1);
    });
  };
  walk(null, 1);
  return out;
});

export const rootCategories = computed(() => childrenOf(store.db, null));

export function childrenIn(categoryId) { return childrenOf(store.db, categoryId || null); }

export const tagLibrary = computed(() =>
  (store.db.tags || [])
    .map(name => ({ name, count: store.db.products.filter(p => (p.tags || []).includes(name)).length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
);

/* 近 30 天卖得最多的商品（服务端聚合），开单页置顶 */
export const frequentIds = computed(() =>
  (store.dash && Array.isArray(store.dash.frequent) ? store.dash.frequent : []).map(Number)
);

/* 库存状态：none 未盘点 / neg 负库存 / low 低于阈值 / ok 正常 */
export function stockState(productId) {
  const qty = balanceOf(store.db, productId);
  const p = productById(store.db, productId) || {};
  const th = num(p.safety_stock);
  if (qty === null) return { known: false, qty: 0, threshold: th, state: 'none' };
  const state = qty < 0 ? 'neg' : (th > 0 && qty <= th ? 'low' : 'ok');
  return { known: true, qty, threshold: th, state };
}
export const STOCK_STATE_TXT = { none: '未盘点', neg: '负库存', low: '偏低', ok: '正常' };
export const STOCK_STATE_TAG = { none: 'gray', neg: 'danger', low: 'warn', ok: 'ok' };

export const inventoryRows = computed(() => {
  const rank = { neg: 0, low: 1, ok: 2, none: 3 };
  return store.db.products
    .map(p => ({ p, ...stockState(p.id) }))
    .sort((a, b) => rank[a.state] - rank[b.state] || a.p.series.localeCompare(b.p.series, 'zh-Hans-CN') || a.p.name.localeCompare(b.p.name, 'zh-Hans-CN'));
});

export const openAlerts = computed(() =>
  store.db.alerts.filter(a => a.status === 'open')
    .map(a => ({ ...a, product: productById(store.db, a.product_id) }))
    .sort((x, y) => (x.created_at < y.created_at ? 1 : -1)));

/* 待收款订单：dashboard 聚合（今日页与导航徽标共用） */
export const pendingOrders = computed(() =>
  ((store.dash && store.dash.pending) || [])
    .map(o => ({ ...o, total_amount: num(o.total_amount) }))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1)));

/* 订单缓存池按创建时间倒序（已拉到的部分；全量清单在 ordersPage） */
export const ordersDesc = computed(() =>
  [...store.db.orders].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));

/* 最近一个有营业的日子（今天没开单时用它做回顾） */
export const lastBusinessDay = computed(() => {
  const days = (store.dash && store.dash.days) || [];
  const withRev = days.filter(d => num(d.revenue) > 0).map(d => d.date);
  if (!withRev.length) {
    if (store.dash && store.dash.lastDay && store.dash.lastDay.date) return store.dash.lastDay.date;
    return null;
  }
  return withRev[withRev.length - 1];
});

const EMPTY_DAY = date => ({ date, revenue: 0, count: 0, pieces: 0, cancelled: 0, avg: 0, channels: {} });
const dayShape = d => ({
  date: d.date,
  revenue: num(d.revenue),
  count: int(d.count),
  pieces: int(d.pieces),
  cancelled: int(d.cancelled),
  avg: num(d.avg),
  channels: d.channels && typeof d.channels === 'object' ? d.channels : {}
});

export const todaySummary = computed(() =>
  store.dash && store.dash.today ? dayShape(store.dash.today) : EMPTY_DAY(ymd(startOfDay())));
export const yesterdaySummary = computed(() =>
  store.dash && store.dash.yesterday ? dayShape(store.dash.yesterday) : EMPTY_DAY(ymd(addDays(startOfDay(), -1))));
export const lastDaySummary = computed(() =>
  store.dash && store.dash.lastDay ? dayShape(store.dash.lastDay) : null);

/* 近 n 天营收：从 dashboard 的近 30 天切片；endDate 指定截止日（如最近营业日） */
export function recentDays(n, endDate) {
  const days = (store.dash && store.dash.days) || [];
  let idx = -1;
  if (endDate) idx = days.findIndex(d => d.date === endDate);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = idx >= 0 ? days[idx - i] : days[days.length - 1 - i];
    if (d) out.push(dayShape(d));
    else {
      const base = idx >= 0 ? days[idx] : days[days.length - 1];
      const date = base ? ymd(addDays(new Date(base.date + 'T00:00:00'), -(i))) : '';
      out.push(EMPTY_DAY(date));
    }
  }
  return out;
}

/* 最近 n 笔订单（dashboard 聚合，含明细） */
export function recentOrders(n) {
  const recent = (store.dash && store.dash.recent) || [];
  return recent.slice(0, n).map(r => ({ order: r.order, items: r.items || [] }));
}

export function orderDetail(id) {
  return store.details[id] || null;
}

/* 数据总览，设置页用 */
export const demoInfo = computed(() => {
  const c = store.counts || {};
  return {
    products: c.products ?? store.db.products.length,
    onSale: store.db.products.filter(p => p.status === 'on_sale').length,
    combos: c.combos ?? store.db.combos.length,
    categories: (store.db.categories || []).length,
    tags: (store.db.tags || []).length,
    orders: c.orders ?? store.db.orders.length,
    paid: c.paid ?? store.db.orders.filter(o => o.status === 'paid').length,
    pending: c.pending ?? store.db.orders.filter(o => o.status === 'pending').length,
    cancelled: c.cancelled ?? store.db.orders.filter(o => o.status === 'cancelled').length,
    movements: c.movements ?? store.db.movements.length,
    counted: c.counted ?? store.db.products.filter(p => isCounted(store.db, p.id)).length,
    alerts: c.alerts ?? store.db.alerts.filter(a => a.status === 'open').length,
    savedAt: store.savedAt,
    syncMode: PREVIEW ? '本地预览' : '字段化 v3',
    phone: store.auth.phone,
    syncState: store.sync.state,
    syncError: store.sync.error
  };
});

/* ============================================================
   动作
   ============================================================ */
export const actions = {
  /* ---------- 收款码 ---------- */
  async savePaymentCodeFile(channel, file) {
    if (PREVIEW) {
      return actR(() => {
        if (!['wechat', 'alipay'].includes(channel)) throw new Error('收款渠道不支持');
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(file.dataUrl) || file.dataUrl.length > 4300000) {
          throw new Error('收款码图片格式不正确或超过 3MB');
        }
        const codes = { ...(store.db.paymentCodes || {}), [channel]: file.dataUrl };
        try { localStorage.setItem('market-pos-preview-payment-codes', JSON.stringify(codes)); }
        catch { throw new Error('本机存储空间不足，请选择较小图片'); }
        store.db.paymentCodes = codes;
      }, '收款码已更新');
    }
    return actR(async () => {
      if (!store.uid) return { ok: false, error: '登录状态异常，请重新登录' };
      const old = (store.db.paymentCodePaths || {})[channel];
      const up = await uploadPaymentCodeImage(store.uid, channel, file);
      if (!up.ok) return up;
      const res = await rpc('save_payment_code', {
        p_channel: channel, p_storage_path: up.path, p_file_id: null,
        p_mime: file.type || null, p_size: file.size || null
      });
      if (!res.ok) { await removeStorageObject(up.path); return res; }
      const paths = { ...(store.db.paymentCodePaths || {}), [channel]: up.path };
      store.db.paymentCodePaths = paths;
      store.db.paymentCodes = { ...(store.db.paymentCodes || {}), [channel]: await signPaymentCodePath(up.path) };
      store.db.paymentCodesAt = Date.now();
      if (old && old !== up.path) removeStorageObject(old);
      return res;
    }, '收款码已更新');
  },
  savePaymentCode(channel, image) {
    /* 兼容旧签名（传 dataURL）：预览模式直接存；云端模式忽略 */
    return actions.savePaymentCodeFile(channel, { dataUrl: image });
  },

  /* ---------- 分类 ---------- */
  async saveCategory(data) {
    if (PREVIEW) return actR(() => upsertCategory(store.db, data));
    return actR(async () => {
      const res = await rpc('save_category', { p_payload: data });
      if (res.ok && res.data && res.data.category) {
        const cat = res.data.category;
        const i = store.db.categories.findIndex(x => Number(x.id) === Number(cat.id));
        if (i >= 0) store.db.categories.splice(i, 1, { ...store.db.categories[i], ...cat });
        else store.db.categories.push({ ...cat, sort: store.db.categories.length });
      }
      return res;
    });
  },
  async moveCategory(id, direction) {
    if (PREVIEW) return actR(() => moveCategory(store.db, id, direction));
    return actR(async () => {
      const res = await rpc('save_category', { p_payload: { id, direction } });
      if (res.ok) await refreshMaster();
      return res;
    });
  },
  async moveCategoryTo(id, targetId) {
    if (PREVIEW) return actR(() => moveCategoryTo(store.db, id, targetId));
    return actR(async () => {
      const res = await rpc('save_category', { p_payload: { id, target_id: targetId } });
      if (res.ok) await refreshMaster();
      return res;
    });
  },
  async removeCategory(id) {
    if (PREVIEW) return actR(() => deleteCategoryRule(store.db, id));
    return actR(async () => {
      const res = await rpc('delete_category', { p_id: id });
      if (res.ok) {
        const i = store.db.categories.findIndex(x => Number(x.id) === Number(id));
        if (i >= 0) store.db.categories.splice(i, 1);
      }
      return res;
    });
  },

  /* ---------- 标签 ---------- */
  async addTag(name) {
    if (PREVIEW) return actR(() => addTagRule(store.db, name));
    return actR(async () => {
      const res = await rpc('save_tag', { p_action: 'add', p_from: null, p_to: name });
      if (res.ok && !store.db.tags.includes(name)) store.db.tags.push(name);
      return res;
    });
  },
  async renameTag(from, to) {
    if (PREVIEW) return actR(() => renameTagRule(store.db, from, to));
    return actR(async () => {
      const res = await rpc('save_tag', { p_action: 'rename', p_from: from, p_to: to });
      if (res.ok) {
        store.db.tags = store.db.tags.map(t => (t === from ? to : t));
        store.db.products.forEach(p => {
          if ((p.tags || []).includes(from)) p.tags = p.tags.map(t => (t === from ? to : t));
        });
      }
      return res;
    });
  },
  async removeTag(name) {
    if (PREVIEW) return actR(() => deleteTagRule(store.db, name));
    return actR(async () => {
      const res = await rpc('save_tag', { p_action: 'delete', p_from: name, p_to: null });
      if (res.ok) {
        store.db.tags = store.db.tags.filter(t => t !== name);
        store.db.products.forEach(p => {
          if ((p.tags || []).includes(name)) p.tags = p.tags.filter(t => t !== name);
        });
      }
      return res;
    });
  },

  /* ---------- 订单 ---------- */
  async createOrder(input) {
    if (PREVIEW) {
      return actR(() => {
        const d = createOrder(store.db, input);
        return { ok: true, data: d };
      });
    }
    return actR(async () => {
      const res = await rpc('create_order', { p_payload: input, p_request_id: newRequestId() });
      if (res.ok) {
        const d = res.data;
        if (d.order) store.db.orders.unshift(d.order);
        if (d.items) store.db.orderItems.push(...d.items);
        if (d.adjustment) store.db.adjustments.push(d.adjustment);
        if (d.alerts && d.alerts.length) store.db.alerts.unshift(...d.alerts);
        ensureDashboard(true);
        refreshMaster();
      }
      return res;
    });
  },
  async confirmOrder(id, input) {
    if (PREVIEW) {
      return actR(() => {
        const d = confirmOrder(store.db, id, input);
        return { ok: true, data: d };
      });
    }
    return actR(async () => {
      const res = await rpc('order_action', {
        p_action: 'confirm',
        p_payload: { id, ...input },
        p_request_id: newRequestId()
      });
      if (res.ok) {
        const d = res.data;
        if (d.order) {
          const i = store.db.orders.findIndex(o => Number(o.id) === Number(id));
          if (i >= 0) store.db.orders.splice(i, 1, d.order); else store.db.orders.unshift(d.order);
          const detail = store.details[id];
          if (detail) detail.order = d.order;
        }
        if (d.alerts && d.alerts.length) store.db.alerts.unshift(...d.alerts);
        ensureDashboard(true);
        refreshMaster();
      }
      return res;
    });
  },
  async cancelOrder(id, reason) {
    if (PREVIEW) {
      return actR(() => {
        const d = cancelOrder(store.db, id, reason);
        return { ok: true, data: d };
      });
    }
    return actR(async () => {
      const res = await rpc('order_action', {
        p_action: 'cancel',
        p_payload: { id, reason },
        p_request_id: newRequestId()
      });
      if (res.ok) {
        const d = res.data;
        if (d.order) {
          const i = store.db.orders.findIndex(o => Number(o.id) === Number(id));
          if (i >= 0) store.db.orders.splice(i, 1, d.order); else store.db.orders.unshift(d.order);
          const detail = store.details[id];
          if (detail) detail.order = d.order;
        }
        ensureDashboard(true);
        refreshMaster();
      }
      return res;
    });
  },

  /* ---------- 库存 ---------- */
  async stockIn(items, note) {
    if (PREVIEW) {
      return actR(() => {
        stockIn(store.db, items, note);
        return { ok: true };
      });
    }
    return actR(async () => {
      const res = await rpc('stock_action', {
        p_action: 'in', p_payload: { items, note }, p_request_id: newRequestId()
      });
      if (res.ok && res.data && Array.isArray(res.data.written)) {
        res.data.written.forEach(w => {
          if (w.product_id !== undefined) store.db.balances = { ...store.db.balances, [String(w.product_id)]: w.balance };
        });
        refreshMaster();
      }
      return res;
    });
  },
  async setStock(pid, counted, reason) {
    if (PREVIEW) {
      return actR(() => {
        setStock(store.db, pid, counted, reason);
        return { ok: true };
      });
    }
    return actR(async () => {
      const res = await rpc('stock_action', {
        p_action: 'set', p_payload: { product_id: pid, counted, note: reason }, p_request_id: newRequestId()
      });
      if (res.ok && res.data && Array.isArray(res.data.written) && res.data.written.length) {
        const w = res.data.written[0];
        if (w.product_id !== undefined) store.db.balances = { ...store.db.balances, [String(w.product_id)]: w.balance };
        refreshMaster();
      }
      return res;
    });
  },

  /* ---------- 商品 ---------- */
  async saveProduct(data) {
    if (PREVIEW) {
      return actR(() => {
        const payload = { ...data };
        const imageChanged = Object.prototype.hasOwnProperty.call(data, 'image_dataUrl');
        delete payload.image_dataUrl;
        if (imageChanged) payload.image_path = null;
        const p = upsertProduct(store.db, payload);
        if (imageChanged) {
          try { persistPreviewImage(p.id, data.image_dataUrl || ''); }
          catch (e) { throw new Error('本机存储空间不足，请换一张小一点的图片'); }
        }
        return p;
      });
    }
    return actR(async () => {
      const prev = data.id ? productById(store.db, data.id) : null;
      const oldPath = prev && prev.image_path;
      const res = await rpc('save_product', { p_payload: data, p_request_id: newRequestId() });
      if (res.ok && res.data && res.data.product) mergeProduct(res.data.product);
      if (res.ok) {
        if (oldPath && oldPath !== data.image_path) removeStorageObject(oldPath);
      } else if (data.image_path && data.image_path !== oldPath) {
        /* 商品没保存成功，删掉刚上传的新图，避免孤儿文件 */
        removeStorageObject(data.image_path);
      }
      return res;
    });
  },
  async toggleProduct(id) {
    if (PREVIEW) return actR(() => toggleProductStatus(store.db, id));
    return actR(async () => {
      const res = await rpc('toggle_product', { p_id: id });
      if (res.ok && res.data && res.data.product) mergeProduct(res.data.product);
      return res;
    });
  },
  /* 批量导入商品：服务端单事务、单行失败不影响其他行 */
  async importProducts(rows, opts = {}) {
    if (PREVIEW) {
      return actR(() => {
        const db = store.db;
        const ok = [];
        const bad = [];
        const used = new Set(db.products.map(p => String(p.sku_code || '').toUpperCase()));
        let seq = 1;
        const autoSku = () => {
          let sku;
          do { sku = 'P' + String(seq).padStart(4, '0'); seq += 1; } while (used.has(sku));
          used.add(sku);
          return sku;
        };
        (rows || []).forEach(row => {
          try {
            const payload = { ...row };
            if (!payload.category_id && opts.autoCreateCategory && row.categoryRaw) {
              const hit = matchCategoryPath(db, row.categoryRaw);
              payload.category_id = hit.id || null;
            }
            if (!String(payload.sku_code || '').trim()) payload.sku_code = autoSku();
            delete payload.categoryRaw;
            delete payload.categoryLabel;
            delete payload.categoryMiss;
            delete payload.errors;
            delete payload.warns;
            delete payload.line;
            const saved = upsertProduct(db, payload);
            used.add(String(saved.sku_code || '').toUpperCase());
            ok.push(saved);
          } catch (e) {
            bad.push({ name: row.name || '', line: row.line, error: e && e.message ? e.message : '写入失败' });
          }
        });
        return { ok: true, data: { ok, bad } };
      });
    }
    return actR(async () => {
      const used = new Set(store.db.products.map(p => String(p.sku_code || '').toUpperCase()));
      let seq = 1;
      const autoSku = () => {
        let sku;
        do { sku = 'P' + String(seq).padStart(4, '0'); seq += 1; } while (used.has(sku));
        used.add(sku);
        return sku;
      };
      const created = new Map();
      const payloadRows = [];
      for (const row of (rows || [])) {
        const payload = { ...row };
        if (!payload.category_id && opts.autoCreateCategory && row.categoryRaw) {
          payload.category_id = await ensureCategoryIdRemote(row.categoryRaw, created) || null;
        }
        if (!String(payload.sku_code || '').trim()) payload.sku_code = autoSku();
        delete payload.categoryRaw;
        delete payload.categoryLabel;
        delete payload.categoryMiss;
        delete payload.errors;
        delete payload.warns;
        delete payload.line;
        payloadRows.push(payload);
      }
      if (!payloadRows.length) return { ok: false, error: '没有可导入的行' };
      const res = await rpc('import_products', { p_rows: payloadRows, p_request_id: newRequestId() });
      if (res.ok && res.data) {
        (res.data.ok || []).forEach(rec => mergeProduct(rec));
        /* 导入可能带建了新分类，静默刷新一遍主数据 */
        refreshMaster();
      }
      return res;
    });
  },

  /* ---------- 套餐 ---------- */
  async saveCombo(data) {
    if (PREVIEW) return actR(() => upsertCombo(store.db, data));
    return actR(async () => {
      const res = await rpc('save_combo', { p_payload: data });
      if (res.ok && res.data && res.data.combo) {
        const c = res.data.combo;
        const i = store.db.combos.findIndex(x => Number(x.id) === Number(c.id));
        if (i >= 0) store.db.combos.splice(i, 1, { ...store.db.combos[i], ...c });
        else store.db.combos.push(c);
      }
      return res;
    });
  },
  async deleteCombo(id) {
    if (PREVIEW) return actR(() => deleteCombo(store.db, id));
    return actR(async () => {
      const res = await rpc('delete_combo', { p_id: id });
      if (res.ok && res.data) {
        if (res.data.deleted) {
          const i = store.db.combos.findIndex(x => Number(x.id) === Number(id));
          if (i >= 0) store.db.combos.splice(i, 1);
        } else {
          /* 历史订单引用：改为停售 */
          const c = store.db.combos.find(x => Number(x.id) === Number(id));
          if (c) c.status = 'off_sale';
          if (res.data.reason) toast(res.data.reason, 'warn');
        }
      }
      return res;
    });
  },

  /* ---------- 预警 ---------- */
  async resolveAlert(id, note) {
    if (PREVIEW) return actR(() => resolveAlert(store.db, id, note));
    return actR(async () => {
      const res = await rpc('resolve_alert', { p_id: id, p_note: note });
      if (res.ok && res.data && res.data.alert) {
        const a = res.data.alert;
        const i = store.db.alerts.findIndex(x => Number(x.id) === Number(id));
        if (i >= 0) store.db.alerts.splice(i, 1, { ...store.db.alerts[i], ...a });
      }
      return res;
    });
  },
  syncAlerts() { return actR(() => { syncAlerts(store.db); return { ok: true }; }); },

  /* ---------- 导出（云端模式从服务端拉全量） ---------- */
  async exportDataset() {
    const res = await rpc('export_dataset');
    if (!res.ok) { toast(res.error || '读取数据失败', 'warn'); return null; }
    return res.data;
  },
  exportJson() {
    if (PREVIEW) {
      const blob = JSON.stringify({ exportedAt: new Date().toISOString(), ...toPlain(store.db) }, null, 2);
      downloadBlob(blob, 'application/json', '摆摊订单管家-数据-' + ymd(new Date()) + '.json');
      return;
    }
    return actR(async () => {
      const d = await actions.exportDataset();
      if (!d) return { ok: false };
      const blob = JSON.stringify(d, null, 2);
      downloadBlob(blob, 'application/json', '摆摊订单管家-数据-' + ymd(new Date()) + '.json');
      return { ok: true };
    }, '已导出 JSON 备份');
  },
  async exportCsv(kind) {
    if (PREVIEW) {
      const file = buildCsv(kind, toPlain(store.db));
      if (!file) { toast('未知的导出类型', 'warn'); return; }
      downloadBlob(file.text, 'text/csv;charset=utf-8', file.filename);
      toast(`已导出 ${file.label} CSV，可用 Excel 打开`, 'ok');
      return;
    }
    return actR(async () => {
      const d = await actions.exportDataset();
      if (!d) return { ok: false };
      const file = buildCsv(kind, d);
      if (!file) { toast('未知的导出类型', 'warn'); return { ok: false }; }
      downloadBlob(file.text, 'text/csv;charset=utf-8', file.filename);
      toast(`已导出 ${file.label} CSV，可用 Excel 打开`, 'ok');
      return { ok: true };
    });
  }
};

function downloadBlob(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* 便捷读取 */
export {
  productById, comboById, orderById, balanceOf, itemsOfOrder, movementsOf,
  openAlertsOf, buildStats, expandCombo, computeTotal,
  categoryById, categoryPath, categoryLabel, categoryLevel, childrenOf, categoryProductCount
};

export function markReady() { store.ready = true; }

export { daysBetween };
