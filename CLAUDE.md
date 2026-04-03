# Instant Polish — CLAUDE.md
> Project intelligence for Claude Code | Last updated: April 2026

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
| Compression | Client | Interactive parameter tweaking expects immediacy. OfflineAudioContext + DynamicsCompressorNode |
| Noise reduction | Server (DeepFilterNet3) | Quality gap vs. RNNoise is significant and user-visible. Modal wait is normal for this operation |
| Full preset chain | Server | Always server-side |

**Why not route normalize and compress through the server too:** Users expect these to feel fast — a 10-second wait to normalize a 30-second selection would feel broken even with a progress modal. The quality delta between client-side and server-side normalize/compress is acceptable for spot editing. For Mode 1/2 users, the preset chain re-applies these operations at the end anyway with full compliance targeting.

**Why noise reduction must be server-side:** RNNoise (the client-side alternative) produces meaningfully worse results than DeepFilterNet3. For a product positioning on audio quality, shipping an inferior NR path for spot edits is not acceptable. The processing modal pattern normalizes the wait — every major audio tool works this way for NR.

### Spot Noise Reduction — Naked DeepFilterNet3 Pass

When a user applies noise reduction manually to a selection, the server receives **only that clip** and runs **only DeepFilterNet3** — no preset chain, no EQ, no limiting, no compliance processing, no room tone padding. The model is applied to the clip with user-controlled parameters and the result is returned.

**Server request shape for spot NR:**
```json
{
  "file": "<selection clip>",
  "operation": "noise_reduction",
  "context": "spot_edit",
  "params": {
    "strength": 0.7
  }
}
```

The `context: "spot_edit"` flag suppresses all preset post-processing. The server applies DeepFilterNet3 and returns the processed clip only.

**⚠ Open question — DeepFilterNet3 exposed parameters:**
The appropriate user-facing controls for spot NR have not been finalized. Candidate parameters are **strength** (aggressiveness of reduction) and **sensitivity** (how conservatively the model classifies speech vs. noise). However, it is unclear how much the `deepfilternet` / `libdf` API actually exposes — if the model has only one meaningful control (attenuation ceiling), presenting two sliders that don't do meaningfully different things would be misleading. **This requires a research spike in Sprint 1 before the spot-edit NR UI is designed.** Findings should update this document.

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

### Non-Destructive Editing Model

Original audio data is never modified until export. All edits are segment pointer manipulations (EDL model). Source buffers are immutable. Processing — both client-side and server-side — produces new buffers into the pool.

Key data structures: `Segment`, `SilenceSegment`, `Timeline` (ordered segment array), `EditorState`. See Wavely spec for full definitions.

---

## Preset + Output Profile Architecture

These are **independent** selections. A preset governs the character of processing (Stages 1–4a). An output profile governs the loudness target, peak ceiling, and measurement method (Stages 5–6), and determines whether ACX certification runs (Stage 7).

### Presets (five at launch)

| Preset ID | Display Name | Audience | Channel Output |
|---|---|---|---|
| `acx_audiobook` | ACX Audiobook | Audiobook narrators | Mono |
| `podcast_ready` | Podcast Ready | Podcast hosts | Preserve original |
| `voice_ready` | Voice Ready | Voice actors | Mono |
| `general_clean` | General Clean | Everyone else (default) | Preserve original |
| `noise_eraser` | Noise Eraser | Severely noisy recordings where standard processing has failed | Mono (default) |

**Default preset:** `general_clean` — or `acx_audiobook` if the user has previously selected it.

### Output Profiles (three)

Output profiles are loudness targets, not compliance standards. They govern what the processing chain tries to achieve — they do not imply certification.

| Profile ID | Display Name | Normalization Target | Peak Ceiling | Measurement |
|---|---|---|---|---|
| `acx` | ACX Audiobook | -20 dBFS RMS | -3 dBFS | Unweighted RMS, voiced frames only |
| `podcast` | Podcast / Streaming | -16 LUFS integrated | -1 dBFS | K-weighted LUFS (EBU R128) |
| `broadcast` | Broadcast | -23 LUFS integrated | -1 dBFS | K-weighted LUFS (EBU R128) |

### Default Pairings

| Preset | Default Output Profile |
|---|---|
| `acx_audiobook` | `acx` |
| `podcast_ready` | `podcast` |
| `voice_ready` | `acx` |
| `general_clean` | `podcast` |
| `noise_eraser` | `podcast` |

