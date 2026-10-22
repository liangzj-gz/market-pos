/* ============================================================
   业务规则引擎（R1 ~ R8）

   纯数据层：所有函数只读写传入的 db 对象，不碰 DOM、不碰 Vue。
   将来接云端 Function 时，把 store.js 里的调用换成 HTTP 即可，
   规则本身不用重写。

   R1 实收 ≠ 应收时必须选择调整原因，差额落 adjustments
   R2 赠品行 is_gift=true、金额=0，计入销量
   R3 确认收款与库存扣减同事务（这里是一次同步写入，失败前不落任何变更）
   R4 冲销生成反向流水，原单据永不删除
   R5 出库后余额 ≤ 安全库存即触发预警，一次触发生成一条
   R6 盘点差异生成 adjust 流水并留痕原因
   R7 停售商品不可加入新订单，历史订单展示不受影响
   R8 套餐按明细逐商品扣减库存，价格取套餐价整体计算
   ============================================================ */

import { num, r2, int, ymd, pad } from '../util/format.js';

/* ---------- 错误 ---------- */
export class BizError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'BizError';
  }
}
const fail = (code, message) => { throw new BizError(code, message); };

/* ---------- 空库 ---------- */
export function createDb() {
  return {
    products: [],
    categories: [],      // { id, name, parent_id, sort } 最多两级
    tags: [],            // 标签词库（字符串）
    combos: [],          // { ...combo, items: [{product_id, quantity}] }
    orders: [],
    orderItems: [],
    adjustments: [],
    balances: {},        // product_id -> quantity（null/undefined 表示未盘点）
    movements: [],
    alerts: [],
    seq: { order: 1, item: 1, adj: 1, mov: 1, alert: 1, product: 1, combo: 1, category: 1 }
  };
}

const nextId = (db, key) => {
  if (!Number.isFinite(db.seq[key])) db.seq[key] = 1;
  return db.seq[key]++;
};

/* ---------- 查询 ---------- */
export const productById = (db, id) => db.products.find(p => p.id === id) || null;
export const comboById   = (db, id) => db.combos.find(c => c.id === id) || null;
export const orderById   = (db, id) => db.orders.find(o => o.id === id) || null;

export function balanceOf(db, productId) {
  const v = db.balances[productId];
  return v === undefined || v === null ? null : v;
}
/* 是否已盘点过（有余额记录） */
export const isCounted = (db, productId) => balanceOf(db, productId) !== null;

export const itemsOfOrder = (db, orderId) =>
  db.orderItems.filter(i => i.order_id === orderId);
export const adjustmentsOfOrder = (db, orderId) =>
  db.adjustments.filter(a => a.order_id === orderId);
export const movementsOf = (db, productId, limit) => {
  const list = db.movements.filter(m => m.product_id === productId);
  list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return limit ? list.slice(0, limit) : list;
};
export const openAlertsOf = (db, productId) =>
  db.alerts.filter(a => a.product_id === productId && a.status === 'open');

/* R8：把套餐展开成 {product_id, quantity} 列表（旧套餐固定明细） */
export function expandCombo(db, comboId, qty) {
  const c = comboById(db, comboId);
  if (!c) return [];
  return (c.items || []).map(it => ({ product_id: it.product_id, quantity: int(it.quantity) * int(qty) }));
}

export const comboHasGroups = c => !!(c && Array.isArray(c.groups) && c.groups.length);

/* 从旧套餐的固定商品明细里按中类归并出子套餐 */
export function deriveComboGroups(db, items) {
  const map = new Map();
  (items || []).forEach(it => {
    const p = productById(db, it.product_id);
    if (!p || !p.category_id) return;
    const path = categoryPath(db, p.category_id);
    const mid = path[1] || null;
    if (!mid) return;
    map.set(mid.id, (map.get(mid.id) || 0) + int(it.quantity));
  });
  return Array.from(map, ([category_id, quantity]) => ({ category_id, quantity }));
}

/* 旧套餐的固定明细 → 选品快照（历史订单导入/迁移用） */
export function comboSelectionsFromItems(db, items) {
  const map = new Map();
  (items || []).forEach(it => {
    const p = productById(db, it.product_id);
    if (!p || !p.category_id) return;
    const path = categoryPath(db, p.category_id);
    const mid = path[1] || null;
    if (!mid) return;
    let group = map.get(mid.id);
    if (!group) {
      group = { category_id: mid.id, items: [] };
      map.set(mid.id, group);
    }
    group.items.push({ product_id: it.product_id, quantity: int(it.quantity) });
  });
  return Array.from(map.values());
}

/* 子套餐选品 → 商品明细；selections 是「一份套餐」的选品 */
export function expandComboSelections(selections, qty = 1) {
  const out = [];
  (selections || []).forEach(group => {
    (group.items || []).forEach(item => {
      const product_id = Number(item.product_id);
      const quantity = int(item.quantity) * int(qty);
      if (product_id && quantity) out.push({ product_id, quantity });
    });
  });
  return out;
}

