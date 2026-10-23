let loader;
function loadWriter() {
  if (window.JsBarcode) return Promise.resolve(window.JsBarcode);
  if (!loader) loader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../../assets/vendor/jsbarcode-code128-3.12.1.min.js', import.meta.url).href;
    script.onload = () => resolve(window.JsBarcode);
    script.onerror = () => { script.remove(); loader = null; reject(new Error('条形码加载失败')); };
    document.head.appendChild(script);
  });
  return loader;
}
export const UiProductBarcode = {
  name: 'UiProductBarcode',
  props: { value: { type: String, default: '' } },
  data() { return { error: '', ready: false }; },
  mounted() { this.draw(); },
  watch: { value() { this.draw(); } },
  beforeUnmount() { this._drawId = (this._drawId || 0) + 1; },
  methods: {
    async draw() {
      const id = this._drawId = (this._drawId || 0) + 1;
      this.ready = false; this.error = '';
      if (!this.value) return;
      try {
        const write = await loadWriter();
        if (id !== this._drawId) return;
        write(this.$refs.svg, this.value, { format: 'CODE128', width: 2, height: 64, margin: 16, fontSize: 14, displayValue: true });
        this.ready = true;
      } catch { if (id === this._drawId) this.error = '暂时无法绘制条形码，请检查条码内容后重试。'; }
    },
    download() {
      if (!this.ready) return;
      const svg = this.$refs.svg.cloneNode(true);
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
      const link = document.createElement('a'); link.href = url; link.download = '商品条码-' + this.value.replace(/[^\w-]/g, '_') + '.svg'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  },
  template: `<div class="product-barcode">
    <div v-if="value" class="product-barcode-preview" role="img" :aria-label="'商品条形码 ' + value"><svg ref="svg"></svg></div>
    <p v-else class="field-hint">保存商品时自动生成唯一条码。</p>
    <p v-if="error" class="field-hint" role="alert">{{ error }}</p>
    <button v-if="ready" class="btn btn-sm" type="button" @click="download">下载条形码</button>
  </div>`
};