**When output profile overrides preset:** the output profile wins on normalization target and peak ceiling. Example: `podcast_ready` + `acx` output profile → file processed with podcast character at ACX loudness levels.

**UI rule:** For `acx_audiobook`, hide/lock the output profile selector to `acx`. There is no meaningful reason to process an audiobook without targeting ACX levels, and surfacing the choice adds confusion.

**UI rule:** For `noise_eraser` with `acx` output profile, surface a warning: "ACX compliance is not recommended for Noise Eraser output. Separation artifacts may cause ACX human review rejection even if measurements pass."

---

## Processing Chain (Standard Presets)

```
Stage 1:  High-Pass Filter (80 Hz Butterworth, 4th order; + conditional 60 Hz notch)
Stage 2:  Adaptive Noise Reduction (DeepFilterNet3)
Stage 3:  Enhancement EQ (Meyda.js spectral analysis → FFmpeg parametric EQ)
Stage 4:  De-esser (conditional — only if P95 sibilant energy exceeds threshold)
Stage 4a: Compression (conditional for ACX; always-on for other presets)
Stage 5:  Loudness Normalization (libebur128 + FFmpeg loudnorm) ← output profile governs target
Stage 6:  True Peak Limiting (FFmpeg loudnorm two-pass, 192 kHz upsample) ← output profile governs ceiling
Stage 7:  Measurement + Processing Report
```

**Order is critical.** Operations out of sequence produce non-compliant output. Never reorder stages.

## Processing Chain (Noise Eraser Preset)

Noise Eraser is a **parallel path** — it does not use Stages 1–4a. It replaces them with a source separation pipeline, then rejoins at Stage 5.

```
Pre-processing (same as standard)
Stage NE-1: RNNoise pre-pass (unconditional)
Stage NE-2: Tonal noise pre-treatment (conditional notch filtering)
Stage NE-3: Demucs htdemucs_ft source separation (vocals stem only)
Stage NE-4: Post-separation validation and artifact assessment
Stage NE-5: Residual DF3 cleanup (conditional — only if noise floor > -55 dBFS)
Stage NE-6: AudioSR bandwidth extension
Stage NE-7: Post-separation enhancement EQ (separation-specific reference profile)
Stage 5:    Loudness Normalization (standard)
Stage 6:    True Peak Limiting (standard)
Stage 7:    Measurement + Processing Report (with separation pipeline additions)
```

**No compression or de-esser in the Noise Eraser path.** Separation output already has a compressed character; stacking compression risks over-processing. De-esser calibration is not validated for separated audio.

See `docs/instant_polish_processing_spec_noise_eraser.md` for full stage-by-stage specification.

### Key Stage Notes

**Stage 2 — Noise Reduction (standard presets only):**
- DeepFilterNet3 (neural network). Python `deepfilternet` / `libdf`.
- Adaptive tiers 1–5 based on measured noise floor. `acx_audiobook` and `voice_ready` cap at Tier 4 (12 dB max). `podcast_ready` caps at Tier 3.
- **Never force a pass.** If noise floor can't reach -60 dBFS without artifact risk, report failure. Do not over-process.
- Conservative defaults for ACX — overprocessing artifacts cause human review rejection.
- Noise floor enforcement only applies when `output_profile = acx`. For other profiles, reduction is applied for quality only.

**Stage 5 — Normalization:**
- `acx` output profile → unweighted RMS measurement (ACX measures RMS, not LUFS).
- `podcast` / `broadcast` output profiles → K-weighted integrated LUFS (EBU R128).
- Exclude silence frames from RMS measurement using dynamic threshold: `noise_floor + 6 dB`.
- For Noise Eraser: use post-NE-5 noise floor for silence exclusion threshold, not the original pre-processing noise floor.

**Stage 7 — Report (two independent systems):**

*System 1 — ACX Technical Certification:* Runs only when `output_profile = acx`. Six-point deterministic pass/fail: RMS, true peak, noise floor, sample rate, bit depth, channel format. Issues a binary certificate. The `acx_certification` key is **absent** (not null) from the JSON when `output_profile` is not `acx`.

