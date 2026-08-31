/**
 * Per-effect help content — the text behind the harness's `?` button.
 *
 * ── THE SHAPE IS FIXED SO THE PANEL CANNOT DRIFT ────────────────────────────
 * Each entry is data, not markup. There is no rich text, no markdown and no
 * HTML, which is deliberate: fifteen authors editing fifteen files will not
 * converge on one layout by agreement, and the one thing this panel has to be
 * is the same panel on every effect. The component owns how a section looks;
 * this directory owns only what it says.
 *
 * ── KEYED BY WINDOW ID, WHICH IS WHY NO PLUGIN HAD TO BE TOUCHED ────────────
 * The keys are the same ids `FloatingWindow` already receives as `windowId`
 * and `src/ui/registry.js` already uses for its operations. The harness looks
 * its own help up by the id it was given, so adding help to a window is a file
 * here and nothing else — no prop to thread, no import in a faceplate, and no
 * chance of a window showing another effect's instructions.
 *
 * ── EDITING ─────────────────────────────────────────────────────────────────
 * One file per effect under this directory. To add an effect: write
 * `<window-id>.js` exporting the shape below, then add the import and the entry
 * here. `test/ui/helpContent.test.js` fails if an effect window has no entry,
 * so the list cannot silently fall behind the app.
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────
 *
 *   summary   string    Required. One sentence: what this effect does to the
 *                       audio. Written like the registry's own `desc` — a verb
 *                       phrase about the user's file, not about the DSP.
 *
 *   whenToUse string[]  Required, 1–5 entries. The situations that should make
 *                       someone reach for this rather than its neighbours. This
 *                       is the section that earns the panel: a control list can
 *                       be inferred from the faceplate, "when is this the right
 *                       tool" cannot.
 *
 *   controls  [{ label, text }]
 *                       Required. One entry per control on the faceplate, in
 *                       the order they appear on it. `label` must match what is
 *                       printed on the panel exactly — a help entry naming a
 *                       knob that is not there is worse than no entry.
 *
 *   steps     string[]  Optional. An ordered walkthrough, for effects where the
 *                       order genuinely matters (anything with an ANALYSE pass,
 *                       or a measurement that has to precede a setting).
 *
 *   notes     string[]  Optional. What is easy to get wrong, and anything the
 *                       panel implies but does not say — a latency cost, a
 *                       control that only applies in one mode, a limit.
 *
 * ── VOICE ───────────────────────────────────────────────────────────────────
 * The product's rules apply here and are partly enforced by the test: second
 * person, present tense, sentence case, exact numbers with units, and **no
 * terminal punctuation** — every string ends bare, the same as every other
 * string in the app. Write one clause per entry rather than a paragraph; two
 * sentences in one bullet is a sign it should be two bullets. No emoji.
 */

import airBand from './air-band.js'
import clipGainDeesser from './clip-gain-deesser.js'
import fetPunch from './fet-punch.js'
import humRemover from './hum-remover.js'
import manualEq from './manual-eq.js'
import noiseReduction from './noise-reduction.js'
import normalize from './normalize.js'
import optoSmooth from './opto-smooth.js'
import removeSilence from './remove-silence.js'
import resonanceSuppressor from './resonance-suppressor.js'
import schepsParallel from './scheps-parallel.js'
import softClipper from './soft-clipper.js'
import spectrumAnalyzer from './spectrum-analyzer.js'
import inflator from './inflator.js'
import vocalSaturation from './vocal-saturation.js'
import voicerx from './voicerx.js'

export const HELP = {
  'air-band': airBand,
  'clip-gain-deesser': clipGainDeesser,
  'fet-punch': fetPunch,
  'hum-remover': humRemover,
  'manual-eq': manualEq,
  'noise-reduction': noiseReduction,
  normalize,
  'opto-smooth': optoSmooth,
  'remove-silence': removeSilence,
  'resonance-suppressor': resonanceSuppressor,
  'scheps-parallel': schepsParallel,
  'soft-clipper': softClipper,
  'spectrum-analyzer': spectrumAnalyzer,
  'inflator': inflator,
  'vocal-saturation': vocalSaturation,
  voicerx,
}

/**
 * Help for one window, or null.
 *
 * Null rather than a stub, because the harness uses it to decide whether to
 * show the `?` at all: a button that opens an empty panel is worse than no
 * button. Nothing else in the app should special-case a missing entry.
 */
export function helpFor(windowId) {
  return HELP[windowId] ?? null
}
