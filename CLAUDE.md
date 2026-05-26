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
| Compression | Client | Interactive parameter tweaking expects immediacy. OfflineAudioContext + DynamicsCompressorNode |
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
| `acx` | ACX Audiobook | -20 dBFS RMS | -3 dBFS | Unweighted RMS, voiced frames only |
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
- `normalize`: `acx` output profile → unweighted RMS; `podcast`/`broadcast` → K-weighted LUFS (EBU R128). Silence exclusion threshold: `noise_floor + 6 dB`.
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
- **Test infrastructure** — No unit, integration, or E2E tests
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
| `docs/acx_production_workflow.md` | ✗ Not present | ACX narrator workflow reference. Context for why features exist and where Instant Polish fits in the production chain. |
| `docs/instant_polish_gtm.md` | ✗ Not present | Go-to-market strategy. Positioning, pricing, launch plan, SEO content map. |

**When in doubt about processing parameters, EQ values, noise reduction tiers, or output profile behavior: the processing spec v3 is authoritative. When in doubt about compliance reporting or advisory flags: the compliance model v2 is authoritative.**