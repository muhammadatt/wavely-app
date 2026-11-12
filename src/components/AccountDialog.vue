<script setup>
import { computed, ref, watch, nextTick, onMounted } from 'vue'
import { useAuth } from '../composables/useAuth.js'
import { useBilling } from '../composables/useBilling.js'
import { useModalFocus } from '../composables/useModalFocus.js'
import { hasEmailIdentity } from '../auth/authStore.js'
import { planSummary, formatPeriodDate } from '../auth/accountSummary.js'
import { MIN_PASSWORD, passwordStrength } from '../auth/passwordStrength.js'

/**
 * The account page, as a dialog (the editor is one page, and leaving it would
 * risk unsaved work): who you are, your plan — and that it is managed and
 * cancelled HERE, through Stripe's portal in its own tab — and changing your
 * password. Opened from the account menu's "Account & billing".
 *
 * Deliberately minimal. Built on the account dialog's tokens (AuthDialog.vue)
 * and the upgrade dialog's gold for Pro, so it reads as part of the same set.
 *
 * Password: an account with an email identity changes it by giving the
 * current one (checked by signing in with it, see `changePassword` in
 * authStore.js), with a reset link as the way out for one who never set one
 * (magic links) or forgot it. An account with only provider identities has
 * no password to check and SETS one.
 */
const auth = useAuth()
const { state, user, plan } = auth
const billing = useBilling()

const summary = computed(() => planSummary(plan.value, state.account?.subscription))
const email = computed(() => state.account?.user?.email ?? user.value?.email ?? '')
const displayName = computed(() => state.account?.user?.displayName || '')
const initial = computed(() => ((displayName.value || email.value).trim()[0] ?? '?').toUpperCase())
const memberSince = computed(() => {
  const created = state.account?.user?.createdAt ?? user.value?.created_at
  return created ? formatPeriodDate(created) : ''
})
const providerNames = computed(() => {
  const names = { google: 'Google', github: 'GitHub', apple: 'Apple', azure: 'Microsoft', facebook: 'Facebook', twitter: 'X' }
  const list = user.value?.app_metadata?.providers ?? []
  return list.filter(p => p !== 'email').map(p => names[p] ?? p[0].toUpperCase() + p.slice(1))
})

// ── Plan ──────────────────────────────────────────────────────────────────

async function manageSubscription() {
  await billing.manage()
}

function upgrade() {
  // The upgrade prompt opens over this dialog; the plan here updates when it lands.
  auth.openUpgrade()
}

onMounted(() => {
  // A change made in the portal in another tab or on Stripe's side.
  auth.loadAccount()
})

// ── Password ──────────────────────────────────────────────────────────────

const checksCurrent = computed(() => hasEmailIdentity(user.value))
const pwOpen = ref(false)
const currentPw = ref('')
const newPw = ref('')
const showPw = ref(false)
const pwBusy = ref(false)
const pwError = ref(null)
const pwErrorKind = ref(null)
const pwDone = ref(false)
const resetSent = ref(false)
const strength = computed(() => passwordStrength(newPw.value))
const currentInput = ref(null)
const newInput = ref(null)

async function openPassword() {
  pwOpen.value = true
  pwDone.value = false
  resetSent.value = false
  await nextTick()
  ;(checksCurrent.value ? currentInput : newInput).value?.focus()
}

function cancelPassword() {
  pwOpen.value = false
  currentPw.value = ''
  newPw.value = ''
  pwError.value = null
  pwErrorKind.value = null
}

async function savePassword() {
  pwError.value = null
  pwErrorKind.value = null
  if (checksCurrent.value && !currentPw.value) {
    pwError.value = 'Enter your current password.'
    currentInput.value?.focus()
    return
  }
  if (newPw.value.length < MIN_PASSWORD) {
    pwError.value = `Use at least ${MIN_PASSWORD} characters.`
    newInput.value?.focus()
    return
  }
  if (checksCurrent.value && newPw.value === currentPw.value) {
    pwError.value = 'Choose a password different from your current one.'
    newInput.value?.focus()
    return
  }
  pwBusy.value = true
  try {
    const r = await auth.changePassword(checksCurrent.value ? currentPw.value : null, newPw.value)
    if (r.error) {
      pwError.value = r.error
      pwErrorKind.value = r.errorKind
      ;(r.errorKind === 'currentPassword' ? currentInput : newInput).value?.focus()
      return
    }
    cancelPassword()
    pwDone.value = true
  } finally {
    pwBusy.value = false
  }
}

