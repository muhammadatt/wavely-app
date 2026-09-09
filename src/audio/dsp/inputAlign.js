/**
 * INPUT ALIGNMENT — making a knob position mean the same thing on every file.
 *
 * THE PROBLEM. Neither opto nor FET emulation has a threshold control. The
 * hardware's threshold is a fixed internal constant and the knob is side-chain
 * gain driving the signal into it (`over = levelDb + scDriveDb` in
 * la2aProcessor.js). That is faithful, and it means the gain reduction a given
 * knob position delivers is a function of the FILE'S LEVEL, not of the knob.
 *
 * ⚠ THAT IS NOT A ROUNDING ERROR, IT IS THE WHOLE KNOB. Measured, average gain
 * reduction while active on speech-shaped programme at Peak Reduction 50:
 *
 *     peak -1 dBFS   4.62 dB        peak -18 dBFS   0.00 dB
 *     peak -6 dBFS   2.17 dB        peak -24 dBFS   0.00 dB
 *     peak -12 dBFS  0.36 dB        peak -30 dBFS   0.00 dB
 *
 * A narrator who gain-staged with headroom — which is what ACX guidance tells
 * them to do — gets a plugin that does LITERALLY NOTHING at its own default,
 * and at -30 dBFS peak the knob runs out of travel before it reaches 3 dB.
 * It also means a saved preset is only valid at the level it was saved at,
 * which quietly breaks the plugin-preset feature rather than degrading it.
 *
 * ⚠ THE MEASUREMENT IS THE DEFAULT, AND OPTOSMOOTH'S INPUT KNOB CAN OVERRIDE IT.
 * AUTO owns the knob until the user touches it, the same contract the Gain knob
 * has under auto makeup; Scheps has the measurement and no knob. An ALIGN
 * on/off switch was built and removed first — it could turn the correction off
 * but could not set an offset by hand — and the knob that replaced it was
 * itself nearly not built, on the reasoning that an offset renders
 * BIT-IDENTICALLY to the matching Peak Reduction move and would therefore
 * duplicate it. That compared renders when the difference is what the numbers
 * MEAN: Peak Reduction is a patch value presets save, this is a property of the
 * FILE, and compensating through the former writes a file's gain staging into a
 * preset. See `useLA2A.js` for the full argument.
 *
 * The measurement below is still what every file gets by default and what the
 * makeup is solved against, so it stays load-bearing: a class of material that
 * fools the gate is a bug to fix HERE, guarded by ALIGN_MAX_DB and
 * `npm run la2a:align`, not something to leave to the knob.
 *
 * ⚠ THIS IS A SIDE-CHAIN DRIVE OFFSET, NOT AN INPUT GAIN, and the distinction
 * is the reason this is safe. Level and drive ADD IN dB inside the gain
 * computer, so adding N dB of drive is algebraically identical to raising the
 * input by N dB — verified bit-identical, 100 % of samples, with the tube and
 * cell modulation off. But the audio path never sees it, so there is no output
 * trim to cancel, no level jump between preview and apply, and the output tube
 * — which is driven by level alone and is the ONE stage that does not cancel
 * under an input gain (rms deviation -56 dBr at a 6 dB offset) — is untouched.
 * An input-gain implementation has to undo itself downstream and still leaves
 * the tube shifted; this cannot, because it is a drive number.
 *
 * WHY GATED RMS AND NOT A PEAK STATISTIC. Gain reduction is an integral over
 * the envelope distribution, so an ENERGY statistic summarises it and a
 * near-peak statistic does not. Each candidate below was calibrated so the
 * reference capture lands at exactly 4.00 dB of reduction at Peak Reduction 50,
 * then every variant was aligned to that same target; a perfect statistic holds
 * 4.00 across the row. Spread across twelve variants of one real narration
 * capture (noise floors, clipping, spectral tilt, room, speech density, an
 * already-compressed pass, and head/tail room tone):
 *
 *     gated RMS (30 dB)   0.93 dB      <- this
 *     gated RMS (20 dB)   1.11
 *     plain RMS           1.64
 *     gated RMS (40 dB)   1.85
 *     99.9th percentile   3.80
 *     true peak           6.04
 *     ---
 *     peak-normalise      5.78         <- today, if the user normalises first
 *     as captured         2.51         <- today, at a third of the reduction
 *
 * ⚠ THE PERCENTILE `makeupReference.js` USES IS THE WRONG STATISTIC HERE AND
 * WAS TRIED. Reusing MAKEUP_PERCENTILE looks like the obvious standardisation
 * and it scores 3.80 — barely better than raw peak, which cannot even reach the
 * 4 dB operating point (the reference capture tops out at 2.80 dB with its peak
 * pinned to 0 dBFS). A near-peak statistic is right on the MAKEUP side, where
 * the question is "how loud is the loudest thing", and wrong here, where the
 * question is "how much energy is driving the detector". Do not unify them.
 *
 * ⚠ AND PEAK IS NOT AN ADEQUATE SHORTCUT, WHICH IS NOT OBVIOUS. The expected
 * cost of a peak reference is a constant bias — a hot-peak file arrives quieter
 * and wants a little more Peak Reduction — and that would be tolerable. The
 * real cost is that the error is neither constant nor about level. A 2 ms click
 * at -1 dBFS moves a peak measurement 1.79 dB and its delivered reduction
 * 1.80 -> 1.33; gated RMS moves 0.01. And peak converts CREST FACTOR straight
 * into compression, inverted — same speech at the same gated level, aligned on
 * peak, delivers 1.80 / 4.19 / 7.12 dB as captured / lightly clipped / hard
 * clipped, so the already-limited file that needs the least gets the most.
 * Gated RMS delivers 1.80 / 1.81 / 1.85. If this ever has to get simpler, the
 * answer is PLAIN RMS (1.89 dB of spread) and not peak (8.22).
 *
 * WHY THE GATE IS LOAD-BEARING. Plain RMS is strong until it is handed a
 * narrator's file with 30 s of head and tail room tone — the ACX case
 * `roomTonePad` exists for — where it errs +1.44 dB. Gating fixes that. It has
 * to gate relative to SPEECH LEVEL, not to the noise floor: a floor-relative
 * gate was built first and traded the silence error for a worse one on noisy
 * material (-1.31 dB at a -18 dBFS noise floor against -0.20 for plain RMS).
 */

