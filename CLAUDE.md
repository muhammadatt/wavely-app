# Instant Polish — CLAUDE.md
> Project intelligence for Claude Code | Last updated: May 2026 | Codebase status: ~60 source files, ~10,000+ lines

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

**The natural order is: Edit → Master.** Users should not normalize or compress specific passages *after* mastering — doing so can break compliance. However, edge cases exist: a narrator may finish a file, get it mastered, and then need to add a few seconds of room tone or silence a small passage. These post-master touch-ups are level-neutral or near-neutral and should be supported without forcing a full re-master. The export UI should always display current compliance status (pass/fail) so the state of the file is self-evident — no lecturing, just clear signal.

---

## Architecture Overview

### Hybrid Client/Server Processing

Processing is split between client and server based on operation type. This is not a clean "everything server-side" model.

| Operation | Where | Rationale |
|---|---|---|
| Trim, cut, delete, silence, split | Client | Pure segment manipulation — no audio data touched |
| Normalize | Client | Linear operation, expected to feel instant. Quality gap vs. server is acceptable for spot work |
| Compression | Client | Interactive parameter tweaking expects immediacy. Two emulations — OptoSmooth (LA-2A opto) and FET Punch (1176 FET) — each a kernel run in an AudioWorklet for preview and in an OfflineAudioContext for apply, so the two are sample-identical. Both run their gain cell and saturator 4x oversampled (`src/audio/dsp/oversample.js`); detector and ballistics stay at base rate. Each reports 50 samples of latency, which the apply path compensates |
| Scheps Parallel | Client | A composite: two fitted Pultec stages around the existing OptoSmooth kernel, blended against a delay-compensated dry path. One worklet node, so the blend's alignment and the preview/apply equivalence are both structural rather than wiring the caller has to get right |
| Manual EQ and VoiceRx | Client | Two separate plugins, each a biquad cascade cheap enough to run live — the whole usability argument depends on hearing the change while moving the control. VoiceRx's analysis is a client port of Stage 3a — measurement-driven, so it needs no corpus, no reference curve and no preset |
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

### Complete (as of May 2026)

**Frontend:**
- Vue 3 (Composition API) production app — not a PoC
- Non-destructive timeline editor: trim, cut, delete, silence, split, fade, volume, copy/paste
- Undo/redo stack (50-item cap)
- Waveform visualization (Canvas 2D, peak caching, device pixel ratio support)
- Playback with A/B before/after comparison
- Preset panel (4 presets) + output profile panel (3 profiles) with dynamic UI rules
- Processing report panel (measurements, ACX certification, advisory flags)
- **OptoSmooth's R37 emphasis was modelled backwards, and the reason it survived is that it had no test.** It was built as a high SHELF BOOST from unity — +8 dB above 2 kHz, lows left at full level. On the hardware R37 is a trimmer in a PASSIVE network, and a passive network cannot boost: "emphasis" is achieved by discarding lows and letting the side-chain amp make the level back. Now a shelving **attenuation of up to 10 dB below 1 kHz**, unity above it.
  - **The consequence was not cosmetic, and the direction was wrong too.** Peak Reduction is side-chain gain into a FIXED internal threshold, so a model that adds gain at the top adds compression where the hardware removes it. Measured on a 120 Hz plosive at Peak Reduction 65: the old model moved gain reduction **13.61 → 13.67 dB** across the entire sweep — 0.06 dB, upward. The new one moves it **13.61 → 6.35 dB**, downward and monotonic. The control now has authority over the one thing it exists to reject.
  - **THE KNOB ALSO RAN THE WRONG WAY, and that is a separate fix.** The parameter is now `r37`, 0–100 read as knob rotation, matching the manual: *"factory set for a 'flat' side-chain response (clockwise). Increasing the resistance … by turning it counter clockwise will result in compression which is increasingly more sensitive to the higher frequencies."* So **100 is fully clockwise, flat, factory, and the default**; winding down to 0 filters. The old `emphasis` ran 0 = flat, which inverted both the hardware and every reference plugin — the same number meant opposite things in our panel and in anything it was compared against, which is exactly how an A/B gets run at two different settings without anyone noticing. Scheps pins `r37: 0`.
  - **The stock position is bit-identical to before the mechanism fix**, so nothing using the default moved. Only off-flat settings changed, and every one of them now compresses less at a given Peak Reduction.
  - **`test/dsp/la2aSidechain.test.js` is the guard that was missing.** Five behavioural assertions — flat at the factory position, monotonic LF rejection, HF drive left alone, side-chain attenuated rather than boosted, 80 Hz HPF always in circuit. **Three of the five fail against the old model**, which is the property that makes them worth having; a control with no test is how a backwards one shipped unnoticed — twice, once in mechanism and once in direction.
  - **Still unmeasured: the 1 kHz corner and the 10 dB depth.** Both come from secondary sources describing the hardware, not from a swept measurement of a real unit — the same standard the Pultec curves were held to, and not yet met here.
  - **THE REFERENCE EMULATION CANNOT SUPPLY THEM — measured, and it is not a near miss.** Analog Obsession's LAEA has no emphasis control at all; the unlabelled knob taken for one is a mix control, and its `HPF` toggle is a **2-pole Butterworth at 84.5 Hz** (fitted to 0.05 dB rms over 63–400 Hz; order is well determined, a 1-pole fit costs 0.89 dB). That is a utility rumble filter, not R37: it measures **−6.3 dB at 63 Hz, −1.7 at 100, −0.3 at 160, and exactly 0.00 at 250 Hz and above**, where R37 wound fully counter-clockwise must still be taking **6.7 dB out at 400 Hz**. The 0.00 dB readings settle it without any modelling assumption in the way. Fitting our shelf to this toggle would have calibrated one control against a different control and recorded the result as measured.
  - **The same capture retroactively validated the taper fit's premise, which is the useful half.** With HPF off, LAEA's gain reduction is **10.39 dB at every tone from 63 Hz to 3.15 kHz, ±0.01** — its side-chain has no frequency shaping whatsoever in that range. The eight taper captures were therefore taken through a genuinely flat side-chain, which is the condition that fit assumed and could not previously check.
  - **The probe floor was 63 Hz, so our own always-on 80 Hz side-chain high-pass is still untested.** It only does real work below that (−0.7 dB at 63, −3.4 at 40), and no tone in the set reaches it. A probe designed to answer one question did not answer the adjacent one — add 31.5 and 40 Hz next time.
- **AUTO MAKEUP IS PEAK-REFERENCED ON BOTH COMPRESSORS, and matching RMS was the bug.** `computeAutoMakeupDb` / `computeFET1176AutoMakeupDb` restored the *average* level, which returns only the average loss and therefore leaves the output exactly as loud as the input — a compressor that by construction cannot make anything louder. Makeup has always meant giving back what was taken off the peaks: the loud moments land where they started and everything underneath rises with them. **The guarantee that buys is the important half — the output can never come out hotter than the source at any setting**, which is what stops a surviving transient reading as an errant peak.
  - **True peak, not a percentile, and that was measured.** A percentile of short-block peaks looks more robust and is worse where it counts: on real speech a fast transient survives compression nearly intact while the p99 comes down several dB, so percentile-referenced makeup over-compensates and pushes that survivor **up to 5.5 dB ABOVE the source**. True peak cannot do that. The cost is the opposite failure — one uncompressed click sets the reference and the makeup comes out small — which is the safe direction.
  - **The same rule reads very differently on the two units, and `test/dsp/compressorMakeup.test.js` pins both.** FET Punch catches peaks, so restoring them lifts everything underneath: **+1.1 to +2.2 dB** of average gain. OptoSmooth on fast material does the reverse — a 10 ms attack lets onsets through while the body is pulled down, so it reduces the average MORE than the peaks and peak-referenced makeup comes out **quieter on average**. That is an opto leveller being itself: reach for FET Punch to make something louder, OptoSmooth to make it steadier. On slower material the Opto does earn density — **+1.6 dB** measured on a real narration clip at Peak Reduction 60.
  - **The Gain/Output knob is draggable while AUTO is lit, and touching it takes over.** Discarding the drag is what shipped, and it reads as a broken knob: an "OptoSmooth at 75 with no makeup gain" comparison turned out to carry **9.45 dB**, because setting the knob to 0 never took and nothing said so.
