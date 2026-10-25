/* ============================================================
   v2 分表同步测试
   纯函数层：node 直接跑断言。
   集成层：jsdom + 模拟 WorkBuddyCloud（内存版分表后端），
   覆盖 迁移 → 增量保存 → 删除 → 二次加载一致性 → resetDemo。
   运行：NODE 无需装包到项目里，jsdom 走 binaries workspace。
   ============================================================ */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/* ---------- Part A：sync.js 纯函数 ---------- */
const sync = await import('../src/data/sync.js');
const { SYNC_TABLES, SEQ_KEYS, buildTableSnapshot, buildMetaSnapshot, metaPart, diffTable, rowsToRecords } = sync;

assert.equal(SYNC_TABLES.length, 8);
assert.deepEqual(SEQ_KEYS, ['order', 'item', 'adj', 'mov', 'alert', 'product', 'combo', 'category']);

const snap0 = buildTableSnapshot([]);
assert.equal(diffTable([], snap0).rows.length, 0);
assert.equal(diffTable([], snap0).deleteIds.length, 0);

const base = [
  { id: 1, name: 'A', price: 1 },
  { id: 2, name: 'B', price: 2 }
];
const snap1 = buildTableSnapshot(base);
/* 无变化 */
assert.deepEqual(diffTable(base, snap1).rows, []);
assert.deepEqual(diffTable(base, snap1).deleteIds, []);
/* 新增 + 修改 + 删除 */
const changed = [...base, { id: 3, name: 'C', price: 3 }];
changed[0] = { id: 1, name: 'A2', price: 1 };
const d1 = diffTable(changed, snap1);
assert.equal(d1.rows.length, 2); // id1 改 + id3 新
assert.deepEqual(d1.rows.map(r => r.rec.id).sort(), [1, 3]);
assert.deepEqual(d1.deleteIds, []); // id2 还在
const d2 = diffTable([base[1]], snap1);
assert.deepEqual(d2.deleteIds, [1]); // id1 没了
/* 同 id 重复只取一条 */
const d3 = diffTable([{ id: 9, name: 'x' }, { id: 9, name: 'y' }], snap1);
assert.equal(d3.rows.length, 1);
assert.equal(d3.rows[0].rec.name, 'x');
/* 无 id 的记录跳过（不合法，不上传） */
assert.equal(diffTable([{ name: 'no-id' }], snap1).rows.length, 0);
/* 快照语义：reset 后旧数据出现在 deleteIds */
const d4 = diffTable([], snap1);
assert.deepEqual(d4.deleteIds.sort(), [1, 2]);
/* rowsToRecords */
assert.deepEqual(rowsToRecords([{ id: 1, data: { id: 1, name: 'A' } }]), [{ id: 1, name: 'A' }]);
/* meta 指纹：balances 的数字键会按数值序序列化，键序不同内容相同 → 指纹一致，不会重传 */
const m1 = metaPart({ tags: ['x'], balances: { 1: 2, 2: 3 }, paymentCodes: {} });
const m2 = metaPart({ tags: ['x'], balances: { 2: 3, 1: 2 }, paymentCodes: {} });
assert.equal(JSON.stringify(m1) === JSON.stringify(m2), true);
assert.equal(buildMetaSnapshot({ tags: [], balances: {}, paymentCodes: {} }), buildMetaSnapshot({ tags: [], balances: {} }));

console.log('Part A：sync.js 纯函数断言全部通过');

