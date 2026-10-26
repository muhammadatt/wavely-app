<script setup>
import { computed, ref, onMounted } from 'vue'
import { useAuth } from '../composables/useAuth.js'
import { useBilling } from '../composables/useBilling.js'
import { useModalFocus } from '../composables/useModalFocus.js'
import { FEATURES, FREE_PREVIEW_SECONDS, PLAN_LABELS } from '../auth/plans.js'
import { formatPrice } from '../auth/billing.js'
import { OPERATIONS } from '../ui/registry.js'

/**
 * "This needs Pro" — or, opened from the account menu with no feature,
 * "Upgrade to Pro". Opened by `useEntitlements().request()`, by a server 402
 * and by the account menu. Says what the feature is, what is free about it,
 * and the next step: an account first when signed out, otherwise Checkout,
 * monthly or yearly, in a new tab (src/auth/billing.js says why a tab).
 *
 * With billing not configured on the server the button says "coming soon"
 * rather than leading nowhere.
 */
const auth = useAuth()
const { state, isSignedIn } = auth
const billing = useBilling()

const feature = computed(() => FEATURES[state.upgradeFor] ?? null)
const planLabel = computed(() => PLAN_LABELS[feature.value?.requires ?? 'pro'] ?? 'Pro')
const title = computed(() => (feature.value
  ? `${feature.value.label} is a ${planLabel.value} feature`
  : `Upgrade to ${planLabel.value}`))

const interval = ref('yearly')
const offers = computed(() => {
  const byInterval = Object.fromEntries(billing.state.prices.filter(p => p.plan === 'pro').map(p => [p.interval, p]))
  return ['monthly', 'yearly'].filter(i => byInterval[i]).map(i => ({
    interval: i,
    label: i === 'monthly' ? 'Monthly' : 'Yearly',
    price: `${formatPrice(byInterval[i].amount, byInterval[i].currency)}${i === 'monthly' ? '/mo' : '/yr'}`,
  }))
})
const canCheckout = computed(() => billing.state.enabled && offers.value.length > 0)

onMounted(async () => {
  await billing.loadPrices()
  if (!offers.value.some(o => o.interval === interval.value)) interval.value = offers.value[0]?.interval ?? 'monthly'
})

async function checkout() {
  const { error } = await billing.upgrade(interval.value)
  // Checkout runs in its own tab; this tab picks the new plan up when it returns.
  if (!error) close()
}

async function manageBilling() {
  const { error } = await billing.manage()
  if (!error) close()
}

const freeNote = computed(() => {
  if (!feature.value) {
    // From the registry, not the feature table: only operations this build
    // actually ships are advertised (a dev-only plugin is not a selling point).
    const unlocks = OPERATIONS.filter(op => op.feature && FEATURES[op.feature]?.requires === 'pro').map(op => op.label)
    return unlocks.length ? `${planLabel.value} unlocks: ${unlocks.join(', ')}.` : ''
  }
  if (feature.value.preview) {
    return `Preview is free on up to ${FREE_PREVIEW_SECONDS} seconds of audio. Applying it to the whole selection needs ${planLabel.value}.`
  }
  if (state.upgradeFor === 'pluginChainApply') {
    return 'Upgrade now to apply this chain to your audio.'
  }
  return ''
})

function close() {
  auth.closeUpgrade()
}

function account(mode) {
  auth.closeUpgrade()
  auth.openDialog(mode)
}

// Focus moves in on open, Tab stays inside, and focus returns to the opener.
const root = ref(null)
const { trapTab } = useModalFocus(root)

function onKeydown(e) {
  trapTab(e)
  e.stopPropagation()
  if (e.key === 'Escape') close()
}
</script>

