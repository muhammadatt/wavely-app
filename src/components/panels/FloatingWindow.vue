<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useWindows } from '../../composables/useWindows.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { helpFor } from '../../content/help/index.js'
import Icon from '../ui/Icon.vue'
import HelpOverlay from './HelpOverlay.vue'

/**
 * The plugin harness — the chassis every effect window is mounted into.
 *
 * It owns everything that is true of ALL plugins and nothing that is true of
 * any one of them: the draggable frame, the brand mark, DELTA, ON/BYPASS, the
 * close button, the selection readout, Preview and Apply. The plugin's own face
 * arrives through the default slot and is the only part that varies.
 *
 * ── HUE-LOCKED TITANIUM: THE CHROME SHARES THE FACE'S HUE, WEAKLY ───────────
 * Every one of these controls used to be rebuilt inside each faceplate at full
 * accent strength: an amber ON pill over an amber face, an amber DELTA beside
 * it, an amber Apply under it. Fifteen hues each used five times over, so the
 * colour that is supposed to mean "this is the parameter you are moving" also
 * meant "this is the window chrome", and the accent stopped distinguishing
 * anything.
 *
 * The fix is not a neutral chassis — that was tried, and a hue-free titanium
 * lit brighter than the face clashes with the colder plugins. The chassis
 * instead carries the plugin's OWN hue at 5–9%, lifted above the faceplate.
 * Sharing the hue is what makes it safe: the chrome cannot clash with a face it
 * is derived from, whatever that face's colour is. The accent is still spent
 * only once at full strength, inside the face, on the controls.
 *
 * The engage lamp is the one thing up here that ignores the hue — it is the
 * app's status green (--color-ok), because it reports a state rather than
 * identifying a plugin. Apply is the brightest surface in the window, warmed by
 * the same hue at 14% so it belongs to this plugin rather than to the app.
 *
 * ── THE FACE IS FLUSH INTO THE CHASSIS. ─────────────────────────────────────
 * No inner radius, no padding, no second border around the face. Separation is
 * carried by the header and footer hairlines alone — 13% white over a 1px black
 * drop line — which is enough for the face to read as its own plane against the
 * lifted chassis without spending 14px of chrome on a frame around a frame. The
 * hairlines do more work now that the two planes share a hue, which is why they
 * are the stronger pair rather than the .06 rule this replaced.
 *
 * ── APPLY IS IN THE FOOTER, WHICH MEANS IT CANNOT SCROLL AWAY. ──────────────
 * It used to be the last row of the panel body, so on a short viewport the
 * primary action of the window sat below the fold behind a "MORE ↓" hint. The
 * footer is pinned outside the scroller: the body scrolls, the actions do not.
 */