*System 2 — Quality Advisory Flags:* Runs for all presets and all output profiles. Probabilistic observations the user should review before submitting. Flags have severity `info` or `review`. No aggregate risk score. Each flag includes a "Mark as reviewed" checkbox in the UI.

These two systems are independent. A file can be ACX certified and still have advisory flags. Advisory flags are never gates — the user can download at any point.

See `docs/instant_polish_compliance_model_v2.md` for full flag definitions, JSON structure, and UI model.

### Preset Character Distinctions (do not converge)

- **ACX Audiobook:** Transparent, natural. Minimal compression (conditional only, crest factor > 20 dB). Conservative noise reduction. Preserve dynamic breath of narration. ACX human reviewers expect an unprocessed character.
- **Podcast Ready:** Punchy, intimate, compressed. Always-on 3:1 compression. More aggressive EQ mud cut. LUFS target (not RMS). Stereo preserved for dual-host.
- **Voice Ready:** Broadcast-neutral. Always-on 2.5:1 compression. Versatile — sits under music beds. Mono output.
- **General Clean:** Pragmatic. More aggressive noise reduction acceptable (Tier 4, relaxed artifact warnings). 3:1 compression always-on.
- **Noise Eraser:** Voice extraction, not noise reduction. Prioritizes noise removal over voice transparency. Output may have a "dry booth" quality. Not recommended for ACX submission without careful review.

---

## ACX Certification and Quality Advisory — Key Rules

**ACX certification is the only formal certification standard.** Podcast and broadcast loudness targets are norms, not standards. Streaming platforms normalize on playback — there is no external body to certify against. Do not present pass/fail framing for `podcast` or `broadcast` output profiles.

**The tool certifies technical compliance. It does not certify ACX acceptance.** ACX also applies a human quality review. The quality advisory flag system addresses this separately.

**Advisory flags are not failures.** A technically certified file with advisory flags is valid and submittable. Flags inform the user's review decision — they do not gate the download or export.

Full specification: `docs/instant_polish_compliance_model_v2.md`.

---

## ACX-Specific Features

These apply only to the `acx_audiobook` preset:

- **Room tone padding:** Auto-detect and pad head (0.75 s) and tail (2 s) using actual room tone from the file's quietest silence segment. Not digital silence.
- **Batch processing (Creator tier gate):** Multi-phase — batch analysis → per-file processing → cross-chapter consistency pass. Consistency pass aligns RMS (< 1 dB deviation from batch median) and spectral centroid (< 15% deviation) across chapters. This is the **primary value prop for narrators**. A complete audiobook processed as a cohesive unit.
- **ACX compliance report:** Per-file six-point technical certification + quality advisory flags.
- **Plosive and breath detection:** Surfaces as quality advisory flags for manual review before ACX submission.

**The cross-chapter consistency problem is the highest-value unsolved pain in ACX narration.** Single-file tools don't address it. Instant Polish batch mode does.

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
| Voice Ready | MP3 128 kbps | WAV only (clients expect WAV) | WAV 16-bit 44.1 kHz mono |
| General Clean | MP3 128 kbps | MP3 256 kbps CBR | WAV 16-bit 44.1 kHz |
| Noise Eraser | MP3 128 kbps | MP3 256 kbps CBR | WAV 16-bit 44.1 kHz mono |

ACX MP3 must be strict CBR. Use LAME via FFmpeg with `-b:a 192k -abr 0`.

---

## Tech Stack

**Server-side:**

| Concern | Technology |
|---|---|
| Decode / encode / resample | FFmpeg |
| Noise reduction (preset chain + spot NR) | DeepFilterNet3 (`deepfilternet` / `libdf`) |
| Pre-separation noise reduction (Noise Eraser) | RNNoise (`pyrnnoise`) |
| Source separation (Noise Eraser) | Demucs `htdemucs_ft` (`demucs` Python package) |
| Bandwidth extension (Noise Eraser) | AudioSR (`audiosr` Python package) |
| Spectral analysis | Meyda.js |
| Enhancement EQ | FFmpeg `equalizer` filter (parametric biquad IIR) |
| Compression (preset chain) | Custom DSP |
| RMS / LUFS measurement | libebur128 (node-ebur128 bindings) |
| True peak limiting | FFmpeg `loudnorm` (two-pass, 192 kHz upsample) |
| MP3 encoding | LAME via FFmpeg |

**Client-side:**

