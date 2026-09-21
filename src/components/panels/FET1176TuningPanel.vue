<script setup>
/**
 * FET Punch curve bench — where the static curve sits, and which ballistics
 * and threshold laws run.
 *
 * ⚠ DELIBERATELY PLAIN, AND NOT BUILT FROM THE DEVICE CHROME, for the same
 * reason `LA2ATuningPanel.vue` is: the knobs and rockers in `../knobs/` are the
 * product's visual language, and using them here would make this read as a
 * feature of the plugin. It is a bench control for A/B-ing the laws that are
 * still open against the ones that ship, gated off by default (see
 * `isFET1176TuningVisible`).
 *
 * ⚠ THE CURVE SELECTOR AND THE LEGACY BUTTON ARE BOTH GONE, AND THE KERNEL MODE
 * IS NOT. `fetCurve: 'tanh'` is cubic-dominant — its H2 rises about 1 dB per dB
 * where FETish measures 3 — so no value of `fetDrive` was ever going to reach
 * the measured curve, and a rocker offering a falsified shape as a peer of a
 * measured one misrepresents both. The button went with it: "the plugin before
 * the FETish capture" is a PAIR of choices, the tanh AFTER the cell, and a
 * button that restored half of that pair is the exact silent-partial-restore
 * bug `test/dsp/fet1176Curve.test.js` was written to catch.
 *
 * `FET_LEGACY_PATCH` remains a kernel patch and `fetCurve` remains a tuning-store
 * key, so the pre-capture kernel is still reachable — from code, where the tests
 * that measure against it live.
 *
 * ⚠⚠ AND THE LEGACY BADGE WENT WITH THEM, because it could no longer light. An
 * earlier version of this note claimed the remaining rockers could still be walked
 * into that configuration by hand; they cannot. `isFET1176TuningLegacy()` requires
 * `fetCurve: 'tanh'`, and with the curve rocker gone this panel has no way to set
 * it — so the predicate was dead and the badge read MODIFIED forever. The
 * predicate itself stays exported: `fet1176Curve.test.js` uses it to pin that the
 * bench can express every key the legacy patch carries. Caught by Copilot on PR #160.
 */
import { ref } from 'vue'
import {
  FET1176_TUNING_DEFAULTS,
  getFET1176Tuning, setFET1176Tuning, resetFET1176Tuning,
  isFET1176TuningDefault,
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

function write(patch) {
  setFET1176Tuning(patch)
  vals.value = getFET1176Tuning()
  pristine.value = isFET1176TuningDefault()
  emit('change')
}

const CHOICES = [
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
        title: '20–800 µs across the dial — the 1176’s published span, and what ships. '
          + 'Dial 1 / 4 / 7 = 800 / 126 / 20 µs before the depth schedule scales them. '
          + '⚠ Both references measure SLOWER than this everywhere: their nominal 20 µs '
          + 'lands at our dial 1.6 (FETish) and 2.3 (CLA-76)',
      },
      {
        id: 'fetish', label: 'FETish',
        title: '6.37 ms – 159 µs, fitted together with the DEPTH schedule — the pair '
          + 'reproduces the reference to 1.15 % across 6–22 dB, either half alone ~36 %. '
          + '⚠ BUT IT FLATTENS THE KNOB: at 12 dB the overshoot spans 1.5 dB across all '
          + 'seven dials against 9.7 for the datasheet ladder, so the control stops '
          + 'discriminating. Accurate, and barely playable',
      },
    ],
  },
  {
    key: 'attackSchedule', label: 'Attack sched',
    options: [
      {
        id: 'none', label: 'FIXED',
        title: 'One constant per dial whatever the reduction — what shipped before the '
          + 'fit. Still a complete model rather than half of one: the datasheet ladder '
          + 'was never scaled for a schedule, so datasheet + FIXED is internally '
          + 'consistent, just not what either reference does',
      },
      {
        id: 'depth', label: 'DEPTH',
        title: 'The attack constant shortens as the TARGET reduction deepens — FETish '
          + 'attacks 5× faster at 22 dB than at 6 (−0.0926/dB), the mirror of its release, '
          + 'which lengthens. SHIPS, on the datasheet ladder — which keeps 8.3 dB of the '
          + 'knob’s 9.7 dB range where the FETish ladder leaves 1.5. CLA-76 corroborates '
          + 'the depth dependence independently',
      },
    ],
  },
  {
    key: 'ratioThreshold', label: 'Ratio thr',
    options: [
      {
        id: 'moving', label: 'MOVING',
        title: 'SHIPS. The threshold RISES 1.712 dB per octave of ratio — CLA-76’s '
          + 'measured behaviour (3.88–4.11 dB across the four buttons at every drive, '
          + 'worst residual 0.135 dB) and what the UA manual describes: “selecting '
          + 'higher ratios also raises the threshold level”. Higher ratios compress '
          + 'LESS at the same Input, so the ratio button is closer to a character '
          + 'control than a level control. ⚠ Ratio 4 is the anchor and does not move, '
          + 'so 4:1 patches are unchanged; 8/12/20 were all re-voiced by this and '
          + 'Consonant Control and Parallel Thickener were re-cut for it',
      },
      {
        id: 'fixed', label: 'FIXED',
        title: 'One threshold for all four ratio buttons — what shipped before the '
          + 'CLA-76 captures, and what reproduces FETish EXACTLY: 16 captures, four '
          + 'buttons at four Input positions, effective threshold identical to the '
          + 'printed digit every time (0.00 dB of spread). ⚠ FETish contradicts its own '
          + 'manual here, which is why it is the alternative and not the default. '
          + 'FET_LEGACY_PATCH selects it',
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
        title: '⚠ HALF A MODEL, LIKE THE ATTACK PAIR. One constant per knob position, but '
          + 'the endpoints were scaled 1.813× to compose WITH the schedule and cannot be '
          + 'switched from here — so turning it off leaves every dial ~1.8× long: 80 % rms '
          + 'against the reference where the shipping pair is 0.8 %. For hearing what the '
          + 'schedule does, not for matching anything',
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
      >MODIFIED</span>
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
          class="rounded border border-white/15 px-2 py-[3px] text-[9px] uppercase tracking-wide text-white/45 hover:border-white/35 hover:text-white/80 disabled:opacity-30"
          :class="{ 'opacity-30 pointer-events-none': pristine }"
          :disabled="disabled"
          title="Back to the shipping configuration"
          @click="reset"
        >Reset</button>
        <span class="ml-auto font-mono text-[9px] text-white/30">
          {{ vals.fetPosition }} / {{ vals.attackRange }} / {{ vals.attackSchedule }} / {{ vals.ratioThreshold }} / {{ vals.releaseSchedule }}
        </span>
      </div>
    </div>
  </div>
</template>