const props = defineProps({
  // Registry id. Identifies this window to the manager for focus and for
  // remembering where the user last dragged it.
  windowId: { type: String, required: true },
  z: { type: Number, default: 500 },

  width: { type: Number, default: 640 },
  // Vertical offset of the initial resting place, used only the first time a
  // window opens; after that the remembered position wins.
  top: { type: Number, default: 90 },
  /**
   * The plugin's hue.
   *
   * Reaches the whole window as the `--face` custom property: the faceplate
   * takes it at 4–10%, the chassis at 5–9% and Apply at 14%. Every one of those
   * is weak enough that fifteen hues still read as one product, and derived
   * from one value so they cannot disagree with each other.
   */
  accent: { type: String, default: '#f5a623' },

  // Two-part brand mark, e.g. "OPTO" + "SMOOTH" — the first word solid, the
  // second lighter.
  brandLead: { type: String, required: true },
  brandTail: { type: String, default: '' },

  // Override the derived faceplate tint. Only FET Punch does — its steel-blue
  // accent tints too cold through the generic recipe.
  background: { type: String, default: null },

  // ── Header controls ───────────────────────────────────────────────────────
  // The ON/BYPASS pill only makes sense where there is something to bypass —
  // i.e. effects that preview in real time.
  showEngage: { type: Boolean, default: true },
  engaged: { type: Boolean, default: false },

  /**
   * DELTA — audition only what the effect is changing.
   *
   * It sits in the header with ON/BYPASS because it is the same kind of
   * control: both change what reaches the speakers and neither changes the
   * file. Down among the parameters it would read as one.
   */
  showDelta: { type: Boolean, default: false },
  delta: { type: Boolean, default: false },
  // Delta means nothing while the effect is bypassed — there is no difference
  // to hear — so callers gate it on their own engaged state.
  deltaDisabled: { type: Boolean, default: false },
  deltaTitle: { type: String, default: 'Hear only what the effect changes' },

  // ── Footer ────────────────────────────────────────────────────────────────
  /**
   * Whether this window can commit anything to the timeline. An analyzer
   * cannot, and gets no footer at all.
   */
  showApply: { type: Boolean, default: false },
  /**
   * Apply's label.
   *
   * "Apply to selection" rather than "Apply <plugin name>" on every window: the
   * brand mark two rows up already says which plugin this is, and repeating it
   * on the button spends the one string that could say what the button acts on.
   * The readout beside it names the region, so the two together read as one
   * sentence. Overridable for anything whose scope is genuinely different.
   */
  applyLabel: { type: String, default: 'Apply to selection' },
  /**
   * What Apply says on a narrow window.
   *
   * The brief was drawn at 860px; the app has windows down to 360, where the
   * full label plus Preview plus the readout do not fit in one row and the
   * readout wraps to two lines inside a fixed-height footer. Rather than let
   * the label truncate — losing the end of the sentence, which is the half that
   * says what is acted on — the footer swaps in a short form and drops the
   * readout, which the app's own selection bar carries anyway.
   */
  applyLabelShort: { type: String, default: 'Apply' },
  applyIcon: { type: String, default: 'check' },
  /**
   * A gate applied on top of the selection requirement — e.g. an effect that is
   * currently bypassed has nothing to render. The button stays visible but
   * inert, with the reason in its tooltip.
   */
  applyDisabled: { type: Boolean, default: false },
  applyDisabledHint: { type: String, default: '' },
  /**
   * Whether Apply needs a selection. True for every effect that processes a
   * region, which is all of them today; false leaves Apply live on an empty
   * selection for anything that operates on the whole file.
   */
  requiresSelection: { type: Boolean, default: true },

  // Preview — present on every effect, enabled only where the effect can run
  // live in the playback chain. A disabled control with a tooltip teaches that
  // real-time tuning exists; omitting it teaches nothing.
  showPreview: { type: Boolean, default: false },
  previewable: { type: Boolean, default: true },
  previewing: { type: Boolean, default: false },
  previewHint: {
    type: String,
    default: 'Real-time preview isn’t available for this effect — apply to hear the result (Ctrl+Z undoes it)',
  },

  /**
   * Let the user drag a handle to make the window — and whatever real-time
   * display it holds — bigger. Off by default: most of these faceplates are
   * hand-fitted to their controls at one width, and a resize handle on a
   * window with nothing that benefits from the extra room would just be a way
   * to break the layout. Opt in on the handful that hold a graphical display
   * worth enlarging (ResoTame, the parametric EQ, VoiceRx).
   */
  resizable: { type: Boolean, default: false },
  /**
   * Floor for a drag-resize. Defaults to the window's own opening width —
   * this is an EXPAND handle, not a shrink one, so the layout it was fitted to
   * is never the thing at risk.
   */
  minWidth: { type: Number, default: null },
  /**
   * Ceiling on how much taller a drag-resize can ask a caller's content to
   * grow, in pixels. FloatingWindow does not know what "taller" means to the
   * plugin inside it — see heightDelta below — so this is the one guard
   * against a runaway drag it can enforce on the caller's behalf.
   */
  maxHeightDelta: { type: Number, default: 360 },
})

const emit = defineEmits([
  'toggle-engaged', 'toggle-delta', 'toggle-preview', 'apply', 'close',
  /**
   * How much extra height a resize drag has asked for, in pixels. Emitted on
   * mount (0, or whatever was remembered) and on every subsequent drag.
   *
   * FloatingWindow does not resize its own body to this number — the body
   * already grows to fit its content, up to the viewport, and scrolls beyond
   * that (see bodyMaxHeight). What "taller" means is entirely the caller's:
   * usually adding this figure to a plot's own height prop, which is what
   * actually makes the content taller and lets the existing grow-then-scroll
   * behaviour take it from there.
   */
  'update:heightDelta',
])

const { focusWindow, closeWindow, savePosition, getPosition, saveSize, getSize } = useWindows()
// The harness reads the selection itself rather than taking it as a prop.
// Every plugin was passing the same `hasSelection` through to the same row and
// printing the same unmet message; one readout that is right by construction
// beats fifteen that agree by convention.
const { state, hasSelection, selectAll } = useEditorState()

const accent = computed(() => props.accent)

/**
 * Help for THIS effect, looked up by the id the harness was already given.
 *
 * No plugin passes it and no plugin can pass the wrong one — `src/content/help`
 * is keyed by the same window id, so a faceplate showing another effect's
 * instructions is not expressible. Null where nothing is written yet, and the
 * button is then absent rather than opening an empty panel.
 */
const help = computed(() => helpFor(props.windowId))
const helpOpen = ref(false)

// The window's own opening width unless a resize has changed it. A ref, not a
// computed off the prop, because a resize drag has to be able to win —
// nothing about a caller re-rendering with the same `width` prop should snap
// a manually-widened window back down.
const boxWidth = ref(props.width)
/** See the `update:heightDelta` emit above. */
const heightDelta = ref(0)
const resizing = ref(false)
let resizeStartX = 0
let resizeStartY = 0
let resizeStartWidth = 0
let resizeStartDelta = 0

const minWidthPx = computed(() => props.minWidth ?? props.width)

