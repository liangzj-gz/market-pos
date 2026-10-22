/* 商品与套餐：两级分类 + 自定义标签，分类和标签都由用户自己维护 */
import {
  store, actions, stockState, productById, toast,
  rootCategories, categoryRows, tagLibrary, childrenIn, categoryProductCount
} from '../data/store.js';
import { money } from '../util/format.js';
import { parseProductImport, matrixToTsv, IMPORT_SAMPLE, IMPORT_COLUMNS } from '../domain/import.js';
import { deriveComboGroups, comboHasGroups, productsInMid } from '../domain/rules.js';
import { UiSheet } from '../components/index.js';

const EMPTY_PRODUCT = () => ({
  id: null, sku_code: '', name: '', cat1: '', cat2: '',
  list_price: '', cost_price: '', safety_stock: 0, barcode: '',
  status: 'on_sale', tags: [], tagInput: ''
});

/* Excel 解析组件按需加载，没打开批量导入就不下载 861KB 的 SheetJS */
let xlsxPromise = null;
function ensureXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxPromise) {
    xlsxPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './assets/vendor/xlsx.full.min.js';
      script.onload = () => resolve(window.XLSX);
      script.onerror = () => {
        xlsxPromise = null;
        reject(new Error('Excel 解析组件加载失败，请检查网络'));
      };
      document.head.appendChild(script);
    });
  }
  return xlsxPromise;
}