- **THE OPTO'S PEAK REDUCTION TAPER IS NOW FITTED TO A REFERENCE LA-2A, and it was wrong in two independent directions at once.** Eight captures of one narration clip through Analog Obsession's LAEA at knobs 20/30/40/56/70/80/90/100 (its +1.34 dB insertion gain removed). The old law compressed **far too early** — 11 dB of side-chain drive at knob 20, where the reference does nothing at all until about 25 — *and* **could not reach the top**, topping out at 13.3 dB of gain reduction across its whole travel against the reference's 26.9 on the same clip. `SC_DRIVE_MAX_DB = 36.24`, `SC_DRIVE_SPAN_DB = 105.9`, `SC_TAPER = 0.4247` reproduce all eight positions to an **rms residual of 0.17 dB**, largest single error 0.35.
  - **An earlier note here said the taper was "~2.4x too aggressive" and that matching the reference's 75 needed our knob at 48.7. Both are withdrawn.** That came from one capture whose knob position was misidentified — measured against the full sweep it sits nearer knob 42–46, at a different insertion gain. **One operating point cannot fit a curve, and the direction it implied was backwards at the bottom of the travel.**
  - **FIT IN GAIN REDUCTION, NOT IN INTERNAL DRIVE.** The first attempt fitted the knob→drive law against drive values recovered by interpolating a coarse drive→GR table. Its residual looked good (0.29 dB *of drive*) and its end-to-end error was **0.68 dB with a systematic +1 dB bias above knob 70** — every upper-half position compressing harder than the reference. Small in the fitted quantity, wrong in the audible one. The drive axis is now walked exactly rather than interpolated: drive and level add in dB inside the gain computer (`over = levelDb + scDriveDb`), so scaling the input at a fixed knob moves the operating point through the real kernel, no probe hook and no interpolation.
  - **This, not the ballistics, is what made the compressor look broken.** Crest factor rises with depth, so at ordinary-looking knob positions users landed in a regime where the unit reduced the average more than the peaks, and auto-makeup then lifted the survivors. **At MATCHED gain reduction our transient control is better than the reference's**: crest change −1.95 dB against their −1.22, peak reduction 5.92 against 5.20. The 10 ms attack is fine and stays.
  - **Two things moved downstream, both because the knob now reaches real depth.** Auto-makeup can ask for more than the **+24 dB Gain knob** has, at deep LIMIT settings — it clamps and undershoots, never overshoots, which is the guarantee that matters and is now its own test. And the base-rate measurement shortcut, whose premise is that oversampling barely moves the RMS, degrades where the saturator is finally driven hard: **0.03 dB at compress PR 90, 0.17 at limit PR 95, 0.26 at limit PR 100**. Pinned at measured bounds rather than under one loose tolerance, so it still fails on drift.
  - **Still one clip and one reference emulation.** Inverting through our own gain computer means these constants absorb any difference between its knee and ratio and the reference's — a behavioural match on average gain reduction, not a claim about the reference's literal side-chain gain. A second source is the thing to check before treating the shape as settled.
