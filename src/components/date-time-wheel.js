const pad = value => String(value).padStart(2, '0');
export function localDateTime(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const parse = value => {
  const [year, month, day, hour, minute] = (value || localDateTime()).split(/[-T:]/).map(Number);
  return { year, month, day, hour, minute };
};
const range = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);

export const UiDateTimeWheel = {
  name: 'UiDateTimeWheel',
  props: { value: { type: String, required: true } },
  emits: ['confirm', 'cancel'],
  data() { return { parts: parse(this.value) }; },
  computed: {
    days() { return new Date(this.parts.year, this.parts.month, 0).getDate(); },
    columns() {
      return [
        { key: 'year', label: '年', values: range(Math.min(1900, this.parts.year), new Date().getFullYear()) },
        { key: 'month', label: '月', values: range(1, 12) },
        { key: 'day', label: '日', values: range(1, this.days) },
        { key: 'hour', label: '时', values: range(0, 23) },
        { key: 'minute', label: '分', values: range(0, 59) }
      ];
    },
    draft() {
      const p = this.parts;
      return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
    }
  },
  mounted() { this.$nextTick(this.align); },
  methods: {
    pad,
    align(key) {
      for (const column of this.columns) {
        if (key && column.key !== key) continue;
        const wheel = this.$el.querySelector(`[data-wheel="${column.key}"]`);
        if (wheel) wheel.scrollTop = column.values.indexOf(this.parts[column.key]) * 36;
      }
    },
    choose(key, value) {
      this.parts[key] = value;
      if (key === 'year' || key === 'month') {
        this.parts.day = Math.min(this.parts.day, this.days);
        this.$nextTick(() => this.align('day'));
      }
    },
    onScroll(column, event) {
      const index = Math.max(0, Math.min(column.values.length - 1, Math.round(event.target.scrollTop / 36)));
      const value = column.values[index];
      if (this.parts[column.key] !== value) this.choose(column.key, value);
    },
    onClick(column, value) {
      this.choose(column.key, value);
      this.align(column.key);
    },
    onKey(column, event) {
      const index = column.values.indexOf(this.parts[column.key]);
      const moves = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 };
      let next;
      if (event.key in moves) next = Math.max(0, Math.min(column.values.length - 1, index + moves[event.key]));
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = column.values.length - 1;
      else return;
      event.preventDefault();
      this.onClick(column, column.values[next]);
    },
    useNow() { this.parts = parse(localDateTime()); this.$nextTick(this.align); },
    confirm() {
      // 读取最后的滚动位置，快速滑动后立即点完成也能提交当前选择。
      for (const column of this.columns) {
        const wheel = this.$el.querySelector(`[data-wheel="${column.key}"]`);
        if (wheel) this.onScroll(column, { target: wheel });
      }
      this.$emit('confirm', this.draft);
    }
  },
  template: `
    <div class="date-time-wheel" role="group" aria-label="选择收款日期时间">
      <div class="date-time-wheel-top"><span>{{ draft.replace('T', ' ') }}</span><button class="btn btn-quiet btn-sm" type="button" @click="useNow">当前时间</button></div>
      <div class="date-time-wheel-columns">
        <div class="date-time-wheel-column" v-for="column in columns" :key="column.key">
          <span class="date-time-wheel-label">{{ column.label }}</span>
          <div class="date-time-wheel-track" :data-wheel="column.key" role="spinbutton" tabindex="0"
               :aria-label="column.label" :aria-valuenow="parts[column.key]" :aria-valuemin="column.values[0]" :aria-valuemax="column.values[column.values.length - 1]"
               @scroll.passive="onScroll(column, $event)" @keydown="onKey(column, $event)">
            <div v-for="value in column.values" :key="value" class="date-time-wheel-option" :class="{ 'is-selected': parts[column.key] === value }" @click="onClick(column, value)">{{ column.key === 'year' ? value : pad(value) }}</div>
          </div>
        </div>
      </div>
      <div class="date-time-wheel-actions"><button class="btn btn-sm" type="button" @click="$emit('cancel')">取消</button><button class="btn btn-primary btn-sm" type="button" @click="confirm">完成</button></div>
    </div>`
};
