import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  definePluginPresets, resetPluginPresets, listPresets, presetParams,
  matchPreset, saveUserPreset, deleteUserPreset, isFactoryPreset,
  pickParams, paramsEqual, clonePlain, PRESET_STORAGE_KEY,
} from '../../src/audio/pluginPresets/store.js'
import { registerPluginPresets } from '../../src/audio/pluginPresets/index.js'
import { usePluginPresets } from '../../src/composables/usePluginPresets.js'
import { readFileSync } from 'node:fs'

import {
  OPTO_SMOOTH_PRESETS, OPTO_SMOOTH_PARAM_KEYS, OPTO_SMOOTH_PRESET_PLUGIN,
} from '../../src/audio/pluginPresets/optoSmooth.js'
import {
  FET_PUNCH_PRESETS, FET_PUNCH_PARAM_KEYS, FET_PUNCH_PRESET_PLUGIN,
} from '../../src/audio/pluginPresets/fetPunch.js'
import {
  RESO_TAME_PARAM_KEYS, RESO_TAME_PRESET_PLUGIN,
  RESO_TAME_FOCUS_PRESETS, RESO_TAME_ZONE_PRESETS,
  resoTamePresetsFor, resoTamePluginId, registerResoTamePresets,
} from '../../src/audio/pluginPresets/resoTame.js'
import {
  RESONANCE_FOCUS_RANGES, RESONANCE_FOCUS_MAX_NODES, FOCUS_SHAPES,
} from '../../src/audio/resonanceFocus.js'
import { DEFAULT_TARGETING } from '../../src/audio/resonanceTargeting.js'
import {
  RESONANCE_ZONE_RANGES, RESONANCE_ZONE_MAX,
  RESONANCE_ATTACK_MIN_MS, RESONANCE_RELEASE_MIN_MS,
} from '../../src/audio/resonanceParams.js'

/**
 * A localStorage stand-in, so the store's persistence is exercised rather than
 * skipped. Without one it silently takes its "no storage" path and every user
 * preset test would pass against an in-memory map that never round-trips.
 */
function fakeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  }
}

function withStorage(fn) {
  const store = fakeStorage()
  globalThis.localStorage = store
  try {
    return fn(store)
  } finally {
    delete globalThis.localStorage
  }
}

/**
 * Wipe the registry and put the shipping collections back.
 *
 * ⚠ NEEDED BECAUSE THE STORE IS ONE MODULE-LEVEL REGISTRY and the whole file
 * runs in one process: a test that resets it to define a toy plugin would
 * otherwise leave every shipping collection un-registered for every test after
 * it, and those tests fail on a null rather than on what they measure.
 */
function isolate() {
  resetPluginPresets()
  registerPluginPresets()
  // ResoTame registers only the LIVE model's table under its own id, so the
  // other model's collection has to be asked for by name.
  registerResoTamePresets(DEFAULT_TARGETING === 'zones' ? 'focus' : 'zones')
}

// ── The two rules the store exists to enforce ─────────────────────────────

test('a factory preset must state every param — it does not inherit defaults', () => {
  resetPluginPresets()
  assert.throws(() => definePluginPresets({
    pluginId: 'p',
    paramKeys: ['a', 'b'],
    factory: [{ id: 'x', name: 'X', params: { a: 1 } }],
  }), /missing param "b"/)
})

test('a factory preset cannot carry anything that is not a param', () => {
  // ⚠ THE FAILURE THIS PREVENTS is the resonance panel's: DELTA and the
  // per-zone delta are monitoring modes, and `applyResonanceRegion` spreads
  // its param object straight into the kernel — so a preset that round-tripped
  // one would be a menu click and an Apply away from rendering a difference
  // signal into the timeline.
  resetPluginPresets()
  assert.throws(() => definePluginPresets({
    pluginId: 'p',
    paramKeys: ['a'],
    factory: [{ id: 'x', name: 'X', params: { a: 1, monitorDelta: true } }],
  }), /carries "monitorDelta"/)
})

test('the whitelist drops non-params on the way in and out', () => {
  resetPluginPresets()
  definePluginPresets({ pluginId: 'p', paramKeys: ['a'], factory: [] })
  const picked = pickParams('p', { a: 3, delta: true, selectedZone: 2 })
  assert.deepEqual(picked, { a: 3 })

  withStorage(() => {
    resetPluginPresets()
    definePluginPresets({ pluginId: 'p', paramKeys: ['a'], factory: [] })
    saveUserPreset('p', 'Mine', { a: 3, delta: true })
    const [saved] = listPresets('p')
    assert.deepEqual(presetParams('p', saved.id), { a: 3 })
  })
})

