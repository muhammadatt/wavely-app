<script setup>
import { computed } from 'vue'
import { useAuth } from '../../composables/useAuth.js'
import { PRO_BENEFITS } from '../../auth/pitch.js'
import AccountPlanCard from './AccountPlanCard.vue'

/**
 * The plan in full, what Pro includes, and where billing happens. Invoices,
 * the card and cancelling are Stripe's portal (Manage subscription); this
 * page says so rather than duplicating them.
 */
const { plan } = useAuth()
const isPro = computed(() => !!plan.value && plan.value !== 'free')
</script>

<template>
  <div class="flex flex-col gap-5">
    <div>
      <h1 class="acc-h1" tabindex="-1">Plan &amp; billing</h1>
      <p class="acc-lead mt-1">Manage or cancel your subscription here, any time.</p>
    </div>

    <AccountPlanCard />

    <section class="acc-card" aria-labelledby="acc-bill-incl">
      <h2 id="acc-bill-incl" class="acc-card-title">{{ isPro ? 'Included in your plan' : 'What Pro adds' }}</h2>
      <ul class="flex flex-col">
        <li v-for="b in PRO_BENEFITS" :key="b.id" class="acc-row">
          <span class="acc-benefit-icon" :class="`acc-benefit-icon--${b.icon}`" aria-hidden="true">
            <svg v-if="b.icon === 'star'" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.85 6.3 6.9.7-5.18 4.62 1.48 6.78L12 17.4l-6.05 3.5 1.48-6.78L2.25 9.5l6.9-.7z"/></svg>
            <svg v-else-if="b.icon === 'chain'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.7 4.5c2.2 0 3.6 1.2 4.3 2.4l1 1.5 1-1.5c.7-1.2 2.1-2.4 4.3-2.4 3.7 0 5.8 3.8 4.3 7.2C19.5 16.4 12 21 12 21z"/></svg>
          </span>
          <span class="min-w-0 flex flex-col gap-[2px]">
            <span class="text-[13px] font-bold text-[#eaf6f8]">{{ b.title }}</span>
            <span class="text-[12px] leading-[1.45] text-[rgba(255,255,255,.5)]">{{ b.desc }}</span>
          </span>
        </li>
      </ul>
    </section>

    <section class="acc-card" aria-labelledby="acc-bill-how">
      <h2 id="acc-bill-how" class="acc-card-title">How billing works</h2>
      <ul class="acc-body flex flex-col gap-[6px] list-disc pl-5">
        <li>Payments are handled by Stripe. We never see or store your card.</li>
        <li>Manage subscription lets you switch between monthly and yearly, update your card, download invoices and cancel.</li>
        <li>If you cancel, Pro stays on until the end of the period you’ve paid for. Your saved presets stay either way.</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.acc-benefit-icon {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.acc-benefit-icon svg {
  width: 17px;
  height: 17px;
}
.acc-benefit-icon--star {
  color: #f1d27a;
  background: rgba(224, 184, 74, 0.14);
  box-shadow: inset 0 0 0 1px rgba(224, 184, 74, 0.3);
}
.acc-benefit-icon--chain {
  color: var(--color-accent-bright);
  background: rgba(53, 211, 230, 0.12);
  box-shadow: inset 0 0 0 1px rgba(53, 211, 230, 0.28);
}
.acc-benefit-icon--heart {
  color: #ff8fa3;
  background: rgba(255, 110, 140, 0.13);
  box-shadow: inset 0 0 0 1px rgba(255, 110, 140, 0.3);
}
</style>
