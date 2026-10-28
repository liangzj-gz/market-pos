import express from 'express';
import { pool, q, q1, qAs, q1As } from './db.js';
import { signToken, verifyToken, hashPassword, checkPassword } from './auth-util.js';
import { runMigrations } from './migrate.js';

const app = express();
app.use(express.json({ limit: '12mb' }));

/* 启动即执行迁移（失败则退出容器，compose 重启重试） */
let migrated = false;
runMigrations()
  .then(() => { migrated = true; })
  .catch(e => { console.error('[migrate] 启动失败：', e.message); process.exit(1); });

/* ============ 登录 / 会话 ============ */

/* 首次建号密钥：必须配置（.env 的 SETUP_KEY）。没有它，公网扫描器可抢注第一个账号 */
const SETUP_KEY = process.env.SETUP_KEY || '';

const BOOTSTRAP_HINT =
  '库还没有账号。先创建第一个账号：POST /api/setup { phone, password, setupKey }（setupKey 见服务器 .env）';

app.post('/api/setup', async (req, res) => {
  try {
    const { phone, password, name, setupKey } = req.body || {};
    if (!SETUP_KEY) {
      console.error('[setup] 服务器未配置 SETUP_KEY，拒绝建号。请在 .env 设置后 docker compose up -d');
      return res.status(503).json({ error: '服务器未配置建号密钥（SETUP_KEY），请联系管理员' });
    }
    if (setupKey !== SETUP_KEY) {
      return res.status(403).json({ error: '建号密钥不正确（见服务器 .env 的 SETUP_KEY）' });
    }
    if (!phone || !password) return res.status(400).json({ error: '需要 phone 和 password' });
    const cnt = await q1(`SELECT count(*)::int AS n FROM local_users`);
    if (cnt.n > 0) return res.status(403).json({ error: '已初始化过，请直接登录' });
    const user = await q1(
      `INSERT INTO local_users (phone, password_hash, name) VALUES ($1,$2,$3) RETURNING id::text AS uid, phone, name`,
      [String(phone).trim(), hashPassword(password), String(name || phone).trim()]
    );
    res.json({ ok: true, token: signToken(user.uid, user.name), user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (!phone || !password) return res.status(400).json({ error: '需要 phone 和 password' });
    const user = await q1(
      `SELECT id::text AS uid, phone, name, password_hash FROM local_users WHERE phone = $1`,
      [String(phone).trim()]
    );
    if (!user || !checkPassword(password, user.password_hash)) {
      /* 库为空时给出引导 */
      const cnt = await q1(`SELECT count(*)::int AS n FROM local_users`);
      return res.status(401).json({
        error: '手机号或密码错误',
        hint: cnt.n === 0 ? BOOTSTRAP_HINT : undefined
      });
    }
    delete user.password_hash;
    res.json({ ok: true, token: signToken(user.uid, user.name), user });
  } catch (e) {
    if (/relation ".*local_users" does not exist/.test(e.message)) {
      return res.status(503).json({ error: '数据库未初始化，请先执行 SQL 迁移', hint: BOOTSTRAP_HINT });
    }
    res.status(500).json({ error: e.message });
  }
});

function auth(req) {
  const h = req.headers.authorization || '';
  /* img 标签无法带 header：允许 ?t=token（仅收款码读取场景） */
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query && req.query.t) || null;
  const payload = token && verifyToken(token);
  if (!payload) return null;
  return payload;
}

/* ============ RPC 白名单（与 WorkBuddy 云端 26 函数一一对应） ============ */

const RPC_ALLOW = new Set([
  'load_snapshot', 'dashboard', 'list_orders', 'get_order', 'list_movements',
  'stats_summary', 'export_dataset', 'create_order', 'order_action', 'stock_action',
  'save_product', 'import_products', 'save_combo', 'delete_combo', 'save_category',
  'delete_category', 'save_tag', 'toggle_product', 'resolve_alert', 'save_payment_code'
]);

/* 函数参数元数据：从 pg_proc 自省一次，缓存到进程内 */
let fnArgsCache = null;
async function fnArgs() {
  if (fnArgsCache) return fnArgsCache;
  const rows = await q(
    `SELECT p.proname,
            pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'`
  );
  const map = new Map();
  for (const r of rows) {
    const name = r.proname;
    const args = String(r.args || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        /* 形如 "p_payload jsonb" / "p_action text DEFAULT 'in'" */
        const m = s.match(/^([a-z_][a-z0-9_]*)\s+([a-z_\[\]0-9]+)(.*)$/i);
        if (!m) return null;
        return { name: m[1], type: m[2].toLowerCase(), hasDefault: /default/i.test(m[3] || '') };
      })
      .filter(Boolean);
    map.set(name, args);
  }
  fnArgsCache = map;
  return map;
}

/**
 * 参数映射：body 里的 { payload, action, ... } 按 pg 形参顺序对位。
 * 前提：所有带默认值的参数都排在必填参数之后（v3 函数全部满足）。
 * 遇到第一个「未传且有默认值」的参数即截断，后续默认。
 */
