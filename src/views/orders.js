/* 订单：按日/状态/渠道/关键词翻账（服务端筛选 + 分页），点开看完整轨迹，该收的收、该冲的冲 */
import {
  store, actions, fetchOrdersPage, fetchOrderDetail, toast
} from '../data/store.js';
import {
  money, fmtDT, fmtAgo, ymd, startOfDay, addDays,
  STATUS_TXT, STATUS_TAG, CHANNEL_TXT
} from '../util/format.js';
import { UiPaySheet } from '../components/pay-sheet.js';

const RANGES = [
  { key: '7', label: '近 7 天', days: 7 },
  { key: '30', label: '近 30 天', days: 30 },
  { key: 'all', label: '全部', days: 0 }
];

export const OrdersView = {
  name: 'OrdersView',
  components: { UiPaySheet },
  data() {
    return {
      ranges: RANGES,
      filter: { range: '30', status: 'all', channel: 'all', search: '' },
      detailId: null,
      payTarget: null,
      cancelTarget: null,
      cancelReason: '',
      submitting: false,
      expandedItems: {}
    };
  },
  computed: {
    store() { return store; },
    page() { return store.ordersPage; },
    loading() { return this.page.loading; },
    /* 每行 { order, items }，服务端分页返回 */
    rowsMap() {
      const m = new Map();
      this.page.rows.forEach(r => m.set(Number(r.order.id), r));
      return m;
    },
    list() { return this.page.rows.map(r => r.order); },
    totals() {
      return {
        count: this.page.total,
        revenue: this.page.sumPaid,
        pending: this.page.pendingTotal
      };
    },
    detail() { return this.detailId ? (store.details[this.detailId] || null) : null; },
    hasFilter() {
      const f = this.filter;
      return f.status !== 'all' || f.channel !== 'all' || !!f.search.trim() || f.range !== '30';
    }
  },
  watch: {
    filter: {
      deep: true,
      handler() {
        if (this._kwTimer) clearTimeout(this._kwTimer);
        this._kwTimer = setTimeout(() => { this._kwTimer = null; this.fetch(true); }, 350);
      }
    }
  },
  mounted() {
    if (store.ui.openOrderId) {
      this.detailId = store.ui.openOrderId;
      store.ui.openOrderId = null;
      fetchOrderDetail(this.detailId);
    }
    this.fetch(true);
  },
  beforeUnmount() {
    if (this._kwTimer) clearTimeout(this._kwTimer);
  },
  methods: {
    money, fmtDT, fmtAgo,
    statusTxt(s) { return STATUS_TXT[s] || s; },
    statusTag(s) { return STATUS_TAG[s] || 'gray'; },
    channelTxt(c) { return CHANNEL_TXT[c] || '—'; },
    query() {
      const f = this.filter;
      const today = ymd(startOfDay());
      const cfg = RANGES.find(r => r.key === f.range);
      return {
        from: cfg && cfg.days ? ymd(addDays(startOfDay(), -(cfg.days - 1))) : null,
        to: cfg && cfg.days ? today : null,
        status: f.status !== 'all' ? f.status : null,
        channel: f.channel !== 'all' ? f.channel : null,
        keyword: f.search.trim() || null
      };
    },
    async fetch(reset) {
      if (!reset && !this.page.hasMore) return;
      await fetchOrdersPage(this.query(), { reset });
    },
    async loadMore() { await this.fetch(false); },
    open(o) {
      this.detailId = o.id;
      fetchOrderDetail(o.id);
    },
    close() { this.detailId = null; },
    openPay(o) { this.detailId = null; this.payTarget = o; },
    async onPaySubmit(payload) {
      this.submitting = true;
      const res = await actions.confirmOrder(this.payTarget.id, payload);
      this.submitting = false;
      if (res.ok) {
        this.payTarget = null;
        this.afterOrderChange();
      }
    },
    openCancel(o) {
      this.detailId = null;
      this.cancelTarget = o;
      this.cancelReason = '';
    },
    async doCancel() {
      const reason = this.cancelReason.trim();
      if (this.cancelTarget.status === 'paid' && !reason) return;
      this.submitting = true;
      const wasPaid = this.cancelTarget.status === 'paid';
      const res = await actions.cancelOrder(this.cancelTarget.id, reason || '取消订单');
      this.submitting = false;
      if (res.ok) {
        this.cancelTarget = null;
        toast(wasPaid ? '已冲销，库存已回补' : '订单已取消', 'ok');
        this.afterOrderChange();
      }
    },
    /* 收款 / 冲销后：刷新列表与服务端聚合，清掉详情缓存 */
    afterOrderChange() {
      this.fetch(true);
      if (this.detailId) {
        delete store.details[this.detailId];
        fetchOrderDetail(this.detailId);
      }
    },
    resetFilter() {
      this.filter = { range: '30', status: 'all', channel: 'all', search: '' };
    },
    toggleItems(id) { this.expandedItems = { ...this.expandedItems, [id]: !this.expandedItems[id] }; },
    rowOf(id) { return this.rowsMap.get(Number(id)); },
    itemsOf(id) {
      const row = this.rowOf(id);
      if (row) return row.items || [];
      return store.db.orderItems.filter(i => Number(i.order_id) === Number(id));
    },
    summaryOf(o) {
      const items = this.itemsOf(o.id);
      const s = items.slice(0, 2).map(i => i.product_name + (i.quantity > 1 ? '×' + i.quantity : '')).join('、');
      return items.length > 2 ? s + ' 等 ' + items.length + ' 项' : s;
    },
    hasGift(id) { return this.itemsOf(id).some(i => i.is_gift); },
    signedMoney(v) {
      const n = Number(v);
      return (n > 0 ? '+' : '−') + money(Math.abs(n));
    },
    movTxt(t) { return { out: '出库', reversal: '冲销回补' }[t] || t; }
  },
  template: `
<div class="v-orders">
  <div class="page-head row-between">
    <div>
      <div class="page-title">订单</div>
      <div class="page-sub">共 {{ totals.count }} 笔 · 实收 <span class="mono">{{ money(totals.revenue) }}</span></div>
    </div>
    <button class="btn btn-primary" @click="store.ui.view = 'register'">
      <ui-icon name="plus" :size="17" /> 开单
    </button>
  </div>

  <div class="card filter-card">
    <div class="card-body">
      <div class="input-search">
        <ui-icon name="search" :size="17" />
        <input class="input" v-model="filter.search" type="search" placeholder="搜订单号 / 商品 / 备注" aria-label="搜索订单">
      </div>
      <div class="chips-scroll" style="margin-top:10px">
        <button v-for="r in ranges" :key="r.key" class="chip" :class="{ 'is-on': filter.range === r.key }"
                :aria-pressed="filter.range === r.key" @click="filter.range = r.key">{{ r.label }}</button>
        <span class="chip-sep"></span>
        <button v-for="s in [{k:'all',t:'全部状态'},{k:'pending',t:'待收款'},{k:'paid',t:'已收款'},{k:'cancelled',t:'已冲销'}]"
                :key="s.k" class="chip" :class="{ 'is-on': filter.status === s.k && s.k !== 'all' }"
                :aria-pressed="filter.status === s.k" @click="filter.status = s.k">{{ s.t }}</button>
        <span class="chip-sep"></span>
        <button v-for="c in [{k:'all',t:'全部渠道'},{k:'wechat',t:'微信'},{k:'alipay',t:'支付宝'},{k:'cash',t:'现金'}]"
                :key="c.k" class="chip" :class="{ 'is-on': filter.channel === c.k && c.k !== 'all' }"
                :aria-pressed="filter.channel === c.k" @click="filter.channel = c.k">{{ c.t }}</button>
      </div>
    </div>
  </div>

  <div class="order-list" v-if="list.length">
    <button class="order-card" v-for="o in list" :key="o.id" @click="open(o)">
      <div class="oc-top">
        <span class="oc-no mono">{{ o.order_no }}</span>
        <span class="tag" :class="'tag-' + statusTag(o.status)">{{ statusTxt(o.status) }}</span>
        <span class="oc-amt mono">{{ money(o.status === 'paid' ? o.paid_amount : o.total_amount) }}</span>
      </div>
      <div class="oc-mid">
        <span class="oc-items">{{ summaryOf(o) }}</span>
        <span class="oc-gift" v-if="hasGift(o.id)"><ui-icon name="gift" :size="12" /> 含赠品</span>
      </div>
      <div class="oc-bottom">
        <span>{{ fmtDT(o.created_at) }}</span>
        <span v-if="o.channel" class="oc-channel"><i></i>{{ channelTxt(o.channel) }}</span>
        <span class="mono">{{ o.item_count }} 件</span>
        <span v-if="o.status === 'paid' && Number(o.paid_amount) !== Number(o.total_amount)" class="oc-diff">
          差 {{ signedMoney(Number(o.paid_amount) - Number(o.total_amount)) }}
        </span>
        <span class="oc-arrow"><ui-icon name="chevronRight" :size="15" /></span>
      </div>
    </button>
    <div class="center" style="padding:14px 0 20px" v-if="page.hasMore || page.loading">
      <button class="btn" :disabled="page.loading" @click="loadMore">
        {{ page.loading ? '加载中…' : '加载更多（还有 ' + (page.total - page.rows.length) + ' 笔）' }}
      </button>
    </div>
  </div>

  <div class="card" v-else>
    <div class="card-body">
      <ui-empty :icon="page.loading ? 'orders' : (hasFilter ? 'search' : 'orders')"
                :title="page.loading ? '正在查询订单…' : (hasFilter ? '这些条件下没有订单' : '还没有订单')"
                :text="page.loading ? '云端正在按条件筛选。' : (hasFilter ? '放宽时间范围，或清掉状态和渠道筛选再看看。' : '去「开单」记第一笔。')">
        <button v-if="hasFilter && !page.loading" class="btn" @click="resetFilter">清空筛选</button>
        <button v-else-if="!page.loading" class="btn btn-primary" @click="store.ui.view = 'register'">去开单</button>
      </ui-empty>
    </div>
  </div>

  <!-- 订单详情 -->
  <ui-sheet v-if="detail" :title="detail.order.order_no" @close="close">
    <div class="od-head">
      <span class="tag" :class="'tag-' + statusTag(detail.order.status)">{{ statusTxt(detail.order.status) }}</span>
      <span class="small muted">{{ fmtDT(detail.order.created_at) }}</span>
      <b class="mono od-amt">{{ money(detail.order.status === 'paid' ? detail.order.paid_amount : detail.order.total_amount) }}</b>
    </div>

    <div class="od-items">
      <div class="od-item" v-for="it in detail.items" :key="it.id">
        <div class="grow">
          <div class="od-item-name">
            {{ it.product_name }}
            <span class="tag tag-brand" v-if="it.item_type === 'combo'">套餐</span>
            <span class="tag tag-ok" v-if="it.is_gift">赠品</span>
          </div>
          <div class="od-item-sub xs muted" v-if="it.item_type === 'combo' && it.parts.length">
            含 <span v-for="(p, i) in it.parts" :key="i">{{ i ? '、' : '' }}{{ p.product ? p.product.name : '?' }}×{{ p.quantity }}</span>
          </div>
        </div>
        <span class="mono xs muted">×{{ it.quantity }}</span>
        <span class="mono od-item-amt">{{ it.is_gift ? '赠送' : money(it.line_amount) }}</span>
      </div>
    </div>

    <hr class="rule-dashed">

    <div class="od-sums">
      <div class="od-sum"><span>应收</span><b class="mono">{{ money(detail.order.total_amount) }}</b></div>
      <div class="od-sum" v-for="a in detail.adjustments" :key="a.id">
        <span>{{ a.adjust_type }}<em class="xs muted" v-if="a.reason"> · {{ a.reason }}</em></span>
        <b class="mono" :class="a.amount < 0 ? 'neg' : 'pos'">{{ (a.amount > 0 ? '+' : '') + money(a.amount) }}</b>
      </div>
      <div class="od-sum od-sum-total">
        <span>{{ detail.order.status === 'paid' ? '实收' : '待收' }}</span>
        <b class="mono">{{ money(detail.order.status === 'paid' ? detail.order.paid_amount : detail.order.total_amount) }}</b>
      </div>
    </div>

    <div class="od-block" v-if="detail.order.note">
      <div class="xs muted" style="margin-bottom:3px">备注</div>
      <div class="small">{{ detail.order.note }}</div>
    </div>

    <div class="od-block">
      <div class="xs muted" style="margin-bottom:7px">轨迹</div>
      <ol class="timeline">
        <li v-for="(ev, i) in detail.timeline" :key="i" :class="'tl-' + ev.kind">
          <span class="tl-dot"></span>
          <span class="tl-text">{{ ev.text }}</span>
          <span class="tl-time mono">{{ fmtDT(ev.at) }}</span>
        </li>
      </ol>
      <div class="xs muted" v-if="detail.order.cancel_reason" style="margin-top:6px">
        冲销原因：{{ detail.order.cancel_reason }}
      </div>
    </div>

    <div class="od-block" v-if="detail.movements.length">
      <button class="od-fold" @click="toggleItems(detail.order.id)">
        <span>库存流水 {{ detail.movements.length }} 条</span>
        <ui-icon :name="expandedItems[detail.order.id] ? 'chevronUp' : 'chevronDown'" :size="15" />
      </button>
      <div class="od-movs" v-if="expandedItems[detail.order.id]">
        <div class="od-mov" v-for="m in detail.movements" :key="m.id">
          <span class="mono" :class="m.quantity > 0 ? 'pos' : 'neg'">{{ (m.quantity > 0 ? '+' : '') + m.quantity }}</span>
          <span class="grow truncate">{{ m.product ? m.product.name : '?' }}</span>
          <span class="xs muted">{{ movTxt(m.movement_type) }}</span>
          <span class="xs muted mono">余 {{ m.balance_after }}</span>
        </div>
      </div>
    </div>

    <template #foot>
      <button v-if="detail.order.status === 'pending'" class="btn btn-primary grow" @click="openPay(detail.order)">
        <ui-icon name="wallet" :size="17" /> 收款
      </button>
      <button v-if="detail.order.status === 'pending'" class="btn btn-danger" @click="openCancel(detail.order)">取消</button>
      <button v-if="detail.order.status === 'paid'" class="btn btn-danger" @click="openCancel(detail.order)">
        <ui-icon name="refresh" :size="16" /> 冲销
      </button>
      <button class="btn" @click="close" v-if="detail.order.status === 'cancelled'">关闭</button>
    </template>
  </ui-sheet>

  <ui-pay-sheet v-if="payTarget" :total="Number(payTarget.total_amount)" :pieces="payTarget.item_count"
                :order-no="payTarget.order_no" title="补收款" :submitting="submitting"
                @close="payTarget = null" @submit="onPaySubmit" />

  <!-- 冲销 / 取消 -->
  <ui-sheet v-if="cancelTarget" :title="cancelTarget.status === 'paid' ? '冲销订单' : '取消订单'"
            :subtitle="cancelTarget.order_no" @close="cancelTarget = null">
    <div class="pill-note pill-note-danger" v-if="cancelTarget.status === 'paid'">
      <ui-icon name="alert" :size="16" />
      <div>
        已收 {{ money(cancelTarget.paid_amount) }} 会作废，出库的 {{ cancelTarget.item_count }} 件商品自动回补库存。
        原单不删除，留痕可查。
      </div>
    </div>
    <div class="pill-note" v-else>
      <ui-icon name="info" :size="16" />
      <div>订单还没收款，取消不涉及库存。</div>
    </div>
    <div class="field" style="margin-top:12px">
      <span class="field-label">{{ cancelTarget.status === 'paid' ? '冲销原因（必填）' : '原因（选填）' }}</span>
      <input class="input" v-model="cancelReason" placeholder="例如：客人退货 / 录错了"
             :aria-required="cancelTarget.status === 'paid'">
    </div>
    <template #foot>
      <button class="btn" @click="cancelTarget = null" :disabled="submitting">再想想</button>
      <button class="btn btn-danger grow" @click="doCancel" :disabled="submitting || (cancelTarget.status === 'paid' && !cancelReason.trim())">
        确认{{ cancelTarget.status === 'paid' ? '冲销' : '取消' }}
      </button>
    </template>
  </ui-sheet>
</div>`
};
