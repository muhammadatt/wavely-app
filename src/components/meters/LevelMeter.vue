<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'

/**
 * Vertical level meter — a bar per channel, a peak-hold line, an over lamp
 * and a labelled scale. Shared by the plugin panels for their IN and OUT
 * readouts.
 *
 * The bar is RMS and the readout is peak, which is the split that makes a
 * meter this size useful: the bar shows how loud the passage sits, the
 * number and the hold line show how close the transients are to the ceiling.
 */
const props = defineProps({
  // RMS level in dBFS, the bar reading.
  db: { type: Number, required: true },
  // Sample peak in dBFS. Drives the hold line, the readout and the over lamp.
  // Callers without a peak source can omit it and get a bar-only meter.
  peakDb: { type: Number, default: -Infinity },
  label: { type: String, default: '' },
  /**
   * Bars to draw. One per independent reading the caller actually has — the
   * level tap measures the analyser's mono downmix, so one is the honest
   * answer for every current caller. Drawing two from a single number was
   * a stereo meter that could not show a channel imbalance if there was one.
   */
  channels: { type: Number, default: 1 },
  height: { type: Number, default: 150 },
  // Bottom of the scale. The top is always 0 dBFS.
  floorDb: { type: Number, default: -60 },
  // Peak at or above this latches the over lamp. 0 dBFS is the point a float
  // sample can no longer survive the trip to an integer file.
  clipDb: { type: Number, default: 0 },
  showScale: { type: Boolean, default: true },
  showReadout: { type: Boolean, default: true },
  showOver: { type: Boolean, default: true },
})

const BAR_WIDTH = 9
const BAR_GAP = 3

// Marks worth engraving, in dBFS. Only some carry a numeral — the rest are
// bare ticks, so the scale stays readable on the shortest panel that uses it.
const TICKS = [-6, -12, -18, -24, -36, -48]
const LABELLED = new Set([-6, -18, -36])

// Zone edges in dBFS. Round numbers that land on ticks, so the colour change
// and the engraving agree.
const AMBER_DB = -18
const RED_DB = -6

/**
 * Scale shape. A linear dBFS scale spends most of its height on the range
 * below -24, where nothing happens, and crushes the -24..0 working range into
 * the remainder. Give the top 24 dB the majority of the travel instead —
 * roughly doubling the resolution where the reading is actually read — and
 * let the quiet end compress. The VU meter face already establishes that a
 * non-linear scale is fair game here.
 */
const KNEE_DB = -24
const KNEE_PCT = 35

// Meter ballistics. Instant attack so nothing is missed, timed release so the
// eye can follow. The bar falls faster than the hold line, which is what keeps
// the hold line visible above it.
const BAR_RELEASE_DB_PER_S = 26
const PEAK_RELEASE_DB_PER_S = 20
const PEAK_HOLD_MS = 1200

/** Position of a dB value on the scale, 0-100 from the floor up. */
function dbToPct(db) {
  const floor = props.floorDb
  let pct
  if (floor >= KNEE_DB) {
    // Scale too short for a knee — the whole thing is working range.
    pct = ((db - floor) / -floor) * 100
  } else if (db <= KNEE_DB) {
    pct = ((db - floor) / (KNEE_DB - floor)) * KNEE_PCT
  } else {
    pct = KNEE_PCT + ((db - KNEE_DB) / -KNEE_DB) * (100 - KNEE_PCT)
  }
  return Math.max(0, Math.min(100, pct))
}

const displayDb = ref(-Infinity)
const heldPeakDb = ref(-Infinity)
const clipped = ref(false)
let holdUntil = 0
let lastTs = 0

/**
 * Ballistics run on their own frame loop rather than off a watcher.
 *
 * A release is a function of elapsed time, not of the input changing. Driven
 * by a watcher it advances only when a new value differs from the last, so a
 * steady tone — or any signal that momentarily plateaus — freezes the bar
 * part-way down. The loop keeps falling whatever the input does.
 */
let rafId = null

function advance() {
  const rms = props.db
  const peak = props.peakDb

  // A non-finite reading means the graph is not running — no real recording
  // reaches digital silence. Clear rather than decay, so a torn-down meter
  // cannot strand a bar or a hold line at whatever it last saw.
  if (!Number.isFinite(rms) && !Number.isFinite(peak)) {
    displayDb.value = -Infinity
    heldPeakDb.value = -Infinity
    clipped.value = false
    lastTs = 0
    rafId = requestAnimationFrame(advance)
    return
  }

  const now = performance.now()
  const elapsedS = lastTs ? (now - lastTs) / 1000 : 0
  lastTs = now

  if (!Number.isFinite(displayDb.value) || rms >= displayDb.value) {
    displayDb.value = rms
  } else {
    displayDb.value = Math.max(rms, displayDb.value - BAR_RELEASE_DB_PER_S * elapsedS)
  }

  if (Number.isFinite(peak)) {
    if (peak >= props.clipDb) clipped.value = true
    if (!Number.isFinite(heldPeakDb.value) || peak >= heldPeakDb.value) {
      heldPeakDb.value = peak
      holdUntil = now + PEAK_HOLD_MS
    } else if (now >= holdUntil) {
      heldPeakDb.value = Math.max(peak, heldPeakDb.value - PEAK_RELEASE_DB_PER_S * elapsedS)
    }
  }

  rafId = requestAnimationFrame(advance)
}

onMounted(() => { advance() })
onUnmounted(() => {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
})

const fillPct = computed(() =>
  Number.isFinite(displayDb.value) ? dbToPct(displayDb.value) : 0)

