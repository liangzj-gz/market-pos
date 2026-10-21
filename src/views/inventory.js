/* 库存：余额一眼扫完，低库存排最前；每一笔变动都能翻到源头 */
import {
  store, inventoryRows, actions, movementsOf, productById
} from '../data/store.js';
import { money, fmtDT, MOV_TXT, MOV_TAG, group } from '../util/format.js';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'neg', label: '负库存' },
  { key: 'low', label: '偏低' },
  { key: 'ok', label: '正常' },
  { key: 'none', label: '未盘点' }
];

export const InventoryView = {
  name: 'InventoryView',
  data() { return { filter: 'all', search: '', expanded: {} }; },
  computed: {
    store() { return store; },
    filters() { return FILTERS; },
    rowsAll() { return inventoryRows.value; },
    summary() {
      const rows = this.rowsAll;
      return {
        total: rows.length,
        counted: rows.filter(r => r.known).length,
        low: rows.filter(r => r.state === 'low').length,
        neg: rows.filter(r => r.state === 'neg').length,
        none: rows.filter(r => r.state === 'none').length,
        units: rows.reduce((t, r) => t + (r.known ? r.qty : 0), 0)
      };
    },
    rows() {
      const kw = this.search.trim().toLowerCase();
      return this.rowsAll.filter(r => {
        if (this.filter !== 'all' && r.state !== this.filter) return false;
        if (!kw) return true;
        return r.p.name.toLowerCase().includes(kw)
          || (r.p.series || '').toLowerCase().includes(kw)
          || (r.p.location || '').toLowerCase().includes(kw)
          || (r.p.sku_code || '').toLowerCase().includes(kw);
      });
    },
    stockValue() {
      return this.rowsAll.reduce((t, r) => t + (r.known && r.p.cost_price ? r.qty * Number(r.p.cost_price) : 0), 0);
    }
  },
  methods: {
    money, fmtDT, group,
    stateTxt(s) { return { none: '未盘点', neg: '负库存', low: '偏低', ok: '正常' }[s] || s; },
    stateTag(s) { return { none: 'gray', neg: 'danger', low: 'warn', ok: 'ok' }[s] || 'gray'; },
    movTxt(t) { return MOV_TXT[t] || t; },
    movTag(t) { return MOV_TAG[t] || 'gray'; },
    openStockIn(r) { store.ui.sheet = { type: 'stockin', productId: r ? r.p.id : null }; },
    openTake(r) { store.ui.sheet = { type: 'stocktake', productId: r.p.id }; },
    toggle(r) {
      const id = r.p.id;
      this.expanded = { ...this.expanded, [id]: !this.expanded[id] };
    },
    movements(r) { return movementsOf(store.db, r.p.id, 12); },
    refLabel(m) {
      if (m.ref_no) return m.ref_no;
      return { in: '入库单', adjust: '盘点单', out: '订单', reversal: '冲销' }[m.movement_type] || '—';
    }
  },
  template: `
<div class="v-inventory">
  <div class="page-head row-between">
    <div>
      <div class="page-title">库存</div>
      <div class="page-sub">{{ summary.total }} 个 SKU · 账面在库 <span class="mono">{{ group(summary.units) }}</span> 件</div>
    </div>
    <button class="btn btn-primary" @click="openStockIn(null)">
      <ui-icon name="boxIn" :size="17" /> 入库
    </button>
  </div>

  <div class="stat-grid" style="margin-bottom:14px">
    <div class="stat stat-accent">
      <div class="stat-label">已盘点</div>
      <div class="stat-value">{{ summary.counted }}<span class="stat-unit">/ {{ summary.total }}</span></div>
      <div class="stat-foot">未建账 {{ summary.none }} 个</div>
    </div>
    <div class="stat stat-warn is-click" @click="filter = 'low'">
      <div class="stat-label">偏低</div>
      <div class="stat-value">{{ summary.low }}</div>
      <div class="stat-foot">低于安全库存</div>
    </div>
    <div class="stat stat-danger is-click" @click="filter = 'neg'">
      <div class="stat-label">负库存</div>
      <div class="stat-value">{{ summary.neg }}</div>
      <div class="stat-foot">账实不符，该盘点了</div>
    </div>
    <div class="stat">
      <div class="stat-label">库存成本</div>
      <div class="stat-value" style="font-size:22px">{{ money(stockValue) }}</div>
      <div class="stat-foot">按成本价估算</div>
    </div>
  </div>

  <div class="card filter-card">
    <div class="card-body">
      <div class="input-search">
        <ui-icon name="search" :size="17" />
        <input class="input" v-model="search" type="search" placeholder="搜商品 / 系列 / 货位 / SKU" aria-label="搜索库存">
      </div>
      <div class="chips-scroll" style="margin-top:10px">
        <button v-for="f in filters" :key="f.key" class="chip"
                :class="{ 'chip-brand': filter === f.key && f.key !== 'all' }" :aria-pressed="filter === f.key"
                @click="filter = f.key">{{ f.label }}</button>
      </div>
    </div>
  </div>

  <div class="inv-list" v-if="rows.length">
    <div class="inv-row" v-for="r in rows" :key="r.p.id" :class="{ 'is-open': expanded[r.p.id] }">
      <div class="inv-main" @click="toggle(r)">
        <div class="inv-info">
          <div class="inv-name">
            <span class="strong">{{ r.p.name }}</span>
            <span class="tag" :class="'tag-' + stateTag(r.state)">{{ stateTxt(r.state) }}</span>
            <span class="tag tag-gray" v-if="r.p.status === 'off_sale'">停售</span>
          </div>
          <div class="inv-meta xs muted">
            {{ r.p.series }} · {{ r.p.location || '未设货位' }} · {{ r.p.sku_code }}
            <template v-if="r.known && r.threshold > 0"> · 阈值 {{ r.threshold }}</template>
          </div>
        </div>
        <div class="inv-qty">
          <b class="mono" :class="{ neg: r.known && r.qty < 0, low: r.state === 'low' }">{{ r.known ? r.qty : '—' }}</b>
          <span class="xs muted">件</span>
        </div>
        <ui-icon name="chevronDown" :size="15" class="inv-caret" />
      </div>

      <div class="inv-actions">
        <button class="btn btn-sm" @click="openStockIn(r)"><ui-icon name="boxIn" :size="14" /> 入库</button>
        <button class="btn btn-sm" @click="openTake(r)"><ui-icon name="count" :size="14" /> 盘点</button>
      </div>

      <div class="inv-movs" v-if="expanded[r.p.id]">
        <div class="xs muted" style="margin-bottom:6px">最近变动</div>
        <div class="mov-row" v-for="m in movements(r)" :key="m.id">
          <span class="tag" :class="'tag-' + movTag(m.movement_type)">{{ movTxt(m.movement_type) }}</span>
          <span class="mono mov-qty" :class="m.quantity > 0 ? 'pos' : 'neg'">{{ (m.quantity > 0 ? '+' : '') + m.quantity }}</span>
          <span class="grow truncate xs muted">{{ refLabel(m) }}<template v-if="m.note"> · {{ m.note }}</template></span>
          <span class="xs muted mono">{{ fmtDT(m.created_at) }}</span>
        </div>
        <div class="xs muted" v-if="!movements(r).length">还没有库存变动</div>
      </div>
    </div>
  </div>

  <div class="card" v-else>
    <div class="card-body">
      <ui-empty icon="inventory" title="没有符合条件的商品" text="换个筛选条件，或先去「商品」页添加商品。">
        <button class="btn" @click="filter = 'all'; search = ''">重置筛选</button>
      </ui-empty>
    </div>
  </div>
</div>`
};