/**
 * Block length for the gate, ms. 50 ms is the same window the speech dynamic
 * range measurements in this project use, and it is long enough that one
 * plosive cannot carry a block over the gate on its own.
 */
export const ALIGN_BLOCK_MS = 50

/**
 * How far below the file's own 95th-percentile block RMS the gate sits, dB.
 *
 * ⚠ FITTED ON ONE PROGRAMME AND NOT YET SETTLED. `data/corpus/` contains
 * exactly one dry source — `hardware.unknown.dry.wav` and `cla2a.unknown.dry.wav`
 * are byte-identical, correlation 1.0000 — and the two `.wet` captures are that
 * same programme through a compressor, so they vary its crest factor and not its
 * voice, room or microphone. `npm run la2a:align` scores 30 best across the 36
 * cases it can build from those (spread 1.26 dB, against 8.22 for true peak and
 * 7.26 for the peak-normalising workflow it replaces), but every one of them
 * descends from a single recording. This is the same shape of exposure as
 * SC_DRIVE_MAX_DB, which was fitted on one clip through what turned out to be
 * the wrong unit entirely. Re-run the bench with `--dir` pointed at narration
 * from another voice before treating 30 as settled.
 *
 * The neighbours are not close: 20 dB is too tight and reads noisy files 0.7-1.0
 * dB hot, 40 dB lets a -40 dBFS room tone back in and errs +1.76 dB. 30 sits
 * between two named failure modes rather than on a smooth optimum, which is
 * mildly reassuring about its position and says nothing about its precision.
 */
export const ALIGN_GATE_RANGE_DB = 30

/**
 * The level alignment aims the gated RMS at, dBFS.
 *
 * ⚠ THIS IS NOT `NOMINAL_DBFS`, AND SUBSTITUTING IT WOULD BE WRONG. -18 dBFS is
 * the DETECTOR's reference — where the T4 threshold sits after the side-chain
 * amplifier — and it is a level in the detector's own domain, reached through
 * the rectifier and the R37 emphasis. This is a gated block-RMS of the raw
 * programme. The two are different measurements of different signals and the
 * numbers are not interchangeable.
 *
 * ANCHORED TO THE REFERENCE CAPTURE'S OWN LEVEL, deliberately, so that
 * `hardware.unknown.dry.wav` aligns to a trim of exactly 0.00 dB. Every
 * ballistic, taper, tube and cell constant in this plugin was auditioned and
 * fitted against that capture at its native level; anchoring anywhere else
 * would silently re-voice all of them. Alignment is therefore a no-op on
 * well-recorded material and a correction only for files that are off nominal,
 * which is the smallest change that fixes the problem.
 */
