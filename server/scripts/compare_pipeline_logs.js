#!/usr/bin/env node
/**
 * Compare two pipeline run logs side-by-side.
 *
 * Usage: node server/scripts/compare_pipeline_logs.js <baseline.log> <candidate.log>
 *
 * Prints per-stage timing deltas, total elapsed delta, and final-metric
 * parity (rms / true peak / noise floor / LUFS) so a pipeline change can be
 * verified against a reference run on the same input.
 */

import { readFile } from 'fs/promises'

const STEP_RE  = /^── Step (\d+): (\w+) \((\d+\.\d+)s\)/
const TOTAL_RE = /^Total elapsed:\s+(\d+\.\d+)s/
const FILE_RE  = /^File:\s+(.+)$/

async function parseLog(path) {
  const text = await readFile(path, 'utf8')
  const lines = text.split(/\r?\n/)

  const stages = []   // { key, name, occurrence, seconds }
  const counts = new Map()
  let total   = null
  let file    = null
  let report  = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const stepMatch = line.match(STEP_RE)
    if (stepMatch) {
      const name = stepMatch[2]
      const occurrence = (counts.get(name) ?? 0) + 1
      counts.set(name, occurrence)
      const key = occurrence > 1 ? `${name}#${occurrence}` : name
      stages.push({ key, name, occurrence, seconds: parseFloat(stepMatch[3]) })
      continue
    }
    const totalMatch = line.match(TOTAL_RE)
    if (totalMatch) total = parseFloat(totalMatch[1])
    const fileMatch = line.match(FILE_RE)
    if (fileMatch && !file) file = fileMatch[1].trim()
    if (line.startsWith('=== Final Report ===')) {
      // Capture the JSON block: from the next line up to the next '=== ' marker.
      const start = i + 1
      let end = lines.length
      for (let j = start; j < lines.length; j++) {
        if (lines[j].startsWith('=== ')) { end = j; break }
      }
      try { report = JSON.parse(lines.slice(start, end).join('\n')) }
      catch { report = null }
      i = end - 1
    }
  }

  return { path, file, total, stages, report }
}

function fmtDelta(delta, unit = 's', signGood = 'neg') {
  if (delta == null || Number.isNaN(delta)) return '   n/a '
  const sign = delta > 0 ? '+' : ''
  const str  = `${sign}${delta.toFixed(2)}${unit}`
  // Color: improvement (faster / lower) green, regression red. signGood='neg'
  // means a negative delta is the desired direction.
  const good = signGood === 'neg' ? delta < -0.005 : delta > 0.005
  const bad  = signGood === 'neg' ? delta >  0.005 : delta < -0.005
  if (good) return `\x1b[32m${str.padStart(8)}\x1b[0m`
  if (bad)  return `\x1b[31m${str.padStart(8)}\x1b[0m`
  return str.padStart(8)
}

function printStageTable(base, cand) {
  const allKeys = []
  const seen = new Set()
  for (const s of base.stages) if (!seen.has(s.key)) { allKeys.push(s.key); seen.add(s.key) }
  for (const s of cand.stages) if (!seen.has(s.key)) { allKeys.push(s.key); seen.add(s.key) }

  const baseMap = new Map(base.stages.map(s => [s.key, s.seconds]))
  const candMap = new Map(cand.stages.map(s => [s.key, s.seconds]))

  console.log(`\n${'Stage'.padEnd(28)} ${'baseline'.padStart(10)} ${'candidate'.padStart(10)} ${'delta'.padStart(10)}`)
  console.log('─'.repeat(62))
  for (const key of allKeys) {
    const b = baseMap.get(key)
    const c = candMap.get(key)
    const delta = (b != null && c != null) ? c - b : null
    const baseStr = b != null ? `${b.toFixed(2)}s`.padStart(10) : '   —      '
    const candStr = c != null ? `${c.toFixed(2)}s`.padStart(10) : '   —      '
    console.log(`${key.padEnd(28)} ${baseStr} ${candStr} ${fmtDelta(delta)}`)
  }
  console.log('─'.repeat(62))
  const totalDelta = (base.total != null && cand.total != null) ? cand.total - base.total : null
  console.log(`${'TOTAL'.padEnd(28)} ${`${base.total?.toFixed(2)}s`.padStart(10)} ${`${cand.total?.toFixed(2)}s`.padStart(10)} ${fmtDelta(totalDelta)}`)
  if (totalDelta != null && base.total) {
    const pct = (totalDelta / base.total) * 100
    const sign = pct > 0 ? '+' : ''
    const color = pct < 0 ? '\x1b[32m' : (pct > 0 ? '\x1b[31m' : '')
    console.log(`${''.padEnd(28)} ${''.padStart(10)} ${''.padStart(10)} ${color}${sign}${pct.toFixed(1)}%\x1b[0m`)
  }
}

