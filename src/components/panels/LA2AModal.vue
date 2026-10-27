<script setup>
import { computed, onMounted } from 'vue'
import { useLA2A } from '../../composables/useLA2A.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { LOOKAHEAD_MAX_MS, LA2A_DEFAULTS } from '../../audio/effects/la2aCompressor.js'
import { SC_EMPH_MAX_DB, LA2A_GAIN_MIN_DB, LA2A_GAIN_MAX_DB } from '../../audio/la2aProcessor.js'
import { INPUT_TRIM_MAX_DB } from '../../audio/dsp/inputAlign.js'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import { OPTO_SMOOTH_PRESET_PLUGIN } from '../../audio/pluginPresets/index.js'
import PresetMenu from './PresetMenu.vue'
import { useEditorState } from '../../composables/useEditorState.js'
import HardwareKnob from '../hardware/HardwareKnob.vue'
import HardwareSlideSwitch from '../hardware/HardwareSlideSwitch.vue'
import LampButton from '../hardware/LampButton.vue'
import FoldedLcd from '../hardware/FoldedLcd.vue'
import MachinedVuMeter from '../hardware/MachinedVuMeter.vue'
import { engraving, evenAngles, formatSignedDb } from '../hardware/hardwareDial.js'
import FloatingWindow from './FloatingWindow.vue'
import LA2ATuningPanel from './LA2ATuningPanel.vue'
import { isLA2ATuningVisible } from '../../audio/effects/la2aTuning.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  la2aMode, la2aPeakReduction, la2aGain, la2aR37, la2aLookahead,
  la2aAutoMakeup, toggleAutoMakeup: toggleAuto,
  la2aAnalog, syncAnalog, la2aMix, syncMix,
  la2aPreview, la2aReduction,
  togglePreview, syncMode, syncPeakReduction, syncGain,
  syncR37, syncLookahead, toggleAutoMakeup, 
  refreshKernelTuning,
  la2aInputAuto, la2aInputDb, syncInput, resetInputAuto,
  apply, teardown, closeModal,
} = useLA2A()

/**
 * Read once, not reactively: the gate is a build flag plus a localStorage key,
 * neither of which changes while the panel is open.
 */
const showTuningBench = isLA2ATuningVisible()

const { state } = useEditorState()

// Default to engaged when the panel opens
onMounted(() => {
  // The chain's copy keeps its ON/BYPASS: opening its editor from the chain
  // must not un-bypass its slot.
  if (!la2aPreview.value && currentPluginCopy() === 'solo') togglePreview()
})

// The window chrome keeps OptoSmooth's amber; the faceplate is the Vintage 2A
// hardware face and carries its own colours.
const ACCENT = '#f5a623'

/** Brushed silver, lit from above. */
const FACEPLATE = 'linear-gradient(180deg,#e2e3e2,#d8d9d8 55%,#cdcfce)'

const off = computed(() => !la2aPreview.value)

// ── Engraving ───────────────────────────────────────────────────────────────
// Peak Reduction in its own 0-100 units, the number presets save.
const PR_SCALE = engraving(['0', '10', '20', '30', '40', '50', '60', '70', '80', '90', '100'])
/**
 * Gain in dB across its travel, ±24 with 0 straight up — the same scale as FET
 * Punch's Output.
 */
const GAIN_MIN_DB = LA2A_GAIN_MIN_DB
const GAIN_MAX_DB = LA2A_GAIN_MAX_DB
const GAIN_SCALE = (() => {
  const labels = ['−24', '−18', '−12', '−6', '0', '+6', '+12', '+18', '+24']
  // One tick per 3 dB, so every numeral lands on a tick.
  return { dots: evenAngles(17), labels: evenAngles(labels.length).map((angle, i) => ({ angle, text: labels[i] })) }
})()
const PR_TICKS = evenAngles(21)
/** The two small knobs: eleven ticks, words at the stops (and 50 on Mix). */
const SMALL_TICKS = evenAngles(11)
const smallScale = (texts) => evenAngles(texts.length).map((angle, i) => ({ angle, text: texts[i] }))
const EMPH_LABELS = smallScale(['FLAT', '', '', '', 'HF'])
const MIX_LABELS = smallScale(['DRY', '', '50', '', 'WET'])

