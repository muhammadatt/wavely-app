/**
 * FET Punch (1176) factory presets.
 *
 * ⚠ IMPORTS NOTHING FROM `effects/fet1176Compressor.js` — that module reaches
 * the worklet loader and its `?worker&url` specifier, which only Vite
 * resolves, so importing it would put this whole collection out of reach of
 * `node --test`. Factory presets state every param, so there is no default to
 * inherit anyway.
 *
 * What the knobs mean, since three of them are dials rather than units:
 *
 *   INPUT DRIVE (0–100) drives the fixed internal threshold AND the audio
 *   path, so it is depth and level at once. That is why AUTO makeup matters
 *   more here than on OptoSmooth: a 20-point move swings the output by tens
 *   of dB.
 *
 *   ATTACK and RELEASE are 1–7 dials where 7 is FASTEST (20 us / 50 ms), as
 *   on the hardware. A preset asking for a slow attack asks for a LOW number.
 *
 *   SC HPF is a side-chain corner in Hz, 0 = off. It keeps a plosive or a
 *   rumble out of the detector without touching the audio.
 *
 *   MIX below 1 is parallel compression — the reason the deepest presets here
 *   are not also the loudest.
 *
 * ⚠⚠ THESE FIVE ARE CALIBRATED AGAINST A CURVE THAT NO LONGER SHIPS, AND THEY
 * HAVE NOT BEEN RE-AUDITIONED.
 *
 * `fetDrive` used to set a drive into an asymmetric `tanh`; it now scales a
 * degree-5 polynomial measured from Analog Obsession FETish, where 1 IS the
 * reference curve. The stored numbers carry across arithmetically and not in
 * voicing — the new curve is far cleaner at low level (75 dB less H2 at
 * −30 dBFS) and that is the whole reason it was adopted, so matching the old
 * distortion amount would undo the change rather than preserve the preset.
 *
 * ⚠ THEY ARE DELIBERATELY LEFT ALONE UNTIL SOMEBODY LISTENS. Re-scaling them by
 * measurement would be inventing a voicing decision, and re-voicing twice is
 * worse than once — the same reasoning that held the LA-2A presets back through
 * its taper re-fit. `FET_LEGACY_PATCH` reproduces the old kernel exactly for
 * A/B.
 *
 * ⚠ `inputDrive` DOES NOT REACH THE SHAPER, and for one release of this branch
 * it did. The curve briefly sat between the input attenuator and the cell —
 * FETish's measured topology — which on a compensated Input means a fixed drive
 * and on OUR real-gain Input meant the knob's whole travel: H2 swung 79.6 dB
 * across Input 10→90 where the reference swings 0.0. It sits ahead of the
 * attenuator now (`preInput`), so saturation is a property of the FILE'S level
 * and these presets' `inputDrive` values change compression without changing
 * colour.
 */

import { definePluginPresets } from './store.js'

export const FET_PUNCH_PRESET_PLUGIN = 'fet-punch'

const OUTPUT_MIN_DB = -36
const OUTPUT_MAX_DB = 24
const RATIOS = ['4', '8', '12', '20', 'all']

function clamp(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return n < lo ? lo : n > hi ? hi : n
}

/**
 * ⚠ THE OUTPUT IS CANONICALISED TO 0 WHILE AUTO IS ON — see the same note on
 * OptoSmooth. It matters more here: Input drives the audio path as well as the
 * detector, so the measured makeup moves by tens of dB across that knob's
 * travel and a preset stating an output would be stale immediately.
 */
function normalize(params) {
  const autoMakeup = params.autoMakeup !== false
  return {
    inputDrive: clamp(params.inputDrive ?? 50, 0, 100),
    output: autoMakeup ? 0 : clamp(params.output ?? 0, OUTPUT_MIN_DB, OUTPUT_MAX_DB),
    // Dials, so they round: a stored 4.5 is not a position this control has.
    attack: Math.round(clamp(params.attack ?? 4, 1, 7)),
    release: Math.round(clamp(params.release ?? 4, 1, 7)),
    // An unrecognised ratio falls back to the stock position rather than
    // reaching the kernel — the kernel's own guard would drop it silently.
    ratio: RATIOS.includes(String(params.ratio)) ? String(params.ratio) : '4',
    // ⚠ The fallback tracks the kernel's default, which moved to 1 with the
    // measured curve. Factory presets all state `fetDrive` explicitly, so this
    // only catches a stored preset that predates the key.
    fetDrive: clamp(params.fetDrive ?? 1, 0, 1),
    scHpf: clamp(params.scHpf ?? 0, 0, 500),
    mix: clamp(params.mix ?? 1, 0, 1),
    autoMakeup,
  }
}

