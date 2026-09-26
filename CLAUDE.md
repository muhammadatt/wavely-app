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
| HF Softener | Client | A dynamic 4.5 kHz shelf driven by a 4 kHz HP peak detector (optional sidechain all-pass rotator) with a threshold raised by low/mid RMS. Zero latency, one AudioWorklet, bit-transparent below threshold — episodic sibilance control that leaves air alone |
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
- Compressors (OptoSmooth — LA-2A style, FET Punch — 1176 style) with auto makeup gain and a fitted LA-2A side-chain taper. **Neither has a threshold control, because neither hardware unit does** — the knob is side-chain gain into a fixed internal threshold (`over = levelDb + scDriveDb`), so what a knob position DOES is set by the file's level. Measured at Peak Reduction 50: 4.62 dB of reduction at −1 dBFS peak, 0.36 at −12, **0.00 at −18** — a narrator who gain-staged with headroom got a plugin that did nothing at its own default, and a saved preset was only valid at the level it was saved at. **OptoSmooth and Scheps now measure the whole file's gated RMS and offset the side-chain drive to nominal** (`dsp/inputAlign.js`). On OptoSmooth it drives an **INPUT knob that AUTO owns until you touch it**, the same contract the Gain knob has; Scheps has no knob, only the measurement. ⚠ AN ALIGN ON/OFF SWITCH WAS BUILT AND REMOVED FIRST — it could turn the correction off but could not set an offset by hand, a mode switch dressed as an escape hatch. ⚠ AND THE KNOB THAT REPLACED IT WAS ALMOST NOT BUILT, on the reasoning that an offset renders **bit-identically** to the matching Peak Reduction move, so a trim would duplicate PR. That compared *renders* when the difference is what the numbers **mean**: PR is a patch value presets save, the trim is a property of the FILE (like `ceilingDb`, and kept out of presets for the same reason). Absorbing a bad measurement by moving PR gets the right sound with the wrong number — the panel reads PR 26 for a PR 50 patch, and the compensation is baked into the preset, which is the portability failure alignment exists to remove, one level up. The knob also reaches where PR cannot: past ~−39 dBFS peak the automatic offset saturates at `ALIGN_MAX_DB` (36) and travel runs out again, so the manual `INPUT_TRIM_MAX_DB` is deliberately wider (48) — a −45 dBFS file goes 10.47 → 17.28 dB at PR 100. ⚠ IT IS A DRIVE OFFSET, NOT AN INPUT GAIN, and that is the safety argument: level and drive add in dB, so it is bit-identical to raising the input as far as the detector is concerned, and invisible everywhere else — no output trim to cancel, no preview/apply drift, and the output tube (the one stage that does NOT cancel under an input gain) untouched. Reduction is then constant to ±0.05 dB from −1 to −30 dBFS peak. The reference statistic is **gated RMS, NOT the makeup percentile** — reusing `MAKEUP_PERCENTILE` looks like the obvious standardisation and scores 4.99 dB of spread against 1.26; a near-peak statistic answers "how loud is the loudest thing" and this asks "how much energy drives the detector". FET Punch has the same topology and is aligned the same way, on the detector's `levelDb` rather than on `inputLin` (which would gain the audio too). **OptoSmooth, Scheps AND FET Punch all reference the 99.9th percentile**, paired with a memoryless output ceiling at the region's own peak that keeps the "never louder than the source" guarantee by enforcement rather than by arithmetic — the two ship together and there is no way to get one without the other (`computeAutoMakeupPlan`, `computeFET1176AutoMakeupPlan`). **The reference, the ceiling, the knee law and the peak/percentile statistics are one shared module** (`dsp/makeupReference.js`) — two copies of a guarantee is two guarantees. ⚠ **THE SOLVE ITSELF IS NOT SHARED, AND MUST NOT BE**: OptoSmooth's output valve sits AFTER the makeup amp, so its output is not affine in the makeup and it iterates renders (`solveMakeupPlan`); FET Punch's Output is the last multiply on the wet path, so `out = a + b·g` exactly and one render answers both references — closed form at Mix 1, bisected on the already-rendered wet path below it. Iterating renders there does NOT converge (three passes at Mix 0.3 came out 6.1 dB short). **The ceiling's soft knee is SIZED BY THE SOLVE, not fixed** (`ceilingKneeDbFor`): it is a `tanh` knee, so it never reaches its own ceiling — a sample AT the ceiling comes out 0.627 dB under it and the bend starts 3 dB down. Load-bearing at PR 55+, where un-ceilinged renders deliver +0.60/+2.58/+2.84 dBFS and it catches 3.4–5.6 dB; pure cost at PR 10–40, where the render is already legal and the knee still took 0.30–0.48 dB. The knee is now `overshoot + 0.5 dB`, capped at `CEILING_KNEE_DB` — so a ceiling with nothing to catch costs **nothing**, and one with 2.5 dB+ of overshoot is bit-identical to before. ⚠ The ledger's "0.00/0.07/0.19/0.24 dB" was a MEAN over the loudest 0.1 %, which hid what the peak pays; "the peaks land where they started" was the claim that did not survive. Peak-referenced makeup let one uncompressed onset pin the whole file, so above Peak Reduction ~50 the knob ran BACKWARDS; delivered rms went −17.4 dB at PR 50 to −20.0 at 70. Not a user choice — the toggle shipped, was auditioned and was removed. **FET Punch had the identical defect and it is now fixed the identical way**: on syllabic narration with one plosive at the end of a pause the plosive survives the FET's attack nearly intact, so peak-referenced delivery went −20.85 dB rms at Input 50 to −22.56 at 70 and −24.37 at 100 — every setting quieter than the −19.18 source, the knob running backwards over its whole travel. Percentile-referenced, the same sweep holds the body to under 0.5 dB of spread and the ceiling holds the peak at or under the source throughout. OptoSmooth and FET Punch therefore both have **no live makeup write-back**: each tracker is peak-referenced by construction and cannot express a quantile, and left in it would fight the offline solve by 3–6 dB on every re-measure. The trackers stay for the bench; the knob now moves on the measurement's cadence (~170 ms), which is when the answer actually changes. **FET Punch's apply path now RESTORES THE PEAK TO THE CEILING** (`peakRestoreTrimDb` / `restorePeakToCeiling`; `applyFET1176Region` resolves `{ buffer, trimDb }` and the toast reports the trim rather than adding gain silently). Percentile-referenced makeup matches the body and leaves the peak under the source — 1.7 dB on a narrator's real take at Input 30, under 0.1 dB from Input 40 up — so the file needed a manual normalize afterwards. ⚠⚠ **"THAT IS THE PEAK REFERENCE BY ANOTHER NAME" WAS THE OBJECTION AND IT IS WRONG**: it holds only while the ceiling is idle, and the ceiling is a LIMITER — at Input 60, both ending at −1 dBFS, restored delivers −16.94 dB rms against the peak reference's −19.21, and holds −16.2 to −17.6 across the knob where the reference slides −17.5 to −20.3. Identical where the ceiling does nothing, strictly better above. ⚠ Scaling the finished render is bit-identical (1.2e-7) to adding the trim to BOTH `outputGainDb` and `ceilingDb`, since the knee is homogeneous in dB. ⚠⚠ **THE TRIM MUST BE MEASURED ON THE WHOLE RENDERED REGION, NEVER THE SOLVE'S CAPPED WINDOW** — `windowPeak ≤ wholePeak` always, so a window-derived trim is too generous and would push a late loud passage past the source peak, which is the one guarantee the ceiling exists to provide. ⚠ **PREVIEW AND APPLY THEREFORE DIVERGE BY THE TRIM** (≤ ~1.9 dB, light settings only) — the one stage in the app where they are not sample-identical, an explicit owner decision. ⚠ It also un-matches the before/after A/B, which the percentile reference had level-matched. No preset re-cut: it is an output trim after the compression, and `output` is canonicalised to 0 and solved per file. **FET Punch's knee is now a LAW, not a per-button constant** (`kneeDbForDrive`): `RATIO_KNEE_DB = {4: 10, 8: 8, 12: 6, 20: 3}` was invented, and FETish's 16 `stairs.wav` captures read **5.85 / 5.85 / 5.84 / 5.84 dB across ratios 12/20/4/8** — one knee for every button. What it does track is the Input knob, 5.85 dB at I1 to 10.86 at I4, which a constant per button cannot express. ⚠ **THE KNEE READS THE KNOB'S DRIVE, NOT THE ALIGNED DRIVE** — following the detector's level instead would undo input alignment, since two files aligned to the same `over` would then reach it through different curves. The captures cannot separate the two (fixed stimulus, moving knob) so this is a design choice where the data is silent. **Fitted by simulate-and-match** (`scripts/fet-static-fit.mjs`, readings kept in `data/fet1176/fetish_stairs_fits.json`): `KNEE_AT_REF_DB` 4.7344, `KNEE_DRIVE_SLOPE` 0.21738. The interior points make the law linear to 0.75 % (segment slopes 0.2000/0.2000/0.2015), and fitting I1+I4 alone predicts the held-out I2/I3 to 0.257 dB rms. ⚠ The printed 0.2004 was **not** the number to install — the instrument's knee bias is width-dependent (+1.92 dB at a 4 dB knee shrinking to +0.76 at 12), so it compresses the range. ⚠⚠ **FINDING 5 IS WITHDRAWN: "FETish compresses less than we do" was our WRONG KNEE reading back.** FETish's four buttons measure their nominal slope to within 0.9 %; the fitter's 3.769/6.552/9.397/13.417 is a diagnostic, and **`RATIO_VALUES` needs no change**. The instrument fits threshold/slope/knee jointly, so a wrong knee returns as a wrong slope: at ratio 4 ours read 0.7734 (+3.12 %) under the old fixed 10 dB knee and reads 0.7495 (−0.07 %) under the fitted law, against FETish's 0.7489. A ~2.4 % drive-dependent residual survives (we match at I1, drift by I2) and is left. ⚠ A known structural residual: our fitted knee moves 0.32 dB across the ratio buttons where FETish's moves 0.01, so no single law fits all 16 readings — worst −0.84 dB at ratio 20/I4. The change is small and lives near threshold: worst 0.32 dB of gain reduction swept across level, 0.048 dB of rms on narration. **The static curve is now finished for the four normal buttons**; all-buttons remains unmeasured — but CLA-76's four all-buttons stairs captures already show **`ALL_KNEE_DB` (16) and `ALL_THRESHOLD_DROP_DB` (6) are both too big**, and that our soft ratio law moves the wrong way with drive. ⚠⚠ **AND THE CAPTURE PROTOCOL HAD THE ATTACK BACKWARDS.** It required the SLOWEST attack for every static capture; measured, that is the worst setting — at dial 7 the fitter recovers a true 4/8/16 dB knee to +0.15/+0.09/+0.04 against +2.15/+1.43/+0.44, lands the slope +0.16 % from true rather than +1.8 %, and drops fit rms from 0.035 to 0.002. **Most of the bias that motivated the diff column and forced simulate-and-match is the attack rounding the corner.** A finer staircase does NOT fix it (the 1 dB plan's floor is 5.18 dB against the coarse 4.32) — `stairs-fine.wav` ships for curve SHAPE, which is what the all-buttons `ALL_RATIO_*` law needs. ⚠⚠ **THE CORRECTION IS OURS, NOT THE REFERENCE'S — bounced, not assumed.** Swept end to end, CLA-76's reading moves 0.0057 of slope and 0.24 dB of knee where ours moves 0.0197 and 2.11, and its fit rms does not improve (0.037 → 0.038). So capture NEW static work at the fastest attack (both sides must share a setting for the diff to cancel, and dial 7 is where OUR side is unbiased) but **do not re-bounce existing captures**. ⚠ The invariance is the better result: a reading that does not move when the attack is swept was never attack-biased, so CLA-76's numbers can be read at face value — and against our unbiased instrument **CLA-76's "4:1" really is ~6:1**, the opposite of FETish's nominal buttons. The two references disagree about their own ratio markings, as they already did about the threshold. **FET Punch's ratio button now MOVES THE THRESHOLD** (`ratioThreshold: 'moving'`, 1.712 dB per octave, anchored at 4:1) — CLA-76's measured behaviour across all 16 captures (worst residual 0.135 dB) and what the UA manual describes, so a higher ratio starts compressing later and the button changes character more than level (spread across the four buttons at Input 90: 7.68 dB fixed → 3.37 dB moving). ⚠ FETish is NOT ambiguous here and reproduces the fixed threshold to 0.00 dB, so this is one reference against the other, with the hardware manual siding against FETish; `FET_LEGACY_PATCH` selects `'fixed'`. ⚠ The anchor at 4:1 is a CHOICE, not a measurement — the captures give only offsets between buttons, whose absolute placement is degenerate with the input drive — and it re-cut `consonant-control` (53 → 57) and `parallel-thickener` (47 → 53) while leaving the ratio-4 presets alone. **OptoSmooth and Scheps now ship the QUARTIC at BOTH saturation stages** (cell and output valve): cell drive 5, valve drive 0.5, Emphasis 85 at a 2300 Hz corner, lean positive (`dsp/quarticSatCurve.js`). The curve is Analog Obsession LALA's OUTPUT STAGE, identified from 21 measured harmonic readings as `u + 1.102e-3·u³ + 3.281e-2·u⁴` — H2 rising 3.06 dB/dB reads as order 4, H3 at 1.95 as order 3, and H4−H2 measures −12.10 dB against a pure quartic's −12.04. ⚠ THIS REPLACED TUBE SATURATION'S CURVE AND EVERY EARLIER RENDER SOUNDS DIFFERENT; `LA2A_TUBESAT_PATCH` reproduces the previous voicing **bit-identically** (it carries the drives, not just the curve names — selecting `vocalsat` alone gives Tube Sat at 3× the drive it was voiced at), and `LA2A_LEGACY_PATCH` still goes back further to `tanh` + `gainmod`. **Chosen by ear over three auditions, and the verdicts ranked in exact order of ODD-HARMONIC SHARE** — preferred / previously shipped / rejected at **1 % / 23 % / 99 %** of distortion energy at −6 dBFS peak. ⚠ TOTAL DISTORTION ORDERS THE OTHER WAY (4.66 / 3.26 / 1.94 %), so "it is cleaner" is NOT the explanation: the rejected configuration was the cleanest of the three by a factor of two, and at cell drive 5 the quartic makes MORE total distortion and MORE second harmonic than the curve it replaced, with **13–19 dB less third**. ⚠⚠ THE IDENTIFICATION IS OF THE OUTPUT STAGE AND THE CELL PLACEMENT IS NOT MEASURED — both reference sweeps were captured at Gain 0 / Peak Reduction 0, cell idle, so at the valve this is a reference curve in the stage the reference measured and at the cell it is an ear choice wearing a borrowed shape. ⚠⚠ IT DIVERGES FROM THE HARDWARE PAPER DELIBERATELY: Moore's six units are ODD-dominant under compression (H3−H2 +16 to +44 dB) and this is not (−22). The configuration that DOES reproduce that band — `cellCurve: 'gainmod'` + quartic valve, every stage measurement-backed, measured +18.8 dB — was built, auditioned and rejected as "a lot of colour, not a neutral sound"; it remains selectable. ⚠ THE DOMAIN GUARD IS IN `u = d·x`, NOT IN `x`, and that is load-bearing: guarded in u the drive cancels out of the slope, so the stage is monotone at EVERY drive (min slope 0.8721) and `inverse()` — which auto makeup solves through — always has an answer. Guarding in x folds the curve and produced three confident wrong findings before it was caught. **NO PRESET RE-CUT**: the shaper is not in the detector path, so gain reduction is bit-identical at every knob position and the factory presets store no curve keys. ⚠ Scheps inherits the kernel and is re-voiced with it; its `squash` calibration is untouched (detector unaffected) and its delivered level moved ≤0.09 dB. ⚠ EMPHASIS SHIPS AT 85 ON A 2300 Hz CORNER, up from 50 at 1800. The ~11 dB of worst-case distortion that forced 100 → 50 belonged to Tube Saturation's curve; the quartic pays about a sixth of it. 1800 was REASONED, not fitted — “leave the fundamental and the first formant out” — and on speech that is too low a bar, since F2 reaches ~2000–2400 Hz. Measured on narration the new pair adds LESS nonlinear energy than the old one. ⚠ A single tone is the wrong instrument for this control and gave the wrong sign three times; use a multitone or the bench's `--emph-sweep`. The cell is still where ~95% of the distortion lives. There is no tube-drive knob — the valves are driven by level alone. Full derivation in `docs/claude-dev-log.md`
- Scheps Parallel — Pultec/LA-2A vocal chain composite (push → OptoSmooth → recovery on a wet path, blended against a delay-compensated dry path), with auto output trim. **It holds the LA-2A kernel rather than a copy**, so every module constant — taper, ballistics, R37, cell and tube laws — reaches it with no conforming change; the bench tuning is module *state* and had to be wired through explicitly. It shares OptoSmooth's makeup reference and ceiling (`dsp/makeupReference.js`), with the ceiling at **Scheps' own output, not the embedded kernel** — a post EQ and the dry sum come after it, so a ceiling inside the kernel would be undone downstream. **⚠ IT IS STRUCTURALLY EXPOSED TO THAT CEILING'S KNEE AND OPTOSMOOTH IS NOT** — the ceiling is the source peak and at low Mix the output IS approximately the source, so the peak sample lands where the knee is deepest by construction. The fixed 3 dB knee cost 0.63 dB at Mix 0, which is otherwise **bit-exact** against the delayed input, and at Mix 1 it charged 0.98 dB to catch 0.58. The solved knee is measured at **Mix 1, the worst case**, because Mix moves after the solve; it recovers 0.32–0.38 dB at every Mix. A residual ~0.25 dB at Mix 0 is known and left: closing it needs a knee that follows Mix. Auto trim is otherwise healthy — level-invariant to 0.06 dB over 27 dB, `squash 40` still lands on its calibrated peak GR 7.64 / avg 1.23, and the emphasis re-tune moved it 0.011 dB. **⚠ Inheritance silently re-tunes Scheps' calibrated defaults:** `squash` has been recalibrated twice for exactly that, and once shipped 4× the intended gain reduction because the fix landed on the kernel defaults and not the panel's. `SCHEPS_DEFAULTS` now derives every shared key from `SCHEPS_KERNEL_DEFAULTS`, and a test pins the round trip
- Soft Clipper — peak control via a shaped curve plus an optional lookahead limiter hybrid path (CLIP/LIMIT switch), with HF emphasis compensation, an auto makeup trim, and configurable ceiling presets (measured from the selection, not a fixed target)
- Inflator — level-independent density/harmonic enhancement (ported curve with algebraic ceiling guarantees), optional 3-band split
- Manual EQ (12-band parametric) and VoiceRx (voice diagnosis/corrective EQ) as separate plugins with separate band pools; VoiceRx can move its corrections into the EQ as ordinary bands
- ResoTame — dynamic, multiband resonance suppression with a per-frequency spectrum display (not a single gain-reduction meter); two selectable targeting models (Zones and Focus, the shipping default) and two reference envelopes (peak envelope shipping, cepstral available via override)
- Auto Leveler — client port of the `autoLevel` pipeline stage: VAD voiced runs and sub-phrase splits into clips, per-clip K-weighted LUFS, `shapeDrift` against a global or rolling median target, transparent merge of conflicting neighbours, cosine crossfades at the lowest-energy point of each boundary. Server-side VAD via `/api/analyze/vad`; everything else runs in the browser. Preview and apply read the same segment list, and `test/dsp/autoLevelParity.test.js` runs the real server stage against the client solver on one fixture and compares the curves sample for sample
- Spectrum Analyzer (conventional RTA-style display on the effect chain output)
- FET Punch's ratio-dependent threshold — auditioned on the bench as `Ratio thr`, **now shipped as MOVING**; FIXED stays on the rocker and in `FET_LEGACY_PATCH`. ⚠ The two references disagree and the hardware sides against FETish: FETish holds its threshold fixed across all four ratio buttons (16 captures, **0.00 dB** of spread), CLA-76 moves it 3.88–4.11 dB, and the UA manual says *“selecting higher ratios also raises the threshold level”*. The shipping law raises it **1.712 dB per octave of ratio** (fitted to CLA-76, worst residual 0.135 dB); ratio 4 is the anchor and does not move, which is a CHOICE since only the offsets between buttons are measurable. It re-voiced every patch on 8/12/20 — `consonant-control` and `parallel-thickener` were re-cut for it; the two ratio-4 presets and all-buttons are unaffected by construction.
- Plugin presets (factory + user-saved) for OptoSmooth, FET Punch, and ResoTame. ⚠ **FET Punch's four normal-ratio presets were RE-CUT against the measured kernel** — left alone they had drifted +1.72 / +2.13 / −0.68 / +7.82 dB of average gain reduction, so doing nothing was itself a silent re-voicing. The target was what each preset DID when it was cut (the as-cut kernel is recoverable exactly, since every constant that moved is module-level: `git show 57e1877:src/audio/fet1176Processor.js`), and all four now land within 0.10 dB of it. `scripts/fet-recut-presets.mjs` is the record; re-run it if the Input span, either ballistics ladder, either depth schedule or the knee law moves again. ⚠ `output` is NOT re-cut and must not be — it is canonicalised to 0 under AUTO and solved per file. ⚠ Three of the eight dials sit at the END of their travel (gentle-ride's release, parallel-thickener's attack and release) where the old voicing is unreachable and the residual is a floor, not a rounding. ⚠ **`factory:all-buttons-in` was re-cut LAST, in a second pass** — it was left drifted on purpose while its law was a guess, and takes the same target as the others now that `fet:allrefit` has fitted it. ⚠⚠ **AND IT CANNOT BE MEASURED FROM A STAIRCASE.** `allThresholdDropDb` is exactly DEGENERATE with the Input drive (the kernel reads `over = level + drive − (THRESHOLD − drop)`, so the two enter as a sum — moving one up and the other down is bit-identical at 3.65e-7 dB rms against 0.797 for either alone), and the ratio triple plus the knee move the curve less than the fit's own residual. The drop IS measurable from the coarse matrix, where all-buttons and a normal button share an Input so the drive cancels: **0.54 / 2.65 / 3.24 dB** below ratio 4 / the mean of four / ratio 12, reproducible to 0.1 dB across four drives, against our 6. ⚠⚠ **"THE CONVENTION AMBIGUITY IS IRREDUCIBLE" IS WITHDRAWN** — it was irreducible only while our model held one threshold for all four numbered buttons and CLA-76's moved 4.5 dB across them. Shipping the moving threshold removed the ambiguity rather than resolving it: ratio 4 is now the reference by construction, and the answer is the first of those three. See the refit below. ⚠⚠ **THE FIRST DIAGNOSIS OF WHY THE RATIO TRIPLE WON'T FIT IS WITHDRAWN** — it said the triple needed material sweeping overshoot independently of level, which a staircase supposedly cannot do. Measured, the fine staircase at the four captured drives sweeps overshoot **−17 to +31 dB**, and the blocker is the **fit residual (0.565 dB), which exceeds every parameter's sensitivity (0.11–0.40 dB) and is model mismatch, not noise** (capture noise is 0.02–0.13 dB). No new bounce fixes that; the law's SHAPE has to be found from the captures already taken. Differencing the curve to read local slope makes it ~7× worse, not better — `scripts/fet-allbuttons-shape.mjs` reads it by least-squares regression over a 5 dB window instead, collapses the four captures onto one axis (recovering their drive offsets to 0.00/5.00/10.00/15.00 on a planted law, collapse residual 0.0000) and reports the shape with no family assumed. ⚠⚠ **IT ALSO EXPLAINS THE NON-IDENTIFIABILITY: `allRatioMin` is the slope at ZERO overshoot, and a 16 dB knee buries that entire region** — so the knee and the ratio law are entangled, not independent unknowns, and only the saturated end of the law is ever visible. Fit the knee first and more of the law comes into view. ⚠⚠⚠ **THE `ALL_RATIO_*` FAMILY RAN BACKWARDS AND HAS BEEN REPLACED** (now `ALL_INCR_AT_KNEE` 0.9528, `ALL_INCR_FALL_PER_DB` 0.0055, `ALL_INCR_FLOOR` 0.8379 — refitted with the knee, see below). ⚠⚠ **THE LAW IS STATED AS AN INCREMENTAL SLOPE AND REDUCTION IS ITS INTEGRAL** — the kernel's `slope` is a SECANT everywhere else, and for a level-dependent law the two differ by the product rule, so a secant falling at k reads as an incremental falling at 2k; a first cut got this wrong and the extractor's self-test caught it. Our kernel now tracks CLA-76 to 0.007 at both ends with the middle sagging 0.036 (the "plateau"), against ~0.11 in the wrong direction before. ⚠ The law is anchored at the knee exit, so changing `ALL_KNEE_DB` or `ALL_THRESHOLD_DROP_DB` means refitting it — which is what `fet:allrefit` does, fitting all five together. The original finding: CLA-76's all-buttons ratio **falls** from ~19.7 near the knee to ~6.3 at high overshoot (−0.756 of ratio per dB); ours **rises** 6 → 20. The collapse residual is 0.0041 of slope over 34 points, so the law is well defined — it is the direction that is wrong, not the range (measured 0.8418–0.9494 sits inside our 0.8334–0.9500). A sign flip does not rescue the family either: the best negative-span member reaches 1.595 rms of ratio (~12 % of the measured range) and wants an asymptote of −13.0, which is not a ratio. Corroborated by Austin Moore, *All Buttons In* (JARP 2012): Shanks likens the all-buttons curve to a **"plateau"** — high ratio then lower above it — and the UA manual puts all-buttons at "between 12:1 and 20:1", which our measurement matches near the knee and falls below at the top. ⚠ That paper measures HARDWARE and both our references are plugins. ⚠⚠ **THE SAME PAPER SETTLES THE THRESHOLD DISAGREEMENT AGAINST US**: the UA manual says *"selecting higher ratios also raises the threshold level"*, so CLA-76 (threshold moves 4.5 dB with the button) matches the hardware and FETish (fixed to 0.00 dB) does not — and our model holds it FIXED. That is a topology change affecting all four normal buttons, and it has since been MADE — `ratioThreshold: 'moving'` ships. ⚠⚠ **THE ALL-BUTTONS LAW IS NOW FITTED, FROM THE CAPTURES ALREADY TAKEN** (`npm run fet:allrefit`, no new bounce): `ALL_KNEE_DB` 16 → **1.52**, `ALL_THRESHOLD_DROP_DB` 6 → **0.969**, `ALL_ATTACK_LAG` 2.5 → **1.0**, the slope triple 0.9528 / 0.0055 / 0.8379. The drop was blocked by a CONVENTION rather than by arithmetic — it is measured against a numbered button, and until the moving threshold shipped our family was not CLA-76's, so "below ratio 4" and "below the mean of four" were different answers (0.54 / 2.65 / 3.24). Anchored at 4:1 it is one number: all-buttons sits **0.565 dB below ratio 4**, spread 0.032 over four Input positions, measured ACROSS buttons at one Input so the drive cancels. ⚠ That cancellation is checkable, not assumable: FETish's threshold reads identically across its four buttons (0.00 dB), which a per-button re-dial could not produce. ⚠ 0.969 is installed, not the measured 0.565 — the instrument fits threshold, slope and knee jointly. ⚠⚠ **`ALL_ATTACK_LAG` WAS REPUTATION AND THE OBVIOUS READING OF IT IS BACKWARDS**: the all-buttons bursts capture alone says our attack is far too fast (1938 µs at a declared dial 4 places it near our dial 2), but CLA-76 is slower than our ladder at EVERY dial on the numbered buttons too, so its ladder offset is confounded with the lag and is the larger of the two. Against its own ratio-4 capture at the same Input and the same dial the offset cancels and all-buttons is **FASTER, not later** — a lag of 1.000 reproduces the ratio to 0.0001 and both absolute figures. ⚠ The depth schedule must be passed explicitly (`runKernel` pins it off) or the lag absorbs the whole 13.34-vs-9.66 dB depth gap; and the probe must be at dial 1, because t63 is quantised at 125 µs and our dial 4 reads 313. ⚠⚠ **THE KNEE AND THE SLOPE FLOOR ARE BOUNDS, NOT MEASUREMENTS** — the residual triples walking the knee UP to 20 dB and barely moves walking it DOWN to 1, and our kernel cannot read a knee back below ~4.2 at any true width because the attack rounds the corner. ⚠ **NOTHING IS HELD OUT FOR THIS LAW ANY MORE**: the coarse slope column had to join the fit because the two targets disagree (shape alone wants a fall of 0.00453 and predicts the column at 0.0133; jointly 0.0055 and 0.0081). ⚠ **`ALL_FET_BOOST` (1.6) IS STILL UNMEASURED** and cannot be reached from what exists — it is a distortion quantity and every capture in hand is level-based; it needs a `thd.wav` bounce in all-buttons. `factory:all-buttons-in` is therefore re-cut at last (Input 70 → 55, avg GR 9.77 → 9.63), with both ballistics dials at the end of their travel. ⚠⚠ **`ALL_TAIL_FRACTION` IS NOW 0**, measured on CLA-76's one all-buttons `bursts.wav`: release t63 does lengthen with hold (77/82/105/124 ms) but the depth schedule explains it at every hold (observed 1.065/1.364/1.610 against 1.045/1.359/1.658), leaving **0.971× for a tail** — nothing. That retires the pre-roll caveat too: all-buttons was the last state with memory longer than `FET1176_PREROLL_S`, so FET Punch's offline render is now **bit-exact**, not merely convergent. ⚠ One capture, one reference, and it leans on `RELEASE_DEPTH_K` fitted from FETish at ratio 4
- Tube Saturation — 3-band saturator with denormal-safe biquad state handling
- HF Softener — dynamic HF shelf per the "Dynamic HF Softener" spec (Modules A/B/C; v2 masking model and the input waveshaper deferred). Panel: Amount, Context, Shape, and a header DELTA monitor (never sent to apply). Rotator (sidechain), Release (40 ms) and vowel release (on) were pinned after listening and are off the panel; the kernel keeps them switchable, and the sidechain listen tap, for the bench and tests. ⚠ **Measured against the spec, two of its numbers do not hold**: the rotator's group delay is 0.29 ms worst case above 3 kHz, not ~0.7 ms, and it lowers detector crest factor on impulsive content (~2.4 dB on a glottal pulse train) but RAISES it ~1 dB on fricative noise, which an all-pass cannot make less peaky — so the 3–5 dB claim is unconfirmed and Module A's value is still the open question the spec flags. ⚠ The bypass trim is matched on the PEAK follower's reading (−0.5 dB), not RMS: an all-pass leaves RMS unchanged by construction. `test/dsp/hfSoftener.test.js` carries the spec's objective checks on synthetic voice; real-speech listening across the spec's five categories has not been done. **Three departures from the spec after listening**, each switchable for A/B: (1) ⚠ **the dulling was release CARRYOVER into the vowel after each "s"**, not vowels triggering the detector (vowels far from a sibilant measured 0.00 dB): the follower's release acts on the level, so recovery time scales with how hard the "s" was hit (65 ms at Amount 40 %, 116 at 80 %). **Vowel release** switches the follower to 10 ms while the low/mid band is voiced — post-"s" vowel −1.32 → −0.40 dB (−3.59 → −1.14 at 80 %) with gap chatter in an "s-t-s" run unchanged, since those gaps are unvoiced. ⚠ Two cheaper cures were measured and rejected: a shorter release fixes carryover but bounces 3.1–3.8 dB in consonant-run gaps, and moving the release onto the GAIN with a hold barely helps because it stacks on the detector's own decay. ⚠ The voicing flag decays in 5 ms, not 20: slower, it lingers from the vowel BEFORE an "s" and under-treats it by 0.5 dB. ⚠ It is a soft 6 dB crossover, not a switch — a hard threshold measured 0.35 dB apart at 96 kHz. (2) **Release** applies outside vowels; tuned as a control, now pinned at 40 ms. (3) **Band shape** (default): the 4.5 kHz shelf plus an opposite shelf at 11 kHz Q 0.8, gain ×1.2 so Amount's depth holds — 16 kHz is untouched at 44.1/48 kHz, never boosts > 0.15 dB; ~1 dB shallower at 96 kHz. **Amount is now three straight lines** (`amountToThresholdDb` and friends): threshold −28 → −44 dBFS, TRUE ratio 1:1 → 6:1, max depth 0 → 24 dB; 0 % never engages; default 40 % (an owner choice: about twice the spec's 40 % cut, −6.1 vs −3.0 dB on synthetic voice). ⚠ The spec's `R` was a DIVISOR (reduction = over / R — its "3" is a true 1.5:1), and raising it cuts LESS, which a first "3:1 → 6:1" attempt did. ⚠ Two earlier maps were uneven in opposite directions — the spec's power-law threshold front-loaded the knob and a ratio linear in SLOPE back-loaded it (2, 3, then 6:1 in the last 20 %); measured per-10 % cuts ran −0.2 … −15.6 with each step bigger than the last. Linear in all three gives −1.5, −3.0 … −15.6, 1.55 dB per 10 %, breath ≤ 0.3 dB at 100 %. The band is built from TWO half-depth shelf/return pairs because one pair cannot dig past ~19 dB without cutting 16 kHz by 14 dB; responses add in dB, so two −12 dB pairs are a −24 dB band with 16 kHz at −0.6 dB. Previously 12 dB: threshold and depth rise together at a fixed 3:1, so the HF level that reaches full depth barely moved across the knob (−16 dBFS at 40 %, −17 at 100 %) and the top of the knob bought only 3 dB. The band's depth compensation is SOLVED per sample rate (`bandDepthComp`), not the ×1.2 constant it started as — the factor runs ×1.17–1.30 with depth at 44.1 kHz and to ×1.51 at 96 kHz, where the band also reaches higher (16 kHz −2.9 dB at 12 dB). **Thresholds are level-aligned**: T_base, L_ref and the voicing floor all shift dB-for-dB with the whole file's gated RMS (`regionAlignDb`, the same statistic and the same whole-file rule as OptoSmooth) against a nominal −20 dBFS, the spec's own L_ref. The detector is linear, so the gain curve is invariant to recording level to rounding; `levelOffset` is a file property, measured, never a user setting. v2's masking model was considered for the dulling and not built: it changes WHICH frequencies are cut, not how long, and its 21 ms frames and 50 ms per-band release are slower than v1

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
| `docs/fet1176_capture_protocol.md` | ✓ Present | FET Punch (1176) reference capture protocol: control-parity check, the four-bounce null test, the 38-bounce capture matrix and what the tooling's self-test already settled. Companion to `scripts/fet-ballistics.mjs`. |
| `docs/acx_production_workflow.md` | ✗ Not present | ACX narrator workflow reference. Context for why features exist and where Instant Polish fits in the production chain. |
| `docs/instant_polish_gtm.md` | ✗ Not present | Go-to-market strategy. Positioning, pricing, launch plan, SEO content map. |

---

**A note on this file's size:** `CLAUDE.md` is automatically read by AI coding agents
(including GitHub Copilot code review) as repository-wide agent instructions on every
request. Keep this file concise and high-signal — detailed development history,
measurement logs, and postmortems belong in `docs/claude-dev-log.md`, not here.