function clampWidth(w) {
  // Leaves the same margin clampToViewport does, so a fully-expanded window
  // still reads as a window rather than a panel welded to the screen edge.
  const maxW = Math.max(minWidthPx.value, window.innerWidth - pos.value.x - 20)
  return Math.min(Math.max(minWidthPx.value, w), maxW)
}

function clampHeightDelta(d) {
  return Math.min(props.maxHeightDelta, Math.max(0, d))
}

// The faceplate is a near-black tinted toward the plugin's accent. Keeping the
// tint this weak is what lets fifteen different hues still read as one product
// — and it is now the ONLY place in the window the hue appears.
const background = computed(() =>
  props.background ??
  `linear-gradient(155deg, color-mix(in srgb, ${accent.value} 10%, #16191e), color-mix(in srgb, ${accent.value} 4%, #0b0d10) 60%)`
)

const hasFooter = computed(() => props.showApply || props.showPreview)
// A selection is what Apply acts on. Without one the footer offers to make one
// rather than printing a notice about its absence — "select all" is a button,
// "make a selection to apply" is a complaint.
const applyBlocked = computed(() => props.applyDisabled || (props.requiresSelection && !hasSelection.value))
const applyTitle = computed(() => {
  if (props.applyDisabled) return props.applyDisabledHint
  if (props.requiresSelection && !hasSelection.value) return 'Select audio to apply this effect to'
  return ''
})

const EMPTY_TIME = '—'
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return EMPTY_TIME
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(2)
  return `${m}:${s.padStart(5, '0')}`
}

/**
 * The selection, in the selection bar's own words.
 *
 * Same formatter, same `→` between the ends and `·` before the duration, so a
 * reading taken here and a reading taken from the bar at the bottom of the app
 * are recognisably the same number rather than two renderings of it.
 */
const selectionText = computed(() => {
  if (!hasSelection.value) return ''
  const { start, end } = state.selection
  return `${formatTime(start)} → ${formatTime(end)} · ${formatTime(end - start)} SELECTED`
})

const pos = ref({ x: 0, y: props.top })
const dragging = ref(false)
let dragOffsetX = 0
let dragOffsetY = 0

// Gap left between the bottom of a window and the bottom of the viewport, so a
// full-height window still reads as a window rather than a panel welded to the
// edge.
const VIEWPORT_MARGIN = 16
// Below this the body is not worth scrolling — a window dragged almost off the
// bottom keeps a usable sliver and hangs over the edge instead of collapsing.
const MIN_BODY_PX = 160
// Chrome heights, fixed by their own classes. The body gets what is left.
const HEADER_PX = 56
const FOOTER_PX = 68

const viewportH = ref(typeof window === 'undefined' ? 800 : window.innerHeight)

/**
 * How tall the scrolling body may be.
 *
 * Windows are sized by their contents and some of them are tall — VoiceRx runs
 * a 200 px plot, a findings list and a knob row, which together outrun a laptop
 * viewport. The frame is overflow:hidden, so before this the overflow was not
 * merely off screen but unreachable.
 *
 * The footer is subtracted because it is pinned outside the scroller: the whole
 * reason Apply moved down there is that it must never be the thing below the
 * fold, and that only holds if the body's ceiling accounts for it.
 */
const bodyMaxHeight = computed(() => Math.max(
  MIN_BODY_PX,
  viewportH.value - pos.value.y - HEADER_PX - (hasFooter.value ? FOOTER_PX : 0) - VIEWPORT_MARGIN,
))

const frameEl = ref(null)
const bodyEl = ref(null)

/**
 * Whether the body has content below its visible edge.
 *
 * Measured rather than derived from bodyMaxHeight, because only the DOM knows
 * how tall the slotted panel actually is — and it changes as a panel opens a
 * section, runs an analysis, or grows a findings list.
 */
const canScrollDown = ref(false)
let bodyRo = null

function updateOverflow() {
  const el = bodyEl.value
  // A pixel of slack: fractional layout heights leave sub-pixel remainders that
  // would otherwise light the hint on a panel that fits exactly.
  canScrollDown.value = !!el && el.scrollHeight - el.scrollTop - el.clientHeight > 1
}
// Whatever had focus when this opened, so closing can hand it back.
let previouslyFocused = null

// Accessible name, read off the brand mark.
const label = computed(() => `${props.brandLead} ${props.brandTail}`.trim())

