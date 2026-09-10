<script setup>
/**
 * OptoSmooth distortion bench — the tuning constants as sliders.
 *
 * ⚠ DELIBERATELY PLAIN, AND NOT BUILT FROM THE DEVICE CHROME. The knobs, rockers
 * and lamp pills in `../knobs/` are the product's visual language; using them
 * here would make this read as a feature of the plugin. It is a bench control
 * for judging the distortion by ear against reference plugins, gated off by
 * default (see `isLA2ATuningVisible`), and it should look like an instrument
 * panel rather than part of the unit.
 *
 * ⚠ EVERY VALUE HERE IS FITTED TO SOMETHING. The two cell constants come from
 * the hardware paper, the two valve constants from the -63.80 dBc H2 anchor,
 * and the rectifier pole is the one mechanism measured to move the harmonic
 * PROFILE rather than the level. Nothing dialled in here ships until it has
 * been back through the ledger, which is what COPY exists for.
 */
import { computed, ref } from 'vue'
import {
  LA2A_TUNING_DEFAULTS, getLA2ATuning, setLA2ATuning, resetLA2ATuning,
  isLA2ATuningDefault,
} from '../../audio/effects/la2aTuning.js'

const props = defineProps({
  accent: { type: String, default: '#f5a623' },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['change'])

/**
 * A local mirror of the store. The store is plain (no Vue import — see its
 * header), so the panel owns the reactivity and writes through.
 */
const vals = ref(getLA2ATuning())
const pristine = ref(isLA2ATuningDefault())

function write(patch) {
  setLA2ATuning(patch)
  vals.value = getLA2ATuning()
  pristine.value = isLA2ATuningDefault()
  emit('change')
}

const open = ref(false)

/**
 * ⚠ THE RECTIFIER POLE HAS A HOLE IN IT AT THE DETECTOR'S OWN TIME CONSTANT.
 * `rel` is `rect / env - 1`; smoothing the numerator to the denominator's 0.5 ms
 * drives it to zero and the cell modulation vanishes (H3 measured -85.1 dBc
 * against -33.8 off). It is a real setting and worth hearing once, so it is
 * flagged rather than blocked.
 */
const NULL_MS = 0.5
const rectNulling = computed(() =>
  Math.abs(vals.value.rectLpMs - NULL_MS) < 0.06 && vals.value.rectLpMs > 0
)

const CONTROLS = [
  {
    key: 'cellMod', label: 'Cell depth', min: 0, max: 1, step: 0.01, digits: 2,
    hint: 'Master on the cell modulation. This is the audible distortion — 0 removes it.',
  },
  {
    key: 'cellModMax', label: 'Cell max', min: 0, max: 0.4, step: 0.0025, digits: 4,
    hint: 'Modulation depth at full compression. Fitted to the hardware paper.',
  },
  {
    key: 'cellModTauDb', label: 'Cell onset', min: 0.5, max: 20, step: 0.05, digits: 3, unit: ' dB',
    hint: 'How quickly depth rises with gain reduction. Smaller = distortion arrives sooner.',
  },
  {
    key: 'rectLpMs', label: 'Rect pole', min: 0, max: 5, step: 0.02, digits: 2, unit: ' ms',
    hint: 'One-pole on the rectifier. 0 is off. The only control that changes the harmonic PROFILE: at 2 ms the H3-to-H9 spread opens from 32 to 42 dB.',
  },
  {
    key: 'tubeDriveLin', label: 'Valve drive', min: 0.02, max: 1.2, step: 0.002, digits: 4,
    hint: 'Anchored to the paper’s -63.80 dBc H2 median. Measures ~30 dB below the cell at working depths.',
  },
  {
    key: 'tubeBias', label: 'Valve bias', min: 0, max: 0.4, step: 0.002, digits: 3,
    hint: 'Operating-point offset — what makes the valve stage even-order at all.',
  },
  {
    key: 'cellCurveDriveMax', label: 'Sat depth', min: 0, max: 24, step: 0.05, digits: 2,
    hint: 'Cell shaper drive at full compression. Only live with the cell set to Tube Sat. The default is level-matched to the gain modulation so an A/B compares character, not loudness.',
  },
  {
    key: 'vocalSatCurveDrive', label: 'Sat drive', min: 0.2, max: 8, step: 0.02, digits: 2,
    hint: 'Where the imported curve sits on its transfer. 2.38 reconstructs Tube Sat’s own operating point at nominal level.',
  },
]

/**
 * The two curve selectors. Peers rather than on/off, which is why they are
 * rockers and not checkboxes: a fitted mechanism and an auditioned one are two
 * different things, not more and less of one thing.
 */
const CURVE_CHOICES = [
  {
    key: 'tubeCurve', label: 'Valve curve',
    options: [
      { id: 'tanh', label: 'TANH', title: 'The fitted biased hyperbolic tangent — anchored to the paper’s H2 median' },
      { id: 'vocalsat', label: 'TUBE SAT', title: 'Tube Saturation’s curve at its panel defaults' },
    ],
  },
  {
    key: 'cellCurve', label: 'Cell mechanism',
    options: [
      { id: 'gainmod', label: 'GAIN MOD', title: 'Detector ripple modulating the gain — fitted to the hardware paper' },
      { id: 'vocalsat', label: 'TUBE SAT', title: 'Tube Saturation’s curve as a waveshaper at the cell. Replaces the modulation; this is where ~95% of the plugin’s distortion lives' },
    ],
  },
]

const fmt = (c, v) => v.toFixed(c.digits) + (c.unit || '')
const isDefault = (c) => vals.value[c.key] === LA2A_TUNING_DEFAULTS[c.key]

function reset() {
  resetLA2ATuning()
  vals.value = getLA2ATuning()
  pristine.value = true
  emit('change')
}

/** The current state as something that can be pasted into the ledger. */
const copied = ref(false)
async function copyConstants() {
  const v = vals.value
  const lines = [
    '// OptoSmooth bench tuning',
    `CELL_MOD_MAX    = ${v.cellModMax}`,
    `CELL_MOD_TAU_DB = ${v.cellModTauDb}`,
    `TUBE_DRIVE_LIN  = ${v.tubeDriveLin}`,
    `TUBE_BIAS       = ${v.tubeBias}`,
    `rectLpMs        = ${v.rectLpMs}`,
    `cellMod         = ${v.cellMod}`,
    `tube            = ${v.tube}`,
    `tubeCurve       = ${v.tubeCurve}`,
    `cellCurve       = ${v.cellCurve}`,
    `cellCurveDriveMax  = ${v.cellCurveDriveMax}`,
    `vocalSatCurveDrive = ${v.vocalSatCurveDrive}`,
    `vocalSatLeanPositive = ${v.vocalSatLeanPositive}`,
  ].join('\n')
  try {
    await navigator.clipboard.writeText(lines)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1400)
  } catch {
    // Clipboard can be refused (permissions, insecure origin). Falling back to
    // the console keeps a tuning session's numbers recoverable either way.
    console.log(lines)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1400)
  }
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
      <span>Distortion bench</span>
      <span
        v-if="!pristine"
        class="rounded-sm px-1.5 py-px text-[9px] tracking-normal"
        :style="{ background: accent, color: '#1a1a1a' }"
      >MODIFIED</span>
      <span class="ml-auto normal-case tracking-normal text-white/25">
        {{ open ? '' : 'not a shipping control' }}
      </span>
    </button>

    <div v-if="open" class="mt-3">
      <p class="mb-3 text-[10px] leading-[1.5] text-white/35">
        Bench controls for judging the distortion by ear. Not part of the patch — these
        are never saved into a preset and never leave this session. Both preview and
        APPLY read them, so what you hear is what renders.
      </p>

      <div
        v-for="c in CONTROLS"
        :key="c.key"
        class="mb-2.5"
        :title="c.hint"
      >
        <div class="flex items-baseline gap-2 text-[10px]">
          <span class="w-[68px] shrink-0 text-white/55">{{ c.label }}</span>
          <input
            type="range"
            class="h-1 flex-1 accent-current"
            :style="{ color: accent }"
            :min="c.min" :max="c.max" :step="c.step"
            :value="vals[c.key]"
            :disabled="disabled"
            @input="write({ [c.key]: $event.target.valueAsNumber })"
          />
          <span
            class="w-[74px] shrink-0 text-right font-mono tabular-nums"
            :class="isDefault(c) ? 'text-white/40' : 'text-white/90'"
          >{{ fmt(c, vals[c.key]) }}</span>
          <button
            type="button"
            class="w-3 shrink-0 text-white/25 hover:text-white/70"
            :class="{ 'opacity-0 pointer-events-none': isDefault(c) }"
            title="Back to the shipping constant"
            @click="write({ [c.key]: LA2A_TUNING_DEFAULTS[c.key] })"
          >↺</button>
        </div>
        <p v-if="c.key === 'rectLpMs' && rectNulling" class="ml-[76px] mt-1 text-[9px] text-amber-400/80">
          At the detector's own 0.5 ms the modulation nulls out — rect/env → 1.
        </p>
      </div>

      <div v-for="ch in CURVE_CHOICES" :key="ch.key" class="mt-3">
        <div class="flex items-center gap-2">
          <span class="w-[70px] shrink-0 text-[10px] text-white/45">{{ ch.label }}</span>
          <div class="flex gap-1">
            <button
              v-for="o in ch.options"
              :key="o.id"
              type="button"
              :title="o.title"
              :disabled="disabled"
              class="rounded border px-2 py-[3px] text-[9px] tracking-wide disabled:opacity-30"
              :class="vals[ch.key] === o.id
                ? 'border-amber-400/60 bg-amber-400/10 text-amber-200'
                : 'border-white/15 text-white/45 hover:border-white/35 hover:text-white/80'"
              @click="write({ [ch.key]: o.id })"
            >{{ o.label }}</button>
          </div>
        </div>
      </div>

      <p
        v-if="vals.cellCurve === 'vocalsat'"
        class="ml-[76px] mt-1 text-[9px] text-amber-400/80"
      >
        Replaces the gain modulation — Cell depth / max / onset are inert.
      </p>

      <label
        v-if="vals.tubeCurve === 'vocalsat' || vals.cellCurve === 'vocalsat'"
        class="mt-3 flex items-center gap-2 text-[10px] text-white/55"
      >
        <input
          type="checkbox"
          :checked="vals.vocalSatLeanPositive"
          :disabled="disabled"
          @change="write({ vocalSatLeanPositive: $event.target.checked })"
        />
        <span>Lean positive</span>
        <span class="text-white/25">— which polarity gets the hard knee</span>
      </label>

      <label class="mt-3 flex items-center gap-2 text-[10px] text-white/55">
        <input
          type="checkbox"
          :checked="vals.tube"
          :disabled="disabled"
          @change="write({ tube: $event.target.checked })"
        />
        <span>Valve stage</span>
        <span class="text-white/25">— off isolates the cell</span>
      </label>

      <div class="mt-3 flex gap-2">
        <button
          type="button"
          class="rounded border border-white/15 px-2 py-1 text-[10px] text-white/60 hover:border-white/35 hover:text-white/90"
          @click="copyConstants"
        >{{ copied ? 'Copied' : 'Copy constants' }}</button>
        <button
          type="button"
          class="rounded border border-white/15 px-2 py-1 text-[10px] text-white/60 hover:border-white/35 hover:text-white/90 disabled:opacity-30"
          :disabled="pristine"
          @click="reset"
        >Reset all</button>
      </div>
    </div>
  </div>
</template>
