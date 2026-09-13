<script setup>
import { computed } from 'vue'
import { useDynamics } from '../../../composables/useDynamics.js'
import { useEditorState } from '../../../composables/useEditorState.js'
import FloatingWindow from '../FloatingWindow.vue'
import Knob from '../../knobs/Knob.vue'
import DeviceDetentRotary from '../../knobs/DeviceDetentRotary.vue'
import LevelMeter from '../../meters/LevelMeter.vue'
import GainReductionBar from '../../meters/GainReductionBar.vue'
// ⚠ Imported, not taken off the composable: it is a module constant, not
// reactive state, and destructuring it from the return would have quietly been
// `undefined` in the caption that quotes it.
import { CLIP_MAX_DEPTH_DB } from '../../../audio/dynamicsSolve.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  panel, solving, preview, metering, inputLevels, outputLevels,
  isStale, hasSolution, solutionValid, summary, effectiveMix, mixIsAuto,
  hasSelection, solve, syncMacro, syncBlend, resetMixAuto,
  togglePreview, apply, teardown, closeModal,
} = useDynamics()

const { state } = useEditorState()

/**
 * The transport, the way every other faceplate reaches it: a window event, not
 * a composable call. `useEditorState` deliberately does not expose playback —
 * the harness owns it — and destructuring a `togglePlayback` from it silently
 * produced `undefined`, which the preview button would have called on click.
 * `test/ui/composableDestructure.test.js` is what caught that.
 */
function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}


const ACCENT = '#f59e6b'

