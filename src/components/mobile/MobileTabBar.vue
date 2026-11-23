<script setup>
import { computed } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { useWindows } from '../../composables/useWindows.js'
import { usePluginChain } from '../../composables/usePluginChain.js'
import { useMobileSheets } from '../../composables/useMobileSheets.js'
import Icon from '../ui/Icon.vue'

/**
 * The mobile shell's bottom bar: Effects, which opens the one Effects menu
 * (MobileEffectsMenu — every released effect, grouped and searchable), and
 * the Plugin Chain in its teal. It replaced a tab per toolbar category, each
 * opening its own list (owner, November 2026): one menu is as few taps, can
 * be searched, and is the same picker the chain's + Add plugin uses.
 */
const { state, closeRail, hasFile } = useEditorState()
const { openWindow, isOpen } = useWindows()
const { slots, liveSlots, bypassed, suspended } = usePluginChain()
const { effectsMenuOpen, openEffectsMenu, closeFileSheet } = useMobileSheets()

const chainActive = computed(() => liveSlots.value.length > 0 && !bypassed.value && !suspended.value)
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
      <span class="m-chain-ic">
        <Icon name="chain" :size="15" />
        <i v-if="slots.length" :class="{ 'is-live': chainActive }" aria-hidden="true" />
      </span>
      <span>Chain</span>
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
  background: #0b0e11;
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
  background: rgba(255,255,255,.05);
  color: rgba(255,255,255,.8);
  font: 700 14px 'Inter', sans-serif;
}
.m-tab.is-on { color: #7fe9f6; background: rgba(53,211,230,.12); }
.m-tab:disabled { opacity: .35; }
.m-chain { color: #eaf6f8; }
.m-chain-ic {
  position: relative;
  display: grid;
  place-items: center;
  width: 30px;
  height: 22px;
  border-radius: 7px;
  background: #1fa9a0;
  color: #fff;
}
.m-chain.is-on .m-chain-ic { box-shadow: 0 0 0 2px rgba(127,233,246,.6); }
.m-chain-ic i {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255,255,255,.45);
  box-shadow: 0 0 0 2px #0b0e11;
}
.m-chain-ic i.is-live { background: #5df0b0; }

/* On its side: a slimmer bar. */
@media (max-height: 500px) {
  .m-tabs { padding-top: 5px; padding-bottom: calc(5px + env(safe-area-inset-bottom, 0px)); }
  .m-tab { height: 36px; font-size: 13px; }
}
</style>
