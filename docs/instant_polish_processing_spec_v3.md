# Instant Polish — Audio Processing Chain: Technical Specification
> Version 3.1 | April 2026
> Supersedes v3.0

---

## Overview

This document specifies the complete audio processing chain for Instant Polish. All processing runs server-side. The browser handles file upload, waveform visualization, playback of both the original and processed audio, and the processing report.

The processing chain is designed to serve multiple use cases through a **preset + output profile** architecture. A preset defines the character of the processing — the EQ curve, compression behavior, noise reduction aggressiveness, and target loudness. An output profile defines the loudness target, peak ceiling, and measurement method the chain tries to achieve. These are independent selections.

**Architecture note (v3.1):** Previous versions of this spec used the term "compliance target" for what is now called "output profile." The rename reflects a cleaner separation of concerns: an output profile drives processing decisions (normalization target, peak ceiling, measurement method). Compliance certification — checking the output against a formal external standard — is a separate post-processing step documented in the Compliance and Quality Review Model addendum. Output profiles and compliance certification are independent; not all output profiles have a corresponding formal certification standard.

---

## Architecture: Server-Side Processing, Browser Playback

All processing runs on the server. No audio processing runs in the browser.

**Request payload (browser → server):**
```json
{
  "file": "<uploaded audio>",
  "preset": "acx_audiobook",
  "output_profile": "acx"
}
```

**Response payload (server → browser):**
- Processed audio blob (WAV or MP3, depending on tier and preset)
- Processing report JSON (measurements, applied processing, output profile results, ACX certification if applicable)
- Waveform peak data JSON (~1000 data points for canvas rendering)

**Browser responsibilities after response:**
- Decode original upload and server response into two `AudioBuffer` objects
- Render before/after waveforms from peak data
- Enable toggle playback between original and processed
- Display processing report, output measurements, and ACX certification (if applicable)
- Enable download of the processed blob (no second server round-trip)

The audio the user hears in the browser is identical to the audio they download. There is no separate preview quality.

---

## Preset and Output Profile Architecture

### Presets

A preset is a named processing profile. It specifies:
- Preferred loudness character (used when no output profile overrides it)
- Compression character (ratio, threshold, attack/release)
- EQ reference profile (what "good" looks like for this use case)
- Noise reduction aggressiveness ceiling
- De-esser sensitivity
- Channel output (mono or stereo)
- Default output profile
- Whether noise floor reduction is enforced

Four presets ship at launch:

| Preset ID | Display name | Primary audience |
|---|---|---|
| `acx_audiobook` | ACX Audiobook | Audiobook narrators submitting to ACX/Audible |
| `podcast_ready` | Podcast Ready | Podcast hosts and interview recordings |
| `voice_ready` | Voice Ready | Voice actors, general voice-over |
| `general_clean` | General Clean | Everyone else; default for unspecified use |

Preset parameters are defined in full in the **Preset Profiles** section below.

### Output Profiles

An output profile defines the loudness target, peak ceiling, and measurement method that the processing chain tries to achieve. It governs Stage 5 (Loudness Normalization) and Stage 6 (True Peak Limiting).

Three output profiles are available:

| Profile ID | Display name | Normalization target | Peak ceiling | Measurement method |
|---|---|---|---|---|
| `acx` | ACX Audiobook | -20 dBFS RMS | -3 dBFS | Unweighted RMS, voiced frames only |
| `podcast` | Podcast / Streaming | -16 LUFS integrated | -1 dBFS | K-weighted LUFS (EBU R128) |
| `broadcast` | Broadcast | -23 LUFS integrated | -1 dBFS | K-weighted LUFS (EBU R128) |

Output profiles are loudness targets, not compliance standards. The `acx` profile targets the center of ACX's loudness window and uses unweighted RMS measurement because that is how ACX measures. The `podcast` and `broadcast` profiles target streaming platform norms and use LUFS measurement because that is how those platforms measure. No formal external certification is implied by selecting `podcast` or `broadcast` — see the Compliance and Quality Review Model addendum for the distinction between output profiles and compliance certification.

### Default Profile Pairings

Each preset has a natural default output profile, applied automatically unless overridden:

| Preset | Default output profile |
|---|---|
| `acx_audiobook` | `acx` |
| `podcast_ready` | `podcast` |
| `voice_ready` | `acx` |
| `general_clean` | `podcast` |

The user can override the output profile for any preset. The most common override: a narrator who prefers the processing character of `voice_ready` but needs their files to target ACX loudness levels.

### How Preset and Output Profile Interact

The preset governs everything that happens in Stages 1–4a (the actual sound processing). The output profile governs Stage 5 (normalization target and measurement method) and Stage 6 (peak ceiling).

The normalization target is the one parameter shared between preset and output profile. The preset defines a preferred loudness character; the output profile can override it to hit a specific target. When the two differ, the output profile wins.

Example: `podcast_ready` prefers -16 LUFS. If the user selects the `acx` output profile, the normalization target overrides to -20 dBFS RMS and unweighted RMS measurement is used. The file gets podcast-style processing at ACX loudness levels.

### Compliance Certification