onMounted(() => {
  // A window that was resized before is reopened at the size it was left, the
  // same courtesy the position gets. Restored before the position fallback
  // below, which reads it for the first-open case.
  const rememberedSize = getSize(props.windowId)
  if (rememberedSize) {
    boxWidth.value = clampWidth(rememberedSize.width ?? props.width)
    heightDelta.value = clampHeightDelta(rememberedSize.heightDelta ?? 0)
  }
  emit('update:heightDelta', heightDelta.value)

  const remembered = getPosition(props.windowId)
  if (remembered) {
    pos.value = { ...remembered }
  } else {
    // First open: rest near the top-right so the waveform stays visible.
    pos.value = { x: Math.max(16, window.innerWidth - boxWidth.value - 40), y: props.top }
  }
  clampToViewport()

  // These windows are non-modal by design — audio keeps playing and the
  // waveform stays usable while one is open — so there is deliberately no focus
  // trap and no aria-modal. Trapping would break previewing an effect against a
  // selection, which is the whole point of them. Focus still has to *land* here
  // though, or a keyboard user has no way in.
  previouslyFocused = document.activeElement
  frameEl.value?.focus({ preventScroll: true })

  window.addEventListener('resize', onViewportResize)

  // Watches the scroller and its content: the first catches the max-height
  // moving with the viewport, the second catches the panel itself changing
  // size, which is the case a scroll listener alone never sees.
  bodyRo = new ResizeObserver(updateOverflow)
  bodyRo.observe(bodyEl.value)
  if (bodyEl.value.firstElementChild) bodyRo.observe(bodyEl.value.firstElementChild)
  updateOverflow()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportResize)
  bodyRo?.disconnect()
  savePosition(props.windowId, pos.value)
  // Return focus only if it is still inside this window; if the user has since
  // clicked the waveform, yanking it back would be worse than leaving it.
  if (frameEl.value?.contains(document.activeElement)) {
    previouslyFocused?.focus?.({ preventScroll: true })
  }
})

/**
 * Shrinking the viewport must not strand a window.
 *
 * Position was clamped once, on open, so a window opened on a tall screen and
 * then met with a smaller one — a resized browser, a rotated tablet, devtools
 * opening — kept a position that no longer existed. Re-clamping here also keeps
 * the body's height honest, since it is measured from the top edge down.
 */
function onViewportResize() {
  viewportH.value = window.innerHeight
  clampToViewport()
}

function clampToViewport() {
  const maxX = window.innerWidth - 120
  const maxY = window.innerHeight - 60
  pos.value.x = Math.min(Math.max(-boxWidth.value + 120, pos.value.x), maxX)
  pos.value.y = Math.min(Math.max(0, pos.value.y), maxY)
}

function onDragStart(e) {
  dragging.value = true
  dragOffsetX = e.clientX - pos.value.x
  dragOffsetY = e.clientY - pos.value.y
  e.currentTarget.setPointerCapture(e.pointerId)
}

function onDragMove(e) {
  if (!dragging.value) return
  pos.value.x = e.clientX - dragOffsetX
  pos.value.y = e.clientY - dragOffsetY
}

function onDragEnd(e) {
  if (!dragging.value) return
  dragging.value = false
  // On pointercancel the capture is already implicitly released
  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
  clampToViewport()
  savePosition(props.windowId, pos.value)
}

/**
 * The corner grip: one drag, two numbers.
 *
 * Horizontal movement is this component's own business — it is the frame's
 * width, clamped and applied exactly like a drag. Vertical movement is not:
 * FloatingWindow has no notion of what "taller" means to whatever is in the
 * slot, so it only tracks and reports the raw pixel delta (see the
 * `update:heightDelta` emit) and lets the body's existing grow-then-scroll
 * behaviour do the rest once the caller acts on it.
 */
function onResizeStart(e) {
  // Propagation is stopped on this handler (see the template), so the frame's
  // own pointerdown-raises-it wiring never runs for this press.
  raise()
  resizing.value = true
  resizeStartX = e.clientX
  resizeStartY = e.clientY
  resizeStartWidth = boxWidth.value
  resizeStartDelta = heightDelta.value
  e.currentTarget.setPointerCapture(e.pointerId)
}

function onResizeMove(e) {
  if (!resizing.value) return
  boxWidth.value = clampWidth(resizeStartWidth + (e.clientX - resizeStartX))
  const nextDelta = clampHeightDelta(resizeStartDelta + (e.clientY - resizeStartY))
  if (nextDelta !== heightDelta.value) {
    heightDelta.value = nextDelta
    emit('update:heightDelta', nextDelta)
  }
}

function onResizeEnd(e) {
  if (!resizing.value) return
  resizing.value = false
  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
  clampToViewport()
  saveSize(props.windowId, { width: boxWidth.value, heightDelta: heightDelta.value })
}

/** Back to the size this opened at — the same gesture every knob here resets with. */
function resetSize() {
  boxWidth.value = props.width
  heightDelta.value = 0
  emit('update:heightDelta', 0)
  saveSize(props.windowId, { width: boxWidth.value, heightDelta: 0 })
}

// Touching or tabbing into the frame raises it. Without this, two open windows
// keep whatever order they happened to mount in.
function raise() {
  focusWindow(props.windowId)
}

// Escape closes the window focus is actually in, which is not necessarily the
// topmost one. Stopping propagation keeps EditorScreen's global ladder from
// then closing a second window behind it.
function onEscape(e) {
  e.preventDefault()
  e.stopPropagation()
  // A ladder, not a shortcut to the bottom: Escape puts the help away before it
  // closes the window. Reading the instructions and then losing the whole panel
  // on the key you reach for to dismiss them is the wrong outcome.
  if (helpOpen.value) {
    helpOpen.value = false
    return
  }
  requestClose()
}

