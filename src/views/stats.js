/* 统计：营收趋势、渠道、TOP 商品、差额损益——服务端聚合，月底对账就靠这页 */
import { store, fetchStats } from '../data/store.js';
import {
  money, ymd, startOfDay, addDays, weekdayCN, fmtD,
  CHANNEL_TXT, CHANNEL_COLOR
} from '../util/format.js';

const PRESETS = [
  { key: '7', label: '近 7 天' },
  { key: '30', label: '近 30 天' },
  { key: 'all', label: '全部' },
  { key: 'custom', label: '自定义' }
];

export const StatsView = {
  name: 'StatsView',
  data() {
    const today = ymd(startOfDay());
    const first = (store.counts && store.counts.firstDate) || today;
    return {
      presets: PRESETS,
      preset: 'all',
      from: first,
      to: today,
      firstDate: first
    };
  },
  computed: {
    store() { return store; },
    loading() { return store.statsLoading; },
    range() {
      const today = ymd(startOfDay());
      const p = this.preset;
      if (p === '7') return { from: ymd(addDays(startOfDay(), -6)), to: today };
      if (p === '30') return { from: ymd(addDays(startOfDay(), -29)), to: today };
      if (p === 'all') return { from: this.firstDate, to: today };
      return { from: this.from || this.firstDate, to: this.to || today };
    },
    stats() { return store.stats; },
    s() { return (this.stats && this.stats.summary) || { revenue: 0, receivable: 0, count: 0, avg: 0, pieces: 0, gifts: 0, giftRate: 0, diff: 0, diffCount: 0, diffRate: 0 }; },
    dailyMax() { return Math.max(1, ...this.stats.daily.map(d => Number(d.revenue))); },
    bars() {
      return this.stats.daily.map(d => ({
        ...d,
        revenue: Number(d.revenue),
        label: d.date.slice(8, 10),
        wk: weekdayCN(d.date),
        h: Number(d.revenue) > 0 ? Math.max(7, Math.round(Number(d.revenue) / this.dailyMax * 100)) : 2
      }));
    },
    wideChart() { return this.bars.length > 16; },
    channels() {
      const total = this.stats.channels.reduce((t, c) => t + Number(c.amount), 0) || 1;
      return this.stats.channels.map(c => ({
        ...c,
        amount: Number(c.amount),
        label: CHANNEL_TXT[c.key] || '其他',
        color: CHANNEL_COLOR[c.key] || '#8C857B',
        pct: Math.round(Number(c.amount) / total * 100)
      }));
    },
    topMax() { return Math.max(1, ...this.stats.top.map(t => Number(t.qty))); },
    topRows() {
      return this.stats.top.map(t => ({ ...t, qty: Number(t.qty), amount: Number(t.amount || 0), w: Math.round(Number(t.qty) / this.topMax * 100) }));
    },
    seriesMax() { return Math.max(1, ...this.stats.series.map(t => Number(t.qty))); },
    seriesRows() {
      return this.stats.series.slice(0, 8).map(t => ({ ...t, qty: Number(t.qty), w: Math.round(Number(t.qty) / this.seriesMax * 100) }));
    },
    hasData() { return !!this.stats && this.s.count > 0; },
    rangeLabel() {
      return fmtD(this.range.from) + ' — ' + fmtD(this.range.to);
    }
  },
  watch: {
    range: {
      immediate: true,
      handler(r) { this.load(r); }
    }
  },
  methods: {
    money,
    async load(r) {
      await fetchStats(r.from, r.to);
    },
    setPreset(k) {
      this.preset = k;
      if (k === 'custom') {
        this.from = this.range.from;
        this.to = this.range.to;
      }
    }
  },
  template: `
<div class="v-stats">
  <div class="page-head">
    <div class="page-title">统计</div>
    <div class="page-sub">{{ rangeLabel }}<template v-if="s.count"> · {{ s.count }} 笔已收款订单</template></div>
  </div>

  <div class="card filter-card">
    <div class="card-body">
      <div class="chips-scroll">
        <button v-for="p in presets" :key="p.key" class="chip" :class="{ 'chip-brand': preset === p.key }"
                :aria-pressed="preset === p.key" @click="setPreset(p.key)">{{ p.label }}</button>
      </div>
      <div class="date-row" v-if="preset === 'custom'">
        <input class="input input-mono" type="date" v-model="from" aria-label="开始日期">
        <span class="muted">—</span>
        <input class="input input-mono" type="date" v-model="to" aria-label="结束日期">
      </div>
    </div>
  </div>

  <div class="card" v-if="loading && !stats">
    <div class="card-body">
      <ui-empty icon="stats" title="正在统计…" text="云端正在按区间汇总订单。" />
    </div>
  </div>

  <template v-else-if="hasData">
    <div class="stat-grid" style="margin-bottom:14px">
      <div class="stat stat-accent">
        <div class="stat-label">实收</div>
        <div class="stat-value">{{ money(s.revenue) }}</div>
        <div class="stat-foot">应收 {{ money(s.receivable) }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">订单数</div>
        <div class="stat-value">{{ s.count }}</div>
        <div class="stat-foot">客单价 {{ money(s.avg) }}</div>
      </div>
      <div class="stat">
        <div class="stat-label">卖出件数</div>
        <div class="stat-value">{{ s.pieces }}</div>
        <div class="stat-foot">其中赠品 {{ s.gifts }} 件（{{ s.giftRate }}%）</div>
      </div>
      <div class="stat" :class="Number(s.diffCount) ? 'stat-warn' : 'stat-ok'">
        <div class="stat-label">差额损益</div>
        <div class="stat-value">{{ (Number(s.diff) > 0 ? '+' : '') + money(s.diff) }}</div>
        <div class="stat-foot">{{ s.diffCount }} 笔有差额 · 占 {{ s.diffRate }}%</div>
      </div>
    </div>

    <!-- 营收趋势 -->
    <div class="card">
      <div class="card-head">
        <h3><ui-icon name="stats" :size="16" /> 每日营收</h3>
        <span class="hint">最高 <b class="mono">{{ money(dailyMax) }}</b></span>
      </div>
      <div class="card-body">
        <div class="chart-scroll" :class="{ 'is-wide': wideChart }">
          <div class="bars bars-tall">
            <div class="bar-col" v-for="d in bars" :key="d.date">
              <span class="bar-val" v-if="d.revenue > 0">{{ d.revenue >= 1000 ? Math.round(d.revenue / 100) / 10 + 'k' : d.revenue }}</span>
              <div class="bar" :class="{ 'is-zero': d.revenue === 0 }" :style="{ height: d.h + '%' }"></div>
              <span class="bar-lbl">{{ d.label }}</span>
              <span class="bar-wk">{{ d.wk }}</span>
            </div>
          </div>
        </div>
        <p class="xs muted" style="margin-top:8px" v-if="wideChart">区间较长，左右滑动可看完整走势</p>
      </div>
    </div>

    <div class="two-col">
      <!-- 渠道 -->
      <div class="card">
        <div class="card-head"><h3><ui-icon name="wallet" :size="16" /> 收款渠道</h3></div>
        <div class="card-body">
          <div class="split-bar">
            <div class="split-seg" v-for="c in channels" :key="c.key"
                 :style="{ width: Math.max(c.pct, 2) + '%', background: c.color }" :title="c.label"></div>
          </div>
          <div class="legend">
            <div class="legend-row" v-for="c in channels" :key="c.key">
              <span class="legend-dot" :style="{ background: c.color }"></span>
              <span class="grow">{{ c.label }}</span>
              <span class="xs muted">{{ c.count }} 笔</span>
              <b class="mono">{{ money(c.amount) }}</b>
              <span class="xs muted" style="width:34px;text-align:right">{{ c.pct }}%</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 差额损益 -->
      <div class="card">
        <div class="card-head"><h3><ui-icon name="percent" :size="16" /> 差额损益</h3></div>
        <div class="card-body">
          <div v-if="!stats.adjustments.length">
            <ui-empty icon="check" title="这段时间账很干净" text="所有订单实收都等于应收，没有差额。" />
          </div>
          <div v-else class="adj-list">
            <div class="adj-row" v-for="a in stats.adjustments" :key="a.type">
              <span class="tag" :class="Number(a.amount) < 0 ? 'tag-warn' : 'tag-info'">{{ a.type }}</span>
              <span class="grow"></span>
              <span class="xs muted">{{ a.count }} 笔</span>
              <b class="mono" :class="Number(a.amount) < 0 ? 'neg' : 'pos'">{{ (Number(a.amount) > 0 ? '+' : '') + money(a.amount) }}</b>
            </div>
            <div class="adj-note xs muted">
              负数＝让价少收，正数＝多收待退或录入更正。对账时按原因逐项核对。
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TOP 商品 -->
    <div class="card">
      <div class="card-head">
        <h3><ui-icon name="spark" :size="16" /> 销量 TOP 10</h3>
        <span class="hint">套餐已按明细拆到单品</span>
      </div>
      <div class="card-body">
        <div class="rank-row" v-for="(t, i) in topRows" :key="t.name">
          <span class="rank-no">{{ i + 1 }}</span>
          <div class="grow" style="min-width:0">
            <div class="row-between" style="gap:8px">
              <span class="rank-name truncate">{{ t.name }}</span>
              <span class="rank-val mono">{{ t.qty }} 件<template v-if="t.amount"> · {{ money(t.amount) }}</template></span>
            </div>
            <div class="rank-track"><div class="rank-fill" :style="{ width: t.w + '%' }"></div></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 系列分布 -->
    <div class="card" v-if="seriesRows.length">
      <div class="card-head"><h3><ui-icon name="layers" :size="16" /> 系列分布</h3></div>
      <div class="card-body">
        <div class="rank-row" v-for="t in seriesRows" :key="t.name">
          <span class="rank-name" style="flex:0 0 92px">{{ t.name }}</span>
          <div class="grow">
            <div class="rank-track"><div class="rank-fill" :style="{ width: t.w + '%' }"></div></div>
          </div>
          <span class="rank-val mono">{{ t.qty }} 件</span>
        </div>
      </div>
    </div>
  </template>

  <div class="card" v-else>
    <div class="card-body">
      <ui-empty icon="stats" title="这段时间没有已收款订单" text="换个时间范围，或去开一单。" />
    </div>
  </div>
</div>`
};
