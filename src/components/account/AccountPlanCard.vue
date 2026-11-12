<script setup>
import { computed } from 'vue'
import { useAuth } from '../../composables/useAuth.js'
import { useBilling } from '../../composables/useBilling.js'
import { planSummary } from '../../auth/accountSummary.js'

/**
 * The plan, its state and the one action that matters for it: Manage
 * subscription (Stripe's portal, in its own tab) or Upgrade to Pro (the
 * upgrade dialog, over the dashboard). `compact` drops the explanation and
 * adds a "Details" link, for the Overview.
 */
defineProps({ compact: { type: Boolean, default: false } })
const emit = defineEmits(['details'])

const auth = useAuth()
const { state, plan } = auth
const billing = useBilling()
const summary = computed(() => planSummary(plan.value, state.account?.subscription))
</script>

<template>
  <section
    class="acc-card"
    :class="{ 'acc-card--pro': summary.paid, 'acc-card--warn': summary.state === 'pastDue' }"
    aria-labelledby="acc-plan-title"
  >
    <div class="flex items-center gap-[10px] flex-wrap">
      <h2 id="acc-plan-title" class="sr-only">Plan</h2>
      <span v-if="summary.paid" class="acc-badge">
        <svg viewBox="0 0 24 24" class="w-[10px] h-[10px]" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6z"/></svg>
        {{ summary.label.toUpperCase() }}
      </span>
      <span v-else class="text-[15px] font-extrabold text-[#eaf6f8]">{{ summary.label }}</span>
      <span class="text-[13px]" :class="summary.state === 'pastDue' ? 'acc-warn-text' : 'text-[rgba(255,255,255,.75)]'">{{ summary.status }}</span>
      <button v-if="compact" class="acc-link ml-auto" @click="emit('details')">Details →</button>
    </div>
    <p v-if="!compact" class="acc-body">{{ summary.detail }}</p>
    <div v-if="state.accountError" class="acc-error" role="alert">Couldn’t load your plan: {{ state.accountError }}</div>
    <div v-if="billing.state.error" class="acc-error" role="alert">{{ billing.state.error }}</div>
    <div class="flex items-center gap-3 flex-wrap">
      <button
        v-if="summary.canManage"
        class="acc-btn acc-btn--gold"
        :disabled="billing.state.busy"
        @click="billing.manage()"
      >
        <span v-if="billing.state.busy" class="acc-spinner" aria-hidden="true"></span>
        {{ billing.state.busy ? 'Opening secure portal…' : summary.state === 'pastDue' ? 'Update payment method' : 'Manage subscription' }}
      </button>
      <button v-else class="acc-btn acc-btn--gold" @click="auth.openUpgrade()">Upgrade to Pro</button>
      <span v-if="summary.canManage && !compact" class="acc-fine max-w-[340px]">
        Opens Stripe’s secure billing portal in a new tab. Your edits stay put, and this page updates when you’re done.
      </span>
    </div>
  </section>
</template>