export const ALIGN_TARGET_DBFS = -17.35

/**
 * Alignment cannot ask for more than this, dB, in either direction.
 *
 * ⚠ A TIGHTER CLAMP RE-CREATES THE BUG IT EXISTS TO GUARD. The first value
 * here was 24, chosen on a worry about extrapolating the taper — which was
 * misplaced: this is a DRIVE OFFSET, `scDriveDbFor` is untouched, and the gain
 * computer's `over` is unbounded by construction, so a large offset extrapolates
 * nothing. What 24 actually did was leave a file peaking at -30 dBFS short by
 * 3.2 dB, delivering 0.98 dB of reduction at Peak Reduction 50 where every
 * other level delivered 1.80 — the exact "quiet file runs out of travel"
 * failure alignment is for, moved rather than removed.
 *
 * The trim a file needs runs about `-2.8 - peakDbfs` on speech, so 36 covers
 * everything down to roughly -39 dBFS peak. Below that a file is far more
 * likely to be a mis-decode, a wrong channel, or near-silence than a quiet
 * narrator, and it is better to under-correct it than to raise 39 dB of drive
 * onto whatever is actually in there.
 *
 * ⚠ THE MANUAL KNOB DELIBERATELY REACHES FURTHER — see INPUT_TRIM_MAX_DB. This
 * bound guards an automatic GUESS about unknown audio; that one bounds a value
 * a person typed while listening, which is a different kind of decision and
 * does not need the same caution.
 */
export const ALIGN_MAX_DB = 36

/**
 * How far the panel's Input trim can be driven by hand, dB.
 *
 * ⚠ WIDER THAN THE AUTOMATIC CLAMP, ON PURPOSE, AND THAT ASYMMETRY IS THE POINT.
 * Past about -39 dBFS peak the automatic offset saturates at ALIGN_MAX_DB and
 * Peak Reduction starts running out again — measured, a file at -55 dBFS peak
 * gets 5.34 dB at PR 100 with the clamp in force, which is the "quiet file runs
 * out of travel" failure this whole mechanism exists to remove, merely pushed
 * to the far end of the range. The automatic path should not chase that: a file
 * that quiet is more often broken than quiet. A user who has listened to it and
 * decided otherwise should not be held to the guess's caution.
 *
 * It also has to be at least ALIGN_MAX_DB, because the knob DISPLAYS the
 * measured offset — a range narrower than the measurement could produce would
 * show a value the knob cannot represent.
 */
export const INPUT_TRIM_MAX_DB = 48

/**
 * Gated RMS of one or more channels, linear.
 *
 * Channels are summed into a single mono measurement rather than measured
 * separately and averaged, matching the kernel's own mono side-chain tap — the
 * thing being aligned is what the detector sees.
 *
 * ⚠ CHANNELS ARE SUMMED THEN DIVIDED, NOT AVERAGED IN POWER, AND THE FIRST CUT
 * GOT THIS WRONG. It measured mean per-channel power — sqrt((L^2 + R^2)/2) —
 * which happens to agree with the detector for a mono file and for identical
 * L/R, and disagrees for everything else. The kernel's tap is
 * `(L + R) / nChannels` (la2aProcessor.js, "Mono sidechain tap"), so what
 * matters is the SUM: correlated content reinforces and opposed content
 * cancels, exactly as it does in the detector.
 *
 * Measured on the two cases that separate them: a stereo file with one dead
 * channel read 3.01 dB hot, and a polarity-flipped pair read -16.62 dBFS where
 * the detector sees digital silence. The first is an ordinary recording — one
 * mic into a stereo file — not a contrived one.
 *
 * ⚠ AND A DUPLICATED-CHANNEL TEST CANNOT CATCH THIS. `[x, x]` is precisely the
 * case where the two formulations agree, so the original test passed while the
 * measurement was wrong. The regressions that matter are opposed and unequal
 * channels; both are pinned in `test/dsp/inputAlign.test.js`.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {number} linear RMS, or 0 for empty input
 */
