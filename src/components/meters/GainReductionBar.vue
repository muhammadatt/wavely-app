<script setup>
import { computed, ref } from 'vue'
import {
  createHeldAverage,
  createPeakHold,
  createReadoutThrottle,
  createVuBallistics,
  grFraction,
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

/** Undo the scale law, so the numeral always states what the fill shows. */
function fractionToDb(fraction) {
  const vMin = Math.pow(10, -props.fullScaleDb / 20)
  const v = 1 - fraction * (1 - vMin)
  return v > 0 ? Math.min(-20 * Math.log10(v), props.fullScaleDb) : props.fullScaleDb
}

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

  if (readoutThrottle.due(dtMs)) readingDb.value = fractionToDb(fillFraction.value)
})

const fillPct = computed(() => Math.min(100, Math.max(0, fillFraction.value * 100)))
const peakPct = computed(() => Math.min(100, Math.max(0, peakFraction.value * 100)))
const showPeak = computed(() => peakFraction.value > 0.005)

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
    <div class="relative h-[18px] rounded-[9px]" style="background:#0a0806;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05),inset 0 2px 6px rgba(0,0,0,.8)">
      <div class="absolute top-0 bottom-0 left-0 rounded-[9px]"
           :style="{
             width: fillPct + '%',
             background: `linear-gradient(90deg, color-mix(in srgb, ${accent} 35%, #ffffff), ${accent})`,
             boxShadow: `0 0 16px color-mix(in srgb, ${accent} 70%, transparent)`,
           }"></div>
      <div class="absolute inset-0 rounded-[9px]" style="background:repeating-linear-gradient(90deg,#0000 0 9px,rgba(10,8,6,.85) 9px 11px)"></div>
      <!-- Ticks on the track itself, so the engraving is visibly tied to the
           positions the numerals claim. Majors run the full height. -->
      <div
        v-for="(mark, i) in marks" :key="`t${i}`"
        v-show="mark.pct > 0 && mark.pct < 100"
        class="absolute"
        :style="{
          left: mark.pct + '%',
          top: mark.major ? '0' : '5px',
          bottom: mark.major ? '0' : '5px',
          width: '1px',
          background: mark.major ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.1)',
        }"
      ></div>
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
    <div class="relative mt-[5px] h-[10px]" style="font:600 8px 'JetBrains Mono',monospace;color:rgba(255,255,255,.3)">
      <span
        v-for="(mark, i) in marks" :key="i"
        v-show="mark.label"
        class="absolute top-0"
        :style="{ left: mark.pct + '%', transform: mark.shift }"
      >{{ mark.label }}</span>
    </div>
  </div>
</template>
