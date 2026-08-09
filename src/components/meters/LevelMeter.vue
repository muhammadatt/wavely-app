<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'

/**
 * Vertical level meter — a segmented LED ladder per channel, a peak-hold
 * segment, a clip lamp and a labelled scale. Shared by the plugin panels for
 * their IN and OUT readouts.
 *
 * The ladder is RMS and the readout is peak, which is the split that makes a
 * meter this size useful: the ladder shows how loud the passage sits, the
 * number and the held segment show how close the transients are to the
 * ceiling.
 */
const props = defineProps({
  /**
   * One `{ rmsDb, peakDb }` per channel, in dBFS, refreshed every frame by
   * the caller. Length sets how many ladders are drawn, so it must be the
   * source's real channel count — see `createLevelTap`. Empty means the
   * graph is not running.
   */
  levels: { type: Array, default: () => [] },
  label: { type: String, default: '' },
  height: { type: Number, default: 150 },
  // Bottom of the scale. The top is always 0 dBFS.
  floorDb: { type: Number, default: -60 },
  // Peak at or above this latches the clip lamp. 0 dBFS is the point a float
  // sample can no longer survive the trip to an integer file.
  clipDb: { type: Number, default: 0 },
  showScale: { type: Boolean, default: true },
  showReadout: { type: Boolean, default: true },
  showOver: { type: Boolean, default: true },
})

// Ladder geometry. A segment and the gap under it are one pitch, so the
// segment count follows from the height the caller asked for rather than the
// other way round — panels keep setting a pixel height and the ladder fills
// as much of it as whole segments allow.
const SEG_W = 6
const SEG_H = 6
const SEG_GAP = 3
const PITCH = SEG_H + SEG_GAP
const CH_GAP = 2
const MIN_ROWS = 8

const rows = computed(() =>
  Math.max(MIN_ROWS, Math.floor((props.height + SEG_GAP) / PITCH)))
const ladderHeight = computed(() => rows.value * PITCH - SEG_GAP)

// Marks worth engraving, in dBFS. Only some carry a numeral — the rest are
// bare ticks, so the scale stays readable on the shortest panel that uses it.
const TICKS = [-6, -12, -18, -24, -36, -48]
const LABELLED = new Set([-6, -18, -36])

// Zone edges in dBFS. Round numbers that land on labelled ticks, so the
// colour change and the engraving agree. Four zones rather than three: the
// cool band gives the bottom of the ladder somewhere to live other than
// "green", which at this segment count was reading as one undifferentiated
// mass across the whole quiet half.
const CYAN_DB = -36
const AMBER_DB = -18
const RED_DB = -6

const COOL = '#3FD0DE'
const MID = '#8FD48A'
const WARM = '#E8A33D'
const HOT = '#FF5A4E'

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
// eye can follow. The ladder falls faster than the hold segment, which is what
// keeps the hold segment visible above it.
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

// One entry per channel: `{ displayDb, heldPeakDb }` after ballistics.
const bars = ref([])
const clipped = ref(false)
let holdUntil = []
let lastTs = 0
let rafId = null

/**
 * Ballistics run on their own frame loop rather than off a watcher.
 *
 * A release is a function of elapsed time, not of the input changing. Driven
 * by a watcher it advances only when a new value differs from the last, so a
 * steady tone — or any signal that momentarily plateaus — freezes the ladder
 * part-way down. The loop keeps falling whatever the input does.
 */