export function gatedRmsOfChannels(channels, sampleRate) {
  if (!channels || channels.length === 0) return 0
  const n = channels[0].length
  if (n === 0) return 0
  const full = Math.max(1, Math.round(sampleRate * ALIGN_BLOCK_MS / 1000))
  // Shorter than one block: there is no distribution to gate against, so the
  // gate would be measuring its own single sample. Measure the lot as one block
  // instead — `regionAlignDb` applies the SAME fallback, and the two disagreeing
  // here was a real defect (see there).
  const block = n >= full ? full : n
  const nBlocks = Math.floor(n / block)

  const blockRms = new Float64Array(nBlocks)
  for (let b = 0; b < nBlocks; b++) {
    blockRms[b] = monoRms(channels, b * block, block)
  }
  const gated = gatedRmsFromBlocks(blockRms)
  // Everything gated out — a silent or DC region.
  return gated > 0 ? gated : monoRms(channels, 0, nBlocks * block)
}

/**
 * The gate itself, over per-block RMS values. Returns the RMS of the blocks
 * that survive it, or 0 if none do.
 *
 * ⚠ SPLIT OUT SO THERE IS EXACTLY ONE GATE. Two callers reach it from opposite
 * directions — `gatedRmsOfChannels` has the samples in hand, `regionAlignDb`
 * walks an edited timeline segment by segment and never materialises them — and
 * a gate implemented once per caller is a gate that drifts. The two agreeing is
 * what makes the panel's read-out and the kernel's offset the same number.
 *
 * Energy is reconstructed from the block RMS values rather than re-read from
 * the samples: every block holds the same sample count, so the mean of the
 * squares is the mean of the kept blocks' squares exactly, with no second pass.
 *
 * @param {ArrayLike<number>} blockRms
 * @returns {number}
 */
export function gatedRmsFromBlocks(blockRms) {
  const n = blockRms.length
  if (n === 0) return 0
  const sorted = Float64Array.from(blockRms).sort()
  const ref = sorted[Math.min(n - 1, Math.max(0, Math.round(0.95 * (n - 1))))]
  const threshold = ref * Math.pow(10, -ALIGN_GATE_RANGE_DB / 20)

  let sum = 0
  let count = 0
  for (let b = 0; b < n; b++) {
    if (blockRms[b] <= threshold) continue
    sum += blockRms[b] * blockRms[b]
    count++
  }
  return count > 0 ? Math.sqrt(sum / count) : 0
}

/**
 * The offset that brings a measured gated RMS to nominal, dB, clamped.
 * Shared so the two measurement paths cannot disagree about the arithmetic.
 *
 * @param {number} gatedRms linear
 * @returns {number}
 */
export function alignDbForRms(gatedRms) {
  if (!(gatedRms > 0)) return 0
  const db = ALIGN_TARGET_DBFS - 20 * Math.log10(gatedRms)
  if (!Number.isFinite(db)) return 0
  return db > ALIGN_MAX_DB ? ALIGN_MAX_DB : (db < -ALIGN_MAX_DB ? -ALIGN_MAX_DB : db)
}

/**
 * RMS of the MONO SUM over a sample range — the signal the kernel's side-chain
 * actually taps, not the mean of the channels' powers. See the note on
 * `gatedRmsOfChannels` for what the difference costs.
 */
function monoRms(channels, start, len) {
  const nCh = channels.length
  if (nCh === 0) return 0
  const end = Math.min(channels[0].length, start + len)
  if (end <= start) return 0
  let sum = 0
  for (let i = start; i < end; i++) {
    let x = 0
    for (let c = 0; c < nCh; c++) x += channels[c][i]
    x /= nCh
    sum += x * x
  }
  return Math.sqrt(sum / (end - start))
}

/**
 * The side-chain drive offset that brings this material to nominal, dB.
 *
 * ⚠ MEASURE THE WHOLE FILE, NOT THE SELECTION. Two selections in one file
 * measured separately get two different operating points, and the plugin stops
 * being one consistent process across the timeline — the same edit applied to
 * a phrase and to the paragraph containing it would compress differently.
 * Callers pass the whole file; this function cannot enforce it.
 *
 * @param {Float32Array[]} channels  whole-file audio
 * @param {number} sampleRate
 * @returns {number} offset in dB, clamped to +/-ALIGN_MAX_DB, 0 if unmeasurable
 */
export function inputAlignDbFor(channels, sampleRate) {
  return alignDbForRms(gatedRmsOfChannels(channels, sampleRate))
}
