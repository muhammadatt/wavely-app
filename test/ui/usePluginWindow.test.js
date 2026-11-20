/**
 * The decisions behind every plugin window's open / close / apply
 * (src/composables/usePluginWindow.js), without a component.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { shouldEngageOnOpen, pluginWindowActions } = await import('../../src/composables/usePluginWindow.js')

test('opening a window switches on the solo copy only, and only when it is off', () => {
  assert.equal(shouldEngageOnOpen(false, 'solo'), true)
  assert.equal(shouldEngageOnOpen(true, 'solo'), false, 'already on: opening must not toggle it off')
  assert.equal(shouldEngageOnOpen(false, 'chain-1'), false, 'a chain slot keeps its ON/BYPASS')
  assert.equal(shouldEngageOnOpen(false, 'chain-3'), false)
})

function recorder(applyResult) {
  const calls = []
  return {
    calls,
    apply: async () => { calls.push('apply'); return applyResult },
    teardown: () => calls.push('teardown'),
    closeModal: () => calls.push('close'),
  }
}

test('a live plugin applies, stops its preview and meters, then closes', async () => {
  const r = recorder(undefined)
  await pluginWindowActions(r).applyAndClose()
  assert.deepEqual(r.calls, ['apply', 'teardown', 'close'])
})

test('a live plugin whose apply committed nothing keeps its window, preview and meters', async () => {
  const committed = recorder(true)
  await pluginWindowActions(committed).applyAndClose()
  assert.deepEqual(committed.calls, ['apply', 'teardown', 'close'])

  const failed = recorder(false)
  const out = await pluginWindowActions(failed).applyAndClose()
  assert.deepEqual(failed.calls, ['apply'], 'a refused or failed apply leaves the user where they were')
  assert.equal(out, false)
})

test('every live plugin\'s apply reports whether it committed', async () => {
  // usePluginWindow keeps the window open only on `false`, so each live apply
  // must resolve true from its commit and false from its catch.
  const { readFileSync, readdirSync } = await import('node:fs')
  const panels = new URL('../../src/components/panels/', import.meta.url)
  const files = readdirSync(panels, { recursive: true }).filter(f => f.endsWith('.vue'))
  const composables = new Set()
  for (const f of files) {
    const src = readFileSync(new URL(f, panels), 'utf8')
    if (!/usePluginWindow\(/.test(src) || /closeOnlyOnSuccess/.test(src)) continue
    for (const m of src.matchAll(/from '[./]+\/composables\/(use\w+)\.js'/g)) composables.add(m[1])
  }
  // The EQ and VoiceRx windows reach their apply through useManualEq /
  // useVoiceRx, which both build it in useEqInstance.
  composables.add('useEqInstance')
  const problems = []
  let checked = 0
  for (const name of composables) {
    const src = readFileSync(new URL(`../../src/composables/${name}.js`, import.meta.url), 'utf8')
    const at = src.search(/async function apply\(\) \{/)
    if (at < 0) continue // a helper composable (the window, presets, the editor)
    checked++
    const body = src.slice(at, src.indexOf('\n    }\n', at))
    if (!/return true\n\s*\} catch \(err\) \{/.test(body)) problems.push(`${name}: no \`return true\` at the end of its try`)
    if (!/return false\n\s*\} finally \{/.test(body)) problems.push(`${name}: its catch does not \`return false\``)
  }
  assert.ok(checked >= 17, `checked ${checked} applies`)
  assert.deepEqual(problems, [])
})

test('closing a live plugin window stops its preview and meters', () => {
  const r = recorder()
  pluginWindowActions(r).close()
  assert.deepEqual(r.calls, ['teardown'])
})

test('an offline plugin closes only when its run committed', async () => {
  const ok = recorder(true)
  await pluginWindowActions({ ...ok, teardown: undefined, closeOnlyOnSuccess: true }).applyAndClose()
  assert.deepEqual(ok.calls, ['apply', 'close'])

  const refused = recorder(false)
  await pluginWindowActions({ ...refused, teardown: undefined, closeOnlyOnSuccess: true }).applyAndClose()
  assert.deepEqual(refused.calls, ['apply'], 'a refused or cancelled run leaves the window open')
})

test('Preview asks the transport to play or stop', () => {
  const seen = []
  globalThis.window = {
    dispatchEvent: e => seen.push(e.type),
  }
  globalThis.CustomEvent ??= class { constructor(type) { this.type = type } }
  try {
    pluginWindowActions(recorder()).togglePlayback()
    assert.deepEqual(seen, ['wavely:toggle-play'])
  } finally {
    delete globalThis.window
  }
})
