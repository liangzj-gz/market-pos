const ROW = 32;
const pad = value => String(value).padStart(2, '0');
const readTime = value => {
  const [year, month, day, hour, minute] = value.split(/[-T:]/).map(Number);
  return { year, month, day, hour, minute };
};

export const UiTimeWheel = {
  name: 'UiTimeWheel',
  props: { modelValue: { type: String, required: true }, disabled: Boolean },
  emits: ['update:modelValue'],
  data() { return { picked: readTime(this.modelValue), positions: {} }; },
  computed: {
    columns() {
      const days = new Date(this.picked.year, this.picked.month, 0).getDate();
      return [
        { key: 'year', label: '年', min: 1900, max: Math.max(new Date().getFullYear(), this.picked.year), loop: false },
        { key: 'month', label: '月', min: 1, max: 12, loop: true },
        { key: 'day', label: '日', min: 1, max: days, loop: true },
        { key: 'hour', label: '时', min: 0, max: 23, loop: true },
        { key: 'minute', label: '分', min: 0, max: 59, loop: true }
      ].map(column => {
        const size = column.max - column.min + 1;
        return { ...column, size, values: Array.from({ length: size * (column.loop ? 3 : 1) }, (_, index) => column.min + index % size) };
      });
    },
    value() {
      const p = this.picked;
      return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
    }
  },
  watch: {
    modelValue(value) {
      if (value === this.value) return;
      this.picked = readTime(value);
      this.$nextTick(() => this.align());
    }
  },
  mounted() { this._timers = {}; this.$nextTick(() => this.align()); },
  beforeUnmount() { Object.values(this._timers).forEach(clearTimeout); this._touch = null; },
  methods: {
    pad,
    track(key) { return this.$el.querySelector(`[data-time-wheel="${key}"]`); },
    middleIndex(column) { return (column.loop ? column.size : 0) + this.picked[column.key] - column.min; },
    align(key) {
      for (const column of this.columns) {
        if (key && key !== column.key) continue;
        const index = this.middleIndex(column);
        this.positions[column.key] = index;
        const track = this.track(column.key);
        if (track) track.scrollTop = index * ROW;
      }
    },
    updatePart(column, value) {
      if (this.picked[column.key] === value) return;
      this.picked[column.key] = value;
      if (column.key === 'year' || column.key === 'month') {
        this.picked.day = Math.min(this.picked.day, new Date(this.picked.year, this.picked.month, 0).getDate());
        clearTimeout(this._timers.day);
        this.align('day');
        this.$nextTick(() => this.align('day'));
      }
    },
    onScroll(oldColumn, event) {
      if (this.disabled) return;
      const column = this.columns.find(item => item.key === oldColumn.key);
      const index = Math.max(0, Math.min(column.values.length - 1, Math.round(event.target.scrollTop / ROW)));
      this.positions[column.key] = index;
      this.updatePart(column, column.values[index]);
      this.$emit('update:modelValue', this.value);
      clearTimeout(this._timers[column.key]);
      this._timers[column.key] = setTimeout(() => {
        if (this._touch?.dragging || !column.loop || (index >= column.size && index < column.size * 2)) return;
        this.align(column.key);
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
      const start = column.loop ? column.size : 0;
      const index = event.key === 'Home' ? start : event.key === 'End' ? start + column.size - 1
        : this.positions[column.key] + (event.key === 'ArrowUp' ? -1 : 1);
      this.choose(column, Math.max(0, Math.min(column.values.length - 1, index)));
    },
    onTouchStart(column, event) {
      if (this.disabled || event.touches.length !== 1) return;
      const touch = event.touches[0];
      this._touch = { key: column.key, x: touch.clientX, y: touch.clientY, top: event.currentTarget.scrollTop, dragging: false };
    },
    onTouchMove(column, event) {
      const gesture = this._touch;
      if (!gesture || gesture.key !== column.key || event.touches.length !== 1) return;
      const dx = event.touches[0].clientX - gesture.x;
      const dy = event.touches[0].clientY - gesture.y;
      if (!gesture.dragging && Math.abs(dy) <= Math.abs(dx)) return;
      // 只接管从数字列内开始的纵向拖动，防止带动外层收款页。
      if (event.cancelable) event.preventDefault();
      if (!gesture.dragging && Math.abs(dy) < 8) return;
      gesture.dragging = true;
      event.currentTarget.classList.add('is-dragging');
      event.currentTarget.scrollTop = gesture.top - dy;
      this.onScroll(column, { target: event.currentTarget });
    },
    onTouchEnd(column, event) {
      const gesture = this._touch;
      if (!gesture || gesture.key !== column.key) return;
      this._touch = null;
      event.currentTarget.classList.remove('is-dragging');
      if (gesture.dragging) {
        this._ignoreClickUntil = Date.now() + 350;
        this.choose(column, this.positions[column.key]);
      }
    },
    onOptionClick(column, index) {
      if (Date.now() < (this._ignoreClickUntil || 0)) return;
      this.choose(column, index);
    },
    optionStyle(column, index) {
      const distance = Math.max(-2, Math.min(2, index - this.positions[column.key]));
      return { transform: `perspective(180px) rotateX(${-distance * 20}deg) scale(${1 - Math.abs(distance) * .08})` };
    },
    commit() {
      for (const column of this.columns) this.onScroll(column, { target: this.track(column.key) });
    }
  },
  template: `
    <div class="time-wheel" role="group" aria-label="上下滑动修改收款日期时间" :class="{ 'is-disabled': disabled }">
      <div class="time-wheel-band" aria-hidden="true"></div>
      <div class="time-wheel-columns">
        <div class="time-wheel-column" v-for="column in columns" :key="column.key">
          <span class="time-wheel-label">{{ column.label }}</span>
          <div class="time-wheel-track" :data-time-wheel="column.key" role="spinbutton" tabindex="0"
               :aria-label="column.label" :aria-valuenow="picked[column.key]" :aria-valuemin="column.min" :aria-valuemax="column.max" :aria-disabled="disabled"
               @scroll.passive="onScroll(column, $event)" @keydown="onKey(column, $event)"
               @touchstart.passive="onTouchStart(column, $event)" @touchmove="onTouchMove(column, $event)"
               @touchend="onTouchEnd(column, $event)" @touchcancel="onTouchEnd(column, $event)">
            <div class="time-wheel-option" v-for="(value, index) in column.values" :key="index"
                 :class="{ 'is-selected': index === positions[column.key] }" :style="optionStyle(column, index)" @click="onOptionClick(column, index)">{{ column.key === 'year' ? value : pad(value) }}</div>
          </div>
        </div>
      </div>
    </div>`
};
