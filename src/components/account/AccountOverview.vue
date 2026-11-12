<script setup>
import { computed } from 'vue'
import { useAuth } from '../../composables/useAuth.js'
import { formatPeriodDate, signInMethods } from '../../auth/accountSummary.js'
import AccountPlanCard from './AccountPlanCard.vue'

/** Who you are, your plan at a glance, and the way to each other section. */
const emit = defineEmits(['go'])

const { state, user, plan } = useAuth()
const email = computed(() => state.account?.user?.email ?? user.value?.email ?? '')
const displayName = computed(() => state.account?.user?.displayName || '')
const initial = computed(() => ((displayName.value || email.value).trim()[0] ?? '?').toUpperCase())
const memberSince = computed(() => formatPeriodDate(state.account?.user?.createdAt ?? user.value?.created_at))
const methods = computed(() => signInMethods(user.value))
const greeting = computed(() => (displayName.value ? `Hi, ${displayName.value.split(/\s+/)[0]}` : 'Your account'))
</script>

<template>
  <div class="flex flex-col gap-5">
    <div>
      <h1 class="acc-h1" tabindex="-1">{{ greeting }}</h1>
      <p class="acc-lead mt-1">Your profile, plan and sign-in settings.</p>
    </div>

    <section class="acc-card" aria-label="Profile">
      <div class="flex items-center gap-[14px]">
        <span class="acc-avatar" :class="{ 'acc-avatar--pro': plan && plan !== 'free' }" aria-hidden="true">{{ initial }}</span>
        <div class="min-w-0 flex flex-col gap-[3px]">
          <div v-if="displayName" class="text-[15px] font-bold text-[#eaf6f8] truncate">{{ displayName }}</div>
          <div class="truncate" :class="displayName ? 'text-[13px] text-[rgba(255,255,255,.6)]' : 'text-[15px] font-bold text-[#eaf6f8]'">{{ email }}</div>
          <div class="flex items-center gap-2 flex-wrap mt-[2px]">
            <span v-if="memberSince" class="acc-fine">Member since {{ memberSince }}</span>
            <span v-for="m in methods" :key="m.provider" class="acc-chip">{{ m.label }}</span>
          </div>
        </div>
      </div>
    </section>

    <AccountPlanCard compact @details="emit('go', 'billing')" />

    <section class="acc-card" aria-labelledby="acc-ov-security">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <h2 id="acc-ov-security" class="acc-card-title">Security</h2>
          <p class="acc-body mt-1">Change your password, see how you log in, or sign out of every device.</p>
        </div>
        <button class="acc-btn acc-btn--ghost" @click="emit('go', 'security')">Open</button>
      </div>
    </section>
  </div>
</template>
