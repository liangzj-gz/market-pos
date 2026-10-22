/* 应用外壳：登录门禁、导航、全局抽屉、提示层 */
import { store, openAlerts, pendingOrders, markReady, bootstrap } from './data/store.js';
import { registerComponents } from './components/index.js';
import { UiStockInSheet, UiStockTakeSheet } from './components/stock-sheets.js';
import { LoginView } from './views/login.js';
import { TodayView } from './views/today.js';
import { RegisterView } from './views/register.js?v=register-anchor-20261022';
import { OrdersView } from './views/orders.js';
import { InventoryView } from './views/inventory.js';
import { AlertsView } from './views/alerts.js';
import { CatalogView } from './views/catalog.js?v=catalog-sticky-20261022';
import { StatsView } from './views/stats.js';
import { SettingsView } from './views/settings.js';

const { createApp } = window.Vue;

const NAV = [
  { key: 'today', label: '今日', icon: 'today', short: '今日' },
  { key: 'register', label: '开单', icon: 'register', short: '开单' },
  { key: 'orders', label: '订单', icon: 'orders', short: '订单' },
  { key: 'inventory', label: '库存', icon: 'inventory', short: '库存' },
  { key: 'alerts', label: '预警', icon: 'alert', short: '预警', badge: 'alerts' },
  { key: 'catalog', label: '商品', icon: 'products', short: '商品' },
  { key: 'stats', label: '统计', icon: 'stats', short: '统计' },
  { key: 'settings', label: '设置', icon: 'settings', short: '设置' }
];

const VIEWS = {
  today: TodayView,
  register: RegisterView,
  orders: OrdersView,
  inventory: InventoryView,
  alerts: AlertsView,
  catalog: CatalogView,
  stats: StatsView,
  settings: SettingsView
};