async function sendReset() {
  if (!email.value) return
  pwBusy.value = true
  try {
    const r = await auth.sendPasswordReset(email.value)
    if (r.error) {
      pwError.value = r.error
      pwErrorKind.value = null
      return
    }
    cancelPassword()
    resetSent.value = true
  } finally {
    pwBusy.value = false
  }
}

// ── Sign out / close ──────────────────────────────────────────────────────

const signOutError = ref(null)
async function signOut() {
  signOutError.value = null
  const { error } = await auth.signOut()
  // On success the store closes this dialog with the session.
  if (error) signOutError.value = `Couldn’t sign out: ${error}`
}

function close() {
  auth.closeAccount()
}

const root = ref(null)
const { trapTab, refocus } = useModalFocus(root)
watch([pwOpen, pwDone, resetSent], () => nextTick(refocus))

function onKeydown(e) {
  trapTab(e)
  e.stopPropagation()
  if (e.key === 'Escape') {
    if (pwOpen.value) cancelPassword()
    else close()
  }
}
</script>

<template>
  <!-- z 690 like the other account dialogs; rendered before UpgradeDialog in
       App.vue so an upgrade opened from here sits on top of it. -->
  <div
    ref="root"
    class="fixed inset-0 z-[690] flex items-start justify-center pt-[9vh] compact:pt-3 px-4 overflow-y-auto dialog-scrim"
    tabindex="-1"
    @click.self="close"
    @keydown="onKeydown"
  >
    <div
      class="acc-card mb-6 font-['Inter'] dialog-surface"
      style="animation:bounceIn .28s cubic-bezier(.34,1.4,.64,1) both"
      role="dialog"
      aria-modal="true"
      aria-labelledby="acc-title"
    >
      <div class="flex items-center gap-[10px]">
        <h2 id="acc-title" class="flex-1 text-[19px] font-extrabold tracking-[-0.01em] text-[#eaf6f8]">Account</h2>
        <button class="acc-close" aria-label="Close" @click="close">
          <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      <!-- ── Profile ─────────────────────────────────────────────── -->
      <section class="flex items-center gap-[14px]" aria-label="Profile">
        <span class="acc-avatar" :class="{ 'acc-avatar--pro': summary.paid }" aria-hidden="true">{{ initial }}</span>
        <div class="min-w-0 flex flex-col gap-[2px]">
          <div v-if="displayName" class="text-[14px] font-bold text-[#eaf6f8] truncate">{{ displayName }}</div>
          <div class="text-[13px] truncate" :class="displayName ? 'text-[rgba(255,255,255,.55)]' : 'font-bold text-[#eaf6f8]'">{{ email }}</div>
          <div v-if="memberSince || providerNames.length" class="text-[11.5px] text-[rgba(255,255,255,.42)]">
            <template v-if="memberSince">Member since {{ memberSince }}</template>
            <template v-if="memberSince && providerNames.length"> · </template>
            <template v-if="providerNames.length">Signs in with {{ providerNames.join(', ') }}</template>
          </div>
        </div>
      </section>

      <!-- ── Plan ────────────────────────────────────────────────── -->
      <section class="acc-section" aria-labelledby="acc-plan">
        <div id="acc-plan" class="acc-label">PLAN</div>
        <div class="acc-plan" :class="{ 'acc-plan--pro': summary.paid, 'acc-plan--warn': summary.state === 'pastDue' }">
          <div class="flex items-center gap-[10px]">
            <span v-if="summary.paid" class="acc-badge">
              <svg viewBox="0 0 24 24" class="w-[10px] h-[10px]" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6z"/></svg>
              {{ summary.label.toUpperCase() }}
            </span>
            <span v-else class="text-[15px] font-extrabold text-[#eaf6f8]">{{ summary.label }}</span>
            <span class="text-[12.5px]" :class="summary.state === 'pastDue' ? 'acc-warn-text' : 'text-[rgba(255,255,255,.7)]'">{{ summary.status }}</span>
          </div>
          <p class="text-[12px] leading-[1.5] text-[rgba(255,255,255,.55)]">{{ summary.detail }}</p>
          <div v-if="state.accountError" class="acc-error" role="alert">Couldn’t load your plan: {{ state.accountError }}</div>
          <div v-if="billing.state.error" class="acc-error" role="alert">{{ billing.state.error }}</div>
          <button
            v-if="summary.canManage"
            class="acc-btn acc-btn--gold"
            :disabled="billing.state.busy"
            @click="manageSubscription"
          >
            <span v-if="billing.state.busy" class="acc-spinner" aria-hidden="true"></span>
            {{ billing.state.busy ? 'Opening secure portal…' : 'Manage subscription' }}
          </button>
          <button v-else class="acc-btn acc-btn--gold" @click="upgrade">Upgrade to Pro</button>
          <div v-if="summary.canManage" class="text-[11px] leading-[1.45] text-[rgba(255,255,255,.4)]">
            Opens Stripe’s secure billing portal in a new tab. Your edits here stay put, and this page updates when you’re done.
          </div>
        </div>
      </section>

      <!-- ── Password ────────────────────────────────────────────── -->
      <section class="acc-section" aria-labelledby="acc-pw">
        <div class="flex items-center">
          <div id="acc-pw" class="acc-label">PASSWORD</div>
          <button v-if="!pwOpen" class="acc-link ml-auto" @click="openPassword">
            {{ checksCurrent ? 'Change password' : 'Set a password' }}
          </button>
        </div>

        <div v-if="pwDone && !pwOpen" class="acc-ok" role="status">Password changed. Use it the next time you log in.</div>
        <div v-else-if="resetSent && !pwOpen" class="acc-ok" role="status">We sent a reset link to {{ email }}. Open it to choose a new password.</div>
        <div v-else-if="!pwOpen" class="text-[12px] text-[rgba(255,255,255,.45)]">
          {{ checksCurrent ? '••••••••' : `You sign in with ${providerNames.join(', ') || 'a provider'}. Set a password to log in with your email too.` }}
        </div>

        <form v-else class="flex flex-col gap-[12px]" novalidate @submit.prevent="savePassword">
          <!-- The username field lets a password manager file the new password under the right account. -->
          <input type="email" autocomplete="username" :value="email" class="sr-only" tabindex="-1" aria-hidden="true" readonly />
          <label v-if="checksCurrent" class="flex flex-col gap-[6px]">
            <span class="acc-field-label">CURRENT PASSWORD</span>
            <input
              ref="currentInput"
              v-model="currentPw"
              class="acc-input"
              :type="showPw ? 'text' : 'password'"
              autocomplete="current-password"
              :disabled="pwBusy"
              @input="pwError && (pwError = null)"
            />
          </label>
          <label class="flex flex-col gap-[6px]">
            <span class="acc-field-label">NEW PASSWORD</span>
            <span class="relative flex">
              <input
                ref="newInput"
                v-model="newPw"
                class="acc-input flex-1 min-w-0 pr-[56px]"
                :type="showPw ? 'text' : 'password'"
                autocomplete="new-password"
                placeholder="Type to see strength"
                :disabled="pwBusy"
                @input="pwError && (pwError = null)"
              />
              <button
                type="button"
                class="acc-reveal"
                :aria-pressed="String(showPw)"
                :aria-label="showPw ? 'Hide passwords' : 'Show passwords'"
                @click="showPw = !showPw"
              >{{ showPw ? 'Hide' : 'Show' }}</button>
            </span>
            <span class="acc-meter" aria-hidden="true">
              <span v-for="i in 4" :key="i" :style="{ background: i <= strength.score ? strength.color : 'rgba(255,255,255,.1)' }"></span>
            </span>
            <span
              class="text-[11.5px]"
              :style="{ color: strength.score === 0 ? 'rgba(255,255,255,.42)' : strength.weak ? '#ff8a80' : 'rgba(255,255,255,.65)' }"
              aria-live="polite"
            >{{ strength.hint }}</span>
          </label>

          <div v-if="pwError" class="acc-error" role="alert">
            <span>{{ pwError }}</span>
            <button v-if="pwErrorKind === 'currentPassword'" type="button" class="acc-link" :disabled="pwBusy" @click="sendReset">Forgot it? Email me a reset link</button>
          </div>

          <div class="flex items-center gap-[10px]">
            <button type="submit" class="acc-btn acc-btn--primary flex-1" :disabled="pwBusy">
              <span v-if="pwBusy" class="acc-spinner" aria-hidden="true"></span>
              {{ checksCurrent ? 'Change password' : 'Set password' }}
            </button>
            <button type="button" class="acc-btn acc-btn--ghost px-4" :disabled="pwBusy" @click="cancelPassword">Cancel</button>
          </div>
          <button
            v-if="checksCurrent && pwErrorKind !== 'currentPassword'"
            type="button"
            class="acc-link acc-link--dim self-start"
            :disabled="pwBusy"
            @click="sendReset"
          >Never set one, or forgot it? Email me a reset link</button>
        </form>
      </section>

      <!-- ── Sign out ────────────────────────────────────────────── -->
      <div class="acc-foot">
        <div v-if="signOutError" class="acc-error mb-2" role="alert">{{ signOutError }}</div>
        <div class="flex items-center">
          <button class="acc-link acc-link--dim" @click="signOut">Sign out</button>
          <button class="acc-link ml-auto" @click="close">Done</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.acc-card {
  width: 460px;
  max-width: 100%;
  padding: 22px 26px 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  border-radius: 20px;
}
.acc-close {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.5);
}
.acc-close:hover {
  background: rgba(255, 255, 255, 0.08);
}
.acc-avatar {
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  font-weight: 800;
  color: #eaf6f8;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}
.acc-avatar--pro {
  box-shadow: 0 0 0 2px #e0b84a;
}
.acc-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}
.acc-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.42);
}
.acc-field-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.5);
}
.acc-plan {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.acc-plan--pro {
  background: rgba(224, 184, 74, 0.07);
  border-color: rgba(224, 184, 74, 0.22);
}
.acc-plan--warn {
  border-color: color-mix(in srgb, var(--color-warn) 45%, transparent);
}
.acc-warn-text {
  color: var(--color-warn);
  font-weight: 600;
}
.acc-badge {
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
.acc-input {
  height: 40px;
  padding: 0 12px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--color-text);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.acc-input::placeholder {
  color: rgba(255, 255, 255, 0.3);
}
.acc-input:focus {
  border-color: rgba(53, 211, 230, 0.6);
  box-shadow: 0 0 0 3px rgba(53, 211, 230, 0.15);
}
.acc-reveal {
  position: absolute;
  right: 6px;
  top: 6px;
  height: 28px;
  padding: 0 8px;
  border-radius: 7px;
  font-size: 11.5px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.5);
}
.acc-reveal:hover {
  color: var(--color-text);
  background: rgba(255, 255, 255, 0.08);
}
.acc-meter {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  margin-top: 2px;
}
.acc-meter > span {
  height: 4px;
  border-radius: 2px;
  transition: background 0.2s;
}
.acc-error {
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
.acc-ok {
  padding: 9px 12px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.45;
  color: rgba(255, 255, 255, 0.8);
  background: rgba(53, 211, 230, 0.09);
  border: 1px solid rgba(53, 211, 230, 0.25);
}
.acc-btn {
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
.acc-btn:not(:disabled):active {
  transform: translateY(1px);
}
.acc-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.acc-btn--primary {
  color: #08161a;
  background: var(--color-accent);
}
.acc-btn--primary:not(:disabled):hover {
  background: var(--color-accent-bright);
}
.acc-btn--gold {
  color: #1a1408;
  background: linear-gradient(180deg, #f1d27a, #e0b84a);
}
.acc-btn--gold:not(:disabled):hover {
  filter: brightness(1.06);
}
.acc-btn--ghost {
  color: #eaf6f8;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.acc-btn--ghost:not(:disabled):hover {
  background: rgba(255, 255, 255, 0.1);
}
.acc-spinner {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 2px solid rgba(8, 22, 26, 0.25);
  border-top-color: #08161a;
  animation: acc-spin 0.7s linear infinite;
}
@keyframes acc-spin {
  to { transform: rotate(360deg); }
}
.acc-link {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-accent-bright);
}
.acc-link--dim {
  color: rgba(255, 255, 255, 0.5);
}
.acc-link:disabled {
  color: rgba(255, 255, 255, 0.35);
  cursor: default;
}
.acc-link:not(:disabled):hover {
  text-decoration: underline;
}
.acc-foot {
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}
</style>
