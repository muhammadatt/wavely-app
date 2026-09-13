<script setup>
/**
 * FET Punch on the Modula components — a UI evaluation duplicate.
 *
 * Built from the primitives in `src/components/modula/` (from the Plugin UI
 * Kit's `Compressor.dc.html`), but NOT the design's layout: that was a
 * 1060 px showcase with a needle meter and a switch bay, and it put the
 * output fader below the fold. This is the same plugin laid out for the way
 * it is actually used, in the order a compressor is set:
 *
 *   1. GAIN REDUCTION across the top — the app's own bar, kept on purpose. It
 *      is the instrument the OptoSmooth panel shows, and the two compressors
 *      cannot be compared through two different meters. Same reasoning for
 *      the IN / OUT LevelMeters: the ladder + peak-hold + clip lamp carry
 *      information the design's 16-segment ladder does not.
 *   2. The main strip: IN meter · INPUT · OUTPUT + AUTO · OUT meter. Signal
 *      flows left to right, and the two big knobs are the hardware's two big
 *      knobs — the pair you have a hand on while listening. Both wear the
 *      kit's DRIVE face: tick scale, collar, dot pointer.
 *   3. The control strip: ATTACK and RELEASE as small detented knobs (seven
 *      positions, like the hardware dials) wearing the kit's GAIN face — an
 *      LED per position — then FET DRIVE · MIX, then RATIO and the sidechain
 *      HPF as segments. Ratio is push-buttons on the 1176, so
 *      a segment is the honest control; the HPF's three named stops do not
 *      need the design's switch-plus-slide.
 *
 * Every control drives the real FET Punch through the same `useFET1176()`
 * singleton as `FET1176Modal.vue`, so the two windows are one plugin behind
 * two faces. The chassis's power button IS the engage control, so the harness
 * lamp is turned off rather than duplicated.
 */
import { computed, onMounted, watch } from 'vue'
import { useFET1176 } from '../../composables/useFET1176.js'
import { useEditorState } from '../../composables/useEditorState.js'
import { useWindows } from '../../composables/useWindows.js'
import { usePluginPresets } from '../../composables/usePluginPresets.js'
import { attackSecondsForDial, releaseSecondsForDial } from '../../audio/fet1176Processor.js'
import { FET_PUNCH_PRESET_PLUGIN } from '../../audio/pluginPresets/index.js'
import FloatingWindow from './FloatingWindow.vue'
import PresetMenu from './PresetMenu.vue'
import ModulaChassis from '../modula/ModulaChassis.vue'
import ModulaCard from '../modula/ModulaCard.vue'
import ModulaKnob from '../modula/ModulaKnob.vue'
import ModulaSwitch from '../modula/ModulaSwitch.vue'
import ModulaSegment from '../modula/ModulaSegment.vue'
import ModulaStepper from '../modula/ModulaStepper.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainReductionBar from '../meters/GainReductionBar.vue'
import { MODULA_ACCENT, MODULA_SECOND } from '../modula/modulaTheme.js'

defineProps({ z: { type: Number, default: 500 } })

// Registry id of this window. Must match the entry in src/ui/registry.js and
// the literal `window-id` on the harness below (a test reads that literal).
const WINDOW_ID = 'fet-punch-modula'

const {
  fetInput, fetOutput, fetAttack, fetRelease, fetRatio, fetDrive, fetScHpf, fetMix,
  fetAutoMakeup, fetAutoMakeupBusy, fetPreview, fetReduction, fetInputLevels, fetOutputLevels,
  togglePreview, syncInput, syncOutput, syncAttack, syncRelease, syncRatio,
  syncDrive, syncScHpf, syncMix, toggleAutoMakeup, refreshAutoMakeup, resetLiveMakeup,
  apply, teardown,
} = useFET1176()

const { state } = useEditorState()
const { closeWindow } = useWindows()

// Same read/write pair and the same ordering constraint as the shipping
// faceplate: Output goes last and through the AUTO decision, because
// `syncOutput` is a take-over that drops AUTO and accepts the value.
const presets = usePluginPresets(FET_PUNCH_PRESET_PLUGIN, {
  read: () => ({
    inputDrive: fetInput.value,
    output: fetOutput.value,
    attack: fetAttack.value,
    release: fetRelease.value,
    ratio: fetRatio.value,
    fetDrive: fetDrive.value,
    scHpf: fetScHpf.value,
    mix: fetMix.value,
    autoMakeup: fetAutoMakeup.value,
  }),
  write: (p) => {
    syncInput(p.inputDrive)
    syncAttack(p.attack)
    syncRelease(p.release)
    syncRatio(p.ratio)
    syncDrive(p.fetDrive)
    syncScHpf(p.scHpf)
    syncMix(p.mix)
    if (p.autoMakeup) {
      if (!fetAutoMakeup.value) toggleAutoMakeup()
    } else {
      if (fetAutoMakeup.value) toggleAutoMakeup()
      syncOutput(p.output)
    }
  },
})

