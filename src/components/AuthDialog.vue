<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { useAuth } from '../composables/useAuth.js'
import { useModalFocus } from '../composables/useModalFocus.js'
import { AUTH_PROVIDERS } from '../auth/config.js'
import { authCopy, ACCOUNT_BENEFITS } from '../auth/pitch.js'

/**
 * Sign in / create account / password reset, as one dialog with modes.
 *
 * The mode lives on the auth store (`state.dialog`) rather than here so the
 * store can open it itself — a password-recovery link lands the user on
 * 'recovery' without any component asking for it.
 *
 * Conversion rules this dialog keeps:
 *   - It says WHY: opened from a feature (`state.dialogReason`) the title names
 *     the task the user was in the middle of, not a generic "sign in".
 *   - Sign in and Create account are one tab apart, and switching keeps the
 *     email typed so far.
 *   - Every known failure carries its way out (Sign in instead / Resend the
 *     link / Email me a link) rather than a dead-end message.
 *   - Opened from the upgrade prompt (`state.pendingUpgrade`) it is step 1 of
 *     2, and the store reopens the prompt once the account exists — including
 *     when a confirmation link signs this tab in later.
 */
const auth = useAuth()
const { state } = auth

const email = ref('')
const password = ref('')
const showPassword = ref(false)
const busy = ref(false)
const error = ref(null)
const errorKind = ref(null)
// After a link has been emailed the form gives way to this: { kind, addr }.
const sent = ref(null)
const resendIn = ref(0)
const resentNote = ref('')
const emailInput = ref(null)
const passwordInput = ref(null)

const MIN_PASSWORD = 8
const RESEND_COOLDOWN_S = 30

const PROVIDER_LABELS = { google: 'Google', apple: 'Apple', github: 'GitHub' }

const mode = computed(() => state.dialog)
const copy = computed(() => authCopy(mode.value, state.dialogReason, state.pendingUpgrade))
const isAccountMode = computed(() => mode.value === 'signIn' || mode.value === 'signUp')
const upgradeFlow = computed(() => !!state.pendingUpgrade && isAccountMode.value)

const showProviders = computed(() => isAccountMode.value && AUTH_PROVIDERS.length > 0)
const needsEmail = computed(() => mode.value !== 'recovery')
const needsPassword = computed(() => isAccountMode.value || mode.value === 'recovery')
const newPassword = computed(() => mode.value === 'signUp' || mode.value === 'recovery')
const passwordLongEnough = computed(() => password.value.length >= MIN_PASSWORD)

const submitLabel = computed(() => {
  if (busy.value) return mode.value === 'signUp' ? 'Creating account…' : 'Working…'
  switch (mode.value) {
    case 'signIn': return upgradeFlow.value ? 'Sign in & continue' : 'Sign in'
    case 'signUp': return upgradeFlow.value ? 'Create account & continue' : 'Create free account'
    case 'reset': return 'Send reset link'
    default: return 'Set password'
  }
})

watch(mode, async (m, prev) => {
  clearError()
  sent.value = null
  if (m !== prev) {
    password.value = ''
    showPassword.value = false
  }
  if (!m) return
  await nextTick()
  ;(needsEmail.value && !email.value ? emailInput.value : passwordInput.value ?? emailInput.value)?.focus()
}, { immediate: true })

function clearError() {
  error.value = null
  errorKind.value = null
}

function setMode(m) {
  state.dialog = m
}

function close() {
  // A link is in someone's inbox: if it signs this tab in, the upgrade the
  // user asked for should still be waiting.
  if (!busy.value) auth.closeDialog({ keepIntent: !!sent.value })
}

function validEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
}

function fail(r) {
  error.value = r.error
  errorKind.value = r.errorKind ?? null
}

