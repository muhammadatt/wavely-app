<script setup>
import { computed } from 'vue'
import { COMPLIANCE_TARGETS } from '../../audio/presets.js'

const props = defineProps({
  report: { type: Object, required: true },
})

// Support both old field names (rms, peak) and server field names (rms_dbfs, true_peak_dbfs)
const before = computed(() => {
  const b = props.report.before
  if (!b) return null
  return {
    rms: b.rms ?? b.rms_dbfs ?? null,
    peak: b.peak ?? b.true_peak_dbfs ?? null,
    noiseFloor: b.noiseFloor ?? b.noise_floor_dbfs ?? null,
  }
})

const after = computed(() => {
  const a = props.report.after
  if (!a) return null
  return {
    rms: a.rms ?? a.rms_dbfs ?? null,
    peak: a.peak ?? a.true_peak_dbfs ?? null,
    noiseFloor: a.noiseFloor ?? a.noise_floor_dbfs ?? null,
  }
})

// Support both compliance shapes
const complianceResult = computed(() => {
  const c = props.report.compliance || props.report.compliance_results
  if (!c) return null
  return {
    target: c.target,
    passed: c.passed ?? c.overall_pass ?? false,
  }
})

const compliance = computed(() => COMPLIANCE_TARGETS[complianceResult.value?.target])
const showNoiseFloor = computed(() => compliance.value?.noiseFloorCeiling !== null)

// Build human-readable processing chain from processing_applied
const processingChain = computed(() => {
  const chain = props.report.chain
  if (chain?.length) return chain

  const applied = props.report.processing_applied
  if (!applied) return []

  const steps = []
  if (applied.resampled_from) steps.push(`Resampled from ${applied.resampled_from} Hz to 44100 Hz`)
  if (applied.stereo_to_mono) steps.push('Converted stereo to mono')
  steps.push('High-pass filter at 80 Hz (4th order Butterworth)')
  if (applied.hpf_60hz_notch) steps.push('60 Hz notch filter applied')
  if (applied.noise_reduction?.applied) {
    steps.push(`Noise reduction: ${applied.noise_reduction.model} (Tier ${applied.noise_reduction.tier})`)
  }
  if (applied.enhancement_eq) steps.push('Enhancement EQ')
  if (applied.de_esser?.applied) steps.push(`De-esser (${applied.de_esser.max_reduction_db} dB max)`)
  if (applied.compression?.applied) steps.push('Compression')
  if (applied.normalization_gain_db != null) {
    const sign = applied.normalization_gain_db >= 0 ? '+' : ''
    steps.push(`Normalization: ${sign}${applied.normalization_gain_db.toFixed(1)} dB`)
  }
  steps.push('True peak limiting')
  return steps
})

const humanReviewRisk = computed(() =>
  props.report.humanReviewRisk ?? props.report.human_review_risk?.level ?? null
)

const riskColors = {
  low: 'bg-mint-lt text-mint',
  medium: 'bg-yellow-lt text-yellow',
  high: 'bg-accent-lt text-accent',
}

function loudnessPass(value) {
  if (!compliance.value) return true
  const [min, max] = compliance.value.loudnessRange
  return value >= min && value <= max
}

function peakPass(value) {
  if (!compliance.value) return true
  return value <= compliance.value.truePeakCeiling
}

