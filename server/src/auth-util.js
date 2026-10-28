import crypto from 'node:crypto';

/** session 载荷：{ uid, name, exp }，token = base64url(json).sig */
const SECRET = process.env.AUTH_SECRET || (() => {
  /* 首次启动自动生成，容器重启后失效——生产请显式设置 AUTH_SECRET */
  const s = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] 未设置 AUTH_SECRET，已生成临时密钥（重启后所有登录失效）');
  return s;
})();

const TTL_MS = Number(process.env.AUTH_TTL_DAYS || 30) * 24 * 3600 * 1000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(uid, name) {
  const payload = { uid, name: name || '', exp: Date.now() + TTL_MS };
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.uid || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** scrypt 加盐哈希：salt$hash（hex） */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `${salt}$${hash}`;
}

export function checkPassword(pw, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes('$')) return false;
  const [salt, hash] = stored.split('$');
  const calc = crypto.scryptSync(String(pw), salt, 32);
  const want = Buffer.from(hash, 'hex');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}
