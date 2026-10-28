#!/usr/bin/env node
/**
 * reset-password.mjs —— 重置本地账号密码（保留 uid，业务数据不受影响）
 *
 * 用法（在部署目录）：
 *   docker compose exec api node src/reset-password.mjs <手机号> <新密码>
 *
 * 与「删号重建」的区别：删号会让新账号 uid 变化，旧数据（owner_id）全部看不到；
 * 本脚本只改 password_hash，uid 不变，数据完好。
 */
import { pool, q1 } from './db.js';
import { hashPassword } from './auth-util.js';

const [,, phone, newPassword] = process.argv;
if (!phone || !newPassword) {
  console.error('用法: node src/reset-password.mjs <手机号> <新密码>');
  process.exit(1);
}
if (String(newPassword).length < 6) {
  console.error('密码至少 6 位');
  process.exit(1);
}

const user = await q1(`SELECT id::text AS uid, name FROM local_users WHERE phone = $1`, [phone]);
if (!user) {
  console.error(`账号 ${phone} 不存在（可用账号见下）`);
  const all = await import('./db.js').then(m => m.q(`SELECT phone FROM local_users ORDER BY id`));
  console.error(all.map(u => '  ' + u.phone).join('\n'));
  await pool.end();
  process.exit(1);
}

await import('./db.js').then(m =>
  m.q(`UPDATE local_users SET password_hash = $2 WHERE phone = $1`, [phone, hashPassword(newPassword)])
);
console.log(`✅ 已重置 ${phone}（uid=${user.uid} 不变，数据完好）的密码，请用新密码登录。`);
await pool.end();