// The manager owns the open set, so the shell can close itself; `close` is
// still emitted for owners that need to tear down a preview chain first.
function requestClose() {
  emit('close')
  closeWindow(props.windowId)
}
</script>

<template>
  <div
    ref="frameEl"
    class="win-frame fixed rounded-[18px] overflow-hidden flex flex-col"
    role="dialog"
    :aria-label="label"
    tabindex="-1"
    :style="{
      left: pos.x + 'px', top: pos.y + 'px', width: boxWidth + 'px',
      zIndex: z,
      // One value, read by the chassis, the faceplate and Apply. Passing the
      // hue as a custom property rather than composing each gradient in JS is
      // what lets the stylesheet hold the recipe — and what stops three
      // separately-built colour strings drifting out of agreement.
      '--face': accent,
      animation: dragging || resizing ? 'none' : 'pluginBounceIn 0.3s cubic-bezier(0.34,1.56,0.64,1) both',
      userSelect: dragging || resizing ? 'none' : 'auto',
    }"
    @pointerdown="raise"
    @focusin="raise"
    @keydown.escape="onEscape"
  >
    <!--
      Header (drag handle).

      A 1fr / auto / 1fr grid rather than space-between: identity left,
      monitoring and presets centred, window controls right. Space-between put
      the middle group wherever the two outer groups' widths happened to leave
      it, so DELTA sat visibly off-centre and moved as a brand mark got longer.
      A grid centres the middle column against the WINDOW, which is what makes
      it read as the header's own axis instead of as a gap.
    -->
    <div
      class="win-header grid items-center touch-none h-14 shrink-0 pl-5 pr-[14px]"
      :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <!-- Brand mark, and nothing else. The "EFFECT" kicker went with this
           layout: it said the same thing on fourteen of fifteen windows, and
           the centre column is worth more to the controls that live there. -->
      <span style="font:800 13px/1 'Inter';letter-spacing:.2em;color:#f6f4f3">
        {{ brandLead }}<template v-if="brandTail">&nbsp;<span style="font-weight:500;color:rgba(255,255,255,.45)">{{ brandTail }}</span></template>
      </span>

      <!--
        The centre column: monitoring, presets, or both. DELTA sits here rather
        than beside ON/BYPASS because the two are peers — one says whether the
        effect is in circuit, the other which half of it you are listening to —
        and a tray around the pair made them read as one switch with two
        positions.
      -->
      <div class="flex items-center gap-2">
        <button
          v-if="showDelta"
          type="button"
          class="win-chip"
          :class="{ 'win-chip--on': delta }"
          :disabled="deltaDisabled"
          :aria-pressed="String(delta)"
          :title="deltaTitle"
          @pointerdown.stop
          @click="emit('toggle-delta')"
        >
          <span class="win-chip-text">DELTA</span>
        </button>
        <slot name="header-center" />
      </div>

      <div class="flex items-center justify-end gap-2.5">
        <button
          v-if="showEngage"
          type="button"
          class="win-chip"
          :class="{ 'win-chip--on': engaged }"
          :aria-pressed="String(engaged)"
          title="Engage or bypass the effect"
          @pointerdown.stop
          @click="emit('toggle-engaged')"
        >
          <span class="win-lamp" :class="{ 'win-lamp--on': engaged }"></span>
          <span class="win-chip-text">{{ engaged ? 'ON' : 'BYPASS' }}</span>
        </button>
        <!--
          Help sits with close rather than with the monitoring chips: those two
          are about the WINDOW, where DELTA and ON/BYPASS are about the audio.
          Same reasoning that put DELTA beside ON/BYPASS in the first place.
        -->
        <span v-if="showEngage" class="win-rule win-rule--tall"></span>
        <button
          v-if="help"
          type="button"
          class="win-icon-btn flex items-center justify-center w-[30px] h-[30px] rounded-[10px] border-none cursor-pointer"
          :class="{ 'win-icon-btn--on': helpOpen }"
          :aria-label="helpOpen ? 'Close help' : 'How to use this effect'"
          :aria-expanded="String(helpOpen)"
          :title="helpOpen ? 'Close help' : 'How to use this effect'"
          @pointerdown.stop
          @click="helpOpen = !helpOpen"
        >
          <Icon name="help" :size="15" :stroke-width="2" />
        </button>
        <button
          type="button"
          class="win-icon-btn flex items-center justify-center w-[30px] h-[30px] rounded-[10px] border-none cursor-pointer"
          aria-label="Close window"
          @pointerdown.stop
          @click="requestClose"
        >
          <Icon name="close" :size="14" :stroke-width="2.5" />
        </button>
      </div>
    </div>

    <!--
      The body scrolls; the header and footer do not. min-height:0 is what makes
      that true — without it a flex child refuses to shrink below its content and
      the max-height lands on a box that never gets to enforce it.

      This wrapper carries the faceplate tint, and it is flush: the face runs
      edge to edge between the two hairlines with no inner radius and no padding
      of its own. The wrapper also exists to hang the overflow hint off, which
      has to be positioned against the viewport onto the content rather than
      against the content itself — inside the scroller it would sit at the
      bottom of the scrolled content, which is the one place it is not needed.
    -->
    <div class="relative min-h-0 flex flex-col" :style="{ background }">
      <div
        ref="bodyEl"
        class="win-body min-h-0 overflow-y-auto"
        :style="{ maxHeight: `${bodyMaxHeight}px` }"
        @scroll="updateOverflow"
      >
        <slot />
      </div>

      <!--
        There is more panel below this edge.

        A window taller than the viewport has always scrolled, but its scrollbar
        is a hairline tuned not to look like a rendering fault on a near-black
        faceplate, and on a faceplate the eye reads the bottom edge as the end of
        the instrument. So a panel with controls below the fold looked like a
        panel with no such controls — reported twice as a control that had
        "disappeared". Shortening the panel fixes one viewport; saying so fixes
        every viewport.

        It no longer has to cover for Apply, which is pinned in the footer.
      -->
      <HelpOverlay
        v-if="help && helpOpen"
        :help="help"
        :title="label"
        @close="helpOpen = false"
      />

      <div
        v-show="canScrollDown && !helpOpen"
        class="win-more absolute left-0 right-0 bottom-0 flex items-end justify-center pointer-events-none"
        aria-hidden="true"
      >
        <span
          class="mb-[3px] px-2 py-[2px] rounded-full"
          style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.14em;color:rgba(234,246,248,.75);background:rgba(0,0,0,.55)"
        >MORE ↓</span>
      </div>
    </div>

    <!--
      Footer — the selection on the left, the actions on the right.

      Preview and Apply are one right-aligned action group rather than a full
      width row, because they are not equals: Preview is reversible and Apply
      writes to the timeline. Apply is the only near-white surface in the
      window, so the primary action is also the brightest thing in it.
    -->
    <div v-if="hasFooter" class="win-footer flex items-center gap-5 h-[68px] shrink-0 pl-5 pr-[14px]">
      <span
        v-if="hasSelection"
        class="win-sel"
        style="font:500 10px 'JetBrains Mono',monospace;letter-spacing:.14em;color:rgba(255,255,255,.4);font-variant-numeric:tabular-nums;white-space:nowrap"
      >{{ selectionText }}</span>
      <!-- No selection is not an error state, it is a missing input with an
           obvious default. The notice this replaced could only be read; this
           can be pressed. -->
      <button
        v-else
        type="button"
        class="win-selectall flex items-center gap-2 h-8 px-3.5 rounded-full cursor-pointer whitespace-nowrap"
        title="Select the whole file"
        @click="selectAll()"
      >
        <Icon name="selectAll" :size="13" :stroke-width="2" />
        <span>Select all</span>
      </button>

      <div class="win-actions flex items-center gap-2">
        <!--
          The title sits on the WRAPPER, not on the button.

          Chrome and Safari suppress pointer events on a disabled control, so a
          `title` there never opens — which silently cost the disabled Preview
          the one thing that justified rendering it at all: the sentence saying
          why this effect cannot be auditioned live. A plain span still receives
          hover, so the tooltip works in both states.
        -->
        <span
          v-if="showPreview"
          class="win-preview-slot"
          :class="{ 'win-preview-slot--inert': !previewable }"
          :title="previewable
            ? (previewing ? 'Stop preview' : 'Play the selection through this effect')
            : previewHint"
        >
          <button
            type="button"
            class="win-preview"
            :class="{ 'win-preview--on': previewing }"
            :disabled="!previewable"
            :aria-label="previewable
              ? (previewing ? 'Stop preview' : 'Preview')
              : previewHint"
            :aria-pressed="String(previewing)"
            @click="emit('toggle-preview')"
          >
            <Icon :name="previewing ? 'stop' : 'play'" :size="13" />
            <span class="win-btn-label">{{ previewing ? 'Stop preview' : 'Preview' }}</span>
          </button>
        </span>

        <button
          v-if="showApply"
          type="button"
          class="win-apply"
          :disabled="applyBlocked"
          :title="applyTitle"
          @click="emit('apply')"
        >
          <Icon :name="applyIcon" :size="15" :stroke-width="2.5" />
          <span class="win-btn-label">{{ applyLabel }}</span>
          <span class="win-btn-label-short">{{ applyLabelShort }}</span>
        </button>
      </div>
    </div>

    <!--
      Expand handle — grow-only, hence one icon rather than the usual
      four-way resize cursor: this widens the frame and asks the caller's
      content to grow taller with it, and never the reverse. A window fitted
      by hand to its controls has no shrink case worth offering; the only
      failure mode a smaller-than-designed version would have is controls
      overlapping each other.

      Sits on the frame itself, not inside the scrolling body — a handle that
      scrolled out of reach the moment content grew past the fold would defeat
      the thing it exists to do.
    -->
    <button
      v-if="resizable"
      type="button"
      class="win-resize absolute flex items-end justify-end cursor-nwse-resize"
      style="width:22px;height:22px;right:3px;bottom:3px;touch-action:none"
      aria-label="Drag to expand the display. Double-click to reset to the default size."
      title="Drag to expand · double-click to reset"
      @pointerdown.stop="onResizeStart"
      @pointermove.stop="onResizeMove"
      @pointerup.stop="onResizeEnd"
      @pointercancel.stop="onResizeEnd"
      @dblclick.stop="resetSize"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style="margin:0 4px 4px 0">
        <g stroke="rgba(255,255,255,.7)" stroke-width="1.5" stroke-linecap="round" opacity="0.55">
          <line x1="9" y1="1" x2="1" y2="9" />
          <line x1="9" y1="5" x2="5" y2="9" />
        </g>
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* ── The chassis: hue-locked titanium ───────────────────────────────────────
   The chrome steps LIGHTER than the face it holds, so the faceplate reads as
   the recessed part and the shell as the thing it is set into — and it carries
   the plugin's own hue at 5–9% so the lift cannot clash with the face. A
   hue-FREE titanium was tried at this brightness and does clash: zero chroma
   next to a cold plugin reads as a different material, not a lighter one. */
