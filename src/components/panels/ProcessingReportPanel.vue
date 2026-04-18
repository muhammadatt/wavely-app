<script setup>
import { computed, reactive } from 'vue'
import { OUTPUT_PROFILES, resolveOutputProfileId } from '../../audio/presets.js'

const props = defineProps({
  report: { type: Object, required: true },
})

// --- Section 1: Output Measurements ---

const before = computed(() => {
  // Support both v2 nested measurements and legacy flat structure
  const m = props.report.measurements?.before || props.report.before
  if (!m) return null
  return {
    rms: m.rms_dbfs ?? m.rms ?? null,
    lufs: m.lufs_integrated ?? null,
    peak: m.true_peak_dbfs ?? m.peak ?? null,
    noiseFloor: m.noise_floor_dbfs ?? m.noiseFloor ?? null,
  }
})

const after = computed(() => {
  const m = props.report.measurements?.after || props.report.after
  if (!m) return null
  return {
    rms: m.rms_dbfs ?? m.rms ?? null,
    lufs: m.lufs_integrated ?? null,
    peak: m.true_peak_dbfs ?? m.peak ?? null,
    noiseFloor: m.noise_floor_dbfs ?? m.noiseFloor ?? null,
  }
})

const outputProfileId = computed(() => {
  // v2 report shape: output_profile is a plain string ID
  if (props.report.output_profile) return resolveOutputProfileId(props.report.output_profile)
  // legacy: compliance was sometimes a plain string ID
  if (typeof props.report.compliance === 'string') return resolveOutputProfileId(props.report.compliance)
  // legacy: compliance was an object with a target field
  const target = props.report.compliance_results?.target ?? props.report.compliance?.target ?? null
  return target ? resolveOutputProfileId(target) : null
})
const outputProfile = computed(() => OUTPUT_PROFILES[outputProfileId.value])
const isAcx = computed(() => outputProfileId.value === 'acx')

// --- Section 2: ACX Certification ---

const acxCert = computed(() => props.report.acx_certification || null)

const certCheckOrder = ['rms', 'true_peak', 'noise_floor', 'sample_rate', 'bit_depth', 'channel']
const certCheckLabels = {
  rms: 'RMS (average loudness)',
  true_peak: 'True Peak',
  noise_floor: 'Noise Floor',
  sample_rate: 'Sample Rate',
  bit_depth: 'Bit Depth',
  channel: 'Channel Format',
}

function formatCheckValue(checkId, check) {
  if (!check) return '--'
  switch (checkId) {
    case 'rms': return `${check.value_dbfs} dBFS (target: ${check.min} to ${check.max})`
    case 'true_peak': return `${check.value_dbfs} dBFS (target: <= ${check.ceiling})`
    case 'noise_floor': return `${check.value_dbfs} dBFS (target: <= ${check.ceiling})`
    case 'sample_rate': return `${check.value_hz} Hz`
    case 'bit_depth': return check.value
    case 'channel': return check.value
    default: return '--'
  }
}

// --- Section 3: Quality Advisory ---

const advisory = computed(() => props.report.quality_advisory || null)
const advisoryFlags = computed(() => advisory.value?.flags || [])
const hasAdvisoryFlags = computed(() => advisoryFlags.value.length > 0)

// Track which flags the user has marked as reviewed (local UI state only)
const reviewedFlags = reactive({})

function toggleReviewed(flagId) {
  reviewedFlags[flagId] = !reviewedFlags[flagId]
}

// --- Compression detail ---

const compressionDetail = computed(() => props.report.processing_applied?.compression ?? null)

// --- Processing chain (kept from v1) ---

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
</script>