/* 订单行：优先用选品快照，旧订单继续用套餐固定明细 */
export function comboPartsOfLine(db, line) {
  if (!line) return [];
  const selections = line.selections || line.combo_selections;
  if (Array.isArray(selections) && selections.length) {
    return expandComboSelections(selections, line.quantity);
  }
  return expandCombo(db, line.combo_id, line.quantity);
}

export function comboPartsOfOrderItem(db, item) {
  if (!item) return [];
  const selections = item.combo_selections || item.selections;
  if (Array.isArray(selections) && selections.length) {
    return expandComboSelections(selections, item.quantity);
  }
  return expandCombo(db, item.combo_id, item.quantity);
}

/* 一条订单行占用的商品件数（套餐按选品/明细展开） */
export function linePieces(db, line) {
  if (line.item_type === 'combo') {
    return comboPartsOfLine(db, line).reduce((t, x) => t + x.quantity, 0);
  }
  return int(line.quantity);
}

/* ---------- 订单号：SO + yyyyMMdd + 3 位流水 ---------- */
export function nextOrderNo(db, at) {
  const d = new Date(at || Date.now());
  const prefix = 'SO' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  const used = db.orders.filter(o => o.order_no && o.order_no.startsWith(prefix)).length;
  return prefix + String(used + 1).padStart(3, '0');
}

/* ---------- 库存写入 ---------- */
function writeBalance(db, productId, quantity) {
  db.balances[productId] = quantity;
}

/* 记一条流水；只有已盘点（有余额）的商品才滚动余额，未盘点的先不建账 */
function pushMovement(db, { product_id, movement_type, quantity, ref_type, ref_id, ref_no, note, created_at }) {
  const known = isCounted(db, product_id);
  const before = known ? balanceOf(db, product_id) : null;
  const after = known ? before + int(quantity) : null;
  if (known) writeBalance(db, product_id, after);
  const mv = {
    id: nextId(db, 'mov'),
    product_id,
    movement_type,
    quantity: int(quantity),
    ref_type: ref_type || null,
    ref_id: ref_id || null,
    ref_no: ref_no || null,
    balance_after: after,
    note: note || null,
    created_at: created_at || new Date().toISOString()
  };
  db.movements.push(mv);
  /* R5：出库/盘点后检查阈值 */
  if (known && (movement_type === 'out' || movement_type === 'adjust' || movement_type === 'reversal')) {
    raiseAlertIfNeeded(db, product_id, after, mv.created_at, mv);
  }
  return mv;
}

/* R5：余额 ≤ 安全库存 或 余额为负，且没有未处理预警时，生成一条 */
function raiseAlertIfNeeded(db, productId, balance, at, ref) {
  const p = productById(db, productId);
  if (!p) return null;
  const th = num(p.safety_stock);
  const negative = balance < 0;
  const low = th > 0 && balance <= th;
  if (!negative && !low) return null;
  if (openAlertsOf(db, productId).length) return null;   // 一次触发一条
  const alert = {
    id: nextId(db, 'alert'),
    product_id: productId,
    kind: negative ? 'negative' : 'low',
    quantity: balance,
    threshold: th,
    status: 'open',
    ref_type: ref ? ref.ref_type : null,
    ref_no: ref ? ref.ref_no : null,
    created_at: at || new Date().toISOString(),
    resolved_at: null
  };
  db.alerts.push(alert);
  return alert;
}

/* 按当前余额补建预警（建账 / 修改阈值时用） */
export function syncAlerts(db) {
  const created = [];
  db.products.forEach(p => {
    const b = balanceOf(db, p.id);
    if (b === null) return;
    const a = raiseAlertIfNeeded(db, p.id, b, new Date().toISOString(), null);
    if (a) created.push(a);
  });
  return created;
}

/* ---------- 订单金额与差额 ---------- */
/* 应收 = Σ 明细金额（赠品行为 0） */
export function computeTotal(db, lines) {
  return r2(lines.reduce((t, l) => {
    if (l.is_gift) return t;
    return t + int(l.quantity) * r2(num(l.unit_price));
  }, 0));
}
export function computePieces(db, lines) {
  return lines.reduce((t, l) => t + (l.item_type === 'combo' ? linePieces(db, l) : int(l.quantity)), 0);
}

/* R1：差额校验，返回需要落库的调整记录（可能为 null） */
function resolveAdjustment(total, paid, adjustType, adjustReason) {
  const diff = r2(num(paid) - num(total));
  if (diff === 0) return null;
  if (!adjustType) fail('ADJUST_REASON_REQUIRED', '实收与应收差 ' + (diff > 0 ? '+' : '') + diff + ' 元，请选择差额原因');
  return { adjust_type: adjustType, amount: diff, reason: adjustReason || null };
}

