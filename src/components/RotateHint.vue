<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import Icon from './ui/Icon.vue'

/**
 * "Rotate for more room" — shown on a phone held upright.
 *
 * The editor is usable in portrait but cramped: the waveform is narrow, the
 * toolbar and selection actions have to scroll or shrink to icons, and plugin
 * faceplates are scaled to about half size. Landscape fixes all of that at
 * once, so asking is cheaper than designing a portrait layout.
 *
 * Dismissed for good with ×. The memory is a per-browser convenience, so a
 * storage that throws (private mode) just means the hint can come back.
 */
const STORAGE_KEY = 'wavely:rotate-hint-dismissed'
const QUERY = '(orientation: portrait) and (max-width: 639.98px)'

const portraitPhone = ref(false)
const dismissed = ref(false)
let mq = null

function update() { portraitPhone.value = !!mq?.matches }

function dismiss() {
  dismissed.value = true
  try { localStorage.setItem(STORAGE_KEY, '1') } catch { /* storage unavailable */ }
}

onMounted(() => {
  try { dismissed.value = localStorage.getItem(STORAGE_KEY) === '1' } catch { /* storage unavailable */ }
  if (typeof window.matchMedia !== 'function') return
  mq = window.matchMedia(QUERY)
  update()
  mq.addEventListener?.('change', update)
})

onUnmounted(() => mq?.removeEventListener?.('change', update))
</script>

<template>
  <div
    v-if="portraitPhone && !dismissed"
    class="rotate-hint flex items-center gap-2 px-3 py-[7px] shrink-0 text-[11.5px] font-semibold"
    role="status"
  >
    <svg viewBox="0 0 24 24" class="w-4 h-4 shrink-0 fill-none stroke-current" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="7" y="2" width="10" height="20" rx="2" transform="rotate(-90 12 12)"/>
      <path d="M3 8a9 9 0 0 1 4-5M7 3v3H4"/>
    </svg>
    <span class="flex-1 min-w-0">Turn your phone sideways for more room to edit.</span>
    <button
      type="button"
      class="rotate-hint__close w-[26px] h-[26px] shrink-0 flex items-center justify-center rounded-[7px]"
      aria-label="Dismiss"
      @click="dismiss"
    >
      <Icon name="close" :size="12" :stroke-width="2.5" />
    </button>
  </div>
</template>

<style scoped>
.rotate-hint {
  color: #7fe9f6;
  background: rgba(53, 211, 230, 0.1);
  border-bottom: 1px solid rgba(53, 211, 230, 0.25);
}
.rotate-hint__close {
  color: rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.05);
}
</style>
