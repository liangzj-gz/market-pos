/* ============================================================
   数据仓库（云端版）

   一份数据对应一个登录手机号，整份 JSON 存进云端 app_state 一行里。
   云端只负责按账号存取；所有业务规则仍在 rules.js 前端执行，
   act() 依旧是「一次同步写入 + 校验失败即抛 BizError」，
   写完 300ms 防抖推上云，版本对不上就提示冲突并刷新。

   换设备登录同一手机号看到的是同一份数据。
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
import { num, r2, int, ymd, startOfDay, addDays, daysBetween } from '../util/format.js';
import { matchCategoryPath } from '../domain/import.js';
import { fillProductBarcodes } from '../domain/barcode.js';
import { SEED_PRODUCTS, SEED_COMBOS, SEED_ORDERS, SEED_OPENING_AT, SEED_TAGS } from './seed.js';
import {
  cloudAvailable, loadState, saveState, getSession, phoneOf,
  signInWithPassword, sendOtp, verifyOtp, signOut as cloudSignOut,
  changePassword as changePasswordRemote
} from './cloud.js';

const { reactive, computed } = window.Vue;

/* 预览模式：URL 带 ?preview=1 时跳过登录，直接灌 29 笔种子数据，
   不调用任何云端接口，用于 iPad / 手机等非同源环境的本地调试 */
export const PREVIEW = typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('preview');

/* 只记「上次登录的手机号」这一条 UI 偏好，绝不存业务数据 */
const PHONE_KEY = 'stall.cloud.phone.v1';

/* ============================================================
   建库：主数据 → 期初建账 → 按时间回放 29 笔历史订单
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
  return db;
}

/* ============================================================
   数据整形
   ============================================================ */
/* reactive 代理不能直接丢给 JSON 序列化，先拍平成纯对象 */
function toPlain(db) { return JSON.parse(JSON.stringify(db)); }

/* 老数据补字段：只补分类树与标签，不动订单和库存 */
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
  loaded: false,                 // 云端数据是否已拉下来
  version: 0,                    // 云端行版本号，乐观并发用
  db: createDb(),                // 登录并加载后才有内容
  savedAt: null,
  auth: { status: 'loading', phone: '', error: '' },   // loading | anon | ready
  sync: { state: 'idle', error: '' },                  // idle | pending | saving | saved | unsynced | conflict
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
   云端保存：300ms 防抖 → 串行提交 → 冲突刷新 / 失败重试
   ============================================================ */
const SAVE_DEBOUNCE = 300;
const RETRY_DELAY = 5000;
const MAX_RETRY = 3;

let saveTimer = null;
let retryTimer = null;
let saving = false;
let dirtyAgain = false;
let retryLeft = MAX_RETRY;

export function scheduleSave() {
  if (PREVIEW) { store.sync.state = 'local'; return; }
  if (store.auth.status !== 'ready') return;
  if (saveTimer) clearTimeout(saveTimer);
  store.sync.state = 'pending';
  saveTimer = setTimeout(() => { saveTimer = null; flushSave(); }, SAVE_DEBOUNCE);
}

async function flushSave() {
  if (PREVIEW) return;
  if (store.auth.status !== 'ready') return;
  if (saving) { dirtyAgain = true; return; }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saving = true;
  store.sync.state = 'saving';
  try {
    const res = await saveState(store.version, toPlain(store.db));
    if (res.ok && !res.conflict) {
      store.version = res.version;
      store.savedAt = new Date().toISOString();
      store.sync.state = 'saved';
      store.sync.error = '';
      retryLeft = MAX_RETRY;
    } else if (res.ok && res.conflict) {
      store.sync.state = 'conflict';
      await pullFromCloud();
      toast('数据已在其他设备更新，已刷新为最新，请重试刚才的操作', 'warn');
    } else {
      store.sync.state = 'unsynced';
      store.sync.error = res.error || '保存失败';
      if (!retryTimer && retryLeft > 0) {
        retryLeft -= 1;
        retryTimer = setTimeout(() => { retryTimer = null; flushSave(); }, RETRY_DELAY);
      }
    }
  } finally {
    saving = false;
    if (dirtyAgain) { dirtyAgain = false; flushSave(); }
  }
}

/* 手动「重试保存」：清掉退避计时，立刻再来一次 */
export function retrySave() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  retryLeft = MAX_RETRY;
  return flushSave();
}

