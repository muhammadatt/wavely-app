/**
 * Pipeline definitions — maps each preset ID to an ordered array of stage
 * functions. The runner in index.js executes whichever pipeline matches the
 * incoming presetId, so adding a new preset or varying its stage sequence
 * requires no changes to the orchestrator.
 *
 * Stages are imported from stages.js.
 */

import * as stages from './stages.js'

// Shared by podcast_ready, voice_ready, and general_clean.
// Differences between these presets (mono vs stereo, EQ profile, compression
// mode, NR ceiling, dereverb enabled/disabled) are all expressed through preset
// config — not pipeline shape. The dereverb stage is a no-op when
// preset.dereverb is absent or preset.dereverb.enabled is false.
//
// Stage order: autoLevel runs immediately before compress. The Auto Leveler
// is M Leveller-style clip automation — it segments voiced audio into clips
// and applies a single flat gain offset per clip. Running it pre-compression
// hands the compressor a level-stable input so it can act with a consistent
// character across the file.
const STANDARD_PIPELINE = [
  stages.decode,
  stages.monoMixdown,
  stages.measureBefore,
  stages.peakNormalize,
  stages.analyzeFramesRaw,
  stages.clickRemove,             // Pre-HPF: Hampel + Burg AR click/lip-smack repair
  stages.humDetect,               // Pre-HPF: spectral hum detection + conditional notch EQ
  stages.hpf,                     // 80hz hi pass filter
  stages.noiseReduce,             // Main Noise Reduction (DF3, RNNoise, DTLN)
  //stages.resonanceSuppressor,     // Dynamic resonance suppressor - pre-pass
  stages.remeasureFramesPostNr,
  stages.autoLevel,               // M Leveller-style per-clip gain automation (pre-compression)
  stages.spectralSubtraction,     // MMSE Wiener pre-pass + optional transient shaper (before ML NR)
  //stages.dereverb,
  //stages.breathReduce,            // Breath event detection and gain reduction
  stages.bandwidthExtension,      // HF restoration/ enhacement (enabled per preset.bwe; no-op when disabled)
  stages.vocalSaturation,
  stages.vadGate,                 // Smooth VAD-driven silence-floor gate (no-op when preset.vadGate.enabled is false)
  stages.remeasureFramesPostNr,   // Recalculate noise floor and update ctx.results.metrics before autoLevel + compression
  stages.compress,                // Serial compression
  stages.remeasureFramesPostNr,   // Refresh noise floor after compression so second NR skip-check is accurate
  stages.noiseReduce,             // Conditional secondary NR pass
  stages.parallelCompress,        // Parallel compression
  stages.vocalExpander,           // Frequency-selective expander (silence-floor residual attenuator)
  stages.airBoost,                // Maag EQ4-style air/HF shelf lift; no-op when air_boost_db ≤ 0
  stages.resonanceSuppressor,     // Dynamic resonance suppressor — post-pass
  stages.enhancementEQ,
  //stages.deEss,                   // Split band De-Esser  
  stages.roomPresence,            // Synthetic-IR convolution reverb; no-op when preset.roomPresence.enabled = false
  //stages.roomTonePad,             // TO DO: Make configurable option; For ACX-only preset only; Changes file length
  stages.normalize,
  stages.truePeakLimit,
  stages.measureAfter,
  stages.acxCertification,
  stages.qualityAdvisory,
  stages.encode,
  stages.extractPeaks,
]

