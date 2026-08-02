<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useWindows } from '../../composables/useWindows.js'
import Icon from '../ui/Icon.vue'

/**
 * Shared shell for every floating window.
 *
 * Owns the chrome each one needs and nothing about any one of them: the
 * draggable frame, the header, the engage/bypass pill, the close button and
 * its place in the stacking order. Contents arrive through the default slot.
 *
 * Two variants, because "every effect opens as a window" has to cover both the
 * outboard-gear faces and a four-slider utility without forcing knob artwork
 * onto the latter:
 *
 *   device  — faceplate gradient, letterspaced brand mark, per-plugin accent.
 *             OptoSmooth, FET Punch.
 *   utility — narrow, flat, reads like the rail. Icon + plain title, sliders
 *             and an Apply footer.
 */
const props = defineProps({
  // Registry id. Identifies this window to the manager for focus and for
  // remembering where the user last dragged it.
  windowId: { type: String, required: true },
  z: { type: Number, default: 500 },
  variant: { type: String, default: 'device' }, // 'device' | 'utility'

  width: { type: Number, default: null },
  // Vertical offset of the initial resting place, used only the first time a
  // window opens; after that the remembered position wins.
  top: { type: Number, default: 90 },
  accent: { type: String, default: null },

  // device: two-part brand mark, e.g. "OPTO" + "SMOOTH" — the first word solid,
  // the second lighter.
  brandLead: { type: String, default: '' },
  brandTail: { type: String, default: '' },
  // utility: plain title + icon name.
  title: { type: String, default: '' },
  icon: { type: String, default: '' },

  background: { type: String, default: null },
  headerBackground: { type: String, default: null },

  // The ON/BYPASS pill only makes sense where there is something to bypass.
  showEngage: { type: Boolean, default: true },
  engaged: { type: Boolean, default: false },
})

const emit = defineEmits(['toggle-engaged', 'close'])

const { focusWindow, closeWindow, savePosition, getPosition } = useWindows()

const isUtility = computed(() => props.variant === 'utility')

// Per-variant defaults, so a utility window needs only a title and an icon.
const width = computed(() => props.width ?? (isUtility.value ? 380 : 640))
const accent = computed(() => props.accent ?? (isUtility.value ? '#35d3e6' : '#f5a623'))
const background = computed(() =>
  props.background ?? (isUtility.value
    ? 'linear-gradient(180deg,#161b24,#0e1116)'
    : 'linear-gradient(155deg,#1a1815,#100e0b 60%)')
)
const headerBackground = computed(() =>
  props.headerBackground ?? (isUtility.value
    ? 'linear-gradient(#1b212b,#151a22)'
    : 'linear-gradient(#221f1a,#171410)')
)

const pos = ref({ x: 0, y: props.top })
const dragging = ref(false)
let dragOffsetX = 0
let dragOffsetY = 0

const frameEl = ref(null)
// Whatever had focus when this opened, so closing can hand it back.
let previouslyFocused = null

// Accessible name: the brand mark for device faces, the plain title otherwise.
const label = computed(() =>
  isUtility.value ? props.title : `${props.brandLead} ${props.brandTail}`.trim()
)

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
})

onBeforeUnmount(() => {
  savePosition(props.windowId, pos.value)
  // Return focus only if it is still inside this window; if the user has since
  // clicked the waveform, yanking it back would be worse than leaving it.
  if (frameEl.value?.contains(document.activeElement)) {
    previouslyFocused?.focus?.({ preventScroll: true })
  }
})

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
    class="win-frame fixed rounded-2xl overflow-hidden"
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
      class="flex items-center justify-between touch-none"
      :class="[
        dragging ? 'cursor-grabbing' : 'cursor-grab',
        isUtility ? 'px-4 h-11' : 'px-[18px] h-12',
      ]"
      style="border-bottom:1px solid rgba(255,255,255,.06)"
      :style="{ background: headerBackground }"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <!-- Utility: icon + plain title, matching the rail's voice -->
      <div v-if="isUtility" class="flex items-center gap-2.5 min-w-0">
        <div
          class="w-[26px] h-[26px] rounded-lg flex items-center justify-center shrink-0"
          :style="{ background: `color-mix(in srgb, ${accent} 16%, transparent)`, color: accent }"
        >
          <Icon v-if="icon" :name="icon" :size="14" />
        </div>
        <span class="text-[13px] font-bold text-text truncate">{{ title }}</span>
      </div>

      <!-- Device: brand mark -->
      <div v-else class="flex items-center gap-2.5">
        <div class="w-3.5 h-3.5 rounded-full"
             :style="{
               background: `linear-gradient(135deg, color-mix(in srgb, ${accent} 45%, #ffffff), ${accent})`,
               boxShadow: `0 0 10px color-mix(in srgb, ${accent} 65%, transparent)`,
             }"></div>
        <span style="font:800 13px/1 'Inter';letter-spacing:.22em;color:#f6ecdd">{{ brandLead }}&nbsp;<span style="font-weight:500;color:rgba(255,255,255,.4)">{{ brandTail }}</span></span>
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

    <slot />
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
