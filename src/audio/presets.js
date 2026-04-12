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
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} displayName
 * @property {string} description
 * @property {string} audience
 * @property {string} character
 * @property {{ value: number, unit: string }} targetLoudness
 * @property {number} truePeakCeiling
 * @property {number|null} noiseFloorTarget
 * @property {{ mode: 'conditional'|'always'|'none', ratio: number, threshold: number, attack: number, release: number }} compression
 * @property {string} eqProfile
 * @property {{ sensitivity: 'standard'|'high'|'none', trigger: number, maxReduction: number }} deEsser
 * @property {'mono'|'preserve'} channelOutput
 * @property {string} defaultOutputProfile
 * @property {boolean} lockedOutputProfile
 * @property {{ enabled: boolean, strength: 'light'|'medium'|'heavy', preserve_early: boolean }} dereverb
 * @property {{ maxGainDb: number, maxRateDbPerS: number }} autoLeveler
 * @property {'demucs'|'convtasnet'} [separationModel]   - Noise Eraser only
 * @property {'mossformer2_48k'|'frcrn_16k'} [clearervoiceModel]   - ClearerVoice Eraser only
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
    compression: {
      mode: 'conditional',
      ratio: 2,
      threshold: -24,
      attack: 10,
      release: 100,
    },
    eqProfile: 'acx_narration',
    deEsser: {
      sensitivity: 'standard',
      trigger: 8,
      maxReduction: 6,
    },
    channelOutput: 'mono',
    defaultOutputProfile: 'acx',
    lockedOutputProfile: true,
    dereverb: {
      enabled: true,
      strength: 'medium',
      preserve_early: false,
    },
    autoLeveler: {
      maxGainDb:     4.0,
      maxRateDbPerS: 1.0,
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
    compression: {
      mode: 'always',
      ratio: 3,
      threshold: -20,
      attack: 5,
      release: 80,
    },
    eqProfile: 'podcast',
    deEsser: {
      sensitivity: 'high',
      trigger: 6,
      maxReduction: 6,
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
    compression: {
      mode: 'always',
      ratio: 2.5,
      threshold: -22,
      attack: 8,
      release: 90,
    },
    eqProfile: 'voice_over',
    deEsser: {
      sensitivity: 'standard',
      trigger: 8,
      maxReduction: 5,
    },
    channelOutput: 'mono',
    defaultOutputProfile: 'acx',
    lockedOutputProfile: false,
    // VACE-WPE (heavy) auto-selects GPU when CUDA is available; falls back to
    // CPU. Set to 'medium' here to use NARA-WPE on CPU-only servers — override
    // at deploy time via presetOverrides if GPU is confirmed available.
    dereverb: {
      enabled: true,
      strength: 'heavy',
      preserve_early: false,
    },
    autoLeveler: {
      maxGainDb:     4.0,
      maxRateDbPerS: 1.0,
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
    compression: {
      mode: 'always',
      ratio: 3,
      threshold: -20,
      attack: 8,
      release: 80,
    },
    eqProfile: 'general',
    deEsser: {
      sensitivity: 'high',
      trigger: 6,
      maxReduction: 8,
    },
    channelOutput: 'preserve',
    defaultOutputProfile: 'podcast',
    lockedOutputProfile: false,
    dereverb: {
      enabled: true,
      strength: 'medium',
      preserve_early: false,
    },
    autoLeveler: {
      maxGainDb:     6.0,
      maxRateDbPerS: 1.5,
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
    compression: {
      mode: 'conditional',
      ratio: 2,
      threshold: -24,
      attack: 10,
      release: 100,
    },
    eqProfile: 'general',
    deEsser: {
      sensitivity: 'high',
      trigger: 6,
      maxReduction: 8,
    },
    eqProfile: 'separation_recovery',
    deEsser: {
      sensitivity: 'none',
      trigger: 0,
      maxReduction: 0,
    },
    channelOutput: 'mono',
    defaultOutputProfile: 'podcast',
    lockedOutputProfile: false,
    // Separation backend: 'demucs' (default, best quality) or 'convtasnet' (faster).
    // Demucs htdemucs_ft: ~5–10x real-time GPU, ~0.5–1x real-time CPU, ~2–4 GB VRAM.
    // ConvTasNet WHAM!:   ~20–30x real-time GPU, ~5–10x real-time CPU, ~500 MB VRAM.
    separationModel: 'demucs',
    dereverb: {
      enabled: true,
      strength: 'medium',
      preserve_early: false,
    },
    autoLeveler: {
      maxGainDb:     8.0,
      maxRateDbPerS: 1.5,
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
      mode: 'none',
      ratio: 1,
      threshold: 0,
      attack: 0,
      release: 0,
    },
    eqProfile: 'separation_recovery',
    deEsser: {
      sensitivity: 'none',
      trigger: 0,
      maxReduction: 0,
    },
    channelOutput: 'mono',
    defaultOutputProfile: 'podcast',
    lockedOutputProfile: false,
    // ClearerVoice enhancement model:
    //   'mossformer2_48k' — MossFormer2_SE_48K (default, best quality, 48 kHz full-band)
    //   'frcrn_16k'       — FRCRN_SE_16K (faster, good quality, 16 kHz)
    // Both models are downloaded from HuggingFace on first use.
    clearervoiceModel: 'mossformer2_48k',
    autoLeveler: {
      maxGainDb:     8.0,
      maxRateDbPerS: 1.5,
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
