<script setup>
import { computed, ref } from 'vue'
import {
  createPeakHold,
  createReadoutThrottle,
  lampFraction,
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
   * Reduction that lights the lamp fully.
   *
   * 3 rather than the kernel's own 6 dB ceiling, and the difference is the
   * point: this stage spends most of its life between 0 and 3, so anchoring
   * full brightness at the bound gave away half the lamp's range to readings
   * it almost never produces. Anything at or past 3 dB now pins — which is
   * fine, because "deeper than 3" is a single fact and the NUMBER carries the
   * exact value.
   *
   * That split only works because the numeral is no longer derived through
   * this scale. See the hold below.
   */
  fullScaleDb: { type: Number, default: 3 },
})

// ONE HELD QUANTITY, IN dB, and both readings derived from it.
//
// The light and the number must not disagree — the kernel reports per block
// and on speech the overwhelming majority of blocks clip nothing, so sampling
// the raw value for the numeral would print a dash on most frames while the
// lamp beside it was lit. That much was always true.
//
// What changed is WHICH quantity is held. It used to be the brightness
// fraction, with the numeral recovered through the inverse of the brightness
// law — and that inverse clamps at full scale, because the forward law does.
// Harmless while full scale was the kernel's own 6 dB bound and nothing could
// exceed it. The moment full scale dropped to 3 it would have printed "3.0"
// for every reduction between 3 and 6 dB, with the light entirely correct and
// the number quietly wrong. Holding dB and deriving brightness from it is the
// same guarantee with the clamp removed: the lamp pins at 3, the number keeps
// counting to the kernel's ceiling.
const heldDbRef = ref(0)
const brightness = computed(() => lampFraction(heldDbRef.value, props.fullScaleDb))
const readoutDb = ref(0)
// Longer hold and a slower fall than the first version, for the same reason
// the curve changed: the case that reads worst is a single errant peak with
// quiet either side, and a 400 ms hold falling at 1.1/s gave that event under
// a second on screen. Still a hold, not an average — averaging is what made
// the bar this replaced unreadable.
//
// The fall is in dB/s now that dB is what is held. 2.5 dB/s puts a full-scale
// 3 dB event on screen for roughly 1.9 s including the hold, which is what the
// fraction-domain rate it replaces gave. ballistics' peak hold is explicitly
// unit-agnostic, so this is the same mechanism with a different unit.
const held = createPeakHold({ holdMs: 700, fallPerSec: 2.5 })
const throttle = createReadoutThrottle()

useMeterFrame((dtMs) => {
  heldDbRef.value = held.push(Math.abs(props.reductionDb), dtMs)
  // The numeral is throttled separately — a value flickering at frame rate is
  // unreadable however correct it is — but it is the same held dB the light
  // is drawn from, so the two can never say different things.
  if (throttle.due(dtMs)) readoutDb.value = heldDbRef.value
})

// TWO MAPPINGS IN SERIES, and only the first is a scale. dB -> fraction is
// lampFraction, which is where the brightness law lives; fraction -> pixels is
// this block, which is meant to be a faithful rendering of it rather than a
// second curve. That distinction is easy to lose, because a color-mix
// percentage looks like a brightness and is not one: sRGB mixes
// gamma-encoded values, so 50% mix is not half the luminance.
//
// MEASURED, because it was an unstated assumption that the fraction survives
// the trip to the screen. Perceived lightness (CIE L*, normalised between the
// unlit and full-lit fills) against the fraction driving it:
//
//   fraction   0.00  0.18  0.245  0.34  0.50  0.68  0.797  0.88  1.00
//   perceived  0.00  0.20  0.27   0.37  0.53  0.71  0.82   0.89  1.00
//
// Within 0.03 everywhere, erring bright. That is luck rather than design —
// sRGB's ~1/2.2 encoding and L*'s ~cube-root of luminance very nearly cancel
// when gamma-encoded values are mixed directly — but it means the law's
// numbers are the ones that reach the eye, so lampFraction can be reasoned
// about on its own. Re-check this if the accent or the unlit colour changes;
// the cancellation is not guaranteed for an arbitrary pair.
//
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
       §7.2). A lamp has no face to engrave, so that guidance moves into the
       title: fully lit IS the bottom of that band, so "lamp pinned" is the
       same reading the shaded band gave, and the numeral covers the rest. -->
  <div
    class="flex items-center gap-[9px]"
    role="img"
    title="Peak reduction on the loudest transient. The lamp is fully lit at 3 dB and the number keeps counting past it to the kernel's 6 dB ceiling. 3-6 dB is the usable range on speech; much below 3 the stage is barely engaging. The second figure is how often it fires."
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
