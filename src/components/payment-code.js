export const UiPaymentCode = {
  name: 'UiPaymentCode',
  props: { code: { type: String, default: '' }, channel: { type: String, required: true }, amount: { type: Number, default: null } },
  data() { return { expanded: false }; },
  computed: { label() { return this.channel === 'wechat' ? '微信' : '支付宝'; } },
  watch: { channel() { this.expanded = false; } },
  methods: {
    expand() { this.expanded = true; this.$nextTick(() => this.$refs.overlay?.focus()); },
    collapse() { this.expanded = false; this.$nextTick(() => this.$refs.open?.focus()); }
  },
  template: `<div class="payment-code" :class="'payment-code-' + channel">
    <template v-if="code">
      <button class="payment-code-open" ref="open" type="button" @click="expand" :aria-label="'放大' + label + '收款码'">
        <img :src="code" :alt="label + '收款码'" decoding="async">
        <span>{{ label }}扫码支付 · 点击放大</span>
      </button>
      <p class="field-hint">请顾客核对收款人，按实收金额付款。到账后再点击「确认收款」。</p>
      <Teleport to="body"><div v-if="expanded" ref="overlay" class="payment-code-overlay" role="dialog" aria-modal="true" :aria-label="label + '收款码大图'" tabindex="-1" @keydown.esc.stop="collapse">
        <div class="payment-code-large-head"><strong>{{ label }}扫码支付</strong><button class="btn" type="button" @click="collapse" aria-label="关闭收款码大图">返回收款</button></div>
        <p v-if="amount !== null" class="payment-code-amount">请支付 <b>¥{{ Number(amount).toFixed(2) }}</b></p>
        <img :src="code" :alt="label + '收款码大图'">
        <p class="small muted">扫码后请核对收款人及金额</p>
      </div></Teleport>
    </template>
    <p v-else class="field-hint">尚未配置{{ label }}收款码，请到「设置 → 收款码」上传。</p>
  </div>`
};

export function readPaymentCode(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return Promise.reject(new Error('请选择 JPG、PNG 或 WebP 收款码图片'));
  if (file.size > 3 * 1024 * 1024) return Promise.reject(new Error('收款码图片请小于 3MB'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片失败，请重试'));
    reader.readAsDataURL(file);
  });
}
