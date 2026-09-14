#!/usr/bin/env node
/**
 * FET Punch — read the null-test captures.
 *
 *   npm run fet:null
 *
 * Step 1 of `docs/fet1176_capture_protocol.md`. Four bounces per reference
 * (five for FETish), and they can disqualify a reference or show a control is
 * not what it says, before the other 35-40 are spent.
 *
 * ⚠ THIS SCRIPT MEASURES THE GAIN REDUCTION ITSELF RATHER THAN TRUSTING THE
 * PLUGIN'S METER. The protocol asks you to log the meter reading, and that log
 * is worth keeping — but a meter is a rendering of a number we can compute from
 * the capture directly, and the two disagreeing is itself informative.
 *
 * EXPECTED FILES in `data/corpus/fet1176/captures/`. Anything missing is
 * reported and skipped; partial runs are fine and expected.
 *
 *   null1_<ref>.wav   thd.wav    Input low enough for 0 GR, Output at default
 *   null2_<ref>.wav   thd.wav    as null1, Output raised 10 dB
 *   null3_<ref>.wav   thd.wav    Input up for ~10 dB of GR
 *   null4_<ref>.wav   stairs.wav ratio 4, mid Input — the "is it in circuit" check
 *   null5_<ref>.wav   thd.wav    FETish only: a SECOND Input position, still 0 GR
 *
 * `<ref>` is free-form (`fetish`, `cla76`, `cla76_bluey`, …) and is only used
 * to group the report.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT EACH COMPARISON ANSWERS
 *
 *   null1 alone        Insertion gain, and whether anything is nonlinear with NO
 *                      gain reduction. If the gain is constant across the five
 *                      tone levels, the no-compression path is linear.
 *
 *   null2 vs null1     Is Output a clean multiply, or does it drive a stage?
 *                      The gain difference should be the 10 dB you dialled. If
 *                      THD rises with it, Output feeds a nonlinearity — which we
 *                      do not model, and `fetDrive` cannot be fitted from that
 *                      reference.
 *
 *   null3 vs null1     ⚠ THE ONE THAT MATTERS. Distortion against dB of GAIN
 *                      REDUCTION, not against input level. THD vs level cannot
 *                      tell a gain-cell nonlinearity from an output-amp one;
 *                      THD vs GR can. On the LA-2A the answer turned out to be
 *                      the cell, after two years of a model that put it in the
 *                      valves.
 *
 *   null4              Sanity. A capture bit-identical to the stimulus means the
 *                      plugin was bypassed or the bounce exported the source —
 *                      which reads downstream as "no compression", i.e. exactly
 *                      like "the Input knob is too low".
 *
 *   null5 vs null1     ⚠ THE MOST VALUABLE SINGLE BOUNCE IN THE PROTOCOL.
 *                      FETish's manual says its Input is internally compensated:
 *                      "you don't have to reduce volume while you boost input".
 *                      If that holds, its Input is a DRIVE OFFSET, not an input
 *                      gain — the opposite of ours and of the hardware's, where
 *                      Input feeds the audio path as well as the detector. Same
 *                      output level at both positions = compensated. A level
 *                      that rises with the knob = the manual is wrong, and
 *                      FETish becomes a full reference for the Input law after
 *                      all. Either answer reshapes the matrix.
 */

import { readdirSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { readCapture, isUnprocessed, alignByEnvelope, preflight, windowRmsDb } from './lib/probeCapture.js'
import { harmonicsAt, compareToFloor, formatDbc, harmonicBalance } from './lib/harmonics.js'
import { buildProbe } from './lib/probeStimulus.js'
import { readWav } from './lib/wav.js'
import { writeFloatWav } from './lib/wav.js'
import { STIM_DIR, CAP_DIR, PLANS, runKernel } from './fet-ballistics.mjs'

/**
 * Where captures are read from. `--dir` overrides it, which is what
 * `--selftest` uses to run the whole report against synthetic captures without
 * putting anything in the real corpus.
 */
let capDir = CAP_DIR

const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))

/** Which stimulus each null bounce used. */
const USES = { null1: 'thd.wav', null2: 'thd.wav', null3: 'thd.wav', null4: 'stairs.wav', null5: 'thd.wav' }

/**
 * Skip the first part of each tone — the compressor is still settling, and on
 * null3 that settling IS gain reduction arriving. Skip a little off the tail so
 * a mute edge or a release cannot clip into the window.
 */
const TONE_SKIP_HEAD_S = 0.8
const TONE_SKIP_TAIL_S = 0.2

