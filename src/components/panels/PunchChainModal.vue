<script setup>
import { computed, onMounted, watch } from 'vue'
import { usePunchChain } from '../../composables/usePunchChain.js'
import { useEditorState } from '../../composables/useEditorState.js'
import Knob from '../knobs/Knob.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  punchDrive, punchPeakReduction, punchOutput,
  punchAuto, punchAutoBusy, punchMakeupDb,
  punchDensityDb, punchSpreadDb, punchSourceDensityDb, punchSourceSpreadDb,
  punchPreview, punchReduction, punchFetReduction, punchOptoReduction,
  punchInputLevels, punchOutputLevels,
  togglePreview, syncDrive, syncPeakReduction, syncOutput,
  toggleAuto, refreshPlan, apply, teardown, closeModal,
} = usePunchChain()

const { state } = useEditorState()

// Default to engaged when the panel opens, matching the other plugin windows.
onMounted(() => {
  if (!punchPreview.value) togglePreview()
})

// Everything is measured from the selected region, so a new selection needs a
// fresh measurement.
watch(() => state.selection, () => refreshPlan(), { deep: true })

const ACCENT = '#e0a13c'

function formatKnob(v) {
  return String(Math.round(v))
}

function formatOutput(v) {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

const makeupReadout = computed(() => {
  if (!punchAuto.value) return 'OFF'
  if (punchAutoBusy.value) return '···'
  const v = punchMakeupDb.value
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
})

/**
 * The two readouts, each as "what it is now" plus "how far that moved".
 *
 * ⚠ THE DELTA IS THE POINT, NOT THE ABSOLUTE. Neither number means much on its
 * own — density is a level difference whose scale depends on the voice, and
 * spread depends on how varied the take was. What the dials do is MOVE them,
 * and the direction of the move is the thing the plate exists to show: past its
 * own turnover the Opto takes density away while it is still buying
 * consistency, and only a signed delta makes that visible while it happens.
 */
function delta(now, before, betterIsUp) {
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null
  const d = now - before
  return {
    text: `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(1)}`,
    // "Better" is up for density and DOWN for spread, so the two readouts
    // cannot share a sign convention and must not pretend to.
    good: betterIsUp ? d > 0.05 : d < -0.05,
    bad: betterIsUp ? d < -0.05 : d > 0.05,
  }
}

const densityDelta = computed(
  () => delta(punchDensityDb.value, punchSourceDensityDb.value, true))
const spreadDelta = computed(
  () => delta(punchSpreadDb.value, punchSourceSpreadDb.value, false))

function readoutValue(v) {
  return Number.isFinite(v) ? v.toFixed(1) : '—'
}

function deltaColor(d) {
  if (!d) return 'rgba(255,255,255,.3)'
  if (d.good) return ACCENT
  if (d.bad) return 'rgba(255,140,140,.75)'
  return 'rgba(255,255,255,.3)'
}

// Preview is transport playback — the worklet is already in the chain, so what
// makes it live is that audio is running while you turn the knob.
function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

function close() {
  teardown()
}

async function applyAndClose() {
  await apply()
  teardown()
  closeModal()
}
</script>

<template>
  <FloatingWindow
    window-id="punch-chain"
    :z="z"
    :width="640"
    :accent="ACCENT"
    brand-lead="PUNCH"
    brand-tail="CHAIN"
    :engaged="punchPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!punchPreview"
    apply-disabled-hint="Turn Punch Chain on to apply it"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="px-[26px] pt-[20px] pb-[26px]">
      <!-- Both stages' reduction summed. Each stage's own share is under its
           dial, because the sum is a meter reading and not arithmetic — see
           getReduction on the kernel. -->
      <GainReductionBar :reduction-db="punchReduction" :accent="ACCENT" />

      <div class="flex items-start justify-between gap-[20px] mt-[20px]">
        <LevelMeter :levels="punchInputLevels" label="IN" :height="150" />

        <div class="flex-1 flex flex-col items-center">
          <!-- ── The two readouts ────────────────────────────────────────
               Density alone would make the Opto's job look like a mistake:
               past PR ~40 it spends density to buy consistency, which is
               exactly what it is there for. Two numbers, so the trade is
               visible and the user makes the call. -->
          <div class="flex gap-[10px] w-full">
            <div
              v-for="r in [
                { key: 'density', label: 'DENSITY', hint: 'Gated RMS against the 99.9th percentile. Higher is denser — more level for the same peak.', value: punchDensityDb, d: densityDelta },
                { key: 'spread', label: 'LEVEL SPREAD', hint: 'P90−P10 of phrase loudness. Lower is more consistent from line to line.', value: punchSpreadDb, d: spreadDelta },
              ]"
              :key="r.key"
              class="flex-1 rounded-[7px] px-[13px] py-[10px]"
              style="background:rgba(255,255,255,.028);border:1px solid rgba(255,255,255,.055)"
              :title="r.hint"
            >
              <div
                style="font:700 8px 'JetBrains Mono',monospace;letter-spacing:.11em;color:rgba(255,255,255,.34)"
              >{{ r.label }}</div>
              <div class="flex items-baseline gap-[7px] mt-[4px]">
                <span
                  :style="{
                    font: `600 19px 'JetBrains Mono',monospace`,
                    color: punchAutoBusy ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.86)',
                    transition: 'color .15s',
                  }"
                >{{ readoutValue(r.value) }}</span>
                <span
                  style="font:500 9px 'JetBrains Mono',monospace;color:rgba(255,255,255,.3)"
                >dB</span>
                <span
                  v-if="r.d"
                  class="ml-auto"
                  :style="{
                    font: `600 10px 'JetBrains Mono',monospace`,
                    color: deltaColor(r.d),
                  }"
                >{{ r.d.text }}</span>
              </div>
            </div>
          </div>

          <div class="flex gap-[34px] mt-[20px] justify-center">
            <div class="w-[124px] flex flex-col items-center">
              <Knob
                :model-value="punchDrive"
                @update:model-value="syncDrive"
                :min="0" :max="100" :step="1"
                label="Input" :accent="ACCENT" :format-value="formatKnob"
                :disabled="!punchPreview"
              />
              <span
                class="mt-[6px]"
                style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.09em;color:rgba(255,255,255,.3)"
                title="The FET stage's gain reduction right now"
              >FET −{{ punchFetReduction.toFixed(1) }} dB</span>
            </div>

            <div class="w-[124px] flex flex-col items-center">
              <Knob
                :model-value="punchPeakReduction"
                @update:model-value="syncPeakReduction"
                :min="0" :max="100" :step="1"
                label="Peak Reduction" :accent="ACCENT" :format-value="formatKnob"
                :disabled="!punchPreview"
              />
              <span
                class="mt-[6px]"
                style="font:600 8px 'JetBrains Mono',monospace;letter-spacing:.09em;color:rgba(255,255,255,.3)"
                title="The opto stage's gain reduction right now"
              >OPTO −{{ punchOptoReduction.toFixed(1) }} dB</span>
            </div>

            <div class="w-[96px] flex flex-col items-center">
              <Knob
                :model-value="punchOutput"
                @update:model-value="syncOutput"
                :min="-12" :max="12" :step="0.1" :value-font-px="13"
                label="Output" :accent="ACCENT" :format-value="formatOutput"
                :disabled="!punchPreview" bipolar
              />
              <button
                class="mt-[7px] px-2.5 py-[4px] rounded-full cursor-pointer transition-all disabled:cursor-default"
                :style="{
                  background: punchAuto ? 'color-mix(in srgb, ' + ACCENT + ' 16%, transparent)' : 'rgba(255,255,255,.05)',
                  border: `1px solid ${punchAuto ? 'color-mix(in srgb, ' + ACCENT + ' 42%, transparent)' : 'rgba(255,255,255,.09)'}`,
                  color: punchAuto ? 'color-mix(in srgb, ' + ACCENT + ' 55%, #ffffff)' : 'rgba(255,255,255,.4)',
                  font: `700 8.5px 'JetBrains Mono',monospace`,
                  letterSpacing: '.1em',
                  opacity: punchPreview ? 1 : 0.4,
                }"
                :disabled="!punchPreview"
                :title="punchAuto
                  ? 'Auto on: the chain is level-matched to the source and held under its peak, so both dials are character controls rather than loudness ones. Click to switch it off.'
                  : 'Auto off: no makeup and no ceiling — the chain runs at whatever level it lands on. Click to level-match it.'"
                @click="toggleAuto"
              >AUTO {{ makeupReadout }}</button>
            </div>
          </div>
        </div>

        <LevelMeter :levels="punchOutputLevels" label="OUT" :height="150" />
      </div>

      <p
        class="mt-[16px] text-center"
        style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.35)"
      >
        FET Punch into OptoSmooth, level-matched end to end. Input sets how much
        density the fast stage takes; Peak Reduction sets how much line-to-line
        consistency the slow one buys — and past about 40 it starts paying for
        that consistency in density. Both numbers above are measured on the
        render, not predicted.
      </p>
    </div>
  </FloatingWindow>
</template>
