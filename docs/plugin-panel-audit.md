# Plugin panel audit — logic to move from `*.vue` into composables

November 2026. This is step 1 of the plugin refactor (#1: panels become views; #2: per-file plugin state; #3: plugins open mid-playback).
It covers all 51 `.vue` files under `src/components/panels/`, including sub-panels, the rail panels and FloatingWindow's non-chrome logic.
Line numbers are as of commit `HEAD` at the time of writing. Every file was read in full; nothing was changed while auditing.

Verdicts:
- **THIN**: only the shared boilerplate below needs to move.
- **SOME**: also has a few panel-specific rules or audio calls.
- **HEAVY**: owns real behaviour, and in some cases has no composable at all.

## 1. Shared boilerplate (in nearly every plugin window)

| # | Pattern | Where | Proposed home |
|---|---|---|---|
| a | `onMounted(() => { if (!preview && currentPluginCopy() === 'solo') togglePreview() })`: engages the plugin when its window opens | every live plugin window (~20); EqModal also calls `seedGeneralBands()` | `usePluginWindow(api).engageOnOpen()`, or each composable's `onPanelOpen()` |
| b | `togglePlayback()` → `window.dispatchEvent('wavely:toggle-play')` | 21 panels | one `requestTogglePlayback()` in a transport module |
| c | `close()` → `teardown()` | every modal | shared helper |
| d | `applyAndClose()` → `await apply(); teardown(); closeModal()`, and the offline variant `if (await apply()) closeModal()` | every modal / AutoLevel, NoiseReduction | shared helper |
| e | `:previewing="state.isPlaying"` read straight off editor state | every modal | `isPlaying` from the helper |

That is about 25 lines per panel. With one `usePluginWindow(api)` helper, a guard test can ban `togglePreview` in `onMounted`, `dispatchEvent('wavely:toggle-play')`, and imports from `src/audio/**`, `src/api/**`, `src/workers/**` and `audio/processing.js` in panel files.

## 2. Per panel

### HEAVY

- **windows/LoudnessWindow.vue** has no composable. It owns all of the following. Proposed home: **`useLoudnessNormalize()`**.
  - Target, unit, ceiling and peak mode state (35–45).
  - The region rule (48–52).
  - `planNormalization` / `matchingTargets` (54–94).
  - A single-flight debounced measurement that runs on mount and re-runs on selection and revision (98–174).
  - The try-out handoff watch (178–193).
  - The outcome/miss rule (237–265).
  - The whole apply: `loudnessNormalizeRegion`, `replaceRegion`, peak cache, start/end processing (267–342).
  - ⚠ The apply captures `appState.activeDocumentId` itself (286) instead of `pinActiveDocument` + `pin.check()`, and has no `editBlockedByProcessing`.
- **VoxPressorModal.vue** (~150 lines of rules). Proposed home: `useVoxPressor.stageReadouts` / `warnings` / `guideZones`. The rules:
  - GR stage selection (86).
  - The ×10 `KNOB_SCALE` setters (96–105).
  - The guide zones (221–244).
  - The warn and touch thresholds (204–212, 245–265).
  - The staleness and stage-in-use rules (279, 310, 313).
  - The measuring/remeasuring readout state machine (294–333).
  - The AUTO release derivation in `measuredNote` (335–348).
  - String formatting can stay.
- **PresetsPanel.vue** (mastering). Proposed home: **`useMastering().start(docId)`**.
  - `handleProcess`: entitlement preview limit, upload, stage timers, `serverJobs.beginJob`, decode, commit (144–239).
  - Model choice (77–116).
  - The ACX warning rule (120–128).
  - ⚠ `setModel` writes into the global `PRESETS` object (115), and `selectedModels` is component-local, so the choice leaks across files and is lost on unmount.

### SOME

- **NormalizeWindow.vue** has no composable. Proposed home: `usePeakNormalize()`. The apply (25–56) also takes the docId itself (35) with no `pin.check()`.
- **VolumePanel.vue** has no composable. Proposed home: `useVolume()`. Same pin issue (28).
- **FadePanel.vue** has no composable. Proposed home: `useFade()`. It pins correctly; the code to move is the edge warning (43–54) and the apply (58–85).
- These three and Loudness share the shape "region → render → `replaceRegion` → peak cache → toast". A **`useRegionApply(renderFn)`** helper would enforce pinning for all four.
- **DeEsserModal.vue**. Proposed homes:
  - Scope transport-hold watch (77–87) → `useScopeTransportHold`.
  - `readTimelineEnvelope(state.segments, state.playhead)` (110–116) → `useTimelineEnvelope`.
  - Peak-hold readout and lamp (146–169) → `useHeldReductionReadout`.
  - Amount/Split defaults (122), total reduction (137), soften and guard captions from `softenLaw` / `guardToFloorDb` (172–199).
  - **PlosiveModal.vue** repeats the first three verbatim (64–99).
- **SoftClipperModal.vue**:
  - `readTimelineEnvelope` (58–66).
  - The ceiling-disabled reason (147–152).
  - `limiterLatencyMs` (162–169).
  - Ceiling setter matching (364–373).
- **SchepsModal / HFLimiterModal / AirBandModal / SaturationEmphasisPlot / eq/EqPlot** compute response curves in the panel (`pultecSections`, `shelfResponseDb`, `airBandSections`, `emphasisSections`, `eqResponseDb` + `magnitudeResponseDb`). Each should expose a `*ResponseDb(freqs)` from its composable and keep only the path building.
- **HFLimiterModal**: Freq/Range quantise and clamp (133–138, 181–184), and the transient lamp (151–160).
- **SaturationBenchModal**:
  - Layer rows, add/remove rules and solo silencing (73–99).
  - The taper laws and `quantizeHz` (128–164). `quantizeHz` is duplicated in SaturationEmphasisPlot.
- **HumRemoverModal / SibilanceEditorModal**:
  - Analysis interpretation (`statusLine`).
  - The `tuningDirty` state machine (Sibilance 61–83).
  - The entitlement blocker (Sibilance 138).
  - These should be structured composable state, with the strings left in the panel.
- **ResonanceModal + ResonanceZoneControls / ZoneCount / FocusControls**:
  - Focus-node patch/delete (146–172).
  - Zone split/merge, id generation and clamps (ZoneCount 122–146, ZoneControls 83–146).
  - Selectivity and threshold functions (91–108).
- **EqModal / eq/GeneralView / eq/VoiceRxView / VoiceRxModal**:
  - Band defaults on create.
  - The Q nudge ×1.15 (duplicated in two views).
  - The "type has no gain" rule (in three places).
  - The VoiceRx gain clamp, `canSolo`, `roleReach`, and `onBeforeUnmount(clearSolo)`.
- **LA2A / FET1176 / InflatorWindow / AutoLevel / NoiseReduction / Phatass / PhatassBench**: small rules only.
  - R37 to dB, AUTO input take-over, dial to seconds.
  - Inflator lift law.
  - Last-run summary.
  - Self-guarding setters while processing.
  - The bench trim and reset.
- **LA2ATuningPanel / FET1176TuningPanel**: each keeps a local mirror of the global tuning store. Both should use one shared `useTuningStore(...)`.
- **FloatingWindow.vue**:
  - The apply gate: busy / blocked / locked / entitlement / title (343–360) → `useApplyGate`.
  - Chain status (495–502).
  - Chain window mount/unmount hooks (551, 608).
  - `selectAll()` on mount (555).

### THIN (shared boilerplate only, or nothing)

- **Nothing to move:**
  - VocalSaturationWindow
  - SpectrumAnalyzerWindow (its mount/unmount attach could move)
  - PluginChainWindow (its apply blocker)
  - HFLimiterLcd, DeEsserBandStrip (optionally its handle clamps), SibilanceTuningPanel
  - voxpressor/*, FilterShapePicker, FocusNodePanel
  - PresetMenu, ProcessingReportPanel (its report normalisation could move to `audio/reportModel.js`)
- **Small operation composables proposed:**
  - TrimPanel → `useTrim`
  - SplitPanel → `useSplit`
  - SilencePanel: nothing to move.

## 3. Single-document assumptions (input to #2, per-file plugin state)

- **Panels read the active file:**
  - `state.currentFile.sampleRate`: Scheps, HFLimiter, AirBand, SaturationBench, SoftClipper, EQ, VoiceRx, Resonance.
  - `state.segments` / `state.playhead`: De-Esser, Plosive, SoftClipper.
  - `state.isPlaying`: every window.
- **Composables key measurements on `${activeDocumentId}:${revision}`**: LA2A, FET1176, Scheps, VoxPressor, DeEsser, HFLimiter, Plosive, Phatass, SaturationBench. Several also watch `[revision, activeDocumentId]` to re-measure on a tab switch.
- **Per-copy, file-agnostic state:**
  - `useAutoLevel.lastResult` is module-level.
  - The Noise Reduction held result is keyed on the document but lives in the single copy.
- **Not keyed to any document:** the Loudness measurement, and mastering's model choice (global `PRESETS`).
- **FloatingWindow's busy flag and `selectAll()`** act on whichever file is active.

## 4. Proposed order of work

1. ✓ DONE (November 2026): `usePluginWindow` (`src/composables/usePluginWindow.js`) absorbs boilerplate (a)–(e) in all 20 plugin windows; Play / Stop goes through `src/ui/transportBus.js`; `test/ui/panelLogicGuard.test.js` bans the boilerplate and direct measuring / rendering / engine / commit calls in panels, with today's offenders as a shrinking allowlist (`ALLOWED`).
2. ✓ DONE (November 2026): `useLoudnessNormalize` / `usePeakNormalize` / `useVolume` / `useFade`, all four applying through `applyToRegion` (`src/composables/regionApply.js`: refuse while processing → pin → render → peak cache → `pin.check()` → commit). Loudness, Peak Normalize and Volume now refuse a commit after a tab switch or an edit mid-render, as Fade already did. Their state keeps the window's lifetime, as before.
3. ✓ DONE (November 2026): `src/composables/useScopeFeeds.js` — `useTimelineEnvelope` (De-Esser, Plosive Tamer, Soft Clipper), `useScopeTransportHold` (its rule as the pure `scopeTransportStep`) and `useHeldReadings` (`createHeldReadings`) — and a `responseDb(freqs, …)` on useScheps / useHFLimiter / useAirBand. The guard now bans `magnitudeResponseDb` / `shelfResponseDb` / `eqResponseDb` in panels too; EqPlot and SaturationEmphasisPlot are permanent EXEMPTions (generic plots that draw the filter they are handed in props).
4. Do VoxPressor and mastering.
5. Do the remaining SOME items one panel at a time, running `npm run smoke` after each.
