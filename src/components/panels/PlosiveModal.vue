<script setup>
/**
 * Plosive Tamer.
 *
 * Two stages, each with its own row of controls and its own colour:
 *
 *   POP    (amber) the low thump of a P or B. DEPTH is the deepest cut, FREQ the
 *          corner the low band is detected and cut below, SENSITIVITY how far it
 *          must jump and stand over the voice, RELEASE how fast the low end
 *          comes back.
 *   BURST  (lavender) the T, K and P release out of a stop's silence. DEPTH is
 *          its cut above FREQ, SENSITIVITY how sharp the onset must be, LENGTH
 *          how long a caught burst is held down.
 *
 * Read plosiveProcessor.js for the design. The scope is the De-Esser's: the
 * waveform around the playhead, shaded wherever a stage cut. The counters are
 * events caught since RESET. DELTA plays only what was removed and never
 * reaches the apply path.
 */
import { onMounted, ref, watch } from 'vue'
import { usePlosive } from '../../composables/usePlosive.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  PLOSIVE_DEFAULTS, POP_DEPTH_MAX_DB, POP_FREQ_MIN_HZ, POP_FREQ_MAX_HZ, POP_RELEASE_MIN_MS, POP_RELEASE_MAX_MS,
  BURST_DEPTH_MAX_DB, BURST_FREQ_MIN_HZ, BURST_FREQ_MAX_HZ, BURST_LENGTH_MIN_MS, BURST_LENGTH_MAX_MS,
  OUTPUT_MIN_DB, OUTPUT_MAX_DB,
} from '../../audio/plosiveParams.js'
import { PLOSIVE_PRESET_PLUGIN, PLOSIVE_PARAM_KEYS } from '../../audio/pluginPresets/plosive.js'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import { HF_SCOPE_SECONDS } from '../../audio/deEsserScope.js'
import { readTimelineEnvelope } from '../../audio/timelineEnvelope.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import { createPeakHold, useMeterFrame } from '../meters/ballistics.js'
import DeEsserScope from '../meters/DeEsserScope.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  plParams, plPreview, plDelta, plPopCut, plBurstCut, plPops, plBursts,
  plInputLevels, plOutputLevels,
  togglePreview, syncParam, applyParams, toggleDelta, getScope, holdScope, clearScope, resetCounts,
  apply, teardown, closeModal,
} = usePlosive()

const presets = usePluginPresets(PLOSIVE_PRESET_PLUGIN, {
  read: () => Object.fromEntries(PLOSIVE_PARAM_KEYS.map(k => [k, plParams[k]])),
  write: p => applyParams(p),
})

const D = PLOSIVE_DEFAULTS
const { state } = useEditorState()

onMounted(() => {
  // The chain's copy keeps its ON/BYPASS: opening its editor from the chain
  // must not un-bypass its slot.
  if (!plPreview.value && currentPluginCopy() === 'solo') togglePreview()
})

// The scope freezes on what last played while the transport is stopped, and
// starts over if playback resumes somewhere else (the De-Esser's rule).
let stoppedAt = null
watch(() => [state.isPlaying, plPreview.value], ([playing]) => {
  if (playing) {
    if (stoppedAt !== null && Math.abs(state.playhead - stoppedAt) > 0.25) clearScope()
    stoppedAt = null
    holdScope(false)
  } else {
    stoppedAt = state.playhead
    holdScope(true)
  }
}, { immediate: true })

const ACCENT = '#e8a33d'
const BURST_COLOR = '#b9a6f2'
const METER_H = 214

/** The timeline's peak envelope around the playhead, for the scope's lookahead. */
const envelopeScratch = { ahead: null, behind: null }
function envelope(offsetSeconds, seconds, columns) {
  if (!state.segments?.length) return null
  const side = offsetSeconds < 0 ? 'behind' : 'ahead'
  if (envelopeScratch[side]?.length !== columns) envelopeScratch[side] = new Float32Array(columns)
  return readTimelineEnvelope(state.segments, state.playhead + offsetSeconds, seconds, columns, envelopeScratch[side])
}

