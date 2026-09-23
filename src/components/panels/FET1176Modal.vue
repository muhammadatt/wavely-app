<script setup>
import { computed, onMounted, watch } from 'vue'
import { useFET1176 } from '../../composables/useFET1176.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  attackSecondsForDial, releaseSecondsForDial, FET1176_OUTPUT_MIN_DB, FET1176_OUTPUT_MAX_DB,
} from '../../audio/fet1176Processor.js'
import { FET1176_DEFAULTS } from '../../audio/effects/fet1176Params.js'
import HardwareKnob from '../hardware/HardwareKnob.vue'
import LampButton from '../hardware/LampButton.vue'
import PreGainToggle from '../hardware/PreGainToggle.vue'
import HardwareFader from '../hardware/HardwareFader.vue'
import HardwareSlideSwitch from '../hardware/HardwareSlideSwitch.vue'
import ClassicVuMeter from '../hardware/ClassicVuMeter.vue'
import { engraving, evenAngles, formatSignedDb, DIAL_MIN_DEG, DIAL_MAX_DEG } from '../hardware/hardwareDial.js'
import FloatingWindow from './FloatingWindow.vue'
import FET1176TuningPanel from './FET1176TuningPanel.vue'
import { isFET1176TuningVisible } from '../../audio/effects/fet1176Tuning.js'
import { INPUT_TRIM_MAX_DB } from '../../audio/dsp/inputAlign.js'
import PresetMenu from './PresetMenu.vue'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import { FET_PUNCH_PRESET_PLUGIN } from '../../audio/pluginPresets/index.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  fetInput, fetOutput, fetAttack, fetRelease, fetRatio, fetDrive, fetScHpf, fetMix,
  fetAutoMakeup, fetPreview, fetReduction,
  fetInputAlignDb, fetInputAuto, syncInputAlign, enableInputAuto,
  togglePreview, syncInput, syncOutput, syncAttack, syncRelease, syncRatio,
  syncDrive, syncScHpf, syncMix, toggleAutoMakeup, refreshAutoMakeup, resetLiveMakeup,
  apply, teardown, closeModal, refreshKernelTuning,
} = useFET1176()

/** Bench only: gated off in production builds. See fet1176Tuning.js. */
const showTuningBench = isFET1176TuningVisible()

/**
 * Presets. Same two functions and the same ordering constraint as OptoSmooth:
 * Output goes last and through the AUTO decision, because `syncOutput` is a
 * take-over that drops AUTO and accepts the value.
 */
const presets = usePluginPresets(FET_PUNCH_PRESET_PLUGIN, {
  read: () => ({
    inputDrive: fetInput.value,
    output: fetOutput.value,
    attack: fetAttack.value,
    release: fetRelease.value,
    ratio: fetRatio.value,
    fetDrive: fetDrive.value,
    scHpf: fetScHpf.value,
    mix: fetMix.value,
    autoMakeup: fetAutoMakeup.value,
  }),
  /**
   * ⚠ `fetDrive` HAS NO CONTROL ON THE FACE BUT PRESETS STILL CARRY IT. Each
   * factory preset was voiced with its own amount (0.2-0.6) against a default
   * of 1, so dropping it on load would re-voice every one of them. It rides
   * along invisibly: a preset sets it, a saved preset keeps what is in effect.
   */
  write: (p) => {
    syncInput(p.inputDrive)
    syncAttack(p.attack)
    syncRelease(p.release)
    syncRatio(p.ratio)
    syncDrive(p.fetDrive)
    syncScHpf(p.scHpf)
    syncMix(p.mix)
    if (p.autoMakeup) {
      if (!fetAutoMakeup.value) toggleAutoMakeup()
    } else {
      if (fetAutoMakeup.value) toggleAutoMakeup()
      syncOutput(p.output)
    }
  },
})

const { state } = useEditorState()

// Default to engaged when the panel opens
onMounted(() => {
  if (!fetPreview.value) togglePreview()
})

// The makeup is measured from the selected region, so a new selection needs
// a fresh measurement.
// A new selection is new material: the live tracker's extrema describe the old
// region, so they are cleared before the offline measurement re-runs.
watch(() => state.selection, () => { resetLiveMakeup(); refreshAutoMakeup() }, { deep: true })

// The window chrome keeps the app's steel blue for FET Punch; the faceplate
// itself is the Classic 76 hardware face and carries its own colours.
const ACCENT = '#79b8ff'

