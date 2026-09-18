# Instant Polish — CLAUDE.md
> Project intelligence for Claude Code | Last updated: September 2026 | Codebase status: ~60 source files, ~10,000+ lines

---

## What This Project Is

**Instant Polish** is a browser-based audio editor targeting voice actors, audiobook narrators, podcasters, and anyone with an audio file that needs to sound better — no software download, no learning curve.

The core product loop: upload → process → hear the cleaned result in-browser → export (gated by tier).

**Design reference:** The Brain.FM ad (comparison-style marketing, before/after clarity, audience-specific proof points) is a useful visual framing model for marketing assets. The product itself follows a remove.bg model: universal task positioning, audience-specific intelligence delivered through presets.

---

## Usage Modes

The product serves three distinct user types. Architecture decisions must accommodate all three.

**Mode 1 — One-click preset user**
Upload → select preset → master → export. Editing is minimal or absent. The server-side preset chain is the entire product for them.

**Mode 2 — Edit-then-preset user**
Trim/cut/clean up the file first, then run the preset chain on the result. May apply spot operations (e.g. normalize a quiet passage) before mastering. The preset chain is still the final step.

**Mode 3 — Manual power user**
Builds their own processing chain through successive manual operations — noise reduction, normalize, compress applied to selections or the whole file, tweaked to taste. May never use presets, or uses them as a starting point and refines from there.

---

## Workflow Phases

Processing follows a natural two-phase flow:

**Phase 1 — Editorial**
Trim, cut, delete, silence regions, add silence, split. Spot processing (normalize, compress, noise reduce) applied to selections or the whole file. This is where the user shapes and cleans the content.

**Phase 2 — Mastering (server)**
The full preset chain. Produces a compliance-checked, level-matched, export-ready file. This is typically the final step and should be run on the complete, edited file.

**The natural order is: Edit → Master.** Users should not normalize or compress specific passages *after* mastering — doing so can break compliance. However, edge cases exist: a narrator may finish a file, get it mastered, and then need to add a few seconds of room tone or silence a small passage. These post-master touch-ups are level-neutral or near-neutral and should be supported without forcing a full re-master.

---

## Architecture Overview

### Hybrid Client/Server Processing

Processing is split between client and server based on operation type. This is not a clean "everything server-side" model.

| Operation | Where | Rationale |
|---|---|---|
| Trim, cut, delete, silence, split | Client | Pure segment manipulation — no audio data touched |
| Peak normalize | Client | Linear operation, expected to feel instant. Quality gap vs. server is acceptable for spot work |
| Loudness normalize | Client | Two BS.1770 measurements and a gain, plus a lookahead limiter when the peak ceiling and the loudness target disagree. Client-side because the measurement is what the user is actually buying — a reading they can see before committing — and a modal wait per selection change would make the readout useless. It is *not* the mastering chain: it moves level to a target and does nothing else |
| Compression | Client | Interactive parameter tweaking expects immediacy. Two emulations — OptoSmooth (LA-2A opto) and FET Punch (1176 FET) — each a kernel run in an AudioWorklet for preview and in an OfflineAudioContext for apply, so the two are sample-identical. Both run their gain cell and saturator 4x oversampled (`src/audio/dsp/oversample.js`); detector and ballistics stay at base rate. Each reports 50 samples of latency, which the apply path compensates |
| Scheps Parallel | Client | A composite: two fitted Pultec stages around the existing OptoSmooth kernel, blended against a delay-compensated dry path. One worklet node, so the blend's alignment and the preview/apply equivalence are both structural rather than wiring the caller has to get right |
| Manual EQ and VoiceRx | Client | Two separate plugins, each a biquad cascade cheap enough to run live — the whole usability argument depends on hearing the change while moving the control. VoiceRx's analysis is a client port of Stage 3a — measurement-driven, so it needs no corpus, no reference curve and no preset |
| Auto Leveler | Hybrid | The DSP is a full client port of the server stage and reproduces its gain curve sample for sample; the one input it cannot compute in the browser is the Silero voiced/silence mask, which comes from `/api/analyze/vad` once per analysis. Every control acts on numbers derived after the mask, so one round trip buys unlimited knob turns. The curve is scheduled onto an AudioParam rather than rendered into a buffer — a per-sample envelope is 317 MB per thirty minutes of mono |
| Noise reduction | Server (DeepFilterNet3) | Quality gap vs. RNNoise is significant and user-visible. Modal wait is normal for this operation |
| Full preset chain | Server | Always server-side |

**Why not route normalize and compress through the server too:** Users expect these to feel fast — a 10-second wait to normalize a 30-second selection would feel broken even with a progress modal. The quality delta between client-side and server-side normalize/compress is acceptable for spot editing. For Mode 1/2 users, the preset chain re-applies these operations at the end anyway with full compliance targeting.

**Why noise reduction must be server-side:** RNNoise (the client-side alternative) produces meaningfully worse results than DeepFilterNet3. For a product positioning on audio quality, shipping an inferior NR path for spot edits is not acceptable. The processing modal pattern normalizes the wait — every major audio tool works this way for NR.

### Full Preset Chain — Server Request Shape

```json
{
  "file": "<uploaded audio>",
  "preset": "acx_audiobook",
  "output_profile": "acx"
}
```

**Server response (preset chain):**
- Processed audio blob (WAV or MP3 per tier/preset)
- Processing report JSON (measurements, ACX certification if applicable, quality advisory flags)
- Waveform peak data JSON (~1000 points for canvas rendering)

The audio the user hears in-browser after mastering is **identical** to the download. There is no separate preview quality.

### Async Job Architecture

The server uses a job-based async model to avoid proxy timeouts on long-running operations (Cloudflare 524 at ~100s):

- `POST /api/process` returns `202 Accepted` immediately with a `jobId`
- Client polls `GET /api/jobs/:jobId` every 3 seconds until status is `complete` or `failed`
- `GET /api/jobs/:jobId/download` streams the processed file
- Jobs are held in-memory; they expire after 1 hour. A server restart loses in-progress jobs.
- Rate limit: 30 requests per 15-minute window per IP

**This is the only submission model for preset chain processing.** Do not add a synchronous path — even short files can take 30+ seconds once dereverberation and source separation are in the chain.

### Non-Destructive Editing Model

Original audio data is never modified until export. All edits are segment pointer manipulations (EDL model). Source buffers are immutable. Processing — both client-side and server-side — produces new buffers into the pool.

Key data structures: `Segment`, `SilenceSegment`, `Timeline` (ordered segment array), `EditorState`. See Wavely spec for full definitions.

---

## Preset + Output Profile Architecture

These are **independent** selections. A preset governs the character of processing. An output profile governs the loudness target, peak ceiling, and measurement method, and determines whether ACX certification runs.

### Presets (four at launch)

| Preset ID | Display Name | Audience | Channel Output |
|---|---|---|---|
| `acx_audiobook` | ACX Audiobook | Audiobook narrators | Mono |
| `podcast_ready` | Podcast Ready | Podcast hosts | Preserve original |
| `general_clean` | General Clean | Everyone else (default) | Preserve original |
| `noise_eraser` | Noise Eraser | Severely noisy recordings where standard processing has failed | Mono |

**Default preset:** `general_clean` — or `acx_audiobook` if the user has previously selected it.

### Output Profiles (three)

Output profiles are loudness targets, not compliance standards. They govern what the processing chain tries to achieve — they do not imply certification.

| Profile ID | Display Name | Normalization Target | Peak Ceiling | Measurement |
|---|---|---|---|---|
| `acx` | ACX Audiobook | -20 dBFS RMS | -3 dBFS | Unweighted RMS, full-file ungated (ACX standard) |
| `podcast` | Podcast / Streaming | -16 LUFS integrated | -1 dBFS | K-weighted LUFS (EBU R128) |
| `broadcast` | Broadcast | -23 LUFS integrated | -1 dBFS | K-weighted LUFS (EBU R128) |

### Default Pairings

| Preset | Default Output Profile |
|---|---|
| `acx_audiobook` | `acx` (locked) |
| `podcast_ready` | `podcast` |
| `general_clean` | `podcast` |
| `noise_eraser` | `podcast` |

**When output profile overrides preset:** the output profile wins on normalization target and peak ceiling. Example: `podcast_ready` + `acx` output profile → file processed with podcast character at ACX loudness levels.

**UI rule:** For `acx_audiobook`, hide/lock the output profile selector to `acx`. There is no meaningful reason to process an audiobook without targeting ACX levels, and surfacing the choice adds confusion.

**UI rule:** For `noise_eraser` with `acx` output profile, surface a warning: "ACX compliance is not recommended for Noise Eraser output. Separation artifacts may cause ACX human review rejection even if measurements pass."

---

## Processing Pipeline Architecture

The pipeline is **fully config-driven**. There is no hardcoded stage ordering. Each preset declares its own `stages` array in `src/audio/presets.js`, and the pipeline runner in `server/pipeline/index.js` executes those stages sequentially via a stage registry. This means:

- Adding or reordering stages for a preset is a data change in `presets.js` only — no changes to the runner
- Stages can carry inline config: `{ noiseReduce: { model: "rnnoise" } }` overrides that stage's defaults for that one call
- The same stage function can appear multiple times in a preset's chain (e.g. `noiseReduce` called twice with different models, `compression` called in multiple passes)
- Stage results accumulate in `ctx.results`; absent stages produce no orphaned keys in the report JSON
- There is no separate "Noise Eraser pipeline" — `noise_eraser` is a preset with its own `stages` array, executed by the same runner as every other preset

**Source of truth:** `src/audio/presets.js` — all preset and output profile definitions live here. The server re-exports from `server/presets.js`.

### Available Stages (stage registry in `server/pipeline/stages.js`)

**Pre-processing & measurement:** `decode`, `monoMixdown`, `measureBefore`, `measureAfter`, `peakNormalize`, `analyzeFramesRaw`, `remeasureFramesPostNr`

**Noise & tonal:** `humDetect`, `hpf`, `noiseReduce` (DF3 / RNNoise / DTLN switchable per call), `spectralSubtraction`, `clickRemove`, `dereverb`

**Voice enhancement:** `correctiveEQ`, `referenceEQ`, `airBoost`, `clipGainDeEss`, `deEss`, `resonanceSuppressor`, `breathReduce`, `vocalExpander`

**Dynamics:** `compress` (multi-pass, crest-factor driven), `parallelCompress`, `autoLevel`, `vadGate`

**Separation & extension (Noise Eraser):** `tonalPretreatment`, `separateVocals` (Demucs or ConvTasNet), `separationValidation`, `bandwidthExtension` (AP-BWE or LavaSR)

**ClearerVoice path:** `clearerVoiceEnhance` (mossformer2_48k or frcrn_16k)

**Special effects:** `harmonicExciter`, `vocalSaturation`, `roomPresence`

**Output & reporting:** `normalize`, `truePeakLimit`, `acxCertification`, `qualityAdvisory`, `encode`, `extractPeaks`, `roomTonePad`

### Key Processing Notes

**Frame analysis (`analyzeFramesRaw` / `remeasureFramesPostNr`):**
- Establishes the canonical noise floor measurement used by all downstream stages
- Runs multiple times per preset to refresh metrics after heavy processing passes
- Noise floor from this analysis drives silence exclusion thresholds, NR skip conditions, and ACX compliance checks

**Noise Reduction (`noiseReduce`):**
- Model is switchable per call: `df3` (DeepFilterNet3), `rnnoise`, or `dtln`
- `acx_audiobook` runs DF3 then RNNoise in sequence; `noise_eraser` runs DF3 before separation
- `skipBelowDb` option skips the call entirely if the measured noise floor is already below the given threshold
- **Never force a pass.** If noise floor can't reach -60 dBFS without artifact risk, report failure. Do not over-process.
- Noise floor enforcement only applies when `output_profile = acx`. For other profiles, reduction is applied for quality only.

**Compression (`compress`):**
- Crest-factor driven, not fixed-ratio. `targetCrestFactorDb` sets the target; the compressor adjusts ratio dynamically up to `maxRatio`.
- Most presets run 2–3 serial compression passes with decreasing target crest factors
- Followed by `parallelCompress` (wet/dry blend with VAD gate and integrated clip-gain de-esser)

**Vocal Expander (`vocalExpander`):**
- Frequency-selective silence-floor attenuator. Not a gate — soft-ratio, band-weighted, calibrated per file.
- Detection band: 80–800 Hz. Attenuation softened above 800 Hz via `highFreqDepth` to preserve consonants.
- Threshold set from post-compression silence P90 + headroom offset; skipped if already below -72 dBFS.
- Emits a `vocal_expander` key in the report; raises `over_expansion` advisory flag when it reaches into quiet speech.

**Auto Leveler (`autoLevel`):**
- VAD-gated gain riding — reduces level variance across voiced segments before final normalization.
- Must not run after `normalize` — gain riding post-normalization breaks compliance targets.

**Normalization & reporting:**
- `normalize`: `acx` output profile → ungated full-file unweighted RMS (FFmpeg `volumedetect`) — matches ACX's own measurement method. `podcast`/`broadcast` → K-weighted integrated LUFS (EBU R128) with pipeline silence exclusion (`noise_floor + 6 dB`) for elevated-room-tone recordings.
- `acxCertification`: runs for all presets when `output_profile = acx`. Six-point deterministic pass/fail. The `acx_certification` key is **absent** (not null) from the JSON for other output profiles.
- `qualityAdvisory`: runs for all presets and output profiles. Probabilistic flags (`info` / `review`), no aggregate score, each with a "Mark as reviewed" checkbox.

See `docs/instant_polish_compliance_model_v2.md` for full flag definitions, JSON structure, and UI model.

### Preset Character Distinctions (do not converge)

- **ACX Audiobook:** Clean, transparent, controlled dynamics. Highest priority on noise reduction quality and artifact-free output. Conservative compression. Dual NR pass (DF3 → RNNoise).
- **Podcast Ready:** Punchy, intimate, compressed. More aggressive EQ. LUFS target (not RMS). Stereo preserved for dual-host. Vocal saturation + room presence added for character.
- **General Clean:** Pragmatic. Uses ClearerVoice enhancement for broad-band cleanup. More aggressive de-esser. No strong tonal character.
- **Noise Eraser:** Voice extraction, not noise reduction. Prioritizes noise removal over voice transparency. Uses Demucs source separation. Output may have a "dry booth" quality.

---

## ACX Certification and Quality Advisory — Key Rules

**ACX certification is the only formal certification standard.** Podcast and broadcast loudness targets are norms, not standards. Streaming platforms normalize on playback — there is no external body to certify against. Do not present pass/fail framing for `podcast` or `broadcast` output profiles.

**The tool certifies technical compliance. It does not certify ACX acceptance.** ACX also applies a human quality review. The quality advisory flag system addresses this separately.

**Advisory flags are not failures.** A technically certified file with advisory flags is valid and submittable. Flags inform the user's review decision — they do not gate the download or export.

Full specification: `docs/instant_polish_compliance_model_v2.md`.

---

## ACX-Specific Features

These apply only to the `acx_audiobook` preset:

- **Room tone padding:** Stage `roomTonePad` is implemented and available in the stage registry — auto-detect and pad head (0.75 s) and tail (2 s) using actual room tone from the file's quietest silence segment. Not digital silence. Currently not included in the `acx_audiobook` stages array.
- **ACX compliance report:** ✓ Implemented — Per-file six-point technical certification + quality advisory flags. `acxCertification` runs for all presets when `output_profile = acx`.
- **Plosive and breath detection:** ✓ Implemented — Surfaces as quality advisory flags for manual review before ACX submission.
- **Batch processing (Creator tier gate):** ✗ Not yet implemented — Multi-phase: batch analysis → per-file processing → cross-chapter consistency pass. Consistency pass aligns RMS (< 1 dB deviation from batch median) and spectral centroid (< 15% deviation) across chapters. This is the **primary value prop for narrators**. Planned for Sprint 5.

**The cross-chapter consistency problem is the highest-value unsolved pain in ACX narration.** Single-file tools don't address it. Instant Polish batch mode will. This is not yet built.

---

## Implementation Status

## Implementation Status

### Complete (as of May 2026)

> The full development history behind these features — every bug report, measurement,
> and design decision — is preserved verbatim in `docs/claude-dev-log.md`. This section
> is a condensed summary of current, shipped behavior only.

