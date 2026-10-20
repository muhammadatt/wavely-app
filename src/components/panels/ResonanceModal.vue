<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useResonance } from '../../composables/useResonance.js'
import { currentPluginCopy } from '../../composables/pluginCopies.js'
import { RESONANCE_FOCUS_RANGES, focusThresholdFn } from '../../audio/resonanceFocus.js'
import {
  RESONANCE_DEFAULTS,
  DEFAULT_REF_MODE,
  zoneSettings,
  effectivePitchRange,
  RESONANCE_ATTACK_MIN_MS,
  RESONANCE_RELEASE_MIN_MS,
} from '../../audio/resonanceParams.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { bright, tint } from '../../ui/accent.js'
import {
  loadOverlays,
  saveOverlays,
  toggleOverlay as flipOverlay,
} from '../../ui/resonanceOverlays.js'
import { HISTORY_SECONDS } from '../meters/resonanceHistory.js'
import {
  focusRanks,
  patchNode,
  removeNode,
  setNodeParam,
} from '../meters/resonanceFocusNodes.js'
import FocusNodePanel from './FocusNodePanel.vue'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaChip from '../modula/ModulaChip.vue'
import ResonanceSpectrum from '../meters/ResonanceSpectrum.vue'
import ResonanceZoneControls from './ResonanceZoneControls.vue'
import ResonanceZoneCount from './ResonanceZoneCount.vue'
import ResonanceFocusControls from './ResonanceFocusControls.vue'
import FloatingWindow from './FloatingWindow.vue'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import { RESO_TAME_PRESET_PLUGIN, RESO_TAME_STOCK_ZONES } from '../../audio/pluginPresets/index.js'

defineProps({ z: { type: Number, default: 500 } })

const {
  resAttack, resRelease,
  resMix, resTrim, resZones, resSelectedZone, resDeltaZone, resRefMode,
  resPreview, resDelta, resReduction,
  resDisplayFn, hasSelection,
  resVoiceProfile, resPlacementBusy, fitZonesToVoice,
  resTargeting, resFocus, resSelectedNode, resSoloNode, syncFocus, toggleFocusSolo,
  togglePreview, toggleDelta, syncAttack,
  syncRelease, syncMix, syncTrim, syncZones, toggleZoneDelta, clearZoneDelta,
  resMode, syncMode,
  apply, teardown, closeModal,
} = useResonance()

/**
 * Running the focus targeting model — see src/audio/resonanceTargeting.js.
 *
 * A const rather than a computed: the model is resolved once at module load, so
 * a reactive read here would only ever produce the same answer at more cost,
 * and would imply the panel can switch between them at runtime. It cannot, on
 * purpose — which is also what lets the preset collection be chosen per model.
 */
const focusMode = resTargeting === 'focus'

/**
 * Presets.
 *
 * ⚠ THE PANEL RUNS ONE TARGETING MODEL AND SO DOES A PRESET. The kernel
 * dispatches on `focus`: a non-null patch TAKES OVER from the zone set. So
 * pushing both halves would mean a zone preset silently switching a
 * focus-model session, or a focus preset arriving in a session whose controls
 * are showing zones. `read` and `write` therefore touch only the live model's
 * half, and the preset MODULE registers only that model's table — the two
 * agree because both ask `resolveTargeting()`, once, at module load.
 *
 * The inert half still travels in the params, because a preset states every
 * one of its plugin's keys rather than inheriting a default that may move. It
 * is simply not pushed.
 *
 * What a preset must never carry, and why this write clears it rather than
 * setting it: the monitoring modes. DELTA, the per-zone delta and the focus
 * SOLO are UI state. Two of the three are expressible as ordinary parameters —
 * a zone delta is every other zone at depth zero, and `focus.solo` is a plain
 * field on the patch — so nothing about either would LOOK wrong if it leaked
 * into what Apply renders. `applyResonanceRegion` spreads its param object
 * straight into the kernel, so that leak is a one-node pass written to the
 * timeline. The store's whitelist keeps them out of the preset; clearing them
 * here keeps a stale isolation from surviving a patch that no longer has the
 * zone or node it was pointing at.
 */