.win-frame {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--face, #f5a623) 8%, #2a2c2f),
    color-mix(in srgb, var(--face, #f5a623) 5%, #1a1b1d)
  );
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(255, 255, 255, 0.11);
  font-family: 'Inter', system-ui, sans-serif;
  /*
    The footer adapts to the FRAME's width, not the viewport's — a 360px window
    and a 900px one sit side by side on the same screen, so a media query would
    answer the wrong question. It also means a resize drag re-lays the footer
    out for free, with no width threshold duplicated in JS.
  */
  container-type: inline-size;
  container-name: win;
}

/* The hairlines are the whole separation story now that the face is flush, so
   they are stronger than the .06 rule they replaced and each carries a 1px
   black drop line under it — a lit edge and a shadow, which is what reads as
   two planes meeting rather than as a border drawn on one. */
/* The header is the brightest plane in the window — the top of the chassis,
   catching the most light. One percent more hue than the shell with it. */
.win-header {
  grid-template-columns: 1fr auto 1fr;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--face, #f5a623) 9%, #33353a),
    color-mix(in srgb, var(--face, #f5a623) 6%, #212325)
  );
  border-bottom: 1px solid rgba(255, 255, 255, 0.13);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.5);
}

.win-footer {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--face, #f5a623) 8%, #2a2c2f),
    color-mix(in srgb, var(--face, #f5a623) 5%, #1c1e20)
  );
  border-top: 1px solid rgba(255, 255, 255, 0.13);
  box-shadow: 0 -1px 0 rgba(0, 0, 0, 0.5);
}

.win-rule {
  width: 1px;
  height: 16px;
  background: rgba(255, 255, 255, 0.13);
}
.win-rule--tall {
  height: 20px;
}

/* ── Monitoring chips (DELTA, ON/BYPASS) ────────────────────────────────────
   One shape for both, because they are the same kind of control. Off is an
   outline, on is a raised white wash — a value step rather than a colour
   change, which is what keeps the hue out of the chrome. */
.win-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 13px;
  border-radius: 9999px;
  cursor: pointer;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.45);
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}
.win-chip:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.7);
}
.win-chip--on {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.16);
  color: #eaf6f8;
}
.win-chip--on:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.16);
  color: #eaf6f8;
}
.win-chip:active:not(:disabled) {
  filter: brightness(0.96);
}
.win-chip:disabled {
  opacity: 0.4;
  cursor: default;
}
.win-chip:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 2px;
}
.win-chip-text {
  font: 700 9px 'JetBrains Mono', monospace;
  letter-spacing: 0.14em;
}

