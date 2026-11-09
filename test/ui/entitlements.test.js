import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reactive, computed } from 'vue'

import { createEntitlements } from '../../src/auth/entitlements.js'
import { FEATURES, FREE_PREVIEW_SECONDS, isOffline, allowsPreview } from '../../src/auth/plans.js'
import { readFileSync } from 'node:fs'

function fakeAuth(status = 'signedOut', plan = null) {
  const state = reactive({ status, plan })
  const calls = []
  const reasons = []
  return {
    reasons,
    state,
    plan: computed(() => (state.status === 'signedIn' ? state.plan : null)),
    openDialog: (m, opts) => { calls.push(['dialog', m]); reasons.push(opts?.reason ?? null) },
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
  // Server previews need an account — except mastering's.
  assert.equal(e.previewLimit('spotEffects'), 0)
  assert.equal(e.previewLimit('mastering'), FREE_PREVIEW_SECONDS)
  // Offline processes are Pro outright: nothing to preview, nothing to send.
  assert.equal(e.previewLimit('noiseReduction'), 0)
  assert.equal(e.previewLimit('autoLevel'), 0)
})

test('requestPreview: signed out asks for a sign-in; a free account previews; Pro is unlimited', () => {
  const auth = fakeAuth('signedOut')
  const e = createEntitlements(auth)
  for (const id of ['spotEffects', 'noiseReduction']) {
    assert.equal(e.requestPreview(id), false, id)
  }
  assert.deepEqual(auth.calls, [['dialog', 'signUp'], ['dialog', 'signUp']])
  assert.equal(e.requestPreview('mastering'), true)

  auth.state.status = 'signedIn'
  auth.state.plan = 'free'
  assert.equal(e.requestPreview('spotEffects'), true)
  assert.equal(e.previewLimit('spotEffects'), FREE_PREVIEW_SECONDS)
  assert.equal(e.requestPreview('noiseReduction'), false, 'no preview: an upgrade, not a sign-in')
  assert.deepEqual(auth.calls.at(-1), ['upgrade', 'noiseReduction'])
  auth.state.plan = 'pro'
  assert.equal(e.previewLimit('spotEffects'), Infinity)
  assert.equal(auth.calls.length, 3, 'no further prompts')

  const off = createEntitlements(fakeAuth('disabled'))
  assert.equal(off.requestPreview('spotEffects'), true)
})

test('a server 401 sign_in_required opens the sign-in dialog', () => {
  const auth = fakeAuth('signedOut')
  const e = createEntitlements(auth)
  const err = Object.assign(new Error('Sign in'), { signIn: { code: 'sign_in_required', feature: 'audioAnalysis' } })
  assert.equal(e.handleServerRefusal(err), true)
  assert.deepEqual(auth.calls, [['dialog', 'signUp']])
})

test('free plan saves presets but not Pro features; Pro has everything; it tracks the plan live', () => {
  const auth = fakeAuth('signedIn', 'free')
  const e = createEntitlements(auth)
  assert.equal(e.can('savePresets'), true)
  assert.equal(e.can('pluginChainApply'), false)
  assert.equal(e.can('noiseReduction'), false)
  assert.equal(e.previewLimit('spotEffects'), FREE_PREVIEW_SECONDS)

  auth.state.plan = 'pro'
  assert.equal(e.can('pluginChainApply'), true)
  assert.equal(e.previewLimit('noiseReduction'), Infinity)
  assert.equal(e.hint('autoLevel'), '')
})

test('Auto Leveler and Noise Reduction are offline processes, gated whole', () => {
  assert.equal(isOffline('autoLevel'), true)
  assert.equal(isOffline('noiseReduction'), true)
  assert.equal(allowsPreview('noiseReduction'), false)
  // The real-time plugins keep their free preview.
  assert.equal(isOffline('pluginChainApply'), false)
})

test('analysis needs an account, not a plan', () => {
  const out = createEntitlements(fakeAuth('signedOut'))
  assert.equal(out.blocker('audioAnalysis'), 'signIn')
  const free = createEntitlements(fakeAuth('signedIn', 'free'))
  assert.equal(free.can('audioAnalysis'), true)
})

test('a server 401 sign_in_required opens the sign-in dialog, not the upgrade prompt', () => {
  const auth = fakeAuth('signedOut')
  const e = createEntitlements(auth)
  const err = Object.assign(new Error('sign in'), { signIn: { feature: 'audioAnalysis' } })
  assert.equal(e.handleServerRefusal(err), true)
  assert.deepEqual(auth.calls, [['dialog', 'signUp']])
})

test('a server 402 opens the upgrade prompt; other errors are left to the caller', () => {
  const auth = fakeAuth('signedIn', 'free')
  const e = createEntitlements(auth)
  assert.equal(e.handleServerRefusal(new Error('boom')), false)
  const err = Object.assign(new Error('needs Pro'), { upgrade: { feature: 'autoLevel' } })
  assert.equal(e.handleServerRefusal(err), true)
  assert.deepEqual(auth.calls, [['upgrade', 'autoLevel']])
})

test('a server 402 for a feature any account unlocks asks for a sign-in, not an upgrade', () => {
  const auth = fakeAuth('signedOut')
  const e = createEntitlements(auth)
  const err = Object.assign(new Error('needs an account'), { upgrade: { feature: 'mastering', requires: 'free' } })
  assert.equal(e.handleServerRefusal(err), true)
  assert.deepEqual(auth.calls, [['dialog', 'signUp']])
  assert.equal(e.previewLimit('mastering'), FREE_PREVIEW_SECONDS)
  auth.state.status = 'signedIn'
  auth.state.plan = 'free'
  assert.equal(e.previewLimit('mastering'), Infinity)
})

test('every registry `feature` and apply-feature names a real feature', () => {
  const sources = [
    'src/ui/registry.js',
    'src/components/panels/windows/PluginChainWindow.vue',
    'src/components/panels/AutoLevelModal.vue',
    'src/components/panels/NoiseReductionModal.vue',
    'src/composables/useAutoLevel.js',
    'src/composables/useNoiseReduction.js',
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

test('the sign-up dialog is told which feature sent the user', () => {
  const auth = fakeAuth('signedOut')
  const e = createEntitlements(auth)
  e.request('savePresets')
  e.requestPreview('spotEffects')
  e.handleServerRefusal(Object.assign(new Error('x'), { signIn: { feature: 'mastering' } }))
  e.handleServerRefusal(Object.assign(new Error('x'), { signIn: { feature: 'fromANewerServer' } }))
  assert.deepEqual(auth.reasons, ['savePresets', 'spotEffects', 'mastering', null])
})