Compliance certification is a separate post-processing step that checks the output against a formal external standard with published requirements. It is not part of the output profile. Currently, one formal certification standard is supported:

**ACX certification** — runs automatically when `output_profile = acx`. Checks RMS, true peak, noise floor, sample rate, bit depth, and channel format against ACX's published requirements. Issues a binary pass/fail certificate. Full specification in the Compliance and Quality Review Model addendum.

For `podcast` and `broadcast` output profiles, no formal certification runs. Stage 7 reports output measurements (LUFS, true peak) as informational values. There is no external standard to certify against — streaming platforms normalize on playback rather than rejecting non-compliant files.

---

## Preset Profiles

Each preset is defined by the parameter values it passes to each processing stage. Stages that exist in the chain but receive no special instruction from a preset use the defaults specified in the Processing Chain section.

---

### Preset: ACX Audiobook (`acx_audiobook`)

**Use case:** Audiobook narrators preparing chapter files for ACX/Audible submission. Files are clean, fully edited WAV recordings. The goal is broadcast-quality narration that passes both ACX's automated measurements and its human quality review. Transparency and naturalness take priority over loudness or punch.

**Character:** Clean, present, natural. Minimal compression — preserves the dynamic breath of a good narration performance. Conservative noise reduction to avoid artifacts. Presence-focused EQ to improve intelligibility without brightness.

| Parameter | Value | Rationale |
|---|---|---|
| Target loudness | -20 dBFS RMS | Center of ACX window (-23 to -18 dBFS) |
| True peak ceiling | -3 dBFS | ACX requirement |
| Noise floor target | -60 dBFS | ACX requirement; enforced |
| Noise reduction ceiling | Tier 4 (12 dB max) | Conservative — artifact risk outweighs noise floor benefit above this |
| Compression | Conditional only (crest factor > 20 dB) | Preserve natural dynamics; compress only when necessary |
| Compression ratio | 2:1 | Gentle; speech-optimized |
| EQ reference profile | ACX narration reference | Presence-forward, minimal warmth boost, conservative air |
| De-esser sensitivity | Standard (P95 > mean + 8 dB trigger) | Conditional; audiobook narration requires full intelligibility |
| De-esser max reduction | 6 dB | |
| Channel output | Mono | ACX requirement |
| Default output profile | `acx` | |

**ACX-specific processing:**
- Room tone padding enabled (see Room Tone Padding section)
- Plosive detection enabled
- Breath detection enabled
- ACX certification runs automatically when output profile is `acx`
- Batch cross-chapter consistency pass available

---

### Preset: Podcast Ready (`podcast_ready`)

**Use case:** Podcast hosts, co-hosted shows, and interview recordings. Source material may include multiple speakers in a single file, recordings from different microphones and environments, and remote guests. The goal is a consistent, listenable output that meets streaming platform loudness standards.

**Character:** Punchy, intimate, consistent. More compression than ACX Audiobook to even out the dynamics of conversational speech and create the "close and present" sound that podcast listeners expect. EQ tuned for intelligibility on earbuds and phone speakers. Stereo output preserved for dual-host shows.

| Parameter | Value | Rationale |
|---|---|---|
| Target loudness | -16 LUFS integrated | Spotify, Apple Podcasts, and most streaming platforms normalize to -14 to -16 LUFS |
| True peak ceiling | -1 dBFS | Streaming standard |
| Noise floor target | Not enforced | Podcasts are not subject to a noise floor gate; reduction applied for quality only |
| Noise reduction ceiling | Tier 3 (8 dB max) | More aggressive than ACX default acceptable; noise floor compliance is not the constraint |
| Compression | Always applied | Conversational speech has high dynamic range; compression is essential for listenable podcasts |
| Compression ratio | 3:1 | More assertive than ACX; creates the "tight" podcast character |
| Compression threshold | -20 dBFS | |
| Compression attack | 5 ms | Faster than ACX — catches conversational transients |
| Compression release | 80 ms | |
| EQ reference profile | Podcast reference | Presence boost at 3–4 kHz, more assertive mud cut, slight warmth cut for clarity on small speakers |
| De-esser sensitivity | Higher sensitivity (P95 > mean + 6 dB trigger) | Podcast listeners on earbuds are particularly sensitive to sibilance |
| De-esser max reduction | 6 dB | |
| Channel output | Preserve original (stereo or mono) | Dual-host podcasts are stereo; solo podcasts may be mono |
| Default output profile | `podcast` | |

**Podcast-specific notes:**
- LUFS measurement (integrated loudness, K-weighted) is used instead of unweighted RMS for the normalization target
- Room tone padding not applied
- No formal compliance certification available for this output profile; Stage 7 reports LUFS and true peak as informational measurements only

---

### Preset: Voice Ready (`voice_ready`)

**Use case:** Voice actors recording commercial copy, explainer videos, corporate narration, e-learning, and general voice-over work. Unlike ACX Audiobook, there is no single platform standard — the output needs to sound professional and versatile across different downstream contexts.

**Character:** Clean, broadcast-quality, neutral. Sits between ACX Audiobook (very transparent, minimal processing) and Podcast Ready (punchy, compressed). Enough presence to cut through a mix but not so bright it clashes with music beds.

