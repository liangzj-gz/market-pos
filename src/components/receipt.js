/* 收款成功后的收据：撕边纸 + 等宽数字，像打出来的小票 */
import { UiSheet } from './index.js';
import { money, fmtDT, CHANNEL_TXT, STATUS_TXT } from '../util/format.js';

export const UiReceipt = {
  name: 'UiReceipt',
  components: { UiSheet },
  props: {
    result: { type: Object, required: true }   // { order, items, adjustment, alerts, pieces }
  },
  emits: ['close', 'again', 'go-orders'],
  computed: {
    order() { return this.result.order; },
    items() { return this.result.items || []; },
    adj() { return this.result.adjustment || null; },
    alerts() { return this.result.alerts || []; },
    channelTxt() { return CHANNEL_TXT[this.order.channel] || '—'; }
  },
  methods: { money, fmtDT },
  template: `
    <ui-sheet :title="order.status === 'paid' ? '收款成功' : '已挂单'" @close="$emit('close')">
      <div class="receipt">
        <div class="receipt-inner">
          <div class="rcp-head">
            <div class="rcp-shop">摆摊订单管家</div>
            <div class="rcp-no mono">{{ order.order_no }}</div>
          </div>
          <hr class="rule-dashed">
          <div class="rcp-line" v-for="(it, i) in items" :key="i">
            <span class="rcp-name">
              {{ it.product_name }}<i v-if="it.is_gift" class="rcp-gift">赠</i>
              <em v-if="it.quantity > 1" class="mono">×{{ it.quantity }}</em>
            </span>
            <span class="rcp-amt mono">{{ it.is_gift ? '0.00' : money(it.line_amount).slice(1) }}</span>
          </div>
          <hr class="rule-dashed">
          <div class="rcp-sum">
            <div class="rcp-row"><span>应收</span><b class="mono">{{ money(order.total_amount) }}</b></div>
            <div class="rcp-row" v-if="adj">
              <span>{{ adj.adjust_type }}</span>
              <b class="mono" :class="adj.amount < 0 ? 'neg' : 'pos'">{{ (adj.amount > 0 ? '+' : '') + money(adj.amount).replace('¥','¥') }}</b>
            </div>
            <div class="rcp-row rcp-total">
              <span>{{ order.status === 'paid' ? '实收（' + channelTxt + '）' : '待收款' }}</span>
              <b class="mono">{{ order.status === 'paid' ? money(order.paid_amount) : money(order.total_amount) }}</b>
            </div>
          </div>
          <hr class="rule-dashed">
          <div class="rcp-meta">
            <span>件数 <b class="mono">{{ order.item_count }}</b></span>
            <span>{{ fmtDT(order.paid_at || order.created_at) }}</span>
          </div>
          <div class="rcp-thanks">谢谢惠顾 · 欢迎再来</div>
        </div>
      </div>

      <div class="pill-note pill-note-warn" style="margin-top:12px" v-if="alerts.length">
        <ui-icon name="alert" :size="16" />
        <div>
          <b>这单触发了 {{ alerts.length }} 条库存预警</b>
          <div class="xs" style="margin-top:2px">
            <span v-for="(a, i) in alerts" :key="a.id">{{ i ? '、' : '' }}{{ a.product ? a.product.name : '商品' }}（余 {{ a.quantity }}）</span>
          </div>
        </div>
      </div>
      <div class="pill-note pill-note-ok" style="margin-top:12px" v-else-if="order.status === 'paid'">
        <ui-icon name="check" :size="16" />
        <div>库存已扣减 {{ order.item_count }} 件，账实同步完成。</div>
      </div>
      <div class="pill-note" style="margin-top:12px" v-else>
        <ui-icon name="clock" :size="16" />
        <div>已挂单，还没扣库存。收到钱后到「订单」页确认收款即可。</div>
      </div>

      <template #foot>
        <button class="btn" @click="$emit('go-orders')" v-if="order.status !== 'paid'">去看订单</button>
        <button class="btn btn-primary" @click="$emit('again')">
          <ui-icon name="plus" :size="17" /> 继续开下一单
        </button>
      </template>
    </ui-sheet>`
};