// ── Cloning, which is where the Vue proxies bite ──────────────────────────

test('params are deep-copied, so a stored preset cannot be mutated through the panel', () => {
  withStorage(() => {
    resetPluginPresets()
    definePluginPresets({ pluginId: 'p', paramKeys: ['zones'], factory: [] })
    const zones = [{ id: 'z1', hiHz: 500 }]
    const saved = saveUserPreset('p', 'Mine', { zones })
    zones[0].hiHz = 9000
    assert.equal(presetParams('p', saved.id).zones[0].hiHz, 500)

    const readBack = presetParams('p', saved.id)
    readBack.zones[0].hiHz = 1
    assert.equal(presetParams('p', saved.id).zones[0].hiHz, 500)
  })
})

test('clonePlain reads through a Proxy, which structuredClone refuses', () => {
  // ⚠ WHY IT IS HAND-ROLLED. The panels hold params in Vue refs, which hand
  // out reactive Proxies; structuredClone throws on those, and that throw took
  // the resonance spectrum display and DELTA down together once — it landed on
  // the first param push, so nothing after it ran.
  const target = { a: 1, zones: [{ hiHz: 500 }] }
  const proxy = new Proxy(target, {})
  assert.throws(() => structuredClone(proxy))
  assert.deepEqual(clonePlain(proxy), target)
})

// ── Matching, saving, deleting ────────────────────────────────────────────

test('matchPreset identifies the settings in effect and forgets them once a knob moves', () => {
  resetPluginPresets()
  definePluginPresets({
    pluginId: 'p', paramKeys: ['a', 'b'],
    factory: [{ id: 'f1', name: 'One', params: { a: 1, b: 2 } }],
  })
  assert.equal(matchPreset('p', { a: 1, b: 2 }), 'f1')
  assert.equal(matchPreset('p', { a: 1, b: 3 }), null)
})

test('a user preset wins a tie with a factory preset of identical settings', () => {
  // The user chose that name; it is the more informative of the two to show.
  withStorage(() => {
    resetPluginPresets()
    definePluginPresets({
      pluginId: 'p', paramKeys: ['a'],
      factory: [{ id: 'f1', name: 'One', params: { a: 1 } }],
    })
    const mine = saveUserPreset('p', 'Mine', { a: 1 })
    assert.equal(matchPreset('p', { a: 1 }), mine.id)
  })
})

test('saving over one of your own names overwrites in place, keeping its id', () => {
  withStorage(() => {
    resetPluginPresets()
    definePluginPresets({ pluginId: 'p', paramKeys: ['a'], factory: [] })
    const first = saveUserPreset('p', 'Mine', { a: 1 })
    const second = saveUserPreset('p', 'mine', { a: 2 })
    assert.equal(first.id, second.id, 'a second save under the same name made a second entry')
    assert.equal(listPresets('p').length, 1)
    assert.equal(presetParams('p', first.id).a, 2)
  })
})

test('a factory name cannot be taken by a user preset', () => {
  // A shipped preset is a fixed reference point. One that quietly became
  // something else would make every note citing it wrong.
  withStorage(() => {
    resetPluginPresets()
    definePluginPresets({
      pluginId: 'p', paramKeys: ['a'],
      factory: [{ id: 'f1', name: 'One', params: { a: 1 } }],
    })
    assert.throws(() => saveUserPreset('p', 'one', { a: 5 }), /built-in/)
  })
})

test('factory presets are not deletable', () => {
  withStorage(() => {
    resetPluginPresets()
    definePluginPresets({
      pluginId: 'p', paramKeys: ['a'],
      factory: [{ id: 'f1', name: 'One', params: { a: 1 } }],
    })
    assert.equal(deleteUserPreset('p', 'f1'), false)
    assert.equal(isFactoryPreset('p', 'f1'), true)
    assert.equal(listPresets('p').length, 1)
  })
})