async function submit() {
  clearError()
  if (needsEmail.value && !validEmail(email.value)) {
    error.value = 'Enter a valid email address.'
    emailInput.value?.focus()
    return
  }
  if (newPassword.value && !passwordLongEnough.value) {
    error.value = `Use at least ${MIN_PASSWORD} characters.`
    passwordInput.value?.focus()
    return
  }
  if (mode.value === 'signIn' && !password.value) {
    error.value = 'Enter your password.'
    passwordInput.value?.focus()
    return
  }

  busy.value = true
  try {
    const addr = email.value.trim()
    if (mode.value === 'signIn') {
      const r = await auth.signInWithPassword(addr, password.value)
      if (r.error) fail(r)
      // On success the store closes the dialog when the session arrives.
    } else if (mode.value === 'signUp') {
      const r = await auth.signUp(addr, password.value)
      if (r.error) fail(r)
      else if (r.needsConfirmation) showSent('confirm', addr)
    } else if (mode.value === 'reset') {
      const r = await auth.sendPasswordReset(addr)
      if (r.error) fail(r)
      else showSent('reset', addr)
    } else if (mode.value === 'recovery') {
      const r = await auth.updatePassword(password.value)
      if (r.error) fail(r)
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
  clearError()
  if (!validEmail(email.value)) {
    error.value = 'Enter your email address first — we’ll send the link there.'
    emailInput.value?.focus()
    return
  }
  busy.value = true
  try {
    const addr = email.value.trim()
    const r = await auth.sendMagicLink(addr)
    if (r.error) fail(r)
    else showSent('magic', addr)
  } finally {
    busy.value = false
  }
}

async function provider(p) {
  clearError()
  const r = await auth.signInWithProvider(p)
  if (r.error) fail(r)
}

// ── After the email has gone ──────────────────────────────────────────────

let cooldownTimer = null
function startCooldown() {
  resendIn.value = RESEND_COOLDOWN_S
  clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    resendIn.value = Math.max(0, resendIn.value - 1)
    if (resendIn.value === 0) clearInterval(cooldownTimer)
  }, 1000)
}
onUnmounted(() => clearInterval(cooldownTimer))

function showSent(kind, addr) {
  sent.value = { kind, addr }
  resentNote.value = ''
  startCooldown()
}

const sentCopy = computed(() => {
  const s = sent.value
  if (!s) return null
  return {
    confirm: { title: 'Confirm your email', body: 'Click the link we sent to finish creating your account.' },
    magic: { title: 'Check your inbox', body: 'Click the link we sent to sign in. No password needed.' },
    reset: { title: 'Check your inbox', body: 'If there’s an account for this address, a reset link is on its way.' },
  }[s.kind]
})

async function resend() {
  if (resendIn.value > 0 || busy.value || !sent.value) return
  busy.value = true
  clearError()
  try {
    const { kind, addr } = sent.value
    const r = kind === 'confirm' ? await auth.resendConfirmation(addr)
      : kind === 'magic' ? await auth.sendMagicLink(addr)
        : await auth.sendPasswordReset(addr)
    if (r.error) fail(r)
    else {
      resentNote.value = 'Sent again.'
      startCooldown()
    }
  } finally {
    busy.value = false
  }
}

function useDifferentEmail() {
  sent.value = null
  clearError()
  nextTick(() => emailInput.value?.focus())
}

/** From the "already registered" error: same email, password kept, sign in. */
function signInInstead() {
  const pw = password.value
  setMode('signIn')
  nextTick(() => {
    password.value = pw
    passwordInput.value?.focus()
  })
}

