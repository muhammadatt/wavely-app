<script setup>
import { computed, ref, watch } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { useOperationDispatch } from '../../composables/useOperationDispatch.js'
import { useWindows, CHAIN_WINDOW_ID } from '../../composables/useWindows.js'
import { getCategory, getOperation, groupedOperations, operationsIn } from '../../ui/registry.js'
import { splitForMobile, targetLine } from '../../ui/mobileEffects.js'
import { useSheetDrag } from '../../composables/useMobileSheets.js'
import Icon from '../ui/Icon.vue'
import PlanBadge from '../ui/PlanBadge.vue'
import OfflineBadge from '../ui/OfflineBadge.vue'

/**
 * The phone's effect list: a category tab's operations as a bottom sheet over
 * the waveform, above the transport (the mobile design, screen 3).
 *
 * The header names the category and what an effect would act on — the
 * selection's length, or "Nothing selected" with Select all beside it, since a
 * plugin's Apply runs on the selection. The rows lead with the v1 effects
 * (ui/mobileEffects.js); the rest of the category sits behind a "More effects"
 * fold and opens as its desktop window, scaled to fit. Rows carry the RENDER
 * tag for an offline process and the plan tag, as the palette's do.
 *
 * Every row goes through useOperationDispatch, as the desktop rail does: a
 * window opens as FloatingWindow's full-screen sheet (and this sheet closes,
 * so closing the window lands back on the waveform), a rail view (Trim, Fade,
 * Volume…) opens inside this sheet with a back button, a verb just runs.
 *
 * Drag the handle down, tap ✕ or tap the tab again to close.
 */
const { state, hasFile, hasSelection, selectAll, closeRail, setRailOperation } = useEditorState()
const { dispatch, isDisabled } = useOperationDispatch()
const { openWindow } = useWindows()

const category = computed(() => getCategory(state.activeTool))
const operation = computed(() => (state.railOperation ? getOperation(state.railOperation) : null))
const sections = computed(() =>
  category.value ? splitForMobile(groupedOperations(category.value.id)) : { primary: [], more: [] })
const offersChain = computed(() => !!category.value && operationsIn(category.value.id).some(op => op.chain))
const target = computed(() => targetLine(state.selection, hasFile.value))

const moreOpen = ref(false)
watch(() => state.activeTool, () => { moreOpen.value = false })

function select(op) {
  if (isDisabled(op)) return
  if (!dispatch(op)) return
  // A window takes the screen; with the list closed under it, closing the
  // window returns to the waveform rather than to a list already used.
  if (op.surface === 'window') closeRail()
}

function openChain() {
  closeRail()
  openWindow(CHAIN_WINDOW_ID)
}

const { dragY, handle } = useSheetDrag(closeRail)
</script>

