<script setup>
import { computed, ref, nextTick } from 'vue'
import { useAuth } from '../../composables/useAuth.js'
import { hasEmailIdentity } from '../../auth/authStore.js'
import { MIN_PASSWORD, passwordStrength } from '../../auth/passwordStrength.js'

/**
 * Change (or set) the password — the Security section's first card.
 *
 * An account with an email identity gives its current password, checked by
 * signing in with it (`changePassword` in authStore.js — Supabase's
 * updateUser accepts a new password from any live session). The reset link
 * is the way out for one who forgot it, or only ever used magic links and so
 * never had one. An account with only provider identities has nothing to
 * check and SETS a password instead.
 *
 * Escape inside the open form cancels the form, and goes no further — the
 * screen's own Escape would close the whole dashboard.
 */
const auth = useAuth()
const { state, user } = auth

const email = computed(() => state.account?.user?.email ?? user.value?.email ?? '')
const checksCurrent = computed(() => hasEmailIdentity(user.value))

const formOpen = ref(false)
const currentPw = ref('')
const newPw = ref('')
const showPw = ref(false)
const busy = ref(false)
const error = ref(null)
const errorKind = ref(null)
const done = ref(false)
const resetSent = ref(false)
const strength = computed(() => passwordStrength(newPw.value))
const currentInput = ref(null)
const newInput = ref(null)
const openBtn = ref(null)

async function openForm() {
  formOpen.value = true
  done.value = false
  resetSent.value = false
  await nextTick()
  ;(checksCurrent.value ? currentInput : newInput).value?.focus()
}

async function cancel() {
  formOpen.value = false
  currentPw.value = ''
  newPw.value = ''
  error.value = null
  errorKind.value = null
  await nextTick()
  openBtn.value?.focus()
}

function clearError() {
  error.value = null
  errorKind.value = null
}

async function save() {
  clearError()
  if (checksCurrent.value && !currentPw.value) {
    error.value = 'Enter your current password.'
    currentInput.value?.focus()
    return
  }
  if (newPw.value.length < MIN_PASSWORD) {
    error.value = `Use at least ${MIN_PASSWORD} characters.`
    newInput.value?.focus()
    return
  }
  if (checksCurrent.value && newPw.value === currentPw.value) {
    error.value = 'Choose a password different from your current one.'
    newInput.value?.focus()
    return
  }
  busy.value = true
  try {
    const r = await auth.changePassword(checksCurrent.value ? currentPw.value : null, newPw.value)
    if (r.error) {
      error.value = r.error
      errorKind.value = r.errorKind
      ;(r.errorKind === 'currentPassword' ? currentInput : newInput).value?.focus()
      return
    }
    await cancel()
    done.value = true
  } finally {
    busy.value = false
  }
}

async function sendReset() {
  if (!email.value) return
  busy.value = true
  try {
    const r = await auth.sendPasswordReset(email.value)
    if (r.error) {
      error.value = r.error
      errorKind.value = null
      return
    }
    await cancel()
    resetSent.value = true
  } finally {
    busy.value = false
  }
}

function onKeydown(e) {
  if (e.key === 'Escape' && formOpen.value) {
    e.stopPropagation()
    cancel()
  }
}
</script>

<template>
  <section class="acc-card" aria-labelledby="acc-pw-title" @keydown="onKeydown">
    <div class="flex items-center gap-3">
      <div class="min-w-0 flex-1">
        <h2 id="acc-pw-title" class="acc-card-title">Password</h2>
        <p v-if="!formOpen" class="acc-body mt-1">
          <template v-if="checksCurrent">Used to log in with {{ email }}.</template>
          <template v-else>You log in with a connected account. Set a password to log in with your email too.</template>
        </p>
      </div>
      <button v-if="!formOpen" ref="openBtn" class="acc-btn acc-btn--ghost" @click="openForm">
        {{ checksCurrent ? 'Change password' : 'Set a password' }}
      </button>
    </div>

    <div v-if="done && !formOpen" class="acc-ok" role="status">Password changed. Use it the next time you log in.</div>
    <div v-else-if="resetSent && !formOpen" class="acc-ok" role="status">We sent a reset link to {{ email }}. Open it to choose a new password.</div>

    <form v-if="formOpen" class="flex flex-col gap-[12px] max-w-[420px]" novalidate @submit.prevent="save">
      <!-- Lets a password manager file the new password under the right account. -->
      <input type="email" autocomplete="username" :value="email" class="sr-only" tabindex="-1" aria-hidden="true" readonly />
      <label v-if="checksCurrent" class="flex flex-col gap-[6px]">
        <span class="acc-field-label">CURRENT PASSWORD</span>
        <input
          ref="currentInput"
          v-model="currentPw"
          class="acc-input"
          :type="showPw ? 'text' : 'password'"
          autocomplete="current-password"
          :disabled="busy"
          @input="error && clearError()"
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
            :disabled="busy"
            @input="error && clearError()"
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

      <div v-if="error" class="acc-error" role="alert">
        <span>{{ error }}</span>
        <button v-if="errorKind === 'currentPassword'" type="button" class="acc-link" :disabled="busy" @click="sendReset">Forgot it? Email me a reset link</button>
      </div>

      <div class="flex items-center gap-[10px]">
        <button type="submit" class="acc-btn acc-btn--primary" :disabled="busy">
          <span v-if="busy" class="acc-spinner" aria-hidden="true"></span>
          {{ checksCurrent ? 'Change password' : 'Set password' }}
        </button>
        <button type="button" class="acc-btn acc-btn--ghost" :disabled="busy" @click="cancel">Cancel</button>
      </div>
      <button
        v-if="checksCurrent && errorKind !== 'currentPassword'"
        type="button"
        class="acc-link acc-link--dim self-start"
        :disabled="busy"
        @click="sendReset"
      >Never set one, or forgot it? Email me a reset link</button>
    </form>
  </section>
</template>