export const FET_PUNCH_PARAM_KEYS = [
  'inputDrive', 'output', 'attack', 'release', 'ratio', 'fetDrive', 'scHpf', 'mix', 'autoMakeup',
]

/**
 * ⚠⚠ RE-CUT AGAINST THE MEASURED KERNEL. These dials are NOT the ones that
 * shipped, and the numbers moved because the kernel under them did — five
 * changes, none of them reachable from a patch:
 *
 *   1. `IN_DRIVE_SPAN_DB` 40 -> 48, so every Input position means more drive
 *   2. release endpoints 1.1 / 0.05 s -> 0.7288 / 0.03318, every dial 1.51x faster
 *   3. `releaseSchedule: 'depth'`, so the constant scales with reduction
 *   4. `attackSchedule: 'depth'`, likewise on the attack
 *   5. the knee: four per-button constants -> one drive law
 *
 * ⚠ THE TARGET WAS WHAT EACH PRESET DID WHEN IT WAS CUT, NOT A NEW VOICING.
 * Left alone, the same dials had drifted by +1.72 / +2.13 / -0.68 / +7.82 dB of
 * average gain reduction on narration — so doing nothing was itself a
 * re-voicing, and a silent one. `scripts/fet-recut-presets.mjs` re-derives them
 * against the as-cut kernel (commit 57e1877) and is the record of how; run it
 * again if any of those five constants moves.
 *
 * ⚠ THE DIALS ARE INTEGERS AND THE SOLVE IS NOT, so attack and release land on
 * the nearest position. Residuals at each preset's own working depth: attack
 * -0 / +23 / +36 / +22 %, release +19 / +31 / -26 / -21 %. Two presets sit at
 * the END of a dial's travel (gentle-ride's release, parallel-thickener's
 * attack and release) where the old voicing is not reachable at all and the
 * residual is a floor rather than a rounding.
 *
 * ⚠ `output` IS NOT RE-CUT AND MUST NOT BE. It is canonicalised to 0 while AUTO
 * is on and solved per file, so the percentile-makeup change needs no preset
 * edit — see `normalize`.
 *
 * ⚠ `factory:all-buttons-in` WAS RE-CUT LAST, in a second pass, because its law
 * had to be measured first. It held its original dials while `ALL_KNEE_DB`,
 * `ALL_THRESHOLD_DROP_DB`, the slope law and `ALL_ATTACK_LAG` were guesses; all
 * four are now fitted against CLA-76 from the captures already taken
 * (`npm run fet:allrefit`), so it is cut to the same target as the others.
 *
 * ⚠ `consonant-control` and `parallel-thickener` were ALSO re-cut twice — once
 * against the measured kernel, and again when the moving ratio threshold
 * shipped and re-voiced every patch on 8 / 12 / 20.
 */
