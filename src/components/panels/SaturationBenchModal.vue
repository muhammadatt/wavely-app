<script setup>
/**
 * Saturation Workbench (file and ids keep the old name): four layers of waveshaping in series, one strip each.
 *
 * Every strip is the same instrument — curve, drive, the band it works on and
 * the emphasis around the curve — so layers are built by stacking rather than by
 * switching modes. Drive reads in dB above a matched point: 0 dB is 1 % THD on
 * that band's measured level, for every curve, which is what makes an A/B
 * between curves a comparison of character. DELTA plays only what the layers add.
 *
 * Modula layout, narrow by design: a strip is one line — curve field, Drive,
 * Amount, the band as a Low / High knob pair with a range readout, and the pre-emphasis as a bypass
 * lamp plus a summary chip. The chip opens the emphasis editor under the strip:
 * the shape switch and a response plot whose node is Freq and Gain (scroll for
 * Q). It is shut by default because most sessions never touch it. Every layer is
 * FULL, so there is no mode switch, and the bypass mutes the pair without moving
 * its gain.
 */
import { computed, onMounted, ref } from 'vue'
import { useSaturationBench } from '../../composables/useSaturationBench.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { useEditorState } from '../../composables/useEditorState.js'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaChip from '../modula/ModulaChip.vue'
import ModulaSegmented from '../modula/ModulaSegmented.vue'
import ModulaReadout from '../modula/ModulaReadout.vue'
import SaturationEmphasisPlot from './SaturationEmphasisPlot.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import FloatingWindow from './FloatingWindow.vue'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import { SATURATION_BENCH_PRESET_PLUGIN } from '../../audio/pluginPresets/index.js'
import { SHAPER_CURVES } from '../../audio/dsp/shaperCurves.js'
import { SAT_BENCH_LAYER_PRESETS } from '../../audio/saturationBenchParams.js'
import {
  SAT_DRIVE_MIN_DB, SAT_DRIVE_MAX_DB, SAT_AMOUNT_MIN_DB, SAT_AMOUNT_MAX_DB,
  SAT_BAND_MIN_HZ, SAT_BAND_MAX_HZ, SAT_BAND_HIGH_MIN_HZ,
} from '../../audio/saturationBenchProcessor.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  sbLayers, sbInputDb, sbOutputDb, syncTrim, sbSolo, setSolo, sbPreview, sbDelta, sbInputLevels, sbOutputLevels,
  togglePreview, toggleDelta, applyParams, syncLayer, syncLayerFields, addLayer, removeLayer, resetLayers,
  apply, teardown, closeModal,
} = useSaturationBench()

const { state } = useEditorState()

// A preset is the whole stack and the trims; SOLO and everything measured stay out.
const presets = usePluginPresets(SATURATION_BENCH_PRESET_PLUGIN, {
  read: () => ({ layers: sbLayers.value, inputDb: sbInputDb.value, outputDb: sbOutputDb.value }),
  write: p => applyParams(p),
})

onMounted(() => {
  // The chain's copy keeps its ON/BYPASS: opening its editor from the chain
  // must not un-bypass its slot.
  if (!sbPreview.value && currentPluginCopy() === 'solo') togglePreview()
})

