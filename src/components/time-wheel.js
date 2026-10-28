const ROW = 44;
const pad = value => String(value).padStart(2, '0');
const readTime = value => { const [hour, minute] = value.split(':').map(Number); return { hour, minute }; };

export const UiTimeWheel = {
  name: 'UiTimeWheel',
  props: { modelValue: { type: String, required: true }, disabled: Boolean },
  emits: ['update:modelValue'],
  data() {
    const picked = readTime(this.modelValue);
    return { picked, positions: { hour: 24 + picked.hour, minute: 60 + picked.minute } };
  },
  computed: {
    columns() {
      return [{ key: 'hour', label: '小时', size: 24 }, { key: 'minute', label: '分钟', size: 60 }]
        .map(column => ({ ...column, values: Array.from({ length: column.size * 3 }, (_, index) => index % column.size) }));
    },
    value() { return pad(this.picked.hour) + ':' + pad(this.picked.minute); }
  },
  watch: {
    modelValue(value) {
      if (value === this.value) return;
      this.picked = readTime(value);
      this.$nextTick(this.align);
    }
  },
  mounted() { this._timers = {}; this.$nextTick(this.align); },
  beforeUnmount() { Object.values(this._timers).forEach(clearTimeout); },
  methods: {
    pad,
    track(key) { return this.$el.querySelector(`[data-time-wheel="${key}"]`); },
    align() {
      for (const column of this.columns) {
        const index = column.size + this.picked[column.key];
        this.positions[column.key] = index;
        this.track(column.key).scrollTop = index * ROW;
      }
    },
    onScroll(column, event) {
      if (this.disabled) return;
      const index = Math.max(0, Math.min(column.values.length - 1, Math.round(event.target.scrollTop / ROW)));
      this.positions[column.key] = index;
      this.picked[column.key] = column.values[index];
      this.$emit('update:modelValue', this.value);
      clearTimeout(this._timers[column.key]);
      this._timers[column.key] = setTimeout(() => {
        // 回到中间的一组数字，00 前也可继续向上滚到 23 / 59。
        if (index >= column.size && index < column.size * 2) return;
        const middle = column.size + this.picked[column.key];
        this.positions[column.key] = middle;
        this.track(column.key).scrollTop = middle * ROW;
      }, 160);
    },
    choose(column, index) {
      if (this.disabled) return;
      this.track(column.key).scrollTop = index * ROW;
      this.onScroll(column, { target: this.track(column.key) });
    },
    onKey(column, event) {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? column.size : event.key === 'End' ? column.size * 2 - 1
        : this.positions[column.key] + (event.key === 'ArrowUp' ? -1 : 1);
      this.choose(column, Math.max(0, Math.min(column.values.length - 1, index)));
    },
    optionStyle(column, index) {
      const distance = Math.max(-3, Math.min(3, index - this.positions[column.key]));
      return { transform: `perspective(220px) rotateX(${-distance * 18}deg) scale(${1 - Math.abs(distance) * .07})` };
    },
    commit() {
      for (const column of this.columns) this.onScroll(column, { target: this.track(column.key) });
    }
  },
  template: `
    <div class="time-wheel" role="group" aria-label="上下滑动修改收款时间" :class="{ 'is-disabled': disabled }">
      <div class="time-wheel-band" aria-hidden="true"></div>
      <div class="time-wheel-columns">
        <div class="time-wheel-track" v-for="column in columns" :key="column.key" :data-time-wheel="column.key"
             role="spinbutton" tabindex="0" :aria-label="column.label" :aria-valuenow="picked[column.key]" :aria-valuemin="0" :aria-valuemax="column.size - 1" :aria-disabled="disabled"
             @scroll.passive="onScroll(column, $event)" @keydown="onKey(column, $event)">
          <div class="time-wheel-option" v-for="(value, index) in column.values" :key="index"
               :class="{ 'is-selected': index === positions[column.key] }" :style="optionStyle(column, index)" @click="choose(column, index)">{{ pad(value) }}</div>
        </div>
      </div>
    </div>`
};
