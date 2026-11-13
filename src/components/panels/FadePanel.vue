<script setup>
import { ref, computed } from "vue"
import { useEditorState, DocumentSwitchedError } from "../../composables/useEditorState.js"
import ApplyAction from '../ui/ApplyAction.vue'
import { renderFadeRegion, computePeakCache } from '../../audio/processing.js'
import { fadeCurvePath } from '../../audio/dsp/fade.js'
import { getTimelineDuration } from '../../audio/operations.js'

const {
  state, hasSelection, getAudioContext, replaceRegion, setPeakCache,
  startProcessing, endProcessing, showToast, pinActiveDocument,
} = useEditorState()

const fadeType = ref("in")
const curveType = ref("linear")

// The type icons draw the selected curve too, so both rows show the real fade.
const fadeTypes = computed(() => [
  { id: "in", label: "Fade In" },
  { id: "out", label: "Fade Out" },
].map((t) => ({ ...t, path: fadeCurvePath(curveType.value, t.id) })))

// Each curve icon is the real gain curve, drawn in the chosen direction.
const curveTypes = computed(() => [
  { id: "linear", label: "Linear" },
  { id: "expo", label: "Expo" },
  { id: "s-curve", label: "S-Curve" },
].map((c) => ({ ...c, path: fadeCurvePath(c.id, fadeType.value) })))

// The selection is the fade: its length is the fade's length.
const fadeSeconds = computed(() => (state.selection ? state.selection.end - state.selection.start : 0))

function durationDisplay() {
  return hasSelection.value ? fadeSeconds.value.toFixed(2) + " s" : "—"
}

const hint = computed(() => (fadeType.value === "in"
  ? "Fades up from silence across the selection."
  : "Fades down to silence across the selection."))

// A fade in that starts mid-file (or a fade out that ends mid-file) meets audio
// at full level: the step from full level to silence there is audible.
const edgeWarning = computed(() => {
  const sel = state.selection
  if (!sel) return ""
  const EPS = 1e-6
  if (fadeType.value === "in" && sel.start > EPS) {
    return "The audio before the selection stays at full level, so it will jump to silence where the fade starts."
  }
  if (fadeType.value === "out" && sel.end < getTimelineDuration(state.segments) - EPS) {
    return "The audio after the selection stays at full level, so it will jump back up where the fade ends."
  }
  return ""
})

const LABELS = { in: "fade in", out: "fade out" }

async function apply() {
  // One fade at a time: a second click while this one renders would render
  // from the uncommitted timeline and commit a second undo step.
  if (!hasSelection.value || state.isProcessing) return
  const { start, end } = state.selection
  const type = fadeType.value
  const curve = curveType.value
  const label = LABELS[type]
  const pin = pinActiveDocument(`The ${label}`)
  startProcessing(`Applying ${label}...`, pin.docId)
  try {
    const buffer = await renderFadeRegion(
      state.segments, start, end, { type, curve },
      getAudioContext(), state.currentFile.sampleRate, state.currentFile.channels,
    )
    const cache = await computePeakCache(buffer, 256)
    pin.check()
    const bufferId = replaceRegion(start, end, buffer, `the ${label}`, pin.docId)
    setPeakCache(bufferId, cache)
    const curveLabel = curveTypes.value.find((c) => c.id === curve)?.label ?? curve
    showToast(`${label[0].toUpperCase()}${label.slice(1)} applied (${(end - start).toFixed(2)} s, ${curveLabel})`)
  } catch (err) {
    console.error("Fade failed:", err)
    showToast(err instanceof DocumentSwitchedError ? err.message : `Fade failed: ${err.message}`)
  } finally {
    endProcessing(pin.docId)
  }
}
</script>

<template>
  <div class="font-['Inter']">
    <!-- Header lives in ContextPanel, which renders it from the registry entry -->
    <div class="p-4 flex flex-col gap-[14px]">
      <!-- Fade type -->
      <div>
        <div class="text-[11px] font-semibold text-[rgba(255,255,255,.4)] mb-2">Type</div>
        <div class="flex gap-[6px]">
          <button
            v-for="ft in fadeTypes"
            :key="ft.id"
            class="flex-1 flex flex-col items-center gap-[5px] py-[10px] px-1 rounded-[12px] border text-[10px] font-semibold cursor-pointer transition-all"
            :style="fadeType === ft.id
              ? 'border-color:rgba(53,211,230,.5);background:rgba(53,211,230,.12);color:#7fe9f6'
              : 'border-color:rgba(255,255,255,.07);background:rgba(255,255,255,.03);color:rgba(255,255,255,.5)'"
            @click="fadeType = ft.id">
            <svg viewBox="0 0 48 24" fill="none" class="w-9 h-[18px]">
              <path
                :d="ft.path"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round" />
            </svg>
            {{ ft.label }}
          </button>
        </div>
      </div>

      <!-- Curve shape -->
      <div>
        <div class="text-[11px] font-semibold text-[rgba(255,255,255,.4)] mb-2">Curve</div>
        <div class="flex gap-[6px]">
          <button
            v-for="ct in curveTypes"
            :key="ct.id"
            class="flex-1 flex flex-col items-center gap-[5px] py-[10px] px-1 rounded-[12px] border text-[10px] font-semibold cursor-pointer transition-all"
            :style="curveType === ct.id
              ? 'border-color:rgba(53,211,230,.5);background:rgba(53,211,230,.12);color:#7fe9f6'
              : 'border-color:rgba(255,255,255,.07);background:rgba(255,255,255,.03);color:rgba(255,255,255,.5)'"
            @click="curveType = ct.id">
            <svg viewBox="0 0 48 24" fill="none" class="w-9 h-[18px]">
              <path
                :d="ct.path"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round" />
            </svg>
            {{ ct.label }}
          </button>
        </div>
      </div>

      <!-- Duration: the selection's length, not a setting -->
      <div class="rounded-[12px] p-[14px]" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)">
        <div class="flex justify-between items-center">
          <span class="font-['JetBrains_Mono'] text-[8.5px] font-bold tracking-[.14em] text-[rgba(255,255,255,.4)] uppercase">Duration</span>
          <span class="font-['JetBrains_Mono'] text-[15px] font-bold text-[#7fe9f6] tabular-nums">{{ durationDisplay() }}</span>
        </div>
        <div class="mt-1 text-[10px] font-semibold text-[rgba(255,255,255,.35)]">Set by the selection</div>
      </div>

      <div class="text-[11px] leading-[1.45] text-[rgba(255,255,255,.45)]">{{ hint }}</div>
      <div
        v-if="edgeWarning"
        class="text-[11px] leading-[1.45] font-semibold text-[#f5c26b]">{{ edgeWarning }}</div>

      <ApplyAction
        class="mt-1"
        :met="hasSelection"
        message="Make a selection to apply fade"
        label="Apply Fade"
        :disabled="!!state.isProcessing"
        @apply="apply"
      />

    </div>
  </div>
</template>