| Parameter | Value | Rationale |
|---|---|---|
| Target loudness | -20 dBFS RMS | Broadcast-neutral; compatible with ACX and most video/multimedia workflows |
| True peak ceiling | -3 dBFS | Leaves headroom for downstream mixing |
| Noise floor target | Not enforced by default | No platform-specific noise floor requirement |
| Noise reduction ceiling | Tier 3 (8 dB max) | |
| Compression | Always applied | Commercial voice-over requires consistent level |
| Compression ratio | 2.5:1 | More than ACX Audiobook, less than Podcast Ready |
| Compression threshold | -22 dBFS | |
| Compression attack | 8 ms | |
| Compression release | 90 ms | |
| EQ reference profile | Voice-over reference | Presence-forward, mild warmth cut, conservative air boost for studio character |
| De-esser sensitivity | Standard (P95 > mean + 8 dB trigger) | |
| De-esser max reduction | 5 dB | |
| Channel output | Mono | Most voice-over deliverables are mono |
| Default output profile | `acx` | ACX targets are conservative and appropriate for most voice-over deliverables |

**Voice Ready notes:**
- No room tone padding
- No chapter batch processing
- The -3 dBFS peak ceiling and -20 dBFS loudness target make this preset naturally ACX-certifiable when `acx` output profile is selected, without additional processing
- ACX certification runs when output profile is `acx`

---

### Preset: General Clean (`general_clean`)

**Use case:** Everything else — meeting recordings, lecture captures, field recordings, dictation, demo submissions, informal audio. The user has a file that sounds bad and wants it to sound better. No platform-specific requirements.

**Character:** Pragmatic. More aggressive noise reduction than other presets. Balanced EQ with no strong character. Moderate compression for consistency.

| Parameter | Value | Rationale |
|---|---|---|
| Target loudness | -16 LUFS integrated | Good general-purpose listening level |
| True peak ceiling | -1 dBFS | |
| Noise floor target | Not enforced | |
| Noise reduction ceiling | Tier 4 (12 dB max), artifact risk warnings relaxed | General clean users have lower quality source material |
| Compression | Always applied | Inconsistent recording conditions make compression essential |
| Compression ratio | 3:1 | |
| Compression threshold | -20 dBFS | |
| Compression attack | 8 ms | |
| Compression release | 80 ms | |
| EQ reference profile | General reference | Balanced; mud cut + mild presence boost; no strong character |
| De-esser sensitivity | Higher sensitivity (P95 > mean + 6 dB trigger) | |
| De-esser max reduction | 8 dB | |
| Channel output | Preserve original | No channel requirement |
| Default output profile | `podcast` | |

**General Clean notes:**
- Default preset when no preset is specified
- No room tone padding, no batch processing
- Artifact risk warnings are relaxed
- No formal compliance certification available; Stage 7 reports measurements as informational only

---

## Accepted Input Formats

All decoding is handled by FFmpeg on the server. Any format FFmpeg supports can be accepted. The practical set users bring:

| Format | Notes |
|---|---|
| WAV (16-bit or 24-bit, any sample rate, mono or stereo) | Primary format. Lossless. |
| MP3 (any bitrate, any sample rate, mono or stereo) | Already lossy — decode to PCM before processing. |
| FLAC (16-bit or 24-bit, any sample rate, mono or stereo) | Lossless. Treat identically to WAV. |
| AIFF | Accepted. Decode to PCM. |
| M4A / AAC | Accepted. Decode to PCM. Already lossy. |

**All internal processing uses 32-bit float PCM at 44.1 kHz.** The first step for every file is: decode → resample to 44.1 kHz (if needed) → convert to 32-bit float.

---

## Pre-Processing: Input Normalization

Before the processing chain runs, normalize the input to a consistent internal format.

**Step 1 — Decode**
FFmpeg decodes the input to raw 32-bit float PCM.

**Step 2 — Resample (if needed)**
If input sample rate ≠ 44.1 kHz, resample using FFmpeg's `swr` resampler with high-quality sinc interpolation. Log original sample rate in processing report.

**Step 3 — Channel handling**
Behavior depends on the preset's channel output setting:
- If preset requires **mono** and input is stereo: apply mid-channel mix-down (`mono = (left + right) / 2`). Log conversion in processing report.
- If preset **preserves original** channel count: pass through without conversion.
- If input is already mono: no action regardless of preset.

**Step 4 — Initial analysis**
Before any processing, measure and record:
- Noise floor (from lowest-energy 2 seconds)
- RMS of full file
- True peak
- Fundamental frequency estimate (for de-esser calibration)
- Spectral envelope of voiced speech segments (for EQ calibration)

These are the "before" values in the processing report.

---

## Processing Chain

```
Stage 1:  High-Pass Filter
Stage 2:  Adaptive Noise Reduction
Stage 3:  Enhancement EQ
Stage 4:  De-esser (conditional)
Stage 4a: Compression (conditional or always-on, per preset)
Stage 5:  Loudness Normalization        ← output profile governs target and method
Stage 6:  True Peak Limiting            ← output profile governs ceiling
Stage 7:  Measurement + Processing Report
```

