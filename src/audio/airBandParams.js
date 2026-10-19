/**
 * Air Boost params — the defaults and the panel's ranges.
 *
 * Split out of `effects/airBand.js` so they can be reached from Node: that
 * module pulls the worklet loader, which a test (or the preset store) cannot
 * import. It re-exports AIR_BAND_DEFAULTS, so importers are unchanged.
 */

export const AIR_BAND_DEFAULTS = {
  air: 6, // dB of air lift, 0–24
  output: 0, // output trim dB, for level-matched A/B
}

/** The panel's Air knob stops at 12; the kernel takes up to 24. */
export const AIR_MAX_DB = 12
export const AIR_OUTPUT_MIN_DB = -12
export const AIR_OUTPUT_MAX_DB = 12
