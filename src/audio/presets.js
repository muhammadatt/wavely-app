/**
 * Audio Effect Presets and Output Profiles
 *
 * Pure data definitions for the Instant Polish processing chain.
 * No side effects, no Vue dependency.
 */

/**
 * @typedef {Object} OutputProfile
 * @property {string} id
 * @property {string} displayName
 * @property {[number, number]} loudnessRange - [min, max] in dBFS (RMS) or LUFS — defines the acceptable compliance window
 * @property {number} normalizationTarget - the specific dBFS RMS or LUFS value to target during normalization (may differ from loudnessRange midpoint)
 * @property {number} truePeakCeiling - dBFS
 * @property {number|null} noiseFloorCeiling - dBFS, null if not enforced
 * @property {'RMS'|'LUFS'} measurementMethod
 */

/** @type {Record<string, OutputProfile>} */
export const OUTPUT_PROFILES = {
  acx: {
    id: 'acx',
    displayName: 'ACX Audiobook',
    loudnessRange: [-23, -18],
    normalizationTarget: -20,   // dBFS RMS — ACX spec target, not the range midpoint (-20.5)
    truePeakCeiling: -3,
    noiseFloorCeiling: -60,
    measurementMethod: 'RMS',
  },
  podcast: {
    id: 'podcast',
    displayName: 'Podcast / Streaming',
    loudnessRange: [-18, -14],
    normalizationTarget: -16,   // LUFS integrated — midpoint of loudnessRange
    truePeakCeiling: -1,
    noiseFloorCeiling: null,
    measurementMethod: 'LUFS',
  },
  broadcast: {
    id: 'broadcast',
    displayName: 'Broadcast',
    loudnessRange: [-24, -22],
    normalizationTarget: -23,   // LUFS integrated — midpoint of loudnessRange
    truePeakCeiling: -1,
    noiseFloorCeiling: null,
    measurementMethod: 'LUFS',
  },
}

// Backward compatibility: accept 'standard' as alias for 'podcast'
export function resolveOutputProfileId(id) {
  if (id === 'standard') return 'podcast'
  return id
}

/**
 * @typedef {Object} ParallelCompressionConfig
 * @property {number} ratio                        - Wet branch compressor ratio (e.g. 8 for 8:1)
 * @property {number} attackMs                     - Attack time in ms
 * @property {number} releaseMs                    - Release time in ms
 * @property {number|'auto'} makeupGain            - Makeup gain: number for fixed dB, 'auto' for automatic matching
 * @property {number} wetMix                       - Target wet mix fraction (0.0–1.0)
 * @property {number} vadFadeMs                    - VAD gate fade duration (ms) for open and close transitions
 * @property {number} crestGuardThresholdDb        - Crest factor below which wet mix is scaled down
 * @property {number} parallelDesserMaxReductionDb - Max gain reduction of parallel de-esser on wet branch (dB)
 *
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} displayName
 * @property {string} description
 * @property {string} audience
 * @property {string} character
 * @property {{ value: number, unit: string }} targetLoudness
 * @property {number} truePeakCeiling
 * @property {number|null} noiseFloorTarget
 * @property {CompressionConfig|CompressionConfig[]} compression
 * @property {ParallelCompressionConfig} parallelCompression
 *
 * @typedef {Object} CompressionConfig
 * @property {number} targetCrestFactorDb  - Target crest factor for output voiced speech (dB). Compression is skipped if input crest factor is already within this value.
 * @property {number} thresholdPercentile  - Percentile of voiced-frame RMS distribution used to anchor the threshold (e.g. 0.75 = 75th percentile).
 * @property {number} attack               - Attack time in ms
 * @property {number} release              - Release time in ms
 * @property {string} eqProfile
 * @property {{ sensitivity: 'standard'|'high'|'none', trigger: number, maxReduction: number }} deEsser
 * @property {'mono'|'preserve'} channelOutput
 * @property {string} defaultOutputProfile
 * @property {boolean} lockedOutputProfile
 * @property {{ enabled: boolean, strength: 'light'|'medium'|'heavy', preserve_early: boolean }} dereverb
 * @property {{ maxGainDb: number, maxRateDbPerS: number }} autoLeveler
 * @property {'demucs'|'convtasnet'} [separationModel]   - Noise Eraser only
 * @property {'mossformer2_48k'|'frcrn_16k'} [clearervoiceModel]   - ClearerVoice Eraser only
 * @property {{ enabled: boolean, postEq?: { enabled: boolean, freq?: number, q?: number, gainDb: number } }} bwe - Bandwidth extension (AP-BWE); enabled for NE presets, disabled for standard presets. postEq applies a narrow bell cut after BWE to tame sibilance introduced by HF synthesis.
 */

