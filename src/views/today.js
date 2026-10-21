/* 今日看板：一屏看清今天收了多少、还差什么、该补什么货 */
import {
  store, todaySummary, yesterdaySummary, lastDaySummary, pendingOrders,
  openAlerts, recentOrders, recentDays, stockState, actions
} from '../data/store.js';
import { money, moneyNum, fmtD, fmtDT, fmtAgo, ymd, startOfDay, weekdayCN, CHANNEL_TXT, CHANNEL_COLOR } from '../util/format.js';
import { orderDetail } from '../data/store.js';
import { UiPaySheet } from '../components/pay-sheet.js';

export const TodayView = {
  name: 'TodayView',
  components: { UiPaySheet },
  data() {
    return { payTarget: null, submitting: false };
  },
  computed: {
    store() { return store; },
    today() { return todaySummary.value; },
    yesterday() { return yesterdaySummary.value; },
    lastDay() { return lastDaySummary.value; },
    hasToday() { return this.today.count > 0 || this.today.cancelled > 0; },
    pending() { return pendingOrders.value; },
    alerts() { return openAlerts.value.slice(0, 5); },
    alertTotal() { return openAlerts.value.length; },
    recent() { return recentOrders(6); },
    /* 今天没出摊时，图表回落到最近营业的 7 天，别让整块变成一格不动的 0 */
    weekAnchor() {
      const last7 = recentDays(7);
      const empty = last7.every(d => d.revenue === 0);
      return empty && this.lastDay ? this.lastDay.date : null;
    },
    week() {
      const days = this.weekAnchor ? recentDays(7, this.weekAnchor) : recentDays(7);
      const max = Math.max(1, ...days.map(d => d.revenue));
      const todayKey = ymd(startOfDay());
      return days.map(d => ({
        ...d,
        label: weekdayCN(d.date),
        dayNum: Number(d.date.slice(8, 10)),
        h: Math.max(d.revenue > 0 ? 6 : 2, Math.round(d.revenue / max * 100)),
        isToday: d.date === todayKey
      }));
    },
    weekTotal() { return this.week.reduce((t, d) => t + d.revenue, 0); },
    weekLabel() { return this.weekAnchor ? '最近营业的 7 天' : '近 7 日营收'; },
    delta() {
      const base = this.yesterday.revenue;
      if (!base) return null;
      const d = this.today.revenue - base;
      return { value: d, pct: Math.round(d / base * 100), up: d >= 0 };
    },
    todayLabel() {
      const d = startOfDay();
      return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${weekdayCN(d)}`;
    }
  },
  methods: {
    money, moneyNum, fmtD, fmtDT, fmtAgo,
    channelLabel(k) { return CHANNEL_TXT[k] || '其他'; },
    channelColor(k) { return CHANNEL_COLOR[k] || '#8C857B'; },
    go(v) { store.ui.view = v; },
    stockOf(id) { return stockState(id); },
    openPay(o) { this.payTarget = o; },
    detail(o) {
      store.ui.openOrderId = o.id;
      store.ui.view = 'orders';
    },
    onPaySubmit(payload) {
      this.submitting = true;
      const res = actions.confirmOrder(this.payTarget.id, payload);
      this.submitting = false;
      if (res.ok) this.payTarget = null;
    }
  },
  template: `
<div class="v-today">
  <div class="page-head row-between">
    <div>
      <div class="page-title">今日</div>
      <div class="page-sub">{{ todayLabel }}</div>
    </div>
    <button class="btn btn-primary btn-lg" @click="go('register')">
      <ui-icon name="plus" :size="18" /> 开单
    </button>
  </div>

  <!-- 今日战报 -->
  <div class="card hero-card" :class="{ 'is-quiet': !hasToday }">
    <div class="hero-top">
      <span class="hero-label">{{ hasToday ? '今日收款' : '今天还没开单' }}</span>
    </div>
    <div class="hero-amount" v-if="hasToday"><span class="cur">¥</span>{{ moneyNum(today.revenue) }}</div>

    <div class="hero-meta" v-if="hasToday">
      <div class="hero-meta-item">
        <b class="mono">{{ today.count }}</b><span>笔订单</span>
      </div>
      <div class="hero-meta-item">
        <b class="mono">{{ today.pieces }}</b><span>件商品</span>
      </div>
      <div class="hero-meta-item">
        <b class="mono">{{ money(today.avg) }}</b><span>客单价</span>
      </div>
      <div class="hero-meta-item" v-if="delta">
        <b class="mono" :class="delta.up ? 'up' : 'down'">
          <ui-icon :name="delta.up ? 'trendUp' : 'trendDown'" :size="13" />{{ delta.up ? '+' : '' }}{{ delta.pct }}%
        </b>
        <span>较昨日</span>
      </div>
    </div>

    <div class="hero-quiet" v-else>
      <div class="hero-quiet-main">
        <div class="hero-amount hero-amount-zero"><span class="cur">¥</span>0</div>
        <p class="hero-quiet-text">开张第一笔记上来，库存和统计会自动跟着走。</p>
      </div>
      <div class="hero-quiet-recap" v-if="lastDay">
        <div class="recap-label">上次营业 · {{ fmtD(lastDay.date) }}</div>
        <div class="recap-line">
          <b class="mono">{{ money(lastDay.revenue) }}</b>
          <span>{{ lastDay.count }} 单 · {{ lastDay.pieces }} 件</span>
        </div>
      </div>
    </div>

    <div class="hero-channels" v-if="hasToday">
      <span v-for="(v, k) in today.channels" :key="k" class="hero-ch">
        <i :style="{ background: channelColor(k) }"></i>
        {{ channelLabel(k) }} <b class="mono">{{ money(v) }}</b>
      </span>
    </div>
  </div>

  <!-- 待收款 -->
  <div class="card" v-if="pending.length">
    <div class="card-head">
      <h3><ui-icon name="clock" :size="16" /> 待收款 <span class="count-badge">{{ pending.length }}</span></h3>
      <button class="btn btn-link btn-sm" @click="go('orders')">全部订单</button>
    </div>
    <div class="card-body">
      <div class="lrow" v-for="o in pending" :key="o.id">
        <div class="lrow-main">
          <div class="lrow-title mono">{{ o.order_no }}</div>
          <div class="lrow-sub">{{ o.item_count }} 件 · {{ fmtAgo(o.created_at) }}</div>
        </div>
        <b class="mono" style="font-size:17px">{{ money(o.total_amount) }}</b>
        <button class="btn btn-primary btn-sm" @click="openPay(o)">收款</button>
      </div>
    </div>
  </div>

  <!-- 库存预警 -->
  <div class="card" v-if="alerts.length">
    <div class="card-head">
      <h3><ui-icon name="alert" :size="16" style="color:var(--amber)" /> 库存预警 <span class="count-badge">{{ alertTotal }}</span></h3>
      <button class="btn btn-link btn-sm" @click="go('alerts')">去处理</button>
    </div>
    <div class="card-body">
      <div class="alert-line" v-for="a in alerts" :key="a.id">
        <span class="alert-dot" :class="a.quantity < 0 ? 'is-neg' : 'is-low'"></span>
        <span class="grow truncate">
          {{ a.product ? a.product.name : '商品' }}
        </span>
        <span class="tag" :class="a.quantity < 0 ? 'tag-danger' : 'tag-warn'">
          余 <b class="mono">{{ stockOf(a.product_id).known ? stockOf(a.product_id).qty : a.quantity }}</b><template v-if="a.threshold"> / 阈 {{ a.threshold }}</template>
        </span>
        <button class="btn btn-sm" @click="store.ui.sheet = { type: 'stockin', productId: a.product_id }">补货</button>
      </div>
    </div>
  </div>

  <!-- 近 7 日 -->
  <div class="card">
    <div class="card-head">
      <h3><ui-icon name="stats" :size="16" /> {{ weekLabel }}</h3>
      <span class="hint mono">{{ money(weekTotal) }}</span>
    </div>
    <div class="card-body">
      <div class="bars">
        <div class="bar-col" v-for="d in week" :key="d.date">
          <span class="bar-val" v-if="d.revenue > 0">{{ d.revenue >= 1000 ? Math.round(d.revenue / 100) / 10 + 'k' : d.revenue }}</span>
          <div class="bar" :class="{ 'is-zero': d.revenue === 0, 'is-today': d.isToday }" :style="{ height: d.h + '%' }"></div>
          <span class="bar-lbl" :class="{ 'is-today': d.isToday }">{{ d.label }}</span>
        </div>
      </div>
      <div class="row-between" style="margin-top:12px">
        <span class="xs muted">柱子为空＝那天没出摊或没开单</span>
        <button class="btn btn-link btn-sm" @click="go('stats')">看统计 <ui-icon name="chevronRight" :size="14" /></button>
      </div>
    </div>
  </div>

  <!-- 最近订单 -->
  <div class="card">
    <div class="card-head">
      <h3><ui-icon name="orders" :size="16" /> 最近订单</h3>
      <button class="btn btn-link btn-sm" @click="go('orders')">全部</button>
    </div>
    <div class="card-body" v-if="!recent.length">
      <ui-empty icon="orders" title="还没有订单" text="点右上角「开单」记第一笔，或到「设置」里恢复初始历史数据看看效果。" />
    </div>
    <div class="card-body" v-else>
      <button class="lrow lrow-btn" v-for="r in recent" :key="r.order.id" @click="detail(r.order)">
        <div class="lrow-main">
          <div class="lrow-title mono">{{ r.order.order_no }}</div>
          <div class="lrow-sub truncate">
            <span v-for="(it, i) in r.items.slice(0, 3)" :key="i">{{ i ? '、' : '' }}{{ it.product_name }}<em v-if="it.quantity > 1">×{{ it.quantity }}</em></span>
            <span v-if="r.items.length > 3"> 等 {{ r.items.length }} 项</span>
          </div>
        </div>
        <span class="tag" :class="r.order.status === 'paid' ? 'tag-ok' : r.order.status === 'pending' ? 'tag-warn' : 'tag-gray'">
          {{ r.order.status === 'paid' ? '已收款' : r.order.status === 'pending' ? '待收款' : '已冲销' }}
        </span>
        <b class="mono" style="min-width:56px;text-align:right">{{ money(r.order.status === 'paid' ? r.order.paid_amount : r.order.total_amount) }}</b>
      </button>
    </div>
  </div>

  <!-- 快捷入口 -->
  <div class="quick-grid">
    <button class="quick" @click="store.ui.sheet = { type: 'stockin' }">
      <ui-icon name="boxIn" :size="20" /><span>入库</span>
    </button>
    <button class="quick" @click="go('inventory')">
      <ui-icon name="count" :size="20" /><span>盘点</span>
    </button>
    <button class="quick" @click="go('catalog')">
      <ui-icon name="tag" :size="20" /><span>商品</span>
    </button>
    <button class="quick" @click="go('stats')">
      <ui-icon name="percent" :size="20" /><span>统计</span>
    </button>
  </div>

  <ui-pay-sheet v-if="payTarget" :total="Number(payTarget.total_amount)" :pieces="payTarget.item_count"
                :order-no="payTarget.order_no" title="补收款" :submitting="submitting"
                @close="payTarget = null" @submit="onPaySubmit" />
</div>`
};