const presets = usePluginPresets(RESO_TAME_PRESET_PLUGIN, {
  read: () => ({
    attack: resAttack.value,
    release: resRelease.value,
    mode: resMode.value,
    mix: resMix.value,
    trim: resTrim.value,
    // The half the panel is not running is reported as the preset's own inert
    // value, so a preset matches itself rather than reading as MODIFIED
    // against a zone set nobody can see or edit in this session.
    zones: focusMode ? RESO_TAME_STOCK_ZONES : resZones.value,
    focus: focusMode ? resFocus.value : null,
  }),
  write: (p) => {
    if (focusMode) {
      if (resSoloNode.value >= 0) toggleFocusSolo(resSoloNode.value)
      // Never null in this collection: the focus model's `normalize` repairs a
      // null patch to the stock global, because null is the instruction to read
      // the zone set — i.e. to switch models — rather than a missing value.
      syncFocus(p.focus)
      // The node strip edits one node by index, and a preset can carry fewer
      // nodes than the patch it replaces — leaving the selection past the end
      // would point the controls at nothing.
      if (resSelectedNode.value >= (p.focus?.nodes?.length ?? 0)) resSelectedNode.value = -1
    } else {
      clearZoneDelta()
      syncZones(p.zones)
      if (resSelectedZone.value >= p.zones.length) resSelectedZone.value = 0
    }
    syncAttack(p.attack)
    syncRelease(p.release)
    syncMode(p.mode)
    syncMix(p.mix)
    syncTrim(p.trim)
  },
})

const { state } = useEditorState()

onMounted(() => {
  // The chain's copy keeps its ON/BYPASS: opening its editor from the chain
  // must not un-bypass its slot.
  if (!resPreview.value && currentPluginCopy() === 'solo') togglePreview()
})

const ACCENT = '#8fd48a'
const SECOND = '#e8a33d'

/**
 * The threshold offset the plot draws its dotted line and its crossings from.
 *
 * Null under zones, so the plot keeps its own zone lookup and the shipping path
 * is untouched. A `computed`, so the normalisation inside `focusThresholdFn`
 * happens once per edit rather than once per display bin per animation frame.
 */
const selectivityFn = computed(() =>
  (focusMode ? focusThresholdFn(resFocus.value) : null))

/**
 * The global threshold the plot draws its rail from.
 *
 * ⚠ GUARDED, AND IT WAS NOT. `resFocus` is null under the zone model, so
 * reading `.global` off it threw on the panel's FIRST RENDER and took the whole
 * of ResoTame down under `?resoTargeting=zones` — the neighbouring `focusNodes`
 * binding had the guard, this one did not. Found by opening the panel, which is
 * the only way: componentBindings.test.js cannot catch it, because the name IS
 * declared and it is the VALUE that is null.
 *
 * The floor rather than the stock 20 when there is no patch: nothing draws the
 * rail under zones, so the number only has to be inside the prop's range.
 */
const focusThreshold = computed(() =>
  (focusMode ? resFocus.value.global.selectivity : RESONANCE_FOCUS_RANGES.selectivity.min))

/**
 * The spectrum display's height — opens at 140, and grows from there. See
 * FloatingWindow's `resizable`: the corner grip reports how many extra
 * pixels the user has dragged in, and this is the only thing here that
 * spends them; the meters, the knobs and the range fader stay exactly the
 * size they were designed at.
 */
/**
 * THE DISPLAY IS THE PANEL. 140 px was the number a cramped layout could spare
 * rather than the number it needs; every step since has been the controls
 * giving height back to it. What paid for this one: the two rows of global
 * knobs became one, the input meter went, Max Cut and Trim became fields
 * instead of dials, and the protection button lost a permanent caption it only
 * ever needed in one of its two states. See the notes on that row.
 */
const PLOT_H = 280
const heightDelta = ref(0)
const plotHeight = computed(() => PLOT_H + heightDelta.value)

/**
 * Whether the node's fields are showing, as distinct from whether a node is
 * selected.
 *
 * ⚠ A DISMISSED PANEL IS NOT A DESELECTED NODE. The `×` puts the fields down and
 * leaves the node selected — still lit on the plot, still the thing the arrow
 * keys walk from — because at the foot of the plate the panel covers the bottom
 * of the display, and wanting to SEE that is not wanting to stop editing.
 *
 * It reopens on the next selection change, so dismissing is per-node rather than
 * a mode: clicking another node shows its fields, which is what a reader who
 * just dismissed one and clicked the next expects.
 */
const nodePanelOpen = ref(true)
watch(() => resSelectedNode.value, () => { nodePanelOpen.value = true })

/** The selected focus node, or null — what the fields are shown for. */
const selectedNode = computed(() => (focusMode
  ? resFocus.value.nodes[resSelectedNode.value] ?? null
  : null))

/**
 * Node edits, applied here rather than in the plot.
 *
 * They lived in ResonanceSpectrum because the panel did, back when it floated
 * beside its node. `shape` and
 * `enabled` are not numbers, so they take `patchNode` rather than the clamping
 * setter `setNodeParam`, which would silently reject them.
 */
