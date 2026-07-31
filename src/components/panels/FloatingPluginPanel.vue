<script setup>
import { ref, computed, onMounted } from 'vue'
import { faceInk } from '../faceplate.js'

/**
 * Shared shell for the outboard-gear plugin panels (OptoSmooth, FET Punch).
 *
 * Owns the chrome every plugin needs and nothing about any one of them: the
 * floating draggable frame, the header with brand mark, the engage/bypass
 * pill and the close button. Everything gear-specific — knobs, meters,
 * switches — arrives through the default slot.
 */
const props = defineProps({
  width: { type: Number, default: 640 },
  // Vertical offset of the panel's initial resting place.
  top: { type: Number, default: 90 },
  accent: { type: String, default: '#f5a623' },
  // Two-part brand mark, e.g. "OPTO" + "SMOOTH": the first word is set solid,
  // the second in a lighter weight.
  brandLead: { type: String, required: true },
  brandTail: { type: String, default: '' },
  // Faceplate gradients — each plugin gets its own colour.
  background: { type: String, default: 'linear-gradient(155deg,#1a1815,#100e0b 60%)' },
  headerBackground: { type: String, default: 'linear-gradient(#221f1a,#171410)' },
  // Whether the faceplate above is dark or bright. Drives every piece of ink
  // printed on it; pass it to the controls in the slot too.
  face: { type: String, default: 'dark' }, // 'dark' | 'light'
  engaged: { type: Boolean, default: false },
})

const emit = defineEmits(['toggle-engaged', 'close'])

const ink = computed(() => faceInk(props.face, props.accent))

// A dark unit sits in its own shadow; a brushed metal one needs a machined
// edge — a bright top bevel over a dark rim — or it reads as a flat rectangle.
const frameShadow = computed(() =>
  props.face === 'light'
    ? '0 24px 60px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.8),inset 0 0 0 1px rgba(16,22,29,.28)'
    : '0 24px 60px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.05)'
)

// Floating, draggable position — starts near the top-right so it doesn't
// cover the waveform, and stays wherever the user drags it.
const pos = ref({ x: 0, y: props.top })
const dragging = ref(false)
let dragOffsetX = 0
let dragOffsetY = 0

onMounted(() => {
  pos.value.x = Math.max(16, window.innerWidth - props.width - 40)
})

function clampToViewport() {
  const maxX = window.innerWidth - 120
  const maxY = window.innerHeight - 60
  pos.value.x = Math.min(Math.max(-props.width + 120, pos.value.x), maxX)
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
}
</script>

<template>
  <div
    class="fixed z-[500] rounded-2xl overflow-hidden"
    :style="{
      left: pos.x + 'px', top: pos.y + 'px', width: width + 'px',
      background,
      boxShadow: frameShadow,
      fontFamily: `'Inter',system-ui,sans-serif`,
      animation: dragging ? 'none' : 'pluginBounceIn 0.3s cubic-bezier(0.34,1.56,0.64,1) both',
      userSelect: dragging ? 'none' : 'auto',
    }"
  >
    <!-- Header (drag handle) -->
    <div
      class="flex items-center justify-between px-[18px] h-12 touch-none"
      :class="dragging ? 'cursor-grabbing' : 'cursor-grab'"
      :style="{ background: headerBackground, borderBottom: `1px solid ${ink.hairline}` }"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <div class="flex items-center gap-2.5">
        <!-- Power LED. On a bright faceplate the halo does nothing, so the
             lamp gets a bezel instead. -->
        <div class="w-3.5 h-3.5 rounded-full"
             :style="{
               background: `linear-gradient(135deg, color-mix(in srgb, ${ink.accentLit} 45%, #ffffff), ${ink.accentLit})`,
               boxShadow: ink.light
                 ? `inset 0 0 0 1px rgba(16,22,29,.35), 0 1px 2px rgba(16,22,29,.35)`
                 : `0 0 10px color-mix(in srgb, ${accent} 65%, transparent)`,
             }"></div>
        <span :style="{ font: `800 13px/1 'Inter'`, letterSpacing: '.22em', color: ink.strong }">{{ brandLead }}&nbsp;<span :style="{ fontWeight: 500, color: ink.muted }">{{ brandTail }}</span></span>
      </div>

      <!-- Optional middle slot (preset selector and the like) -->
      <slot name="header-center" />

      <div class="flex items-center gap-2">
        <button
          class="flex items-center gap-2 px-3 py-1.5 rounded-full border cursor-pointer transition-opacity"
          :style="{
            background: engaged || !ink.light ? ink.accentWash : ink.well,
            borderColor: engaged || !ink.light ? ink.accentEdge : ink.line,
            opacity: engaged ? 1 : ink.light ? 0.8 : 0.55,
          }"
          @pointerdown.stop
          @click="emit('toggle-engaged')"
        >
          <span class="w-[7px] h-[7px] rounded-full"
                :style="{
                  background: ink.accentLit,
                  boxShadow: ink.light ? 'inset 0 0 0 1px rgba(16,22,29,.3)' : `0 0 7px ${accent}`,
                }"></span>
          <span :style="{ font: `700 9px 'JetBrains Mono',monospace`, letterSpacing: '.14em', color: engaged || !ink.light ? ink.accentInk : ink.muted }">{{ engaged ? 'ON' : 'BYPASS' }}</span>
        </button>
        <button
          class="flex items-center justify-center w-7 h-7 rounded-full border-none cursor-pointer"
          :style="{ background: ink.well, color: ink.label }"
          @pointerdown.stop
          @click="emit('close')"
        >
          <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-none stroke-current" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <slot />
  </div>
</template>

<style scoped>
@keyframes pluginBounceIn {
  0% { opacity: 0; transform: scale(0.94) translateY(8px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
</style>