/* ---------- Part B：jsdom + 模拟云端 ---------- */
const require2 = createRequire('/Users/liangzj/.workbuddy/binaries/node/workspace/');
const { JSDOM } = require2('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.local/', runScripts: 'outside-only' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const fs = await import('node:fs');
const vueSrc = fs.readFileSync(new URL('../assets/vendor/vue.global.prod.js', import.meta.url), 'utf8');
dom.window.eval(vueSrc);
assert.ok(dom.window.Vue, 'vendor Vue 加载失败');

/* --- 内存版分表后端 --- */
const CLOUD_TABLES = ['products', 'combos', 'categories', 'orders', 'order_items', 'adjustments', 'movements', 'alerts'];
const key = (owner, id) => owner + '\n' + id;
const backend = {
  owner: 'dev-u1',
  rows: Object.fromEntries(CLOUD_TABLES.map(t => [t, new Map()])), // key(owner,id) -> data
  meta: new Map(),       // owner -> doc
  ranges: new Map(),     // owner:name -> base
  legacy: null,          // { version, doc }
  rpcCalls: []
};
function rpcMock(name, params = {}) {
  backend.rpcCalls.push(name);
  const owner = backend.owner;
  if (name === 'load_app_data') {
    const out = { schema: 2, meta: backend.meta.get(owner) || null };
    for (const t of CLOUD_TABLES) {
      const m = backend.rows[t];
      const rows = [...m.entries()].filter(([k]) => k.startsWith(owner + '\n')).map(([k, v]) => ({ id: Number(k.split('\n')[1]), data: v }));
      rows.sort((a, b) => a.id - b.id);
      out[t === 'order_items' ? 'orderItems' : t] = rows;
    }
    return { data: out, error: null };
  }
  if (name === 'save_table_rows') {
    const phys = params.p_table === 'orderItems' ? 'order_items' : params.p_table;
    const m = backend.rows[phys];
    if (!m) return { data: null, error: { message: 'unknown table' } };
    for (const id of params.p_delete_ids || []) m.delete(key(owner, id));
    for (const rec of params.p_upserts || []) m.set(key(owner, rec.id), JSON.parse(JSON.stringify(rec)));
    return { data: null, error: null };
  }
  if (name === 'save_meta') {
    backend.meta.set(owner, JSON.parse(JSON.stringify(params.p_doc)));
    return { data: null, error: null };
  }
  if (name === 'claim_id_range') {
    const key = owner + ':' + params.p_name;
    const prev = backend.ranges.get(key) || 0;
    const base2 = Math.max(prev, params.p_floor) + params.p_count;
    backend.ranges.set(key, base2);
    return { data: base2, error: null };
  }
  return { data: null, error: { message: 'unknown rpc ' + name } };
}
const selectState = async () => ({
  data: backend.legacy ? [{ version: backend.legacy.version, doc: backend.legacy.doc }] : [],
  error: null
});
dom.window.WorkBuddyCloud = {
  createWorkBuddyCloud: () => ({
    auth: {
      getSession: async () => ({ data: { user: { phone: '13800000000' } }, error: null }),
      signInWithPassword: async () => ({ data: { user: { phone: '13800000000' } }, error: null }),
      signOut: async () => ({ data: null, error: null })
    },
    database: {
      rpc: async (name, params) => rpcMock(name, params),
      from: () => ({ select: () => ({ limit: selectState }) })
    }
  })
};

const storeMod = await import('../src/data/store.js');
const { store, bootstrap, actions, scheduleSave, buildSeedDb, SYNC_STATE } = storeMod;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const flush = async () => { scheduleSave(); await sleep(420); }; // 300ms 防抖 + 余量
const canon = db => {
  const j = JSON.parse(JSON.stringify(db));
  delete j.seq; // seq 是本地 id 分配游标，每次登录重新申领区间，不属于同步状态
  for (const k of SYNC_TABLES) j[k] = (j[k] || []).slice().sort((a, b) => a.id - b.id);
  j.categories = (j.categories || []).slice().sort((a, b) => a.id - b.id);
  return JSON.stringify(j);
};

/* 1. 迁移路径：legacy 存在 → 全量进分表，legacy 原样保留 */
backend.legacy = { version: 3, doc: JSON.parse(JSON.stringify(buildSeedDb())) };
await bootstrap();
assert.equal(store.auth.status, 'ready');
assert.equal(store.sync.state, 'saved', '同步态应为 saved：' + store.sync.error);
assert.ok(store.version === null, 'v2 模式 version 应为 null');
const L = backend.legacy.doc;
assert.equal(backend.meta.get(backend.owner).schema_version, 2);
assert.equal(backend.rows.products.size, L.products.length);
assert.equal(backend.rows.orders.size, L.orders.length);
assert.equal(backend.rows.order_items.size, L.orderItems.length);
assert.equal(backend.rows.movements.size, L.movements.length);
assert.equal(backend.rows.adjustments.size, L.adjustments.length);
assert.equal(backend.rows.alerts.size, L.alerts.length);
assert.equal(backend.rows.categories.size, L.categories.length);
assert.equal(backend.rows.combos.size, L.combos.length);
assert.ok(backend.legacy, '迁移后 legacy app_state 必须保留（回滚源）');
assert.equal(store.db.orders.length, L.orders.length);
assert.equal(store.db.balances['1'], L.balances['1']);
console.log('B1：legacy → 分表迁移通过（8 张表行数与 legacy 一致，legacy 保留）');

/* 2. 增量保存：新增商品 → 只有 products 多一行，其余表不动 */
const beforeCounts = Object.fromEntries(CLOUD_TABLES.map(t => [t, backend.rows[t].size]));
const p = actions.saveProduct({ name: '测试新品', sku_code: 'NEW-1', list_price: 10, cost_price: 2, safety_stock: 1, series: '测试', unit: '件' });
assert.ok(p.ok, 'saveProduct 失败：' + (p.error && p.error.message));
assert.ok(p.data.id >= 37, '新商品 id 必须来自申领区间（≥37），实际 ' + p.data.id);
await flush();
assert.equal(backend.rows.products.size, beforeCounts.products + 1);
assert.equal(backend.rows.orders.size, beforeCounts.orders);
assert.ok(backend.rows.products.get ? [...backend.rows.products.values()].some(r => r.name === '测试新品') : false);
console.log('B2：新增商品增量上传通过（id 来自申领区间，其他表零写入）');

/* 3. 入库 + 开单：orders/order_items/movements/balances 全部落云 */
const sin = actions.stockIn([{ product_id: p.data.id, quantity: 10 }], '测试入库');
assert.ok(sin.ok, 'stockIn 失败：' + (sin.error && sin.error.message));
await flush();
const paid = actions.createOrder({
  lines: [{ item_type: 'product', product_id: p.data.id, quantity: 2, unit_price: 10, is_gift: false }],
  channel: 'wechat', paidAmount: 20, settle: true
});
assert.ok(paid.ok, 'createOrder 失败：' + (paid.error && paid.error.message));
await flush();
assert.equal(backend.rows.orders.size, beforeCounts.orders + 1);
assert.equal(backend.rows.order_items.size, beforeCounts.order_items + 1);
assert.equal(backend.rows.movements.size, beforeCounts.movements + 2); // 入库 1 + 出库 1
const metaNow = backend.meta.get(backend.owner);
assert.equal(metaNow.balances[p.data.id], 8); // 10 - 2
console.log('B3：入库与开单增量上传通过（订单/明细/流水/余额同步）');

/* 4. 修改商品 + 删除分类：update 与 delete 都进云端 */
const upd = actions.saveProduct({ ...p.data, list_price: 12 });
assert.ok(upd.ok);
const cat = actions.saveCategory({ name: '测试分类' });
assert.ok(cat.ok);
await flush();
assert.equal(backend.rows.categories.size, beforeCounts.categories + 1);
const del = actions.removeCategory(cat.data.id);
assert.ok(del.ok);
await flush();
assert.equal(backend.rows.categories.size, beforeCounts.categories);
assert.ok(![...backend.rows.categories.values()].some(c => c.name === '测试分类'));
const priceInCloud = [...backend.rows.products.values()].find(r => r.id === p.data.id).list_price;
assert.equal(priceInCloud, 12);
console.log('B4：修改与删除同步通过');

/* 5. 二次加载一致性（模拟换设备重新登录） */
const snapshotBefore = canon(store.db);
store.loaded = false;
await bootstrap();
assert.equal(store.sync.state, 'saved', '二次加载同步态：' + store.sync.error);
assert.equal(canon(store.db), snapshotBefore, '云端装配结果与本地一致');
console.log('B5：二次加载一致性通过');

/* 6. resetDemo：seed 之外的行被删光，云端只剩种子数据 */
const seedOrders = JSON.parse(JSON.stringify(buildSeedDb()));
actions.resetDemo();
await flush();
assert.equal(backend.rows.orders.size, seedOrders.orders.length);
assert.equal(backend.rows.products.size, seedOrders.products.length);
assert.ok(![...backend.rows.products.values()].some(r => r.name === '测试新品'));
store.loaded = false;
await bootstrap();
assert.equal(store.db.orders.length, seedOrders.orders.length);
assert.ok(!store.db.products.some(x => x.name === '测试新品'));
console.log('B6：resetDemo 全量重置同步通过');

/* 7. 模板检查：改动过的 settings 模板必须能编译（防白屏） */
const settingsMod = await import('../src/views/settings.js');
dom.window.Vue.compile(settingsMod.SettingsView.template);
console.log('B7：settings 模板编译通过');

console.log('\n全部测试通过 ✅');
process.exit(0);
