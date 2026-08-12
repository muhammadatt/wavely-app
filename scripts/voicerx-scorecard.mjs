#!/usr/bin/env node
/**
 * Run the VoiceRx corpus and print a scorecard.
 *
 *   node scripts/voicerx-scorecard.mjs                 full corpus, human readable
 *   node scripts/voicerx-scorecard.mjs --json          machine readable
 *   node scripts/voicerx-scorecard.mjs --smoke         the regression subset only
 *   node scripts/voicerx-scorecard.mjs --detector=x    score a different detector
 *   node scripts/voicerx-scorecard.mjs --write-baseline
 *
 * The last form overwrites the baseline the committed regression test compares
 * against — baseline-smoke.json with --smoke, baseline.json without. Rewrite
 * one only when a change to the detector is intended and the new numbers have
 * been read.
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runScorecard } from '../test/voicerx/harness.js'
import { CASES, SMOKE_CASES } from '../test/voicerx/cases.js'
import { DETECTORS } from '../test/voicerx/detectors.js'

const argv = process.argv.slice(2)
const has = flag => argv.includes(flag)
const opt = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const detectorName = opt('detector', 'current')
const detector = DETECTORS[detectorName]
if (!detector) {
  console.error(`unknown detector "${detectorName}" — have: ${Object.keys(DETECTORS).join(', ')}`)
  process.exit(1)
}

const cases = has('--smoke') ? SMOKE_CASES : CASES
const started = Date.now()
const card = runScorecard(detector, cases)
const elapsed = ((Date.now() - started) / 1000).toFixed(1)

if (has('--json')) {
  console.log(JSON.stringify(card, null, 2))
} else {
  print(card, detectorName, elapsed)
}

if (has('--write-baseline')) {
  const here = dirname(fileURLToPath(import.meta.url))
  // Two baselines, because they describe two different case sets and mixing
  // them would silently compare a six-case number against a fifty-eight-case
  // one. The smoke file is the one the committed test reads.
  const file = has('--smoke') ? 'baseline-smoke.json' : 'baseline.json'
  const path = join(here, '..', 'test', 'voicerx', file)
  // Per-case detail is deliberately excluded. The baseline is a regression
  // guard, and pinning every band of every case would make it fire on noise
  // in the last decimal place of a gain rather than on a change worth reading.
  writeFileSync(path, `${JSON.stringify({
    detector: detectorName,
    overall: card.overall,
    families: card.families,
  }, null, 2)}\n`)
  console.log(`\nwrote test/voicerx/${file}`)
}

function pct(v) {
  return v === null ? '   -' : `${(v * 100).toFixed(0).padStart(3)}%`
}

function num(v, places = 2) {
  return v === null ? '    -' : v.toFixed(places).padStart(5)
}

function print(card, name, seconds) {
  const o = card.overall
  console.log(`\nVoiceRx scorecard — detector "${name}", ${o.cases} cases, ${seconds}s\n`)

  console.log('family            cases  detect   recovery (p10/med/p90)   spurious  gain')
  console.log('─'.repeat(78))
  for (const [family, s] of Object.entries(card.families)) {
    console.log(
      family.padEnd(17),
      String(s.cases).padStart(4),
      pct(s.detectionRate).padStart(7),
      `${num(s.recovery.p10)} ${num(s.recovery.median)} ${num(s.recovery.p90)}`.padStart(24),
      String(s.spuriousBands).padStart(8),
      `${num(s.spuriousGainDb, 1)} dB`,
    )
  }
  console.log('─'.repeat(78))
  console.log(
    'OVERALL'.padEnd(17),
    String(o.cases).padStart(4),
    pct(o.detectionRate).padStart(7),
    `${num(o.recovery.p10)} ${num(o.recovery.median)} ${num(o.recovery.p90)}`.padStart(24),
    String(o.spuriousBands).padStart(8),
    `${num(o.spuriousGainDb, 1)} dB`,
  )

  console.log(`\nrecovery spread (p90-p10)   ${num(o.recovery.spread)}   <- 0.00 would be perfectly consistent`)
  console.log(`aim, octaves off  median ${num(o.freqErrorOctaves.median, 3)}  worst ${num(o.freqErrorOctaves.max, 3)}`)
  console.log(`cases needing no correction that got one  ${o.noCorrectionButGotBands} / ${o.noCorrectionExpected}`)
  console.log(`analyses that refused to run        ${o.analysisFailures}`)

  if (o.missed.length) {
    console.log(`\nMISSED (${o.missed.length}/${o.plantedDefects}):`)
    for (const m of o.missed) console.log(`  ${m}`)
  }

  const worst = card.results
    .filter(r => r.spuriousBands > 0)
    .sort((a, b) => b.spuriousGainDb - a.spuriousGainDb)
    .slice(0, 8)
  if (worst.length) {
    console.log('\nLARGEST INVENTED CORRECTIONS:')
    for (const r of worst) {
      const bands = r.spurious.map(b => `${Math.round(b.freqHz)}Hz ${b.gainDb > 0 ? '+' : ''}${b.gainDb}`).join('  ')
      console.log(`  ${r.name.padEnd(28)} ${String(r.spuriousGainDb).padStart(5)} dB total   ${bands}`)
    }
  }
  console.log()
}