function discover() {
  if (!existsSync(capDir)) return []
  return readdirSync(capDir)
    .filter(f => /^null[1-5]_.+\.wav$/i.test(f))
    .sort()
}

/**
 * Per-tone readings for a thd.wav capture: the level the plugin delivered, the
 * gain it applied, and the harmonics.
 */
function readToneCapture(file, plan, stim, sampleRate) {
  const { y } = readCapture(join(capDir, file), sampleRate)
  const pre = preflight(file, y, plan, stim.env, sampleRate)
  const bypassed = isUnprocessed(y, stim.x)
  const lag = alignByEnvelope(stim.env, y, sampleRate)

  const tones = []
  for (const ev of plan.events) {
    const from = Math.round((ev.up + TONE_SKIP_HEAD_S) * sampleRate) + lag
    const to = Math.round((ev.down - TONE_SKIP_TAIL_S) * sampleRate) + lag
    if (to <= from || to > y.length) { tones.push({ ev, missing: true }); continue }
    if (pre.gaps.some(([g0, g1]) => to / sampleRate >= g0 && from / sampleRate <= g1)) {
      tones.push({ ev, muted: true }); continue
    }
    const h = harmonicsAt(y, from, to - from, sampleRate, ev.freqHz)
    // The stimulus's own harmonics over the SAME window — the real floor.
    const hs = harmonicsAt(stim.x, from - lag, to - from, sampleRate, ev.freqHz)
    const { usable, unrendered } = compareToFloor(h, hs)
    // Gain the plugin applied to this tone, broadband rather than at one bin.
    const outDb = windowRmsDb(y, from, to)
    const inDb = windowRmsDb(stim.x, from - lag, to - lag)
    tones.push({ ev, h, hs, usable, unrendered, gainDb: outDb - inDb, outDb, inDb })
  }
  return { file, lag, bypassed, pre, tones }
}

/**
 * ⚠ BIT-IDENTICAL DOES NOT ALWAYS MEAN BYPASSED, AND THE SELF-TEST CAUGHT THIS
 * READER CALLING IT THAT.
 *
 * The check is right in general — a real plugin's output stage changes
 * SOMETHING even at unity — but a reference with no output stage, at a setting
 * with no gain reduction and no makeup, can genuinely return its input. Our own
 * kernel does exactly that at `fetDrive: 0`, and the first version of this
 * script flagged two synthetic captures as bypassed when the synthetic plugin
 * was demonstrably working: null4, from the same "plugin", showed 11.23 dB of
 * reduction in the same run.
 *
 * `null4` is the disambiguator, which is what it is in the matrix for. It sits
 * at a compressing setting, so if IT shows reduction the plugin is in circuit
 * and a transparent null1 is a finding rather than a fault.
 */
function reportToneCapture(r, sampleRate, inCircuit) {
  for (const line of r.pre.lines) console.log(line)
  console.log(`   lag ${r.lag} samples (${(1000 * r.lag / sampleRate).toFixed(2)} ms)` +
    ' — envelope-aligned, ~±12 samples; ample for a 0.8 s window inside a 3 s tone')
  if (r.bypassed) {
    if (inCircuit === true) {
      console.log(`\n   ${r.file} is BIT-IDENTICAL to the stimulus — but null4 shows the plugin`)
      console.log('   compressing, so it is in circuit. At this setting the reference is simply')
      console.log('   TRANSPARENT: no gain reduction, no makeup, and no output stage to colour it.')
      console.log('   That is a finding about the reference, not a bad bounce.')
    } else {
      console.log(`\n⚠⚠ ${r.file} IS BIT-IDENTICAL TO THE STIMULUS.`)
      console.log('   The plugin was bypassed, or the bounce exported the source track. Every')
      console.log('   reading below would say "no compression", which looks exactly like "the')
      console.log('   Input knob is too low".')
      console.log(inCircuit === false
        ? '   null4 is bit-identical too, which settles it. Re-bounce.'
        : '   ⚠ No null4 in this set, so there is nothing to tell a bypass from a genuinely')
      if (inCircuit !== false) console.log('   transparent setting. Bounce null4 before trusting this run.')
    }
    return
  }
  console.log('\n   tone      in      out     gain      H2      H3      H4      H5     THD%')
  for (const t of r.tones) {
    if (t.missing) { console.log(`   ${t.ev.tag.padEnd(9)} — outside the capture —`); continue }
    if (t.muted) { console.log(`   ${t.ev.tag.padEnd(9)} — demo mute in the window, skipped —`); continue }
    console.log(
      `   ${t.ev.tag.padEnd(9)}` +
      `${t.inDb.toFixed(1).padStart(6)}  ${t.outDb.toFixed(1).padStart(6)}  ` +
      `${(t.gainDb >= 0 ? '+' : '') + t.gainDb.toFixed(2).padStart(6)}  ` +
      `${formatDbc(t.h, t.usable)}  ${t.h.thdPct.toFixed(3).padStart(7)}` +
      `${t.unrendered ? '   clean' : ''}`)
    if (t.h.driftWarning) console.log(`     ⚠ ${t.h.driftWarning}`)
  }
  console.log('   (flr) = below the stimulus tone\'s own harmonic at that order — not a reading.')
  console.log('   clean = no harmonic above the stimulus\'s own. Legitimate for a transparent')
  console.log('           setting; suspicious only if EVERY tone of EVERY capture reads it.')
}

