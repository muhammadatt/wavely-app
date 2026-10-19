<script setup>
/**
 * HF Softener — Modula, laid out after the SSL DeEss.
 *
 * The chain runs Duck → EQ → Air → [Reso] → Soften. Duck turns the whole "s"
 * down with its shape intact; EQ cuts the top of what the duck left (its
 * detector hears the ducked signal); Shape picks that cut; Air puts back a few
 * dB of top after it, on Air Boost's curve, on the vowels only (Air Mode is
 * PINNED to VOICED and off the panel); Soften turns the band above 500 Hz down
 * for a few ms on sudden onsets, out of the chain at 0. Reso is off the panel
 * at 0. Context, Rotator, Release and vowel release are pinned (see
 * useDeEsser.js).
 *
 * TOP: the frequency strip — the input's spectrum, the cut's RANGE (static:
 * the most the EQ may take, then the Air lift), and the two corners as
 * handles: CUT (Band, where the EQ cuts) hung from the top and
 * LISTEN (Detect, where the detector listens) standing on the bottom. Two
 * handles, not linked — see DeEsserBandStrip.
 * MIDDLE: the controls in four groups — DE-ESS (Duck, EQ, Shape), PROTECT
 * (Guard), AIR (HF Restore, AUTO) and SOFTEN (Transient Softener, Plosives).
 * BOTTOM: the reduction split into Duck · EQ · Soften, over the activity scope
 * (the waveform, shaded full height wherever it de-essed). That is where
 * "when" lives; the strip only says "where and how far".
 * DELTA sits in the header and never reaches the apply path.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useDeEsser } from '../../composables/useDeEsser.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  AIR_MAKEUP_MAX_DB,
  DETECT_HZ_MIN, DETECT_HZ_MAX, DETECT_HI_MIN, DETECT_HI_MAX, DETECT_MIN_RATIO,
} from '../../audio/deEsserProcessor.js'
import { guardToFloorDb, amountSplitOf, HF_SOFTENER_DEFAULTS } from '../../audio/deEsserParams.js'
import { softenLaw, SOFTEN_MAX } from '../../audio/deEsserSoftenStage.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaFillSlider from '../modula/ModulaFillSlider.vue'
import ModulaLedPill from '../modula/ModulaLedPill.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import { createPeakHold, useMeterFrame } from '../meters/ballistics.js'
import DeEsserScope from '../meters/DeEsserScope.vue'
import DeEsserBandStrip from './DeEsserBandStrip.vue'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import { HF_SOFTENER_PRESET_PLUGIN } from '../../audio/pluginPresets/deEsser.js'
import { HF_SCOPE_SECONDS } from '../../audio/deEsserScope.js'
import { readTimelineEnvelope } from '../../audio/timelineEnvelope.js'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  hfAmount, hfSplit, hfTotal, hfGuard, hfPlosives, hfBand, hfResoAmount, hfSoften, hfSoftenCut, hfAir, hfAirLossDb, hfComp, hfDetect, hfDetectHigh, hfAudition, hfDuck, hfBroadband, hfDelta, hfPreview,
  hfLevelOffset, refreshLevel,
  hfReduction, hfOutputLevels,
  togglePreview, syncSoften, syncAir, syncComp, syncDetect, syncDetectHigh, scheduleAutoAir, syncTotal, syncSplit, syncGuard, syncPlosives, applyParams, toggleDelta, toggleAudition,
  hfReso, hfBurstLamp, hfAirLamp, getScope, holdScope, clearScope, getInputSpectrum,
  apply, teardown, closeModal,
} = useDeEsser()

const { state, appState } = useEditorState()

const presets = usePluginPresets(HF_SOFTENER_PRESET_PLUGIN, {
  read: () => ({
    duck: hfDuck.value, amount: hfAmount.value, guard: hfGuard.value,
    plosives: hfPlosives.value, band: hfBand.value, detect: hfDetect.value, detectHigh: hfDetectHigh.value,
    // Under AUTO the knob holds a MEASUREMENT of this selection, which is the
    // file's, not the patch's: store the default, so a preset never carries it
    // and AUTO never makes one read as modified. applyParams ignores it anyway.
    air: hfComp.value ? D.air : hfAir.value,
    comp: hfComp.value, soften: hfSoften.value,
  }),
  write: p => applyParams(p),
})
const D = HF_SOFTENER_DEFAULTS

// An edit or a document switch changes the file's level, and with it where
// every threshold sits. Measured only while the window is open.
// Auto Air measures over the selection, so a new selection is a new answer.
watch(() => state.selection, () => {
  if (hfPreview.value) scheduleAutoAir()
}, { deep: true })

watch(() => [state.revision, appState.activeDocumentId], () => {
  if (hfPreview.value) refreshLevel()
})

onMounted(() => {
  if (!hfPreview.value) togglePreview()
})

// The scope freezes on what last played while the transport is stopped, and
// starts over if playback resumes somewhere else (a seek, a click on the
// timeline): its history would describe audio that is no longer behind the
// playhead.
let stoppedAt = null
watch(() => [state.isPlaying, hfPreview.value], ([playing]) => {
  if (playing) {
    if (stoppedAt !== null && Math.abs(state.playhead - stoppedAt) > 0.25) clearScope()
    stoppedAt = null
    holdScope(false)
  } else {
    stoppedAt = state.playhead
    holdScope(true)
  }
}, { immediate: true })

// The kit's amber. The plosive treatment keeps its own colour on the scope and
// its lamp, and LISTEN takes the kit's second hue (a "where", not an amount).
const ACCENT = '#e8a33d'
const PLOSIVE_COLOR = '#b9a6f2'
const LISTEN_COLOR = '#3fd0de'
const METER_H = 150
const AIR_LAMP_COLOR = '#9fd3c7'

/** A lamp: dark at 0, lit and glowing at 1. */
function lampStyle(level, colour) {
  const on = Math.min(1, Math.max(0, level))
  return {
    background: on > 0.05 ? colour : 'rgba(255,255,255,.16)',
    opacity: on > 0.05 ? 0.45 + 0.55 * on : 1,
    boxShadow: on > 0.05 ? `0 0 ${Math.round(3 + 5 * on)}px ${colour}` : 'none',
  }
}

