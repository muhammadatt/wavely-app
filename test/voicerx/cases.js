/**
 * The corpus: every case the scorecard scores, and why each family is here.
 *
 * Families exist so a failure has an address. "Detection rate 0.75" says
 * nothing actionable; "detection rate 1.0 everywhere except `resonance`, which
 * misses everything between 1.2 and 2.5 kHz" points at a region table.
 *
 * Frequencies are chosen to land inside each of the nine regions AND on the
 * boundaries between them, because a defect straddling two regions is the case
 * the merge step exists for and the case it is most likely to get wrong.
 */

/** Frequencies covering every region and the seams between them. */
const SWEEP_HZ = [180, 300, 450, 700, 1000, 1500, 2000, 3000, 4500, 7000, 11000]

function resonanceCases() {
  const cases = []
  for (const freqHz of SWEEP_HZ) {
    for (const gainDb of [6, 12]) {
      cases.push({
        name: `resonance ${freqHz}Hz +${gainDb}dB`,
        family: 'resonance',
        defects: [{ freqHz, gainDb, q: 3.0 }],
      })
    }
  }
  // Width sweep at one frequency. Q is measured, not assumed, so a detector
  // that reports the right centre with the wrong width is correcting the wrong
  // amount of spectrum — and a very wide defect is where a local baseline is
  // most likely to absorb the thing it is supposed to be measuring against.
  for (const q of [1.0, 2.0, 5.0, 8.0]) {
    cases.push({
      name: `resonance 1000Hz +9dB Q${q}`,
      family: 'resonance-width',
      defects: [{ freqHz: 1000, gainDb: 9, q }],
    })
  }
  return cases
}

/**
 * Shallow deficiencies — the correctable kind.
 *
 * Deliberately separate from `notch`. A 6 dB dip is something a corrective EQ
 * should fill; a 20 dB one is a hole, and the right response is to report it
 * rather than to spend 20 dB of boost on it. A detector that treats them alike
 * is wrong in one direction or the other, and splitting the families is what
 * makes which one visible.
 */
function deficiencyCases() {
  return [200, 400, 900, 1600, 2500, 5000, 9000].map(freqHz => ({
    name: `deficiency ${freqHz}Hz -6dB`,
    family: 'deficiency',
    defects: [{ freqHz, gainDb: -6, q: 2.0 }],
  }))
}

/**
 * Deep notches — the failure that started this.
 *
 * `defects` is empty on purpose even though something was applied. There is no
 * correct correction here: the expected behaviour is an advisory and NO bands,
 * so every band a detector emits scores as spurious. That is the whole point —
 * the original bug was two large phantom cuts either side of a notch, and this
 * family measures exactly that.
 */
function notchCases() {
  const cases = []
  for (const freqHz of [800, 2000, 5000]) {
    for (const depthDb of [15, 20]) {
      cases.push({
        name: `notch ${freqHz}Hz -${depthDb}dB`,
        family: 'notch',
        defects: [],
        applied: [{ freqHz, gainDb: -depthDb, q: 1.2 }],
      })
    }
  }
  return cases
}

/**
 * Clean voices whose bandwidth ends at various places.
 *
 * No defects, so anything reported is invented. This family exists because a
 * bandwidth edge is a discontinuity a baseline cannot represent, exactly like a
 * notch is, and a detector that handles one but not the other has a special
 * case rather than a mechanism. 9 kHz is roughly a low-bitrate MP3; 20 kHz is
 * an unprocessed 44.1 kHz capture.
 */
function bandwidthCases() {
  return [9000, 11000, 14000, 16000, 20000].map(bandwidthHz => ({
    name: `bandwidth ${bandwidthHz}Hz`,
    family: 'bandwidth',
    voice: { bandwidthHz },
    defects: [],
  }))
}