/** Is the gain the same at every tone level? That is the linearity question. */
function gainSpread(r) {
  const g = r.tones.filter(t => t.h && Number.isFinite(t.gainDb)).map(t => t.gainDb)
  if (g.length < 2) return null
  return { lo: Math.min(...g), hi: Math.max(...g), spread: Math.max(...g) - Math.min(...g), mean: g.reduce((a, b) => a + b) / g.length }
}

/**
 * THD is read from every tone, floor flags notwithstanding: a harmonic sitting
 * at the stimulus's own floor is around −150 dBc and contributes nothing to the
 * sum. ⚠ An earlier version filtered those tones OUT and returned NaN for a
 * transparent capture, which propagated into the verdicts as "THD moved NaN
 * points" — the floor flags belong in the per-harmonic display, not in the
 * aggregate.
 */
function maxThd(r) {
  const v = r.tones.filter(t => t.h).map(t => t.h.thdPct)
  return v.length ? Math.max(...v) : null
}

/** Every tone's harmonics at the stimulus floor — nothing measurable here. */
function allClean(r) {
  const t = r.tones.filter(x => x.h)
  return t.length > 0 && t.every(x => x.unrendered)
}

/**
 * Gain reduction WITHIN one capture, relative to its own open gain.
 *
 * ⚠ THIS IS NOT THE DIFFERENCE BETWEEN TWO CAPTURES' MEAN GAINS, and the first
 * version of this script made exactly that mistake: it compared null3's mean
 * gain against null1's and reported "−22.63 dB of measured GR" on a synthetic
 * reference whose real reduction was 11.0 dB. The two captures sit at different
 * Input positions, so their difference is insertion gain PLUS reduction, and
 * the headline number of the most important comparison in the protocol was
 * wrong by the insertion gain.
 *
 * The open gain is the gain at the QUIETEST tone, which is below threshold at
 * any Input position the null test uses. Reduction is measured down from it,
 * inside one capture, so nothing about the Input knob enters.
 */
function grWithinCapture(r) {
  const t = r.tones.filter(x => x.h && Number.isFinite(x.gainDb))
  if (t.length < 2) return null
  const open = t[0].gainDb                       // quietest tone, cell resting
  return t.map(x => ({ tag: x.ev.tag, grDb: open - x.gainDb, thdPct: x.h.thdPct }))
}

/**
 * The static distortion law: log10(THD%) against OUTPUT level in dBFS, fitted
 * from a capture with no gain reduction anywhere in it.
 *
 * ⚠ THIS EXISTS BECAUSE THE FIRST VERSION OF THE null3 VERDICT WAS WRONG, AND
 * WRONG IN THE EXACT WAY THIS WHOLE PROTOCOL IS BUILT TO AVOID.
 *
 * On `thd.wav` the loudest tones are also the most compressed, so within one
 * capture LEVEL AND GAIN REDUCTION RISE TOGETHER AND CANNOT BE SEPARATED. The
 * reader compared THD at 0 dB of GR against THD at 8 dB and announced
 * "distortion rises with compression — the nonlinearity lives with the gain
 * cell". On the first real capture (Waves CLA-76, Blacky) that was false: the
 * law fitted from null1, where NOTHING is compressing, predicts every null3
 * tone to within 0.9 % — including the ones with 8.2 dB of reduction. The
 * distortion is a function of output level alone and the gain cell contributes
 * nothing measurable.
 *
 * So null3 is read as a RESIDUAL against null1's law, at matched output level.
 * That is the control the comparison needed, and without it a level effect gets
 * attributed to compression — which would have fitted `fetDrive` to a
 * mechanism that is not there.
 */
