<script setup>
import { computed, ref, nextTick } from 'vue'
import { useAuth } from '../../composables/useAuth.js'
import { signInMethods } from '../../auth/accountSummary.js'
import AccountPasswordForm from './AccountPasswordForm.vue'

/** Password, the ways this account logs in, and signing out (here or everywhere). */
const auth = useAuth()
const { user } = auth
const methods = computed(() => signInMethods(user.value))

const busy = ref(false)
const error = ref(null)
const confirmEverywhere = ref(false)
const everywhereBtn = ref(null)
const confirmBtn = ref(null)

// Each swap removes the focused button; without moving focus it falls to
// <body>, outside the dashboard's key handler, where Space / Delete would
// reach the editor's shortcuts behind it.
async function askEverywhere() {
  confirmEverywhere.value = true
  await nextTick()
  confirmBtn.value?.focus()
}

async function cancelEverywhere() {
  confirmEverywhere.value = false
  await nextTick()
  everywhereBtn.value?.focus()
}

async function signOut(everywhere) {
  error.value = null
  busy.value = true
  try {
    const { error: err } = everywhere ? await auth.signOutEverywhere() : await auth.signOut()
    // On success the session ends and the dashboard closes with it.
    if (err) error.value = `Couldn’t sign out: ${err}`
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <div>
      <h1 class="acc-h1" tabindex="-1">Security</h1>
      <p class="acc-lead mt-1">How you log in, and where you’re logged in.</p>
    </div>

    <AccountPasswordForm />

    <section class="acc-card" aria-labelledby="acc-sec-methods">
      <h2 id="acc-sec-methods" class="acc-card-title">Ways to log in</h2>
      <ul v-if="methods.length" class="flex flex-col">
        <li v-for="m in methods" :key="m.provider" class="acc-row">
          <span class="acc-chip">{{ m.label }}</span>
          <span class="min-w-0 flex-1 truncate text-[12.5px] text-[rgba(255,255,255,.7)]">
            <template v-if="m.provider === 'email'">Email and password, or an emailed link</template>
            <template v-else>{{ m.email || `Your ${m.label} account` }}</template>
          </span>
          <span v-if="m.since" class="acc-fine whitespace-nowrap">Added {{ m.since }}</span>
        </li>
      </ul>
      <p v-else class="acc-body">No log-in methods to show.</p>
    </section>

    <section class="acc-card" aria-labelledby="acc-sec-sessions">
      <h2 id="acc-sec-sessions" class="acc-card-title">Sessions</h2>
      <div class="acc-row">
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-bold text-[#eaf6f8]">This browser</div>
          <div class="acc-body">Sign out here. Unsaved edits stay open in the editor.</div>
        </div>
        <button class="acc-btn acc-btn--ghost" :disabled="busy" @click="signOut(false)">Sign out</button>
      </div>
      <div class="acc-row">
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-bold text-[#eaf6f8]">Every device</div>
          <div class="acc-body">
            Signs you out here and on every other browser and device. Others drop off within the hour.
            Use it if you logged in somewhere you no longer use.
          </div>
        </div>
        <button v-if="!confirmEverywhere" ref="everywhereBtn" class="acc-btn acc-btn--danger" :disabled="busy" @click="askEverywhere">Sign out everywhere</button>
      </div>
      <div v-if="confirmEverywhere" class="acc-error" role="alert">
        <span>Sign out on every device, including this one?</span>
        <span class="flex items-center gap-3 mt-1">
          <button ref="confirmBtn" class="acc-btn acc-btn--danger" :disabled="busy" @click="signOut(true)">
            <span v-if="busy" class="acc-spinner" aria-hidden="true"></span>
            Yes, sign out everywhere
          </button>
          <button class="acc-link acc-link--dim" :disabled="busy" @click="cancelEverywhere">Cancel</button>
        </span>
      </div>
      <div v-if="error" class="acc-error" role="alert">{{ error }}</div>
    </section>
  </div>
</template>
