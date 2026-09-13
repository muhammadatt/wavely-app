<script setup>
/**
 * Sunk status pill: an LED and a line of mono text. For state the face reports
 * rather than sets — "MEASURING", the caption for the lit mode.
 */
import { computed } from 'vue'
import { glow, OFF_LED, OFF_LED_SHADOW } from './modulaTheme.js'

const props = defineProps({
  text: { type: String, required: true },
  active: { type: Boolean, default: false },
  color: { type: String, default: '#ff8b3d' },
  /** Hide the LED for a pill that is pure caption. */
  showLed: { type: Boolean, default: true },
})

const led = computed(() => props.active
  ? { background: props.color, boxShadow: `0 0 10px ${glow(props.color)}` }
  : { background: OFF_LED, boxShadow: OFF_LED_SHADOW })
</script>

<template>
  <div class="mst">
    <div v-if="showLed" class="mst-led" :style="led"></div>
    <div class="mst-text">{{ text }}</div>
  </div>
</template>

<style scoped>
.mst {
  display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-radius: 14px; min-width: 0;
  background: linear-gradient(180deg, #1a1c20, #22252a); box-shadow: inset 0 2px 8px rgba(0,0,0,.8);
}
.mst-led { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.mst-text { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: .14em; color: #9aa2ab; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
