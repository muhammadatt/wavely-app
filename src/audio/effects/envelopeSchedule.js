/**
 * WHERE AND WHEN A GAIN-ENVELOPE MODULATOR STARTS.
 *
 * An effect whose gain is fully known in advance drives a `GainNode`'s
 * AudioParam from an `AudioBufferSourceNode` rather than computing anything at
 * play time — see `clipGainDeEss.js` for why that beats a position-aware
 * worklet. The envelope spans one REGION of the timeline, not the whole of it
 * (a full-timeline buffer is 635 MB of Float32 for a one-hour chapter), so
 * every playback has to work out where in that region the playhead is.
 *
 * ⚠ THIS ARITHMETIC IS SHARED BECAUSE IT IS THE PART THAT IS EASY TO GET WRONG
 * AND IMPOSSIBLE TO NOTICE. Getting it wrong slides the envelope against the
 * audio — a de-esser dip lands off the sibilant, a leveller's step lands mid-
 * word — which reads as the effect being subtly bad rather than as a bug. It is
 * also the one piece that cannot be exercised from Node inside its own node
 * wrapper, because that needs an AudioContext. Pulled out here it is a pure
 * function with a test.
 *
 * The node plumbing deliberately stays in each effect: it is boilerplate, and
 * sharing it would mean sharing `getReduction`, which measures a different
 * quantity per effect.
 */

/**
 * Schedule one envelope pass.
 *
 * Two cases, and both are the same arithmetic `playback.js` already does for
 * segments: playback starting BEFORE the region schedules the modulator later,
 * playback starting INSIDE it starts the modulator part-way in.
 *
 * @param {object}  args
 * @param {number}  args.regionStartSec  where the envelope's first sample sits
 *                                       on the timeline
 * @param {number}  args.durationSec     the envelope's length in seconds
 * @param {number}  args.when            context time this playback begins sounding
 * @param {number}  args.startSec        timeline position playback begins at
 * @returns {{at: number, offset: number, transportStartSec: number} | null}
 *   `null` when the region is already behind the playhead and this pass has
 *   nothing to schedule.
 */
export function scheduleEnvelope({ regionStartSec, durationSec, when, startSec }) {
  const regionEndSec = regionStartSec + durationSec
  // Already past it. Not an error — seeking beyond an applied region is normal.
  if (startSec >= regionEndSec) return null

  return {
    // Starting before the region: wait out the gap on the context clock.
    at: startSec < regionStartSec ? when + (regionStartSec - startSec) : when,
    // Starting inside it: skip that far into the buffer.
    offset: startSec < regionStartSec ? 0 : startSec - regionStartSec,
    /**
     * The timeline position the modulator's first sounding sample corresponds
     * to. It is NOT `startSec` when playback began before the region — the
     * meters read the envelope from here, and using `startSec` would have them
     * reading the gap as though it were envelope.
     */
    transportStartSec: startSec < regionStartSec ? regionStartSec : startSec,
  }
}
