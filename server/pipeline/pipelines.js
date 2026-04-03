/**
 * Pipeline definitions — maps each preset ID to an ordered array of stage
 * functions. The runner in index.js executes whichever pipeline matches the
 * incoming presetId, so adding a new preset or varying its stage sequence
 * requires no changes to the orchestrator.
 *
 * Stages are imported from stages.js. New stages for Noise Eraser (NE-1
 * through NE-7) will be added to stages.js and declared below when Sprint
 * NE-1 is implemented.
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
  stages.complianceCheck,
  stages.riskAssess,
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
    stages.complianceCheck,
    stages.riskAssess,
    stages.encode,
    stages.extractPeaks,
  ],

  podcast_ready: STANDARD_PIPELINE,
  voice_ready:   STANDARD_PIPELINE,
  general_clean: STANDARD_PIPELINE,

  // noise_eraser: defined in Sprint NE-1. The preset exists in presets.js
  // and the UI shows it as "Coming soon". Pipeline will be added here once
  // the NE stage functions (rnnoisePrePass, separateVocals, etc.) are built.
}
