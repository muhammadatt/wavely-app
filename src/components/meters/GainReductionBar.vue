<script setup>
import { computed } from 'vue'

/**
 * Horizontal gain-reduction bar with a labelled scale.
 * Shared by the plugin panels.
 */
const props = defineProps({
  // Negative dB, matching DynamicsCompressorNode.reduction conventions.
  reductionDb: { type: Number, required: true },
  accent: { type: String, default: '#f5a623' },
  // Reduction (in dB) that fills the bar end to end.
  fullScaleDb: { type: Number, default: 40 },
  scale: { type: Array, default: () => ['0', '-3', '-6', '-12', '-24'] },
  title: { type: String, default: 'GAIN REDUCTION' },
  // CSS smoothing on the fill. Fine for a compressor, whose reduction is already
  // a continuous tens-of-ms envelope. Set to 0 when the caller applies its own
  // meter ballistics, otherwise the two fight and the bar lags behind both.
  transitionMs: { type: Number, default: 75 },
})

const amount = computed(() => Math.abs(props.reductionDb))
const fillPct = computed(() => Math.min(100, (amount.value / props.fullScaleDb) * 100))
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-1.5">
      <span style="font:700 9.5px 'JetBrains Mono',monospace;letter-spacing:.18em;color:rgba(255,255,255,.5)">{{ title }}</span>
      <span :style="{
              font: `700 12px 'JetBrains Mono',monospace`,
              color: `color-mix(in srgb, ${accent} 65%, #ffffff)`,
              textShadow: `0 0 8px color-mix(in srgb, ${accent} 55%, transparent)`,
            }">{{ amount.toFixed(1) }} dB</span>
    </div>
    <div class="relative h-[18px] rounded-[9px]" style="background:#0a0806;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05),inset 0 2px 6px rgba(0,0,0,.8)">
      <div class="absolute top-0 bottom-0 left-0 rounded-[9px]"
           :style="{
             width: fillPct + '%',
             transition: transitionMs > 0 ? `width ${transitionMs}ms linear` : 'none',
             background: `linear-gradient(90deg, color-mix(in srgb, ${accent} 35%, #ffffff), ${accent})`,
             boxShadow: `0 0 16px color-mix(in srgb, ${accent} 70%, transparent)`,
           }"></div>
      <div class="absolute inset-0 rounded-[9px]" style="background:repeating-linear-gradient(90deg,#0000 0 9px,rgba(10,8,6,.85) 9px 11px)"></div>
    </div>
    <div class="flex justify-between mt-[5px]" style="font:600 8px 'JetBrains Mono',monospace;color:rgba(255,255,255,.3)">
      <span v-for="(mark, i) in scale" :key="i">{{ mark }}</span>
    </div>
  </div>
</template>
