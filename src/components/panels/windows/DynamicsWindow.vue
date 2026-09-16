<script setup>
import { computed, onMounted } from 'vue'
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
import { CLIP_MAX_DEPTH_DB, CLIP_SHAVE_DETENTS } from '../../../audio/dynamicsSolve.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  panel, solving, preview, metering, inputLevels, outputLevels,
  isStale, hasSolution, solutionValid, summary,
  hasSelection, solve, syncMacro, syncBlend,
  togglePreview, apply, teardown, closeModal,
} = useDynamics()

/**
 * ⚠ DERIVED FROM THE DETENT LIST, NOT TYPED OUT. The top position must stay at
 * `CLIP_MAX_DEPTH_DB`; a hand-written list would let the dial drift past the cap
 * and offer a setting the solve silently clamps.
 */
const CLIP_DETENT_OPTIONS = CLIP_SHAVE_DETENTS.map(db => ({
  value: db,
  label: db === 0 ? 'OFF' : `${db} dB`,
  title: db === 0
    ? 'No clipping — the FET and the opto do all of it'
    : `Shave up to ${db} dB of crest before the compressors`,
}))

const { state } = useEditorState()

/**
 * ⚠ THE SECTION ENGAGES WHEN THE PANEL OPENS, RATHER THAN OPENING BYPASSED.
 *
 * Engaging cannot be a default on `preview` — the flag has to travel with the
 * side effects `togglePreview` performs (put the effect in the chain, enable
 * it, start the meters), or the panel would read ENGAGED over a chain that has
 * nothing in it. It also cannot happen before a user gesture, because
 * `getAudioContext` constructs the AudioContext; mounting this window is the
 * result of a click, so this is inside one.
 *
 * ⚠ AND IT IS SAFE ONLY BECAUSE AN UN-SOLVED SECTION IS A BIT-EXACT
 * PASS-THROUGH, WHICH IT WAS NOT UNTIL THIS CHANGE. `toLiveKernelParams` clears
 * every measured key, and only the clipper read that as "bypass" — the FET fell
 * back to `fetDrive: 50` and the opto to `squash: 33`, both unaligned, so
 * opening the panel would have started compressing with a patch nobody
 * measured. All three stages now bypass on an absent measured key; pinned in
 * dynamicsComposite.test.js. So what the user hears on open is the file, and
 * the first thing they hear change is their own solve.
 */
onMounted(() => {
  if (!preview.value) togglePreview()
})

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


/**
 * ⚠ 600 WAS SIZED FOR FOUR CONTROLS AND BALANCE MADE FIVE.
 *
 * The knob row is flex with fixed child widths and no wrap, so the overflow did
 * not push anything off the faceplate — every child simply shrank, because flex
 * children shrink by default. 122 + 96 + 108 + 96 + 96 plus four 22px gaps is
 * 606px against the 548 a 600px window leaves after its 26px padding, so all
 * five knobs were squeezed about 12px each.
 *
 * ⚠ `npm run smoke` CANNOT SEE THIS. It checks that every panel opens without
 * throwing, and this one did. Layout that is merely wrong is invisible to it.
 */
const WINDOW_WIDTH = 680

/**
 * ⚠ WITHOUT A VALID MEASUREMENT THE KERNEL IS A BIT-EXACT PASS-THROUGH, AND
 * EVERY CONTROL THAT FEEDS IT IS INERT. That is correct DSP behaviour — all
 * three stages bypass on an absent measured key rather than falling back to an
 * unmeasured patch — but the panel was still presenting live knobs over it. The
 * knobs moved, the numbers changed, the meters stayed at zero and nothing was
 * audible. A control that cannot do anything must not look like it can.
 *
 * ⚠ OUTPUT IS THE EXCEPTION AND IT IS NOT AN OVERSIGHT: the bypass path still
 * applies `outputLin`, so the trim is the one thing that works with no solve in
 * force. Disabling it would be the same lie in the other direction.
 */
const controlsLive = computed(() => solutionValid.value)

const ACCENT = '#f59e6b'

const formatInt = (v) => String(Math.round(v))
const formatMix = (v) => `${Math.round(v * 100)}%`
/**
 * ⚠ NAMED ENDS, NOT A SIGNED NUMBER. "−60" says nothing about which compressor
 * is being leaned on, and the whole point of the control is which.
 */
const formatBalance = (v) => {
  const n = Math.round(v)
  if (n === 0) return 'EVEN'
  return n < 0 ? `FET ${-n}` : `OPTO ${n}`
}
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
  if (solving.value) return 'Measuring — sampling this material once, so the knobs stay live after'
  if (!hasSolution.value) return 'Measure this material to set the three devices'
  if (isStale.value) return 'The file or the selection moved — measure again'
  const s = summary.value
  /**
   * ⚠ CLIP AND FET ONLY. The opto's reduction and the evenness pair used to sit
   * here as PREDICTIONS off the opto grid; the meter row beside this shows the
   * opto live, and predicting it before playback is what the grid's extra
   * columns cost. These two are free — they come off curves the solve needs for
   * its parameters either way.
   */
  return `clip ${s.clipDepthDb.toFixed(1)} · FET ${s.fetPeakDb.toFixed(1)} dB`
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
 * ⚠ THE FET RAN OUT OF ROAD, AND STAYING QUIET ABOUT IT IS WHAT LET 26 dB OF
 * GAIN REDUCTION SHIP. Impact has only ~3 dB of travel through this device, so
 * a target below the floor is indistinguishable from one that was met unless
 * the solve says so. The clipper has said so since it was written.
 *
 * ⚠ IT NO LONGER STOPS AT FULL DRIVE, AND THIS TEXT SAID IT DID. The solve gives
 * up at `FET_MAX_SOLVE_DRIVE`, the measured plateau — past it the knob buys
 * almost no further impact and costs enormous gain reduction, so running to 100
 * is not "trying harder", it is 20 dB of reduction for a fraction of a dB. The
 * message also still named the Voicing, which has not existed since Density
 * became one number.
 */
