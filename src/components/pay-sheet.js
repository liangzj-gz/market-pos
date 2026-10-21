/* 收款抽屉：新建订单收款 与 待收款订单补收，共用同一套差额校验（R1） */
import { UiSheet } from './index.js';
import { num, r2, money, moneyNum, ADJUST_TYPES, ADJUST_HINT, CHANNEL_TXT } from '../util/format.js';
import { roundingSuggestions } from '../domain/cart.js';

export const UiPaySheet = {
  name: 'UiPaySheet',
  components: { UiSheet },
  props: {
    total: { type: Number, required: true },
    pieces: { type: Number, default: 0 },
    defaultChannel: { type: String, default: 'wechat' },
    submitting: Boolean,
    title: { type: String, default: '收款' },
    orderNo: { type: String, default: '' }
  },
  emits: ['close', 'submit'],
  data() {
    return {
      channel: this.defaultChannel || 'wechat',
      paid: moneyNum(this.total),
      adjustType: '',
      adjustReason: '',
      err: ''
    };
  },
  computed: {
    totalNum() { return num(this.total); },
    paidNum() { return num(this.paid); },
    diff() { return r2(this.paidNum - this.totalNum); },
    hasDiff() { return this.diff !== 0; },
    suggestions() { return roundingSuggestions(this.totalNum); },
    adjustTypes() { return ADJUST_TYPES; },
    channelList() {
      return [
        { key: 'wechat', label: CHANNEL_TXT.wechat, icon: 'wechat' },
        { key: 'alipay', label: CHANNEL_TXT.alipay, icon: 'alipay' },
        { key: 'cash', label: CHANNEL_TXT.cash, icon: 'cash' }
      ];
    }
  },
  watch: {
    total(v) { if (!this.touched) this.paid = moneyNum(v); }
  },
  methods: {
    money, moneyNum,
    hint(t) { return ADJUST_HINT[t] || ''; },
    setPaid(v) { this.touched = true; this.paid = v === '' ? '' : String(v); this.err = ''; },
    bump(d) { this.setPaid(moneyNum(r2(this.paidNum + d))); },
    exact() { this.setPaid(moneyNum(this.totalNum)); },
    pickType(t) { this.adjustType = this.adjustType === t ? '' : t; this.err = ''; },
    submit() {
      if (this.paid === '' || isNaN(this.paidNum) || this.paidNum < 0) {
        this.err = '请填写实收金额'; return;
      }
      if (this.hasDiff && !this.adjustType) {
        this.err = '实收与应收差 ' + (this.diff > 0 ? '+' : '') + this.diff + ' 元，请先选择差额原因';
        return;
      }
      this.err = '';
      this.$emit('submit', {
        channel: this.channel,
        paidAmount: r2(this.paidNum),
        adjustType: this.hasDiff ? this.adjustType : null,
        adjustReason: this.hasDiff ? (this.adjustReason.trim() || ADJUST_HINT[this.adjustType] || null) : null
      });
    }
  },
  created() { this.touched = false; },
  template: `
    <ui-sheet :title="title" :subtitle="orderNo" @close="$emit('close')">
      <div class="pay-amount">
        <span class="pay-amount-label">应收</span>
        <span class="pay-amount-value"><i>¥</i>{{ moneyNum(total) }}</span>
        <span class="pay-amount-sub" v-if="pieces">{{ pieces }} 件商品</span>
      </div>

      <hr class="rule-dashed">

      <div class="field">
        <span class="field-label">收款渠道</span>
        <div class="channel-grid">
          <button v-for="c in channelList" :key="c.key" type="button"
                  class="channel" :class="{ 'is-on': channel === c.key }"
                  :aria-pressed="channel === c.key" @click="channel = c.key">
            <ui-icon :name="c.icon" :size="20" />
            <span>{{ c.label }}</span>
          </button>
        </div>
      </div>

      <div class="field">
        <span class="field-label">实收金额</span>
        <div class="paid-row">
          <span class="paid-cur">¥</span>
          <input class="input input-mono paid-input" type="number" inputmode="decimal" step="0.01" min="0"
                 :value="paid" @input="setPaid($event.target.value)" aria-label="实收金额">
        </div>
        <div class="chips" style="margin-top:9px">
          <button type="button" class="chip chip-brand" :aria-pressed="!hasDiff" @click="exact">
            <ui-icon name="check" :size="14" /> 刚好 {{ money(totalNum) }}
          </button>
          <button v-for="s in suggestions" :key="s.value" type="button" class="chip"
                  :aria-pressed="paidNum === s.value" @click="setPaid(moneyNum(s.value))">{{ s.label }}</button>
          <button type="button" class="chip" @click="bump(-1)">−1</button>
          <button type="button" class="chip" @click="bump(1)">＋1</button>
        </div>
      </div>

      <transition name="fold">
        <div v-if="hasDiff" class="diff-panel" :class="diff < 0 ? 'is-less' : 'is-more'">
          <div class="diff-head">
            <ui-icon :name="diff < 0 ? 'trendDown' : 'trendUp'" :size="16" />
            <span>实收{{ diff < 0 ? '少' : '多' }} <b class="mono">{{ money(Math.abs(diff)) }}</b></span>
            <span class="diff-tag">{{ diff < 0 ? '少收' : '多收' }}</span>
          </div>
          <p class="small" style="margin:2px 0 10px;opacity:.8">按规矩得选个原因，差额会单独记账，月底能对得上。</p>
          <div class="chips">
            <button v-for="t in adjustTypes" :key="t" type="button" class="chip"
                    :class="{ 'chip-brand': adjustType === t }" :aria-pressed="adjustType === t"
                    @click="pickType(t)">{{ t }}</button>
          </div>
          <p class="xs" style="margin-top:8px;opacity:.75" v-if="adjustType">{{ hint(adjustType) }}</p>
          <input class="input" style="margin-top:9px" placeholder="补充说明（选填）" v-model="adjustReason">
        </div>
      </transition>

      <div class="field-err" v-if="err">{{ err }}</div>

      <template #foot>
        <button class="btn" @click="$emit('close')" :disabled="submitting">取消</button>
        <button class="btn btn-primary btn-checkout" @click="submit" :disabled="submitting">
          <span v-if="submitting" class="spinner"></span>
          <template v-else>确认收款 {{ money(paidNum) }}</template>
        </button>
      </template>
    </ui-sheet>`
};
