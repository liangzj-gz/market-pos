/* 商品与套餐：两级分类 + 自定义标签，分类和标签都由用户自己维护 */
import {
  store, actions, stockState, productById, toast,
  rootCategories, categoryRows, tagLibrary, childrenIn, categoryProductCount
} from '../data/store.js';
import { money } from '../util/format.js';
import { UiSheet } from '../components/index.js';

const EMPTY_PRODUCT = () => ({
  id: null, sku_code: '', name: '', cat1: '', cat2: '',
  list_price: '', cost_price: '', safety_stock: 0, location: '', barcode: '',
  status: 'on_sale', tags: [], tagInput: ''
});

export const CatalogView = {
  name: 'CatalogView',
  components: { UiSheet },
  data() {
    return {
      tab: 'products',
      search: '',
      tag: 'all',
      activeRoot: null,
      activeMid: null,
      condensed: false,
      prodForm: null,
      comboTarget: null,
      confirmDelete: null,
      saving: false,
      /* 分类 / 标签管理 */
      catManager: false,
      catTab: 'categories',
      catPath: [],            // 当前选中的分类链路，三栏与钻取共用
      catEditing: false,      // 窄屏列表的编辑态
      catEdit: null,          // { id: null|number, parentId, name, depth }
      tagEdit: null,          // { from, name }
      newTag: '',
      confirmCatDelete: null,
      confirmTagDelete: null
    };
  },
  computed: {
    store() { return store; },
    allProducts() { return store.db.products; },
    rootCats() { return rootCategories.value; },
    tags() { return tagLibrary.value; },
    catTotal() { return categoryRows.value.length; },
    products() {
      const kw = this.search.trim().toLowerCase();
      return store.db.products.filter(p => {
        if (this.tag !== 'all' && !(p.tags || []).includes(this.tag)) return false;
        if (!kw) return true;
        const hay = [
          p.name, p.sku_code, p.location,
          this.catPathText(p),
          (p.tags || []).join(' ')
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(kw);
      }).sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.status === 'on_sale' ? -1 : 1));
    },
    rootGroups() {
      const rootOrder = new Map(this.rootCats.map((c, i) => [c.id, i]));
      const midOrder = new Map();
      this.rootCats.forEach(r => childrenIn(r.id).forEach((c, i) => midOrder.set(c.id, i)));
      const roots = new Map();
      for (const p of this.products) {
        const path = this.pathArr(p.category_id);
        const root = path[0] || null;
        const mid = path[1] || null;
        const rootKey = root ? root.id : 'none';
        let group = roots.get(rootKey);
        if (!group) {
          group = {
            key: String(rootKey), id: root ? root.id : null,
            name: root ? root.name : '未分类', total: 0, mids: new Map()
          };
          roots.set(rootKey, group);
        }
        group.total += 1;
        const midKey = mid ? mid.id : 'none';
        let sub = group.mids.get(midKey);
        if (!sub) {
          sub = {
            key: String(rootKey) + '-' + String(midKey), id: mid ? mid.id : null,
            name: mid ? mid.name : (root ? '未细分' : '未分类'), items: []
          };
          group.mids.set(midKey, sub);
        }
        sub.items.push(p);
      }
      const list = Array.from(roots.values()).map(group => ({ ...group, mids: Array.from(group.mids.values()) }));
      list.forEach(group => group.mids.sort((a, b) => {
        if (a.id === null) return 1;
        if (b.id === null) return -1;
        return (midOrder.get(a.id) ?? 999) - (midOrder.get(b.id) ?? 999);
      }));
      list.sort((a, b) => {
        if (a.id === null) return 1;
        if (b.id === null) return -1;
        return (rootOrder.get(a.id) ?? 999) - (rootOrder.get(b.id) ?? 999);
      });
      return list;
    },
    combos() { return store.db.combos; },
    stats() {
      return {
        total: this.allProducts.length,
        combos: store.db.combos.length
      };
    },
    /* 分类管理：桌面上两栏联动，手机上按 breadcrumb 逐层钻取 */
    breadcrumb() {
      return this.catPath.map(id => store.db.categories.find(c => c.id === id)).filter(Boolean);
    },
    col1() { return this.deco(childrenIn(null)); },
    col2() { return this.catPath[0] ? this.deco(childrenIn(this.catPath[0])) : []; },
    columns() { return [this.col1, this.col2]; },
    drillList() {
      const parent = this.catPath.length ? this.catPath[this.catPath.length - 1] : null;
      return this.deco(childrenIn(parent));
    },
    cat2Options() { return this.prodForm && this.prodForm.cat1 ? childrenIn(this.prodForm.cat1) : []; },
    suggestedTags() {
      if (!this.prodForm) return [];
      return this.tags.map(t => t.name).filter(n => !this.prodForm.tags.includes(n)).slice(0, 6);
    },
    comboFormValid() {
      return this.comboTarget && this.comboTarget.name.trim() && this.comboTarget.items.some(i => i.product_id);
    },
    activeRootGroup() {
      return this.rootGroups.find(g => g.key === this.activeRoot) || null;
    },
    activeRootMids() {
      return this.activeRootGroup ? this.activeRootGroup.mids : [];
    }
  },
  watch: {
    rootGroups() { this.$nextTick(this.updateActiveRoot); },
    tab() { this.$nextTick(this.updateActiveRoot); }
  },
  mounted() {
    this._onScroll = () => {
      if (this._scrollRaf) return;
      this._scrollRaf = requestAnimationFrame(() => {
        this._scrollRaf = null;
        this.updateCondensed();
        this.updateActiveRoot();
      });
    };
    window.addEventListener('scroll', this._onScroll, { passive: true });
    this.$nextTick(() => {
      this.updateCondensed();
      this.updateActiveRoot();
    });
  },
  beforeUnmount() {
    window.removeEventListener('scroll', this._onScroll);
    if (this._scrollRaf) cancelAnimationFrame(this._scrollRaf);
  },
  methods: {
    money,
    stockOf(id) { return stockState(id); },
    pathArr(categoryId) {
      const out = [];
      let cur = store.db.categories.find(c => c.id === categoryId);
      for (let guard = 0; cur && guard < 8; guard++) {
        out.unshift(cur);
        cur = store.db.categories.find(c => c.id === cur.parent_id);
      }
      return out;
    },
    catPathText(p) {
      const path = this.pathArr(p.category_id);
      if (path.length) return path.map(c => c.name).join(' / ');
      return [p.category, p.series].filter(Boolean).join(' / ');
    },
    subCatOf(p) {
      const path = this.pathArr(p.category_id).slice(1).map(c => c.name);
      const sub = path.filter((n, i) => n !== path[i - 1]).join(' / ');
      return sub || (p.category_id ? '未细分' : '未分类');
    },
    rootDomId(group) { return 'cat-root-' + group.key; },
    midDomId(sub) { return 'cat-mid-' + sub.key; },
    jumpToRoot(group) {
      this.condensed = true;
      this.activeRoot = group.key;
      this.activeMid = null;
      this.$nextTick(() => {
        const el = document.getElementById(this.rootDomId(group));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    jumpToMid(group, sub) {
      this.condensed = true;
      this.activeRoot = group.key;
      this.activeMid = sub.key;
      this.$nextTick(() => {
        const el = document.getElementById(this.midDomId(sub));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },
    updateCondensed() {
      const y = window.scrollY;
      if (!this.condensed && y > 24) this.condensed = true;
      else if (this.condensed && y < 8) this.condensed = false;
    },
    updateActiveRoot() {
      if (this.tab !== 'products') return;
      const groups = this.rootGroups;
      if (!groups.length) { this.activeRoot = null; this.activeMid = null; return; }
      let currentRoot = groups[0].key;
      let currentMid = null;
      for (const group of groups) {
        const rootEl = document.getElementById(this.rootDomId(group));
        if (rootEl && rootEl.getBoundingClientRect().top <= 140) currentRoot = group.key;
        for (const sub of group.mids) {
          const midEl = document.getElementById(this.midDomId(sub));
          if (midEl && midEl.getBoundingClientRect().top <= 140) {
            currentRoot = group.key;
            currentMid = sub.key;
          }
        }
      }
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      if (maxScroll - window.scrollY <= 80) {
        const last = groups[groups.length - 1];
        currentRoot = last.key;
        currentMid = last.mids.length ? last.mids[last.mids.length - 1].key : null;
      }
      if (this.activeRoot !== currentRoot) this.activeRoot = currentRoot;
      if (this.activeMid !== currentMid) this.activeMid = currentMid;
    },

    /* ---------- 商品表单 ---------- */
    openNew() {
      this.prodForm = EMPTY_PRODUCT();
    },
    openEdit(p) {
      const path = this.pathArr(p.category_id);
      this.prodForm = {
        id: p.id, sku_code: p.sku_code, name: p.name,
        cat1: path[0] ? path[0].id : '',
        cat2: path[1] ? path[1].id : '',
        list_price: p.list_price,
        cost_price: p.cost_price === null || p.cost_price === undefined ? '' : p.cost_price,
        safety_stock: p.safety_stock, location: p.location || '', barcode: p.barcode || '',
        status: p.status, tags: [...(p.tags || [])], tagInput: ''
      };
    },
    onCat1() { this.prodForm.cat2 = ''; },
    addFormTag() {
      const v = String(this.prodForm.tagInput || '').trim().replace(/^#/, '');
      this.prodForm.tagInput = '';
      if (!v) return;
      if (v.length > 10) { toast('标签控制在 10 个字以内', 'warn'); return; }
      if (!this.prodForm.tags.includes(v)) this.prodForm.tags.push(v);
    },
    addFormTagName(t) { if (!this.prodForm.tags.includes(t)) this.prodForm.tags.push(t); },
    removeFormTag(t) { this.prodForm.tags = this.prodForm.tags.filter(x => x !== t); },
    saveProduct() {
      const f = this.prodForm;
      this.saving = true;
      const res = actions.saveProduct({
        ...f,
        category_id: f.cat2 || f.cat1 || null,
        tags: f.tags
      });
      this.saving = false;
      if (res.ok) this.prodForm = null;
    },
    toggle(p) { actions.toggleProduct(p.id); },

    /* ---------- 分类管理 ---------- */
    openCatManager() {
      this.catManager = true;
      this.catTab = 'categories';
      this.catPath = [];
      this.catEditing = false;
      this.catEdit = null;
      this.tagEdit = null;
      this.newTag = '';
    },
    deco(list) {
      return list.map(c => ({
        ...c,
        count: categoryProductCount(store.db, c.id),
        hasChildren: childrenIn(c.id).length > 0
      }));
    },
    pick(depth, id) { this.catPath = [...this.catPath.slice(0, depth), id]; },
    parentAt(depth) { return depth === 0 ? null : (this.catPath[depth - 1] || null); },
    canAdd(depth) { return depth < 2 && (depth === 0 || !!this.parentAt(depth)); },
    addIn(depth) {
      if (!this.canAdd(depth)) return;
      this.catEdit = { id: null, parentId: this.parentAt(depth), name: '', depth };
    },
    renameNode(c) { this.catEdit = { id: c.id, parentId: c.parent_id, name: c.name, depth: 0 }; },
    renameSel(depth) {
      const id = this.catPath[depth];
      const c = id ? store.db.categories.find(x => x.id === id) : null;
      if (c) this.renameNode(c);
    },
    askDeleteNode(c) { this.confirmCatDelete = c; },
    askDeleteSel(depth) {
      const id = this.catPath[depth];
      const c = id ? store.db.categories.find(x => x.id === id) : null;
      if (c) this.confirmCatDelete = { ...c, count: categoryProductCount(store.db, c.id) };
    },
    saveCatEdit() {
      if (!this.catEdit || !this.catEdit.name.trim()) return;
      const res = actions.saveCategory({
        id: this.catEdit.id, parent_id: this.catEdit.parentId, name: this.catEdit.name
      });
      if (res.ok) this.catEdit = null;
    },
    doDeleteCategory() {
      actions.removeCategory(this.confirmCatDelete.id);
      this.confirmCatDelete = null;
      /* 被删节点及更深层的选中状态一并收回 */
      const valid = [];
      for (const id of this.catPath) {
        if (!store.db.categories.find(x => x.id === id)) break;
        valid.push(id);
      }
      this.catPath = valid;
    },
    createTag() {
      const v = String(this.newTag || '').trim();
      if (!v) return;
      const res = actions.addTag(v);
      if (res.ok) this.newTag = '';
    },
    startEditTag(t) { this.tagEdit = { from: t.name, name: t.name }; },
    saveTagEdit() {
      if (!this.tagEdit || !this.tagEdit.name.trim()) return;
      const res = actions.renameTag(this.tagEdit.from, this.tagEdit.name);
      if (res.ok) this.tagEdit = null;
    },
    askDeleteTag(t) { this.confirmTagDelete = t; },
    doDeleteTag() {
      actions.removeTag(this.confirmTagDelete.name);
      this.confirmTagDelete = null;
    },

    /* ---------- 套餐 ---------- */
    openNewCombo() {
      this.comboTarget = { id: null, name: '', combo_price: '', original_price: '', status: 'on_sale', items: [{ product_id: '', quantity: 1 }] };
    },
    openEditCombo(c) {
      this.comboTarget = {
        id: c.id, name: c.name, combo_price: c.combo_price,
        original_price: c.original_price === null ? '' : c.original_price,
        status: c.status,
        items: (c.items || []).map(i => ({ product_id: i.product_id, quantity: i.quantity }))
      };
    },
    addRow() { this.comboTarget.items.push({ product_id: '', quantity: 1 }); },
    removeRow(i) { this.comboTarget.items.splice(i, 1); },
    saveCombo() {
      this.saving = true;
      const res = actions.saveCombo(this.comboTarget);
      this.saving = false;
      if (res.ok) this.comboTarget = null;
    },
    askDelete(c) { this.confirmDelete = c; },
    doDelete() {
      actions.deleteCombo(this.confirmDelete.id);
      this.confirmDelete = null;
    },
    comboParts(c) {
      return (c.items || []).map(i => {
        const p = productById(store.db, i.product_id);
        return (p ? p.name : '?') + '×' + i.quantity;
      }).join(' + ');
    },
    comboValue(c) {
      return (c.items || []).reduce((t, i) => {
        const p = productById(store.db, i.product_id);
        return t + (p ? Number(p.list_price) * Number(i.quantity) : 0);
      }, 0);
    }
  },
  template: `
<div class="v-catalog">
  <div class="catalog-sticky" :class="{ 'is-condensed': condensed }">
  <div class="page-head row-between catalog-head">
    <div class="seg catalog-seg" role="tablist">
      <button class="seg-btn" :class="{ 'is-on': tab === 'products' }" role="tab" :aria-selected="tab === 'products'"
              @click="tab = 'products'">商品 <span class="mono">{{ stats.total }}</span></button>
      <button class="seg-btn" :class="{ 'is-on': tab === 'combos' }" role="tab" :aria-selected="tab === 'combos'"
              @click="tab = 'combos'">套餐 <span class="mono">{{ stats.combos }}</span></button>
    </div>
    <div class="row" style="gap:8px">
      <button class="btn btn-icon" @click="openCatManager" aria-label="管理分类与标签" title="管理分类与标签">
        <ui-icon name="settings" :size="18" />
      </button>
      <button class="btn btn-primary" @click="tab === 'products' ? openNew() : openNewCombo()">
        <ui-icon name="plus" :size="17" /> {{ tab === 'products' ? '新增商品' : '新增套餐' }}
      </button>
    </div>
  </div>

  <div class="card filter-card catalog-filter-card" v-if="tab === 'products'">
    <div class="card-body">
      <div class="catalog-filter-row">
        <div class="input-search catalog-search">
          <ui-icon name="search" :size="17" />
          <input class="input" v-model="search" type="search" placeholder="搜名称 / SKU / 分类 / 标签 / 货位" aria-label="搜索商品">
        </div>
        <div class="chips-scroll catalog-tags" v-if="tags.length">
          <button class="chip" :class="{ 'is-on': tag === 'all' }" :aria-pressed="tag === 'all'" @click="tag = 'all'">全部标签</button>
          <button v-for="t in tags" :key="t.name" class="chip"
                  :class="{ 'chip-brand': tag === t.name }" :aria-pressed="tag === t.name"
                  @click="tag = t.name">#{{ t.name }}<span class="chip-count">{{ t.count }}</span></button>
        </div>
      </div>
    </div>
  </div>
  </div>

  <!-- 商品 -->
  <template v-if="tab === 'products'">
    <div class="catalog-layout" v-if="products.length">
      <nav class="cat-rail" aria-label="商品分类">
        <div class="cat-rail-title">分类</div>
        <template v-for="g in rootGroups" :key="g.key">
          <button class="cat-rail-item cat-rail-root"
                  :class="{ 'is-active': activeRoot === g.key && !activeMid, 'is-current': activeRoot === g.key && activeMid }"
                  @click="jumpToRoot(g)">
            <span class="cr-dot"></span>
            <span class="cr-name">{{ g.name }}</span>
            <span class="cr-count mono">{{ g.total }}</span>
          </button>
          <button v-for="mg in g.mids" :key="mg.key" class="cat-rail-item cat-rail-mid"
                  :class="{ 'is-active': activeMid === mg.key }" @click="jumpToMid(g, mg)">
            <span class="cr-subdot"></span>
            <span class="cr-name">{{ mg.name }}</span>
            <span class="cr-count mono">{{ mg.items.length }}</span>
          </button>
        </template>
      </nav>

      <div class="catalog-main">
        <nav class="cat-rail-mobile" aria-label="商品分类">
          <div class="cat-rail-mobile-row">
            <button v-for="g in rootGroups" :key="g.key" class="chip chip-brand"
                    :class="{ 'is-on': activeRoot === g.key }" @click="jumpToRoot(g)">
              {{ g.name }}<span class="chip-count">{{ g.total }}</span>
            </button>
          </div>
          <div class="cat-rail-mobile-row crm-mids" v-if="activeRootMids.length">
            <button v-for="mg in activeRootMids" :key="mg.key" class="crm-mid"
                    :class="{ 'is-on': activeMid === mg.key }" @click="jumpToMid(activeRootGroup, mg)">
              {{ mg.name }}<span>{{ mg.items.length }}</span>
            </button>
          </div>
        </nav>

        <section v-for="g in rootGroups" :key="g.key" :id="rootDomId(g)" class="root-section">
          <div class="root-head">
            <span class="root-bar"></span>
            <span class="root-name">{{ g.name }}</span>
            <span class="root-count mono">{{ g.total }}</span>
          </div>
          <div class="prod-group" v-for="mg in g.mids" :key="mg.key" :id="midDomId(mg)">
            <div class="pg-head">
              <span class="pg-dot"></span>
              <span class="pg-name">{{ mg.name }}</span>
              <span class="pg-count mono">{{ mg.items.length }}</span>
              <span class="pg-rule"></span>
            </div>
            <div class="prod-grid">
              <article class="prod-cell" v-for="p in mg.items" :key="p.id" :class="{ 'is-off': p.status === 'off_sale' }">
                <button class="pc-open" @click="openEdit(p)" :aria-label="'编辑商品 ' + p.name">
                  <span class="pc-top">
                    <span class="pc-sku mono">{{ p.sku_code }}</span>
                    <span class="tag tag-gray" v-if="p.status === 'off_sale'">停售</span>
                  </span>
                  <span class="pc-name" :title="p.name">{{ p.name }}</span>
                  <span class="pc-sub xs muted">
                    <span class="truncate">{{ subCatOf(p) }}</span>
                    <span class="nowrap" v-if="p.location">· {{ p.location }}</span>
                  </span>
                  <span class="pc-tags" v-if="(p.tags || []).length">
                    <span v-for="t in p.tags.slice(0, 2)" :key="t" class="tag tag-brand pc-tag">#{{ t }}</span>
                    <span v-if="p.tags.length > 2" class="pc-more muted">+{{ p.tags.length - 2 }}</span>
                  </span>
                </button>
                <div class="pc-foot">
                  <b class="pc-price mono" :title="p.cost_price !== null && p.cost_price !== undefined ? '成本 ' + money(p.cost_price) : ''">{{ money(p.list_price) }}</b>
                  <span class="pc-stock xs" :class="'is-' + stockOf(p.id).state"
                        :title="p.safety_stock > 0 ? '安全库存阈值 ' + p.safety_stock : ''">
                    <span class="pc-stock-dot"></span>
                    余 {{ stockOf(p.id).known ? stockOf(p.id).qty : '—' }}
                  </span>
                  <button class="btn btn-sm btn-quiet pc-toggle" @click="toggle(p)"
                          :aria-label="(p.status === 'on_sale' ? '下架 ' : '上架 ') + p.name">{{ p.status === 'on_sale' ? '下架' : '上架' }}</button>
                </div>
              </article>
            </div>
          </div>
        </section>
      </div>
    </div>
    <div class="card" v-else><div class="card-body">
      <ui-empty icon="products" title="没有符合条件的商品" text="换个标签或搜索词，也可以新增一个。">
        <button class="btn btn-primary" @click="openNew">新增商品</button>
      </ui-empty>
    </div></div>
  </template>

  <!-- 套餐 -->
  <template v-else>
    <div class="combo-cards" v-if="combos.length">
      <div class="combo-card" v-for="c in combos" :key="c.id" :class="{ 'is-off': c.status === 'off_sale' }">
        <div class="cc-head">
          <div class="grow">
            <div class="cc-name">{{ c.name }}
              <span class="tag tag-gray" v-if="c.status === 'off_sale'">停售</span>
            </div>
            <div class="cc-parts xs muted">{{ comboParts(c) }}</div>
          </div>
          <div class="cc-price">
            <b class="mono">{{ money(c.combo_price) }}</b>
            <s class="mono xs" v-if="c.original_price">{{ money(c.original_price) }}</s>
          </div>
        </div>
        <div class="cc-meta">
          <span class="xs muted">单点合计 <b class="mono">{{ money(comboValue(c)) }}</b></span>
          <span class="xs" v-if="c.original_price && comboValue(c) > 0">
            <span class="tag tag-ok">约 {{ Math.round(Number(c.combo_price) / comboValue(c) * 100) }} 折</span>
          </span>
          <span class="grow"></span>
          <button class="btn btn-sm" @click="openEditCombo(c)">编辑</button>
          <button class="btn btn-sm btn-danger" @click="askDelete(c)">删除</button>
        </div>
      </div>
    </div>
    <div class="card" v-else><div class="card-body">
      <ui-empty icon="layers" title="还没有套餐" text="把常一起卖的商品打包成套餐，录单时点一下整套入单。">
        <button class="btn btn-primary" @click="openNewCombo">新增套餐</button>
      </ui-empty>
    </div></div>
  </template>

  <!-- 商品表单 -->
  <ui-sheet v-if="prodForm" :title="prodForm.id ? '编辑商品' : '新增商品'" @close="prodForm = null">
    <div class="form-grid">
      <div class="field span-2">
        <label>商品名称 *</label>
        <input class="input" v-model="prodForm.name" placeholder="可以带逗号，不用怕解析错" autofocus>
      </div>

      <div class="field span-2">
        <label>分类</label>
        <div class="cat-picker">
          <select class="select" v-model="prodForm.cat1" @change="onCat1" aria-label="大类">
            <option value="">未分类</option>
            <option v-for="c in rootCats" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <select class="select" v-model="prodForm.cat2" :disabled="!prodForm.cat1" aria-label="中类">
            <option value="">不选中类</option>
            <option v-for="c in cat2Options" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>
        <div class="field-hint">商品挂在最后选中的一级；分类不够用就到「管理分类」里加</div>
      </div>

      <div class="field span-2">
        <label>标签</label>
        <div class="tag-editor">
          <span class="tag tag-brand tag-removable" v-for="t in prodForm.tags" :key="t">
            #{{ t }}<button type="button" @click="removeFormTag(t)" :aria-label="'移除标签 ' + t">×</button>
          </span>
          <input class="tag-input" v-model="prodForm.tagInput" placeholder="输入标签后回车"
                 @keydown.enter.prevent="addFormTag" aria-label="添加标签">
        </div>
        <div class="field-hint tag-suggests" v-if="suggestedTags.length">
          常用：
          <button type="button" v-for="t in suggestedTags" :key="t" class="tag-suggest" @click="addFormTagName(t)">#{{ t }}</button>
        </div>
      </div>

      <div class="field">
        <label>售价 *</label>
        <input class="input input-mono" type="number" inputmode="decimal" step="0.01" v-model="prodForm.list_price">
      </div>
      <div class="field">
        <label>成本价</label>
        <input class="input input-mono" type="number" inputmode="decimal" step="0.01" v-model="prodForm.cost_price" placeholder="选填，算毛利用">
      </div>
      <div class="field">
        <label>安全库存阈值</label>
        <input class="input input-mono" type="number" inputmode="numeric" min="0" v-model="prodForm.safety_stock">
        <div class="field-hint">低于或等于这个数就触发预警，填 0 表示不预警</div>
      </div>
      <div class="field">
        <label>货位</label>
        <input class="input" v-model="prodForm.location" placeholder="如 A-1 / 9-4">
      </div>
      <div class="field">
        <label>SKU 编码</label>
        <input class="input input-mono" v-model="prodForm.sku_code" placeholder="留空自动生成">
      </div>
      <div class="field">
        <label>状态</label>
        <select class="select" v-model="prodForm.status">
          <option value="on_sale">在售</option>
          <option value="off_sale">停售</option>
        </select>
      </div>
    </div>
    <template #foot>
      <button class="btn" @click="prodForm = null" :disabled="saving">取消</button>
      <button class="btn btn-primary grow" @click="saveProduct" :disabled="saving || !prodForm.name.trim()">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </ui-sheet>

  <!-- 套餐表单 -->
  <ui-sheet v-if="comboTarget" :title="comboTarget.id ? '编辑套餐' : '新增套餐'" @close="comboTarget = null">
    <div class="form-grid">
      <div class="field span-2">
        <label>套餐名称 *</label>
        <input class="input" v-model="comboTarget.name" placeholder="如 十一套餐">
      </div>
      <div class="field">
        <label>套餐价 *</label>
        <input class="input input-mono" type="number" inputmode="decimal" step="0.01" v-model="comboTarget.combo_price">
      </div>
      <div class="field">
        <label>原价（划线价）</label>
        <input class="input input-mono" type="number" inputmode="decimal" step="0.01" v-model="comboTarget.original_price" placeholder="选填">
      </div>
    </div>

    <div class="field">
      <label>套餐明细 *</label>
      <div class="cie-list">
        <div class="cie-row" v-for="(it, i) in comboTarget.items" :key="i">
          <select class="select grow" v-model.number="it.product_id" :aria-label="'第 ' + (i + 1) + ' 项商品'">
            <option :value="''" disabled>选择商品</option>
            <option v-for="p in allProducts" :key="p.id" :value="p.id">{{ p.name }}（{{ money(p.list_price) }}）</option>
          </select>
          <input class="input input-mono cie-qty" type="number" inputmode="numeric" min="1" v-model.number="it.quantity" aria-label="数量">
          <button class="btn btn-quiet btn-icon btn-sm" @click="removeRow(i)" :disabled="comboTarget.items.length === 1" aria-label="删除该行">
            <ui-icon name="close" :size="15" />
          </button>
        </div>
      </div>
      <button class="btn btn-sm" style="margin-top:8px" @click="addRow"><ui-icon name="plus" :size="14" /> 加一项</button>
    </div>

    <div class="field">
      <label>状态</label>
      <select class="select" v-model="comboTarget.status">
        <option value="on_sale">在售</option>
        <option value="off_sale">停售</option>
      </select>
    </div>

    <template #foot>
      <button class="btn" @click="comboTarget = null" :disabled="saving">取消</button>
      <button class="btn btn-primary grow" @click="saveCombo" :disabled="saving || !comboFormValid">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </ui-sheet>

  <!-- 分类 / 标签管理 -->
  <ui-sheet v-if="catManager" title="分类与标签" wide @close="catManager = false">
    <div class="seg" role="tablist">
      <button class="seg-btn" :class="{ 'is-on': catTab === 'categories' }" role="tab" :aria-selected="catTab === 'categories'"
              @click="catTab = 'categories'">分类 <span class="mono">{{ catTotal }}</span></button>
      <button class="seg-btn" :class="{ 'is-on': catTab === 'tags' }" role="tab" :aria-selected="catTab === 'tags'"
              @click="catTab = 'tags'">标签 <span class="mono">{{ tags.length }}</span></button>
    </div>

    <template v-if="catTab === 'categories'">
      <!-- 大屏：三栏联动 -->
      <div class="cat-cols">
        <section class="cat-col" v-for="(col, ci) in columns" :key="ci">
          <header class="cat-col-head">
            <span>{{ ['大类', '中类'][ci] }}</span>
            <em class="mono">{{ col.length }}</em>
          </header>
          <div class="cat-col-list">
            <template v-for="c in col" :key="c.id">
              <div v-if="catEdit && catEdit.id === c.id" class="cat-edit-row">
                <input class="input cat-input" v-model="catEdit.name" placeholder="分类名称"
                       @keydown.enter.prevent="saveCatEdit" @keydown.esc="catEdit = null" autofocus>
                <button class="btn btn-sm btn-primary" @click="saveCatEdit" :disabled="!catEdit.name.trim()">保存</button>
                <button class="btn btn-sm btn-quiet" @click="catEdit = null" aria-label="取消">
                  <ui-icon name="close" :size="14" />
                </button>
              </div>
              <button v-else class="cat-item" :class="{ 'is-selected': catPath[ci] === c.id }"
                      @click="pick(ci, c.id)">
                <span class="cat-dot" :class="'lv' + (ci + 1)"></span>
                <span class="cat-name">{{ c.name }}</span>
                <span class="cat-count mono">{{ c.count }}</span>
                <ui-icon v-if="c.hasChildren" name="chevronRight" :size="13" class="cat-chev" />
              </button>
            </template>

            <div v-if="catEdit && catEdit.id === null && catEdit.depth === ci" class="cat-edit-row">
              <input class="input cat-input" v-model="catEdit.name" placeholder="分类名称"
                     @keydown.enter.prevent="saveCatEdit" @keydown.esc="catEdit = null" autofocus>
              <button class="btn btn-sm btn-primary" @click="saveCatEdit" :disabled="!catEdit.name.trim()">保存</button>
              <button class="btn btn-sm btn-quiet" @click="catEdit = null" aria-label="取消">
                <ui-icon name="close" :size="14" />
              </button>
            </div>

            <div class="empty-inline" v-if="!col.length && !(catEdit && catEdit.id === null && catEdit.depth === ci)">
              {{ ci === 0 ? '还没有分类' : '先选一个大类' }}
            </div>
          </div>
          <footer class="cat-col-foot">
            <button class="btn btn-sm btn-quiet" @click="addIn(ci)" :disabled="!canAdd(ci)">
              <ui-icon name="plus" :size="13" /> 新增
            </button>
            <button class="btn btn-sm btn-quiet" @click="renameSel(ci)" :disabled="!catPath[ci]">改名</button>
            <button class="btn btn-sm btn-quiet cat-del" @click="askDeleteSel(ci)" :disabled="!catPath[ci]">删除</button>
          </footer>
        </section>
      </div>

      <!-- 窄屏：面包屑逐层钻取 -->
      <div class="cat-drill">
        <div class="cat-crumbs">
          <button :class="{ 'is-active': !catPath.length }" @click="catPath = []">全部</button>
          <template v-for="(b, i) in breadcrumb" :key="b.id">
            <ui-icon name="chevronRight" :size="12" />
            <button :class="{ 'is-active': i === breadcrumb.length - 1 }"
                    @click="catPath = catPath.slice(0, i + 1)">{{ b.name }}</button>
          </template>
        </div>

        <div class="cat-list">
          <div class="cat-row" v-for="c in drillList" :key="c.id">
            <template v-if="catEdit && catEdit.id === c.id">
              <input class="input cat-input" v-model="catEdit.name" placeholder="分类名称"
                     @keydown.enter.prevent="saveCatEdit" @keydown.esc="catEdit = null" autofocus>
              <button class="btn btn-sm btn-primary" @click="saveCatEdit" :disabled="!catEdit.name.trim()">保存</button>
              <button class="btn btn-sm btn-quiet" @click="catEdit = null" aria-label="取消">
                <ui-icon name="close" :size="14" />
              </button>
            </template>
            <template v-else>
              <button class="cat-item grow" @click="pick(catPath.length, c.id)">
                <span class="cat-dot" :class="'lv' + (catPath.length + 1)"></span>
                <span class="cat-name">{{ c.name }}</span>
                <span class="cat-count mono">{{ c.count }}</span>
                <ui-icon v-if="c.hasChildren" name="chevronRight" :size="14" class="cat-chev" />
              </button>
              <template v-if="catEditing">
                <button class="btn btn-sm btn-quiet" @click="renameNode(c)">改名</button>
                <button class="btn btn-sm btn-quiet cat-del" @click="askDeleteNode(c)">删除</button>
              </template>
            </template>
          </div>

          <div class="cat-edit-row" v-if="catEdit && catEdit.id === null && catEdit.depth === catPath.length">
            <input class="input cat-input" v-model="catEdit.name" placeholder="分类名称"
                   @keydown.enter.prevent="saveCatEdit" @keydown.esc="catEdit = null" autofocus>
            <button class="btn btn-sm btn-primary" @click="saveCatEdit" :disabled="!catEdit.name.trim()">保存</button>
            <button class="btn btn-sm btn-quiet" @click="catEdit = null" aria-label="取消">
              <ui-icon name="close" :size="14" />
            </button>
          </div>

          <div class="empty-inline" v-if="!drillList.length && !(catEdit && catEdit.id === null && catEdit.depth === catPath.length)">
            {{ catPath.length >= 2 ? '已经到最末级' : catPath.length ? '这一层还没有分类' : '还没有分类，先建一个' }}
          </div>
        </div>

        <div class="cat-drill-foot">
          <button class="btn btn-sm" @click="catEditing = !catEditing">{{ catEditing ? '完成' : '编辑' }}</button>
          <button class="btn btn-sm btn-primary" @click="addIn(catPath.length)" :disabled="!canAdd(catPath.length)">
            <ui-icon name="plus" :size="14" /> 新增分类
          </button>
        </div>
        <p class="xs muted" style="margin-top:8px">最多两级，商品挂在最后选中的一级</p>
      </div>
    </template>

    <template v-else>
      <div class="tag-manager">
      <div class="tag-add">
        <input class="input" v-model="newTag" placeholder="输入标签名，回车添加"
               @keydown.enter.prevent="createTag" aria-label="新标签">
        <button class="btn btn-primary" @click="createTag" :disabled="!newTag.trim()">添加</button>
      </div>
      <div class="cat-list">
        <div class="cat-row tag-row" v-for="t in tags" :key="t.name">
          <template v-if="tagEdit && tagEdit.from === t.name">
            <input class="input cat-input" v-model="tagEdit.name" @keydown.enter.prevent="saveTagEdit" autofocus>
            <button class="btn btn-sm btn-primary" @click="saveTagEdit" :disabled="!tagEdit.name.trim()">保存</button>
            <button class="btn btn-sm btn-quiet" @click="tagEdit = null">取消</button>
          </template>
          <template v-else>
            <span class="tag tag-brand">#{{ t.name }}</span>
            <span class="cat-count mono">{{ t.count }}</span>
            <span class="cat-actions">
              <button class="btn btn-sm btn-quiet" @click="startEditTag(t)">改名</button>
              <button class="btn btn-sm btn-quiet cat-del" @click="askDeleteTag(t)">删除</button>
            </span>
          </template>
        </div>
        <div class="empty-inline" v-if="!tags.length">还没有标签，在上方输入一个试试</div>
      </div>
      <p class="xs muted" style="margin-top:10px">标签是自由维度，可以跨分类使用，比如「热销」「套餐件」。</p>
      </div>
    </template>
  </ui-sheet>

  <ui-confirm v-if="confirmDelete" title="删除套餐？"
              :text="'「' + confirmDelete.name + '」将被移除；如果已被历史订单引用，会自动改为停售以保留记录。'"
              confirm-text="删除" danger @yes="doDelete" @no="confirmDelete = null" />

  <ui-confirm v-if="confirmCatDelete" title="删除分类？"
              :text="'「' + confirmCatDelete.name + '」下如有子分类或商品将无法删除。'"
              confirm-text="删除" danger @yes="doDeleteCategory" @no="confirmCatDelete = null" />

  <ui-confirm v-if="confirmTagDelete" title="删除标签？"
              :text="'「#' + confirmTagDelete.name + '」会从 ' + confirmTagDelete.count + ' 个商品上移除，商品本身不受影响。'"
              confirm-text="删除" danger @yes="doDeleteTag" @no="confirmTagDelete = null" />
</div>`
};