const fetShortNote = computed(() => {
  const s = summary.value
  if (!solutionValid.value || !s?.fetCapped) return null
  return `The FET is as deep as it is worth driving and still `
    + `${s.fetShortfallDb.toFixed(1)} dB short of the dynamic range Density is `
    + `asking for — there is not enough peak-to-body left in the material to take. `
    + `Lower Density, or lean Balance toward the opto`
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
  if (!hasSolution.value) return 'Measure first'
  if (isStale.value) return 'The file or selection moved — measure again'
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
    :width="WINDOW_WIDTH"
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
      <!-- ⚠ DIMMED WITH THE CONTROLS, because the meters are the evidence the
           section is doing nothing: with no solve every stage bypasses, so the
           gain-reduction bars sit at zero and read as "no compression needed"
           rather than "nothing is measured yet". -->
      <div
        class="flex items-start justify-between gap-[14px]"
        :style="{ opacity: controlsLive ? 1 : 0.45, transition: 'opacity .15s' }"
      >
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
          <!-- One macro. It turns into a clip threshold, a drive and a squash
               by reading the sampled curves — each device on the statistic it
               actually controls, which is not the same statistic for all three.
               ⚠ LIVE: this used to throw the measurement away on every move and
               make the user re-run a 7.3-7.9 s bisect. -->
          <Knob
            :model-value="panel.density"
            @update:model-value="v => syncMacro('density', v)"
            :disabled="!controlsLive"
            :min="0" :max="100" :step="1"
            label="Density" :accent="ACCENT" :format-value="formatInt"
            :value-font-px="22"
          />
        </div>

        <div class="w-[96px] flex flex-col items-center">
          <!-- ⚠ WHICH compressor does the work, not how much. Density sets the
               amount; this shifts the voicing's impact target and squash in
               OPPOSITE senses, so the two compressors trade. Live for the same
               reason Density is: both are lookups on the sampled curves.
               ⚠ It only bites below roughly Density 60 on typical narration —
               above that the FET's drive pins at 100 and its target stops
               reaching, so the lean shows up on the opto half alone. -->
          <Knob
            :model-value="panel.balance"
            @update:model-value="v => syncMacro('balance', v)"
            :disabled="!controlsLive"
            :min="-100" :max="100" :step="1"
            label="Balance" :accent="ACCENT" :format-value="formatBalance"
            :value-font-px="15"
          />
        </div>

        <div class="w-[108px] flex flex-col items-center pt-[8px]">
          <!-- ⚠ THE CLIPPER'S SHARE, WHICH USED TO BE BURIED IN THE VOICING.
               How much crest it may shave is a character decision — tighter and
               more forward, or rounder — and independent of how far the section
               goes, which is Density's job. The top detent sits AT the 3 dB hard
               cap deliberately, so the dial never offers a position the solve
               quietly clamps. -->
          <DeviceDetentRotary
            :model-value="panel.clipShaveDb"
            :options="CLIP_DETENT_OPTIONS"
            :accent="ACCENT"
            label="Clip"
            :disabled="!controlsLive"
            @update:model-value="v => syncMacro('clipShaveDb', v)"
          />
        </div>

        <div class="w-[96px] flex flex-col items-center">
          <!-- Mix does NOT invalidate the solve. The blend is measured at Mix 1,
               the worst case, precisely so this knob stays valid wherever it
               lands — the same reasoning Scheps uses for sizing its ceiling
               knee. At 0 you get clip and FET with no opto, which is a real
               setting rather than a bypass.
               ⚠ THE AUTO BADGE WENT WITH THE VOICINGS. It meant "take the
               voicing's own blend"; with one target set there is nothing to
               defer to, and a nullable value is not what a preset should
               carry. -->
          <Knob
            :model-value="panel.mix"
            @update:model-value="v => syncBlend('mix', v)"
            :disabled="!controlsLive"
            :min="0" :max="1" :step="0.01"
            label="Mix" :accent="ACCENT" :format-value="formatMix"
            :value-font-px="15"
          />
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
        >{{ solving ? 'MEASURING…' : (hasSolution ? 'RE-MEASURE' : 'MEASURE') }}</button>

        <p class="text-[10.5px] leading-[1.45] text-[rgba(255,255,255,.45)]">{{ statusText }}</p>
      </div>

      <p
        v-if="cappedNote"
        class="mt-[10px] text-[10px] leading-[1.45]"
        :style="{ color: `color-mix(in srgb, ${ACCENT} 55%, #ffffff)` }"
      >{{ cappedNote }}</p>

      <p
        v-if="fetShortNote"
        class="mt-[8px] text-[10px] leading-[1.5] text-[rgba(255,255,255,.4)]"
      >{{ fetShortNote }}</p>

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
