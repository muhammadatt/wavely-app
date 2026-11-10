<script setup>
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useAuth } from '../composables/useAuth.js'
import { useBilling } from '../composables/useBilling.js'
import { useModalFocus } from '../composables/useModalFocus.js'
import { FEATURES, PLAN_LABELS } from '../auth/plans.js'
import { formatPrice } from '../auth/billing.js'
import { offerFraming, PRO_BENEFITS } from '../auth/pitch.js'

/**
 * "This needs Pro" — or, opened from the account menu with no feature,
 * "Upgrade to Pro". Opened by `useEntitlements().request()`, by a server 402,
 * by the top bar and by the account menu.
 *
 * Laid out like the account dialog (design 2c, `docs/design/create-account/`;
 * owner, November 2026): a split card, the pitch on the left — logo,
 * headline, the three Pro value props with their icons, fine print — and the
 * plan, one primary button and quiet secondary actions on the right. A light
 * gold tint where the account dialog has teal keeps it reading as Pro. On a
 * compact viewport the pitch stacks ABOVE the form rather than going, since
 * the value props are what this dialog is selling.
 *
 * Four views, one dialog (the right column changes, the pitch stays):
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
  if (!feature.value) return 'Get Pro tools and streamline your workflow.'
  if (featureId.value === 'pluginChainApply') return 'Upgrade to Pro to render your whole effect chain.'
  return `${feature.value.label} and everything else in ${planLabel.value}.`
})


// ── Prices ────────────────────────────────────────────────────────────────

// Resumed after the account dialog: the period picked before it, not the default.
const interval = ref(state.upgradeInterval ?? 'yearly')
const framing = computed(() => offerFraming(billing.state.prices))
const offers = computed(() => {
  const f = framing.value
  const out = []
  if (f.yearly) {
    // Quoted per month, the SaaS convention (owner, November 2026), so the two
    // rows compare like for like; what is actually charged stays on the row.
    out.push({
      interval: 'yearly',
      label: 'Yearly',
      price: formatPrice(f.yearlyPerMonth, f.yearly.currency),
      per: '/mo',
      note: `${formatPrice(f.yearly.amount, f.yearly.currency)} billed yearly`,
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

const closeBtn = ref(null)

onMounted(async () => {
  await billing.loadPrices()
  if (!offers.value.some(o => o.interval === interval.value)) interval.value = offers.value[0]?.interval ?? 'monthly'
  // The dialog opens before the prices land, so the primary button did not
  // exist for useModalFocus and focus fell to the first button: close. Hand
  // it to the primary now — unless the user has already moved it.
  await nextTick()
  if (document.activeElement === closeBtn.value) root.value?.querySelector('[data-autofocus]')?.focus()
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
  auth.signUpThenUpgrade(mode, { interval: interval.value })
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
const { trapTab, refocus } = useModalFocus(root)
// Every view swap removes the control that was focused (Get Pro, Change
// plan, Reopen checkout…): pull focus back in, or it lands on <body>.
watch(view, refocus)

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
    class="fixed inset-0 z-[690] flex items-start justify-center pt-[9vh] compact:pt-3 px-4 overflow-y-auto dialog-scrim"
    tabindex="-1"
    @click.self="close"
    @keydown="onKeydown"
  >
    <div
      class="up-card mb-6 font-['Inter'] dialog-surface"
      style="animation:bounceIn .28s cubic-bezier(.34,1.4,.64,1) both"
      role="dialog"
      aria-modal="true"
      :aria-label="view === 'success' ? `You’re on ${planLabel}` : title"
    >
      <!-- ── The pitch ─────────────────────────────────────────────── -->
      <aside class="up-pitch">
        <img src="/crisp-fm-logo.png" alt="crisp.fm" class="up-logo" draggable="false" />
        <div class="flex flex-col gap-[18px]">
          <span v-if="!isSignedIn && view === 'offer'" class="up-steps" aria-label="Two steps">
            <span class="is-on">1 Account</span><span class="up-step-line"></span><span>2 Pro plan</span>
          </span>
          <div>
            <span class="up-badge">
              <svg viewBox="0 0 24 24" class="w-[10px] h-[10px]" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6z"/></svg>
              {{ planLabel.toUpperCase() }}
            </span>
            <div class="up-headline mt-3">{{ title }}.</div>
            <div class="mt-[10px] text-[13px] leading-[1.5] text-[rgba(255,255,255,.55)]">{{ lead }}</div>
          </div>
          <ul class="flex flex-col gap-[14px]" aria-label="What Pro includes">
            <li v-for="b in PRO_BENEFITS" :key="b.id" class="flex items-center gap-[12px]">
              <span class="up-prop-icon" :class="`up-prop-icon--${b.icon}`" aria-hidden="true">
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
        </div>
        <div class="up-fine">SECURE CHECKOUT · CANCEL ANYTIME</div>
      </aside>

      <!-- ── The form ──────────────────────────────────────────────── -->
      <div class="up-form">
        <div class="flex items-center gap-[10px]">
          <div class="flex-1 text-[19px] font-extrabold tracking-[-0.01em] text-[#eaf6f8]">
            <template v-if="view === 'success'">{{ alreadyPro ? `You already have ${planLabel}` : `Welcome to ${planLabel}!` }}</template>
            <template v-else-if="view === 'waiting'">Finish checkout</template>
            <template v-else>Choose your plan</template>
          </div>
          <button ref="closeBtn" class="up-close" aria-label="Close" @click="close">
            <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>

        <!-- ── Success ─────────────────────────────────────────────── -->
        <div v-if="view === 'success'" class="flex flex-col gap-[18px]">
          <div class="up-note up-note--gold" role="status">
            <span class="up-medal" aria-hidden="true">
              <svg viewBox="0 0 24 24" class="w-[15px] h-[15px]" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
            </span>
            <div class="text-[13px] leading-[1.5] text-[rgba(255,255,255,.75)]">
              <template v-if="feature">{{ feature.label }} is unlocked<template v-if="!alreadyPro"> — along with everything else in {{ planLabel }}</template>.</template>
              <template v-else>Every tool is unlocked, on whole files.</template>
            </div>
          </div>
          <button class="up-btn up-btn--gold" data-autofocus @click="close">
            {{ feature ? `Continue with ${feature.label}` : 'Start editing' }}
          </button>
        </div>

        <!-- ── Waiting on Checkout ─────────────────────────────────── -->
        <div v-else-if="view === 'waiting'" class="flex flex-col gap-[18px]">
          <div class="up-note" role="status">
            <span class="up-wait" aria-hidden="true"></span>
            <div class="flex flex-col gap-1">
              <div class="text-[14px] font-bold text-[#fff1c9]">Checkout is open in a new tab</div>
              <div class="text-[12.5px] leading-[1.5] text-[rgba(255,255,255,.65)]">{{ planLabel }} unlocks here the moment payment goes through — no reload, your edits stay put.</div>
            </div>
          </div>
          <div v-if="billing.state.error" class="up-error" role="alert">{{ billing.state.error }}</div>
          <div class="flex justify-between">
            <button class="up-link" :disabled="billing.state.busy" @click="checkout">Reopen checkout</button>
            <button class="up-link up-link--dim" @click="view = 'offer'">Change plan</button>
          </div>
        </div>

        <!-- ── Offer ───────────────────────────────────────────────── -->
        <div v-else class="flex flex-col gap-[18px]">
          <template v-if="canCheckout">
            <div class="flex flex-col gap-[10px]" role="radiogroup" aria-label="Billing period">
              <button
                v-for="o in offers"
                :key="o.interval"
                class="up-offer"
                :class="{ 'is-on': interval === o.interval }"
                role="radio"
                :aria-checked="String(interval === o.interval)"
                @click="interval = o.interval"
              >
                <span class="up-radio" aria-hidden="true"></span>
                <span class="flex flex-col gap-[2px] min-w-0">
                  <span class="flex items-center gap-[8px]">
                    <span class="up-offer-label">{{ o.label }}</span>
                    <span v-if="o.badge" class="up-save">{{ o.badge }}</span>
                  </span>
                  <span class="up-offer-note">{{ o.note }}</span>
                </span>
                <span class="up-offer-price">{{ o.price }}<span class="up-offer-per">{{ o.per }}</span></span>
              </button>
            </div>

            <div v-if="billing.state.error" class="up-error" role="alert">
              <span>{{ billing.state.error }}</span>
              <button
                v-if="/already have an active subscription/i.test(billing.state.error)"
                class="up-link"
                @click="manageBilling"
              >Manage billing</button>
            </div>

            <button
              v-if="isSignedIn"
              class="up-btn up-btn--gold"
              data-autofocus
              :disabled="billing.state.busy"
              @click="checkout"
            >
              <span v-if="billing.state.busy" class="up-spinner" aria-hidden="true"></span>
              {{ billing.state.busy ? 'Opening secure checkout…' : `Get ${planLabel}${chosen ? ` — ${chosen.price}${chosen.per}` : ''}` }}
            </button>
            <button v-else class="up-btn up-btn--gold" data-autofocus @click="createAccount('signUp')">Create account &amp; continue</button>
          </template>

          <template v-else>
            <div class="up-note">
              <div class="text-[12.5px] leading-[1.5] text-[rgba(255,255,255,.65)]">
                {{ billing.state.loading ? 'Loading prices…' : `${planLabel} checkout isn’t open yet — it’s coming soon.` }}
              </div>
            </div>
            <button class="up-btn up-btn--gold" disabled>{{ billing.state.loading ? 'Loading…' : 'Coming soon' }}</button>
          </template>

          <!-- An alternative path gets a button; dismissing gets only a link. -->
          <template v-if="!isSignedIn">
            <div class="flex items-center gap-3">
              <div class="flex-1 h-px bg-[rgba(255,255,255,.08)]"></div>
              <span class="text-[10.5px] font-semibold tracking-[0.08em] text-[rgba(255,255,255,.35)]">OR</span>
              <div class="flex-1 h-px bg-[rgba(255,255,255,.08)]"></div>
            </div>
            <button class="up-btn up-btn--ghost" @click="createAccount('signIn')">I already have an account</button>
          </template>
          <button class="up-notnow" @click="close">Not now</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.up-card {
  width: 720px;
  max-width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  border-radius: 20px;
  overflow: hidden;
}

/* ── Pitch column (the account dialog's, in Pro gold) ─────────────────── */
.up-pitch {
  padding: 28px 26px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 24px;
  background: linear-gradient(180deg, rgba(53, 211, 230, 0.1), rgba(53, 211, 230, 0.02));
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}
.up-logo {
  height: 22px;
  width: auto;
  align-self: flex-start;
  user-select: none;
}
.up-headline {
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.15;
  color: #eaf6f8;
  text-wrap: balance;
}
.up-fine {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.42);
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
  letter-spacing: 0.02em;
  color: rgba(255, 255, 255, 0.38);
}
.up-steps .is-on {
  color: #f1d27a;
}
.up-step-line {
  width: 14px;
  height: 1px;
  background: rgba(255, 255, 255, 0.2);
}
.up-prop-icon {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.up-prop-icon svg {
  width: 17px;
  height: 17px;
}
/* One hue per prop: Pro gold, the accent teal, a warm heart. */
.up-prop-icon--star {
  color: #f1d27a;
  background: rgba(224, 184, 74, 0.14);
  box-shadow: inset 0 0 0 1px rgba(224, 184, 74, 0.3);
}
.up-prop-icon--chain {
  color: var(--color-accent-bright);
  background: rgba(53, 211, 230, 0.12);
  box-shadow: inset 0 0 0 1px rgba(53, 211, 230, 0.28);
}
.up-prop-icon--heart {
  color: #ff8fa3;
  background: rgba(255, 110, 140, 0.13);
  box-shadow: inset 0 0 0 1px rgba(255, 110, 140, 0.3);
}

/* ── Form column (the account dialog's tokens) ────────────────────────── */
.up-form {
  padding: 22px 26px 26px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}
.up-close {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.5);
}
.up-close:hover {
  background: rgba(255, 255, 255, 0.08);
}
.up-offer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  text-align: left;
  background: rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.1);
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.up-offer:hover {
  border-color: rgba(255, 255, 255, 0.2);
}
.up-offer.is-on {
  background: rgba(224, 184, 74, 0.07);
  border-color: rgba(224, 184, 74, 0.7);
  box-shadow: 0 0 0 3px rgba(224, 184, 74, 0.12);
}
.up-radio {
  width: 15px;
  height: 15px;
  border-radius: 999px;
  border: 1.5px solid rgba(255, 255, 255, 0.35);
  flex: none;
}
.up-offer.is-on .up-radio {
  border: 4.5px solid #e0b84a;
}
.up-offer-label {
  font-size: 13px;
  font-weight: 700;
  color: #eaf6f8;
}
.up-save {
  font-size: 9.5px;
  font-weight: 800;
  letter-spacing: 0.03em;
  padding: 2px 7px;
  border-radius: 999px;
  color: #08161a;
  background: var(--color-accent);
}
.up-offer-note {
  font-size: 11.5px;
  color: rgba(255, 255, 255, 0.5);
}
.up-offer-price {
  margin-left: auto;
  font-size: 19px;
  font-weight: 800;
  color: #fff;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.up-offer-per {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.5);
  margin-left: 1px;
}
.up-note {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding: 16px 18px;
  border-radius: 12px;
  background: rgba(224, 184, 74, 0.07);
  border: 1px solid rgba(224, 184, 74, 0.22);
}
.up-note--gold {
  align-items: center;
}
.up-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 9px 12px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-danger) 28%, transparent);
}
.up-btn {
  width: 100%;
  height: 40px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 700;
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
/* The account dialog's primary, in Pro gold: same height, corners, no glow. */
.up-btn--gold {
  height: 44px;
  font-size: 14px;
  color: #1a1408;
  background: #e8c35a;
}
.up-btn--gold:not(:disabled):hover {
  background: #f1d27a;
}
.up-btn--ghost {
  color: #eaf6f8;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.up-btn--ghost:hover {
  background: rgba(255, 255, 255, 0.1);
}
.up-notnow {
  align-self: center;
  font-size: 12.5px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.5);
}
.up-notnow:hover {
  color: rgba(255, 255, 255, 0.8);
  text-decoration: underline;
}
.up-link {
  font-size: 12px;
  font-weight: 600;
  color: #f1d27a;
}
.up-link--dim {
  color: rgba(255, 255, 255, 0.5);
}
.up-link:disabled {
  opacity: 0.5;
}
.up-link:not(:disabled):hover {
  text-decoration: underline;
}
.up-spinner,
.up-wait {
  flex: none;
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
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border: 2.5px solid rgba(224, 184, 74, 0.2);
  border-top-color: #e0b84a;
}
.up-medal {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #1a1408;
  background: #e8c35a;
  box-shadow: 0 0 0 5px rgba(224, 184, 74, 0.14);
  animation: bounceIn 0.4s cubic-bezier(0.34, 1.4, 0.64, 1) both;
}
@keyframes up-spin {
  to { transform: rotate(360deg); }
}

/* ── Compact: one column, the pitch on top ────────────────────────────────
   Unlike the account dialog the pitch is NOT dropped: the value props are
   the reason to upgrade. It stacks above the form, without its fine print. */
@media (max-width: 760px), (max-height: 520px) {
  .up-card {
    width: 420px;
    grid-template-columns: minmax(0, 1fr);
  }
  .up-pitch {
    padding: 20px 22px 18px;
    gap: 16px;
    border-right: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .up-headline {
    font-size: 21px;
  }
  .up-fine {
    display: none;
  }
}
</style>
