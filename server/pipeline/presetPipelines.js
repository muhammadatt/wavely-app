/**
 * Preset pipeline definitions.
 *
 * Each preset owns an ordered array of stage descriptors. The runner in
 * index.js resolves each descriptor against a stage registry built from
 * stages.js and executes them sequentially.
 *
 * Descriptor formats:
 *   'stageName'                         — run the stage with ctx.preset unchanged
 *   { stage: 'stageName', ...overrides } — shallow-merge the extra properties into
 *                                          ctx.preset for that single invocation only,
 *                                          then restore the original ctx.preset after.
 *                                          Useful for running the same stage twice with
 *                                          different config (e.g. vocalExpander pre/post
 *                                          compression with different ratios).
 *
 * Adding a new preset or changing its stage sequence requires no changes to
 * the orchestrator — only to this file and stages.js (if a new stage is needed).
 */

// ── Standard presets ──────────────────────────────────────────────────────────
//
// Each standard preset gets its own independent array so stage sequences can
// diverge freely without coupling across presets.
//
// Stage order rationale:
//   autoLevel runs immediately before compress — the Auto Leveler is M Leveller-
//   style clip automation that hands the compressor a level-stable input so it
//   acts with a consistent character across the file.
//   remeasureFramesPostNr runs after each NR pass to refresh the noise floor
//   estimate used by downstream stages.

const ACX_AUDIOBOOK_PIPELINE = [
  'decode',
  'monoMixdown',
  'measureBefore',
  'peakNormalize',
  'analyzeFramesRaw',
  'clickRemove',             // Pre-HPF: Hampel + Burg AR click/lip-smack repair
  'humDetect',               // Pre-HPF: spectral hum detection + conditional notch EQ
  'hpf',                     // 80 Hz hi-pass filter
  'noiseReduce',             // Main noise reduction (DF3, RNNoise, DTLN)
  'remeasureFramesPostNr',
  'autoLevel',               // M Leveller-style per-clip gain automation (pre-compression)
  'spectralSubtraction',     // MMSE Wiener pre-pass + optional transient shaper
  'bandwidthExtension',      // HF restoration (enabled per preset.bwe; no-op when disabled)
  'vocalSaturation',
  'vadGate',                 // VAD-driven silence-floor gate (no-op when preset.vadGate.enabled is false)
  'clipGainDeEss',           // Clip-gain de-esser — per-event sibilant attenuation
  'remeasureFramesPostNr',   // Refresh before compression
  'compress',
  'remeasureFramesPostNr',   // Refresh noise floor after compression for secondary NR skip-check
  'noiseReduce',             // Conditional secondary NR pass
  'parallelCompress',
  'vocalExpander',           // Frequency-selective expander (silence-floor residual attenuator)
  'airBoost',                // Maag EQ4-style air/HF shelf lift
  'resonanceSuppressor',     // Dynamic resonance suppressor
  'correctiveEQ',
  'roomPresence',            // Synthetic-IR convolution reverb; no-op when preset.roomPresence.enabled = false
  'normalize',
  'truePeakLimit',
  'measureAfter',
  'acxCertification',
  'qualityAdvisory',
  'encode',
  'extractPeaks',
]

const PODCAST_READY_PIPELINE = [
  'decode',
  'monoMixdown',
  'measureBefore',
  'peakNormalize',
  'analyzeFramesRaw',
  'clickRemove',
  'humDetect',
  'hpf',
  'noiseReduce',
  'remeasureFramesPostNr',
  'autoLevel',
  'spectralSubtraction',
  'bandwidthExtension',
  'vocalSaturation',
  'vadGate',
  'clipGainDeEss',
  'remeasureFramesPostNr',
  'compress',
  'remeasureFramesPostNr',
  'noiseReduce',
  'parallelCompress',
  'vocalExpander',
  'airBoost',
  'resonanceSuppressor',
  'correctiveEQ',
  'roomPresence',
  'normalize',
  'truePeakLimit',
  'measureAfter',
  'acxCertification',
  'qualityAdvisory',
  'encode',
  'extractPeaks',
]

