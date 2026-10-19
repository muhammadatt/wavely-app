<script setup>
/**
 * PHAT*SS — Psycho Harmonic Analog Tape * Saturation Simulator, on the Modula
 * faceplate (docs/design/modula/Tape_Saturator.dc.html).
 *
 *   SATURATION   what TAPE and Warmth are adding, against the clean signal
 *   IN  + trim   Input: a DRIVE into everything after it (phatassParams)
 *   TAPE         DRIVE — dB TAPE takes off the selection's peak, with
 *                peak-restoring makeup; CLEAN (cubic) / PHAT (the hysteresis
 *                loop); TAPE SPEED 7.5 / 15 / 30 IPS — the HF sag and the
 *                head bump (`HF_DETENTS`)
 *   HARMONICS    WARMTH — the low-end layers, never raising the peak (the
 *                guard); ROUND / TIGHT — their balance (`CHARACTERS`)
 *   MIX          dry / wet against a latency-aligned dry path
 *   OUT + trim   Output
 *
 * The per-band Warmth readout, the MAKEUP and speed captions and the
 * explanatory paragraph are off this panel (owner's call); the tooltips carry
 * what the captions said. The bench rows still render under it in dev builds.
 */
import { computed, onMounted, watch } from 'vue'
import { usePhatass } from '../../composables/usePhatass.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import { PHATASS_PRESET_PLUGIN } from '../../audio/pluginPresets/index.js'
import { PHATASS_PARAM_KEYS } from '../../audio/pluginPresets/phatass.js'
import {
  PHATASS_DEFAULTS, WARMTH_MAX, TAPE_MAX_DB, OUTPUT_MIN_DB, OUTPUT_MAX_DB, INPUT_MIN_DB, INPUT_MAX_DB,
  CHARACTERS, TAPE_PANEL_CURVES,
} from '../../audio/phatassParams.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import ModulaDetent from '../modula/ModulaDetent.vue'
import ModulaFader from '../modula/ModulaFader.vue'
import ModulaBarMeter from '../modula/ModulaBarMeter.vue'
import PhatassBenchPanel from './PhatassBenchPanel.vue'
import { isPhatassBenchVisible } from '../../audio/effects/phatassBench.js'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  phParams, phPreview, phInputLevels, phOutputLevels, phSatNeedle, phOutputMakeup,
  togglePreview, syncParam, applyParams, scheduleWarmthReadout, apply, teardown, closeModal,
} = usePhatass()

const { state } = useEditorState()

const presets = usePluginPresets(PHATASS_PRESET_PLUGIN, {
  read: () => Object.fromEntries(PHATASS_PARAM_KEYS.map(k => [k, phParams[k]])),
  write: p => applyParams(p),
})

// TAPE's makeup (and the bench's trim) follow the selection and the file, only while the panel is live.
watch(() => [state.selection?.start, state.selection?.end, state.revision], () => {
  if (phPreview.value) scheduleWarmthReadout()
})

onMounted(() => {
  if (!phPreview.value) togglePreview()
})

const ACCENT = '#e8a33d'
const showBench = isPhatassBenchVisible()
const METER_H = 236

const fmtDb = v => `${v > 0.05 ? '+' : ''}${(Math.abs(v) < 0.05 ? 0 : v).toFixed(1)} dB`
const fmtDrive = v => (v <= 0 ? 'OFF' : `−${v.toFixed(1)} dB`)
const fmtWarmth = v => (v <= 0 ? 'OFF' : v.toFixed(1))
const fmtMix = v => `${Math.round(v * 100)}%`

const TAPE_CURVE_TITLES = {
  cubic: 'CLEAN: a soft clipper that rounds off only the top of each wave, adding mostly the third harmonic, and clips flat past about 3.5 dB',
  hysteresis: 'PHAT: magnetic tape\'s own loop, with memory — low, heavy hits like kicks are squashed about twice as hard as snares, and peaks round off without a hard clip. Heavier on the processor',
}
const TAPE_CURVE_OPTIONS = TAPE_PANEL_CURVES.map(c => ({ ...c, title: TAPE_CURVE_TITLES[c.value] }))

const CHARACTER_TITLES = {
  50: 'ROUND: rounder and fuller — more of the even (quartic) layer',
  25: 'TIGHT: firmer, with more edge — more of the odd (cubic) layer',
}
const CHARACTER_OPTIONS = CHARACTERS.map(c => ({ ...c, title: CHARACTER_TITLES[c.value] }))
// A bench or legacy Odd/Even off the two positions lights neither half.
const characterValue = computed(() => Number(phParams.oddEven))