/* ---------- 校验订单行 ---------- */
function validateLines(db, lines) {
  if (!lines || !lines.length) fail('EMPTY_ORDER', '订单为空，请先选择商品');
  lines.forEach(l => {
    const qty = int(l.quantity);
    if (!qty || qty < 1) fail('INVALID_QUANTITY', '「' + (l.product_name || '商品') + '」数量无效');
    if (num(l.unit_price) < 0) fail('INVALID_PRICE', '「' + (l.product_name || '商品') + '」价格无效');
    if (l.item_type === 'combo') {
      const c = comboById(db, l.combo_id);
      if (!c) fail('COMBO_NOT_FOUND', '套餐不存在或已停售');
      if (c.status !== 'on_sale') fail('COMBO_NOT_FOUND', '套餐「' + c.name + '」已停售');
      if (comboHasGroups(c)) {
        const selections = Array.isArray(l.selections) ? l.selections : [];
        const byCategory = new Map();
        selections.forEach(sel => {
          const categoryId = Number(sel.category_id);
          const group = c.groups.find(g => Number(g.category_id) === categoryId);
          if (!group) fail('COMBO_GROUP_MISMATCH', '套餐「' + c.name + '」的选品与子套餐不匹配');
          if (byCategory.has(categoryId)) fail('COMBO_GROUP_DUP', '套餐「' + c.name + '」的同一子套餐不能重复选品');
          byCategory.set(categoryId, sel);
        });
        c.groups.forEach(group => {
          const categoryId = Number(group.category_id);
          const category = categoryById(db, categoryId);
          const categoryName = category ? category.name : ('中类#' + categoryId);
          const required = int(group.quantity);
          const sel = byCategory.get(categoryId);
          if (!sel) fail('COMBO_SELECTION_MISSING', '套餐「' + c.name + '」需要从「' + categoryName + '」选 ' + required + ' 件');
          let count = 0;
          (sel.items || []).forEach(item => {
            const quantity = int(item.quantity);
            if (!quantity || quantity < 1) fail('INVALID_QUANTITY', '「' + categoryName + '」的选品数量无效');
            const p = productById(db, item.product_id);
            if (!p) fail('PRODUCT_NOT_FOUND', '套餐选品里的商品不存在');
            if (p.status !== 'on_sale') fail('PRODUCT_NOT_FOUND', '「' + p.name + '」已停售，不能加入新订单');
            const path = p.category_id ? categoryPath(db, p.category_id) : [];
            if (!path.some(cat => cat.id === categoryId)) {
              fail('COMBO_PRODUCT_CATEGORY', '「' + p.name + '」不属于子套餐「' + categoryName + '」');
            }
            count += quantity;
          });
          if (count !== required) {
            fail('COMBO_SELECTION_COUNT', '子套餐「' + categoryName + '」需选 ' + required + ' 件，当前 ' + count + ' 件');
          }
        });
      } else if (!(c.items || []).length) {
        fail('COMBO_ITEMS_MISSING', '套餐「' + c.name + '」缺少明细，无法扣减库存');
      }
    } else {
      const p = productById(db, l.product_id);
      if (!p) fail('PRODUCT_NOT_FOUND', '商品不存在');
      /* R7：停售商品不可加入新订单 */
      if (p.status !== 'on_sale') fail('PRODUCT_NOT_FOUND', '「' + p.name + '」已停售，不能加入新订单');
    }
  });
}

/* 订单行 → 需要出库的 {product_id, quantity} 汇总 */
function stockImpact(db, lines) {
  const map = new Map();
  lines.forEach(l => {
    const parts = l.item_type === 'combo'
      ? comboPartsOfLine(db, l)
      : [{ product_id: l.product_id, quantity: int(l.quantity) }];
    parts.forEach(pt => {
      map.set(pt.product_id, (map.get(pt.product_id) || 0) + pt.quantity);
    });
  });
  return Array.from(map, ([product_id, quantity]) => ({ product_id, quantity }));
}

/* 选品快照：订单保存后不受套餐后续编辑影响 */
function cloneComboSelections(selections) {
  return (selections || []).map(group => ({
    category_id: Number(group.category_id),
    items: (group.items || []).map(item => ({
      product_id: Number(item.product_id),
      quantity: int(item.quantity)
    }))
  }));
}

