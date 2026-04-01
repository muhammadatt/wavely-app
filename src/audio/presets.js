/**
 * Audio Effect Presets and Compliance Targets
 *
 * Pure data definitions for the Instant Polish processing chain.
 * No side effects, no Vue dependency.
 */

/**
 * @typedef {Object} ComplianceTarget
 * @property {string} id
 * @property {string} displayName
 * @property {[number, number]} loudnessRange - [min, max] in dBFS (RMS) or LUFS
 * @property {number} truePeakCeiling - dBFS
 * @property {number|null} noiseFloorCeiling - dBFS, null if not enforced
 * @property {'RMS'|'LUFS'} measurementMethod
 */

/** @type {Record<string, ComplianceTarget>} */
export const COMPLIANCE_TARGETS = {
  acx: {
    id: 'acx',
    displayName: 'ACX Standard',
    loudnessRange: [-23, -18],
    truePeakCeiling: -3,
    noiseFloorCeiling: -60,
    measurementMethod: 'RMS',
  },
  standard: {
    id: 'standard',
    displayName: 'Standard',
    loudnessRange: [-18, -14],
    truePeakCeiling: -1,
    noiseFloorCeiling: null,
    measurementMethod: 'LUFS',
  },
  broadcast: {
    id: 'broadcast',
    displayName: 'Broadcast',
    loudnessRange: [-24, -22],
    truePeakCeiling: -1,
    noiseFloorCeiling: null,
    measurementMethod: 'LUFS',
  },
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
 * @property {number} noiseFloorTarget
 * @property {number} noiseReductionCeiling - max dB reduction
 * @property {{ mode: 'conditional'|'always', ratio: number, threshold: number, attack: number, release: number }} compression
 * @property {string} eqProfile
 * @property {{ sensitivity: string, trigger: number, maxReduction: number }} deEsser
 * @property {'mono'|'preserve'} channelOutput
 * @property {string} defaultCompliance
 * @property {boolean} lockedCompliance
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
    noiseReductionCeiling: 12,
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
    defaultCompliance: 'acx',
    lockedCompliance: true,
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
    noiseReductionCeiling: 8,
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
    defaultCompliance: 'standard',
    lockedCompliance: false,
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
    noiseReductionCeiling: 8,
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
    defaultCompliance: 'acx',
    lockedCompliance: false,
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
    noiseReductionCeiling: 12,
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
    defaultCompliance: 'standard',
    lockedCompliance: false,
  },
}

/**
 * Expected shape of the processing report returned by the server.
 * @typedef {Object} ProcessingReport
 * @property {{ rms: number, peak: number, noiseFloor: number, lufs: number|null }} before
 * @property {{ rms: number, peak: number, noiseFloor: number, lufs: number|null }} after
 * @property {{ target: string, passed: boolean, failures: string[] }} compliance
 * @property {string[]} chain - Human-readable processing steps applied
 * @property {string[]} warnings
 * @property {'low'|'medium'|'high'|null} humanReviewRisk - ACX only
 */

// --- Helpers ---

export function getDefaultCompliance(presetId) {
  return PRESETS[presetId]?.defaultCompliance ?? 'standard'
}

export function isComplianceLocked(presetId) {
  return PRESETS[presetId]?.lockedCompliance === true
}

export function getPresetList() {
  return Object.values(PRESETS)
}

export function getComplianceList() {
  return Object.values(COMPLIANCE_TARGETS)
}

export function formatLoudness(preset) {
  if (!preset) return ''
  const { value, unit } = preset.targetLoudness
  return `${value} ${unit}`
}