<template>
  <!-- z 690: above every floating window (500 and up, one step per window) —
       these open FROM a plugin window — and below the command palette. -->
  <div
    ref="root"
    class="fixed inset-0 z-[690] flex items-start justify-center pt-[14vh] px-4"
    style="background:rgba(5,7,9,.6);backdrop-filter:blur(5px)"
    tabindex="-1"
    @click.self="close"
    @keydown="onKeydown"
  >
    <div
      class="w-full max-w-[380px] rounded-[18px] overflow-hidden font-['Inter']"
      style="background:linear-gradient(155deg,#181c22,#0d1013);box-shadow:0 24px 60px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.07);animation:bounceIn .28s cubic-bezier(.34,1.4,.64,1) both"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <div class="px-6 pt-[22px] pb-6">
        <div class="flex items-center gap-2">
          <span
            class="font-['JetBrains_Mono'] text-[9px] font-bold tracking-[0.1em] px-[6px] py-[3px] rounded-[5px]"
            style="color:#08161a;background:#e0b84a"
          >{{ planLabel.toUpperCase() }}</span>
          <button
            class="ml-auto w-[26px] h-[26px] -mr-1 rounded-[7px] flex items-center justify-center transition-colors hover:bg-[rgba(255,255,255,.08)]"
            style="color:rgba(255,255,255,.5)"
            aria-label="Close"
            @click="close"
          >
            <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        <div class="mt-3 text-[16px] font-bold text-[#eaf6f8]">{{ title }}</div>
        <div v-if="freeNote" class="mt-2 text-[12.5px] leading-[1.5] text-[rgba(255,255,255,.55)]">{{ freeNote }}</div>

        <template v-if="!isSignedIn">
          <div class="mt-4 text-[12.5px] leading-[1.5] text-[rgba(255,255,255,.55)]">
            Create a free account first — you can upgrade from it.
          </div>
          <button class="up-btn up-btn--primary mt-4" data-autofocus @click="account('signUp')">Create account</button>
          <button class="up-btn up-btn--ghost mt-2" @click="account('signIn')">Sign in</button>
        </template>
        <template v-else-if="canCheckout">
          <div class="mt-4 grid gap-2" :style="{ gridTemplateColumns: `repeat(${offers.length}, 1fr)` }" role="radiogroup" aria-label="Billing period">
            <button
              v-for="o in offers"
              :key="o.interval"
              class="up-offer"
              :class="{ 'is-on': interval === o.interval }"
              role="radio"
              :aria-checked="String(interval === o.interval)"
              @click="interval = o.interval"
            >
              <span class="up-offer-label">{{ o.label }}</span>
              <span class="up-offer-price">{{ o.price }}</span>
            </button>
          </div>
          <div v-if="billing.state.error" class="mt-3 text-[12px] leading-[1.45]" style="color:var(--color-danger)" role="alert">
            {{ billing.state.error }}
            <button
              v-if="/already have an active subscription/i.test(billing.state.error)"
              class="underline ml-1"
              @click="manageBilling"
            >Manage billing</button>
          </div>
          <button class="up-btn up-btn--primary mt-4" data-autofocus :disabled="billing.state.busy" @click="checkout">
            {{ billing.state.busy ? 'Opening checkout…' : `Upgrade to ${planLabel}` }}
          </button>
          <div class="mt-2 text-[11px] text-center text-[rgba(255,255,255,.4)]">Secure checkout by Stripe opens in a new tab.</div>
          <button class="up-btn up-btn--ghost mt-3" @click="close">Not now</button>
        </template>
        <template v-else>
          <button class="up-btn up-btn--primary mt-5" disabled :title="billing.state.loading ? 'Loading prices…' : 'Checkout is not open yet'">
            {{ billing.state.loading ? 'Loading…' : `Upgrade to ${planLabel} — coming soon` }}
          </button>
          <button class="up-btn up-btn--ghost mt-2" data-autofocus @click="close">Not now</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.up-offer {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  transition: border-color 0.15s, background 0.15s;
}
.up-offer.is-on {
  background: rgba(53, 211, 230, 0.09);
  border-color: rgba(53, 211, 230, 0.6);
}
.up-offer-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--color-text-dim);
}
.up-offer-price {
  font-size: 15px;
  font-weight: 800;
  color: var(--color-text);
}
.up-btn {
  width: 100%;
  height: 40px;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 700;
  transition: background 0.15s, opacity 0.15s;
}
.up-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.up-btn--primary {
  background: var(--color-accent);
  color: #08161a;
}
.up-btn--primary:not(:disabled):hover {
  background: var(--color-accent-bright);
}
.up-btn--ghost {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--color-text);
}
.up-btn--ghost:hover {
  background: rgba(255, 255, 255, 0.1);
}
</style>