/* 把云端最新的整份数据换进来；没有行就用 29 笔历史订单初始化 */
async function pullFromCloud() {
  const res = await loadState();
  if (!res.ok) {
    store.sync.state = 'unsynced';
    store.sync.error = res.error || '读取云端数据失败';
    return false;
  }
  if (!res.exists) {
    store.db = buildSeedDb();
    store.version = 0;
    store.savedAt = null;
    store.sync.state = 'pending';
    await flushSave();
    return true;
  }
  const needsBarcodes = (res.doc.products || []).some(p => !String(p.barcode || '').trim());
  store.db = migrate(res.doc);
  store.version = res.version;
  store.savedAt = new Date().toISOString();
  store.sync.state = 'saved';
  store.sync.error = '';
  if (needsBarcodes) scheduleSave();
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
  store.auth.status = 'ready';
  await pullFromCloud();
  store.loaded = true;
  /* 首登写种子数据失败也不白屏：留在应用里，顶部显示未同步 */
  if (store.sync.state === 'unsynced') toast(store.sync.error || '云端数据读取失败', 'warn');
}

export async function bootstrap() {
  if (PREVIEW) {
    store.auth.status = 'ready';
    store.auth.phone = '本地预览';
    store.db = buildSeedDb();
    store.loaded = true;
    store.sync.state = 'local';
    return;
  }
  store.auth.status = 'loading';
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
  const res = await sendOtp(phone);
  if (res.ok) {
    store.auth.error = '';
  } else {
    store.auth.error = res.error;
  }
  return res;
}

export async function activate({ phone, verificationId, token, isExistingUser, password }) {
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
  const res = await changePasswordRemote(oldPassword, newPassword);
  if (res.ok) toast('密码已更新，下次用新密码登录', 'ok');
  else toast(res.error || '修改密码失败', 'warn');
  return res;
}

export async function logout() {
  if (PREVIEW) { toast('预览模式无需退出', 'info'); return; }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (store.sync.state === 'pending' || store.sync.state === 'unsynced') await flushSave();
  await cloudSignOut();
  store.db = createDb();
  store.version = 0;
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

/* 页面被切到后台时立刻补一次保存，避免最后 300ms 的改动丢掉 */
function flushBeforeHide() {
  if (store.auth.status === 'ready' && (store.sync.state === 'pending' || store.sync.state === 'unsynced')) flushSave();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushBeforeHide();
});
window.addEventListener('pagehide', flushBeforeHide);

/* 包一层：任何规则错误都转成提示，视图里不用到处 try/catch */
function act(fn, okMsg) {
  try {
    const res = fn();
    scheduleSave();
    if (okMsg) toast(okMsg, 'ok');
    return { ok: true, data: res };
  } catch (e) {
    toast(e && e.message ? e.message : '操作失败，请重试', 'warn');
    return { ok: false, error: e };
  }
}

/* 批量导入时按 `大类>中类` 找到分类；不存在就逐级建出来，返回最终分类 id。
   只在用户勾选了「自动创建分类」时才会走到这里。建不出来就返回能建到的那一层，不影响商品写入。 */
function ensureCategoryId(db, raw) {
  const hit = matchCategoryPath(db, raw);
  if (hit.id) {
    /* 大类在、中类缺：补一个中类 */
    if (hit.miss && hit.missParent) {
      try {
        const c = upsertCategory(db, { name: String(hit.miss).slice(0, 12), parent_id: hit.id });
        return c.id;
      } catch (e) {
        return hit.id;
      }
    }
    return hit.id;
  }
  const parts = String(raw || '')
    .split(/[>＞/／]/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 2);
  let parentId = null;
  for (const part of parts) {
    const name = part.slice(0, 12);
    const found = db.categories.find(c => (c.parent_id || null) === parentId && c.name === name);
    if (found) {
      parentId = found.id;
      continue;
    }
    try {
      parentId = upsertCategory(db, { name, parent_id: parentId }).id;
    } catch (e) {
      return parentId;
    }
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
/* 扁平化的分类树，带层级和商品数，便于直接渲染 */
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

/* 近 30 天卖得最多的商品，开单页置顶（少点几下） */
export const frequentIds = computed(() => {
  const since = addDays(startOfDay(), -30).toISOString();
  const count = {};
  store.db.orders.forEach(o => {
    if (o.status !== 'paid' || !o.paid_at || o.paid_at < since) return;
    itemsOfOrder(store.db, o.id).forEach(it => {
      if (it.item_type === 'product') count[it.product_id] = (count[it.product_id] || 0) + int(it.quantity);
      else comboPartsOfOrderItem(store.db, it).forEach(x => { count[x.product_id] = (count[x.product_id] || 0) + x.quantity; });
    });
  });
  return Object.entries(count).sort((a, b) => b[1] - a[1]).map(x => Number(x[0]));
});

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

export const pendingOrders = computed(() =>
  store.db.orders.filter(o => o.status === 'pending')
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1)));

