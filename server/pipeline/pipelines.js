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
// mode, NR ceiling) are all expressed through preset config — not pipeline shape.
const STANDARD_PIPELINE = [
  stages.decode,
  stages.monoMixdown,
  stages.measureBefore,
  stages.silenceAnalysisRaw,
  stages.hpf,
  stages.noiseReduce,
  stages.silenceAnalysisPostNr,
  stages.enhancementEQ,
  stages.silenceAnalysisPreDeEss,
  stages.deEss,
  stages.compress,
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
    stages.silenceAnalysisRaw,
    stages.hpf,
    stages.noiseReduce,
    stages.silenceAnalysisPostNr,
    stages.roomTonePad,             // ACX-only
    stages.enhancementEQ,
    stages.silenceAnalysisPreDeEss,
    stages.deEss,
    stages.compress,
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
    stages.silenceAnalysisRaw,      // Pre-processing noise floor for NE-2/NE-4
    stages.rnnoisePrePass,          // NE-1: RNNoise stationary noise reduction
    stages.tonalPretreatment,       // NE-2: Hum/tonal notch filtering (conditional)
    stages.separateVocals,          // NE-3: Demucs or ConvTasNet vocal extraction
    stages.separationValidation,    // NE-4: Artifact/sibilance/breath assessment
    stages.residualCleanup,         // NE-5: DF3 Tier 2 residual cleanup (conditional)
    stages.bandwidthExtension,      // NE-6: AudioSR HF restoration (conditional)
    stages.separationEQ,            // NE-7: Post-separation enhancement EQ
    stages.normalize,               // Stage 5: Loudness normalization
    stages.truePeakLimit,           // Stage 6: True peak limiting
    stages.measureAfter,
    stages.acxCertification,        // Only emits when output_profile === 'acx'
    stages.qualityAdvisory,
    stages.encode,
    stages.extractPeaks,
  ],

  // Resemble Enhance: single-model alternative to the Noise Eraser separation chain.
  // Replaces NE-1 through NE-7 with one Resemble Enhance pass (denoise or full enhance).
  // No monoMixdown here — resembleEnhance handles channel conversion after processing.
  resemble_enhance: [
    stages.decode,
    stages.measureBefore,
    stages.silenceAnalysisRaw,
    stages.resembleEnhance,         // RE-1: Resemble Enhance denoise or full enhance
    stages.normalize,
    stages.truePeakLimit,
    stages.measureAfter,
    stages.acxCertification,
    stages.qualityAdvisory,
    stages.encode,
    stages.extractPeaks,
  ],

  // VoiceFixer: vocoder-based speech restoration for reverberant/clipped recordings.
  // Replaces NE-1 through NE-7 with a single VoiceFixer restoration pass.
  // VoiceFixer outputs mono — no explicit mixdown stage needed.
  voicefixer: [
    stages.decode,
    stages.measureBefore,
    stages.silenceAnalysisRaw,
    stages.voiceFixerRestore,       // VF-1: VoiceFixer speech restoration
    stages.normalize,
    stages.truePeakLimit,
    stages.measureAfter,
    stages.acxCertification,
    stages.qualityAdvisory,
    stages.encode,
    stages.extractPeaks,
  ],
}
