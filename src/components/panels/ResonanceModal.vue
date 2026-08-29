<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useResonance } from '../../composables/useResonance.js'
import { focusThresholdFn } from '../../audio/resonanceFocus.js'
import {
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
  patchNode,
  removeNode,
  setNodeParam,
} from '../meters/resonanceFocusNodes.js'
import { resolveFocusDock } from '../../ui/focusNodeDock.js'
import FocusNodePanel from './FocusNodePanel.vue'
import Knob from '../knobs/Knob.vue'
import ResonanceSpectrum from '../meters/ResonanceSpectrum.vue'
import ResonanceZoneControls from './ResonanceZoneControls.vue'
import ResonanceZoneCount from './ResonanceZoneCount.vue'
import ResonanceFocusControls from './ResonanceFocusControls.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  resAttack, resRelease,
  resMix, resTrim, resZones, resSelectedZone, resDeltaZone, resRefMode,
  resPreview, resDelta, resReduction,
  resDisplayFn, hasSelection,
  resVoiceProfile, resPlacementBusy, fitZonesToVoice,
  resTargeting, resFocus, resSelectedNode, resSoloNode, syncFocus, toggleFocusSolo,
  togglePreview, toggleDelta, syncAttack,
  syncRelease, syncMix, syncTrim, syncZones, toggleZoneDelta,
  apply, teardown, closeModal,
} = useResonance()

const { state } = useEditorState()

onMounted(() => {
  if (!resPreview.value) togglePreview()
})

const ACCENT = '#8de0a8'

/**
 * Running the prototype targeting model — see src/audio/resonanceTargeting.js.
 *
 * A const rather than a computed: the model is resolved once at module load, so
 * a reactive read here would only ever produce the same answer at more cost,
 * and would imply the panel can switch between them at runtime. It cannot, on
 * purpose.
 */
const focusMode = resTargeting === 'focus'

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
 * THE READOUT ROW IS THE PANEL'S, NOT THE PLOT'S.
 *
 * It used to live inside ResonanceSpectrum, above the canvas, which is where it
 * is drawn and so looked like where it belonged. It is not: the row is a header
 * for the whole display area rather than a part of the picture, and keeping it
 * inside the plot meant the panel could not put anything else in it — which is
 * exactly what the zone count needed. The plot now draws the plot.
 *
 * The two figures are still MEASURED inside the plot, on the frame loop that
 * draws it, and arrive by `update:reading` at ~10 Hz. That split is the point:
 * anything computing them out here would be a second reader of the kernel's
 * port describing a different instant from the picture beside it.
 */
/**
 * The selected focus node, or null — what the control row shows in its place.
 *
 * ⚠ SELECTION DRIVES IT NOW, WHERE A SEPARATE "OPEN" STATE USED TO. As a
 * floating card the node's fields had to be opened and closed, because they
 * covered the plot: `panelOpen`, a click to open, another to dismiss, Escape,
 * and a close button. Docked in the row there is nothing to dismiss — the row
 * shows the settings of whatever is selected, exactly as it does for a zone, and
 * clicking empty plate deselects.
 */
/**
 * Which of the two placements is in force — see ui/focusNodeDock.js.
 *
 * Resolved once, not reactive: it is a comparison switch for deciding between
 * two designs by looking at them, and a placement that could change mid-session
 * would be a third thing to reason about rather than a way of choosing between
 * two.
 */
const focusDock = resolveFocusDock()

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

const selectedNode = computed(() => (focusMode
  ? resFocus.value.nodes[resSelectedNode.value] ?? null
  : null))

