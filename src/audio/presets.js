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
 * @property {{ enabled: boolean, model?: 'ap-bwe'|'ap_bwe'|'lavasr', postEq?: { enabled: boolean, freq?: number, q?: number, gainDb: number } }} bandwidthExtension - Bandwidth extension; enabled for NE presets, disabled for standard presets. model selects the backend ('ap-bwe' default, 'lavasr'). postEq applies a narrow bell cut after BWE to tame sibilance introduced by HF synthesis.
 * @property {{ model?: 'df3'|'rnnoise'|'dtln', skipBelowDb?: number }} [noiseReduce] - Noise reduction stage configuration. model selects the backend ('df3' default). skipBelowDb skips this pass entirely if the current noise floor is already below the given dBFS (e.g. -85). When the stage is listed more than once, each call can carry its own model and skipBelowDb.
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
    channelOutput: "mono",
    defaultOutputProfile: "acx",
    lockedOutputProfile: true,
    stages: [
      "decode",
      "monoMixdown",
      "measureBefore",
      "peakNormalize",
      "analyzeFramesRaw",
      "humDetect",
      "hpf",
      { noiseReduce: { model: "df3" } }, //"df3", "rnnoise", "dtln"
      {
        bandwidthExtension: {
          enabled: true,
          model: "ap-bwe", //"lavasr", "ap-bwe"
          postEq: { enabled: false, freq: 9000, q: 2, gainDb: -3 },
        },
      },
      "remeasureFramesPostNr",
      {
        autoLeveler: {
          total_max_up_db: 10.0,
          total_max_down_db: 10.0,
          target_mode: "global",
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
      },
      {
        spectralSubtraction: {
          enabled: true,
          alphaDd: 0.98,
          beta: 0.15,
          strength: 0.7,
          transientShaper: true,
        },
      },
      {
        vadGate: {
          enabled: true,
          energyOverrideDb: 24,
          lookaheadMs: 60,
          holdMs: 200,
          attackMs: 5,
          releaseMs: 80,
          floorDb: -110,
        },
      },
      {
        clipGainDeEsser: {
          enabled: true,
          naturalCeilingDb: 8,
          reductionRatio: 0.55,
          maxReductionDb: 6.0,
          minDurationMs: 25,
          contextWindowMs: 80,
          fades: {
            fricativeInMs: 3.0,
            fricativeOutMs: 4.0,
            affricateInMs: 1.5,
            affricateOutMs: 4.5,
          },
        },
      },
      {
        // Conservative —
        throatClickAttenuator: {
          sensitivityDb: 10,
          nrmsThreshold: 3.0,
          attenuationDb: 14,
          attackMs: 12,
          releaseMs: 25,
          padMs: 4,
        },
      },

      "correctiveEQ",
      "remeasureFramesPostNr",
      {
        compression: [
          {
            targetCrestFactorDb: 15,
            maxRatio: 6,
            threshold: "auto",
            follow: false,
            attack: 0.1,
            release: 30,
          },
          {
            targetCrestFactorDb: 15,
            maxRatio: 3,
            threshold: "auto",
            follow: false,
            attack: 15,
            release: 120,
          },
        ],
      },
      "remeasureFramesPostNr",
      { noiseReduce: { model: "rrnoise", skipBelowDb: -70 } },
      {
        parallelCompression: {
          ratio: 20,
          attackMs: 15,
          releaseMs: 150,
          makeupGain: "auto",
          wetMix: 0.15,
          vadFadeMs: 5,
          crestGuardThresholdDb: 12,
          parallelDesserMaxReductionDb: 15,
        },
      },
      {
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
      },
      {
        airBoost: {
          gainDb: 2,
          sibilantGainFloor: 0,
          sibilanceDetection: {
            p95_trigger_db: 6.0,
            min_flatness: 0.1,
            broadband_trigger_db: 10.0,
          },
        },
      },
      /*
      {
        vocalSaturation: {
          //drive: 1.8,
          drive: 0,
          wetDry: 0,
          //wetDry: 0.03,
          bias: 0.08,
          lowCrossover: 500,
          midCrossover: 3000,
          softness: 0.8,
        },
      },
      */
      "correctiveEQ",
      "referenceEQ",
      { clickRemover: { thresholdSigma: 2.5, maxClickMs: 5 } },

      {
        resonanceSuppressor: [
          {
            depth: 0.67,
            sharpness: 0.8,
            selectivity: 3,
            attack_ms: 15.0,
            release_ms: 80.0,
            max_reduction_db: 36.0,
            freq_floor_hz: 40.0,
            freq_ceil_hz: 20000.0,
            mode: "soft",
          },
          {
            sibilant_only: true,
            preserve_harmonics: false,
            depth: 0.67,
            sharpness: 0.4,
            selectivity: 1,
            attack_ms: 5.0,
            release_ms: 10.0,
            max_reduction_db: 25.0,
            freq_floor_hz: 3000.0,
            freq_ceil_hz: 10000.0,
            mode: "soft",
            lifter_cutoff_bins: 3,
            band_summary_max_cluster_bins: 186,
            sibilanceDetection: {
              p95_trigger_db: 9.0,
              min_flatness: 0.2,
              broadband_trigger_db: 13.0,
            },
          },
        ],
      },

      {
        roomPresence: {
          enabled: true,
          ir_path: "../ir/MRV_VocalBoot_m-m.wav",
          wet: 0.02,
          rt60Ms: 250,
          preDelayMs: 10.0,
          early_reflections: 2,
          normalize_ir: true,
        },
      },
      "normalize",
      "truePeakLimit",
      "measureAfter",
      "acxCertification",
      "qualityAdvisory",
      "encode",
      "extractPeaks",
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
    channelOutput: "preserve",
    defaultOutputProfile: "podcast",
    lockedOutputProfile: false,
    stages: [
      "decode",
      "monoMixdown",
      "measureBefore",
      "peakNormalize",
      "analyzeFramesRaw",
      { clickRemover: { thresholdSigma: 3.5, maxClickMs: 15 } },
      "humDetect",
      "hpf",
      { noiseReduce: { model: "df3" } },
      "remeasureFramesPostNr",
      {
        autoLeveler: {
          total_max_up_db: 6.0,
          total_max_down_db: 8.0,
          target_mode: "running_median",
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
      },
      {
        spectralSubtraction: {
          enabled: true,
          alphaDd: 0.98,
          beta: 0.15,
          strength: 1.0,
          transientShaper: true,
          transientMaxReductionDb: 6,
        },
      },
      { bandwidthExtension: { enabled: false, model: "ap-bwe" } },
      "vocalSaturation",
      {
        vadGate: {
          enabled: false,
          lookaheadMs: 20,
          holdMs: 80,
          attackMs: 8,
          releaseMs: 40,
          floorDb: -60,
        },
      },
      {
        clipGainDeEsser: {
          enabled: true,
          naturalCeilingDb: 8.0,
          reductionRatio: 0.55,
          maxReductionDb: 8.0,
          minDurationMs: 25,
          contextWindowMs: 80,
          fades: {
            fricativeInMs: 3.0,
            fricativeOutMs: 4.0,
            affricateInMs: 1.5,
            affricateOutMs: 4.5,
          },
        },
      },
      "remeasureFramesPostNr",
      {
        compression: [
          {
            targetCrestFactorDb: 14,
            maxRatio: 5,
            threshold: "auto",
            follow: false,
            attack: 0.1,
            release: 40,
          },
          {
            targetCrestFactorDb: 10,
            maxRatio: 4,
            threshold: "auto",
            follow: false,
            attack: 5,
            release: 80,
          },
        ],
      },
      "remeasureFramesPostNr",
      { noiseReduce: { model: "df3", skipBelowDb: -85 } },
      {
        parallelCompression: {
          ratio: 10,
          attackMs: 0.4,
          releaseMs: 120,
          makeupGain: "auto",
          wetMix: 0.4,
          vadFadeMs: 10,
          crestGuardThresholdDb: 12,
          parallelDesserMaxReductionDb: 10,
        },
      },
      {
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
      },
      { airBoost: { gainDb: 2.5, sibilantGainFloor: 0.25 } },
      {
        resonanceSuppressor: {
          depth: 0.65,
          selectivity: 6,
          attack_ms: 8.0,
          release_ms: 60.0,
        },
      },
      "correctiveEQ",
      "referenceEQ",
      {
        throatClickAttenuator: {
          sensitivityDb: 10,
          nrmsThreshold: 2.5,
          attenuationDb: 20,
          attackMs: 12,
          releaseMs: 25,
          padMs: 4,
        },
      },
      {
        roomPresence: {
          enabled: true,
          wet: 0.08,
          rt60Ms: 80,
          preDelayMs: 1.5,
          diffusion: 0.7,
        },
      },
      "normalize",
      "truePeakLimit",
      "measureAfter",
      "acxCertification",
      "qualityAdvisory",
      "encode",
      "extractPeaks",
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
    channelOutput: "preserve",
    defaultOutputProfile: "podcast",
    lockedOutputProfile: false,
    stages: [
      "decode",
      "monoMixdown",
      "measureBefore",
      "peakNormalize",
      "analyzeFramesRaw",
      { clickRemover: { thresholdSigma: 3.5, maxClickMs: 10 } },
      "humDetect",
      "hpf",
      { noiseReduce: { model: "df3" } },
      "remeasureFramesPostNr",
      {
        autoLeveler: {
          total_max_up_db: 8.0,
          total_max_down_db: 10.0,
          target_mode: "running_median",
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
      },
      {
        spectralSubtraction: {
          enabled: true,
          alphaDd: 0.98,
          beta: 0.15,
          strength: 1.0,
          transientShaper: true,
          transientMaxReductionDb: 6,
        },
      },
      { bandwidthExtension: { enabled: false, model: "ap_bwe" } },
      "vocalSaturation",
      {
        vadGate: {
          enabled: false,
          lookaheadMs: 20,
          holdMs: 80,
          attackMs: 8,
          releaseMs: 40,
          floorDb: -60,
        },
      },
      {
        clipGainDeEsser: {
          enabled: true,
          naturalCeilingDb: 7.0,
          reductionRatio: 0.6,
          maxReductionDb: 8.0,
          minDurationMs: 25,
          contextWindowMs: 80,
          fades: {
            fricativeInMs: 3.0,
            fricativeOutMs: 4.0,
            affricateInMs: 1.5,
            affricateOutMs: 4.5,
          },
        },
      },
      "remeasureFramesPostNr",
      {
        compression: {
          mode: "conditional",
          targetCrestFactorDb: 10,
          thresholdPercentile: 0.7,
          attack: 8,
          release: 80,
        },
      },
      "remeasureFramesPostNr",
      { noiseReduce: { model: "df3", skipBelowDb: -85 } },
      {
        parallelCompression: {
          ratio: 10,
          attackMs: 0.3,
          releaseMs: 120,
          makeupGain: "auto",
          wetMix: 0.35,
          vadFadeMs: 8,
          crestGuardThresholdDb: 9,
          parallelDesserMaxReductionDb: 12,
        },
      },
      {
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
      },
      {
        airBoost: {
          gainDb: 16,
          sibilantGainFloor: 0.0,
          sibilanceDetection: { broadband_trigger_db: 9.0 },
        },
      },
      {
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
      },
      "correctiveEQ",
      "referenceEQ",
      {
        throatClickAttenuator: {
          sensitivityDb: 10,
          nrmsThreshold: 2.5,
          attenuationDb: 18,
          attackMs: 12,
          releaseMs: 25,
          padMs: 4,
        },
      },
      {
        roomPresence: {
          enabled: true,
          wet: 0.08,
          rt60Ms: 80,
          preDelayMs: 1.5,
          diffusion: 0.7,
        },
      },
      "normalize",
      "truePeakLimit",
      "measureAfter",
      "acxCertification",
      "qualityAdvisory",
      "encode",
      "extractPeaks",
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
    channelOutput: "mono",
    defaultOutputProfile: "podcast",
    lockedOutputProfile: false,
    // Separation backend: 'demucs' (default, best quality) or 'convtasnet' (faster).
    // Demucs htdemucs_ft: ~5–10x real-time GPU, ~0.5–1x real-time CPU, ~2–4 GB VRAM.
    // ConvTasNet WHAM!:   ~20–30x real-time GPU, ~5–10x real-time CPU, ~500 MB VRAM.
    separationModel: "demucs",
    stages: [
      "decode",
      "measureBefore",
      "peakNormalize",
      "analyzeFramesRaw",
      "humDetect",
      "hpf",
      {
        spectralSubtraction: {
          enabled: true,
          alphaDd: 0.98,
          beta: 0.15,
          strength: 0.8,
          transientShaper: true,
          transientMaxReductionDb: 6,
        },
      },
      { noiseReduce: { model: "df3" } },
      "tonalPretreatment",
      "separateVocals",
      "separationValidation",
      { bandwidthExtension: { enabled: false, model: "ap-bwe" } },
      "remeasureFramesPostNr",
      {
        vocalExpander: {
          enabled: true,
          ratio: 1.5,
          highFreqDepth: 0.25,
          headroomOffsetDb: 4,
          releaseMs: 50,
          attackMs: 2,
          holdMs: 5,
          lookaheadMs: 20,
          maxAttenuationDb: 12,
          detectionBand: { lowHz: 80, highHz: 800 },
        },
      },
      "vocalSaturation",
      {
        compression: [
          {
            targetCrestFactorDb: 15,
            maxRatio: 4,
            threshold: "auto",
            follow: false,
            attack: 0.1,
            release: 40,
          },
          {
            targetCrestFactorDb: 12,
            maxRatio: 4,
            threshold: "auto",
            follow: false,
            attack: 10,
            release: 80,
          },
          {
            targetCrestFactorDb: 12,
            maxRatio: 2.5,
            threshold: "auto",
            follow: false,
            attack: 15,
            release: 120,
          },
        ],
      },
      {
        vocalExpander: {
          enabled: true,
          ratio: 2.0,
          highFreqDepth: 0.5,
          headroomOffsetDb: 6,
          releaseMs: 50,
          attackMs: 2,
          holdMs: 5,
          lookaheadMs: 20,
          maxAttenuationDb: 18,
          detectionBand: { lowHz: 80, highHz: 800 },
        },
      },
      {
        vadGate: {
          enabled: false,
          lookaheadMs: 20,
          holdMs: 80,
          attackMs: 5,
          releaseMs: 30,
          floorDb: -70,
        },
      },
      "autoLevel",
      { airBoost: { gainDb: 0 } },
      { roomPresence: { enabled: false } },
      "normalize",
      "truePeakLimit",
      "measureAfter",
      "acxCertification",
      "qualityAdvisory",
      "encode",
      "extractPeaks",
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