/** Brushed charcoal, with the plate's top and bottom edges catching light. */
const FACEPLATE = [
  'repeating-linear-gradient(0deg,rgba(255,255,255,.022) 0px,rgba(255,255,255,0) 1px,rgba(0,0,0,.05) 2px,rgba(255,255,255,0) 3px)',
  'linear-gradient(180deg,#3c3c3a 0%,#2e2e2c 5%,#262625 24%,#212120 50%,#232322 74%,#2b2b29 92%,#373735 100%)',
].join(',')

const off = computed(() => !fetPreview.value)

// ── Engraving ───────────────────────────────────────────────────────────────
// Input is printed in its own 0-100 knob units, the number presets save.
// Output is printed in dB: it is plain gain, ±the Input's full drive.
const INPUT_SCALE = engraving(['0', '', '25', '', '50', '', '75', '', '100'])
const OUTPUT_SCALE = engraving(['−24', '−18', '−12', '−6', '0', '+6', '+12', '+18', '+24'])
// Dial 1 is the SLOWEST position and 7 the fastest, as on the hardware.
const BALLISTICS_DOTS = evenAngles(7)
const BALLISTICS_LABELS = [
  { angle: DIAL_MIN_DEG, text: 'SLOW' },
  { angle: DIAL_MAX_DEG, text: 'FAST' },
]
// Top to bottom, as the buttons are stacked on the unit.
const RATIOS = [
  { value: '20', label: '20', title: '20:1 — effectively limiting' },
  { value: '12', label: '12', title: '12:1 — peak taming' },
  { value: '8', label: '8', title: '8:1 — firm control' },
  { value: '4', label: '4', title: '4:1 — gentle enough to leave on a whole take' },
  { value: 'all', label: 'ALL', title: 'All buttons in — crushed, lagging, loud' },
]

/**
 * Sidechain high-pass, a three-position slide switch. Not on the original:
 * the 1176's detector is broadband, which lets plosives duck a whole phrase.
 * OFF is the stock path.
 */
const SC_HPF_OPTIONS = [
  { value: 0, label: 'Off', title: 'Stock broadband detector' },
  { value: 90, label: '90', title: '90 Hz: stops plosives and rumble from ducking the take' },
  { value: 150, label: '150', title: '150 Hz: keeps chest weight out of the detector entirely' },
]

