<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useWindows } from '../../composables/useWindows.js'
import { useEditorState } from '../../composables/useEditorState.js'
import {
  chainWindowMounted, chainWindowUnmounted, chainStatusFor,
} from '../../composables/usePluginChain.js'
import { helpFor } from '../../content/help/index.js'
import { resolveHarnessChrome } from '../../ui/harnessChrome.js'
import Icon from '../ui/Icon.vue'
import HelpOverlay from './HelpOverlay.vue'
import ModulaPresetBrowser from '../modula/ModulaPresetBrowser.vue'
import ModulaLedPill from '../modula/ModulaLedPill.vue'

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

  /**
   * 'classic' | 'modula'. MODULA is the control-surface kit's chrome
   * (docs/design/modula): one lifted chassis with the face set into it, the
   * name in the plugin's hue over white, a round help and close, the preset
   * browser in the centre, ON/BYPASS as a lamp pill in a fixed slot, and a
   * footer of Select all · Preview · Apply. Opt-in per plugin, so the panels
   * convert one at a time; everything else this component does — dragging,
   * focus, help, the scroll ceiling, the footer's narrow-window steps — is
   * the same in both.
   */
  design: { type: String, default: 'classic' },
  /**
   * A `usePluginPresets` instance. Under Modula it puts the preset browser in
   * the header's centre column (classic windows slot PresetMenu themselves).
   */
  presets: { type: Object, default: null },
  presetsDisabled: { type: Boolean, default: false },
  presetsDisabledHint: { type: String, default: '' },
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

const { openWindow, focusWindow, closeWindow, savePosition, getPosition, saveSize, getSize } = useWindows()
// The harness reads the selection itself rather than taking it as a prop.
// Every plugin was passing the same `hasSelection` through to the same row and
// printing the same unmet message; one readout that is right by construction
// beats fifteen that agree by convention.
const { state, hasSelection, selectAll } = useEditorState()

const accent = computed(() => props.accent)
const modula = computed(() => props.design === 'modula')

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

/**
 * Which chassis this window wears — see `ui/harnessChrome.js`.
 *
 * Resolved once per window rather than per render: it cannot change while a
 * window is open, and re-reading it on every paint would mean a `localStorage`
 * hit inside the render path.
 */
const chrome = resolveHarnessChrome()

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

// A caller may change its natural width while open (the parametric EQ sizes
// itself to its band count). Move by the same amount, so a manual widening is
// kept as an offset rather than snapped away, then re-fit to the viewport.
// Growing slides the window left as far as it needs to keep its right edge
// on screen, so a band added near the edge never pushes the strip off it.
watch(() => props.width, (next, prev) => {
  const w = Math.max(minWidthPx.value, boxWidth.value + (next - prev))
  const overflow = pos.value.x + w - (window.innerWidth - 20)
  if (overflow > 0) pos.value.x = Math.max(16, pos.value.x - overflow)
  boxWidth.value = clampWidth(w)
  clampToViewport()
})

function clampWidth(w) {
  // Leaves the same margin clampToViewport does, so a fully-expanded window
  // still reads as a window rather than a panel welded to the screen edge.
  const maxW = Math.max(minWidthPx.value, window.innerWidth - pos.value.x - 20)
  return Math.min(Math.max(minWidthPx.value, w), maxW)
}

function clampHeightDelta(d) {
  return Math.min(props.maxHeightDelta, Math.max(0, d))
}

// The faceplate's tint comes from `--chrome-face-*` in the stylesheet, not from
// here, because it is one of the two things the chassis variants disagree
// about. Building it in script put an inline style on every window, which wins
// over the class — so the dark chassis rendered its own face at the light
// chassis's values and 5b's whole point (a face lit against a darker shell)
// came out at a fraction of its contrast. Only a caller with a hand-tuned
// faceplate overrides it now.
const background = computed(() => props.background)

