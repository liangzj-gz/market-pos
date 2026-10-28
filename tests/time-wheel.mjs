import assert from 'node:assert/strict';
import { UiTimeWheel } from '../src/components/time-wheel.js';

const tracks = { hour: { scrollTop: 0 }, minute: { scrollTop: 0 } };
const events = [];
const wheel = {
  ...UiTimeWheel.data.call({ modelValue: '23:59' }),
  _timers: {}, disabled: false,
  $el: { querySelector: selector => tracks[selector.includes('hour') ? 'hour' : 'minute'] },
  $emit: (...args) => events.push(args)
};
for (const [key, method] of Object.entries(UiTimeWheel.methods)) wheel[key] = method.bind(wheel);
for (const [key, getter] of Object.entries(UiTimeWheel.computed)) Object.defineProperty(wheel, key, { get: getter.bind(wheel) });
wheel.align();
const [hour, minute] = wheel.columns;
wheel.choose(hour, 48);
wheel.choose(minute, 120);
assert.equal(wheel.value, '00:00');
wheel.onKey(hour, { key: 'ArrowUp', preventDefault() {} });
wheel.onKey(minute, { key: 'ArrowUp', preventDefault() {} });
assert.equal(wheel.value, '23:59');
tracks.minute.scrollTop = (60 + 17) * 44;
wheel.commit();
assert.equal(wheel.value, '23:17');
assert.deepEqual(events.at(-1), ['update:modelValue', '23:17']);
wheel.disabled = true;
wheel.choose(hour, 24);
assert.equal(wheel.value, '23:17');
UiTimeWheel.beforeUnmount.call(wheel);
console.log('时分循环边界、键盘调整、提交前读取滚动位置及禁用检查通过');
