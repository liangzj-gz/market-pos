/* 格式化与计算工具 */

export const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
export const r2  = v => Math.round((num(v) + Number.EPSILON) * 100) / 100;
export const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

/* 金额：整数不带小数，否则保留两位并去掉末尾 0 */
export function money(v) {
  const n = num(v);
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/(\.\d)0$/, '$1');
  return '¥' + s;
}
/* 只返回数字部分，配合模板里的 ¥ 前缀做排版 */
export function moneyNum(v) {
  const n = num(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/(\.\d)0$/, '$1');
}
/* 千分位整数 */
export function group(n) {
  return String(int(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function startOfDay(d = new Date()) {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
}
export function addDays(d, n) {
  const x = new Date(d); x.setDate(x.getDate() + n); return x;
}
export function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}

/* 10/3 15:12 */
export function fmtDT(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/* 2026/10/3 */
export function fmtD(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
/* 只取时分 */
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/* 相对时间：刚刚 / 12 分钟前 / 昨天 15:12 / 10/3 */
export function fmtAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso), now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (daysBetween(d, now) === 0) return `今天 ${fmtTime(iso)}`;
  if (daysBetween(d, now) === 1) return `昨天 ${fmtTime(iso)}`;
  if (daysBetween(d, now) < 7) return `${daysBetween(d, now)} 天前`;
  return fmtD(iso);
}
/* 星期几，用于图表横轴 */
export function weekdayCN(d) {
  return ['日', '一', '二', '三', '四', '五', '六'][new Date(d).getDay()];
}

/* ---------- 业务枚举文案 ---------- */
export const STATUS_TXT = { pending: '待收款', paid: '已收款', cancelled: '已冲销' };
export const STATUS_TAG = { pending: 'warn', paid: 'ok', cancelled: 'gray' };
export const CHANNEL_TXT = { wechat: '微信', alipay: '支付宝', cash: '现金' };
export const CHANNEL_COLOR = { wechat: '#2F7A4F', alipay: '#1F6AA5', cash: '#96690A' };
export const ADJUST_TYPES = ['抹零让利', '满赠赠送', '临时改价', '多收待退', '少收挂账', '录入更正'];
export const MOV_TXT = { in: '入库', out: '出库', adjust: '盘点调整', reversal: '冲销回补' };
export const MOV_TAG = { in: 'ok', out: 'gray', adjust: 'info', reversal: 'warn' };

/* 差额原因的解释文案，帮摊主选对 */
export const ADJUST_HINT = {
  '抹零让利': '实收比应收少，零头抹掉不收',
  '满赠赠送': '买赠活动送的，不算钱',
  '临时改价': '现场临时给的价格',
  '多收待退': '收多了，之后要退给客人',
  '少收挂账': '收少了，先记着',
  '录入更正': '录入有误，以实收为准'
};
