/* ============================================================
   分表同步纯函数层（v2）

   云端物理分表：products / combos / categories / orders /
   order_items / adjustments / movements / alerts 八张行表
   （每行 = owner_id + id + data JSONB），
   tags / balances / paymentCodes 这三个小对象放 meta 单行。

   这里全是纯函数：输入记录数组 + 云端快照，输出增量。
   不碰 Vue、不碰网络，node 可以直接测试。
   ============================================================ */

/* 与云端表对应的业务数组名（orderItems ↔ 云端 order_items） */
export const SYNC_TABLES = [
  'products', 'combos', 'categories', 'orders',
  'orderItems', 'adjustments', 'movements', 'alerts'
];

/* meta 行的业务键（schema_version 由调用方附加） */
export const META_KEYS = ['tags', 'balances', 'paymentCodes'];

/* id 区间申领相关的 seq 键（rules.js 的 db.seq 键名） */
export const SEQ_KEYS = ['order', 'item', 'adj', 'mov', 'alert', 'product', 'combo', 'category'];

const fingerprint = value => JSON.stringify(value);

/* 一张表的云端快照：id -> JSON 指纹。
   快照语义 = 「云端现在有什么」，与本地 db 无关，
   所以 resetDemo / 导入备份 / 清空都不用动快照，
   被删掉的行会自然出现在 deleteIds 里。 */
export function buildTableSnapshot(records) {
  const map = new Map();
  (records || []).forEach(rec => {
    if (Number.isFinite(rec.id)) map.set(rec.id, fingerprint(rec));
  });
  return map;
}

export function metaPart(db) {
  return {
    tags: db.tags || [],
    balances: db.balances || {},
    paymentCodes: db.paymentCodes || {}
  };
}

export const buildMetaSnapshot = db => fingerprint(metaPart(db));

/* 计算一张表的增量。
   rows: [{ rec, fp }] 新增或内容有变的记录（rec 直接作为云端 data 列存入）；
   deleteIds: 快照里有、现在没有的 id。
   同 id 重复出现时只取第一条（云端 ON CONFLICT 不允许同语句二次冲突）。 */
export function diffTable(records, snap) {
  const rows = [];
  const seen = new Set();
  (records || []).forEach(rec => {
    if (!Number.isFinite(rec.id) || seen.has(rec.id)) return;
    seen.add(rec.id);
    const fp = fingerprint(rec);
    if (snap.get(rec.id) !== fp) rows.push({ rec, fp });
  });
  const deleteIds = [];
  snap.forEach((fp, id) => { if (!seen.has(id)) deleteIds.push(id); });
  return { rows, deleteIds };
}

/* 云端 load 返回的 [{id, data}] 还原成记录数组（data 本身含 id） */
export function rowsToRecords(rows) {
  return (rows || []).map(r => r.data);
}