/* ---------- 建单（可同时收款） ---------- */
/*
  input: {
    lines: [{ item_type:'product'|'combo', product_id|combo_id, product_name, quantity, unit_price, is_gift }],
    note, channel, paidAmount, adjustType, adjustReason, createdAt, paidAt,
    settle: true 表示建单即收款
  }
  R3：收款 + 出库在同一批写入内完成，校验不通过时不产生任何变更。
*/
export function createOrder(db, input) {
  const lines = input.lines || [];
  validateLines(db, lines);

  const total = computeTotal(db, lines);
  const settle = input.settle !== false && input.paidAmount !== undefined && input.paidAmount !== null && input.paidAmount !== '';
  const paid = settle ? r2(num(input.paidAmount)) : null;

  let adj = null;
  if (settle) {
    if (!input.channel) fail('CHANNEL_REQUIRED', '请选择收款渠道');
    if (paid === null || isNaN(paid)) fail('PAID_AMOUNT_REQUIRED', '请填写实收金额');
    adj = resolveAdjustment(total, paid, input.adjustType, input.adjustReason);
  }

  const createdAt = input.createdAt || new Date().toISOString();
  const order = {
    id: nextId(db, 'order'),
    order_no: nextOrderNo(db, createdAt),
    status: settle ? 'paid' : 'pending',
    channel: settle ? input.channel : null,
    total_amount: total,
    paid_amount: settle ? paid : null,
    item_count: computePieces(db, lines),
    note: input.note || null,
    created_at: createdAt,
    paid_at: settle ? (input.paidAt || createdAt) : null,
    cancelled_at: null,
    cancel_reason: null
  };
  db.orders.push(order);

  lines.forEach(l => {
    db.orderItems.push({
      id: nextId(db, 'item'),
      order_id: order.id,
      item_type: l.item_type === 'combo' ? 'combo' : 'product',
      product_id: l.item_type === 'combo' ? null : l.product_id,
      combo_id: l.item_type === 'combo' ? l.combo_id : null,
      product_name: l.product_name,
      quantity: int(l.quantity),
      unit_price: r2(num(l.unit_price)),
      /* R2：赠品金额为 0 */
      line_amount: l.is_gift ? 0 : r2(int(l.quantity) * num(l.unit_price)),
      is_gift: !!l.is_gift,
      combo_selections: l.item_type === 'combo' && Array.isArray(l.selections) && l.selections.length
        ? cloneComboSelections(l.selections)
        : null
    });
  });

  /* R1：差额落库 */
  if (adj) {
    db.adjustments.push({
      id: nextId(db, 'adj'),
      order_id: order.id,
      adjust_type: adj.adjust_type,
      amount: adj.amount,
      reason: adj.reason,
      created_at: order.paid_at
    });
  }

  const alerts = [];
  if (settle) {
    stockImpact(db, lines).forEach(si => {
      const mv = pushMovement(db, {
        product_id: si.product_id,
        movement_type: 'out',
        quantity: -si.quantity,
        ref_type: 'order',
        ref_id: order.id,
        ref_no: order.order_no,
        created_at: order.paid_at
      });
      const opened = openAlertsOf(db, si.product_id).find(a => a.created_at === mv.created_at);
      if (opened) alerts.push(opened);
    });
  }

  return { order, alerts, adjustment: adj, total, pieces: order.item_count };
}

/* ---------- 确认收款（pending → paid） ---------- */
export function confirmOrder(db, orderId, input) {
  const o = orderById(db, orderId);
  if (!o) fail('ORDER_NOT_FOUND', '订单不存在');
  if (o.status !== 'pending') fail('ORDER_NOT_PENDING', '只有待收款订单可以收款');
  if (!input.channel) fail('CHANNEL_REQUIRED', '请选择收款渠道');
  const paid = r2(num(input.paidAmount));
  if (isNaN(paid)) fail('PAID_AMOUNT_REQUIRED', '请填写实收金额');
  const adj = resolveAdjustment(o.total_amount, paid, input.adjustType, input.adjustReason);

  const paidAt = input.paidAt || new Date().toISOString();
  o.status = 'paid';
  o.channel = input.channel;
  o.paid_amount = paid;
  o.paid_at = paidAt;

  if (adj) {
    db.adjustments.push({
      id: nextId(db, 'adj'), order_id: o.id,
      adjust_type: adj.adjust_type, amount: adj.amount, reason: adj.reason, created_at: paidAt
    });
  }

  const alerts = [];
  stockImpact(db, itemsOfOrder(db, o.id)).forEach(si => {
    pushMovement(db, {
      product_id: si.product_id, movement_type: 'out', quantity: -si.quantity,
      ref_type: 'order', ref_id: o.id, ref_no: o.order_no, created_at: paidAt
    });
  });
  syncAlerts(db).forEach(a => alerts.push(a));
  return { order: o, alerts };
}

/* ---------- 取消 / 冲销 ---------- */
/* R4：已收款订单冲销 → 生成反向流水回补库存，原单不删除 */
export function cancelOrder(db, orderId, reason) {
  const o = orderById(db, orderId);
  if (!o) fail('ORDER_NOT_FOUND', '订单不存在');
  if (o.status === 'cancelled') fail('ORDER_NOT_CANCELLABLE', '订单已冲销，不能重复操作');
  const wasPaid = o.status === 'paid';
  if (wasPaid && !(reason || '').trim()) fail('REASON_REQUIRED', '冲销已收款订单必须填写原因');

  const at = new Date().toISOString();
  o.status = 'cancelled';
  o.cancelled_at = at;
  o.cancel_reason = (reason || '取消订单').trim();

  const alerts = [];
  if (wasPaid) {
    stockImpact(db, itemsOfOrder(db, o.id)).forEach(si => {
      pushMovement(db, {
        product_id: si.product_id, movement_type: 'reversal', quantity: si.quantity,
        ref_type: 'order', ref_id: o.id, ref_no: o.order_no,
        note: '冲销回补：' + o.cancel_reason, created_at: at
      });
    });
    /* 回补后可能已脱离预警区，未处理预警一并关闭 */
    db.alerts.forEach(a => {
      if (a.status !== 'open') return;
      const b = balanceOf(db, a.product_id);
      if (b === null) return;
      const th = num((productById(db, a.product_id) || {}).safety_stock);
      if (b >= 0 && (th <= 0 || b > th)) { a.status = 'resolved'; a.resolved_at = at; a.resolve_note = '冲销回补后库存恢复'; }
    });
  }
  return { order: o, reversed: wasPaid, alerts };
}

