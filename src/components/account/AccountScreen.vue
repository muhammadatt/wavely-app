<script setup>
import { computed, ref, watch, nextTick, onMounted } from 'vue'
import { useAuth } from '../../composables/useAuth.js'
import { useAccountScreen } from '../../composables/useAccountScreen.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { useModalFocus } from '../../composables/useModalFocus.js'
import { stopPlayback } from '../../audio/playback.js'
import { ACCOUNT_SECTIONS } from '../../auth/accountRoute.js'
import AccountOverview from './AccountOverview.vue'
import AccountBilling from './AccountBilling.vue'
import AccountSecurity from './AccountSecurity.vue'
import './account.css'

/**
 * The full-screen account dashboard: Overview, Plan & billing, Security.
 *
 * A LAYER OVER THE EDITOR, never a page instead of it — documents live only
 * in this tab's memory, so leaving the page would lose them. App.vue keeps
 * EditorScreen mounted underneath (and `inert` while this is open), and
 * closing returns to exactly what was there. Its address is a hash
 * (`#/account/<section>`, src/auth/accountRoute.js), so Back closes it and a
 * link opens a section.
 *
 * Above the floating windows (z 500 + one per window), below the account /
 * upgrade dialogs (690) so Upgrade to Pro opens over it.
 */
const auth = useAuth()
const screen = useAccountScreen()
const { state: editor } = useEditorState()

const section = computed(() => screen.state.section)
const current = computed(() => ({ overview: AccountOverview, billing: AccountBilling, security: AccountSecurity })[section.value] ?? AccountOverview)

function go(id) {
  screen.open(id)
}

onMounted(() => {
  // The dashboard covers the transport; leaving audio playing under it
  // would play on with no visible way to stop it.
  if (editor.isPlaying) {
    stopPlayback()
    editor.isPlaying = false
  }
  // A plan change made in the portal, another tab or on Stripe's side.
  auth.loadAccount()
})

const root = ref(null)
const main = ref(null)
const { trapTab } = useModalFocus(root)

// A new section: back to the top, and focus to its heading for screen readers.
watch(section, async () => {
  await nextTick()
  main.value?.scrollTo?.({ top: 0 })
  main.value?.querySelector('h1')?.focus?.()
})

function onKeydown(e) {
  trapTab(e)
  // The editor's shortcuts listen on window; none of them belong here.
  e.stopPropagation()
  if (e.key === 'Escape') screen.close()
}
</script>

<template>
  <div
    ref="root"
    class="acc-screen font-['Inter']"
    role="dialog"
    aria-modal="true"
    aria-label="Account"
    tabindex="-1"
    @keydown="onKeydown"
  >
    <header class="acc-top">
      <img src="/crisp-fm-logo.png" alt="crisp.fm" class="h-[22px] w-auto select-none" draggable="false" />
      <span class="acc-top-rule" aria-hidden="true"></span>
      <span class="text-[13px] font-bold text-[rgba(255,255,255,.7)]">Account</span>
      <button class="acc-back ml-auto" data-autofocus @click="screen.close()">
        <svg viewBox="0 0 24 24" class="w-[14px] h-[14px] fill-none stroke-current" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
        Back to editor
      </button>
    </header>

    <div class="acc-layout">
      <nav class="acc-nav" aria-label="Account sections">
        <button
          v-for="s in ACCOUNT_SECTIONS"
          :key="s.id"
          class="acc-nav-item"
          :class="{ 'is-on': section === s.id }"
          :aria-current="section === s.id ? 'page' : undefined"
          @click="go(s.id)"
        >
          <svg v-if="s.id === 'overview'" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>
          <svg v-else-if="s.id === 'billing'" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h4"/></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>
          {{ s.label }}
        </button>
      </nav>

      <main ref="main" class="acc-main">
        <div class="acc-content">
          <component :is="current" @go="go" />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.acc-screen {
  position: fixed;
  inset: 0;
  z-index: 600;
  display: flex;
  flex-direction: column;
  background: linear-gradient(160deg, #181c22, #0c0f13 62%);
  outline: none;
  animation: acc-in 0.18s ease-out both;
}
@keyframes acc-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.acc-top {
  flex: none;
  height: 60px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 20px;
  background: var(--color-chrome, #0d1015);
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}
.acc-top-rule {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.12);
}
.acc-back {
  height: 34px;
  padding: 0 14px 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 10px;
  font-size: 12.5px;
  font-weight: 600;
  color: #eaf6f8;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.acc-back:hover {
  background: rgba(255, 255, 255, 0.07);
}
.acc-layout {
  flex: 1;
  min-height: 0;
  display: flex;
}
.acc-nav {
  flex: none;
  width: 232px;
  padding: 24px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}
.acc-nav-item {
  height: 38px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 10px;
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.62);
}
.acc-nav-item svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex: none;
}
.acc-nav-item:hover {
  color: #eaf6f8;
  background: rgba(255, 255, 255, 0.05);
}
.acc-nav-item.is-on {
  color: #eaf6f8;
  background: rgba(53, 211, 230, 0.1);
  box-shadow: inset 0 0 0 1px rgba(53, 211, 230, 0.25);
}
.acc-nav-item.is-on svg {
  color: var(--color-accent-bright);
}
.acc-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.acc-content {
  max-width: 720px;
  padding: 32px 32px 48px;
}
.acc-content :deep(h1) {
  outline: none;
}

/* Narrow or short: the nav becomes a strip of tabs over the content. */
@media (max-width: 760px), (max-height: 520px) {
  .acc-top {
    height: 52px;
    padding: 0 16px;
  }
  .acc-layout {
    flex-direction: column;
  }
  .acc-nav {
    width: auto;
    flex-direction: row;
    padding: 8px 16px;
    gap: 6px;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .acc-nav-item {
    height: 34px;
    flex: none;
    white-space: nowrap;
  }
  .acc-content {
    padding: 20px 16px 40px;
  }
}
</style>
