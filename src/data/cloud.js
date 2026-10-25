/* ============================================================
   云端数据层

   只做两件事：
   1. 账号：手机号 + 密码登录、首次激活（短信验证一次）、改密、退出
   2. 数据：整份 store.db 存成一行 JSONB（app_state），带乐观并发

   业务规则一律不在这里，全部留在 domain/rules.js 前端执行，
   云端只负责「按账号存取整份数据」。
   ============================================================ */

import { cloudConfig } from '../cloud-config.js';

let client = null;

export function cloudAvailable() {
  return !!(window.WorkBuddyCloud && typeof window.WorkBuddyCloud.createWorkBuddyCloud === 'function');
}

export function getClient() {
  if (client) return client;
  if (!cloudAvailable()) throw new Error('云端 SDK 没有加载成功，请刷新页面重试');
  client = window.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: cloudConfig.endpoint,
    oauthRelayBaseUrl: cloudConfig.oauthRelayBaseUrl,
    publishableKey: cloudConfig.publishableKey
  });
  return client;
}

function db() { return getClient().database; }
function auth() { return getClient().auth; }

/* ---------- 错误文案 ---------- */
/* 分支判断永远走 error.kind / 错误码，不依赖文案 */
const KIND_MSG = {
  network: '网络连接失败，请检查网络后重试',
  'backend-unavailable': '云端服务暂时不可用，请稍后重试',
  unauthenticated: '登录已过期，请重新登录',
  invalid_grant: '手机号或密码不正确',
  rate_limited: '操作太频繁，请稍后再试'
};

function readable(err, fallback) {
  if (!err) return fallback;
  const kind = err.kind || err.code;
  if (kind && KIND_MSG[kind]) return KIND_MSG[kind];
  if (typeof err.message === 'string' && err.message && !/^[A-Z_]+$/.test(err.message)) return err.message;
  return fallback;
}

function dbMessage(err, fallback) {
  if (!err) return fallback;
  const code = err.code;
  if (code === '42P01') return '云端数据表还没建好，请联系应用维护者';
  if (code === '42501') return '没有权限读写这份数据，请重新登录';
  if (code === 'PGRST301' || code === 'PGRST302') return '登录已过期，请重新登录';
  if (err.message === 'Failed to fetch' || err.message === 'TypeError: Load failed') return '网络连接失败，请检查网络后重试';
  return readable(err, fallback);
}

/* ============================================================
   账号
   ============================================================ */

export async function getSession() {
  try {
    const { data, error } = await auth().getSession();
    if (error) return { ok: false, signedIn: false, error: readable(error, '读取登录状态失败') };
    return { ok: true, signedIn: !!data, session: data || null };
  } catch (e) {
    return { ok: false, signedIn: false, error: readable(e, '读取登录状态失败') };
  }
}

export async function signInWithPassword(phone, password) {
  try {
    const { data, error } = await auth().signInWithPassword({ phone, password });
    if (error) return { ok: false, error: readable(error, '登录失败，请重试') };
    return { ok: true, session: data };
  } catch (e) {
    return { ok: false, error: readable(e, '登录失败，请重试') };
  }
}

/* 发短信验证码：只在「首次激活」时用一次 */
export async function sendOtp(phone) {
  try {
    const { data, error } = await auth().sendOtp({ phone });
    if (error) return { ok: false, error: readable(error, '验证码发送失败，请稍后重试') };
    return { ok: true, verificationId: data.verificationId, isExistingUser: data.isExistingUser };
  } catch (e) {
    return { ok: false, error: readable(e, '验证码发送失败，请稍后重试') };
  }
}

/* 验码即开通：新号码用这个密码建账号，老号码直接登录（不改密码） */
export async function verifyOtp({ phone, verificationId, token, isExistingUser, password }) {
  try {
    const payload = { phone, verificationId, token, isExistingUser: !!isExistingUser };
    if (!isExistingUser && password) payload.password = password;
    const { data, error } = await auth().verifyOtp(payload);
    if (error) return { ok: false, error: readable(error, '验证码不正确或已过期') };
    return { ok: true, session: data };
  } catch (e) {
    return { ok: false, error: readable(e, '验证失败，请重试') };
  }
}

export async function changePassword(oldPassword, newPassword) {
  try {
    const { error } = await auth().resetPasswordForOld({ oldPassword, newPassword });
    if (error) return { ok: false, error: readable(error, '修改密码失败，请确认原密码是否正确') };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: readable(e, '修改密码失败，请重试') };
  }
}

