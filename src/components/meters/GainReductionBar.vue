<script setup>
import { computed, ref } from 'vue'
import {
  createHeldAverage,
  createPeakHold,
  createReadoutThrottle,
  createVuBallistics,
  grFraction,
  grFractionToDb,
  grScaleMarks,
  useMeterFrame,
} from './ballistics.js'

/**
 * Horizontal gain-reduction bar with a labelled scale.
 *
 * Reads the same way the VU movement in the FET panel does — same VU damping,
 * same voltage scale law, same engraved numbers — so the two meters can be
 * compared by eye. The bar shows the damped average; a fast tick above it
 * holds the transient depth the average smooths away.
 *
 * The caller pushes the raw envelope, undamped. This component owns the
 * ballistics and runs its own frame loop, so the reading is correct whether
 * the caller updates every frame or occasionally.
 */
const props = defineProps({
  // Negative dB, matching DynamicsCompressorNode.reduction conventions.
  reductionDb: { type: Number, required: true },
  accent: { type: String, default: '#f5a623' },
  /**
   * Reduction (in dB) that fills the bar end to end. 24 dB covers everything
   * an opto or FET stage does short of hard limiting; deeper scales spend
   * their width on readings that never occur.
   */
  fullScaleDb: { type: Number, default: 24 },
  title: { type: String, default: 'GAIN REDUCTION' },
  /**
   * Damping. 'vu' is the default and is what makes the bar readable. 'none'
   * is for callers that already apply their own ballistics upstream — running
   * both smooths twice and the bar lags behind the audio.
   */
  ballistics: { type: String, default: 'vu' }, // 'vu' | 'none'
  /**
   * Optional target-range shading, e.g. the soft clipper's "3-6 dB is usable,
   * past that it reads as grit" range (spec §7.1-7.2). Undefined on either
   * bound skips the shading entirely — every other caller is unaffected.
   */
  zoneMinDb: { type: Number, default: null },
  zoneMaxDb: { type: Number, default: null },
})

const averaged = createVuBallistics()
const peaked = createPeakHold()

// Fraction of the scale, 0 at rest. Both the damping and the peak fall run
// here rather than on the dB value: a movement is damped in voltage, and a
// mark that falls at a fixed fraction per second falls at one visible speed
// wherever it is on a scale this non-linear.
const fillFraction = ref(0)
const peakFraction = ref(0)

/**
 * Two numerals over two time bases.
 *
 * The primary states what the fill is doing right now, refreshed at ~10 Hz so
 * the digits can be read while it moves. It is the number that answers "did
 * that knob do anything", and it steps in sympathy with the level meters'
 * readouts, which is what lets the two be compared.
 *
 * Beside it, the settled reading: a second of working audio, averaged and
 * held. That one answers "how hard is this actually compressing", which is a
 * question no live number can answer, however slowly it is sampled.
 */
const readoutThrottle = createReadoutThrottle()
const readingDb = ref(0)

const heldAverage = createHeldAverage()
const averageDb = ref(0)
const hasAverage = ref(false)

useMeterFrame((dtMs) => {
  const target = Math.abs(props.reductionDb)
  const targetFraction = grFraction(target, props.fullScaleDb)

  fillFraction.value = props.ballistics === 'none'
    ? averaged.reset(targetFraction)
    : averaged.push(targetFraction, dtMs)

  peakFraction.value = peaked.push(targetFraction, dtMs)

  // Averaged in dB, from the raw envelope. Feeding it the damped fill would
  // average an average, and the mean of a lag is the mean of its input anyway.
  averageDb.value = heldAverage.push(target, dtMs)
  hasAverage.value = heldAverage.active

  if (readoutThrottle.due(dtMs)) {
    readingDb.value = grFractionToDb(fillFraction.value, props.fullScaleDb)
  }
})

const fillPct = computed(() => Math.min(100, Math.max(0, fillFraction.value * 100)))
const peakPct = computed(() => Math.min(100, Math.max(0, peakFraction.value * 100)))
const showPeak = computed(() => peakFraction.value > 0.005)

/**
 * Track geometry.
 *
 * The lit slot and the plate around it used to be one element, so the fill ran
 * edge to edge and there was nowhere for a margin to live. Splitting them puts
 * the padding on the plate and leaves the lit height untouched — the plate
 * grows outward by the gap rather than the bar shrinking inward by it.
 *
 * Radii are concentric: an inner corner and an outer corner separated by the
 * padding only stay parallel if the outer radius is the inner plus the gap.
 * Matching them instead leaves a visibly pinched crescent at each end.
 */
const LIT_H = 18
const TRACK_PAD = 3

const plateStyle = {
  padding: `${TRACK_PAD}px`,
  borderRadius: `${LIT_H / 2 + TRACK_PAD}px`,
  background: '#0a0806',
  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.05)',
}

