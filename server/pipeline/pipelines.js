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
const STANDARD_PIPELINE = [
  stages.decode,
  stages.monoMixdown,
  stages.measureBefore,
  stages.peakNormalize,
  stages.silenceAnalysisRaw,
  stages.hpf,
  stages.noiseReduce,
  stages.silenceAnalysisPostNr,
  stages.dereverb,              // no-op when preset.dereverb.enabled is false
  stages.enhancementEQ,
  stages.silenceAnalysisPreDeEss,
  stages.deEss,
  stages.compress,
  stages.harmonicExciter,
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
  acx_audiobook: [
    stages.decode,
    stages.monoMixdown,
    stages.measureBefore,
    stages.peakNormalize,
    stages.silenceAnalysisRaw,
    stages.hpf,
    stages.noiseReduce,
    stages.silenceAnalysisPostNr,
    stages.dereverb,                // runs before room tone padding so padded room tone matches dereverberated signal
    stages.roomTonePad,             // ACX-only
    stages.enhancementEQ,
    stages.silenceAnalysisPreDeEss,
    stages.deEss,
    stages.compress,
    stages.harmonicExciter,
    stages.normalize,
    stages.truePeakLimit,
    stages.measureAfter,
    stages.acxCertification,
    stages.qualityAdvisory,
    stages.encode,
    stages.extractPeaks,
  ],

  podcast_ready: STANDARD_PIPELINE,
  voice_ready:   STANDARD_PIPELINE,
  general_clean: STANDARD_PIPELINE,

  // Noise Eraser: parallel separation path replacing Stages 1–4a.
  // Rejoins the standard chain at normalize (Stage 5) through extractPeaks.
  //
  // Key differences from STANDARD_PIPELINE:
  //   - monoMixdown is omitted — separateVocals handles channel conversion
  //     AFTER separation to preserve separation quality on stereo inputs.
  //   - hpf / noiseReduce / enhancementEQ / deEss / compress are all replaced
  //     by the NE-1 through NE-7 separation stages.
  //   - silenceAnalysisRaw is kept: provides rawNoiseFloor for NE-2 tonal
  //     analysis (hum detection) and NE-4 validation logging.
  noise_eraser: [
    stages.decode,
    // No monoMixdown here — see separateVocals
    stages.measureBefore,
    stages.peakNormalize,
    stages.silenceAnalysisRaw,      // Pre-processing noise floor for NE-2/NE-4
    stages.hpf,
    stages.rnnoisePrePass,          // NE-1: RNNoise stationary noise reduction
    stages.tonalPretreatment,       // NE-2: Hum/tonal notch filtering (conditional)
    stages.separateVocals,          // NE-3: Demucs or ConvTasNet vocal extraction
    stages.separationValidation,    // NE-4: Artifact/sibilance/breath assessment
    stages.residualCleanup,         // NE-5: DF3 Tier 2 residual cleanup (conditional)
    stages.dereverb,
    stages.silenceAnalysisPostNr,    // Required by enhancementEQ (populates ctx.silencePostNr)
    //stages.separationEQ,
    stages.enhancementEQ,
    stages.silenceAnalysisPreDeEss,
    stages.deEss,
    stages.compress,
    stages.harmonicExciter,         // Adds presence/air harmonic content before normalization
    stages.normalize,               // Stage 5: Loudness normalization
    stages.truePeakLimit,           // Stage 6: True peak limiting
    stages.measureAfter,
    stages.acxCertification,        // Only emits when output_profile === 'acx'
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
    // No monoMixdown here — clearerVoiceEnhance mixes to mono inside the Python script
    stages.measureBefore,
    stages.peakNormalize,
    stages.silenceAnalysisRaw,      // Pre-processing noise floor for NE-2/NE-4
    stages.rnnoisePrePass,          // NE-1: RNNoise stationary noise reduction
    stages.tonalPretreatment,       // NE-2: Hum/tonal notch filtering (conditional)
    stages.clearerVoiceEnhance,     // CE-3: ClearerVoice SE replaces Demucs/ConvTasNet
    stages.separationValidation,    // NE-4: Artifact/sibilance/breath assessment
    stages.residualCleanup,         // NE-5: DF3 Tier 2 residual cleanup (conditional)
    //stages.separationEQ,            // NE-7: Post-separation enhancement EQ
    stages.enhancementEQ,
    stages.harmonicExciter,         // Adds presence/air harmonic content before normalization
    stages.normalize,               // Stage 5: Loudness normalization
    stages.truePeakLimit,           // Stage 6: True peak limiting
    stages.measureAfter,
    stages.acxCertification,        // Only emits when output_profile === 'acx'
    stages.qualityAdvisory,
    stages.encode,
    stages.extractPeaks,
  ],

}