export const PIPELINES = {
  // ACX Audiobook: identical to STANDARD_PIPELINE plus roomTonePad after
  // post-NR silence analysis. Room tone padding must run on the HPF+NR signal
  // (not raw) so the sampled room tone matches the processed audio character.

  acx_audiobook: STANDARD_PIPELINE,
  podcast_ready: STANDARD_PIPELINE,
  voice_ready:   STANDARD_PIPELINE,
  general_clean: STANDARD_PIPELINE,

  // Noise Eraser: Adds a voice separation stage for additional denoise benefits.
  //
  // Key differences from STANDARD_PIPELINE:
  //   - monoMixdown is omitted — separateVocals handles channel conversion
  //     AFTER separation to preserve separation quality on stereo inputs.

  noise_eraser: [
    stages.decode,
    // No monoMixdown here — see separateVocals
    stages.measureBefore,
    stages.peakNormalize,
    stages.analyzeFramesRaw,        // Pre-processing noise floor for NE-2/NE-4
    stages.humDetect,               // Pre-HPF: spectral hum detection + conditional notch EQ
    stages.hpf,
    stages.spectralSubtraction,     // MMSE Wiener pre-pass + optional transient shaper (before ML NR)
    stages.noiseReduce,
    stages.tonalPretreatment,       // Hum/tonal notch filtering (conditional)
    stages.separateVocals,          // Demucs or ConvTasNet vocal extraction
    stages.separationValidation,    // Artifact/sibilance/breath assessment
    //stages.residualCleanup,       // DF3 Tier 2 residual cleanup (conditional)
    stages.bandwidthExtension,      // AP-BWE HF restoration (conditional)
    //stages.deEss,
    //stages.dereverb,
    stages.remeasureFramesPostNr,    // Recalculate noise floor and update ctx.results.metrics before compression
    stages.vocalExpander,   
    stages.vocalSaturation,
    stages.compress,                 // standard serial compression
    //stages.parallelCompress,         // parallel compression
    stages.vocalExpander,            // Stage 4a-E — frequency-selective expander
    stages.vadGate,                  // Smooth VAD-driven silence-floor gate (no-op when preset.vadGate.enabled is false)
    stages.autoLevel,                // VAD-gated gain riding; no-op when drift ≤ 3 dB σ
    stages.enhancementEQ,
    stages.airBoost,               // Stage 3b — no-op for noise_eraser (air_boost_db = 0)
    //stages.harmonicExciter,         // Adds presence/air harmonic content before normalization

    //Finalize
    stages.roomPresence,             // Synthetic-IR convolution reverb; disabled in noise_eraser preset config
    stages.normalize,                // Loudness normalization
    stages.truePeakLimit,            // True peak limiting
    stages.measureAfter,
    stages.acxCertification,         // Only emits when output_profile === 'acx'
    stages.qualityAdvisory,
    stages.encode,
    stages.extractPeaks,
  ],

  // ClearerVoice Eraser: mirrors the Noise Eraser pipeline with ClearerVoice SE
  // (MossFormer2_SE_48K or FRCRN_SE_16K) in place of Demucs/ConvTasNet (NE-3).
  //
  // Key differences from noise_eraser:
  //   - clearerVoiceEnhance replaces separateVocals — ClearerVoice SE models
  //     process mono audio internally, so no post-stage mixdown is needed.
  //   - All other stages (NE-1/2/4–7, normalization, encode) are identical to
  //     noise_eraser and share the same context keys.
  clearervoice_eraser: [
    stages.decode,
    // No monoMixdown here — see separateVocals
    stages.measureBefore,
    stages.peakNormalize,
    stages.analyzeFramesRaw,        // Pre-processing noise floor for NE-2/NE-4
    stages.humDetect,               // Pre-HPF: spectral hum detection + conditional notch EQ
    stages.hpf,
    stages.spectralSubtraction,     // MMSE Wiener pre-pass + optional transient shaper (before ML NR)
    stages.noiseReduce,
    stages.tonalPretreatment,       // Hum/tonal notch filtering (conditional)
    stages.clearerVoiceEnhance,     // Clearer Voice
    stages.separationValidation,    // Artifact/sibilance/breath assessment
    stages.residualCleanup,         // DF3 Tier 2 residual cleanup (conditional)
    stages.bandwidthExtension,      // AP-BWE HF restoration (conditional)
    stages.deEss,
    //stages.dereverb,
    stages.remeasureFramesPostNr,    // Recalculate noise floor and update ctx.results.metrics before autoLevel + compression
    stages.autoLevel,                // M Leveller-style per-clip gain automation (pre-compression)
    stages.compress,                 // standard serial compression
    stages.parallelCompress,         // parallel compression
    stages.vocalExpander,            // Stage 4a-E — frequency-selective expander
    stages.vadGate,                  // Smooth VAD-driven silence-floor gate (no-op when preset.vadGate.enabled is false)
    stages.enhancementEQ,
    stages.airBoost,               // Stage 3b — no-op for clearervoice_eraser (air_boost_db = 0)
    //stages.harmonicExciter,         // Adds presence/air harmonic content before normalization
    stages.vocalSaturation,
    stages.roomPresence,             // Synthetic-IR convolution reverb; disabled in clearervoice_eraser preset config
    stages.normalize,                // Loudness normalization
    stages.truePeakLimit,            // True peak limiting
    stages.measureAfter,
    stages.acxCertification,         // Only emits when output_profile === 'acx'
    stages.qualityAdvisory,
    stages.encode,
    stages.extractPeaks,
  ],

}
