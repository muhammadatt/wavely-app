<script setup>
import { computed, ref } from 'vue'
import { useAuth } from '../composables/useAuth.js'
import { useModalFocus } from '../composables/useModalFocus.js'
import { FEATURES, FREE_PREVIEW_SECONDS, PLAN_LABELS } from '../auth/plans.js'

/**
 * "This needs Pro." Opened by `useEntitlements().request()` and by a server
 * 402. Says what the feature is, what is free about it, and the next step —
 * which for a signed-out user is an account first.
 *
 * ⚠ Checkout is not built yet (Stripe is the next step), so the upgrade
 * button says so rather than leading nowhere.
 */
const auth = useAuth()
const { state, isSignedIn } = auth

const feature = computed(() => FEATURES[state.upgradeFor] ?? null)
const planLabel = computed(() => PLAN_LABELS[feature.value?.requires] ?? 'Pro')

const freeNote = computed(() => {
  if (!feature.value) return ''
  if (feature.value.preview) {
    return `You can try it free on up to ${FREE_PREVIEW_SECONDS} seconds of audio — select a shorter passage to preview.`
  }
  if (state.upgradeFor === 'pluginChainApply') {
    return 'Previewing the chain is free — upgrading lets you apply it to your audio.'
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
    v-if="feature"
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
      :aria-label="`${feature.label} needs ${planLabel}`"
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
        <div class="mt-3 text-[16px] font-bold text-[#eaf6f8]">{{ feature.label }} is a {{ planLabel }} feature</div>
        <div v-if="freeNote" class="mt-2 text-[12.5px] leading-[1.5] text-[rgba(255,255,255,.55)]">{{ freeNote }}</div>

        <template v-if="!isSignedIn">
          <div class="mt-4 text-[12.5px] leading-[1.5] text-[rgba(255,255,255,.55)]">
            Create a free account first — you can upgrade from it.
          </div>
          <button class="up-btn up-btn--primary mt-4" data-autofocus @click="account('signUp')">Create account</button>
          <button class="up-btn up-btn--ghost mt-2" @click="account('signIn')">Sign in</button>
        </template>
        <template v-else>
          <button class="up-btn up-btn--primary mt-5" disabled title="Checkout is not open yet">
            Upgrade to {{ planLabel }} — coming soon
          </button>
          <button class="up-btn up-btn--ghost mt-2" data-autofocus @click="close">Not now</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