const MODE_OPTIONS = [
  { value: 'compress', label: 'Comp', title: 'Compress — around 3:1, levelling' },
  { value: 'limit', label: 'Limit', title: 'Limit — a harder ceiling' },
]

/**
 * HF EMPH IS R37, the side-chain trimmer, turned the way the face reads: FLAT
 * fully anticlockwise (R37 100, factory) to full emphasis fully clockwise
 * (R37 0). It filters the SIDE-CHAIN, not the audio — the compressor stops
 * reacting to plosives and rides the presence band instead. Nothing here is
 * audible on its own; it changes what the compressor listens to.
 *
 * The readout is the shelf's real gain above its corner, from the kernel's own
 * constant: `SC_EMPH_MAX_DB * (1 - r37/100)`.
 */
const hfEmph = computed(() => 100 - la2aR37.value)
const setHfEmph = (v) => syncR37(100 - v)
const formatEmph = (v) => {
  const db = SC_EMPH_MAX_DB * v / 100
  return db < 0.05 ? 'Flat' : `+${db.toFixed(1)} dB`
}

// ── Readouts (the face prints none under its knobs: they show on hover,
// focus or drag, as the bubble the design calls for) ──────────────────────────
const prTip = computed(() => String(Math.round(la2aPeakReduction.value)))
const gainTip = computed(() => formatSignedDb(la2aGain.value))
const formatLookahead = (v) => (v <= 0 ? 'Off' : `${Math.round(v)} ms`)
const formatPercent = (v) => `${Math.round(v * 100)}%`

/**
 * Pre-Gain is the input ALIGNMENT, and it trims the SIDE-CHAIN DRIVE, not the
 * audio: it changes what the cell hears and nothing about the output level. It
 * exists because neither this plugin nor the hardware has a threshold control —
 * Peak Reduction is side-chain gain into a fixed internal threshold — so
 * without it the file's own level decides what the knob does: 4.6 dB of
 * reduction at PR 50 on a file peaking at -1 dBFS, 0.0 dB on one at -18.
 *
 * ⚠ IT IS NOT A SECOND PEAK REDUCTION KNOB. An offset and the matching PR move
 * are bit-identical as DSP; the difference is what the numbers MEAN. Peak
 * Reduction is a patch value presets save, this is a property of the FILE. It
 * folds away on the face (FoldedLcd); AUTO measures it, stepping takes over,
 * exactly as the Gain knob behaves under Auto Makeup.
 */
function setInputAuto(on) {
  if (on) resetInputAuto()
  else syncInput(la2aInputDb.value)
}

/**
 * The lamp beside the nameplate is HARMONICS (analog mode), not power: power
 * is the header's switch. Off is not a bypass — the detector, taper, R37 and
 * ballistics are untouched and gain reduction is bit-identical, so what goes
 * is the colour and not the compression. An LA-2A has no saturation control,
 * and this is still not one: not "how much" but "whether".
 */
const toggleHarmonics = () => syncAnalog(!la2aAnalog.value)

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

/**
 * Presets. This replaced a mock dropdown that displayed four names and changed
 * nothing — the placeholder that made this plugin the one asking for a real
 * preset architecture.
 *
 * Reading the params is just the knobs. Writing them has one ordering
 * constraint worth stating: the Gain knob goes LAST and goes through the AUTO
 * decision, because `syncGain` is a take-over — it drops AUTO and accepts the
 * value. Setting the gain before deciding the AUTO state would therefore leave
 * AUTO off whatever the preset asked for.
 */
