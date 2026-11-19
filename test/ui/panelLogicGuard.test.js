/**
 * Panels draw; composables decide (docs/plugin-panel-audit.md).
 *
 * A plugin window's .vue file may read state and call its composable, but it
 * must not measure, render, touch the audio engine or commit edits itself:
 * that logic is untestable in a component, invisible to `npm run smoke`, and
 * would have to be rewritten for any other shell (a phone layout). This guard
 * reads every panel's <script> and fails on such a call.
 *
 * ⚠ THE ALLOWLIST ONLY SHRINKS. It lists the calls that were there when the
 * guard was written; each is work still to do (the audit's order). A NEW call
 * fails the test, and so does an allowlisted call that has gone — delete its
 * entry, so the list stays the true remaining work.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../../', import.meta.url).pathname
const PANELS = join(ROOT, 'src/components/panels')

/** Calls a panel must leave to its composable. */
const FORBIDDEN_CALL = new RegExp(
  '\\b(' + [
    // Committing an edit and the processing overlay.
    'replaceRegion', 'startProcessing', 'endProcessing', 'updateProcessingStage',
    'updateProcessingProgress', 'pinActiveDocument', 'setPeakCache', 'computePeakCache',
    'setProcessingReport',
    // The audio engine and the transport.
    'getAudioContext', 'getEffectChain', 'getEffectChainIfExists', 'startPlayback',
    'stopPlayback', 'decodeAudioData',
    // Measuring, rendering and the server.
    'measure[A-Z]\\w*', 'render[A-Z]\\w*Region', '\\w*[nN]ormalizeRegion', 'adjustVolumeRegion',
    'readTimelineEnvelope', 'processAudioOnServer', 'uploadAudio',
    // A plugin's frequency response at the file's rate is its composable's
    // (`responseDb`), not the panel's.
    'magnitudeResponseDb', 'shelfResponseDb', 'eqResponseDb',
  ].join('|') + ')\\s*\\(',
  'g',
)

/** What each panel still calls itself — to be moved, then deleted from here. */
const ALLOWED = {
  'PresetsPanel.vue': [
    'decodeAudioData', 'endProcessing', 'getAudioContext', 'processAudioOnServer',
    'startProcessing', 'updateProcessingProgress', 'updateProcessingStage',
  ],
}

/**
 * Permanent exceptions, each with its reason — unlike ALLOWED, these are not
 * work left to do. A generic plot component that draws the response of the
 * filter it is HANDED in props (bands, a layer's emphasis, a sample rate) reads
 * no plugin or editor state; computing the curve from its props is drawing.
 */
const EXEMPT = {
  'eq/EqPlot.vue': ['eqResponseDb'],
  'SaturationEmphasisPlot.vue': ['magnitudeResponseDb'],
}

function vueFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return vueFiles(path)
    return name.endsWith('.vue') ? [path] : []
  })
}

/** A panel's <script>, comments removed so a comment naming a call is no call. */
function scriptOf(path) {
  const src = readFileSync(path, 'utf8')
  const end = src.indexOf('</script>')
  return (end === -1 ? '' : src.slice(0, end))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

const panels = vueFiles(PANELS).map(path => ({ path, name: relative(PANELS, path), script: scriptOf(path) }))

test('the guard sees the panels', () => {
  assert.ok(panels.length >= 40, `found ${panels.length} panels`)
  for (const name of Object.keys(ALLOWED)) {
    assert.ok(panels.some(p => p.name === name), `allowlisted ${name} does not exist`)
  }
})

test('no panel measures, renders, drives the engine or commits an edit itself', () => {
  const problems = []
  for (const { name, script } of panels) {
    const calls = new Set([...script.matchAll(FORBIDDEN_CALL)].map(m => m[1]))
    const allowed = new Set(ALLOWED[name] ?? [])
    const exempt = new Set(EXEMPT[name] ?? [])
    for (const call of exempt) calls.delete(call)
    for (const call of calls) {
      if (!allowed.has(call)) problems.push(`${name} calls ${call}() — move it into the composable`)
    }
    for (const call of allowed) {
      if (!calls.has(call)) problems.push(`${name} no longer calls ${call}() — delete it from ALLOWED`)
    }
  }
  assert.deepEqual(problems, [])
})

test('plugin windows use the shared window behaviour, not their own copy', () => {
  const problems = []
  for (const { name, script } of panels) {
    // Engage-on-open is usePluginWindow's; FloatingWindow maps window ids by copy.
    if (name !== 'FloatingWindow.vue' && /\bcurrentPluginCopy\s*\(/.test(script)) {
      problems.push(`${name} reads currentPluginCopy() — engage on open through usePluginWindow`)
    }
    if (/\bfunction (togglePlayback|applyAndClose)\s*\(/.test(script)) {
      problems.push(`${name} defines its own togglePlayback / applyAndClose — use usePluginWindow`)
    }
  }
  assert.deepEqual(problems, [])
})

test('only the transport bus names the toggle-play event', () => {
  const src = join(ROOT, 'src')
  const files = (function walk(dir) {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return walk(path)
      return /\.(vue|js)$/.test(name) ? [path] : []
    })
  })(src)
  const offenders = files
    .filter(f => !f.endsWith('transportBus.js') && readFileSync(f, 'utf8').includes('wavely:toggle-play'))
    .map(f => relative(ROOT, f))
  assert.deepEqual(offenders, [], 'request playback through src/ui/transportBus.js')
})