---

### Stage 1 — High-Pass Filter

**Purpose:** Remove sub-vocal low-frequency energy before any level processing.

**Implementation:** FFmpeg `highpass` filter.

**Specification (all presets):**
- Filter type: Butterworth high-pass, 4th order (-24 dB/octave)
- Cutoff frequency: 80 Hz
- Apply to the full file

**Supplementary: 60 Hz notch filter (conditional, all presets)**
If a tonal spike at 50 or 60 Hz is > 6 dB above surrounding noise floor: apply narrow notch (Q = 10, -20 dB attenuation).

---

### Stage 2 — Adaptive Noise Reduction

**Purpose:** Reduce background noise to improve listening quality and, where the active output profile targets ACX, bring the noise floor to -60 dBFS.

**Implementation:** DeepFilterNet3. Python `deepfilternet` package or Rust `libdf` bindings, server-side.

#### 2a — Pre-Reduction Analysis

**Silence detection:** 100 ms frames. Silence when RMS < `(noise_floor_estimate + 6 dB)`.

**Noise floor measurement:** Average RMS of all silence frames.

**SNR calculation:** `SNR = average_voiced_RMS − measured_noise_floor`

**Noise character classification:** Broadband stationary / Tonal-hum / Non-stationary / Mixed.

#### 2b — Adaptive Reduction Tiers

| Tier | Measured noise floor | Approach |
|---|---|---|
| 1 — Clean | ≤ -60 dBFS | Skip. Log "Noise floor compliant — no reduction applied." |
| 2 — Light | -55 to -60 dBFS | Light DF3 pass. Low artifact risk. |
| 3 — Standard | -50 to -55 dBFS | Standard DF3 pass. Post-reduction artifact check. |
| 4 — Heavy | -45 to -50 dBFS | Maximum safe reduction. Artifact check. Warn user. |
| 5 — At risk | Above -45 dBFS | Apply max safe reduction. Report failure. Do not force further. |

`acx_audiobook` and `voice_ready` cap at Tier 4. `podcast_ready` caps at Tier 3. `general_clean` allows Tier 4 with relaxed artifact warnings.

**Noise floor enforcement:** Only applied when `output_profile = acx`. For other output profiles, noise reduction is applied for quality — the goal is perceptual improvement, not hitting a measurement threshold.

**Tier 5 messaging (acx output profile):** "Background noise is too high to process cleanly. Measured noise floor: [X] dBFS. Consider re-recording in a quieter environment."

**Tier 5 messaging (other output profiles):** "Background noise level is high. Some reduction has been applied, but residual noise remains audible."

#### 2c — Post-Reduction Validation

After DF3 processing:
1. Re-measure noise floor. If `output_profile = acx` and target not met: report failure; do not re-run.
2. Artifact check: compare spectral flatness of voiced speech before and after. Significant decrease → log quality advisory flag.

---

### Stage 3 — Enhancement EQ

**Purpose:** Improve tonal quality for the target use case. Runs after noise reduction, before normalization.

**Implementation:** FFmpeg `equalizer` filter, parametric biquad IIR.

#### 3a — Spectral Analysis

Analyze spectral envelope of voiced speech using Meyda.js. Compute average energy in diagnostic bands and compare to preset's EQ reference profile.

#### 3b — EQ Reference Profiles

**ACX narration reference:** Presence-forward, conservative air, minimal warmth alteration.
- Mud cut: trigger > 3 dB above reference, -2 to -4 dB, Q = 2–3
- Clarity cut: -1 to -2 dB at 400–600 Hz
- Presence boost: trigger > 2 dB below reference, +2 to +3 dB at ~4 kHz, Q = 1.5
- Warmth boost: conditional only
- Air boost: conservative, +1 to +1.5 dB shelf at 10 kHz

**Podcast reference:** Assertive mud cut, presence pushed for conversational crispness.
- Mud cut: trigger > 2 dB above reference, -3 to -5 dB, Q = 2
- Warmth cut: gentle -1 to -2 dB at 150–200 Hz
- Presence boost: +2 to +4 dB at ~3.5 kHz, Q = 1.5
- Air boost: +1 to +2 dB shelf at 10 kHz

**Voice-over reference:** Neutral character, mild presence boost, no strong tonal opinion.
- Mud cut: -2 to -3 dB, Q = 2
- Presence boost: +2 to +3 dB at ~4 kHz, Q = 1.5
- Air boost: +1 to +1.5 dB shelf, conservative trigger

**General reference:** Balanced, no strong character, widest range of source material.
- Mud cut: -2 to -4 dB, Q = 2
- Presence boost: +2 to +3 dB at ~4 kHz, Q = 1.5
- Warmth: ±2 dB as needed
- Air boost: conservative

#### 3c — Noise Floor Constraint (acx output profile only)

When `output_profile = acx`: after presence boost, re-check noise floor. If boost has raised noise floor above -60 dBFS, reduce boost by 1 dB increments until compliant, or skip.

#### 3d — Maximum EQ Gain Constraint (all presets)