const presets = usePluginPresets(OPTO_SMOOTH_PRESET_PLUGIN, {
  read: () => ({
    mode: la2aMode.value,
    peakReduction: la2aPeakReduction.value,
    gain: la2aGain.value,
    r37: la2aR37.value,
    lookahead: la2aLookahead.value,
    analog: la2aAnalog.value,
    mix: la2aMix.value,
    autoMakeup: la2aAutoMakeup.value,
  }),
  write: (p) => {
    syncMode(p.mode)
    syncPeakReduction(p.peakReduction)
    syncR37(p.r37)
    // Absent in every preset saved before the control existed, and 0 is both
    // the default and what those patches were auditioned with.
    syncLookahead(p.lookahead ?? 0)
    // Absent in every preset saved before the control existed, and those were
    // auditioned WITH the nonlinearity — so an absent key means ON, never OFF.
    syncAnalog(p.analog !== false)
    // Absent in every preset saved before the control existed; those were
    // auditioned fully wet.
    syncMix(p.mix ?? 1)
    if (p.autoMakeup) {
      // Already on: the syncs above have each scheduled a re-measure, so the
      // knob lands on the new settings without a second toggle.
      if (!la2aAutoMakeup.value) toggleAuto()
    } else {
      if (la2aAutoMakeup.value) toggleAuto()
      syncGain(p.gain)
    }
  },
})
</script>

