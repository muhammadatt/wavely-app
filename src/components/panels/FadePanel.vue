<script setup>
import { ref, computed } from "vue"
import { useEditorState, DocumentSwitchedError } from "../../composables/useEditorState.js"
import ApplyAction from '../ui/ApplyAction.vue'
import { renderFadeRegion, computePeakCache } from '../../audio/processing.js'
import { effectiveFadeSeconds, FADE_SLIDER_SECONDS_PER_STEP } from '../../audio/dsp/fade.js'

const {
  state, hasSelection, getAudioContext, replaceRegion, setPeakCache,
  startProcessing, endProcessing, showToast, pinActiveDocument, setPlayhead,
} = useEditorState()

const fadeType = ref("in")
const curveType = ref("linear")
const duration = ref(20) // 1-100 slider, 0.05 s a step (0.05-5 s)

const fadeTypes = [
  { id: "in", label: "Fade In", path: "M2 22 Q24 22 46 2" },
  { id: "out", label: "Fade Out", path: "M2 2 Q24 22 46 22" },
  { id: "cross", label: "Crossfade", path: "M2 22 Q24 12 46 2" },
]

const curveTypes = [
  { id: "linear", label: "Linear", path: "M2 22 C12 22 36 2 46 2" },
  { id: "expo", label: "Expo", path: "M2 22 C2 22 10 2 46 2" },
  { id: "s-curve", label: "S-Curve", path: "M2 22 C16 22 32 2 46 2" },
]

const requestedSeconds = computed(() => duration.value * FADE_SLIDER_SECONDS_PER_STEP)

// What the selection lets the fade use: a fade cannot run past the selection,
// a crossfade takes at most half of it (dsp/fade.js).
const effectiveSeconds = computed(() => {
  const sel = state.selection
  if (!sel) return requestedSeconds.value
  return effectiveFadeSeconds(fadeType.value, requestedSeconds.value, sel.end - sel.start)
})
const limited = computed(() => hasSelection.value && effectiveSeconds.value < requestedSeconds.value - 1e-9)

const hint = computed(() => {
  if (fadeType.value === "cross") {
    return "Removes the selection and blends the audio either side of it over the duration."
  }
  return fadeType.value === "in"
    ? "Fades up from silence at the start of the selection."
    : "Fades down to silence at the end of the selection."
})

function durationDisplay() {
  return requestedSeconds.value.toFixed(2) + " s"
}

const LABELS = { in: "fade in", out: "fade out", cross: "crossfade" }

async function apply() {
  if (!hasSelection.value) return
  const { start, end } = state.selection
  const type = fadeType.value
  const curve = curveType.value
  const label = LABELS[type]
  const pin = pinActiveDocument(`The ${label}`)
  startProcessing(`Applying ${label}...`, pin.docId)
  try {
    const ctx = getAudioContext()
    const result = renderFadeRegion(
      state.segments, start, end,
      { type, curve, seconds: requestedSeconds.value },
      ctx, state.currentFile.sampleRate, state.currentFile.channels,
    )
    const cache = await computePeakCache(result.buffer, 256)
    pin.check()
    const bufferId = replaceRegion(result.start, result.end, result.buffer, `the ${label}`, pin.docId, result.duration)
    setPeakCache(bufferId, cache)
    if (type === "cross") {
      // The selection's audio is gone; select the blended join instead, so it
      // can be auditioned straight away.
      state.selection = { start, end: start + result.duration }
      // The timeline got shorter: keep the playhead on it.
      setPlayhead(state.playhead)
    }
    const curveLabel = curveTypes.find((c) => c.id === curve)?.label ?? curve
    showToast(`${label[0].toUpperCase()}${label.slice(1)} applied (${result.seconds.toFixed(2)} s, ${curveLabel})`)
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
                stroke-linecap="round" />
            </svg>
            {{ ct.label }}
          </button>
        </div>
      </div>

      <!-- Duration -->
      <div class="rounded-[12px] p-[14px]" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)">
        <div class="flex justify-between items-center mb-2">
          <span class="font-['JetBrains_Mono'] text-[8.5px] font-bold tracking-[.14em] text-[rgba(255,255,255,.4)] uppercase">Duration</span>
          <span class="font-['JetBrains_Mono'] text-[15px] font-bold text-[#7fe9f6] tabular-nums">{{ durationDisplay() }}</span>
        </div>
        <input
          type="range"
          min="1"
          max="100"
          v-model.number="duration"
          class="w-full h-1.5 rounded-full appearance-none cursor-pointer"
          style="background:rgba(255,255,255,.1);accent-color:#35d3e6" />
        <div
          v-if="limited"
          class="mt-2 text-[10px] font-semibold text-[#f5c26b]">
          Limited to {{ effectiveSeconds.toFixed(2) }} s by the selection{{ fadeType === 'cross' ? ' (a crossfade uses at most half of it)' : '' }}
        </div>
      </div>

      <div class="text-[11px] leading-[1.45] text-[rgba(255,255,255,.45)]">{{ hint }}</div>

      <ApplyAction
        class="mt-1"
        :met="hasSelection"
        message="Make a selection to apply fade"
        label="Apply Fade"
        @apply="apply"
      />

    </div>
  </div>
</template>