/** @type {Record<string, Preset>} */
export const PRESETS = {
  acx_audiobook: {
    id: 'acx_audiobook',
    displayName: 'ACX Audiobook',
    description: 'Conservative, transparent processing for audiobook narration',
    audience: 'Audiobook narrators',
    character: 'Clean, present, natural',
    targetLoudness: { value: -20, unit: 'dBFS RMS' },
    truePeakCeiling: -3,
    noiseFloorTarget: -60,
    noiseModel: 'df3',
    eqProfile: 'audiobook',
    airBoost: { gainDb: 5 },
    bweModel: 'lavasr',
    bwe: { enabled: true, postEq: { enabled: false, freq: 9000, q: 2, gainDb: -3 } },
    deEsser: {
      sensitivity: 'medium',
      trigger: 1,
      maxReduction: 6,
      crossoverHz: 4000,
    },
    channelOutput: 'mono',
    defaultOutputProfile: 'acx',
    lockedOutputProfile: true,
    dereverb: {
      enabled: true,
      strength: 'medium',
      preserve_early: true,
    },
    autoLeveler: {
      maxGainDb:     10.0,
      maxRateDbPerS: 2.0,
    },
    saturation: {
      drive: 1.8,
      wetDry: 0.05,
      bias: 0.08
    },
    compression: [

      // Pass 1: Transient Catcher (Peak Control)
      // Hits only the loudest errant peaks (plosives, exclamations) very quickly
      {
        targetCrestFactorDb: 15,
        maxRatio: 6,
        threshold: 'auto',
        follow: false,
        attack: 0.1,  // Extremely fast to catch peaks
        release: 30,  // Fast release to get out of the way quickly
      },
      /*
      //Tonal Pass for character
      {
      targetCrestFactorDb: 12,
      maxRatio: 4,
      threshold: 'auto',
      follow: false,
      attack: 10,
      release: 80,
      },*/
      // Pass 2: Gentle Leveler (Body Control)
      // Smooths out the overall performance, bringing up presence without pumping
      
      {
        targetCrestFactorDb: 15,
        maxRatio: 3, // Gentle ratio for transparency
        threshold: 'auto',
        follow: false,
        attack: 15,    // Slow enough to let crisp consonants through (presence)
        release: 120,  // Slow release for smooth, unnoticeable recovery
      }
      
    ],
    parallelCompression: {
      ratio:                       20,
      attackMs:                    15,   
      releaseMs:                   150,
      makeupGain:                  'auto', // automatically match average gain reduction
      wetMix:                      0.15,
      vadFadeMs:                   5,
      crestGuardThresholdDb:       12,
      parallelDesserMaxReductionDb: 15,
    },
    // Expander — reduce the level of the noise floor
    // headroomOffsetDb - defines how close to speech threshold; 
    // highFreqDepth - reduces gain reduction for noise outside the top of the frequency band -- 
    // e.g. (0.25) preserves breath/fricative transparency above 800 Hz.
    vocalExpander: {
      enabled:          false,
      ratio:            2.5,
      highFreqDepth:    0.25,
      headroomOffsetDb: 6,
      releaseMs:        150,
      attackMs:         50,
      holdMs:           5,
      lookaheadMs:      250,
      maxAttenuationDb: 24,
      detectionBand:    { lowHz: 80, highHz: 800 },
    },
    // VAD Gate — conservative for ACX. Shallower floor preserves audible room
    // tone; generous hold prevents chopping the long decay of narrated word endings.
    vadGate: {
      enabled:     true,
      lookaheadMs: 60, //Higher = fewer clipped onsets, more latency
      holdMs:      200, //Higher = fewer clipped endings, less breath reduction
      attackMs:    5, //Slower attack softens plosive transients
      releaseMs:   80, //Slower release = more natural fade-out
      floorDb:     -110, //-∞ = fully silent gaps (unnatural), -40 = subtle presence
    },
    // Conservative: enough to clean audible breaths that flag ACX human review,
    // but not so deep that the narrator's breathing presence disappears entirely.
    breathReducer: { max_reduction_db: 12 },
    // Slightly more aggressive — mouth clicks are a human review concern for ACX
    clickRemover: { thresholdSigma: 3.0, maxClickMs: 15 },
    // MMSE spectral subtraction pre-pass (before DF3). Conservative settings for
    // ACX: lower strength preserves the natural vocal character ACX human reviewers
    // expect; transient shaper disabled to avoid any risk of gating room tone.
    spectralSubtraction: {
      enabled:              true,
      alphaDd:              0.98,
      beta:                 0.15,
      strength:             0.7,
      transientShaper:      false,
    },
    // Stage 4 — Sibilance Suppressor. Sparse overrides; anything omitted
    // inherits from DEFAULT_PARAMS in server/scripts/sibilance_suppressor.py.
    // Conservative ACX tuning: lower depth and
    // ceiling, slower release to preserve narration intelligibility.
    sibilanceSuppressor: {
      depth: 0.6,
      release_ms:           80.0,
      max_reduction_db:     8.0,
    },
  },

  podcast_ready: {
    id: 'podcast_ready',
    displayName: 'Podcast Ready',
    description: 'Punchy, consistent sound for podcast distribution',
    audience: 'Podcast hosts',
    character: 'Punchy, intimate, consistent',
    targetLoudness: { value: -16, unit: 'LUFS' },
    truePeakCeiling: -1,
    noiseFloorTarget: null,
    noiseModel: 'df3',
    compression: [
      // Pass 1: Transient Catcher (Peak Control)
      {
        targetCrestFactorDb: 14,
        maxRatio: 5,
        threshold: 'auto',
        follow: false,
        attack: 0.1,
        release: 40,
      },
      // Pass 2: Aggressive Leveler (The "Radio" Sound)
      {
        targetCrestFactorDb: 10,
        maxRatio: 4,
        threshold: 'auto',
        follow: false,
        attack: 5,     // Faster than ACX to thicken the voice, but still lets some punch through
        release: 80,   // Faster release for a denser, higher-energy consistent sound
      }
    ],
    eqProfile: 'podcast',
    deEsser: {
      sensitivity: 'high',
      trigger: 6,
      maxReduction: 6,
      crossoverHz: 4000,
    },
    channelOutput: 'preserve',
    defaultOutputProfile: 'podcast',
    lockedOutputProfile: false,
    dereverb: {
      enabled: false,
      strength: 'light',
      preserve_early: true,
    },
    autoLeveler: {
      maxGainDb:     8.0,
      maxRateDbPerS: 1.5,
    },
    saturation: {
      drive: 2.0,
      wetDry: 0.30,
      bias: 0.10,
      fc: 3000,
    },
    parallelCompression: {
      ratio:                       10,
      attackMs:                    0.40,   // midpoint of 0.3–0.5 ms spec range
      releaseMs:                   120,
      makeupGain:                  'auto', // automatically match average gain reduction
      wetMix:                      0.40,   // midpoint of 25–35%
      vadFadeMs:                   10,
      crestGuardThresholdDb:       12,
      parallelDesserMaxReductionDb: 10,
    },
    // Stage 4a-E: Vocal Expander. Assertive settings for processed podcast
    // character: 2.0:1 ratio with wider +6 dB headroom is acceptable because
    // listeners expect a tighter, more processed sound.
    vocalExpander: {
      enabled:          true,
      ratio:            2.0,
      highFreqDepth:    0.5,
      headroomOffsetDb: 6,
      releaseMs:        150,
      attackMs:         10,
      holdMs:           20,
      lookaheadMs:      10,
      maxAttenuationDb: 18,
      detectionBand:    { lowHz: 80, highHz: 800 },
    },
    // VAD Gate — assertive for podcast. Deeper floor matches the tighter,
    // more processed character; faster release keeps the gate from feeling
    // sluggish on rapid-fire dialogue.
    vadGate: {
      enabled:     false,
      lookaheadMs: 20,
      holdMs:      80,
      attackMs:    8,
      releaseMs:   40,
      floorDb:     -60,
    },
    airBoost: { gainDb: 2.5 },
    bweModel: 'ap_bwe',
    bwe: { enabled: true, postEq: { enabled: true, freq: 9000, q: 2, gainDb: -3 } },
    // Light reduction — podcast listeners expect some breath presence; going
    // deeper makes the performance feel over-edited.
    breathReducer: { max_reduction_db: 6 },
    clickRemover: { thresholdSigma: 3.5, maxClickMs: 15 },
    // MMSE spectral subtraction pre-pass (before DF3). Full strength with transient
    // shaper enabled — podcast listeners expect a processed, tight sound and benefit
    // from inter-phrase reverb tail suppression.
    spectralSubtraction: {
      enabled:                 true,
      alphaDd:                 0.98,
      beta:                    0.15,
      strength:                1.0,
      transientShaper:         true,
      transientMaxReductionDb: 6,
    },
    // Stage 4 — Sibilance Suppressor. Slightly deeper reduction with a faster
    // attack matches the punchier, more processed podcast character; everything
    // else inherits from DEFAULT_PARAMS.
    sibilanceSuppressor: {
      depth:     0.7,
      attack_ms: 4.0,
    },
  },

  voice_ready: {
    id: 'voice_ready',
    displayName: 'Voice Ready',
    description: 'Broadcast-quality processing for voice-over work',
    audience: 'Voice actors',
    character: 'Clean, broadcast-quality, neutral',
    targetLoudness: { value: -20, unit: 'dBFS RMS' },
    truePeakCeiling: -3,
    noiseFloorTarget: null,
    noiseModel: 'df3',
    compression: {
      mode: 'conditional',
      targetCrestFactorDb: 12,
      thresholdPercentile: 0.75,
      attack: 8,
      release: 90,
    },
    eqProfile: 'general',
    deEsser: {
      sensitivity: 'standard',
      trigger: 8,
      maxReduction: 5,
      crossoverHz: 4000,
    },
    channelOutput: 'mono',
    defaultOutputProfile: 'acx',
    lockedOutputProfile: false,
    dereverb: {
      enabled: true,
      strength: 'heavy', // VACE-WPE (heavy) //Set to 'medium' here to use NARA-WPE
      preserve_early: false,
    },
    autoLeveler: {
      maxGainDb:     4.0,
      maxRateDbPerS: 1.0,
    },
    saturation: {
      drive: 2.0,
      wetDry: 0.3,
      bias: 0.08,
      fc: 4000,
    },
    parallelCompression: {
      ratio:                       8,
      attackMs:                    0.50,
      releaseMs:                   150,
      makeupGain:                  'auto', // automatically match average gain reduction
      wetMix:                      0.225,  // midpoint of 20–25%
      vadFadeMs:                   5,
      crestGuardThresholdDb:       12,
      parallelDesserMaxReductionDb: 10,
    },
    // Stage 4a-E: Vocal Expander. Conservative settings matching ACX: voice-over
    // work often sits under music beds, so pumping and gating artifacts are
    // audible — the slower 200 ms release and low highFreqDepth keep the stage
    // transparent.
    vocalExpander: {
      enabled:          true,
      ratio:            1.5,
      highFreqDepth:    0.25,
      headroomOffsetDb: 4,
      releaseMs:        200,
      attackMs:         10,
      holdMs:           20,
      lookaheadMs:      10,
      maxAttenuationDb: 12,
      detectionBand:    { lowHz: 80, highHz: 800 },
    },
    // VAD Gate — broadcast-neutral. Shallower floor than podcast since
    // voice-over often sits under music; a hard cut would be audible against
    // the bed.
    vadGate: {
      enabled:     false,
      lookaheadMs: 25,
      holdMs:      100,
      attackMs:    10,
      releaseMs:   60,
      floorDb:     -55,
    },
    airBoost: { gainDb: 2.0 },
    bweModel: 'ap_bwe',
    bwe: { enabled: true, postEq: { enabled: true, freq: 9000, q: 2, gainDb: -3 } },
    // Moderate — voice-over often sits under music beds where breaths are
    // audible; deeper reduction than podcast, lighter than ACX.
    breathReducer: { max_reduction_db: 10 },
    // Same rationale as ACX — voice actors also benefit from clean transients
    clickRemover: { thresholdSigma: 3.0, maxClickMs: 15 },
    // MMSE spectral subtraction pre-pass (before DF3). Moderate strength; transient
    // shaper disabled because voice-over often sits under music beds where any gating
    // artifact becomes audible against the bed.
    spectralSubtraction: {
      enabled:              true,
      alphaDd:              0.98,
      beta:                 0.15,
      strength:             0.8,
      transientShaper:      false,
    },
    // Stage 4 — Sibilance Suppressor. Broadcast-neutral tuning sits between
    // ACX and podcast: stricter detection than the defaults, lower ceiling
    // than ACX since voice-over often sits under music beds where deep cuts
    // become audible.
    sibilanceSuppressor: {
      p95_trigger_db:       8.0,
      p95_threshold_db:     4.0,
      broadband_trigger_db: 11.0,
      selectivity:          5.5,
      release_ms:           70.0,
      max_reduction_db:     8.0,
    },
  },

  general_clean: {
    id: 'general_clean',
    displayName: 'General Clean',
    description: 'Balanced cleanup for any audio recording',
    audience: 'Everyone',
    character: 'Pragmatic, balanced',
    targetLoudness: { value: -16, unit: 'LUFS' },
    truePeakCeiling: -1,
    noiseFloorTarget: null,
    noiseModel: 'df3',
    compression: {
      mode: 'conditional',
      targetCrestFactorDb: 10,
      thresholdPercentile: 0.70,
      attack: 8,
      release: 80,
    },
    eqProfile: 'general',
    deEsser: {
      sensitivity: 'high',
      trigger: 6,
      maxReduction: 8,
      crossoverHz: 4000,
    },
    channelOutput: 'preserve',
    defaultOutputProfile: 'podcast',
    lockedOutputProfile: false,
    dereverb: {
      enabled: true,
      strength: 'heavy',
      preserve_early: false,
    },
    autoLeveler: {
      maxGainDb:     8.0,
      maxRateDbPerS: 1.5,
    },
    saturation: {
      drive: 2.0,
      wetDry: 0.3,
      bias: 0.10,
      fc: 3000,
    },
    parallelCompression: {
      ratio:                       10,
      attackMs:                    0.30,
      releaseMs:                   120,
      makeupGain:                  'auto', // automatically match average gain reduction
      wetMix:                      0.35,   // midpoint of 30–40%
      vadFadeMs:                   8,
      crestGuardThresholdDb:       9,      // relaxed per spec
      parallelDesserMaxReductionDb: 12,
    },
    // Stage 4a-E: Vocal Expander. Pragmatic assertive settings — this preset
    // accepts more aggressive processing in exchange for a cleaner silence floor.
    vocalExpander: {
      enabled:          true,
      ratio:            2.0,
      highFreqDepth:    0.5,
      headroomOffsetDb: 6,
      releaseMs:        150,
      attackMs:         10,
      holdMs:           20,
      lookaheadMs:      10,
      maxAttenuationDb: 18,
      detectionBand:    { lowHz: 80, highHz: 800 },
    },
    // VAD Gate — assertive for general_clean. Unknown source material; a
    // cleaner silence floor is generally preferable.
    vadGate: {
      enabled:     false,
      lookaheadMs: 20,
      holdMs:      80,
      attackMs:    8,
      releaseMs:   40,
      floorDb:     -60,
    },
    airBoost: { gainDb: 16 },
    bweModel: 'ap_bwe',
    bwe: { enabled: true, postEq: { enabled: true, freq: 9000, q: 2, gainDb: -3 } },
    // Aggressive — unknown source material; cleaner is generally better here.
    breathReducer: { max_reduction_db: 15 },
    // Conservative — unknown source material
    clickRemover: { thresholdSigma: 3.5, maxClickMs: 10 },
    // MMSE spectral subtraction pre-pass (before DF3). Full strength with transient
    // shaper enabled — unknown source material benefits from maximum diffuse noise and
    // reverb tail reduction before DF3.
    spectralSubtraction: {
      enabled:                 true,
      alphaDd:                 0.98,
      beta:                    0.15,
      strength:                1.0,
      transientShaper:         true,
      transientMaxReductionDb: 6,
    },
    // Stage 4 — Sibilance Suppressor. Pragmatic assertive: lower broadband
    // trigger and selectivity catch more events, deeper reduction with a
    // narrower spreading kernel (sharpness 0.2) for surgical cuts on unknown
    // source material.
    sibilanceSuppressor: {
      broadband_trigger_db: 9.0,
      depth:                0.8,
      selectivity:          4.0,
      attack_ms:            4.0,
      release_ms:           50.0,
      max_reduction_db:     12.0,
      sharpness:            0.2,
    },
  },

  noise_eraser: {
    id: 'noise_eraser',
    displayName: 'Noise Eraser',
    description: 'Voice extraction for severely noisy recordings',
    audience: 'Noisy recordings',
    character: 'Aggressive separation, dry booth quality',
    targetLoudness: { value: -16, unit: 'LUFS' },
    truePeakCeiling: -1,
    noiseFloorTarget: null,
    eqProfile: 'audiobook',
    deEsser: {
      sensitivity: 'high',
      trigger: 6,
      maxReduction: 8,
      crossoverHz: 4000,
    },
    channelOutput: 'mono',
    defaultOutputProfile: 'podcast',
    lockedOutputProfile: false,
    noiseModel: 'df3',
    // Separation backend: 'demucs' (default, best quality) or 'convtasnet' (faster).
    // Demucs htdemucs_ft: ~5–10x real-time GPU, ~0.5–1x real-time CPU, ~2–4 GB VRAM.
    // ConvTasNet WHAM!:   ~20–30x real-time GPU, ~5–10x real-time CPU, ~500 MB VRAM.
    separationModel: 'demucs',
    dereverb: {
      enabled: true,
      strength: 'heavy',
      preserve_early: false,
    },
    autoLeveler: {
      maxGainDb:     4.0,
      maxRateDbPerS: 1.0,
    },
    saturation: {
      drive: 5,
      wetDry: 0.20,
      bias: 0.10,
      fc: 3000,
    },
    compression: [

      // Pass 1: Transient Catcher (Peak Control)
      // Hits only the loudest errant peaks (plosives, exclamations) very quickly
      {
        targetCrestFactorDb: 15,
        maxRatio: 4,
        threshold: 'auto',
        follow: false,
        attack: 0.1,  // Extremely fast to catch peaks
        release: 40,  // Fast release to get out of the way quickly
      },
      //Tonal Pass for character
      {
      targetCrestFactorDb: 12,
      maxRatio: 4,
      threshold: 'auto',
      follow: false,
      attack: 10,
      release: 80,
    },
      // Pass 2: Gentle Leveler (Body Control)
      // Smooths out the overall performance, bringing up presence without pumping
      {
        targetCrestFactorDb: 12,
        maxRatio: 2.5, // Gentle ratio for transparency
        threshold: 'auto',
        follow: false,
        attack: 15,    // Slow enough to let crisp consonants through (presence)
        release: 120,  // Slow release for smooth, unnoticeable recovery
      }
    ],
    parallelCompression: {
      ratio:                       25,
      attackMs:                    0.1,   
      releaseMs:                   50,
      makeupGain:                  'auto', // automatically match average gain reduction
      wetMix:                      0.40,
      vadFadeMs:                   5,
      crestGuardThresholdDb:       12,
      parallelDesserMaxReductionDb: 6,
    },
    // Stage 4a-E: Vocal Expander — frequency-selective silence-floor attenuation.
    // headroomOffsetDb - defines how close to speech threshold; 
    // highFreqDepth - reduces gain reduction for noise outside the top of the frequency band -- 
    // e.g. (0.25) preserves breath/fricative transparency above 800 Hz.
    vocalExpander: {
      enabled:          true,
      ratio:            2.5,
      highFreqDepth:    1.0,
      headroomOffsetDb: 6,
      releaseMs:        50,
      attackMs:         2,
      holdMs:           5,
      lookaheadMs:      20,
      maxAttenuationDb: 40,
      detectionBand:    { lowHz: 80, highHz: 800 },
    },
    // VAD Gate — assertive for noise_eraser. Source separation already produces
    // a "dry booth" silence character; a hard gate completes the removal of
    // residual bleed between words.
    vadGate: {
      enabled:     false,
      lookaheadMs: 20,
      holdMs:      80,
      attackMs:    5,
      releaseMs:   30,
      floorDb:     -70,
    },
    airBoost: { gainDb: 0 },
    bweModel: 'ap_bwe',
    bwe: { enabled: false, postEq: { enabled: true, freq: 9000, q: 2, gainDb: -3 } },
    // MMSE spectral subtraction pre-pass (before RNNoise NE-1). Moderate strength
    // so residual room noise is reduced before RNNoise's stationary NR pass and
    // Demucs separation. Transient shaper enabled to suppress reverb tails.
    spectralSubtraction: {
      enabled:                 true,
      alphaDd:                 0.98,
      beta:                    0.15,
      strength:                0.8,
      transientShaper:         true,
      transientMaxReductionDb: 6,
    },
  },

  clearervoice_eraser: {
    id: 'clearervoice_eraser',
    displayName: 'ClearerVoice Eraser',
    description: 'Neural speech enhancement using ClearerVoice-Studio',
    audience: 'Noisy recordings',
    character: 'AI-enhanced, clean speech, dry quality',
    targetLoudness: { value: -16, unit: 'LUFS' },
    truePeakCeiling: -1,
    noiseFloorTarget: null,
    compression: {
      mode: 'conditional',
      targetCrestFactorDb: 10,
      thresholdPercentile: 0.75,
      attack: 8,
      release: 100,
    },
    parallelCompression: {
      ratio:                       8,
      attackMs:                    1.0,
      releaseMs:                   225,    // longer release for smoothed separation transients
      makeupGain:                  'auto', // automatically match average gain reduction
      wetMix:                      0.30,   // midpoint of 20–25%
      vadFadeMs:                   5,
      crestGuardThresholdDb:       12,
      parallelDesserMaxReductionDb: 8,     // fixed-band only; lower ceiling per spec
    },
    eqProfile: 'podcast',
    deEsser: {
      sensitivity: 'none',
      trigger: 0,
      maxReduction: 0,
      crossoverHz: 4000,
    },
    channelOutput: 'mono',
    defaultOutputProfile: 'podcast',
    lockedOutputProfile: false,
    noiseModel: 'df3',
    // ClearerVoice enhancement model:
    //   'mossformer2_48k' — MossFormer2_SE_48K (default, best quality, 48 kHz full-band)
    //   'frcrn_16k'       — FRCRN_SE_16K (faster, good quality, 16 kHz)
    // Both models are downloaded from HuggingFace on first use.
    clearervoiceModel: 'mossformer2_48k',
    autoLeveler: {
      maxGainDb:     8.0,
      maxRateDbPerS: 1.5,
    },
    saturation: {
      drive: 2.0,
      wetDry: 0.3,
      bias: 0.08,
      fc: 3500,
    },
    // Stage 4a-E: Vocal Expander. ClearerVoice output is already enhanced; the
    // expander calibrates from the measured silence floor regardless of how the
    // signal was produced, so the general-clean assertive defaults apply.
    vocalExpander: {
      enabled:          true,
      ratio:            2.0,
      highFreqDepth:    0.5,
      headroomOffsetDb: 6,
      releaseMs:        150,
      attackMs:         10,
      holdMs:           20,
      lookaheadMs:      10,
      maxAttenuationDb: 18,
      detectionBand:    { lowHz: 80, highHz: 800 },
    },
    // VAD Gate — assertive for clearervoice_eraser. ClearerVoice output already
    // has a dry, processed character; deeper floor reinforces it.
    vadGate: {
      enabled:     false,
      lookaheadMs: 20,
      holdMs:      80,
      attackMs:    5,
      releaseMs:   30,
      floorDb:     -70,
    },
    airBoost: { gainDb: 0 },
    bweModel: 'ap_bwe',
    bwe: { enabled: true, postEq: { enabled: true, freq: 9000, q: 2, gainDb: -4 } },
    // MMSE spectral subtraction pre-pass (before RNNoise NE-1). Moderate strength
    // reduces residual room noise before ClearerVoice SE processes the signal.
    // Transient shaper enabled to suppress inter-phrase reverb tails.
    spectralSubtraction: {
      enabled:                 true,
      alphaDd:                 0.98,
      beta:                    0.15,
      strength:                0.8,
      transientShaper:         true,
      transientMaxReductionDb: 6,
    },
  },

}