<template>
  <FloatingWindow
    window-id="opto-smooth"
    :z="z"
    :width="868"
    :top="110"
    :accent="ACCENT"
    :background="FACEPLATE"
    brand-lead="LA VINTAGE"
    brand-tail="2A"
    :engaged="la2aPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!la2aPreview"
    apply-disabled-hint="Turn LA Vintage 2A on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <template #header-center>
      <PresetMenu
        :presets="presets"
        :accent="ACCENT"
        :disabled="!la2aPreview"
        disabled-hint="Turn LA Vintage 2A on to use presets"
      />
    </template>

    <div class="v2a" :class="{ 'is-off': off }">
      <div class="v2a-ear v2a-ear--l" aria-hidden="true">
        <div class="v2a-ear-slot v2a-ear-slot--top" />
        <div class="v2a-ear-slot v2a-ear-slot--bottom" />
      </div>

      <div class="v2a-main">
        <div class="v2a-screw v2a-screw--tl" aria-hidden="true"><div class="v2a-screw-slot" /></div>
        <div class="v2a-screw v2a-screw--tr" aria-hidden="true"><div class="v2a-screw-slot" /></div>
        <div class="v2a-screw v2a-screw--bl" aria-hidden="true"><div class="v2a-screw-slot" /></div>
        <div class="v2a-screw v2a-screw--br" aria-hidden="true"><div class="v2a-screw-slot" /></div>

        <!-- ── Top row: Peak Reduction · meter · Gain ─────────────────────── -->
        <div class="v2a-top">
          <div class="v2a-col">
            <HardwareKnob
              class="v2a-ctl"
              variant="bakelite"
              :model-value="la2aPeakReduction"
              @update:model-value="syncPeakReduction"
              :min="0" :max="100" :step="1"
              :default-value="LA2A_DEFAULTS.peakReduction"
              mark-style="line" :dots="PR_TICKS" :labels="PR_SCALE.labels"
              rotate-labels :label-weight="500"
              :tip="prTip"
              label="Peak Reduction" :format-value="v => String(Math.round(v))"
              :disabled="off"
            />
            <div class="v2a-title">Peak Reduction</div>
          </div>

          <div class="v2a-center">
            <MachinedVuMeter :reduction-db="la2aReduction" :active="la2aPreview" />
            <div class="v2a-nameplate">
              <div class="v2a-nameplate-row">
                <LampButton
                  class="v2a-harmonics v2a-ctl"
                  :on="la2aAnalog"
                  :size="22"
                  :disabled="off"
                  :title="la2aAnalog
                    ? 'Harmonics on: the valve and cell colour. Click for clean — the compression is identical.'
                    : 'Harmonics off: clean, same compression. Click to bring the colour back.'"
                  @click="toggleHarmonics"
                />
                <div class="v2a-model">Vintage 2A</div>
              </div>
              <div class="v2a-kind">Leveling Amplifier</div>
            </div>
          </div>

          <div class="v2a-col">
            <!-- Stays draggable while Auto Makeup is lit: touching it takes
                 over and drops AUTO, so a gain the user sets actually sticks. -->
            <HardwareKnob
              class="v2a-ctl"
              variant="bakelite"
              :model-value="la2aGain"
              @update:model-value="syncGain"
              :min="GAIN_MIN_DB" :max="GAIN_MAX_DB" :step="0.1"
              :default-value="0"
              mark-style="line" :dots="GAIN_SCALE.dots" :labels="GAIN_SCALE.labels"
              rotate-labels :label-weight="500"
              :tip="gainTip"
              label="Gain" :format-value="formatSignedDb"
              :disabled="off"
            />
            <div class="v2a-title v2a-title--gain">
              Gain
              <!-- Auto makeup drives the Gain knob to whatever restores the
                   input's level; touching Gain takes over and drops AUTO. -->
              <div class="v2a-auto">
                <LampButton
                  class="v2a-ctl"
                  :on="la2aAutoMakeup"
                  :size="22"
                  :disabled="off"
                  :title="la2aAutoMakeup
                    ? 'Auto makeup on. Click to take manual control of Gain.'
                    : 'Auto makeup off. Click to let the plugin set the output gain.'"
                  @click="toggleAutoMakeup"
                />
                <span class="v2a-auto-label">Auto</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Bottom row: folded settings · mode + HF emph · mix ─────────── -->
        <div class="v2a-bottom">
          <div class="v2a-left">
            <FoldedLcd
              class="v2a-ctl"
              name="Pre-Gain"
              :model-value="la2aInputDb"
              @update:model-value="syncInput"
              :auto="la2aInputAuto"
              @update:auto="setInputAuto"
              :min="-INPUT_TRIM_MAX_DB" :max="INPUT_TRIM_MAX_DB" :step="0.5"
              :disabled="off"
            />
            <!-- LOOKAHEAD is OFF by default and that is not timidity: an LA-2A
                 has none, the transient pass-through IS the T4, and every
                 preset that predates it was made without it. It delays the
                 audio (never the side-chain) so an onset out of silence meets
                 the gain the cell would have reached later. Capped at 20 ms:
                 past that the duck starts audibly BEFORE the consonant. See
                 LOOKAHEAD_MAX_MS in la2aProcessor.js. -->
            <FoldedLcd
              class="v2a-ctl"
              name="Lookahead"
              :model-value="la2aLookahead"
              @update:model-value="syncLookahead"
              :min="0" :max="LOOKAHEAD_MAX_MS" :step="1"
              :format="formatLookahead"
              :disabled="off"
            />
          </div>

          <div class="v2a-mid">
            <!-- Compress / Limit — the hardware's rear-panel switch. -->
            <HardwareSlideSwitch
              class="v2a-ctl"
              :model-value="la2aMode"
              @update:model-value="syncMode"
              :options="MODE_OPTIONS"
              :pitch="36"
              :disabled="off"
              label="Mode"
            />
            <div class="v2a-small-knob">
              <HardwareKnob
                class="v2a-ctl v2a-knob-sm"
                variant="bakelite-sm"
                :model-value="hfEmph"
                @update:model-value="setHfEmph"
                :min="0" :max="100" :step="1"
                :default-value="0"
                mark-style="line" :dots="SMALL_TICKS" :labels="EMPH_LABELS"
                rotate-labels
                :tip="formatEmph(hfEmph)"
                label="HF emphasis (R37)" :format-value="formatEmph"
                :disabled="off"
              />
              <div class="v2a-small-title">HF Emph</div>
            </div>
          </div>

          <div class="v2a-right">
            <!-- Blends the untouched input back in — parallel compression
                 without a second track. Auto Makeup solves through the blend,
                 so the Gain it sets is right at every Mix. -->
            <div class="v2a-small-knob">
              <HardwareKnob
                class="v2a-ctl v2a-knob-md"
                variant="bakelite-md"
                :model-value="la2aMix"
                @update:model-value="syncMix"
                :min="0" :max="1" :step="0.01"
                :default-value="1"
                mark-style="line" :dots="SMALL_TICKS" :labels="MIX_LABELS"
                rotate-labels
                :tip="formatPercent(la2aMix)"
                label="Mix" :format-value="formatPercent"
                :disabled="off"
              />
              <div class="v2a-small-title">Mix</div>
            </div>
          </div>
        </div>
      </div>

      <div class="v2a-ear v2a-ear--r" aria-hidden="true">
        <div class="v2a-ear-slot v2a-ear-slot--top" />
        <div class="v2a-ear-slot v2a-ear-slot--bottom" />
      </div>
    </div>

    <!-- Bench only: gated off in production builds. See la2aTuning.js. -->
    <div v-if="showTuningBench" class="v2a-bench">
      <LA2ATuningPanel
        :accent="ACCENT"
        :disabled="!la2aPreview"
        @change="refreshKernelTuning"
      />
    </div>
  </FloatingWindow>
