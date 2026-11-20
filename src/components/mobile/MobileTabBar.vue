<script setup>
import { computed } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { useWindows } from '../../composables/useWindows.js'
import { usePluginChain } from '../../composables/usePluginChain.js'
import { CATEGORIES } from '../../ui/registry.js'
import Icon from '../ui/Icon.vue'

/**
 * The mobile shell's bottom tabs: the desktop toolbar's categories, then the
 * Plugin Chain in its teal. A category opens its list as a sheet above the
 * transport (tapping it again closes it); Chain opens the chain window.
 */
const { state, setActiveTool, closeRail, hasFile } = useEditorState()
const { openWindow, isOpen } = useWindows()
const { slots, liveSlots, bypassed, suspended } = usePluginChain()

// Mastering presets are deferred (the Master category is dev-only on desktop
// too) and not part of mobile v1, so the tabs never show it, dev builds
// included: seven tabs do not fit a phone's width.
const MOBILE_EXCLUDED = new Set(['master'])
const tabs = CATEGORIES.filter(c => !MOBILE_EXCLUDED.has(c.id))

const chainActive = computed(() => liveSlots.value.length > 0 && !bypassed.value && !suspended.value)

function openChain() {
  closeRail()
  openWindow('plugin-chain')
}
</script>

<template>
  <nav class="m-tabs" aria-label="Tools">
    <button
      v-for="cat in tabs"
      :key="cat.id"
      type="button"
      class="m-tab"
      :class="{ 'is-on': state.activeTool === cat.id }"
      :disabled="!hasFile"
      :aria-pressed="String(state.activeTool === cat.id)"
      :data-testid="`mobile-tab-${cat.id}`"
      @click="setActiveTool(cat.id)"
    >
      <Icon :name="cat.icon" :size="18" />
      <span>{{ cat.label }}</span>
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
  flex-shrink: 0;
  padding: 6px 4px calc(8px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid rgba(255,255,255,.06);
  background: #0b0e11;
}
.m-tab {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px 0;
  border: none;
  background: none;
  color: rgba(255,255,255,.5);
  font: 600 10px 'Inter', sans-serif;
}
.m-tab span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.m-tab.is-on { color: #7fe9f6; }
.m-tab:disabled { opacity: .35; }
.m-chain { color: #eaf6f8; }
.m-chain-ic {
  position: relative;
  display: grid;
  place-items: center;
  width: 30px;
  height: 20px;
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

/* On its side: icons only. */
@media (max-height: 500px) {
  .m-tabs { padding-top: 4px; padding-bottom: calc(4px + env(safe-area-inset-bottom, 0px)); }
  .m-tab { font-size: 0; gap: 0; padding: 4px 0; }
}
</style>
