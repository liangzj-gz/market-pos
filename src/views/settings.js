/* 设置：云端账号、收款码、数据导出、业务规则对照 */
import { store, actions, demoInfo, changePassword, logout, toast, PREVIEW, SELF_HOST_LOGIN, refreshPaymentCodesIfNeeded } from '../data/store.js';
import { UiPaymentCode } from '../components/payment-code.js';
import { fmtDT } from '../util/format.js';

const RULES = [
  ['R1', '实收 ≠ 应收时必须选差额原因，差额单独记账'],
  ['R2', '赠品行金额为 0，但仍计入销量与出库'],
  ['R3', '收款与库存扣减在服务端同一事务完成，失败不落库'],
  ['R4', '冲销生成反向流水，原单永不删除'],
  ['R5', '出库后余额 ≤ 安全库存即触发一条预警'],
  ['R6', '盘点差异生成调整流水并留痕原因'],
  ['R7', '停售商品不能加入新订单，历史订单照常展示'],
  ['R8', '套餐按明细逐商品扣库存，价格按套餐价整体算'],
  ['R9', '同一操作重复提交（网络重试 / 双击）只生效一次']
];

const SYNC_TXT = {
  idle: '已连接', saving: '处理中',
  saved: '已同步', unsynced: '操作失败', local: '本地预览'
};

export const SettingsView = {
  name: 'SettingsView',
  components: { UiPaymentCode },
  data() {
    return {
      confirmLogout: false,
      codeUploading: false, codeChannels: [{ key: 'wechat', label: '微信' }, { key: 'alipay', label: '支付宝' }],
      rules: RULES,
      showPwd: false, oldPwd: '', newPwd: '', newPwd2: '', pwdBusy: false, pwdError: ''
    };
  },
  computed: {
    preview() { return PREVIEW; },
    selfHost() { return SELF_HOST_LOGIN; },
    store() { return store; },
    info() { return demoInfo.value; },
    syncText() { return SYNC_TXT[store.sync.state] || '已连接'; },
    syncBad() { return store.sync.state === 'unsynced'; },
    phoneText() {
      const p = store.auth.phone || '';
      return p.length === 11 ? p.slice(0, 3) + ' ' + p.slice(3, 7) + ' ' + p.slice(7) : (p || '—');
    },
    pwdReady() {
      return this.oldPwd.length >= 6 && this.newPwd.length >= 6 && this.newPwd === this.newPwd2;
    }
  },
  mounted() {
    /* 收款码签名 URL 到期自动续签（页面长开时刷新设置页也能拿到新地址） */
    refreshPaymentCodesIfNeeded();
  },
  methods: {
    /* 收款码：图片上传云端文件存储，数据库只存路径 */
    async uploadPaymentCode(channel, event) {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        toast('请选择 JPG、PNG 或 WebP 收款码图片', 'warn');
        event.target.value = '';
        return;
      }
      if (file.size > 3 * 1024 * 1024) {
        toast('收款码图片请小于 3MB', 'warn');
        event.target.value = '';
        return;
      }
      this.codeUploading = true;
      try { await actions.savePaymentCodeFile(channel, file); }
      catch (error) { toast(error.message || '上传失败，请重试', 'warn'); }
      finally { this.codeUploading = false; event.target.value = ''; }
    },
    fmtDT,
    retry() {
      store.sync.error = '';
      store.sync.state = 'saved';
    },
    async exportJson() { await actions.exportJson(); },
    async exportCsv(kind) { await actions.exportCsv(kind); },
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
    <div class="page-sub">账号、收款码与数据导出</div>
  </div>

  <div class="card">
    <div class="card-head"><h3>收款码</h3></div>
    <div class="card-body">
      <p class="small muted">选择收款渠道时自动展示对应收款码。请上传完整、清晰的原图。</p>
      <p class="field-hint">{{ preview ? '预览模式仅保存在当前浏览器，换设备需重新上传。' : '收款码图片存在云端文件存储，换设备登录同一账户即可读取。' }}</p>
      <div class="payment-code-settings">
        <section v-for="c in codeChannels" :key="c.key">
          <h4>{{ c.label }}收款码</h4>
          <ui-payment-code :channel="c.key" :code="store.db.paymentCodes?.[c.key] || ''" />
          <label class="btn btn-sm">{{ codeUploading ? '正在上传…' : '上传 / 更换' }}
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
        <div class="info-row"><span>云端存储</span><b class="mono">{{ info.syncMode }}</b></div>
      </div>
      <p class="small" style="line-height:1.7;color:var(--label-2);margin-top:12px">
        商品、订单、库存按字段存进云端数据库，每个操作在服务端成套落库：
        下单即扣库存、盘点即出流水，不会出现「本机记了、云端没记」的中间态。
        换手机或换浏览器用同一个号码登录，看到的是同一份数据。
      </p>
      <p class="xs muted" style="margin-top:8px">最近操作：{{ info.savedAt ? fmtDT(info.savedAt) : '—' }}</p>

      <div class="pill-note pill-note-warn" style="margin-top:12px" v-if="syncBad">
        <ui-icon name="alert" :size="16" />
        <div class="grow">
          {{ info.syncError || '上一次操作没有成功，请重试。' }}
          <button class="btn btn-sm" style="margin-left:8px" @click="retry">知道了</button>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h3><ui-icon name="lock" :size="16" /> 账号</h3></div>
    <div class="card-body stack-sm">
      <button v-if="!selfHost" class="btn btn-block" @click="openPwd">
        <ui-icon name="lock" :size="16" /> 修改密码
      </button>
      <p v-else class="xs muted">自托管版暂不支持在页面上改密码；需要改密时在服务器上按部署文档操作。</p>
      <button class="btn btn-block btn-danger" @click="confirmLogout = true">
        <ui-icon name="logout" :size="16" /> 退出登录
      </button>
      <p class="xs muted">{{ selfHost ? '数据存放在你自己的服务器（Oracle Cloud）上，退出后重新登录即可。' : '初始密码是 123456，建议现在就换掉。退出登录会清空本页内存里的数据，重新登录再从云端拉。' }}</p>
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
    <div class="card-head"><h3><ui-icon name="history" :size="16" /> 数据导出</h3></div>
    <div class="card-body stack-sm">
      <button class="btn btn-block" @click="exportJson">
        <ui-icon name="download" :size="16" /> 导出当前数据（JSON 备份）
      </button>
      <button class="btn btn-block" @click="exportCsv('orders')">
        <ui-icon name="download" :size="16" /> 导出订单 CSV（Excel 分析）
      </button>
      <button class="btn btn-block" @click="exportCsv('items')">
        <ui-icon name="download" :size="16" /> 导出订单明细 CSV
      </button>
      <button class="btn btn-block" @click="exportCsv('products')">
        <ui-icon name="download" :size="16" /> 导出商品库存 CSV
      </button>
      <p class="xs muted">JSON 是全量备份（含订单、明细、流水、余额）；CSV 用来在 Excel 里看账分析。云端数据库是唯一数据源，建议定期导出备份。</p>
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
        <span class="muted">开单收款、订单跟踪、库存盘点、经营统计，一个页面管完一场市集。数据按字段存云端数据库，业务规则在服务端成套执行。</span>
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

  <ui-confirm v-if="confirmLogout" title="退出登录？"
              text="退出后本页不再显示数据，重新登录会从云端重新拉取。"
              confirm-text="退出" danger @yes="doLogout" @no="confirmLogout = false" />
</div>`
};