async function resendFromError() {
  const addr = email.value.trim()
  if (!validEmail(addr)) return
  busy.value = true
  try {
    const r = await auth.resendConfirmation(addr)
    if (r.error) fail(r)
    else showSent('confirm', addr)
  } finally {
    busy.value = false
  }
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
    class="fixed inset-0 z-[690] flex items-start justify-center pt-[9vh] compact:pt-3 px-4 overflow-y-auto dialog-scrim"
    @click.self="close"
    @keydown="onKeydown"
  >
    <div
      class="auth-card w-full max-w-[400px] mb-6 flex flex-col rounded-[18px] overflow-hidden font-['Inter'] dialog-surface"
      style="animation:bounceIn .28s cubic-bezier(.34,1.4,.64,1) both"
      role="dialog"
      aria-modal="true"
      :aria-label="sent ? sentCopy.title : copy.title"
    >
      <!-- Header: the mark, the step (upgrade flow) and close. -->
      <div class="px-6 pt-5 flex items-center gap-[10px]">
        <span class="auth-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" class="w-[15px] h-[15px]" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
            <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
          </svg>
        </span>
        <span v-if="upgradeFlow && !sent" class="auth-steps" aria-label="Step 1 of 2">
          <span class="auth-step is-on">1 Account</span>
          <span class="auth-step-line"></span>
          <span class="auth-step">2 Pro plan</span>
        </span>
        <button
          class="ml-auto w-[28px] h-[28px] -mr-1 rounded-[8px] flex items-center justify-center transition-colors hover:bg-[rgba(255,255,255,.08)]"
          style="color:rgba(255,255,255,.5)"
          aria-label="Close"
          @click="close"
        >
          <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>

      <!-- Sent: the form is done, say what happens next and how to recover. -->
      <div v-if="sent" class="px-6 pt-5 pb-6 flex flex-col items-center text-center">
        <span class="auth-mail" aria-hidden="true">
          <svg viewBox="0 0 24 24" class="w-[24px] h-[24px]" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 6.5l8.5 6.5 8.5-6.5" />
          </svg>
        </span>
        <div class="mt-4 text-[18px] font-bold text-[#eaf6f8]">{{ sentCopy.title }}</div>
        <div class="mt-2 text-[13px] leading-[1.5] text-[rgba(255,255,255,.6)]">
          We sent it to <strong class="text-[#eaf6f8] font-semibold break-all">{{ sent.addr }}</strong>.
          {{ sentCopy.body }}
        </div>
        <div
          v-if="sent.kind !== 'reset'"
          class="mt-4 w-full text-[12px] leading-[1.5] rounded-[10px] px-4 py-3 text-left"
          style="color:#bff6ff;background:rgba(53,211,230,.08);border:1px solid rgba(53,211,230,.22)"
          role="status"
        >
          Keep this tab open — it signs in by itself when you click the link<template v-if="state.pendingUpgrade">, and takes you on to Pro</template>. Your audio and edits stay put.
        </div>
        <div v-if="error" class="mt-3 text-[12px] leading-[1.45]" style="color:var(--color-danger)" role="alert">{{ error }}</div>
        <div class="mt-5 flex items-center gap-2 text-[12px] text-[rgba(255,255,255,.45)]">
          <span>Didn’t get it?</span>
          <button
            type="button"
            class="auth-link"
            :disabled="resendIn > 0 || busy"
            @click="resend"
          >{{ resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend' }}</button>
          <span aria-hidden="true">·</span>
          <button type="button" class="auth-link" @click="useDifferentEmail">Use a different email</button>
        </div>
        <div v-if="resentNote" class="mt-2 text-[11.5px]" style="color:var(--color-accent-bright)" role="status">{{ resentNote }} Check spam if it’s not there in a minute.</div>
      </div>

      <form v-else class="px-6 pt-4 pb-6 flex flex-col" novalidate @submit.prevent="submit">
        <!-- Sign in ⇄ Create account, one tab apart. -->
        <div v-if="isAccountMode" class="auth-tabs" role="tablist" aria-label="Account">
          <button
            type="button" role="tab" class="auth-tab"
            :class="{ 'is-on': mode === 'signUp' }" :aria-selected="String(mode === 'signUp')"
            @click="setMode('signUp')"
          >Create account</button>
          <button
            type="button" role="tab" class="auth-tab"
            :class="{ 'is-on': mode === 'signIn' }" :aria-selected="String(mode === 'signIn')"
            @click="setMode('signIn')"
          >Sign in</button>
        </div>

        <div :class="isAccountMode ? 'mt-5' : 'mt-1'">
          <div class="text-[19px] leading-[1.25] font-bold text-[#eaf6f8] tracking-[-0.01em]">{{ copy.title }}</div>
          <div class="mt-[6px] text-[12.5px] leading-[1.5] text-[rgba(255,255,255,.55)]">{{ copy.subtitle }}</div>
        </div>

        <ul v-if="mode === 'signUp' && !upgradeFlow" class="mt-4 flex flex-col gap-[7px]" aria-label="What you get">
          <li v-for="b in ACCOUNT_BENEFITS" :key="b.feature" class="flex items-start gap-[9px] text-[12.5px] leading-[1.4] text-[rgba(255,255,255,.78)]">
            <svg viewBox="0 0 24 24" class="auth-tick" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
            {{ b.text }}
          </li>
        </ul>

        <div class="mt-5 flex flex-col gap-3">
          <template v-if="showProviders">
            <button
              v-for="p in AUTH_PROVIDERS"
              :key="p"
              type="button"
              class="auth-btn auth-btn--provider"
              :disabled="busy"
              @click="provider(p)"
            >
              <svg v-if="p === 'google'" viewBox="0 0 24 24" class="w-[16px] h-[16px]" aria-hidden="true">
                <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/>
                <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"/>
                <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"/>
                <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"/>
              </svg>
              <svg v-else-if="p === 'apple'" viewBox="0 0 24 24" class="w-[16px] h-[16px]" fill="currentColor" aria-hidden="true">
                <path d="M16.37 12.6c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.77-3.32-1.8-1.41-.14-2.76.83-3.47.83-.72 0-1.82-.81-2.99-.79-1.54.02-2.96.9-3.75 2.27-1.6 2.78-.41 6.89 1.15 9.14.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.98.72 1.23-.02 2.01-1.12 2.77-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.39-.92-2.41-3.66zM14.1 5.86c.63-.77 1.06-1.83.94-2.89-.91.04-2.01.61-2.66 1.37-.58.67-1.09 1.76-.96 2.8 1.02.08 2.05-.52 2.68-1.28z"/>
              </svg>
              <svg v-else-if="p === 'github'" viewBox="0 0 24 24" class="w-[16px] h-[16px]" fill="currentColor" aria-hidden="true">
                <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2 0 1.9 1.2 1.9 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2 0-.4-.5-1.6.2-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.6.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/>
              </svg>
              Continue with {{ PROVIDER_LABELS[p] }}
            </button>
            <div class="flex items-center gap-3 my-[2px]">
              <div class="flex-1 h-px bg-[rgba(255,255,255,.08)]"></div>
              <span class="text-[10.5px] font-semibold tracking-[0.08em] text-[rgba(255,255,255,.35)]">OR WITH EMAIL</span>
              <div class="flex-1 h-px bg-[rgba(255,255,255,.08)]"></div>
            </div>
          </template>

          <label v-if="needsEmail" class="flex flex-col gap-[6px]">
            <span class="auth-label">Email</span>
            <input
              ref="emailInput"
              v-model="email"
              class="auth-input"
              :class="{ 'is-bad': error && errorKind == null && !validEmail(email) }"
              type="email"
              autocomplete="email"
              inputmode="email"
              placeholder="you@example.com"
              :disabled="busy"
              @input="error && clearError()"
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
              >Forgot password?</button>
            </span>
            <span class="relative flex">
              <input
                ref="passwordInput"
                v-model="password"
                class="auth-input flex-1 pr-[64px]"
                :type="showPassword ? 'text' : 'password'"
                :autocomplete="mode === 'signIn' ? 'current-password' : 'new-password'"
                :placeholder="newPassword ? `At least ${MIN_PASSWORD} characters` : ''"
                :disabled="busy"
                @input="error && clearError()"
              />
              <button
                type="button"
                class="auth-reveal"
                :aria-pressed="String(showPassword)"
                :aria-label="showPassword ? 'Hide password' : 'Show password'"
                @click="showPassword = !showPassword"
              >{{ showPassword ? 'Hide' : 'Show' }}</button>
            </span>
            <span
              v-if="newPassword && password"
              class="text-[11px] flex items-center gap-[5px]"
              :style="{ color: passwordLongEnough ? 'var(--color-accent-bright)' : 'rgba(255,255,255,.45)' }"
            >
              <svg v-if="passwordLongEnough" viewBox="0 0 24 24" class="w-[11px] h-[11px]" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
              {{ passwordLongEnough ? 'Good length' : `${MIN_PASSWORD - password.length} more character${MIN_PASSWORD - password.length === 1 ? '' : 's'}` }}
            </span>
          </label>

          <!-- Every known failure offers its own way out. -->
          <div
            v-if="error"
            class="auth-error"
            role="alert"
          >
            <span>{{ error }}</span>
            <button v-if="errorKind === 'exists'" type="button" class="auth-link" @click="signInInstead">Sign in instead</button>
            <button v-else-if="errorKind === 'unconfirmed'" type="button" class="auth-link" :disabled="busy" @click="resendFromError">Resend the confirmation link</button>
            <button v-else-if="errorKind === 'credentials'" type="button" class="auth-link" :disabled="busy" @click="magicLink">Email me a sign-in link instead</button>
          </div>

          <button type="submit" class="auth-btn auth-btn--primary mt-1" :disabled="busy">
            <span v-if="busy" class="auth-spinner" aria-hidden="true"></span>
            {{ submitLabel }}
          </button>

          <button
            v-if="isAccountMode"
            type="button"
            class="auth-link self-center"
            :disabled="busy"
            @click="magicLink"
          >{{ mode === 'signUp' ? 'Rather not pick a password? Email me a link' : 'Email me a sign-in link instead' }}</button>

          <div v-if="mode === 'reset'" class="text-[12px] text-center text-[rgba(255,255,255,.45)]">
            Remembered it? <button type="button" class="auth-link" @click="setMode('signIn')">Back to sign in</button>
          </div>
        </div>

        <div v-if="mode === 'signUp'" class="mt-5 pt-4 border-t border-[rgba(255,255,255,.07)] flex items-center justify-center gap-[14px] text-[11px] text-[rgba(255,255,255,.4)]">
          <span>No credit card</span>
          <span aria-hidden="true">·</span>
          <span>Free forever plan</span>
          <span aria-hidden="true">·</span>
          <span>Nothing to install</span>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.auth-mark {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #08161a;
  background: linear-gradient(135deg, #7ef0ff, #25b6d0);
  box-shadow: 0 4px 14px rgba(53, 211, 230, 0.28);
}
.auth-steps {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.auth-step {
  color: rgba(255, 255, 255, 0.38);
}
.auth-step.is-on {
  color: var(--color-accent-bright);
}
.auth-step-line {
  width: 14px;
  height: 1px;
  background: rgba(255, 255, 255, 0.2);
}
.auth-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 3px;
  border-radius: 11px;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.auth-tab {
  height: 32px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.55);
  transition: background 0.15s, color 0.15s;
}
.auth-tab:hover {
  color: var(--color-text);
}
.auth-tab.is-on {
  color: #eaf6f8;
  background: rgba(255, 255, 255, 0.09);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 1px 3px rgba(0, 0, 0, 0.35);
}
.auth-tick {
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 1px;
  padding: 2px;
  border-radius: 999px;
  color: #08161a;
  background: var(--color-accent);
}
.auth-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--color-text-dim);
}
.auth-input {
  height: 40px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.11);
  color: var(--color-text);
  font-size: 13.5px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.auth-input::placeholder {
  color: rgba(255, 255, 255, 0.25);
}
.auth-input:focus {
  border-color: rgba(53, 211, 230, 0.6);
  box-shadow: 0 0 0 3px rgba(53, 211, 230, 0.15);
}
.auth-input.is-bad {
  border-color: color-mix(in srgb, var(--color-danger) 70%, transparent);
}
.auth-reveal {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  height: 28px;
  padding: 0 10px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.55);
}
.auth-reveal:hover {
  color: var(--color-text);
  background: rgba(255, 255, 255, 0.07);
}
.auth-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  font-size: 12px;
  line-height: 1.45;
  color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-danger) 28%, transparent);
}
.auth-btn {
  height: 42px;
  border-radius: var(--radius-md);
  font-size: 13.5px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  transition: background 0.15s, opacity 0.15s, transform 0.1s;
}
.auth-btn:not(:disabled):active {
  transform: translateY(1px);
}
.auth-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.auth-btn--primary {
  background: linear-gradient(180deg, var(--color-accent-bright), var(--color-accent));
  color: #08161a;
  box-shadow: 0 6px 18px rgba(53, 211, 230, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.35);
}
.auth-btn--primary:not(:disabled):hover {
  background: var(--color-accent-bright);
}
.auth-btn--provider {
  background: #f4f7f8;
  color: #12171c;
  font-weight: 600;
}
.auth-btn--provider:not(:disabled):hover {
  background: #ffffff;
}
.auth-spinner {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  border: 2px solid rgba(8, 22, 26, 0.25);
  border-top-color: #08161a;
  animation: auth-spin 0.7s linear infinite;
}
@keyframes auth-spin {
  to { transform: rotate(360deg); }
}
.auth-mail {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-accent-bright);
  background: rgba(53, 211, 230, 0.1);
  border: 1px solid rgba(53, 211, 230, 0.25);
}
.auth-link {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-accent-bright);
  letter-spacing: 0;
}
.auth-link:disabled {
  color: rgba(255, 255, 255, 0.35);
  cursor: default;
}
.auth-link:not(:disabled):hover {
  text-decoration: underline;
}
</style>