| Concern | Technology |
|---|---|
| Normalize (spot) | Pure JS — peak scan + linear gain multiply |
| Compression (spot) | OfflineAudioContext + native DynamicsCompressorNode |
| Waveform rendering | Canvas 2D API, peak data from server |
| Playback | Web Audio API (`AudioBufferSourceNode`) |
| Segment editing | Pure JS — no audio data touched |
| Framework | Vanilla JS + Canvas (PoC); Vue 3 (production) |
| Export | Download blob from server response |

**Future commercial library evaluation (Sprint 6):** Krisp AI Voice SDK vs. DeepFilterNet3 on real narrator recordings.

---

## Processing Sprint Sequence

1. **Sprint 1** — Core pipeline (ACX Audiobook): FFmpeg decode + HPF + mono → DeepFilterNet3 → normalization + limiting → libebur128 → ACX certification → WAV/MP3 output
2. **Sprint 2** — Enhancement quality (ACX): Meyda.js EQ → silence exclusion → room tone padding → quality advisory flags (overprocessing, breath, plosive detection)
3. **Sprint 3** — De-esser + compression (ACX): F0 estimation → sibilance analysis → conditional de-esser → conditional compression
4. **Sprint 4** — Preset and output profile architecture: separate preset/output profile configs → Podcast Ready, Voice Ready, General Clean → LUFS normalization path → output profile selector in UI → output measurements reporting for non-ACX profiles
5. **Sprint 5** — Batch processing (ACX): batch analysis → per-file processing → consistency pass → batch report
6. **Sprint 6** — Commercial library evaluation: Krisp vs. DeepFilterNet3
7. **Sprint NE-1** — Noise Eraser core path: RNNoise pre-pass → Demucs separation → residual DF3 cleanup → Stage 5–7 → validate on high-noise test corpus
8. **Sprint NE-2** — Noise Eraser full pipeline: tonal pre-treatment → sibilance/breath assessment → AudioSR bandwidth extension → post-separation EQ → separation quality rating in report
9. **Sprint NE-3** — Noise Eraser benchmarking: test corpus across noise floor severity levels → calibrate NE-4 thresholds → validate AudioSR guidance scale → Demucs vs. Spleeter comparison

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

- **Never force a pass.** If a file cannot meet output profile targets without artifacts that would fail ACX human review, report the failure. Do not over-process.
- **Transparency first.** Same voice, cleaner and at the right level. Never a different voice.
- **Preset character, not preset uniformity.** ACX files should sound like ACX. Podcast files should sound like podcasts. Do not converge.
- **ACX human review is the real target**, not just the automated measurements. Six technical checks passing is necessary but not sufficient.
- **`acx_certification` is absent, not null,** in the JSON when `output_profile` is not `acx`. Do not include the key with a null value.
- **Advisory flags are never gates.** Users can download at any point regardless of flag state.
- **`outputStart` recalculation:** After any delete/trim/paste, recalculate from scratch for every segment. Do not attempt partial updates.
- **AudioContext on user gesture.** Never on page load.
- **Float32Array throughout.** Web Audio API uses [-1.0, 1.0] range.
- **Canvas pixel ratio.** Multiply canvas width/height by `devicePixelRatio` or waveforms are blurry on retina.

---

## Companion Documents

| Document | Purpose |
|---|---|
| `docs/instant_polish_processing_spec_v3.md` | Full processing chain technical specification. Authoritative source for all processing parameters, stage definitions, preset profiles, and output profile behavior. |
| `docs/instant_polish_compliance_model_v2.md` | ACX certification system, quality advisory flag definitions, report JSON structure, and UI model. Authoritative source for all compliance and reporting behavior. |
| `docs/instant_polish_processing_spec_noise_eraser.md` | Noise Eraser preset specification. Parallel processing path (NE-1 through NE-7). Read alongside v3 spec, not as a standalone. |
| `docs/acx_production_workflow.md` | ACX narrator workflow reference. Context for why features exist and where Instant Polish fits in the production chain. |
| `docs/instant_polish_gtm.md` | Go-to-market strategy. Positioning, pricing, launch plan, SEO content map. |

**When in doubt about processing parameters, EQ values, noise reduction tiers, or output profile behavior: the processing spec v3 is authoritative. When in doubt about compliance reporting or advisory flags: the compliance model v2 is authoritative.**