/** Clean controls across voice type and noise floor. Any band is a false positive. */
function cleanCases() {
  return [
    { name: 'clean male', family: 'clean', voice: {}, defects: [] },
    { name: 'clean deep male', family: 'clean', voice: { f0Hz: 95 }, defects: [] },
    { name: 'clean female', family: 'clean', voice: { f0Hz: 210, formantScale: 1.17 }, defects: [] },
    { name: 'clean quiet room', family: 'clean', voice: { snrDb: 60 }, defects: [] },
    { name: 'clean noisy room', family: 'clean', voice: { snrDb: 30 }, defects: [] },
  ]
}

/**
 * More than one thing wrong at once, which is the normal case in real audio.
 *
 * Tests that corrections do not interfere: finding a 700 Hz resonance must not
 * depend on there being nothing else wrong, and correcting it must not create a
 * phantom somewhere else.
 */
function combinedCases() {
  return [
    {
      name: 'combined boxy + harsh',
      family: 'combined',
      defects: [
        { freqHz: 500, gainDb: 8, q: 2.5 },
        { freqHz: 3200, gainDb: 7, q: 3.5 },
      ],
    },
    {
      name: 'combined thin + sibilant',
      family: 'combined',
      defects: [
        { freqHz: 220, gainDb: -7, q: 2.0 },
        { freqHz: 6500, gainDb: 9, q: 3.0 },
      ],
    },
    {
      name: 'combined muddy + nasal + dull',
      family: 'combined',
      defects: [
        { freqHz: 320, gainDb: 7, q: 2.5 },
        { freqHz: 950, gainDb: 8, q: 3.0 },
        { freqHz: 8000, gainDb: -6, q: 1.5 },
      ],
    },
  ]
}

/** The same defect through worsening noise. Detection should degrade gracefully. */
function noiseCases() {
  return [20, 25, 35].map(snrDb => ({
    name: `noise ${snrDb}dB SNR`,
    family: 'noise',
    voice: { snrDb },
    defects: [{ freqHz: 900, gainDb: 10, q: 3.0 }],
  }))
}

/**
 * Short selections.
 *
 * A user drags a two-second selection and presses Analyze. The honest answers
 * are a correct finding or a refusal; the wrong answer is a confident finding
 * from too little data. `analysisFailures` counts refusals separately from
 * misses so the two do not blur together in the detection rate.
 */
function durationCases() {
  return [3, 1.5, 0.8].map(seconds => ({
    name: `duration ${seconds}s`,
    family: 'duration',
    voice: { seconds },
    defects: [{ freqHz: 900, gainDb: 10, q: 3.0 }],
  }))
}

export const CASES = [
  ...cleanCases(),
  ...resonanceCases(),
  ...deficiencyCases(),
  ...notchCases(),
  ...bandwidthCases(),
  ...combinedCases(),
  ...noiseCases(),
  ...durationCases(),
]

/**
 * The subset the committed regression test runs.
 *
 * The full corpus takes about a minute, which does not belong in every
 * `npm test`. Six cases is roughly six seconds, and they are chosen for signal
 * rather than for coverage — each one pins a behaviour that is currently
 * interesting, including the ones that currently FAIL. A regression guard whose
 * cases all pass can only report news you already have; these will also tell
 * you when something broken starts working.
 *
 *   clean male           must stay silent — the false-positive canary
 *   resonance 700Hz      must be found — the basic competence check
 *   resonance 2000Hz     currently MISSED — the dip-only region blind spot
 *   notch 5000Hz         holes guard fires here
 *   notch 800Hz          holes guard does NOT fire here, two phantom cuts
 *   bandwidth 9000Hz     invents a correction on a clean voice
 *
 * These are the same case definitions the full corpus uses, not shortened
 * variants, so a smoke number and a full-corpus number mean the same thing.
 */
export const SMOKE_CASES = CASES.filter(c => [
  'clean male',
  'resonance 700Hz +12dB',
  'resonance 2000Hz +12dB',
  'notch 5000Hz -20dB',
  'notch 800Hz -20dB',
  'bandwidth 9000Hz',
].includes(c.name))