const ACCENT = '#e8a33d'
const METER_H = 470
const TRIM_MIN_DB = -24
const TRIM_MAX_DB = 24
const fmtTrim = v => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`

const sampleRate = () => state.currentFile?.sampleRate ?? 44100

/**
 * The rows are the layers that are IN USE: every tab is a layer that is on, and a
 * slot that is not in use is not shown (add one with the + tab). `k` stays the
 * layer's slot, which is what every edit addresses.
 */
const rows = computed(() => sbLayers.value.map((layer, k) => ({ layer, k })).filter(r => r.layer.on))
const canAdd = computed(() => sbLayers.value.some(l => !l.on))
const canRemove = computed(() => rows.value.length > 1)

/** The slot whose face is showing; falls back to the first layer when it is removed. */
const selK = ref(0)
const sel = computed(() => rows.value.find(r => r.k === selK.value) ?? rows.value[0] ?? null)
const selNum = computed(() => (sel.value ? rows.value.indexOf(sel.value) + 1 : 1))

/** While one layer is soloed, every other layer is out of the sound. */
const silenced = k => sbSolo.value !== null && sbSolo.value !== k

function onAdd() {
  // The new layer takes the first slot after the ones in use, and the face follows it.
  const k = rows.value.length
  addLayer()
  selK.value = k
}

function removeRow(k) {
  if (!canRemove.value) return
  removeLayer(k)
}

/** A slot's factory layer: where double-click on one of its controls goes back to. */
const factory = (k, field) => SAT_BENCH_LAYER_PRESETS[k]?.[field] ?? null
const emphDefaults = k => ({ hz: factory(k, 'emphHz'), q: factory(k, 'emphQ'), db: factory(k, 'emphDb') })

const CURVES = SHAPER_CURVES.filter(c => !c.hidden)

function curveLabel(id) {
  return CURVES.find(c => c.id === id)?.label ?? ''
}

function curveTitle(id) {
  return CURVES.find(c => c.id === id)?.title ?? ''
}

// Three KINDS of filter, not a progression — short names, full ones in the titles.
const EMPH_TYPE_OPTIONS = [
  { value: 'hishelf', label: 'HI', title: 'HI SHELF — everything above the corner goes into the curve harder (or softer, at negative gain)' },
  { value: 'bell', label: 'BELL', title: 'BELL — one region around the frequency, a formant or the sibilant band, goes into the curve harder or softer' },
  { value: 'loshelf', label: 'LO', title: 'LO SHELF — everything below the corner goes into the curve harder (or softer, at negative gain)' },
]

const signed = (v, d) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`
const fmtDrive = v => `${signed(v, 0)} dB`
const fmtAmount = v => `${signed(v, 1)} dB`
const fmtQ = v => v.toFixed(2)

