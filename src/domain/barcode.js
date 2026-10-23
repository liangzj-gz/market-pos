/* 条码按字符串精确匹配，保留前导零。 */
export const normalizeBarcode = value => String(value ?? '').trim();

export function generateProductBarcode(products, id) {
  const base = 'MP' + String(id).padStart(8, '0');
  let code = base, suffix = 0;
  while (products.some(p => barcodesEqual(p.barcode, code))) code = base + '-' + (++suffix);
  return code;
}

export function fillProductBarcodes(db) {
  let count = 0;
  db.products.forEach(p => {
    if (!normalizeBarcode(p.barcode)) { p.barcode = generateProductBarcode(db.products, p.id); count++; }
  });
  return count;
}

// UPC-A 与前补 0 的 EAN-13 表示同一商品；仅在校验位正确时兼容这两种解码结果。
export function barcodesEqual(left, right) {
  const a = normalizeBarcode(left), b = normalizeBarcode(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const ean = a.length === 13 ? a : b;
  const upc = a.length === 12 ? a : b;
  if (!/^0\d{12}$/.test(ean) || !/^\d{12}$/.test(upc) || ean.slice(1) !== upc) return false;
  const sum = [...ean.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
  return (10 - sum % 10) % 10 === Number(ean[12]);
}

export function matchBarcode(products, value) {
  const code = normalizeBarcode(value);
  if (!code) return { state: 'empty', message: '请扫描或输入商品条码' };
  const matches = products.filter(p => barcodesEqual(p.barcode, code));
  if (!matches.length) return { state: 'missing', message: '未找到条码「' + code + '」，请先到商品页绑定' };
  if (matches.length > 1) return { state: 'duplicate', message: '该条码绑定了多个商品，请先到商品页处理' };
  const product = matches[0];
  if (product.status !== 'on_sale') return { state: 'off_sale', message: '「' + product.name + '」已停售，不能加入本单' };
  return { state: 'ok', product };
}

/* 镜头内持续可见的同一条码仅触发一次，移开 900ms 后才重新允许。 */
export function createScanGate() {
  let locked = '', seenAt = 0;
  const accepted = new Map();
  return (value, now = Date.now()) => {
    const code = normalizeBarcode(value);
    if (!code) { if (now - seenAt >= 900) locked = ''; return false; }
    const key = code.length === 13 && barcodesEqual(code, code.slice(1)) ? code.slice(1) : code;
    seenAt = now;
    if (key === locked) return false;
    locked = key;
    if (accepted.has(key) && now - accepted.get(key) < 1500) return false;
    accepted.set(key, now);
    if (accepted.size > 64) accepted.delete(accepted.keys().next().value);
    return true;
  };
}