<template>
  <section
    v-if="category"
    class="m-fx"
    :class="{ 'is-dragging': dragY > 0 }"
    :style="dragY ? { transform: `translateY(${dragY}px)` } : null"
    data-testid="mobile-effect-sheet"
    :aria-label="`${category.label} effects`"
  >
    <div
      class="m-fx-handle"
      aria-hidden="true"
      v-on="handle"
    ><span /></div>

    <header class="m-fx-head">
      <button
        v-if="operation"
        type="button"
        class="m-fx-back"
        :aria-label="`Back to ${category.label}`"
        data-testid="mobile-effect-back"
        @click="setRailOperation(null)"
      >
        <Icon name="chevronLeft" :size="16" :stroke-width="2.5" />
      </button>
      <div class="m-fx-titles">
        <h2 class="m-fx-title">{{ operation ? operation.label : category.label }}</h2>
        <div class="m-fx-target" data-testid="mobile-effect-target">
          <span :class="{ 'is-none': hasFile && !hasSelection }">{{ target }}</span>
          <button
            v-if="hasFile && !hasSelection"
            type="button"
            class="m-fx-selall"
            data-testid="mobile-effect-select-all"
            @click="selectAll"
          >Select all</button>
        </div>
      </div>
      <button type="button" class="m-fx-close" aria-label="Close" data-testid="mobile-effect-close" @click="closeRail">
        <Icon name="close" :size="12" :stroke-width="2.5" />
      </button>
    </header>

    <div class="m-fx-body">
      <!-- A rail view (Trim, Split, Silence, Fade, Volume): its own panel. -->
      <component :is="operation.component" v-if="operation" />

      <template v-else>
        <div v-for="g in sections.primary" :key="g.group" class="m-fx-group">
          <div v-if="g.group" class="m-fx-group-name">{{ g.group }}</div>
          <button
            v-for="op in g.operations"
            :key="op.id"
            type="button"
            class="m-fx-row"
            :disabled="isDisabled(op)"
            :data-testid="`mobile-effect-${op.id}`"
            @click="select(op)"
          >
            <span class="m-fx-icon"><Icon :name="op.icon" :size="17" /></span>
            <span class="m-fx-text">
              <span class="m-fx-name">
                <span class="truncate">{{ op.label }}</span>
                <OfflineBadge :show="!!op.offline" />
                <PlanBadge :feature="op.feature" />
              </span>
              <span class="m-fx-desc">{{ op.desc }}</span>
            </span>
            <Icon v-if="op.surface !== 'immediate'" name="chevronRight" :size="16" :stroke-width="2.5" class="m-fx-chev" />
          </button>
        </div>

        <div v-if="sections.more.length" class="m-fx-more">
          <button
            type="button"
            class="m-fx-more-toggle"
            :aria-expanded="moreOpen"
            data-testid="mobile-effect-more"
            @click="moreOpen = !moreOpen"
          >
            <span>More effects <span class="m-fx-count">{{ sections.more.length }}</span></span>
            <Icon :name="moreOpen ? 'chevronUp' : 'chevronDown'" :size="15" :stroke-width="2.5" />
          </button>
          <template v-if="moreOpen">
            <p class="m-fx-more-note">Desktop panels, scaled to fit the screen.</p>
            <button
              v-for="op in sections.more"
              :key="op.id"
              type="button"
              class="m-fx-row is-more"
              :disabled="isDisabled(op)"
              :data-testid="`mobile-effect-${op.id}`"
              @click="select(op)"
            >
              <span class="m-fx-icon"><Icon :name="op.icon" :size="15" /></span>
              <span class="m-fx-text">
                <span class="m-fx-name">
                  <span class="truncate">{{ op.label }}</span>
                  <OfflineBadge :show="!!op.offline" />
                  <PlanBadge :feature="op.feature" />
                </span>
              </span>
              <Icon name="chevronRight" :size="15" :stroke-width="2.5" class="m-fx-chev" />
            </button>
          </template>
        </div>

        <button v-if="offersChain" type="button" class="m-fx-chain" data-testid="mobile-effect-chain" @click="openChain">
          <Icon name="chain" :size="16" />
          <span class="m-fx-text">
            <span class="m-fx-name">Use several at once?</span>
            <span class="m-fx-desc">Stack plugins in the Effect Chain</span>
          </span>
          <Icon name="chevronRight" :size="16" :stroke-width="2.5" class="m-fx-chev" />
        </button>
      </template>
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
  padding: 0 12px 10px 16px;
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
  padding: 8px 12px calc(12px + env(safe-area-inset-bottom, 0px));
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.m-fx-group { display: flex; flex-direction: column; gap: 6px; }
.m-fx-group-name {
  padding: 6px 4px 0;
  font: 800 9.5px 'Inter', sans-serif;
  letter-spacing: .11em;
  text-transform: uppercase;
  color: rgba(255,255,255,.38);
}
.m-fx-row, .m-fx-chain {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 9px 12px;
  border: 1px solid rgba(255,255,255,.06);
  border-radius: 12px;
  background: rgba(255,255,255,.03);
  color: inherit;
  text-align: left;
  -webkit-user-select: none;
  user-select: none;
}
.m-fx-row:active { background: rgba(255,255,255,.08); }
.m-fx-row:disabled { opacity: .38; }
.m-fx-row.is-more { min-height: 46px; padding: 6px 12px; }
.m-fx-icon {
  width: 36px; height: 36px; flex: none;
  display: grid; place-items: center;
  border-radius: 10px;
  background: rgba(53,211,230,.08);
  color: #35d3e6;
}
.is-more .m-fx-icon { width: 30px; height: 30px; background: rgba(255,255,255,.05); color: rgba(255,255,255,.6); }
.m-fx-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.m-fx-name { display: flex; align-items: center; gap: 6px; min-width: 0; font: 700 14px 'Inter', sans-serif; color: #eef2f6; }
.m-fx-desc { font: 500 12px 'Inter', sans-serif; color: rgba(255,255,255,.5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.m-fx-chev { flex: none; color: rgba(255,255,255,.3); }
.m-fx-more { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.m-fx-more-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 6px;
  border: none;
  background: none;
  color: rgba(255,255,255,.6);
  font: 700 12.5px 'Inter', sans-serif;
}
.m-fx-count {
  margin-left: 4px;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(255,255,255,.08);
  font: 700 10.5px 'JetBrains Mono', monospace;
}
.m-fx-more-note { margin: -4px 6px 2px; font: 500 11px 'Inter', sans-serif; color: rgba(255,255,255,.38); }
.m-fx-chain {
  margin-top: 6px;
  border-style: dashed;
  border-color: rgba(31,184,166,.45);
  background: rgba(31,184,166,.07);
  color: #2fd3bf;
}
.m-fx-chain .m-fx-name { color: #bff3ec; }

/* On its side: a shorter sheet, slimmer rows, no descriptions. */
@media (max-height: 500px) {
  .m-fx { max-height: 88%; }
  .m-fx-row { min-height: 44px; padding: 5px 10px; }
  .m-fx-desc { display: none; }
}
</style>