export const FET_PUNCH_PRESETS = [
  {
    id: 'factory:vocal-punch',
    name: 'Vocal Punch',
    description: '4:1, medium ballistics. The one to reach for first.',
    params: {
      inputDrive: 46,
      output: 0,
      attack: 5,
      release: 3,
      ratio: '4',
      fetDrive: 0.35,
      scHpf: 0,
      mix: 1,
      autoMakeup: true,
    },
  },
  {
    id: 'factory:consonant-control',
    name: 'Consonant Control',
    description: '8:1 with a fast attack and the lows out of the detector.',
    params: {
      // ⚠ 53 -> 57 WHEN THE MOVING THRESHOLD SHIPPED. This preset is on 8:1, so
      // its threshold rose 1.71 dB and it needed the Input back to deliver what
      // it was cut for.
      inputDrive: 57,
      output: 0,
      // Fast enough to catch a consonant rather than ride behind it, with the
      // side-chain high-passed at 120 Hz so the fundamental is not what sets
      // the gain reduction.
      attack: 6,
      release: 4,
      ratio: '8',
      fetDrive: 0.3,
      scHpf: 120,
      mix: 1,
      autoMakeup: true,
    },
  },
  {
    id: 'factory:gentle-ride',
    name: 'Gentle Ride',
    description: 'Slow attack, low drive — onsets pass, the body steadies.',
    params: {
      inputDrive: 35,
      output: 0,
      /**
       * A LOW attack number is a SLOW attack. Letting the onset through is the
       * whole point: this is the setting that keeps a narrator's diction while
       * taking the swing out of the phrase underneath it.
       *
       * ⚠ DIAL 3 IS A JUDGEMENT, NOT THE ARITHMETIC'S ANSWER. The re-cut's
       * combined score preferred 4; at their own settled operating points the
       * two straddle the old 0.433 ms constant almost symmetrically (dial 3
       * +36 %, dial 4 -28 %), and dial 3 is both marginally closer in log terms
       * AND errs on the SLOW side — which is what "onsets pass" asks for. A
       * preset that exists to let transients through should miss slow.
       */
      attack: 3,
      release: 1,
      ratio: '4',
      fetDrive: 0.2,
      scHpf: 80,
      mix: 1,
      autoMakeup: true,
    },
  },
  {
    id: 'factory:parallel-thickener',
    name: 'Parallel Thickener',
    description: '12:1 squashed hard and blended under the dry signal.',
    params: {
      // Deep and fast, then mixed back at 40%: the wet path is doing something
      // that would be unusable on its own, which is what parallel is for.
      //
      // ⚠ 75 -> 47 IS THE LARGEST MOVE IN THE RE-CUT and it is the Input span
      // change, not a re-voicing: at the old span this patch delivered 6.54 dB
      // of average reduction and at the new one the same 75 delivered 14.36.
      // ⚠ THEN 47 -> 53 WHEN THE MOVING THRESHOLD SHIPPED — on 12:1 the
      // threshold rose 2.71 dB, so the Input had to come back to match.
      inputDrive: 53,
      output: 0,
      attack: 7,
      release: 7,
      ratio: '12',
      fetDrive: 0.5,
      scHpf: 100,
      mix: 0.4,
      autoMakeup: true,
    },
  },
  {
    id: 'factory:all-buttons-in',
    name: 'All Buttons In',
    description: 'The 1176 stunt setting, kept usable by the Mix knob.',
    params: {
      // ⚠ RE-CUT LAST, AND ONLY ONCE ITS LAW WAS MEASURED. This sat on the
      // original dials on purpose while `ALL_KNEE_DB`, `ALL_THRESHOLD_DROP_DB`,
      // the slope triple and `ALL_ATTACK_LAG` had no captures behind them —
      // correcting a preset against a guess would have dressed it as a fit.
      // `fet:allrefit` fitted all five against CLA-76, so this is now re-cut to
      // what it DID when it was cut: 70 -> 55, avg GR 9.77 -> 9.63 dB.
      // ⚠ Both ballistics dials sit at the end of their travel, so their
      // residuals (-23 % attack, +56 % release) are a floor, not a rounding —
      // `ALL_ATTACK_LAG` going 2.5 -> 1 moved the attack out of reach at dial 7.
      inputDrive: 55,
      output: 0,
      attack: 7,
      release: 7,
      ratio: 'all',
      fetDrive: 0.6,
      scHpf: 0,
      // Half wet. All-buttons-in is a distortion and ballistics effect more
      // than a compressor, and at Mix 1 it is a texture rather than a
      // treatment — which is not what a narration plugin should default to
      // when someone presses a preset out of curiosity.
      mix: 0.5,
      autoMakeup: true,
    },
  },
]

/**
 * Registration is a named function AND is called on import.
 *
 * Called on import because the registry has to answer the same way whatever
 * order the user opened windows in. Named because the store is a module-level
 * registry and a test that resets it needs a way to put the shipping
 * collection back — without one, the first test to reset would silently
 * un-register this plugin for every test after it.
 */
export function registerFetPunchPresets() {
  return definePluginPresets({
    pluginId: FET_PUNCH_PRESET_PLUGIN,
    paramKeys: FET_PUNCH_PARAM_KEYS,
    factory: FET_PUNCH_PRESETS,
    normalize,
  })
}

registerFetPunchPresets()