/**
 * The timeline's peak envelope around the playhead, for the scope's lookahead
 * (and its history when the effect is bypassed). One scratch per side: both
 * are read in the same frame. See ClipperScope / SoftClipperModal.
 */
const envelopeScratch = { ahead: null, behind: null }
function envelope(offsetSeconds, seconds, columns) {
  if (!state.segments?.length) return null
  const side = offsetSeconds < 0 ? 'behind' : 'ahead'
  if (envelopeScratch[side]?.length !== columns) envelopeScratch[side] = new Float32Array(columns)
  return readTimelineEnvelope(state.segments, state.playhead + offsetSeconds, seconds, columns, envelopeScratch[side])
}





// The Amount and its Split are a view over the two stages (useDeEsser): what
// each stage actually got, as a note under the knob.
const stageNote = computed(() => `WIDE ${Math.round(hfDuck.value)} · SPLIT ${Math.round(hfAmount.value)}`)
const formatSplit = v => (v <= 0 ? 'ALL WIDE' : v >= 100 ? 'ALL SPLIT' : `${100 - Math.round(v)} / ${Math.round(v)}`)
const AMOUNT_DEFAULT = amountSplitOf(D.duck, D.amount).total
const SPLIT_DEFAULT = amountSplitOf(D.duck, D.amount).split




// ── Detector strip ──────────────────────────────────────────────────────────
// The strip's axis starts at 500 Hz, not 100: the two handles live between
// 3 and 8 kHz, and the octaves below the voice's top end are what the space
// is spent on otherwise.
const CURVE_W = 400
// The well fills the row: the OUT meter sets the row's height (211 px with its
// readout and caption), less the strip's 14 px axis.
const CURVE_H = 197
const F_MIN = 500
const F_MAX = 20000
const GRID_FREQS = [1000, 2000, 3000, 4000, 6000, 8000, 12000, 16000]

const totalReduction = computed(() => hfReduction.value + hfBroadband.value + (hfResoAmount.value > 0 ? hfReso.value : 0) + (hfSoften.value > 0 ? hfSoftenCut.value : 0))

/**
 * THE READOUT IS HELD, NOT LIVE. Read raw, each figure changed every frame —
 * an "s" is 30–40 ms, so a number was on screen for one or two frames before
 * the next one replaced it. Each figure now holds its peak for a second and
 * then falls at 6 dB/s, and the text refreshes at most 5 times a second, so
 * what is printed is "the most it took just now" and stays long enough to read.
 */
