/**
 * Sibilance detector calibration constants, for the developer tuning panel.
 *
 * These mirror DEFAULT_PARAMS in server/scripts/sibilance_detector.py, plus the
 * two de-esser-stage settings that also force re-detection. They are NOT user
 * controls and are gated behind DEV_TUNING_PANELS — several were fitted against
 * narrator recordings and carry open TODOs in the Python. The panel exists so
 * they can be swept against real audio instead of by editing a preset and
 * re-running the chain.
 *
 * Anything here changes which events exist or how they were measured, so every
 * one of them invalidates the analysis. That is the line between this file and
 * dsp/clipGainDecision.js: the constants there are pure functions of two frozen
 * measurements and move freely at play time; these are inputs to the
 * measurement itself.
 *
 * `key` is the wire name. Everything except minDurationMs and contextWindowMs
 * is passed straight through as a sparse override over the Python's defaults,
 * so the snake_case names are deliberate — they have to match.
 */

export const SIBILANCE_TUNING_GROUPS = [
  {
    label: 'Spectral shape',
    hint: 'Separates broadband fricative turbulence from narrow-band content.',
    params: [
      { key: 'p95_trigger_db', label: 'P95 trigger', unit: 'dB', min: 0, max: 24, step: 0.5 },
      { key: 'min_flatness', label: 'Min flatness', unit: '', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    label: 'Voicing veto',
    hint: 'Vowels dominate the low band by 30–50 dB; voiceless fricatives do not.',
    params: [
      { key: 'voicing_veto_db', label: 'Veto threshold', unit: 'dB', min: 0, max: 60, step: 1 },
      { key: 'voicing_veto_lf_low_hz', label: 'LF band low', unit: 'Hz', min: 20, max: 500, step: 10 },
      { key: 'voicing_veto_lf_high_hz', label: 'LF band high', unit: 'Hz', min: 500, max: 4000, step: 50 },
    ],
  },
  {
    label: 'Energy gate',
    hint: 'Absolute floor. The pipeline supplies the noise floor per call.',
    params: [
      {
        key: 'min_sibilant_energy_above_noise_db',
        label: 'Above noise floor', unit: 'dB', min: 0, max: 40, step: 1,
      },
    ],
  },
  {
    label: 'Event shaping',
    hint: 'Duration filter and gap merging, applied after per-frame detection.',
    params: [
      { key: 'minDurationMs', label: 'Min duration', unit: 'ms', min: 0, max: 100, step: 1 },
      { key: 'gap_merge_ms', label: 'Gap merge', unit: 'ms', min: 0, max: 250, step: 5 },
      { key: 'contextWindowMs', label: 'Context window', unit: 'ms', min: 20, max: 400, step: 10 },
    ],
  },
  {
    label: 'Fricative extension',
    hint: 'Silero marks turbulence-only head and tail as silence; these reclaim it.',
    params: [
      { key: 'fricative_head_extension_ms', label: 'Head pre-roll', unit: 'ms', min: 0, max: 200, step: 5 },
      { key: 'fricative_tail_extension_ms', label: 'Tail extension', unit: 'ms', min: 0, max: 200, step: 5 },
      { key: 'silence_gap_reset_ms', label: 'Silence reset', unit: 'ms', min: 0, max: 500, step: 10 },
      { key: 'post_silence_window_ms', label: 'Post-silence window', unit: 'ms', min: 0, max: 500, step: 10 },
    ],
  },
  {
    label: 'Boundary expansion',
    hint: 'Relaxes only the spectral margin at event edges. Hard gates never relax.',
    params: [
      { key: 'boundary_p95_relax_db', label: 'P95 relax', unit: 'dB', min: 0, max: 6, step: 0.1 },
      { key: 'boundary_flatness_relax', label: 'Flatness relax', unit: '', min: 0, max: 0.2, step: 0.005 },
    ],
  },
]

/** Defaults, matching sibilance_detector.DEFAULT_PARAMS and the ACX preset. */
export const SIBILANCE_TUNING_DEFAULTS = {
  p95_trigger_db: 6.0,
  min_flatness: 0.1,
  voicing_veto_db: 20.0,
  voicing_veto_lf_low_hz: 80.0,
  voicing_veto_lf_high_hz: 1500.0,
  min_sibilant_energy_above_noise_db: 20.0,
  gap_merge_ms: 80.0,
  silence_gap_reset_ms: 150.0,
  post_silence_window_ms: 150.0,
  fricative_tail_extension_ms: 80.0,
  fricative_head_extension_ms: 80.0,
  boundary_p95_relax_db: 1.5,
  boundary_flatness_relax: 0.02,
  // De-esser stage settings, not detector params — see splitTuning in
  // useDeEsser.js. Here because they invalidate the analysis just the same.
  minDurationMs: 25,
  contextWindowMs: 80,
}

/** Which keys differ from their defaults — the panel marks these. */
export function changedTuningKeys(tuning) {
  return Object.keys(SIBILANCE_TUNING_DEFAULTS).filter(
    k => tuning[k] !== SIBILANCE_TUNING_DEFAULTS[k],
  )
}
