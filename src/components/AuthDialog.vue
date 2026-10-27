<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useAuth } from '../composables/useAuth.js'
import { useModalFocus } from '../composables/useModalFocus.js'
import { AUTH_PROVIDERS } from '../auth/config.js'

/**
 * Sign in / create account / password reset, as one dialog with modes.
 *
 * The mode lives on the auth store (`state.dialog`) rather than here so the
 * store can open it itself — a password-recovery link lands the user on
 * 'recovery' without any component asking for it.
 */
const auth = useAuth()
const { state } = auth

const email = ref('')
const password = ref('')
const busy = ref(false)
const error = ref(null)
// After a link has been emailed the form gives way to this message.
const notice = ref(null)
const emailInput = ref(null)
const passwordInput = ref(null)

const MIN_PASSWORD = 8

const PROVIDER_LABELS = { google: 'Google', apple: 'Apple', github: 'GitHub' }

const mode = computed(() => state.dialog)

const title = computed(() => ({
  signIn: 'Sign in',
  signUp: 'Create your account',
  reset: 'Reset your password',
  recovery: 'Choose a new password',
}[mode.value] ?? ''))

const subtitle = computed(() => ({
  signIn: 'Save presets to your account and pick up where you left off.',
  signUp: 'Sign up for free to save presets to your account.',
  reset: 'We’ll email you a link to set a new password.',
  recovery: 'Signed in from your reset link — set a password to finish.',
}[mode.value] ?? ''))

const showProviders = computed(() => (mode.value === 'signIn' || mode.value === 'signUp') && AUTH_PROVIDERS.length > 0)
const needsEmail = computed(() => mode.value !== 'recovery')
const needsPassword = computed(() => mode.value === 'signIn' || mode.value === 'signUp' || mode.value === 'recovery')

watch(mode, async (m, prev) => {
  error.value = null
  notice.value = null
  if (m !== prev) password.value = ''
  if (!m) return
  await nextTick()
  ;(needsEmail.value && !email.value ? emailInput.value : passwordInput.value ?? emailInput.value)?.focus()
}, { immediate: true })

function setMode(m) {
  state.dialog = m
}

function close() {
  if (!busy.value) auth.closeDialog()
}

function validEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
}

async function submit() {
  error.value = null
  if (needsEmail.value && !validEmail(email.value)) {
    error.value = 'Enter a valid email address.'
    return
  }
  if ((mode.value === 'signUp' || mode.value === 'recovery') && password.value.length < MIN_PASSWORD) {
    error.value = `Use at least ${MIN_PASSWORD} characters.`
    return
  }
  if (mode.value === 'signIn' && !password.value) {
    error.value = 'Enter your password.'
    return
  }

  busy.value = true
  try {
    const addr = email.value.trim()
    if (mode.value === 'signIn') {
      const r = await auth.signInWithPassword(addr, password.value)
      if (r.error) error.value = r.error
      // On success the store closes the dialog when the session arrives.
    } else if (mode.value === 'signUp') {
      const r = await auth.signUp(addr, password.value)
      if (r.error) error.value = r.error
      else if (r.needsConfirmation) notice.value = `Check ${addr} for a link to confirm your account.`
    } else if (mode.value === 'reset') {
      const r = await auth.sendPasswordReset(addr)
      if (r.error) error.value = r.error
      else notice.value = `If ${addr} has an account, a reset link is on its way.`
    } else if (mode.value === 'recovery') {
      const r = await auth.updatePassword(password.value)
      if (r.error) error.value = r.error
      else {
        busy.value = false
        auth.closeDialog()
        return
      }
    }
  } finally {
    busy.value = false
  }
}

async function magicLink() {
  error.value = null
  if (!validEmail(email.value)) {
    error.value = 'Enter your email address first.'
    emailInput.value?.focus()
    return
  }
  busy.value = true
  try {
    const addr = email.value.trim()
    const r = await auth.sendMagicLink(addr)
    if (r.error) error.value = r.error
    else notice.value = `Check ${addr} for a sign-in link. You can keep working here — this tab signs in when you click it.`
  } finally {
    busy.value = false
  }
}

async function provider(p) {
  error.value = null
  const r = await auth.signInWithProvider(p)
  if (r.error) error.value = r.error
}

// Focus moves in on open, Tab stays inside, and focus returns to the opener.
const root = ref(null)
const { trapTab } = useModalFocus(root)

function onKeydown(e) {
  trapTab(e)
  // Keep the editor's global shortcuts (space, delete, Ctrl+Z…) out of the form.
  e.stopPropagation()
  if (e.key === 'Escape') close()
}
</script>