function staticThdLaw(r) {
  const t = r.tones.filter(x => x.h && x.h.thdPct > 0)
  if (t.length < 3) return null
  /**
   * ⚠ A REFERENCE WITH NO STATIC DISTORTION HAS NO LAW, and fitting one anyway
   * divides by nothing. Our own kernel at `fetDrive: 0` reads THD of 0.0000 %
   * at every level in null1; the regression through five zeros then predicted
   * ~0, and null3's 0.02 % came back as a residual of **2,895,331 %**, which
   * is a divide-by-zero wearing a percentage sign. When null1 is at the floor
   * the honest statement is that there is nothing to control against.
   */
  if (Math.max(...t.map(x => x.h.thdPct)) < 0.005) return { degenerate: true }
  const X = t.map(x => x.h.fundamentalDbfs), Y = t.map(x => Math.log10(x.h.thdPct))
  const n = X.length
  const sx = X.reduce((a, b) => a + b, 0), sy = Y.reduce((a, b) => a + b, 0)
  const sxx = X.reduce((a, b) => a + b * b, 0)
  const sxy = X.reduce((a, b, i) => a + b * Y[i], 0)
  const m = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  const c = (sy - m * sx) / n
  // How well the line describes its own data — a curved law would show here.
  const worst = Math.max(...X.map((x, i) => Math.abs(Math.pow(10, m * x + c) / t[i].h.thdPct - 1)))
  return { m, c, worst, loDb: Math.min(...X), hiDb: Math.max(...X), predict: outDb => Math.pow(10, m * outDb + c) }
}