No single band adjustment exceeds ±5 dB.

---

### Stage 4 — De-esser (Conditional)

**Purpose:** Reduce harsh sibilant energy.

**Implementation:** Custom DSP — Meyda.js spectral analysis driving a frequency-selective compressor.

**Trigger:** Standard (ACX Audiobook, Voice Ready): P95 > mean + 8 dB. Higher sensitivity (Podcast Ready, General Clean): P95 > mean + 6 dB. Skip if trigger not met.

#### 4a — Sibilance Analysis

F0 estimation → sibilant band identification → fricative event detection → target frequency from P95 fricative spectral centroid.

#### 4b — De-esser Parameters

| Parameter | ACX Audiobook | Podcast Ready | Voice Ready | General Clean |
|---|---|---|---|---|
| Trigger | P95 > mean + 8 dB | P95 > mean + 6 dB | P95 > mean + 8 dB | P95 > mean + 6 dB |
| Threshold | mean + 4 dB | mean + 3 dB | mean + 4 dB | mean + 3 dB |
| Max reduction | 6 dB | 6 dB | 5 dB | 8 dB |
| Attack | 1–2 ms | 1–2 ms | 1–2 ms | 1–2 ms |
| Release | 40–60 ms | 40–60 ms | 40–60 ms | 40–60 ms |

---

### Stage 4a — Compression

**Purpose:** Reduce dynamic range to achieve the consistency appropriate to the target use case.

| Preset | Applied | When |
|---|---|---|
| ACX Audiobook | Conditionally | Only when crest factor > 20 dB |
| Podcast Ready | Always | |
| Voice Ready | Always | |
| General Clean | Always | |

**Parameters by preset:**

| Parameter | ACX Audiobook | Podcast Ready | Voice Ready | General Clean |
|---|---|---|---|---|
| Threshold | -24 dBFS | -20 dBFS | -22 dBFS | -20 dBFS |
| Ratio | 2:1 | 3:1 | 2.5:1 | 3:1 |
| Attack | 10 ms | 5 ms | 8 ms | 8 ms |
| Release | 100 ms | 80 ms | 90 ms | 80 ms |
| Knee | Soft, 4 dB | Soft, 4 dB | Soft, 4 dB | Soft, 4 dB |
| Makeup gain | 0 dB | 0 dB | 0 dB | 0 dB |

---

### Stage 4a-E — Frequency-Selective Vocal Expander

**Purpose:** Dynamically attenuate residual low-level noise (room tone, HVAC, mic handling, floor rumble) that compression elevates in the silence gaps between words. Runs after Stage 4a-PC (parallel compression) and before Stage 4b (Auto Leveler). Not a gate and not a replacement for Stage 2 noise reduction — a soft-ratio, band-weighted expander calibrated from the file's measured silence-energy distribution.

**Applied:** All three pipelines (`STANDARD_PIPELINE`, `noise_eraser`, `clearervoice_eraser`), enabled by default. Skipped when the post-compression silence P90 RMS is already below -72 dBFS.

**Architecture (two-path):**

- **Detection path:** 80–800 Hz bandpass (HP80 + LP800 biquad cascade, Q=0.707) → 10 ms frame RMS → soft-ratio gain reduction with 10 ms lookahead, 10 ms attack, 20 ms hold, preset-specific release.
- **Attenuation path:** Static 800 Hz low-pass splits the input signal into low-band and high-band. Below 800 Hz receives full gain reduction; above 800 Hz receives softened gain reduction scaled by `highFreqDepth`. The softening preserves consonant clarity.

**Threshold calibration (per-file):**

1. Snapshot `silenceP90PreDb` = P90 of silence-frame RMS from the post-NR metrics (pre-compression).
2. Re-measure silence-frame RMS on the compressed signal → `silenceP90PostDb`.
3. `thresholdDb = max(silenceP90PostDb + headroomOffsetDb, -70)`.

**Gain-reduction curve:**

For each 10 ms detection frame with RMS `rmsDb`:

```
if rmsDb >= thresholdDb:
    targetGrDb = 0
else:
    targetGrDb = -min((thresholdDb - rmsDb) × (1 - 1/ratio), maxAttenuationDb)
```

Smoothed per-sample with exponential attack/release. The lookahead buffer lets gain begin releasing before voiced energy arrives.

**Band-weighted attenuation:**

```
gainLowLin  = 10^(grDb / 20)                         // full-depth in detection band
gainHighLin = 10^(grDb × highFreqDepth / 20)         // softened above 800 Hz
y[i] = low[i] × gainLowLin[i] + (x[i] - low[i]) × gainHighLin[i]
```

This is equivalent to the spec form `softened_ratio = 1 + (ratio - 1) × high_freq_depth`; the gain-dB-scaling form above is numerically identical and computationally simpler.

**Parameters by preset:**