/**
 * Node edits, applied here rather than in the plot.
 *
 * They lived in ResonanceSpectrum because the card did. `shape` and `enabled`
 * are not numbers, so they take `patchNode` rather than the clamping setter
 * `setNodeParam`, which would silently reject them.
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

const reading = ref({ deepestDb: 0, count: 0, avgDb: 0 })

/**
 * The two figures beside each other, and the string that reserves their width.
 *
 * ⚠ A READOUT THAT RESIZES ITSELF MOVES EVERYTHING TO ITS RIGHT. These update
 * ~10 times a second, so `-6.4` becoming `-12.1` shunted the MAX pair sideways
 * several times a second — the number was legible and the row was not. Two
 * distinct causes, and fixing one leaves the other: the glyph COUNT changes at
 * 10 dB, and Inter's default figures are proportional, so `-11.1` is narrower
 * than `-88.8` at the same length. `tabular-nums` answers the second; only
 * reserving the width answers the first.
 *
 * WIDEST is a real string rendered invisibly in the same box rather than a
 * min-width in `ch` or px. `ch` is the width of a digit, so a value made of a
 * minus, a point and three digits is not a whole number of them — sizing that
 * way means guessing at Inter's metrics for the minus and the point, and being
 * wrong in the loose direction leaves a permanent gap. A hidden copy of the
 * widest string is exact by construction and stays exact if the face or the
 * size ever changes.
 *
 * -24.0 is the widest either figure can be: both are bounded by the plot's
 * `fullScaleDb`, which is 24. A value past it would widen the box rather than
 * be clipped, so the failure mode of getting this wrong is the old behaviour
 * rather than a truncated number.
 */
const READOUT_WIDEST = '-24.0'

const readouts = computed(() => [
  { key: 'ave', db: reading.value.avgDb, label: 'AVE dB' },
  { key: 'max', db: reading.value.deepestDb, label: 'MAX dB' },
])

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
    label: 'REMOVED',
    on: overlays.value.removed,
    title: 'The suppression trace — what is being taken out',
  },
  {
    key: 'spectrum',
    label: 'SPECTRO',
    on: overlays.value.spectrum,
    title: 'Input level and the detection threshold across it, for placing zone boundaries',
  },
  {
    key: 'found',
    label: 'RESONANCE',
    on: overlays.value.found,
    title: 'Resonances found in the last few seconds, at their true depth over the threshold',
  },
  { key: 'grid', label: 'GRID', on: overlays.value.grid, title: 'Frequency and reduction rules' },
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
 * back is a SegmentedSwitch and three lines.
 */

const percent = v => `${Math.round(v * 100)}`
const ms = v => `${Math.round(v)}`
const db = v => `${Math.round(v)}`
const signedDb = v => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))

/**
 * Harmonic protection is per zone, so the panel-level statement about it is a
 * summary rather than a control: which zones, if any, are running unmasked.
 *
 * Kept because this is the one setting here that can quietly wreck the
 * material. It used to be a caption under a global button; with the control
 * distributed to the zones the warning has to be too, and naming the zones is
 * what makes it actionable rather than ominous.
 */
