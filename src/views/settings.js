/* 设置：云端账号、数据维护、业务规则对照 */
import { store, actions, demoInfo, changePassword, logout, toast, PREVIEW } from '../data/store.js';
import { UiPaymentCode, readPaymentCode } from '../components/payment-code.js';
import { fmtDT } from '../util/format.js';

const RULES = [
  ['R1', '实收 ≠ 应收时必须选差额原因，差额单独记账'],
  ['R2', '赠品行金额为 0，但仍计入销量与出库'],
  ['R3', '收款与库存扣减一起完成，失败不落库'],
  ['R4', '冲销生成反向流水，原单永不删除'],
  ['R5', '出库后余额 ≤ 安全库存即触发一条预警'],
  ['R6', '盘点差异生成调整流水并留痕原因'],
  ['R7', '停售商品不能加入新订单，历史订单照常展示'],
  ['R8', '套餐按明细逐商品扣库存，价格按套餐价整体算']
];

const SYNC_TXT = {
  idle: '待同步', pending: '同步中', saving: '同步中',
  saved: '已同步', unsynced: '未同步', conflict: '待刷新'
};

export const SettingsView = {
  name: 'SettingsView',
  components: { UiPaymentCode },
  data() {
    return {
      confirmReset: false, confirmClear: false, confirmLogout: false,
      codeUploading: false, codeChannels: [{ key: 'wechat', label: '微信' }, { key: 'alipay', label: '支付宝' }],
      rules: RULES, importing: false,
      showPwd: false, oldPwd: '', newPwd: '', newPwd2: '', pwdBusy: false, pwdError: ''
    };
  },
  computed: {
    preview() { return PREVIEW; },
    store() { return store; },
    info() { return demoInfo.value; },
    syncText() { return SYNC_TXT[store.sync.state] || '云端同步'; },
    syncBad() { return ['unsynced', 'conflict'].includes(store.sync.state); },
    phoneText() {
      const p = store.auth.phone || '';
      return p.length === 11 ? p.slice(0, 3) + ' ' + p.slice(3, 7) + ' ' + p.slice(7) : (p || '—');
    },
    pwdReady() {
      return this.oldPwd.length >= 6 && this.newPwd.length >= 6 && this.newPwd === this.newPwd2;
    }
  },
  methods: {
    async uploadPaymentCode(channel, event) {
      const file = event.target.files?.[0];
      if (!file) return;
      this.codeUploading = true;
      try { actions.savePaymentCode(channel, await readPaymentCode(file)); }
      catch (error) { toast(error.message, 'warn'); }
      finally { this.codeUploading = false; event.target.value = ''; }
    },
    fmtDT,
    reset() { actions.resetDemo(); this.confirmReset = false; },
    clear() { actions.clearAll(); this.confirmClear = false; },
    retry() { actions.retrySave(); },
    exportJson() { actions.exportJson(); },
    pickImport() { this.$refs.importFile.click(); },
    async onImport(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      this.importing = true;
      await actions.importJson(file);
      this.importing = false;
      e.target.value = '';
    },
    openPwd() {
      this.oldPwd = ''; this.newPwd = ''; this.newPwd2 = ''; this.pwdError = '';
      this.showPwd = true;
    },
    async submitPwd() {
      this.pwdError = '';
      if (this.oldPwd.length < 6) { this.pwdError = '请输入原密码（至少 6 位）'; return; }
      if (this.newPwd.length < 6) { this.pwdError = '新密码至少 6 位'; return; }
      if (this.newPwd !== this.newPwd2) { this.pwdError = '两次输入的新密码不一致'; return; }
      this.pwdBusy = true;
      const res = await changePassword(this.oldPwd, this.newPwd);
      this.pwdBusy = false;
      if (!res.ok) { this.pwdError = res.error || '修改失败'; return; }
      this.showPwd = false;
    },
    async doLogout() {
      this.confirmLogout = false;
      await logout();
    }
  },
  template: `
<div class="v-settings">
  <div class="page-head">
    <div class="page-title">设置</div>
    <div class="page-sub">账号、同步与数据维护</div>
  </div>

  <div class="card">
    <div class="card-head"><h3>收款码</h3></div>
    <div class="card-body">
      <p class="small muted">选择收款渠道时自动展示对应收款码。请上传完整、清晰的原图。</p>
      <p class="field-hint">{{ preview ? '预览模式仅保存在当前浏览器，换设备需重新上传。' : '收款码随当前账户数据同步，换设备登录同一账户即可读取。' }}</p>
      <div class="payment-code-settings">
        <section v-for="c in codeChannels" :key="c.key">
          <h4>{{ c.label }}收款码</h4>
          <ui-payment-code :channel="c.key" :code="store.db.paymentCodes?.[c.key] || ''" />
          <label class="btn btn-sm">{{ codeUploading ? '正在保存…' : '上传 / 更换' }}
            <input type="file" accept="image/png,image/jpeg,image/webp" :aria-label="'上传' + c.label + '收款码'" :disabled="codeUploading" @change="uploadPaymentCode(c.key, $event)" class="payment-code-file">
          </label>
        </section>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <h3><ui-icon name="cloud" :size="16" /> 数据存在云端</h3>
      <span class="badge-demo" :class="{ 'badge-bad': syncBad }">{{ syncText }}</span>
    </div>
    <div class="card-body">
      <div class="info-rows">
        <div class="info-row"><span>登录手机号</span><b class="mono">{{ phoneText }}</b></div>
        <div class="info-row"><span>云端版本</span><b class="mono">v{{ info.version }}</b></div>
      </div>
      <p class="small" style="line-height:1.7;color:var(--label-2);margin-top:12px">
        商品、订单、库存全部存在云端，按手机号隔离。改完会自动同步，
        换手机或换浏览器用同一个号码登录，看到的是同一份数据。
      </p>
      <p class="xs muted" style="margin-top:8px">最近同步：{{ info.savedAt ? fmtDT(info.savedAt) : '—' }}</p>

      <div class="pill-note pill-note-warn" style="margin-top:12px" v-if="syncBad">
        <ui-icon name="alert" :size="16" />
        <div class="grow">
          {{ info.syncError || '这次改动还没同步到云端，先别关页面。' }}
          <button class="btn btn-sm" style="margin-left:8px" @click="retry">立即重试</button>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3><ui-icon name="lock" :size="16" /> 账号</h3></div>
    <div class="card-body stack-sm">
      <button class="btn btn-block" @click="openPwd">
        <ui-icon name="lock" :size="16" /> 修改密码
      </button>
      <button class="btn btn-block btn-danger" @click="confirmLogout = true">
        <ui-icon name="logout" :size="16" /> 退出登录
      </button>
      <p class="xs muted">初始密码是 123456，建议现在就换掉。退出登录会清空本页内存里的数据，重新登录再从云端拉。</p>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3><ui-icon name="layers" :size="16" /> 当前数据</h3></div>
    <div class="card-body">
      <div class="kv-grid">
        <div class="kv"><span>商品</span><b class="mono">{{ info.products }}</b></div>
        <div class="kv"><span>在售</span><b class="mono">{{ info.onSale }}</b></div>
        <div class="kv"><span>套餐</span><b class="mono">{{ info.combos }}</b></div>
        <div class="kv"><span>订单</span><b class="mono">{{ info.orders }}</b></div>
        <div class="kv"><span>已收款</span><b class="mono">{{ info.paid }}</b></div>
        <div class="kv"><span>待收款</span><b class="mono">{{ info.pending }}</b></div>
        <div class="kv"><span>已冲销</span><b class="mono">{{ info.cancelled }}</b></div>
        <div class="kv"><span>库存流水</span><b class="mono">{{ info.movements }}</b></div>
        <div class="kv"><span>已建账商品</span><b class="mono">{{ info.counted }}</b></div>
        <div class="kv"><span>未处理预警</span><b class="mono">{{ info.alerts }}</b></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3><ui-icon name="history" :size="16" /> 数据维护</h3></div>
    <div class="card-body stack-sm">
      <button class="btn btn-block" @click="exportJson">
        <ui-icon name="download" :size="16" /> 导出当前数据（JSON）
      </button>
      <button class="btn btn-block" :disabled="importing" @click="pickImport">
        <ui-icon name="boxIn" :size="16" /> {{ importing ? '导入中…' : '导入数据（JSON）' }}
      </button>
      <input ref="importFile" type="file" accept="application/json,.json" style="display:none" @change="onImport">
      <button class="btn btn-block" @click="confirmReset = true">
        <ui-icon name="refresh" :size="16" /> 恢复初始历史数据
      </button>
      <button class="btn btn-block btn-danger" @click="confirmClear = true">
        <ui-icon name="trash" :size="16" /> 清空所有数据
      </button>
      <p class="xs muted">导出只是给本地留个备份，云端才是唯一数据源。导入会整体替换云端数据，建议先导出。</p>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <h3><ui-icon name="target" :size="16" /> 业务规则对照</h3>
      <span class="hint">开发验收用</span>
    </div>
    <div class="card-body">
      <div class="rule-row" v-for="r in rules" :key="r[0]">
        <span class="rule-code mono">{{ r[0] }}</span>
        <span class="small">{{ r[1] }}</span>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3><ui-icon name="info" :size="16" /> 关于</h3></div>
    <div class="card-body">
      <p class="small" style="line-height:1.7;color:var(--label-2)">
        摆摊订单管家 · 市集收银台<br>
        <span class="muted">开单收款、订单跟踪、库存盘点、经营统计，一个页面管完一场市集。业务规则仍在前端执行，云端只负责按账号存取。</span>
      </p>
    </div>
  </div>

  <ui-sheet v-if="showPwd" title="修改密码" subtitle="改了以后下次用新密码登录" @close="showPwd = false">
    <label class="field">
      <span class="field-label">原密码</span>
      <input class="input" type="password" autocomplete="current-password" v-model="oldPwd" placeholder="当前的登录密码">
    </label>
    <label class="field">
      <span class="field-label">新密码</span>
      <input class="input" type="password" autocomplete="new-password" v-model="newPwd" placeholder="至少 6 位">
    </label>
    <label class="field">
      <span class="field-label">再输一次新密码</span>
      <input class="input" type="password" autocomplete="new-password" v-model="newPwd2" placeholder="两次要一样">
    </label>
    <p class="login-error" v-if="pwdError">{{ pwdError }}</p>
    <template #foot>
      <button class="btn" @click="showPwd = false">取消</button>
      <button class="btn btn-primary" :disabled="!pwdReady || pwdBusy" @click="submitPwd">
        {{ pwdBusy ? '保存中…' : '保存' }}
      </button>
    </template>
  </ui-sheet>

  <ui-confirm v-if="confirmReset" title="恢复初始历史数据？"
              text="当前所有改动会被云端覆盖，回到初始的 36 个商品、2 个套餐和 29 笔历史订单。"
              confirm-text="恢复" danger @yes="reset" @no="confirmReset = false" />

  <ui-confirm v-if="confirmClear" title="清空所有数据？"
              text="商品、订单、库存、流水和预警会全部清掉，云端也会同步成空库。建议先导出备份。"
              confirm-text="清空" danger @yes="clear" @no="confirmClear = false" />

  <ui-confirm v-if="confirmLogout" title="退出登录？"
              text="退出后本页不再显示数据，重新登录会从云端重新拉取。未同步的改动会先尝试保存。"
              confirm-text="退出" danger @yes="doLogout" @no="confirmLogout = false" />
</div>`
};