const App = {
  components: { UiStockInSheet, UiStockTakeSheet, LoginView },
  data() {
    return {
      store,
      nav: NAV,
      views: VIEWS,
      /* 移动端底部五个位置：前四个直达，「更多」收其余 */
      tabs: ['today', 'register', 'orders', 'inventory']
    };
  },
  computed: {
    ui() { return store.ui; },
    view() { return store.ui.view; },
    current() { return VIEWS[store.ui.view] || TodayView; },
    alertCount() { return openAlerts.value.length; },
    pendingCount() { return pendingOrders.value.length; },
    moreViews() { return NAV.filter(n => !this.tabs.includes(n.key)); },
    sheet() { return store.ui.sheet; },
    moreActive() { return this.moreViews.some(n => n.key === this.view); },
    toasts() { return store.ui.toasts; },
    /* 门禁：loading 先看登录态，anon 看登录页，数据没拉下来也不白屏 */
    signedIn() { return store.auth.status === 'ready'; },
    booting() { return store.auth.status === 'loading' || (this.signedIn && !store.loaded); },
    phoneMask() {
      const p = store.auth.phone || '';
      return p.length === 11 ? p.slice(0, 3) + ' ' + p.slice(3, 7) + ' ' + p.slice(7) : p;
    },
    syncing() { return ['pending', 'saving'].includes(store.sync.state); },
    syncBad() { return ['unsynced', 'conflict'].includes(store.sync.state); },
    syncLabel() {
      if (store.sync.state === 'local') return '本地预览';
      if (store.sync.state === 'unsynced') return '未同步';
      if (store.sync.state === 'saving' || store.sync.state === 'pending') return '同步中';
      if (store.sync.state === 'conflict') return '待刷新';
      return '云端同步';
    }
  },
  methods: {
    go(key) {
      store.ui.view = key;
      store.ui.sheet = null;
      store.ui.cartOpen = false;
      window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    },
    badgeOf(item) {
      if (item.badge === 'alerts') return this.alertCount;
      return 0;
    },
    closeSheet() { store.ui.sheet = null; },
    toastIcon(kind) {
      return kind === 'warn' ? 'alert' : kind === 'ok' ? 'check' : 'info';
    }
  },
  mounted() {
    markReady();
    /* 先确认登录态，再看要不要拉云端数据 */
    bootstrap();
    /* hash 路由：刷新保持当前页，也能直接收藏某一页 */
    const fromHash = () => {
      const key = (location.hash || '').replace(/^#\/?/, '');
      if (key && VIEWS[key]) store.ui.view = key;
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    this.$watch(() => store.ui.view, v => {
      if (location.hash !== '#/' + v) history.replaceState(null, '', '#/' + v);
    }, { immediate: true });
    window.scrollTo(0, 0);
  },
  template: `
<div v-if="booting" class="boot-screen">
  <div class="boot-spin"></div>
  <div class="small muted">正在从云端读取数据…</div>
</div>

<login-view v-else-if="!signedIn" />

<div v-else class="shell">
  <!-- 桌面端侧栏 -->
  <aside class="sidebar" aria-label="主导航">
    <div class="side-brand">
      <div class="brand">
        <span class="brand-mark"><ui-icon name="orders" :size="16" /></span>
        <span class="side-brand-name">摆摊订单管家</span>
      </div>
      <div class="brand-sub">市集收银台</div>
      <div class="badge-demo" :class="{ 'badge-bad': syncBad }">
        <ui-icon name="cloud" :size="12" /> {{ syncLabel }}
      </div>
    </div>
    <nav class="side-nav">
      <button v-for="item in nav" :key="item.key" class="side-link"
              :aria-current="view === item.key ? 'page' : null" @click="go(item.key)">
        <ui-icon :name="item.icon" :size="18" />
        <span>{{ item.label }}</span>
        <span v-if="badgeOf(item)" class="count-badge">{{ badgeOf(item) }}</span>
      </button>
    </nav>
    <div class="side-foot">
      <div class="xs muted" style="line-height:1.6">
        数据存在云端<br>{{ phoneMask }}
      </div>
    </div>
  </aside>

  <!-- 移动端顶栏 -->
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark"><ui-icon name="orders" :size="16" /></span>
      <span>摆摊订单管家</span>
    </div>
    <span class="grow"></span>
    <span class="badge-demo" :class="{ 'badge-bad': syncBad }">
      <ui-icon name="cloud" :size="12" /> {{ syncLabel }}
    </span>
  </header>

  <main class="content">
    <component :is="current" :key="view" />
  </main>

  <!-- 移动端底部标签栏 -->
  <nav class="tabbar" aria-label="主导航">
    <button v-for="key in tabs" :key="key" class="tab"
            :aria-current="view === key ? 'page' : null" @click="go(key)">
      <ui-icon :name="nav.find(n => n.key === key).icon" :size="21" />
      <span>{{ nav.find(n => n.key === key).short }}</span>
      <span v-if="key === 'orders' && pendingCount" class="count-badge">{{ pendingCount }}</span>
    </button>
    <button class="tab" :class="{ 'is-more': true }" :aria-current="moreActive ? 'page' : null"
            :aria-expanded="ui.moreOpen" @click="ui.moreOpen = !ui.moreOpen">
      <ui-icon name="more" :size="21" />
      <span>更多</span>
      <span v-if="alertCount" class="count-badge">{{ alertCount }}</span>
    </button>
  </nav>

  <!-- 更多菜单 -->
  <teleport to="body">
    <div v-if="ui.moreOpen" class="more-mask" @click.self="ui.moreOpen = false">
      <div class="more-panel">
        <button v-for="item in moreViews" :key="item.key" class="more-item"
                :aria-current="view === item.key ? 'page' : null"
                @click="go(item.key); ui.moreOpen = false">
          <span class="more-icon"><ui-icon :name="item.icon" :size="19" /></span>
          <span class="grow" style="text-align:left">{{ item.label }}</span>
          <span v-if="badgeOf(item)" class="count-badge">{{ badgeOf(item) }}</span>
          <ui-icon name="chevronRight" :size="15" style="color:var(--label-4)" />
        </button>
      </div>
    </div>
  </teleport>

  <!-- 全局抽屉 -->
  <ui-stock-in-sheet v-if="sheet && sheet.type === 'stockin'" :product-id="sheet.productId || null" @close="closeSheet" />
  <ui-stock-take-sheet v-if="sheet && sheet.type === 'stocktake'" :product-id="sheet.productId" @close="closeSheet" />

  <!-- 提示 -->
  <teleport to="body">
    <div class="toast-layer" aria-live="polite">
      <transition-group name="toast">
        <div v-for="t in toasts" :key="t.id" class="toast" :class="'toast-' + t.kind">
          <ui-icon :name="toastIcon(t.kind)" :size="16" />
          <span>{{ t.message }}</span>
        </div>
      </transition-group>
    </div>
  </teleport>
</div>`
};

const app = createApp(App);
registerComponents(app);
app.mount('#app');