function noisePass(value) {
  if (!compliance.value || compliance.value.noiseFloorCeiling === null) return true
  return value <= compliance.value.noiseFloorCeiling
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- Before / After -->
    <div class="text-[11px] font-bold text-ink-mid uppercase tracking-wider mb-0.5">Measurements</div>
    <div class="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1.5 text-[11px]">
      <div class="font-bold text-ink-mid"></div>
      <div class="font-bold text-ink-mid text-center">Before</div>
      <div class="font-bold text-ink-mid text-center">After</div>

      <!-- Loudness -->
      <div class="font-bold text-ink-mid">
        {{ compliance?.measurementMethod === 'LUFS' ? 'LUFS' : 'RMS' }}
      </div>
      <div class="text-ink-lt tabular-nums text-center">
        {{ before?.rms != null ? `${before.rms.toFixed(1)} dB` : '--' }}
      </div>
      <div class="text-center flex items-center justify-center gap-1">
        <span class="tabular-nums">{{ after?.rms != null ? `${after.rms.toFixed(1)} dB` : '--' }}</span>
        <span v-if="after?.rms != null"
              class="inline-block px-1.5 py-0.5 rounded-[var(--radius-pill)] text-[9px] font-extrabold"
              :class="loudnessPass(after.rms) ? 'bg-mint-lt text-mint' : 'bg-accent-lt text-accent'">
          {{ loudnessPass(after.rms) ? 'PASS' : 'FAIL' }}
        </span>
      </div>

      <!-- True Peak -->
      <div class="font-bold text-ink-mid">True Peak</div>
      <div class="text-ink-lt tabular-nums text-center">
        {{ before?.peak != null ? `${before.peak.toFixed(1)} dBFS` : '--' }}
      </div>
      <div class="text-center flex items-center justify-center gap-1">
        <span class="tabular-nums">{{ after?.peak != null ? `${after.peak.toFixed(1)} dBFS` : '--' }}</span>
        <span v-if="after?.peak != null"
              class="inline-block px-1.5 py-0.5 rounded-[var(--radius-pill)] text-[9px] font-extrabold"
              :class="peakPass(after.peak) ? 'bg-mint-lt text-mint' : 'bg-accent-lt text-accent'">
          {{ peakPass(after.peak) ? 'PASS' : 'FAIL' }}
        </span>
      </div>

      <!-- Noise Floor (ACX only) -->
      <template v-if="showNoiseFloor">
        <div class="font-bold text-ink-mid">Noise Floor</div>
        <div class="text-ink-lt tabular-nums text-center">
          {{ before?.noiseFloor != null ? `${before.noiseFloor.toFixed(1)} dBFS` : '--' }}
        </div>
        <div class="text-center flex items-center justify-center gap-1">
          <span class="tabular-nums">{{ after?.noiseFloor != null ? `${after.noiseFloor.toFixed(1)} dBFS` : '--' }}</span>
          <span v-if="after?.noiseFloor != null"
                class="inline-block px-1.5 py-0.5 rounded-[var(--radius-pill)] text-[9px] font-extrabold"
                :class="noisePass(after.noiseFloor) ? 'bg-mint-lt text-mint' : 'bg-accent-lt text-accent'">
            {{ noisePass(after.noiseFloor) ? 'PASS' : 'FAIL' }}
          </span>
        </div>
      </template>
    </div>

    <!-- Overall compliance -->
    <div v-if="complianceResult" class="flex items-center gap-2">
      <span class="text-[11px] font-bold text-ink-mid">Compliance:</span>
      <span class="inline-block px-2 py-0.5 rounded-[var(--radius-pill)] text-[10px] font-extrabold"
            :class="complianceResult.passed ? 'bg-mint-lt text-mint' : 'bg-accent-lt text-accent'">
        {{ complianceResult.passed ? 'PASSED' : 'FAILED' }}
      </span>
    </div>

    <!-- Processing chain -->
    <div v-if="processingChain.length">
      <div class="text-[11px] font-bold text-ink-mid uppercase tracking-wider mb-1.5">Processing Applied</div>
      <ol class="list-decimal list-inside text-[11px] text-ink-lt font-semibold flex flex-col gap-0.5">
        <li v-for="(step, i) in processingChain" :key="i">{{ step }}</li>
      </ol>
    </div>

    <!-- Warnings -->
    <div v-if="report.warnings?.length"
         class="bg-yellow-lt border-2 border-yellow rounded-[var(--radius-md)] px-3 py-2.5 text-[11px] font-bold text-ink-mid leading-relaxed">
      <div v-for="(warning, i) in report.warnings" :key="i" class="flex items-start gap-1.5">
        <span class="shrink-0 mt-[1px]">&#9888;</span>
        <span>{{ warning }}</span>
      </div>
    </div>

    <!-- Human review risk (ACX only) -->
    <div v-if="humanReviewRisk" class="flex items-center gap-2">
      <span class="text-[11px] font-bold text-ink-mid">Human Review Risk:</span>
      <span class="inline-block px-2 py-0.5 rounded-[var(--radius-pill)] text-[10px] font-extrabold capitalize"
            :class="riskColors[humanReviewRisk] || 'bg-bg text-ink-mid'">
        {{ humanReviewRisk }}
      </span>
    </div>
  </div>
</template>