/* ---------- 入库 ---------- */
export function stockIn(db, items, note, at) {
  if (!items || !items.length) fail('EMPTY_ITEMS', '请选择要入库的商品');
  const time = at || new Date().toISOString();
  const written = [];
  items.forEach(it => {
    const qty = int(it.quantity);
    if (!qty || qty < 1) fail('INVALID_QUANTITY', '入库数量必须大于 0');
    const p = productById(db, it.product_id);
    if (!p) fail('PRODUCT_NOT_FOUND', '商品不存在');
    /* 首次入库即为该商品建账 */
    if (!isCounted(db, it.product_id)) writeBalance(db, it.product_id, 0);
    pushMovement(db, {
      product_id: it.product_id, movement_type: 'in', quantity: qty,
      ref_type: 'purchase', ref_no: null, note: note || null, created_at: time
    });
    written.push({ product: p, quantity: qty, balance: balanceOf(db, it.product_id) });
  });
  return { written, at: time };
}

/* ---------- 盘点（R6） ---------- */
export function setStock(db, productId, counted, reason, at) {
  const p = productById(db, productId);
  if (!p) fail('PRODUCT_NOT_FOUND', '商品不存在');
  const c = int(counted);
  if (isNaN(c) || c < 0) fail('INVALID_COUNTED', '盘点数量无效');
  const time = at || new Date().toISOString();
  const before = balanceOf(db, productId);
  if (before === null) {
    /* 首次建账：直接以实盘数作为期初，记一条 in 流水 */
    writeBalance(db, productId, 0);
    pushMovement(db, {
      product_id: productId, movement_type: 'in', quantity: c,
      ref_type: 'stocktake', note: '期初建账' + (reason ? '：' + reason : ''), created_at: time
    });
    return { changed: true, before: null, balance: c, diff: c, first: true };
  }
  const diff = c - before;
  if (diff === 0) return { changed: false, before, balance: before, diff: 0, first: false };
  pushMovement(db, {
    product_id: productId, movement_type: 'adjust', quantity: diff,
    ref_type: 'stocktake', note: reason || null, created_at: time
  });
  return { changed: true, before, balance: balanceOf(db, productId), diff, first: false };
}

/* ---------- 分类树（最多两级，用户自己维护） ---------- */
export const categoryById = (db, id) => db.categories.find(c => c.id === id) || null;

export function categoryPath(db, id) {
  const path = [];
  let cur = categoryById(db, id);
  for (let guard = 0; cur && guard < 8; guard++) {
    path.unshift(cur);
    cur = categoryById(db, cur.parent_id);
  }
  return path;
}
export const categoryLabel = (db, id) => categoryPath(db, id).map(c => c.name).join(' / ');
export const categoryLevel = (db, id) => categoryPath(db, id).length;

export function childrenOf(db, parentId) {
  return db.categories
    .filter(c => (c.parent_id || null) === (parentId || null))
    .sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/* 含子分类在内的商品数 */
export function categoryProductCount(db, id) {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    db.categories.forEach(c => {
      if (c.parent_id && ids.has(c.parent_id) && !ids.has(c.id)) { ids.add(c.id); grew = true; }
    });
  }
  return db.products.filter(p => ids.has(p.category_id)).length;
}

export function upsertCategory(db, data) {
  const name = String(data.name || '').trim();
  if (!name) fail('NAME_REQUIRED', '请填写分类名称');
  if (name.length > 12) fail('NAME_TOO_LONG', '分类名称请控制在 12 个字以内');
  const parent = data.parent_id ? categoryById(db, data.parent_id) : null;
  if (data.parent_id && !parent) fail('CATEGORY_NOT_FOUND', '上级分类不存在');
  const depth = parent ? categoryLevel(db, parent.id) + 1 : 1;
  if (depth > 2) fail('CATEGORY_DEPTH', '最多支持两级分类');
  const siblings = db.categories.filter(c =>
    (c.parent_id || null) === (parent ? parent.id : null) && c.id !== data.id);
  if (siblings.some(c => c.name === name)) fail('CATEGORY_DUP', '同级下已有「' + name + '」');
  if (data.id) {
    const c = categoryById(db, data.id);
    if (!c) fail('CATEGORY_NOT_FOUND', '分类不存在');
    c.name = name;
    return c;
  }
  const c = {
    id: nextId(db, 'category'), name,
    parent_id: parent ? parent.id : null,
    sort: siblings.length,
    created_at: new Date().toISOString()
  };
  db.categories.push(c);
  return c;
}

