<script setup>
/**
 * PHAT*SS bench — TAPE's curve, its low push and head bump, its place in the
 * chain, and an automatic output trim.
 *
 * ⚠ DELIBERATELY PLAIN, AND NOT BUILT FROM THE DEVICE CHROME, like the FET
 * Punch and OptoSmooth benches: the knobs and rockers in `../knobs/` are the
 * product's visual language, and these are not product controls. CUBIC, no push,
 * no bump, FIRST and OFF ship; the others are kept to A/B against them, gated off in production
 * (`isPhatassBenchVisible`). They are ordinary PHAT*SS params, so preview and
 * APPLY both read them — what you hear is what renders.
 */
import { computed, ref } from 'vue'
import { PHATASS_DEFAULTS } from '../../audio/phatassParams.js'

const props = defineProps({
  /** The panel's params (reads `tapeCurve`, `tapeLowPush`, `tapeHeadBump`, `tapeOrder`, `outputMakeup` and `outputMakeupDb`). */
  params: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
  /** The output trim's measurement is in flight. */
  trimPending: { type: Boolean, default: false },
})
const emit = defineEmits(['set'])

const open = ref(false)

const CHOICES = [
  {
    key: 'tapeCurve', label: 'Tape curve',
    options: [
      { id: 'cubic', label: 'CUBIC', title: 'Ships. Fits the Studer A800 emulation best (0.09 dB rms): only the third harmonic until the peak reaches its flat at 3.52 dB, then a hard clip' },
      { id: 'tanh', label: 'TANH', title: 'Studer fit 0.17. Never flat: more high-order content at light settings, the peak nearer the knob at heavy ones' },
      { id: 'algebraic', label: 'ALGEBRAIC', title: 'Studer fit 0.19. Bends earliest: the most added distortion of the three at every setting' },
      { id: 'hysteresis', label: 'HYSTERESIS', title: 'The Saturation Bench\'s Jiles-Atherton tape loop: it has memory, so kicks are squashed about twice as hard as snares and peaks round off without a hard clip. Closest per-hit match to the Studer A800 on drums. The knob is calibrated on a steady sine (a hit\'s first cycle can lose less); TAPE 8 ≈ bench drive 13. About 3.5× the CPU, slower makeup' },
    ],
  },
  {
    key: 'tapeLowPush', label: 'Low push',
    options: [
      { id: 0, label: 'OFF', title: 'Ships. TAPE drives every frequency alike' },
      { id: 6, label: '+6', title: '+6 dB low shelf (150 Hz) into the curve, undone after: the lows saturate first. On drums, TAPE 6 here squashes the kick like the Studer A800' },
      { id: 12, label: '+12', title: '+12 dB low shelf into the curve, undone after. On a drum machine, TAPE 2 here squashes the kick like the Studer A800' },
      { id: 18, label: '+18', title: '+18 dB low shelf into the curve, undone after: past the Studer at most settings' },
    ],
  },
  {
    key: 'tapeHeadBump', label: 'Head bump',
    options: [
      { id: 0, label: 'OFF', title: 'Ships. No low lift' },
      { id: 3, label: '+3', title: '+3 dB low shelf (40 Hz) ahead of TAPE, kept in the output: the tape machine\'s low lift, driving the kick into the curve' },
      { id: 6, label: '+6', title: '+6 dB low shelf ahead of TAPE, kept. With TAPE 12 this matches the Studer A800 drum machine\'s kick-against-snare balance (the drums render needed none)' },
      { id: 9, label: '+9', title: '+9 dB low shelf ahead of TAPE, kept: past both Studer renders' },
    ],
  },
  {
    key: 'tapeOrder', label: 'Tape order',
    options: [
      { id: 'first', label: 'FIRST', title: 'Ships. TAPE → makeup → Warmth: Warmth works on the rounded signal and is never clipped by TAPE' },
      { id: 'last', label: 'LAST', title: 'Warmth → guard → TAPE → makeup, the order before October 2026. The makeup is measured through Warmth (slower on long selections) and re-measures when Warmth moves' },
    ],
  },
  {
    key: 'outputMakeup', label: 'Output trim',
    options: [
      { id: 'off', label: 'OFF', title: 'Ships. No automatic trim: the output is whatever the chain and the Output knob make it' },
      { id: 'peak', label: 'PEAK', title: 'Trims the whole plugin so its output peak lands on the selection\'s own peak. TAPE\'s makeup is peak-restoring either way' },
      { id: 'rms', label: 'RMS', title: 'Trims the whole plugin so its output RMS matches the selection\'s: a level-matched A/B against bypass' },
    ],
  },
]

