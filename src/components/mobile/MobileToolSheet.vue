<script setup>
import { computed } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { getOperation } from '../../ui/registry.js'
import { targetLine } from '../../ui/mobileEffects.js'
import { useMobileSheets, useSheetDrag } from '../../composables/useMobileSheets.js'
import Icon from '../ui/Icon.vue'

/**
 * The phone's tool sheet: a rail view — Trim, Split, Silence, Fade, Volume,
 * opened from the Effects menu — as a bottom sheet over the waveform, above
 * the transport. Plugins open as windows instead; this hosts only the panels
 * the desktop shows in its rail.
 *
 * The header names the tool and what it would act on — the selection's
 * length, or "Nothing selected" with Select all beside it. ‹ goes back to the
 * Effects menu; ✕, dragging the handle down or Escape closes it.
 */
const { state, hasFile, hasSelection, selectAll, closeRail } = useEditorState()
const { openEffectsMenu } = useMobileSheets()

const operation = computed(() => (state.railOperation ? getOperation(state.railOperation) : null))
const target = computed(() => targetLine(state.selection, hasFile.value))

function back() {
  openEffectsMenu() // closes this sheet too
}

const { dragY, handle } = useSheetDrag(closeRail)
</script>

<template>
  <section
    v-if="operation"
    class="m-fx"
    :class="{ 'is-dragging': dragY > 0 }"
    :style="dragY ? { transform: `translateY(${dragY}px)` } : null"
    data-testid="mobile-tool-sheet"
    :aria-label="operation.label"
  >
    <div class="m-fx-handle" aria-hidden="true" v-on="handle"><span /></div>

    <header class="m-fx-head">
      <button
        type="button"
        class="m-fx-back"
        aria-label="Back to effects"
        data-testid="mobile-tool-back"
        @click="back"
      >
        <Icon name="chevronLeft" :size="16" :stroke-width="2.5" />
      </button>
      <div class="m-fx-titles">
        <h2 class="m-fx-title">{{ operation.label }}</h2>
        <div class="m-fx-target" data-testid="mobile-tool-target">
          <span :class="{ 'is-none': hasFile && !hasSelection }">{{ target }}</span>
          <button
            v-if="hasFile && !hasSelection"
            type="button"
            class="m-fx-selall"
            data-testid="mobile-tool-select-all"
            @click="selectAll"
          >Select all</button>
        </div>
      </div>
      <button type="button" class="m-fx-close" aria-label="Close" data-testid="mobile-tool-close" @click="closeRail">
        <Icon name="close" :size="12" :stroke-width="2.5" />
      </button>
    </header>

    <div class="m-fx-body">
      <component :is="operation.component" />
    </div>
  </section>
</template>

<style scoped>
.m-fx {
  position: absolute;
  inset: auto 0 0 0;
  z-index: 60;
  max-height: 72%;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, #141922, #0e1116);
  border-top: 1px solid rgba(255,255,255,.08);
  border-radius: 16px 16px 0 0;
  box-shadow: 0 -12px 32px rgba(0,0,0,.55);
  transition: transform .18s ease;
}
.m-fx.is-dragging { transition: none; }
.m-fx-handle {
  flex: none;
  display: grid;
  place-items: center;
  height: 18px;
  touch-action: none;
  cursor: grab;
}
.m-fx-handle span { width: 36px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.22); }
.m-fx-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 10px 12px;
  border-bottom: 1px solid rgba(255,255,255,.06);
}
.m-fx-titles { flex: 1; min-width: 0; }
.m-fx-title { margin: 0; font: 800 16px 'Inter', sans-serif; color: #eef2f6; }
.m-fx-target {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font: 600 11.5px 'JetBrains Mono', ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
  color: #e8a33d;
}
.m-fx-target .is-none { color: rgba(255,255,255,.45); font-family: 'Inter', sans-serif; }
.m-fx-selall, .m-fx-back, .m-fx-close {
  border: none;
  background: rgba(255,255,255,.06);
  color: rgba(255,255,255,.75);
  border-radius: 8px;
}
.m-fx-selall { padding: 3px 9px; font: 600 11.5px 'Inter', sans-serif; }
.m-fx-back, .m-fx-close { width: 30px; height: 30px; flex: none; display: grid; place-items: center; }
.m-fx-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

@media (max-height: 500px) {
  .m-fx { max-height: 88%; }
}
</style>