// ── Readouts ────────────────────────────────────────────────────────────────
function formatMs(seconds) {
  const ms = seconds * 1000
  if (ms < 1) return `${Math.round(ms * 1000)} µs`
  if (ms < 100) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
const formatInteger = (v) => String(Math.round(v))
const formatPercent = (v) => `${Math.round(v * 100)}%`
const formatDial = (v) => `Dial ${Math.round(v)}`

const inputReadout = computed(() => formatInteger(fetInput.value))
const outputReadout = computed(() => formatSignedDb(fetOutput.value))
const attackReadout = computed(() => formatMs(attackSecondsForDial(fetAttack.value)))
const releaseReadout = computed(() => formatMs(releaseSecondsForDial(fetRelease.value)))
const mixReadout = computed(() => formatPercent(fetMix.value))

/**
 * Input ALIGNMENT, not a second Input. It offsets the DETECTOR only, never the
 * audio path — unlike Input, which gains both as the hardware attenuator does.
 * It exists because there is no threshold control, so without it the file's
 * own level decides what Input does: measured at Input 55, ratio 4, a file
 * peaking at -6 dBFS gets 13.30 dB of reduction and one at -30 dBFS gets 0.00.
 *
 * Off the faceplate: AUTO measures the whole file's gated RMS and is right for
 * nearly every file, so the face shows only a readout and the override sits
 * behind it (PreGainToggle). Stepping it takes over from AUTO, exactly as Output
 * behaves under Auto Makeup; turning AUTO off keeps the measured value as the
 * starting point rather than jumping.
 */
function setAlignAuto(on) {
  if (on) enableInputAuto()
  else syncInputAlign(fetInputAlignDb.value)
}

// Preview is just transport playback: the worklet is already in the chain, so
// what makes this effect "live" is that the audio is running while you turn the
// knobs. Reuses the existing toggle-play bus rather than a second play path.
function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

// The shell removes itself from the window manager; this only has to stop the
// preview chain and the meter loop.
function close() {
  teardown()
}

async function applyAndClose() {
  await apply()
  // apply() already disables the preview, but the meter loop is still running.
  teardown()
  closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="fet-punch"
    :z="z"
    :width="820"
    :top="110"
    :accent="ACCENT"
    :background="FACEPLATE"
    brand-lead="FET"
    brand-tail="PUNCH"
    :engaged="fetPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!fetPreview"
    apply-disabled-hint="Turn FET Punch on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <template #header-center>
      <PresetMenu
        :presets="presets"
        :accent="ACCENT"
        :disabled="!fetPreview"
        disabled-hint="Turn FET Punch on to use presets"
      />
    </template>

    <div class="c76" :class="{ 'is-off': off }">
      <div class="c76-sheen" />
      <div v-for="pos in ['tl', 'tr', 'bl', 'br']" :key="pos" class="c76-screw" :class="`c76-screw--${pos}`">
        <div class="c76-screw-slot" />
      </div>

      <!-- ── Top row: Input · ratio + meter · Output ───────────────────────── -->
      <div class="c76-top">
        <div class="c76-col">
          <div class="c76-title">Input</div>
          <!-- Input is the only threshold control there is: it drives the
               audio path and the detector together, exactly as the hardware
               attenuator does. -->
          <HardwareKnob
            class="c76-ctl"
            :model-value="fetInput"
            @update:model-value="syncInput"
            :min="0" :max="100" :step="1"
            :default-value="FET1176_DEFAULTS.inputDrive"
            :dots="INPUT_SCALE.dots" :labels="INPUT_SCALE.labels"
            label="Input" :format-value="formatInteger"
            :disabled="off"
          />
          <div class="c76-readout">{{ inputReadout }}</div>
        </div>

        <div class="c76-center">
          <div class="c76-ratio">
            <div class="c76-small-title c76-ratio-title">Ratio</div>
            <div class="c76-ratio-stack" role="radiogroup" aria-label="Ratio">
              <div v-for="r in RATIOS" :key="r.value" class="c76-ratio-row">
                <div class="c76-ratio-legend">{{ r.label }}</div>
                <button
                  type="button"
                  class="c76-ratio-btn c76-ctl"
                  :class="{ 'is-in': fetRatio === r.value }"
                  role="radio"
                  :aria-checked="fetRatio === r.value"
                  :aria-label="r.title"
                  :title="r.title"
                  :disabled="off"
                  @click="syncRatio(r.value)"
                />
              </div>
            </div>
          </div>
          <div class="c76-meter-col">
            <ClassicVuMeter :reduction-db="fetReduction" :active="fetPreview" />
            <div class="c76-nameplate">
              <div class="c76-nameplate-row">
                <!-- The unit's power switch is FET Punch's on/off, the same
                     state as the lamp in the window header. -->
                <LampButton
                  :on="fetPreview"
                  :size="20"
                  class="c76-power"
                  :title="fetPreview ? 'Turn FET Punch off' : 'Turn FET Punch on'"
                  @click="togglePreview"
                />
                <div class="c76-model">Classic 76</div>
              </div>
              <div class="c76-kind">Limiting Amplifier</div>
            </div>
          </div>
        </div>

        <div class="c76-col">
          <div class="c76-title">Output</div>
          <!-- Stays draggable while Auto Makeup is lit: touching it takes
               over and drops AUTO, so a gain the user sets actually sticks. -->
          <HardwareKnob
            class="c76-ctl"
            :model-value="fetOutput"
            @update:model-value="syncOutput"
            :min="FET1176_OUTPUT_MIN_DB" :max="FET1176_OUTPUT_MAX_DB" :step="0.1"
            :default-value="0"
            :dots="OUTPUT_SCALE.dots" :labels="OUTPUT_SCALE.labels" :label-radius="80" :label-size="13"
            label="Output" :format-value="formatSignedDb"
            :disabled="off"
          />
          <div class="c76-readout">{{ outputReadout }}</div>
        </div>
      </div>

      <!-- ── Bottom row: SC HPF · Attack/Release · Makeup/Mix ─────────────── -->
      <div class="c76-bottom">
        <div class="c76-left">
          <!-- Pre-Gain (input alignment) is folded to one line by default and
               opens in place. See PreGainToggle. -->
          <PreGainToggle
            class="c76-ctl"
            :model-value="fetInputAlignDb"
            @update:model-value="syncInputAlign"
            :auto="fetInputAuto"
            @update:auto="setAlignAuto"
            :min="-INPUT_TRIM_MAX_DB" :max="INPUT_TRIM_MAX_DB" :step="0.5"
            :disabled="off"
          />
          <div class="c76-schpf">
            <HardwareSlideSwitch
              class="c76-ctl"
              :model-value="fetScHpf"
              @update:model-value="syncScHpf"
              :options="SC_HPF_OPTIONS"
              :disabled="off"
              label="Sidechain high-pass"
            />
            <div class="c76-tiny-title">SC HPF</div>
          </div>
        </div>

        <div class="c76-ballistics">
          <div class="c76-small-knob">
            <HardwareKnob
              class="c76-ctl"
              variant="small"
              :model-value="fetAttack"
              @update:model-value="syncAttack"
              :min="1" :max="7" :step="1"
              :default-value="FET1176_DEFAULTS.attack"
              :dots="BALLISTICS_DOTS" :labels="BALLISTICS_LABELS"
              label="Attack" :format-value="formatDial"
              :disabled="off"
            />
            <div class="c76-sub-readout">{{ attackReadout }}</div>
            <div class="c76-small-title">Attack</div>
          </div>
          <div class="c76-small-knob">
            <HardwareKnob
              class="c76-ctl"
              variant="small"
              :model-value="fetRelease"
              @update:model-value="syncRelease"
              :min="1" :max="7" :step="1"
              :default-value="FET1176_DEFAULTS.release"
              :dots="BALLISTICS_DOTS" :labels="BALLISTICS_LABELS"
              label="Release" :format-value="formatDial"
              :disabled="off"
            />
            <div class="c76-sub-readout">{{ releaseReadout }}</div>
            <div class="c76-small-title">Release</div>
          </div>
        </div>

        <div class="c76-makeup">
          <div class="c76-makeup-lamp">
            <!-- Auto makeup matters more here than on OptoSmooth: Input feeds
                 the audio path too, so driving the unit harder swings the
                 output level by tens of dB. -->
            <LampButton
              class="c76-ctl"
              :on="fetAutoMakeup"
              :size="36"
              halo
              :disabled="off"
              :title="fetAutoMakeup
                ? 'Auto makeup on. Click to take manual control of Output.'
                : 'Auto makeup off. Click to let the plugin match Output to the input level.'"
              @click="toggleAutoMakeup"
            />
            <div class="c76-tiny-title c76-makeup-title">Auto Makeup</div>
          </div>
          <div class="c76-mix">
            <!-- Blends the untouched input back in — parallel compression
                 without a second track. -->
            <HardwareFader
              class="c76-ctl"
              :model-value="fetMix"
              @update:model-value="syncMix"
              :min="0" :max="1" :step="0.01"
              :default-value="1"
              min-label="0" max-label="100"
              label="Mix" :format-value="formatPercent"
              :disabled="off"
            />
            <div class="c76-sub-readout c76-sub-readout--sm">{{ mixReadout }}</div>
            <div class="c76-tiny-title">Mix</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bench only: gated off in production builds. See fet1176Tuning.js. -->
    <div v-if="showTuningBench" class="px-[26px] pb-[20px]">
      <FET1176TuningPanel
        :accent="ACCENT"
        :disabled="!fetPreview"
        @change="refreshKernelTuning"
      />
    </div>
  </FloatingWindow>
</template>

<style scoped>
.c76 {
  position: relative; padding: 24px 30px 24px; overflow: hidden;
  font-family: Oswald, 'Inter', system-ui, sans-serif;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.2), inset 0 -1px 0 rgba(0,0,0,.85);
}
.c76-sheen {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(94deg,rgba(255,255,255,.05) 0%,rgba(255,255,255,0) 20%,rgba(255,255,255,0) 80%,rgba(255,255,255,.04) 100%),
    linear-gradient(180deg,rgba(255,255,255,.08) 0%,rgba(255,255,255,0) 9%),
    radial-gradient(140% 90% at 50% 8%,rgba(255,255,255,.05),rgba(255,255,255,0) 62%);
}
.c76-screw {
  position: absolute; width: 15px; height: 15px; border-radius: 50%;
  background: radial-gradient(circle at 34% 28%,#9b9ea2,#5c6065 48%,#22252a 100%);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.65), 0 1px 2px rgba(0,0,0,.85);
}
.c76-screw--tl { left: 12px; top: 12px; }
.c76-screw--tr { right: 12px; top: 12px; }
.c76-screw--bl { left: 12px; bottom: 12px; }
.c76-screw--br { right: 12px; bottom: 12px; }
.c76-screw-slot { position: absolute; left: 50%; top: 50%; width: 9px; height: 1.6px; margin: -.8px 0 0 -4.5px; background: rgba(0,0,0,.65); }

.c76-title, .c76-small-title, .c76-tiny-title, .c76-model, .c76-kind {
  text-transform: uppercase; color: #f2f0ec; text-shadow: 0 1px 0 rgba(0,0,0,.9); line-height: 1;
}
.c76-title { font-size: 15px; font-weight: 500; letter-spacing: .24em; }
.c76-small-title { font-size: 11px; font-weight: 500; letter-spacing: .2em; }
.c76-tiny-title { font-size: 9px; font-weight: 400; letter-spacing: .18em; white-space: nowrap; }
.c76-readout { margin-top: -12px; font-size: 11px; font-weight: 400; line-height: 1; letter-spacing: .18em; color: #f2f0ec; }
.c76-sub-readout { font-size: 10px; line-height: 1; letter-spacing: .16em; color: #b9b6b0; }
.c76-sub-readout--sm { font-size: 9px; letter-spacing: .14em; }

.c76-top { position: relative; display: flex; align-items: flex-start; justify-content: space-between; }
.c76-col { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.c76-center { flex: 0 0 auto; display: flex; align-items: flex-start; justify-content: center; gap: 10px; }

.c76-ratio { align-self: stretch; display: flex; flex-direction: column; align-items: center; gap: 5px; }
.c76-ratio-title { transform: translateX(16px); }
.c76-ratio-stack { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.c76-ratio-row { flex: 1; display: flex; align-items: center; gap: 6px; }
.c76-ratio-legend { width: 26px; text-align: right; font-size: 12px; line-height: 1; letter-spacing: .06em; color: #e7e5e0; }
.c76-ratio-btn {
  width: 26px; align-self: stretch; padding: 0; border: 0; border-radius: 3px; cursor: pointer; outline: none;
  transition: transform 60ms ease-out, box-shadow 60ms ease-out;
  background: linear-gradient(180deg,#4a4d52 0%,#3a3d42 14%,#2b2e33 60%,#191b1f 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.28), inset 0 -2px 3px rgba(0,0,0,.6), 0 4px 5px rgba(0,0,0,.7), 0 1px 0 rgba(255,255,255,.05);
}
.c76-ratio-btn:not(:disabled):active { transform: translateY(2px); }
.c76-ratio-btn.is-in {
  background: linear-gradient(180deg,#1a1b1d 0%,#24262a 16%,#2c2f34 52%,#14161a 100%);
  box-shadow: inset 0 2px 4px rgba(0,0,0,.85), inset 0 -1px 0 rgba(255,255,255,.08), 0 1px 0 rgba(255,255,255,.07);
}
.c76-ratio-btn:focus-visible { box-shadow: 0 0 0 2px rgba(255,164,53,.55); }
.c76-ratio-btn:disabled { cursor: default; }

.c76-meter-col { flex: 0 1 auto; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.c76-nameplate { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.c76-nameplate-row { display: flex; align-items: center; }
.c76-power { margin-right: 9px; }
.c76-model { font-size: 14px; font-weight: 500; letter-spacing: .3em; }
.c76-kind { font-size: 17px; font-weight: 600; letter-spacing: .14em; color: #ffffff; margin-top: 5px; }

.c76-bottom { position: relative; margin-top: 18px; display: grid; grid-template-columns: 176px 1fr 176px; align-items: stretch; }
/* Both side columns pin their first control to the top of the row and their
   last to the bottom, so they line up with the ballistics knobs between. */
.c76-left { display: flex; flex-direction: column; align-items: center; justify-content: space-between; }
.c76-schpf { display: flex; flex-direction: column; align-items: center; gap: 5px; }

.c76-ballistics { display: flex; align-items: flex-start; justify-content: center; gap: 12px; }
.c76-small-knob { display: flex; flex-direction: column; align-items: center; gap: 5px; }

.c76-makeup { display: flex; flex-direction: column; align-items: center; justify-content: space-between; }
.c76-makeup-lamp { display: flex; flex-direction: column; align-items: center; gap: 5px; }
.c76-makeup-title { font-size: 10px; letter-spacing: .16em; margin-top: 5px; }
.c76-mix { display: flex; flex-direction: column; align-items: center; gap: 5px; }

/* Unit off: the controls go dead and dim; the power lamp and the engraving
   stay, so the face still reads as the same unit. Knobs dim their own cap
   (HardwareKnob), so their printed scale is left alone. */
.c76-ctl { transition: opacity .15s ease; }
.is-off .c76-ctl:not(.hw-knob) { opacity: .45; }
</style>
