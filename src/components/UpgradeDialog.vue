<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useAuth } from '../composables/useAuth.js'
import { useBilling } from '../composables/useBilling.js'
import { useModalFocus } from '../composables/useModalFocus.js'
import { FEATURES, PLAN_LABELS } from '../auth/plans.js'
import { formatPrice } from '../auth/billing.js'
import { offerFraming, proBenefits } from '../auth/pitch.js'
import { OPERATIONS } from '../ui/registry.js'

/**
 * "This needs Pro" — or, opened from the account menu with no feature,
 * "Upgrade to Pro". Opened by `useEntitlements().request()`, by a server 402,
 * by the top bar and by the account menu.
 *
 * Four views, one dialog:
 *   offer     what Pro unlocks (the feature that opened it first), the two
 *             prices with the yearly saving spelled out, one button.
 *             Signed out it is the SAME offer — prices are shown before the
 *             account is asked for — and the button is "create account &
 *             continue"; the store reopens this dialog once the account exists
 *             (`signUpThenUpgrade`).
 *   waiting   Checkout is open in its own tab (src/auth/billing.js says why a
 *             tab). This tab says so and waits: the return broadcasts an
 *             account change, and the plan flipping to Pro moves on to…
 *   success   …"You're on Pro", naming what just unlocked. Previously the
 *             dialog closed the moment Checkout opened, and the editor tab
 *             never acknowledged the purchase at all.
 *   soon      billing is not configured on the server: no dead button.
 */
const auth = useAuth()
const { state, isSignedIn, plan } = auth
const billing = useBilling()

const featureId = computed(() => state.upgradeFor)
const feature = computed(() => FEATURES[featureId.value] ?? null)
const planLabel = computed(() => PLAN_LABELS[feature.value?.requires ?? 'pro'] ?? 'Pro')
const isPro = computed(() => plan.value === 'pro')

const view = ref(isPro.value ? 'success' : 'offer')
// Opened by an account that already has Pro (a stale prompt): say so plainly.
const alreadyPro = ref(isPro.value)

const title = computed(() => (feature.value
  ? `Unlock ${feature.value.label} with ${planLabel.value}`
  : `Upgrade to ${planLabel.value}`))

const lead = computed(() => {
  if (!feature.value) return 'Every tool, applied to your whole file.'
  if (featureId.value === 'pluginChainApply') return 'Your chain is set up — Pro renders it onto your audio in one step.'
  return `${feature.value.label} and everything below, on whole files.`
})

const benefits = computed(() => proBenefits(OPERATIONS, featureId.value).slice(0, 5))

// ── Prices ────────────────────────────────────────────────────────────────

const interval = ref('yearly')
const framing = computed(() => offerFraming(billing.state.prices))
const offers = computed(() => {
  const f = framing.value
  const out = []
  if (f.yearly) {
    out.push({
      interval: 'yearly',
      label: 'Yearly',
      price: formatPrice(f.yearly.amount, f.yearly.currency),
      per: '/yr',
      note: `${formatPrice(f.yearlyPerMonth, f.yearly.currency)}/mo, billed yearly`,
      badge: f.savePercent ? `Save ${f.savePercent}%` : null,
    })
  }
  if (f.monthly) {
    out.push({
      interval: 'monthly',
      label: 'Monthly',
      price: formatPrice(f.monthly.amount, f.monthly.currency),
      per: '/mo',
      note: 'Cancel anytime',
      badge: null,
    })
  }
  return out
})
const chosen = computed(() => offers.value.find(o => o.interval === interval.value) ?? null)
const canCheckout = computed(() => billing.state.enabled && offers.value.length > 0)

onMounted(async () => {
  await billing.loadPrices()
  if (!offers.value.some(o => o.interval === interval.value)) interval.value = offers.value[0]?.interval ?? 'monthly'
})

// ── Actions ───────────────────────────────────────────────────────────────

async function checkout() {
  const { error } = await billing.upgrade(interval.value)
  // Checkout runs in its own tab; this one waits for the plan to change.
  if (!error) view.value = 'waiting'
}