function patchFocusNode(patch) {
  const i = resSelectedNode.value
  let next = resFocus.value.nodes
  for (const [name, value] of Object.entries(patch)) {
    next = name === 'shape' || name === 'enabled'
      ? patchNode(next, i, { [name]: value })
      : setNodeParam(next, i, name, value)
  }
  syncFocus({ ...resFocus.value, nodes: next })
}

function deleteFocusNode() {
  syncFocus({ ...resFocus.value, nodes: removeNode(resFocus.value.nodes, resSelectedNode.value) })
  resSelectedNode.value = -1
}

/**
 * ⚠ THE PLOT KEEPS ITS OWN READINGS NOW, so nothing here holds them. AVE and
 * MAX are drawn inside the REMOVED band by the component that measures them,
 * which removes the hop they used to make: measured in the frame loop, emitted
 * at ~10 Hz, held in a ref here, and printed a few pixels above the plot. The
 * `update:reading` emit went with them.
 */

// Display state, persisted, and deliberately nowhere near `params` — see
// ui/resonanceOverlays.js for both halves of that.
const overlays = ref(loadOverlays())

function toggleOverlay(key) {
  overlays.value = flipOverlay(overlays.value, key)
  saveOverlays(overlays.value)
}

/**
 * The five switches, readings first and context second.
 *
 * REMOVED leads because it is the plot rather than an overlay of it — see the
 * note on its default. SPECTRUM and FOUND are the two questions asked of the
 * input and are independent rather than exclusive: SPECTRUM says which peak is
 * over the line now and where it sits in the file, FOUND says what has been over
 * it lately at true depth, and someone can reasonably want both.
 */
const overlayButtons = computed(() => [
  {
    key: 'removed',
    label: 'RESONANCE',
    on: overlays.value.removed,
    title: 'The suppression trace — what is being taken out',
  },
  {
    key: 'spectrum',
    label: 'SPECTRO',
    on: overlays.value.spectrum,
    title: 'Input level and the detection threshold across it, for placing zone boundaries',
  },
  /*
  {
    key: 'found',
    label: 'RESONANCE',
    on: overlays.value.found,
    title: 'Resonances found in the last few seconds, at their true depth over the threshold',
  },
  /*
  {
    key: 'history',
    label: 'HISTORY',
    on: overlays.value.history,
    title: `What has been carved over the last ${HISTORY_SECONDS} seconds`,
  },
  */
])

/**
 * ⚠ THE SOFT/HARD KNEE SWITCH IS GONE AND `mode` IS PINNED AT ITS STOCK 'soft'.
 * It was a segmented switch on the old global row, captioned "gradual knee" /
 * "linear above threshold". What removed it was the row: collapsing the globals
 * onto the zone line left space for four knobs, and this was the cheapest of the
 * six controls to give up — the hard knee is the same law with the smoothing
 * taken out, so what it changes is how abruptly a bin starts being treated as it
 * crosses, which on real material is a subtler difference than any of Attack,
 * Release, Mix or Trim make.
 *
 * IT REMAINS A PARAMETER at RESONANCE_DEFAULTS.mode, so the kernel is untouched
 * and a stored patch keeps whatever it had. Only the way in is gone; putting it
 * back is a DeviceChoiceRocker and three lines.
 */

const percent = v => `${Math.round(v * 100)}%`
const ms = v => `${Math.round(v)} ms`
const db = v => `${Math.round(v)}`
const signedDb = v => `${v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)} dB`

/**
 * ⚠ THE UNPROTECTED-ZONES WARNING IS GONE, and the switch is why. Harmonic
 * protection was per zone, so the panel could only state it as a summary —
 * "Z2, Z4 running unmasked" — because the one setting here that can quietly
 * wreck the material must stay visible without opening a zone. It is one global
 * switch now, sitting in this row with its own on/off state, so the summary was
 * restating what the control already shows.
 */


