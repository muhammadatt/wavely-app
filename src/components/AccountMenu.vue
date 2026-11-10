<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useAuth } from '../composables/useAuth.js'
import { useEditorState } from '../composables/useEditorState.js'
import { useBilling } from '../composables/useBilling.js'
import BaseButton from './ui/BaseButton.vue'
import Icon from './ui/Icon.vue'

/**
 * Top-bar account control. Renders nothing at all when accounts are off, so a
 * build without Supabase configured looks exactly as it did before.
 */
const auth = useAuth()
const { state, user, plan } = auth

const open = ref(false)

const PLAN_LABELS = { free: 'Free', pro: 'Pro' }

const displayName = computed(() => state.account?.user?.displayName || user.value?.email || '')
const initial = computed(() => (displayName.value.trim()[0] ?? '?').toUpperCase())
const planLabel = computed(() => PLAN_LABELS[plan.value] ?? plan.value ?? '')
const isPaid = computed(() => !!plan.value && plan.value !== 'free')

function onWindowClick(e) {
  if (!e.target.closest?.('[data-account-menu]')) open.value = false
}

onMounted(() => window.addEventListener('click', onWindowClick))
onUnmounted(() => window.removeEventListener('click', onWindowClick))

const { showToast } = useEditorState()
const billing = useBilling()

/** "Renews 21 Nov 2026" / "Ends 21 Nov 2026" / "Payment failed — update your card". */
const subscriptionLine = computed(() => {
  const sub = state.account?.subscription
  if (!sub) return ''
  if (sub.status === 'past_due') return 'Payment failed — update your card'
  if (!sub.currentPeriodEnd) return ''
  const date = new Date(sub.currentPeriodEnd).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return `${sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${date}`
})

function upgrade() {
  open.value = false
  auth.openUpgrade()
}

async function manageBilling() {
  open.value = false
  const { error } = await billing.manage()
  if (error) showToast(error, 5000)
}

async function signOut() {
  open.value = false
  const { error } = await auth.signOut()
  // Still signed in — say so rather than leaving the menu looking unchanged.
  if (error) showToast(`Couldn’t sign out: ${error}`, 5000)
}
</script>

<template>
  <template v-if="state.status !== 'disabled'">
    <div class="w-px h-[18px] bg-[rgba(255,255,255,.12)] mx-1 max-sm:hidden"></div>

    <!-- Reserve the slot while Supabase reports in, so the row doesn't jump. -->
    <div v-if="state.status === 'loading'" class="w-[30px] h-[30px]" aria-hidden="true"></div>

    <!-- On a phone held upright the words do not fit beside Save and Export
         (they ran off the screen at 390 px); the person icon stands in. -->
    <template v-else-if="state.status === 'signedOut'">
      <BaseButton
        size="md" color="ghost" :pill="false" class="max-sm:px-[9px]"
        aria-label="Log in"
        title="Log in"
        @click="auth.openDialog('signIn')"
      >
        <Icon name="user" :size="15" class="sm:hidden" />
        <span class="max-sm:hidden">Log in</span>
      </BaseButton>
      <!-- The sign-up door, not buried behind "Sign in": most visitors have no
           account yet, and "free" is the word that gets the click. Off on a
           compact viewport, where the row has no room; Sign in still opens
           the dialog with Create account one tab away. -->
      <BaseButton
        size="md" :pill="false" class="ml-1 whitespace-nowrap max-sm:hidden compact:hidden"
        title="Create a free account"
        @click="auth.openDialog('signUp')"
      >Sign up</BaseButton>
    </template>

    <div v-else class="relative flex items-center gap-[6px]" data-account-menu>
      <!-- Free accounts see the way up at all times, not only inside the menu. -->
      <button
        v-if="!isPaid && !state.accountError && state.account"
        class="acct-upgrade inline-flex items-center max-sm:hidden"
        title="See what Pro unlocks"
        @click.stop="upgrade"
      >
        <svg viewBox="0 0 24 24" class="w-[10px] h-[10px]" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6z"/></svg>
        Upgrade
      </button>
      <button
        class="h-[30px] flex items-center gap-[7px] pl-[3px] pr-[8px] max-sm:pr-[3px] rounded-full transition-colors hover:bg-[rgba(255,255,255,.08)]"
        :title="user?.email"
        aria-label="Account"
        :aria-expanded="open"
        @click.stop="open = !open"
      >
        <span
          class="w-[24px] h-[24px] rounded-full flex items-center justify-center text-[11px] font-extrabold"
          style="background:linear-gradient(135deg,#7ef0ff,#25b6d0);color:#08161a"
        >{{ initial }}</span>
        <span
          class="max-sm:hidden font-['JetBrains_Mono'] text-[8.5px] font-bold tracking-[0.1em] px-[6px] py-[3px] rounded-[5px]"
          :style="isPaid
            ? 'color:#08161a;background:#e0b84a'
            : 'color:rgba(255,255,255,.6);background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1)'"
        >{{ planLabel.toUpperCase() }}</span>
      </button>

      <div
        v-if="open"
        class="absolute right-0 top-[36px] z-[400] w-[230px] rounded-[12px] overflow-hidden font-['Inter'] menu-surface"
      >
        <div class="px-4 pt-3 pb-[10px] border-b border-[rgba(255,255,255,.07)]">
          <div class="text-[12.5px] font-bold text-[#eaf6f8] truncate">{{ displayName }}</div>
          <div
            v-if="state.account?.user?.displayName"
            class="text-[11px] text-[rgba(255,255,255,.45)] truncate"
          >{{ user?.email }}</div>
          <div class="mt-[6px] text-[11px] text-[rgba(255,255,255,.55)]">
            {{ planLabel }} plan<template v-if="subscriptionLine"> · {{ subscriptionLine }}</template>
          </div>
          <div
            v-if="state.accountError"
            class="mt-[6px] text-[11px] leading-[1.4]"
            style="color:var(--color-warn)"
          >Couldn’t load your plan: {{ state.accountError }}</div>
        </div>
        <div class="py-1">
          <button
            v-if="!isPaid"
            class="w-full text-left px-4 py-[8px] transition-colors hover:bg-[rgba(255,255,255,.08)]"
            @click="upgrade"
          >
            <span class="block text-[12px] font-semibold" style="color:#e0b84a">Upgrade to Pro</span>
            <span class="block text-[11px] text-[rgba(255,255,255,.45)]">Every tool, applied to your whole file</span>
          </button>
          <button
            v-if="state.account?.subscription"
            class="w-full text-left px-4 py-[8px] text-[12px] font-semibold transition-colors hover:bg-[rgba(255,255,255,.08)]"
            style="color:#eaf6f8"
            @click="manageBilling"
          >Manage billing</button>
          <button
            class="w-full text-left px-4 py-[8px] text-[12px] font-semibold transition-colors hover:bg-[rgba(255,255,255,.08)]"
            style="color:#eaf6f8"
            @click="signOut"
          >Sign out</button>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.acct-upgrade {
  height: 24px;
  gap: 5px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  color: #1a1408;
  background: linear-gradient(180deg, #f4d983, #e0b84a);
  box-shadow: 0 3px 10px rgba(224, 184, 74, 0.2);
  white-space: nowrap;
  transition: filter 0.15s;
}
.acct-upgrade:hover {
  filter: brightness(1.08);
}
</style>
