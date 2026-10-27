/* 入库 / 盘点：由 app 统一挂载，任何页面都能唤起 */
import { UiSheet } from './index.js';
import { store, actions, stockState, productById, productsOnSale, toast } from '../data/store.js';
import { money, num, int, MOV_TXT } from '../util/format.js';

export const UiStockInSheet = {
  name: 'UiStockInSheet',
  components: { UiSheet },
  props: { productId: { type: Number, default: null } },
  emits: ['close'],
  data() {
    const single = this.productId ? productById(store.db, this.productId) : null;
    return {
      mode: single ? 'single' : 'batch',
      single,
      qty: 1,
      note: '',
      search: '',
      batch: {},
      submitting: false
    };
  },
  computed: {
    candidates() {
      const kw = this.search.trim().toLowerCase();
      return productsOnSale.value.filter(p => !kw || p.name.toLowerCase().includes(kw) || (p.series || '').toLowerCase().includes(kw));
    },
    batchItems() {
      return Object.entries(this.batch)
        .filter(([, q]) => int(q) > 0)
        .map(([id, q]) => ({ product_id: Number(id), quantity: int(q) }));
    },
    batchCount() { return this.batchItems.length; },
    batchTotal() { return this.batchItems.reduce((t, i) => t + i.quantity, 0); }
  },
  methods: {
    money, int,
    qtyOf(id) { return this.batch[id] || ''; },
    setQty(id, v) { this.batch = { ...this.batch, [id]: v }; },
    bumpBatch(id, d) {
      const cur = int(this.batch[id]);
      const next = Math.max(0, cur + d);
      this.setQty(id, next || '');
    },
    stockOf(id) { return stockState(id); },
    async submit() {
      let items, note = this.note.trim() || null;
      if (this.mode === 'single') {
        if (!this.single || int(this.qty) < 1) return;
        items = [{ product_id: this.single.id, quantity: int(this.qty) }];
      } else {
        items = this.batchItems;
        if (!items.length) return;
      }
      this.submitting = true;
      const res = await actions.stockIn(items, note);
      this.submitting = false;
      if (res.ok) {
        const total = items.reduce((t, i) => t + i.quantity, 0);
        this.$emit('close');
        toast(`入库 ${items.length} 个商品，共 ${total} 件`, 'ok');
      }
    }
  },
  template: `
    <ui-sheet :title="mode === 'single' ? '入库' : '批量入库'" @close="$emit('close')">
      <template v-if="mode === 'single' && single">
        <div class="sheet-product">
          <div class="grow">
            <div class="strong">{{ single.name }}</div>
            <div class="xs muted">{{ single.series }} · 现余
              {{ stockOf(single.id).known ? stockOf(single.id).qty : '未盘点' }}
            </div>
          </div>
          <span class="tag" :class="'tag-' + (stockOf(single.id).state === 'ok' ? 'ok' : stockOf(single.id).state === 'none' ? 'gray' : 'warn')">
            {{ stockOf(single.id).known ? '已建账' : '未盘点' }}
          </span>
        </div>
        <div class="field">
          <span class="field-label">入库数量</span>
          <div class="big-qty">
            <button type="button" class="big-qty-btn" @click="qty = Math.max(1, qty - 1)" aria-label="减少">−</button>
            <input class="input input-mono big-qty-input" type="number" inputmode="numeric" min="1" v-model.number="qty" aria-label="入库数量">
            <button type="button" class="big-qty-btn" @click="qty = Number(qty) + 1" aria-label="增加">＋</button>
          </div>
          <div class="chips" style="margin-top:9px">
            <button v-for="n in [1, 5, 10, 20]" :key="n" type="button" class="chip" @click="qty = Number(qty) + n">＋{{ n }}</button>
          </div>
        </div>
        <div class="field">
          <span class="field-label">备注（选填）</span>
          <input class="input" v-model="note" placeholder="例如：进货补货 / 摊位调拨">
        </div>
        <p class="xs muted">首次入库会给该商品建账，之后余额自动累计。</p>
      </template>

      <template v-else>
        <div class="input-search" style="margin-bottom:10px">
          <ui-icon name="search" :size="17" />
          <input class="input" v-model="search" type="search" placeholder="搜商品" aria-label="搜索商品">
        </div>
        <div class="batch-list">
          <div class="batch-row" v-for="p in candidates" :key="p.id">
            <div class="grow">
              <div class="strong small">{{ p.name }}</div>
              <div class="xs muted">{{ p.series }} · 余 {{ stockOf(p.id).known ? stockOf(p.id).qty : '未盘点' }}</div>
            </div>
            <div class="batch-ctrl">
              <button type="button" class="batch-btn" @click="bumpBatch(p.id, -1)" aria-label="减少">−</button>
              <input class="input input-mono batch-input" type="number" inputmode="numeric" min="0"
                     :value="qtyOf(p.id)" @input="setQty(p.id, $event.target.value)" :aria-label="p.name + ' 入库数量'" placeholder="0">
              <button type="button" class="batch-btn" @click="bumpBatch(p.id, 1)" aria-label="增加">＋</button>
            </div>
          </div>
        </div>
        <div class="field" style="margin-top:12px">
          <span class="field-label">备注（选填）</span>
          <input class="input" v-model="note" placeholder="例如：进货补货 / 摊位调拨">
        </div>
      </template>

      <template #foot>
        <button class="btn" @click="$emit('close')" :disabled="submitting">取消</button>
        <button class="btn btn-primary grow" @click="submit"
                :disabled="submitting || (mode === 'single' ? int(qty) < 1 : !batchCount)">
          确认入库<template v-if="mode === 'batch' && batchCount">（{{ batchCount }} 种 {{ batchTotal }} 件）</template>
        </button>
      </template>
    </ui-sheet>`
};