<template>
  <!-- z 690: above every floating window (500 and up, one step per window) —
       these open FROM a plugin window — and below the command palette. -->
  <div
    ref="root"
    tabindex="-1"
    class="fixed inset-0 z-[690] flex items-start justify-center pt-[12vh] px-4 dialog-scrim"
    @click.self="close"
    @keydown="onKeydown"
  >
    <div
      class="w-full max-w-[380px] flex flex-col rounded-[18px] overflow-hidden font-['Inter'] dialog-surface"
      style="animation:bounceIn .28s cubic-bezier(.34,1.4,.64,1) both"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <div class="px-6 pt-[22px] pb-[4px] flex items-start gap-3">
        <div class="flex-1">
          <div class="text-[16px] font-bold text-[#eaf6f8]">{{ title }}</div>
          <div class="mt-[4px] text-[12px] leading-[1.45] text-[rgba(255,255,255,.45)]">{{ subtitle }}</div>
        </div>
        <button
          class="w-[26px] h-[26px] -mr-1 rounded-[7px] flex items-center justify-center transition-colors hover:bg-[rgba(255,255,255,.08)]"
          style="color:rgba(255,255,255,.5)"
          aria-label="Close"
          @click="close"
        >
          <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      <!-- Sent: the form is done, say what happens next. -->
      <div v-if="notice" class="px-6 pt-4 pb-6">
        <div
          class="text-[12.5px] leading-[1.5] rounded-[10px] px-4 py-3"
          style="color:#bff6ff;background:rgba(53,211,230,.09);border:1px solid rgba(53,211,230,.25)"
          role="status"
        >{{ notice }}</div>
        <button class="auth-link mt-4" @click="notice = null; setMode('signIn')">Back to sign in</button>
      </div>

      <form v-else class="px-6 pt-4 pb-6 flex flex-col gap-3" novalidate @submit.prevent="submit">
        <template v-if="showProviders">
          <button
            v-for="p in AUTH_PROVIDERS"
            :key="p"
            type="button"
            class="auth-btn auth-btn--ghost"
            :disabled="busy"
            @click="provider(p)"
          >Continue with {{ PROVIDER_LABELS[p] }}</button>
          <div class="flex items-center gap-3 my-[2px]">
            <div class="flex-1 h-px bg-[rgba(255,255,255,.08)]"></div>
            <span class="text-[10.5px] font-semibold tracking-[0.08em] text-[rgba(255,255,255,.35)]">OR</span>
            <div class="flex-1 h-px bg-[rgba(255,255,255,.08)]"></div>
          </div>
        </template>

        <label v-if="needsEmail" class="flex flex-col gap-[6px]">
          <span class="auth-label">Email</span>
          <input
            ref="emailInput"
            v-model="email"
            class="auth-input"
            type="email"
            autocomplete="email"
            inputmode="email"
            :disabled="busy"
          />
        </label>

        <label v-if="needsPassword" class="flex flex-col gap-[6px]">
          <span class="auth-label flex items-center">
            {{ mode === 'recovery' ? 'New password' : 'Password' }}
            <button
              v-if="mode === 'signIn'"
              type="button"
              class="auth-link ml-auto"
              @click="setMode('reset')"
            >Forgot?</button>
          </span>
          <input
            ref="passwordInput"
            v-model="password"
            class="auth-input"
            type="password"
            :autocomplete="mode === 'signIn' ? 'current-password' : 'new-password'"
            :disabled="busy"
          />
        </label>

        <div
          v-if="error"
          class="text-[12px] leading-[1.45]"
          style="color:var(--color-danger)"
          role="alert"
        >{{ error }}</div>

        <button type="submit" class="auth-btn auth-btn--primary mt-1" :disabled="busy">
          <template v-if="busy">Working…</template>
          <template v-else-if="mode === 'signIn'">Sign in</template>
          <template v-else-if="mode === 'signUp'">Create account</template>
          <template v-else-if="mode === 'reset'">Send reset link</template>
          <template v-else>Set password</template>
        </button>

        <button
          v-if="mode === 'signIn'"
          type="button"
          class="auth-link self-center"
          :disabled="busy"
          @click="magicLink"
        >Email me a sign-in link instead</button>

        <div class="text-[12px] text-center text-[rgba(255,255,255,.45)] mt-1">
          <template v-if="mode === 'signIn'">
            No account? <button type="button" class="auth-link" @click="setMode('signUp')">Create one</button>
          </template>
          <template v-else-if="mode === 'signUp' || mode === 'reset'">
            Have an account? <button type="button" class="auth-link" @click="setMode('signIn')">Sign in</button>
          </template>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.auth-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--color-text-dim);
}
.auth-input {
  height: 38px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--color-text);
  font-size: 13px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.auth-input:focus {
  border-color: rgba(53, 211, 230, 0.6);
  box-shadow: 0 0 0 3px rgba(53, 211, 230, 0.15);
}
.auth-btn {
  height: 40px;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 700;
  transition: background 0.15s, opacity 0.15s;
}
.auth-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.auth-btn--primary {
  background: var(--color-accent);
  color: #08161a;
}
.auth-btn--primary:not(:disabled):hover {
  background: var(--color-accent-bright);
}
.auth-btn--ghost {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--color-text);
}
.auth-btn--ghost:not(:disabled):hover {
  background: rgba(255, 255, 255, 0.1);
}
.auth-link {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-accent-bright);
  letter-spacing: 0;
}
.auth-link:hover {
  text-decoration: underline;
}
</style>
