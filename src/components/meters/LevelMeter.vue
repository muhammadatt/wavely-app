<script setup>
import { computed } from 'vue'

/**
 * Vertical segmented level meter — a column per channel plus a caption.
 * Shared by the plugin panels for their IN and OUT readouts.
 */
const props = defineProps({
  db: { type: Number, required: true },
  label: { type: String, default: '' },
  channels: { type: Number, default: 2 },
  height: { type: Number, default: 150 },
  // Bottom of the scale. The top is always 0 dBFS.
  floorDb: { type: Number, default: -60 },
  // Faceplate the meter is mounted on — see components/faceplate.js.
  face: { type: String, default: 'dark' }, // 'dark' | 'light'
})

const fillPct = computed(() => {
  if (!Number.isFinite(props.db)) return 0
  const span = -props.floorDb
  return Math.max(0, Math.min(100, ((props.db - props.floorDb) / span) * 100))
})

const labelColor = computed(() =>
  props.face === 'light' ? 'rgba(16,22,29,.62)' : 'rgba(255,255,255,.45)'
)

// The column is a dark well either way; on metal it gets a cut edge so it
// reads as recessed into the panel rather than painted on.
const wellShadow = computed(() =>
  props.face === 'light'
    ? 'inset 0 1px 3px rgba(0,0,0,.7), 0 1px 0 rgba(255,255,255,.7)'
    : 'inset 0 0 0 1px rgba(255,255,255,.05)'
)
</script>

<template>
  <div class="flex flex-col items-center gap-[9px]">
    <div class="flex gap-[3px]">
      <div
        v-for="ch in channels" :key="ch"
        class="relative w-[9px] rounded-[3px]"
        :style="{ height: height + 'px', background: '#07090c', boxShadow: wellShadow }"
      >
        <div class="absolute bottom-0 left-0 right-0 rounded-[3px] transition-all duration-100"
             :style="{ height: fillPct + '%', background: 'linear-gradient(to top,#2ec96b 0 62%,#e9c63b 62% 84%,#e35d4f 84%)' }"></div>
        <div class="absolute inset-0" style="background:repeating-linear-gradient(to top,#0000 0 4px,#07090c 4px 6px)"></div>
      </div>
    </div>
    <span v-if="label"
          :style="{ font: `700 9px 'JetBrains Mono',monospace`, letterSpacing: '.16em', color: labelColor }">{{ label }}</span>
  </div>
</template>
