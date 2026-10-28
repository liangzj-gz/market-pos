/* ============================================================
   v3 服务端接口封装

   v3 起数据按 20 张字段化表存储，业务表对客户端零授权，
   读写全部经服务端 SECURITY DEFINER 函数（26 个 RPC）。
   这里只做四件事：
   1. rpc(name, params) 统一调云端函数并转换错误文案
   2. newRequestId() 生成幂等键（防重复提交，服务端 client_requests 去重）
   3. 收款码图片的 Storage 上传 / 签名 URL / 删除
   4. 自托管模式（window.__SELF_HOST__）：同签名的 rpc/上传走
      自建 API（/api/rpc/:fn + /api/files），登录走手机号+密码

   业务规则一律在服务端执行；前端只负责把返回结果装配进缓存。
   ============================================================ */

import { getClient, readable, dbMessage } from './cloud.js';

/* ---------- 自托管模式检测 ---------- */

export const SELF_HOSTED = typeof window !== 'undefined' && window.__SELF_HOST__ === true;

const TOKEN_KEY = 'mp_token';

export function selfHostToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}
export function setSelfHostToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (e) { /* 隐私模式忽略 */ }
}

async function selfHostFetch(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(selfHostToken() ? { Authorization: 'Bearer ' + selfHostToken() } : {})
    },
    body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body || {})
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (json && json.error) || `请求失败（${res.status}）`;
    const err = new Error(msg);
    err.status = res.status;
    return { ok: false, error: msg, status: res.status, data: json };
  }
  return { ok: true, data: json };
}

export async function selfHostLogin(phone, password) {
  return selfHostFetch('/api/login', { phone, password });
}

export async function selfHostSetup(phone, password, name, setupKey) {
  return selfHostFetch('/api/setup', { phone, password, name, setupKey });
}

/* ---------- RPC ---------- */

export async function rpc(name, params) {
  if (SELF_HOSTED) {
    try {
      /* 参数名转 body：p_xxx → xxx（与自建 API 的映射约定一致） */
      const body = {};
      for (const [k, v] of Object.entries(params || {})) {
        if (k === 'p_payload') body.payload = v;
        else if (k === 'p_rows') body.rows = v;
        else body[k.replace(/^p_/, '')] = v;
      }
      const r = await selfHostFetch(`/api/rpc/${name}`, body);
      if (r.status === 401) {
        setSelfHostToken('');
        return { ok: false, error: '登录已过期，请重新登录' };
      }
      return r.ok ? { ok: true, data: r.data } : r;
    } catch (e) {
      return { ok: false, error: '网络连接失败，请检查网络后重试' };
    }
  }
  try {
    const { data, error } = await getClient().database.rpc(name, params || {});
    if (error) return { ok: false, error: dbMessage(error, '云端操作失败，请重试') };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: readable(e, '网络连接失败，请检查网络后重试') };
  }
}

/* 幂等键：同一次操作重试时服务端只执行一次 */
export function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* ---------- Storage（收款码等用户文件） ---------- */

function storageApi() {
  const c = getClient();
  if (!c.storage || typeof c.storage.from !== 'function') {
    throw new Error('云端文件服务没有加载成功，请刷新页面重试');
  }
  return c.storage;
}

/* 上传一张收款码，返回 storage 路径（存 payment_codes.storage_path）。
   uid 由调用方传入（登录后从 session.user.id 拿到）。 */
export async function uploadPaymentCodeImage(uid, channel, file) {
  if (SELF_HOSTED) {
    try {
      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
      const path = `users/${uid}/payment-codes/${channel}-${Date.now()}.${ext}`;
      const base64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      const r = await selfHostFetch('/api/files', { path, base64, contentType: file.type });
      return r.ok ? { ok: true, path } : { ok: false, error: r.error || '收款码上传失败' };
    } catch (e) {
      return { ok: false, error: '收款码上传失败，请重试' };
    }
  }
  const st = storageApi();
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = st.userPath(uid, 'payment-codes/' + channel + '-' + Date.now() + '.' + ext);
  const { error } = await st.from().upload(path, file, { contentType: file.type, upsert: false });
  if (error) return { ok: false, error: readable(error, '收款码上传失败，请重试') };
  return { ok: true, path };
}

/* 路径 → 可展示的签名 URL（有效期 1 年，加载时会续签）
   自托管：文件接口要求本人 token；<img> 标签无法带 header，
   把 token 放 query（仅限收款码这类低敏感图片，路径不可猜测） */
export async function signPaymentCodePath(path) {
  if (!path) return '';
  /* 兼容历史遗留的 dataURL：直接可用 */
  if (/^data:image\//.test(path)) return path;
  if (SELF_HOSTED) return `/api/files/${path}?t=${encodeURIComponent(selfHostToken())}`;
  try {
    const { data, error } = await storageApi().from().createSignedUrl(path, 60 * 60 * 24 * 365);
    if (error || !data || !data.signedUrl) return '';
    return data.signedUrl;
  } catch (e) {
    return '';
  }
}

/* 删除一个 storage 对象（失败不阻塞业务，文件多了顶多占点空间） */
export async function removeStorageObject(path) {
  if (!path || /^data:image\//.test(path)) return;
  if (SELF_HOSTED) {
    try { await selfHostFetch(`/api/files/${path}`, undefined, 'DELETE'); } catch (e) { /* 忽略 */ }
    return;
  }
  try { await storageApi().from().remove([path]); } catch (e) { /* 忽略 */ }
}