- **Scheps Parallel** — Andrew Scheps' Pultec/LA-2A vocal trick as one plugin. Pultec push → OptoSmooth → Pultec recovery on a wet path, blended against the dry. **Four visible controls** (Character, Squash, Mix, Output) because the trick's defining settings are not choices: the LA-2A's R37 emphasis is pinned wide open (that *is* the trick — the side-chain filtered so the cell stops ducking on plosives and rides the presence band instead), mode is COMP, and its makeup stays at 0 so the tube stage isn't driven by gain that belongs after the post EQ.
  - **The EQ curves are fitted from measurement, not derived.** `data/pultec_curves/*.csv` — 120 points per stage, two characters — fitted to 3–4 RBJ biquads per stage by `npm run fit:pultec`, jointly across 44.1/48/96 kHz so one set of constants survives every rate the app can run at. Three of the four stages land inside **0.15 dB**; `thick/pre` is **0.57 dB** at 20 kHz, where bilinear warping compresses the top octave into almost nothing. A fifth section was tried for it and rejected — it did not clear the 15% margin the fitter demands before spending a biquad. Pinned against the CSVs in `test/dsp/pultec.test.js`.
  - **Pre and post are fitted independently, and that is the point.** A passive EQP-1A's boost and cut at the same nominal frequency are different shapes, so the recovery does not cancel the push. What survives is the character: Thick nets **+4 dB at 30 Hz and −4.6 dB at 20 kHz**, Presence nets a 4–10 kHz lift with the top octave scooped (its post cut is anchored at 20 kHz, per Scheps' own preference — which is why the preset that was called "Airy" is not airy and got renamed).
  - **The wet path's makeup is the compressor's own Gain, not a multiply after the post EQ.** It was staged after eq2, which is the wrong place: on the hardware the Gain knob feeds the output amplifier and the second Pultec sits after it, so makeup drives the tube rather than bypassing it. Measured cost of the old staging was small — about **1 dB less harmonic content** (−45.6 vs −44.5 dBc on a 200 Hz tone), with levels moving by hundredths of a dB, because gain commutes exactly through a linear biquad cascade. **The reason it was worth fixing is structural rather than sonic**: the makeup now flows through the compressor's own machinery, so changes to how OptoSmooth computes makeup reach this plugin instead of having to be mirrored into it. It also means the trim measurement iterates, as `computeAutoMakeupDb` does — makeup ahead of a nonlinearity moves the operating point it was measured at.
  - **That the post EQ has no gain stage of its own is a modelling gap, not a reason the ordering does not matter.** A real EQP-1A is a passive network followed by a tube makeup amplifier; ours is pure biquads. Once that stage exists, feeding it 6 dB light would matter a great deal — which is why the ordering was fixed before rather than after.
  - **The blend lives inside the kernel, not in the audio graph.** The wet path lags by the compressor's oversampling latency; a two-node parallel split would put an undelayed dry signal against it and comb-filter the low end, where the two are nearly the same waveform. The dry side runs a delay line of exactly that latency, and the plugin reports it once for the offline apply path to trim. Verified: at Mix 0 the output is the input, sample for sample.
  - **Equal-power crossfade, corrected for correlation — and the correction is not optional.** Equal power assumes uncorrelated sources; these two are the same voice, measured at **rho ≈ 0.95** on real material, so a textbook cos/sin blend runs up to **+2.9 dB hot** in the middle of the Mix sweep. The kernel divides by `sqrt(1 + rho·sin 2θ)`, which is flat end to end for a measured rho and degenerates to plain equal power at rho = 0. A linear blend was not the alternative — that dips 6 dB per path at the halfway point.
  - **Auto Output Trim is measured per region, in the worker**, alongside the correlation, by the same debounce/supersede machinery the compressors' auto-makeup uses. It sets the wet path's gain *before* the sum, so pushing Mix changes character rather than loudness — without it the Mix knob is a volume control and every A/B is decided by level.
  - **THE TRIM IS MEASURED IN THE SPEECH BAND (300 Hz–4 kHz), AND BROADBAND RMS WAS THE BUG.** Reported from real use: the output sounds quieter with no makeup. It was. On a real narrator recording **81% of the total energy sits between 125 and 500 Hz** and 2–8 kHz carries **1.6%**, so a broadband RMS match is to within a rounding error a match of the *fundamental region alone* — which is the one part of the spectrum Thick's net curve raises. The trim therefore read "already loud enough" while the whole intelligibility range came out **3 dB down**, with broadband RMS reading −0.15 dB and gated LUFS −0.24 dB. Every broadband loudness measure said the file was level; the band analysis said 500 Hz–8 kHz was down 2.7–4.0 dB and 8–16 kHz down 4.9.
  - **K-weighting is not a fix for that, measured.** Its shelf is +4 dB above 1.7 kHz, and against a band carrying 1.6% of the energy it moved the answer by **0.34 dB** on a 3 dB deficit. The instrument has to be band-limited, not merely tilted.
  - **THE MAKEUP IS REFERENCED TO THE LOUD PARTS, NOT THE AVERAGE — matching the average is a compressor that cannot make anything louder.** That is what makeup gain has always meant: the compressor pulls the loud moments down, you hand back what it took, the loud parts land where they started and everything underneath comes up. Restoring the *average* instead returns only the average loss, so the output is by construction exactly as loud as the input. The target is now the **95th percentile of 100 ms speech-band blocks** (blocks more than 40 dB below the loudest are dropped so pauses cannot drag it down). On the reported file at Squash 80 that moves the makeup **3.54 → 4.16 dB**.
  - **What it buys is `densityDb`, and it is small here for a structural reason.** Once the loud parts are level the wet copy's average sits **0.6–0.8 dB** above the dry's on real speech — that is the compression's actual yield, and the mix law passes it through instead of flattening it, so the output rises 0.00 → 0.18 → 0.63 dB across the Mix sweep. It is not the several dB the textbook picture suggests because **a 10 ms attack lets syllable onsets through nearly intact while the cell pulls the sustained body down**, so the chain reduces the average almost as much as it reduces the peaks: at Squash 80 average GR is 4.28 dB while restoring the average costs 3.54, only ~0.6 dB of daylight. (An earlier note here blamed the multi-second release. Wrong half of the ballistics — the release governs how it recovers, the attack governs what it catches.) A fast peak compressor would hand back far more. **Measured, and it overturns the textbook picture in one place**: restoring the single-sample PEAK needs only 2.88 dB — *less* than restoring the average — because the opto's onset overshoots mean peaks barely come down at all.
  - **The mix law now targets independent-sum power rather than unity**, `sqrt(cos² + r²sin²) / sqrt(cos² + r²sin² + 2ρr·cosθ·sinθ)`, so it removes the correlated-sum bump without removing the density. It degenerates to the previous formula at `r = 1`. Mix 0 is still exactly dry.
  - **What the plugin now promises is: Mix 0 is the dry signal, and pushing Mix adds the compression's density and nothing else** — monotonically, bounded, landing on the measured `densityDb` at full wet. Speech-band loudness is the domain throughout; broadband energy rises faster, because the character adds weight underneath the voice and making that weight pay for itself out of the midrange is what went wrong before. Pinned in `test/dsp/scheps.test.js`.
  - **A single broadband gain cannot fully correct a tilt, and the residue is the character.** After the fix, at the default Mix the speech band lands within 0.9 dB; at Mix 100 it is still 1.5–2.7 dB down against +3.1 dB at the bottom. That is the Pultec net curve doing what it is for, and the answer to wanting it milder is Mix, not more gain.
  - **Two synthetic corpora missed this and one real 46-second file found it in one measurement.** Every probe used during development put its energy where the effect is flat, so the broadband match happened to be right on them. **Seventh time synthetic material has been too clean to answer the question asked of it.**
  - **Squash defaults to 62, above a mid position, because the side-chain arrives twice-filtered.** The pre EQ takes ~4.7 dB out of the lows and R37 takes 10 dB more below 1 kHz, so the cell sees far less than the raw signal: 62 here lands around **7.25 dB** of gain reduction on speech at nominal level, where the same number on the Opto Comp panel with a flat side-chain gives **11.6**.
  - **IT WAS 80, AND WHAT THE MOVE PRESERVES IS THE OPERATING POINT, NOT THE NUMBER.** 80 delivered that same ~7 dB under the old Peak Reduction taper, which topped out at 13 dB of reduction across its entire travel. The fitted taper reaches 27, so 80 on the same clip became **14.2 dB** — double the compression on the default patch, silently, from a change made two layers away in the compressor. **Every Squash figure recorded in this file before the taper fit refers to the old law** and is not comparable to a Squash reading taken now.
  - **The chain levels phrases, not syllables, and that is the T4 cell rather than a setting.** 10 ms of attack into a release measured in seconds cannot follow a syllable. Measured across envelope rates at fixed settings: a 0.1 Hz swell flattens by **1.3 dB**, a 3 Hz one by **0.16**. The levelling tests use a slow envelope for that reason — a fast probe makes a working compressor look idle.
  - **Crest factor is the wrong probe for this and the tests say so.** At Squash 80 the chain takes 12 dB of gain reduction while leaving crest factor slightly *higher* than the input — a 10 ms attack into a multi-second release lets every onset overshoot by design, and after makeup those overshoots are the peaks. The tests measure **spread of short-term RMS** instead, which is what a leveller actually reduces.