// Each bar and lamp is HELD: a burst is 15–40 ms, a frame or two, and read raw
// it flickered past unseen. Peak for 0.4 s, then 20 dB/s.
const HOLD = { holdMs: 400, fallPerSec: 20 }
const popHold = createPeakHold(HOLD)
const burstHold = createPeakHold(HOLD)
const popShown = ref(0)
const burstShown = ref(0)
useMeterFrame((dt) => {
  popShown.value = popHold.push(plPopCut.value, dt)
  burstShown.value = burstHold.push(plBurstCut.value, dt)
})

/** A lamp: dark at 0, lit and glowing at 1 (full at 3 dB of cut). */
function lampStyle(db, colour) {
  const on = Math.min(1, Math.max(0, db / 3))
  return {
    background: on > 0.05 ? colour : 'rgba(255,255,255,.16)',
    opacity: on > 0.05 ? 0.45 + 0.55 * on : 1,
    boxShadow: on > 0.05 ? `0 0 ${Math.round(3 + 5 * on)}px ${colour}` : 'none',
  }
}

const fmtHz = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k Hz` : `${Math.round(v)} Hz`)
const fmtDepth = v => (v <= 0 ? 'OFF' : `−${v.toFixed(1)} dB`)
const fmtDb = v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
const fmtMs = v => `${Math.round(v)} ms`
const fmtPct = v => `${Math.round(v)}`
/** Typed entry for a frequency: "2.5k" or "2500". */
function parseHz(t) {
  const m = String(t).trim().match(/^(-?\d*\.?\d+)\s*(k)?/i)
  if (!m) return NaN
  return parseFloat(m[1]) * (m[2] ? 1000 : 1)
}
const parseDepth = t => Math.abs(parseFloat(t))

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
    window-id="plosive"
    :z="z"
    :width="780"
    :accent="ACCENT"
    design="modula"
    brand-lead="PLOSIVE TAMER"
    :presets="presets"
    :presets-disabled="!plPreview"
    presets-disabled-hint="Turn Plosive Tamer on to use presets"
    :engaged="plPreview"
    show-delta
    :delta="plDelta"
    :delta-disabled="!plPreview"
    delta-title="Hear only what is being removed — it should sound like thumps and short spits, not words. Monitoring only; Apply always renders the processed audio."
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!plPreview"
    apply-disabled-hint="Turn Plosive Tamer on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-delta="toggleDelta"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="pt-grid">
      <div class="pt-meter">
        <LevelMeter variant="modula" scale-side="left" :levels="plInputLevels" label="IN" :height="METER_H" />
      </div>

      <div class="pt-display">
        <div class="pt-bars">
          <GainReductionBar
            :reduction-db="-popShown" :accent="ACCENT"
            :full-scale-db="POP_DEPTH_MAX_DB" ballistics="none" title="POP"
          />
          <GainReductionBar
            :reduction-db="-burstShown" :accent="BURST_COLOR"
            :full-scale-db="BURST_DEPTH_MAX_DB" ballistics="none" title="BURST"
          />
        </div>
        <div class="pt-scope">
          <DeEsserScope
            :data-fn="getScope"
            :envelope-fn="envelope"
            :window-seconds="HF_SCOPE_SECONDS * 2"
            :accent="ACCENT"
            :plosive-color="BURST_COLOR"
            :legend="{ treated: 'POP', plosive: 'BURST', guard: null }"
            :held="!state.isPlaying"
            :height="112"
            title="Plosive Tamer activity: the waveform, shaded amber where a pop was cut and lavender where a T, K or P release was — playhead at the centre, played audio to its left, audio about to play to its right"
            @request-play="togglePlayback"
          />
        </div>
        <div class="pt-counts">
          <span class="pt-count">
            <span class="pt-lamp" :style="lampStyle(popShown, ACCENT)" aria-hidden="true"></span>
            POPS <span class="pt-count-num">{{ plPops }}</span>
          </span>
          <span class="pt-count">
            <span class="pt-lamp" :style="lampStyle(burstShown, BURST_COLOR)" aria-hidden="true"></span>
            BURSTS <span class="pt-count-num">{{ plBursts }}</span>
          </span>
          <button
            type="button" class="pt-reset m-focusable" :disabled="!plPreview"
            title="Zero the counters"
            @click="resetCounts"
          >RESET</button>
        </div>
      </div>

      <div class="pt-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="plOutputLevels" label="OUT" :height="METER_H">
          <template #below>
            <ModulaKnob
              variant="trim" :model-value="plParams.output" show-value
              :min="OUTPUT_MIN_DB" :max="OUTPUT_MAX_DB" :step="0.1"
              :default-value="D.output" :format-value="fmtDb"
              aria-label="Output" :disabled="!plPreview"
              title="Output: a trim after the plugin. Double-click to reset"
              @update:model-value="v => syncParam('output', v)"
            />
          </template>
        </LevelMeter>
      </div>
    </div>

    <div class="pt-panel">
      <div class="pt-group">
        <span class="m-caption pt-caption" :style="{ color: ACCENT }">Pop · P and B thumps</span>
        <div class="pt-knobs">
          <ModulaKnob
            variant="small" :size="52" show-value editable :parse-value="parseDepth"
            :model-value="plParams.popDepth" :min="0" :max="POP_DEPTH_MAX_DB" :step="0.5"
            :default-value="D.popDepth" label="Depth" :color="ACCENT" :format-value="fmtDepth" :disabled="!plPreview"
            title="The deepest a P or B thump is taken down. Each pop is cut only as far as it stands above the voice. 0 turns POP off. Double-click to reset"
            @update:model-value="v => syncParam('popDepth', v)"
          />
          <ModulaKnob
            variant="small" :size="52" show-value editable :parse-value="parseHz"
            :model-value="plParams.popFreq" :min="POP_FREQ_MIN_HZ" :max="POP_FREQ_MAX_HZ" :step="1" scale="log"
            :default-value="D.popFreq" label="Freq" :color="ACCENT" :format-value="fmtHz" :disabled="!plPreview"
            title="Where the thump lives: the band below this is detected and turned down. Double-click to reset"
            @update:model-value="v => syncParam('popFreq', v)"
          />
          <ModulaKnob
            variant="small" :size="52" show-value editable
            :model-value="plParams.popSensitivity" :min="0" :max="100" :step="1"
            :default-value="D.popSensitivity" label="Sensitivity" :color="ACCENT" :format-value="fmtPct" :disabled="!plPreview"
            title="How easily a pop is caught: how suddenly the low band must jump, and how far over the voice it must stand. A deep voice's steady low end never jumps, so it is left alone. Double-click to reset"
            @update:model-value="v => syncParam('popSensitivity', v)"
          />
          <ModulaKnob
            variant="small" :size="52" show-value editable
            :model-value="plParams.popRelease" :min="POP_RELEASE_MIN_MS" :max="POP_RELEASE_MAX_MS" :step="1" scale="log"
            :default-value="D.popRelease" label="Release" :color="ACCENT" :format-value="fmtMs" :disabled="!plPreview"
            title="How quickly the low end comes back after a pop. Double-click to reset"
            @update:model-value="v => syncParam('popRelease', v)"
          />
        </div>
      </div>

      <span class="pt-rule" aria-hidden="true"></span>

      <div class="pt-group">
        <span class="m-caption pt-caption" :style="{ color: BURST_COLOR }">Burst · T, K and P releases</span>
        <div class="pt-knobs">
          <ModulaKnob
            variant="small" :size="52" show-value editable :parse-value="parseDepth"
            :model-value="plParams.burstDepth" :min="0" :max="BURST_DEPTH_MAX_DB" :step="0.5"
            :default-value="D.burstDepth" label="Depth" :color="BURST_COLOR" :format-value="fmtDepth" :disabled="!plPreview"
            title="How far a caught T, K or P release is turned down above Freq. 0 turns BURST off. Double-click to reset"
            @update:model-value="v => syncParam('burstDepth', v)"
          />
          <ModulaKnob
            variant="small" :size="52" show-value editable :parse-value="parseHz"
            :model-value="plParams.burstFreq" :min="BURST_FREQ_MIN_HZ" :max="BURST_FREQ_MAX_HZ" :step="10" scale="log"
            :default-value="D.burstFreq" label="Freq" :color="BURST_COLOR" :format-value="fmtHz" :disabled="!plPreview"
            title="The band above this is cut on a burst: lower takes more of the release's body, higher only its hiss. Double-click to reset"
            @update:model-value="v => syncParam('burstFreq', v)"
          />
          <ModulaKnob
            variant="small" :size="52" show-value editable
            :model-value="plParams.burstSensitivity" :min="0" :max="100" :step="1"
            :default-value="D.burstSensitivity" label="Sensitivity" :color="BURST_COLOR" :format-value="fmtPct" :disabled="!plPreview"
            title="How sharp an onset must be to count: a release comes straight out of a stop's silence and rises suddenly; higher catches softer ones. Double-click to reset"
            @update:model-value="v => syncParam('burstSensitivity', v)"
          />
          <ModulaKnob
            variant="small" :size="52" show-value editable
            :model-value="plParams.burstLength" :min="BURST_LENGTH_MIN_MS" :max="BURST_LENGTH_MAX_MS" :step="1"
            :default-value="D.burstLength" label="Length" :color="BURST_COLOR" :format-value="fmtMs" :disabled="!plPreview"
            title="How long a caught release is held down. It lets go early when the vowel after it arrives. Double-click to reset"
            @update:model-value="v => syncParam('burstLength', v)"
          />
        </div>
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.pt-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}
.pt-meter {
  display: flex;
  justify-content: center;
  padding: 12px 4px;
}
.pt-display {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.pt-bars {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pt-scope {
  padding: 3px;
  border-radius: 9px;
  background: #0b0e13;
  box-shadow: var(--m-shadow-well), 0 0 0 1px #1c222c;
}
.pt-counts {
  display: flex;
  align-items: center;
  gap: 18px;
  font: 600 10px/1 var(--m-font-mono);
  letter-spacing: .08em;
  color: var(--m-ink-3);
}
.pt-count { display: inline-flex; align-items: center; gap: 7px; }
.pt-count-num {
  min-width: 28px;
  font-variant-numeric: tabular-nums;
  color: var(--m-ink-2, #c3c9cf);
}
.pt-lamp {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}
.pt-reset {
  margin-left: auto;
  padding: 4px 9px;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  background: linear-gradient(180deg, #34383e, #25282d);
  box-shadow: 0 2px 4px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .1), 0 0 0 1px rgba(0, 0, 0, .5);
  font: 600 10px/1 var(--m-font-mono);
  letter-spacing: .08em;
  color: var(--m-ink-3, #8a929a);
}
.pt-reset:hover:not(:disabled) { color: var(--m-ink-2, #c3c9cf); }
.pt-reset:disabled { opacity: .4; cursor: default; }
.pt-panel {
  margin-top: 12px;
  display: flex;
  align-items: stretch;
  justify-content: space-around;
  gap: 14px;
  padding: 12px 16px 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.pt-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.pt-knobs { display: flex; gap: 12px; }
.pt-rule {
  align-self: stretch;
  width: 1px;
  background: rgba(0, 0, 0, .35);
  box-shadow: 1px 0 0 rgba(255, 255, 255, .04);
}
</style>
