<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useWindows } from '../../composables/useWindows.js'
import Icon from '../ui/Icon.vue'

/**
 * Shared shell for every effect window — the outboard-gear faceplate.
 *
 * Owns the chrome each one needs and nothing about any one of them: the
 * draggable frame, the brand header, the engage/bypass pill, the close button
 * and its place in the stacking order. Contents arrive through the default slot.
 *
 * There used to be a second, flat "utility" variant for the effects that only
 * had a few sliders. Two looks for one kind of object is the inconsistency this
 * whole restructure exists to remove, so every effect now wears the faceplate
 * and the faceplate is derived from the plugin's own accent — a family
 * resemblance that costs each window one colour.
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
  accent: { type: String, default: '#f5a623' },

  // Two-part brand mark, e.g. "OPTO" + "SMOOTH" — the first word solid, the
  // second lighter.
  brandLead: { type: String, required: true },
  brandTail: { type: String, default: '' },

  // Override the derived faceplate. Only FET Punch does — its steel-blue accent
  // tints too cold through the generic recipe, so it keeps a hand-tuned pair.
  background: { type: String, default: null },
  headerBackground: { type: String, default: null },

  // The ON/BYPASS pill only makes sense where there is something to bypass —
  // i.e. effects that preview in real time.
  showEngage: { type: Boolean, default: true },
  engaged: { type: Boolean, default: false },

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
  'toggle-engaged', 'close',
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

const accent = computed(() => props.accent)

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
// tint this weak is what lets six different hues still read as one product.
const background = computed(() =>
  props.background ??
  `linear-gradient(155deg, color-mix(in srgb, ${accent.value} 10%, #16191e), color-mix(in srgb, ${accent.value} 4%, #0b0d10) 60%)`
)
const headerBackground = computed(() =>
  props.headerBackground ??
  `linear-gradient(color-mix(in srgb, ${accent.value} 14%, #1c2026), color-mix(in srgb, ${accent.value} 7%, #121418))`
)

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
// Header height, fixed by its own h-12 class. The body gets what is left.
const HEADER_PX = 48

const viewportH = ref(typeof window === 'undefined' ? 800 : window.innerHeight)

/**
 * How tall the scrolling body may be.
 *
 * Windows are sized by their contents and some of them are tall — VoiceRx runs
 * a 200 px plot, a findings list, a knob row and an apply bar, which together
 * outrun a laptop viewport. The frame is overflow:hidden, so before this the
 * overflow was not merely off screen but unreachable: Apply could sit below the
 * fold with no scrollbar anywhere and no way to drag the window high enough to
 * reveal it.
 */
const bodyMaxHeight = computed(() => Math.max(
  MIN_BODY_PX,
  viewportH.value - pos.value.y - HEADER_PX - VIEWPORT_MARGIN,
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
    class="win-frame fixed rounded-2xl overflow-hidden flex flex-col"
    role="dialog"
    :aria-label="label"
    tabindex="-1"
    :style="{
      left: pos.x + 'px', top: pos.y + 'px', width: boxWidth + 'px',
      zIndex: z,
      background,
      boxShadow: '0 24px 60px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.05)',
      fontFamily: `'Inter',system-ui,sans-serif`,
      animation: dragging || resizing ? 'none' : 'pluginBounceIn 0.3s cubic-bezier(0.34,1.56,0.64,1) both',
      userSelect: dragging || resizing ? 'none' : 'auto',
    }"
    @pointerdown="raise"
    @focusin="raise"
    @keydown.escape="onEscape"
  >
    <!-- Header (drag handle) -->
    <div
      class="flex items-center justify-between touch-none px-[18px] h-12 shrink-0"
      :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
      style="border-bottom:1px solid rgba(255,255,255,.06)"
      :style="{ background: headerBackground }"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <!-- Brand mark -->
      <div class="flex items-center gap-2.5">
        <div class="w-3.5 h-3.5 rounded-full"
             :style="{
               background: `linear-gradient(135deg, color-mix(in srgb, ${accent} 45%, #ffffff), ${accent})`,
               boxShadow: `0 0 10px color-mix(in srgb, ${accent} 65%, transparent)`,
             }"></div>
        <!-- Brand text is a very light tint of the accent rather than a fixed
             cream, which was tuned for OptoSmooth's amber and read wrong on
             every other hue. -->
        <span
          style="font:800 13px/1 'Inter';letter-spacing:.22em"
          :style="{ color: `color-mix(in srgb, ${accent} 20%, #ffffff)` }"
        >{{ brandLead }}&nbsp;<span style="font-weight:500;color:rgba(255,255,255,.4)">{{ brandTail }}</span></span>
      </div>

      <!-- Optional middle slot (preset selector and the like) -->
      <slot name="header-center" />

      <div class="flex items-center gap-2">
        <button
          v-if="showEngage"
          class="flex items-center gap-2 px-3 py-1.5 rounded-full border cursor-pointer transition-opacity"
          :style="{
            background: `color-mix(in srgb, ${accent} 14%, transparent)`,
            borderColor: `color-mix(in srgb, ${accent} 40%, transparent)`,
            opacity: engaged ? 1 : 0.55,
          }"
          :aria-pressed="String(engaged)"
          @pointerdown.stop
          @click="emit('toggle-engaged')"
        >
          <span class="w-[7px] h-[7px] rounded-full" :style="{ background: accent, boxShadow: `0 0 7px ${accent}` }"></span>
          <span :style="{ font: `700 9px 'JetBrains Mono',monospace`, letterSpacing: '.14em', color: `color-mix(in srgb, ${accent} 65%, #ffffff)` }">{{ engaged ? 'ON' : 'BYPASS' }}</span>
        </button>
        <button
          class="win-close flex items-center justify-center w-7 h-7 rounded-full border-none cursor-pointer"
          aria-label="Close window"
          @pointerdown.stop
          @click="requestClose"
        >
          <Icon name="close" :size="14" :stroke-width="2.5" />
        </button>
      </div>
    </div>

    <!--
      The body scrolls; the header does not. min-height:0 is what makes that
      true — without it a flex child refuses to shrink below its content and the
      max-height lands on a box that never gets to enforce it.

      The wrapper exists only to hang the overflow hint off, which has to be
      positioned against the viewport onto the content rather than against the
      content itself — inside the scroller it would sit at the bottom of the
      scrolled content, which is the one place it is not needed.
    -->
    <div class="relative min-h-0 flex flex-col">
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
      -->
      <div
        v-show="canScrollDown"
        class="win-more absolute left-0 right-0 bottom-0 flex items-end justify-center pointer-events-none"
        aria-hidden="true"
      >
        <span
          class="mb-[3px] px-2 py-[2px] rounded-full"
          :style="{
            font: `700 8px 'JetBrains Mono',monospace`,
            letterSpacing: '.14em',
            color: `color-mix(in srgb, ${accent} 55%, #ffffff)`,
            background: 'rgba(0,0,0,.55)',
          }"
        >MORE ↓</span>
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
        <g :stroke="`color-mix(in srgb, ${accent} 70%, #ffffff)`" stroke-width="1.5" stroke-linecap="round" opacity="0.55">
          <line x1="9" y1="1" x2="1" y2="9" />
          <line x1="9" y1="5" x2="5" y2="9" />
        </g>
      </svg>
    </button>
  </div>
</template>

<style scoped>
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

.win-close {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.55);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.win-close:hover {
  background: rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.9);
}
.win-close:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 2px;
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

@keyframes pluginBounceIn {
  0% { opacity: 0; transform: scale(0.94) translateY(8px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
</style>