onMounted(() => {
  if (!fetPreview.value) togglePreview()
})

watch(() => state.selection, () => { resetLiveMakeup(); refreshAutoMakeup() }, { deep: true })

const ACCENT = MODULA_ACCENT
const SECOND = MODULA_SECOND

// ── Ratio ────────────────────────────────────────────────────────────────────
const RATIO_OPTIONS = [
  { value: '4', label: '4', title: 'Gentle enough to leave on a whole take' },
  { value: '8', label: '8', title: 'Firm control' },
  { value: '12', label: '12', title: 'Peak taming' },
  { value: '20', label: '20', title: 'Effectively limiting' },
  { value: 'all', label: 'ALL', title: 'All buttons in — the "British mode" trick' },
]
const RATIO_CAPTIONS = {
  4: 'gentle — safe on a whole take',
  8: 'firm control',
  12: 'peak taming',
  20: 'effectively limiting',
  all: 'all buttons in — crushed, lagging, loud',
}
const ratioCaption = computed(() => RATIO_CAPTIONS[fetRatio.value] ?? '')

// ── Ballistics ───────────────────────────────────────────────────────────────
function formatMs(seconds) {
  const ms = seconds * 1000
  if (ms < 1) return `${Math.round(ms * 1000)} µs`
  if (ms < 100) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
// Dial numbering follows the hardware panel: 7 is the FASTEST position. The
// dials are detented knobs — seven positions, so seven options — and the
// readout prints the position with the time it actually sets.
const DIALS = [1, 2, 3, 4, 5, 6, 7]
const ATTACK_OPTIONS = DIALS.map(d => ({ value: d, label: String(d), title: `Attack ${d} — ${formatMs(attackSecondsForDial(d))}` }))
const RELEASE_OPTIONS = DIALS.map(d => ({ value: d, label: String(d), title: `Release ${d} — ${formatMs(releaseSecondsForDial(d))}` }))
const attackText = (d) => `${d} · ${formatMs(attackSecondsForDial(d))}`
const releaseText = (d) => `${d} · ${formatMs(releaseSecondsForDial(d))}`
const percent = (v) => `${Math.round(v * 100)} %`
const gainDb = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`

// ── Sidechain HPF: three named stops, one segment ─────────────────────────
const SC_OPTIONS = [
  { value: 0, label: 'OFF', title: 'Stock broadband detector' },
  { value: 90, label: '90', title: 'Stops plosives and rumble from ducking the take' },
  { value: 150, label: '150', title: 'Keeps chest weight out of the detector entirely' },
]

// What the fader's tag says: nothing when the user owns the knob, AUTO while
// the plugin does, and the measurement in progress when it is re-solving.
const outputTag = computed(() => !fetAutoMakeup.value ? '' : fetAutoMakeupBusy.value ? 'MEASURING' : 'AUTO')

// ── Header ───────────────────────────────────────────────────────────────────
const presetName = computed(() => {
  const active = presets.activePreset.value
  if (!active) return 'PRESETS'
  return (presets.dirty.value ? `${active.name} *` : active.name).toUpperCase()
})
function stepPreset(dir) {
  const list = presets.presets.value ?? []
  if (!list.length) return
  const current = list.findIndex(p => p.id === presets.activePreset.value?.id)
  const next = current < 0
    ? (dir > 0 ? 0 : list.length - 1)
    : (current + dir + list.length) % list.length
  presets.select(list[next].id)
}

// ── Harness ──────────────────────────────────────────────────────────────────
function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

function close() {
  teardown()
}

async function applyAndClose() {
  await apply()
  teardown()
  closeWindow(WINDOW_ID)
}
</script>

<template>
  <FloatingWindow
    window-id="fet-punch-modula"
    :z="z"
    :width="760"
    :top="90"
    :accent="ACCENT"
    background="#1a1c20"
    brand-lead="FET"
    brand-tail="PUNCH · MODULA"
    :show-engage="false"
    :engaged="fetPreview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!fetPreview"
    apply-disabled-hint="Turn FET Punch on to apply it"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <template #header-center>
      <PresetMenu
        :presets="presets"
        :accent="ACCENT"
        :disabled="!fetPreview"
        disabled-hint="Turn FET Punch on to use presets"
      />
    </template>

    <ModulaChassis
      compact
      brand="FET PUNCH"
      sub="1176"
      :engaged="fetPreview"
      :accent="ACCENT"
      @toggle-power="togglePreview"
    >
      <template #center>
        <ModulaStepper
          :text="presetName"
          prev-title="Previous preset"
          next-title="Next preset"
          @prev="stepPreset(-1)"
          @next="stepPreset(1)"
        />
      </template>

      <!-- 1. Gain reduction — the app's own instrument, see the note above. -->
      <div class="px-[4px]">
        <GainReductionBar :reduction-db="fetReduction" :accent="ACCENT" />
      </div>

      <!-- 2. Main strip. Signal order left to right. -->
      <ModulaCard compact class="mt-[14px] flex items-center gap-[14px]">
        <LevelMeter :levels="fetInputLevels" label="IN" :height="150" />

        <div class="flex-1 flex items-center justify-center gap-[22px]">
          <!-- Input is the only threshold control there is: it drives the
               audio path and the detector together, as the hardware
               attenuator does. -->
          <div class="flex flex-col items-center gap-[10px]">
            <ModulaKnob
              size="big" ring="ticks" indicator="dot" :model-value="fetInput" @update:model-value="syncInput"
              :min="0" :max="100" :step="1" :color="ACCENT"
              label="INPUT" :format-value="v => String(Math.round(v))"
              title="Input — drives the threshold and the audio path together"
            />
            <!-- Same height as OUTPUT's switch row, so the two knobs sit level. -->
            <div class="h-[22px]"></div>
          </div>

          <div class="flex flex-col items-center gap-[10px]">
            <!-- Touch-to-take-over lives in `syncOutput`: a drag while AUTO
                 is lit drops AUTO and accepts the value. -->
            <ModulaKnob
              size="big" ring="ticks" indicator="dot" :model-value="fetOutput" @update:model-value="syncOutput"
              :min="-36" :max="24" :step="0.1" :color="ACCENT"
              label="OUTPUT" :format-value="gainDb"
              title="Output — drag to take manual control"
            />
            <!-- Auto makeup matters more here than on the OptoSmooth: Input
                 feeds the audio path too, so driving harder swings the output
                 by tens of dB. AUTO restores the input's peak level. Under
                 the knob it governs, sized to it. -->
            <ModulaSwitch
              size="small"
              :model-value="fetAutoMakeup" @update:model-value="toggleAutoMakeup"
              :color="ACCENT" :label="outputTag || 'MANUAL'"
              :title="fetAutoMakeup
                ? 'Auto makeup on. Click to take manual control of Output.'
                : 'Auto makeup off. Click to let the plugin match Output to the input level.'"
            />
          </div>
        </div>

        <LevelMeter :levels="fetOutputLevels" label="OUT" :height="150" />
      </ModulaCard>

      <!-- 3. Control strip. -->
      <ModulaCard compact class="mt-[14px] flex flex-wrap items-start justify-between gap-[16px]">
        <div class="flex items-start gap-[14px]">
          <!-- Dial numbering follows the panel: 7 is the FASTEST position. -->
          <ModulaKnob
            ring="leds" indicator="bar" :model-value="fetAttack" @update:model-value="syncAttack"
            :options="ATTACK_OPTIONS" :color="ACCENT" label="ATTACK" :format-value="attackText"
          />
          <ModulaKnob
            ring="leds" indicator="bar" :model-value="fetRelease" @update:model-value="syncRelease"
            :options="RELEASE_OPTIONS" :color="ACCENT" label="RELEASE" :format-value="releaseText"
          />
          <div class="pt-[15px] flex items-start gap-[14px]">
            <ModulaKnob
              :model-value="fetDrive" @update:model-value="syncDrive"
              :min="0" :max="1" :step="0.01" :color="SECOND" label="FET DRIVE" :format-value="percent"
            />
            <!-- Blends the untouched input back in — parallel compression
                 without a second track. -->
            <ModulaKnob
              :model-value="fetMix" @update:model-value="syncMix"
              :min="0" :max="1" :step="0.01" :color="SECOND" label="MIX" :format-value="percent"
            />
          </div>
        </div>

        <div class="flex flex-col items-end gap-[12px]">
          <!-- Push-buttons on the hardware, so a segment here. -->
          <div class="flex flex-col items-center gap-[6px]">
            <ModulaSegment
              :model-value="fetRatio" @update:model-value="syncRatio"
              :options="RATIO_OPTIONS" :color="SECOND" label="RATIO"
            />
            <div class="ratio-note">{{ ratioCaption }}</div>
          </div>
          <!-- Not on the original: the 1176's detector is broadband, which
               lets plosives duck a whole phrase. OFF is the stock path. -->
          <ModulaSegment
            :model-value="fetScHpf" @update:model-value="syncScHpf"
            :options="SC_OPTIONS" :color="SECOND" label="SC HPF · Hz"
          />
        </div>
      </ModulaCard>
    </ModulaChassis>
  </FloatingWindow>
</template>

<style scoped>
/* The lit ratio's one-line character note, under its segment. */
.ratio-note {
  max-width: 230px; text-align: center;
  font-family: 'JetBrains Mono', monospace; font-size: 9px; line-height: 1.4; color: #565d66;
}
</style>