function main() {
  const files = discover()
  if (!files.length) {
    console.log(`\nNo null-test captures in ${capDir}\n`)
    console.log('Expected names (see docs/fet1176_capture_protocol.md, Step 1):')
    for (const [k, v] of Object.entries(USES)) console.log(`  ${k}_<ref>.wav   from ${v}`)
    console.log('\nRun `npm run fet:stimulus` first if the stimulus is not written yet.\n')
    return
  }

  // Plans and their rendered stimulus, at the rate the WAVs on disk are at.
  const stimRate = readWav(join(STIM_DIR, 'thd.wav')).sampleRate
  console.log(`\nFET Punch null test — stimulus at ${stimRate} Hz, ${files.length} capture(s)\n`)

  const byRef = new Map()
  for (const f of files) {
    const [, which, ref] = f.match(/^(null[1-5])_(.+)\.wav$/i)
    if (!byRef.has(ref)) byRef.set(ref, {})
    byRef.get(ref)[which] = f
  }

  for (const [ref, set] of byRef) {
    console.log('═'.repeat(78))
    console.log(`REFERENCE: ${ref}`)
    console.log('═'.repeat(78))

    const results = {}

    // ⚠ null4 IS READ FIRST, because every other capture's bypass verdict
    // depends on it — see reportToneCapture.
    let inCircuit = null
    if (set.null4) {
      console.log(`\n── null4  (${set.null4}) — is the plugin in circuit?`)
      const { plan, stim } = rendered(USES.null4, stimRate)
      try {
        const { y } = readCapture(join(capDir, set.null4), stimRate)
        const pre = preflight(set.null4, y, plan, stim.env, stimRate)
        for (const line of pre.lines) console.log(line)
        if (isUnprocessed(y, stim.x)) {
          inCircuit = false
          console.log('\n⚠⚠ BIT-IDENTICAL TO THE STIMULUS — bypassed, or the bounce exported the')
          console.log('   source track. Fix this before reading anything else in this run.')
        } else {
          const lag = alignByEnvelope(stim.env, y, stimRate)
          let deepest = 0, deepestTag = ''
          for (const ev of plan.events) {
            const from = Math.round((ev.down - 0.3) * stimRate) + lag
            const to = Math.round((ev.down - 0.05) * stimRate) + lag
            if (to > y.length || to <= from) continue
            if (pre.gaps.some(([g0, g1]) => to / stimRate >= g0 && from / stimRate <= g1)) continue
            const g = windowRmsDb(y, from, to) - windowRmsDb(stim.x, from - lag, to - lag)
            if (-g > deepest) { deepest = -g; deepestTag = ev.tag }
          }
          inCircuit = deepest > 0.5
          console.log(`   in circuit ✓ — deepest settled reduction ${deepest.toFixed(2)} dB, at ${deepestTag}`)
          console.log('   (relative to the open gain; an absolute insertion trim does not affect this)')
          if (!inCircuit) {
            console.log('   ⚠ but under 0.5 dB of reduction at any step. Either the Input is far too')
            console.log('     low, or something upstream is not reaching the plugin.')
          }
        }
      } catch (e) {
        console.log(`   ⚠ ${e.message}`)
      }
    } else {
      console.log('\n── null4 missing — nothing to tell a bypass from a transparent setting.')
    }

    for (const which of ['null1', 'null2', 'null3', 'null5']) {
      if (!set[which]) continue
      const { plan, stim } = rendered(USES[which], stimRate)
      console.log(`\n── ${which}  (${set[which]})`)
      try {
        const r = readToneCapture(set[which], plan, stim, stimRate)
        results[which] = r
        reportToneCapture(r, stimRate, inCircuit)
      } catch (e) {
        console.log(`   ⚠ ${e.message}`)
      }
    }

    // ── The comparisons ────────────────────────────────────────────────────
    console.log(`\n── VERDICTS for ${ref}`)

    const g1 = results.null1 && gainSpread(results.null1)
    if (g1) {
      const lin = g1.spread < 0.1
      console.log(`\n  Insertion gain at zero GR: ${g1.mean.toFixed(2)} dB, spread ${g1.spread.toFixed(3)} dB across the five tone levels`)
      console.log(`  → the no-compression GAIN is ${lin ? 'LINEAR' : '⚠ NOT LINEAR — gain depends on level'}`)

      /**
       * ⚠ LINEAR GAIN AND ZERO DISTORTION ARE DIFFERENT QUESTIONS, and keeping
       * them apart is the sharpest diagnostic the null test has. A STATIC
       * saturator distorts with LEVEL and needs no gain reduction to do it; a
       * GAIN-CELL nonlinearity needs reduction. Our own kernel shows the first
       * clearly — on the synthetic reference, gain is flat to 0.002 dB across
       * all five tones while THD climbs 0.006 → 0.089 % over the same 24 dB.
       * Reporting only "linear" would have hidden that entirely.
       */
      const rows = results.null1.tones.filter(t => t.h)
      if (rows.length >= 2) {
        const lo = rows[0].h.thdPct, hi = rows[rows.length - 1].h.thdPct
        if (allClean(results.null1)) {
          console.log('  THD with no gain reduction: at the stimulus floor at every level —')
          console.log('    nothing static to measure.')
        } else {
          console.log(`  THD with no gain reduction: ${lo.toFixed(3)} % at the quietest tone → ${hi.toFixed(3)} % at the loudest`)
          const loud = rows[rows.length - 1]
          const bal = harmonicBalance(loud.h, loud.usable)
          if (hi > lo * 2 && hi > 0.01) {
            console.log('  → ⚠ A STATIC SATURATOR IS IN CIRCUIT — distortion rises with LEVEL with no')
            console.log('    compression happening at all. That is an output-stage nonlinearity, and it')
            console.log('    has to be separated from the gain-cell one before `fetDrive` is fitted.')
            console.log(bal.evenDbc !== null
              ? `    Even order present (H2 ${bal.evenDbc.toFixed(1)} dBc) — an asymmetric shaper, like ours.`
              : '    ⚠ Odd-order only — symmetric, which our asymmetric tanh cannot reproduce.')
          }
        }
      }
    }

    if (results.null1 && results.null2) {
      const a = gainSpread(results.null1), b = gainSpread(results.null2)
      const dGain = b.mean - a.mean
      const t1 = maxThd(results.null1), t2 = maxThd(results.null2)
      console.log(`\n  Output +10 dB: gain moved ${dGain.toFixed(2)} dB`)
      if (Math.abs(dGain - 10) > 0.5) {
        console.log(`  ⚠ the gain did not move by the 10 dB dialled — check the knob's calibration,`)
        console.log('    and whether an auto-makeup or output-normalising control is still engaged.')
      }
      if (t1 !== null && t2 !== null) {
        console.log(`    worst THD ${t1.toFixed(3)} % → ${t2.toFixed(3)} %`)
        if (t2 > t1 + 0.05) {
          console.log('  → ⚠ OUTPUT DRIVES A STAGE. We model no such thing: our Output is a clean')
          console.log('    multiply after the FET. `fetDrive` cannot be fitted from this reference')
          console.log('    without separating the two nonlinearities first.')
        } else {
          console.log('  → Output is a clean multiply, as we model it.')
          /**
           * ⚠ AND THIS SAYS MORE THAN "CLEAN", WHICH THE FIRST VERSION MISSED.
           * If raising Output by 10 dB leaves the harmonics UNCHANGED IN dBc,
           * the distortion cannot be happening at or after Output — a shaper
           * fed 10 dB hotter would produce more. So it is generated upstream
           * and Output merely scales the result. That is our topology exactly:
           * waveshaper first, output gain after it.
           */
          const same = Math.abs(t2 - t1) < Math.max(0.002, 0.03 * t1)
          if (same) {
            console.log('  → ⚠ AND THE HARMONICS ARE UNCHANGED IN dBc, which places the')
            console.log('    distortion UPSTREAM OF OUTPUT. A shaper fed 10 dB hotter would make')
            console.log('    more; this one makes exactly as much and Output just scales it. Same')
            console.log('    topology as ours — waveshaper first, output gain after.')
            console.log('    ⚠ It also means the static law below is a law about the level at the')
            console.log('    SHAPER, not at the output. null1 and null3 share an Output setting per')
            console.log('    the protocol, so output level is a valid axis between those two — but')
            console.log('    it is not one across captures with different Output positions.')
          }
        }
      }
    }

    if (results.null3) {
      const curve = grWithinCapture(results.null3)
      console.log('\n  ⚠ THE AXIS THAT MATTERS — DISTORTION AGAINST GAIN REDUCTION,')
      console.log('    CONTROLLED FOR OUTPUT LEVEL.')
      console.log('    Reduction is measured DOWN FROM THIS CAPTURE\'S OWN open gain, so the')
      console.log('    Input position and any insertion trim drop out of it. ⚠ And THD is')
      console.log('    compared against what null1\'s no-compression law predicts AT THE SAME')
      console.log('    OUTPUT LEVEL — on this stimulus the loudest tones are also the most')
      console.log('    compressed, so an uncontrolled comparison credits the gain cell with a')
      console.log('    level effect.\n')

      let law = results.null1 ? staticThdLaw(results.null1) : null
      if (law && law.degenerate) {
        console.log('    ⚠ null1 shows NO static distortion at any level — there is no law to')
        console.log('      control against, so nothing below can separate a gain-cell term from a')
        console.log('      level effect. Whatever null3 shows is generated by the compression.')
        law = null
      }
      const rows3 = results.null3.tones.filter(t => t.h)

      if (!law) {
        console.log('      tone        GR      THD%')
        for (const c of curve) console.log(`      ${c.tag.padEnd(10)}${c.grDb.toFixed(2).padStart(6)}  ${c.thdPct.toFixed(3).padStart(8)}`)
        console.log('\n  ⚠ No null1 in this set, so there is no static law to control against and')
        console.log('    nothing here can separate a gain-cell term from a level effect.')
      } else {
        console.log(`    static law from null1: THD% rises ${(20 * law.m).toFixed(2)} dB per 20 dB of output level`)
        console.log(`    (fits its own five points to ${(law.worst * 100).toFixed(1)} %)\n`)
        console.log('      tone       out      GR   THD meas   predicted   residual')
        let extrapolated = 0
        for (let i = 0; i < rows3.length; i++) {
          const t = rows3[i], c = curve[i]
          const pred = law.predict(t.h.fundamentalDbfs)
          const res = (t.h.thdPct / pred - 1) * 100
          const beyond = t.h.fundamentalDbfs > law.hiDb + 0.5 || t.h.fundamentalDbfs < law.loDb - 0.5
          if (beyond) extrapolated++
          console.log(`      ${c.tag.padEnd(9)}${t.h.fundamentalDbfs.toFixed(1).padStart(7)}` +
            `${c.grDb.toFixed(2).padStart(8)}  ${t.h.thdPct.toFixed(4).padStart(9)}  ` +
            `${pred.toFixed(4).padStart(10)}  ${(res >= 0 ? '+' : '') + res.toFixed(1).padStart(6)}%` +
            `${beyond ? '  (extrapolated)' : ''}`)
        }
        if (extrapolated) {
          console.log(`\n    ⚠ ${extrapolated} tone(s) sit outside null1's measured level range ` +
            `(${law.loDb.toFixed(1)} to ${law.hiDb.toFixed(1)} dBFS).`)
          console.log('      The law is extrapolated there. Read those rows with that in mind.')
        }

        // Residual at the most-compressed tone is the gain cell's contribution.
        const compressed = rows3.map((t, i) => ({ t, c: curve[i] })).filter(x => x.c.grDb > 2)
        if (!compressed.length) {
          console.log('\n  ⚠ NOTHING IN null3 COMPRESSED BY MORE THAN 2 dB. Raise the Input and')
          console.log('    re-bounce — this capture cannot answer the question it was taken for.')
        } else {
          // ⚠ ABSOLUTE residual. A signed max reported "within −0.8 %" when every
          // row undershot, which reads as a bound and is not one.
          const worstRes = Math.max(...compressed.map(x =>
            Math.abs(x.t.h.thdPct / law.predict(x.t.h.fundamentalDbfs) - 1) * 100))
          const deepest = compressed[compressed.length - 1]
          if (worstRes < 15) {
            console.log(`\n  → NO GAIN-CELL DISTORTION. Output level alone explains every tone to`)
            console.log(`    within ${worstRes.toFixed(1)} %, up to ${deepest.c.grDb.toFixed(1)} dB of reduction.`)
            console.log('    The nonlinearity is STATIC and sits where level reaches it — which is')
            console.log('    where our own `fetDrive` shaper sits, after the gain cell. ⚠ That is a')
            console.log('    validation of the TOPOLOGY; only the drive constant is left to fit.')
            console.log('    ⚠ It is also the OPPOSITE of the LA-2A result, where the distortion')
            console.log('    lives with the cell and rises with reduction. Do not carry that')
            console.log('    finding across to this unit.')
          } else {
            console.log(`\n  → ⚠ A GAIN-CELL TERM IS PRESENT: ${worstRes.toFixed(0)} % more distortion than output`)
            console.log(`    level alone accounts for, at ${deepest.c.grDb.toFixed(1)} dB of reduction. That is on TOP of`)
            console.log('    the static law, and the two have to be separated before either is fitted.')
          }
        }
      }

      const deepTone = rows3[rows3.length - 1]
      if (deepTone && harmonicBalance(deepTone.h, deepTone.usable).oddDominant) {
        const bal = harmonicBalance(deepTone.h, deepTone.usable)
        console.log(`\n  ⚠ ODD-ORDER DOMINATED (H3 at ${bal.oddDbc.toFixed(1)} dBc` +
          `${bal.marginDb !== null ? `, ${bal.marginDb.toFixed(0)} dB over the strongest even` : ', nothing even above the floor'}).`)
        console.log('    An unsmoothed full-wave detector modulates the gain at 2f on a steady')
        console.log('    tone, and a tone times a 2f modulation puts sidebands at f and 3f — odd')
        console.log('    orders only, with no waveshaper involved. LAEA showed the same signature')
        console.log('    with Peak Reduction engaged, and our own kernel reads it at `fetDrive: 0`.')
        console.log('    ⚠ FITTING `fetDrive` TO THIS WOULD PUT A SATURATOR WHERE A RIPPLE IS.')
      }
    }

    if (results.null1 && results.null5) {
      const a = gainSpread(results.null1), b = gainSpread(results.null5)
      const d = b.mean - a.mean
      console.log(`\n  ⚠ THE COMPENSATION TEST — two Input positions, zero GR at both:`)
      console.log(`    output level moved ${(d >= 0 ? '+' : '') + d.toFixed(2)} dB between them`)
      if (Math.abs(d) < 0.5) {
        console.log('  → INPUT IS COMPENSATED. It is a DRIVE OFFSET, not an input gain, exactly as')
        console.log('    the manual says. This reference cannot speak to our Input\'s audio path —')
        console.log('    only to the detector side. ⚠ And it means the two references will disagree')
        console.log('    on stairs.wav output level BY CONSTRUCTION. That is not a bad capture.')
      } else {
        console.log('  → ⚠ INPUT IS A REAL GAIN — the manual is wrong, or the compensation is')
        console.log('    partial. Finding 1 in the protocol does not hold, and this reference')
        console.log(`    becomes a full reference for the Input law. ${d.toFixed(2)} dB for the knob`)
        console.log('    step you used; log both positions, that ratio is data now.')
      }
    }
    console.log()
  }

  console.log('Full protocol and what to do with each verdict: docs/fet1176_capture_protocol.md\n')
}


