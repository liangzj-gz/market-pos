import { createScanGate, normalizeBarcode } from '../domain/barcode.js';

let decoderPromise;
function loadDecoder() {
  if (window.ZXingBrowser) return Promise.resolve(window.ZXingBrowser);
  if (!decoderPromise) {
    decoderPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('../../assets/vendor/zxing-browser-0.1.5.min.js', import.meta.url).href;
      script.onload = () => resolve(window.ZXingBrowser);
      script.onerror = () => { script.remove(); decoderPromise = null; reject(new Error('扫码组件加载失败，请重试')); };
      document.head.appendChild(script);
    });
  }
  return decoderPromise;
}

export const UiBarcodeScanner = {
  name: 'UiBarcodeScanner',
  props: { feedback: { type: String, default: '' }, tone: { type: String, default: 'info' }, successKey: { type: Number, default: 0 }, active: { type: Boolean, default: true }, items: { type: Array, default: null } },
  emits: ['scan'],
  data() { return { manual: '', starting: false, running: false, confirming: false, error: '', cameras: [], deviceId: '' }; },
  watch: { successKey() { this.showSuccess(); }, active(value) { if (value) this.start(); else this.stop(); } },
  mounted() {
    this._generation = 0;
    this._visibility = () => { if (document.hidden) this.stop(); };
    document.addEventListener('visibilitychange', this._visibility);
    this._pagehide = () => this.stop();
    window.addEventListener('pagehide', this._pagehide);
    if (this.active !== false) this.start();
  },
  beforeUnmount() {
    this.stop();
    document.removeEventListener('visibilitychange', this._visibility);
    window.removeEventListener('pagehide', this._pagehide);
  },
  methods: {
    showSuccess() {
      clearTimeout(this._successTimer);
      this.confirming = true;
      this._successTimer = setTimeout(() => { this.confirming = false; }, 500);
      this.flashSuccess();
    },
    async flashSuccess() {
      if (!this.running || this.active === false || this._torchTrack) return;
      const track = this._stream?.getVideoTracks?.()[0];
      const generation = this._generation;
      try {
        const torch = track?.getCapabilities?.().torch;
        if (!(torch === true || (Array.isArray(torch) && torch.includes(true)))) return;
        this._torchTrack = track;
        await track.applyConstraints({ advanced: [{ torch: true }] });
        // 开灯请求可能在关闭扫码或切换镜头后才完成，及时关掉旧镜头的灯。
        if (generation !== this._generation || this._torchTrack !== track) {
          await track.applyConstraints({ advanced: [{ torch: false }] });
          return;
        }
        this._torchTimer = setTimeout(() => this.stopFlash(), 150);
      } catch {
        // 不支持或系统拒绝闪光灯时，保留原有录入和屏幕成功提示。
        if (this._torchTrack === track) this.stopFlash();
      }
    },
    stopFlash() {
      clearTimeout(this._torchTimer);
      this._torchTimer = null;
      const track = this._torchTrack;
      this._torchTrack = null;
      if (track) {
        try { Promise.resolve(track.applyConstraints({ advanced: [{ torch: false }] })).catch(() => {}); }
        catch { /* 旧镜头已停止时无需继续控制闪光灯。 */ }
      }
    },
    stop() {
      clearTimeout(this._successTimer);
      this.confirming = false;
      this._generation++;
      this.stopFlash();
      this._controls?.stop(); this._controls = null;
      this._stream?.getTracks().forEach(track => track.stop()); this._stream = null;
      if (this.$refs.video) this.$refs.video.srcObject = null;
      this.starting = false; this.running = false;
    },
    async start() {
      if (this.active === false) return;
      this.stop(); this.error = '';
      if (!window.isSecureContext) { this.error = '摄像头需要 HTTPS 访问，请使用线上地址；也可在下方输入条码。'; return; }
      if (!navigator.mediaDevices?.getUserMedia) { this.error = '当前浏览器无法打开摄像头，请使用 Safari 或 Chrome，或手动输入条码。'; return; }
      const generation = this._generation;
      const current = () => generation === this._generation;
      this.starting = true;
      const gate = createScanGate();
      try {
        // 由本组件持有流，关闭抽屉、切页或迟到的授权都能及时释放摄像头。
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false, video: this.deviceId ? { deviceId: { exact: this.deviceId } }
            : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        if (!current()) { stream.getTracks().forEach(t => t.stop()); return; }
        this._stream = stream;
        const ZXing = await loadDecoder();
        if (!current()) return;
        const reader = new ZXing.BrowserMultiFormatOneDReader(undefined, { delayBetweenScanAttempts: 180, delayBetweenScanSuccess: 200 });
        const controls = await reader.decodeFromStream(stream, this.$refs.video, (result, error) => {
          if (!current() || this.confirming) return;
          if (result) {
            const code = result.getText();
            if (gate(code)) this.$emit('scan', code);
          } else if (error?.constructor?.kind === 'NotFoundException' || error?.name === 'NotFoundException') gate('');
        });
        if (!current()) { controls.stop(); return; }
        this._controls = controls; this.running = true;
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          if (current()) this.cameras = devices.filter(d => d.kind === 'videoinput');
        } catch { /* 摄像头列表不可用时继续使用当前镜头。 */ }
      } catch (e) {
        if (!current()) return;
        this.stop();
        this.error = e.name === 'NotAllowedError' ? '未获得摄像头权限，请在浏览器设置中允许摄像头后重试。'
          : e.name === 'NotFoundError' ? '没有找到摄像头，可手动输入条码。'
          : e.name === 'NotReadableError' ? '摄像头可能正在被其他应用使用，请关闭后重试。'
          : '摄像头启动失败，请重试或手动输入条码。';
      } finally { if (current()) this.starting = false; }
    },
    submitManual() {
      if (this.confirming || this.active === false) return;
      const code = normalizeBarcode(this.manual);
      if (!code) return;
      this.$emit('scan', code); this.manual = '';
    }
  },
  template: `
  <div class="barcode-scanner">
    <div class="barcode-camera" :class="{ 'is-running': running }">
      <video ref="video" autoplay muted playsinline aria-label="条码摄像头预览"></video>
      <div v-if="!running" class="barcode-camera-hint">{{ starting ? '正在申请摄像头权限…' : '开启后置摄像头，对准商品条形码' }}</div>
      <div v-else class="barcode-frame" aria-hidden="true"></div>
      <div v-if="confirming" class="barcode-success" aria-hidden="true">
        <span class="barcode-success-icon"><svg viewBox="0 0 48 48" fill="none"><path d="M12 25l8 8 17-18" /></svg></span>
        <strong>已加入本单</strong>
      </div>
    </div>
    <p v-if="items !== null" class="barcode-message barcode-feedback" :class="'is-' + tone" role="status" aria-live="polite" aria-atomic="true">{{ feedback || '支持 Code 128、EAN、UPC 等商品条码。' }}</p>
    <section v-if="items !== null" class="barcode-summary" aria-label="本单商品汇总">
      <div class="barcode-summary-head"><strong>本单商品</strong><span>{{ items.length }} 种 · 当前数量</span></div>
      <div v-if="items.length" class="barcode-summary-list" tabindex="0" role="region" aria-label="商品数量列表">
        <table>
          <thead><tr><th scope="col">商品</th><th scope="col">数量</th></tr></thead>
          <tbody><tr v-for="item in items" :key="item.id">
            <td>{{ item.name }}</td><td><b class="mono">{{ item.qty }}</b><span>{{ item.unit }}</span></td>
          </tr></tbody>
        </table>
      </div>
      <p v-else class="barcode-summary-empty">还未加入商品，扫码后在这里查看数量</p>
    </section>
    <div class="barcode-camera-actions">
      <button class="btn btn-sm btn-primary" v-if="!running && !starting" @click="start" :disabled="!active">开启摄像头</button>
      <button class="btn btn-sm" v-else @click="stop">{{ starting ? '取消启动' : '暂停扫码' }}</button>
      <select v-if="cameras.length > 1 && !starting" class="select" v-model="deviceId" @change="start" aria-label="选择摄像头">
        <option value="">自动选择后置摄像头</option>
        <option v-for="(camera, index) in cameras" :key="camera.deviceId" :value="camera.deviceId">{{ camera.label || '摄像头 ' + (index + 1) }}</option>
      </select>
    </div>
    <p v-if="error" class="barcode-message is-warn" role="alert">{{ error }}</p>
    <p v-if="items === null" class="barcode-message" :class="'is-' + tone" role="status" aria-live="polite">{{ feedback || '支持 Code 128、EAN、UPC 等商品条码。' }}</p>
    <p class="field-hint">同一条码停留在镜头中只录入一次；移开约 1 秒后重新扫入可再次录入。</p>
    <form class="barcode-manual" @submit.prevent="submitManual">
      <input class="input input-mono" v-model="manual" placeholder="也可手动输入条码" aria-label="手动输入商品条码" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="btn" type="submit" :disabled="!active || confirming || !manual.trim()">确认</button>
    </form>
  </div>`
};