// The kernel clamps the low end to what its analysis frame can resolve, so show
// what it will actually search rather than what the preset asked for.
const pitchRangeCaption = computed(() => {
  const sr = state.currentFile?.sampleRate ?? 44100
  const r = effectivePitchRange(sr)
  return `${Math.round(r.minHz)}–${Math.round(r.maxHz)} Hz`
})

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
    window-id="resonance-suppressor"
    :z="z"
    :width="800"
    :accent="ACCENT"
    design="modula"
    brand-lead="RESOTAME"
    :presets="presets"
    :presets-disabled="!resPreview"
    presets-disabled-hint="Turn ResoTame on to use presets"
    :engaged="resPreview"
    show-delta
    :delta="resDelta"
    :delta-disabled="!resPreview"
    delta-title="Hear only what is being removed. Monitoring only — Apply always renders the processed audio."
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!resPreview"
    apply-disabled-hint="Turn ResoTame on to apply it"
    resizable
    @update:height-delta="heightDelta = $event"
    @toggle-engaged="togglePreview"
    @toggle-delta="toggleDelta"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <template #header-center>
      <!-- An override is a thing you forget you turned on. The two references
           disagree by an order of magnitude about what Selectivity measures, so
           a panel running the non-shipping one and not saying so is a panel
           whose numbers mean something other than they appear to. -->
      <span
        v-if="resRefMode !== DEFAULT_REF_MODE"
        class="rt-badge"
        title="Non-shipping reference, selected by ?resoRef. Its knob calibration differs from the default mode's."
      >{{ resRefMode.toUpperCase() }} REF</span>
    </template>

    <!-- A 1fr / auto / 1fr grid so the middle column (the zone count, under
         the zone model) centres against the ROW rather than wherever the two
         outer groups' widths happen to leave it. -->
    <div class="rt-head">
      <span class="rt-head-left">
        <!-- Second statement of a mode the title bar already shows: someone
             reading the plot has their eyes here, and a loud trace is
             otherwise unexplained. -->
        <span v-show="resDelta" class="rt-delta">DELTA</span>
      </span>

      <span>
        <span
          v-if="!focusMode"
          class="rt-badge"
          title="Zone targeting, selected by ?resoTargeting=zones. Focus nodes are the shipping model."
        >ZONES</span>
        <ResonanceZoneCount
          v-if="!focusMode"
          :zones="resZones"
          :selected="resSelectedZone"
          :disabled="!resPreview"
          :busy="resPlacementBusy"
          :has-selection="hasSelection"
          :profile="resVoiceProfile"
          @update:zones="syncZones"
          @update:selected="resSelectedZone = $event"
          @fit="fitZonesToVoice"
        />
      </span>

      <!-- The overlays: independent, because they answer different questions.
           Flat chips, lit when on — they change what is DRAWN, never the audio. -->
      <span class="rt-overlays">
        <ModulaChip
          v-for="o in overlayButtons"
          :key="o.key"
          variant="flat"
          :model-value="o.on"
          :label="o.label"
          color="var(--m-accent)"
          :title="o.title"
          @click="toggleOverlay(o.key)"
        />
      </span>
    </div>

    <!-- The plot draws zone columns from what it is GIVEN, so in focus mode it
         is given none. -->
    <ResonanceSpectrum
      :data-fn="resDisplayFn"
      :reduction-db="resReduction"
      :accent="ACCENT"
      :height="plotHeight"
      :delta="resDelta"
      :selectivity-fn="selectivityFn"
      :focus-nodes="focusMode ? resFocus.nodes : null"
      :focus-threshold="focusThreshold"
      :selected-focus-node="resSelectedNode"
      :solo-focus-node="resSoloNode"
      :zones="focusMode ? [] : resZones"
      :selected-zone="focusMode ? -1 : resSelectedZone"
      :delta-zone="focusMode ? -1 : resDeltaZone"
      :overlays="overlays"
      @update:zones="syncZones"
      @update:selected-zone="resSelectedZone = $event"
      @update:focus-nodes="syncFocus({ ...resFocus, nodes: $event })"
      @update:focus-threshold="syncFocus({
        ...resFocus, global: { ...resFocus.global, selectivity: $event },
      })"
      @focus-node-clicked="nodePanelOpen = true"
      @update:selected-focus-node="resSelectedNode = $event"
      @focus-solo="toggleFocusSolo"
    >
      <!-- Docked at the foot of the plate, where the change happens where the
           reader is already looking. -->
      <template v-if="focusMode && selectedNode && nodePanelOpen" #dock>
        <FocusNodePanel
          :node="selectedNode"
          :index="resSelectedNode"
          :rank="focusRanks(resFocus.nodes)[resSelectedNode]"
          :count="resFocus.nodes.length"
          :solo="resSoloNode === resSelectedNode"
          :accent="ACCENT"
          @patch="patchFocusNode"
          @delete="deleteFocusNode"
          @solo="toggleFocusSolo(resSelectedNode)"
          @close="nodePanelOpen = false"
        />
      </template>
    </ResonanceSpectrum>

    <!-- ONE ROW FOR EVERYTHING BELOW THE PLOT, ORDERED BY SCOPE, OUTSIDE IN.
         Attack and Release on the left and Mix and Trim on the right describe
         the effect as a whole; the detector (or, under zones, the selected
         zone) sits between them. -->
    <div class="rt-panel">
      <!-- The ballistic minima are the STFT hop, not 0 — see
           RESONANCE_ATTACK_MIN_MS. The tops were measured: matched at 3 dB of
           cut the effect saturates by about 200/500 ms. -->
      <ModulaKnob
        variant="small" :size="44" show-value editable
        :model-value="resAttack" :min="RESONANCE_ATTACK_MIN_MS" :max="400" :step="5"
        :default-value="RESONANCE_DEFAULTS.attack"
        label="Attack" :color="SECOND" :format-value="ms" :disabled="!resPreview"
        title="How fast the detector closes on a resonance. Double-click to reset"
        @update:model-value="syncAttack"
      />
      <ModulaKnob
        variant="small" :size="44" show-value editable
        :model-value="resRelease" :min="RESONANCE_RELEASE_MIN_MS" :max="2000" :step="10"
        :default-value="RESONANCE_DEFAULTS.release"
        label="Release" :color="SECOND" :format-value="ms" :disabled="!resPreview"
        title="How fast it lets go. Double-click to reset"
        @update:model-value="syncRelease"
      />

      <span class="rt-rule" aria-hidden="true"></span>

      <!-- min-width 0 so the middle is what gives way if the row runs short. -->
      <div class="rt-middle">
        <ResonanceFocusControls
          v-if="focusMode"
          :focus="resFocus"
          :accent="SECOND"
          :disabled="!resPreview"
          @update:focus="syncFocus"
        />
        <ResonanceZoneControls
          v-else
          :zones="resZones"
          :selected="resSelectedZone"
          :delta-zone="resDeltaZone"
          :pitch-range-caption="pitchRangeCaption"
          :ref-mode="resRefMode"
          :accent="SECOND"
          :disabled="!resPreview"
          @update:zones="syncZones"
          @zone-delta="toggleZoneDelta"
        />
      </div>

      <span class="rt-rule" aria-hidden="true"></span>

      <!-- Mix then Trim, in the order the signal meets them. -->
      <ModulaKnob
        variant="small" :size="44" show-value editable :parse-value="t => parseFloat(t) / 100"
        :model-value="resMix" :min="0" :max="1" :step="0.01"
        :default-value="RESONANCE_DEFAULTS.mix"
        label="Mix" :color="SECOND" :format-value="percent" :disabled="!resPreview"
        title="How much of the detector's work reaches the output. Double-click to reset"
        @update:model-value="syncMix"
      />
      <!-- ⚠ FIXED WIDTH: the printed value runs from "0.0 dB" to "-12.0 dB", and
           a column sized by its text moves everything beside it as the digits
           change. The width holds the widest reading. -->
      <div class="rt-fixed">
        <ModulaKnob
          variant="small" :size="44" show-value editable bipolar
          :model-value="resTrim" :min="-12" :max="12" :step="0.5"
          :default-value="RESONANCE_DEFAULTS.trim"
          label="Trim" :color="SECOND" :format-value="signedDb" :disabled="!resPreview"
          title="Output gain, for an honest A/B against the bypass. Double-click to reset"
          @update:model-value="syncTrim"
        />
      </div>
    </div>
  </FloatingWindow>
</template>

<style scoped>
.rt-badge {
  padding: 4px 9px;
  border-radius: 999px;
  font: 700 8.5px var(--m-font-mono);
  letter-spacing: .12em;
  color: #ffb27a;
  background: rgba(255, 178, 122, .12);
  border: 1px solid rgba(255, 178, 122, .45);
}
.rt-head {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 14px;
  margin-bottom: 8px;
}
.rt-head-left { min-width: 0; display: flex; align-items: center; }
.rt-delta {
  padding: 2px 6px;
  border-radius: 4px;
  font: 700 8px var(--m-font-mono);
  letter-spacing: .12em;
  color: var(--m-second);
  background: color-mix(in srgb, var(--m-second) 14%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--m-second) 35%, transparent);
}
.rt-overlays {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
.rt-panel {
  margin-top: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.rt-panel > * { flex-shrink: 0; }
.rt-fixed { width: 60px; display: flex; justify-content: center; }
.rt-rule {
  align-self: stretch;
  width: 1px;
  background: rgba(0, 0, 0, .35);
  box-shadow: 1px 0 0 rgba(255, 255, 255, .04);
}
.rt-middle {
  flex: 1 1 auto !important;
  min-width: 0;
  display: flex;
  justify-content: center;
}
</style>