// ── Self-test ───────────────────────────────────────────────────────────────

/**
 * Synthesise the five null-test captures from our own kernel, with properties
 * we choose, and run the whole report against them.
 *
 * ⚠ THE VERDICTS ARE THE THING BEING TESTED, NOT THE ARITHMETIC. Every line
 * this script prints is a claim about a plugin — "Output drives a stage", "the
 * Input is compensated", "this reference models no output stage" — and each one
 * will be acted on by spending or not spending thirty-five bounces. A verdict
 * that comes out backwards on a capture whose answer is known is the only way
 * to catch that before it happens on one whose answer is not.
 *
 * Two references are synthesised, chosen to land on OPPOSITE verdicts in every
 * row, so a comparison that is stuck rather than working cannot pass both:
 *
 *   synthclean  Input compensated (drive raised, level put back), fetDrive 0.
 *               Expect: linear, Output clean, NO distortion rise, COMPENSATED.
 *   synthdirty  Input a true gain, fetDrive 0.35.
 *               Expect: linear at 0 GR, Output clean, DISTORTION RISES, REAL GAIN.
 *
 * ⚠ NEITHER IS A PREDICTION ABOUT FETish OR CLA-76. They are our own kernel
 * wearing two hats, and the only claim is that the reader reports what is
 * actually there.
 */

