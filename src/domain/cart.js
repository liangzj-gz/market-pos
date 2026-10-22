/* 开单购物车：状态放在 store.ui.cart，这里只提供纯操作与派生计算 */

import { store } from '../data/store.js';
import { num, r2, int } from '../util/format.js';
import { comboPartsOfLine } from '../domain/rules.js';

const cart = () => store.ui.cart;
let comboPickSeq = 0;

export function addProduct(p, qty = 1) {
  const key = 'p' + p.id;
  const line = cart().find(l => l.key === key);
  if (line) line.qty += qty;
  else cart().push({ key, type: 'product', id: p.id, name: p.name, price: num(p.list_price), qty, gift: false, series: p.series });
}

export function addCombo(c, qty = 1) {
  const key = 'c' + c.id;
  const line = cart().find(l => l.key === key);
  if (line) line.qty += qty;
  else cart().push({ key, type: 'combo', id: c.id, name: c.name, price: num(c.combo_price), qty, gift: false, series: '套餐' });
}

/* 自选套餐：每次配置单独一行，selections 是「一份套餐」的选品 */
export function addComboSelection(c, selections, qty = 1) {
  const key = 'c' + c.id + '-' + Date.now().toString(36) + '-' + (++comboPickSeq);
  const snapshot = (selections || []).map(group => ({
    category_id: group.category_id,
    items: (group.items || []).map(item => ({
      product_id: item.product_id,
      quantity: int(item.quantity)
    }))
  }));
  cart().push({
    key, type: 'combo', id: c.id, name: c.name, price: num(c.combo_price),
    qty, gift: false, series: '套餐', selections: snapshot
  });
}

export function incLine(l) { l.qty++; }
export function decLine(l) { if (l.qty <= 1) removeLine(l); else l.qty--; }
export function removeLine(l) {
  const i = cart().findIndex(x => x.key === l.key);
  if (i >= 0) cart().splice(i, 1);
}
export function setLineQty(l, qty) {
  const q = int(qty);
  if (!q || q < 1) { removeLine(l); return; }
  l.qty = q;
}
export function setLinePrice(l, price) {
  const p = num(price);
  l.price = p < 0 ? 0 : r2(p);
}
export function toggleGift(l) { l.gift = !l.gift; }
export function clearCart() { store.ui.cart = []; store.ui.cartNote = ''; }

/* 应收：赠品行计 0（R2） */
export function cartTotal() {
  return r2(cart().reduce((t, l) => t + (l.gift ? 0 : int(l.qty) * num(l.price)), 0));
}
/* 件数：套餐按明细展开 */
export function cartPieces() {
  return cart().reduce((t, l) => {
    if (l.type === 'combo') {
      const parts = comboPartsOfLine(store.db, l);
      return t + (parts.length ? parts.reduce((s, x) => s + x.quantity, 0) : int(l.qty));
    }
    return t + int(l.qty);
  }, 0);
}
/* 转成规则引擎要的订单行 */
export function cartToOrderLines() {
  return cart().map(l => l.type === 'combo'
    ? { item_type: 'combo', combo_id: l.id, product_name: l.name, quantity: int(l.qty), unit_price: r2(num(l.price)), is_gift: false, selections: l.selections || null }
    : { item_type: 'product', product_id: l.id, product_name: l.name, quantity: int(l.qty), unit_price: r2(num(l.price)), is_gift: !!l.gift });
}

/* 购物车里各商品的占用量，用于商品格上显示「扣掉本单后还剩多少」 */
export function cartDemandByProduct() {
  const map = {};
  cart().forEach(l => {
    const parts = l.type === 'combo'
      ? comboPartsOfLine(store.db, l)
      : [{ product_id: l.id, quantity: int(l.qty) }];
    parts.forEach(p => { map[p.product_id] = (map[p.product_id] || 0) + p.quantity; });
  });
  return map;
}

/* 抹零建议：抹到最近的整数 / 整十，摊位上最常用 */
export function roundingSuggestions(total) {
  const t = num(total);
  const out = [];
  const toInt = Math.floor(t);
  if (toInt !== t && t - toInt < t) out.push({ label: '抹零 ¥' + toInt, value: toInt });
  const toTen = Math.floor(t / 10) * 10;
  if (toTen > 0 && toTen !== toInt && toTen < t) out.push({ label: '抹到整十 ¥' + toTen, value: toTen });
  [1, 2, 5].forEach(d => {
    const v = r2(t - d);
    if (v > 0 && !out.some(x => x.value === v) && v !== toInt && v !== toTen) {
      out.push({ label: '−' + d + ' ¥' + v, value: v });
    }
  });
  return out.slice(0, 4);
}