const slotStyle = {
  height: `${LIT_H}px`,
  borderRadius: `${LIT_H / 2}px`,
  background: 'rgba(0,0,0,.5)',
  boxShadow: 'inset 0 1px 4px rgba(0,0,0,.8)',
}

const hasZone = computed(() => props.zoneMinDb != null && props.zoneMaxDb != null)
const zoneStartPct = computed(() => hasZone.value ? grFraction(props.zoneMinDb, props.fullScaleDb) * 100 : 0)
const zoneEndPct = computed(() => hasZone.value ? grFraction(props.zoneMaxDb, props.fullScaleDb) * 100 : 0)

const marks = computed(() =>
  grScaleMarks(props.fullScaleDb).map((mark) => {
    const pct = mark.fraction * 100
    return {
      ...mark,
      // Negative, because the scale reads as reduction.
      label: mark.label && mark.db > 0 ? `-${mark.label}` : mark.label,
      pct,
      shift: pct <= 0 ? 'none' : pct >= 100 ? 'translateX(-100%)' : 'translateX(-50%)',
    }
  })
)
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-1.5">
      <span class="flex items-baseline gap-[9px]">
        <!-- Live: what the fill is doing, at a rate the digits survive. -->
        <span :style="{
                font: `700 12px 'JetBrains Mono',monospace`,
                color: `color-mix(in srgb, ${accent} 65%, #ffffff)`,
                textShadow: `0 0 8px color-mix(in srgb, ${accent} 55%, transparent)`,
              }">{{ readingDb.toFixed(1) }} dB</span>
        <!-- Settled: a second of working audio, averaged and held. -->
        <span style="font:600 9px 'JetBrains Mono',monospace;letter-spacing:.08em;color:rgba(255,255,255,.38)">
          AVG {{ hasAverage ? averageDb.toFixed(1) : '—' }}
        </span>
      </span>
      <span style="font:700 9.5px 'JetBrains Mono',monospace;letter-spacing:.18em;color:rgba(255,255,255,.5)">{{ title }}</span>

    </div>
    <!-- Plate, then the lit slot recessed into it. The gap between them is the
         plate's padding, so the bar keeps its height. -->
    <div :style="plateStyle">
      <div class="relative" :style="slotStyle">
        <!-- Target-range shading, drawn first so the fill and peak marker sit
             on top of it. A quiet band, not a second meter: it answers "where
             should I be aiming" without competing with "where am I". -->
        <div
          v-if="hasZone"
          class="absolute top-0 bottom-0 pointer-events-none"
          :style="{
            left: zoneStartPct + '%',
            width: (zoneEndPct - zoneStartPct) + '%',
            background: `color-mix(in srgb, ${accent} 14%, transparent)`,
            boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 22%, transparent)`,
          }"
        ></div>
        <div class="absolute top-0 bottom-0 left-0"
             :style="{
               width: fillPct + '%',
               borderRadius: `${LIT_H / 2}px`,
               background: `linear-gradient(90deg, color-mix(in srgb, ${accent} 35%, #ffffff), ${accent})`,
               boxShadow: `0 0 16px color-mix(in srgb, ${accent} 70%, transparent)`,
             }"></div>
        <div class="absolute inset-0" :style="{ borderRadius: `${LIT_H / 2}px`, background: 'repeating-linear-gradient(90deg,#0000 0 9px,rgba(10,8,6,.85) 9px 11px)' }"></div>

        <!--
        Peak hold: instant attack, so it catches the transient depth the damped
        fill never reaches. Sits above the LED mask, not behind it.

        Kept deliberately quiet. The fill is the reading — how hard the stage is
        working on this passage — and this is an annotation on it. Drawn as a
        bright glowing marker it out-shouted the thing it annotates, which is
        backwards. A plain hairline inside the track states the high-water mark
        and then gets out of the way; where peak and average nearly agree, as on
        a slow opto, it simply rides the leading edge of the fill and vanishes
        into it, which is the correct amount of attention for a gap that is not
        there.
      -->
        <div
          v-show="showPeak"
          class="absolute pointer-events-none"
          :style="{
            left: `calc(${peakPct}% - 1px)`,
            top: '1px',
            bottom: '1px',
            width: '2px',
            borderRadius: '1px',
            background: 'rgba(255,255,255,.5)',
          }"
        ></div>
      </div>
    </div>

    <!-- Inset by the same padding as the slot, so a numeral still lands over
         the position it names rather than over the plate beside it. -->
    <div :style="{ padding: `0 ${TRACK_PAD}px` }">
      <div class="relative mt-[5px] h-[10px]" style="font:600 8px 'JetBrains Mono',monospace;color:rgba(255,255,255,.3)">
        <span
          v-for="(mark, i) in marks" :key="i"
          v-show="mark.label"
          class="absolute top-0"
          :style="{ left: mark.pct + '%', transform: mark.shift }"
        >{{ mark.label }}</span>
      </div>
    </div>
  </div>
</template>
