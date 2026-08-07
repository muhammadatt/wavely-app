import { ref, computed, shallowRef } from 'vue'
import { useWindows } from './useWindows.js'
import { createEqInstance } from './useEqInstance.js'
import { voiceRxEqEffect } from '../audio/effects/manualEq.js'
import { renderRegionToBuffer } from '../audio/processing.js'
import {
  getRole, bandForRole, ROLES_IN_ORDER, isBandActive,
} from '../audio/eqBands.js'
import { analyzeVoiceRx, MIN_VOICED_FRAMES, HOP_SIZE, FRAME_SIZE } from '../audio/voicerx/analysis.js'
import { buildSuggestions, suggestionToBand } from '../audio/voicerx/suggestions.js'
import { MALE_REGIONS } from '../audio/voicerx/regions.js'
import { getTimelineDuration } from '../audio/operations.js'
import { receiveBands } from './useManualEq.js'

// Registry id of this plugin's window. Must match the entry in src/ui/registry.js.
export const VOICERX_WINDOW_ID = 'voicerx'

/**
 * VoiceRx — the voice diagnosis plugin.
 *
 * Its own band pool and its own node in the chain, placed ahead of the general
 * EQ: corrective before creative, the order the server pipeline uses. It was
 * once a second view onto the EQ's pool; see useEqInstance.js for why that was
 * abandoned.
 *
 * Bands here are role-tagged and measurement-derived. They can be handed to the
 * EQ, which strips the tags and treats them as ordinary parametric bands. There
 * is no route back — a general band has no role to recover, and a pool that
 * accepted arbitrary bands could not promise that what it shows is what it
 * measured.
 */
const instance = createEqInstance({
  effect: voiceRxEqEffect,
  windowId: VOICERX_WINDOW_ID,
  label: 'VoiceRx',
  // A band here is the control for a named characteristic, so its range is a
  // wall rather than the general EQ's trapdoor — see clampBandToRole.
  frequencyPolicy: 'clamp',
})

// Analysis is heavy and frozen; the curves inside it are typed arrays that must
// never become reactive proxies, hence shallowRef.
const analysis = shallowRef(null)
const analyzedKey = ref(null)
const analyzing = ref(false)
const analysisError = ref(null)
const analysisWidened = ref(false)

/**
 * Whether the panel has moved past its opening offer to analyse.
 *
 * The plugin opens on the diagnosis and nothing else, because that is the thing
 * a first-time user can act on without knowing any of the vocabulary: press one
 * button, hear the voice fixed, then read what was wrong. Nine knobs and a plot
 * arriving at the same moment is a lot to meet before any of it means anything.
 *
 * Anyone who already knows the tool can step past it, and a completed analysis
 * steps past it too — once the controls have been seen there is no teaching
 * left to do and returning to the offer would read as the panel forgetting.
 *
 * Module-level, so it holds for the session and not merely while the window is
 * open. It resets on reload, which errs toward the new user; nothing else in
 * this app persists a preference across loads and one flag is not the place to
 * start.
 */
const introDismissed = ref(false)

export function openVoiceRxWindow() {
  useWindows().openWindow(VOICERX_WINDOW_ID)
}