const formatInt = (v) => String(Math.round(v))
const formatMix = (v) => `${Math.round(v * 100)}%`
const formatDb = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`

/**
 * ⚠ THREE METERS, NEVER A SUM. The macro sets a target and the solve
 * distributes it across three devices that do three different things — the
 * clipper shaves crest, the FET takes peak-to-body, the opto evens level out
 * over seconds. A single bar would hide which of them is working, and in
 * particular would hide the clipper sitting on its cap, which is the one
 * failure the design says must never be silent.
 */
const stages = computed(() => [
  { key: 'clip', label: 'CLIP', db: metering.value?.clip.now ?? 0, full: 6 },
  { key: 'fet', label: 'FET', db: metering.value?.fet.now ?? 0, full: 18 },
  { key: 'opto', label: 'OPTO', db: metering.value?.opto.now ?? 0, full: 18 },
])

const statusText = computed(() => {
  if (solving.value) return 'Measuring and solving — this renders the section several times'
  if (!hasSolution.value) return 'Solve to measure this material and set the three devices'
  if (isStale.value) return 'The file or the selection moved — solve again'
  const s = summary.value
  return `clip ${s.clipDepthDb.toFixed(1)} · FET ${s.fetPeakDb.toFixed(1)} · opto `
    + `${s.optoPeakDb.toFixed(1)} dB · evenness ${s.spreadFrom.toFixed(1)} → ${s.spreadTo.toFixed(1)} dB`
})

/**
 * The clipper's cap is the one hard rule in the section: never ask it for more
 * than it can give without audible distortion. When Density wants more, Density
 * is what backs off, and saying so is the whole point.
 */
const cappedNote = computed(() => {
  if (!solutionValid.value || !summary.value?.clipCapped) return null
  return `Density is asking for more than the clipper can give. It is held at `
    + `${CLIP_MAX_DEPTH_DB} dB and the rest of the macro is doing the work — `
    + `past that, speech starts to distort audibly`
})

/**
 * The opto's trade, stated rather than buried. It rides the body and lets
 * onsets through, so past a point it hands the delivery stage more peak than it
 * received. Half a dB is noise; two is worth knowing about.
 */
const tradeNote = computed(() => {
  const rose = summary.value?.crestRoseBy
  if (!solutionValid.value || !(rose > 0.75)) return null
  return `Peak-to-body rose ${rose.toFixed(1)} dB — the opto evens level out by `
    + `riding the body and letting onsets through, so the loudness stage after `
    + `this has more peak to hold down`
})

const applyHint = computed(() => {
  if (!preview.value) return 'Turn the section on to apply it'
  if (!hasSolution.value) return 'Solve first'
  if (isStale.value) return 'The file or selection moved — solve again'
  if (!hasSelection.value) return 'Select the part of the file to write back'
  return ''
})

async function applyAndClose() {
  await apply()
  close()
}

function close() {
  teardown()
  closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="vocal-chain-dynamics"
    :z="z"
    :width="600"
    :accent="ACCENT"
    brand-lead="VOCAL"
    brand-tail="DYNAMICS"
    :engaged="preview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!preview || !solutionValid || !hasSelection"
    :apply-disabled-hint="applyHint"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="px-[26px] pt-[22px] pb-[24px]">
      <div class="flex items-start justify-between gap-[14px]">
        <LevelMeter :levels="inputLevels" label="IN" :height="118" />

        <!-- Three devices, three bars. See `stages` for why never a sum. -->
        <div class="flex-1 flex flex-col gap-[7px] pt-[4px]">
          <div v-for="s in stages" :key="s.key" class="flex items-center gap-[9px]">
            <span
              class="w-[34px] shrink-0 text-right"
              style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.14em;color:rgba(255,255,255,.42)"
            >{{ s.label }}</span>
            <div class="flex-1">
              <GainReductionBar
                :reduction-db="-s.db" :accent="ACCENT"
                :full-scale-db="s.full" title=""
              />
            </div>
          </div>
        </div>

        <LevelMeter :levels="outputLevels" label="OUT" :height="118" />
      </div>

      <div
        class="mt-[18px] pt-[16px] flex items-start justify-center gap-[22px]"
        style="border-top:1px solid rgba(255,255,255,.06)"
      >
        <div class="w-[122px]">
          <!-- One macro. The solve turns it into a clip threshold, a drive and
               a squash by measuring the material — each device on the statistic
               it actually controls, which is not the same statistic for all
               three. -->
          <Knob
            :model-value="panel.density"
            @update:model-value="v => syncMacro('density', v)"
            :min="0" :max="100" :step="1"
            label="Density" :accent="ACCENT" :format-value="formatInt"
            :value-font-px="22"
          />
        </div>

        <div class="w-[108px] flex flex-col items-center pt-[8px]">
          <DeviceDetentRotary
            :model-value="panel.voicing"
            :options="[
              { value: 'natural', label: 'NATURAL', title: 'Light touch, most of the performance left alone' },
              { value: 'audiobook', label: 'AUDIOBOOK', title: 'Even and controlled, conservative clipping' },
              { value: 'podcast', label: 'PODCAST', title: 'Denser and more forward' },
            ]"
            :accent="ACCENT"
            label="Voicing"
            @update:model-value="v => syncMacro('voicing', v)"
          />
        </div>

        <div class="w-[96px] flex flex-col items-center">
          <div class="relative w-full" :style="{ opacity: mixIsAuto ? 0.78 : 1 }">
            <!-- Mix does NOT invalidate the solve. The blend is measured at
                 Mix 1, the worst case, precisely so this knob stays valid
                 wherever it lands — the same reasoning Scheps uses for sizing
                 its ceiling knee. At 0 you get clip and FET with no opto, which
                 is a real voicing rather than a bypass. -->
            <Knob
              :model-value="effectiveMix"
              @update:model-value="v => syncBlend('mix', v)"
              :min="0" :max="1" :step="0.01"
              label="Mix" :accent="ACCENT" :format-value="formatMix"
              :value-font-px="15"
            />
            <span
              v-if="mixIsAuto"
              class="absolute top-[2px] right-[2px] px-1 py-[1px] rounded-full pointer-events-none"
              :style="{
                background: `color-mix(in srgb, ${ACCENT} 20%, transparent)`,
                border: `1px solid color-mix(in srgb, ${ACCENT} 40%, transparent)`,
                font: `700 6px/1 'JetBrains Mono',monospace`,
                letterSpacing: '.08em',
                color: `color-mix(in srgb, ${ACCENT} 65%, #ffffff)`,
              }"
            >AUTO</span>
          </div>
          <button
            v-if="!mixIsAuto"
            class="mt-[5px] px-2 py-[2px] rounded-full cursor-pointer transition-all"
            style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);color:rgba(255,255,255,.4);font:700 7.5px 'JetBrains Mono',monospace;letter-spacing:.1em"
            title="Hand Mix back to the voicing's own blend."
            @click="resetMixAuto"
          >AUTO</button>
        </div>

        <div class="w-[96px]">
          <Knob
            :model-value="panel.outputDb"
            @update:model-value="v => syncBlend('outputDb', v)"
            :min="-12" :max="12" :step="0.1"
            label="Output" :accent="ACCENT" :format-value="formatDb"
            :value-font-px="15" bipolar
          />
        </div>
      </div>

      <div class="mt-[18px] flex items-center gap-[12px]">
        <button
          class="px-3 py-[6px] rounded-full cursor-pointer transition-all disabled:cursor-default shrink-0"
          :style="{
            background: `color-mix(in srgb, ${ACCENT} 16%, transparent)`,
            border: `1px solid color-mix(in srgb, ${ACCENT} 42%, transparent)`,
            color: `color-mix(in srgb, ${ACCENT} 70%, #ffffff)`,
            font: `700 9px 'JetBrains Mono',monospace`,
            letterSpacing: '.12em',
            opacity: solving ? 0.5 : 1,
          }"
          :disabled="solving"
          title="Measure this material and set the three devices from it"
          @click="solve"
        >{{ solving ? 'SOLVING…' : (hasSolution ? 'RE-SOLVE' : 'SOLVE') }}</button>

        <p class="text-[10.5px] leading-[1.45] text-[rgba(255,255,255,.45)]">{{ statusText }}</p>
      </div>

      <p
        v-if="cappedNote"
        class="mt-[10px] text-[10px] leading-[1.45]"
        :style="{ color: `color-mix(in srgb, ${ACCENT} 55%, #ffffff)` }"
      >{{ cappedNote }}</p>

      <p
        v-if="tradeNote"
        class="mt-[8px] text-[10px] leading-[1.45] text-[rgba(255,255,255,.36)]"
      >{{ tradeNote }}</p>

      <p class="mt-[14px] text-[10px] leading-[1.5] text-[rgba(255,255,255,.32)]">
        Clipping into the detectors, then a fast compressor, then an opto blended
        back against it. Density is measured into all three rather than mapped —
        each device is set from the thing it actually controls, so the same
        position does the same job on a different recording.
      </p>
    </div>
  </FloatingWindow>
</template>
