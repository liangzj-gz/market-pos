#!/usr/bin/env node
/**
 * import-backup.mjs —— 把「摆摊订单管家」导出的 JSON 备份导入自托管数据库
 *
 * 用法（在部署目录 server/ 下，先 npm install）：
 *   node src/import-backup.mjs <备份.json> <登录账号(手机号)>
 *
 * 数据来源：正式站点 设置 → 导出当前数据（JSON 备份）（export_dataset 格式）
 * 目标：自托管 PostgreSQL（连接参数走 PG* 环境变量，与 API 相同）
 *
 * 特性：
 * - owner_id 全部重映射为本地账号的 uid
 * - 幂等：ON CONFLICT DO NOTHING，重复执行不会产生重复数据
 * - 导入后自动重建 id_counters / order_no_counters 游标
 */
import fs from 'node:fs';
import path from 'node:path';
import { pool, q } from './db.js';
import { hashPassword } from './auth-util.js';

const [,, backupFile, account] = process.argv;
if (!backupFile || !account) {
  console.error('用法: node src/import-backup.mjs <备份.json> <登录账号(手机号)>');
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(path.resolve(backupFile), 'utf8'));

async function main() {
  /* 1) 本地账号必须已存在（先在页面上「首次建号」），或自动创建（密码=账号后6位） */
  let user = (await q(`SELECT id::text AS uid FROM local_users WHERE phone = $1`, [account]))[0];
  if (!user) {
    const r = (await q(
      `INSERT INTO local_users (phone, password_hash, name) VALUES ($1,$2,$1) RETURNING id::text AS uid`,
      [account, hashPassword(account.slice(-6))]
    ))[0];
    user = r;
    console.log(`已创建本地账号 ${account}（初始密码=账号后 6 位，请尽快修改）`);
  }
  const uid = user.uid;
  console.log(`目标账号 uid = ${uid}`);

  const D = (s) => s === undefined || s === null ? null : s;

  /* 2) 分类 */
  for (const c of raw.categories || []) {
    await q(
      `INSERT INTO categories (owner_id, id, parent_id, name, sort, created_at)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now()))
       ON CONFLICT DO NOTHING`,
      [uid, c.id, D(c.parent_id), c.name, c.sort ?? 0, D(c.created_at)]
    );
  }
  console.log(`分类 ${(raw.categories || []).length}`);

  /* 3) 标签 */
  for (const t of raw.tags || []) {
    await q(`INSERT INTO tags (owner_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [uid, t]);
  }

  /* 4) 商品 + 商品标签 */
  for (const p of raw.products || []) {
    await q(
      `INSERT INTO products (owner_id, id, category_id, sku_code, barcode, name, series, unit,
                             list_price, cost_price, safety_stock, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13::timestamptz, now()))
       ON CONFLICT DO NOTHING`,
      [uid, p.id, D(p.category_id), D(p.sku_code), D(p.barcode), p.name,
       D(p.series), D(p.unit) || '件', p.list_price, D(p.cost_price), D(p.safety_stock) ?? 0,
       D(p.status) || 'on_sale', D(p.created_at)]
    );
    for (const t of p.tags || []) {
      await q(`INSERT INTO product_tags (owner_id, product_id, tag_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [uid, p.id, t]);
    }
  }
  console.log(`商品 ${(raw.products || []).length}`);

  /* 5) 套餐 + 明细 + 分组 */
  for (const c of raw.combos || []) {
    await q(
      `INSERT INTO combos (owner_id, id, combo_code, name, combo_price, original_price, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()))
       ON CONFLICT DO NOTHING`,
      [uid, c.id, D(c.combo_code), c.name, c.combo_price, D(c.original_price), D(c.status) || 'on_sale', D(c.created_at)]
    );
    let sort = 0;
    for (const it of c.items || []) {
      await q(
        `INSERT INTO combo_items (owner_id, combo_id, product_id, quantity, sort)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [uid, c.id, it.product_id, it.quantity, sort++]
      );
    }
    sort = 0;
    for (const g of c.groups || []) {
      await q(
        `INSERT INTO combo_groups (owner_id, combo_id, category_id, category_l1_id, quantity, sort)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [uid, c.id, g.category_id, D(g.category_l1_id), g.quantity, sort++]
      );
      for (const pid of g.product_ids || []) {
        await q(
          `INSERT INTO combo_group_products (owner_id, combo_id, category_id, product_id)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [uid, c.id, g.category_id, pid]
        );
      }
    }
  }
  console.log(`套餐 ${(raw.combos || []).length}`);

  /* 6) 订单 → 订单明细（+套餐选品） */
  for (const o of raw.orders || []) {
    await q(
      `INSERT INTO orders (owner_id, id, order_no, status, channel, item_count,
                           total_amount, paid_amount, paid_at, created_at, note,
                           cancel_reason, cancelled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT DO NOTHING`,
      [uid, o.id, o.order_no, o.status, o.channel, o.item_count,
       o.total_amount, D(o.paid_amount), D(o.paid_at), o.created_at, D(o.note),
       D(o.cancel_reason), D(o.cancelled_at)]
    );
  }
  console.log(`订单 ${(raw.orders || []).length}`);

  for (const i of raw.orderItems || []) {
    await q(
      `INSERT INTO order_items (owner_id, id, order_id, line_no, item_type, product_id, product_name,
                                combo_id, quantity, unit_price, line_amount, is_gift, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13::timestamptz, now()))
       ON CONFLICT DO NOTHING`,
      [uid, i.id, i.order_id, i.line_no, i.item_type, D(i.product_id), i.product_name,
       D(i.combo_id), i.quantity, i.unit_price, i.line_amount, !!i.is_gift, D(i.created_at)]
    );
    for (const sel of i.combo_selections || []) {
      for (const x of sel.items || []) {
        await q(
          `INSERT INTO order_item_selections (owner_id, order_item_id, category_id, product_id, quantity)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [uid, i.id, sel.category_id, x.product_id, x.quantity]
        );
      }
    }
  }
  console.log(`明细 ${(raw.orderItems || []).length}`);

  /* 7) 差额调整 */
  for (const a of raw.adjustments || []) {
    await q(
      `INSERT INTO adjustments (owner_id, id, order_id, adjust_type, amount, reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()))
       ON CONFLICT DO NOTHING`,
      [uid, a.id, a.order_id, a.adjust_type, a.amount, D(a.reason), D(a.created_at)]
    );
  }

  /* 8) 库存流水（导出 JSON 里的 ref_id = 表里的 order_id） */
  for (const m of raw.movements || []) {
    await q(
      `INSERT INTO movements (owner_id, id, product_id, movement_type, quantity, balance_after,
                              ref_type, order_id, ref_no, note, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, now()))
       ON CONFLICT DO NOTHING`,
      [uid, m.id, m.product_id, m.movement_type, m.quantity, m.balance_after,
       D(m.ref_type), D(m.ref_id), D(m.ref_no), D(m.note), D(m.created_at)]
    );
  }
  console.log(`流水 ${(raw.movements || []).length}`);

  /* 9) 库存余额 */
  for (const [pid, qty] of Object.entries(raw.balances || {})) {
    await q(
      `INSERT INTO inventory_balances (owner_id, product_id, quantity, updated_at)
       VALUES ($1,$2,$3, now()) ON CONFLICT (owner_id, product_id)
       DO UPDATE SET quantity = EXCLUDED.quantity`,
      [uid, Number(pid), qty]
    );
  }

  /* 10) 库存预警 */
  for (const a of raw.alerts || []) {
    await q(
      `INSERT INTO stock_alerts (owner_id, id, product_id, kind, quantity, threshold,
                                 status, ref_type, ref_no, resolve_note, resolved_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12::timestamptz, now()))
       ON CONFLICT DO NOTHING`,
      [uid, a.id, a.product_id, a.kind, a.quantity, a.threshold,
       D(a.status) || 'open', D(a.ref_type), D(a.ref_no), D(a.resolve_note), D(a.resolved_at), D(a.created_at)]
    );
  }

  /* 11) 收款码（只存路径；图片文件不入库，自托管需重新上传或手动放文件） */
  for (const [channel, storagePath] of Object.entries(raw.paymentCodes || {})) {
    if (storagePath) {
      await q(
        `INSERT INTO payment_codes (owner_id, channel, storage_path)
         VALUES ($1,$2,$3) ON CONFLICT (owner_id, channel) DO UPDATE SET storage_path = EXCLUDED.storage_path`,
        [uid, channel, storagePath]
      );
    }
  }

  /* 12) id 游标（保证新单 id 不撞） */
  const seq = raw.seq || {};
  for (const [name, val] of Object.entries(seq)) {
    await q(
      `INSERT INTO id_counters (owner_id, name, next_value) VALUES ($1,$2,$3)
       ON CONFLICT (owner_id, name) DO UPDATE SET next_value = GREATEST(id_counters.next_value, EXCLUDED.next_value)`,
      [uid, name, Math.max(Number(val) || 1, 2)]
    );
  }

  /* 13) 订单号日计数器（从订单号重建，与云端 0010 迁移同口径） */
  const counters = {};
  for (const o of raw.orders || []) {
    const m = String(o.order_no || '').match(/^SO(\d{8})(\d{3,})$/);
    if (!m) continue;
    const day = `${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}`;
    const seqNo = Number(m[2]);
    counters[day] = Math.max(counters[day] || 0, seqNo);
  }
  for (const [day, last] of Object.entries(counters)) {
    await q(
      `INSERT INTO order_no_counters (owner_id, day, last_seq) VALUES ($1,$2,$3)
       ON CONFLICT (owner_id, day) DO UPDATE SET last_seq = GREATEST(order_no_counters.last_seq, EXCLUDED.last_seq)`,
      [uid, day, last]
    );
  }

  /* 14) 核对 */
  const counts = {};
  for (const [label, table] of [['categories','categories'],['products','products'],['combos','combos'],
    ['orders','orders'],['order_items','order_items'],['adjustments','adjustments'],
    ['movements','movements'],['inventory_balances','inventory_balances'],['stock_alerts','stock_alerts']]) {
    const r = (await q(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id = $1`, [uid]))[0];
    counts[label] = r.n;
  }
  console.log('\n导入完成，当前库内数量：');
  console.table(counts);
  await pool.end();
}

main().catch(async (e) => {
  console.error('导入失败（已写入的部分不影响，脚本可重复执行）：', e.message);
  await pool.end();
  process.exit(1);
});
