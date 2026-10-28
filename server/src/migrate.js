import fs from 'node:fs';
import path from 'node:path';
import { q } from './db.js';

/**
 * SQL 迁移执行器：API 启动时按文件名序执行 sql/migrations/ 下未跑过的脚本。
 * - 已跑记录在 schema_migrations 表（脚本名 + 时间 + 耗时）
 * - 每个脚本一个事务；单个失败 = 启动失败（容器退出，compose 会重启重试）
 * - 脚本必须幂等（CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE），
 *   因为失败重试或首次部署 entrypoint 已建过表时可能重复执行
 *
 * 与 postgres entrypoint-initdb.d 的关系：
 * entrypoint 只在「全新空库」时跑 0000-0003（首次部署建库用）；
 * 之后所有 schema 演进（0010+）走本执行器，老库升级时自动补跑。
 */
export async function runMigrations(dir) {
  const MIGR_DIR = dir || process.env.MIGRATIONS_DIR || '/app/sql/migrations';

  await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name      text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    took_ms   integer
  )`);

  if (!fs.existsSync(MIGR_DIR)) {
    console.log('[migrate] 无迁移目录，跳过');
    return;
  }
  const files = fs.readdirSync(MIGR_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
  if (!files.length) { console.log('[migrate] 无待执行脚本'); return; }

  const done = new Set((await q(`SELECT name FROM schema_migrations`)).map(r => r.name));
  const client = await (await import('./db.js')).pool.connect();
  try {
    for (const f of files) {
      if (done.has(f)) continue;
      const t0 = Date.now();
      const sqlText = fs.readFileSync(path.join(MIGR_DIR, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query(
          `INSERT INTO schema_migrations (name, took_ms) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING`,
          [f, Date.now() - t0]
        );
        await client.query('COMMIT');
        console.log(`[migrate] ✓ ${f}（${Date.now() - t0}ms）`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`迁移脚本 ${f} 失败：${e.message}`);
      }
    }
  } finally {
    client.release();
  }
}