/**
 * Expected shape of the processing report returned by the server.
 * @typedef {Object} ProcessingReport
 * @property {{ rms_dbfs: number, lufs_integrated: number|null, true_peak_dbfs: number, noise_floor_dbfs: number }} measurements.before
 * @property {{ rms_dbfs: number, lufs_integrated: number|null, true_peak_dbfs: number, noise_floor_dbfs: number }} measurements.after
 * @property {{ certificate: 'pass'|'fail', checks: object }|undefined} acx_certification - Present only when output_profile = acx
 * @property {{ flags: Array<{ id: string, severity: 'info'|'review', message: string }>, review_recommended: boolean }} quality_advisory
 * @property {string[]} warnings
 */

// --- Helpers ---

export function getDefaultOutputProfile(presetId) {
  return PRESETS[presetId]?.defaultOutputProfile ?? 'podcast'
}

export function isOutputProfileLocked(presetId) {
  return PRESETS[presetId]?.lockedOutputProfile === true
}

export function getPresetList() {
  return Object.values(PRESETS)
}

export function getOutputProfileList() {
  return Object.values(OUTPUT_PROFILES)
}

export function formatLoudness(preset) {
  if (!preset) return ''
  const { value, unit } = preset.targetLoudness
  return `${value} ${unit}`
}
