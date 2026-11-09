<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { useAuth } from '../composables/useAuth.js'
import { useModalFocus } from '../composables/useModalFocus.js'
import { AUTH_PROVIDERS } from '../auth/config.js'
import { authCopy, ACCOUNT_BENEFITS } from '../auth/pitch.js'
import { MIN_PASSWORD, passwordStrength } from '../auth/passwordStrength.js'

/**
 * Sign in / create account / password reset, as one dialog with modes.
 *
 * Laid out as design 2c (`docs/design/create-account/Create_Account_Explorations.dc.html`,
 * owner, November 2026): a SPLIT PANEL — the pitch on the left (logo, the
 * headline, three benefits, "free forever"), the form on the right — that
 * collapses to the form column alone on a compact viewport. The form has a
 * live strength meter under the password and a passwordless path one button
 * away ('link' view: one field and "Send link →").
 *
 * The mode lives on the auth store (`state.dialog`) rather than here so the
 * store can open it itself — a password-recovery link lands the user on
 * 'recovery' without any component asking for it.
 *
 * Conversion rules this dialog keeps:
 *   - It says WHY: opened from a feature (`state.dialogReason`) the headline
 *     names the task the user was in the middle of.
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
// 'pw' (email + password) | 'link' (email only, a sign-in link)
const view = ref('pw')
// After a link has been emailed the form gives way to this: { kind, addr }.
const sent = ref(null)
const resendIn = ref(0)
const resentNote = ref('')
const emailInput = ref(null)
const passwordInput = ref(null)
const linkInput = ref(null)

const RESEND_COOLDOWN_S = 30

const PROVIDER_LABELS = { google: 'Google', apple: 'Apple', github: 'GitHub' }

const mode = computed(() => state.dialog)
const copy = computed(() => authCopy(mode.value, state.dialogReason, state.pendingUpgrade))
const isAccountMode = computed(() => mode.value === 'signIn' || mode.value === 'signUp')
const upgradeFlow = computed(() => !!state.pendingUpgrade && isAccountMode.value)

/** The pitch's headline ends in a full stop, as the design sets it. */
const headline = computed(() => (isAccountMode.value
  ? copy.value.title.replace(/[.!?]?$/, (m) => m || '.')
  // Reset and recovery carry their own title in the form column; the pitch
  // stays a welcome rather than saying the same thing twice.
  : 'Welcome back.'))
/** The benefits ARE the pitch for a plain sign-up; every other account case says its own line. */
const showSubtitle = computed(() => isAccountMode.value && !(mode.value === 'signUp' && !upgradeFlow.value))
const showBenefits = computed(() => !upgradeFlow.value)

const showProviders = computed(() => isAccountMode.value && AUTH_PROVIDERS.length > 0)
const needsEmail = computed(() => mode.value !== 'recovery')
const needsPassword = computed(() => isAccountMode.value || mode.value === 'recovery')
const newPassword = computed(() => mode.value === 'signUp' || mode.value === 'recovery')
const strength = computed(() => passwordStrength(password.value))

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
    if (!isAccountMode.value) view.value = 'pw'
  }
  if (!m) return
  await nextTick()
  focusFirst()
}, { immediate: true })

function focusFirst() {
  if (view.value === 'link') return linkInput.value?.focus()
  ;(needsEmail.value && !email.value ? emailInput.value : passwordInput.value ?? emailInput.value)?.focus()
}

function clearError() {
  error.value = null
  errorKind.value = null
}

function setMode(m) {
  state.dialog = m
}

function setView(v) {
  view.value = v
  clearError()
  nextTick(focusFirst)
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
  if (newPassword.value && password.value.length < MIN_PASSWORD) {
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
    error.value = 'Enter your email address — we’ll send the link there.'
    ;(view.value === 'link' ? linkInput : emailInput).value?.focus()
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
  const after = state.pendingUpgrade ? ', and takes you on to Pro' : ''
  return {
    confirm: { title: `Check ${s.addr}`, body: `Click the link to confirm your account. Keep working — this tab signs in by itself${after}.` },
    magic: { title: `Check ${s.addr}`, body: `Keep working — this tab signs in when you click the link${after}.` },
    reset: { title: `Check ${s.addr}`, body: 'If there’s an account for this address, a reset link is on its way.' },
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
      resentNote.value = 'Sent again — check spam if it’s not there in a minute.'
      startCooldown()
    }
  } finally {
    busy.value = false
  }
}

