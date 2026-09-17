<script setup>
/**
 * FET Punch curve bench — which static curve runs, and where it sits.
 *
 * ⚠ DELIBERATELY PLAIN, AND NOT BUILT FROM THE DEVICE CHROME, for the same
 * reason `LA2ATuningPanel.vue` is: the knobs and rockers in `../knobs/` are the
 * product's visual language, and using them here would make this read as a
 * feature of the plugin. It is a bench control for A/B-ing the measured curve
 * against the one it replaced, gated off by default (see
 * `isFET1176TuningVisible`).
 *
 * ⚠ THE TWO CONTROLS ARE NOT INDEPENDENT IN PRACTICE, which is why LEGACY is a
 * button and not a third option on each rocker. "The plugin as it was before the
 * FETish capture" is a PAIR of choices — the `tanh`, after the cell — and either
 * one alone is a configuration that never shipped and was never voiced.
 */
import { ref } from 'vue'
import {
  FET1176_TUNING_DEFAULTS, FET1176_LEGACY_TUNING,
  getFET1176Tuning, setFET1176Tuning, resetFET1176Tuning,
  isFET1176TuningDefault, isFET1176TuningLegacy,
} from '../../audio/effects/fet1176Tuning.js'

const props = defineProps({
  accent: { type: String, default: '#4aa3df' },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['change'])

const open = ref(false)
/**
 * A local mirror of the store. The store is plain (no Vue import — see its
 * header), so the panel owns the reactivity and writes through.
 */
const vals = ref(getFET1176Tuning())
const pristine = ref(isFET1176TuningDefault())
const legacy = ref(isFET1176TuningLegacy())

function write(patch) {
  setFET1176Tuning(patch)
  vals.value = getFET1176Tuning()
  pristine.value = isFET1176TuningDefault()
  legacy.value = isFET1176TuningLegacy()
  emit('change')
}

const CHOICES = [
  {
    key: 'fetCurve', label: 'Curve',
    options: [
      {
        id: 'poly', label: 'MEASURED',
        title: 'x − 0.01·x⁴ + 0.01·x⁵ — fitted to Analog Obsession FETish over 24 dB, '
          + 'H2 matching to 0.1 dB at every level',
      },
      {
        id: 'tanh', label: 'TANH',
        title: 'The fitted asymmetric hyperbolic tangent this shipped with before the '
          + 'capture. Cubic-dominant: 75 dB more H2 at −30 dBFS',
      },
    ],
  },
  {
    key: 'fetPosition', label: 'Position',
    options: [
      {
        id: 'preInput', label: 'PRE-INPUT',
        title: 'Ahead of the input attenuator — the shaper sees the source, so saturation '
          + 'is a property of the file and does not move with the Input knob. '
          + 'Reproduces FETish’s behaviour exactly (0.0 dB of swing)',
      },
      {
        id: 'preCell', label: 'PRE-CELL',
        title: 'FETish’s measured topology — but NOT its behaviour on our real-gain '
          + 'Input: H2 swings 79.6 dB across the knob where the reference swings 0.0',
      },
      {
        id: 'postCell', label: 'POST-CELL',
        title: 'On the compressed signal, which is what this kernel did before the capture, '
          + 'and what CLA-76 measures. H2 swings 36.4 dB across the knob',
      },
    ],
  },
  {
    key: 'attackRange', label: 'Attack',
    options: [
      {
        id: 'datasheet', label: 'DATASHEET',
        title: '20–800 µs across the dial — the 1176’s published span, which our constants '
          + 'quote and which ships. Dial 1 / 4 / 7 = 800 / 126 / 20 µs',
      },
      {
        id: 'fetish', label: 'FETish',
        title: '6.37 ms – 159 µs, fitted together with the DEPTH attack schedule. '
          + '⚠ USE BOTH OR NEITHER: with the schedule it reproduces the reference to '
          + '1.15 % across 6–22 dB; this ladder alone is 41 % out and the schedule alone '
          + 'is 36 %, against 88 % for the shipping datasheet ladder',
      },
    ],
  },
  {
    key: 'attackSchedule', label: 'Attack sched',
    options: [
      {
        id: 'none', label: 'FIXED',
        title: 'One constant per dial whatever the reduction. Ships',
      },
      {
        id: 'depth', label: 'DEPTH',
        title: 'The attack constant shortens as the TARGET reduction deepens — FETish '
          + 'attacks 5× faster at 22 dB than at 6 (−0.0926/dB), the mirror of its release, '
          + 'which lengthens. Pair it with the FETish ladder; either alone is far worse '
          + 'than both',
      },
    ],
  },
  {
    key: 'releaseSchedule', label: 'Release',
    options: [
      {
        id: 'depth', label: 'DEPTH',
        title: 'The release constant scales with the current reduction — the limb FETish '
          + 'measurably has: 30 / 70 / 93 / 139 ms at 6.2 / 14.0 / 17.5 / 21.9 dB on one '
          + 'release setting. Ships',
      },
      {
        id: 'none', label: 'FIXED',
        title: 'One constant per knob position whatever the reduction, as before the fit. '
          + 'Note the release ENDPOINTS do not change with this — they are fitted to FETish '
          + 'and ship either way',
      },
    ],
  },
]

/**
 * Arrow / Home / End over a rocker, as the radiogroup role promises. Focus
 * follows selection, which is what the LA-2A bench does and what a small option
 * group should do.
 */
function onKey(e, ch) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
  if (!keys.includes(e.key) || props.disabled) return
  e.preventDefault()
  const ids = ch.options.map(o => o.id)
  const cur = Math.max(0, ids.indexOf(vals.value[ch.key]))
  const next = e.key === 'Home' ? 0
    : e.key === 'End' ? ids.length - 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        ? (cur - 1 + ids.length) % ids.length
        : (cur + 1) % ids.length
  write({ [ch.key]: ids[next] })
  e.currentTarget.querySelectorAll('[role="radio"]')[next]?.focus()
}