function advance() {
  const src = props.levels
  const now = performance.now()

  // No channels means the graph is not running. Clear rather than decay, so
  // a torn-down meter cannot strand a segment or a hold line at its last
  // reading.
  if (!src || src.length === 0) {
    if (bars.value.length) bars.value = []
    clipped.value = false
    holdUntil = []
    lastTs = 0
    rafId = requestAnimationFrame(advance)
    return
  }

  const elapsedS = lastTs ? (now - lastTs) / 1000 : 0
  lastTs = now

  const prev = bars.value
  const next = new Array(src.length)
  if (holdUntil.length !== src.length) holdUntil = new Array(src.length).fill(0)

  // The release is a fixed slope, and over a digitally silent passage the
  // input it is racing against is -Infinity — so nothing ever stops it. Left
  // unbounded the readout walks off into four figures of negative dB. The
  // floor is the bottom of the scale, so anything at or under it is reported
  // as silence rather than as a number.
  const floor = props.floorDb

  for (let ch = 0; ch < src.length; ch++) {
    const rms = src[ch].rmsDb
    const peak = src[ch].peakDb
    const last = prev[ch] ?? { displayDb: floor, heldPeakDb: floor }

    const displayDb = Math.max(floor, rms >= last.displayDb
      ? rms
      : last.displayDb - BAR_RELEASE_DB_PER_S * elapsedS)

    // An over on any channel lights the one lamp.
    if (peak >= props.clipDb) clipped.value = true

    let heldPeakDb = last.heldPeakDb
    if (peak >= heldPeakDb) {
      heldPeakDb = peak
      holdUntil[ch] = now + PEAK_HOLD_MS
    } else if (now >= holdUntil[ch]) {
      // Decays against the floor rather than against the peak, so a hold
      // segment over a digitally silent passage falls away and settles
      // instead of either hanging there or running off the bottom.
      heldPeakDb = heldPeakDb - PEAK_RELEASE_DB_PER_S * elapsedS
    }
    heldPeakDb = Math.max(floor, Math.max(peak, heldPeakDb))

    next[ch] = { displayDb, heldPeakDb }
  }

  bars.value = next
  rafId = requestAnimationFrame(advance)
}

onMounted(() => { advance() })
onUnmounted(() => {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
})

/**
 * Where each segment sits and what colour it burns when lit. Fixed for a
 * given height and floor, so it is computed once rather than per frame — the
 * frame loop only decides which of these are currently alight.
 *
 * Zone edges are compared against the segment's midpoint, so a segment takes
 * the colour of the level it reports rather than of the boundary it happens
 * to straddle.
 */
const segMeta = computed(() => {
  const h = ladderHeight.value
  const redPct = dbToPct(RED_DB)
  const amberPct = dbToPct(AMBER_DB)
  const greenPct = dbToPct(CYAN_DB)
  return Array.from({ length: rows.value }, (_, i) => {
    // i counts from the bottom; the column is drawn top-down and reversed.
    const centerPct = ((i * PITCH + SEG_H / 2) / h) * 100
    const color = centerPct >= redPct ? HOT
      : centerPct >= amberPct ? WARM
        : centerPct >= greenPct ? MID
          : COOL
    return { centerPct, color }
  })
})

/**
 * Per-channel segment state for this frame. Before the first frame the ladder
 * is still drawn, fully dark, so the panel does not reflow as metering starts.
 */
const ladders = computed(() => {
  const meta = segMeta.value
  const h = ladderHeight.value
  const floor = props.floorDb
  const source = bars.value.length
    ? bars.value
    : [{ displayDb: floor, heldPeakDb: floor }]

  return source.map((bar) => {
    const levelPct = dbToPct(bar.displayDb)

    // The hold reads as one segment, so snap it to the nearest one rather
    // than letting it fall between two and light neither. At the floor there
    // is nothing to hold, so no segment is claimed.
    const peakIndex = bar.heldPeakDb <= floor
      ? -1
      : Math.max(0, Math.min(meta.length - 1,
        Math.round((dbToPct(bar.heldPeakDb) / 100 * h - SEG_H / 2) / PITCH)))

    const segments = meta.map((seg, i) => {
      const on = seg.centerPct <= levelPct
      const held = i === peakIndex
      return {
        color: seg.color,
        // Lit runs at full; a hold sitting above the run is dimmed so the two
        // stay tellable apart, and everything else is the dark faceplate.
        opacity: on ? 1 : held ? 0.85 : 0.1,
        glow: on || held,
      }
    })
    // Drawn top-down.
    segments.reverse()
    return { bar, segments }
  })
})

const channelCount = computed(() => Math.max(1, props.levels.length))

// Channel identity is carried in the label rather than drawn: at 6 px a
// segment has no room for a caption, and a stereo pair reads as
// left-then-right.
function channelName(index) {
  if (channelCount.value < 2) return ''
  return index === 0 ? 'left' : 'right'
}

/** Loudest peak across channels — one number over a pair means the hotter. */
const readoutDb = computed(() => {
  let max = props.floorDb
  for (const bar of bars.value) {
    if (bar.heldPeakDb > max) max = bar.heldPeakDb
  }
  return max
})