/* The one lit thing in the chrome. Status green, not the plugin's hue: it
   reports whether the effect is in circuit, which is the same fact whatever
   plugin this is. */
.win-lamp {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--meter-lamp-off, #262c37);
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}
.win-lamp--on {
  background: var(--color-ok, #5fd39a);
  box-shadow: 0 0 7px var(--color-ok, #5fd39a);
}

/* Help and close: the two window-level controls, one shape. */
.win-icon-btn {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.55);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.win-icon-btn:hover {
  background: rgba(255, 255, 255, 0.13);
  color: #f2fafc;
}
/* Held open, so the button reads as a toggle rather than as something that
   fired once. Same white wash the monitoring chips use for their on state. */
.win-icon-btn--on {
  background: rgba(255, 255, 255, 0.14);
  color: #f2fafc;
}
.win-icon-btn:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 2px;
}

/* ── Footer actions ─────────────────────────────────────────────────────── */

/* The actions stay right-aligned whether or not anything is on the left, so a
   window too narrow for the readout does not drag Apply into the middle. */
.win-actions {
  margin-left: auto;
}

.win-btn-label-short {
  display: none;
}

.win-selectall {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.7);
  font: 600 12px 'Inter', system-ui, sans-serif;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.win-selectall:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #eaf6f8;
}
.win-selectall:active {
  filter: brightness(0.96);
}
.win-selectall:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 2px;
}