function mapArgs(args, body) {
  const out = [];
  for (const a of args) {
    const key = a.name.replace(/^p_/, '');
    let v;
    if (a.name === 'p_payload') v = body.payload;
    else if (a.name === 'p_rows') v = body.rows;
    else if (a.name === 'p_from' || a.name === 'p_to') v = body[key === 'from' ? 'from' : 'to'];
    else v = body[key];
    /* 未传：有默认值记 SKIP（尾部截断后交给 PG 默认值），无默认值补 null */
    if (v === undefined) { out.push(a.hasDefault ? SKIP : null); continue; }
    out.push(v);
  }
  while (out.length && out[out.length - 1] === SKIP) out.pop();
  /* 中间残留的 SKIP（跳着传参）转 null：v3 函数内部都 COALESCE，null=用默认行为 */
  return out.map(x => (x === SKIP ? null : x));
}
const SKIP = Symbol('skip');

app.post('/api/rpc/:fn', async (req, res) => {
  const who = auth(req);
  if (!who) return res.status(401).json({ error: '未登录或会话已过期' });
  const fn = req.params.fn;
  if (!RPC_ALLOW.has(fn)) return res.status(404).json({ error: `未知接口: ${fn}` });

  try {
    const meta = (await fnArgs()).get(fn);
    if (!meta) return res.status(503).json({ error: `数据库缺少函数 ${fn}，请先执行 SQL 迁移` });
    const params = mapArgs(meta, req.body || {});
    /* set_config 必须在函数求值前执行：cfg 在前 + LATERAL 保证顺序 */
    const holders = params.map((_, i) => `$${i + 2}`).join(', ');
    const sql = params.length
      ? `SELECT t.data FROM (SELECT set_config('app.uid', $1, true) AS uid) cfg, LATERAL (SELECT public.${fn}(${holders}) AS data) t`
      : `SELECT t.data FROM (SELECT set_config('app.uid', $1, true) AS uid) cfg, LATERAL (SELECT public.${fn}() AS data) t`;
    const rows = await q(sql, [who.uid, ...params]);
    const first = rows[0] || {};
    res.json(first.data !== undefined ? first.data : first);
  } catch (e) {
    console.error(`[rpc:${fn}]`, e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ============ 收款码图片：上传 / 读取 ============ */

import fs from 'node:fs';
import path from 'node:path';

const FILES_DIR = process.env.FILES_DIR || '/data/files';
try {
  fs.mkdirSync(FILES_DIR, { recursive: true });
} catch (e) {
  console.warn('[files] 无法创建上传目录（首次写入时若仍失败会报错）：', e.message);
}

function safePath(p) {
  if (!p || typeof p !== 'string' || p.includes('..')) return null;
  return p.replace(/^\/+|\/+$/g, '');
}

/* 上传：{ path: "users/<uid>/payment-codes/xx.png", base64, contentType } */
app.post('/api/files', async (req, res) => {
  const who = auth(req);
  if (!who) return res.status(401).json({ error: '未登录' });
  const { path: rel, base64, contentType } = req.body || {};
  const p = safePath(rel);
  if (!p || !base64 || !p.startsWith(`users/${who.uid}/`)) {
    return res.status(400).json({ error: '非法路径或缺少 base64' });
  }
  try {
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: '文件超过 8MB' });
    const abs = path.join(FILES_DIR, p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    res.json({ ok: true, path: p, contentType: contentType || 'image/png' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 读取：GET /api/files/users/<uid>/payment-codes/xx.png（本人或带 token） */
app.get('/api/files/*', (req, res) => {
  const rel = safePath(req.params[0]);
  const who = auth(req);
  if (!rel) return res.status(400).end();
  /* 收款码仅本人可见（img 标签无法带 header，允许 users/<uid>/ 前缀即本人 token 校验后的宽松读） */
  if (!who || !rel.startsWith(`users/${who.uid}/`)) return res.status(403).end();
  const abs = path.join(FILES_DIR, rel);
  if (!fs.existsSync(abs)) return res.status(404).end();
  const ext = path.extname(abs).toLowerCase();
  const ct = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(abs).pipe(res);
});

/* 删除（换码时清理旧图） */
app.delete('/api/files/*', (req, res) => {
  const who = auth(req);
  const rel = safePath(req.params[0]);
  if (!who || !rel || !rel.startsWith(`users/${who.uid}/`)) return res.status(403).end();
  const abs = path.join(FILES_DIR, rel);
  try { fs.unlinkSync(abs); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============ 健康检查 ============ */

app.get('/api/health', async (_req, res) => {
  try {
    await q1('SELECT 1 AS ok');
    if (!migrated) return res.status(503).json({ ok: false, db: 'up', migrate: 'running' });
    const mig = await q1(`SELECT count(*)::int AS n FROM schema_migrations`);
    res.json({ ok: true, db: 'up', migrations: mig.n, ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down', error: e.message });
  }
});

/* 404 */
app.use((req, res) => res.status(404).json({ error: 'not found' }));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[market-pos] API listening on :${PORT}`);
});

export default app;
