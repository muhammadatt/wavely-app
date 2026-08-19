<script setup>
import { computed, ref } from 'vue'
import {
  createPeakHold,
  createReadoutThrottle,
  lampFraction,
  lampFractionToDb,
  useMeterFrame,
} from './ballistics.js'

/**
 * Clipping lamp — peak reduction as a light rather than as a bar.
 *
 * WHY THIS REPLACED A FULL-LENGTH GAIN-REDUCTION METER. A bar is the right
 * instrument for a compressor, where the reading is continuous and the
 * question is "how deep". This stage is neither: it does nothing at all for
 * most of a file and then takes a fraction of a dB off a plosive. Measured, the
 * blocks that clip take a median of 0.3-0.4 dB, so on a 12 dB face the bar
 * spent its entire length displaying an idle needle — 90% of the panel's widest
 * instrument dedicated to the reading it never shows. The question a user
 * actually has here is "did it just do something, and roughly how hard", which
 * is what a lamp answers in a tenth of the space.
 *
 * BRIGHTNESS IS PEAK-HELD, NOT AVERAGED, and that is the whole point. VU
 * damping is what made the bar unreadable: a 3 ms event smoothed over a 45 ms
 * time constant is a reading of nearly zero. The lamp runs instant attack and a
 * held fall, so a single plosive lights it fully and stays visible long enough
 * to be seen. The number beside it is throttled separately — a value flickering
 * at frame rate is unreadable however correct it is.
 *
 * THE BRIGHTNESS LAW IS THE LAMP'S OWN, NOT THE COMPRESSORS' GR CURVE. It
 * shipped using grFraction on the argument that "half lit" here should mean
 * what "half way along the bar" means there. Reported from use: the lamp was
 * barely visible unless the stage was driven hard, and showed almost nothing
 * when it was doing the job it exists for. A voltage law is near-linear in
 * amplitude at small reductions, so on this 6 dB scale a 0.3 dB event — the
 * median of the blocks that clip on real narration — lit 3.9% of the range.
 * See lampFraction for the replacement and the numbers; the short version is
 * that consistency with an instrument the user cannot see beside this one was
 * never worth the visibility it cost.
 */
const props = defineProps({
  /** Peak reduction, positive or negative dB — the magnitude is used. */
  reductionDb: { type: Number, required: true },
  /**
   * Share of voiced blocks the stage engaged on, 0-100.
   *
   * Sits beside the dB figure because the two answer different questions and
   * this stage is the case where they come apart: 0.4 dB on 3% of blocks and
   * 0.4 dB on 40% of them are the same reading on any meter and completely
   * different settings.
   */
  engagedPct: { type: Number, default: 0 },
  accent: { type: String, default: '#ff8f6b' },
  /**
   * Reduction that lights the lamp fully. 6 dB is the kernel's own hard
   * ceiling (MAX_REDUCTION_DB), so the lamp cannot be driven past its top by
   * any setting — full brightness means the stage is at its bound.
   */
  fullScaleDb: { type: Number, default: 6 },
})

// Brightness carries the ballistics; the numeral is the SAME held value read
// back through the inverse of the brightness law, throttled so it stays
// legible.
//
// Reading the raw `reductionDb` instead would put the two out of step in the
// worst possible way: the kernel reports per block, and on speech the
// overwhelming majority of blocks clip nothing at all, so a 10 Hz sample of
// the raw value shows a dash on most frames while the lamp beside it is lit.
// Deriving both from one held quantity is the same rule lampFractionToDb
// exists for — a number and a light that disagree are worse than either alone.
const brightness = ref(0)
const readoutDb = ref(0)
// Longer hold and a slower fall than the first version, for the same reason
// the curve changed: the case that reads worst is a single errant peak with
// quiet either side, and a 400 ms hold falling at 1.1/s gave that event under
// a second on screen. 700 ms and 0.7/s puts an isolated plosive up for roughly
// 2 s, which is long enough to look over at. Still a hold, not an average —
// averaging is what made the bar this replaced unreadable.
const held = createPeakHold({ holdMs: 700, fallPerSec: 0.7 })
const throttle = createReadoutThrottle()

useMeterFrame((dtMs) => {
  const target = lampFraction(Math.abs(props.reductionDb), props.fullScaleDb)
  brightness.value = held.push(target, dtMs)
  if (throttle.due(dtMs)) {
    readoutDb.value = lampFractionToDb(brightness.value, props.fullScaleDb)
  }
})

// A floor of 0.06 keeps the lamp visible as an unlit fixture rather than
// letting it disappear into the faceplate — an absent lamp and a dark one look
// the same, and only one of them means "not clipping".
const lampStyle = computed(() => {
  const b = brightness.value
  return {
    background: `color-mix(in srgb, ${props.accent} ${(6 + b * 94).toFixed(1)}%, #17120f)`,
    // The glow starts substantial rather than ramping from nothing: the fill
    // alone at a quarter lit reads as a slightly warm dot, where a halo around
    // it reads as a lamp that came on. Still exactly absent at rest, so an
    // idle stage cannot be mistaken for a working one.
    boxShadow: b > 0.01
      ? `0 0 ${(4 + b * 18).toFixed(1)}px ${(b * 3).toFixed(1)}px color-mix(in srgb, ${props.accent} ${(20 + b * 55).toFixed(0)}%, transparent)`
      : 'none',
    borderColor: `color-mix(in srgb, ${props.accent} ${(18 + b * 60).toFixed(0)}%, transparent)`,
  }
})

const dbText = computed(() => (readoutDb.value < 0.05 ? '—' : readoutDb.value.toFixed(1)))
const engagedText = computed(() => `${props.engagedPct.toFixed(1)}%`)
</script>

<template>
  <!-- The bar this replaced shaded its 3-6 dB usable range on the face (spec
       §7.2). A lamp has no face to engrave, so that guidance moves here rather
       than being dropped: full brightness is the kernel's hard 6 dB ceiling, so
       "at least half lit" is the same reading the shaded band gave. -->
  <div
    class="flex items-center gap-[9px]"
    role="img"
    title="Peak reduction on the loudest transient. 3-6 dB is the usable range on speech; past 6 the kernel bounds it, and much below 3 the stage is barely engaging. The second figure is how often it fires."
    :aria-label="`Peak reduction ${dbText} dB, engaged on ${engagedText} of voiced blocks`"
  >
    <span
      class="rounded-full border transition-none"
      style="width:11px;height:11px"
      :style="lampStyle"
    ></span>

    <span
      class="tabular-nums"
      :style="{
        font: `700 13px 'JetBrains Mono',monospace`,
        color: readoutDb < 0.05 ? 'rgba(255,255,255,.25)' : accent,
        minWidth: '34px',
        textAlign: 'right',
      }"
    >{{ dbText }}</span>
    <span style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.14em;color:rgba(255,255,255,.3)">
      dB PEAK
    </span>

    <span class="mx-[2px]" style="width:1px;height:12px;background:rgba(255,255,255,.1)"></span>

    <span
      class="tabular-nums"
      :style="{
        font: `700 11px 'JetBrains Mono',monospace`,
        color: engagedPct < 0.05 ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.62)',
        minWidth: '34px',
        textAlign: 'right',
      }"
    >{{ engagedText }}</span>
    <span style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.14em;color:rgba(255,255,255,.3)">
      ENGAGED
    </span>
  </div>
</template>