const unprotectedZones = computed(() => (resRefMode !== 'cepstral' ? [] : resZones.value
  .map((z, i) => (zoneSettings(z).protect ? null : `Z${i + 1}`))
  .filter(Boolean)))


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
  <!-- ⚠ BACK TO 660, AND THE ROW WAS MADE TO FIT RATHER THAN THE WINDOW GROWN.
       It went to 740 when the two control rows collapsed into one, because the
       row measured 674 against 608 of content. The knobs came down instead:
       the four globals to 54 and the zone plate to a 100 px identity and 68 px
       knobs, which is 348 in a 352 px slot. The arithmetic is in the widths
       below and it has almost nothing spare, so anything added to this row
       needs the sums redone rather than a nudge. -->
  <FloatingWindow
    window-id="resonance-suppressor"
    :z="z"
    :width="660"
    :accent="ACCENT"
    brand-lead="RESO"
    brand-tail="TAME"
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
    <!-- Delta sits beside ON/BYPASS because it is the same kind of control:
         both change what reaches the speakers and neither changes the file.
         Putting it down among the parameters would have implied it was one. -->
    <template #header-center>
      <!-- An override is a thing you forget you turned on. The two references
           disagree by an order of magnitude about what Selectivity measures, so
           a panel running the non-shipping one and not saying so is a panel
           whose numbers mean something other than they appear to. -->
      <span
        v-if="resRefMode !== DEFAULT_REF_MODE"
        class="px-2 py-1 rounded-full"
        style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.12em;
               color:#ffb27a;background:rgba(255,178,122,.12);
               border:1px solid rgba(255,178,122,.45)"
        title="Non-shipping reference, selected by ?resoRef. Its knob calibration differs from the default mode's."
      >{{ resRefMode.toUpperCase() }} REF</span>
    </template>
    <div class="px-[26px] pt-[18px] pb-[18px]">
      <!-- The display, not a meter. This effect cuts a few narrow bands and
           leaves the rest alone, so "how much" without "where" describes almost
           nothing about it — see the note in ResonanceSpectrum. -->
      <!-- NOTHING SITS BESIDE THE DISPLAY ANY MORE, and the column that used
           to has emptied one item at a time. It began as two level meters,
           then one — two meters answer "how much did this change the level",
           and an effect that cuts a few narrow bands always answers "barely",
           so the pair spent width to show two columns at the same height. Then
           the last meter went for the same reason taken further: a bar reading
           "barely" at every setting is a bar nobody looks at, and the plot
           beside it already says exactly what came out and where.

           What was left was the zone count and Trim, and neither was paying
           for the ~90 px of the display's WIDTH the column costs. This plot's
           axis is frequency: width is resolution, and it is the one dimension
           the resize grip does not give back. TRIM moved into the global row
           beside Mix, which is where it belonged on the row's own rule — that
           row is the controls whose subject is the whole effect rather than
           one zone, and the output level is exactly that. It sat here on the
           argument that it was the odd one out among the meters, and once the
           meters were gone that argument had nothing left to be odd against.

           THE ZONE COUNT COST NO HEIGHT AT ALL IN THE END. It went above the
           plot first, as its own line, which was the right place and the wrong
           row: the display already had a header — the deepest-cut figure and
           the overlay switches — sitting inside the plot component, and two
           header rows stacked on one display is one more than the display has
           to say for itself. That row is ~42 px tall because of the 30 px
           numeral, and the count is one 22 px line, so it fits in the space
           the numeral already occupies. What made it possible was moving the
           row out of ResonanceSpectrum, which had no way to let the panel put
           anything in it. -->
      <!-- A 1fr / auto / 1fr GRID RATHER THAN `justify-between`, for the reason
           the window header already records: space-between leaves the middle
           group wherever the two outer groups' widths happen to put it, and
           these two are nowhere near equal — a labelled pair of large figures
           at one end, three small switches at the other. The count came out
           visibly left of centre. A grid centres the middle column against the
           ROW, so it sits over the middle of the plot below it whatever the
           figures beside it happen to read.

           `min-w-0` on the outer cells is what keeps the two tracks equal: a
           1fr track is `minmax(auto, 1fr)`, so without it the wider group
           forces its own track and pushes the centre back off axis. Both outer
           groups are now fixed-width by construction — the readouts reserve
           their widest string, the switches carry fixed labels — so the centre
           holds still frame to frame as well as file to file. -->
      <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-[14px] mb-[7px]">
        <!-- 1c's header figures: what was taken out, at the size of the thing
             the panel is for. The old line led with a running reduction figure
             and an average in 12 px, sharing a row with a three-item curve
             legend. Under "removal only" the reduction IS the reading — there
             is no second curve for it to be one of — so it gets the size, and
             the legend goes: two of the three curves it named no longer exist.
             The average and the deepest are both here because they answer
             different questions: how much the effect is doing overall, and how
             hard it is working at its worst moment. -->
        <span class="flex items-end gap-[10px] min-w-0">
          <span class="flex flex-col">
            <span style="font:500 9px 'JetBrains Mono',monospace;letter-spacing:.14em;color:rgba(255,255,255,.35)">
              RESONANCES SUPPRESSED
            </span>
            <!-- The brief sets this at 46 px against a 1000 px card; this
                 faceplate is 640 (`--w-faceplate`), so the same figure lands at
                 30, and at 24 with two of them side by side. Everything else
                 about it is the brief's: Inter 500, the pale tint, and a mono
                 `dB` at the text-mini step beside it.

                 One loop rather than two copies: the pair differ in a number
                 and a word, and the width reservation below has to be identical
                 on both or the one that drifts moves the other. -->
            <div class="flex gap-2 mt-1">
              <span
                v-for="r in readouts"
                :key="r.key"
                class="flex items-baseline gap-[4px]"
              >
                <!-- The invisible copy sets the width; the real value is laid
                     over it, right-aligned, so the decimal point holds still
                     rather than the leading digit. -->
                <span class="relative inline-block">
                  <span
                    aria-hidden="true"
                    class="invisible"
                    :style="{
                      font: `500 24px 'Inter',system-ui`,
                      lineHeight: '1',
                      fontVariantNumeric: 'tabular-nums',
                    }"
                  >{{ READOUT_WIDEST }}</span>
                  <span
                    class="absolute inset-0 text-right"
                    :style="{
                      font: `500 24px 'Inter',system-ui`,
                      lineHeight: '1',
                      fontVariantNumeric: 'tabular-nums',
                      color: bright(ACCENT),
                      textShadow: `0 0 12px ${tint(ACCENT, 0.45)}`,
                    }"
                  >-{{ r.db.toFixed(1) }}</span>
                </span>
                <span style="font:500 9px 'JetBrains Mono',monospace;color:rgba(255,255,255,.35)">{{ r.label }}</span>
              </span>
            </div>

          </span>

          <!-- Second statement of a mode the title bar already shows, and worth
               the duplication: someone reading the plot to decide whether a cut
               is landing where they want has their eyes here, not on the title
               bar, and the trace being loud is otherwise unexplained. -->
          <span
            v-show="resDelta"
            class="px-[5px] py-[1px] rounded mb-[3px]"
            :style="{
              font: `700 8px 'JetBrains Mono',monospace`,
              letterSpacing: '.12em',
              color: bright(ACCENT),
              background: tint(ACCENT, 0.14),
              boxShadow: `inset 0 0 0 1px ${tint(ACCENT, 0.3)}`,
            }"
          >DELTA</span>
        </span>

        <!-- The count sits between the two readouts because it is neither: it
             is the only control in the row, and it is about the row of columns
             on the plot below rather than about any one of them. -->
        <!-- No nudge of its own: the row centres its items now, and a bottom
             margin left over from when it aligned them to the baseline would
             lift this one 3 px above the axis it is being centred on. -->
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
        <!-- ⚠ AN OVERRIDE IS A THING YOU FORGET YOU TURNED ON — the same rule
             the reference-mode badge follows two rows up, and the reason this
             is a badge rather than nothing. The panel is running a targeting
             model that does not ship, and everything below the plot is a
             different control surface from the one the notes describe. -->
        <span
          v-else
          class="px-2 py-1 rounded-full"
          style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.12em;
                 color:#ffb27a;background:rgba(255,178,122,.12);
                 border:1px solid rgba(255,178,122,.45)"
          title="Prototype targeting model: one global detector plus focus nodes. ?resoTargeting=zones for the shipping model."
        >FOCUS · NOT SHIPPED</span>

        <span class="flex flex-col items-end self-end gap-[5px] min-w-0">


          <!-- The three overlays. Independent rather than the source design's
               one DETAIL button: they answer different questions, and someone
               who wants a grid rarely wants a waterfall behind it. Lit when on,
               in the accent, so the row reads at a glance as "what is folded
               in". -->
          <!-- ⚠ WRAPPED, because five of these do not fit the cell on one
               line — they run to about 265 px against a track nearer 174. The
               row has the height for two: it was sized by the 30 px reading
               opposite, and the sentence that used to sit above these buttons
               is gone. -->
          <span class="flex flex-wrap items-center justify-end gap-[4px]">
            <button
              v-for="o in overlayButtons"
              :key="o.key"
              type="button"
              class="px-[7px] py-[3px] rounded-full transition-colors"
              :aria-pressed="String(o.on)"
              :title="o.title"
              :style="{
                font: `600 8px 'JetBrains Mono',monospace`,
                letterSpacing: '.1em',
                color: o.on ? bright(ACCENT) : 'rgba(255,255,255,.36)',
                background: o.on ? tint(ACCENT, 0.14) : 'rgba(255,255,255,.03)',
                boxShadow: o.on ? `inset 0 0 0 1px ${tint(ACCENT, 0.5)}` : 'inset 0 0 0 1px rgba(255,255,255,.06)',
              }"
              @click="toggleOverlay(o.key)"
            >{{ o.label }}</button>
          </span>
        </span>
      </div>

      <!-- The plot draws zone columns from what it is GIVEN, so in focus mode it
           is given none. The rail below owns targeting there, and two editors
           for one idea on one plate is exactly the confusion this prototype
           exists to remove. -->
      <ResonanceSpectrum
        :data-fn="resDisplayFn"
        :reduction-db="resReduction"
        :accent="ACCENT"
        :height="plotHeight"
        :delta="resDelta"
        :selectivity-fn="selectivityFn"
        :focus-nodes="focusMode ? resFocus.nodes : null"
        :selected-focus-node="resSelectedNode"
        :solo-focus-node="resSoloNode"
        :zones="focusMode ? [] : resZones"
        :selected-zone="focusMode ? -1 : resSelectedZone"
        :delta-zone="focusMode ? -1 : resDeltaZone"
        :overlays="overlays"
        @update:zones="syncZones"
        @update:selected-zone="resSelectedZone = $event"
        @update:focus-nodes="syncFocus({ ...resFocus, nodes: $event })"
        @update:selected-focus-node="resSelectedNode = $event"
        @focus-solo="toggleFocusSolo"
        @update:reading="reading = $event"
      >
        <!-- The bottom placement. Same component and the same handlers as the
             row one — only where it is mounted differs, which is what makes the
             two comparable rather than two designs that happen to look alike. -->
        <template v-if="focusDock === 'bottom' && focusMode && selectedNode && nodePanelOpen" #dock>
          <FocusNodePanel
            docked
            :node="selectedNode"
            :index="resSelectedNode"
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

      <!-- ONE ROW FOR EVERYTHING BELOW THE PLOT, and it used to be two.
           Directly under the display because the row and the plot are one
           control split by what they edit: the plot owns where a zone IS —
           boundaries are horizontal extents and the axis is horizontal — and
           this owns what it DOES. Selection lights both, so the column and the
           row read as the same object.

           The global controls used to sit on a second line beneath. Collapsing
           them cost two settings, and both were chosen because they are pinned
           to a value nobody was moving rather than because they are unimportant:
           the SOFT/HARD knee switch and the per-zone
           Max Cut (see the note in ResonanceZoneControls). Both remain
           parameters at their stock values; only the controls are gone.

           WHAT IS LEFT IS ORDERED BY SCOPE, OUTSIDE IN. Attack and Release on
           the left and Mix and Trim on the right describe the effect as a whole
           — how fast the detector moves, how much of its work reaches the
           output, and at what level — and the plate between them is the one
           zone being edited. The globals bracket the per-zone block rather than
           sitting under it, which is what lets one line say both. -->
      <div class="flex items-center gap-[10px] mt-[11px]">
        <!-- The ballistic minima are the STFT hop, not 0. A time constant
             shorter than one hop leaves the IIR coefficient at zero, so every
             setting below it is the same instantaneous jump — the bottom of
             both knobs used to be travel that could not be heard. See
             RESONANCE_ATTACK_MIN_MS.

             The TOPS were measured rather than inherited. At fixed selectivity
             a longer attack looks like it cleans up but is only refusing to act
             — jitter per dB removed gets WORSE, 0.351 at 12 ms to 0.417 at
             800 ms — while a longer release genuinely improves it, 0.416 to
             0.299. Matched at 3.0 dB of cut the whole effect saturates by about
             200/500 ms; what keeps improving past there is p90 depth, 8.5 to
             5.2 dB, the same average cut spread evenly instead of concentrated
             in momentary deep notches. 400/2000 captures nearly all of it. -->
        <div class="w-[54px] shrink-0">
          <Knob
            :model-value="resAttack" @update:model-value="syncAttack"
            :min="RESONANCE_ATTACK_MIN_MS" :max="400" :step="5" :value-font-px="11"
            label="Attack" :accent="ACCENT" :format-value="ms"
            :disabled="!resPreview"
          />
        </div>
        <div class="w-[54px] shrink-0">
          <Knob
            :model-value="resRelease" @update:model-value="syncRelease"
            :min="RESONANCE_RELEASE_MIN_MS" :max="2000" :step="10" :value-font-px="11"
            label="Release" :accent="ACCENT" :format-value="ms"
            :disabled="!resPreview"
          />
        </div>

        <!-- min-w-0 so the plate is what gives way if the row ever runs out of
             width, rather than a knob being clipped off the end. -->
        <div class="flex-1 min-w-0">
          <!-- ⚠ THE SELECTED NODE TAKES THE SLOT, SWAPPING WITH THE GLOBAL
               FOCUS KNOBS RATHER THAN OPENING BESIDE THEM. Same move the HARM
               door makes inside the zone plate, for the same reason: the row's
               height is set by what is in it, so a swap moves nothing while an
               expansion moves everything below.

               It also puts the two models on the same footing at last. Under
               zones, the plot owns WHERE a zone is and this slot owns what the
               SELECTED one does; under focus, the plot owned where a node was
               and its settings floated over the plot in a card placed at the
               node's own y — covering the curve being edited. Now both models
               read the same way.

               ⚠ ResonanceFocusControls IS THE UNSELECTED STATE, NOT DEAD CODE.
               It carries the settings that are global to the focus model —
               Threshold, Sharp, Depth and the range — which have nowhere else to
               live and are what the row should show when no node is selected. -->
          <!-- Centred, not stretched — the zone plate this swaps with is sized
               by its contents too. -->
          <div
            v-if="focusMode && selectedNode && nodePanelOpen && focusDock === 'row'"
            class="flex justify-center"
          >
            <FocusNodePanel
              docked
              :node="selectedNode"
              :index="resSelectedNode"
              :count="resFocus.nodes.length"
              :solo="resSoloNode === resSelectedNode"
              :accent="ACCENT"
              @patch="patchFocusNode"
              @delete="deleteFocusNode"
              @solo="toggleFocusSolo(resSelectedNode)"
              @close="nodePanelOpen = false"
            />
          </div>
          <ResonanceFocusControls
            v-else-if="focusMode"
            :focus="resFocus"
            :pitch-range-caption="pitchRangeCaption"
            :accent="ACCENT"
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
            :accent="ACCENT"
            :disabled="!resPreview"
            @update:zones="syncZones"
            @zone-delta="toggleZoneDelta"
          />
        </div>

        <!-- Mix then Trim, in the order the signal meets them: how much of the
             detector's work reaches the output, then what level it leaves at.
             Trim is `bipolar` — a cut/boost knob filling from its minimum lights
             half the ring at 0 dB, so an untouched trim reads as an applied
             one. -->
        <div class="w-[54px] shrink-0">
          <Knob
            :model-value="resMix" @update:model-value="syncMix"
            :min="0" :max="1" :step="0.01" :value-font-px="11"
            label="Mix" :accent="ACCENT" :format-value="percent"
            :disabled="!resPreview"
          />
        </div>
        <div class="w-[54px] shrink-0">
          <Knob
            :model-value="resTrim" @update:model-value="syncTrim"
            :min="-12" :max="12" :step="0.5" :value-font-px="11"
            label="Trim" :accent="ACCENT" :format-value="signedDb"
            :disabled="!resPreview" bipolar
            title="Output gain, for an honest A/B against the bypass."
          />
        </div>
      </div>
    </div>
  </FloatingWindow>
</template>