// At the floor the meter is off the bottom of its own scale, and a number
// there would be a reading the scale cannot show.
const readout = computed(() =>
  readoutDb.value <= props.floorDb ? '-∞' : readoutDb.value.toFixed(1))

// The lamp belongs to the ladders, not to the whole component — the scale
// gutter and the caption are both wider, and stretching to them left it
// floating unaligned above the thing it reports on.
const ladderBlockWidth = computed(() =>
  channelCount.value * SEG_W + (channelCount.value - 1) * CH_GAP)

const visibleTicks = computed(() => TICKS.filter(t => t > props.floorDb))

function segStyle(seg) {
  return {
    width: SEG_W + 'px',
    height: SEG_H + 'px',
    borderRadius: '1px',
    background: seg.color,
    opacity: seg.opacity,
    boxShadow: seg.glow ? `0 0 6px ${seg.color}` : 'none',
  }
}

function ariaText(bar) {
  return bar.displayDb <= props.floorDb ? 'silent' : `${bar.displayDb.toFixed(1)} dBFS`
}
</script>

<template>
  <div class="flex flex-col items-center gap-[7px]">
    <div class="flex items-end" :style="{ gap: showScale ? '5px' : '0' }">
      <!-- Ladder housing. The lamp lives inside it, on the faceplate, rather
           than floating above the component. -->
      <div
        class="flex flex-col items-center"
        style="padding:5px;border-radius:5px;background:#0b0e13;border:1px solid #1c222c"
      >
        <!-- Clip lamp. Latches, and clears on click the way a console does:
             the readout decays within a second or two, so without the latch a
             peak that overshot ten seconds ago leaves no trace. -->
        <div
          v-if="showOver"
          class="mb-[6px]"
          :style="{ width: ladderBlockWidth + 'px' }"
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
            borderRadius: '1.5px',
            background: clipped ? HOT : '#262c37',
            boxShadow: clipped ? `0 0 10px ${HOT}, 0 0 3px ${HOT}` : 'none',
            transition: 'background .12s, box-shadow .12s',
          }"></div>
        </div>

        <div class="flex" :style="{ gap: CH_GAP + 'px' }">
          <div
            v-for="(ladder, ch) in ladders"
            :key="ch"
            class="flex flex-col"
            :style="{ gap: SEG_GAP + 'px', height: ladderHeight + 'px' }"
            role="meter"
            :aria-valuemin="floorDb"
            :aria-valuemax="0"
            :aria-valuenow="Number(ladder.bar.displayDb.toFixed(1))"
            :aria-valuetext="ariaText(ladder.bar)"
            :aria-label="[label, channelName(ch), 'level'].filter(Boolean).join(' ')"
          >
            <!-- No CSS transition on the segments: ballistics are applied
                 above, and a transition restarting every frame never reaches
                 its target. -->
            <div v-for="(seg, i) in ladder.segments" :key="i" :style="segStyle(seg)"></div>
          </div>
        </div>
      </div>

      <!-- Scale. Ticks sit at their true positions; the gutter is sized for
           the widest numeral so the ladders do not shift between panels, and
           inset by the housing padding so it lines up with the segments. -->
      <div
        v-if="showScale"
        class="relative mb-[5px]"
        :style="{ height: ladderHeight + 'px', width: '18px' }"
      >
        <div
          v-for="tick in visibleTicks" :key="tick"
          class="absolute left-0 flex items-center gap-[4px]"
          :style="{ bottom: `calc(${dbToPct(tick)}% - 3px)`, height: '6px' }"
        >
          <span :style="{
            width: LABELLED.has(tick) ? '4px' : '2.5px',
            height: '1px',
            background: 'rgba(255,255,255,.18)',
          }"></span>
          <span
            v-if="LABELLED.has(tick)"
            style="font:500 9px 'JetBrains Mono',monospace;color:#5d6472;line-height:1"
          >{{ tick }}</span>
        </div>
      </div>
    </div>

    <span
      v-if="showReadout"
      :style="{
        font: `600 12px 'JetBrains Mono',monospace`,
        color: clipped ? '#ff9d90' : '#cfd4de',
      }"
    >{{ readout }}</span>

    <span v-if="label" style="font:600 9px 'JetBrains Mono',monospace;letter-spacing:.2em;color:#6f7787">{{ label }}</span>
  </div>
</template>