const trimText = computed(() => {
  if (props.params.outputMakeup !== 'peak' && props.params.outputMakeup !== 'rms') return ''
  if (props.trimPending) return 'trim …'
  const v = Number(props.params.outputMakeupDb) || 0
  return `trim ${v >= 0 ? '+' : ''}${v.toFixed(2)} dB`
})

const pristine = computed(() => CHOICES.every(ch => props.params[ch.key] === PHATASS_DEFAULTS[ch.key]))

function set(key, value) {
  if (props.disabled || props.params[key] === value) return
  emit('set', key, value)
}

function onKey(e, ch) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
  if (!keys.includes(e.key) || props.disabled) return
  e.preventDefault()
  const ids = ch.options.map(o => o.id)
  const cur = Math.max(0, ids.indexOf(props.params[ch.key]))
  const next = e.key === 'Home' ? 0
    : e.key === 'End' ? ids.length - 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
        ? (cur - 1 + ids.length) % ids.length
        : (cur + 1) % ids.length
  set(ch.key, ids[next])
  e.currentTarget.querySelectorAll('[role="radio"]')[next]?.focus()
}

function reset() {
  for (const ch of CHOICES) set(ch.key, PHATASS_DEFAULTS[ch.key])
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
      <span>Tape bench</span>
      <span
        v-if="!pristine"
        class="rounded-sm px-1.5 py-px text-[9px] tracking-normal bg-amber-300 text-[#1a1a1a]"
      >MODIFIED</span>
      <span class="ml-auto normal-case tracking-normal text-white/25">
        {{ open ? '' : 'not a shipping control' }}
      </span>
    </button>

    <div v-if="open" class="mt-3">
      <p class="mb-3 text-[10px] leading-[1.5] text-white/35">
        A/B TAPE's curve, its place in the chain and an automatic output trim against what ships (CUBIC, no push, no bump, FIRST, OFF). With a low push the TAPE knob is a drive: a kick can lose more than its number.
        Hidden in production builds. Both preview and APPLY read them.
      </p>

      <div v-for="ch in CHOICES" :key="ch.key" class="mt-3">
        <div class="flex items-center gap-2">
          <span :id="`phatass-bench-${ch.key}`" class="w-[70px] shrink-0 text-[10px] text-white/45">{{ ch.label }}</span>
          <div
            role="radiogroup"
            :aria-labelledby="`phatass-bench-${ch.key}`"
            class="flex gap-1"
            @keydown="onKey($event, ch)"
          >
            <button
              v-for="(o, i) in ch.options"
              :key="o.id"
              type="button"
              role="radio"
              :aria-checked="params[ch.key] === o.id"
              :tabindex="params[ch.key] === o.id || (!ch.options.some(x => x.id === params[ch.key]) && i === 0) ? 0 : -1"
              :title="o.title"
              :disabled="disabled"
              class="rounded border px-2 py-[3px] text-[9px] tracking-wide disabled:opacity-30"
              :class="params[ch.key] === o.id
                ? 'border-amber-300/60 bg-amber-300/10 text-amber-100'
                : 'border-white/15 text-white/45 hover:border-white/35 hover:text-white/80'"
              @click="set(ch.key, o.id)"
            >{{ o.label }}</button>
          </div>
          <button
            type="button"
            class="ml-auto w-3 shrink-0 text-white/25 hover:text-white/70"
            :class="{ 'opacity-0 pointer-events-none': params[ch.key] === PHATASS_DEFAULTS[ch.key] }"
            title="Back to the shipping choice"
            :disabled="disabled"
            @click="set(ch.key, PHATASS_DEFAULTS[ch.key])"
          >↺</button>
        </div>
      </div>

      <div class="mt-4 flex items-center gap-2">
        <button
          type="button"
          class="rounded border border-white/15 px-2 py-[3px] text-[9px] uppercase tracking-wide text-white/45 hover:border-white/35 hover:text-white/80 disabled:opacity-30"
          :class="{ 'opacity-30 pointer-events-none': pristine }"
          :disabled="disabled"
          title="Back to the shipping configuration"
          @click="reset"
        >Reset</button>
        <span v-if="trimText" class="font-mono text-[9px] text-amber-100/60">{{ trimText }}</span>
        <span class="ml-auto font-mono text-[9px] text-white/30">{{ params.tapeCurve }} / push {{ params.tapeLowPush }} / bump {{ params.tapeHeadBump }} / {{ params.tapeOrder }} / {{ params.outputMakeup }}</span>
      </div>
    </div>
  </div>
</template>
