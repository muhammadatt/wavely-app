<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useAuth } from '../composables/useAuth.js'
import BaseButton from './ui/BaseButton.vue'

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

async function signOut() {
  open.value = false
  await auth.signOut()
}
</script>

<template>
  <template v-if="state.status !== 'disabled'">
    <div class="w-px h-[18px] bg-[rgba(255,255,255,.12)] mx-1"></div>

    <!-- Reserve the slot while Supabase reports in, so the row doesn't jump. -->
    <div v-if="state.status === 'loading'" class="w-[30px] h-[30px]" aria-hidden="true"></div>

    <BaseButton
      v-else-if="state.status === 'signedOut'"
      size="md" color="ghost" :pill="false"
      @click="auth.openDialog('signIn')"
    >
      Sign in
    </BaseButton>

    <div v-else class="relative" data-account-menu>
      <button
        class="h-[30px] flex items-center gap-[7px] pl-[3px] pr-[8px] rounded-full transition-colors hover:bg-[rgba(255,255,255,.08)]"
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
          class="font-['JetBrains_Mono'] text-[8.5px] font-bold tracking-[0.1em] px-[6px] py-[3px] rounded-[5px]"
          :style="isPaid
            ? 'color:#08161a;background:#e0b84a'
            : 'color:rgba(255,255,255,.6);background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1)'"
        >{{ planLabel.toUpperCase() }}</span>
      </button>

      <div
        v-if="open"
        class="absolute right-0 top-[36px] z-[400] w-[230px] rounded-[12px] overflow-hidden font-['Inter']"
        style="background:linear-gradient(155deg,#181c22,#0d1013);box-shadow:0 16px 40px rgba(0,0,0,.5),inset 0 0 0 1px rgba(255,255,255,.08)"
      >
        <div class="px-4 pt-3 pb-[10px] border-b border-[rgba(255,255,255,.07)]">
          <div class="text-[12.5px] font-bold text-[#eaf6f8] truncate">{{ displayName }}</div>
          <div
            v-if="state.account?.user?.displayName"
            class="text-[11px] text-[rgba(255,255,255,.45)] truncate"
          >{{ user?.email }}</div>
          <div class="mt-[6px] text-[11px] text-[rgba(255,255,255,.55)]">
            {{ planLabel }} plan
          </div>
          <div
            v-if="state.accountError"
            class="mt-[6px] text-[11px] leading-[1.4]"
            style="color:var(--color-warn)"
          >Couldn’t load your plan: {{ state.accountError }}</div>
        </div>
        <div class="py-1">
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
