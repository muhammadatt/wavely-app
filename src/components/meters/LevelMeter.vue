<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { createReadoutThrottle } from './ballistics.js'

/**
 * Vertical level meter — a segmented LED ladder per channel, a peak-hold
 * line, a clip lamp and a labelled scale. Shared by the plugin panels for
 * their IN and OUT readouts.
 *
 * The ladder is RMS and the readout is peak, which is the split that makes a
 * meter this size useful: the ladder shows how loud the passage sits, the
 * number and the hold line show how close the transients are to the ceiling.
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
const SEG_H = 4
const SEG_GAP = 3
const PITCH = SEG_H + SEG_GAP
const CH_GAP = 2
const MIN_ROWS = 8

// The ladder block is a fixed width whatever the channel count, and the
// channels divide it between them. Sizing the segment instead and letting the
// block follow made a mono meter half the width of a stereo one — so the same
// panel changed shape with the file, and the housing, the lamp, the readout
// and the caption all moved with it.
const LADDER_W = 14

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

const COOL = '#7CE0A8' // '#3FD0DE' blue
const MID = '#6FD6C0'// '#8FD48A' green
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
// eye can follow. The ladder falls faster than the hold line, which is what
// keeps the hold line visible above it.
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
 * Loudest held peak across channels — one number over a pair means the hotter.
 *
 * Refreshed on its own slower clock than the ladder. While the hold is latched
 * the number sits still anyway, but during the release it falls at 20 dB/s,
 * and a tenths digit stepping twice a frame is unreadable. Same throttle the
 * gain-reduction bar's numerals use.
 */
const readoutThrottle = createReadoutThrottle()
const readoutDb = ref(props.floorDb)

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
    // Not throttled: a torn-down meter should read silent at once, not carry
    // its last number for another tenth of a second.
    readoutDb.value = props.floorDb
    rafId = requestAnimationFrame(advance)
    return
  }

  const elapsedMs = lastTs ? now - lastTs : 0
  const elapsedS = elapsedMs / 1000
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
      // line over a digitally silent passage falls away and settles
      // instead of either hanging there or running off the bottom.
      heldPeakDb = heldPeakDb - PEAK_RELEASE_DB_PER_S * elapsedS
    }
    heldPeakDb = Math.max(floor, Math.max(peak, heldPeakDb))

    next[ch] = { displayDb, heldPeakDb }
  }

  bars.value = next

  if (readoutThrottle.due(elapsedMs)) {
    let loudest = floor
    for (const bar of next) {
      if (bar.heldPeakDb > loudest) loudest = bar.heldPeakDb
    }
    readoutDb.value = loudest
  }

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
  const floor = props.floorDb
  const source = bars.value.length
    ? bars.value
    : [{ displayDb: floor, heldPeakDb: floor }]

  return source.map((bar) => {
    const levelPct = dbToPct(bar.displayDb)

    const segments = meta.map((seg) => {
      const on = seg.centerPct <= levelPct
      return {
        color: seg.color,
        opacity: on ? 1 : 0.1,
        glow: on,
      }
    })
    // Drawn top-down.
    segments.reverse()

    // The hold is a hairline riding over the ladder, not a lit segment. Drawn
    // in the ladder's own vocabulary it reads as "the level is briefly up
    // there too", which is the opposite of what it means — it is a mark left
    // behind. A rule in a foreign colour, sitting in the gaps between
    // segments, says "high-water" without any explanation. It also carries
    // the true position rather than the nearest segment's, so the number
    // beneath it and the mark agree.
    const peak = bar.heldPeakDb <= floor
      ? null
      : { pct: dbToPct(bar.heldPeakDb), hot: bar.heldPeakDb >= RED_DB }

    return { bar, segments, peak }
  })
})

const channelCount = computed(() => Math.max(1, props.levels.length))

// Channel identity is carried in the label rather than drawn: at this width a
// segment has no room for a caption, and a stereo pair reads as
// left-then-right.
function channelName(index) {
  if (channelCount.value < 2) return ''
  return index === 0 ? 'left' : 'right'
}

// At the floor the meter is off the bottom of its own scale, and a number
// there would be a reading the scale cannot show.
const readout = computed(() =>
  readoutDb.value <= props.floorDb ? '-∞' : readoutDb.value.toFixed(1))

// A mono meter gets one wide segment rather than one narrow one, so the block
// measures the same either way. Fractional widths are fine — the browser
// subpixel-positions them and the ladder still lands on whole pixels overall.
const segWidth = computed(() =>
  (LADDER_W - (channelCount.value - 1) * CH_GAP) / channelCount.value)

// The lamp belongs to the ladders, not to the whole component — the scale
// gutter and the caption are both wider, and stretching to them left it
// floating unaligned above the thing it reports on.
const ladderBlockWidth = computed(() => LADDER_W)

// Outer width of the housing: the ladders, its padding, its border. The
// readout and the caption are centred on this rather than on the component,
// which includes the scale gutter off to one side and so would sit them
// visibly off to that side of the thing they label.
const HOUSING_PAD = 5
const HOUSING_BORDER = 1
const housingWidth = computed(() =>
  ladderBlockWidth.value + 2 * (HOUSING_PAD + HOUSING_BORDER))

const visibleTicks = computed(() => TICKS.filter(t => t > props.floorDb))

function segStyle(seg) {
  return {
    width: segWidth.value + 'px',
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
  <div class="flex flex-col items-start gap-[7px]">
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
            class="relative flex flex-col"
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

            <!-- Peak hold. Last child so it paints over the ladder. -->
            <div
              v-if="ladder.peak"
              class="absolute left-0 right-0 pointer-events-none"
              :style="{
                bottom: `calc(${ladder.peak.pct}% - 1px)`,
                background: ladder.peak.hot ? '#ff8a7a' : 'rgba(255,255,255,.85)',
                height: '3px',
                borderRadius: '1px',
                boxShadow: `0 0 6px ${ladder.peak.hot ? '#ff8a7a' : 'rgba(255,255,255,.85)'}`,
              }"
            ></div>
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
          <span
            v-if="LABELLED.has(tick)"
            style="font:600 7px 'JetBrains Mono',monospace;color:rgba(255,255,255,.3);line-height:1"
          >{{ tick }}</span>
        </div>
      </div>
    </div>

    <div
      v-if="showReadout || label"
      class="flex flex-col items-center gap-[7px]"
      :style="{ width: housingWidth + 'px' }"
    >
      <span
        v-if="showReadout"
        :style="{
          font: `700 9.5px 'JetBrains Mono',monospace`,
          color: clipped ? '#ff9d90' : 'rgba(255,255,255,.62)',
        }"
      >{{ readout }}</span>

      <span v-if="label" style="font:700 9px 'JetBrains Mono',monospace;letter-spacing:.16em;color:rgba(255,255,255,.45)">{{ label }}</span>
    </div>
  </div>
</template>
