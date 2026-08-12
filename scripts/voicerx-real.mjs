#!/usr/bin/env node
/**
 * Run every detector over real, already-finished recordings and report what
 * each one claims about audio that is by definition already right.
 *
 *   npm run scorecard:real
 *   node scripts/voicerx-real.mjs --seconds=45 --windows=3
 *   node scripts/voicerx-real.mjs --json
 *   node scripts/voicerx-real.mjs --dir=some/other/path
 *
 * There is no pass or fail here and there is no baseline to match. The
 * synthetic corpus can assert an exact right answer because it planted the
 * defect; this cannot, because nobody knows what a finished master "should"
 * report. What it can do is put a number on the one thing the synthetic corpus
 * structurally cannot check — how often a detector invents work on real audio a
 * professional has already signed off — and show the mask measurements that
 * every other number depends on.
 *
 * Read it, do not gate on it.
 */

import { runDetectors } from '../test/voicerx/realRun.js'
import { CORPUS_DIR } from '../test/voicerx/realCorpus.js'

const argv = process.argv.slice(2)
const has = f => argv.includes(f)
const opt = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const dir = opt('dir', CORPUS_DIR)
const seconds = Number(opt('seconds', 45))
const windows = Number(opt('windows', 3))

const report = runDetectors({ dir, seconds, windows })

if (report.files.length === 0) {
  console.log(`\nNo .wav files in ${dir}\n`)
  console.log('Put finished, already-mastered recordings there — the directory is')
  console.log('gitignored, the same way the referenceEQ corpus is, so commercial')
  console.log('audio never reaches the repository.\n')
  console.log(`  mkdir -p ${dir}`)
  console.log(`  cp /path/to/*.wav ${dir}/\n`)
  process.exit(0)
}

if (has('--json')) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

print(report)

/**
 * The two detectors describe an advisory differently and neither is wrong.
 * v1 writes a finished sentence for the panel; v2 emits the measurement and
 * which confidence term suppressed it. Print whichever shape arrived rather
 * than forcing one into the other's fields — an earlier version assumed v2's
 * and rendered every v1 advisory as "note 3048Hz dB".
 */
function describeAdvisory(a) {
  if (a.title) return a.title
  const where = Math.round(a.centreHz ?? a.lowHz ?? 0)
  const depth = a.depthDb === undefined ? '' : ` ${a.depthDb} dB`
  const why = a.reason ? ` (limited by ${a.reason})` : ''
  return `${a.kind ?? 'note'} at ${where} Hz${depth}${why}`
}

function fmtBands(bands) {
  if (!bands.length) return '—'
  // A band on the fundamental is marked, because it is the one correction that
  // is never right whatever else the detector got out of the file.
  return bands.map(b => `${Math.round(b.freqHz)}Hz ${b.gainDb > 0 ? '+' : ''}${b.gainDb.toFixed(1)}`
    + (b.nearF0 ? '[F0]' : '')).join('  ')
}