</template>

<style scoped>
/* The light face re-inks every shared control through these. */
.v2a {
  --hw-ink: #232527;
  --hw-ink-shadow: 0 1px 0 rgba(255,255,255,.55);
  --hw-mark: #2a2c2f;
  --hw-mark-shadow: 0 1px 0 rgba(255,255,255,.55);
  --hw-rim: rgba(255,255,255,.6);
  --hw-switch-on: #141516;
  --hw-switch-off: #7b7e81;
  --hw-switch-shadow: none;
  --hw-fader-tick: #2f3134;
  --hw-dim: #5d6064;
  --hw-dim-hover: #232527;
  --hw-hover-bg: rgba(0,0,0,.06);
  --hw-manual: #a24a12;
  --hw-manual-hover: #7e3409;
  --hw-manual-glow: none;
}
.v2a {
  position: relative; display: flex;
  font-family: Oswald, 'Inter', system-ui, sans-serif;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.7);
}
.v2a-ear { position: relative; width: 42px; flex: 0 0 auto; background: linear-gradient(180deg,#e4e5e4,#d3d5d4 55%,#c3c6c5); }
.v2a-ear--l { box-shadow: inset -1px 0 0 rgba(0,0,0,.14); }
.v2a-ear--r { box-shadow: inset 1px 0 0 rgba(0,0,0,.14); }
/* The rack slots, cut through to the window behind. */
.v2a-ear-slot { position: absolute; width: 22px; height: 10px; background: #1c1d1f; box-shadow: inset 0 1px 2px rgba(0,0,0,.8); }
.v2a-ear-slot--top { top: 40px; }
.v2a-ear-slot--bottom { bottom: 52px; }
.v2a-ear--l .v2a-ear-slot { left: 0; border-radius: 0 5px 5px 0; }
.v2a-ear--r .v2a-ear-slot { right: 0; border-radius: 5px 0 0 5px; }

.v2a-main { flex: 1; min-width: 0; position: relative; padding: 24px 18px; }
.v2a-screw {
  position: absolute; width: 11px; height: 11px; border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle at 36% 30%,#f2f4f6,#9da2a6 62%,#71767a);
  box-shadow: inset 0 -1px 2px rgba(0,0,0,.4), 0 1px 0 rgba(255,255,255,.6);
}
.v2a-screw-slot { position: absolute; left: 2px; right: 2px; top: 4.5px; height: 2px; background: rgba(0,0,0,.4); }
.v2a-screw--tl { left: 12px; top: 12px; }
.v2a-screw--tr { right: 12px; top: 12px; }
.v2a-screw--bl { left: 12px; bottom: 10px; }
.v2a-screw--br { right: 12px; bottom: 10px; }
.v2a-screw--tl .v2a-screw-slot { transform: rotate(28deg); }
.v2a-screw--tr .v2a-screw-slot { transform: rotate(-36deg); }
.v2a-screw--bl .v2a-screw-slot { transform: rotate(-60deg); }
.v2a-screw--br .v2a-screw-slot { transform: rotate(12deg); }

.v2a-top { position: relative; display: flex; align-items: flex-start; justify-content: space-between; }
.v2a-col { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 8px; }
/* Engraved under the knob, tucked into the bottom of its dial box. */
.v2a-title {
  position: relative; margin-top: -14px;
  font-size: 15px; font-weight: 500; line-height: 1; letter-spacing: .24em; text-transform: uppercase;
  white-space: nowrap; color: #2f3134; text-shadow: 0 1px 0 rgba(255,255,255,.6);
}
.v2a-auto {
  position: absolute; right: calc(100% + 14px); top: 50%; transform: translateY(-50%);
  display: flex; flex-direction: row-reverse; align-items: center; gap: 7px;
}
.v2a-auto-label { font-size: 9px; font-weight: 400; line-height: 1.25; letter-spacing: .16em; text-transform: uppercase; text-shadow: none; }
.v2a-center { flex: 0 1 auto; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 14px; }
.v2a-nameplate { display: flex; flex-direction: column; align-items: center; gap: 6px; }
/* The lamp hangs off the left of the name, outside the flow, so both lines of
   lettering centre on the meter's axis rather than on name + lamp. */
.v2a-nameplate-row { position: relative; display: flex; align-items: center; }
.v2a-harmonics { position: absolute; right: calc(100% + 16px); top: 50%; transform: translateY(-50%); }
/* Letter-spacing trails the last glyph too; the matching indent puts the ink,
   not the box, on centre. */
.v2a-model {
  font-size: 22px; font-weight: 700; line-height: 1; letter-spacing: .06em; padding-left: .06em; text-transform: uppercase;
  color: #b3262b; text-shadow: 0 1px 0 rgba(255,255,255,.5);
}
.v2a-kind {
  font-size: 11px; font-weight: 400; line-height: 1; letter-spacing: .16em; padding-left: .16em; text-transform: uppercase;
  color: #232527;
}

.v2a-bottom { position: relative; margin-top: -18px; display: grid; grid-template-columns: 196px 1fr 196px; align-items: end; }
.v2a-left { display: flex; flex-direction: column; align-items: center; gap: 18px; padding-bottom: 4px; }
.v2a-mid { display: flex; align-items: center; justify-content: center; gap: 44px; padding: 30px 0 4px; }
.v2a-right { display: flex; align-items: flex-end; justify-content: center; }
.v2a-small-knob { display: flex; flex-direction: column; align-items: center; gap: 2px; }
/* The dial boxes are square; the design's are trimmed top and bottom. */
.v2a-knob-sm { margin: -6px 0; }
.v2a-knob-md { margin: -6px 0; }
.v2a-small-knob :deep(.hw-numeral) { letter-spacing: .1em; }
.v2a-small-title { margin-top: 3px; font-size: 10px; line-height: 1; letter-spacing: .18em; padding-left: .18em; text-transform: uppercase; color: #2f3134; }
.v2a-bench { display: flow-root; padding: 0 26px 20px; background: #1d2027; }

/* Unit off: the controls go dead and dim; the engraving stays. Knobs dim
   their own cap (HardwareKnob), so their printed scale is left alone. */
.v2a-ctl { transition: opacity .15s ease; }
.is-off .v2a-ctl:not(.hw-knob) { opacity: .45; }
</style>
