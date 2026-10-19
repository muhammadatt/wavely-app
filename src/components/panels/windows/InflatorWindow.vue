<script setup>
/**
 * CAMBRIDGE INFLATOR — the Modula faceplate (docs/design/modula/Inflator.dc.html).
 *
 * IN meter with the Input trim under it · a raised centre panel holding the
 * two long faders, EFFECT and CURVE, with the LIFT ladder and the two switches
 * between them · OUT meter with the Output trim under it.
 *
 * The ranges are the plugin's own, not the mockup's: Input ±12 dB, Output
 * −12…0 (it only ever CUTS, matching the reference — the curve already raises
 * the level, and an Output that could raise it further would make every A/B
 * against bypass a loudness comparison).
 */
import { computed, onMounted } from 'vue'
import { useInflator } from '../../../composables/useInflator.js'
import { useEditorState } from '../../../composables/useEditorState.js'
import { usePluginPresets } from '../../../composables/usePluginPresets.js'
import { INFLATOR_PRESET_PLUGIN } from '../../../audio/pluginPresets/index.js'
import {
  INFLATOR_DEFAULTS, INFLATOR_INPUT_MIN_DB, INFLATOR_INPUT_MAX_DB, INFLATOR_OUTPUT_MIN_DB, INFLATOR_OUTPUT_MAX_DB,
  CURVE_MIN_PCT, CURVE_MAX_PCT, inflatorLiftDb,
} from '../../../audio/inflatorParams.js'
import FloatingWindow from '../FloatingWindow.vue'
import LevelMeter from '../../meters/LevelMeter.vue'
import ModulaKnob from '../../modula/ModulaKnob.vue'
import ModulaFader from '../../modula/ModulaFader.vue'
import ModulaLedPill from '../../modula/ModulaLedPill.vue'
import ModulaMiniLadder from '../../modula/ModulaMiniLadder.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  inInputDb, inEffect, inCurve, inOutputDb, inClip, inBandSplit,
  inPreview, inInputLevels, inOutputLevels, inLiftDb,
  togglePreview, currentParams, applyParams,
  syncInputDb, syncEffect, syncCurve, syncOutputDb, syncClip, syncBandSplit,
  apply, teardown, closeModal,
} = useInflator()

const { state } = useEditorState()

const presets = usePluginPresets(INFLATOR_PRESET_PLUGIN, {
  read: () => currentParams(),
  write: p => applyParams(p),
})

// Default to engaged when the panel opens, matching the other plugin windows.
onMounted(() => {
  if (!inPreview.value) togglePreview()
})

const ACCENT = '#e8a33d'
const METER_H = 228

