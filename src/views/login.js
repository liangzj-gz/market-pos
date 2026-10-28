/* ============================================================
   登录页

   云端版：手机号 + 密码；第一次用某个手机号时短信验证激活。
   自托管版（SELF_HOST_LOGIN）：手机号 + 密码；首次使用 =
   设密码直接建第一个账号（无短信，部署文档里有说明）。
   ============================================================ */

import { store, signIn, requestCode, activate, lastPhone, SELF_HOST_LOGIN } from '../data/store.js';

export const LoginView = {
  name: 'LoginView',
  data() {
    return {
      mode: 'login',            // login | setup
      phone: lastPhone(),
      password: '',
      code: '',
      initPassword: '123456',
      setupKey: '',
      verificationId: '',
      isExistingUser: false,
      sending: false,
      busy: false,
      countdown: 0,
      error: '',
      info: ''
    };
  },
  computed: {
    store() { return store; },
    selfHost() { return SELF_HOST_LOGIN; },
    phoneOk() { return this.selfHost ? this.phone.trim().length >= 3 : /^1\d{10}$/.test(this.phone); },
    canSend() { return this.phoneOk && !this.sending && this.countdown === 0; },
    shownError() { return this.error || store.auth.error || ''; },
    setupTabLabel() { return this.selfHost ? '首次建号' : '首次使用'; },
    modeHint() {
      if (this.mode === 'login') {
        return this.selfHost
          ? '用手机号和密码登录，数据存放在你自己的服务器上。'
          : '用手机号和密码登录，数据从云端拉取。';
      }
      return this.selfHost
        ? '服务器还没有账号时，在这里创建第一个账号（之后此入口自动关闭）。'
        : '这个号码第一次使用时，短信验证一次就能设好初始密码。';
    }
  },
  watch: {
    phone() { this.error = ''; }
  },
  methods: {
    switchMode(m) {
      if (this.mode === m) return;
      this.mode = m;
      this.error = '';
      this.info = '';
      this.password = '';
      this.code = '';
    },
    submit() {
      return this.mode === 'login' ? this.doLogin() : this.doActivate();
    },
    async doLogin() {
      this.error = '';
      if (!this.phoneOk) {
        this.error = this.selfHost ? '请输入账号（手机号）' : '请输入正确的 11 位手机号';
        return;
      }
      if (!this.password) { this.error = '请输入密码'; return; }
      this.busy = true;
      const res = await signIn(this.phone, this.password);
      this.busy = false;
      if (!res.ok) this.error = res.error || '登录失败，请重试';
    },
    async sendCode() {
      this.error = '';
      if (!this.phoneOk) { this.error = '请输入正确的 11 位手机号'; return; }
      this.sending = true;
      const res = await requestCode(this.phone);
      this.sending = false;
      if (!res.ok) { this.error = res.error; return; }
      this.verificationId = res.verificationId;
      this.isExistingUser = res.isExistingUser;
      this.info = '验证码已发送，5 分钟内有效';
      this.startCountdown();
    },
    startCountdown() {
      this.countdown = 60;
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => {
        this.countdown -= 1;
        if (this.countdown <= 0) { clearInterval(this.timer); this.timer = null; }
      }, 1000);
    },
    async doActivate() {
      this.error = '';
      if (!this.phoneOk) {
        this.error = this.selfHost ? '请输入账号（手机号）' : '请输入正确的 11 位手机号';
        return;
      }
      if (this.selfHost) {
        /* 自托管：直接建号（需要服务器 .env 里的 SETUP_KEY） */
        if ((this.initPassword || '').length < 6) { this.error = '密码至少 6 位'; return; }
        if (!this.setupKey.trim()) { this.error = '请输入建号密钥（见服务器 .env 的 SETUP_KEY）'; return; }
        this.busy = true;
        const res = await activate({ phone: this.phone, password: this.initPassword, setupKey: this.setupKey.trim() });
        this.busy = false;
        if (!res.ok) this.error = res.error || '创建账号失败，请重试';
        return;
      }
      if (!this.verificationId) { this.error = '请先获取短信验证码'; return; }
      if (!this.code.trim()) { this.error = '请输入短信验证码'; return; }
      if (!this.isExistingUser && this.initPassword.length < 6) { this.error = '密码至少 6 位'; return; }
      this.busy = true;
      const res = await activate({
        phone: this.phone,
        verificationId: this.verificationId,
        token: this.code.trim(),
        isExistingUser: this.isExistingUser,
        password: this.initPassword
      });
      this.busy = false;
      if (!res.ok) this.error = res.error || '验证失败，请重试';
    }
  },
  beforeUnmount() {
    if (this.timer) clearInterval(this.timer);
  },
  template: `
<div class="login-wrap">
  <div class="login-hero">
    <span class="login-mark"><ui-icon name="orders" :size="20" /></span>
    <div>
      <div class="login-title">摆摊订单管家</div>
      <div class="login-sub">市集收银台 · {{ selfHost ? '自托管版' : '云端同步' }}</div>
    </div>
  </div>

  <div class="card login-card">
    <div class="card-body">
      <div class="login-tabs">
        <button type="button" class="login-tab" :class="{ 'is-on': mode === 'login' }" @click="switchMode('login')">密码登录</button>
        <button type="button" class="login-tab" :class="{ 'is-on': mode === 'setup' }" @click="switchMode('setup')">{{ setupTabLabel }}</button>
      </div>
      <p class="login-hint xs muted">{{ modeHint }}</p>

      <form @submit.prevent="submit">
        <label class="field">
          <span class="field-label">手机号</span>
          <input class="input input-num" type="tel" inputmode="numeric" :maxlength="selfHost ? 20 : 11"
                 autocomplete="tel" :placeholder="selfHost ? '账号（手机号）' : '11 位手机号'" v-model.trim="phone">
        </label>

        <template v-if="mode === 'login'">
          <label class="field">
            <span class="field-label">密码</span>
            <input class="input" type="password" autocomplete="current-password"
                   placeholder="输入登录密码" v-model="password">
          </label>
        </template>

        <template v-else-if="selfHost">
          <label class="field">
            <span class="field-label">设置登录密码</span>
            <input class="input" type="password" autocomplete="new-password"
                   placeholder="至少 6 位" v-model="initPassword">
          </label>
          <label class="field">
            <span class="field-label">建号密钥</span>
            <input class="input" type="password" autocomplete="off"
                   placeholder="服务器 .env 里的 SETUP_KEY" v-model="setupKey">
          </label>
          <div class="pill-note" style="margin-bottom:14px">
            <ui-icon name="info" :size="16" />
            <div>密钥在服务器 ~/market-pos/.env 的 SETUP_KEY 一行；建好第一个账号后此入口自动失效。</div>
          </div>
        </template>

        <template v-else>
          <label class="field">
            <span class="field-label">短信验证码</span>
            <div class="code-row">
              <input class="input input-num" type="text" inputmode="numeric" maxlength="6"
                     autocomplete="one-time-code" placeholder="6 位验证码" v-model.trim="code">
              <button type="button" class="btn code-btn" :disabled="!canSend" @click="sendCode">
                {{ sending ? '发送中…' : (countdown ? countdown + ' 秒' : '获取验证码') }}
              </button>
            </div>
          </label>

          <label class="field" v-if="!isExistingUser">
            <span class="field-label">设置登录密码（初始 123456）</span>
            <input class="input" type="text" autocomplete="new-password"
                   placeholder="至少 6 位" v-model="initPassword">
          </label>

          <div class="pill-note" v-if="isExistingUser" style="margin-bottom:14px">
            <ui-icon name="info" :size="16" />
            <div>这个号码已经激活过，验证后直接进入，密码不变。进来后可在「设置 → 修改密码」换成新密码。</div>
          </div>
        </template>

        <p class="login-error" v-if="shownError">{{ shownError }}</p>
        <p class="login-info" v-if="info">{{ info }}</p>

        <button class="btn btn-primary btn-block btn-lg" type="submit" :disabled="busy">
          {{ busy ? (mode === 'login' ? '登录中…' : '处理中…') : (mode === 'login' ? '登录' : (selfHost ? '创建账号并进入' : '验证并进入')) }}
        </button>
      </form>

      <p class="login-foot xs muted">
        {{ selfHost ? '数据存放在你自己的服务器（Oracle Cloud）上。' : '换手机或换浏览器，用同一个手机号登录看到的是同一份数据。' }}
      </p>
    </div>
  </div>
</div>`
};
