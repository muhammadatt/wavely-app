<script setup>
import { computed } from 'vue'

/**
 * Bipolar gain bar, centred on unity.
 *
 * WHY NOT GainReductionBar. That meter is one-sided by design — it reads the
 * compressors' `reduction` convention, where the only interesting direction is
 * down. A leveler's boosts are half of what it does, and usually the half the
 * user came for: a one-sided bar sits at rest through exactly the quiet
 * passages the plugin was opened to fix.
 *
 * NO BALLISTICS HERE. GainReductionBar owns its own damping because a de-esser
 * event is an impulse its caller cannot be trusted to catch. This value is a
 * staircase that holds for whole phrases and is read exactly out of the gain
 * curve, so the caller's light smoothing is all it needs — a second stage would
 * only put the bar behind the audio.
 */
const props = defineProps({
  /** Signed gain in dB. Positive is a boost. */
  gainDb: { type: Number, required: true },
  accent: { type: String, default: '#7ec8ff' },
  /** Half-range: the bar fills at +/- this many dB. */
  fullScaleDb: { type: Number, default: 12 },
  title: { type: String, default: 'GAIN' },
})

const fraction = computed(() => {
  const f = props.gainDb / props.fullScaleDb
  return Math.max(-1, Math.min(1, f))
})

/** Bar geometry as percentages of the track, measured out from the centre. */
const bar = computed(() => {
  const half = Math.abs(fraction.value) * 50
  return fraction.value >= 0
    ? { left: '50%', width: `${half}%` }
    : { left: `${50 - half}%`, width: `${half}%` }
})

const readout = computed(() => {
  const v = props.gainDb
  if (Math.abs(v) < 0.05) return '0.0'
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
})

const marks = computed(() => {
  const step = props.fullScaleDb / 2
  return [-props.fullScaleDb, -step, 0, step, props.fullScaleDb].map(db => ({
    db,
    label: db === 0 ? '0' : `${db > 0 ? '+' : ''}${db}`,
    left: `${50 + (db / props.fullScaleDb) * 50}%`,
  }))
})
</script>

<template>
  <div>
    <div class="flex items-baseline justify-between mb-[6px]">
      <span style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.14em;
                   color:rgba(255,255,255,.42)">{{ title }}</span>
      <span
        :style="{
          font: `700 11px 'JetBrains Mono',monospace`,
          color: Math.abs(gainDb) < 0.05 ? 'rgba(255,255,255,.35)' : accent,
        }"
      >{{ readout }} dB</span>
    </div>

    <div
      class="relative w-full rounded"
      style="height:10px;background:rgba(255,255,255,.05);
             border:1px solid rgba(255,255,255,.07)"
    >
      <!-- Unity, engraved rather than drawn on top of the fill. -->
      <div
        class="absolute top-0 bottom-0"
        style="left:50%;width:1px;background:rgba(255,255,255,.22)"
      />
      <div
        class="absolute top-0 bottom-0 rounded-sm transition-none"
        :style="{ ...bar, background: accent, opacity: 0.85 }"
      />
    </div>

    <div class="relative w-full" style="height:11px">
      <span
        v-for="m in marks"
        :key="m.db"
        class="absolute"
        :style="{
          left: m.left,
          transform: 'translateX(-50%)',
          font: `500 7.5px 'JetBrains Mono',monospace`,
          color: 'rgba(255,255,255,.28)',
        }"
      >{{ m.label }}</span>
    </div>
  </div>
</template>