const READOUT_HOLD = { holdMs: 1000, fallPerSec: 6 }
const READOUT_EVERY_MS = 200
const readoutHolds = { total: createPeakHold(READOUT_HOLD), duck: createPeakHold(READOUT_HOLD), eq: createPeakHold(READOUT_HOLD), soft: createPeakHold(READOUT_HOLD) }
const shown = ref({ total: 0, duck: 0, eq: 0, soft: 0 })
// The de-ess lamp: lit by either stage's cut, held a moment so a 30 ms "s" is seen
// (the cut itself reads once or twice a frame). Full at 3 dB.
const deessHold = createPeakHold({ holdMs: 120, fallPerSec: 20 })
const deessLamp = ref(0)
let sinceReadout = 0
useMeterFrame((dt) => {
  deessLamp.value = Math.round(Math.min(1, deessHold.push(Math.max(hfBroadband.value, hfReduction.value), dt) / 3) * 20) / 20
  const h = readoutHolds
  const next = {
    total: h.total.push(totalReduction.value, dt),
    duck: h.duck.push(hfBroadband.value, dt),
    eq: h.eq.push(hfReduction.value, dt),
    soft: h.soft.push(hfSoftenCut.value, dt),
  }
  sinceReadout += dt
  if (sinceReadout >= READOUT_EVERY_MS) {
    sinceReadout = 0
    shown.value = next
  }
})
const formatSoften = v => (v <= 0 ? 'OFF' : v.toFixed(1))
// AUTO: the knob is the measurement, so say what it measured; manual says so.
const airCaption = computed(() => (hfComp.value
  ? (hfAirLossDb.value == null ? 'auto' : `auto · ${hfAirLossDb.value.toFixed(1)} dB`)
  : 'manual'))
// What the Soften knob currently allows on one attack.
const softenCaption = computed(() => {
  const d = softenLaw(hfSoften.value).depthDb
  return d > 0 ? `onsets · up to −${Math.round(d)} dB` : 'off'
})


function fmtCut(v) {
  return v >= 0.05 ? `−${v.toFixed(1)} dB` : '0.0 dB'
}


function formatAir(v) {
  return v > 0 ? `+${Number(v).toFixed(1)} dB` : 'OFF'
}

function formatPct(v) {
  return `${Math.round(v)}%`
}

function formatGuard(v) {
  return v > 0 ? `${Math.round(v)}%` : 'OFF'
}