function formatHz(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`
}
const fmtHz = v => `${formatHz(v)} Hz`

function quantizeHz(v) {
  const step = v >= 1000 ? 100 : v >= 100 ? 10 : 1
  return Math.round(v / step) * step
}

/**
 * The band knobs' travel law. A plain log axis from 1 Hz spends 46 % of the
 * turn below 100 Hz, where almost nothing is set. The bottom octaves still have
 * to be reachable on Low (the first step off "open" is a gentle 2 Hz corner, and
 * a 20 Hz one is not), so Low squeezes 1–20 Hz into the first 8 % and gives
 * 20 Hz–20 kHz the rest on a log axis: 100 Hz sits at 29 % of the turn. High
 * never goes below 20 Hz, so it is a plain log over 20 Hz–20 kHz.
 */
const KNEE_HZ = 20
const KNEE_PCT = 0.08
const lnr = (v, a, b) => Math.log(Math.max(a, Math.min(b, v)) / a) / Math.log(b / a)
const LOW_TAPER = {
  toPct: v => (v <= KNEE_HZ
    ? KNEE_PCT * lnr(v, SAT_BAND_MIN_HZ, KNEE_HZ)
    : KNEE_PCT + (1 - KNEE_PCT) * lnr(v, KNEE_HZ, SAT_BAND_MAX_HZ)),
  fromPct: p => (p <= KNEE_PCT
    ? SAT_BAND_MIN_HZ * Math.pow(KNEE_HZ / SAT_BAND_MIN_HZ, p / KNEE_PCT)
    : KNEE_HZ * Math.pow(SAT_BAND_MAX_HZ / KNEE_HZ, (p - KNEE_PCT) / (1 - KNEE_PCT))),
}
const HIGH_TAPER = {
  toPct: v => lnr(v, SAT_BAND_HIGH_MIN_HZ, SAT_BAND_MAX_HZ),
  fromPct: p => SAT_BAND_HIGH_MIN_HZ * Math.pow(SAT_BAND_MAX_HZ / SAT_BAND_HIGH_MIN_HZ, Math.max(0, Math.min(1, p))),
}

function bandCaption(l) {
  const lowOpen = l.loHz <= SAT_BAND_MIN_HZ
  const highOpen = l.hiHz >= SAT_BAND_MAX_HZ
  if (lowOpen && highOpen) return 'FULL BAND'
  if (highOpen) return `ABOVE ${formatHz(l.loHz)}`
  if (lowOpen) return `BELOW ${formatHz(l.hiHz)}`
  return `${formatHz(l.loHz)}–${formatHz(l.hiHz)}`
}

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
    window-id="saturation-bench"
    :z="z"
    :width="760"
    :min-width="680"
    :accent="ACCENT"
    design="modula"
    :presets="presets"
    :presets-disabled="!sbPreview"
    presets-disabled-hint="Turn Saturation Workbench on to use presets"
    brand-lead="SATURATION WORKBENCH"
    :engaged="sbPreview"
    show-delta
    :delta="sbDelta"
    :delta-disabled="!sbPreview"
    delta-title="Hear only what the layers add"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!sbPreview"
    apply-disabled-hint="Turn Saturation Workbench on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-delta="toggleDelta"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="sb-grid">
      <div class="sb-meter">
        <LevelMeter variant="modula" scale-side="left" :levels="sbInputLevels" label="IN" :height="METER_H">
          <template #below>
            <ModulaKnob
              variant="trim" :model-value="sbInputDb" show-value
              :min="TRIM_MIN_DB" :max="TRIM_MAX_DB" :step="0.1" :default-value="0" :format-value="fmtTrim"
              aria-label="Input" :disabled="!sbPreview"
              title="Input: a trim before the layers. It moves how hard every curve is driven, so it is a drive offset for the whole bench. Double-click to reset"
              @update:model-value="v => syncTrim('input', v)"
            />
          </template>
        </LevelMeter>
      </div>

      <div class="sb-layers">
        <!-- Layer tabs: each summarises its layer; the selected one owns the face below. -->
        <div class="sb-tabs" role="tablist" aria-label="Layers">
          <div
            v-for="(row, n) in rows" :key="row.k"
            class="sb-tab" :class="{ 'is-sel': row.k === sel?.k, 'is-muted': row.layer.muted, 'is-silenced': silenced(row.k) }"
            role="tab" :aria-selected="row.k === sel?.k" tabindex="0"
            :title="`Layer ${n + 1}: ${curveTitle(row.layer.curve)}`"
            @click="selK = row.k" @keydown.enter.prevent="selK = row.k" @keydown.space.prevent="selK = row.k"
          >
            <div class="sb-tab-text">
              <span class="sb-tab-name">LAYER {{ n + 1 }}</span>
              <span class="sb-tab-sum">{{ curveLabel(row.layer.curve) }} · {{ fmtDrive(row.layer.driveDb) }}</span>
            </div>
            <button
              type="button" class="sb-x m-focusable" :disabled="!sbPreview || !canRemove"
              :aria-label="`Remove layer ${n + 1}`"
              :title="canRemove ? `Remove layer ${n + 1}; the layers after it move up and its settings are kept for adding it back` : 'The last layer cannot be removed'"
              @click.stop="removeRow(row.k)"
            >
              <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
                <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              </svg>
            </button>
          </div>
          <button
            v-if="canAdd" type="button" class="sb-tab sb-tab-add m-focusable" :disabled="!sbPreview"
            title="Add a layer: the next one in the series, with the settings its slot last held"
            aria-label="Add layer" @click="onAdd"
          >+</button>
        </div>

        <div v-if="sel" class="sb-face" :class="{ 'is-muted': sel.layer.muted, 'is-silenced': silenced(sel.k) }">
          <div class="sb-face-head">
            <ModulaChip
              class="sb-on" :label="sel.layer.muted ? 'OFF' : 'ON'" lamp :color="ACCENT"
              :model-value="!sel.layer.muted" :disabled="!sbPreview"
              :aria-label="`Layer ${selNum} on / off`"
              title="Layer on / off: off keeps the layer in the stack with its settings but takes it out of the sound, in preview and in Apply"
              @update:model-value="v => syncLayer(sel.k, 'muted', !v)"
            />
            <ModulaChip
              class="sb-on" label="SOLO" lamp :color="ACCENT"
              :model-value="sbSolo === sel.k" :disabled="!sbPreview"
              :aria-label="`Solo layer ${selNum}`"
              title="Hear only this layer, on the unprocessed input. A listening aid: it never reaches Apply, and adding or removing a layer clears it"
              @update:model-value="setSolo(sel.k)"
            />
          </div>
          <div class="sb-zones">
            <section class="sb-zone sb-zone-char">
              <span class="m-caption">Character</span>
              <div class="sb-char">
                <div class="sb-curves" role="radiogroup" aria-label="Curve">
                  <button
                    v-for="c in CURVES" :key="c.id" type="button" role="radio"
                    class="sb-curve-opt m-focusable" :class="{ 'is-on': sel.layer.curve === c.id }"
                    :aria-checked="sel.layer.curve === c.id" :disabled="!sbPreview" :title="c.title"
                    @click="syncLayer(sel.k, 'curve', c.id)"
                  ><i class="sb-led"></i>{{ c.label }}</button>
                </div>
                <ModulaKnob
                  variant="led" :size="112" show-value editable
                  :model-value="sel.layer.driveDb" :min="SAT_DRIVE_MIN_DB" :max="SAT_DRIVE_MAX_DB" :step="0.5"
                  :default-value="factory(sel.k, 'driveDb')" label="Drive" :color="ACCENT" :format-value="fmtDrive"
                  :disabled="!sbPreview"
                  title="dB above the matched point: 0 dB puts every curve at 1 % distortion on this band's measured level, so switching curves compares character, not strength. A high band wants +12 to +20 dB to be heard. Double-click to reset"
                  @update:model-value="v => syncLayer(sel.k, 'driveDb', v)"
                />
                <ModulaKnob
                  variant="ring" :size="56" show-value editable bipolar
                  :model-value="sel.layer.amountDb" :min="SAT_AMOUNT_MIN_DB" :max="SAT_AMOUNT_MAX_DB" :step="0.5"
                  :default-value="factory(sel.k, 'amountDb')" label="Amount" :color="ACCENT" :format-value="fmtAmount"
                  :disabled="!sbPreview"
                  title="Level of what this layer adds — the clean signal is never touched. Drive sets how hard the curve bends; Amount sets how loud its result is. Use it when Drive has run out: the Quartic stops growing past about +15 dB of drive. Double-click to reset"
                  @update:model-value="v => syncLayer(sel.k, 'amountDb', v)"
                />
              </div>
            </section>

            <section class="sb-zone sb-zone-band">
              <span class="m-caption">Frequency Range</span>
              <div class="sb-band">
                <div class="sb-band-knobs">
                  <ModulaKnob
                    variant="plain" :size="40" show-value editable :quantize="quantizeHz" :taper="LOW_TAPER"
                    :model-value="sel.layer.loHz" :min="SAT_BAND_MIN_HZ" :max="SAT_BAND_MAX_HZ"
                    :default-value="factory(sel.k, 'loHz')" label="Low" :color="ACCENT" :format-value="fmtHz"
                    :disabled="!sbPreview"
                    title="Bottom of the band this layer saturates. Fully down (1 Hz) is open — no high-pass; the next step is a 2 Hz corner, so leaving open is gentle. The value is the real corner. Double-click to reset"
                    @update:model-value="v => syncLayer(sel.k, 'loHz', v)"
                  />
                  <ModulaKnob
                    variant="plain" :size="40" show-value editable :quantize="quantizeHz" :taper="HIGH_TAPER"
                    :model-value="sel.layer.hiHz" :min="SAT_BAND_HIGH_MIN_HZ" :max="SAT_BAND_MAX_HZ"
                    :default-value="factory(sel.k, 'hiHz')" label="High" :color="ACCENT" :format-value="fmtHz"
                    :disabled="!sbPreview"
                    title="Top of the band this layer saturates. Fully up is open — no low-pass. What the curve adds is band-passed again, so nothing it makes leaves the band. Double-click to reset"
                    @update:model-value="v => syncLayer(sel.k, 'hiHz', v)"
                  />
                </div>
                <ModulaReadout class="sb-range" :text="bandCaption(sel.layer)" size="sm" />
              </div>
            </section>
          </div>

          <section class="sb-zone sb-zone-pre">
            <div class="sb-pre-head">
              <span class="m-caption">Pre-Emphasis</span>
              <ModulaChip
                class="sb-on" :label="sel.layer.emphOn !== false ? 'ON' : 'OFF'" lamp :color="ACCENT"
                :model-value="sel.layer.emphOn !== false" :disabled="!sbPreview"
                :aria-label="`Layer ${selNum} pre-emphasis`"
                title="Bypass the pre-emphasis: off sends the signal into the curve flat and skips the matching de-emphasis, without changing its frequency, Q or gain"
                @update:model-value="v => syncLayer(sel.k, 'emphOn', v)"
              />
              <ModulaSegmented
                :model-value="sel.layer.emphType" :options="EMPH_TYPE_OPTIONS"
                :aria-label="`Layer ${selNum} emphasis shape`" :disabled="!sbPreview"
                @update:model-value="v => syncLayer(sel.k, 'emphType', v)"
              />
            </div>
            <div class="sb-emph">
              <SaturationEmphasisPlot
                :type="sel.layer.emphType" :hz="sel.layer.emphHz" :q="sel.layer.emphQ" :db="sel.layer.emphDb"
                :on="sel.layer.emphOn !== false" :sample-rate="sampleRate()" :color="ACCENT" :width="300"
                :defaults="emphDefaults(sel.k)" :disabled="!sbPreview"
                @change="fields => syncLayerFields(sel.k, fields)"
              />
              <div class="sb-emph-read">
                <div><span class="m-caption">Freq</span><b>{{ fmtHz(sel.layer.emphHz) }}</b></div>
                <div><span class="m-caption">Gain</span><b>{{ signed(sel.layer.emphDb, 1) }} dB</b></div>
                <div><span class="m-caption">Q</span><b>{{ fmtQ(sel.layer.emphQ) }}</b></div>
                <p class="m-note sb-emph-hint" title="Drag the node: across is Freq, up and down is Gain. Scroll over it for Q. Double-click to reset all three.">Drag: Freq / Gain<br>Scroll: Q</p>
              </div>
            </div>
          </section>
        </div>

        <div class="sb-foot">
          <span class="m-note">LAYERS RUN LEFT TO RIGHT</span>
          <button
            type="button" class="sb-text-btn m-focusable" :disabled="!sbPreview"
            title="Back to the two factory layers: Warmth (Quartic, +20.4 dB shelf, full band) and Exciter (Tanh, −20.4 dB shelf, 3 kHz up)"
            @click="resetLayers"
          >Reset layers</button>
        </div>
      </div>

      <div class="sb-meter">
        <LevelMeter variant="modula" scale-side="right" :levels="sbOutputLevels" label="OUT" :height="METER_H">
          <template #below>
            <ModulaKnob
              variant="trim" :model-value="sbOutputDb" show-value
              :min="TRIM_MIN_DB" :max="TRIM_MAX_DB" :step="0.1" :default-value="0" :format-value="fmtTrim"
              aria-label="Output" :disabled="!sbPreview"
              title="Output: a trim after the layers. Double-click to reset"
              @update:model-value="v => syncTrim('output', v)"
            />
          </template>
        </LevelMeter>
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.sb-grid {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: start;
}
.sb-meter { display: flex; justify-content: center; padding: 12px 4px; }
.sb-layers { display: flex; flex-direction: column; min-width: 0; }

/* Tabs: a row of layer summaries sitting on the face. */
.sb-tabs { display: flex; align-items: flex-end; gap: 4px; padding: 0 6px; }
.sb-tab {
  position: relative;
  flex: 1;
  min-width: 0;
  max-width: 150px;
  height: 36px;
  display: flex;
  align-items: center;
  padding: 0 24px 0 11px;
  border-radius: 10px 10px 0 0;
  cursor: pointer;
  background: transparent;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .08);
  opacity: .75;
  transition: opacity .15s ease;
}
.sb-tab:hover { opacity: 1; }
.sb-tab.is-muted .sb-tab-text, .sb-tab.is-silenced .sb-tab-text { opacity: .45; }
.sb-tab.is-silenced, .sb-tab.is-sel.is-silenced { opacity: .5; }
.sb-tab.is-sel {
  height: 42px;
  opacity: 1;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .08), 0 0 0 1px rgba(0, 0, 0, .45);
}
.sb-tab-text { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.sb-tab-name { font: 700 10px/1 var(--m-font-ui); letter-spacing: .12em; color: var(--m-ink-2); }
.sb-tab.is-sel .sb-tab-name { color: var(--m-ink); }
.sb-tab-sum {
  font: 500 9px/1 var(--m-font-mono);
  color: var(--m-ink-4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sb-tab-add {
  flex: none;
  width: 34px;
  max-width: none;
  padding: 0;
  border: none;
  display: grid;
  place-items: center;
  font: 600 16px/1 var(--m-font-ui);
  color: var(--m-accent);
}
.sb-tab-add:disabled { opacity: .35; cursor: default; }
.sb-x {
  position: absolute;
  top: 5px;
  right: 5px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  background: transparent;
  color: var(--m-ink-off);
  transition: color .15s ease, background-color .15s ease;
}
.sb-x:hover:not(:disabled) { color: var(--m-ink); background: rgba(255, 255, 255, .08); }
.sb-x:disabled { opacity: .3; cursor: default; }

/* The face: three labelled zones, sized to the window rather than to the layer. */
.sb-face {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.sb-face-head { display: flex; align-items: center; gap: 10px; }
.sb-face.is-muted .sb-zones, .sb-face.is-muted .sb-zone-pre,
.sb-face.is-silenced .sb-zones, .sb-face.is-silenced .sb-zone-pre { opacity: .45; }
.sb-zones { display: flex; gap: 12px; }
.sb-zone {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(0, 0, 0, .12);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, .35);
}
.sb-zone-char { flex: 1.5; min-width: 0; }
.sb-zone-band { flex: 1; min-width: 0; }
.sb-char { flex: 1; display: flex; align-items: center; justify-content: space-around; gap: 10px; }
.sb-curves { display: flex; flex-direction: column; gap: 7px; }
.sb-curve-opt {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  font: 700 9.5px/1 var(--m-font-mono);
  letter-spacing: .04em;
  color: var(--m-ink-off);
}
.sb-curve-opt:hover:not(:disabled) { color: var(--m-ink-2); }
.sb-curve-opt.is-on { color: var(--m-ink); }
.sb-curve-opt:disabled { cursor: default; opacity: .5; }
.sb-led { width: 6px; height: 6px; border-radius: 50%; background: #3a3d43; box-shadow: inset 0 1px 1px rgba(0, 0, 0, .7); }
.sb-curve-opt.is-on .sb-led { background: var(--m-accent); box-shadow: 0 0 6px var(--m-accent); }
.sb-band { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
.sb-band-knobs { display: flex; gap: 12px; }
/* A fixed cell per knob, so a longer readout ("20k Hz" against "1 Hz") never moves it. */
.sb-band-knobs > * { flex: none; width: 76px; }
.sb-range { min-width: 96px; }
.sb-pre-head { display: flex; align-items: center; gap: 12px; }
.sb-pre-head > .m-caption { margin-right: auto; }
/* The chip rings itself in the accent colour, inline, when on. Keep the raised
   button look it has when off and drop only the orange: !important is the only
   thing that outranks an inline style. */
.sb-on { box-shadow: inset 0 1px 0 rgba(255, 255, 255, .07), 0 0 0 1px rgba(0, 0, 0, .6), 0 4px 8px -4px rgba(0, 0, 0, .9) !important; }
.sb-emph { display: flex; align-items: center; gap: 16px; }
.sb-emph > .ep { flex: 1; }
.sb-emph-read { display: flex; flex-direction: column; gap: 6px; width: 104px; flex: none; }
.sb-emph-read > div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.sb-emph-read b { font: 600 11px/1 var(--m-font-mono); color: var(--m-ink-2); }
.sb-emph-hint { margin: 0; line-height: 1.6; color: var(--m-ink-4); }
/* The Plugin Chain's text button (its "+ Add plugin" and "Clear"): a 26 px raised
   outline, small caps in the mono face. */
.sb-text-btn {
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--m-ink-2);
  box-shadow: var(--m-shadow-raised);
  cursor: pointer;
  font: 700 9.5px/1 var(--m-font-mono);
  letter-spacing: .12em;
  text-transform: uppercase;
  white-space: nowrap;
}
.sb-text-btn:hover:not(:disabled) { filter: brightness(1.15); color: var(--m-ink); }
.sb-text-btn:disabled { opacity: .35; cursor: default; }
.sb-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 4px 0;
}
</style>