test('user presets survive a reload of the store', () => {
  withStorage((store) => {
    resetPluginPresets()
    definePluginPresets({ pluginId: 'p', paramKeys: ['a'], factory: [] })
    saveUserPreset('p', 'Mine', { a: 7 })
    assert.ok(store.getItem(PRESET_STORAGE_KEY), 'nothing was written to storage')

    // Fresh registration, same storage — this is what a page reload looks like.
    resetPluginPresets()
    definePluginPresets({ pluginId: 'p', paramKeys: ['a'], factory: [] })
    const [mine] = listPresets('p')
    assert.equal(mine.name, 'Mine')
    assert.equal(presetParams('p', mine.id).a, 7)
  })
})

test('a corrupt or unreadable store is an empty one, not a crash', () => {
  const store = fakeStorage()
  store.setItem(PRESET_STORAGE_KEY, '{not json')
  globalThis.localStorage = store
  try {
    resetPluginPresets()
    definePluginPresets({ pluginId: 'p', paramKeys: ['a'], factory: [] })
    assert.deepEqual(listPresets('p'), [])
  } finally {
    delete globalThis.localStorage
  }
})

test('no storage at all still gives a working session', () => {
  resetPluginPresets()
  definePluginPresets({ pluginId: 'p', paramKeys: ['a'], factory: [] })
  const saved = saveUserPreset('p', 'Mine', { a: 1 })
  assert.equal(presetParams('p', saved.id).a, 1)
})

// ── The menu composable ───────────────────────────────────────────────────

test('a preset that disappears leaves nothing lit and nothing dirty', () => {
  // ⚠ THE READOUTS ARE MEASURED AGAINST THE RECONCILED PRESET, NOT THE RAW ID.
  // A `selectedId` naming something no longer in the list used to leave `dirty`
  // true with `activePreset` null — a trigger lit as modified while naming
  // nothing, and a "Revert to " item with an empty name after it, calling
  // revert with an id that can no longer be loaded. `remove()` clears the id on
  // its own path, but a rule applied per gesture is a rule with a gesture
  // missing from it.
  withStorage(() => {
    resetPluginPresets()
    definePluginPresets({ pluginId: 'p', paramKeys: ['a'], factory: [] })
    const live = { a: 1 }
    const presets = usePluginPresets('p', { read: () => ({ ...live }), write: (v) => Object.assign(live, v) })

    const saved = saveUserPreset('p', 'Mine', { a: 1 })
    presets.select(saved.id)
    live.a = 2
    assert.equal(presets.dirty.value, true, 'a moved knob is not reported as modified')

    // Deleted straight through the store, which is the path `remove()` does not
    // cover.
    deleteUserPreset('p', saved.id)
    assert.equal(presets.activePreset.value, null)
    assert.equal(presets.dirty.value, false, 'a vanished preset still reads as modified')
    assert.equal(presets.label.value, 'Presets')
    assert.equal(presets.revert(), false, 'revert claimed to reload a preset that is gone')
  })
})

test('deleting the selected preset falls back to whatever the settings match', () => {
  // Why `remove()` clears the id eagerly rather than leaving it to the
  // reconcile: naming the factory preset the settings still match is more
  // informative than going blank.
  withStorage(() => {
    resetPluginPresets()
    definePluginPresets({
      pluginId: 'p', paramKeys: ['a'],
      factory: [{ id: 'f1', name: 'One', params: { a: 1 } }],
    })
    const live = { a: 1 }
    const presets = usePluginPresets('p', { read: () => ({ ...live }), write: (v) => Object.assign(live, v) })
    const mine = saveUserPreset('p', 'Mine', { a: 1 })
    presets.select(mine.id)
    presets.remove(mine.id)
    assert.equal(presets.activePreset.value?.id, 'f1')
    assert.equal(presets.dirty.value, false)
  })
})

test('nothing selected is not the same as modified', () => {
  resetPluginPresets()
  definePluginPresets({
    pluginId: 'p', paramKeys: ['a'],
    factory: [{ id: 'f1', name: 'One', params: { a: 1 } }],
  })
  const live = { a: 99 }
  const presets = usePluginPresets('p', { read: () => ({ ...live }), write: (v) => Object.assign(live, v) })
  assert.equal(presets.dirty.value, false, 'a file never given a preset reads as modified')
  assert.equal(presets.label.value, 'Presets')
})

