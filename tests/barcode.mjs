import assert from 'node:assert/strict';
import { createDb, upsertProduct } from '../src/domain/rules.js';
import { matchBarcode, createScanGate, barcodesEqual } from '../src/domain/barcode.js';
import { UiBarcodeScanner as scanner } from '../src/components/barcode-scanner.js';

const db = createDb();
const product = upsertProduct(db, { name: '条码测试', sku_code: 'SCAN-TEST', list_price: 10, barcode: ' 00012345 ' });
assert.equal(product.barcode, '00012345');
assert.equal(matchBarcode(db.products, '00012345').product.id, product.id);
assert.equal(matchBarcode(db.products, '12345').state, 'missing');
assert.equal(matchBarcode(db.products, '').state, 'empty');
assert.throws(() => upsertProduct(db, { name: '重复条码', barcode: product.barcode }), /已绑定/);
assert.equal(db.products.length, 1);
upsertProduct(db, { ...product });
product.status = 'off_sale';
assert.equal(matchBarcode(db.products, product.barcode).state, 'off_sale');
db.products.push({ ...product, id: 999 });
assert.equal(matchBarcode(db.products, product.barcode).state, 'duplicate');
assert.equal(barcodesEqual('0036000291452', '036000291452'), true);
assert.equal(barcodesEqual('0036000291451', '036000291451'), false);
assert.equal(barcodesEqual('00012345', '12345'), false);

const gate = createScanGate();
assert.equal(gate('A', 10000), true);
assert.equal(gate('A', 12000), false); // 持续停留，即使超过冷却时间也不能重复加购。
gate('', 12500);
assert.equal(gate('A', 12510), false); // 短暂识别失败不视为移开。
gate('', 13500);
assert.equal(gate('A', 13510), true);
assert.equal(gate('B', 13520), true);
assert.equal(gate('A', 13530), false);
const upcGate = createScanGate();
assert.equal(upcGate('0036000291452', 20000), true);
assert.equal(upcGate('036000291452', 23000), false);

const makeScanner = () => {
  const instance = { ...scanner.data(), _generation: 0, $refs: { video: {} }, $emit: () => {} };
  for (const [name, method] of Object.entries(scanner.methods)) instance[name] = method.bind(instance);
  return instance;
};
const setMedia = mediaDevices => Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices }, configurable: true });
globalThis.window = { isSecureContext: true };
let release, stopped = 0;
setMedia({ getUserMedia: () => new Promise(resolve => { release = resolve; }) });
let instance = makeScanner();
const pending = instance.start();
instance.stop();
release({ getTracks: () => [{ stop: () => stopped++ }] });
await pending;
assert.equal(stopped, 1); // 用户关闭后才授权，流也必须被释放。
assert.equal(instance.running, false);
setMedia({ getUserMedia: async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }); } });
instance = makeScanner();
await instance.start();
assert.match(instance.error, /权限/);
assert.equal(instance.starting, false);
window.isSecureContext = false;
instance = makeScanner();
await instance.start();
assert.match(instance.error, /HTTPS/);
window.isSecureContext = true;
let onDecode;
window.ZXingBrowser = { BrowserMultiFormatOneDReader: class {
  async decodeFromStream(stream, video, callback) { onDecode = callback; return { stop: () => stopped++ }; }
} };
setMedia({ getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }), enumerateDevices: async () => [] });
instance = makeScanner();
const scanned = [];
instance.$emit = (event, code) => scanned.push(code);
await instance.start();
assert.equal(instance.running, true);
onDecode({ getText: () => '00012345' });
onDecode({ getText: () => '00012345' });
assert.deepEqual(scanned, ['00012345']);
instance.stop();
onDecode({ getText: () => '999' });
assert.equal(scanned.length, 1);
assert.equal(instance.running, false);
console.log('条码匹配、保存约束、防重复及摄像头生命周期检查通过');
