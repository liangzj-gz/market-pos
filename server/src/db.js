import pg from 'pg';

/* pg 默认把 numeric 转 string（保精度），timestamptz 转 Date。
   前端按字符串消费，无需特殊处理。 */

const conf = {
  host: process.env.PGHOST || 'postgres',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'marketpos',
  user: process.env.PGUSER || 'marketpos',
  password: process.env.PGPASSWORD || 'marketpos'
};

export const pool = new pg.Pool({ ...conf, max: 10, idleTimeoutMillis: 30_000 });

export async function q(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}

export async function q1(text, params = []) {
  const rows = await q(text, params);
  return rows[0] || null;
}

/** 以指定 uid 身份执行（等价 WorkBuddy 云的 request.jwt.claim.sub） */
export async function qAs(uid, text, params = []) {
  return q(
    `SELECT set_config('app.uid', $1, true) AS _, t.* FROM ( ${text} ) t`,
    [String(uid), ...params]
  );
}

export async function q1As(uid, text, params = []) {
  const rows = await qAs(uid, text, params);
  return rows[0] || null;
}