| Parameter | ACX Audiobook | Podcast Ready | Voice Ready | General Clean | Noise Eraser | ClearerVoice Eraser |
|---|---|---|---|---|---|---|
| Enabled | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ratio | 1.5:1 | 2.0:1 | 1.5:1 | 2.0:1 | 2.0:1 | 2.0:1 |
| Headroom offset | +4 dB | +6 dB | +4 dB | +6 dB | +6 dB | +6 dB |
| High-freq depth | 0.25 | 0.5 | 0.25 | 0.5 | 0.5 | 0.5 |
| Release | 200 ms | 150 ms | 200 ms | 150 ms | 150 ms | 150 ms |
| Attack | 10 ms | 10 ms | 10 ms | 10 ms | 10 ms | 10 ms |
| Hold | 20 ms | 20 ms | 20 ms | 20 ms | 20 ms | 20 ms |
| Lookahead | 10 ms | 10 ms | 10 ms | 10 ms | 10 ms | 10 ms |
| Max attenuation | 12 dB | 18 dB | 12 dB | 18 dB | 18 dB | 18 dB |
| Detection band | 80–800 Hz | 80–800 Hz | 80–800 Hz | 80–800 Hz | 80–800 Hz | 80–800 Hz |

**Implementation note:** The spec originally suggested FFmpeg `volume` + `equalizer` filters, but time-varying per-sample gain with lookahead/hold/release cannot be expressed in FFmpeg filter graphs. Implementation uses the custom-JS DSP pattern already established by `compression.js`, `autoLeveler.js`, and `parallelCompression.js` — read WAV via `readWavAllChannels()`, build sample-level gain curve, write WAV via `writeWavChannels()`.

**Report output shape (Stage 7):**

```json
"vocal_expander": {
  "applied": true,
  "skipped_reason": null,
  "calibration": {
    "silence_p90_pre_compression_dbfs":  -58.2,
    "silence_p90_post_compression_dbfs": -51.0,
    "threshold_dbfs":                    -45.0,
    "headroom_offset_db":                6
  },
  "parameters": {
    "ratio":              2.0,
    "high_freq_depth":    0.5,
    "release_ms":         150,
    "max_attenuation_db": 18
  },
  "result": {
    "avg_attenuation_silence_db": -8.3,
    "max_attenuation_db":         -14.1,
    "pct_frames_expanded":        22.4,
    "over_expansion_flag":        false
  }
}
```

When skipped: `{ "applied": false, "skipped_reason": "silence_floor_already_below_-72_dbfs" }` or similar reason string.

**Advisory flag:** Emits `over_expansion` (severity `review`) when `pct_frames_expanded > 35` OR any VAD-voiced frame received more than 3 dB of attenuation.

---

### Stage 5 — Loudness Normalization

**Purpose:** Bring average loudness to the target level.

**Implementation:** libebur128 (node-ebur128 bindings); FFmpeg `loudnorm` filter (two-pass) or linear gain for adjustment.

#### 5a — Normalization Target

The normalization target and measurement method are set by the **output profile**:

| Output profile | Normalization target | Measurement method |
|---|---|---|
| `acx` | -20 dBFS RMS | Unweighted RMS, voiced frames only |
| `podcast` | -16 LUFS integrated | K-weighted integrated loudness (EBU R128) |
| `broadcast` | -23 LUFS integrated | K-weighted integrated loudness (EBU R128) |

**Why unweighted RMS for ACX:** ACX measures unweighted RMS. Using LUFS for ACX output would create a systematic measurement mismatch with what ACX's own tools report.

**Why LUFS for podcast/broadcast:** Streaming platforms normalize by LUFS. Using LUFS ensures files behave correctly in downstream platform normalization.

#### 5b — Silence Exclusion

For RMS measurement: exclude silence frames using `silence_threshold = measured_noise_floor + 6 dB`.

For LUFS measurement: EBU R128 gating handles silence exclusion natively.

#### 5c — Gain Calculation and Application

```
For RMS:  gain_dB = target_RMS_dBFS − measured_RMS_dBFS
For LUFS: gain_dB = target_LUFS − measured_LUFS
```

Apply as a single linear gain to the entire file.

**Edge case:** If `gain_dB > +18 dB`, log warning: "Recording level is very low. Consider re-recording with higher input gain."

---

### Stage 6 — True Peak Limiting

**Purpose:** Prevent inter-sample peaks from exceeding the output profile's peak ceiling.

**Implementation:** FFmpeg `loudnorm`, two-pass mode. Upsamples to 192 kHz for true peak detection.

**Peak ceiling by output profile:**

| Output profile | True peak ceiling |
|---|---|
| `acx` | -3 dBFS |
| `podcast` | -1 dBFS |
| `broadcast` | -1 dBFS |

---

### Stage 7 — Measurement and Processing Report

**Purpose:** Measure the processed file, run ACX certification if applicable, assess quality advisory flags, and generate the report returned to the browser.

#### 7a — Output Measurements (all presets, all output profiles)

Always reported as informational values regardless of output profile:

| Measurement | Method |
|---|---|
| RMS (unweighted) | libebur128, voiced frames only |
| LUFS integrated | libebur128, K-weighted |
| True peak | FFmpeg loudnorm, 192 kHz upsample |
| Noise floor | Energy threshold, silence frames |

#### 7b — ACX Certification (acx output profile only)