/** Input knob positions that produce zero gain reduction on every thd.wav tone. */
const SELFTEST_IN_LOW = 0
const SELFTEST_IN_LOW2 = 10
/** ...and one that compresses. */
const SELFTEST_IN_COMP = 60

function inputDriveDbFor(knob) {
  // Mirrors the kernel's own taper. Used only to undo it for the compensated
  // reference, so the synthetic plugin behaves the way FETish's manual claims.
  const IN_DRIVE_MIN_DB = -24, IN_DRIVE_SPAN_DB = 40, IN_TAPER = 0.8
  return IN_DRIVE_MIN_DB + IN_DRIVE_SPAN_DB * Math.pow(Math.max(0, Math.min(100, knob)) / 100, IN_TAPER)
}

function selftest(outDir) {
  mkdirSync(outDir, { recursive: true })
  const rate = readWav(join(STIM_DIR, 'thd.wav')).sampleRate
  const thd = rendered('thd.wav', rate)
  const stairs = rendered('stairs.wav', rate)

  const write = (name, y) => writeFloatWav(join(outDir, name), y, rate)

  for (const ref of ['synthclean', 'synthdirty']) {
    const compensated = ref === 'synthclean'
    const fetDrive = compensated ? 0 : 0.35
    // A compensated Input puts the level back; a true-gain Input does not.
    const comp = knob => (compensated ? -inputDriveDbFor(knob) : 0)

    write(`null1_${ref}.wav`, runKernel(thd.stim.x, rate,
      { inputDrive: SELFTEST_IN_LOW, outputGainDb: comp(SELFTEST_IN_LOW), ratio: '4', fetDrive }).y)
    write(`null2_${ref}.wav`, runKernel(thd.stim.x, rate,
      { inputDrive: SELFTEST_IN_LOW, outputGainDb: comp(SELFTEST_IN_LOW) + 10, ratio: '4', fetDrive }).y)
    write(`null3_${ref}.wav`, runKernel(thd.stim.x, rate,
      { inputDrive: SELFTEST_IN_COMP, outputGainDb: comp(SELFTEST_IN_COMP), ratio: '4', fetDrive }).y)
    write(`null4_${ref}.wav`, runKernel(stairs.stim.x, rate,
      { inputDrive: 50, ratio: '4', attack: 1, release: 7, fetDrive }).y)
    write(`null5_${ref}.wav`, runKernel(thd.stim.x, rate,
      { inputDrive: SELFTEST_IN_LOW2, outputGainDb: comp(SELFTEST_IN_LOW2), ratio: '4', fetDrive }).y)
  }

  // ⚠ AND ONE DELIBERATELY BROKEN CAPTURE. The bypass check is the cheapest
  // guard in the script and the one whose failure is least visible — a file
  // that never entered the plugin reads as "no compression" everywhere
  // downstream. `synthbypass` is the raw stimulus, and null4 must say so.
  write('null4_synthbypass.wav', stairs.stim.x)

  console.log(`\nSynthetic captures written to ${outDir}`)
  console.log('\nEXPECTED VERDICTS — anything else is a bug in the reader, not in the capture:')
  console.log('  synthclean   linear · Output clean · NO distortion rise · COMPENSATED')
  console.log('  synthdirty   linear · Output clean · DISTORTION RISES   · REAL GAIN')
  console.log('  synthbypass  null4 flagged BIT-IDENTICAL TO THE STIMULUS')
  capDir = outDir
  main()
}

let renderedCache = null
function rendered(name, rate) {
  if (!renderedCache) {
    renderedCache = new Map()
    for (const [n, fn] of Object.entries(PLANS)) {
      const plan = fn()
      renderedCache.set(n, { plan, stim: buildProbe(plan, rate) })
    }
  }
  return renderedCache.get(name)
}

// ── Entry ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const dirArg = args.indexOf('--dir')
if (dirArg >= 0 && args[dirArg + 1]) capDir = args[dirArg + 1]

if (args.includes('--selftest')) {
  const out = args[dirArg + 1] || join(STIM_DIR, '..', 'selftest')
  selftest(out)
} else {
  main()
}