- **EQ** — parametric, 12 bands, live analyzer. One strip per band (gain knob, filter shape, frequency and width knobs) with all bands on screen at once; shape options are positional, so cuts and shelves are offered only on the lowest and highest bands. Opens on a neutral four-band starting layout.
- **ResoTame** — dynamic resonance suppression, with a **per-frequency display in place of a gain-reduction meter**. A compressor pulls everything down by one amount, so one number describes it; this cuts a handful of narrow bands and leaves the rest alone, where "6 dB" cannot distinguish a surgical notch from 6 dB taken off half the spectrum. Two lanes over one log-frequency axis (`src/components/meters/ResonanceSpectrum.vue`): reduction hanging from the top on the same voltage-law scale the other panels' GR meters use, with a decaying per-bin peak hold that makes an intermittent ring findable; below it the spectrum the cut was decided from — input, the cepstral reference plus Selectivity as the threshold line, and the output, with the removed sliver shaded between them. **The curves are the kernel's own numbers, not a second analyser on the output** — an FFT of the output could show the result of a cut but never the reference it was decided against, and that reference is the whole explanation of why a peak was or was not treated. The kernel resamples its frame onto a 192-point log grid and posts **five curves** with the meter message (`readDisplay`, ~46 Hz): magnitude, reference, output, live reduction and held reduction. Magnitude is normalised to dBFS. **The output curve is sent, not derived as `magnitude − reduction`** — those two summarise a display cell from different FFT bins (loudest vs most suppressed, different bins in 65% of the cells carrying any cut on real speech), so subtracting them draws a notch up to 2 dB deeper than the one that happened. Reduction is sent twice for a related reason: the live curve agrees with the spectrum beside it, and the held curve — the maximum since the last read, so a peak landing on an unread frame is not lost — feeds the peak-hold outline and nothing else. **The peak hold ages per bin.** One shared timer was tried and is broken by construction: it resets whenever any of 192 bins rises, something always is, so the trace never reaches its decay phase — an intermittent 3 kHz ring still read full height three seconds after it stopped, against 0.49 → 0.37 → 0.16 with per-bin ages. Side effect worth knowing: with `PROTECTION OFF` the display shows the suppressor eating the harmonic comb, so the warning that it thins the material is now visible rather than only asserted. **A `DELTA` monitor sits beside ON/BYPASS in the header** — audition only what is being removed. It applies the *complement* of the gain inside the same STFT (`ResonanceKernel.setMonitor`) rather than subtracting two signals downstream: the transform is linear and reconstructs exactly, so `ISTFT(X·(1−G))` is `ISTFT(X) − ISTFT(X·G)` sample for sample, with no delay to align and no second path to drift (pinned in `resonance.test.js` — output + delta reconstructs the input to 7e-9). **It is not a parameter and must never become one**: `applyResonanceRegion` spreads its param object straight into the kernel, so a monitoring mode living in `params` would be one careless key from rendering a difference signal into the timeline. It travels on its own port message, which the offline path never sends. **The display cost the panel 175 px it did not have** — everything below the fold was reachable only by scrolling, which pushed Depth off the top — so the faceplate was compacted to fit a 800 px viewport with no scroll: the plot splits its height between the lanes by ratio rather than at a fixed 56 px, its readouts and legend share one line above the plot instead of two either side of it, and Low Limit / High Limit merged into one two-handle log-frequency fader (`src/components/knobs/DeviceRangeSlider.vue`) — the lit span between the handles is the processed band. **Each handle stops at the other one and at nothing else.** It first kept the old per-parameter limits (low ≤ 1 kHz, high ≥ 2 kHz) on the argument that merging two faders is presentational and must not widen what the effect can be set to — wrong about how the merged control reads: on two faders a limit is where that fader ends, on one shared track a handle stopping dead with track visibly in front of it reads as a jam. A closed band is therefore reachable and means the effect processes nothing, which is legible rather than silent because the display washes out everything outside the band. Handles that can meet can also hide each other, so z-order goes to whichever still has somewhere to go. **A range input is not a controlled component** — the browser moves its thumb with the pointer and fires `input` afterwards, and Vue patches `:value` only when the bound value *changes*, so the moment a handle reaches the other one and the clamp starts returning the same frequency there is nothing to patch and the thumb sails past the stop and stays there. `syncThumbs` writes the accepted position back after every event, which is what makes the stop real. **Separately, `FloatingWindow` now says when a panel runs past the fold** (`MORE ↓` over a fade, measured from the DOM): a window taller than the viewport always scrolled, but its hairline scrollbar plus a faceplate's hard bottom edge made a panel with controls below the fold look like a panel without them — reported twice as a control that had vanished. Shortening a panel fixes one viewport; saying so fixes every viewport. **THE ATTACK AND RELEASE MAXIMA WERE INHERITED, NEVER MEASURED, AND ARE NOW 400 / 2000 ms.** Long ballistics were found by hand to suppress the pitch artefacts that appear with `PROTECTION OFF`, and the sweep says the credit is misassigned: at fixed selectivity, longer attack gets **worse** per dB removed (0.351 → 0.417 from 12 to 800 ms) and at 800 ms removes 0.87 dB, barely above the mask-on config's 0.20 — it is a throttle, not a cleaner. Longer release genuinely improves per dB (0.416 → 0.299 out to 4 s). **Matched at 3.0 dB of cut the whole effect is modest and saturates** — jitter 0.96/1.29 at 12/80, 0.80/1.02 by 200/500, then flat to 200/4000 — so the large raw-sweep numbers were the throttle, not the ballistics. What keeps improving is **p90 depth, 8.5 → 5.2 dB**: the same average cut spread evenly instead of concentrated in momentary deep notches, which is the plausible reason the artefacts are audible at all and the reason to raise the tops. 400/2000 captures nearly all of it; 800/4000 is marginally better (0.73/0.90) but needs selectivity at 13.5 to hold the cut and an attack near a second no longer tracks a phrase. **Pause bleed falls rather than rises at matched cut** (−2.47 → −1.19 dB), because the higher selectivity a slow setting needs more than pays for the longer tail. **SENSITIVITY NODES ARE EDITED ON THE PLOT, AND THE THING THEY MOVE IS ALREADY DRAWN THERE.** A node is not a filter — it offsets Selectivity over a span of the spectrum, and Selectivity is the dashed threshold line. So the panel draws **two** thresholds once a node exists: the flat one the knob asks for, dim, and the one the detector will actually use, bright, with the gap between them shaded. That gap *is* the node — depth and width both — drawn at the place the decision is made rather than as a separate curve needing to be related back to this one. With no nodes the two coincide and only one is drawn, so a panel that has never touched this is unchanged. Positive is **more sensitive**, which reads backwards as a gain and correctly as what it is; soothe2 names the same inversion when it calls its own version "an inverse EQ". **Handles hit-test on frequency alone** — they ride a curve that moves with the audio, so a radial test would make the editor feel broken on loud material and fine on silence; a node's identity is its frequency and nodes are separated in frequency. Double-click places and removes, drag moves, shift-drag or scroll sets width; **every one of those has a keyboard equivalent** (`n`, arrows, `[`/`]`, Delete) because the only editor for a parameter living inside a canvas is otherwise the one control in this panel that some people cannot use at all. **The arithmetic is `src/components/meters/resonanceNodes.js`, not the component**, and it is tested (`test/dsp/resonanceNodeEdit.test.js`): a frequency mapping off by an octave, a drag that loses its excursion against a clamp, or a hit test that cannot reach the node it is drawn under all still look like a working node editor. Drags are measured from the grab rather than incrementally, for that last reason. **It costs no panel height** — the affordance hint borrows the readout line's idle state and disappears once the first node is placed.
- **VoiceRx** — voice diagnosis (renamed from VoxDoc). Client port of Stage 3a's cepstral envelope and edge-anchored deviation detection, producing plain-language findings with measured centre frequency and Q, over a role-knob control surface. **Corrections are applied the moment analysis completes**, not offered for approval — the findings list is a set of live on/off switches with a per-row solo, so the first thing the user hears is the corrected version and switching any of it back off is one click. Nothing touches the file until Apply.
- **Spectral hole detection (VoiceRx only — client has diverged from the server here).** Edge-anchored baselines assume the context windows either side of a scan region are representative. A deep notch inside one — what a previously applied surgical EQ cut leaves behind — drags that anchor down, tips the chord, and makes ordinary spectrum on the far side of the region read as a large hump. A single hole corrupts the region *below* it and the region *above* it, producing a matched pair of phantom cuts, which iteration then drives to the caps. `src/audio/voicerx/holes.js` finds notches by greyscale morphological closing in log-frequency (exactly zero on any monotone slope, so spectral tilt cannot produce a false positive; `min` of the two shoulders, so a brick-wall edge cannot either). Hole bins are excluded from anchor medians and the context window widens past them; a region more than `MAX_HOLE_COVERAGE` inside a hole is reported `skipReason: 'spectral_hole'` and left uncorrected. Holes are surfaced as advisories (`buildAdvisories`) and hatched on the plot — **never auto-filled**. Note the reason: *not* that the band is empty (a notch attenuates, it does not delete — the reference clip still measures 23 dB of speech-above-floor at the bottom of a 17.6 dB hole, so this is **not** the `DEAD_REGION_DB` case and must not be argued as if it were), but that the boost needed exceeds anything the tool spends unasked per `MAX_TOTAL_CAP_FACTOR`, that the band's room tone rises with it, and that the tool cannot know whether the cut was deliberate. `server/scripts/corrective_eq.py` still has the original flaw and needs this ported.
- **THE SHIPPING BASELINE IS THE CHORD; the trend is wired, scored and not default.** The default went to the trend on corpus evidence and came back on listening evidence, and both moves were right on what they had. `analyzeVoiceRx` defaults to `{ baseline: 'chord' }`; the trend is `{ baseline: 'trend' }` and is scored as **`v1trend`**. Harness names track the default, so **`current` is the chord**. `robustTrend` lives in `voicerx/trend.js` (promoted out of `v2/`, and it stays there — shipping code should not import from a directory documented as unwired, and the trend is one flag away from shipping). **To A/B by ear**, `?voicerxBaseline=trend` or `localStorage.setItem('voicerxBaseline','trend')` (`src/audio/voicerx/baselineOverride.js`); an amber badge shows whenever any override is active. Cost of the trend on the live path is 4% (392 ms vs 376 ms on a 4 s selection).
- **WHY THE CHORD WON, AND WHAT IT DOES NOT SETTLE.** The two make opposite errors and the corpus can only see one of them. The trend is better on every countable measure against 13 finished masters — invented bands 89→48, invented gain 289.4→132.0 dB, bands on F0 1→0, convergence residual 0.11→0.00. But those files needed *nothing*, which is not the input this tool receives, so the corpus measures "did it damage good audio" and is silent on "did it find the problem a person can hear". Listening across several files preferred the chord, specifically **its two distinct low-mid cuts over the trend's merged single one**. When a countable proxy and a direct observation disagree about the thing the proxy stands in for, the observation wins. **The trend's advantage remains real and unaddressed**; the two things standing between it and shipping are the low-frequency blind spot and the band merge, both measured and both open.
- **RUMBLE IS ITS OWN HEURISTIC, outside the region/deviation structure** (`src/audio/voicerx/rumble.js`). Reported from use: VoiceRx almost never cuts the low end. It doesn't, and `sub_bass` fails there **four ways at once** — the analysed span starts at 60 Hz, exactly its scan floor, so its left context window is off the end of the spectrum; at `N_FFT` 4096 that scan is **6.5 FFT bins** wide and its context 1.3 (against `nasal`'s 51); it carries the **highest threshold in the table** at 4.0 dB; and real rumble is mostly **below 60 Hz**, which the envelope never looks at. Measured: a +20 dB resonance at 90 Hz moves its deviation 1.12 → 2.83 dB and never fires; +20 dB at 40 Hz moves it **0.06 dB**. No threshold tuning fixes a measurement taken from six bins with one anchor. **Note the same structural flaw at the other end** — `REGION_SPAN_HZ` is exactly the union of the scan ranges with no margin, so `air` has no right anchor either, and that is the region whose +6 dB boosts at 14.8–16 kHz the slope guard had to suppress. One cause, opposite symptoms.
- **How the rumble heuristic works, and what it rests on.** Below F0 there cannot be voice — physics, not a comparison — so it asks a different question entirely and never touches the cepstral envelope. **Corner is prophylactic, depth is measured.** The corner is `clamp(min(0.75 × p25F0, 0.55 × medianF0), 40, 100)`; *not* a low percentile of F0, which is the obvious choice and is wrong — the tracker's search floor is 70 Hz and octave-halving errors pile against it (reference clip: p1 71, p5 76, p10 84, p25 107, median 138, so p5 reports the floor rather than the speaker). Depth comes from the **tilt of the spectrum below the corner**: a clean recording falls away toward DC because nothing is down there, rumble is energy piled at the bottom and flattens it. An absolute energy ratio was tried first and fails — 20 dB of rumble moved it 5.5 dB, and a 90 Hz resonance *above* the corner moved it the same way. Tilt on the reference clip: clean −14.7, +6 dB rumble −11.1, +12 −7.4, +20 −3.2, and a 90 Hz peak −20.3 (correctly ignored). Gain is the excess over a clean tilt, capped at 12 dB, suppressed below 1 dB. It reads the **whole selection including pauses** — HVAC does not stop when the narrator does. `sub_bass` is dropped from the correction set (`skipReason: 'rumble_heuristic'`) so two mechanisms cannot both place a shelf down there. **All three detector baselines are bit-identical after this** — independent confirmation that `sub_bass` never contributed a band.
- **The rumble heuristic cannot be scored by the synthetic corpus, and the reason is a corpus defect.** `synthVoice` gates its pauses with a hard on/off, and those discontinuities splatter broadband energy below F0 that no real recording has: the synth's sub-F0 tilt reads **−1.4 dB** where a real clip reads −14.7, so the heuristic sees rumble that is purely a generator artefact. Rumble bands are therefore excluded from `runScorecard` (they are also unclaimable — no planted defect can match a band justified by physics rather than by deviation), and `test/dsp/voicerxRumble.test.js` builds its own signals with **raised-cosine pause edges**. **`CLEAN_TILT_DB = −14` is calibrated on one file** and is the first thing to re-derive once raw, unmastered narrator recordings exist — every file available when it was written was synthetic or already mastered, and mastering has usually high-passed the bottom away already. **Sixth time this corpus has been too clean to answer the question asked of it.**
- **`MAX_TOTAL_CAP_FACTOR` IS 1 — the per-region dB caps are TOTAL caps.** `MAX_CUT_DB = 6` for mud now means this tool will never cut mud by more than 6 dB, which is what the number reads as. It was 2, on the argument that holding the total to the per-pass figure would make iterating pointless. That argument was wrong about what iterating is *for*: iteration does not exist to keep spending on a region already at its limit, it exists because **a second feature can be unmeasurable until a larger adjacent one comes down**. That still works at 1 — a region first detected on a later pass gets its own full budget. Reproduced synthetically and pinned: a 900 Hz +10 dB hump beside a 550 Hz +8 dB one hides the smaller entirely until the first correction lands, and `boxy_honky` is then detected **on pass 2**. Same mechanism as the reference clip's mud band. **Measured cost: recovery median 0.50 → 0.42** on the chord (0.44 → 0.42 on the trend) — large defects are now deliberately under-corrected and stay flagged rather than earning a big surgical cut taken on trust. Detection and invented bands are unchanged.
- **THE CHORD'S OVERSHOOT WAS THE THIRD ITERATION PASS — fixed, `MAX_CORRECTION_PASSES` 3 → 2.** Reported from listening: the chord cuts harder than the defect warrants. It does, and the mechanism is that each pass re-derives its baseline from audio the previous pass already altered, so a reference carrying any bias compounds that bias every round. The original argument for three passes was pure convergence arithmetic and assumed each pass re-measures the *same* defect more accurately; it does not. **Detection is 67% at one, two and three passes** — iteration never finds a defect, it only decides how much to spend on one already found — so capping it costs nothing measurable. On the 5 kHz-notch clip the chord goes from **−7.9 dB to −5.7 dB** on a region it measured at 5.12 dB, keeping both bands (340 Hz −2.0 and 609 Hz −5.7; with `MAX_TOTAL_CAP_FACTOR` since taken to 1 it lands at −5.0, the region's cap); corpus invented gain 79.4 → 75.7 dB with detection and recovery unchanged. **One pass is too few** — recovery 0.50 → 0.42 and the mud band vanishes, because it is only measurable once the larger adjacent hump comes down, which is the legitimate half of iterating. The shipping trend is near-indifferent (19.8 → 18.7 dB, detection and recovery identical), which is the same tell as its 0.00 convergence residual: a reference not chasing its own corrections has little to do on a third round.
- **Listening prefers the chord's two-band answer on the notch clip, and that is a real signal about band merging, not only about baselines.** The chord reports `mud 340 Hz −2.0` and `boxy_honky 609 Hz −5.7`; the trend at `thresholdScale 0.8` detects **both regions too** (mud 2.07 dB @ 410, boxy 2.46 dB @ 445) but places their centres 0.12 octaves apart, so `mergeBands` (`MERGE_OCTAVES = 0.33`) collapses them into one band at 427 Hz. So the disagreement heard as "the trend misses the boxiness" is partly **the trend locating the boxy peak 0.45 octaves lower than the chord does**, and then merging. Where each reference puts a peak inside a wide scan region is unexamined and is the next thing to measure.
- **LISTENING SAYS THE THRESHOLDS ARE MISCALIBRATED FOR THE TREND, and the corpus agrees.** Reported from real use: the chord catches critical defects the trend walks past, *and* overshoots — big cuts where a smaller one was right. Both halves have a mechanism, and they are the same mechanism. Every threshold in `regions.js` was tuned against **chord** deviations, which are inflated by the curvature bias (a convex spectrum sits above its own chord whether or not anything is wrong), so each threshold silently absorbed some bias; remove the bias and the same numbers are too high. On the original 5 kHz-notch clip the trend measures a real boxy resonance at **2.46 dB against a 2.5 dB threshold** — a miss by 0.04 dB on a defect a person can hear — while the chord calls the same region 5.12 dB and, over three passes, spends **−7.9 dB** on it (a single pass at `SCALE = 0.70` would spend −3.6). That is the overshoot: iteration compounding on an inflated measurement. Scaling every threshold by **0.80** beats *both* shipping detectors on every synthetic axis at once — detection **70%** (chord 67%, trend 63%), recovery **0.58** (0.50 / 0.44), invented bands **7** (24 / 5), invented gain **27.1 dB** (79.4 / 19.8) — with convergence still 0 and risky boosts still 0. Below 0.75 it collapses (x0.60 → 41 invented bands), so 0.80 is a knee, not a slope. On the clip it finds the low-mid problem the chord found, at **−3.2 dB total instead of −7.9**. **It is NOT the default**: that table is the synthetic corpus, which has been wrong about the real-audio ranking three times, and lowering a detection threshold can only increase what gets offered on audio that needs nothing. Reachable as `?voicerxThreshold=0.8` (or `analyzeVoiceRx(..., { thresholdScale })`) so it can be heard; **run `npm run scorecard:real` before promoting it.**
- **VoiceRx is measured, and the numbers are poor.** `npm run scorecard` runs a 58-case synthetic corpus (`test/voicerx/`) in which a clean voice is corrupted with a *known* EQ move, so the correct output is the exact inverse and needs no human judgement. Baselines in `test/voicerx/baseline.json`. **`current` (trend): detection 63%, recovery median 0.44, spread 0.37, 5 invented bands totalling 19.8 dB, aim 0.011 octaves.** `v1chord` (now `current`): detection 67%, recovery 0.50, spread 0.58, **24 invented bands totalling 79.4 dB**, aim 0.021. Note what the switch bought and cost on synthetics alone: 4 points of detection for a **79% cut in invented gain** — and the synthetic corpus is the one that *disagrees* with the real one about this trade, see the real-corpus table below. Aim is the one strong result on both. Where the trend still invents: the **bandwidth family, 3 bands / 15 dB** (cuts at ~9 kHz on band-limited files — the trend's own edge weakness, distinct from the boost family the slope guard fixed), where the chord invents none. Blind spots are structural: `body_warmth`, `lower_presence` and `air` are dip-only with `MAX_CUT_DB = 0`, so a hump anywhere in 1200–2500 Hz (or at 180 Hz, or 11 kHz) is **undetectable by construction**. The trend adds one of its own, **measured and pinned in `voicerxAnalysis.test.js`**: a defect sitting on the spectrum's own maximum is near-invisible to a smooth local reference, so a 12 dB resonance at 300 Hz on an F0 120 voice reads 1.24 dB against the trend where the chord saw it clearly. That is the mechanism behind the low-frequency misses (180/200/220/300/400 Hz) and it is inherent to the approach, not tunable. `test/voicerx/scorecard.test.js` pins a 6-case subset as a regression guard — it asserts the numbers are *unchanged*, not that they are good; re-record with `node scripts/voicerx-scorecard.mjs --smoke --write-baseline`.
- **VoiceRx v2 exists, behind the harness, not wired into the app** (`src/audio/voicerx/v2/`; its `robustTrend` and `toLogGrid` now live one level up in `voicerx/trend.js` because the shipping detector uses them). Measure (envelope + two half-envelopes + noise floor) → mask (per-frequency **measured SNR**, replacing `DEAD_REGION_DB`/`no_energy`/`flatBaseline`) → robust local quadratic trend (replacing the chord) → continuous peak/trough finding on the residual (replacing the nine-region grid, `mergeBands`, and the directional blind spots) → confidence from four multiplied terms (evidence, conditioning, split-half stability, plausibility — replacing the caps and the hole guard) → `gain = -height × confidence`. **63 hand-set region constants become 6.** Scored on the same corpus: detection **67%→83%**, recovery median **0.50→0.67**, spread **0.58→0.41**, invented bands **27→4**, invented gain **90.1→7.7 dB**, aim **0.021→0.015** octaves. Score both with `npm run scorecard --detector=v2`; both are pinned in the baselines.
- **v2 output policy (step 3).** Continuous detection finds everything, including real fine structure that is not a tonal defect. Three rules shape the output, each measured: a **minimum feature width of 0.22 octave** (below a critical band the ear does not hear a peak as tonal colour — the junk bands on the reference clip measured 0.042–0.125 octave, the planted defects 0.25–0.63); a **minimum spacing of 0.33 octave** between corrections, greedy by strength, which is what killed the adjacent opposite-sign pairs; and a **cap of 6 bands** (a product limit, not a DSP one). Advisories get the same spacing rule, or one wide notch reports itself two or three times. Reference clip: **6 sensible bands + 1 correct hole advisory**, down from 10 bands.
- **THE REAL CORPUS CONTRADICTS THE SYNTHETIC ONE, and the real one wins.** On 13 commercially mastered ACX files (31 windows), where the right answer is very nearly "no correction": v1 offers bands on **30/31 windows, 3.06 per window, 336.6 dB total**; v2 offers **30/31, 3.35 per window, 388.8 dB**. The synthetic corpus rates v2 at 4 invented bands across 58 cases; real finished audio gives ~104 across 31 windows. **The synthetic ranking does not transfer**, and on the metric that matters most for a consumer tool — do not damage good audio — neither detector is fit to ship, with v2 marginally worse by count. Two specific, addressed bugs fell out (below). Do not read the synthetic scorecard as a shipping signal again without checking it against `npm run scorecard:real`.
- **The SNR mask looked inert, and that reading was itself the epsilon bug.** It first measured **100% live on 31/31 real windows**, never excluding anything, and I wrote it off as a mask that is not a mask. Wrong diagnosis: the absolute log-power floor was flattening the *noise* envelope to a constant, so every SNR ratio was measured against a floor that could not go below the epsilon and came out enormous. With the relative floor in place the same corpus reads **40% live to 539 Hz on `bk_ParadeofHorribles`** (SNR 9.9 dB, the file whose pauses are literal digital silence at −240 dBFS), **94–95% live to 11.2–12.2 kHz on two `ProjectHailMary` windows**, and a median speech-band SNR of **48 dB rather than 55.4**. The mask now excludes bandwidth edges and refuses spectrum it cannot measure — on `ParadeofHorribles` that alone takes v2 from 4 bands to 1. It still does **not** exclude sub-F0, so the fundamental bug below stands on its own.
- **v2 cuts the fundamental.** In 17 of 31 real windows v2's lowest band lands within 7.5% of the measured F0 — ratios 0.93 to 1.075, across seven different narrators — and up to −8 dB. F0 is the voice's pitch, not a defect in it. The mechanism is structural: below F0 there is no voice energy at all, the envelope steps up into it, and a smooth quadratic over ±2.5 octaves cannot follow a step, so the envelope sits above the trend at F0 and reads as a resonance. The SNR mask should have excluded sub-F0 bins and does not. `nearF0` in the real-corpus report flags it per band. Measured: **v2 17/96 bands within 15% of F0, v1 1/89** — and the epsilon fix, which repaired the mask everywhere else, moved this count by exactly zero — and v1's single case (ProjectHailMary, F0 105.3, band at 94 Hz −8.0) is the one narrator whose F0 falls in `sub_bass`, the only low region v1 scans for humps. **v1 is protected by its directional blind spot, not by better measurement**: for F0 between ~135 and 280 Hz the fundamental lands in `body_warmth`, which is dip-only with `MAX_CUT_DB = 0`, so v1 cannot cut there whatever it measures. Reproducible synthetically — a clean F0 160 voice gives a 1.29 dB residual bump at F0 (under the 2 dB floor, which is why 58 synthetic cases never showed it), and adding the 60–80 Hz high-pass every ACX master carries takes it to 2.2–2.6 dB and v2 emits a band. **Removing a constraint you do not fully understand means inheriting what it was suppressing.**
- **Two thirds of what v2 says on real audio comes from two addressable bugs.** Half-octave histogram of its 104 invented bands: **177 Hz — 16 bands** (the F0 bug) and **11.3 kHz — 12 bands**, together 27% of everything it emits. v1's own cluster was **16 kHz — 6 bands, every one a +6.0 dB boost pinned at 2× its cap**, the worst possible direction there (boosting 16 kHz raises hiss) — **fixed by the slope guard, that bin is now empty**; v2's two are not, it does not use that code path. v2 also emits a run of **+3 to +5 dB boosts at 4–6 kHz** across many files: mastered audiobooks are de-essed there, so v2 is systematically offering to undo professional de-essing — the direct consequence of a notch reading as a deficiency.
- **Repeatability, measured: v1 74%, v2 50%.** Of the bands a detector reports on one window of a finished file, that fraction recurs in every other window of the same file. v2 tells you something different half the time you ask.
- **How the trend was isolated before it was adopted (`v1trend`, now `current`).** v1's region tables, directions, thresholds, caps, SCALE, iteration and merge unchanged; only the chord baseline replaced by the robust local quadratic. Synthetic corpus: invented bands **27→8**, invented gain **90.1→29.8 dB**, and the **notch family goes to zero** phantom corrections — the failure that started this investigation, gone without a hole detector involved. It costs detection (67%→63%, recovery 0.50→0.44) because v1's thresholds were calibrated against chord deviations and the trend is a tighter reference; that recalibration is deliberately not done against synthetics. **It does NOT fix the bandwidth-edge boosts** — that bug lives in the region structure, not the baseline (the slope guard does, and covers all three detectors' v1-path regions).
- **The two corpora disagree about the trend, and the real one decided it.** Same 13 files, 31 windows, with the slope guard in place:

  | on finished masters | v1 | `v1trend` | v2 |
  |---|---|---|---|
  | windows offered bands | 30/31 | **26/31** | 30/31 |
  | bands per window | 2.87 | **1.55** | 3.10 |
  | total invented gain | 289.4 dB | **132.0 dB** | 349.7 dB |
  | bands within 15% of F0 | 1/89 | **0/48** | 17/96 |
  | bands failing to recur, per file | 0.78 | 0.89 | 1.44 |

  (v2's column is post-epsilon-fix; v1 and `v1trend` are unmoved by it, bit-identical before and after on all 31 windows.)

  `v1trend` invents **half** of what v1 does and **45%** of what v2 does, at a third of v2's total gain, and never touches the fundamental. The synthetic corpus charged it 4 points of detection for the trend; the real corpus refunds that many times over on the axis that matters for a consumer tool. **Its one real cost is repeatability, 75%→56%** — and part of that is arithmetic (at 1.55 bands per window a single non-recurring band costs proportionally more than at 2.87), so a like-for-like recount is the one number to pin down before adopting it (the tooling for that is now in place — see the repeatability note below). v2 is unchanged by the guard, as expected — different code path.
- **The notch advisory fires on 9 of 13 finished masters**, 6–15 dB, at 5.6–10.3 kHz and clustered at 6–8 kHz in eight of the nine, identically for v1 and `v1trend` (the hole detector is baseline-independent). These are most likely *real* — professional de-essing cuts exactly there, so each instance may well be a true positive. That does not save it: **an advisory that fires on 70% of professionally finished audio carries no information**, whatever its per-case accuracy. Before this ships to users it needs either a de-essing-shaped exclusion or a much higher bar in that octave.
- **v2's top-end failure was mostly the epsilon, and is mostly gone.** It scored zero bandwidth-spurious bands on synthetics but on real audio emitted a 12-band cluster at 11.3 kHz plus 2 at 16 kHz, and reported suppressed "resonances" of **19.8–23.4 dB at 11.3–15.9 kHz** on four windows. Those giant phantom peaks were the absolute floor flattening the roll-off into an apparent plateau: after the fix **every one of them is gone**, the 16 kHz and 8 kHz bins empty, and v2 drops from **104 bands / 388.8 dB to 96 / 349.7**. The **12-band cluster at 11.3 kHz survives unchanged** — that one is the trend failing on the roll-off, not the floor.
- **Corrections on a filter slope are refused (`skipReason: 'bandwidth_edge'`).** `air` is a fixed 9–16 kHz dip-scanned band, so on a file whose content stops lower it lifts the roll-off — six +6.0 dB boosts at 14.8–16 kHz on the real corpus, every one pinned at 2× cap. Guarded by local slope, and the separation is enormous: false boosts sit at **−56 to −62 dB/octave**, real deficiencies and clean spectrum at **−5 to −9**. Nothing in between, so the 25 dB/octave threshold's exact value does not matter. Applies to cuts as well as boosts (a feature on a filter slope is a filter artefact whichever way the correction points) and takes v1's bandwidth family to **zero** invented bands with detection unchanged. This one touches shipping code; it only ever suppresses. **Confirmed on the real corpus, which is where the bug was found:** v1 goes from **95 bands / 336.6 dB to 89 / 289.4 dB**, the 16 kHz histogram bin disappears entirely, and **risky boosts above 3 kHz go from six (+36 dB, all at 14.8–16 kHz) to zero** — v1's largest remaining boost anywhere on 31 windows of finished audio is +3.3 dB at 1.5 kHz. This is the only change in the whole spike that has been validated on both corpora and shown to help on both.
- **Three ground-truth-free checks (`npm run robustness`, `npm run robustness:real`).** Invariance (gain and polarity must change nothing — anything under 100% is a bug; window shifts held to a lower bar), convergence (apply a detector's own corrections, re-analyse — a detector reading the voice has little left to say), and direction (boosts above 3 kHz, where a lift adds the very defects users come to remove). They work on any audio, annotated or not. **All three detectors pass everything on the synthetic corpus** — which is a finding about the corpus, not the detectors: it cannot exercise these either. **On the 13-file real corpus they separate, and one of them found an actual bug:**

  | on finished masters | v1 | `v1trend` | v2 |
  |---|---|---|---|
  | exact invariance (min) | **100%** | **100%** | 89% — a bug, now fixed |
  | framing invariance (mean) | 99% | 97% | 95% |
  | convergence, median residual | 0.11 | **0.00** | 0.24 |
  | risky boosts >3 kHz | **0** | **0** | 5, +18.3 dB |

  Three findings. (1) **v2 is not invariant to gain or polarity on one file** (`bk_HarryPotter`, 89%) — a transformation a magnitude spectrum cannot see changed its answer, which is a defect by definition rather than a tolerance. (2) **`v1trend` converges completely** where v1 leaves 11% and v2 leaves 24% of its gain still wanted after applying its own advice — a detector chasing structure in its own reference never settles, and this is the cleanest evidence yet that the trend is reading the voice rather than the baseline. (3) The direction check confirms the slope guard on real audio and re-confirms v2's de-essing-undo problem from an independent angle.
- **The v2 invariance bug WAS the absolute epsilon — found, fixed, and the fix is behaviour-neutral.** Both detectors floored their log-power spectrum with an absolute `+ 1e-10`. Bins below the constant get flattened up to it and bins above keep their value, so which side a bin falls on **moves when you apply gain**: the same recording, 6 dB louder, produced a different envelope. Now a floor **120 dB below each frame's own peak** (`logPowerSpectrum` in `analysis.js`, shared by both detectors — they had separate copies of the same constant), which scales with the signal and is exactly scale-invariant. Verified: doubling the input moved envelope bins by between 6.02 and 10.3 dB before, and by exactly 6.02 everywhere after. **Both scorecards are bit-identical to their recorded baselines** — v1 67% / 0.50 / 24 spurious / 79.41 dB / 0.021 aim, v2 83% / 0.67 / 4 / 7.66 / 0.015 — so this buys the invariant for nothing.
- **Two wrong attributions on the way, and the second is the reusable lesson.** I first reported the epsilon as *ruled out*, because attenuating a case to −60 dBFS and gating its pauses to −40/−80/−140 dB left all three detectors at 100%. Both probes were bad. (1) They ran **end to end through the bands**, where a defect is only visible once it is large enough to change a decision — so the bug hid on every synthetic case while breaking a real file. (2) The gate depths **straddled past the failure**: the error is non-monotonic in level, peaking where the quietest bins sit near the constant, so −40 and −140 both read clean while −60 and −90 would not have. Measuring the property at the layer that must hold it (`test/voicerx/scale.test.js`) catches it on **6 of 7 signals including ungated audio** — the absolute floor broke invariance on ordinary material too, it just never moved a band there. **Assert invariants at the layer that owns them, not through the pipeline that consumes them.**
- **The diagnostic that made this findable.** `invariance()` records which band moved under which transformation, so the real-corpus run printed `bk_HarryPotter / gain +6 dB / differs: 12140Hz −2.9 (base only)` instead of "89%". A band at the top of the spectrum vanishing when the file gets *louder* named the mechanism in one line — a percentage alone is unchaseable by anyone without the file, which for a gitignored corpus is everyone.
- **The repeatability gap was mostly denominator arithmetic — measured, resolved.** A per-file fraction charges a quiet detector more for the same absolute mistake (one stray band out of two is 50%, one out of five is 80%), which is exactly the shape of v1 at 2.87 bands/window against `v1trend` at 1.55. Adding a pooled fraction and an **absolute count of bands that failed to recur** settles it:

  | | per-file avg | pooled | bands that failed to recur, per file |
  |---|---|---|---|
  | v1 | 75% | 74% | **0.78** |
  | `v1trend` | 56% | 50% | **0.89** |
  | v2 | 55% | 55% | 1.44 |

  In absolute terms `v1trend` fails to reproduce **0.11 more bands per file** than v1 — not the 19-point collapse the fraction implied. It is genuinely a little less stable *per band emitted*, and it emits far fewer bands, so the number of findings a user sees change between two runs of the same file is about the same for both. **v2 is unambiguously worst at 1.44**, nearly double v1's, and that is the one number the epsilon fix did not improve.
- **Real-corpus tooling is ready and waiting for files** (`npm run scorecard:real`). Drop finished, already-mastered recordings in `data/corpus/voicerx/` — gitignored, same arrangement referenceEQ uses, so commercial audio never reaches the repo. It runs every detector over several windows per file and reports what each claims about audio a professional has already signed off, plus v2's **mask health** (was a noise floor measurable, what fraction of 60 Hz–16 kHz reads as live, median speech-band SNR). There is deliberately no pass/fail and no baseline: nobody knows what a finished master *should* report, and a finished file may legitimately carry a notch. Read it, do not gate on it.
- **v2's open problems (still do not ship it):** (1) **Low-frequency detection is poor** — planted defects at 180, 200, 220, 300 and 400 Hz are all missed. A defect centred on the spectrum's own maximum is near-invisible to any smooth reference (a +12 dB peak at 300 Hz leaves 2.25 dB of residual), and below F0 there is no spectrum to build context from. Measured, inherent to the approach, not tunable. (2) **`IMPLAUSIBLE_DEFICIENCY_DB` is the weakest constant in the design** — separating a fillable dip from a report-only notch rests on a **1.25 dB margin** in residual height, and the same −6 dB dip reads 3.29 dB at 2.5 kHz or 6.16 dB at 1.6 kHz depending only on local spectral shape. Two better discriminators were tried and failed (wider-scale depth widens the gap only slightly; per-frequency SNR deficit is *inverted*, because an EQ cut applied to a finished file attenuates its noise floor along with the voice). Finding a real discriminator is open. (3) Recovery spread is 0.41 — better than v1's 0.58, still not consistent. (4) **No real-file validation beyond one clip.** (5) **A deep notch perturbs the trend far past itself** — an 18 dB notch at 5 kHz on an otherwise clean synthetic makes v2 emit a spurious −3.6 dB band at 9.6 kHz, where the clean version emits nothing. The mask excludes low-SNR bins but a notch still has SNR, so the notch sits inside the fit window and drags the local trend down; the recovery above it then reads as a hump. Structurally the same failure as the one that started this work, one layer up.
- **The holes patch is frequency-dependent and does not generalise.** Measured: a −20 dB notch at 5 kHz is caught, but the same notch at **800 Hz produces no hole at all** and two phantom cuts totalling 11.1 dB. `min` of the two shoulders is slope-invariant for *rejecting* a monotone slope but slope-*biased* for measuring depth — on a falling spectrum the upper shoulder sits lower, under-reading the notch by roughly the slope across the window, which at 800 Hz is enough to fall under `MIN_DEPTH_DB`. This is evidence for replacing the approach rather than adding a fifth guard.
- **Known remaining weakness in both client and server:** the chord baseline also misreads pure *curvature*. A steep convex roll-off with no notch anywhere near it leaves the envelope above the chord across the whole region and reads as a hump. Fixing it means replacing the two-point chord with a curvature-robust local fit, which recalibrates every region on every file — deliberately not bundled with the hole fix.
- EQ and VoiceRx are **separate plugins with separate band pools and separate nodes in the live chain** (VoiceRx first — corrective before creative). They were built as two views onto one pool; in use, role bands and hand-placed bands sitting in one list looking alike but behaving differently was the problem, not the solution. The only link left is a one-way hand-off: VoiceRx can **move** its corrections into the EQ, where they become ordinary untagged bands. Moving rather than copying makes double-application structurally impossible. See `src/composables/useEqInstance.js`.

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
- **Test infrastructure** — Partial. `npm test` runs a `node:test` unit suite over the client DSP (`test/dsp/`, `test/voicerx/`, 311 tests). No integration or E2E tests, and no coverage of the server pipeline, Vue components or the async job flow
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
| `docs/instant_polish_processing_spec_v3.md` | ✓ Present | Full processing chain technical specification. Authoritative source for all processing parameters, stage definitions, preset profiles, and output profile behavior. |
| `docs/instant_polish_compliance_model_v2.md` | ✓ Present | ACX certification system, quality advisory flag definitions, report JSON structure, and UI model. Authoritative source for all compliance and reporting behavior. |
| `docs/instant_polish_processing_spec_noise_eraser.md` | ✓ Present | Noise Eraser preset specification. Documents the separation-based processing stages and their parameters. Read alongside v3 spec. Note: the NE-1 through NE-7 stage numbering used in this doc is deprecated — NE is now a standard preset in the unified pipeline. |
| `docs/scheps_vocal_chain_thick_spec.md` | ✓ Present | Scheps Parallel, "Thick" character: signal chain, reference knob positions and the measured target curves. Authoritative on what the curves *are*; the biquad fit that reproduces them is `scripts/fit-pultec-curves.mjs`. Companion data: `data/pultec_curves/scheps_thick_curve_data.csv`. |
| `docs/scheps_vocal_chain_presence_spec.md` | ✓ Present | The complementary "Presence" character. Read alongside the Thick spec — the two share a signal chain and differ only in curve data. Note the post-EQ cut is anchored at 20 kHz deliberately; the Naming Note explains why the preset is not called "Airy". |
| `docs/acx_production_workflow.md` | ✗ Not present | ACX narrator workflow reference. Context for why features exist and where Instant Polish fits in the production chain. |
| `docs/instant_polish_gtm.md` | ✗ Not present | Go-to-market strategy. Positioning, pricing, launch plan, SEO content map. |

**When in doubt about processing parameters, EQ values, noise reduction tiers, or output profile behavior: the processing spec v3 is authoritative. When in doubt about compliance reporting or advisory flags: the compliance model v2 is authoritative.**