When `output_profile = acx`, run the full ACX certification as specified in the Compliance and Quality Review Model addendum. Issues a binary pass/fail certificate covering six checks: RMS, true peak, noise floor, sample rate, bit depth, channel format.

For `podcast` and `broadcast` output profiles: ACX certification does not run. No pass/fail is reported. Output measurements are shown without a compliance framing.

#### 7c — Quality Advisory Flags (all presets, all output profiles)

Quality advisory flags run regardless of output profile. Full flag definitions in the Compliance and Quality Review Model addendum.

#### 7d — Processing Report JSON Structure

```json
{
  "file": "chapter_01.wav",
  "preset": "acx_audiobook",
  "output_profile": "acx",
  "duration_seconds": 1247,
  "processing_applied": {
    "stereo_to_mono": false,
    "resampled_from": null,
    "hpf_60hz_notch": false,
    "noise_reduction": {
      "applied": true,
      "tier": 3,
      "model": "DeepFilterNet3",
      "pre_noise_floor_dbfs": -53.2,
      "post_noise_floor_dbfs": -62.1
    },
    "enhancement_eq": {
      "profile": "acx_narration",
      "mud_cut": { "applied": true, "freq_hz": 285, "gain_db": -3.0 },
      "warmth_boost": { "applied": false },
      "clarity_cut": { "applied": true, "freq_hz": 520, "gain_db": -1.5 },
      "presence_boost": { "applied": true, "freq_hz": 4000, "gain_db": 2.5 },
      "air_boost": { "applied": false }
    },
    "de_esser": {
      "applied": true,
      "target_freq_hz": 6200,
      "max_reduction_db": 4.0
    },
    "compression": { "applied": false },
    "normalization_gain_db": 6.4,
    "limiting_max_reduction_db": 0.8
  },
  "measurements": {
    "before": {
      "rms_dbfs": -26.4,
      "true_peak_dbfs": -4.1,
      "noise_floor_dbfs": -53.2,
      "lufs_integrated": -28.1
    },
    "after": {
      "rms_dbfs": -19.8,
      "true_peak_dbfs": -3.0,
      "noise_floor_dbfs": -62.1,
      "lufs_integrated": -21.4
    }
  },
  "acx_certification": {
    "certificate": "pass",
    "checks": {
      "rms": { "value_dbfs": -19.8, "min": -23, "max": -18, "pass": true },
      "true_peak": { "value_dbfs": -3.0, "ceiling": -3, "pass": true },
      "noise_floor": { "value_dbfs": -62.1, "ceiling": -60, "pass": true },
      "sample_rate": { "value_hz": 44100, "required": 44100, "pass": true },
      "bit_depth": { "value": "16-bit PCM", "required": "16-bit PCM", "pass": true },
      "channel": { "value": "mono", "required": "mono", "pass": true }
    }
  },
  "quality_advisory": {
    "flags": [],
    "review_recommended": false
  }
}
```

**When `output_profile` is `podcast` or `broadcast`:** The `acx_certification` key is absent from the JSON entirely — not null, absent. The `measurements.after` object is present and always populated.

---

## Output Format Specification

**Internal processed file (not delivered):** WAV, 32-bit float, 44.1 kHz.

**Free tier delivery (all presets):** MP3, 128 kbps CBR, 44.1 kHz.

**Creator tier delivery — WAV:** WAV, 16-bit PCM, 44.1 kHz, channel count per preset.

**Creator tier delivery — preset-specific encoded format:**

| Preset | Encoded format | Specification |
|---|---|---|
| ACX Audiobook | MP3 192 kbps CBR | LAME via FFmpeg, `-b:a 192k -abr 0`. ACX requires strict CBR. |
| Podcast Ready | MP3 320 kbps CBR | |
| Voice Ready | WAV only | Voice-over deliverables are typically WAV |
| General Clean | MP3 256 kbps CBR | |

---

## Room Tone Padding (ACX Audiobook only)

ACX requires 0.5–1 second of room tone at the head and 1–5 seconds at the tail of each file.

**Detection:** Measure duration of near-silence (frames ≤ noise floor + 3 dB) at head and tail.

**Correction:**
- Head room tone < 0.5 s → prepend to reach 0.75 s
- Tail room tone < 1 s → append to reach 2 s
- Source: 500 ms sample from the lowest-energy silence segment identified in Stage 2a

Room tone padding is skipped for all other presets.

---

## Batch Processing (ACX Audiobook only)

**Phase 1 — Batch analysis:** Analyze all files before processing any. Compute batch-wide medians for noise floor, RMS, and spectral centroid. Flag outliers.

**Phase 2 — Individual processing:** Process each file through the full chain independently.

**Phase 3 — Consistency pass:**
- RMS consistency: files deviating > 1 dB from batch median receive a linear trim
- Tonal consistency: files with spectral centroid > 15% from batch median receive 1–2 dB corrective EQ
- Flag files requiring > 1.5 dB tonal correction in batch report

**Batch report:** One row per file (filename, duration, RMS, true peak, noise floor, ACX certification pass/fail, quality advisory flags, warnings) plus a summary row.

---

## UI Requirements