// Left to right, slowest first: the knob turns clockwise toward more headroom.
const SPEED_OPTIONS = [
  { value: 'ips7', label: '7.5', title: '7.5 IPS: the least HF headroom. The top end darkens on anything bright and the loss reaches into the upper mids; the head bump is lowest' },
  { value: 'ips15', label: '15', title: '15 IPS: bright passages lose some top end, more as they get hotter. Attacks stay bright' },
  { value: 'ips30', label: '30', title: '30 IPS: the most HF headroom. Only the brightest passages sag a little at the very top; the head bump is gentlest' },
]
// A bench-only position (OFF) shows on the dial rather than lighting a speed it is not.
const speedOptions = computed(() => (SPEED_OPTIONS.some(o => o.value === phParams.hf)
  ? SPEED_OPTIONS
  : [...SPEED_OPTIONS, { value: phParams.hf, label: String(phParams.hf).toUpperCase(), title: 'Set on the bench' }]))

const satReading = computed(() => (phPreview.value ? `${Math.round(phSatNeedle.value)}%` : 'OFF'))

function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

function close() {
  teardown()
}

async function applyAndClose() {
  await apply()
  teardown()
  closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="phatass"
    :z="z"
    :width="668"
    :accent="ACCENT"
    design="modula"
    brand-lead="PHATaSS"
    :presets="presets"
    :presets-disabled="!phPreview"
    presets-disabled-hint="Turn PHATaSS on to use presets"
    :engaged="phPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!phPreview"
    apply-disabled-hint="Turn PHATaSS on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="ph-grid">
      <div
        class="ph-sat"
        title="SATURATION: how much TAPE and Warmth are adding, against the clean signal — the energy of everything they add, averaged over the last fraction of a second. 0 is −40 dB (barely there), 100 is as much added as the signal itself; red from about 80. Warmth reads far higher than TAPE: its low layers reshape the whole low band"
      >
        <ModulaBarMeter title="SATURATION" :reading="satReading" :value="phSatNeedle / 100" :active="phPreview" :color="ACCENT" />
      </div>

      <div class="ph-meter">
        <LevelMeter variant="modula" scale-side="left" :levels="phInputLevels" label="IN" :height="METER_H">
          <template #below>
            <ModulaKnob
              variant="trim" :model-value="phParams.inputDb" show-value
              :min="INPUT_MIN_DB" :max="INPUT_MAX_DB" :step="0.1" :default-value="PHATASS_DEFAULTS.inputDb"
              :format-value="fmtDb" aria-label="Input" :disabled="!phPreview"
              title="Input: drives everything after it harder — TAPE, Warmth and the HF sag are calibrated on the selection, so turning this up pushes the signal further into them. TAPE's makeup follows, so the peak lands where the driven signal's was. Double-click to reset"
              @update:model-value="v => syncParam('inputDb', v)"
            />
          </template>
        </LevelMeter>
      </div>

      <div class="ph-centre">
        <div class="ph-modules">
          <section class="ph-module">
            <header class="ph-module-head">Tape</header>
            <div class="ph-module-body">
              <div title="DRIVE: takes this many dB off the selection's loudest peak the way tape saturation does, and gives it back as level — the makeup is measured, so the peak lands where it started. Turning it up also drives the top end into the HF sag and brings in the speed's head bump. Double-click for off">
                <ModulaKnob
                  variant="led" :size="156" :model-value="phParams.tape"
                  :min="0" :max="TAPE_MAX_DB" :step="0.1" :default-value="PHATASS_DEFAULTS.tape"
                  :format-value="fmtDrive" label="Drive" :color="ACCENT" :disabled="!phPreview"
                  @update:model-value="v => syncParam('tape', v)"
                />
              </div>
              <ModulaSegmented
                :model-value="phParams.tapeCurve" :options="TAPE_CURVE_OPTIONS"
                aria-label="Tape type" :disabled="!phPreview || phParams.tape <= 0"
                @update:model-value="v => syncParam('tapeCurve', v)"
              />
            </div>
            <div class="ph-module-rule"></div>
            <div class="ph-module-foot" title="TAPE SPEED: the treble sags on bright, hot passages — slower tape sags sooner, deeper and further down — while attacks stay bright, and Drive makes it sag harder. The speed also sets Drive's head bump, an octave lower at each slower speed">
              <ModulaDetent
                :model-value="phParams.hf" :options="speedOptions" label="Tape speed (IPS)" :disabled="!phPreview"
                @update:model-value="v => syncParam('hf', v)"
              />
            </div>
          </section>

          <section class="ph-module">
            <header class="ph-module-head">Harmonics</header>
            <div class="ph-module-body">
              <div title="WARMTH: low-end harmonic warmth — an even (quartic) and an odd (cubic) saturator on the low band, voiced for body. It sets how much of what they add is mixed in; the clean signal is never touched. Calibrated on this file, and never raises the selection's peak: a guard turns the added warmth down for a few milliseconds where it would. Double-click for off">
                <ModulaKnob
                  variant="ticks" :size="156" :model-value="phParams.warmth"
                  :min="0" :max="WARMTH_MAX" :step="0.1" :default-value="PHATASS_DEFAULTS.warmth"
                  :format-value="fmtWarmth" label="Warmth" :color="ACCENT" :disabled="!phPreview"
                  @update:model-value="v => syncParam('warmth', v)"
                />
              </div>
              <ModulaSegmented
                :model-value="characterValue" :options="CHARACTER_OPTIONS"
                aria-label="Warmth character" :disabled="!phPreview || phParams.warmth <= 0"
                @update:model-value="v => syncParam('oddEven', v)"
              />
            </div>
          </section>
        </div>

        <div class="ph-mix" title="MIX: the processed signal against the dry one, held back by the plugin's latency so the blend never combs. Double-click for fully wet">
          <span class="m-caption">Mix</span>
          <ModulaFader
            orientation="horizontal" :length="300" :thickness="44" readout="end" :readout-min-width="52"
            :model-value="phParams.mix" :min="0" :max="1" :step="0.01" :default-value="PHATASS_DEFAULTS.mix"
            :format-value="fmtMix" aria-label="Mix" :disabled="!phPreview"
            @update:model-value="v => syncParam('mix', v)"
          />
        </div>
      </div>

      <div class="ph-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="phOutputLevels" label="OUT" :height="METER_H">
          <template #below>
            <ModulaKnob
              variant="trim" :model-value="phParams.output" show-value
              :min="OUTPUT_MIN_DB" :max="OUTPUT_MAX_DB" :step="0.1" :default-value="PHATASS_DEFAULTS.output"
              :format-value="fmtDb" aria-label="Output" :disabled="!phPreview"
              title="Output: a trim on the whole plugin, after Mix. Double-click to reset"
              @update:model-value="v => syncParam('output', v)"
            />
          </template>
        </LevelMeter>
      </div>
    </div>

    <!-- Bench only: gated off in production builds. See phatassBench.js. -->
    <PhatassBenchPanel
      v-if="showBench"
      :params="phParams" :disabled="!phPreview" :trim-pending="phOutputMakeup.pending"
      @set="(k, v) => syncParam(k, v)"
    />
  </FloatingWindow>
</template>

<style scoped>
.ph-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-rows: auto 1fr;
  gap: 10px;
}
.ph-sat {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  padding: 12px 14px 10px;
  border-radius: 16px;
  /* background: linear-gradient(180deg, #0c0d0e, #18191a); */
  background: var(--m-well);
  box-shadow: inset 0 2px 10px rgba(0, 0, 0, .8), 0 0 0 1px rgba(0, 0, 0, .5);
}
.ph-meter {
  grid-row: 2;
  display: flex;
  justify-content: center;
  padding: 2px 0;
}
.ph-meter:first-of-type { grid-column: 1; }
.ph-meter:last-of-type { grid-column: 3; }
.ph-centre {
  grid-row: 2;
  grid-column: 2;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ph-modules {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1.12fr) minmax(0, 1fr);
  gap: 10px;
}
.ph-module {
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .05), 0 0 0 1px rgba(0, 0, 0, .5);
}
.ph-module-head {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 14px 9px;
  border-bottom: 1px solid rgba(0, 0, 0, .45);
  box-shadow: 0 1px 0 rgba(255, 255, 255, .05);
  font: 700 10px/1 var(--m-font-ui);
  letter-spacing: .18em;
  text-transform: uppercase;
  color: var(--m-ink-2);
}
.ph-module-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 18px 10px 12px;
}
.ph-module-rule {
  height: 1px;
  margin: 0 14px;
  background: rgba(0, 0, 0, .45);
  box-shadow: 0 1px 0 rgba(255, 255, 255, .05);
}
.ph-module-foot {
  display: flex;
  justify-content: center;
  padding: 6px 10px 12px;
}
.ph-mix {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border-radius: 16px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .05), 0 0 0 1px rgba(0, 0, 0, .5);
}
</style>