const hasFooter = computed(() => props.showApply || props.showPreview)
// A selection is what Apply acts on. Without one the footer offers to make one
// rather than printing a notice about its absence — "select all" is a button,
// "make a selection to apply" is a complaint.
const applyBlocked = computed(() => !!inChain.value || props.applyDisabled || (props.requiresSelection && !hasSelection.value))
const applyTitle = computed(() => {
  if (inChain.value) return 'This plugin is in the Plugin Chain — apply it from the chain'
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

// ── Chain membership ────────────────────────────────────────────────────────
// A plugin with a slot in the Plugin Chain says so (IN CHAIN · n, which opens
// the rack) and has NO APPLY of its own: the chain's Apply is the one that
// writes it, in order with the rest. Joining happens only from the chain's
// Add picker, so a plugin outside the chain shows nothing here.
const inChain = computed(() => {
  const status = chainStatusFor(props.windowId)
  return status?.member ? status : null
})

// Accessible name, read off the brand mark.
const label = computed(() => `${props.brandLead} ${props.brandTail}`.trim())

onMounted(() => {
  // A plugin keeps playing in the chain while its window is closed, with its
  // meters stopped; reopening the window brings them back.
  chainWindowMounted(props.windowId)

  // A window that was resized before is reopened at the size it was left, the
  // same courtesy the position gets. Restored before the position fallback
  // below, which reads it for the first-open case.
  const rememberedSize = getSize(props.windowId)
  if (rememberedSize) {
    // `extra` is how far a drag took the window past its natural width, so a
    // window whose natural width moves (the EQ follows its band count)
    // reopens at today's width plus the same widening, not at a stale total.
    boxWidth.value = clampWidth(rememberedSize.extra != null
      ? props.width + rememberedSize.extra
      : rememberedSize.width ?? props.width)
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
  // A window allowed to be narrower than its natural width (`minWidth`) opens
  // no wider than the viewport has room for; the rest is a no-op.
  boxWidth.value = clampWidth(boxWidth.value)
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
  // However the window closed — ×, Escape, or replaced by another plugin.
  chainWindowUnmounted(props.windowId)
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
  saveSize(props.windowId, {
    width: boxWidth.value,
    extra: boxWidth.value - props.width,
    heightDelta: heightDelta.value,
  })
}

/** Back to the size this opened at — the same gesture every knob here resets with. */
function resetSize() {
  boxWidth.value = props.width
  heightDelta.value = 0
  emit('update:heightDelta', 0)
  saveSize(props.windowId, { width: boxWidth.value, extra: 0, heightDelta: 0 })
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
    :data-chrome="chrome"
    :data-design="design"
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
      <!--
        Identity, and the one thing that explains it.

        The "EFFECT" kicker went with this layout: it said the same thing on
        fourteen of fifteen windows, and the centre column is worth more to the
        controls that live there.

        HELP SITS HERE NOW, NEXT TO THE NAME, and the rule between them is what
        makes that read as a pair rather than as a longer brand mark. It used to
        sit beside close, on the argument that both are about the WINDOW where
        DELTA and ON/BYPASS are about the audio. That argument was sound about
        close and wrong about help: close is a window control, but help is about
        the EFFECT — what this plugin does and how to work it — so its subject is
        the name it now sits beside, not the frame around it. What is left in the
        right-hand group is genuinely uniform: the audio switches, a rule, and
        the one button that disposes of the window.
      -->
      <div class="flex items-center gap-2.5">
        <!-- Modula: one word mark in the plugin's hue over white, no rule. -->
        <span v-if="modula" class="win-brand-m">{{ brandLead }}{{ brandTail }}</span>
        <span v-else style="font:800 13px/1 'Inter';letter-spacing:.2em;color:#f6f4f3">
          {{ brandLead }}<template v-if="brandTail">&nbsp;<span style="font-weight:500;color:rgba(255,255,255,.85)">{{ brandTail }}</span></template>
        </span>
        <!-- The short rule, not `--tall`: it is dividing a 13 px word from an
             icon, where the tall one divides two 30 px chips. -->
        <span v-if="help && !modula" class="win-rule"></span>
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
          <span v-if="modula" style="font:700 12px/1 'Inter',system-ui,sans-serif">?</span>
          <Icon v-else name="help" :size="15" :stroke-width="2" />
        </button>
      </div>

      <!--
        The centre column: monitoring, presets, or both. DELTA sits here rather
        than beside ON/BYPASS because the two are peers — one says whether the
        effect is in circuit, the other which half of it you are listening to —
        and a tray around the pair made them read as one switch with two
        positions.
      -->
      <div class="flex items-center gap-2">
        <!-- Modula: a lamp pill in the kit's second hue — DELTA is monitoring,
             a mode rather than a value, the hue the kit gives modes. -->
        <ModulaLedPill
          v-if="showDelta && modula"
          size="sm" label="DELTA" color="var(--m-second)"
          :model-value="delta" :disabled="deltaDisabled" :title="deltaTitle"
          @pointerdown.stop
          @update:model-value="emit('toggle-delta')"
        />
        <button
          v-if="showDelta && !modula"
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
        <ModulaPresetBrowser
          v-if="modula && presets"
          class="win-presets-m"
          :presets="presets"
          :disabled="presetsDisabled"
          :disabled-hint="presetsDisabledHint"
        />
        <!-- Says BYPASSED with the chain: the plugin's own lamp can read ON
             while the chain around it is out of circuit and nothing is heard. -->
        <button
          v-if="inChain"
          type="button"
          class="win-chain-pill is-member"
          :class="{ 'is-bypassed': inChain.chainBypassed }"
          :title="inChain.chainBypassed ? 'The Plugin Chain is bypassed — open it to turn it on' : 'Open the Plugin Chain'"
          @pointerdown.stop
          @click="openWindow('plugin-chain')"
        >IN CHAIN · {{ inChain.position }}{{ inChain.chainBypassed ? ' · BYPASSED' : '' }}</button>
        <slot name="header-center" />
      </div>

      <div class="flex items-center justify-end gap-2.5">
        <!-- Modula: a fixed 96 px slot, so ON and BYPASS (different lengths)
             never move the close button. -->
        <span v-if="showEngage && modula" class="win-engage-slot-m">
          <button
            type="button"
            class="win-pill-m"
            :aria-pressed="String(engaged)"
            title="Engage or bypass the effect"
            @pointerdown.stop
            @click="emit('toggle-engaged')"
          >
            <span class="win-pill-lamp-m" :class="{ 'is-on': engaged }"></span>
            <span class="win-pill-text-m" :class="{ 'is-on': engaged }">{{ engaged ? 'ON' : 'BYPASS' }}</span>
          </button>
        </span>
        <button
          v-if="showEngage && !modula"
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
          The rule separates what changes the AUDIO from what disposes of the
          WINDOW. Help used to sit on the right of it, which is where the pair
          stopped being uniform — see the note beside the brand mark.
        -->
        <span v-if="showEngage" class="win-rule win-rule--tall"></span>
        <button
          type="button"
          class="win-icon-btn flex items-center justify-center w-[30px] h-[30px] rounded-[10px] border-none cursor-pointer"
          aria-label="Close window"
          @pointerdown.stop
          @click="requestClose"
        >
          <span v-if="modula" style="font:400 17px/1 'Inter',system-ui,sans-serif;margin-top:-1px">×</span>
          <Icon v-else name="close" :size="14" :stroke-width="2.5" />
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
    <div class="win-face relative min-h-0 flex flex-col" :style="background ? { background } : null">
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
        <span v-if="modula" class="win-selectall-box-m"></span>
        <Icon v-else name="selectAll" :size="13" :stroke-width="2" />
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
            <span v-if="modula" class="win-play-m" :class="{ 'is-on': previewing }"></span>
            <Icon v-else :name="previewing ? 'stop' : 'play'" :size="13" />
            <span class="win-btn-label">{{ previewing ? (modula ? 'Stop' : 'Stop preview') : 'Preview' }}</span>
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
          <span v-if="modula" style="font:700 12px/1 'Inter',system-ui,sans-serif">✓</span>
          <Icon v-else :name="applyIcon" :size="15" :stroke-width="2.5" />
          <span class="win-btn-label">{{ inChain ? 'Applies with the chain' : applyLabel }}</span>
          <span class="win-btn-label-short">{{ inChain ? 'In chain' : applyLabelShort }}</span>
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
/* ── The chassis: hue-locked, in two exposures ──────────────────────────────

   Both variants mix the plugin's own accent into the chrome at 5–9%. That part
   is settled: it is what stops the chassis clashing with any faceplate, and a
   hue-FREE chrome was tried and does clash — zero chroma next to a cold plugin
   reads as a different material rather than a lighter one.

   What differs is which side of the face the chrome sits on, and the whole
   difference is these tokens. Every rule below reads them, so neither variant
   can acquire a value the other forgot.

     light (5a)  chrome ABOVE the face: the faceplate is the recessed part
     dark  (5b)  chrome BELOW the face: the faceplate is the only lit surface

   Two things move with the exposure beyond the greys. The dark chassis takes a
   1px white BEVEL along its top edge — without it a near-black shell reads as
   a hole rather than as metal — and its hairlines drop to .10 over a heavier
   black drop line, because separation on a dark chassis comes from the shadow
   rather than from the lit edge. The face is mixed HOTTER under dark chrome
   (12/5% against 10/4%): it is carrying the whole window's light there. */
.win-frame {
  --chrome-shell-top: color-mix(in srgb, var(--face, #f5a623) 8%, #2a2c2f);
  --chrome-shell-bottom: color-mix(in srgb, var(--face, #f5a623) 5%, #1a1b1d);
  --chrome-header-top: color-mix(in srgb, var(--face, #f5a623) 9%, #33353a);
  --chrome-header-bottom: color-mix(in srgb, var(--face, #f5a623) 6%, #212325);
  --chrome-footer-top: color-mix(in srgb, var(--face, #f5a623) 8%, #2a2c2f);
  --chrome-footer-bottom: color-mix(in srgb, var(--face, #f5a623) 5%, #1c1e20);
  --chrome-face-top: color-mix(in srgb, var(--face, #f5a623) 10%, #16191e);
  --chrome-face-bottom: color-mix(in srgb, var(--face, #f5a623) 4%, #0b0d10);
  --chrome-help-top: color-mix(in srgb, var(--face, #f5a623) 7%, #171b21);
  --chrome-help-bottom: color-mix(in srgb, var(--face, #f5a623) 4%, #101319);
  --chrome-hairline: rgba(255, 255, 255, 0.13);
  --chrome-drop: rgba(0, 0, 0, 0.5);
  --chrome-frame-shadow: 0 24px 60px rgba(0, 0, 0, 0.55),
    inset 0 0 0 1px rgba(255, 255, 255, 0.11);
  --chrome-close-bg: rgba(255, 255, 255, 0.06);
  --chrome-close-fg: rgba(255, 255, 255, 0.55);

  background: linear-gradient(180deg, var(--chrome-shell-top), var(--chrome-shell-bottom));
  box-shadow: var(--chrome-frame-shadow);
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
.win-frame[data-chrome='dark'] {
  --chrome-shell-top: color-mix(in srgb, var(--face, #f5a623) 8%, #101215);
  --chrome-shell-bottom: color-mix(in srgb, var(--face, #f5a623) 5%, #08090b);
  --chrome-header-top: color-mix(in srgb, var(--face, #f5a623) 9%, #14171a);
  --chrome-header-bottom: color-mix(in srgb, var(--face, #f5a623) 6%, #0c0e10);
  --chrome-footer-top: color-mix(in srgb, var(--face, #f5a623) 8%, #111316);
  --chrome-footer-bottom: color-mix(in srgb, var(--face, #f5a623) 5%, #090a0c);
  --chrome-face-top: color-mix(in srgb, var(--face, #f5a623) 12%, #191c21);
  --chrome-face-bottom: color-mix(in srgb, var(--face, #f5a623) 5%, #0d0f12);
  --chrome-help-top: color-mix(in srgb, var(--face, #f5a623) 9%, #181b20);
  --chrome-help-bottom: color-mix(in srgb, var(--face, #f5a623) 5%, #0d1013);
  --chrome-hairline: rgba(255, 255, 255, 0.1);
  --chrome-drop: rgba(0, 0, 0, 0.7);
  /* The bevel is what keeps this reading as metal rather than as a hole. */
  --chrome-frame-shadow: 0 24px 60px rgba(0, 0, 0, 0.6),
    inset 0 1px 0 rgba(255, 255, 255, 0.09),
    inset 0 0 0 1px rgba(255, 255, 255, 0.07);
  --chrome-close-bg: rgba(255, 255, 255, 0.05);
  --chrome-close-fg: rgba(255, 255, 255, 0.5);
}

/* The faceplate's default tint, and the second thing the two chassis disagree
   about: 5a sets the face below the shell, 5b lifts it above.

   The Soft Clipper overrides it inline and is the only window that does. Its
   faceplate is deliberately the lightest surface in the app so its sunken
   display and control band read as recessed, which is a statement about that
   panel rather than about the chassis, and it holds either way round. FET
   Punch used to override it too, with the pre-hue-lock default minus the tint
   — no reason recorded, and it made that one window's face hue-free under 5a
   and darker than its own header under 5b. That was a leftover, not a tune. */
.win-face {
  background: linear-gradient(155deg, var(--chrome-face-top), var(--chrome-face-bottom) 60%);
}

/* The header is the brightest plane in the window — the top of the chassis,
   catching the most light. One percent more hue than the shell with it. */
.win-header {
  grid-template-columns: 1fr auto 1fr;
  background: linear-gradient(180deg, var(--chrome-header-top), var(--chrome-header-bottom));
  border-bottom: 1px solid var(--chrome-hairline);
  box-shadow: 0 1px 0 var(--chrome-drop);
}

.win-footer {
  background: linear-gradient(180deg, var(--chrome-footer-top), var(--chrome-footer-bottom));
  border-top: 1px solid var(--chrome-hairline);
  box-shadow: 0 -1px 0 var(--chrome-drop);
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
.win-chain-pill {
  height: 26px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, .14);
  background: rgba(255, 255, 255, .04);
  color: rgba(234, 246, 248, .7);
  font: 700 9.5px/1 'JetBrains Mono', monospace;
  letter-spacing: .12em;
  white-space: nowrap;
  cursor: pointer;
}
.win-chain-pill:hover { background: rgba(255, 255, 255, .09); color: #eaf6f8; }
.win-chain-pill.is-member {
  border-color: rgba(232, 163, 61, .45);
  color: #e8a33d;
}
.win-chain-pill.is-member.is-bypassed {
  border-color: rgba(255, 255, 255, .14);
  color: rgba(234, 246, 248, .55);
}
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
  background: var(--chrome-close-bg);
  color: var(--chrome-close-fg);
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
  background: #ffffff;
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

/* ── MODULA ─────────────────────────────────────────────────────────────────
   The control-surface kit's chrome (docs/design/modula, "PLUGIN CHROME"). One
   lifted chassis, no separate face plane: the face is the chassis, inset by
   14 px, and the header and footer are separated from it by a dark rule over
   a 4 % lit edge rather than by planes of their own. */
.win-frame[data-design='modula'] {
  border-radius: 22px;
  background: var(--m-chassis);
  box-shadow: 0 60px 90px -50px rgba(0, 0, 0, 1), inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.6);
  color: var(--m-ink);
}
/* Space-between, as the kit draws it: the preset browser sits between the
   name and the switches rather than on the window's axis. A centred column
   needs twice the wider side's width, which a long name like CAMBRIDGE
   INFLATOR turns into an overflow. */
[data-design='modula'] .win-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 58px;
  padding: 2px 18px 0;
  gap: 16px;
  background: transparent;
  border-bottom: 1px solid rgba(0, 0, 0, 0.32);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04);
}
[data-design='modula'] .win-face {
  background: transparent;
}
[data-design='modula'] .win-body {
  padding: 14px;
}
[data-design='modula'] .win-footer {
  height: 60px;
  padding: 0 16px;
  background: transparent;
  border-top: 1px solid rgba(0, 0, 0, 0.32);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}
.win-brand-m {
  white-space: nowrap;
  font: 800 13px/1 var(--m-font-ui);
  letter-spacing: 0.14em;
  color: color-mix(in srgb, var(--face, #e8a33d) 20%, #fff);
}
/* Help and close: round, raised, no fill. */
[data-design='modula'] .win-icon-btn {
  border-radius: 50%;
  background: transparent;
  color: var(--m-ink-2);
  box-shadow: 0 6px 12px -6px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 0 1px rgba(0, 0, 0, 0.65);
}
[data-design='modula'] .win-icon-btn:hover,
[data-design='modula'] .win-icon-btn--on {
  background: rgba(255, 255, 255, 0.06);
  color: var(--m-ink);
}
[data-design='modula'] .win-header > div {
  min-width: 0;
}
[data-design='modula'] .win-header > div:first-child,
[data-design='modula'] .win-header > div:last-child {
  flex: none;
}
.win-presets-m {
  width: 200px;
  flex: 0 1 200px;
}
[data-design='modula'] .win-rule--tall {
  height: 22px;
  margin: 0 3px;
  background: rgba(0, 0, 0, 0.45);
  box-shadow: 1px 0 0 rgba(255, 255, 255, 0.06);
}
.win-engage-slot-m {
  width: 96px;
  flex: none;
  display: flex;
  justify-content: flex-end;
}
.win-pill-m {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  box-sizing: border-box;
  padding: 0 13px;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  background: transparent;
  box-shadow: var(--m-shadow-raised);
}
.win-pill-m:hover { filter: brightness(1.08); }
.win-pill-m:focus-visible { outline: 2px solid #7fe9f6; outline-offset: 2px; }
.win-pill-lamp-m {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--m-lamp-off);
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.7);
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
}
.win-pill-lamp-m.is-on { background: var(--m-ok); box-shadow: 0 0 6px var(--m-ok); }
.win-pill-text-m {
  font: 700 10px/1 var(--m-font-ui);
  letter-spacing: 0.14em;
  color: var(--m-ink-3);
}
.win-pill-text-m.is-on { color: var(--m-ink); }

/* Footer: Select all is a dashed square in an outline; Preview is raised;
   Apply is the light primary. All 32 px, radius 9. */
[data-design='modula'] .win-selectall {
  height: 32px;
  padding: 0 12px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--m-ink-3);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
}
[data-design='modula'] .win-selectall:hover { color: var(--m-ink); box-shadow: inset 0 0 0 1px rgba(232, 163, 61, 0.7); }
.win-selectall-box-m { width: 10px; height: 10px; box-sizing: border-box; border-radius: 2px; border: 1.5px dashed currentColor; }
[data-design='modula'] .win-sel { color: var(--m-ink-4); }
[data-design='modula'] .win-preview {
  min-width: 0;
  height: 32px;
  padding: 0 14px;
  gap: 8px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--m-ink);
  font: 600 12px var(--m-font-ui);
  box-shadow: var(--m-shadow-raised);
}
[data-design='modula'] .win-preview:hover:not(:disabled) { background: rgba(255, 255, 255, 0.05); }
[data-design='modula'] .win-preview--on { background: transparent; }
.win-play-m { width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent; border-left: 8px solid var(--m-ink); }
.win-play-m.is-on { border-left-color: var(--m-accent); }
[data-design='modula'] .win-apply {
  height: 32px;
  padding: 0 14px;
  gap: 7px;
  border-radius: 9px;
  color: #1b1d21;
  font: 600 12px var(--m-font-ui);
  background: linear-gradient(180deg, #f2f4f7, #d9dde3);
  box-shadow: inset 0 1px 0 #ffffff, 0 0 0 1px rgba(0, 0, 0, 0.55), 0 6px 12px -6px rgba(0, 0, 0, 0.9);
}

@keyframes pluginBounceIn {
  0% { opacity: 0; transform: scale(0.94) translateY(8px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
</style>
