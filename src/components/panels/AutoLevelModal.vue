<script setup>
/**
 * Auto Leveler.
 *
 * Three-speed, and the panel says so: Analyse runs voice-activity detection on
 * the server once, the clip analysis that follows is local, and every control
 * below re-solves from it in milliseconds. Nothing here can trigger a round
 * trip except the Analyse button.
 *
 * The controls are deliberately the preset's own parameter names rather than a
 * simplified "amount" knob. This plugin exists for the user who is going to
 * check the result against ACX, and a leveler whose caps and deadband are
 * hidden cannot be reasoned about against a compliance report.
 */
import { computed, onMounted } from 'vue'
import { useAutoLevel } from '../../composables/useAutoLevel.js'
import { useEditorState } from '../../composables/useEditorState.js'
import Knob from '../knobs/Knob.vue'
import LevelMeter from '../meters/LevelMeter.vue'
import GainRideBar from '../meters/GainRideBar.vue'
import FloatingWindow from './FloatingWindow.vue'

defineProps({ z: { type: Number, default: 500 } })

const {
  params, preview, analyzing, prepared, solved,
  gainDb, inputLevels, outputLevels,
  hasAnalysis, hasSelection, isStale, curveValid, analyzedRegion, skipReason,
  togglePreview, syncParam, resetParams, analyze, apply, teardown, closeModal,
} = useAutoLevel()

const { state } = useEditorState()

onMounted(() => {
  if (!preview.value) togglePreview()
})

const ACCENT = '#9ee6a8'

const oneDp = v => v.toFixed(1)
const twoDp = v => v.toFixed(2)
const secs = v => `${Math.round(v)}`