export function useVoiceRx() {
  const api = instance.use()
  const { state, showToast, bands } = api

  // ── Analysis bookkeeping ──────────────────────────────────────────────────

  /** Key describing the exact audio a result was measured from. */
  function selectionKey() {
    if (!state.selection || !state.currentFile) return null
    const { start, end } = state.selection
    const ids = state.segments.map(s => s.sourceBufferId ?? 'silence').join(',')
    return `${start.toFixed(6)}:${end.toFixed(6)}:${ids}`
  }

  const isStale = computed(
    () => analysis.value !== null && analyzedKey.value !== selectionKey(),
  )

  /**
   * There is a result to show. Deliberately not "and it is still fresh".
   *
   * Staleness used to be folded in here, and it made a nudged selection erase
   * the diagnosis: the panel dropped back to its ANALYZE prompt while the
   * corrections that analysis had made were still in the pool and still
   * audible, the per-suggestion switches went with it, and the "selection
   * changed" banner could never render because it lives inside the branch that
   * had just unmounted. A measurement does not stop being true because the
   * selection moved — it stops describing what is selected now, which is a
   * caption, not a reason to throw it away. Freshness is isStale's job, shown
   * as a banner over a result that stays put; the de-esser and hum remover
   * report it the same way.
   */
  const hasAnalysis = computed(() => analysis.value?.ok === true)

  /**
   * The resolved region table.
   *
   * Before analysis there is no measured voice type, so role ranges fall back to
   * the male table. That only affects where a *manually* added role band is
   * allowed to sit — nothing is claimed about the speaker until Analyze has run.
   */
  const regions = computed(() => analysis.value?.regions ?? MALE_REGIONS)

  /**
   * Suggestions are derived, never stored (spec §9.2).
   *
   * Recomputing them from the frozen analysis means there is no pending state
   * to discard or restore, and nothing can go stale independently of the
   * analysis it came from.
   *
   * Every suggestion the analysis produced is listed, including the ones
   * currently switched off. They used to be filtered out once applied, which
   * made sense while applying was a decision the user made per row; now that
   * analysis applies them on arrival, a row disappearing on apply would take
   * away the only control for switching it back off.
   */
  const suggestions = computed(() =>
    (hasAnalysis.value ? buildSuggestions(analysis.value) : []))

  /**
   * Each suggestion paired with the band carrying it, if there is one.
   *
   * The band is the state — enabled, gain, frequency — and the suggestion is the
   * explanation. Neither is derivable from the other, which is why the row needs
   * both: the note says what was heard, the band says what is being done about
   * it right now.
   */
  const suggestionRows = computed(() => suggestions.value.map(s => ({
    suggestion: s,
    band: s.roleId ? bandForRole(bands.value, s.roleId) : null,
  })))

  /**
   * How many suggestions are actually doing something.
   *
   * Counted with isBandActive, the same rule the faceplate's correction count
   * and the Apply gate use. Counting `enabled` alone let a band turned down to
   * 0 dB by its knob read as on here and as nothing everywhere else — "3 of 4
   * on" over a header that said 2 corrections, with Apply greyed out.
   */
  const activeSuggestionCount = computed(
    () => suggestionRows.value.filter(r => r.band && isBandActive(r.band)).length)

  // ── Applying ──────────────────────────────────────────────────────────────

  /**
   * Put every suggestion into the pool, switched on.
   *
   * Called by analyze(), so a diagnosis arrives already corrected and the first
   * thing the user hears is the fixed version. The previous design listed the
   * corrections and waited to be told to apply each one, which reads as
   * cautious and plays as broken: the panel described problems while the audio
   * still had them, and the obvious next action was a button press away.
   *
   * Nothing is lost by applying first — every row can be switched off, the EQ
   * as a whole can be bypassed, and nothing touches the file until Apply.
   */
  function applyAllSuggestions() {
    for (const s of suggestions.value) {
      if (bands.value.length >= api.maxBands) break
      const existing = s.roleId ? bandForRole(bands.value, s.roleId) : null
      const band = suggestionToBand(s, regions.value)
      // One band per role: a second correction over the same region stacks two
      // filters where the analysis measured one problem.
      bands.value = existing
        ? bands.value.map(b => (b.id === existing.id ? band : b))
        : [...bands.value, band]
    }
    api.pushBands()
  }

  /**
   * Switch one suggestion's correction on or off.
   *
   * A row is never a dead switch, which means answering for every way a
   * correction can be inert, not just the obvious one. A band is doing nothing
   * if it is switched off — or if its knob has been turned to 0 dB, which the
   * switch reads as off because that is what it sounds like. Turning such a row
   * back on restores the measured gain; flipping `enabled` alone would leave the
   * switch exactly where it was and look broken.
   *
   * Rebuilds the band outright if it is missing — after a Clear, or after the
   * user sent the corrections to the EQ.
   */
  function toggleSuggestion(suggestion) {
    const existing = suggestion.roleId ? bandForRole(bands.value, suggestion.roleId) : null
    if (existing) {
      if (isBandActive(existing)) {
        api.toggleBand(existing.id)
        return
      }
      api.updateBand(existing.id, (b) => {
        b.enabled = true
        if (b.gainDb === 0) b.gainDb = suggestion.gainDb
      })
      return
    }
    if (api.atBandLimit.value) {
      showToast(`VoiceRx holds ${api.maxBands} bands — remove one to add another`)
      return
    }
    bands.value = [...bands.value, suggestionToBand(suggestion, regions.value)]
    api.pushBands()
  }

  function setAllSuggestions(on) {
    if (on) {
      // Re-create anything missing, then make sure the whole set is enabled.
      applyAllSuggestions()
      bands.value = bands.value.map(b => (b.origin === 'suggestion'
        ? { ...b, enabled: true } : b))
    } else {
      bands.value = bands.value.map(b => (b.origin === 'suggestion'
        ? { ...b, enabled: false } : b))
    }
    api.pushBands()
  }

  /** Latching solo, matching the EQ's per-band S button. */
  function toggleSolo(band) {
    if (!band) return
    if (api.soloBandId.value === band.id) api.clearSolo()
    else api.setSolo(band.id)
  }

  /**
   * Audition a role, band or no band.
   *
   * "What does this word even sound like" is the question the palette exists to
   * answer, and it is asked before anything has been turned up, not after — so
   * solo cannot require a band to hang a monitor filter on. With no band it
   * sends a probe at the role's own centre and canonical width, which is the
   * region the control would act on if it were turned up.
   */
  function toggleRoleSolo(roleId) {
    const band = bandForRole(bands.value, roleId)
    if (band) {
      toggleSolo(band)
      return
    }
    if (api.soloProbe.value?.roleId === roleId) {
      api.clearSolo()
      return
    }
    const role = getRole(roleId)
    api.setSoloProbe({
      roleId,
      type: role.type,
      frequencyHz: roleCentreHz(roleId),
      q: role.canonicalQ,
    })
  }

  function isRoleSoloed(roleId) {
    const band = bandForRole(bands.value, roleId)
    return band
      ? api.soloBandId.value === band.id
      : api.soloProbe.value?.roleId === roleId
  }

  // ── The palette ───────────────────────────────────────────────────────────

  /**
   * Every role, always, in frequency order.
   *
   * This used to be a subset: six roles by default, the rest appearing when a
   * suggestion targeted one or the user added it from a chip. That was the
   * right instinct for a findings panel and the wrong one for a palette. The
   * nine regions tile the voice contiguously from 60 Hz to 16 kHz (see
   * voicerx/regions.js) — together they are a complete map, and showing two
   * thirds of a map leaves the user to conclude the missing part is not
   * covered rather than that it is one click away.
   *
   * The deciding argument is constancy. The visible set was a function of what
   * the last analysis happened to find, so the control surface was arranged
   * differently on every file. A vocabulary you are meant to learn — reach for
   * "nasal" without knowing it lives at 650-1200 Hz — cannot be one that moves
   * between sessions.
   *
   * What is lost is the signal that appearing carried for free: which roles the
   * analysis actually flagged. That is now marked on the controls themselves
   * (detectedRoles), because it is information about this file, and only the
   * layout should be constant.
   */
  const paletteRoles = ROLES_IN_ORDER

  /** Roles the current analysis raised a finding for. */
  const detectedRoles = computed(
    () => new Set(suggestions.value.map(s => s.roleId).filter(Boolean)))

  /** The gain of a role's band, or 0 where the role has no band yet. */
  function roleGain(roleId) {
    return bandForRole(bands.value, roleId)?.gainDb ?? 0
  }

  /**
   * Where a role sits: the band's frequency if it has one, the measured
   * anomaly's centre if the analysis found one there, otherwise the geometric
   * centre of the role's scan range.
   *
   * Answers the question for a role with no band too, which is what lets the
   * detail strip and the solo probe describe a control before it has been
   * touched.
   */
  function roleCentreHz(roleId) {
    const band = bandForRole(bands.value, roleId)
    if (band) return band.frequencyHz

    const role = getRole(roleId)
    const measured = analysis.value?.regionResults?.find(r => r.roleId === roleId)
    if (measured && Number.isFinite(measured.centerHz)) return measured.centerHz

    const [lo, hi] = measured
      ? [measured.scanLowHz, measured.scanHighHz]
      : (regions.value[role.region] ?? [200, 400])
    return Math.sqrt(lo * hi)
  }

  /** The width in use: the band's Q, or the role's canon where there is none. */
  function roleQ(roleId) {
    return bandForRole(bands.value, roleId)?.q ?? getRole(roleId).canonicalQ
  }

  /**
   * Narrow or widen a role.
   *
   * Only meaningful once the role has a band — width is a property of a
   * correction, and there is nothing to be wide. The strip disables the control
   * rather than minting an inert band to hold a number nobody is hearing.
   */
  function setRoleQ(roleId, q) {
    const band = bandForRole(bands.value, roleId)
    if (band) api.setQ(band.id, q)
  }

  /**
   * What a role's ON button should show, and whether it can be pressed.
   *
   * The general EQ's equivalent reads `band.enabled` and nothing else, because
   * there every strip has a band behind it. Here a role can have no band — the
   * resting state, since an inert band would hold a pool slot for nothing — and
   * a band can be switched on while its knob sits at 0 dB, which is on and
   * silent. Both are off as far as the ear is concerned, and both are states
   * this button cannot do anything about: there is no gain to restore, because
   * nothing measured one. So they read OFF and do not take a press, with the
   * knob directly above saying why.
   *
   * 'on' is exactly isBandActive, which keeps this button and the findings
   * list's switch describing the same band the same way.
   */
  function roleOnState(roleId) {
    const band = bandForRole(bands.value, roleId)
    if (!band) return 'absent'
    if (band.gainDb === 0) return 'flat'
    return band.enabled ? 'on' : 'off'
  }

  function toggleRoleEnabled(roleId) {
    const band = bandForRole(bands.value, roleId)
    if (band && band.gainDb !== 0) api.toggleBand(band.id)
  }

  /** Put a role back to untouched: flat, and at its canonical width. */
  function resetRole(roleId) {
    const band = bandForRole(bands.value, roleId)
    if (!band) return
    api.resetQ(band.id)
    api.setGain(band.id, 0)
  }

  /**
   * Move a role's gain, creating the band on first touch.
   *
   * A role knob at 0 dB with no band behind it is the correct resting state: an
   * inert band would occupy one of the twelve slots for no reason.
   */
  function setRoleGain(roleId, db) {
    const existing = bandForRole(bands.value, roleId)
    if (existing) {
      // Moving a switched-off correction switches it back on. A knob that
      // visibly moves and changes nothing is the worse of the two surprises.
      if (!existing.enabled) api.toggleBand(existing.id)
      api.setGain(existing.id, db)
      return
    }
    if (db === 0) return
    api.addBand({
      role: roleId,
      regions: regions.value,
      frequencyHz: roleCentreHz(roleId),
      gainDb: db,
      origin: 'manual_voicerx',
    })
  }

  // ── Hand-off to the EQ ────────────────────────────────────────────────────

  const canSendToEq = computed(() => api.activeBands.value.length > 0)

  /**
   * Move these corrections into the general EQ.
   *
   * A move, not a copy. Two pools holding the same correction with both
   * plugins engaged applies it twice, and no amount of warning copy makes that
   * a good default — so the bands leave here as they arrive there. What is left
   * behind is the analysis, so the suggestions come straight back and the
   * diagnosis is not lost.
   */
  function sendToEq() {
    const specs = api.activeBands.value.map(b => ({
      type: b.type,
      frequencyHz: b.frequencyHz,
      gainDb: b.gainDb,
      q: b.q,
      enabled: b.enabled,
    }))
    if (specs.length === 0) return

    const { added, dropped } = receiveBands(specs)
    // Stays engaged. The pool is empty now so the node is transparent, and
    // leaving it on means the next suggestion applied here is audible at once
    // rather than needing the plugin switched back on first.
    api.clearBands()

    showToast(dropped > 0
      ? `${added} band${added === 1 ? '' : 's'} moved to EQ — ${dropped} dropped, EQ is full`
      : `${added} band${added === 1 ? '' : 's'} moved to EQ`)
  }

  // ── Analyze ───────────────────────────────────────────────────────────────

  /**
   * Widen a too-short selection symmetrically into the surrounding audio.
   *
   * Used for display and suggestion generation only — the EQ is still applied to
   * the user's actual selection. Reaching outside is honest as long as it is
   * labelled, and it beats refusing to analyse a phrase that happens to be short.
   *
   * The frame constants are sample counts, so the duration they need depends on
   * the file's own rate — analysis runs at the file's native rate, and a server
   * round-trip can change it. Widening against a fixed 44.1 kHz would reach too
   * far on lower rates and too little on higher ones.
   */
  function widenedRange(start, end, duration, sampleRate) {
    const needed = ((MIN_VOICED_FRAMES * HOP_SIZE + FRAME_SIZE) / sampleRate) * 3
    if (end - start >= needed) return { start, end, widened: false }
    const grow = (needed - (end - start)) / 2
    const s = Math.max(0, start - grow)
    const e = Math.min(duration, end + grow)
    return { start: s, end: e, widened: s !== start || e !== end }
  }

  /**
   * Resolve after the browser has painted.
   *
   * The first frame callback runs before the coming paint, the second after it,
   * so awaiting this guarantees the DOM changes queued so far are on screen.
   */
  function nextPaint() {
    return new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }

  async function analyze() {
    if (!state.selection || !state.currentFile) return
    if (analyzing.value) return
    analyzing.value = true
    analysisError.value = null

    // Everything below holds the main thread — seconds of it on a long
    // selection. Without yielding for a paint first, the busy state set above
    // never reaches the screen and the click looks like it did nothing.
    await nextPaint()

    try {
      const { sampleRate, channels } = state.currentFile
      const sel = state.selection
      const range = widenedRange(
        sel.start, sel.end, getTimelineDuration(state.segments), sampleRate,
      )

      const rendered = renderRegionToBuffer(
        state.segments, range.start, range.end, sampleRate, channels,
      )
      // Mono for analysis: the envelope is a single-channel measurement and a
      // stereo pair would otherwise be analysed as its left channel alone.
      const mono = rendered.length === 1 ? rendered[0] : mixToMono(rendered)

      const result = analyzeVoiceRx(mono, sampleRate)

      if (!result.ok) {
        analysis.value = null
        analyzedKey.value = null
        analysisError.value = result.reason
        return
      }

      analysis.value = result
      analyzedKey.value = selectionKey()
      introDismissed.value = true
      analysisWidened.value = range.widened

      // A fresh diagnosis replaces the old one outright. Keeping bands from a
      // previous measurement would leave corrections on screen that the
      // current analysis never proposed and cannot explain.
      api.clearBands()
      applyAllSuggestions()
    } catch (err) {
      console.error('VoiceRx analysis failed:', err)
      analysisError.value = 'failed'
    } finally {
      analyzing.value = false
    }
  }

  function mixToMono(channelData) {
    const n = channelData[0].length
    const out = new Float32Array(n)
    for (const ch of channelData) for (let i = 0; i < n; i++) out[i] += ch[i]
    const scale = 1 / channelData.length
    for (let i = 0; i < n; i++) out[i] *= scale
    return out
  }

  return {
    ...api,
    analysis, analyzing, analysisError, analysisWidened, isStale, hasAnalysis,
    introDismissed, dismissIntro: () => { introDismissed.value = true },
    suggestions, suggestionRows, activeSuggestionCount,
    regions, paletteRoles, detectedRoles,
    analyze, applyAllSuggestions, toggleSuggestion, setAllSuggestions, toggleSolo,
    toggleRoleSolo, isRoleSoloed,
    roleGain, setRoleGain, roleQ, setRoleQ, roleCentreHz, resetRole,
    roleOnState, toggleRoleEnabled,
    canSendToEq, sendToEq,
  }
}