const guardLabel = computed(() =>
  hfGuard.value > 0 ? `floor ${guardToFloorDb(hfGuard.value).toFixed(0)} dB` : 'no guard',
)

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
    window-id="hf-softener"
    :z="z"
    :width="820"
    :accent="ACCENT"
    design="modula"
    brand-lead="DE-ESSER"
    :presets="presets"
    :presets-disabled="!hfPreview"
    presets-disabled-hint="Turn De-Esser on to use presets"
    :engaged="hfPreview"
    show-delta
    :delta="hfDelta"
    :delta-disabled="!hfPreview"
    delta-title="Hear only what is being removed — it should sound like sibilance and nothing else. Monitoring only; Apply always renders the processed audio."
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!hfPreview"
    apply-disabled-hint="Turn De-Esser on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-delta="toggleDelta"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <!-- ── Frequency strip, beside the output meter ──────────────────────── -->
    <div class="hs-top">
      <DeEsserBandStrip
        :detect="hfDetect" :detect-high="hfDetectHigh"
        :detect-min="DETECT_HZ_MIN" :detect-max="DETECT_HZ_MAX"
        :high-min="DETECT_HI_MIN" :high-max="DETECT_HI_MAX" :min-ratio="DETECT_MIN_RATIO"
        :detect-default="D.detect" :high-default="D.detectHigh"
        :min-hz="F_MIN" :max-hz="F_MAX" :height="CURVE_H" :view-w="CURVE_W"
        :grid-freqs="GRID_FREQS" :tap-fn="getInputSpectrum"
        :listen-color="LISTEN_COLOR" :disabled="!hfPreview"
        :audition="hfAudition"
        @update:detect="syncDetect" @update:detect-high="syncDetectHigh" @update:audition="toggleAudition"
      />
      <div class="hs-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="hfOutputLevels" label="OUT" :height="METER_H" />
      </div>
    </div>

    <!-- ── The controls, grouped by what they do ─────────────────────────── -->
    <div class="hs-panel">
      <!-- DE-ESS: one Amount, split between the two cutting stages. -->
      <div class="hs-group">
        <span class="m-caption hs-caption">
          De-ess
          <span
            class="hs-lamp" :style="lampStyle(deessLamp, ACCENT)"
            title="Lit while the de-esser is cutting: the wide band Duck or the split band EQ is taking something off"
          ></span>
        </span>
        <div class="hs-knob">
          <ModulaKnob
            variant="arc" :size="100" editable
            :model-value="hfTotal" :min="0" :max="100" :step="1" :default-value="AMOUNT_DEFAULT"
            label="Amount" :color="ACCENT" :format-value="formatPct" :disabled="!hfPreview"
            title="How much de-essing, shared between the two stages by the Split below: the wide band Duck (turns the whole S down, keeping its shape and tone) and the split band EQ (a dynamic cut of the top end, on whatever the Duck left hot). Double-click to reset"
            @update:model-value="syncTotal"
          />
        </div>
        <ModulaFillSlider
          orientation="horizontal" :length="200"
          :model-value="hfSplit" :min="0" :max="100" :step="1" :default-value="SPLIT_DEFAULT"
          label="" :ends="['WIDE BAND', 'SPLIT BAND']" flat :format-value="formatSplit"
          color="var(--m-accent)" :disabled="!hfPreview"
          aria-label="Split between wide band and split band"
          title="Where the Amount goes. Left: all to the wide band Duck, which turns the whole S down and keeps its tone. Right: all to the split band EQ, which cuts only the top end. Double-click to reset"
          @update:model-value="syncSplit"
        />
      </div>

      <span class="hs-rule" aria-hidden="true"></span>

      <!-- AIR: what goes back on top after the cut — on the vowels only. -->
      <div class="hs-group">
        <span class="m-caption hs-caption hs-caption-blank" aria-hidden="true">&nbsp;</span>
        <div class="hs-knob">
          <ModulaKnob
            variant="arc" :size="80" show-value editable
            :model-value="hfAir" :min="0" :max="AIR_MAKEUP_MAX_DB" :step="0.1" :default-value="D.air"
            label="HF Restore" :color="ACCENT" :format-value="formatAir" :disabled="!hfPreview"
            title="Add top after the cut, on Air Boost's curve, on the vowels only. While AUTO is lit this is the measured amount; turn it to take over (AUTO drops and the value stays). Double-click to reset"
            @update:model-value="syncAir"
          />
        </div>
        <button
          type="button" class="hs-auto" :class="{ 'is-on': hfComp }" :disabled="!hfPreview"
          role="switch" :aria-checked="hfComp" :style="{ '--hs-auto': ACCENT }"
          title="Set HF Restore automatically: half of the top end the cut is measured to take off the selection is put back on the vowels, and it follows the other controls. Turn the knob to take over; AUTO drops and keeps the value"
          @click="syncComp(!hfComp)"
        ><span class="hs-auto-dot"></span>AUTO</button>
      </div>

      <span class="hs-rule" aria-hidden="true"></span>

      <!-- PROTECT: what the cut is not allowed to do. -->
      <div class="hs-group">
        <span class="m-caption hs-caption hs-caption-blank" aria-hidden="true">&nbsp;</span>
        <div class="hs-knob">
          <ModulaKnob
            variant="arc" :size="80" show-value editable
            :model-value="hfGuard" :min="0" :max="100" :step="1" :default-value="D.guard"
            label="Lisp Guard" :color="ACCENT" :format-value="formatGuard" :disabled="!hfPreview"
            title="Lisp guard strength. No cut may take an S further below the voice than this floor, so it never ends up quieter than a normal S sits. Higher is stricter; 0 turns it off. Double-click to reset"
            @update:model-value="syncGuard"
          />
        </div>
      </div>

      <span class="hs-rule" aria-hidden="true"></span>

      <!-- SOFTEN: onsets, not sibilance — last in the chain — with the T/K/P burst treatment. -->
      <div class="hs-group" style="display:none">
        <span class="m-caption"></span>
        <div class="hs-knob">
          <ModulaKnob
            variant="small" :size="40" show-value editable
            :model-value="hfSoften" :min="0" :max="SOFTEN_MAX" :step="0.1" :default-value="D.soften"
            label="Soften Transients" :color="ACCENT" :format-value="formatSoften" :disabled="!hfPreview"
            title="Softens sudden attacks: when the band above 500 Hz rises suddenly — a click, a lip smack, a hard T or K — it is turned down for a few milliseconds. It reacts to how suddenly the voice rises, not how loud it is. 0 is off. Double-click to reset"
            @update:model-value="syncSoften"
          />
          <span class="m-note">{{ softenCaption }}</span>
        </div>
        <span class="hs-lampwrap">
          <span class="m-note">Soften Plosives</span>
          <ModulaLedPill
            size="sm" label="ON" :color="ACCENT"
            :model-value="hfPlosives" :disabled="!hfPreview"
            title="Catch T, K and P releases — a burst straight out of a stop's silence — and cut them harder, with the lisp guard lifted"
            @update:model-value="syncPlosives"
          />
          <span
            class="hs-lamp" :style="lampStyle(hfBurstLamp, PLOSIVE_COLOR)"
            title="Lit while a plosive burst is being treated"
          ></span>
        </span>
      </div>
    </div>

    <!-- ── What it took, and where ───────────────────────────────────────── -->
    <div class="hs-readout">
      <span class="hs-total">
        <span class="m-caption">Reduction</span>
        <span class="hs-total-num">{{ fmtCut(shown.total) }}</span>
      </span>
      <span class="hs-split">
        <span>DUCK {{ fmtCut(shown.duck) }}</span>
        <span>EQ {{ fmtCut(shown.eq) }}</span>
        <span title="Soften's deepest recent onset cut — a few milliseconds at a time, on top of the reduction. Held for a second so it can be read">SOFT <template v-if="hfSoften > 0">{{ fmtCut(shown.soft) }}</template><span v-else class="hs-off">OFF</span></span>
      </span>
    </div>
    <div class="hs-scope">
      <DeEsserScope
        :data-fn="getScope"
        :envelope-fn="envelope"
        :window-seconds="HF_SCOPE_SECONDS * 2"
        :accent="ACCENT"
        :plosive-color="PLOSIVE_COLOR"
        :held="!state.isPlaying"
        :height="124"
        title="De-Esser activity: the waveform, shaded wherever it de-essed — playhead at the centre, played audio to its left, audio about to play to its right"
        @request-play="togglePlayback"
      />
    </div>
  </FloatingWindow>