export const ordersDesc = computed(() =>
  [...store.db.orders].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));

/* 最近一个有营业的日子（今天没开单时用它做回顾） */
export const lastBusinessDay = computed(() => {
  const days = new Set(store.db.orders.filter(o => o.status === 'paid' && o.paid_at).map(o => ymd(new Date(o.paid_at))));
  if (!days.size) return null;
  return Array.from(days).sort().pop();
});

function daySummary(dateStr) {
  const from = new Date(dateStr + 'T00:00:00').getTime();
  const to = from + 86400000;
  const paid = store.db.orders.filter(o => {
    if (o.status !== 'paid' || !o.paid_at) return false;
    const t = new Date(o.paid_at).getTime();
    return t >= from && t < to;
  });
  const revenue = r2(paid.reduce((t, o) => t + num(o.paid_amount), 0));
  const pieces = paid.reduce((t, o) => t + int(o.item_count), 0);
  const cancelled = store.db.orders.filter(o => {
    if (o.status !== 'cancelled' || !o.cancelled_at) return false;
    const t = new Date(o.cancelled_at).getTime();
    return t >= from && t < to;
  }).length;
  return {
    date: dateStr, revenue, count: paid.length, pieces, cancelled,
    avg: paid.length ? r2(revenue / paid.length) : 0,
    channels: channelSplit(paid)
  };
}
function channelSplit(orders) {
  const map = {};
  orders.forEach(o => {
    const k = o.channel || 'other';
    map[k] = r2((map[k] || 0) + num(o.paid_amount));
  });
  return map;
}

export const todaySummary = computed(() => daySummary(ymd(startOfDay())));
export const yesterdaySummary = computed(() => daySummary(ymd(addDays(startOfDay(), -1))));
export const lastDaySummary = computed(() => {
  const d = lastBusinessDay.value;
  return d ? daySummary(d) : null;
});

/* 近 n 天营收，含今天；用于迷你柱状图。endDate 可指定截止日（如最近营业日） */
export function recentDays(n, endDate) {
  const end = endDate ? startOfDay(new Date(endDate + 'T00:00:00')) : startOfDay();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(daySummary(ymd(addDays(end, -i))));
  }
  return out;
}

/* 最近 n 笔订单（含明细摘要） */
export function recentOrders(n) {
  return ordersDesc.value.slice(0, n).map(o => ({ order: o, items: itemsOfOrder(store.db, o.id) }));
}

export function orderDetail(id) {
  const o = orderById(store.db, id);
  if (!o) return null;
  const items = itemsOfOrder(store.db, id).map(it => {
    if (it.item_type === 'combo') {
      const c = comboById(store.db, it.combo_id);
      const parts = comboPartsOfOrderItem(store.db, it).map(part => ({
        product: productById(store.db, part.product_id),
        quantity: part.quantity
      }));
      return { ...it, combo: c, parts };
    }
    return { ...it, product: productById(store.db, it.product_id) };
  });
  return {
    order: o,
    items,
    adjustments: adjustmentsOfOrder(store.db, id),
    movements: db_movementsForOrder(id),
    timeline: buildTimeline(o, items)
  };
}
function db_movementsForOrder(orderId) {
  const o = orderById(store.db, orderId);
  return store.db.movements
    .filter(m => m.ref_type === 'order' && m.ref_id === orderId)
    .map(m => ({ ...m, product: productById(store.db, m.product_id) }))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}
function buildTimeline(o) {
  const ev = [{ at: o.created_at, kind: 'create', text: '创建订单' }];
  if (o.paid_at) ev.push({ at: o.paid_at, kind: 'pay', text: '确认收款' });
  if (o.cancelled_at) ev.push({ at: o.cancelled_at, kind: 'cancel', text: o.status === 'cancelled' && o.paid_at ? '冲销并回补库存' : '取消订单' });
  return ev.sort((a, b) => (a.at < b.at ? -1 : 1));
}

/* 数据总览，设置页用 */
export const demoInfo = computed(() => ({
  products: store.db.products.length,
  onSale: store.db.products.filter(p => p.status === 'on_sale').length,
  combos: store.db.combos.length,
  categories: (store.db.categories || []).length,
  tags: (store.db.tags || []).length,
  orders: store.db.orders.length,
  paid: store.db.orders.filter(o => o.status === 'paid').length,
  pending: store.db.orders.filter(o => o.status === 'pending').length,
  cancelled: store.db.orders.filter(o => o.status === 'cancelled').length,
  movements: store.db.movements.length,
  counted: store.db.products.filter(p => isCounted(store.db, p.id)).length,
  alerts: store.db.alerts.filter(a => a.status === 'open').length,
  savedAt: store.savedAt,
  version: store.version,
  phone: store.auth.phone,
  syncState: store.sync.state,
  syncError: store.sync.error
}));