test('the menu routes REVERT through the same disabled guard a selection takes', () => {
  // ⚠ REVERTING IS A PARAMETER CHANGE, which is exactly what `disabled` refuses
  // — so a bypassed plugin whose menu prints "turn this on to use presets" was
  // still one click from having its settings rewritten (pick a preset, move a
  // knob, bypass, open the menu). Read from the source the way
  // resonanceZoneDelta.test.js reads its own guarantee: this suite stops below
  // the components, so the wiring cannot be exercised, only pinned.
  const src = readFileSync(
    new URL('../../src/components/panels/PresetMenu.vue', import.meta.url), 'utf8')
  assert.match(src, /function revert\(\)\s*\{\s*if \(props\.disabled\) return/,
    'revert() does not check disabled')
  assert.equal(/@click="presets\.revert\(\)/.test(src), false,
    'the template calls presets.revert() directly, bypassing the guard')
  // Saving and deleting stay available while disabled on purpose: neither
  // changes the sound, which is the same reasoning that lets a delete need no
  // confirmation.
  assert.match(src, /@click="startSave"/)
})

test('paramsEqual is structural over nested arrays and objects', () => {
  assert.equal(paramsEqual([{ a: 1 }], [{ a: 1 }]), true)
  assert.equal(paramsEqual([{ a: 1 }], [{ a: 1, b: 2 }]), false)
  assert.equal(paramsEqual({ a: [1, 2] }, { a: [1, 2] }), true)
  assert.equal(paramsEqual({ a: [1, 2] }, { a: [2, 1] }), false)
})

// ── The shipped collections ───────────────────────────────────────────────

const RESO_TAME_PRESETS = resoTamePresetsFor(DEFAULT_TARGETING)

const COLLECTIONS = [
  ['OptoSmooth', OPTO_SMOOTH_PRESET_PLUGIN, OPTO_SMOOTH_PRESETS, OPTO_SMOOTH_PARAM_KEYS],
  ['FET Punch', FET_PUNCH_PRESET_PLUGIN, FET_PUNCH_PRESETS, FET_PUNCH_PARAM_KEYS],
  ['ResoTame', RESO_TAME_PRESET_PLUGIN, RESO_TAME_PRESETS, RESO_TAME_PARAM_KEYS],
  // The other targeting model's table is authored content, not dead code: the
  // flag is what reaches it, and it has to hold up to the same rules.
  ['ResoTame (zones)', resoTamePluginId('zones'), RESO_TAME_ZONE_PRESETS, RESO_TAME_PARAM_KEYS],
]

for (const [label, pluginId, presets, keys] of COLLECTIONS) {
  test(`${label} ships a small, complete, distinct collection`, () => {
    isolate()
    assert.ok(presets.length >= 4 && presets.length <= 6,
      `${label} ships ${presets.length} presets — a "small collection" is 4–6`)

    const names = new Set()
    const ids = new Set()
    for (const p of presets) {
      assert.ok(p.name && p.description, `${p.id} is missing a name or a description`)
      assert.equal(names.has(p.name), false, `duplicate name ${p.name}`)
      assert.equal(ids.has(p.id), false, `duplicate id ${p.id}`)
      names.add(p.name)
      ids.add(p.id)
      // Rule 2 again, at the content layer: a preset that omitted a param
      // would change meaning the next time that default moved.
      assert.deepEqual(Object.keys(p.params).sort(), [...keys].sort(),
        `${p.id} does not state exactly this plugin's params`)
    }
  })

  test(`${label} presets are distinct settings, not just distinct names`, () => {
    isolate()
    // A menu of five names that are three settings is worse than a menu of
    // three: it invites an A/B between two identical renders.
    const seen = []
    for (const p of presets) {
      const params = pickParams(pluginId, p.params)
      assert.equal(seen.some(s => paramsEqual(s, params)), false,
        `${p.id} duplicates the settings of another preset`)
      seen.push(params)
    }
  })

  test(`${label} presets survive normalisation unchanged`, () => {
    isolate()
    // A factory preset that the plugin's own clamp would move is a preset
    // stating a setting the panel cannot reach — it would read as MODIFIED
    // the instant it was chosen.
    for (const p of presets) {
      assert.deepEqual(pickParams(pluginId, p.params), pickParams(pluginId, pickParams(pluginId, p.params)),
        `${p.id} is not a fixed point of its own normalisation`)
      assert.equal(matchPreset(pluginId, p.params), p.id,
        `${p.id} does not match itself — the menu would show it as modified`)
    }
  })
}

test('the auto-owned makeup knob is not part of the comparison while AUTO is on', () => {
  isolate()
  // ⚠ THE BUG THIS PREVENTS. With AUTO on, the plugin owns the makeup knob and
  // writes a measured value into it from the selection — so a preset stating a
  // gain would disagree with the knob within one measurement, through no edit
  // by the user, and every preset would read as MODIFIED a moment after being
  // chosen. Turning AUTO off makes the knob part of the preset again.
  const withAuto = { ...OPTO_SMOOTH_PRESETS[0].params, gain: 9.45 }
  assert.equal(matchPreset(OPTO_SMOOTH_PRESET_PLUGIN, withAuto), OPTO_SMOOTH_PRESETS[0].id)

  const manual = { ...OPTO_SMOOTH_PRESETS[0].params, autoMakeup: false, gain: 0 }
  assert.equal(pickParams(OPTO_SMOOTH_PRESET_PLUGIN, { ...manual, gain: 4 }).gain, 4,
    'with AUTO off the gain must be part of the preset')

  const fetAuto = { ...FET_PUNCH_PRESETS[0].params, output: -12 }
  assert.equal(matchPreset(FET_PUNCH_PRESET_PLUGIN, fetAuto), FET_PUNCH_PRESETS[0].id)
})

test('ResoTame presets carry neither the reference mode nor any monitoring state', () => {
  isolate()
  // refMode is a build-level research override and the two references disagree
  // about what Selectivity measures by an order of magnitude. The monitoring
  // modes are the delta trap. Neither is a preset param.
  for (const key of ['refMode', 'delta', 'deltaZone', 'selectedZone', 'selectedNode']) {
    assert.equal(RESO_TAME_PARAM_KEYS.includes(key), false, `${key} is a preset param`)
  }
  const smuggled = pickParams(RESO_TAME_PRESET_PLUGIN, {
    ...RESO_TAME_PRESETS[0].params, refMode: 'cepstral', deltaZone: 1,
  })
  assert.equal('refMode' in smuggled, false)
  assert.equal('deltaZone' in smuggled, false)
})

test('the focus SOLO is dropped, and it is the one that would not look wrong', () => {
  // ⚠ SOLO IS A MONITORING MODE LIVING ON THE PARAMS OBJECT. Unlike DELTA it is
  // an ordinary field on the focus patch — `focus.solo` — so a preset carrying
  // it would round-trip through the whitelist untouched and Apply would render
  // a ONE-NODE PASS into the timeline, with nothing about the stored object
  // looking wrong. The whitelist cannot catch it, because `focus` IS a param;
  // normalisation has to rebuild the patch field by field instead.
  isolate()
  const smuggled = pickParams(RESO_TAME_PRESET_PLUGIN, {
    ...RESO_TAME_PRESETS[1].params,
    focus: { ...RESO_TAME_PRESETS[1].params.focus, solo: 0 },
  })
  assert.equal('solo' in (smuggled.focus ?? {}), false, 'a preset can carry a solo')
})

test('the two targeting models get separate collections, factory AND user', () => {
  // ⚠ THE HAZARD THIS CLOSES. The kernel dispatches on `focus`: a non-null
  // patch TAKES OVER from the zone set. User presets persist across sessions
  // and are keyed by plugin id, so one saved under zones would appear in a
  // focus session's menu carrying `focus: null` — and selecting it would switch
  // the model under a panel still showing focus controls, from a menu click,
  // with nothing saying so.
  assert.notEqual(resoTamePluginId('focus'), resoTamePluginId('zones'))
  withStorage(() => {
    isolate()
    saveUserPreset(resoTamePluginId('zones'), 'Zone Patch', RESO_TAME_ZONE_PRESETS[1].params)
    const focusNames = listPresets(resoTamePluginId('focus')).map(p => p.name)
    assert.equal(focusNames.includes('Zone Patch'), false,
      'a zone-model preset reached the focus-model menu')
  })
})

test('normalisation cannot switch the targeting model out from under a session', () => {
  isolate()
  // In a focus session a null patch is repaired rather than passed through:
  // null is not a missing value, it is the instruction to read the zone set.
  const repaired = pickParams(resoTamePluginId('focus'), {
    ...RESO_TAME_FOCUS_PRESETS[0].params, focus: null,
  })
  assert.notEqual(repaired.focus, null, 'a null patch survived into a focus collection')
  assert.deepEqual(repaired.focus.nodes, [])

  // And the reverse: nothing out of storage can hand a zone session a patch.
  const dropped = pickParams(resoTamePluginId('zones'), {
    ...RESO_TAME_ZONE_PRESETS[0].params, focus: RESO_TAME_FOCUS_PRESETS[1].params.focus,
  })
  assert.equal(dropped.focus, null, 'a focus patch survived into a zone collection')
})

test('every ResoTame focus patch is one the panel could have produced', () => {
  isolate()
  const R = RESONANCE_FOCUS_RANGES
  for (const p of RESO_TAME_FOCUS_PRESETS) {
    const { focus, attack, release } = pickParams(resoTamePluginId('focus'), p.params)
    assert.notEqual(focus, null, `${p.id}: a focus preset with no patch`)
    const g = focus.global
    assert.ok(g.selectivity >= R.selectivity.min && g.selectivity <= R.selectivity.max, `${p.id}: threshold`)
    assert.ok(g.depth >= R.depth.min && g.depth <= R.depth.max, `${p.id}: depth`)
    assert.ok(g.maxCut >= R.maxCut.min && g.maxCut <= R.maxCut.max, `${p.id}: maxCut`)
    assert.ok(g.sharpness >= R.sharpness.min && g.sharpness <= R.sharpness.max, `${p.id}: sharpness`)
    assert.ok(focus.nodes.length <= RESONANCE_FOCUS_MAX_NODES, `${p.id}: too many nodes`)
    const ids = new Set()
    for (const n of focus.nodes) {
      assert.equal(ids.has(n.id), false, `${p.id}: duplicate node id ${n.id}`)
      ids.add(n.id)
      assert.ok(FOCUS_SHAPES.includes(n.shape), `${p.id}: unknown shape ${n.shape}`)
      assert.ok(n.hz >= R.hz.min && n.hz <= R.hz.max, `${p.id}: node frequency`)
      assert.ok(n.spanOct >= R.spanOct.min && n.spanOct <= R.spanOct.max, `${p.id}: node span`)
      assert.ok(n.biasDb >= R.biasDb.min && n.biasDb <= R.biasDb.max, `${p.id}: node amount`)
    }
    assert.ok(attack >= RESONANCE_ATTACK_MIN_MS, `${p.id}: attack below the floor that does anything`)
    assert.ok(release >= RESONANCE_RELEASE_MIN_MS, `${p.id}: release below the floor that does anything`)
  }
})

test('a focus node that stands a band down carries a NEGATIVE amount', () => {
  // ⚠ THE SIGN IS THE OPPOSITE OF THE ARITHMETIC. Selectivity is a THRESHOLD, so
  // it runs backwards — higher means less is cut — and a node's amount is stated
  // the way a person thinks about it, positive being "work harder here", which
  // means it is SUBTRACTED from the global. Getting it backwards produces a
  // preset that looks entirely functional and does the reverse of its name, so
  // the intent is asserted here rather than left to a downstream measurement.
  isolate()
  const sib = pickParams(resoTamePluginId('focus'), RESO_TAME_FOCUS_PRESETS[1].params).focus
  const worked = sib.nodes.find(n => n.shape === 'high')
  const stoodDown = sib.nodes.find(n => n.shape === 'low')
  assert.ok(worked.biasDb > 0, 'Sibilance Tame does not work the top harder')
  assert.ok(stoodDown.biasDb < 0, 'Sibilance Tame does not stand the bottom down')
})

test('every ResoTame zone set is one the editor could have produced', () => {
  isolate()
  const R = RESONANCE_ZONE_RANGES
  for (const p of RESO_TAME_ZONE_PRESETS) {
    const { zones, attack, release, focus } = pickParams(resoTamePluginId('zones'), p.params)
    assert.equal(focus, null, `${p.id}: a zone preset carrying a focus patch`)
    assert.ok(zones.length >= 1 && zones.length <= RESONANCE_ZONE_MAX, `${p.id}: zone count`)
    // The top zone reaches the top of the spectrum, or there is a band with no
    // zone over it — a state the editor cannot produce and the kernel has no
    // answer for.
    assert.equal(zones[zones.length - 1].hiHz, 20000, `${p.id}: top zone stops short`)
    for (let i = 1; i < zones.length; i++) {
      assert.ok(zones[i].hiHz > zones[i - 1].hiHz, `${p.id}: boundaries out of order`)
    }
    for (const z of zones) {
      assert.ok(z.depth >= R.depth.min && z.depth <= R.depth.max, `${p.id}: depth`)
      assert.ok(z.selectivity >= R.selectivity.min && z.selectivity <= R.selectivity.max, `${p.id}: selectivity`)
      assert.ok(z.maxCut >= R.maxCut.min && z.maxCut <= R.maxCut.max, `${p.id}: maxCut`)
      assert.ok(z.sharpness >= R.sharpness.min && z.sharpness <= R.sharpness.max, `${p.id}: sharpness`)
    }
    assert.ok(attack >= RESONANCE_ATTACK_MIN_MS, `${p.id}: attack below the floor that does anything`)
    assert.ok(release >= RESONANCE_RELEASE_MIN_MS, `${p.id}: release below the floor that does anything`)
  }
})

test('ResoTame normalisation repairs a stored zone set rather than passing it on', () => {
  isolate()
  // Unlike a knob value, a stored zone set never went through a control. Out of
  // order, out of range, and stopping short of the top are all reachable from
  // an older build's storage, and all three reach the kernel if nothing checks.
  const repaired = pickParams(resoTamePluginId('zones'), {
    attack: 1, release: 99999, mode: 'nonsense', mix: 5, trim: -99, focus: null,
    zones: [
      { id: 'z1', hiHz: 5000, depth: 4, selectivity: 900, maxCut: 900, sharpness: -1 },
      { id: 'z2', hiHz: 200, depth: 0.5 },
    ],
  })
  assert.deepEqual(repaired.zones.map(z => z.hiHz), [200, 20000], 'boundaries not sorted and closed')
  assert.equal(repaired.mode, 'soft')
  assert.equal(repaired.mix, 1)
  assert.equal(repaired.attack, RESONANCE_ATTACK_MIN_MS)
  assert.equal(repaired.trim, -12)
  for (const z of repaired.zones) {
    assert.ok(z.depth <= 1 && z.depth >= 0)
    assert.ok(z.selectivity <= RESONANCE_ZONE_RANGES.selectivity.max)
    assert.ok(z.sharpness >= 0)
  }
})

test('ResoTame normalisation repairs a stored focus patch too', () => {
  isolate()
  const repaired = pickParams(resoTamePluginId('focus'), {
    ...RESO_TAME_FOCUS_PRESETS[0].params,
    focus: {
      global: { selectivity: 900, depth: -4, maxCut: 900, protectCeilHz: 1 },
      nodes: [
        { id: 'n1', shape: 'wobble', hz: 99999, spanOct: 99, biasDb: 900 },
        ...Array.from({ length: RESONANCE_FOCUS_MAX_NODES + 3 }, (_, i) => ({ id: `x${i}`, hz: 1000 })),
      ],
    },
  })
  const R = RESONANCE_FOCUS_RANGES
  assert.equal(repaired.focus.global.selectivity, R.selectivity.max)
  assert.equal(repaired.focus.global.depth, R.depth.min)
  assert.equal(repaired.focus.nodes.length, RESONANCE_FOCUS_MAX_NODES, 'node list not capped')
  // An unrecognised shape falls back rather than passing through — a typo must
  // not produce a fourth behaviour downstream.
  assert.equal(repaired.focus.nodes[0].shape, 'bell')
  assert.equal(repaired.focus.nodes[0].hz, R.hz.max)
  assert.equal(repaired.focus.nodes[0].biasDb, R.biasDb.max)
})

test('FET Punch normalisation keeps the dials on their detents and the ratio on a real position', () => {
  isolate()
  const p = pickParams(FET_PUNCH_PRESET_PLUGIN, {
    inputDrive: 200, output: 0, attack: 4.5, release: 99, ratio: '3',
    fetDrive: 2, scHpf: -5, mix: 3, autoMakeup: false,
  })
  assert.equal(p.inputDrive, 100)
  assert.equal(p.attack, 5, 'a dial landed between detents')
  assert.equal(p.release, 7)
  // ⚠ The kernel's own setParam guard would drop an unknown ratio SILENTLY —
  // the failure the soft clipper's dead ratio knobs shipped. Falling back to a
  // real position means the panel and the kernel agree about what is playing.
  assert.equal(p.ratio, '4')
  assert.equal(p.fetDrive, 1)
  assert.equal(p.scHpf, 0)
  assert.equal(p.mix, 1)
})