**Preset selector:** Four options at launch. Default: General Clean.

**Output profile selector:** Secondary control, below or adjacent to preset selector. Default pre-filled from preset. For the ACX Audiobook preset, the output profile selector should be hidden or locked to `acx` — there is no meaningful reason to process an audiobook chapter without targeting ACX levels.

**Output profile override indicator:** When a user selects a non-default output profile for a preset, surface a brief note. Example: "Using ACX output levels with Podcast Ready preset. Output will target -20 dBFS RMS (not -16 LUFS)."

**Processing report display:**
- Output measurements: always shown, all presets, all output profiles
- ACX certification: shown as primary result when `output_profile = acx`; absent for other output profiles
- Quality advisory flags: shown as secondary section for all presets and output profiles
- "Before you submit" section with per-flag "Mark as reviewed" checkboxes: shown when `review_recommended = true`

For `podcast` and `broadcast` output profiles, the report section is titled **"Output Measurements"** and shows LUFS and true peak values without pass/fail framing.

---

## Processing Quality Constraints

**Transparency first.** The goal is the same voice, cleaner and at the right level. Never a different voice.

**Preset character, not preset uniformity.** Each preset has a distinct character. Do not converge all presets toward the same sound.

**Never force a pass.** If a file cannot meet the active output profile targets without artifact levels that would sound unnatural, report the failure honestly.

**Human review is the real target (ACX Audiobook).** For ACX files, the six technical checks are necessary but not sufficient. Every processing decision should be evaluated against: "Would an ACX human reviewer flag this?"

---

## Library Reference

| Stage | Library / Tool | License | Cost |
|---|---|---|---|
| Decode / encode / resample / convert | FFmpeg (system binary) | LGPL | Free |
| High-pass filter | FFmpeg `highpass` filter | LGPL | Free |
| 60 Hz notch filter | FFmpeg `equalizer` filter | LGPL | Free |
| Noise reduction | DeepFilterNet3 (`deepfilternet` or `libdf`) | MIT | Free |
| Noise reduction (future upgrade) | Krisp AI Voice SDK | Commercial | Custom |
| Spectral analysis (EQ + de-esser) | Meyda.js (server-side) | MIT | Free |
| Enhancement EQ | FFmpeg `equalizer` filter | LGPL | Free |
| De-esser | Custom DSP (Meyda.js + frequency-selective compressor) | — | Free |
| Compression | Custom DSP | — | Free |
| RMS / LUFS measurement | libebur128 via node-ebur128 | MIT | Free |
| True peak limiting | FFmpeg `loudnorm` (two-pass, 192 kHz upsample) | LGPL | Free |
| Noise floor measurement | Custom energy-thresholding | — | Free |
| Waveform data generation | Custom peak extraction | — | Free |
| MP3 encoding | LAME via FFmpeg | LGPL + LAME | Free |

---

## Processing Time Targets

| Workload | Target |
|---|---|
| Single file, 20 min WAV | ≤ 45 seconds |
| Single file, 10 min WAV | ≤ 25 seconds |
| Batch of 25 chapters (ACX) | ≤ 15 minutes (parallel) |

---

## Implementation Sprint Sequence

**Sprint 1 — Core pipeline (ACX Audiobook):**
FFmpeg decode + HPF + mono conversion → DeepFilterNet3 → FFmpeg normalization + limiting → libebur128 measurement → ACX certification → WAV/MP3 output → return to browser

**Sprint 2 — Enhancement quality (ACX Audiobook):**
Meyda.js spectral analysis → adaptive enhancement EQ → dynamic silence exclusion → room tone padding → quality advisory flags (overprocessing, breath, plosive detection)

**Sprint 3 — De-esser and compression (ACX Audiobook):**
F0 estimation → sibilance analysis → conditional de-esser → conditional compression → report logging

**Sprint 4 — Preset and output profile architecture:**
Separate preset config from output profile config → implement Podcast Ready, Voice Ready, General Clean presets → LUFS normalization path → output profile selector in UI → preset-specific EQ reference profiles → output profile override indicator → output measurements reporting for non-ACX profiles

**Sprint 5 — Batch processing (ACX Audiobook):**
Batch analysis phase → per-file processing → consistency pass → batch report

**Sprint 6 — Commercial library evaluation:**
Krisp SDK evaluation on real narrator recordings vs. DeepFilterNet3 → commercial licensing decision

---

## AI Enhancement Roadmap

Two stages are identified as candidates for AI-driven parameter selection in a future version:

**Enhancement EQ Calibration (Stage 3):** A model trained on matched before/after pairs (raw narration → professionally mastered output) could predict optimal EQ parameters directly from input acoustic features.

**De-esser Frequency Targeting (Stage 4):** A regression model taking the spectral profile of detected fricative events as input and predicting the problematic sibilant center frequency directly would outperform the current lookup-table approach.

Both improvements are post-launch. The heuristic system ships first.

---

*This specification supersedes v3.0. Companion documents: `acx_production_workflow.md`, `instant_polish_gtm.md`, `instant_polish_compliance_model_v2.md`, `instant_polish_processing_spec_noise_eraser.md`.*
