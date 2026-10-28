import assert from 'node:assert/strict';
import { UiTimeWheel } from '../src/components/time-wheel.js';
const tracks = Object.fromEntries(['year', 'month', 'day', 'hour', 'minute'].map(key => [key, { scrollTop: 0, classList: { add() {}, remove() {} } }]));
const events = [];
const wheel = {
  ...UiTimeWheel.data.call({ modelValue: '2024-03-31T23:59' }), _timers: {}, disabled: false,
  $el: { querySelector: selector => tracks[selector.match(/="(.*?)"/)[1]] },
  $nextTick(callback) { callback(); }, $emit: (...args) => events.push(args)
};
for (const [key, method] of Object.entries(UiTimeWheel.methods)) wheel[key] = method.bind(wheel);
for (const [key, getter] of Object.entries(UiTimeWheel.computed)) Object.defineProperty(wheel, key, { get: getter.bind(wheel) });
const column = key => wheel.columns.find(item => item.key === key);
function choose(key, value) { const c = column(key); wheel.choose(c, (c.loop ? c.size : 0) + value - c.min); }
wheel.align();
choose('month', 2);
assert.equal(wheel.value, '2024-02-29T23:59');
wheel.commit();
assert.equal(wheel.value, '2024-02-29T23:59');
choose('year', 2025);
assert.equal(wheel.value, '2025-02-28T23:59');
wheel.onKey(column('hour'), { key: 'ArrowDown', preventDefault() {} });
wheel.onKey(column('minute'), { key: 'ArrowDown', preventDefault() {} });
assert.equal(wheel.value, '2025-02-28T00:00');
tracks.minute.scrollTop = (60 + 17) * 32;
wheel.commit();
assert.deepEqual(events.at(-1), ['update:modelValue', '2025-02-28T00:17']);
let prevented = false;
const start = { currentTarget: tracks.minute, touches: [{ clientX: 20, clientY: 100 }] };
wheel.onTouchStart(column('minute'), start);
wheel.onTouchMove(column('minute'), { currentTarget: tracks.minute, touches: [{ clientX: 20, clientY: 97 }], cancelable: true, preventDefault() { prevented = true; } });
assert.equal(prevented, true);
assert.equal(wheel.picked.minute, 17);
wheel.onTouchMove(column('minute'), { currentTarget: tracks.minute, touches: [{ clientX: 20, clientY: 68 }], cancelable: true, preventDefault() {} });
wheel.onTouchEnd(column('minute'), { currentTarget: tracks.minute });
assert.equal(wheel.picked.minute, 18);
wheel.onOptionClick(column('minute'), 0);
assert.equal(wheel.picked.minute, 18);
wheel.disabled = true;
choose('hour', 10);
assert.equal(wheel.picked.hour, 0);
UiTimeWheel.beforeUnmount.call(wheel);
console.log('年月日联动、闰年、循环边界、立即提交、轻触保护、拖动隔离及禁用检查通过');