function printMetricsTable(base, cand) {
  if (!base.report || !cand.report) {
    console.log('\n(metrics comparison skipped — final report missing in one or both logs)')
    return
  }
  const fields = [
    ['before.rms_dbfs',         'before',  'rms_dbfs'],
    ['before.true_peak_dbfs',   'before',  'true_peak_dbfs'],
    ['before.noise_floor_dbfs', 'before',  'noise_floor_dbfs'],
    ['before.lufs_integrated',  'before',  'lufs_integrated'],
    ['after.rms_dbfs',          'after',   'rms_dbfs'],
    ['after.true_peak_dbfs',    'after',   'true_peak_dbfs'],
    ['after.noise_floor_dbfs',  'after',   'noise_floor_dbfs'],
    ['after.lufs_integrated',   'after',   'lufs_integrated'],
  ]
  console.log(`\n${'Metric'.padEnd(28)} ${'baseline'.padStart(10)} ${'candidate'.padStart(10)} ${'delta'.padStart(10)}`)
  console.log('─'.repeat(62))
  for (const [label, section, key] of fields) {
    const b = base.report?.[section]?.[key]
    const c = cand.report?.[section]?.[key]
    const delta = (typeof b === 'number' && typeof c === 'number') ? c - b : null
    const baseStr = typeof b === 'number' ? b.toFixed(2).padStart(10) : '   —      '
    const candStr = typeof c === 'number' ? c.toFixed(2).padStart(10) : '   —      '
    // For metrics the "good" direction depends on the metric; treat any
    // movement >0.5 dB as worth flagging (red) and anything within 0.5 dB
    // as parity (uncolored). No green — these are correctness checks, not
    // optimization targets.
    const fmtMetric = (d) => {
      if (d == null) return '   n/a '
      const s = `${d > 0 ? '+' : ''}${d.toFixed(2)}`
      if (Math.abs(d) > 0.5) return `\x1b[33m${s.padStart(8)}\x1b[0m`
      return s.padStart(8)
    }
    console.log(`${label.padEnd(28)} ${baseStr} ${candStr} ${fmtMetric(delta)}`)
  }
  const baseAcx = base.report?.acx_certification?.certificate
  const candAcx = cand.report?.acx_certification?.certificate
  if (baseAcx || candAcx) {
    console.log('─'.repeat(62))
    console.log(`${'ACX certificate'.padEnd(28)} ${(baseAcx ?? '—').padStart(10)} ${(candAcx ?? '—').padStart(10)}`)
  }
}

async function main() {
  const [, , basePath, candPath] = process.argv
  if (!basePath || !candPath) {
    console.error('Usage: node compare_pipeline_logs.js <baseline.log> <candidate.log>')
    process.exit(1)
  }
  const [base, cand] = await Promise.all([parseLog(basePath), parseLog(candPath)])
  console.log(`baseline:  ${base.path}`)
  console.log(`           file=${base.file ?? '?'}  total=${base.total?.toFixed(2)}s  stages=${base.stages.length}`)
  console.log(`candidate: ${cand.path}`)
  console.log(`           file=${cand.file ?? '?'}  total=${cand.total?.toFixed(2)}s  stages=${cand.stages.length}`)
  if (base.file && cand.file && base.file !== cand.file) {
    console.log(`\n⚠ Files differ — comparison may be misleading.`)
  }
  printStageTable(base, cand)
  printMetricsTable(base, cand)
}

main().catch(err => { console.error(err); process.exit(1) })