export function deleteCategory(db, id) {
  const c = categoryById(db, id);
  if (!c) fail('CATEGORY_NOT_FOUND', '分类不存在');
  if (db.categories.some(x => x.parent_id === id)) fail('CATEGORY_HAS_CHILDREN', '「' + c.name + '」下还有子分类，请先处理');
  if (db.products.some(p => p.category_id === id)) fail('CATEGORY_IN_USE', '还有商品挂在「' + c.name + '」下，不能删除');
  db.categories = db.categories.filter(x => x.id !== id);
  return { deleted: true };
}

/* ---------- 标签 ---------- */
export function normalizeTags(list) {
  const out = [];
  (list || []).forEach(t => {
    const v = String(t || '').trim().replace(/^#/, '');
    if (!v) return;
    if (v.length > 10) fail('TAG_TOO_LONG', '标签「' + v + '」太长，控制在 10 个字以内');
    if (!out.includes(v)) out.push(v);
  });
  return out.slice(0, 8);
}

export function addTag(db, name) {
  const v = String(name || '').trim().replace(/^#/, '');
  if (!v) fail('NAME_REQUIRED', '请填写标签名称');
  if (v.length > 10) fail('TAG_TOO_LONG', '标签太长，控制在 10 个字以内');
  if (!db.tags.includes(v)) db.tags.push(v);
  return v;
}

export function renameTag(db, from, to) {
  const next = String(to || '').trim().replace(/^#/, '');
  if (!next) fail('NAME_REQUIRED', '请填写标签名称');
  if (next.length > 10) fail('TAG_TOO_LONG', '标签太长，控制在 10 个字以内');
  if (next !== from && db.tags.includes(next)) fail('TAG_DUP', '标签「' + next + '」已存在');
  db.tags = db.tags.map(t => (t === from ? next : t));
  db.products.forEach(p => {
    if (Array.isArray(p.tags)) p.tags = Array.from(new Set(p.tags.map(t => (t === from ? next : t))));
  });
  return next;
}

export function deleteTag(db, name) {
  db.tags = db.tags.filter(t => t !== name);
  db.products.forEach(p => {
    if (Array.isArray(p.tags)) p.tags = p.tags.filter(t => t !== name);
  });
  return { deleted: true };
}

/* 由旧的「品类」文本生成两级分类树：大类 → 中类，商品挂在中类 */
const L1_GROUPS = [
  { name: '挂件饰品', categories: ['挂件', '小件', '摆件'] },
  { name: '吧唧徽章', categories: ['吧唧', '吧唧立牌'] },
  { name: '纸品印刷', categories: ['贴纸', '明信片'] },
  { name: '随身配件', categories: ['手绳', '袋子', '本子'] },
  { name: '礼盒福袋', categories: ['福袋'] }
];

export function buildCategoryTree(db) {
  if (db.categories && db.categories.length) return db.categories;
  db.categories = db.categories || [];
  if (!db.seq) db.seq = {};
  const now = new Date().toISOString();
  const mk = (name, parent) => {
    const siblings = db.categories.filter(c => (c.parent_id || null) === (parent ? parent.id : null));
    const c = {
      id: nextId(db, 'category'), name,
      parent_id: parent ? parent.id : null,
      sort: siblings.length, created_at: now
    };
    db.categories.push(c);
    return c;
  };
  const l1Nodes = new Map();
  L1_GROUPS.forEach(g => l1Nodes.set(g.name, { node: mk(g.name, null), cats: g.categories }));
  const otherNode = mk('其他', null);
  const pickL1 = catName => {
    for (const [, g] of l1Nodes) if (g.cats.includes(catName)) return g.node;
    return otherNode;
  };
  const l2Key = new Map();
  db.products.forEach(p => {
    const catName = String(p.category || '其他').trim() || '其他';
    const l1 = pickL1(catName);
    let l2 = l2Key.get(l1.id + '|' + catName);
    if (!l2) { l2 = mk(catName, l1); l2Key.set(l1.id + '|' + catName, l2); }
    p.category_id = l2.id;
    if (!Array.isArray(p.tags)) p.tags = [];
  });
  return db.categories;
}

/* 老数据里的小类（第三级）归并到所属中类，保留商品上的系列文本快照 */
export function collapseCategoryDepth(db) {
  let changed = false;
  db.products.forEach(p => {
    const path = p.category_id ? categoryPath(db, p.category_id) : [];
    if (path.length > 2 && path[1]) {
      p.category_id = path[1].id;
      changed = true;
    }
  });
  const kept = db.categories.filter(c => categoryPath(db, c.id).length <= 2);
  if (kept.length !== db.categories.length) {
    db.categories = kept;
    changed = true;
  }
  return changed;
}

/* ---------- 商品 / 套餐 ---------- */
export function upsertProduct(db, data) {
  const tags = normalizeTags(data.tags);
  const categoryId = data.category_id ? Number(data.category_id) : null;
  const path = categoryId ? categoryPath(db, categoryId) : [];
  if (categoryId && !path.length) fail('CATEGORY_NOT_FOUND', '分类不存在');
  const deepest = path.length ? path[path.length - 1].name : '';
  const mid = path.length >= 2 ? path[1].name : deepest;
  const prev = data.id ? productById(db, data.id) : null;
  /* 只改价格等信息时保留原来的系列快照，避免统计和开单筛选被重置 */
  const series = prev && (prev.category_id || null) === categoryId && prev.series
    ? prev.series
    : (deepest || String(data.series || '').trim() || '未分类');
  const payload = {
    name: String(data.name || '').trim(),
    category_id: categoryId,
    tags,
    /* 系列/品类是分类路径的快照，订单、统计、库存等既有视图继续可用 */
    series,
    category: mid || String(data.category || '').trim() || '其他',
    unit: data.unit || '件',
    list_price: r2(num(data.list_price)),
    cost_price: data.cost_price === '' || data.cost_price === null || data.cost_price === undefined ? null : r2(num(data.cost_price)),
    safety_stock: Math.max(0, int(data.safety_stock)),
    barcode: String(data.barcode || '').trim() || null,
    status: data.status === 'off_sale' ? 'off_sale' : 'on_sale'
  };
  if (!payload.name) fail('NAME_REQUIRED', '请填写商品名称');
  tags.forEach(t => { if (!db.tags.includes(t)) db.tags.push(t); });
  if (data.id) {
    const p = productById(db, data.id);
    if (!p) fail('PRODUCT_NOT_FOUND', '商品不存在');
    const thChanged = num(p.safety_stock) !== payload.safety_stock;
    Object.assign(p, payload);
    if (thChanged) syncAlerts(db);
    return p;
  }
  const p = {
    id: nextId(db, 'product'),
    sku_code: String(data.sku_code || '').trim() || ('P' + Date.now().toString(36).toUpperCase()),
    ...payload,
    created_at: new Date().toISOString()
  };
  if (db.products.some(x => x.sku_code === p.sku_code)) fail('SKU_DUP', 'SKU 编码「' + p.sku_code + '」已存在');
  db.products.push(p);
  syncAlerts(db);
  return p;
}

export function toggleProductStatus(db, id) {
  const p = productById(db, id);
  if (!p) fail('PRODUCT_NOT_FOUND', '商品不存在');
  p.status = p.status === 'on_sale' ? 'off_sale' : 'on_sale';
  return p;
}

export function upsertCombo(db, data) {
  const name = String(data.name || '').trim();
  if (!name) fail('NAME_REQUIRED', '请填写套餐名称');
  let groups = (data.groups || [])
    .map(g => ({ category_id: Number(g.category_id) || null, quantity: Math.max(1, int(g.quantity)) }))
    .filter(g => g.category_id);
  /* 兼容旧客户端：只传固定商品时按中类归并出子套餐 */
  if (!groups.length && Array.isArray(data.items)) groups = deriveComboGroups(db, data.items);
  if (!groups.length) fail('COMBO_GROUPS_MISSING', '请至少配置一个子套餐');
  const seen = new Set();
  groups.forEach(g => {
    const category = categoryById(db, g.category_id);
    if (!category) fail('CATEGORY_NOT_FOUND', '子套餐的中类不存在');
    if (categoryLevel(db, category.id) !== 2) fail('COMBO_GROUP_LEVEL', '子套餐只能选择中类');
    if (seen.has(category.id)) fail('COMBO_GROUP_DUP', '同一中类只能配置一次');
    seen.add(category.id);
  });

  const payload = {
    name,
    combo_price: r2(num(data.combo_price)),
    original_price: data.original_price === '' || data.original_price == null ? null : r2(num(data.original_price)),
    status: data.status === 'off_sale' ? 'off_sale' : 'on_sale',
    groups
  };
  if (data.id) {
    const c = comboById(db, data.id);
    if (!c) fail('COMBO_NOT_FOUND', '套餐不存在');
    /* items 是旧订单的固定明细快照，编辑时保留，避免历史订单被改写 */
    Object.assign(c, payload);
    if (!Array.isArray(c.items)) c.items = [];
    return c;
  }
  const c = {
    id: nextId(db, 'combo'), combo_code: 'C' + Date.now().toString(36).toUpperCase(),
    items: [], ...payload
  };
  db.combos.push(c);
  return c;
}

export function deleteCombo(db, id) {
  const i = db.combos.findIndex(c => c.id === id);
  if (i < 0) fail('COMBO_NOT_FOUND', '套餐不存在');
  /* 历史订单引用了就不物理删，只停售（R4 精神：单据永不删除） */
  const referenced = db.orderItems.some(x => x.combo_id === id);
  if (referenced) {
    db.combos[i].status = 'off_sale';
    return { deleted: false, reason: '历史订单已引用该套餐，已改为停售' };
  }
  db.combos.splice(i, 1);
  return { deleted: true };
}

/* ---------- 预警处理 ---------- */
export function resolveAlert(db, alertId, note) {
  const a = db.alerts.find(x => x.id === alertId);
  if (!a) fail('ALERT_NOT_FOUND', '预警记录不存在');
  a.status = 'resolved';
  a.resolved_at = new Date().toISOString();
  a.resolve_note = note || '已处理';
  return a;
}

/* ---------- 统计 ---------- */
/* 本地日历日键，避免 UTC 切片把晚间订单算到第二天 */
const dayKeyOf = iso => { const d = new Date(iso); return ymd(d); };

export function paidOrdersIn(db, fromDate, toDate) {
  const from = new Date(fromDate + 'T00:00:00').getTime();
  const to = new Date(toDate + 'T00:00:00').getTime() + 86400000;
  return db.orders.filter(o => {
    if (o.status !== 'paid' || !o.paid_at) return false;
    const t = new Date(o.paid_at).getTime();
    return t >= from && t < to;
  });
}

export function buildStats(db, fromDate, toDate) {
  const from = new Date(fromDate + 'T00:00:00').getTime();
  const to = new Date(toDate + 'T00:00:00').getTime() + 86400000;
  const orders = db.orders.filter(o => {
    if (o.status !== 'paid' || !o.paid_at) return false;
    const t = new Date(o.paid_at).getTime();
    return t >= from && t < to;
  });
  const ids = new Set(orders.map(o => o.id));
  const items = db.orderItems.filter(i => ids.has(i.order_id) && i.item_type === 'product');
  const comboItems = db.orderItems.filter(i => ids.has(i.order_id) && i.item_type === 'combo');
  const adjs = db.adjustments.filter(a => ids.has(a.order_id));

  const revenue = r2(orders.reduce((t, o) => t + num(o.paid_amount), 0));
  const receivable = r2(orders.reduce((t, o) => t + num(o.total_amount), 0));
  const pieces = orders.reduce((t, o) => t + int(o.item_count), 0);
  const gifts = db.orderItems.filter(i => ids.has(i.order_id) && i.is_gift)
    .reduce((t, i) => t + int(i.quantity), 0);

  /* 按日营收 */
  const dayMap = {};
  const dayCountMap = {};
  orders.forEach(o => {
    const d = dayKeyOf(o.paid_at);
    dayMap[d] = r2((dayMap[d] || 0) + num(o.paid_amount));
    dayCountMap[d] = (dayCountMap[d] || 0) + 1;
  });
  const daily = [];
  const cur = new Date(fromDate + 'T00:00:00');
  const end = new Date(toDate + 'T00:00:00');
  while (cur <= end) {
    const d = ymd(cur);
    daily.push({ date: d, revenue: dayMap[d] || 0, count: dayCountMap[d] || 0 });
    cur.setDate(cur.getDate() + 1);
  }

  /* TOP 商品（含套餐内商品，按实际出货件数） */
  const topMap = {};
  items.forEach(i => {
    const k = i.product_name;
    if (!topMap[k]) topMap[k] = { name: k, qty: 0, amount: 0, gifts: 0 };
    topMap[k].qty += int(i.quantity);
    topMap[k].amount = r2(topMap[k].amount + num(i.line_amount));
    if (i.is_gift) topMap[k].gifts += int(i.quantity);
  });
  comboItems.forEach(ci => {
    comboPartsOfOrderItem(db, ci).forEach(part => {
      const p = productById(db, part.product_id);
      const k = p ? p.name : ('商品#' + part.product_id);
      if (!topMap[k]) topMap[k] = { name: k, qty: 0, amount: 0, gifts: 0 };
      topMap[k].qty += int(part.quantity);
    });
  });
  const top = Object.values(topMap).sort((a, b) => b.qty - a.qty);

  /* 系列分布 */
  const seriesMap = {};
  Object.values(topMap).forEach(row => {
    const p = db.products.find(x => x.name === row.name);
    const s = p ? (p.series || '未分类') : '未分类';
    if (!seriesMap[s]) seriesMap[s] = { name: s, qty: 0, amount: 0 };
    seriesMap[s].qty += row.qty;
    seriesMap[s].amount = r2(seriesMap[s].amount + row.amount);
  });

  /* 渠道 */
  const chMap = {};
  orders.forEach(o => {
    const c = o.channel || 'other';
    if (!chMap[c]) chMap[c] = { key: c, amount: 0, count: 0 };
    chMap[c].amount = r2(chMap[c].amount + num(o.paid_amount));
    chMap[c].count += 1;
  });

  /* 差额损益（按原因） */
  const adjMap = {};
  adjs.forEach(a => {
    const k = a.adjust_type || '未分类';
    if (!adjMap[k]) adjMap[k] = { type: k, amount: 0, count: 0 };
    adjMap[k].amount = r2(adjMap[k].amount + num(a.amount));
    adjMap[k].count += 1;
  });

  return {
    from: fromDate, to: toDate,
    summary: {
      revenue, receivable, count: orders.length,
      avg: orders.length ? r2(revenue / orders.length) : 0,
      pieces, gifts,
      giftRate: pieces ? Math.round(gifts / pieces * 100) : 0,
      diff: r2(revenue - receivable),
      diffCount: adjs.length,
      diffRate: orders.length ? Math.round(adjs.length / orders.length * 100) : 0
    },
    daily,
    top: top.slice(0, 10),
    topAll: top,
    series: Object.values(seriesMap).sort((a, b) => b.qty - a.qty),
    channels: Object.values(chMap).sort((a, b) => b.amount - a.amount),
    adjustments: Object.values(adjMap).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  };
}
