/* 开单收银台：选货 → 看应收 → 收款，三步以内完成一单 */
import {
  store, productsOnSale, combosOnSale, frequentIds,
  stockState, balanceOf, actions, productById, comboById, tagLibrary, toast,
  productImageSrc
} from '../data/store.js';
import { money, moneyNum, num, r2, int } from '../util/format.js';
import {
  addProduct, addCombo, addComboSelection, incLine, decLine, removeLine, setLineQty, setLinePrice,
  toggleGift, clearCart, cartTotal, cartPieces, cartToOrderLines, cartDemandByProduct
} from '../domain/cart.js';
import { comboHasGroups, categoryPath, childrenOf } from '../domain/rules.js';
import { UiSheet } from '../components/index.js';
import { UiPaySheet } from '../components/pay-sheet.js';
import { UiReceipt } from '../components/receipt.js';
import { UiBarcodeScanner } from '../components/barcode-scanner.js';
import { matchBarcode } from '../domain/barcode.js';

export const RegisterView = {
  name: 'RegisterView',
  components: { UiSheet, UiPaySheet, UiReceipt, UiBarcodeScanner },
  data() {
    return {
      paying: false, submitting: false, receipt: null, confirmClear: false,
      scanning: false, scanFeedback: '', scanTone: 'info', scanSuccess: 0,
      dockScanner: window.matchMedia('(min-width: 900px)').matches,
      compactTags: window.matchMedia('(max-width: 640px)').matches, tagPickerOpen: false, searchExpanded: false,
      comboPick: null, pickGroups: [], activeRoot: null, activeMid: null, pickTab: 'products', tag: 'all'
    };
  },
  computed: {
    store() { return store; },
    reg() { return store.ui.register; },
    cart() { return store.ui.cart; },
    note: {
      get() { return store.ui.cartNote; },
      set(v) { store.ui.cartNote = v; }
    },
    frequent() { return frequentIds.value; },
    demand() { return cartDemandByProduct(); },
    scanItems() {
      return Object.entries(this.demand).filter(([, qty]) => qty > 0).map(([id, qty]) => {
        const product = productById(store.db, Number(id));
        const line = this.cart.find(item => item.type === 'product' && String(item.id) === id);
        return { id, name: product?.name || line?.name || '未知商品', qty, unit: product?.unit || '件', canDecrease: !!line, canIncrease: product?.status === 'on_sale' };
      });
    },
    combos() { return combosOnSale.value; },
    tags() {
      return tagLibrary.value.map(t => ({
        name: t.name, count: productsOnSale.value.filter(p => (p.tags || []).includes(t.name)).length
      }));
    },
    products() {
      const kw = this.reg.search.trim().toLowerCase();
      let list = productsOnSale.value.filter(p => {
        if (this.reg.onlyFrequent && !this.frequent.includes(p.id)) return false;
        if (this.tag !== 'all' && !(p.tags || []).includes(this.tag)) return false;
        if (!kw) return true;
        return p.name.toLowerCase().includes(kw)
          || (p.series || '').toLowerCase().includes(kw)
          || (p.category || '').toLowerCase().includes(kw)
          || (p.sku_code || '').toLowerCase().includes(kw)
          || categoryPath(store.db, p.category_id).map(c => c.name).join(' ').toLowerCase().includes(kw)
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
    rootGroups() {
      const roots = new Map();
      const order = new Map(childrenOf(store.db, null)
        .flatMap(root => [root, ...childrenOf(store.db, root.id)])
        .map((c, i) => [c.id, i]));
      for (const p of this.products) {
        const path = categoryPath(store.db, p.category_id);
        const root = path[0], mid = path[1];
        const key = String(root?.id ?? 'none');
        if (!roots.has(key)) roots.set(key, { key, name: root?.name || '未分类', id: root?.id, total: 0, mids: new Map() });
        const group = roots.get(key);
        const midKey = key + '-' + String(mid?.id ?? 'none');
        if (!group.mids.has(midKey)) group.mids.set(midKey, { key: midKey, id: mid?.id, name: mid?.name || (root ? '未细分' : '未分类'), items: [] });
        group.total++;
        group.mids.get(midKey).items.push(p);
      }
      const rank = c => order.get(c.id) ?? Infinity;
      return [...roots.values()].sort((a, b) => rank(a) - rank(b)).map(g => ({
        ...g, mids: [...g.mids.values()].sort((a, b) => rank(a) - rank(b))
      }));
    },
    activeRootGroup() { return this.rootGroups.find(g => g.key === this.activeRoot) || this.rootGroups[0]; },
    activeMids() { return this.activeRootGroup?.mids || []; },
    total() { return cartTotal(); },
    pieces() { return cartPieces(); },
    lines() { return this.cart.length; },
    hasItems() { return this.cart.length > 0; },
    cartOpen: {
      get() { return store.ui.cartOpen; },
      set(v) { store.ui.cartOpen = v; }
    },
    emptyCatalog() { return store.db.products.length === 0; },
    comboPickReady() {
      return !!(this.comboPick && this.pickGroups.length
        && this.pickGroups.every(group => this.pickGroupCount(group) === group.required));
    }
  },
  watch: {
    hasItems(value) { if (!value) { this.scanFeedback = ''; this.scanTone = 'info'; } },
    rootGroups() { this._anchor = null; this.$nextTick(this.refreshCategories); },
    pickTab() {
      this.tagPickerOpen = false;
      this.searchExpanded = false;
      this._anchor = null;
      this.$nextTick(() => {
        this.refreshCategories();
        this.scrollHost().scrollTo({ top: 0, behavior: 'instant' });
      });
    },
    activeRoot() { this.$nextTick(this.revealCategoryAnchors); },
    activeMid() { this.$nextTick(this.revealCategoryAnchors); }
  },
  mounted() {
    this._tagMedia = window.matchMedia('(max-width: 640px)');
    this._tagLayout = event => {
      this.compactTags = event.matches;
      this.searchExpanded = event.matches && document.activeElement === this.$refs.productSearch;
      if (!event.matches) this.tagPickerOpen = false;
    };
    this._tagMedia.addEventListener('change', this._tagLayout);
    this._scannerMedia = window.matchMedia('(min-width: 900px)');
    this._scannerLayout = event => { this.scanning = false; this.dockScanner = event.matches; };
    this._scannerMedia.addEventListener('change', this._scannerLayout);
    this._keyboardViewport = window.visualViewport;
    this._keyboardLayout = () => {
      if (this._keyboardRaf) return;
      this._keyboardRaf = requestAnimationFrame(() => {
        this._keyboardRaf = null;
        this.fitCartToKeyboard();
      });
    };
    this._keyboardViewport?.addEventListener('resize', this._keyboardLayout);
    this._keyboardViewport?.addEventListener('scroll', this._keyboardLayout);
    document.addEventListener('focusin', this._keyboardLayout);
    document.addEventListener('focusout', this._keyboardLayout);
    this._categoryScroll = () => {
      if (this._categoryRaf) return;
      this._categoryRaf = requestAnimationFrame(() => {
        this._categoryRaf = null;
        this.refreshCategories();
      });
    };
    window.addEventListener('scroll', this._categoryScroll, { passive: true });
    this.$refs.pickPane.addEventListener('scroll', this._categoryScroll, { passive: true });
    this._cancelAnchor = () => { this._anchor = null; };
    window.addEventListener('wheel', this._cancelAnchor, { passive: true });
    window.addEventListener('touchstart', this._cancelAnchor, { passive: true });
    window.addEventListener('keydown', this._cancelAnchor);
    window.addEventListener('resize', this._categoryScroll, { passive: true });
    this._categoryObserver = new ResizeObserver(() => this.refreshCategories());
    this._categoryObserver.observe(this.$refs.pickBar);
    this.$nextTick(this.refreshCategories);
  },
  beforeUnmount() {
    this._tagMedia.removeEventListener('change', this._tagLayout);
    this._keyboardViewport?.removeEventListener('resize', this._keyboardLayout);
    this._keyboardViewport?.removeEventListener('scroll', this._keyboardLayout);
    document.removeEventListener('focusin', this._keyboardLayout);
    document.removeEventListener('focusout', this._keyboardLayout);
    if (this._keyboardRaf) cancelAnimationFrame(this._keyboardRaf);
    this._scannerMedia.removeEventListener('change', this._scannerLayout);
    window.removeEventListener('scroll', this._categoryScroll);
    this.$refs.pickPane.removeEventListener('scroll', this._categoryScroll);
    window.removeEventListener('wheel', this._cancelAnchor);
    window.removeEventListener('touchstart', this._cancelAnchor);
    window.removeEventListener('keydown', this._cancelAnchor);
    window.removeEventListener('resize', this._categoryScroll);
    this._categoryObserver.disconnect();
    if (this._categoryRaf) cancelAnimationFrame(this._categoryRaf);
  },
  methods: {
    startSearch() {
      if (this.compactTags) this.searchExpanded = true;
    },
    finishSearch(event) {
      if (event?.isComposing || event?.keyCode === 229) return;
      event?.preventDefault();
      this.searchExpanded = false;
      this.$refs.productSearch?.blur();
    },
    leaveSearch(event) {
      if (!event.currentTarget.contains(event.relatedTarget)) this.searchExpanded = false;
    },
    openTagPicker() {
      this.tagPickerOpen = true;
      this.$nextTick(() => this.$refs.tagOptions?.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true }));
    },
    closeTagPicker() {
      this.tagPickerOpen = false;
      this.$nextTick(() => this.$refs.tagToggle?.focus({ preventScroll: true }));
    },
    selectTag(name) {
      this.tag = name;
      this.closeTagPicker();
    },
    fitCartToKeyboard() {
      const cart = this.$el.querySelector('.reg-cart');
      const viewport = this._keyboardViewport;
      const input = document.activeElement;
      const editing = input?.matches('input, textarea') && cart?.contains(input);
      const keyboardOpen = !!(viewport && this.cartOpen && !this.dockScanner && editing
        && window.innerHeight - viewport.height > 100);
      cart?.classList.toggle('is-keyboard-open', keyboardOpen);
      if (!keyboardOpen) return;
      cart.style.setProperty('--cart-visible-height', viewport.height + 'px');
      cart.style.setProperty('--cart-keyboard-bottom', Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) + 'px');
      // 仅滚动本单明细，避免 Safari 把整个页面拖到输入框所在的位置。
      const body = cart.querySelector('.cart-body');
      if (!body?.contains(input)) return;
      const bounds = body.getBoundingClientRect();
      const field = input.getBoundingClientRect();
      if (field.bottom > bounds.bottom - 12) body.scrollTop += field.bottom - bounds.bottom + 12;
      else if (field.top < bounds.top + 12) body.scrollTop -= bounds.top + 12 - field.top;
    },
    async openScanCart() {
      this.scanning = false;
      await this.$nextTick();
      this.cartOpen = true;
    },
    changeScanQuantity({ id, delta }) {
      const product = productById(store.db, Number(id));
      const line = this.cart.find(item => item.type === 'product' && String(item.id) === String(id));
      if (delta === 1 && product?.status === 'on_sale') addProduct(product);
      else if (delta === -1 && line) decLine(line);
      else return;
      this.scanFeedback = (delta > 0 ? '已增加「' : '已减少「') + (product?.name || line.name) + '」';
      this.scanTone = 'ok';
    },
    openScanner() {
      if (this.dockScanner) {
        const scanner = this.$refs.dockedScanner;
        if (scanner && !scanner.running && !scanner.starting) scanner.start();
        return;
      }
      this.cartOpen = false;
      this.scanFeedback = ''; this.scanTone = 'info'; this.scanning = true;
    },
    scanProduct(code) {
      const match = matchBarcode(store.db.products, code);
      if (match.state !== 'ok') { this.scanFeedback = match.message; this.scanTone = 'warn'; return; }
      addProduct(match.product);
      this.scanFeedback = '已加入「' + match.product.name + '」';
      this.scanTone = 'ok';
      this.scanSuccess++;
    },
    rootDomId(g) { return 'reg-root-' + g.key; },
    midDomId(g) { return 'reg-mid-' + g.key; },
    scrollHost() { return window.matchMedia('(min-width: 900px)').matches ? this.$refs.pickPane : window; },
    revealCategoryAnchors() {
      const rail = this.$refs.categoryRail;
      const selected = rail?.querySelector('[aria-current="location"]');
      if (!selected) return;
      const item = selected.getBoundingClientRect(), bounds = rail.getBoundingClientRect();
      if (item.top < bounds.top || item.bottom > bounds.bottom) {
        rail.scrollTo({ top: rail.scrollTop + item.top - bounds.top - (bounds.height - item.height) / 2, behavior: 'instant' });
      }
    },
    jumpCategory(g, mid) {
      const target = mid || g.mids[0];
      this._anchor = { root: g.key, mid: target.key, until: performance.now() + 1600 };
      this.activeRoot = g.key;
      this.activeMid = target.key;
      this.$nextTick(() => {
        this.refreshCategories();
        const el = document.getElementById(this.midDomId(target));
        if (!el) return;
        const host = this.scrollHost();
        const bar = this.$refs.pickBar;
        const toolbarBottom = (host === window ? 0 : host.getBoundingClientRect().top)
          + (parseFloat(getComputedStyle(bar).top) || 0) + bar.getBoundingClientRect().height;
        const y = (host === window ? window.scrollY : host.scrollTop) + el.getBoundingClientRect().top - toolbarBottom - 8;
        this._anchor.y = y;
        host.scrollTo({ top: y, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      });
    },
    refreshCategories() {
      const bar = this.$refs.pickBar;
      const height = bar.getBoundingClientRect().height;
      const threshold = bar.getBoundingClientRect().bottom + 8;
      this.$el.style.setProperty('--reg-toolbar-height', height + 'px');
      this.$el.style.setProperty('--reg-pane-height', this.scrollHost() === window ? window.innerHeight + 'px' : this.$refs.pickPane.clientHeight + 'px');
      const anchor = this._anchor;
      const scrollY = this.scrollHost() === window ? window.scrollY : this.$refs.pickPane.scrollTop;
      if (anchor && performance.now() < anchor.until && (anchor.y === undefined || Math.abs(scrollY - anchor.y) > 2)) return;
      this._anchor = null;
      let root = this.rootGroups[0]?.key || null;
      let mid = this.rootGroups[0]?.mids[0]?.key || null;
      for (const g of this.rootGroups) {
        const r = document.getElementById(this.rootDomId(g));
        if (r && r.getBoundingClientRect().top <= threshold + 1) {
          root = g.key;
          mid = g.mids[0]?.key || null;
        }
        for (const m of g.mids) {
          const el = document.getElementById(this.midDomId(m));
          if (el && el.getBoundingClientRect().top <= threshold + 1) { root = g.key; mid = m.key; }
        }
      }
      this.activeRoot = root;
      this.activeMid = mid;
    },
    money, moneyNum, num, r2, int,
    imageOf(p) { return productImageSrc(p); },
    addProduct(p) { addProduct(p); this.bump(); },
    decreaseProduct(p) {
      const line = this.cart.find(l => l.key === 'p' + p.id);
      if (line) decLine(line);
    },
    addCombo(c) {
      if (comboHasGroups(c)) { this.openComboPicker(c); return; }
      addCombo(c); this.bump();
    },
    openComboPicker(c) {
      this.comboPick = c;
      this.pickGroups = (c.groups || []).map(g => {
        const mid = store.db.categories.find(x => x.id === g.category_id);
        const root = mid && mid.parent_id ? store.db.categories.find(x => x.id === mid.parent_id) : null;
        return {
          category_id: g.category_id,
          label: (root ? root.name + ' / ' : '') + (mid ? mid.name : '未分类'),
          required: int(g.quantity),
          product_ids: Array.isArray(g.product_ids) ? [...g.product_ids] : [],
          items: []
        };
      });
    },
    closeComboPicker() { this.comboPick = null; this.pickGroups = []; },
    comboIsPickable(c) { return comboHasGroups(c); },
    pickerProducts(group) {
      let list = productsOnSale.value.filter(p =>
        categoryPath(store.db, p.category_id).some(c => c.id === group.category_id)
      );
      if (group.product_ids && group.product_ids.length) {
        const allowed = new Set(group.product_ids.map(Number));
        list = list.filter(p => allowed.has(p.id));
      }
      return list;
    },
    pickQty(group, product) {
      const item = group.items.find(x => x.product_id === product.id);
      return item ? item.quantity : 0;
    },
    pickGroupCount(group) {
      return group.items.reduce((t, x) => t + int(x.quantity), 0);
    },
    incPick(group, product) {
      if (this.pickGroupCount(group) >= group.required) {
        toast('「' + group.label + '」已经选够了', 'warn');
        return;
      }
      const item = group.items.find(x => x.product_id === product.id);
      if (item) item.quantity += 1;
      else group.items.push({ product_id: product.id, quantity: 1 });
    },
    clearPickGroup(group) { group.items = []; },
    pickAdd() {
      if (!this.comboPickReady) { toast('还有子套餐没选够件数', 'warn'); return; }
      const selections = this.pickGroups.map(group => ({
        category_id: group.category_id,
        items: group.items.map(item => ({ product_id: item.product_id, quantity: item.quantity }))
      }));
      addComboSelection(this.comboPick, selections);
      this.closeComboPicker();
      this.bump();
      toast('已加入本单', 'ok');
    },
    incLine, decLine, removeLine, toggleGift,
    onQty(l, e) { setLineQty(l, e.target.value); },
    selectLinePrice(e) {
      const input = e.target;
      input.select();
      // 等点击默认的光标定位结束后，再保持全选，方便手机直接输入替换。
      requestAnimationFrame(() => { if (document.activeElement === input) input.select(); });
    },
    onPrice(l, e) {
      const value = e.target.value.trim();
      if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(Number(value))) setLinePrice(l, value);
      else if (value) toast('请输入有效的非负价格');
      e.target.value = l.price;
    },
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
      return this.cart.filter(x => x.type === 'combo' && x.id === c.id)
        .reduce((t, x) => t + int(x.qty), 0);
    },
    comboPieces(c) {
      if (comboHasGroups(c)) return c.groups.reduce((t, g) => t + int(g.quantity), 0);
      return (c.items || []).reduce((t, it) => t + int(it.quantity), 0);
    },
    comboNames(c) {
      if (comboHasGroups(c)) {
        return c.groups.map(g => {
          const mid = store.db.categories.find(x => x.id === g.category_id);
          const root = mid && mid.parent_id ? store.db.categories.find(x => x.id === mid.parent_id) : null;
          const label = root ? root.name + '>' + mid.name : (mid ? mid.name : '?');
          return label + '×' + int(g.quantity);
        }).join(' + ');
      }
      return (c.items || []).map(it => {
        const p = productById(store.db, it.product_id);
        return (p ? p.name : '?') + '×' + int(it.quantity);
      }).join(' + ');
    },
    comboSelectionText(l) {
      if (!l.selections || !l.selections.length) {
        const c = comboById(store.db, l.id);
        return c ? this.comboNames(c) : '按套餐明细扣库存';
      }
      return l.selections.map(g => {
        const mid = store.db.categories.find(c => c.id === g.category_id);
        const root = mid && mid.parent_id ? store.db.categories.find(c => c.id === mid.parent_id) : null;
        const label = root ? root.name + '>' + mid.name : (mid ? mid.name : '未分类');
        const names = g.items.map(it => {
          const p = productById(store.db, it.product_id);
          return (p ? p.name : '?') + (int(it.quantity) > 1 ? '×' + int(it.quantity) : '');
        }).join('、');
        return label + '：' + names;
      }).join(' · ');
    },
    comboSelectionPieces(l) {
      if (!l.selections || !l.selections.length) {
        const c = comboById(store.db, l.id);
        return (c ? this.comboPieces(c) : 0) * int(l.qty);
      }
      return l.selections.reduce((t, g) =>
        t + (g.items || []).reduce((s, it) => s + int(it.quantity), 0), 0) * int(l.qty);
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
    clearSearch() {
      const editing = this.searchExpanded;
      this.reg.search = '';
      if (editing) this.$nextTick(() => this.$refs.productSearch?.focus({ preventScroll: true }));
    },
    doClear() { clearCart(); this.cartOpen = false; this.confirmClear = false; },
    async openPay() {
      if (!this.hasItems) return;
      this.scanning = false;
      this.cartOpen = false;
      await this.$nextTick();
      this.paying = true;
    },
    async onPaySubmit(payload) {
      this.submitting = true;
      const res = await actions.createOrder({
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
        items: d.items || [],
        adjustment: d.adjustment,
        alerts: d.alerts || []
      };
    },
    async hang() {
      if (!this.hasItems) return;
      const res = await actions.createOrder({ lines: cartToOrderLines(), note: this.note.trim() || null, settle: false });
      if (!res.ok) return;
      this.cartOpen = false;
      const d = res.data;
      clearCart();
      this.receipt = {
        order: d.order,
        items: d.items || [],
        adjustment: null,
        alerts: []
      };
    }
  },
  template: `
<div class="v-register">
  <ui-sheet v-if="tagPickerOpen" title="选择商品标签" @close="closeTagPicker">
    <div class="reg-tag-options" ref="tagOptions" role="group" aria-label="选择商品标签">
      <button class="reg-tag-option reg-tag-all" :aria-pressed="tag === 'all'" @click="selectTag('all')">
        <span class="reg-tag-name">全部标签</span>
        <ui-icon v-if="tag === 'all'" name="check" :size="18" />
      </button>
      <button v-for="t in tags" :key="t.name" class="reg-tag-option" :aria-pressed="tag === t.name" @click="selectTag(t.name)">
        <span class="reg-tag-name">{{ t.name }}</span>
        <span class="reg-tag-count">{{ t.count }} 款商品</span>
        <ui-icon v-if="tag === t.name" name="check" :size="18" />
      </button>
    </div>
  </ui-sheet>
  <ui-sheet v-if="scanning" title="扫码录入商品" @close="scanning = false">
    <ui-barcode-scanner :feedback="scanFeedback" :tone="scanTone" :success-key="scanSuccess" :items="scanItems" @scan="scanProduct" @change-quantity="changeScanQuantity" />
    <template #foot>
      <button class="btn" @click="scanning = false" aria-label="返回列表继续添加商品">返回列表</button>
      <button class="btn" :disabled="!hasItems" @click="openScanCart">修改价格</button>
      <button class="btn btn-primary grow" :disabled="!hasItems" @click="openPay">收款 {{ money(total) }}</button>
    </template>
  </ui-sheet>
  <div class="reg-layout">
    <!-- 选货 -->
    <section class="reg-pick" ref="pickPane" aria-label="选购商品">
      <div class="pick-bar" ref="pickBar">
        <div class="reg-mode-row" :class="{ 'is-products': pickTab === 'products', 'is-searching': compactTags && searchExpanded }">
          <div class="seg reg-modes" role="tablist" aria-label="选货类型">
            <button class="seg-btn" :class="{ 'is-on': pickTab === 'products' }" role="tab" :aria-selected="pickTab === 'products'" @click="pickTab = 'products'">商品</button>
            <button class="seg-btn" :class="{ 'is-on': pickTab === 'combos' }" role="tab" :aria-selected="pickTab === 'combos'" @click="pickTab = 'combos'">套餐</button>
          </div>
          <div v-if="pickTab === 'products'" class="reg-search-scan" @focusout="leaveSearch">
            <div class="input-search catalog-search" :class="{ 'has-query': !!reg.search }">
              <ui-icon name="search" :size="17" />
              <input ref="productSearch" class="input" v-model="reg.search" type="search" enterkeyhint="search"
                     :placeholder="compactTags ? '搜索' : '搜名称 / SKU / 分类 / 标签'" aria-label="搜索商品"
                     @focus="startSearch" @keydown.enter="finishSearch" @keydown.esc="finishSearch">
              <button v-if="reg.search" class="pick-clear" @click="clearSearch" aria-label="清空搜索">
                <ui-icon name="close" :size="15" />
              </button>
            </div>
            <button v-if="compactTags && searchExpanded" class="reg-search-done" @click="finishSearch">完成</button>
            <button v-if="dockScanner" class="btn btn-sm reg-scan-button" @click="openScanner" aria-label="扫码录入商品">扫码</button>
          </div>
          <button v-if="pickTab === 'products'" class="chip chip-freq reg-frequent" :class="{ 'is-on': reg.onlyFrequent }" :aria-pressed="reg.onlyFrequent"
                  @click="reg.onlyFrequent = !reg.onlyFrequent"><ui-icon name="spark" :size="14" /> 常卖</button>
          <button v-if="pickTab === 'products' && compactTags && tags.length" ref="tagToggle" class="chip reg-tag-toggle"
                  :class="{ 'is-on': tag !== 'all' }" :aria-expanded="tagPickerOpen" aria-haspopup="dialog"
                  :aria-label="'标签筛选，当前：' + (tag === 'all' ? '全部标签' : tag)"
                  :title="tag === 'all' ? '按标签筛选商品' : '当前标签：' + tag" @click="openTagPicker">
            <span>{{ tag === 'all' ? '标签' : tag }}</span><ui-icon name="chevronDown" :size="13" />
          </button>
        </div>
        <template v-if="pickTab === 'products' && !compactTags && tags.length">
        <div class="catalog-filter-row reg-filter-row">
        <div class="chips-scroll catalog-tags" v-if="tags.length" role="group" aria-label="商品标签筛选">
          <button class="chip" :class="{ 'is-on': tag === 'all' }" :aria-pressed="tag === 'all'" @click="tag = 'all'">全部标签</button>
          <button v-for="t in tags" :key="t.name" class="chip"
                  :class="{ 'chip-brand': tag === t.name }" :aria-pressed="tag === t.name"
                  @click="tag = t.name">#{{ t.name }}<span class="chip-count">{{ t.count }}</span></button>
        </div>
        </div>
        </template>
      </div>

      <div class="card" v-if="pickTab === 'combos' && combos.length">
        <div class="card-head"><h3><ui-icon name="layers" :size="16" /> 套餐</h3><span class="hint">点一下选品入单</span></div>
        <div class="card-body combo-list">
          <button v-for="c in combos" :key="c.id" class="combo-cell" :class="{ 'has-qty': comboInCart(c) }" @click="addCombo(c)">
            <span class="combo-badge" v-if="comboInCart(c)">{{ comboInCart(c) }}</span>
            <span class="combo-name">{{ c.name }}<i v-if="comboIsPickable(c)" class="tag tag-brand combo-self">自选</i></span>
            <span class="combo-parts">{{ comboNames(c) }}</span>
            <span class="combo-price">
              <b class="mono">{{ money(c.combo_price) }}</b>
              <s class="mono" v-if="c.original_price">{{ money(c.original_price) }}</s>
            </span>
          </button>
        </div>
      </div>

      <div v-if="pickTab === 'combos' && !combos.length" class="card"><div class="card-body">
        <ui-empty icon="layers" title="暂无在售套餐" text="可切回商品继续选购。" />
      </div></div>

      <template v-if="pickTab === 'products'">
      <div v-if="emptyCatalog" class="card"><div class="card-body">
        <ui-empty icon="products" title="还没有商品" text="先到「商品」页添加在售商品，或在「设置」里载入演示数据。">
          <button class="btn btn-primary" @click="store.ui.view = 'catalog'">去添加商品</button>
        </ui-empty>
      </div></div>

      <div v-else-if="!products.length" class="card"><div class="card-body">
        <ui-empty icon="search" title="没有匹配的商品" text="换个关键词、标签，或关闭「常卖」筛选。">
          <button class="btn" @click="reg.search = ''; reg.onlyFrequent = false; tag = 'all'">重置筛选</button>
        </ui-empty>
      </div></div>

      <template v-else>
        <div class="reg-browse">
          <nav class="cat-rail reg-category-rail" ref="categoryRail" aria-label="商品分类锚点">
            <div class="cat-rail-title">分类</div>
            <template v-for="g in rootGroups" :key="g.key">
              <button class="cat-rail-item cat-rail-root" :class="{ 'is-current': activeRoot === g.key }"
                      @click="jumpCategory(g)">
                <span class="cr-dot"></span><span class="cr-name">{{ g.name }}</span><span class="cr-count mono">{{ g.total }}</span>
              </button>
              <button v-for="m in g.mids" :key="m.key" class="cat-rail-item cat-rail-mid"
                      :class="{ 'is-active': activeMid === m.key }" :aria-current="activeMid === m.key ? 'location' : undefined"
                      @click="jumpCategory(g, m)">
                <span class="cr-subdot"></span><span class="cr-name">{{ m.name }}</span><span class="cr-count mono">{{ m.items.length }}</span>
              </button>
            </template>
          </nav>
          <div class="reg-products">
        <section v-for="g in rootGroups" :key="g.key" :id="rootDomId(g)" class="root-section">
          <div v-for="m in g.mids" :key="m.key" :id="midDomId(m)" class="prod-group">
            <h3 class="reg-group-label"><span>{{ g.name }}</span><span class="muted">/</span><b>{{ m.name }}</b><em>{{ m.items.length }}</em></h3>
        <div class="pick-grid">
          <article v-for="p in m.items" :key="p.id" class="pick-cell" :class="{ 'has-qty': inCart(p), 'is-low': stockLeft(p).low }">
            <button class="pick-product-main" @click="addProduct(p)" :aria-label="'加入 ' + p.name">
              <span class="pick-head">
                <span class="pick-thumb" :class="{ 'is-empty': !imageOf(p) }">
                  <img v-if="imageOf(p)" :src="imageOf(p)" alt="" loading="lazy" decoding="async">
                  <span v-else>{{ p.name.slice(0, 1) }}</span>
                </span>
                <span class="pick-figures">
                  <span class="pick-price mono">{{ money(p.list_price) }}</span>
                  <span class="pick-stock" :class="{ low: stockLeft(p).low }">{{ stockLeft(p).text }}</span>
                </span>
              </span>
              <span class="pick-name" :title="p.name">{{ p.name }}</span>
            </button>
            <div class="pick-quantity" v-if="inCart(p)">
              <button @click="decreaseProduct(p)" :aria-label="'减少 ' + p.name"><ui-icon name="minus" :size="14" /></button>
              <b class="mono" :aria-label="'已选 ' + inCart(p) + ' 件'">{{ inCart(p) }}</b>
              <button @click="addProduct(p)" :aria-label="'增加 ' + p.name"><ui-icon name="plus" :size="14" /></button>
            </div>
            <button v-else class="pick-add" @click="addProduct(p)" :aria-label="'增加 ' + p.name"><ui-icon name="plus" :size="15" /></button>
          </article>
        </div>
          </div>
        </section>
          </div>
        </div>
      </template>
      </template>
    </section>

    <!-- 购物车：桌面右侧常驻，移动端底部抽屉 -->
    <button v-if="cartOpen" class="reg-cart-backdrop" @click="cartOpen = false" aria-label="关闭本单遮罩"></button>
    <aside class="reg-cart" :class="{ 'is-open': cartOpen }" @keydown.esc="cartOpen = false">
      <div class="cart-panel">
        <section v-if="dockScanner" class="reg-scan-dock" aria-label="常驻扫码区">
          <div class="reg-scan-dock-head"><b>扫码选品</b><span>扫描后直接加入本单</span></div>
          <ui-barcode-scanner ref="dockedScanner" class="reg-dock-scanner" hide-summary
            :feedback="scanFeedback" :tone="scanTone" :success-key="scanSuccess" :items="scanItems"
            :active="!paying && !receipt && !comboPick && !confirmClear" @scan="scanProduct" @change-quantity="changeScanQuantity" />
        </section>
        <div class="cart-head">
          <h3><ui-icon name="register" :size="16" /> 本单</h3>
          <span class="mono small">{{ lines }} 行 · {{ pieces }} 件</span>
          <button class="btn btn-quiet btn-icon reg-cart-close" @click="cartOpen = false" aria-label="收起本单"><ui-icon name="close" :size="16" /></button>
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
            <div class="cl-combo-parts xs muted" v-if="l.type === 'combo'">{{ comboSelectionText(l) }}</div>
            <div class="cl-bottom">
              <label class="gift-check" v-if="l.type === 'product'">
                <input type="checkbox" :checked="l.gift" @change="toggleGift(l)">
                <span class="switch-track" aria-hidden="true"></span>
                <span class="xs">送出去</span>
              </label>
              <span v-else class="xs muted">共 {{ comboSelectionPieces(l) }} 件</span>
              <div class="cl-right">
                <span class="cl-price">
                  <i>¥</i><input class="input input-mono cl-price-input" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off" spellcheck="false"
                                 :value="l.price" :disabled="l.gift" @focus="selectLinePrice" @click="selectLinePrice" @keydown.enter="$event.target.blur()" @change="onPrice(l, $event)" :aria-label="l.name + ' 单价'">
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
          <ui-empty icon="register" title="还没选货" text="点商品加入本单，也可切换套餐选购。" />
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
  <div class="cart-bar" ref="cartBar" v-if="!cartOpen">
    <button class="cart-summary" @click="cartOpen = true" :disabled="!hasItems" aria-label="查看本单">
      <span class="cart-bar-count mono">{{ pieces }}</span>
      <span class="cart-bar-text"><b class="mono">{{ money(total) }}</b><em>{{ hasItems ? '查看本单 · ' + lines + ' 行商品' : '点商品开始选购' }}</em></span>
      <ui-icon name="chevronUp" :size="15" v-if="hasItems" />
    </button>
    <button class="btn btn-primary cart-direct-pay" :disabled="!hasItems" @click="openPay">收款</button>
    <button class="btn cart-direct-scan" @click="openScanner" aria-label="扫码录入商品">扫码</button>
  </div>

  <!-- 自选套餐：按子套餐中类现场选品 -->
  <ui-sheet v-if="comboPick" wide :title="comboPick.name"
            :subtitle="money(comboPick.combo_price) + ' · 共选 ' + comboPieces(comboPick) + ' 件'"
            @close="closeComboPicker">
    <div class="cp-intro">从每个中类里选够对应件数，再点击加入本单。同一商品可以选多件。</div>
    <section class="cp-group" v-for="group in pickGroups" :key="group.category_id">
      <header class="cp-head">
        <div class="grow">
          <b>{{ group.label }}</b>
          <span class="xs muted">需选 {{ group.required }} 件</span>
        </div>
        <span class="cp-count" :class="{ 'is-ok': pickGroupCount(group) === group.required }">
          {{ pickGroupCount(group) }} / {{ group.required }}
        </span>
        <button v-if="group.items.length" class="btn btn-sm btn-quiet" @click="clearPickGroup(group)">清空</button>
      </header>
      <div class="cp-products" v-if="pickerProducts(group).length">
        <button v-for="p in pickerProducts(group)" :key="p.id" class="cp-product"
                :class="{ 'has-qty': pickQty(group, p) > 0 }"
                @click="incPick(group, p)" :aria-label="'选择 ' + p.name">
          <span class="cp-name">{{ p.name }}</span>
          <span class="cp-meta xs muted">{{ stockLeft(p).text }}</span>
          <span class="cp-badge mono" v-if="pickQty(group, p)">{{ pickQty(group, p) }}</span>
        </button>
      </div>
      <div class="empty-inline" v-else>这个中类暂时没有在售商品</div>
    </section>
    <template #foot>
      <button class="btn" @click="closeComboPicker">取消</button>
      <button class="btn btn-primary grow" :disabled="!comboPickReady" @click="pickAdd">
        加入本单 {{ money(comboPick.combo_price) }}
      </button>
    </template>
  </ui-sheet>

  <ui-pay-sheet v-if="paying" :total="total" :pieces="pieces" :submitting="submitting"
                title="收款" @close="paying = false" @submit="onPaySubmit" />

  <ui-receipt v-if="receipt" :result="receipt"
              @close="receipt = null" @again="receipt = null"
              @go-orders="receipt = null; store.ui.view = 'orders'" />

  <ui-confirm v-if="confirmClear" title="清空本单？" text="已选的商品会全部移除，不影响历史订单。"
              confirm-text="清空" danger @yes="doClear" @no="confirmClear = false" />
</div>`
};