<template>
  <div class="flex flex-col gap-3">

    <!-- ===== Section 1: Output Measurements (always shown) ===== -->
    <div>
      <div class="text-[11px] font-bold text-ink-mid uppercase tracking-wider mb-1.5">Output Measurements</div>
      <div class="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1.5 text-[11px]">
        <div class="font-bold text-ink-mid"></div>
        <div class="font-bold text-ink-mid text-center">Before</div>
        <div class="font-bold text-ink-mid text-center">After</div>

        <!-- RMS -->
        <div class="font-bold text-ink-mid">RMS</div>
        <div class="text-ink-lt tabular-nums text-center">
          {{ before?.rms != null ? `${before.rms.toFixed(1)} dBFS` : '--' }}
        </div>
        <div class="text-ink-lt tabular-nums text-center">
          {{ after?.rms != null ? `${after.rms.toFixed(1)} dBFS` : '--' }}
        </div>

        <!-- LUFS -->
        <div class="font-bold text-ink-mid">LUFS</div>
        <div class="text-ink-lt tabular-nums text-center">
          {{ before?.lufs != null ? `${before.lufs.toFixed(1)} LUFS` : '--' }}
        </div>
        <div class="text-ink-lt tabular-nums text-center">
          {{ after?.lufs != null ? `${after.lufs.toFixed(1)} LUFS` : '--' }}
        </div>

        <!-- True Peak -->
        <div class="font-bold text-ink-mid">True Peak</div>
        <div class="text-ink-lt tabular-nums text-center">
          {{ before?.peak != null ? `${before.peak.toFixed(1)} dBFS` : '--' }}
        </div>
        <div class="text-ink-lt tabular-nums text-center">
          {{ after?.peak != null ? `${after.peak.toFixed(1)} dBFS` : '--' }}
        </div>

        <!-- Noise Floor -->
        <div class="font-bold text-ink-mid">Noise Floor</div>
        <div class="text-ink-lt tabular-nums text-center">
          {{ before?.noiseFloor != null ? `${before.noiseFloor.toFixed(1)} dBFS` : '--' }}
        </div>
        <div class="text-ink-lt tabular-nums text-center">
          {{ after?.noiseFloor != null ? `${after.noiseFloor.toFixed(1)} dBFS` : '--' }}
        </div>
      </div>
    </div>

    <!-- ===== Section 2: ACX Technical Certification (acx output profile only) ===== -->
    <div v-if="acxCert">
      <div class="text-[11px] font-bold text-ink-mid uppercase tracking-wider mb-1.5">ACX Technical Certification</div>

      <!-- Overall certificate badge -->
      <div class="flex items-center gap-2 mb-2">
        <span class="inline-block px-2.5 py-1 rounded-[var(--radius-pill)] text-[11px] font-extrabold"
              :class="acxCert.certificate === 'pass'
                ? 'bg-mint-lt text-mint'
                : 'bg-accent-lt text-accent'">
          {{ acxCert.certificate === 'pass' ? 'PASS' : 'FAIL' }}
        </span>
      </div>

      <!-- Per-check results -->
      <div class="flex flex-col gap-1 text-[11px]">
        <div v-for="checkId in certCheckOrder" :key="checkId"
             class="flex items-start gap-1.5">
          <span class="shrink-0 mt-[1px] font-bold"
                :class="acxCert.checks[checkId]?.pass ? 'text-mint' : 'text-accent'">
            {{ acxCert.checks[checkId]?.pass ? '\u2713' : '\u2717' }}
          </span>
          <span class="font-bold text-ink-mid w-[120px] shrink-0">{{ certCheckLabels[checkId] }}</span>
          <span class="text-ink-lt tabular-nums">{{ formatCheckValue(checkId, acxCert.checks[checkId]) }}</span>
        </div>
      </div>

      <!-- Export certificate stub -->
      <button v-if="acxCert.certificate === 'pass'"
              class="mt-2 text-[10px] font-bold text-accent hover:underline cursor-pointer bg-transparent border-none p-0"
              @click="">
        Export Certificate
      </button>
    </div>

    <!-- ===== Section 3: Compression Detail ===== -->
    <div v-if="compressionDetail">
      <div class="text-[11px] font-bold text-ink-mid uppercase tracking-wider mb-1.5">Compression</div>
      <div v-if="compressionDetail.applied" class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[11px]">
        <div class="font-bold text-ink-mid">Threshold</div>
        <div class="text-ink-lt tabular-nums text-right">{{ compressionDetail.threshold_dbfs != null ? `${compressionDetail.threshold_dbfs} dBFS` : '--' }}</div>
        <div class="font-bold text-ink-mid">Derived ratio</div>
        <div class="text-ink-lt tabular-nums text-right">{{ compressionDetail.derived_ratio != null ? `${compressionDetail.derived_ratio}:1` : '--' }}</div>
        <div class="font-bold text-ink-mid">Gain reduction</div>
        <div class="text-ink-lt tabular-nums text-right">{{ compressionDetail.derived_gain_reduction_db != null ? `${compressionDetail.derived_gain_reduction_db} dB` : '--' }}</div>
      </div>
      <div v-else class="text-[11px] text-ink-lt font-semibold">
        {{ compressionDetail.skip_reason || 'Compression not needed — dynamics already within target.' }}
      </div>
    </div>

    <!-- ===== Section 5: Before You Submit (advisory flags) ===== -->
    <div>
      <div class="text-[11px] font-bold text-ink-mid uppercase tracking-wider mb-1.5">
        {{ hasAdvisoryFlags ? 'Before you submit \u2014 things to listen for' : 'Quality Check' }}
      </div>

      <div v-if="hasAdvisoryFlags" class="flex flex-col gap-2">
        <div v-for="flag in advisoryFlags" :key="flag.id"
             class="flex items-start gap-2 rounded-[var(--radius-md)] px-3 py-2"
             :class="flag.severity === 'review' ? 'bg-yellow-lt' : 'bg-bg'">
          <!-- Checkbox: Mark as reviewed -->
          <label class="flex items-start gap-2 cursor-pointer flex-1 min-w-0">
            <input type="checkbox"
                   :checked="reviewedFlags[flag.id]"
                   @change="toggleReviewed(flag.id)"
                   class="mt-0.5 shrink-0 accent-accent" />
            <div>
              <div class="text-[11px] font-bold leading-snug"
                   :class="flag.severity === 'review' ? 'text-ink' : 'text-ink-mid'">
                {{ flag.message }}
              </div>
              <span class="inline-block text-[9px] font-extrabold uppercase mt-0.5 px-1.5 py-0.5 rounded-[var(--radius-pill)]"
                    :class="flag.severity === 'review'
                      ? 'bg-yellow text-white'
                      : 'bg-ink-lt text-white'">
                {{ flag.severity }}
              </span>
            </div>
          </label>
        </div>
      </div>

      <div v-else class="text-[11px] text-ink-lt font-semibold">
        No quality concerns detected.
      </div>
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
  </div>
</template>