export async function signOut() {
  try {
    await auth().signOut();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: readable(e, '退出登录失败') };
  }
}

/* 从 session 里取手机号，字段可能缺失，交给调用方兜底 */
export function phoneOf(session) {
  const u = (session && session.user) || {};
  return u.phone || u.phoneNumber || u.phone_number || '';
}

/* ============================================================
   数据
   ============================================================ */

/* 拉整份数据。没有行时 exists:false，由调用方决定初始化什么 */
export async function loadState() {
  try {
    const { data, error } = await db().from('app_state').select('version,doc').limit(1);
    if (error) return { ok: false, error: dbMessage(error, '读取云端数据失败') };
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { ok: true, exists: false, version: 0, doc: null };
    return { ok: true, exists: true, version: Number(row.version) || 0, doc: row.doc || null };
  } catch (e) {
    return { ok: false, error: readable(e, '读取云端数据失败') };
  }
}

/* 乐观并发：版本对不上返回 conflict，调用方重新 loadState 后提示重试 */
export async function saveState(version, doc) {
  try {
    const { data, error } = await db().rpc('save_state', { p_version: version, p_doc: doc });
    if (error) return { ok: false, error: dbMessage(error, '保存到云端失败') };
    const row = Array.isArray(data) ? data[0] : data;
    const next = row && Number(row.version);
    if (!next) return { ok: true, conflict: true };
    return { ok: true, conflict: false, version: next };
  } catch (e) {
    return { ok: false, error: readable(e, '保存到云端失败') };
  }
}

/* ============================================================
   v2 分表数据层

   物理分表（products / order_items / movements ...），
   客户端没有表的直连权限，全部走服务端 SECURITY DEFINER 函数：
   - load_app_data()      登录后整份拉取（含 meta）
   - save_table_rows()    一张表的增量落库（upsert + 按 id 删除）
   - save_meta()          tags / balances / paymentCodes 单行落库
   - claim_id_range()     原子申领一段全局唯一 id 区间（多设备不撞号）
   ============================================================ */

export async function loadAppData() {
  try {
    const { data, error } = await db().rpc('load_app_data');
    if (error) return { ok: false, error: dbMessage(error, '读取云端数据失败') };
    return { ok: true, data: data && typeof data === 'object' ? data : null };
  } catch (e) {
    return { ok: false, error: readable(e, '读取云端数据失败') };
  }
}

/* 一张表的增量落库；大表分块串行，防请求体超限。
   同一次调用里先删后插，重置/导入时 id 复用也安全。 */
const ROWS_CHUNK = 400;

export async function saveTableRows(table, upserts, deleteIds) {
  try {
    const ids = deleteIds || [];
    for (let i = 0; i < ids.length; i += ROWS_CHUNK) {
      const { error } = await db().rpc('save_table_rows', {
        p_table: table, p_upserts: null, p_delete_ids: ids.slice(i, i + ROWS_CHUNK)
      });
      if (error) return { ok: false, error: dbMessage(error, '保存到云端失败') };
    }
    const rows = upserts || [];
    for (let i = 0; i < rows.length; i += ROWS_CHUNK) {
      const { error } = await db().rpc('save_table_rows', {
        p_table: table, p_upserts: rows.slice(i, i + ROWS_CHUNK), p_delete_ids: null
      });
      if (error) return { ok: false, error: dbMessage(error, '保存到云端失败') };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: readable(e, '保存到云端失败') };
  }
}

export async function saveMetaDoc(doc) {
  try {
    const { error } = await db().rpc('save_meta', { p_doc: doc });
    if (error) return { ok: false, error: dbMessage(error, '保存到云端失败') };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: readable(e, '保存到云端失败') };
  }
}

/* 申领一段 id 区间，返回 { base }；起点 = base - count + 1。
   p_floor 是本端已用到的最大 id，服务端保证新区间从
   GREATEST(历史 base, floor) + 1 起，多设备永不撞号。 */
export async function claimIdRange(name, floor, count) {
  try {
    const { data, error } = await db().rpc('claim_id_range', { p_name: name, p_floor: floor, p_count: count });
    if (error) return { ok: false, error: dbMessage(error, '申领编号失败') };
    const row = Array.isArray(data) ? data[0] : data;
    const base = typeof row === 'object' && row !== null
      ? Number(row.base ?? row.claim_id_range)
      : Number(row);
    if (!Number.isFinite(base)) return { ok: false, error: '申领编号返回异常' };
    return { ok: true, base };
  } catch (e) {
    return { ok: false, error: readable(e, '申领编号失败') };
  }
}