function fmtTime(sec) {
  const m = Math.floor(sec / 60)
  const s = (sec - m * 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}

const measurements = computed(() => solved.value?.measurements ?? null)

const statusLine = computed(() => {
  if (analyzing.value) return 'Detecting speech…'
  if (!prepared.value) return 'Analyse the selection to find its phrases.'
  if (isStale.value) {
    const r = analyzedRegion.value
    return r
      ? `Selection is outside the analysed ${fmtTime(r.start)}–${fmtTime(r.end)} — analyse again.`
      : 'Audio changed since analysis — analyse again.'
  }
  if (skipReason.value) return skipReason.value

  const m = measurements.value
  if (!m) return 'Analysed.'
  return `${m.clip_count_after_merge} phrases levelled — ` +
    `spread ${m.input_clip_lufs_std_db.toFixed(1)} → ` +
    `${m.output_clip_lufs_std_db.toFixed(1)} dB, ` +
    `${m.gain_max_down_db.toFixed(1)} to +${m.gain_max_up_db.toFixed(1)} dB applied.`
})

/**
 * The headroom cap is the one thing that silently changes what the controls
 * can do, so it says so rather than leaving Max Boost looking broken.
 */
const capNote = computed(() => {
  const m = measurements.value
  if (!m?.noise_floor_cap_active) return null
  return m.max_up_effective_db <= 0.01
    ? `Room tone is too close to the ${params.value.noise_floor_target_dbfs} dBFS ` +
      `target to lift anything — cuts only.`
    : `Boost capped at ${m.max_up_effective_db.toFixed(1)} dB to keep room tone ` +
      `under ${params.value.noise_floor_target_dbfs} dBFS.`
})

const applyHint = computed(() => {
  if (!preview.value) return 'Turn the leveler on to apply it'
  if (!hasAnalysis.value) return 'Analyse the selection first'
  if (isStale.value) return 'Selection moved outside the analysed region — analyse again'
  return skipReason.value ?? 'Nothing to level'
})

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
    window-id="auto-leveler"
    :z="z"
    :width="640"
    :accent="ACCENT"
    brand-lead="AUTO"
    brand-tail="LEVEL"
    :engaged="preview"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    :apply-disabled="!preview || !curveValid"
    :apply-disabled-hint="applyHint"
    @toggle-engaged="togglePreview"
    @toggle-preview="togglePlayback"
    @apply="applyAndClose"
    @close="close"
  >
    <div class="px-[26px] pt-[22px] pb-[24px]">
      <!-- Signed, because the boosts are the point. 12 dB half-scale matches
           the default caps: a bar whose ends are unreachable wastes its width. -->
      <GainRideBar :gain-db="gainDb" :accent="ACCENT" :full-scale-db="12" />

      <div class="flex items-start justify-between gap-[20px] mt-[20px]">
        <LevelMeter :levels="inputLevels" label="IN" :height="176" />

        <div class="flex-1">
          <!-- Analyse: the frozen half -->
          <div class="flex items-center justify-between gap-[16px]">
            <div>
              <div
                style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.14em;
                       color:rgba(255,255,255,.42)"
              >SPEECH DETECTION</div>
              <div
                class="mt-[2px]"
                style="font:500 9.5px/1.4 'Inter';color:rgba(255,255,255,.3);max-width:290px"
              >Runs once on the server. Phrase segmentation and every control
                below are computed here from the result.</div>
            </div>
            <button
              class="px-[18px] py-[9px] rounded-lg cursor-pointer transition-all disabled:cursor-default"
              :style="{
                background: analyzing ? 'rgba(255,255,255,.05)' : 'rgba(158,230,168,.16)',
                border: `1px solid ${analyzing ? 'rgba(255,255,255,.09)' : 'rgba(158,230,168,.42)'}`,
                color: analyzing ? 'rgba(255,255,255,.4)' : '#cdf3d4',
                font: `700 10px 'JetBrains Mono',monospace`,
                letterSpacing: '.1em',
                opacity: hasSelection ? 1 : 0.4,
              }"
              :disabled="analyzing || !hasSelection"
              @click="analyze"
            >{{ analyzing ? 'ANALYSING…' : 'ANALYSE' }}</button>
          </div>

          <!-- Targeting: the live half -->
          <div
            class="mt-[16px] pt-[14px] grid grid-cols-2 gap-x-[26px] gap-y-[14px]"
            style="border-top:1px solid rgba(255,255,255,.06)"
          >
            <div class="w-[104px]">
              <Knob
                :model-value="params.deadband_db"
                @update:model-value="v => syncParam('deadband_db', v)"
                :min="0" :max="6" :step="0.05" :value-font-px="12"
                label="Deadband dB" :accent="ACCENT" :format-value="twoDp"
                :disabled="!preview || !hasAnalysis"
              />
            </div>
            <div class="w-[104px]">
              <Knob
                :model-value="params.knee_db"
                @update:model-value="v => syncParam('knee_db', v)"
                :min="0.1" :max="6" :step="0.1" :value-font-px="12"
                label="Knee dB" :accent="ACCENT" :format-value="oneDp"
                :disabled="!preview || !hasAnalysis"
              />
            </div>
            <div class="w-[104px]">
              <Knob
                :model-value="params.max_up_db"
                @update:model-value="v => syncParam('max_up_db', v)"
                :min="0" :max="18" :step="0.5" :value-font-px="12"
                label="Max Boost dB" :accent="ACCENT" :format-value="oneDp"
                :disabled="!preview || !hasAnalysis"
              />
            </div>
            <div class="w-[104px]">
              <Knob
                :model-value="params.max_down_db"
                @update:model-value="v => syncParam('max_down_db', v)"
                :min="0" :max="18" :step="0.5" :value-font-px="12"
                label="Max Cut dB" :accent="ACCENT" :format-value="oneDp"
                :disabled="!preview || !hasAnalysis"
              />
            </div>
          </div>

          <p
            class="mt-[12px]"
            :style="{
              font: `500 10px/1.5 'Inter'`,
              color: isStale || skipReason ? '#ffb27a' : 'rgba(255,255,255,.35)',
            }"
          >{{ statusLine }}</p>

          <p
            v-if="capNote"
            class="mt-[6px]"
            style="font:500 10px/1.5 'Inter';color:#ffb27a"
          >{{ capNote }}</p>
        </div>

        <LevelMeter :levels="outputLevels" label="OUT" :height="176" />
      </div>

      <!-- Target: what each phrase is levelled towards -->
      <div
        class="flex items-center justify-between mt-[16px] pt-[14px]"
        style="border-top:1px solid rgba(255,255,255,.06)"
      >
        <div style="max-width:250px">
          <p style="font:500 10px/1.5 'Inter';color:rgba(255,255,255,.3)">
            What each phrase is levelled towards. <b>Whole selection</b> holds one
            level throughout; <b>rolling</b> follows a moving median, so a
            deliberate change in delivery survives.
          </p>
          <button
            class="mt-[8px] px-[10px] py-[4px] rounded cursor-pointer"
            style="font:700 8.5px 'JetBrains Mono',monospace;letter-spacing:.1em;
                   background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);
                   color:rgba(255,255,255,.45)"
            @click="resetParams"
          >RESET</button>
        </div>

        <div class="flex items-center gap-[18px]">
          <div class="flex rounded-lg overflow-hidden" style="border:1px solid rgba(255,255,255,.09)">
            <button
              v-for="mode in [
                { id: 'global', label: 'WHOLE SELECTION' },
                { id: 'running_median', label: 'ROLLING' },
              ]"
              :key="mode.id"
              class="px-[12px] py-[7px] cursor-pointer transition-all"
              :style="{
                background: params.target_mode === mode.id
                  ? 'rgba(158,230,168,.16)' : 'transparent',
                color: params.target_mode === mode.id
                  ? '#cdf3d4' : 'rgba(255,255,255,.38)',
                font: `700 8.5px 'JetBrains Mono',monospace`,
                letterSpacing: '.1em',
                opacity: (!preview || !hasAnalysis) ? 0.4 : 1,
              }"
              :disabled="!preview || !hasAnalysis"
              @click="syncParam('target_mode', mode.id)"
            >{{ mode.label }}</button>
          </div>

          <div class="w-[86px]">
            <Knob
              :model-value="params.target_window_s"
              @update:model-value="v => syncParam('target_window_s', v)"
              :min="10" :max="120" :step="5" :value-font-px="11"
              label="Window s" :accent="ACCENT" :format-value="secs"
              :disabled="!preview || !hasAnalysis || params.target_mode !== 'running_median'"
            />
          </div>

          <div class="w-[86px]">
            <Knob
              :model-value="params.noise_floor_target_dbfs"
              @update:model-value="v => syncParam('noise_floor_target_dbfs', v)"
              :min="-80" :max="-40" :step="1" :value-font-px="11"
              label="Floor dBFS" :accent="ACCENT" :format-value="v => v.toFixed(0)"
              :disabled="!preview || !hasAnalysis"
            />
          </div>
        </div>
      </div>
    </div>
  </FloatingWindow>
</template>
