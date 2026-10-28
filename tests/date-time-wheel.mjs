import assert from 'node:assert/strict';
import { UiDateTimeWheel, localDateTime } from '../src/components/date-time-wheel.js';

assert.equal(localDateTime(new Date(2024, 1, 29, 3, 5)), '2024-02-29T03:05');
const events = [];
const picker = {
  ...UiDateTimeWheel.data.call({ value: '2024-03-31T23:59' }),
  $el: { querySelector: () => null },
  $nextTick(callback) { callback.call(this); },
  $emit: (...args) => events.push(args)
};
for (const [key, method] of Object.entries(UiDateTimeWheel.methods)) picker[key] = method.bind(picker);
for (const [key, getter] of Object.entries(UiDateTimeWheel.computed)) Object.defineProperty(picker, key, { get: getter.bind(picker) });

picker.choose('month', 2);
assert.equal(picker.parts.day, 29);
picker.choose('year', 2025);
assert.equal(picker.parts.day, 28);
picker.choose('month', 4);
picker.choose('day', 30);
picker.choose('month', 2);
assert.equal(picker.parts.day, 28);
assert.equal(picker.draft, '2025-02-28T23:59');

const minutes = picker.columns.find(column => column.key === 'minute');
picker.onScroll(minutes, { target: { scrollTop: 36 * 17 } });
assert.equal(picker.parts.minute, 17);
picker.onScroll(minutes, { target: { scrollTop: 100000 } });
assert.equal(picker.parts.minute, 59);
picker.onScroll(minutes, { target: { scrollTop: -100 } });
assert.equal(picker.parts.minute, 0);
picker.onKey(minutes, { key: 'ArrowUp', preventDefault() {} });
assert.equal(picker.parts.minute, 0);
picker.onKey(minutes, { key: 'End', preventDefault() {} });
assert.equal(picker.parts.minute, 59);
picker.confirm();
assert.deepEqual(events.pop(), ['confirm', '2025-02-28T23:59']);
console.log('收款时间格式、闰年及大小月联动、滚轮边界、键盘操作和确认检查通过');