**Frontend:**
- Vue 3 (Composition API) production app — not a PoC
- Non-destructive timeline editor: trim, cut, delete, silence, split, fade, volume, copy/paste
- Loudness Normalize — moves a region to a delivery target and holds a peak ceiling. Two meters, and **they are not interchangeable**: streaming targets are K-weighted gated LUFS against true peak (`dsp/loudness.js`, BS.1770-4, coefficients re-derived per sample rate so 44.1 kHz is exact rather than approximated by a 48 kHz table), ACX is **ungated, unweighted RMS against sample peak**, which is what ACX itself audits — so `unit` rides on every benchmark and reaches the measurement instead of being assumed. Benchmarks (`loudnessTargets.js`) are three numbers each and carry no character; the three that also exist as server output profiles are pinned to `OUTPUT_PROFILES` by a test so the spot normalizer and the mastering chain cannot drift apart. ⚠ **THE TARGET AND THE CEILING ARE TWO CONSTRAINTS ON ONE GAIN AND ROUTINELY DISAGREE** on speech — so the PEAK switch decides which gives (LIMIT hits the target and limits peaks; SAFE applies one gain and reports how far short it stopped), and LIMIT is a *solve*, not arithmetic: limiting lowers the loudness the gain just set, so it re-measures and closes the gap, stopping early when a pass stops helping. ⚠ **EVERY FIGURE THE PANEL PRINTS AFTER APPLY IS MEASURED ON THE RENDER**, never predicted from the gain — the user is aiming at a spec somebody else will measure. The measurement is deliberately **not** window-capped the way the compressors' auto-makeup is (`measureWholeRegionInWorker`): integrated loudness is a statement about the whole region, and a capped window on a chapter that opens loud normalizes the rest of the recording down to match
- Undo/redo stack (50-item cap), each entry labeled with the operation that created it; dirtiness is tracked via a revision counter rather than undo-stack depth, driving the tab marker, Save button dot, close confirmation and `beforeunload` guard consistently
- Save / Save As write the file back to disk via the File System Access API (the first Save is always a Save As); falls back to a download where the write API is unavailable (Firefox, Safari). Both take a document id, so the files panel offers them per row without switching the active file
- Files panel (Ctrl+P): search, per-file Go to / Rename / Save / Save As / Close, bulk export and bulk close. **Every action is a labelled button** — the first version hid them behind gestures and shipped three bugs for it: a dismiss ✕ that closed the *file*, a double-click rename that lost to the row's own click handler, and an Escape out of a rename that took the panel with it. `npm run smoke` drives all three against a real document
- Waveform visualization (Canvas 2D, peak caching, device pixel ratio support), with a minimum-drag threshold before a selection is created and draggable selection edges (`src/audio/selectionDrag.js`)
- Playback with A/B before/after comparison; looping and region changes are scheduled on the audio clock (not animation frames) for sample-accurate seams
- Preset panel (4 presets) + output profile panel (3 profiles) with dynamic UI rules
- Processing report panel (measurements, ACX certification, advisory flags)
- Compressors (OptoSmooth — LA-2A style, FET Punch — 1176 style) with auto makeup gain and a fitted LA-2A side-chain taper. **Neither has a threshold control, because neither hardware unit does** — the knob is side-chain gain into a fixed internal threshold (`over = levelDb + scDriveDb`), so what a knob position DOES is set by the file's level. Measured at Peak Reduction 50: 4.62 dB of reduction at −1 dBFS peak, 0.36 at −12, **0.00 at −18** — a narrator who gain-staged with headroom got a plugin that did nothing at its own default, and a saved preset was only valid at the level it was saved at. **OptoSmooth and Scheps now measure the whole file's gated RMS and offset the side-chain drive to nominal** (`dsp/inputAlign.js`). On OptoSmooth it drives an **INPUT knob that AUTO owns until you touch it**, the same contract the Gain knob has; Scheps has no knob, only the measurement. ⚠ AN ALIGN ON/OFF SWITCH WAS BUILT AND REMOVED FIRST — it could turn the correction off but could not set an offset by hand, a mode switch dressed as an escape hatch. ⚠ AND THE KNOB THAT REPLACED IT WAS ALMOST NOT BUILT, on the reasoning that an offset renders **bit-identically** to the matching Peak Reduction move, so a trim would duplicate PR. That compared *renders* when the difference is what the numbers **mean**: PR is a patch value presets save, the trim is a property of the FILE (like `ceilingDb`, and kept out of presets for the same reason). Absorbing a bad measurement by moving PR gets the right sound with the wrong number — the panel reads PR 26 for a PR 50 patch, and the compensation is baked into the preset, which is the portability failure alignment exists to remove, one level up. The knob also reaches where PR cannot: past ~−39 dBFS peak the automatic offset saturates at `ALIGN_MAX_DB` (36) and travel runs out again, so the manual `INPUT_TRIM_MAX_DB` is deliberately wider (48) — a −45 dBFS file goes 10.47 → 17.28 dB at PR 100. ⚠ IT IS A DRIVE OFFSET, NOT AN INPUT GAIN, and that is the safety argument: level and drive add in dB, so it is bit-identical to raising the input as far as the detector is concerned, and invisible everywhere else — no output trim to cancel, no preview/apply drift, and the output tube (the one stage that does NOT cancel under an input gain) untouched. Reduction is then constant to ±0.05 dB from −1 to −30 dBFS peak. The reference statistic is **gated RMS, NOT the makeup percentile** — reusing `MAKEUP_PERCENTILE` looks like the obvious standardisation and scores 4.99 dB of spread against 1.26; a near-peak statistic answers "how loud is the loudest thing" and this asks "how much energy drives the detector". **FET Punch is now aligned too**, and by a different route it had to take: its Input knob is an attenuator on the AUDIO PATH as well as the detector, exactly as the hardware wires it, so folding the offset into `inputDrive` would make it an input gain — output raised by the same amount, Output needed to cancel it, saturator driven harder on a quiet file. The offset therefore rides a separate detector-only coefficient (`scDriveLin`) and the panel calls it ALIGN, not INPUT, because INPUT is already taken. Measured at Input 50 on speech: 7.35 dB of reduction at −1 dBFS peak, 1.74 at −12, 0.00 at −18 and below; aligned, constant across the whole sweep. ⚠ THE STATISTIC IS INHERITED, NOT INDEPENDENTLY SETTLED — gated RMS was chosen on the argument that reduction is an integral over the envelope distribution, and this unit's detector is a rectified PEAK follower with no smoothing, so that argument does not obviously carry. It ships on gated RMS because one statistic across both compressors is what stops a serial chain's two devices drifting apart; `npm run fet:align` scores the alternatives against this unit when a corpus is available. **FET Punch is peak-referenced** (closed-form) and keeps a real-time tracker on the knob. **OptoSmooth references the 99.9th percentile instead**, paired with a memoryless output ceiling at the region's own peak that keeps the "never louder than the source" guarantee by enforcement rather than by arithmetic — the two ship together and there is no way to get one without the other (`computeAutoMakeupPlan`). **The ceiling's soft knee is SIZED BY THE SOLVE, not fixed** (`ceilingKneeDbFor`): it is a `tanh` knee, so it never reaches its own ceiling — a sample AT the ceiling comes out 0.627 dB under it and the bend starts 3 dB down. Load-bearing at PR 55+, where un-ceilinged renders deliver +0.60/+2.58/+2.84 dBFS and it catches 3.4–5.6 dB; pure cost at PR 10–40, where the render is already legal and the knee still took 0.30–0.48 dB. The knee is now `overshoot + 0.5 dB`, capped at `CEILING_KNEE_DB` — so a ceiling with nothing to catch costs **nothing**, and one with 2.5 dB+ of overshoot is bit-identical to before. ⚠ The ledger's "0.00/0.07/0.19/0.24 dB" was a MEAN over the loudest 0.1 %, which hid what the peak pays; "the peaks land where they started" was the claim that did not survive. Peak-referenced makeup let one uncompressed onset pin the whole file, so above Peak Reduction ~50 the knob ran BACKWARDS; delivered rms went −17.4 dB at PR 50 to −20.0 at 70. Not a user choice — the toggle shipped, was auditioned and was removed. OptoSmooth therefore has **no live makeup write-back**: the tracker is peak-referenced by construction and cannot express a quantile. **OptoSmooth and Scheps now ship Tube Saturation's curve at BOTH saturation stages** (cell and output valve), chosen by ear: cell drive 1.5, valve drive 0.5, Emphasis 50, lean positive. ⚠ THIS IS A DELIBERATE BREAK WITH THE HARDWARE MODEL AND EVERY EARLIER RENDER SOUNDS DIFFERENT. The fitted `tanh` valve and the Moore-derived T4 gain modulation are both still implemented, still correct, and still selectable — `tubeCurve: 'tanh'` + `cellCurve: 'gainmod'` + `emphasis: 0` (exported as `LA2A_LEGACY_PATCH`) reproduces the previous kernel exactly, and a test pins it. ⚠ THE MOORE CALIBRATION NO LONGER DESCRIBES WHAT SHIPS — the six units, the H3-over-H2 balance and the 0.94–4.22% THD band validate `gainmod` only and must not be cited for the shipping patch, whose justification is a listening decision. The cell is still where ~95% of the distortion lives (ablated: cell −19.4 dBc vs valve −32.3 at PR 70), so the cell selector is the one that changes the sound and the valve selector is a fidelity fix. The emphasis pair is a ±12 dB shelf at 1800 Hz into the nonlinear section and back out; measured, it only does anything on the imported cell curve and is inert on `tanh` and on the gain modulation. ⚠ ITS −1.13 dB OF CREST IS A BURST-PROBE NUMBER AND DOES NOT TRANSFER — on real narration the whole 0–100 sweep moves crest under 0.07 dB (and moves onset overshoot the WRONG way at PR 70), while the top half of the knob adds ~11 dB of distortion on bright sustained vowels. **It ships at 50 for that reason**, down from 100; the damage is spectral, not level — the passage that flagged it sits at only the 59th percentile of level in its file. `cellCurveDriveMax` is NOT a substitute: it moves the same passage 3–4 dB and pays broadband. ⚠ COMPARING THE TWO STAGES REQUIRES THE MAKEUP THE PATCH WILL ACTUALLY USE — at makeup 0 the valve is starved (it sits after the makeup amp) and every comparison tilts toward the cell; that error produced a bogus 3.6× scale mismatch that does not exist. There is no tube-drive knob — the valves are driven by level alone. Full derivation in `docs/claude-dev-log.md`
- Scheps Parallel — Pultec/LA-2A vocal chain composite (push → OptoSmooth → recovery on a wet path, blended against a delay-compensated dry path), with auto output trim. **It holds the LA-2A kernel rather than a copy**, so every module constant — taper, ballistics, R37, cell and tube laws — reaches it with no conforming change; the bench tuning is module *state* and had to be wired through explicitly. It shares OptoSmooth's makeup reference and ceiling (`dsp/makeupReference.js`), with the ceiling at **Scheps' own output, not the embedded kernel** — a post EQ and the dry sum come after it, so a ceiling inside the kernel would be undone downstream. **⚠ IT IS STRUCTURALLY EXPOSED TO THAT CEILING'S KNEE AND OPTOSMOOTH IS NOT** — the ceiling is the source peak and at low Mix the output IS approximately the source, so the peak sample lands where the knee is deepest by construction. The fixed 3 dB knee cost 0.63 dB at Mix 0, which is otherwise **bit-exact** against the delayed input, and at Mix 1 it charged 0.98 dB to catch 0.58. The solved knee is measured at **Mix 1, the worst case**, because Mix moves after the solve; it recovers 0.32–0.38 dB at every Mix. A residual ~0.25 dB at Mix 0 is known and left: closing it needs a knee that follows Mix. Auto trim is otherwise healthy — level-invariant to 0.06 dB over 27 dB, `squash 40` still lands on its calibrated peak GR 7.64 / avg 1.23, and the emphasis re-tune moved it 0.011 dB. **⚠ Inheritance silently re-tunes Scheps' calibrated defaults:** `squash` has been recalibrated twice for exactly that, and once shipped 4× the intended gain reduction because the fix landed on the kernel defaults and not the panel's. `SCHEPS_DEFAULTS` now derives every shared key from `SCHEPS_KERNEL_DEFAULTS`, and a test pins the round trip
- Soft Clipper — peak control via a shaped curve plus an optional lookahead limiter hybrid path (CLIP/LIMIT switch), with HF emphasis compensation, an auto makeup trim, and configurable ceiling presets (measured from the selection, not a fixed target)
- Inflator — level-independent density/harmonic enhancement (ported curve with algebraic ceiling guarantees), optional 3-band split
- Manual EQ (12-band parametric) and VoiceRx (voice diagnosis/corrective EQ) as separate plugins with separate band pools; VoiceRx can move its corrections into the EQ as ordinary bands
- ResoTame — dynamic, multiband resonance suppression with a per-frequency spectrum display (not a single gain-reduction meter); two selectable targeting models (Zones and Focus, the shipping default) and two reference envelopes (peak envelope shipping, cepstral available via override)
- Auto Leveler — client port of the `autoLevel` pipeline stage: VAD voiced runs and sub-phrase splits into clips, per-clip K-weighted LUFS, `shapeDrift` against a global or rolling median target, transparent merge of conflicting neighbours, cosine crossfades at the lowest-energy point of each boundary. Server-side VAD via `/api/analyze/vad`; everything else runs in the browser. Preview and apply read the same segment list, and `test/dsp/autoLevelParity.test.js` runs the real server stage against the client solver on one fixture and compares the curves sample for sample
- Spectrum Analyzer (conventional RTA-style display on the effect chain output)
- Plugin presets (factory + user-saved) for OptoSmooth, FET Punch, and ResoTame
- Auto Level — clip-based gain riding, client port of the server's `autoLevel`. **Not a gain-riding curve**: it segments into voiced clips, gives each clip ONE flat gain and crossfades between them at the quietest point in the gap, so dynamics INSIDE a clip are untouched — a continuously ridden gain is a slow compressor wearing a different name and flattens what the compressors downstream are meant to act on. ⚠ THE VOICED MASK IS ENERGY, NOT SILERO, AND NOT `F0Tracker` EITHER — `frameAnalysis.js` ships an energy backend as a first-class path and that is what is ported (frame RMS against `noiseFloor + 6 dB`); VoiceRx's pitched-frame substitution is the opposite trade and is not interchangeable, since a pitch tracker drops every fricative. The cost is that quiet fricatives read as silence and could fragment a clip at its own "s"; the 300 ms bridging pass covers every speech fricative while a real pause still splits. ⚠ THE HEAD STEP IS A SERVER BEHAVIOUR THIS PORT DELIBERATELY DOES NOT COPY — `buildSampleGainArray` jumps by the whole of the first clip's gain on one sample, landing where the first word begins (measured 6.00 dB), and every ACX file meets it because `roomTonePad` puts 0.75 s of room tone at the head; a head ramp takes it to 7.12e-3 dB. ⚠ THE ENERGY SUM IS PER-BLOCK (10 ms) AND STREAMED — per-sample it is 1.27 GB for an hour-long chapter beside a 635 MB mono buffer, which is the file size the beachhead audience actually uploads; block resolution is 2.9 MB and 4.5x faster (14.3 s -> 3.2 s), and hop is DERIVED from block so clip bounds stay exactly block-aligned. Analysis is whole-file (clip targets are a running median over neighbours) and the envelope is evaluated per span, which is what lets an apply path's pre-roll carry the same gain the preview gave it. Measured on 60 s with 20 dB of drift, WHOLE mode: clip spread sd 5.75 -> 1.60 dB, range 18.33 -> 4.33. A file inside the deadband is skipped outright and comes back bit-identical. Explicit ANALYSE step because detection is 3.2 s on an hour; splitting detection from the cheap gain solve, so the knobs can be live, is a known follow-up
- Vocal Dynamics — the vocal chain's dynamics section as one composite: clip → FET → (Pultec pre → Opto → Pultec post), with the parallel blend LOCAL to the opto block and its dry side taken POST-FET, so the chain stays serial end to end and Mix 0 is a real fast-and-dry voicing rather than a bypass (bit-exact against clip → FET alone, which is also the only direct check on the dry delay). It HOLDS the three shipping kernels rather than copying them. ⚠ **LATENCY IS RATE-DEPENDENT AND `dynamicsLatencySamples` IS THE ONLY HONEST SOURCE FOR IT** — 326 samples at 44.1 kHz and 342 at 48, because the clipper's limiter is engaged and its lookahead is a fixed number of MILLISECONDS. It was 150 and constant while the limiter was off. A constant is exactly how this shifted an applied region by 176 samples in the standalone clipper; the opto's lookahead is still pinned at 0. ⚠ THE CLIPPER IS ALSO PINNED TO `thresholdMode: 'fixed'` — the kernel default `adaptive` is recorded as history-dependent with no pre-roll that converges it, and inheriting it would have made the whole composite preview/apply divergent. ⚠ **IT NOW HOLDS A CEILING AND IT USED TO BE A DESIGN PROPERTY NOT TO** — peak control was left to the chain's delivery solve, which also avoided the knee cost Scheps pays at low Mix. The price of that was holding "never louder than the source" by ARITHMETIC on a PREDICTED output peak, and peak does not interpolate. `ceilingDb` enforces it instead. ⚠ AN UN-SOLVED SECTION IS A BIT-EXACT PASS-THROUGH AND THE PANEL THEREFORE OPENS ENGAGED. Only the clipper used to bypass on an absent measured key; the FET fell back to `fetDrive: 50` and the opto to `squash: 33` with both alignments at 0, so a live node with no solve was an unmeasured compressor doing ~7 dB of gain reduction on a −1 dBFS file while the panel read "Solve first". All three stages now bypass on an absent measured key, the opto's taking the Pultec pair and the blend with it. ⚠ AND EACH BYPASS CARRIES ITS OWN 50-SAMPLE DELAY, WHICH WAS A REAL BUG: the clipper's bypass skipped its processing while `latencySamples` still declared 150, so below Density ~2.5 (where the wanted shave rounds to nothing and the threshold stays null) `applyWorkletRegion` trimmed 50 samples too many off the front of the region. The existing "latency is constant across every patch" test could not see it — it pins the DECLARED number, which was never wrong; the new test measures an impulse. ⚠ **THE SPEC'S "DESCENDING CREST LADDER" WAS WRONG AND THE SOLVE DISPROVED IT** — crest is gain-invariant and the three devices move three DIFFERENT statistics: the clipper reduces crest, the FET reduces p99.9-minus-body (9.29 → 7.70 across its drive), and the opto *raises* peak-to-body (8.45 → 15.87 across squash) because its ~10 ms attack rides the body and lets onsets through, pulling the body down 19.7 dB while the peak falls 8.2. ⚠ AND THE OPTO'S "SPREAD MINIMUM" WAS A SYNTHETIC ARTIFACT — on the generator block spread ran 2.605 / 2.326 / **2.082** / 2.093 / 2.148 / 2.225 at squash 30–80 and the solve searched that curve; on real narration there is no minimum and nothing to find (post-FET 3.663, opto at squash 0 already 4.774, bare opto 3.666 → 5.179 @40 → 6.275 @60), because a ~10 ms attack can flatten the bench's slow sinusoidal envelope but not a talker's syllables. Levelling belongs to Auto Level, so **squash is a calibrated constant scaled by Density**, anchored on Scheps' own tuned layer depth (GR peak 7.64 / avg 1.23): measured here 30→6.51/0.94, **33→7.52/1.23**, 36→8.53/1.61, 40→9.87/2.27, so the shipping default is **33 and Scheps' 40 does not transfer** — its cell sees the raw file, this one sees a signal already clipped and FET-compressed. ⚠ CALIBRATED AT 48 kHz ON A PRODUCT THAT RESAMPLES TO 44.1: the same samples re-declared at 44.1 give 6.96/1.02, which bounds the sensitivity rather than measuring it (`npm run dynamics:calibrate` reproduces the table against any file). Each device is therefore solved on the statistic it controls; Density 0 → 100 takes spread 3.73 → 2.58 dB and impact 10.16 → 8.06, and the crest RISE (+2.13 dB at full) is reported as the trade rather than hidden. ⚠ EVERY STAGE IS ALIGNED AT ITS OWN INPUT — in a serial chain the two compressors do not share one, and the opto's sits ~6 dB lower in gated terms, so aligning it from the raw file gives 0.25 dB where its own input gives 2.98. The solve therefore renders the head stage by stage. ⚠ THE BLEND MUST BE CORRELATED ON ALIGNED PATHS (rho 0.481 unaligned vs 0.956) — that bug was invisible in every solved knob and surfaced only because switching oversampling off for speed takes the latency to zero by coincidence. ⚠ **THE MACRO IS A LIVE KNOB, BECAUSE THE SOLVE IS A SAMPLED SWEEP RATHER THAN A PER-MOVE SEARCH** (`sweepDynamics` / `solveFromSweep`; `npm run dynamics:sweep` scores it). Bisecting cost 7.3-11.3 s EVERY time Density moved; sampling every curve once costs ~29 s and makes every later Density and Voicing move a lookup with **no renders at all**. Scored by rendering both param sets through the real stages on TWO narrators: **0.136 dB of delivered impact**, worst case. ⚠ SCORE THE RESULT, NEVER THE KNOBS — both curves are shallow near the solution, so the paths disagree on knob positions by an order of magnitude more than on the output; the bench's first version compared an INTERPOLATED figure to a MEASURED one and flagged a 0.80 dB audio problem that does not exist (rendered, the two agree to 0.009 dB) while hiding a reporting one that did. The clipper's half is exact (its curve is measured on the raw input, so Density only picks the target); the blend is measured once and costs 0.034 dB. ⚠ THE FET'S CURVE IS STORED AS A DROP, NOT AN ABSOLUTE IMPACT, AND THE SECOND NARRATOR IS WHAT FORCED THAT — sampled at one clip setting, its drive-0 value is that setting's post-clip impact, so inverting it for an absolute target charges the FET for a clipper difference the sweep already measured. Narrator 1 spread 0.08 dB across the clip range and hid it; narrator 2 spread 0.62 (0.12 as a drop at low drive) and it cost 0.25 dB at Density 10. ⚠ IT IS A TRADE: the drop form takes narrator 2 from 0.252 to 0.136 dB and narrator 1 from 0.064 to 0.104, so the WORST CASE decides it (0.136 vs 0.252) — the absolute form was cancelling an error it had itself introduced. ⚠ THE OPTO'S CURVE IS INDEXED BY DENSITY, NOT SQUASH — indexing by squash mis-reported reduction by 0.80 dB at the top of the macro because the FET's drive rises with Density too, and ALIGNMENT DOES NOT RESCUE IT: alignment matches gated RMS, and gain reduction is an integral over the envelope DISTRIBUTION, so same energy with a different crest gives different reduction. Residual 0.30 dB, on a reported figure only, where the FET saturates. ⚠ TWO ASSUMPTIONS FAILED QUIETLY. The first inversion dropped the clipper's hard depth cap (1.32 dB above Density 80) — a lookup is not exempt from the constraints the search obeyed. And **THE CLIPPER'S CREST CURVE IS NOT MONOTONIC**: over 24 dB of threshold on tight-crest material it falls to a minimum and RISES again, because deep clipping then pulls the BODY down faster than the peak, so the crossing's endpoint shortcut fired on the wrong end and ran to the deepest threshold sampled. ⚠ THE REFERENCE NARRATION NEVER SHOWED IT (crest 19.79 dB, curve does not turn in range) — the corpus scored 0.064 dB while a second stimulus was 0.65 dB out, and fixing it improved the corpus too. ⚠ THREE STIMULI, THREE DIFFERENT FINDINGS, NONE VISIBLE ON THE FIRST FILE: the synthetic probe found the non-monotonic crest curve, the second narrator found the FET double-count. ONE FILE IS NOT A BENCH — `npm run dynamics:sweep <file>` against a new voice is the cheapest way to find the next one. ⚠ **THE IMPACT TARGETS WERE BELOW THE FLOOR AND EVERY ONE OF THEM WAS UNREACHABLE** — `impactDb` was 8.5/7.5/9.5 against a measured floor (clipper at its cap, FET at full drive) of **11.50 / 11.03** on two narrators. The synthetic generator's impact is 11.32 so 8.5 asked it for 2.82 dB; real narration is 13.2-14.8 so the SAME absolute number asked for 4.7-6.3. ⚠ AND THE FET CANNOT DELIVER THAT AT ANY SETTING: measured alone, impact moves **3.3 dB across its whole drive range** and plateaus at drive 60, because compressing the loud parts pulls the body down with them (p99.9 falls 6.4 dB, body 3.1; impact is the difference). So the drive pinned at 100 and 26 dB of gain reduction came out that nobody asked for — and it failed SILENTLY, because `crossingOf` clamps to the last sampled drive and that is indistinguishable from reaching the target. It took the top half of Density and the whole FET side of Balance with it: at Density 80 every Balance position from -100 to +100 gave drive 100, one distinct value out of nine. Recalibrated to **12.2/11.8/13.0, squash 26/32/20**; narrator 1 now reaches the canonical FET 5.99 / opto 2.05 at Density 70 with drive 24. ⚠ `BALANCE_IMPACT_DB` STAYS AT ±2.0 — it was briefly narrowed to ±1.0 on the argument that a 4.0 dB span across a 2.18-3.30 dB usable band must rail at both ends, which mis-describes how the span is spent (Density already places the target INSIDE the band; Balance shifts from there and only rails past an end). Measured rails per five positions across D30/50/70/90: ±1.0 none on narrator 1 and 1-2/5 on narrator 2; ±2.0 one cell at D90 and 2/5; ±3.0 1-3/5 everywhere. At D70 on narrator 1, ±2.0 spans FET reduction 17.3 -> 1.3 dB against ±1.0's 9.0 -> 3.4 — double the range for one railed cell. ⚠ NARRATOR 2 RAILS AT EVERY SPAN INCLUDING THE NARROWEST, because its input impact sits ~1 dB from the target so the lean-opto side bypasses regardless: that is the absolute target's material-dependence, not the span's. Fixing the below-floor target implied nothing about the range. ⚠ **DRIVE 0 IS A 24 dB ATTENUATOR AND THE SOLVE STARTED SELECTING IT** once the targets became reachable — the FET's Input knob attenuates the AUDIO PATH as well as the detector, so drive 0 gives 0.07 dB of reduction and takes the signal down 24.00 dB. `crossingOf` returns the first sampled drive when the target is already met, which is correct as a lookup and catastrophic as a setting. The FET now BYPASSES when there is nothing to do (bit-exact, latency preserved); an older test had documented the attenuator and concluded "there is no bypass position", true when written and false since every stage learned to bypass on an absent measured key. ⚠ AN UNREACHABLE TARGET IS NOW REPORTED (`report.fet.capped` / `shortfallDb`, surfaced on the panel) — the same contract the clipper's cap has always had. ⚠ **AND THE TEST STIMULUS WAS THE ROOT CAUSE ALL ALONG**: both generators read impact 10.8-11.3 against real narration's 13.2-14.8, because a flat train of identical syllables has no plosives or stressed onsets and p99.9 sits far closer to the body than speech ever does — the exact statistic every target is expressed in. Both now accent one syllable in seven (impact ~13.9/~14.7) and four assertions moved to match, all toward the real files. ⚠ **BALANCE TRADES THE TWO COMPRESSORS AGAINST EACH OTHER** — Density says how much, Balance says WHICH device. It shifts exactly two voicing numbers (`impactDb` ±2.0 dB, `squash` ×1.45/×0.55) and is live for the same reason Density is: both are lookups. ⚠ THE SIGNS INVERT — a HIGHER `impactDb` is a SLACKER FET target, so leaning toward the opto RAISES both numbers; only one of them means "do less". The clipper and Mix are deliberately out of the trade. Measured at Density 60: FET GR 26.6 → 9.4 and opto GR 1.0 → 5.8 across the range; ⚠ it only bites below ~Density 60 on the FET side, because above that the drive pins at 100 and `impactDb` stops reaching. ⚠ AND IT BROKE THE OPTO'S REPORTED REDUCTION, WHICH IS NOW A (DRIVE x SQUASH) GRID: that figure depends on the opto's depth AND on what the FET handed it, and Balance moves those in OPPOSITE directions at a fixed Density — indexed by squash alone it was out 0.80 dB, by Density alone **2.86 dB** (the panel read 3.90 where the opto did 1.04), by a 4x6 bilinear grid 0.70 dB (4x4 scored 1.45; the squash axis was too coarse where the curve bends). Build 28 -> 29.7 s. The audio was never at risk either time — delivered impact stays 0.086/0.210 dB across the whole Balance range on both narrators. ⚠ THE LESSON IS THE SHAPE: a reported figure depending on two independently-moving controls cannot be a curve in either one, and it read correctly right up until the second control existed. ⚠ **THE THREE VOICINGS ARE GONE AND DENSITY NOW MEANS ONE THING** — each carried its own `impactDb`, `squash`, `clipShaveDb` and `mix`, so Density 55 was three different amounts of processing depending on a rotary beside it: the macro's own number had no fixed meaning and neither did a patch quoting it. One target set remains (`DYNAMICS_TARGET`, the audiobook numbers — the only ones ever measured; the other two were these moved by hand). The folded-in knobs got their own controls: Mix is a plain number (the AUTO badge went with the voicings — it deferred to `voicing.mix` and there is nothing left to defer to), and the clipper's shave is a **Clip detent (OFF/1/2/3 dB) whose top position is DERIVED from `CLIP_MAX_DEPTH_DB`** so the dial never offers a setting the solve quietly clamps. ⚠ **IT SHIPPED WITH NO AUTO MAKEUP AND CAME OUT 16 dB QUIET** — the FET's Input knob attenuates the AUDIO PATH as well as the detector, so every solved drive costs level: at Density 70 the output peak sat 15.86 dB below the input and the body 11.93 below, with the trim at 0. The zero was deliberate and the reasoning expired — it deferred the level to "the chain's tone section and delivery solve", neither of which exists, while this section ships standalone. `makeupDb` is now a measured key referenced to the **99.9th percentile** (the house reference; a peak reference lets one onset pin the file) and capped so the output cannot exceed the input peak. ⚠ `fetDrive ?? 0` BIT FOR THE FOURTH TIME: drive 0 is the 24 dB attenuator, so reading the FET level curve there made the makeup add back attenuation that never happened — **+24.16 dB over the input peak**; with the FET out the dry path is the post-CLIP signal. ⚠ LEVEL INTERPOLATES AND PEAK DOES NOT — p99.9 tracks a Mix lerp to 0.04 dB because the blend law holds POWER constant, but the peak of a SUM is not the blend of two peaks, so a cap on an interpolated peak is unsound. ⚠ AND OUTPUT LEVEL vs FET DRIVE IS STRONGLY CONVEX NEAR ZERO (−26.03/−20.97/−18.50 dB at drives 0/9.1/18.2): linear interpolation under-read 1.20 dB at drive 5.2, monotone cubic takes it to 0.96 and cannot remove it — the knob-solving crossings deliberately stay linear, being scored at 0.136 dB. So the cap carries a **measured 3.43 dB margin**, the worst under-read over 240 combinations of Density/Mix/Balance on two narrators: with it 0 of 240 exceed the input peak, without it 68 did by up to 1.97 dB. ⚠ THE MARGIN IS NOT FREE and an earlier note claimed it was — at Density 70 the delivered body is +2.63 dB without it and +0.87 with, so ~1.8 dB of makeup buys the guarantee; it is sized on a worst case (D5-10 at Mix 1) that is not typical (D70 errs ~1.7), and a margin following the error's own structure is the obvious next improvement. An exact cap would need a render, which is what this path exists to avoid. ⚠ **THE CONTROLS ARE DISABLED WITHOUT A MEASUREMENT** — with no valid solve every stage bypasses and the kernel is a bit-exact pass-through, but the panel kept presenting live knobs over it: they moved, the readouts changed, the meters sat at zero and nothing was audible. Density/Balance/Clip/Mix now disable until `solutionValid` and the meter row dims with them. ⚠ OUTPUT STAYS ENABLED AND THAT IS NOT AN OVERSIGHT: the bypass path still applies `outputLin`, so the trim is the one control that works with no solve — disabling it would be the same lie inverted. Panel state is five keys (density, balance, clipShaveDb, mix, outputDb), every one portable independently of the others, and NOTHING measured reaches a preset. Targets are reachable operating points, NOT listening decisions. ⚠ **THE CLIPPER LEANS ON ITS LIMITER NOW (`DYNAMICS_CLIP_LIMITER` 100) AND THAT IS A LISTENING DECISION** — auditioned on narration through this composite and judged cleaner than the shaping curve. The standalone's measurements (the curve's error is IN-BAND harmonics, −16 dBc at 13 dB of drive, which 8x oversampling cannot touch because it is not fold-back) were a reason to go and listen, NOT the result, and must not be cited as the justification. It was pinned at 0 for a LATENCY reason all along, not an audio one. ⚠ IT TOOK THREE FIXES TO BECOME SAFE, none visible from that one line, all of them the clipper reporting only what its SHAPING CURVE did. **The depth cap stopped binding**: `CLIP_MAX_DEPTH_DB` reads the curve's own reduction, which is 0.00–0.01 dB at every threshold once the limiter carries the work — measured 25/292 and 88/292 combinations at the cap before, **0/292 after**. `CLIP_MAX_PEAK_RED_DB` is a second bound on how far the PEAK moved, path-agnostic, and it holds at exactly 3.00 dB below peak on both narrators. ⚠ THE TWO ARE NOT INTERCHANGEABLE AND REPLACING ONE WITH THE OTHER WAS TRIED: at a 3 dB peak bound the solve ran to 8.04 dB below peak, where the curve's depth is 3.8–4.5 — past the 2.77–3.21 at which speech distorts audibly. Where `depth` first reaches 3.0 the peak has moved 2.90 dB on one narrator and 1.80 on the other, so no single number reproduces the other. **The GR meter read zero over a working stage** — `stageReductionDb` adds the limiter's gain to the curve's PER SAMPLE (their maxima fall on different samples, so summing two maxima reports a reduction nothing received); ⚠ THE STANDALONE PLUGIN WAS ALREADY UNDER-READING AT ITS SHIPPING DEFAULT, which is `limiter: 100` — measured curve 0.00/0.00/0.01 against a stage doing 1.00/7.36/14.96 dB. **And the peak prediction became deletable**: with the limiter the output peak IS the threshold, measured to 0.00. ⚠ **THAT DETERMINISM IS WHAT CUT THE MEASURE FROM 26.75 s TO 16.1 s**, not a tolerance trade. `peakRed = srcPeak − threshold` in closed form bounds the deepest reachable threshold at exactly `srcPeak − CLIP_MAX_PEAK_RED_DB`, so the clip axis is 5 points over 1.5× the cap instead of 12 over 24 dB — of which NINE were deeper than anything selectable (worst delivered impact 0.022 dB). ⚠ THE OPTO GRID IS 4×4 BECAUSE ONLY ONE COLUMN EVER REACHED THE AUDIO: `outP999Db` feeds the makeup, and 4 squash columns match 6 on delivered p99.9 (0.704 vs 0.708) while 6 existed for a PREDICTED gain-reduction readout the panel already meters live. ⚠ THE DRIVE AXIS IS NOT THE SAME STORY — 3 rows instead of 4 costs 1.44–1.71 dB. ⚠ AND THE MAKEUP'S LEVEL PREDICTION IS 0.7 dB OUT AT ITS WORST (Density 100 at Mix 1) REGARDLESS OF THE GRID — that is interpolation along the SOLVE'S TRAJECTORY, not along an axis, and is now the largest error in the makeup path. `MAKEUP_PEAK_MARGIN_DB` and `MAKEUP_TRIM_MARGIN_DB` are gone with the prediction; the ceiling's knee is a fixed 1.5 dB rather than solved, affordable only because the section reduces crest — measured with the makeup unbounded the output lands over the input peak in 22/84 and 0/84 combinations, median 0.74–1.11 dB UNDER, so it is a backstop and not a working stage (guarantee 0/84 and 0/84, knee cost mean 0.006 and 0.002 dB). ⚠ **A NULL DRIVE IS NOT DRIVE 0, FOR THE FIFTH TIME, AND THE FIFTH ONE WAS AUDIBLE** — `optoAlignDb` read the FET's alignment curve unconditionally, and a null clamps to the drive-0 row, which is the 24 dB attenuator. So a bypassed FET handed the opto a **+25 dB side-chain offset** for a signal nothing had attenuated: measured align 25.43 against a true 1.37, and 10.29 dB of opto reduction at Density 30 where the calibration asks for one. The panel read 0.00 throughout, because the report grid clamped the same null to its own drive-0 row. The clip sweep now carries `outAlignDb`; `renderFet` bypasses instead of rendering the kernel default 50. ⚠ AND THAT EXPOSED A BROKEN PEAK GUARANTEE — with the FET out the wet path was modelled as EQUAL TO the dry path, as if the opto block were not there, so the predicted peak under-read ~2.5 dB at Mix 1; and `makeupDbFor` floored at 0, which enforces "never louder than the source" by WITHHOLDING makeup and so does nothing when there is none. Measured 2.31 dB past the input peak. The wet path is now a GAIN off the grid's drive-0 row (the `impactDrop` lesson again: store the difference when the thing underneath moves) and the floor is the predicted overshoot; same grid worst −0.10 dB. The trim's margin is **0.3 dB, not the cap's 3.43** — that number is sized on the bilinear grid the FET-engaged branch reads, while the trim only fires on the bypass branch where the prediction lands within 0.20. ⚠ **THE IMPACT TARGET NOW CARRIES A RELATIVE FLOOR, BECAUSE AN ABSOLUTE ONE MAKES DENSITY MEAN "DISTANCE TO A FIXED NUMBER" — A PROPERTY OF THE FILE.** A recording at impact 14.9 has room; one at 11.0 has none, so the FET bypassed at every Density and the knob bought nothing from that stage. `MAX_IMPACT_DROP_DB` (1.5) also asks for a guaranteed drop from wherever the audio starts, with the absolute still binding as a floor. ⚠ THE CONSTANT IS CHOSEN ON AN ASYMMETRIC DOWNSIDE, NOT A BEST SCORE: 1.5 is **identical to the absolute target at every Density** on the punchy stimulus (and real narration's 13.2-14.8 is the same regime), while taking the flat one from total bypass to drive 18.4-45.8 / 0.33-6.57 dB with nothing short of target; 2.0 rails at Density 100, 2.5 from 70, 3.0 spends 10.42 dB of reduction to come 1.24 dB short. `npm run dynamics:target` re-scores it — it is fitted to two SYNTHETIC stimuli. ⚠ AND THE SOLVE NOW STOPS AT `FET_MAX_SOLVE_DRIVE` (60), THE MEASURED PLATEAU — past it the knob buys almost no further impact and costs enormous reduction; uncapped, an unreachable floor spent **20.49 dB of gain reduction** for the last 0.3 dB. It changes where the solve gives up, never whether it says so: `shortfallDb` still reports, and reports larger. ⚠ **THE SECTION CAME OUT 3 dB QUIET AGAINST FET PUNCH AND THE PROCESSING WAS NEVER MISSING** — on real narration at Density 100 it delivered 3.68 dB under the source peak where FET Punch at Input 25 delivered the source peak exactly, which reads as "not enough compression". Level-matched (impact and crest are gain-invariant) the section was doing MORE: impact −2.65 against −2.06, crest −4.41 against −4.70. What was missing was makeup. ⚠ AND THE CAUSE WAS THE OPTO GRID'S DRIVE AXIS, NOT THE MARGIN CONSTANT — four evenly spaced rows to 100 put almost every patch inside the FIRST interval (0→33), across exactly the region where output level against drive is convex, while the row at 100 became unreachable the moment the solve started stopping at 60. `OPTO_GRID_DRIVE_POINTS` is now `[0, 10, 25, 60]`: **same render count**, worst under-read 3.42 → 1.37 dB on two narrators, so `MAKEUP_PEAK_MARGIN_DB` goes 3.43 → **1.50** and the delivered body at Density 50/70/100 goes +1.60/+2.15/+2.97. ⚠ THE SHIPPING 1.50 IS THE SYNTHETIC'S NUMBER, NOT THE REAL FILES' 1.37 — a margin is a guarantee, so it is sized on every signal that can be put through it; 1.37 overshot the generator by 0.03 dB and a test caught it. ⚠ AND THE RESIDUAL MOVED FROM THE WET PATH TO THE DRY ONE (worst case is now Mix 0 at drive 1.5, the FET level curve's own interpolation), which is the next axis to re-span. The remaining ~2 dB under the source peak is the PERCENTILE REFERENCE, not the margin: restoring p99.9 on a signal whose crest has been reduced necessarily leaves the peak lower, and the percentile target — not the cap — is what limits the makeup across Density 50–100 now
- Tube Saturation — 3-band saturator with denormal-safe biquad state handling

**Backend:**
- Config-driven pipeline architecture — all 4 presets share a single orchestrator; stage sequences declared per-preset in `src/audio/presets.js`
- Stage registry (`server/pipeline/stages.js`): 29 stage functions including correctiveEQ, referenceEQ, airBoost, clipGainDeEss, spectralSubtraction, resonanceSuppressor, vocalSaturation, roomPresence, autoLevel, parallelCompress, vocalExpander, clickRemove, humDetect, tonalPretreatment, separateVocals, separationValidation, clearerVoiceEnhance, bandwidthExtension, vadGate
- Noise Eraser as a preset (same runner, different stages array): spectral subtraction → DF3 → tonal pretreatment → Demucs separation → separation validation → bandwidth extension
- Async job architecture (POST → 202 + jobId → polling → download)
- Rate limiting, CORS, temp file cleanup, job TTL
- Python integrations: DeepFilterNet3, RNNoise, Demucs, ConvTasNet, AP-BWE / LavaSR, ClearerVoice

### Not Yet Implemented

- **User authentication** — No auth system
- **Payment / tier enforcement** — Gate logic not present; all tiers currently serve same output
- **Batch processing** — Sprint 5; multi-file + cross-chapter consistency pass
- **API access** — Sprint 6 / Pro tier
- **Test infrastructure** — Partial. `npm test` routes through `scripts/run-tests.mjs`, which runs `node --test` with `--test-concurrency` set to `availableParallelism()` and forwards explicit file targets. Coverage is still unit-only on client-side DSP/editor logic (`test/dsp/`, `test/voicerx/`, `test/ui/`); there are no integration/E2E tests, and no server-pipeline or async-job-flow coverage — with one exception: the auto-leveler suite imports `server/pipeline/autoLeveler.js` and asserts the client port produces the same gain curve, which is the only place a client port is checked against the server implementation rather than against hand-written expectations. `npm run smoke` remains the guard for module-scope wiring failures (for example, broken composable/panel exports or missing re-export imports), so run it before merging changes that touch composables, effect wrappers, or params modules.
- **Persistent job storage** — Jobs are in-memory; server restart loses them
- **`docs/acx_production_workflow.md`** and **`docs/instant_polish_gtm.md`** — Referenced but not created

### Available but Not Active in Current Presets

- **Room tone padding** (`roomTonePad`) — Stage implemented; not currently in any preset's stages array
- **Dereverberation** (`dereverb`) — Stage implemented; commented out in presets
- **VAD gate** (`vadGate`) — Stage implemented; disabled in current presets
- **Bandwidth extension** (`bandwidthExtension`) — Stage implemented; `enabled: false` in noise_eraser preset
- **Harmonic exciter**, **breath reducer**, **throat click attenuator** — Stages implemented; not in any active preset

---

## Freemium Gates

| Tier | Export | Batch | Quality |
|---|---|---|---|
| Free | MP3 128 kbps | No | In-browser preview at full quality |
| Credits ($0.50/export) | WAV / 320 kbps MP3 | No | Full quality |
| Creator ($9/mo) | WAV / MP3 / FLAC | Up to 5 files | Full quality |
| Pro ($24/mo) | Unlimited | Up to 20 files | Full quality + API |

**Critical implementation detail:** The in-browser preview must be full quality before the paywall. The user hears the cleaned result first. The export gate appears after the wow moment, not before it. Invest heavily in the before/after comparison UX — it is the primary conversion driver.

**Batch processing is the primary Creator tier gate** (not export count for audiobook narrators). Single-file stays free for the wow moment. Per-chapter ACX compliance reports bundle into batch.

---

## Input Formats

All decoding via FFmpeg server-side. All internal processing: **32-bit float PCM at 44.1 kHz**.

Accepted: WAV (16/24-bit), MP3, FLAC, AIFF, M4A/AAC. First step for every file: decode → resample to 44.1 kHz → convert to 32-bit float. Never process on integer PCM.

Narrators primarily upload WAV (16-bit, 44.1 kHz, mono). MP3 input supported for re-checking already-converted files.

---

## Output Formats by Preset and Tier

| Preset | Free | Creator (encoded) | Creator (WAV) |
|---|---|---|---|
| ACX Audiobook | MP3 128 kbps | MP3 192 kbps CBR (LAME, strict CBR — ACX requirement) | WAV 16-bit 44.1 kHz mono |
| Podcast Ready | MP3 128 kbps | MP3 320 kbps CBR | WAV 16-bit 44.1 kHz |
| General Clean | MP3 128 kbps | MP3 256 kbps CBR | WAV 16-bit 44.1 kHz |
| Noise Eraser | MP3 128 kbps | MP3 256 kbps CBR | WAV 16-bit 44.1 kHz mono |

ACX MP3 must be strict CBR. Use LAME via FFmpeg with `-b:a 192k -abr 0`.

---

## Tech Stack

**Server-side:**

| Concern | Technology |
|---|---|
| Decode / encode / resample | FFmpeg |
| Noise reduction | DeepFilterNet3 (`deepfilternet` / `libdf`), RNNoise (`pyrnnoise`), DTLN |
| Source separation (Noise Eraser) | Demucs `htdemucs_ft` (primary); ConvTasNet via `asteroid` (fallback) |
| Bandwidth extension | AP-BWE (`ap_bwe`), LavaSR — available but currently disabled in presets |
| Speech enhancement (General Clean) | ClearerVoice (`mossformer2_48k` or `frcrn_16k`) |
| Spectral analysis | Meyda.js (in-process, Node.js) |
| Enhancement EQ | FFmpeg `equalizer` filter (parametric biquad IIR) |
| Compression / dynamics | Custom DSP (JavaScript) — compression, parallel compression, vocal expander, auto leveler |
| RMS / LUFS measurement | libebur128 (node-ebur128 bindings) |
| True peak limiting | FFmpeg `loudnorm` (two-pass, 192 kHz upsample) |
| MP3 encoding | LAME via FFmpeg |
| Server framework | Express 5.1.0 (ES modules) |
| File upload | Multer 2.1.1 |

**Client-side:**

| Concern | Technology |
|---|---|
| Framework | Vue 3 (Composition API) |
| Build | Vite 8.0.1 |
| Styling | Tailwind CSS 4.2.2 |
| Waveform rendering | Canvas 2D API, peak data from server |
| Playback | Web Audio API (`AudioBufferSourceNode`) |
| Segment editing | Pure JS — no audio data touched |
| Export | Download blob from server response |

**Future commercial library evaluation (Sprint 6):** Krisp AI Voice SDK vs. DeepFilterNet3 on real narrator recordings.

---

## Processing Sprint Sequence

> ✓ = Complete and in production | ✗ = Not yet started

1. ✓ **Sprint 1** — Core pipeline (ACX Audiobook): FFmpeg decode + HPF + mono → DeepFilterNet3 → normalization + limiting → libebur128 → ACX certification → WAV/MP3 output
2. ✓ **Sprint 2** — Enhancement quality (ACX): Meyda.js EQ → silence exclusion → room tone padding → quality advisory flags (overprocessing, breath, plosive detection)
3. ✓ **Sprint 3** — De-esser + compression (ACX): F0 estimation → sibilance analysis → conditional de-esser → conditional compression
4. ✓ **Sprint 4** — Preset and output profile architecture: separate preset/output profile configs → Podcast Ready, General Clean → LUFS normalization path → output profile selector in UI → output measurements reporting for non-ACX profiles
5. ✓ **Sprint NE-1** — Noise Eraser core path: spectral subtraction → DF3 → tonal pretreatment → Demucs separation → separation validation → Stage 5–7; ConvTasNet (asteroid) added as fallback
6. ✓ **Sprint Auto-Leveler** — Auto Leveler + pipeline refactor: VAD-gated gain riding → silence analysis framework unified on frame-based measurement → pipeline becomes fully config-driven via preset `stages` array
7. ✓ **Sprint Pipeline Expansion** — Extended stage registry: clip-gain de-esser → corrective EQ → reference EQ → air boost → resonance suppressor → vocal saturation → room presence → spectral subtraction → click remover → hum detector → vocal expander → parallel compression → ClearerVoice integration (General Clean) → multi-pass crest-factor compression for all presets
8. ✗ **Sprint 5** — Batch processing (ACX): batch analysis → per-file processing → consistency pass → batch report *(Creator tier gate — primary differentiator for narrators)*
9. ✗ **Sprint 6** — Commercial library evaluation: Krisp vs. DeepFilterNet3 on real narrator recordings
10. ✗ **Sprint NE-3** — Noise Eraser benchmarking: test corpus across noise floor severity levels → validate bandwidth extension → Demucs vs. ConvTasNet comparison

---

## Launch Beachhead

**Voice actors and audiobook narrators.** Same profile, same communities, 100% audio-native workflow, acute recurring pain (ACX rejection), low competition at the simple-tool end.

**Day 90 milestone:** 10 paying customers.

**Primary community targets:** r/VoiceActing, r/audiobooks, ACX community forums, audiobook narrator Facebook groups.

**Community post formula:** Open with the pain → brief founder story → before/after audio clip → mention the tool almost as an aside → "try it free right now, no download required."

---

## SEO Priority

**Highest-priority SEO asset:** Free Audio Loudness Checker tool page (upload → report: RMS, peak, noise floor, ACX pass/fail). Drives qualified traffic, earns organic links, funnels directly into the core product.

**Tier 1 keywords (immediate fix intent):** "remove background noise from audio online," "normalize audio online free," "clean up audio online."

**Tier 2 keywords (compliance intent):** "how to pass ACX audio check," "ACX audio requirements," "podcast audio loudness standards."

---

## Positioning

> **"Upload any audio file. Get broadcast-quality sound in one click. No software to download, no learning curve, no audio engineering required."**

**One-line:** Professional results without professional complexity.

**Not a DAW. Not a video editor. Not a professional plugin host.**

**Competitive angle vs. Auphonic:** Cleaner UX, better free tier, voice-actor positioning, ACX-specific intelligence.

---

## Critical Implementation Rules

- **`outputStart` recalculation:** After any delete/trim/paste, recalculate from scratch for every segment. Do not attempt partial updates.
- **AudioContext on user gesture.** Never on page load.
- **Float32Array throughout.** Web Audio API uses [-1.0, 1.0] range.
- **Canvas pixel ratio.** Multiply canvas width/height by `devicePixelRatio` or waveforms are blurry on retina.

---

## Companion Documents

| Document | Status | Purpose |
|---|---|---|
| `docs/claude-dev-log.md` | ✓ Present | Full verbatim development history (moved out of this file to keep it small for Copilot/agent context — see note below). |
| `docs/instant_polish_processing_spec_v3.md` | ✓ Present | Full processing chain technical specification. Authoritative source for all processing parameters, stage definitions, preset profiles, and output profile behavior. |
| `docs/instant_polish_compliance_model_v2.md` | ✓ Present | ACX certification system, quality advisory flag definitions, report JSON structure, and UI model. Authoritative source for all compliance and reporting behavior. |
| `docs/instant_polish_processing_spec_noise_eraser.md` | ✓ Present | Noise Eraser preset specification. Documents the separation-based processing stages and their parameters. Read alongside v3 spec. Note: the NE-1 through NE-7 stage numbering used in this doc is deprecated — NE is now a standard preset in the unified pipeline. |
| `docs/scheps_vocal_chain_thick_spec.md` | ✓ Present | Scheps Parallel, "Thick" character: signal chain, reference knob positions and the measured target curves. Authoritative on what the curves *are*; the biquad fit that reproduces them is `scripts/fit-pultec-curves.mjs`. Companion data: `data/pultec_curves/scheps_thick_curve_data.csv`. |
| `docs/scheps_vocal_chain_presence_spec.md` | ✓ Present | The complementary "Presence" character. Read alongside the Thick spec — the two share a signal chain and differ only in curve data. Note the post-EQ cut is anchored at 20 kHz deliberately; the Naming Note explains why the preset is not called "Airy". |
| `docs/instant_polish_vocal_chain_spec.md` | ✓ Present | Client-side Vocal Chain design spec — the browser-side counterpart to the server mastering chain, as one composite plugin. Design only; nothing implemented. Authoritative on section order, the crest ladder, and which shipping constants must be re-measured rather than inherited. |
| `docs/acx_production_workflow.md` | ✗ Not present | ACX narrator workflow reference. Context for why features exist and where Instant Polish fits in the production chain. |
| `docs/instant_polish_gtm.md` | ✗ Not present | Go-to-market strategy. Positioning, pricing, launch plan, SEO content map. |

---

**A note on this file's size:** `CLAUDE.md` is automatically read by AI coding agents
(including GitHub Copilot code review) as repository-wide agent instructions on every
request. Keep this file concise and high-signal — detailed development history,
measurement logs, and postmortems belong in `docs/claude-dev-log.md`, not here.