export const UiStockTakeSheet = {
  name: 'UiStockTakeSheet',
  components: { UiSheet },
  props: { productId: { type: Number, required: true } },
  emits: ['close'],
  data() {
    const st = stockState(this.productId);
    return {
      product: productById(store.db, this.productId),
      system: st.known ? st.qty : null,
      /* 账面为负时实盘不能预填负数，从 0 开始数 */
      counted: st.known ? String(Math.max(0, st.qty)) : '',
      reason: '',
      submitting: false
    };
  },
  computed: {
    countedNum() { return this.counted === '' ? null : int(this.counted); },
    diff() { return this.countedNum === null || this.system === null ? null : this.countedNum - this.system; },
    valid() { return this.countedNum !== null && this.countedNum >= 0; }
  },
  methods: {
    nudge(d) {
      const base = this.countedNum === null ? 0 : this.countedNum;
      this.counted = String(Math.max(0, base + d));
    },
    adjustLabel() { return MOV_TXT.adjust; },
    async submit() {
      if (!this.valid) return;
      this.submitting = true;
      const res = await actions.setStock(this.product.id, this.countedNum, this.reason.trim() || null);
      this.submitting = false;
      if (res.ok) this.$emit('close');
    }
  },
  template: `
    <ui-sheet title="盘点" :subtitle="product ? product.name : ''" @close="$emit('close')">
      <div class="sheet-product">
        <div class="grow">
          <div class="strong">{{ product ? product.name : '' }}</div>
          <div class="xs muted">{{ product ? product.series : '' }}</div>
        </div>
        <div class="take-system">
          <span class="xs muted">账面</span>
          <b class="mono">{{ system === null ? '未建账' : system }}</b>
        </div>
      </div>

      <div class="field">
        <span class="field-label">实盘数量</span>
        <div class="big-qty">
          <button type="button" class="big-qty-btn" @click="nudge(-1)" aria-label="减少">−</button>
          <input class="input input-mono big-qty-input" type="number" inputmode="numeric" min="0" v-model="counted" aria-label="实盘数量">
          <button type="button" class="big-qty-btn" @click="nudge(1)" aria-label="增加">＋</button>
        </div>
      </div>

      <div class="take-diff" v-if="diff !== null" :class="diff === 0 ? 'is-same' : diff > 0 ? 'is-more' : 'is-less'">
        <span v-if="diff === 0"><ui-icon name="check" :size="15" /> 账实一致，无需调整</span>
        <span v-else>
          <ui-icon :name="diff > 0 ? 'trendUp' : 'trendDown'" :size="15" />
          差异 <b class="mono">{{ diff > 0 ? '+' : '' }}{{ diff }}</b> 件，提交后生成盘点调整流水
        </span>
      </div>
      <div class="take-diff is-new" v-else>
        <ui-icon name="info" :size="15" /> 这是首次盘点，将以实盘数作为期初库存
      </div>

      <div class="field" style="margin-top:12px">
        <span class="field-label">差异原因（选填）</span>
        <input class="input" v-model="reason" placeholder="例如：丢失 / 送人 / 记错">
      </div>

      <p class="xs muted">盘点不改历史流水，只补一条「{{ adjustLabel() }}」，账实差异留痕可查。</p>

      <template #foot>
        <button class="btn" @click="$emit('close')" :disabled="submitting">取消</button>
        <button class="btn btn-primary grow" @click="submit" :disabled="submitting || !valid">
          {{ diff === 0 ? '确认无差异' : '确认盘点' }}
        </button>
      </template>
    </ui-sheet>`
};
