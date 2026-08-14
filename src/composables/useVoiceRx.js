import { ref, computed, shallowRef } from 'vue'
import { useWindows } from './useWindows.js'
import { createEqInstance } from './useEqInstance.js'
import { voiceRxEqEffect } from '../audio/effects/manualEq.js'
import { renderRegionToBuffer } from '../audio/processing.js'
import {
  getRole, bandForRole, ROLES_IN_ORDER, roleForRegion,
  roleFreqRange, clamp,
} from '../audio/eqBands.js'
import { analyzeVoiceRx, MIN_VOICED_FRAMES, HOP_SIZE, FRAME_SIZE } from '../audio/voicerx/analysis.js'
import { buildSuggestions, buildAdvisories, suggestionToBand } from '../audio/voicerx/suggestions.js'
import { MALE_REGIONS, regionAtHz } from '../audio/voicerx/regions.js'
import { resolveBaseline, DEFAULT_BASELINE } from '../audio/voicerx/baselineOverride.js'
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
   * Folding staleness in here would make a nudged selection erase the
   * diagnosis: the panel would drop back to its ANALYZE prompt while the
   * corrections that analysis made were still in the pool and still audible,
   * the per-suggestion switches would go with it, and the "selection changed"
   * banner could never render, because it lives inside the branch that had just
   * unmounted. A measurement does not stop being true because the selection
   * moved — it stops describing what is selected now, which is a caption, not a
   * reason to throw it away. Freshness is isStale's job, shown as a banner over
   * a result that stays put; the de-esser and hum remover report it the same
   * way.
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
   * currently switched off. Filtering out the applied ones would empty the list
   * the moment a diagnosis arrives — analysis applies them all — and would take
   * away the only control for switching one back off.
   */
  const suggestions = computed(() =>
    (hasAnalysis.value ? buildSuggestions(analysis.value) : []))

  /**
   * What the analysis found but will not correct — see buildAdvisories.
   *
   * Derived from the same frozen analysis as the suggestions, and separate from
   * them because it is not a correction: there is no band, no gain and nothing
   * to apply, so it cannot travel through suggestionRows without becoming a row
   * with a dead button on it.
   */
  const advisories = computed(() =>
    (hasAnalysis.value ? buildAdvisories(analysis.value) : []))

  /**
   * Each suggestion paired with the band carrying it, if there is one.
   *
   * The band is the state — enabled, gain, frequency — and the suggestion is the
   * explanation. Neither is derivable from the other, which is why the row needs
   * both: the note says what was heard, the band says what is being done about
   * it right now.
   *
   * `atRecommended` answers the one question the row's button needs: would
   * pressing it change anything? All three measured numbers are compared, not
   * just the gain, because a dot dragged along the plot moves the frequency and
   * a wheel over it moves the Q — both leave the correction no longer the one
   * that was recommended, and both are things the button exists to undo.
   */
  const suggestionRows = computed(() => suggestions.value.map((s) => {
    const band = s.roleId ? bandForRole(bands.value, s.roleId) : null
    return { suggestion: s, band, atRecommended: isAtRecommended(band, s) }
  }))

  /**
   * Does this band carry exactly what was recommended for it?
   *
   * Tolerances rather than equality: gain arrives from a knob quantized to
   * 0.1 dB and Q from one quantized to two decimals, so a band the user nudged
   * and nudged back would fail an === test while sounding identical, and the
   * button would offer to re-apply something already in force.
   *
   * A switched-off band is not at the recommendation whatever its numbers say.
   * The recommendation is a correction to be heard; one that is muted is not
   * being made, and re-applying is exactly the right offer.
   */
  function isAtRecommended(band, suggestion) {
    if (!band || !band.enabled) return false
    return Math.abs(band.gainDb - suggestion.gainDb) < 0.05
      && Math.abs(band.frequencyHz - suggestion.frequencyHz) < 0.5
      && Math.abs(band.q - suggestion.q) < 0.01
  }

  // ── Applying ──────────────────────────────────────────────────────────────

  /**
   * Put every suggestion into the pool, switched on.
   *
   * Called by analyze(), so a diagnosis arrives already corrected and the first
   * thing the user hears is the fixed version. Listing the corrections and
   * waiting to be told to apply each one reads as cautious and plays as broken:
   * the panel would describe problems while the audio still had them.
   *
   * Nothing is lost by applying first — every row can be switched off, the EQ
   * as a whole can be bypassed, and nothing touches the file until Apply.
   */
  function applyAllSuggestions() {
    for (const s of suggestions.value) writeSuggestion(s)
    api.pushBands()
  }

  /**
   * Write one recommendation into the pool, overwriting whatever is there.
   *
   * ONE-WAY, AND THE ONLY DIRECTION THAT EXISTS. Making the row a toggle would
   * make it a control over the band, and a control has to display the thing it
   * controls — so the row would have to show the band's live gain, and the
   * measured recommendation would be overwritten on screen the moment the user
   * touched the knob. "What did it actually recommend?" would be unanswerable.
   *
   * So the row is a read-only statement of what was measured, and this is the
   * one action on it: put that back. Switching a correction off is the role
   * column's ON button, where it sits beside the knob it mutes.
   *
   * Keeps the existing band's id when overwriting. createBand mints a fresh one,
   * and a new id would strand a solo or a plot selection pointing at the band
   * this just replaced.
   *
   * @returns {boolean} false if the pool was full and nothing was written
   */
  function writeSuggestion(s) {
    const existing = s.roleId ? bandForRole(bands.value, s.roleId) : null
    if (!existing && bands.value.length >= api.maxBands) return false

    const band = suggestionToBand(s, regions.value)
    // One band per role: a second correction over the same region stacks two
    // filters where the analysis measured one problem.
    bands.value = existing
      ? bands.value.map(b => (b.id === existing.id ? { ...band, id: existing.id } : b))
      : [...bands.value, band]
    return true
  }

  /**
   * The row's button: override this role's current values with the measured ones.
   *
   * Same writer as applyAllSuggestions, so a row and the bulk action can never
   * disagree about what "the recommendation" means.
   */
  function applySuggestion(suggestion) {
    if (!writeSuggestion(suggestion)) {
      showToast(`VoiceRx holds ${api.maxBands} bands — remove one to add another`)
      return
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
   * Never a subset chosen by the analysis. The nine regions tile the voice
   * contiguously from 60 Hz to 16 kHz (see voicerx/regions.js) — together they
   * are a complete map, and showing two thirds of a map leaves the user to
   * conclude the missing part is not covered.
   *
   * The deciding argument is constancy. A visible set that followed what the
   * last analysis happened to find would arrange the control surface
   * differently on every file, and a vocabulary you are meant to learn — reach
   * for "nasal" without knowing it lives at 650-1200 Hz — cannot be one that
   * moves between sessions. What this file's analysis flagged is said by the
   * findings list and by the plot's markers, both of which are about this
   * recording; only the layout is constant.
   */
  const paletteRoles = ROLES_IN_ORDER

  /** The gain of a role's band, or 0 where the role has no band yet. */
  function roleGain(roleId) {
    return bandForRole(bands.value, roleId)?.gainDb ?? 0
  }

  /**
   * Put a role at a point on the plot, creating its band if it has none.
   *
   * The general EQ's own gesture, made safe for a role-tagged pool: the
   * frequency pressed names a role (see regionAtHz), so the click creates
   * exactly the band that role's knob would have created, at the point actually
   * pointed at rather than at the region's centre. A band with no role would be
   * audible with no control anywhere that admits to it, which is why the
   * frequency has to resolve to one before anything is placed.
   *
   * A role that already has a band gets it moved, not doubled — one band per
   * role is the invariant the whole palette rests on. The frequency is held
   * inside the role's own range, so a click near a boundary lands at the edge
   * rather than somewhere the role cannot reach.
   *
   * Returns the band's id so the press that placed it can carry on dragging it.
   */
  function setRoleAt(frequencyHz, gainDb) {
    const region = regionAtHz(regions.value, frequencyHz)
    const role = region ? roleForRegion(region) : null
    if (!role) return null

    const [lo, hi] = roleFreqRange(role.id, regions.value) ?? [frequencyHz, frequencyHz]
    const hz = clamp(frequencyHz, lo, hi)

    const existing = bandForRole(bands.value, role.id)
    if (existing) {
      if (!existing.enabled) api.toggleBand(existing.id)
      api.setFrequency(existing.id, hz)
      api.setGain(existing.id, gainDb)
      return existing.id
    }
    return api.addBand({
      role: role.id,
      regions: regions.value,
      frequencyHz: hz,
      gainDb,
      origin: 'manual_voicerx',
    })?.id ?? null
  }

  /**
   * Where a role sits: the band's frequency if it has one, the measured
   * anomaly's centre if the analysis found one there, otherwise the geometric
   * centre of the role's scan range.
   *
   * Answers the question for a role with no band too, which is what lets the
   * caption line and the solo probe describe a control before it has been
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
   * correction, and there is nothing to be wide. The column hides the control
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
   * Used for measurement only — the EQ is still applied to the user's actual
   * selection. Reading a little beyond the selection beats refusing to analyse
   * a phrase that happens to be short, and the corrections it produces are
   * still corrections to the same voice.
   *
   * The frame constants are sample counts, so the duration they need depends on
   * the file's own rate — analysis runs at the file's native rate, and a server
   * round-trip can change it. Widening against a fixed 44.1 kHz would reach too
   * far on lower rates and too little on higher ones.
   */
  function widenedRange(start, end, duration, sampleRate) {
    const needed = ((MIN_VOICED_FRAMES * HOP_SIZE + FRAME_SIZE) / sampleRate) * 3
    if (end - start >= needed) return { start, end }
    const grow = (needed - (end - start)) / 2
    return {
      start: Math.max(0, start - grow),
      end: Math.min(duration, end + grow),
    }
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

      const baseline = resolveBaseline()
      const result = analyzeVoiceRx(mono, sampleRate, { baseline })
      if (baseline !== DEFAULT_BASELINE) {
        console.info(`VoiceRx: analysing with the "${baseline}" baseline (override active)`)
      }

      if (!result.ok) {
        analysis.value = null
        analyzedKey.value = null
        analysisError.value = result.reason
        return
      }

      analysis.value = result
      analyzedKey.value = selectionKey()
      introDismissed.value = true

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
    analysis, analyzing, analysisError, isStale, hasAnalysis,
    introDismissed, dismissIntro: () => { introDismissed.value = true },
    suggestions, suggestionRows, advisories,
    regions, paletteRoles,
    analyze, applyAllSuggestions, applySuggestion,
    toggleRoleSolo, isRoleSoloed,
    roleGain, setRoleGain, setRoleAt, roleQ, setRoleQ, roleCentreHz, resetRole,
    roleOnState, toggleRoleEnabled,
    canSendToEq, sendToEq,
  }
}
