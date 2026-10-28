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

const { fillProductBarcodes, generateProductBarcode } = await import('../src/domain/barcode.js');
const legacy = createDb();
legacy.products = [{ id: 1, barcode: 'PACKAGING-EXISTING' }, { id: 2, barcode: null }, { id: 3, barcode: '' }, { id: 4, barcode: 'MP00000002' }];
const preserved = JSON.stringify(legacy.products[0]);
assert.equal(fillProductBarcodes(legacy), 2);
assert.equal(legacy.products[1].barcode, 'MP00000002-1');
assert.equal(JSON.stringify(legacy.products[0]), preserved);
assert.equal(fillProductBarcodes(legacy), 0);
assert.equal(new Set(legacy.products.map(p => p.barcode)).size, 4);
assert.notEqual(generateProductBarcode(legacy.products, 2), legacy.products[1].barcode);
const fresh = createDb();
const generated = upsertProduct(fresh, { name: '自动生成条码', list_price: 10 });
assert.match(generated.barcode, /^MP\d+/);
assert.equal(matchBarcode(fresh.products, generated.barcode).state, 'ok');
const originalCode = generated.barcode;
upsertProduct(fresh, { ...generated, barcode: '' });
assert.equal(generated.barcode, originalCode);
console.log('自动生成、旧数据补齐、碰撞避让、幂等和保留既有条码检查通过');

let autoStarts = 0, requestedVideo;
globalThis.document = { addEventListener() {} };
window.addEventListener = () => {};
scanner.mounted.call({ start() { autoStarts++; } });
assert.equal(autoStarts, 1);
setMedia({ getUserMedia: async constraints => { requestedVideo = constraints.video; return { getTracks: () => [{ stop() {} }] }; }, enumerateDevices: async () => [] });
instance = makeScanner();
await instance.start();
assert.equal(requestedVideo.facingMode.ideal, 'environment');
instance.stop();
console.log('打开扫码自动启动及默认后置镜头约束检查通过');

instance = makeScanner();
const successScans = [];
instance.$emit = (event, code) => successScans.push(code);
await instance.start();
const realTimeout = globalThis.setTimeout;
let finishSuccess, successDuration;
globalThis.setTimeout = (callback, duration) => { finishSuccess = callback; successDuration = duration; };
instance.showSuccess();
globalThis.setTimeout = realTimeout;
assert.equal(instance.confirming, true);
assert.equal(successDuration, 500);
onDecode({ getText: () => 'MP00000001' });
assert.equal(successScans.length, 0);
instance.manual = 'MP00000001';
instance.submitManual();
assert.equal(successScans.length, 0);
finishSuccess();
assert.equal(instance.confirming, false);
onDecode({ getText: () => 'MP00000001' });
assert.deepEqual(successScans, ['MP00000001']);
instance.showSuccess();
instance.stop();
assert.equal(instance.confirming, false);
console.log('成功反馈停留 500ms、期间暂停接收、恢复及关闭清理检查通过');

instance = makeScanner();
instance.active = false;
let inactiveEmits = 0;
instance.$emit = () => inactiveEmits++;
instance.manual = 'MP00000001';
instance.submitManual();
await instance.start();
assert.equal(instance.running, false);
assert.equal(inactiveEmits, 0);
instance.active = true;
await instance.start();
assert.equal(instance.running, true);
instance.active = false;
scanner.watch.active.call(instance, false);
assert.equal(instance.running, false);
console.log('常驻扫码在收款等窗口中禁用与暂停检查通过');

// 模拟硬件接口，验证短闪及异步关闭；实际亮灯仍需手机验收。
function torchScanner(capability = true, apply) {
  const calls = [];
  const track = {
    getCapabilities: () => ({ torch: capability }),
    applyConstraints: constraints => {
      const value = constraints.advanced[0].torch;
      calls.push(value);
      return apply ? apply(value) : Promise.resolve();
    },
    stop() {}
  };
  const scannerInstance = makeScanner();
  scannerInstance.running = true;
  scannerInstance._stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  return { scannerInstance, calls };
}
let torchTest = torchScanner();
let flashEnd, flashDuration;
globalThis.setTimeout = (callback, duration) => { flashEnd = callback; flashDuration = duration; return 1; };
try { await torchTest.scannerInstance.flashSuccess(); }
finally { globalThis.setTimeout = realTimeout; }
assert.deepEqual(torchTest.calls, [true]);
assert.equal(flashDuration, 150);
await torchTest.scannerInstance.flashSuccess();
assert.deepEqual(torchTest.calls, [true]); // 同一短闪未结束时不叠加请求。
flashEnd();
assert.deepEqual(torchTest.calls, [true, false]);
assert.equal(torchTest.scannerInstance._torchTrack, null);

for (const capability of [undefined, false, [false]]) {
  torchTest = torchScanner(capability);
  // undefined 不走函数默认参数。
  if (capability === undefined) torchTest.scannerInstance._stream.getVideoTracks()[0].getCapabilities = () => ({});
  await torchTest.scannerInstance.flashSuccess();
  assert.deepEqual(torchTest.calls, []);
}
torchTest = torchScanner(true, () => Promise.reject(new Error('系统拒绝闪光灯')));
await torchTest.scannerInstance.flashSuccess();
assert.equal(torchTest.scannerInstance.running, true);
assert.equal(torchTest.scannerInstance.error, '');
assert.equal(torchTest.scannerInstance._torchTrack, null);

let finishTorchOn;
torchTest = torchScanner([false, true], on => on ? new Promise(resolve => { finishTorchOn = resolve; }) : Promise.resolve());
const pendingFlash = torchTest.scannerInstance.flashSuccess();
torchTest.scannerInstance.stop();
finishTorchOn();
await pendingFlash;
assert.deepEqual(torchTest.calls, [true, false, false]); // 迟到的开灯完成后也必须关灯。
assert.equal(torchTest.scannerInstance._torchTimer, null);
assert.equal(torchTest.scannerInstance.running, false);

torchTest = torchScanner();
torchTest.scannerInstance.showSuccess();
await Promise.resolve();
assert.equal(torchTest.scannerInstance.confirming, true);
assert.deepEqual(torchTest.calls, [true]);
torchTest.scannerInstance.stop();
assert.deepEqual(torchTest.calls, [true, false]);
assert.equal(torchTest.scannerInstance._torchTimer, null);
console.log('成功后短闪、无硬件支持、系统拒绝、停止扫码及迟到请求关灯检查通过');
