<script setup>
import { computed } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { useWindows } from '../../composables/useWindows.js'
import { usePluginChain } from '../../composables/usePluginChain.js'
import { useMobileSheets } from '../../composables/useMobileSheets.js'
import { useEntitlements } from '../../composables/useEntitlements.js'
import Icon from '../ui/Icon.vue'

/**
 * The mobile shell's bottom bar: Effects, which opens the one Effects menu
 * (MobileEffectsMenu — every released effect, grouped and searchable), and
 * the Plugin Chain in its teal. It replaced a tab per toolbar category, each
 * opening its own list (owner, November 2026): one menu is as few taps, can
 * be searched, and is the same picker the chain's + Add plugin uses.
 *
 * Both are the same neutral button with a BARE icon (owner, November 2026);
 * Chain's icon keeps the chain's teal. Chain carries the desktop Chain
 * button's PRO tag while the plan lacks the chain's Apply, and ACTIVE /
 * BYPASSED once it holds plugins, as on desktop.
 */
const { state, closeRail, hasFile } = useEditorState()
const { openWindow, isOpen } = useWindows()
const { slots, liveSlots, bypassed, suspended } = usePluginChain()
const { effectsMenuOpen, openEffectsMenu, closeFileSheet } = useMobileSheets()

const chainActive = computed(() => liveSlots.value.length > 0 && !bypassed.value && !suspended.value)
// The chain's Apply is Pro (plans.js `pluginChainApply`); building the rack is
// open to everyone, so the tag says what the plan lacks, not a lock.
const entitlements = useEntitlements()
const chainLocked = computed(() => !entitlements.can('pluginChainApply'))
// Lit while the menu, or a tool opened from it, is up.
const effectsOn = computed(() => effectsMenuOpen.value || !!state.railOperation)

function openChain() {
  closeRail()
  closeFileSheet()
  openWindow('plugin-chain')
}
</script>

<template>
  <nav class="m-tabs" aria-label="Tools">
    <button
      type="button"
      class="m-tab m-effects"
      :class="{ 'is-on': effectsOn }"
      :disabled="!hasFile"
      :aria-expanded="String(effectsMenuOpen)"
      data-testid="mobile-effects"
      @click="openEffectsMenu"
    >
      <Icon name="effects" :size="18" />
      <span>Effects</span>
    </button>
    <button
      type="button"
      class="m-tab m-chain"
      :class="{ 'is-on': isOpen('plugin-chain') }"
      :disabled="!hasFile"
      data-testid="mobile-tab-chain"
      @click="openChain"
    >
      <Icon name="chain" :size="18" class="m-chain-ic" />
      <span>Chain</span>
      <span v-if="slots.length" class="m-chain-count" :class="{ 'is-live': chainActive }">{{ chainActive ? 'ACTIVE' : 'BYPASSED' }}</span>
      <span v-else-if="chainLocked" class="m-chain-pro" data-testid="mobile-chain-pro">PRO</span>
    </button>
  </nav>
</template>

<style scoped>
.m-tabs {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid rgba(255,255,255,.06);
  background: var(--mob-bar-bg);
}
.m-tab {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 46px;
  border: none;
  border-radius: 12px;
  background: var(--mob-btn-bg);
  color: rgba(255,255,255,.8);
  font: 700 14px 'Inter', sans-serif;
}
.m-tab.is-on { color: #7fe9f6; background: var(--mob-accent-wash); }
.m-tab:disabled { opacity: .35; }
.m-chain-ic { color: #2fd3bf; }
.m-chain.is-on .m-chain-ic { color: #7fe9f6; }
/* The desktop Chain button's tags (FloatingToolbar.vue): dark with teal ink. */
.m-chain-pro,
.m-chain-count {
  font: 700 9.5px 'JetBrains Mono', monospace;
  letter-spacing: .06em;
  padding: 2px 5px;
  border-radius: 5px;
  background: #08161a;
  color: #86e8ff;
}
.m-chain-count.is-live { color: #5df0b0; }

/* On its side: a slimmer bar. */
@media (max-height: 500px) {
  .m-tabs { padding-top: 5px; padding-bottom: calc(5px + env(safe-area-inset-bottom, 0px)); }
  .m-tab { height: 36px; font-size: 13px; }
}
</style>