/**
 * The gradient is sized to the full track and pinned to its bottom edge, so
 * the zones stay at fixed dB positions. Left to resolve against the fill —
 * which is what a plain `background` on a percentage-height element does —
 * they would scale with the reading, and every level would render with a red
 * tip. Stops come from dbToPct, so the zones follow the knee automatically.
 */
const fillStyle = computed(() => ({
  height: fillPct.value + '%',
  backgroundImage: `linear-gradient(to top,
    #2ec96b 0 ${dbToPct(AMBER_DB)}%,
    #e9c63b ${dbToPct(AMBER_DB)}% ${dbToPct(RED_DB)}%,
    #e35d4f ${dbToPct(RED_DB)}%)`,
  backgroundSize: `100% ${props.height}px`,
  backgroundPosition: 'left bottom',
  backgroundRepeat: 'no-repeat',
}))

const heldPeakPct = computed(() =>
  Number.isFinite(heldPeakDb.value) ? dbToPct(heldPeakDb.value) : 0)

const readout = computed(() =>
  Number.isFinite(heldPeakDb.value) ? heldPeakDb.value.toFixed(1) : '-∞')

// The lamp belongs to the bars, not to the whole component — the scale gutter
// and the caption are both wider, and stretching to them left it floating
// unaligned above the thing it reports on.
const barBlockWidth = computed(() =>
  props.channels * BAR_WIDTH + (props.channels - 1) * BAR_GAP)

const visibleTicks = computed(() => TICKS.filter(t => t > props.floorDb))

const ariaText = computed(() =>
  Number.isFinite(props.db) ? `${props.db.toFixed(1)} dBFS` : 'silent')
</script>

<template>
  <div class="flex flex-col items-center gap-[7px]">
    <!-- Over lamp. Latches, and clears on click the way a console does: the
         readout decays within a second or two, so without the latch a peak
         that overshot ten seconds ago leaves no trace. -->
    <div
      v-if="showOver"
      :style="{ width: barBlockWidth + 'px' }"
      :class="clipped ? 'cursor-pointer' : ''"
      :role="clipped ? 'button' : 'status'"
      :tabindex="clipped ? 0 : -1"
      :title="clipped ? 'Peak reached 0 dBFS — click to reset' : 'No overs'"
      :aria-label="clipped ? 'Over, click to reset' : 'No overs'"
      @click="clipped = false"
      @keydown.enter.space.prevent="clipped = false"
    >
      <div :style="{
        height: '5px',
        borderRadius: '2px',
        border: '1px solid rgba(255,255,255,.07)',
        background: clipped ? '#e35d4f' : 'rgba(255,255,255,.04)',
        boxShadow: clipped ? '0 0 8px rgba(227,93,79,.7)' : 'none',
      }"></div>
    </div>

    <div class="flex items-end" :style="{ gap: showScale ? '5px' : '0' }">
      <div class="flex" :style="{ gap: BAR_GAP + 'px' }">
        <div
          v-for="ch in channels" :key="ch"
          class="relative rounded-[3px]"
          :style="{ width: BAR_WIDTH + 'px', height: height + 'px' }"
          style="background:#07090c;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)"
          role="meter"
          :aria-valuemin="floorDb"
          :aria-valuemax="0"
          :aria-valuenow="Number.isFinite(db) ? Number(db.toFixed(1)) : floorDb"
          :aria-valuetext="ariaText"
          :aria-label="label ? `${label} level` : 'Level'"
        >
          <!-- No CSS transition: ballistics are applied above, and a
               transition restarting every frame never reaches its target. -->
          <div class="absolute bottom-0 left-0 right-0 rounded-[3px]" :style="fillStyle"></div>

          <!-- Segment ruling, purely cosmetic — the scale is the ticks. -->
          <div class="absolute inset-0" style="background:repeating-linear-gradient(to top,#0000 0 4px,#07090c 4px 6px)"></div>

          <div
            v-if="Number.isFinite(heldPeakDb)"
            class="absolute left-0 right-0"
            :style="{
              bottom: `calc(${heldPeakPct}% - 1px)`,
              height: '2px',
              background: heldPeakDb >= RED_DB ? '#ff8a7a' : 'rgba(255,255,255,.85)',
            }"
          ></div>
        </div>
      </div>

      <!-- Scale. Ticks sit at their true positions; the gutter is sized for
           the widest numeral so the bars do not shift between panels. -->
      <div v-if="showScale" class="relative" :style="{ height: height + 'px', width: '18px' }">
        <div
          v-for="tick in visibleTicks" :key="tick"
          class="absolute left-0 flex items-center gap-[4px]"
          :style="{ bottom: `calc(${dbToPct(tick)}% - 3px)`, height: '6px' }"
        >
          <span :style="{
            width: LABELLED.has(tick) ? '4px' : '2.5px',
            height: '1px',
            background: 'rgba(255,255,255,.22)',
          }"></span>
          <span
            v-if="LABELLED.has(tick)"
            style="font:600 7px 'JetBrains Mono',monospace;color:rgba(255,255,255,.3);line-height:1"
          >{{ tick }}</span>
        </div>
      </div>
    </div>

    <span
      v-if="showReadout"
      :style="{
        font: `700 9.5px 'JetBrains Mono',monospace`,
        color: clipped ? '#ff9d90' : 'rgba(255,255,255,.62)',
      }"
    >{{ readout }}</span>

    <span v-if="label" style="font:700 9px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.45)">{{ label }}</span>
  </div>
</template>
