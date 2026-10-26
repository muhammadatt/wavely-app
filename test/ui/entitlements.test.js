import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reactive, computed } from 'vue'

import { createEntitlements } from '../../src/auth/entitlements.js'
import { FEATURES, FREE_PREVIEW_SECONDS } from '../../src/auth/plans.js'
import { readFileSync } from 'node:fs'

function fakeAuth(status = 'signedOut', plan = null) {
  const state = reactive({ status, plan })
  const calls = []
  return {
    state,
    plan: computed(() => (state.status === 'signedIn' ? state.plan : null)),
    openDialog: (m) => calls.push(['dialog', m]),
    openUpgrade: (f) => calls.push(['upgrade', f]),
    calls,
  }
}

test('accounts off: everything is allowed and nothing is limited', () => {
  const auth = fakeAuth('disabled')
  const e = createEntitlements(auth)
  for (const id of Object.keys(FEATURES)) {
    assert.equal(e.can(id), true, id)
    assert.equal(e.blocker(id), null)
    assert.equal(e.request(id), true)
    assert.equal(e.previewLimit(id), Infinity)
  }
  assert.deepEqual(auth.calls, [])
})

test('signed out: saving asks for an account, Pro features ask for an upgrade', () => {
  const auth = fakeAuth('signedOut')
  const e = createEntitlements(auth)
  assert.equal(e.request('savePresets'), false)
  assert.equal(e.request('pluginChainApply'), false)
  assert.deepEqual(auth.calls, [['dialog', 'signUp'], ['upgrade', 'pluginChainApply']])
  assert.match(e.hint('savePresets'), /^Sign in/)
  assert.match(e.hint('autoLevel'), /Pro feature/)
  assert.equal(e.previewLimit('noiseReduction'), FREE_PREVIEW_SECONDS)
  // Analysis plugins have no server preview to limit: only their Apply is Pro.
  assert.equal(e.previewLimit('autoLevel'), 0)
})

test('free plan saves presets but not Pro features; Pro has everything; it tracks the plan live', () => {
  const auth = fakeAuth('signedIn', 'free')
  const e = createEntitlements(auth)
  assert.equal(e.can('savePresets'), true)
  assert.equal(e.can('pluginChainApply'), false)
  assert.equal(e.previewLimit('noiseReduction'), FREE_PREVIEW_SECONDS)

  auth.state.plan = 'pro'
  assert.equal(e.can('pluginChainApply'), true)
  assert.equal(e.previewLimit('noiseReduction'), Infinity)
  assert.equal(e.hint('autoLevel'), '')
})

test('a server 402 opens the upgrade prompt; other errors are left to the caller', () => {
  const auth = fakeAuth('signedIn', 'free')
  const e = createEntitlements(auth)
  assert.equal(e.handleServerRefusal(new Error('boom')), false)
  const err = Object.assign(new Error('needs Pro'), { upgrade: { feature: 'autoLevel' } })
  assert.equal(e.handleServerRefusal(err), true)
  assert.deepEqual(auth.calls, [['upgrade', 'autoLevel']])
})

test('every registry `feature` and apply-feature names a real feature', () => {
  const sources = [
    'src/ui/registry.js',
    'src/components/panels/windows/PluginChainWindow.vue',
    'src/components/panels/AutoLevelModal.vue',
    'src/components/panels/SibilanceEditorModal.vue',
  ].map(p => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')).join('\n')
  const named = [
    ...sources.matchAll(/feature: '([^']+)'/g),
    ...sources.matchAll(/apply-feature="([^"]+)"/g),
    ...sources.matchAll(/(?:request|previewLimit|can)\('([^']+)'\)/g),
  ].map(m => m[1])
  assert.ok(named.length >= 6)
  for (const id of named) assert.ok(FEATURES[id], `unknown feature "${id}"`)
})
