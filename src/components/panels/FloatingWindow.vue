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
})

const emit = defineEmits(['toggle-engaged', 'close'])

const { focusWindow, closeWindow, savePosition, getPosition } = useWindows()

const width = computed(() => props.width)
const accent = computed(() => props.accent)

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
// Whatever had focus when this opened, so closing can hand it back.
let previouslyFocused = null

// Accessible name, read off the brand mark.
const label = computed(() => `${props.brandLead} ${props.brandTail}`.trim())

onMounted(() => {
  const remembered = getPosition(props.windowId)
  if (remembered) {
    pos.value = { ...remembered }
  } else {
    // First open: rest near the top-right so the waveform stays visible.
    pos.value = { x: Math.max(16, window.innerWidth - width.value - 40), y: props.top }
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
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportResize)
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
  pos.value.x = Math.min(Math.max(-width.value + 120, pos.value.x), maxX)
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
      left: pos.x + 'px', top: pos.y + 'px', width: width + 'px',
      zIndex: z,
      background,
      boxShadow: '0 24px 60px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.05)',
      fontFamily: `'Inter',system-ui,sans-serif`,
      animation: dragging ? 'none' : 'pluginBounceIn 0.3s cubic-bezier(0.34,1.56,0.64,1) both',
      userSelect: dragging ? 'none' : 'auto',
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
    -->
    <div class="win-body min-h-0 overflow-y-auto" :style="{ maxHeight: `${bodyMaxHeight}px` }">
      <slot />
    </div>
  </div>
</template>

<style scoped>
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
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}
.win-body::-webkit-scrollbar {
  width: 9px;
}
.win-body::-webkit-scrollbar-track {
  background: transparent;
}
.win-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.16);
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

@keyframes pluginBounceIn {
  0% { opacity: 0; transform: scale(0.94) translateY(8px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
</style>
