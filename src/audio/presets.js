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
    id: "acx",
    displayName: "ACX Audiobook",
    loudnessRange: [-23, -18],
    normalizationTarget: -20, // dBFS RMS — ACX spec target, not the range midpoint (-20.5)
    truePeakCeiling: -3,
    noiseFloorCeiling: -60,
    measurementMethod: "RMS",
  },
  podcast: {
    id: "podcast",
    displayName: "Podcast / Streaming",
    loudnessRange: [-18, -14],
    normalizationTarget: -16, // LUFS integrated — midpoint of loudnessRange
    truePeakCeiling: -1,
    noiseFloorCeiling: null,
    measurementMethod: "LUFS",
  },
  broadcast: {
    id: "broadcast",
    displayName: "Broadcast",
    loudnessRange: [-24, -22],
    normalizationTarget: -23, // LUFS integrated — midpoint of loudnessRange
    truePeakCeiling: -1,
    noiseFloorCeiling: null,
    measurementMethod: "LUFS",
  },
}

// Backward compatibility: accept 'standard' as alias for 'podcast'
export function resolveOutputProfileId(id) {
  if (id === "standard") return "podcast"
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
 * @property {{ sensitivity: 'standard'|'high'|'none', trigger: number, maxReduction: number, ratio: number }} deEsser
 * @property {'mono'|'preserve'} channelOutput
 * @property {string} defaultOutputProfile
 * @property {boolean} lockedOutputProfile
 * @property {{ enabled: boolean, strength: 'light'|'medium'|'heavy', preserve_early: boolean }} dereverb
 * @property {{ total_max_up_db: number, total_max_down_db: number, target_mode: 'running_median'|'global', target_window_s: number, noise_floor_target_dbfs: number, deadband_db: number, knee_db: number, max_up_db: number, max_down_db: number, subphrase_split_drop_db: number, subphrase_split_min_duration_ms: number, crossfade_ms: number, merge_max_delta_db: number } | null} autoLeveler
 * @property {'demucs'|'convtasnet'} [separationModel]   - Noise Eraser only
 * @property {'mossformer2_48k'|'frcrn_16k'} [clearervoiceModel]   - ClearerVoice Eraser only
 * @property {{ enabled: boolean, postEq?: { enabled: boolean, freq?: number, q?: number, gainDb: number } }} bwe - Bandwidth extension (AP-BWE); enabled for NE presets, disabled for standard presets. postEq applies a narrow bell cut after BWE to tame sibilance introduced by HF synthesis.
 */

/** @type {Record<string, Preset>} */
export const PRESETS = {
  acx_audiobook: {
    id: "acx_audiobook",
    displayName: "ACX Audiobook",
    description: "Conservative, transparent processing for audiobook narration",
    audience: "Audiobook narrators",
    character: "Clean, present, natural",
    targetLoudness: { value: -20, unit: "dBFS RMS" },
    truePeakCeiling: -3,
    noiseFloorTarget: -60,
    noiseModel: "df3", //"df3", "rnnoise", "dtln"
    eqProfile: "audiobook",
    bweModel: "ap-bwe", //"lavasr", "ap-bwe"
    bwe: {
      enabled: false,
      postEq: { enabled: false, freq: 9000, q: 2, gainDb: -3 },
    },
    channelOutput: "mono",
    defaultOutputProfile: "acx",
    lockedOutputProfile: true,
    dereverb: {
      enabled: true,
      strength: "medium",
      preserve_early: false,
    },
    autoLeveler: {
      total_max_up_db: 10.0,
      total_max_down_db: 10.0,
      target_mode: 'global', // "running_median", "global"
      target_window_s: 60,
      noise_floor_target_dbfs: -60,
      deadband_db: 2.0,
      knee_db: 1.5,
      max_up_db: 10.0,
      max_down_db: 10.0,
      subphrase_split_drop_db: 6.0,
      subphrase_split_min_duration_ms: 500,
      crossfade_ms: 30,
      merge_max_delta_db: 6.0,
    },
    saturation: {
      drive: 1.8,
      wetDry: 0.03,
      bias: 0.08,
      lowCrossover: 500,
      midCrossover: 3000,
      softness: 0.8,
    },
    compression: [
      // Pass 1: Transient Catcher (Peak Control)
      // Hits only the loudest errant peaks (plosives, exclamations) very quickly
      {
        targetCrestFactorDb: 15,
        maxRatio: 6,
        threshold: "auto",
        follow: false,
        attack: 0.1, // Extremely fast to catch peaks
        release: 30, // Fast release to get out of the way quickly
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
        threshold: "auto",
        follow: false,
        attack: 15, // Slow enough to let crisp consonants through (presence)
        release: 120, // Slow release for smooth, unnoticeable recovery
      },
    ],
    parallelCompression: {
      ratio: 20,
      attackMs: 15,
      releaseMs: 150,
      makeupGain: "auto", // automatically match average gain reduction
      wetMix: 0.15,
      vadFadeMs: 5,
      crestGuardThresholdDb: 12,
      parallelDesserMaxReductionDb: 15,
    },
    // Expander — reduce the level of the noise floor
    // headroomOffsetDb - defines how close to speech threshold;
    // highFreqDepth - reduces gain reduction for noise outside the top of the frequency band --
    // e.g. (0.25) preserves breath/fricative transparency above 800 Hz.
    vocalExpander: {
      enabled: false,
      ratio: 2.5,
      highFreqDepth: 1,
      headroomOffsetDb: 6,
      releaseMs: 150,
      attackMs: 50,
      holdMs: 5,
      lookaheadMs: 455,
      maxAttenuationDb: 24,
      detectionBand: { lowHz: 80, highHz: 800 },
    },
    // VAD Gate — conservative for ACX. Shallower floor preserves audible room
    // tone; generous hold prevents chopping the long decay of narrated word endings.
    vadGate: {
      enabled: true,
      energyOverrideDb: 12,
      lookaheadMs: 60, //Higher = fewer clipped onsets, more latency
      holdMs: 200, //Higher = fewer clipped endings, less breath reduction
      attackMs: 5, //Slower attack softens plosive transients
      releaseMs: 80, //Slower release = more natural fade-out
      floorDb: -110, //-∞ = fully silent gaps (unnatural), -40 = subtle presence
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
      enabled: true,
      alphaDd: 0.98,
      beta: 0.15,
      strength: 0.7,
      transientShaper: true,
    },
    // sibilantGainFloor: how much of the boost survives on sibilant frames.
    // 0.0 = no boost on sibilants; 1.0 = full boost everywhere (no masking).
    //
    // sibilanceDetection: applies aggressive (broader) params to prevent
    // a broad range of fricatives from being boosted 
    airBoost: {
      gainDb: 8,
      sibilantGainFloor: 0,
      sibilanceDetection: {
        p95_trigger_db:      6.0,
        min_flatness:        0.1,
        broadband_trigger_db: 10.0,
      },
    },
    // Resonance Suppressor.
    // Selectivity is calibrated for the cepstral inter-harmonic floor reference,
    // which sits ~8–15 dB below spectral peaks — so 8 dB here is equivalent to a
    // very tight threshold on the old mel-smoothed reference.

    // Multi-pass mode — two fully independent serial passes.  Each pass runs
    // its own complete STFT → gain-reduction → ISTFT cycle; pass 2 receives
    // the output audio of pass 1 as its input.  IIR state is isolated: there
    // is no cross-pass bleed of any kind.

    resonanceSuppressor: [
      {
        // Pass 1 — narrow resonances (room modes, mic peaks)
        // L=93 (f0-derived): reference follows formants closely so only
        // true narrow spikes (8+ dB above inter-harmonic floor) are caught.
        depth: 0.67,
        sharpness: 0.6,
        selectivity: 8,
        attack_ms: 25.0,
        release_ms: 100.0,
        max_reduction_db: 12.0,
        freq_floor_hz: 80.0,
        freq_ceil_hz: 20000.0,
        mode: "soft",
      },
      {
        // Pass 2 — broad sibilant plateau (4–12 kHz), gated to sibilant frames.
        // lifter_cutoff_bins=3: nearly-flat reference resolves only features
        // wider than n_fft/(2*3) ≈ 7.3 kHz, making a 4–8 kHz sibilant
        // plateau protrude clearly above it.
        //
        // sibilanceDetection: this stage's own detector params. Uses stricter params to only
        // suppress the harshest sibilants
        sibilant_only: true,
        preserve_harmonics: true,
        depth: 0.67,
        sharpness: 0.4,
        selectivity: 1,
        attack_ms: 5.0,
        release_ms: 5.0,
        max_reduction_db: 25.0,
        freq_floor_hz: 3000.0,
        freq_ceil_hz: 12000.0,
        mode: "soft",
        lifter_cutoff_bins: 3,
        band_summary_max_cluster_bins: 186, // reporting only ≈ 4 kHz — prevents micro-cluster
                                            // fragmentation from wide spread kernel
        sibilanceDetection: {
          p95_trigger_db:      9.0,
          min_flatness:        0.2,
          broadband_trigger_db: 13.0,
        },
      },
    ],
    //Gentle pre-compresion settings - designed for single voice use
    deEsser: {
      sensitivity: "medium",
      trigger: 1,
      maxReduction: 12,
      ratio: 3,
    },
    // Clip-gain de-esser — ACX Audiobook tuning. Transparent: low ceiling
    // but a hard 6 dB reduction cap so even spikes never get hammered enough
    // to call attention to the de-esser. 25 ms duration filter excludes
    // consonant stops and click residuals.
    clipGainDeEsser: {
      enabled: true,
      naturalCeilingDb: 6.5,
      reductionRatio:   0.55,
      maxReductionDb:   6.0,
      minDurationMs:    25,
      contextWindowMs:  80,
      fades: {
        fricativeInMs:  3.0,
        fricativeOutMs: 4.0,
        affricateInMs:  1.5,
        affricateOutMs: 4.5,
      },
    },
    roomPresence: {
      enabled: true,
      //ir_path: "../ir/HHB1.wav",   
      ir_path: "../ir/19_CrystalVocal.wav",  
      wet: 0.20,                            
      rt60Ms: 100,                          //hard trim ceiling on IR tail
      preDelayMs: 10.0,                     //zero-pad before IR onset
      early_reflections: 2,                 //onset ramp (1=sharp, 5=gradual)
      normalize_ir: true,                   //normalize IR peak to 0dBFS before use
    },
    stages: [
      'decode', 'monoMixdown', 'measureBefore', 'peakNormalize', 'analyzeFramesRaw',
      { clickRemover: { thresholdSigma: 3.0, maxClickMs: 15 } },
      'humDetect', 'hpf',
      'noiseReduce', 'remeasureFramesPostNr',
      { autoLeveler: {
        total_max_up_db: 10.0, total_max_down_db: 10.0,
        target_mode: 'global', target_window_s: 60,
        noise_floor_target_dbfs: -60, deadband_db: 2.0, knee_db: 1.5,
        max_up_db: 10.0, max_down_db: 10.0,
        subphrase_split_drop_db: 6.0, subphrase_split_min_duration_ms: 500,
        crossfade_ms: 30, merge_max_delta_db: 6.0,
      } },
      { spectralSubtraction: { enabled: true, alphaDd: 0.98, beta: 0.15, strength: 0.7, transientShaper: true } },
      'bandwidthExtension', 'vocalSaturation',
      { vadGate: { enabled: true, energyOverrideDb: 12, lookaheadMs: 60, holdMs: 200, attackMs: 5, releaseMs: 80, floorDb: -110 } },
      { clipGainDeEsser: { enabled: true, naturalCeilingDb: 6.5, reductionRatio: 0.55, maxReductionDb: 6.0, minDurationMs: 25, contextWindowMs: 80, fades: { fricativeInMs: 3.0, fricativeOutMs: 4.0, affricateInMs: 1.5, affricateOutMs: 4.5 } } },
      'remeasureFramesPostNr',
      { compression: [
        { targetCrestFactorDb: 15, maxRatio: 6, threshold: 'auto', follow: false, attack: 0.1, release: 30 },
        { targetCrestFactorDb: 15, maxRatio: 3, threshold: 'auto', follow: false, attack: 15, release: 120 },
      ] },
      'remeasureFramesPostNr',
      'noiseReduce',
      { parallelCompression: { ratio: 20, attackMs: 15, releaseMs: 150, makeupGain: 'auto', wetMix: 0.15, vadFadeMs: 5, crestGuardThresholdDb: 12, parallelDesserMaxReductionDb: 15 } },
      { vocalExpander: { enabled: false, ratio: 2.5, highFreqDepth: 1, headroomOffsetDb: 6, releaseMs: 150, attackMs: 50, holdMs: 5, lookaheadMs: 455, maxAttenuationDb: 24, detectionBand: { lowHz: 80, highHz: 800 } } },
      { airBoost: { gainDb: 8, sibilantGainFloor: 0, sibilanceDetection: { p95_trigger_db: 6.0, min_flatness: 0.1, broadband_trigger_db: 10.0 } } },
      { resonanceSuppressor: [
        { depth: 0.67, sharpness: 0.6, selectivity: 8, attack_ms: 25.0, release_ms: 100.0, max_reduction_db: 12.0, freq_floor_hz: 80.0, freq_ceil_hz: 20000.0, mode: 'soft' },
        { sibilant_only: true, preserve_harmonics: true, depth: 0.67, sharpness: 0.4, selectivity: 1, attack_ms: 5.0, release_ms: 5.0, max_reduction_db: 25.0, freq_floor_hz: 3000.0, freq_ceil_hz: 12000.0, mode: 'soft', lifter_cutoff_bins: 3, band_summary_max_cluster_bins: 186, sibilanceDetection: { p95_trigger_db: 9.0, min_flatness: 0.2, broadband_trigger_db: 13.0 } },
      ] },
      'correctiveEQ',
      { roomPresence: { enabled: true, ir_path: '../ir/19_CrystalVocal.wav', wet: 0.20, rt60Ms: 100, preDelayMs: 10.0, early_reflections: 2, normalize_ir: true } },
      'normalize', 'truePeakLimit', 'measureAfter',
      'acxCertification', 'qualityAdvisory', 'encode', 'extractPeaks',
    ],
  },

  podcast_ready: {
    id: "podcast_ready",
    displayName: "Podcast Ready",
    description: "Punchy, consistent sound for podcast distribution",
    audience: "Podcast hosts",
    character: "Punchy, intimate, consistent",
    targetLoudness: { value: -16, unit: "LUFS" },
    truePeakCeiling: -1,
    noiseFloorTarget: null,
    noiseModel: "df3",
    compression: [
      // Pass 1: Transient Catcher (Peak Control)
      {
        targetCrestFactorDb: 14,
        maxRatio: 5,
        threshold: "auto",
        follow: false,
        attack: 0.1,
        release: 40,
      },
      // Pass 2: Aggressive Leveler (The "Radio" Sound)
      {
        targetCrestFactorDb: 10,
        maxRatio: 4,
        threshold: "auto",
        follow: false,
        attack: 5, // Faster than ACX to thicken the voice, but still lets some punch through
        release: 80, // Faster release for a denser, higher-energy consistent sound
      },
    ],
    eqProfile: "podcast",
    deEsser: {
      sensitivity: "medium",
      trigger: 6,
      maxReduction: 4,
      ratio: 6.7,
    },
    // Clip-gain de-esser — Podcast Ready tuning. Higher ceiling (more
    // permissive of bright sibilants because podcast voices sit further
    // forward) but a slightly larger cap so loud /s/ on a peaky mic still
    // gets pulled in.
    clipGainDeEsser: {
      enabled: true,
      naturalCeilingDb: 8.0,
      reductionRatio:   0.55,
      maxReductionDb:   8.0,
      minDurationMs:    25,
      contextWindowMs:  80,
      fades: {
        fricativeInMs:  3.0,
        fricativeOutMs: 4.0,
        affricateInMs:  1.5,
        affricateOutMs: 4.5,
      },
    },
    channelOutput: "preserve",
    defaultOutputProfile: "podcast",
    lockedOutputProfile: false,
    dereverb: {
      enabled: false,
      strength: "light",
      preserve_early: true,
    },
    autoLeveler: {
      total_max_up_db: 6.0,
      total_max_down_db: 8.0,
      target_mode: 'running_median',
      target_window_s: 45,
      noise_floor_target_dbfs: -50,
      deadband_db: 1.5,
      knee_db: 1.0,
      max_up_db: 5.0,
      max_down_db: 6.0,
      subphrase_split_drop_db: 6.0,
      subphrase_split_min_duration_ms: 500,
      crossfade_ms: 30,
      merge_max_delta_db: 6.0,
    },
    saturation: {
      drive: 2.0,
      wetDry: 0.3,
      bias: 0.1,
      lowCrossover: 600,
      midCrossover: 4000,
      softness: 0.2,
    },
    parallelCompression: {
      ratio: 10,
      attackMs: 0.4, // midpoint of 0.3–0.5 ms spec range
      releaseMs: 120,
      makeupGain: "auto", // automatically match average gain reduction
      wetMix: 0.4, // midpoint of 25–35%
      vadFadeMs: 10,
      crestGuardThresholdDb: 12,
      parallelDesserMaxReductionDb: 10,
    },
    // Stage 4a-E: Vocal Expander. Assertive settings for processed podcast
    // character: 2.0:1 ratio with wider +6 dB headroom is acceptable because
    // listeners expect a tighter, more processed sound.
    vocalExpander: {
      enabled: true,
      ratio: 2.0,
      highFreqDepth: 0.5,
      headroomOffsetDb: 6,
      releaseMs: 150,
      attackMs: 10,
      holdMs: 20,
      lookaheadMs: 10,
      maxAttenuationDb: 18,
      detectionBand: { lowHz: 80, highHz: 800 },
    },
    // VAD Gate — assertive for podcast. Deeper floor matches the tighter,
    // more processed character; faster release keeps the gate from feeling
    // sluggish on rapid-fire dialogue.
    vadGate: {
      enabled: false,
      lookaheadMs: 20,
      holdMs: 80,
      attackMs: 8,
      releaseMs: 40,
      floorDb: -60,
    },
    // Podcast: retain a small fraction of the boost on sibilant frames (0.25)
    // so the air character isn't entirely absent on consonants — the processed,
    // punchy podcast sound benefits from some HF presence even on sibilants.
    //
    // sibilanceDetection: defaults are fine for podcast — no override needed.
    // The punchier character tolerates more aggressive masking than ACX.
    airBoost: { gainDb: 2.5, sibilantGainFloor: 0.25 },
    bweModel: "ap_bwe",
    bwe: {
      enabled: true,
      postEq: { enabled: true, freq: 9000, q: 2, gainDb: -3 },
    },
    // Light reduction — podcast listeners expect some breath presence; going
    // deeper makes the performance feel over-edited.
    breathReducer: { max_reduction_db: 6 },
    clickRemover: { thresholdSigma: 3.5, maxClickMs: 15 },
    // MMSE spectral subtraction pre-pass (before DF3). Full strength with transient
    // shaper enabled — podcast listeners expect a processed, tight sound and benefit
    // from inter-phrase reverb tail suppression.
    spectralSubtraction: {
      enabled: true,
      alphaDd: 0.98,
      beta: 0.15,
      strength: 1.0,
      transientShaper: true,
      transientMaxReductionDb: 6,
    },
    // Stage 3b — Resonance Suppressor. Faster attack and more assertive
    // selectivity match the punchier, more processed podcast character.
    // selectivity: 6 dB above the cepstral inter-harmonic floor — lower than
    // ACX (8 dB) to catch more room resonances for the processed podcast sound,
    // but still well above the ±3–5 dB normal spectral variation threshold.
    // No sibilant_only pass configured here, so no sibilanceDetection block
    // is needed.
    resonanceSuppressor: {
      depth: 0.65,
      selectivity: 6,
      attack_ms: 8.0,
      release_ms: 60.0,
    },
    // Stage 4c — Room Presence. Default settings for podcast: standard wet mix
    // and RT60 give an intimate small-room quality that suits conversational audio.
    roomPresence: {
      enabled: true,
      wet: 0.08,
      rt60Ms: 80,
      preDelayMs: 1.5,
      diffusion: 0.7,
    },
    stages: [
      'decode', 'monoMixdown', 'measureBefore', 'peakNormalize', 'analyzeFramesRaw',
      { clickRemover: { thresholdSigma: 3.5, maxClickMs: 15 } },
      'humDetect', 'hpf',
      'noiseReduce', 'remeasureFramesPostNr',
      { autoLeveler: {
        total_max_up_db: 6.0, total_max_down_db: 8.0,
        target_mode: 'running_median', target_window_s: 45,
        noise_floor_target_dbfs: -50, deadband_db: 1.5, knee_db: 1.0,
        max_up_db: 5.0, max_down_db: 6.0,
        subphrase_split_drop_db: 6.0, subphrase_split_min_duration_ms: 500,
        crossfade_ms: 30, merge_max_delta_db: 6.0,
      } },
      { spectralSubtraction: { enabled: true, alphaDd: 0.98, beta: 0.15, strength: 1.0, transientShaper: true, transientMaxReductionDb: 6 } },
      'bandwidthExtension', 'vocalSaturation',
      { vadGate: { enabled: false, lookaheadMs: 20, holdMs: 80, attackMs: 8, releaseMs: 40, floorDb: -60 } },
      { clipGainDeEsser: { enabled: true, naturalCeilingDb: 8.0, reductionRatio: 0.55, maxReductionDb: 8.0, minDurationMs: 25, contextWindowMs: 80, fades: { fricativeInMs: 3.0, fricativeOutMs: 4.0, affricateInMs: 1.5, affricateOutMs: 4.5 } } },
      'remeasureFramesPostNr',
      { compression: [
        { targetCrestFactorDb: 14, maxRatio: 5, threshold: 'auto', follow: false, attack: 0.1, release: 40 },
        { targetCrestFactorDb: 10, maxRatio: 4, threshold: 'auto', follow: false, attack: 5, release: 80 },
      ] },
      'remeasureFramesPostNr',
      'noiseReduce',
      { parallelCompression: { ratio: 10, attackMs: 0.4, releaseMs: 120, makeupGain: 'auto', wetMix: 0.4, vadFadeMs: 10, crestGuardThresholdDb: 12, parallelDesserMaxReductionDb: 10 } },
      { vocalExpander: { enabled: true, ratio: 2.0, highFreqDepth: 0.5, headroomOffsetDb: 6, releaseMs: 150, attackMs: 10, holdMs: 20, lookaheadMs: 10, maxAttenuationDb: 18, detectionBand: { lowHz: 80, highHz: 800 } } },
      { airBoost: { gainDb: 2.5, sibilantGainFloor: 0.25 } },
      { resonanceSuppressor: { depth: 0.65, selectivity: 6, attack_ms: 8.0, release_ms: 60.0 } },
      'correctiveEQ',
      { roomPresence: { enabled: true, wet: 0.08, rt60Ms: 80, preDelayMs: 1.5, diffusion: 0.7 } },
      'normalize', 'truePeakLimit', 'measureAfter',
      'acxCertification', 'qualityAdvisory', 'encode', 'extractPeaks',
    ],
  },

  voice_ready: {
    id: "voice_ready",
    displayName: "Voice Ready",
    description: "Broadcast-quality processing for voice-over work",
    audience: "Voice actors",
    character: "Clean, broadcast-quality, neutral",
    targetLoudness: { value: -20, unit: "dBFS RMS" },
    truePeakCeiling: -3,
    noiseFloorTarget: null,
    noiseModel: "df3",
    compression: {
      mode: "conditional",
      targetCrestFactorDb: 12,
      thresholdPercentile: 0.75,
      attack: 8,
      release: 90,
    },
    eqProfile: "general",
    deEsser: {
      sensitivity: "standard",
      trigger: 8,
      maxReduction: 5,
      ratio: 6.7,
    },
    // Clip-gain de-esser — Voice Ready tuning. Broadcast-neutral character:
    // moderate ceiling and cap, identical fade shape to ACX. Voice Ready
    // outputs typically sit under music beds, so leaving sibilance present
    // and natural rather than dulling it is worth a slightly higher ceiling
    // than ACX.
    clipGainDeEsser: {
      enabled: true,
      naturalCeilingDb: 7.0,
      reductionRatio:   0.55,
      maxReductionDb:   7.0,
      minDurationMs:    25,
      contextWindowMs:  80,
      fades: {
        fricativeInMs:  3.0,
        fricativeOutMs: 4.0,
        affricateInMs:  1.5,
        affricateOutMs: 4.5,
      },
    },
    channelOutput: "mono",
    defaultOutputProfile: "acx",
    lockedOutputProfile: false,
    dereverb: {
      enabled: true,
      strength: "heavy", // VACE-WPE (heavy) //Set to 'medium' here to use NARA-WPE
      preserve_early: false,
    },
    autoLeveler: {
      total_max_up_db: 5.0,
      total_max_down_db: 6.0,
      target_mode: 'running_median',
      target_window_s: 60,
      noise_floor_target_dbfs: -55,
      deadband_db: 2.0,
      knee_db: 1.5,
      max_up_db: 4.0,
      max_down_db: 5.0,
      subphrase_split_drop_db: 6.0,
      subphrase_split_min_duration_ms: 500,
      crossfade_ms: 30,
      merge_max_delta_db: 6.0,
    },
    saturation: {
      drive: 2.0,
      wetDry: 0.3,
      bias: 0.08,
      lowCrossover: 500,
      midCrossover: 3500,
      softness: 0.35,
    },
    parallelCompression: {
      ratio: 8,
      attackMs: 0.5,
      releaseMs: 150,
      makeupGain: "auto", // automatically match average gain reduction
      wetMix: 0.225, // midpoint of 20–25%
      vadFadeMs: 5,
      crestGuardThresholdDb: 12,
      parallelDesserMaxReductionDb: 10,
    },
    // Stage 4a-E: Vocal Expander. Conservative settings matching ACX: voice-over
    // work often sits under music beds, so pumping and gating artifacts are
    // audible — the slower 200 ms release and low highFreqDepth keep the stage
    // transparent.
    vocalExpander: {
      enabled: true,
      ratio: 1.5,
      highFreqDepth: 0.25,
      headroomOffsetDb: 4,
      releaseMs: 200,
      attackMs: 10,
      holdMs: 20,
      lookaheadMs: 10,
      maxAttenuationDb: 12,
      detectionBand: { lowHz: 80, highHz: 800 },
    },
    // VAD Gate — broadcast-neutral. Shallower floor than podcast since
    // voice-over often sits under music; a hard cut would be audible against
    // the bed.
    vadGate: {
      enabled: false,
      lookaheadMs: 25,
      holdMs: 100,
      attackMs: 10,
      releaseMs: 60,
      floorDb: -55,
    },
    // Voice Ready: 0.0 — voice-over sits under music beds where sibilant
    // amplification is audible; fully suppress the boost on sibilant frames.
    //
    // sibilanceDetection: broadcast-neutral. Stricter than defaults so we
    // only mask the boost on clearly-sibilant frames; the lower max_reduction
    // / softer character of this preset doesn't need an aggressive sibilance
    // catcher.
    airBoost: {
      gainDb: 2.0,
      sibilantGainFloor: 0.0,
      sibilanceDetection: {
        p95_trigger_db:       8.0,
        broadband_trigger_db: 11.0,
      },
    },
    bweModel: "ap_bwe",
    bwe: {
      enabled: true,
      postEq: { enabled: true, freq: 9000, q: 2, gainDb: -3 },
    },
    // Moderate — voice-over often sits under music beds where breaths are
    // audible; deeper reduction than podcast, lighter than ACX.
    breathReducer: { max_reduction_db: 10 },
    // Same rationale as ACX — voice actors also benefit from clean transients
    clickRemover: { thresholdSigma: 3.0, maxClickMs: 15 },
    // MMSE spectral subtraction pre-pass (before DF3). Moderate strength; transient
    // shaper disabled because voice-over often sits under music beds where any gating
    // artifact becomes audible against the bed.
    spectralSubtraction: {
      enabled: true,
      alphaDd: 0.98,
      beta: 0.15,
      strength: 0.8,
      transientShaper: false,
    },
    // Stage 3b — Resonance Suppressor. Broadcast-neutral tuning: moderate depth
    // with a lower ceiling than podcast (voice-over sits under music beds where
    // deep cuts become audible) and a slower attack than podcast.
    // No sibilant_only pass configured here, so no sibilanceDetection block
    // is needed.
    resonanceSuppressor: {
      depth: 0.55,
      attack_ms: 12.0,
      release_ms: 70.0,
      max_reduction_db: 7.0,
    },
    // Stage 4c — Room Presence. Slightly tighter than podcast defaults — voice
    // actors need placement without obvious room character that would be
    // audible under music beds.
    roomPresence: {
      enabled: true,
      wet: 0.06,
      rt60Ms: 70,
      preDelayMs: 1.5,
      diffusion: 0.65,
    },
    stages: [
      'decode', 'monoMixdown', 'measureBefore', 'peakNormalize', 'analyzeFramesRaw',
      { clickRemover: { thresholdSigma: 3.0, maxClickMs: 15 } },
      'humDetect', 'hpf',
      'noiseReduce', 'remeasureFramesPostNr',
      { autoLeveler: {
        total_max_up_db: 5.0, total_max_down_db: 6.0,
        target_mode: 'running_median', target_window_s: 60,
        noise_floor_target_dbfs: -55, deadband_db: 2.0, knee_db: 1.5,
        max_up_db: 4.0, max_down_db: 5.0,
        subphrase_split_drop_db: 6.0, subphrase_split_min_duration_ms: 500,
        crossfade_ms: 30, merge_max_delta_db: 6.0,
      } },
      { spectralSubtraction: { enabled: true, alphaDd: 0.98, beta: 0.15, strength: 0.8, transientShaper: false } },
      'bandwidthExtension', 'vocalSaturation',
      { vadGate: { enabled: false, lookaheadMs: 25, holdMs: 100, attackMs: 10, releaseMs: 60, floorDb: -55 } },
      { clipGainDeEsser: { enabled: true, naturalCeilingDb: 7.0, reductionRatio: 0.55, maxReductionDb: 7.0, minDurationMs: 25, contextWindowMs: 80, fades: { fricativeInMs: 3.0, fricativeOutMs: 4.0, affricateInMs: 1.5, affricateOutMs: 4.5 } } },
      'remeasureFramesPostNr',
      { compression: { mode: 'conditional', targetCrestFactorDb: 12, thresholdPercentile: 0.75, attack: 8, release: 90 } },
      'remeasureFramesPostNr',
      'noiseReduce',
      { parallelCompression: { ratio: 8, attackMs: 0.5, releaseMs: 150, makeupGain: 'auto', wetMix: 0.225, vadFadeMs: 5, crestGuardThresholdDb: 12, parallelDesserMaxReductionDb: 10 } },
      { vocalExpander: { enabled: true, ratio: 1.5, highFreqDepth: 0.25, headroomOffsetDb: 4, releaseMs: 200, attackMs: 10, holdMs: 20, lookaheadMs: 10, maxAttenuationDb: 12, detectionBand: { lowHz: 80, highHz: 800 } } },
      { airBoost: { gainDb: 2.0, sibilantGainFloor: 0.0, sibilanceDetection: { p95_trigger_db: 8.0, broadband_trigger_db: 11.0 } } },
      { resonanceSuppressor: { depth: 0.55, attack_ms: 12.0, release_ms: 70.0, max_reduction_db: 7.0 } },
      'correctiveEQ',
      { roomPresence: { enabled: true, wet: 0.06, rt60Ms: 70, preDelayMs: 1.5, diffusion: 0.65 } },
      'normalize', 'truePeakLimit', 'measureAfter',
      'acxCertification', 'qualityAdvisory', 'encode', 'extractPeaks',
    ],
  },

  general_clean: {
    id: "general_clean",
    displayName: "General Clean",
    description: "Balanced cleanup for any audio recording",
    audience: "Everyone",
    character: "Pragmatic, balanced",
    targetLoudness: { value: -16, unit: "LUFS" },
    truePeakCeiling: -1,
    noiseFloorTarget: null,
    noiseModel: "df3",
    compression: {
      mode: "conditional",
      targetCrestFactorDb: 10,
      thresholdPercentile: 0.7,
      attack: 8,
      release: 80,
    },
    eqProfile: "general",
    deEsser: {
      sensitivity: "high",
      trigger: 6,
      maxReduction: 8,
      ratio: 6.7,
    },
    // Clip-gain de-esser — General Clean tuning. Slightly more aggressive
    // ratio (0.60) since this preset accepts heavier processing in exchange
    // for handling unknown source material safely.
    clipGainDeEsser: {
      enabled: true,
      naturalCeilingDb: 7.0,
      reductionRatio:   0.60,
      maxReductionDb:   8.0,
      minDurationMs:    25,
      contextWindowMs:  80,
      fades: {
        fricativeInMs:  3.0,
        fricativeOutMs: 4.0,
        affricateInMs:  1.5,
        affricateOutMs: 4.5,
      },
    },
    channelOutput: "preserve",
    defaultOutputProfile: "podcast",
    lockedOutputProfile: false,
    dereverb: {
      enabled: true,
      strength: "heavy",
      preserve_early: false,
    },
    autoLeveler: {
      total_max_up_db: 8.0,
      total_max_down_db: 10.0,
      target_mode: 'running_median',
      target_window_s: 30,
      noise_floor_target_dbfs: -50,
      deadband_db: 1.5,
      knee_db: 1.0,
      max_up_db: 6.0,
      max_down_db: 8.0,
      subphrase_split_drop_db: 6.0,
      subphrase_split_min_duration_ms: 500,
      crossfade_ms: 30,
      merge_max_delta_db: 6.0,
    },
    saturation: {
      drive: 2.0,
      wetDry: 0.3,
      bias: 0.1,
      lowCrossover: 550,
      midCrossover: 3500,
      softness: 0.25,
    },
    parallelCompression: {
      ratio: 10,
      attackMs: 0.3,
      releaseMs: 120,
      makeupGain: "auto", // automatically match average gain reduction
      wetMix: 0.35, // midpoint of 30–40%
      vadFadeMs: 8,
      crestGuardThresholdDb: 9, // relaxed per spec
      parallelDesserMaxReductionDb: 12,
    },
    // Stage 4a-E: Vocal Expander. Pragmatic assertive settings — this preset
    // accepts more aggressive processing in exchange for a cleaner silence floor.
    vocalExpander: {
      enabled: true,
      ratio: 2.0,
      highFreqDepth: 0.5,
      headroomOffsetDb: 6,
      releaseMs: 150,
      attackMs: 10,
      holdMs: 20,
      lookaheadMs: 10,
      maxAttenuationDb: 18,
      detectionBand: { lowHz: 80, highHz: 800 },
    },
    // VAD Gate — assertive for general_clean. Unknown source material; a
    // cleaner silence floor is generally preferable.
    vadGate: {
      enabled: false,
      lookaheadMs: 20,
      holdMs: 80,
      attackMs: 8,
      releaseMs: 40,
      floorDb: -60,
    },
    // General Clean: 16 dB is significant — sibilant masking is critical here.
    // 0.0 fully suppresses the boost on sibilant frames.
    //
    // sibilanceDetection: lower broadband_trigger_db catches more events on
    // unknown source material — the larger boost makes any missed sibilants
    // more obviously bright.
    airBoost: {
      gainDb: 16,
      sibilantGainFloor: 0.0,
      sibilanceDetection: {
        broadband_trigger_db: 9.0,
      },
    },
    bweModel: "ap_bwe",
    bwe: {
      enabled: true,
      postEq: { enabled: true, freq: 9000, q: 2, gainDb: -3 },
    },
    // Aggressive — unknown source material; cleaner is generally better here.
    breathReducer: { max_reduction_db: 15 },
    // Conservative — unknown source material
    clickRemover: { thresholdSigma: 3.5, maxClickMs: 10 },
    // MMSE spectral subtraction pre-pass (before DF3). Full strength with transient
    // shaper enabled — unknown source material benefits from maximum diffuse noise and
    // reverb tail reduction before DF3.
    spectralSubtraction: {
      enabled: true,
      alphaDd: 0.98,
      beta: 0.15,
      strength: 1.0,
      transientShaper: true,
      transientMaxReductionDb: 6,
    },
    // Stage 3b — Resonance Suppressor. Assertive tuning for unknown source
    // material: deeper reduction, wider frequency range, and higher ceiling
    // than ACX/voice presets.  selectivity: 6 dB above the cepstral floor —
    // same as podcast, more assertive than ACX, but not so low that it triggers
    // on normal inter-harmonic spectral variation in voiced speech.
    // No sibilant_only pass configured here, so no sibilanceDetection block
    // is needed.
    resonanceSuppressor: {
      depth: 0.7,
      sharpness: 0.4,
      selectivity: 6,
      attack_ms: 8.0,
      release_ms: 50.0,
      max_reduction_db: 12.0,
      freq_floor_hz: 60.0,
      freq_ceil_hz: 18000.0,
    },
    // Stage 4c — Room Presence. Default settings for general_clean: unknown
    // source material benefits from standard acoustic placement.
    roomPresence: {
      enabled: true,
      wet: 0.08,
      rt60Ms: 80,
      preDelayMs: 1.5,
      diffusion: 0.7,
    },
    stages: [
      'decode', 'monoMixdown', 'measureBefore', 'peakNormalize', 'analyzeFramesRaw',
      { clickRemover: { thresholdSigma: 3.5, maxClickMs: 10 } },
      'humDetect', 'hpf',
      'noiseReduce', 'remeasureFramesPostNr',
      { autoLeveler: {
        total_max_up_db: 8.0, total_max_down_db: 10.0,
        target_mode: 'running_median', target_window_s: 30,
        noise_floor_target_dbfs: -50, deadband_db: 1.5, knee_db: 1.0,
        max_up_db: 6.0, max_down_db: 8.0,
        subphrase_split_drop_db: 6.0, subphrase_split_min_duration_ms: 500,
        crossfade_ms: 30, merge_max_delta_db: 6.0,
      } },
      { spectralSubtraction: { enabled: true, alphaDd: 0.98, beta: 0.15, strength: 1.0, transientShaper: true, transientMaxReductionDb: 6 } },
      'bandwidthExtension', 'vocalSaturation',
      { vadGate: { enabled: false, lookaheadMs: 20, holdMs: 80, attackMs: 8, releaseMs: 40, floorDb: -60 } },
      { clipGainDeEsser: { enabled: true, naturalCeilingDb: 7.0, reductionRatio: 0.60, maxReductionDb: 8.0, minDurationMs: 25, contextWindowMs: 80, fades: { fricativeInMs: 3.0, fricativeOutMs: 4.0, affricateInMs: 1.5, affricateOutMs: 4.5 } } },
      'remeasureFramesPostNr',
      { compression: { mode: 'conditional', targetCrestFactorDb: 10, thresholdPercentile: 0.7, attack: 8, release: 80 } },
      'remeasureFramesPostNr',
      'noiseReduce',
      { parallelCompression: { ratio: 10, attackMs: 0.3, releaseMs: 120, makeupGain: 'auto', wetMix: 0.35, vadFadeMs: 8, crestGuardThresholdDb: 9, parallelDesserMaxReductionDb: 12 } },
      { vocalExpander: { enabled: true, ratio: 2.0, highFreqDepth: 0.5, headroomOffsetDb: 6, releaseMs: 150, attackMs: 10, holdMs: 20, lookaheadMs: 10, maxAttenuationDb: 18, detectionBand: { lowHz: 80, highHz: 800 } } },
      { airBoost: { gainDb: 16, sibilantGainFloor: 0.0, sibilanceDetection: { broadband_trigger_db: 9.0 } } },
      { resonanceSuppressor: { depth: 0.7, sharpness: 0.4, selectivity: 6, attack_ms: 8.0, release_ms: 50.0, max_reduction_db: 12.0, freq_floor_hz: 60.0, freq_ceil_hz: 18000.0 } },
      'correctiveEQ',
      { roomPresence: { enabled: true, wet: 0.08, rt60Ms: 80, preDelayMs: 1.5, diffusion: 0.7 } },
      'normalize', 'truePeakLimit', 'measureAfter',
      'acxCertification', 'qualityAdvisory', 'encode', 'extractPeaks',
    ],
  },

  noise_eraser: {
    id: "noise_eraser",
    displayName: "Noise Eraser",
    description: "Voice extraction for severely noisy recordings",
    audience: "Noisy recordings",
    character: "Aggressive separation, dry booth quality",
    targetLoudness: { value: -16, unit: "LUFS" },
    truePeakCeiling: -1,
    noiseFloorTarget: null,
    eqProfile: "audiobook",
    deEsser: {
      sensitivity: "high",
      trigger: 6,
      maxReduction: 8,
    },
    channelOutput: "mono",
    defaultOutputProfile: "podcast",
    lockedOutputProfile: false,
    noiseModel: "df3",
    // Separation backend: 'demucs' (default, best quality) or 'convtasnet' (faster).
    // Demucs htdemucs_ft: ~5–10x real-time GPU, ~0.5–1x real-time CPU, ~2–4 GB VRAM.
    // ConvTasNet WHAM!:   ~20–30x real-time GPU, ~5–10x real-time CPU, ~500 MB VRAM.
    separationModel: "demucs",
    dereverb: {
      enabled: true,
      strength: "heavy",
      preserve_early: false,
    },
    autoLeveler: null,
    saturation: {
      drive: 5,
      wetDry: 0.2,
      bias: 0.1,
      lowCrossover: 400,
      midCrossover: 3000,
      softness: 0.15,
    },
    compression: [
      // Pass 1: Transient Catcher (Peak Control)
      // Hits only the loudest errant peaks (plosives, exclamations) very quickly
      {
        targetCrestFactorDb: 15,
        maxRatio: 4,
        threshold: "auto",
        follow: false,
        attack: 0.1, // Extremely fast to catch peaks
        release: 40, // Fast release to get out of the way quickly
      },
      //Tonal Pass for character
      {
        targetCrestFactorDb: 12,
        maxRatio: 4,
        threshold: "auto",
        follow: false,
        attack: 10,
        release: 80,
      },
      // Pass 2: Gentle Leveler (Body Control)
      // Smooths out the overall performance, bringing up presence without pumping
      {
        targetCrestFactorDb: 12,
        maxRatio: 2.5, // Gentle ratio for transparency
        threshold: "auto",
        follow: false,
        attack: 15, // Slow enough to let crisp consonants through (presence)
        release: 120, // Slow release for smooth, unnoticeable recovery
      },
    ],
    parallelCompression: {
      ratio: 25,
      attackMs: 0.1,
      releaseMs: 50,
      makeupGain: "auto", // automatically match average gain reduction
      wetMix: 0.4,
      vadFadeMs: 5,
      crestGuardThresholdDb: 12,
      parallelDesserMaxReductionDb: 6,
    },
    // Stage 4a-E: Vocal Expander — frequency-selective silence-floor attenuation.
    // headroomOffsetDb - defines how close to speech threshold;
    // highFreqDepth - reduces gain reduction for noise outside the top of the frequency band --
    // e.g. (0.25) preserves breath/fricative transparency above 800 Hz.
    vocalExpander: {
      enabled: true,
      ratio: 2.5,
      highFreqDepth: 1.0,
      headroomOffsetDb: 6,
      releaseMs: 50,
      attackMs: 2,
      holdMs: 5,
      lookaheadMs: 20,
      maxAttenuationDb: 40,
      detectionBand: { lowHz: 80, highHz: 800 },
    },
    // VAD Gate — assertive for noise_eraser. Source separation already produces
    // a "dry booth" silence character; a hard gate completes the removal of
    // residual bleed between words.
    vadGate: {
      enabled: false,
      lookaheadMs: 20,
      holdMs: 80,
      attackMs: 5,
      releaseMs: 30,
      floorDb: -70,
    },
    airBoost: { gainDb: 0 },
    bweModel: "ap_bwe",
    bwe: {
      enabled: false,
      postEq: { enabled: true, freq: 9000, q: 2, gainDb: -3 },
    },
    // MMSE spectral subtraction pre-pass (before RNNoise NE-1). Moderate strength
    // so residual room noise is reduced before RNNoise's stationary NR pass and
    // Demucs separation. Transient shaper enabled to suppress reverb tails.
    spectralSubtraction: {
      enabled: true,
      alphaDd: 0.98,
      beta: 0.15,
      strength: 0.8,
      transientShaper: true,
      transientMaxReductionDb: 6,
    },
    roomPresence: { enabled: false },
    stages: [
      'decode',
      'measureBefore', 'peakNormalize', 'analyzeFramesRaw',
      'humDetect', 'hpf',
      { spectralSubtraction: { enabled: true, alphaDd: 0.98, beta: 0.15, strength: 0.8, transientShaper: true, transientMaxReductionDb: 6 } },
      'noiseReduce',
      'tonalPretreatment', 'separateVocals', 'separationValidation',
      'bandwidthExtension', 'remeasureFramesPostNr',
      { vocalExpander: { enabled: true, ratio: 1.5, highFreqDepth: 0.25, headroomOffsetDb: 4, releaseMs: 50, attackMs: 2, holdMs: 5, lookaheadMs: 20, maxAttenuationDb: 12, detectionBand: { lowHz: 80, highHz: 800 } } },
      'vocalSaturation',
      { compression: [
        { targetCrestFactorDb: 15, maxRatio: 4, threshold: 'auto', follow: false, attack: 0.1, release: 40 },
        { targetCrestFactorDb: 12, maxRatio: 4, threshold: 'auto', follow: false, attack: 10, release: 80 },
        { targetCrestFactorDb: 12, maxRatio: 2.5, threshold: 'auto', follow: false, attack: 15, release: 120 },
      ] },
      { vocalExpander: { enabled: true, ratio: 2.0, highFreqDepth: 0.5, headroomOffsetDb: 6, releaseMs: 50, attackMs: 2, holdMs: 5, lookaheadMs: 20, maxAttenuationDb: 18, detectionBand: { lowHz: 80, highHz: 800 } } },
      { vadGate: { enabled: false, lookaheadMs: 20, holdMs: 80, attackMs: 5, releaseMs: 30, floorDb: -70 } },
      'autoLevel',
      { airBoost: { gainDb: 0 } },
      { roomPresence: { enabled: false } },
      'normalize', 'truePeakLimit', 'measureAfter',
      'acxCertification', 'qualityAdvisory', 'encode', 'extractPeaks',
    ],
  },

  clearervoice_eraser: {
    id: "clearervoice_eraser",
    displayName: "ClearerVoice Eraser",
    description: "Neural speech enhancement using ClearerVoice-Studio",
    audience: "Noisy recordings",
    character: "AI-enhanced, clean speech, dry quality",
    targetLoudness: { value: -16, unit: "LUFS" },
    truePeakCeiling: -1,
    noiseFloorTarget: null,
    compression: {
      mode: "conditional",
      targetCrestFactorDb: 10,
      thresholdPercentile: 0.75,
      attack: 8,
      release: 100,
    },
    parallelCompression: {
      ratio: 8,
      attackMs: 1.0,
      releaseMs: 225, // longer release for smoothed separation transients
      makeupGain: "auto", // automatically match average gain reduction
      wetMix: 0.3, // midpoint of 20–25%
      vadFadeMs: 5,
      crestGuardThresholdDb: 12,
      parallelDesserMaxReductionDb: 8, // fixed-band only; lower ceiling per spec
    },
    eqProfile: "podcast",
    deEsser: {
      sensitivity: "none",
      trigger: 0,
      maxReduction: 0,
      ratio: 6.7,
    },
    channelOutput: "mono",
    defaultOutputProfile: "podcast",
    lockedOutputProfile: false,
    noiseModel: "df3",
    // ClearerVoice enhancement model:
    //   'mossformer2_48k' — MossFormer2_SE_48K (default, best quality, 48 kHz full-band)
    //   'frcrn_16k'       — FRCRN_SE_16K (faster, good quality, 16 kHz)
    // Both models are downloaded from HuggingFace on first use.
    clearervoiceModel: "mossformer2_48k",
    autoLeveler: {
      total_max_up_db: 6.0,
      total_max_down_db: 8.0,
      target_mode: 'running_median',
      target_window_s: 45,
      noise_floor_target_dbfs: -50,
      deadband_db: 1.5,
      knee_db: 1.0,
      max_up_db: 5.0,
      max_down_db: 6.0,
      subphrase_split_drop_db: 6.0,
      subphrase_split_min_duration_ms: 500,
      crossfade_ms: 30,
      merge_max_delta_db: 6.0,
    },
    saturation: {
      drive: 2.0,
      wetDry: 0.3,
      bias: 0.08,
      lowCrossover: 500,
      midCrossover: 3500,
      softness: 0.35,
    },
    // Stage 4a-E: Vocal Expander. ClearerVoice output is already enhanced; the
    // expander calibrates from the measured silence floor regardless of how the
    // signal was produced, so the general-clean assertive defaults apply.
    vocalExpander: {
      enabled: true,
      ratio: 2.0,
      highFreqDepth: 0.5,
      headroomOffsetDb: 6,
      releaseMs: 150,
      attackMs: 10,
      holdMs: 20,
      lookaheadMs: 10,
      maxAttenuationDb: 18,
      detectionBand: { lowHz: 80, highHz: 800 },
    },
    // VAD Gate — assertive for clearervoice_eraser. ClearerVoice output already
    // has a dry, processed character; deeper floor reinforces it.
    vadGate: {
      enabled: false,
      lookaheadMs: 20,
      holdMs: 80,
      attackMs: 5,
      releaseMs: 30,
      floorDb: -70,
    },
    airBoost: { gainDb: 0 },
    bweModel: "ap_bwe",
    bwe: {
      enabled: true,
      postEq: { enabled: true, freq: 9000, q: 2, gainDb: -4 },
    },
    // MMSE spectral subtraction pre-pass (before RNNoise NE-1). Moderate strength
    // reduces residual room noise before ClearerVoice SE processes the signal.
    // Transient shaper enabled to suppress inter-phrase reverb tails.
    spectralSubtraction: {
      enabled: true,
      alphaDd: 0.98,
      beta: 0.15,
      strength: 0.8,
      transientShaper: true,
      transientMaxReductionDb: 6,
    },
    // Stage 4c — Room Presence disabled: ClearerVoice Eraser produces a clean,
    // dry enhanced signal. Adding room presence would contradict the preset goal.
    roomPresence: { enabled: false },
    stages: [
      'decode',
      'measureBefore', 'peakNormalize', 'analyzeFramesRaw',
      'humDetect', 'hpf',
      { spectralSubtraction: { enabled: true, alphaDd: 0.98, beta: 0.15, strength: 0.8, transientShaper: true, transientMaxReductionDb: 6 } },
      'noiseReduce',
      'tonalPretreatment', 'clearerVoiceEnhance', 'separationValidation',
      'residualCleanup', 'bandwidthExtension',
      { deEsser: { sensitivity: 'none', trigger: 0, maxReduction: 0, ratio: 6.7 } },
      'remeasureFramesPostNr',
      { autoLeveler: {
        total_max_up_db: 6.0, total_max_down_db: 8.0,
        target_mode: 'running_median', target_window_s: 45,
        noise_floor_target_dbfs: -50, deadband_db: 1.5, knee_db: 1.0,
        max_up_db: 5.0, max_down_db: 6.0,
        subphrase_split_drop_db: 6.0, subphrase_split_min_duration_ms: 500,
        crossfade_ms: 30, merge_max_delta_db: 6.0,
      } },
      { compression: { mode: 'conditional', targetCrestFactorDb: 10, thresholdPercentile: 0.75, attack: 8, release: 100 } },
      { parallelCompression: { ratio: 8, attackMs: 1.0, releaseMs: 225, makeupGain: 'auto', wetMix: 0.3, vadFadeMs: 5, crestGuardThresholdDb: 12, parallelDesserMaxReductionDb: 8 } },
      { vocalExpander: { enabled: true, ratio: 2.0, highFreqDepth: 0.5, headroomOffsetDb: 6, releaseMs: 150, attackMs: 10, holdMs: 20, lookaheadMs: 10, maxAttenuationDb: 18, detectionBand: { lowHz: 80, highHz: 800 } } },
      { vadGate: { enabled: false, lookaheadMs: 20, holdMs: 80, attackMs: 5, releaseMs: 30, floorDb: -70 } },
      'correctiveEQ',
      { airBoost: { gainDb: 0 } },
      'vocalSaturation',
      { roomPresence: { enabled: false } },
      'normalize', 'truePeakLimit', 'measureAfter',
      'acxCertification', 'qualityAdvisory', 'encode', 'extractPeaks',
    ],
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
  return PRESETS[presetId]?.defaultOutputProfile ?? "podcast"
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
  if (!preset) return ""
  const { value, unit } = preset.targetLoudness
  return `${value} ${unit}`
}
