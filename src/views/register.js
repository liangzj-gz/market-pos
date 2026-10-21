/* 开单收银台：选货 → 看应收 → 收款，三步以内完成一单 */
import {
  store, productsOnSale, combosOnSale, seriesList, frequentIds,
  stockState, balanceOf, actions, productById, comboById
} from '../data/store.js';
import { money, moneyNum, num, r2, int } from '../util/format.js';
import {
  addProduct, addCombo, incLine, decLine, removeLine, setLineQty, setLinePrice,
  toggleGift, clearCart, cartTotal, cartPieces, cartToOrderLines, cartDemandByProduct
} from '../domain/cart.js';
import { expandCombo } from '../domain/rules.js';
import { UiPaySheet } from '../components/pay-sheet.js';
import { UiReceipt } from '../components/receipt.js';

export const RegisterView = {
  name: 'RegisterView',
  components: { UiPaySheet, UiReceipt },
  data() {
    return { paying: false, submitting: false, receipt: null, confirmClear: false };
  },
  computed: {
    store() { return store; },
    reg() { return store.ui.register; },
    cart() { return store.ui.cart; },
    note: {
      get() { return store.ui.cartNote; },
      set(v) { store.ui.cartNote = v; }
    },
    series() { return seriesList.value; },
    frequent() { return frequentIds.value; },
    demand() { return cartDemandByProduct(); },
    combos() { return combosOnSale.value; },
    products() {
      const kw = this.reg.search.trim().toLowerCase();
      let list = productsOnSale.value.filter(p => {
        if (this.reg.series !== '全部' && (p.series || '未分类') !== this.reg.series) return false;
        if (this.reg.onlyFrequent && !this.frequent.includes(p.id)) return false;
        if (!kw) return true;
        return p.name.toLowerCase().includes(kw)
          || (p.series || '').toLowerCase().includes(kw)
          || (p.category || '').toLowerCase().includes(kw)
          || (p.sku_code || '').toLowerCase().includes(kw)
          || (p.tags || []).join(' ').toLowerCase().includes(kw);
      });
      /* 常卖的排前面，其余按系列聚拢，摊位上找货不用来回翻 */
      const freqRank = id => { const i = this.frequent.indexOf(id); return i < 0 ? 999 : i; };
      return list.sort((a, b) => {
        const fa = freqRank(a.id), fb = freqRank(b.id);
        if (fa !== fb) return fa - fb;
        const s = (a.series || '').localeCompare(b.series || '', 'zh-Hans-CN');
        return s !== 0 ? s : a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
    },
    total() { return cartTotal(); },
    pieces() { return cartPieces(); },
    lines() { return this.cart.length; },
    hasItems() { return this.cart.length > 0; },
    cartOpen: {
      get() { return store.ui.cartOpen; },
      set(v) { store.ui.cartOpen = v; }
    },
    emptyCatalog() { return store.db.products.length === 0; }
  },
  methods: {
    money, moneyNum, num, r2, int,
    addProduct(p) { addProduct(p); this.bump(); },
    addCombo(c) { addCombo(c); this.bump(); },
    incLine, decLine, removeLine, toggleGift,
    onQty(l, e) { setLineQty(l, e.target.value); },
    onPrice(l, e) { setLinePrice(l, e.target.value); },
    /* 商品格上显示「扣掉这单还剩几件」 */
    stockLeft(p) {
      const b = balanceOf(store.db, p.id);
      if (b === null) return { text: '未盘点', low: false };
      const left = b - (this.demand[p.id] || 0);
      const th = num(p.safety_stock);
      return { text: '余 ' + left, low: left < 0 || (th > 0 && left <= th) };
    },
    inCart(p) {
      const l = this.cart.find(x => x.key === 'p' + p.id);
      return l ? l.qty : 0;
    },
    comboInCart(c) {
      const l = this.cart.find(x => x.key === 'c' + c.id);
      return l ? l.qty : 0;
    },
    comboPieces(c) {
      return (c.items || []).reduce((t, it) => t + int(it.quantity), 0);
    },
    comboNames(c) {
      return (c.items || []).map(it => {
        const p = productById(store.db, it.product_id);
        return (p ? p.name : '?') + '×' + int(it.quantity);
      }).join(' + ');
    },
    bump() {
      /* 轻微反馈：加了货就让购物车条呼吸一下 */
      this.$nextTick(() => {
        const el = this.$refs.cartBar;
        if (!el) return;
        el.classList.remove('is-bump');
        void el.offsetWidth;
        el.classList.add('is-bump');
      });
    },
    setSeries(s) { this.reg.series = s; },
    clearSearch() { this.reg.search = ''; },
    doClear() { clearCart(); this.cartOpen = false; this.confirmClear = false; },
    openPay() {
      if (!this.hasItems) return;
      this.cartOpen = false;
      this.paying = true;
    },
    onPaySubmit(payload) {
      this.submitting = true;
      const res = actions.createOrder({
        lines: cartToOrderLines(),
        note: this.note.trim() || null,
        settle: true,
        ...payload
      });
      this.submitting = false;
      if (!res.ok) return;
      this.paying = false;
      const d = res.data;
      clearCart();
      this.receipt = {
        order: d.order,
        items: store.db.orderItems.filter(i => i.order_id === d.order.id),
        adjustment: d.adjustment,
        alerts: d.alerts
      };
    },
    hang() {
      if (!this.hasItems) return;
      const res = actions.createOrder({ lines: cartToOrderLines(), note: this.note.trim() || null, settle: false });
      if (!res.ok) return;
      this.cartOpen = false;
      const d = res.data;
      clearCart();
      this.receipt = {
        order: d.order,
        items: store.db.orderItems.filter(i => i.order_id === d.order.id),
        adjustment: null,
        alerts: []
      };
    }
  },
  template: `
<div class="v-register">
  <div class="reg-layout">
    <!-- 选货 -->
    <section class="reg-pick">
      <div class="pick-bar">
        <div class="input-search">
          <ui-icon name="search" :size="17" />
          <input class="input" v-model="reg.search" type="search" enterkeyhint="search"
                 placeholder="搜名称 / 系列 / SKU" aria-label="搜索商品">
          <button v-if="reg.search" class="pick-clear" @click="clearSearch" aria-label="清空搜索">
            <ui-icon name="close" :size="15" />
          </button>
        </div>
        <div class="chips-scroll">
          <button v-for="s in series" :key="s" class="chip" :class="{ 'chip-brand': reg.series === s && s !== '全部' }"
                  :aria-pressed="reg.series === s" @click="setSeries(s)">{{ s }}</button>
          <button class="chip chip-freq" :class="{ 'is-on': reg.onlyFrequent }" :aria-pressed="reg.onlyFrequent"
                  @click="reg.onlyFrequent = !reg.onlyFrequent">
            <ui-icon name="spark" :size="14" /> 常卖
          </button>
        </div>
      </div>

      <div class="card" v-if="combos.length">
        <div class="card-head"><h3><ui-icon name="layers" :size="16" /> 套餐</h3><span class="hint">点一下整套入单</span></div>
        <div class="card-body combo-list">
          <button v-for="c in combos" :key="c.id" class="combo-cell" :class="{ 'has-qty': comboInCart(c) }" @click="addCombo(c)">
            <span class="combo-badge" v-if="comboInCart(c)">{{ comboInCart(c) }}</span>
            <span class="combo-name">{{ c.name }}</span>
            <span class="combo-parts">{{ comboNames(c) }}</span>
            <span class="combo-price">
              <b class="mono">{{ money(c.combo_price) }}</b>
              <s class="mono" v-if="c.original_price">{{ money(c.original_price) }}</s>
            </span>
          </button>
        </div>
      </div>

      <div v-if="emptyCatalog" class="card"><div class="card-body">
        <ui-empty icon="products" title="还没有商品" text="先到「商品」页添加在售商品，或在「设置」里载入演示数据。">
          <button class="btn btn-primary" @click="store.ui.view = 'catalog'">去添加商品</button>
        </ui-empty>
      </div></div>

      <div v-else-if="!products.length" class="card"><div class="card-body">
        <ui-empty icon="search" title="没有匹配的商品" text="换个关键词，或把系列切回「全部」。">
          <button class="btn" @click="reg.search = ''; reg.series = '全部'; reg.onlyFrequent = false">重置筛选</button>
        </ui-empty>
      </div></div>

      <template v-else>
        <div class="pick-grid">
          <button v-for="p in products" :key="p.id" class="pick-cell" :class="{ 'has-qty': inCart(p), 'is-low': stockLeft(p).low }"
                  @click="addProduct(p)" :aria-label="'加入 ' + p.name">
            <span class="pick-badge mono" v-if="inCart(p)">{{ inCart(p) }}</span>
            <span class="pick-name">{{ p.name }}</span>
            <span class="pick-price mono">{{ money(p.list_price) }}</span>
            <span class="pick-stock" :class="{ low: stockLeft(p).low }">
              {{ stockLeft(p).text }}
            </span>
          </button>
        </div>
      </template>
    </section>

    <!-- 购物车：桌面右侧常驻，移动端底部抽屉 -->
    <aside class="reg-cart" :class="{ 'is-open': cartOpen }">
      <div class="cart-panel">
        <div class="cart-head">
          <h3><ui-icon name="register" :size="16" /> 本单</h3>
          <span class="mono small">{{ lines }} 行 · {{ pieces }} 件</span>
          <button class="btn btn-quiet btn-sm" v-if="hasItems" @click="confirmClear = true">
            <ui-icon name="trash" :size="14" /> 清空
          </button>
        </div>

        <div class="cart-body" v-if="hasItems">
          <div class="cart-line" v-for="l in cart" :key="l.key">
            <div class="cl-top">
              <span class="cl-name">
                {{ l.name }}
                <i class="tag tag-brand" v-if="l.type === 'combo'">套餐</i>
                <i class="tag tag-ok" v-if="l.gift">赠品</i>
              </span>
              <button class="cl-del" @click="removeLine(l)" aria-label="删除该行"><ui-icon name="close" :size="14" /></button>
            </div>
            <div class="cl-bottom">
              <label class="gift-check" v-if="l.type === 'product'">
                <input type="checkbox" :checked="l.gift" @change="toggleGift(l)">
                <span class="switch-track" aria-hidden="true"></span>
                <span class="xs">送出去</span>
              </label>
              <span v-else class="xs muted">按明细扣库存</span>
              <div class="cl-right">
                <span class="cl-price">
                  <i>¥</i><input class="input input-mono cl-price-input" type="number" inputmode="decimal" step="0.01" min="0"
                                 :value="l.price" :disabled="l.gift" @change="onPrice(l, $event)" :aria-label="l.name + ' 单价'">
                </span>
                <span class="stepper">
                  <button @click="decLine(l)" aria-label="减少"><ui-icon name="minus" :size="15" /></button>
                  <input class="stepper-input mono" type="number" inputmode="numeric" min="1" :value="l.qty"
                         @change="onQty(l, $event)" :aria-label="l.name + ' 数量'">
                  <button @click="incLine(l)" aria-label="增加"><ui-icon name="plus" :size="15" /></button>
                </span>
                <b class="cl-amt mono">{{ l.gift ? money(0) : money(l.qty * l.price) }}</b>
              </div>
            </div>
          </div>

          <div class="field" style="margin:12px 0 0">
            <input class="input" v-model="note" placeholder="备注（选填）：客人要求、口头约定、取货时间…" aria-label="订单备注">
          </div>
        </div>

        <div class="cart-body cart-empty" v-else>
          <ui-empty icon="register" title="还没选货" text="左边点商品就进单，套餐点一下整套展开。" />
        </div>

        <div class="cart-foot">
          <div class="cart-total-row">
            <span class="cart-total-label">应收</span>
            <span class="cart-total mono"><i>¥</i>{{ moneyNum(total) }}</span>
          </div>
          <div class="cart-actions">
            <button class="btn btn-lg" :disabled="!hasItems" @click="hang">挂单</button>
            <button class="btn btn-primary btn-lg btn-checkout grow" :disabled="!hasItems" @click="openPay">
              <ui-icon name="wallet" :size="18" /> 收款
            </button>
          </div>
          <p class="xs muted center" style="margin-top:8px">收款即扣库存；挂单先记着，收到钱再确认。</p>
        </div>
      </div>
    </aside>
  </div>

  <!-- 移动端购物车浮条 -->
  <button class="cart-bar" ref="cartBar" v-if="hasItems" @click="cartOpen = !cartOpen"
          :aria-expanded="cartOpen" aria-label="展开本单">
    <span class="cart-bar-count mono">{{ pieces }}</span>
    <span class="cart-bar-text">
      <b class="mono">{{ money(total) }}</b>
      <em>{{ lines }} 行商品</em>
    </span>
    <span class="cart-bar-cta">收款 <ui-icon name="chevronUp" :size="15" /></span>
  </button>

  <ui-pay-sheet v-if="paying" :total="total" :pieces="pieces" :submitting="submitting"
                title="收款" @close="paying = false" @submit="onPaySubmit" />

  <ui-receipt v-if="receipt" :result="receipt"
              @close="receipt = null" @again="receipt = null"
              @go-orders="receipt = null; store.ui.view = 'orders'" />

  <ui-confirm v-if="confirmClear" title="清空本单？" text="已选的商品会全部移除，不影响历史订单。"
              confirm-text="清空" danger @yes="doClear" @no="confirmClear = false" />
</div>`
};