const decibels = v => `${v > 0.05 ? '+' : ''}${v.toFixed(1)} dB`
const percent = v => `${(v * 100).toFixed(1)} %`
const signed = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}`

// The small-signal lift the settings give — Effect blends it in linearly in
// amplitude: 1 + Effect·(f'(0) − 1). The ladder beside it is the lift being
// applied right now, measured; this is the most it can be.
const maxLiftDb = computed(() => {
  const slope = 10 ** (inflatorLiftDb(inCurve.value) / 20)
  return 20 * Math.log10(1 + inEffect.value * (slope - 1))
})
// The ladder's full scale: the largest lift any setting gives (Curve +50, Effect 100 %).
const LIFT_FULL_DB = inflatorLiftDb(CURVE_MAX_PCT)
const liftValues = computed(() => {
  const v = inLiftDb.value.length ? inLiftDb.value : [0]
  return (v.length === 1 ? [v[0], v[0]] : v).map(db => db / LIFT_FULL_DB)
})
const liftText = computed(() => (inPreview.value ? `+${maxLiftDb.value.toFixed(1)} dB` : 'OFF'))

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
    window-id="inflator"
    :z="z"
    :width="660"
    :accent="ACCENT"
    design="modula"
    brand-lead="CAMBRIDGE INFLATOR"
    :presets="presets"
    :presets-disabled="!inPreview"
    presets-disabled-hint="Turn Inflator on to use presets"
    :engaged="inPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!inPreview"
    apply-disabled-hint="Turn Inflator on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="inf-grid">
      <!-- IN, with the Input trim: it drives the curve, which is not level-invariant. -->
      <div class="inf-meter">
        <LevelMeter variant="modula" scale-side="left" :levels="inInputLevels" label="IN" :height="METER_H">
          <template #below>
            <ModulaKnob
              variant="trim" :model-value="inInputDb" show-value
              :min="INFLATOR_INPUT_MIN_DB" :max="INFLATOR_INPUT_MAX_DB" :step="0.1"
              :default-value="INFLATOR_DEFAULTS.inputDb" :format-value="decibels"
              aria-label="Input" :disabled="!inPreview"
              title="Input: drives the curve harder. The Inflator is not level-invariant, so this changes how much of the signal the curve lifts. Double-click to reset"
              @update:model-value="syncInputDb"
            />
          </template>
        </LevelMeter>
      </div>

      <div class="inf-panel">
        <div class="inf-captions"><span>EFFECT</span><span>CURVE</span></div>
        <div class="inf-row">
          <div class="inf-fader" title="Effect: how much of the curve's output is blended with the dry signal. 0 skips the curve outright">
            <ModulaFader
              :model-value="inEffect" :min="0" :max="1" :step="0.001"
              :default-value="INFLATOR_DEFAULTS.effect" :format-value="percent"
              aria-label="Effect" :disabled="!inPreview"
              @update:model-value="syncEffect"
            />
          </div>

          <div class="inf-centre">
            <ModulaMiniLadder
              :values="liftValues" :rows="14" :color="ACCENT" :reading="liftText" label="LIFT"
              title="LIFT: what the curve is adding right now (the ladder, measured as output against input) and the most it can add — on the quietest material — at these settings (the number)"
            />
            <div class="inf-toggles">
              <div class="inf-toggle">
                <ModulaLedPill
                  :model-value="inBandSplit" label="BAND SPLIT" :color="ACCENT" :disabled="!inPreview"
                  @update:model-value="syncBandSplit"
                />
                <span class="inf-cap">{{ inBandSplit ? 'curve runs on 240 Hz / 2.4 kHz bands' : 'curve runs on the whole signal' }}</span>
              </div>
              <div class="inf-toggle">
                <ModulaLedPill
                  :model-value="inClip" label="CLIP 0 dB" :color="ACCENT" :disabled="!inPreview"
                  @update:model-value="syncClip"
                />
                <span class="inf-cap">{{ inClip ? 'holds peaks at full scale' : 'peaks past full scale fold back' }}</span>
              </div>
            </div>
          </div>

          <!-- CURVE IS SHAPE, NOT DEPTH — f(1) = 1 at every setting, so this
               cannot move the ceiling. What it moves is the small-signal lift,
               which the LIFT readout beside it prints. -->
          <div class="inf-fader" title="Curve: the shape of the curve. Positive lifts quiet material more; it never moves the ceiling">
            <ModulaFader
              :model-value="inCurve" :min="CURVE_MIN_PCT" :max="CURVE_MAX_PCT" :step="0.1"
              :default-value="INFLATOR_DEFAULTS.curve" :unity="0" :format-value="signed"
              aria-label="Curve" :disabled="!inPreview"
              @update:model-value="syncCurve"
            />
          </div>
        </div>

        <!-- ⚠ THE ONE COMBINATION THAT BREAKS THE PLUGIN'S HEADLINE PROMISE.
             Broadband, f(s) <= 1 bounds the output at full scale whatever the
             settings. Band Split sums THREE curve outputs, each bounded by 1,
             so the sum is not — measured at +2.8 dB over on hot material. -->
        <p v-if="inBandSplit && !inClip" class="inf-warn">
          Band Split can exceed full scale — three bands sum after the curve.
          Turn Clip on to hold the ceiling.
        </p>
      </div>

      <!-- OUT, with the Output trim: cut only. -->
      <div class="inf-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="inOutputLevels" label="OUT" :height="METER_H">
          <template #below>
            <ModulaKnob
              variant="trim" :model-value="inOutputDb" show-value
              :min="INFLATOR_OUTPUT_MIN_DB" :max="INFLATOR_OUTPUT_MAX_DB" :step="0.1"
              :default-value="INFLATOR_DEFAULTS.outputDb" :format-value="decibels"
              aria-label="Output" :disabled="!inPreview"
              title="Output: cut only. The curve already raises the level. Double-click to reset"
              @update:model-value="syncOutputDb"
            />
          </template>
        </LevelMeter>
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.inf-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}
.inf-meter {
  display: flex;
  justify-content: center;
  padding: 12px 4px;
}
.inf-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 12px 10px 16px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.inf-captions {
  align-self: stretch;
  display: flex;
  justify-content: space-between;
  padding: 0 14px;
  font: 600 10px/1 var(--m-font-ui);
  letter-spacing: .14em;
  color: var(--m-ink-3);
}
.inf-row {
  align-self: stretch;
  display: flex;
  justify-content: center;
  align-items: flex-end;
  gap: 14px;
}
.inf-fader { padding-bottom: 6px; }
.inf-centre {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding-bottom: 6px;
}
.inf-toggles { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.inf-toggle { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.inf-cap {
  max-width: 170px;
  text-align: center;
  font: 600 8.5px/1.35 var(--m-font-ui);
  letter-spacing: .06em;
  color: rgba(255, 255, 255, .4);
}
.inf-warn {
  margin: 4px 6px 0;
  text-align: center;
  font: 600 9px/1.5 var(--m-font-ui);
  color: var(--m-accent);
}
</style>