/* ============================================================
   动作
   ============================================================ */
export const actions = {
  saveCategory(data)      { return act(() => upsertCategory(store.db, data)); },
  moveCategory(id, direction) { return act(() => moveCategory(store.db, id, direction)); },
  moveCategoryTo(id, targetId) { return act(() => moveCategoryTo(store.db, id, targetId)); },
  removeCategory(id)      { return act(() => deleteCategoryRule(store.db, id)); },
  addTag(name)            { return act(() => addTagRule(store.db, name)); },
  renameTag(from, to)     { return act(() => renameTagRule(store.db, from, to)); },
  removeTag(name)         { return act(() => deleteTagRule(store.db, name)); },

  createOrder(input)      { return act(() => createOrder(store.db, input)); },
  confirmOrder(id, input) { return act(() => confirmOrder(store.db, id, input)); },
  cancelOrder(id, reason) { return act(() => cancelOrder(store.db, id, reason)); },
  stockIn(items, note)    { return act(() => stockIn(store.db, items, note)); },
  setStock(pid, counted, reason) { return act(() => setStock(store.db, pid, counted, reason)); },
  saveProduct(data)       { return act(() => upsertProduct(store.db, data)); },
  toggleProduct(id)       { return act(() => toggleProductStatus(store.db, id)); },
  /* 批量导入商品：整批走一次 act()，只触发一次云端保存。
     autoCreateCategory 为真时，分类没匹配上就按 `大类>中类` 逐级建出来，否则归入未分类。 */
  importProducts(rows, opts = {}) {
    return act(() => {
      const db = store.db;
      const ok = [];
      const bad = [];
      /* 批量导入时 upsertProduct 的默认 SKU 是 P+时间戳，同一个毫秒内会全部撞车，
         所以这里给没填 SKU 的行按 P0001 递增分配，并记进 used 防止与后续行重复 */
      const used = new Set(db.products.map(p => String(p.sku_code || '').toUpperCase()));
      let seq = 1;
      const autoSku = () => {
        let sku;
        do {
          sku = 'P' + String(seq).padStart(4, '0');
          seq += 1;
        } while (used.has(sku));
        used.add(sku);
        return sku;
      };
      (rows || []).forEach(row => {
        try {
          const payload = { ...row };
          if (!payload.category_id && opts.autoCreateCategory && row.categoryRaw) {
            payload.category_id = ensureCategoryId(db, row.categoryRaw);
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
      return { ok, bad };
    });
  },
  saveCombo(data)         { return act(() => upsertCombo(store.db, data)); },
  deleteCombo(id)         { return act(() => deleteCombo(store.db, id)); },
  resolveAlert(id, note)  { return act(() => resolveAlert(store.db, id, note)); },
  syncAlerts()            { return act(() => syncAlerts(store.db)); },

  resetDemo() {
    store.db = buildSeedDb();
    scheduleSave();
    toast('已恢复初始历史数据', 'ok');
  },
  clearAll() {
    store.db = createDb();
    scheduleSave();
    toast('已清空，现在是空库', 'ok');
  },
  retrySave() { return retrySave(); },
  exportJson() {
    const blob = JSON.stringify({ exportedAt: new Date().toISOString(), ...toPlain(store.db) }, null, 2);
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = '摆摊订单管家-数据-' + ymd(new Date()) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
  importJson(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const obj = JSON.parse(String(reader.result || ''));
          if (!obj || !Array.isArray(obj.products) || !Array.isArray(obj.orders)
              || !Array.isArray(obj.orderItems) || !obj.seq) {
            throw new Error('不是有效的订单管家备份文件');
          }
          delete obj.exportedAt;
          store.db = migrate(obj);
          scheduleSave();
          toast('数据已导入，正在同步到云端', 'ok');
          resolve({ ok: true });
        } catch (e) {
          toast(e.message || '导入失败', 'warn');
          resolve({ ok: false, error: e });
        }
      };
      reader.onerror = () => { toast('读取文件失败', 'warn'); resolve({ ok: false }); };
      reader.readAsText(file);
    });
  }
};

/* 便捷读取 */
export {
  productById, comboById, orderById, balanceOf, itemsOfOrder, movementsOf,
  openAlertsOf, buildStats, expandCombo, computeTotal,
  categoryById, categoryPath, categoryLabel, categoryLevel, childrenOf, categoryProductCount
};

export function markReady() { store.ready = true; }

export { daysBetween };