function reset() {
  resetFET1176Tuning()
  vals.value = getFET1176Tuning()
  pristine.value = true
  legacy.value = isFET1176TuningLegacy()
  emit('change')
}
</script>

<template>
  <div class="mt-5 border-t border-white/10 pt-3">
    <button
      type="button"
      class="flex w-full items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-white/40 hover:text-white/70"
      @click="open = !open"
    >
      <span class="inline-block w-3 text-center">{{ open ? '−' : '+' }}</span>
      <span>Curve bench</span>
      <span
        v-if="!pristine"
        class="rounded-sm px-1.5 py-px text-[9px] tracking-normal"
        :style="{ background: accent, color: '#1a1a1a' }"
      >{{ legacy ? 'LEGACY' : 'MODIFIED' }}</span>
      <span class="ml-auto normal-case tracking-normal text-white/25">
        {{ open ? '' : 'not a shipping control' }}
      </span>
    </button>

    <div v-if="open" class="mt-3">
      <p class="mb-3 text-[10px] leading-[1.5] text-white/35">
        A/B the curve measured from FETish against the one it replaced. Not part of the
        patch — never saved into a preset and never leaves this session. Both preview and
        APPLY read them, so what you hear is what renders.
      </p>

      <div v-for="ch in CHOICES" :key="ch.key" class="mt-3">
        <div class="flex items-center gap-2">
          <span :id="`fet-curve-${ch.key}`" class="w-[70px] shrink-0 text-[10px] text-white/45">{{ ch.label }}</span>
          <div
            role="radiogroup"
            :aria-labelledby="`fet-curve-${ch.key}`"
            class="flex gap-1"
            @keydown="onKey($event, ch)"
          >
            <button
              v-for="(o, i) in ch.options"
              :key="o.id"
              type="button"
              role="radio"
              :aria-checked="vals[ch.key] === o.id"
              :tabindex="vals[ch.key] === o.id || (!ch.options.some(x => x.id === vals[ch.key]) && i === 0) ? 0 : -1"
              :title="o.title"
              :disabled="disabled"
              class="rounded border px-2 py-[3px] text-[9px] tracking-wide disabled:opacity-30"
              :class="vals[ch.key] === o.id
                ? 'border-sky-400/60 bg-sky-400/10 text-sky-200'
                : 'border-white/15 text-white/45 hover:border-white/35 hover:text-white/80'"
              @click="write({ [ch.key]: o.id })"
            >{{ o.label }}</button>
          </div>
          <button
            type="button"
            class="ml-auto w-3 shrink-0 text-white/25 hover:text-white/70"
            :class="{ 'opacity-0 pointer-events-none': vals[ch.key] === FET1176_TUNING_DEFAULTS[ch.key] }"
            title="Back to the shipping choice"
            :disabled="disabled"
            @click="write({ [ch.key]: FET1176_TUNING_DEFAULTS[ch.key] })"
          >↺</button>
        </div>
      </div>

      <div class="mt-4 flex items-center gap-2">
        <button
          type="button"
          class="rounded border px-2 py-[3px] text-[9px] uppercase tracking-wide disabled:opacity-30"
          :class="legacy
            ? 'border-sky-400/60 bg-sky-400/10 text-sky-200'
            : 'border-white/15 text-white/45 hover:border-white/35 hover:text-white/80'"
          :disabled="disabled"
          title="The kernel exactly as it stood before the FETish capture — the tanh, after the cell. Both controls at once, because either alone is a configuration that never shipped."
          @click="write(FET1176_LEGACY_TUNING)"
        >Legacy kernel</button>
        <button
          type="button"
          class="rounded border border-white/15 px-2 py-[3px] text-[9px] uppercase tracking-wide text-white/45 hover:border-white/35 hover:text-white/80 disabled:opacity-30"
          :class="{ 'opacity-30 pointer-events-none': pristine }"
          :disabled="disabled"
          title="Back to the shipping configuration"
          @click="reset"
        >Reset</button>
        <span class="ml-auto font-mono text-[9px] text-white/30">
          {{ vals.fetCurve }} / {{ vals.fetPosition }} / {{ vals.attackRange }} / {{ vals.attackSchedule }} / {{ vals.releaseSchedule }}
        </span>
      </div>
    </div>
  </div>
</template>
