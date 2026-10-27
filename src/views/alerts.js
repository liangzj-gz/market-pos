/* 预警中心：出库触发的低库存/负库存记录，补完货再来关掉 */
import { store, openAlerts, actions, productById, stockState } from '../data/store.js';
import { money, fmtDT, fmtAgo } from '../util/format.js';

export const AlertsView = {
  name: 'AlertsView',
  data() { return { tab: 'open' }; },
  computed: {
    store() { return store; },
    open() { return openAlerts.value; },
    resolved() {
      return store.db.alerts
        .filter(a => a.status === 'resolved')
        .sort((x, y) => (x.resolved_at < y.resolved_at ? 1 : -1))
        .map(a => ({ ...a, product: productById(store.db, a.product_id) }));
    },
    list() { return this.tab === 'open' ? this.open : this.resolved; },
    todayCount() {
      const today = new Date().toISOString().slice(0, 10);
      return store.db.alerts.filter(a => (a.created_at || '').slice(0, 10) === today).length;
    },
    negCount() {
      /* 按当前余额算，和库存页口径一致；预警里记的是触发时的快照 */
      return this.open.filter(a => {
        const s = stockState(a.product_id);
        return s.known && s.qty < 0;
      }).length;
    },
    resolvedThisWeek() {
      const cut = Date.now() - 7 * 86400000;
      return store.db.alerts.filter(a => a.status === 'resolved' && new Date(a.resolved_at).getTime() >= cut).length;
    }
  },
  methods: {
    money, fmtDT, fmtAgo,
    stateOf(id) { return stockState(id); },
    restock(a) { store.ui.sheet = { type: 'stockin', productId: a.product_id }; },
    take(a) { store.ui.sheet = { type: 'stocktake', productId: a.product_id }; },
    async resolve(a) { await actions.resolveAlert(a.id, '已补货'); },
    kindTxt(a) { return a.kind === 'negative' || a.quantity < 0 ? '负库存' : '低于安全库存'; }
  },
  template: `
<div class="v-alerts">
  <div class="page-head">
    <div class="page-title">预警</div>
    <div class="page-sub">出库后余额低于阈值的商品会出现在这里</div>
  </div>

  <div class="stat-grid" style="margin-bottom:14px">
    <div class="stat stat-warn">
      <div class="stat-label">待处理</div>
      <div class="stat-value">{{ open.length }}</div>
      <div class="stat-foot">其中负库存 {{ negCount }}</div>
    </div>
    <div class="stat stat-warn">
      <div class="stat-label">今日新增</div>
      <div class="stat-value">{{ todayCount }}</div>
      <div class="stat-foot">由出库自动触发</div>
    </div>
    <div class="stat stat-ok">
      <div class="stat-label">近 7 天已处理</div>
      <div class="stat-value">{{ resolvedThisWeek }}</div>
      <div class="stat-foot">补货后手动关闭</div>
    </div>
  </div>

  <div class="seg" role="tablist">
    <button class="seg-btn" :class="{ 'is-on': tab === 'open' }" role="tab" :aria-selected="tab === 'open'"
            @click="tab = 'open'">待处理 <span class="mono">{{ open.length }}</span></button>
    <button class="seg-btn" :class="{ 'is-on': tab === 'resolved' }" role="tab" :aria-selected="tab === 'resolved'"
            @click="tab = 'resolved'">已处理 <span class="mono">{{ resolved.length }}</span></button>
  </div>

  <div class="alert-list" v-if="list.length">
    <div class="alert-card" v-for="a in list" :key="a.id" :class="{ 'is-resolved': a.status === 'resolved' }">
      <div class="ac-head">
        <span class="ac-icon" :class="a.quantity < 0 ? 'is-neg' : 'is-low'">
          <ui-icon name="alert" :size="16" />
        </span>
        <div class="grow" style="min-width:0">
          <div class="ac-name">
            {{ a.product ? a.product.name : '商品 #' + a.product_id }}
            <span class="tag" :class="a.quantity < 0 ? 'tag-danger' : 'tag-warn'">{{ kindTxt(a) }}</span>
          </div>
          <div class="xs muted">
            {{ a.product ? a.product.series : '' }} · {{ fmtAgo(a.created_at) }}
          </div>
        </div>
        <div class="ac-qty">
          <span class="xs muted">余</span>
          <b class="mono" :class="a.quantity < 0 ? 'neg' : 'low'">{{ a.quantity }}</b>
        </div>
      </div>

      <div class="ac-meta">
        <span>触发时余额 <b class="mono">{{ a.quantity }}</b></span>
        <span v-if="a.threshold">阈值 <b class="mono">{{ a.threshold }}</b></span>
        <span v-if="a.ref_no" class="mono">{{ a.ref_no }}</span>
      </div>

      <div class="ac-actions" v-if="a.status === 'open'">
        <span class="ac-now xs muted">当前余 <b class="mono">{{ stateOf(a.product_id).known ? stateOf(a.product_id).qty : '—' }}</b></span>
        <button class="btn btn-sm" @click="take(a)">盘点</button>
        <button class="btn btn-sm" @click="restock(a)">补货</button>
        <button class="btn btn-sm btn-ok" @click="resolve(a)"><ui-icon name="check" :size="14" /> 已处理</button>
      </div>
      <div class="ac-actions" v-else>
        <span class="xs muted"><ui-icon name="check" :size="13" style="display:inline;vertical-align:-2px" /> {{ a.resolve_note || '已处理' }} · {{ fmtDT(a.resolved_at) }}</span>
      </div>
    </div>
  </div>

  <div class="card" v-else>
    <div class="card-body">
      <ui-empty v-if="tab === 'open'" icon="check" title="库存都在安全线上" text="出库后余额掉到阈值以下时，这里会自动冒出来一条。" />
      <ui-empty v-else icon="history" title="还没有处理记录" text="补完货点「已处理」，记录会留在这里。" />
    </div>
  </div>
</div>`
};