function useDifferentEmail() {
  const wasLink = sent.value?.kind === 'magic'
  sent.value = null
  clearError()
  if (wasLink) view.value = 'link'
  nextTick(focusFirst)
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
      class="auth-card mb-6 font-['Inter'] dialog-surface"
      style="animation:bounceIn .28s cubic-bezier(.34,1.4,.64,1) both"
      role="dialog"
      aria-modal="true"
      :aria-label="sent ? sentCopy.title : copy.title"
    >
      <!-- ── The pitch ─────────────────────────────────────────────── -->
      <aside class="auth-pitch">
        <img src="/crisp-fm-logo.png" alt="crisp.fm" class="auth-logo" draggable="false" />
        <div class="flex flex-col gap-[18px]">
          <span v-if="upgradeFlow" class="auth-steps" aria-label="Step 1 of 2">
            <span class="is-on">1 Account</span><span class="auth-step-line"></span><span>2 Pro plan</span>
          </span>
          <div>
            <div class="auth-headline">{{ headline }}</div>
            <div v-if="showSubtitle" class="mt-[10px] text-[13px] leading-[1.5] text-[rgba(255,255,255,.55)]">{{ copy.subtitle }}</div>
          </div>
          <ul v-if="showBenefits" class="flex flex-col gap-[14px]" aria-label="What you get">
            <li v-for="b in ACCOUNT_BENEFITS" :key="b.id" class="flex flex-col gap-[2px]">
              <span class="text-[13px] font-bold text-[#eaf6f8]">{{ b.title }}</span>
              <span class="text-[12px] leading-[1.45] text-[rgba(255,255,255,.5)]">{{ b.text }}</span>
            </li>
          </ul>
        </div>
        <div class="auth-fine">FREE FOREVER · NO CARD NEEDED</div>
      </aside>

      <!-- ── The form ──────────────────────────────────────────────── -->
      <div class="auth-form">
        <!-- Compact: the pitch column is gone, so the logo moves here. -->
        <img src="/crisp-fm-logo.png" alt="" aria-hidden="true" class="auth-logo auth-logo--compact" draggable="false" />

        <div class="flex items-center gap-[10px]">
          <div v-if="isAccountMode && !sent" class="auth-tabs" role="tablist" aria-label="Account">
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
          <div v-else class="flex-1 text-[19px] font-extrabold tracking-[-0.01em] text-[#eaf6f8]">
            {{ sent ? 'Check your inbox' : copy.title }}
          </div>
          <button class="auth-close" aria-label="Close" @click="close">
            <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>

        <!-- Compact only: the headline the pitch column carried. -->
        <div v-if="!sent && isAccountMode" class="auth-compact-head">
          <div class="text-[17px] font-extrabold tracking-[-0.01em] text-[#eaf6f8]">{{ copy.title }}</div>
          <div class="mt-1 text-[12px] leading-[1.45] text-[rgba(255,255,255,.55)]">{{ copy.subtitle }}</div>
        </div>

        <!-- ── Sent ──────────────────────────────────────────────── -->
        <div v-if="sent" class="flex flex-col gap-[18px]">
          <div class="auth-sent" role="status">
            <span class="auth-sent-dot" aria-hidden="true"></span>
            <div class="flex flex-col gap-1 min-w-0">
              <div class="text-[14px] font-bold text-[#bff6ff] break-all">{{ sentCopy.title }}</div>
              <div class="text-[12.5px] leading-[1.5] text-[rgba(255,255,255,.65)]">{{ sentCopy.body }}</div>
            </div>
          </div>
          <div v-if="error" class="auth-error" role="alert"><span>{{ error }}</span></div>
          <div class="flex justify-between">
            <button type="button" class="auth-link" :disabled="resendIn > 0 || busy" @click="resend">
              {{ resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend link' }}
            </button>
            <button type="button" class="auth-link auth-link--dim" @click="useDifferentEmail">Use a different email</button>
          </div>
          <div v-if="resentNote" class="text-[11.5px] text-[var(--color-accent-bright)]" role="status">{{ resentNote }}</div>
        </div>

        <!-- ── Passwordless ──────────────────────────────────────── -->
        <form v-else-if="isAccountMode && view === 'link'" class="flex flex-col gap-[18px]" novalidate @submit.prevent="magicLink">
          <div class="flex flex-col gap-[6px]">
            <div class="text-[19px] font-extrabold tracking-[-0.01em] text-[#eaf6f8]">No password needed</div>
            <div class="text-[13px] leading-[1.5] text-[rgba(255,255,255,.5)]">
              Enter your email and we’ll send a link that {{ mode === 'signUp' ? 'creates your account and signs you in' : 'signs you in' }}.
            </div>
          </div>
          <div class="auth-combo">
            <input
              ref="linkInput"
              v-model="email"
              type="email"
              autocomplete="email"
              inputmode="email"
              placeholder="you@example.com"
              aria-label="Email"
              :disabled="busy"
              @input="error && clearError()"
            />
            <button type="submit" class="auth-combo-btn" :disabled="busy">
              <span v-if="busy" class="auth-spinner" aria-hidden="true"></span>
              <template v-else>Send link →</template>
            </button>
          </div>
          <div v-if="error" class="auth-error" role="alert"><span>{{ error }}</span></div>
          <button type="button" class="auth-link self-start" @click="setView('pw')">← Use a password instead</button>
        </form>

        <!-- ── Email + password (and reset / recovery) ───────────── -->
        <form v-else class="flex flex-col gap-[18px]" novalidate @submit.prevent="submit">
          <div v-if="mode === 'reset' || mode === 'recovery'" class="-mt-2 text-[13px] leading-[1.5] text-[rgba(255,255,255,.55)]">{{ copy.subtitle }}</div>

          <label v-if="needsEmail" class="flex flex-col gap-[6px]">
            <span class="auth-label">EMAIL</span>
            <input
              ref="emailInput"
              v-model="email"
              class="auth-input"
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
              {{ mode === 'recovery' ? 'NEW PASSWORD' : 'PASSWORD' }}
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
                class="auth-input flex-1 min-w-0 pr-[56px]"
                :type="showPassword ? 'text' : 'password'"
                :autocomplete="mode === 'signIn' ? 'current-password' : 'new-password'"
                :placeholder="newPassword ? 'Type to see strength' : ''"
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
            <template v-if="newPassword">
              <span class="auth-meter" aria-hidden="true">
                <span v-for="i in 4" :key="i" :style="{ background: i <= strength.score ? strength.color : 'rgba(255,255,255,.1)' }"></span>
              </span>
              <span
                class="text-[11.5px]"
                :style="{ color: strength.score === 0 ? 'rgba(255,255,255,.42)' : strength.weak ? '#ff8a80' : 'rgba(255,255,255,.65)' }"
                aria-live="polite"
              >{{ strength.hint }}</span>
            </template>
          </label>

          <!-- Every known failure offers its own way out. -->
          <div v-if="error" class="auth-error" role="alert">
            <span>{{ error }}</span>
            <button v-if="errorKind === 'exists'" type="button" class="auth-link" @click="signInInstead">Sign in instead</button>
            <button v-else-if="errorKind === 'unconfirmed'" type="button" class="auth-link" :disabled="busy" @click="resendFromError">Resend the confirmation link</button>
            <button v-else-if="errorKind === 'credentials'" type="button" class="auth-link" :disabled="busy" @click="magicLink">Email me a sign-in link instead</button>
          </div>

          <button type="submit" class="auth-btn auth-btn--primary" :disabled="busy">
            <span v-if="busy" class="auth-spinner" aria-hidden="true"></span>
            {{ submitLabel }}
          </button>

          <template v-if="isAccountMode">
            <div class="flex items-center gap-3">
              <div class="flex-1 h-px bg-[rgba(255,255,255,.08)]"></div>
              <span class="text-[10.5px] font-semibold tracking-[0.08em] text-[rgba(255,255,255,.35)]">OR</span>
              <div class="flex-1 h-px bg-[rgba(255,255,255,.08)]"></div>
            </div>
            <div class="flex flex-col gap-[10px]">
              <button
                v-for="p in showProviders ? AUTH_PROVIDERS : []"
                :key="p"
                type="button"
                class="auth-btn auth-btn--ghost"
                :disabled="busy"
                @click="provider(p)"
              >
                <svg v-if="p === 'google'" viewBox="0 0 24 24" class="w-[15px] h-[15px]" aria-hidden="true">
                  <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/>
                  <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"/>
                  <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"/>
                  <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"/>
                </svg>
                <svg v-else-if="p === 'apple'" viewBox="0 0 24 24" class="w-[15px] h-[15px]" fill="currentColor" aria-hidden="true">
                  <path d="M16.37 12.6c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.77-3.32-1.8-1.41-.14-2.76.83-3.47.83-.72 0-1.82-.81-2.99-.79-1.54.02-2.96.9-3.75 2.27-1.6 2.78-.41 6.89 1.15 9.14.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.98.72 1.23-.02 2.01-1.12 2.77-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.39-.92-2.41-3.66zM14.1 5.86c.63-.77 1.06-1.83.94-2.89-.91.04-2.01.61-2.66 1.37-.58.67-1.09 1.76-.96 2.8 1.02.08 2.05-.52 2.68-1.28z"/>
                </svg>
                <svg v-else-if="p === 'github'" viewBox="0 0 24 24" class="w-[15px] h-[15px]" fill="currentColor" aria-hidden="true">
                  <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2 0 1.9 1.2 1.9 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2 0-.4-.5-1.6.2-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.6.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/>
                </svg>
                Continue with {{ PROVIDER_LABELS[p] }}
              </button>
              <button type="button" class="auth-btn auth-btn--ghost" :disabled="busy" @click="setView('link')">Email me a sign-in link</button>
            </div>
          </template>

          <div v-if="mode === 'reset'" class="text-[12px] text-[rgba(255,255,255,.45)]">
            Remembered it? <button type="button" class="auth-link" @click="setMode('signIn')">Back to sign in</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-card {
  width: 720px;
  max-width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  border-radius: 20px;
  overflow: hidden;
}

/* ── Pitch column ─────────────────────────────────────────────────────── */
.auth-pitch {
  padding: 28px 26px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 24px;
  background: linear-gradient(180deg, rgba(53, 211, 230, 0.1), rgba(53, 211, 230, 0.02));
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}
.auth-logo {
  height: 22px;
  width: auto;
  align-self: flex-start;
  user-select: none;
}
.auth-logo--compact {
  display: none;
}
.auth-headline {
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.15;
  color: #eaf6f8;
  text-wrap: balance;
}
.auth-fine {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.42);
}
.auth-steps {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: rgba(255, 255, 255, 0.38);
}
.auth-steps .is-on {
  color: var(--color-accent-bright);
}
.auth-step-line {
  width: 14px;
  height: 1px;
  background: rgba(255, 255, 255, 0.2);
}

/* ── Form column ──────────────────────────────────────────────────────── */
.auth-form {
  padding: 22px 26px 26px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
}
.auth-compact-head {
  display: none;
}
.auth-tabs {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 4px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.25);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}
.auth-tab {
  height: 36px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  color: #eaf6f8;
  transition: background 0.15s, color 0.15s;
}
.auth-tab:not(.is-on):hover {
  background: rgba(255, 255, 255, 0.08);
}
.auth-tab.is-on {
  font-weight: 700;
  color: #08161a;
  background: var(--color-accent);
  box-shadow: 0 2px 10px rgba(53, 211, 230, 0.25);
}
.auth-close {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.5);
}
.auth-close:hover {
  background: rgba(255, 255, 255, 0.08);
}
.auth-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.5);
}
.auth-input {
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
.auth-input::placeholder,
.auth-combo input::placeholder {
  color: rgba(255, 255, 255, 0.3);
}
.auth-input:focus {
  border-color: rgba(53, 211, 230, 0.6);
  box-shadow: 0 0 0 3px rgba(53, 211, 230, 0.15);
}
.auth-reveal {
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
.auth-reveal:hover {
  color: var(--color-text);
  background: rgba(255, 255, 255, 0.08);
}
.auth-meter {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
  margin-top: 2px;
}
.auth-meter > span {
  height: 4px;
  border-radius: 2px;
  transition: background 0.2s;
}
.auth-combo {
  display: flex;
  padding: 4px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(53, 211, 230, 0.55);
  box-shadow: 0 0 0 3px rgba(53, 211, 230, 0.12);
}
.auth-combo input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 10px;
  background: transparent;
  color: var(--color-text);
  font-size: 14px;
  outline: none;
}
.auth-combo-btn {
  height: 40px;
  min-width: 104px;
  padding: 0 16px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
  color: #08161a;
  background: var(--color-accent);
}
.auth-combo-btn:not(:disabled):hover {
  background: var(--color-accent-bright);
}
.auth-sent {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding: 16px 18px;
  border-radius: 12px;
  background: rgba(53, 211, 230, 0.09);
  border: 1px solid rgba(53, 211, 230, 0.25);
}
.auth-sent-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: var(--color-accent);
  box-shadow: 0 0 0 4px rgba(53, 211, 230, 0.18);
}
.auth-error {
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
.auth-btn {
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
.auth-btn:not(:disabled):active {
  transform: translateY(1px);
}
.auth-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.auth-btn--primary {
  height: 44px;
  font-size: 14px;
  color: #08161a;
  background: var(--color-accent);
  box-shadow: 0 8px 24px rgba(53, 211, 230, 0.22);
}
.auth-btn--primary:not(:disabled):hover {
  background: var(--color-accent-bright);
}
.auth-btn--ghost {
  color: #eaf6f8;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.auth-btn--ghost:not(:disabled):hover {
  background: rgba(255, 255, 255, 0.1);
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
.auth-link {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-accent-bright);
  letter-spacing: 0;
}
.auth-link--dim {
  color: rgba(255, 255, 255, 0.5);
}
.auth-link:disabled {
  color: rgba(255, 255, 255, 0.35);
  cursor: default;
}
.auth-link:not(:disabled):hover {
  text-decoration: underline;
}

/* ── Compact: the form column alone ───────────────────────────────────────
   The split needs ~720 px; below that (and on a short landscape phone, the
   app's `compact:` variant) the pitch goes and the form carries the logo
   and a one-line headline. */
@media (max-width: 760px), (max-height: 520px) {
  .auth-card {
    width: 420px;
    grid-template-columns: minmax(0, 1fr);
  }
  .auth-pitch {
    display: none;
  }
  .auth-logo--compact {
    display: block;
    height: 20px;
  }
  .auth-compact-head {
    display: block;
  }
}
</style>
