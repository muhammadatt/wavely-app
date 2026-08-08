<script setup>
import { computed, ref, watch } from 'vue'

/**
 * Vertical segmented level meter — a column per channel, a peak-hold line,
 * an over indicator and a labelled scale. Shared by the plugin panels for
 * their IN and OUT readouts.
 *
 * The bar is RMS and the readout is peak, which is the split that makes a
 * meter this size useful: the bar shows how loud the passage sits, the
 * number and the hold line show how close the transients are to the ceiling.
 */
const props = defineProps({
  // RMS level in dBFS, the bar reading.
  db: { type: Number, required: true },
  // Sample peak in dBFS. Drives the hold line, the readout and the over
  // indicator. Callers without a peak source can omit it and get the old
  // bar-only meter.
  peakDb: { type: Number, default: -Infinity },
  label: { type: String, default: '' },
  channels: { type: Number, default: 2 },
  height: { type: Number, default: 150 },
  // Bottom of the scale. The top is always 0 dBFS.
  floorDb: { type: Number, default: -60 },
  // Peak at or above this latches the over indicator. 0 dBFS is the point a
  // float sample can no longer survive the trip to an integer file.
  clipDb: { type: Number, default: 0 },
  showScale: { type: Boolean, default: true },
  showReadout: { type: Boolean, default: true },
})

// Marks worth engraving, in dBFS. Only some carry a numeral — the rest are
// bare ticks, so the scale stays readable on the shortest panel that uses it.
const TICKS = [-6, -12, -18, -24, -36, -48]
const LABELLED = new Set([-6, -18, -36])

// Zone edges in dBFS. Round numbers that land on ticks, so the colour change
// and the engraving agree.
const AMBER_DB = -18
const RED_DB = -6

// Peak-hold ballistics: dwell, then fall at a constant rate.
const HOLD_MS = 1200
const DECAY_DB_PER_S = 20

/** Position of a dB value on the scale, 0-100 from the floor up. */
function dbToPct(db) {
  const span = -props.floorDb
  return Math.max(0, Math.min(100, ((db - props.floorDb) / span) * 100))
}

const fillPct = computed(() => (Number.isFinite(props.db) ? dbToPct(props.db) : 0))

/**
 * The gradient is sized to the full track and pinned to its bottom edge, so
 * the zones stay at fixed dB positions. Left to resolve against the fill —
 * which is what a plain `background` on a percentage-height element does —
 * they would scale with the reading, and every level would render with a red
 * tip.
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

const heldPeakDb = ref(-Infinity)
const clipped = ref(false)
let holdUntil = 0
let lastTs = 0

watch(() => props.peakDb, (peak) => {
  // A non-finite peak means the graph is not running — no real recording
  // reaches digital silence. Clear rather than decay, so a torn-down meter
  // cannot strand a hold line at whatever it last saw.
  if (!Number.isFinite(peak)) {
    heldPeakDb.value = -Infinity
    clipped.value = false
    lastTs = 0
    return
  }

  const now = performance.now()
  const elapsedS = lastTs ? (now - lastTs) / 1000 : 0
  lastTs = now

  if (peak >= props.clipDb) clipped.value = true

  if (peak >= heldPeakDb.value || !Number.isFinite(heldPeakDb.value)) {
    heldPeakDb.value = peak
    holdUntil = now + HOLD_MS
  } else if (now >= holdUntil) {
    heldPeakDb.value = Math.max(peak, heldPeakDb.value - DECAY_DB_PER_S * elapsedS)
  }
// Immediate, so a peak that is already set at mount — or one that arrives and
// then holds perfectly steady — still registers. A plain watcher only sees
// changes, which would leave the readout at -∞ and the over lamp dark.
}, { immediate: true })

const heldPeakPct = computed(() =>
  Number.isFinite(heldPeakDb.value) ? dbToPct(heldPeakDb.value) : 0)

const readout = computed(() =>
  Number.isFinite(heldPeakDb.value) ? heldPeakDb.value.toFixed(1) : '-∞')

const ariaText = computed(() =>
  Number.isFinite(props.db) ? `${props.db.toFixed(1)} dBFS` : 'silent')
</script>

<template>
  <div class="flex flex-col items-center gap-[7px]">
    <!-- Over indicator. Latches, and clears on click the way a console does. -->
    <button
      v-if="showReadout"
      type="button"
      class="rounded-[2px] cursor-pointer"
      :style="{
        width: '100%',
        minWidth: '30px',
        height: '7px',
        border: '1px solid rgba(255,255,255,.07)',
        background: clipped ? '#e35d4f' : 'rgba(255,255,255,.04)',
        boxShadow: clipped ? '0 0 8px rgba(227,93,79,.7)' : 'none',
      }"
      :aria-label="clipped ? 'Over — click to reset' : 'No overs'"
      :aria-pressed="clipped"
      @click="clipped = false"
    ></button>

    <div class="flex items-end gap-[5px]">
      <div class="flex gap-[3px]">
        <div
          v-for="ch in channels" :key="ch"
          class="relative w-[9px] rounded-[3px]"
          :style="{ height: height + 'px' }"
          style="background:#07090c;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)"
          role="meter"
          :aria-valuemin="floorDb"
          :aria-valuemax="0"
          :aria-valuenow="Number.isFinite(db) ? Number(db.toFixed(1)) : floorDb"
          :aria-valuetext="ariaText"
          :aria-label="label ? `${label} level` : 'Level'"
        >
          <!-- No CSS transition: the source already updates every frame, and a
               transition that restarts each frame never lands on its target.
               Designed ballistics are a separate job from drawing the bar. -->
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
           the widest numeral so the columns do not shift between panels. -->
      <div v-if="showScale" class="relative" :style="{ height: height + 'px', width: '17px' }">
        <div
          v-for="tick in TICKS.filter(t => t > floorDb)" :key="tick"
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