const VOICE_READY_PIPELINE = [
  'decode',
  'monoMixdown',
  'measureBefore',
  'peakNormalize',
  'analyzeFramesRaw',
  'clickRemove',
  'humDetect',
  'hpf',
  'noiseReduce',
  'remeasureFramesPostNr',
  'autoLevel',
  'spectralSubtraction',
  'bandwidthExtension',
  'vocalSaturation',
  'vadGate',
  'clipGainDeEss',
  'remeasureFramesPostNr',
  'compress',
  'remeasureFramesPostNr',
  'noiseReduce',
  'parallelCompress',
  'vocalExpander',
  'airBoost',
  'resonanceSuppressor',
  'correctiveEQ',
  'roomPresence',
  'normalize',
  'truePeakLimit',
  'measureAfter',
  'acxCertification',
  'qualityAdvisory',
  'encode',
  'extractPeaks',
]

const GENERAL_CLEAN_PIPELINE = [
  'decode',
  'monoMixdown',
  'measureBefore',
  'peakNormalize',
  'analyzeFramesRaw',
  'clickRemove',
  'humDetect',
  'hpf',
  'noiseReduce',
  'remeasureFramesPostNr',
  'autoLevel',
  'spectralSubtraction',
  'bandwidthExtension',
  'vocalSaturation',
  'vadGate',
  'clipGainDeEss',
  'remeasureFramesPostNr',
  'compress',
  'remeasureFramesPostNr',
  'noiseReduce',
  'parallelCompress',
  'vocalExpander',
  'airBoost',
  'resonanceSuppressor',
  'correctiveEQ',
  'roomPresence',
  'normalize',
  'truePeakLimit',
  'measureAfter',
  'acxCertification',
  'qualityAdvisory',
  'encode',
  'extractPeaks',
]

// ── Noise Eraser ──────────────────────────────────────────────────────────────
//
// Adds vocal source separation (Demucs or ConvTasNet). monoMixdown is omitted
// because separateVocals handles channel conversion after separation to preserve
// separation quality on stereo inputs.

const NOISE_ERASER_PIPELINE = [
  'decode',
  // No monoMixdown — see separateVocals
  'measureBefore',
  'peakNormalize',
  'analyzeFramesRaw',
  'humDetect',
  'hpf',
  'spectralSubtraction',
  'noiseReduce',
  'tonalPretreatment',       // Hum/tonal notch filtering (conditional)
  'separateVocals',          // Demucs or ConvTasNet vocal extraction
  'separationValidation',    // Artifact/sibilance/breath assessment
  'bandwidthExtension',      // AP-BWE HF restoration (conditional)
  'remeasureFramesPostNr',
  'vocalExpander',
  'vocalSaturation',
  'compress',
  'vocalExpander',
  'vadGate',
  'autoLevel',
  'airBoost',
  'roomPresence',
  'normalize',
  'truePeakLimit',
  'measureAfter',
  'acxCertification',
  'qualityAdvisory',
  'encode',
  'extractPeaks',
]

// ── ClearerVoice Eraser ───────────────────────────────────────────────────────
//
// Mirrors Noise Eraser with ClearerVoice SE (MossFormer2_SE_48K or FRCRN_SE_16K)
// replacing Demucs/ConvTasNet. ClearerVoice processes mono internally so no
// post-stage mixdown is needed.

const CLEARERVOICE_ERASER_PIPELINE = [
  'decode',
  // No monoMixdown — see clearerVoiceEnhance
  'measureBefore',
  'peakNormalize',
  'analyzeFramesRaw',
  'humDetect',
  'hpf',
  'spectralSubtraction',
  'noiseReduce',
  'tonalPretreatment',
  'clearerVoiceEnhance',
  'separationValidation',
  'residualCleanup',         // DF3 Tier 2 residual cleanup (conditional)
  'bandwidthExtension',
  'deEss',
  'remeasureFramesPostNr',
  'autoLevel',
  'compress',
  'parallelCompress',
  'vocalExpander',
  'vadGate',
  'correctiveEQ',
  'airBoost',
  'vocalSaturation',
  'roomPresence',
  'normalize',
  'truePeakLimit',
  'measureAfter',
  'acxCertification',
  'qualityAdvisory',
  'encode',
  'extractPeaks',
]

export const PRESET_PIPELINES = {
  acx_audiobook:      ACX_AUDIOBOOK_PIPELINE,
  podcast_ready:      PODCAST_READY_PIPELINE,
  voice_ready:        VOICE_READY_PIPELINE,
  general_clean:      GENERAL_CLEAN_PIPELINE,
  noise_eraser:       NOISE_ERASER_PIPELINE,
  clearervoice_eraser: CLEARERVOICE_ERASER_PIPELINE,
}