/*
  Preview holds a fixed width across both its states.

  "Preview" and "Stop preview" are different lengths, so a button sized to its
  own text changes width when it is pressed — which shifts Apply sideways under
  the pointer at the exact moment the user might be reaching for it.
*/
/* Carries the tooltip; contributes nothing to layout of its own. */
.win-preview-slot {
  display: flex;
}

.win-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  flex-shrink: 0;
  min-width: 142px;
  height: 40px;
  padding: 0 18px;
  border-radius: 10px;
  cursor: pointer;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.09);
  color: rgba(255, 255, 255, 0.85);
  font: 600 13px 'Inter', system-ui, sans-serif;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}
.win-preview:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: #eaf6f8;
}
.win-preview--on {
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.22);
  color: #eaf6f8;
}
.win-preview:active:not(:disabled) {
  filter: brightness(0.96);
}
.win-preview:disabled {
  opacity: 0.4;
  cursor: default;
}
.win-preview:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 2px;
}

/* Near-white, and the only near-white surface in the window. It is the primary
   action; it is also the one control here that writes to the file. */
.win-apply {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 40px;
  padding: 0 22px;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  white-space: nowrap;
  /* Warmed by the same hue at 14%: still the brightest surface in the window,
     but belonging to this plugin rather than sitting on it as app chrome. The
     ink is a near-black carrying the same lean, so the pairing holds on every
     hue rather than only on the warm ones. */
  background: color-mix(in srgb, var(--face, #f5a623) 14%, #f4f4f5);
  color: #14100e;
  font: 600 13px 'Inter', system-ui, sans-serif;
  transition: filter 0.15s ease, opacity 0.15s ease;
}
.win-apply:hover:not(:disabled) {
  filter: brightness(1.06);
}
.win-apply:active:not(:disabled) {
  filter: brightness(0.96);
}
.win-apply:disabled {
  opacity: 0.4;
  cursor: default;
}
.win-apply:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 2px;
}

/* The hint's own height is the fade: tall enough that the gradient reads as
   depth rather than as a border, short enough not to dim a control that is
   fully visible. */
.win-more {
  height: 34px;
  background: linear-gradient(rgba(10, 12, 14, 0), rgba(10, 12, 14, 0.92));
}

/* The frame takes focus programmatically on open so keyboard users land inside
   it. That must not paint a ring — only an actual keyboard focus should. */
.win-frame:focus {
  outline: none;
}
.win-frame:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 2px;
}

/* A default scrollbar on a near-black faceplate reads as a rendering fault.
   Only paints when the body actually overflows. */
.win-body {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.28) transparent;
}
.win-body::-webkit-scrollbar {
  width: 9px;
}
.win-body::-webkit-scrollbar-track {
  background: transparent;
}
.win-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.26);
  border: 3px solid transparent;
  background-clip: content-box;
  border-radius: 999px;
}
.win-body::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.28);
  background-clip: content-box;
}

/* Quiet until asked for — a corner grip drawn at full strength on every
   faceplate would compete with the controls it sits beside for no reason
   most of a session, since it is only ever touched once in a while. */
.win-resize {
  background: transparent;
  border: none;
  padding: 0;
  opacity: 0.5;
  transition: opacity 0.15s ease;
}
.win-resize:hover,
.win-resize:focus-visible {
  opacity: 1;
}
.win-resize:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: -2px;
}

/*
  Two steps down from the width the brief was drawn at.

  First the readout goes: it is a reading, the selection bar at the bottom of
  the app carries the same one, and losing it costs nothing that cannot be read
  elsewhere. Only then do the buttons shrink — Preview to its glyph, Apply to
  its short label — because those are the controls, and a control that has
  shrunk is worse than a reading that has gone.
*/
@container win (max-width: 660px) {
  .win-sel {
    display: none;
  }
}

@container win (max-width: 520px) {
  /*
    A Preview that cannot preview does not survive the shrink.

    It is shown disabled at full width on purpose — a greyed control with a
    tooltip teaches that real-time tuning exists on the effects that have it,
    where omitting it teaches nothing. That argument is entirely about the
    LABEL. Stripped to a dimmed triangle it teaches nobody anything and reads
    as a broken button, which is exactly how it was reported.
  */
  .win-preview-slot--inert {
    display: none;
  }
  .win-preview {
    min-width: 0;
    padding: 0;
    width: 40px;
  }
  .win-preview .win-btn-label {
    display: none;
  }
  .win-apply .win-btn-label {
    display: none;
  }
  .win-apply .win-btn-label-short {
    display: inline;
  }
}

@keyframes pluginBounceIn {
  0% { opacity: 0; transform: scale(0.94) translateY(8px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
</style>
