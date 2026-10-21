/* 全局共享组件 */
import { ICONS } from './icons.js';

export const UiIcon = {
  name: 'UiIcon',
  props: {
    name: { type: String, required: true },
    size: { type: [Number, String], default: 18 },
    sw: { type: [Number, String], default: 1.8 }
  },
  computed: {
    body() { return ICONS[this.name] || ICONS.info; },
    px() { return typeof this.size === 'number' ? this.size + 'px' : this.size; }
  },
  template: `
    <svg :width="px" :height="px" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         :stroke-width="sw" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false" v-html="body"></svg>`
};

/* 底部抽屉（移动） / 居中对话框（桌面），Teleport 到 body 避免层叠问题 */
export const UiSheet = {
  name: 'UiSheet',
  components: { UiIcon },
  props: {
    title: { type: String, default: '' },
    subtitle: { type: String, default: '' },
    wide: { type: Boolean, default: false },
    xwide: { type: Boolean, default: false }
  },
  emits: ['close'],
  mounted() {
    this.onKey = e => { if (e.key === 'Escape') this.$emit('close'); };
    document.addEventListener('keydown', this.onKey);
    document.body.style.overflow = 'hidden';
  },
  unmounted() {
    document.removeEventListener('keydown', this.onKey);
    document.body.style.overflow = '';
  },
  template: `
    <Teleport to="body">
      <div class="sheet-mask" @click.self="$emit('close')" role="dialog" aria-modal="true" :aria-label="title">
        <div class="sheet" :class="{ 'sheet-wide': wide, 'sheet-xwide': xwide }">
          <div class="sheet-grab"></div>
          <div class="sheet-head">
            <h2>{{ title }}</h2>
            <span v-if="subtitle" class="small muted">{{ subtitle }}</span>
            <button class="btn btn-quiet btn-icon btn-sm" @click="$emit('close')" aria-label="关闭">
              <ui-icon name="close" :size="18" />
            </button>
          </div>
          <div class="sheet-body"><slot /></div>
          <div class="sheet-foot" v-if="$slots.foot"><slot name="foot" /></div>
        </div>
      </div>
    </Teleport>`
};

export const UiEmpty = {
  name: 'UiEmpty',
  components: { UiIcon },
  props: {
    icon: { type: String, default: 'info' },
    title: { type: String, default: '这里还是空的' },
    text: { type: String, default: '' }
  },
  template: `
    <div class="empty">
      <div class="empty-icon"><ui-icon :name="icon" :size="22" /></div>
      <div class="empty-title">{{ title }}</div>
      <div class="empty-text" v-if="text">{{ text }}</div>
      <slot />
    </div>`
};

export const UiStat = {
  name: 'UiStat',
  props: {
    label: String,
    value: [String, Number],
    foot: String,
    tone: { type: String, default: '' },   // '' | accent | ok | warn | danger
    to: { type: String, default: '' }      // 有值则整卡可点
  },
  emits: ['go'],
  template: `
    <div class="stat" :class="[tone ? 'stat-' + tone : '', to ? 'is-click' : '']"
         :role="to ? 'button' : null" :tabindex="to ? 0 : null"
         @click="to && $emit('go', to)"
         @keydown.enter="to && $emit('go', to)"
         @keydown.space.prevent="to && $emit('go', to)">
      <div class="stat-label">{{ label }}</div>
      <div class="stat-value"><slot name="value">{{ value }}</slot></div>
      <div class="stat-foot" v-if="foot || $slots.foot"><slot name="foot">{{ foot }}</slot></div>
    </div>`
};

/* 内联确认：替代 window.confirm，样式与全站一致 */
export const UiConfirm = {
  name: 'UiConfirm',
  components: { UiSheet },
  props: { title: String, text: String, confirmText: { type: String, default: '确定' }, danger: Boolean },
  emits: ['yes', 'no'],
  template: `
    <ui-sheet :title="title" @close="$emit('no')">
      <p class="small" style="line-height:1.6;color:var(--label-2)">{{ text }}</p>
      <template #foot>
        <button class="btn" @click="$emit('no')">取消</button>
        <button class="btn" :class="danger ? 'btn-danger' : 'btn-primary'" @click="$emit('yes')">{{ confirmText }}</button>
      </template>
    </ui-sheet>`
};

export function registerComponents(app) {
  app.component('UiIcon', UiIcon);
  app.component('UiSheet', UiSheet);
  app.component('UiEmpty', UiEmpty);
  app.component('UiStat', UiStat);
  app.component('UiConfirm', UiConfirm);
}