async function manageBilling() {
  const { error } = await billing.manage()
  if (!error) close()
}

function createAccount(mode) {
  auth.signUpThenUpgrade(mode)
}

// The billing tab's return broadcasts an account change; the store reloads it.
watch(isPro, (pro) => {
  if (pro && view.value !== 'success') view.value = 'success'
})

// Waiting on another tab: when the user comes back here, ask once for the
// plan (the broadcast covers the normal case; this covers a closed channel).
function onFocusBack() {
  if (view.value === 'waiting' && isSignedIn.value) auth.loadAccount()
}
onMounted(() => window.addEventListener('focus', onFocusBack))
onUnmounted(() => window.removeEventListener('focus', onFocusBack))

function close() {
  auth.closeUpgrade()
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
    class="fixed inset-0 z-[690] flex items-start justify-center pt-[8vh] compact:pt-3 px-4 overflow-y-auto dialog-scrim"
    tabindex="-1"
    @click.self="close"
    @keydown="onKeydown"
  >
    <div
      class="w-full max-w-[420px] mb-6 rounded-[18px] overflow-hidden font-['Inter'] dialog-surface"
      style="animation:bounceIn .28s cubic-bezier(.34,1.4,.64,1) both"
      role="dialog"
      aria-modal="true"
      :aria-label="view === 'success' ? `You’re on ${planLabel}` : title"
    >
      <!-- ── Success ─────────────────────────────────────────────────── -->
      <div v-if="view === 'success'" class="up-hero up-hero--success px-6 pt-7 pb-6 text-center">
        <span class="up-medal" aria-hidden="true">
          <svg viewBox="0 0 24 24" class="w-[26px] h-[26px]" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        </span>
        <div class="mt-4 text-[20px] font-bold text-[#fff6dc] tracking-[-0.01em]">
          {{ alreadyPro ? `You already have ${planLabel}` : `Welcome to ${planLabel}!` }}
        </div>
        <div class="mt-2 text-[13px] leading-[1.5] text-[rgba(255,246,220,.7)]">
          <template v-if="feature">{{ feature.label }} is unlocked<template v-if="!alreadyPro"> — along with everything else in {{ planLabel }}</template>.</template>
          <template v-else>Every tool is unlocked, on whole files.</template>
        </div>
        <button class="up-btn up-btn--gold mt-6" data-autofocus @click="close">
          {{ feature ? `Continue with ${feature.label}` : 'Start editing' }}
        </button>
      </div>

      <template v-else>
        <!-- ── Hero ─────────────────────────────────────────────────── -->
        <div class="up-hero px-6 pt-5 pb-5">
          <div class="flex items-center gap-2">
            <span class="up-badge">
              <svg viewBox="0 0 24 24" class="w-[10px] h-[10px]" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6z"/></svg>
              {{ planLabel.toUpperCase() }}
            </span>
            <span v-if="!isSignedIn && view === 'offer'" class="up-steps" aria-label="Two steps">
              <span>1 Account</span><span class="up-step-line"></span><span>2 Pro plan</span>
            </span>
            <button
              class="ml-auto w-[28px] h-[28px] -mr-1 rounded-[8px] flex items-center justify-center transition-colors hover:bg-[rgba(255,255,255,.1)]"
              style="color:rgba(255,246,220,.6)"
              aria-label="Close"
              @click="close"
            >
              <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
          <div class="mt-4 text-[20px] leading-[1.25] font-bold text-[#fff6dc] tracking-[-0.01em]">{{ title }}</div>
          <div class="mt-2 text-[13px] leading-[1.5] text-[rgba(255,246,220,.68)]">{{ lead }}</div>
        </div>

        <!-- ── Waiting on Checkout ──────────────────────────────────── -->
        <div v-if="view === 'waiting'" class="px-6 pt-6 pb-6 flex flex-col items-center text-center">
          <span class="up-wait" aria-hidden="true"></span>
          <div class="mt-4 text-[15px] font-bold text-[#eaf6f8]">Finish checkout in the new tab</div>
          <div class="mt-2 text-[12.5px] leading-[1.5] text-[rgba(255,255,255,.55)]" role="status">
            {{ planLabel }} unlocks here the moment payment goes through — no reload, your edits stay put.
          </div>
          <div v-if="billing.state.error" class="mt-3 text-[12px] leading-[1.45]" style="color:var(--color-danger)" role="alert">{{ billing.state.error }}</div>
          <div class="mt-5 flex items-center gap-3 text-[12px]">
            <button class="up-link" :disabled="billing.state.busy" @click="checkout">Reopen checkout</button>
            <span class="text-[rgba(255,255,255,.3)]" aria-hidden="true">·</span>
            <button class="up-link" @click="view = 'offer'">Change plan</button>
          </div>
        </div>

        <!-- ── Offer ────────────────────────────────────────────────── -->
        <div v-else class="px-6 pt-5 pb-6">
          <ul class="flex flex-col gap-[9px]" aria-label="What Pro includes">
            <li v-for="b in benefits" :key="b.feature" class="flex items-start gap-[10px]">
              <svg viewBox="0 0 24 24" class="up-tick" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
              <span class="min-w-0">
                <span class="block text-[12.5px] font-semibold text-[#eaf6f8] leading-[1.35]">{{ b.title }}</span>
                <span v-if="b.desc" class="block text-[11.5px] leading-[1.4] text-[rgba(255,255,255,.48)]">{{ b.desc }}</span>
              </span>
            </li>
          </ul>

          <template v-if="canCheckout">
            <div class="mt-5 grid gap-2" :style="{ gridTemplateColumns: `repeat(${offers.length}, 1fr)` }" role="radiogroup" aria-label="Billing period">
              <button
                v-for="o in offers"
                :key="o.interval"
                class="up-offer"
                :class="{ 'is-on': interval === o.interval }"
                role="radio"
                :aria-checked="String(interval === o.interval)"
                @click="interval = o.interval"
              >
                <span class="flex items-center gap-[6px] w-full">
                  <span class="up-radio" aria-hidden="true"></span>
                  <span class="up-offer-label">{{ o.label }}</span>
                  <span v-if="o.badge" class="up-save ml-auto">{{ o.badge }}</span>
                </span>
                <span class="up-offer-price">{{ o.price }}<span class="up-offer-per">{{ o.per }}</span></span>
                <span class="up-offer-note">{{ o.note }}</span>
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

            <template v-if="isSignedIn">
              <button class="up-btn up-btn--gold mt-4" data-autofocus :disabled="billing.state.busy" @click="checkout">
                <span v-if="billing.state.busy" class="up-spinner" aria-hidden="true"></span>
                {{ billing.state.busy ? 'Opening secure checkout…' : `Get ${planLabel}${chosen ? ` — ${chosen.price}${chosen.per}` : ''}` }}
              </button>
            </template>
            <template v-else>
              <button class="up-btn up-btn--gold mt-4" data-autofocus @click="createAccount('signUp')">Create free account &amp; continue</button>
              <div class="mt-3 text-[12px] text-center text-[rgba(255,255,255,.45)]">
                Have an account? <button class="up-link" @click="createAccount('signIn')">Sign in</button>
              </div>
            </template>

            <div class="mt-3 flex items-center justify-center gap-[6px] text-[11px] text-[rgba(255,255,255,.42)]">
              <svg viewBox="0 0 24 24" class="w-[11px] h-[11px]" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>
              Secure checkout by Stripe · Cancel anytime
            </div>
          </template>

          <template v-else>
            <button class="up-btn up-btn--gold mt-5" disabled :title="billing.state.loading ? 'Loading prices…' : 'Checkout is not open yet'">
              {{ billing.state.loading ? 'Loading prices…' : `${planLabel} is coming soon` }}
            </button>
            <template v-if="!isSignedIn && !billing.state.loading">
              <div class="mt-3 text-[12px] text-center text-[rgba(255,255,255,.45)]">
                Meanwhile, <button class="up-link" @click="createAccount('signUp')">create a free account</button> to save your presets and get early access to new effects.
              </div>
            </template>
          </template>

          <button class="up-notnow mt-3" @click="close">Not now</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.up-hero {
  background:
    radial-gradient(120% 140% at 100% 0%, rgba(224, 184, 74, 0.28), transparent 55%),
    linear-gradient(160deg, #3a3222, #262a30 70%);
  border-bottom: 1px solid rgba(224, 184, 74, 0.18);
}
.up-hero--success {
  border-bottom: none;
}
.up-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  font-weight: 800;
  letter-spacing: 0.1em;
  padding: 3px 7px;
  border-radius: 6px;
  color: #1a1408;
  background: linear-gradient(180deg, #f1d27a, #e0b84a);
}
.up-steps {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 700;
  color: rgba(255, 246, 220, 0.5);
}
.up-steps > span:first-child {
  color: #f1d27a;
}
.up-step-line {
  width: 14px;
  height: 1px;
  background: rgba(255, 246, 220, 0.25);
}
.up-tick {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  padding: 3px;
  border-radius: 999px;
  color: #1a1408;
  background: #e0b84a;
}
.up-offer {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 11px 12px 10px;
  border-radius: 12px;
  text-align: left;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.1);
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.up-offer:hover {
  border-color: rgba(255, 255, 255, 0.2);
}
.up-offer.is-on {
  background: rgba(224, 184, 74, 0.08);
  border-color: rgba(224, 184, 74, 0.75);
  box-shadow: 0 0 0 3px rgba(224, 184, 74, 0.12);
}
.up-radio {
  width: 13px;
  height: 13px;
  border-radius: 999px;
  border: 1.5px solid rgba(255, 255, 255, 0.35);
  flex: none;
}
.up-offer.is-on .up-radio {
  border: 4px solid #e0b84a;
}
.up-offer-label {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--color-text);
}
.up-save {
  font-size: 9.5px;
  font-weight: 800;
  letter-spacing: 0.03em;
  padding: 2px 6px;
  border-radius: 999px;
  color: #08161a;
  background: var(--color-accent);
}
.up-offer-price {
  margin-top: 2px;
  font-size: 19px;
  font-weight: 800;
  color: #fff;
  letter-spacing: -0.01em;
}
.up-offer-per {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.5);
  margin-left: 1px;
}
.up-offer-note {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}
.up-btn {
  width: 100%;
  height: 44px;
  border-radius: var(--radius-md);
  font-size: 13.5px;
  font-weight: 800;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  transition: background 0.15s, opacity 0.15s, transform 0.1s;
}
.up-btn:not(:disabled):active {
  transform: translateY(1px);
}
.up-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.up-btn--gold {
  color: #1a1408;
  background: linear-gradient(180deg, #f4d983, #e0b84a);
  box-shadow: 0 8px 22px rgba(224, 184, 74, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.45);
}
.up-btn--gold:not(:disabled):hover {
  background: linear-gradient(180deg, #f8e3a0, #e8c35a);
}
.up-notnow {
  display: block;
  width: 100%;
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.4);
}
.up-notnow:hover {
  color: rgba(255, 255, 255, 0.7);
}
.up-link {
  font-weight: 600;
  color: #f1d27a;
}
.up-link:disabled {
  opacity: 0.5;
}
.up-link:not(:disabled):hover {
  text-decoration: underline;
}
.up-spinner,
.up-wait {
  border-radius: 999px;
  animation: up-spin 0.8s linear infinite;
}
.up-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(26, 20, 8, 0.25);
  border-top-color: #1a1408;
}
.up-wait {
  width: 34px;
  height: 34px;
  border: 3px solid rgba(224, 184, 74, 0.2);
  border-top-color: #e0b84a;
}
.up-medal {
  width: 58px;
  height: 58px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #1a1408;
  background: linear-gradient(180deg, #f4d983, #e0b84a);
  box-shadow: 0 0 0 8px rgba(224, 184, 74, 0.14), 0 10px 30px rgba(224, 184, 74, 0.3);
  animation: bounceIn 0.4s cubic-bezier(0.34, 1.4, 0.64, 1) both;
}
@keyframes up-spin {
  to { transform: rotate(360deg); }
}
</style>