const SHEET_FIELDS = ['name', 'list_price', 'cost_price', 'safety_stock', 'sku_code', 'cat1', 'cat2', 'tags'];

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
      confirmTagDelete: null,
      /* 批量导入 */
      importer: false,
      importText: '',
      importFile: '',
      importHelp: false,
      autoCreateCategory: false,
      importMode: 'file',
      sheetRows: [],
      sheetSeq: 0,
      excelLoading: false
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
          p.name, p.sku_code,
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
      const groups = (this.comboTarget && this.comboTarget.groups) || [];
      return !!(this.comboTarget && this.comboTarget.name.trim() && groups.length
        && groups.every(g => g.category_l1_id && g.category_id
          && Array.isArray(g.product_ids) && g.product_ids.length));
    },
    activeRootGroup() {
      return this.rootGroups.find(g => g.key === this.activeRoot) || null;
    },
    activeRootMids() {
      return this.activeRootGroup ? this.activeRootGroup.mids : [];
    },
    activeMidItem() {
      const group = this.activeRootGroup;
      if (!group) return null;
      return group.mids.find(m => m.key === this.activeMid) || group.mids[0] || null;
    },
    /* 批量导入：文本一变就重新解析，预览区始终和输入同步 */
    importParsed() {
      if (!String(this.importText || '').trim()) return null;
      return parseProductImport(this.importText, store.db);
    },
    importColumns() { return IMPORT_COLUMNS; },
    importSample() { return IMPORT_SAMPLE; },
    sheetFilledRows() {
      return this.sheetRows.filter(row =>
        SHEET_FIELDS.some(field => String(row[field] === null || row[field] === undefined ? '' : row[field]).trim() !== '')
      );
    },
    sheetText() {
      return this.sheetFilledRows.map(row =>
        IMPORT_COLUMNS.map(col => {
          const value = col.key === 'category' ? this.categoryText(row) : row[col.key];
          return String(value === null || value === undefined ? '' : value)
            .replace(/\t/g, ' ')
            .replace(/\r?\n/g, ' ');
        }).join('\t')
      ).join('\n');
    },
    sheetParsed() {
      if (!this.sheetFilledRows.length) return null;
      return parseProductImport(this.sheetText, store.db);
    },
    sheetParsedByKey() {
      const map = {};
      if (!this.sheetParsed) return map;
      this.sheetFilledRows.forEach((row, i) => { map[row.key] = this.sheetParsed.rows[i] || null; });
      return map;
    },
    categoryPaths() {
      const cats = store.db.categories;
      const roots = new Map(cats.filter(c => !c.parent_id).map(c => [c.id, c.name]));
      const out = [];
      cats.forEach(c => {
        if (c.parent_id && roots.has(c.parent_id)) out.push(roots.get(c.parent_id) + '>' + c.name);
        else if (!c.parent_id) out.push(c.name);
      });
      return out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    },
    sheetReady() {
      return this.sheetParsed ? this.sheetParsed.okCount : 0;
    },
    importReady() {
      if (this.importMode === 'table') return this.sheetReady;
      return this.importParsed ? this.importParsed.okCount : 0;
    },
    importHasCategoryMiss() {
      const parsed = this.importMode === 'table' ? this.sheetParsed : this.importParsed;
      return !!(parsed && parsed.rows.some(r => r.categoryMiss));
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
      const threshold = window.matchMedia('(min-width: 900px)').matches ? 100 : 140;
      let currentRoot = groups[0].key;
      let currentMid = null;
      for (const group of groups) {
        const rootEl = document.getElementById(this.rootDomId(group));
        if (rootEl && rootEl.getBoundingClientRect().top <= threshold) currentRoot = group.key;
        for (const sub of group.mids) {
          const midEl = document.getElementById(this.midDomId(sub));
          if (midEl && midEl.getBoundingClientRect().top <= threshold) {
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
        safety_stock: p.safety_stock, barcode: p.barcode || '',
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

    /* ---------- 批量导入 ---------- */
    openImport() {
      this.importer = true;
      this.importMode = 'table';
      this.importText = '';
      this.importFile = '';
      this.importHelp = false;
      this.autoCreateCategory = false;
      this.excelLoading = false;
      this.resetSheetRows();
    },
    setImportMode(mode) {
      this.importMode = mode;
      if (mode === 'file') ensureXlsx().catch(() => {});
    },
    closeImport() {
      if (this.saving) return;
      this.importer = false;
    },
    newSheetRow(data = {}) {
      return {
        key: ++this.sheetSeq,
        name: '', list_price: '', cost_price: '', safety_stock: '',
        sku_code: '', cat1: '', cat2: '', tags: '',
        ...data
      };
    },
    addSheetRow() { this.sheetRows.push(this.newSheetRow()); },
    removeSheetRow(row) {
      const index = this.sheetRows.indexOf(row);
      if (index >= 0) this.sheetRows.splice(index, 1);
      if (!this.sheetRows.length) this.sheetRows.push(this.newSheetRow());
    },
    resetSheetRows() {
      this.sheetSeq = 0;
      this.sheetRows = Array.from({ length: 5 }, () => this.newSheetRow());
    },
    fillSheetSample() {
      const root = this.rootCats.find(c => c.name !== '其他') || this.rootCats[0];
      const mid = root ? childrenIn(root.id)[0] : null;
      this.sheetSeq = 0;
      this.sheetRows = [
        this.newSheetRow({
          name: '示例-手工皂', list_price: '18', cost_price: '6', safety_stock: '5',
          cat1: root ? root.id : '', cat2: mid ? mid.id : '', tags: '手工/送礼'
        }),
        this.newSheetRow({
          name: '示例-帆布包', list_price: '39', cost_price: '12', safety_stock: '3',
          cat1: root ? root.id : '', cat2: mid ? mid.id : '', tags: '热销'
        })
      ];
    },
    midOptions(row) { return row.cat1 ? childrenIn(row.cat1) : []; },
    categoryText(row) {
      const root = store.db.categories.find(c => c.id === row.cat1);
      if (!root) return '';
      const mid = store.db.categories.find(c => c.id === row.cat2);
      return mid ? root.name + '>' + mid.name : root.name;
    },
    sheetRowParsed(row) { return this.sheetParsedByKey[row.key] || null; },
    sheetRowIssue(row) {
      const parsed = this.sheetRowParsed(row);
      return parsed ? this.rowIssue(parsed) : '';
    },
    sheetRowBad(row) {
      const parsed = this.sheetRowParsed(row);
      return !!(parsed && parsed.errors.length);
    },
    sheetRowWarn(row) {
      const parsed = this.sheetRowParsed(row);
      return !!(parsed && !parsed.errors.length && parsed.warns.length);
    },
    async onImportFile(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const isSpreadsheet = ext === 'xlsx' || ext === 'xls';
      if (file.size > (isSpreadsheet ? 5 : 1) * 1024 * 1024) {
        toast('文件太大了，请控制在 ' + (isSpreadsheet ? '5MB' : '1MB') + ' 以内', 'warn');
        return;
      }
      if (!isSpreadsheet) {
        const reader = new FileReader();
        reader.onload = () => {
          this.importText = String(reader.result || '');
          this.importFile = file.name;
        };
        reader.onerror = () => toast('读取文件失败', 'warn');
        reader.readAsText(file, 'utf-8');
        return;
      }
      this.excelLoading = true;
      try {
        const XLSX = await ensureXlsx();
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = sheetName ? workbook.Sheets[sheetName] : null;
        if (!sheet) throw new Error('Excel 里没有工作表');
        const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
        const text = matrixToTsv(matrix);
        if (!text.trim()) throw new Error('这个工作表里没有读到内容');
        this.importText = text;
        this.importFile = file.name;
        toast('已读取「' + sheetName + '」' + (workbook.SheetNames.length > 1 ? '（默认第一个工作表）' : ''), 'ok');
      } catch (e) {
        toast(e && e.message ? e.message : '读取 Excel 失败', 'warn');
      } finally {
        this.excelLoading = false;
      }
    },
    async downloadTemplate() {
      try {
        const XLSX = await ensureXlsx();
        const headers = IMPORT_COLUMNS.map(c => c.label);
        const categories = this.categoryPaths;
        const sampleCategory = categories.find(p => p.includes('>') && !p.startsWith('其他')) || categories[0] || '';
        const sheet = XLSX.utils.aoa_to_sheet([
          headers,
          ['示例-手工皂', '18', '6', '5', '', sampleCategory, '手工/送礼']
        ]);
        sheet['!cols'] = headers.map((h, i) => ({ wch: [18, 10, 10, 12, 10, 14, 20, 18][i] || 12 }));
        const helpRows = [['列名', '说明']].concat(IMPORT_COLUMNS.map(c => [c.label, c.hint]));
        helpRows.push(['分类格式', '大类>中类，例如 ' + (sampleCategory || '挂件饰品>挂件')]);
        helpRows.push(['标签格式', '多个标签用 / 或逗号分隔']);
        const help = XLSX.utils.aoa_to_sheet(helpRows);
        help['!cols'] = [{ wch: 14 }, { wch: 42 }];
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, '商品导入模板');
        XLSX.utils.book_append_sheet(book, help, '填写说明');
        XLSX.writeFile(book, '商品导入模板.xlsx');
        toast('Excel 模板已下载', 'ok');
      } catch (e) {
        toast(e && e.message ? e.message : '生成模板失败', 'warn');
      }
    },
    fillImportSample() {
      this.importText = IMPORT_SAMPLE;
      this.importFile = '';
    },
    rowIssue(r) {
      if (r.errors.length) return r.errors[0];
      if (r.warns.length) return r.warns[0];
      return '';
    },
    doImport() {
      const parsed = this.importMode === 'table' ? this.sheetParsed : this.importParsed;
      if (!parsed) return;
      const rows = parsed.rows.filter(r => !r.errors.length);
      if (!rows.length) { toast('没有可导入的行，先按提示改一下', 'warn'); return; }
      this.saving = true;
      const res = actions.importProducts(rows, { autoCreateCategory: this.autoCreateCategory });
      this.saving = false;
      if (!res.ok) return;
      const okCount = res.data.ok.length;
      const bad = res.data.bad;
      if (bad.length) {
        toast('导入 ' + okCount + ' 个，' + bad.length + ' 个写入失败：' + bad[0].error, 'warn');
        return;
      }
      this.importer = false;
      this.importText = '';
      this.importFile = '';
      this.resetSheetRows();
      toast(parsed.badCount
        ? '已导入 ' + okCount + ' 个，另有 ' + parsed.badCount + ' 行格式有问题已跳过'
        : '已导入 ' + okCount + ' 个商品', parsed.badCount ? 'warn' : 'ok');
    },

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
      this.comboTarget = {
        id: null, name: '', combo_price: '', original_price: '', status: 'on_sale',
        groups: [{ category_l1_id: '', category_id: '', quantity: 1, product_ids: [] }]
      };
    },
    openEditCombo(c) {
      const groups = (comboHasGroups(c) ? c.groups : deriveComboGroups(store.db, c.items || []))
        .map(g => {
          const mid = store.db.categories.find(x => x.id === g.category_id);
          const fallbackProducts = mid ? productsInMid(store.db, mid.id).map(p => p.id) : [];
          return {
            category_l1_id: g.category_l1_id || (mid ? mid.parent_id : '') || '',
            category_id: g.category_id,
            quantity: g.quantity,
            product_ids: Array.isArray(g.product_ids) && g.product_ids.length
              ? [...g.product_ids]
              : fallbackProducts
          };
        });
      this.comboTarget = {
        id: c.id, name: c.name, combo_price: c.combo_price,
        original_price: c.original_price === null ? '' : c.original_price,
        status: c.status,
        groups: groups.length ? groups : [{ category_l1_id: '', category_id: '', quantity: 1, product_ids: [] }]
      };
    },
    addComboGroup() {
      this.comboTarget.groups.push({ category_l1_id: '', category_id: '', quantity: 1, product_ids: [] });
    },
    removeComboGroup(i) {
      if (this.comboTarget.groups.length > 1) this.comboTarget.groups.splice(i, 1);
    },
    groupMidOptions(group) {
      return group.category_l1_id ? childrenIn(group.category_l1_id) : [];
    },
    onComboGroupRoot(group) {
      group.category_id = '';
      group.product_ids = [];
    },
    onComboGroupMid(group) {
      group.product_ids = [];
    },
    groupProducts(group) {
      if (!group.category_id) return [];
      return productsInMid(store.db, group.category_id)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    },
    selectAllGroupProducts(group) {
      group.product_ids = this.groupProducts(group).map(p => p.id);
    },
    clearGroupProducts(group) { group.product_ids = []; },
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
    comboGroupList(c) {
      return comboHasGroups(c) ? c.groups : deriveComboGroups(store.db, c.items || []);
    },
    comboParts(c) {
      return this.comboGroupList(c).map(g => {
        const mid = store.db.categories.find(x => x.id === g.category_id);
        const root = mid && mid.parent_id ? store.db.categories.find(x => x.id === mid.parent_id) : null;
        const label = root ? root.name + '>' + mid.name : (mid ? mid.name : '?');
        return label + '×' + g.quantity;
      }).join(' + ');
    },
    comboPieces(c) {
      return this.comboGroupList(c).reduce((t, g) => t + Number(g.quantity || 0), 0);
    },
    comboValue(c) {
      if (comboHasGroups(c)) return 0;
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
    <div class="row catalog-actions" style="gap:8px">
      <button class="btn btn-icon" @click="openCatManager" aria-label="管理分类与标签" title="管理分类与标签">
        <ui-icon name="settings" :size="18" />
      </button>
      <button v-if="tab === 'products'" class="btn btn-icon" @click="openImport"
              aria-label="批量导入商品" title="批量导入商品">
        <span class="bi-char">批</span>
      </button>
      <button class="btn btn-primary btn-icon"
              @click="tab === 'products' ? openNew() : openNewCombo()"
              :aria-label="tab === 'products' ? '新增商品' : '新增套餐'"
              :title="tab === 'products' ? '新增商品' : '新增套餐'">
        <ui-icon name="plus" :size="18" />
      </button>
    </div>
  </div>

  <div class="card filter-card catalog-filter-card" v-if="tab === 'products'">
    <div class="card-body">
      <div class="catalog-filter-row">
        <div class="input-search catalog-search">
          <ui-icon name="search" :size="17" />
          <input class="input" v-model="search" type="search" placeholder="搜名称 / SKU / 分类 / 标签" aria-label="搜索商品">
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

        <div class="cat-context-bar" v-if="activeRootGroup">
          <span class="ccb-dot"></span>
          <span class="ccb-root">{{ activeRootGroup.name }}</span>
          <ui-icon name="chevronRight" :size="12" class="ccb-chev" />
          <span class="ccb-mid">{{ activeMidItem ? activeMidItem.name : '全部' }}</span>
          <span class="ccb-count mono" v-if="activeMidItem">{{ activeMidItem.items.length }}</span>
        </div>

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
      <ui-empty icon="products" title="没有符合条件的商品" text="换个标签或搜索词，也可以新增一个；货单上的商品能一次贴进来。">
        <button class="btn btn-primary" @click="openNew">新增商品</button>
        <button class="btn" @click="openImport">批量导入</button>
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
          <span class="xs muted" v-if="comboValue(c) > 0">单点合计 <b class="mono">{{ money(comboValue(c)) }}</b></span>
          <span class="xs muted" v-else>自选 {{ comboPieces(c) }} 件</span>
          <span class="xs" v-if="c.original_price && Number(c.original_price) > 0">
            <span class="tag tag-ok">约 {{ Math.round(Number(c.combo_price) / (comboValue(c) || Number(c.original_price)) * 100) }} 折</span>
          </span>
          <span class="grow"></span>
          <button class="btn btn-sm" @click="openEditCombo(c)">编辑</button>
          <button class="btn btn-sm btn-danger" @click="askDelete(c)">删除</button>
        </div>
      </div>
    </div>
    <div class="card" v-else><div class="card-body">
      <ui-empty icon="layers" title="还没有套餐" text="把常一起卖的商品打包成套餐，录单时按中类现场选品。">
        <button class="btn btn-primary" @click="openNewCombo">新增套餐</button>
      </ui-empty>
    </div></div>
  </template>

  <!-- 批量导入商品 -->
  <ui-sheet v-if="importer" title="批量导入商品" xwide @close="closeImport">
    <div class="seg bi-modes" role="tablist">
      <button class="seg-btn" :class="{ 'is-on': importMode === 'table' }" role="tab"
              :aria-selected="importMode === 'table'" @click="setImportMode('table')">在线表格录入</button>
      <button class="seg-btn" :class="{ 'is-on': importMode === 'file' }" role="tab"
              :aria-selected="importMode === 'file'" @click="setImportMode('file')">Excel 文件导入</button>
    </div>

    <template v-if="importMode === 'file'">
      <div class="bi-intro">
        支持 <b>.xlsx / .xls / .csv</b>，也可以从 Excel / WPS 里框选复制后直接粘贴。只有<b>商品名称</b>是必填的，其余列能填就填。
      </div>

      <div class="bi-toolbar">
        <label class="btn btn-sm bi-file" :class="{ 'is-loading': excelLoading }">
          <ui-icon name="boxIn" :size="16" /> {{ excelLoading ? '正在读取…' : '选择 Excel / CSV 文件' }}
          <input type="file" accept=".xlsx,.xls,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain"
                 @change="onImportFile" :disabled="excelLoading">
        </label>
        <button type="button" class="btn btn-sm" @click="downloadTemplate">下载模板</button>
        <button type="button" class="btn btn-sm" @click="fillImportSample">填入示例</button>
        <button type="button" class="btn btn-sm btn-quiet" @click="importHelp = !importHelp">
          {{ importHelp ? '收起列说明' : '列的格式' }}
        </button>
      </div>

      <div class="bi-help" v-if="importHelp">
        <div class="bi-help-row" v-for="c in importColumns" :key="c.key">
          <b>{{ c.label }}</b>
          <span class="xs muted">{{ c.hint }}</span>
        </div>
        <div class="field-hint">
          列的顺序就是上表顺序；首行如果写「名称 / 售价 / 成本价」这类表头会自动识别，不用记顺序。
          分类用 <code>大类&gt;中类</code> 表示，标签多个用 <code>/</code> 分隔。
        </div>
      </div>

      <div class="field">
        <label>粘贴内容<span class="xs muted" v-if="importFile"> · {{ importFile }}</span></label>
        <textarea class="input input-mono bi-textarea" v-model="importText" rows="7"
                  :placeholder="importSample" spellcheck="false"></textarea>
      </div>

      <div class="bi-preview" v-if="importParsed">
        <div class="bi-stat">
          <span class="bi-stat-ok">可导入 {{ importParsed.okCount }}</span>
          <span class="bi-stat-bad" v-if="importParsed.badCount">{{ importParsed.badCount }} 行有错</span>
          <span class="bi-stat-warn" v-if="importParsed.warnCount">{{ importParsed.warnCount }} 行需留意</span>
          <span class="grow"></span>
          <span class="xs muted">
            {{ importParsed.separator === 'tab' ? '按制表符分列' : importParsed.separator === 'pipe' ? '按竖线分列' : importParsed.separator === 'comma' ? '按逗号分列' : '整行当名称' }}{{ importParsed.headerSkipped ? ' · 已跳过表头' : '' }}
          </span>
        </div>
        <div class="bi-rows">
          <div class="bi-row" v-for="r in importParsed.rows" :key="r.line"
               :class="{ 'is-bad': r.errors.length, 'is-warn': !r.errors.length && r.warns.length }">
            <span class="bi-line mono xs">{{ r.line }}</span>
            <div class="grow">
              <div class="bi-name">{{ r.name || '（没读到名称）' }}</div>
              <div class="xs muted bi-sub">
                <span v-if="r.categoryLabel">{{ r.categoryLabel }}</span>
                <span v-if="r.list_price">{{ money(r.list_price) }}</span>
                <span v-if="r.safety_stock">预警 {{ r.safety_stock }}</span>
                <span v-if="r.tags.length">#{{ r.tags.join(' #') }}</span>
              </div>
              <div class="xs bi-issue" v-if="rowIssue(r)">{{ rowIssue(r) }}</div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="bi-intro">
        像表格一样逐行填写，一行一个商品。商品名称必填；分类直接选大类和中类（新分类先去「管理分类」添加）。
      </div>

      <div class="bi-sheet-toolbar">
        <span class="xs muted">已填写 {{ sheetFilledRows.length }} 行</span>
        <span class="grow"></span>
        <button class="btn btn-sm" @click="fillSheetSample">填入示例</button>
        <button class="btn btn-sm" @click="addSheetRow"><ui-icon name="plus" :size="14" /> 加一行</button>
        <button class="btn btn-sm btn-quiet" @click="resetSheetRows">清空</button>
      </div>
      <div class="xs muted bi-sheet-hint">手机上可左右滑动表格，填写后面的售价、库存、分类等列。</div>

      <div class="bi-sheet-scroll">
        <table class="bi-sheet">
          <thead>
            <tr>
              <th class="bi-sheet-no">#</th>
              <th class="bi-col-name">商品名称 <b class="bi-required">*</b></th>
              <th class="bi-col-price">售价</th>
              <th class="bi-col-price">成本价</th>
              <th class="bi-col-stock">安全库存</th>
              <th class="bi-col-sku">SKU</th>
              <th class="bi-col-cat-root">大类</th>
              <th class="bi-col-cat-mid">中类</th>
              <th class="bi-col-tags">标签</th>
              <th class="bi-col-act"></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(row, i) in sheetRows" :key="row.key">
              <tr :class="{ 'is-bad': sheetRowBad(row), 'is-warn': sheetRowWarn(row) }">
                <td class="bi-sheet-no mono">{{ i + 1 }}</td>
                <td><input class="input bi-cell" v-model="row.name" placeholder="商品名称（必填）" aria-label="商品名称"></td>
                <td><input class="input bi-cell" type="number" inputmode="decimal" step="0.01" v-model="row.list_price" placeholder="0" aria-label="售价"></td>
                <td><input class="input bi-cell" type="number" inputmode="decimal" step="0.01" v-model="row.cost_price" placeholder="选填" aria-label="成本价"></td>
                <td><input class="input bi-cell" type="number" inputmode="numeric" min="0" v-model="row.safety_stock" placeholder="0" aria-label="安全库存"></td>
                <td><input class="input bi-cell" v-model="row.sku_code" placeholder="留空自动生成" aria-label="SKU"></td>
                <td>
                  <select class="select bi-cell" v-model="row.cat1" @change="row.cat2 = ''" aria-label="大类">
                    <option value="">未分类</option>
                    <option v-for="c in rootCats" :key="c.id" :value="c.id">{{ c.name }}</option>
                  </select>
                </td>
                <td>
                  <select class="select bi-cell" v-model="row.cat2" :disabled="!row.cat1" aria-label="中类">
                    <option value="">不选中类</option>
                    <option v-for="c in midOptions(row)" :key="c.id" :value="c.id">{{ c.name }}</option>
                  </select>
                </td>
                <td><input class="input bi-cell" v-model="row.tags" placeholder="热销/新品" aria-label="标签"></td>
                <td class="bi-col-act">
                  <button class="btn btn-sm btn-quiet" @click="removeSheetRow(row)" aria-label="删除这一行">
                    <ui-icon name="close" :size="14" />
                  </button>
                </td>
              </tr>
              <tr v-if="sheetRowIssue(row)" class="bi-sheet-issue" :class="{ 'is-warn': sheetRowWarn(row) }">
                <td></td>
                <td :colspan="9" class="bi-issue">{{ sheetRowIssue(row) }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <button class="btn btn-sm bi-add-row" @click="addSheetRow"><ui-icon name="plus" :size="14" /> 再加一行</button>

      <div class="bi-stat bi-sheet-stat" v-if="sheetParsed">
        <span class="bi-stat-ok">可导入 {{ sheetParsed.okCount }}</span>
        <span class="bi-stat-bad" v-if="sheetParsed.badCount">{{ sheetParsed.badCount }} 行有错</span>
        <span class="bi-stat-warn" v-if="sheetParsed.warnCount">{{ sheetParsed.warnCount }} 行需留意</span>
        <span class="grow"></span>
        <span class="xs muted">只导入没有错误的行</span>
      </div>
      <div class="xs muted bi-sheet-empty" v-else>填写几行后，这里会显示校验结果。</div>
    </template>

    <label class="bi-check" v-if="importHasCategoryMiss">
      <input type="checkbox" v-model="autoCreateCategory">
      <span>分类不存在的自动建出来（按「大类&gt;中类」逐级创建）</span>
    </label>

    <template #foot>
      <button class="btn" @click="closeImport" :disabled="saving">取消</button>
      <button class="btn btn-primary grow" @click="doImport" :disabled="saving || !importReady">
        {{ saving ? '导入中…' : '导入 ' + importReady + ' 个' }}
      </button>
    </template>
  </ui-sheet>

  <!-- 商品表单 -->
  <ui-sheet v-if="prodForm" :title="prodForm.id ? '编辑商品' : '新增商品'" @close="prodForm = null">
    <div class="field-hint import-entry" v-if="!prodForm.id">
      一次要录好几个？<button type="button" class="tag-suggest" @click="prodForm = null; openImport()">用批量导入 →</button>
    </div>
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
  <ui-sheet v-if="comboTarget" medium :title="comboTarget.id ? '编辑套餐' : '新增套餐'" @close="comboTarget = null">
    <div class="combo-form">
    <div class="form-grid">
      <div class="field">
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
      <label>子套餐（大类 + 中类 + 商品 + 必选件数）*</label>
      <div class="combo-groups">
        <div class="combo-group" v-for="(g, i) in comboTarget.groups" :key="i">
          <div class="combo-group-side">
            <span class="combo-side-label">大类</span>
            <select class="select" v-model.number="g.category_l1_id" @change="onComboGroupRoot(g)" aria-label="大类">
              <option :value="''" disabled>大类</option>
              <option v-for="c in rootCats" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
            <span class="combo-side-label">中类</span>
            <select class="select" v-model.number="g.category_id" @change="onComboGroupMid(g)"
                    :disabled="!g.category_l1_id" aria-label="中类">
              <option :value="''" disabled>中类</option>
              <option v-for="c in groupMidOptions(g)" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
            <div class="combo-side-foot">
              <span class="xs muted">必选</span>
              <input class="input input-mono combo-group-qty" type="number" inputmode="numeric" min="1"
                     v-model.number="g.quantity" aria-label="必选件数">
              <span class="xs muted">件</span>
              <button class="btn btn-quiet btn-icon btn-sm" @click="removeComboGroup(i)"
                      :disabled="comboTarget.groups.length === 1" aria-label="删除该子套餐">
                <ui-icon name="close" :size="14" />
              </button>
            </div>
            <div class="combo-side-actions">
              <button type="button" class="btn btn-sm btn-quiet" @click="selectAllGroupProducts(g)"
                      :disabled="!g.category_id || !groupProducts(g).length">全选</button>
              <button type="button" class="btn btn-sm btn-quiet" @click="clearGroupProducts(g)"
                      :disabled="!g.product_ids.length">全不选</button>
            </div>
          </div>
          <div class="combo-group-pool">
            <div class="combo-group-body" v-if="g.category_id">
              <div class="combo-group-tools">
                <span class="xs muted">可选商品 · 已选 {{ g.product_ids.length }} 款</span>
              </div>
              <div class="combo-product-scroll" v-if="groupProducts(g).length">
                <label class="combo-product-check" v-for="p in groupProducts(g)" :key="p.id">
                  <input type="checkbox" :value="p.id" v-model="g.product_ids">
                  <span class="combo-product-name">{{ p.name }}</span>
                  <span class="tag tag-gray" v-if="p.status === 'off_sale'">停售</span>
                </label>
              </div>
              <div class="xs muted" v-else>这个中类还没有商品</div>
            </div>
            <div class="xs muted combo-group-hint" v-else>先选大类和中类，再勾选顾客可选的商品</div>
          </div>
        </div>
      </div>
      <button class="btn btn-sm" style="margin-top:8px" @click="addComboGroup"><ui-icon name="plus" :size="14" /> 加一个子套餐</button>
      <div class="field-hint">顾客开单时从勾选的商品里选够对应件数；同一商品可选多件。</div>
    </div>

    <div class="field combo-status">
      <label>状态</label>
      <select class="select" v-model="comboTarget.status">
        <option value="on_sale">在售</option>
        <option value="off_sale">停售</option>
      </select>
    </div>

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
