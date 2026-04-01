<script setup>
import { computed } from 'vue'
import { COMPLIANCE_TARGETS } from '../../audio/presets.js'

const props = defineProps({
  report: { type: Object, required: true },
})

const compliance = computed(() => COMPLIANCE_TARGETS[props.report.compliance?.target])
const showNoiseFloor = computed(() => compliance.value?.noiseFloorCeiling !== null)

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
        {{ report.before?.rms != null ? `${report.before.rms.toFixed(1)} dB` : '--' }}
      </div>
      <div class="text-center flex items-center justify-center gap-1">
        <span class="tabular-nums">{{ report.after?.rms != null ? `${report.after.rms.toFixed(1)} dB` : '--' }}</span>
        <span v-if="report.after?.rms != null"
              class="inline-block px-1.5 py-0.5 rounded-[var(--radius-pill)] text-[9px] font-extrabold"
              :class="loudnessPass(report.after.rms) ? 'bg-mint-lt text-mint' : 'bg-accent-lt text-accent'">
          {{ loudnessPass(report.after.rms) ? 'PASS' : 'FAIL' }}
        </span>
      </div>

      <!-- True Peak -->
      <div class="font-bold text-ink-mid">True Peak</div>
      <div class="text-ink-lt tabular-nums text-center">
        {{ report.before?.peak != null ? `${report.before.peak.toFixed(1)} dBFS` : '--' }}
      </div>
      <div class="text-center flex items-center justify-center gap-1">
        <span class="tabular-nums">{{ report.after?.peak != null ? `${report.after.peak.toFixed(1)} dBFS` : '--' }}</span>
        <span v-if="report.after?.peak != null"
              class="inline-block px-1.5 py-0.5 rounded-[var(--radius-pill)] text-[9px] font-extrabold"
              :class="peakPass(report.after.peak) ? 'bg-mint-lt text-mint' : 'bg-accent-lt text-accent'">
          {{ peakPass(report.after.peak) ? 'PASS' : 'FAIL' }}
        </span>
      </div>

      <!-- Noise Floor (ACX only) -->
      <template v-if="showNoiseFloor">
        <div class="font-bold text-ink-mid">Noise Floor</div>
        <div class="text-ink-lt tabular-nums text-center">
          {{ report.before?.noiseFloor != null ? `${report.before.noiseFloor.toFixed(1)} dBFS` : '--' }}
        </div>
        <div class="text-center flex items-center justify-center gap-1">
          <span class="tabular-nums">{{ report.after?.noiseFloor != null ? `${report.after.noiseFloor.toFixed(1)} dBFS` : '--' }}</span>
          <span v-if="report.after?.noiseFloor != null"
                class="inline-block px-1.5 py-0.5 rounded-[var(--radius-pill)] text-[9px] font-extrabold"
                :class="noisePass(report.after.noiseFloor) ? 'bg-mint-lt text-mint' : 'bg-accent-lt text-accent'">
            {{ noisePass(report.after.noiseFloor) ? 'PASS' : 'FAIL' }}
          </span>
        </div>
      </template>
    </div>

    <!-- Overall compliance -->
    <div v-if="report.compliance" class="flex items-center gap-2">
      <span class="text-[11px] font-bold text-ink-mid">Compliance:</span>
      <span class="inline-block px-2 py-0.5 rounded-[var(--radius-pill)] text-[10px] font-extrabold"
            :class="report.compliance.passed ? 'bg-mint-lt text-mint' : 'bg-accent-lt text-accent'">
        {{ report.compliance.passed ? 'PASSED' : 'FAILED' }}
      </span>
    </div>

    <!-- Processing chain -->
    <div v-if="report.chain?.length">
      <div class="text-[11px] font-bold text-ink-mid uppercase tracking-wider mb-1.5">Processing Applied</div>
      <ol class="list-decimal list-inside text-[11px] text-ink-lt font-semibold flex flex-col gap-0.5">
        <li v-for="(step, i) in report.chain" :key="i">{{ step }}</li>
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
    <div v-if="report.humanReviewRisk" class="flex items-center gap-2">
      <span class="text-[11px] font-bold text-ink-mid">Human Review Risk:</span>
      <span class="inline-block px-2 py-0.5 rounded-[var(--radius-pill)] text-[10px] font-extrabold capitalize"
            :class="riskColors[report.humanReviewRisk] || 'bg-bg text-ink-mid'">
        {{ report.humanReviewRisk }}
      </span>
    </div>
  </div>
</template>