function print(r) {
  console.log(`\nVoiceRx on real finished audio — ${r.files.length} files, `
    + `${r.windowCount} windows of ${r.seconds}s, ${r.elapsedSeconds}s\n`)

  console.log('THESE FILES ARE ALREADY MASTERED. Bands below are corrections offered on')
  console.log('audio a professional has signed off, so most of them are corrections that')
  console.log('should not have been offered — but see realCorpus.js: a finished file may')
  console.log('carry a deliberate notch, and reporting that is right rather than wrong.\n')

  for (const f of r.files) {
    if (f.error) {
      console.log(`${f.name}  COULD NOT BE READ — ${f.error}\n`)
      continue
    }
    console.log(`${f.name}  (${f.seconds.toFixed(0)}s, ${f.sampleRate} Hz, `
      + `${f.channels === 1 ? 'mono' : `${f.channels}ch`}, ${f.bitDepth}-bit)`)

    for (const w of f.windows) {
      const at = `  @${String(Math.round(w.startSeconds)).padStart(4)}s`
      if (w.error) {
        console.log(`${at}  ERROR ${w.error}`)
        continue
      }
      const gated = w.quietLevelDbfs < -80 ? ' GATED' : ''
      const voice = `${w.voiceType ?? '?'} F0 ${w.medianF0Hz ?? '?'}`
      console.log(`${at}  ${voice.padEnd(18)} mask ${w.mask
        ? `${(w.mask.liveFraction * 100).toFixed(0)}% live to ${w.mask.topLiveHz} Hz, `
          + `SNR ${w.mask.medianSpeechSnrDb ?? '?'} dB${w.mask.noiseFloorMeasured ? '' : ' (NO PAUSES — floor not measured)'}`
        : '—'}, floor ${w.quietLevelDbfs} dBFS${gated}`)
      for (const [name, out] of Object.entries(w.detectors)) {
        const label = out.ok
          ? `${String(out.bands.length).padStart(2)} bands  ${fmtBands(out.bands)}`
          : `refused: ${out.reason}`
        console.log(`         ${name.padEnd(8)} ${label}`)
        for (const a of out.advisories ?? []) {
          console.log(`                  advisory: ${describeAdvisory(a)}`)
        }
      }
    }
    console.log()
  }

  console.log('─'.repeat(72))
  console.log('SUMMARY — corrections offered on audio that is already finished\n')
  console.log('detector   windows w/ bands   bands/window   total gain   largest single')
  for (const [name, s] of Object.entries(r.summary)) {
    console.log(
      name.padEnd(10),
      `${s.windowsWithBands}/${s.windows}`.padStart(14),
      s.bandsPerWindow.toFixed(2).padStart(14),
      `${s.totalGainDb.toFixed(1)} dB`.padStart(12),
      `${s.largestGainDb.toFixed(1)} dB`.padStart(16),
    )
  }

  console.log('\nCORRECTING THE FUNDAMENTAL — never right, it is the pitch not a defect')
  for (const [name, s] of Object.entries(r.summary)) {
    console.log(`  ${name.padEnd(10)} ${s.bandsNearF0}/${s.totalBands} bands within 15% of measured F0`)
  }

  console.log('\nREPEATABILITY — of the first window\'s bands, how many recur in EVERY window')
  for (const [name, s] of Object.entries(r.summary)) {
    console.log(`  ${name.padEnd(10)} ${s.recurringFraction === null ? 'n/a'
      : `${(s.recurringFraction * 100).toFixed(0)}%`}`)
  }
  console.log('  A user who analyses twice and is told different things has no reason')
  console.log('  to believe either answer.')

  console.log('\nWHERE THE INVENTED BANDS LAND (half-octave bins)')
  for (const [name, s] of Object.entries(r.summary)) {
    const rows = Object.entries(s.histogram)
      .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
      .filter(([, n]) => n > 0)
    console.log(`  ${name}`)
    for (const [label, n] of rows) {
      console.log(`    ${label.padStart(8)}  ${'#'.repeat(n)} ${n}`)
    }
  }

  console.log('\nMASK HEALTH (v2 only — the measurement everything else rests on)')
  const m = r.maskSummary
  console.log(`  files where a noise floor could be measured   ${m.measured}/${m.windows}`)
  console.log(`  median live fraction of 60 Hz-16 kHz          ${(m.medianLiveFraction * 100).toFixed(0)}%`)
  console.log(`  median speech-band SNR                        ${m.medianSpeechSnrDb ?? '?'} dB`)
  console.log(`  median top live frequency                     ${m.medianTopLiveHz} Hz`)
  console.log(`  median level of the quietest frames           ${m.medianQuietLevelDbfs} dBFS`)
  console.log(`  windows whose pauses look gated (<-80 dBFS)   ${m.windowsWithGatedSilence}/${m.windows}`)
  console.log('\n  A live fraction far below ~90%, or an SNR in single digits, means')
  console.log('  mastering has compressed the pauses enough to blind the mask — and')
  console.log('  every v2 number on this corpus would then be describing a spectrum')
  console.log('  with holes punched in it rather than the recording.\n')
}