</template>

<style scoped>
.hs-top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}
.hs-meter {
  display: flex;
  justify-content: center;
  padding: 0 4px;
}
.hs-panel {
  margin-top: 12px;
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 18px 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.hs-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.hs-caption { display: flex; align-items: center; gap: 6px; }
.hs-knobs { display: flex; gap: 16px; }
.hs-knob {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
}
.hs-rule {
  align-self: stretch;
  width: 1px;
  background: rgba(0, 0, 0, .35);
  box-shadow: 1px 0 0 rgba(255, 255, 255, .04);
}
.hs-auto {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 9px; border: 0; border-radius: 6px; cursor: pointer;
  background: linear-gradient(180deg, #34383e, #25282d);
  box-shadow: 0 2px 4px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .1), 0 0 0 1px rgba(0, 0, 0, .5);
  font: 600 10px/1 var(--m-font-mono); letter-spacing: .08em; color: var(--m-ink-3, #8a929a);
  transition: color .12s ease, background .12s ease;
}
.hs-auto:hover:not(:disabled) { color: var(--m-ink-2, #c3c9cf); background: linear-gradient(180deg, #3b4047, #2a2e33); }
.hs-auto:active:not(:disabled) { box-shadow: inset 0 1px 3px rgba(0, 0, 0, .7), 0 0 0 1px rgba(0, 0, 0, .5); }
.hs-auto:disabled { opacity: .4; cursor: default; }
.hs-auto-dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(0, 0, 0, .5); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .18); }
.hs-auto.is-on { color: var(--hs-auto); box-shadow: inset 0 1px 3px rgba(0, 0, 0, .6), 0 0 0 1px color-mix(in oklab, var(--hs-auto) 45%, #000); }
.hs-auto.is-on .hs-auto-dot { background: var(--hs-auto); box-shadow: 0 0 6px var(--hs-auto); }
.hs-lampwrap { display: flex; align-items: center; gap: 7px; }
.hs-lamp {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}
.hs-readout {
  margin: 14px 2px 8px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.hs-total { display: flex; align-items: baseline; gap: 12px; }
.hs-total-num {
  min-width: 92px;
  font: 700 19px/1 var(--m-font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--m-accent);
}
.hs-split {
  display: flex;
  gap: 18px;
  font: 600 10px/1 var(--m-font-mono);
  letter-spacing: .08em;
  font-variant-numeric: tabular-nums;
  color: var(--m-ink-3);
}
.hs-off { color: var(--m-ink-4); }
.hs-scope {
  padding: 3px;
  border-radius: 9px;
  background: #0b0e13;
  box-shadow: var(--m-shadow-well), 0 0 0 1px #1c222c;
}
</style>
