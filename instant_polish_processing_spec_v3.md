# Instant Polish — Audio Processing Chain: Technical Specification
> Version 3.0 | April 2026
> Supersedes v2.0

---

## Overview

This document specifies the complete audio processing chain for Instant Polish. All processing runs server-side. The browser handles file upload, waveform visualization, playback of both the original and processed audio, and the processing report.

The processing chain is designed to serve multiple use cases through a **preset + compliance target** architecture. A preset defines the character of the processing — the EQ curve, compression behavior, noise reduction aggressiveness, and target loudness. A compliance target defines the output measurement gates. These are independent selections. A narrator who prefers the dynamic character of the Podcast Ready preset can still elect to meet ACX compliance targets on the output.

---

## Architecture: Server-Side Processing, Browser Playback

All processing runs on the server. No audio processing runs in the browser.

**Request payload (browser → server):**
```json
{
  "file": "<uploaded audio>",
  "preset": "acx_audiobook",
  "compliance": "acx"
}
```

**Response payload (server → browser):**
- Processed audio blob (WAV or MP3, depending on tier and preset)
- Processing report JSON (measurements, applied processing, compliance results)
- Waveform peak data JSON (~1000 data points for canvas rendering)

**Browser responsibilities after response:**
- Decode original upload and server response into two `AudioBuffer` objects
- Render before/after waveforms from peak data
- Enable toggle playback between original and processed
- Display processing report and compliance indicators
- Enable download of the processed blob (no second server round-trip)

The audio the user hears in the browser is identical to the audio they download. There is no separate preview quality.

---

## Preset and Compliance Architecture

### Presets

A preset is a named processing profile. It specifies:
- Target loudness (normalization target)
- Compression character (ratio, threshold, attack/release)
- EQ reference profile (what "good" looks like for this use case)
- Noise reduction aggressiveness ceiling
- De-esser sensitivity
- Channel output (mono or stereo)
- Default compliance target
- Whether noise floor compliance is enforced

Four presets ship at launch:

| Preset ID | Display name | Primary audience |
|---|---|---|
| `acx_audiobook` | ACX Audiobook | Audiobook narrators submitting to ACX/Audible |
| `podcast_ready` | Podcast Ready | Podcast hosts and interview recordings |
| `voice_ready` | Voice Ready | Voice actors, general voice-over |
| `general_clean` | General Clean | Everyone else; default for unspecified use |

Preset parameters are defined in full in the **Preset Profiles** section below.

### Compliance Targets

A compliance target is a set of output measurement gates applied after processing. It specifies:
- RMS window (min/max)
- True peak ceiling
- Noise floor ceiling (if enforced)
- What the processing report labels as pass/fail

Three compliance targets are available:

| Compliance ID | Display name | RMS target | True peak ceiling | Noise floor ceiling |
|---|---|---|---|---|
| `acx` | ACX Standard | -23 to -18 dBFS | -3 dBFS | -60 dBFS (enforced) |
| `standard` | Standard | -18 to -14 dBFS (≈ -16 LUFS) | -1 dBFS | Not enforced |
| `broadcast` | Broadcast / Streaming | -24 to -22 dBFS (≈ -23 LUFS) | -1 dBFS | Not enforced |

### Default Pairings

Each preset has a natural default compliance target, which is applied automatically unless overridden:

| Preset | Default compliance |
|---|---|
| `acx_audiobook` | `acx` |
| `podcast_ready` | `standard` |
| `voice_ready` | `acx` |
| `general_clean` | `standard` |

The user can override the compliance target for any preset. The most common override case: a narrator who prefers the processing character of `voice_ready` but needs their files to meet ACX compliance gates.

### How Preset and Compliance Interact

The preset governs everything that happens in Stages 1–6 (the actual sound processing). The compliance target governs Stage 7 (measurement and reporting) and provides the normalization target to Stage 5.

The normalization target is the one parameter shared between preset and compliance. The preset defines a preferred loudness character; the compliance target can override it to meet a specific standard. When the two differ, the compliance target wins. Example: `podcast_ready` targets -16 LUFS for loudness. If the user applies `acx` compliance, the normalization target overrides to -20 dBFS RMS and the noise floor gate is enforced — the file is processed to sound like a podcast-style recording at audiobook loudness levels.

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
| Default compliance | `acx` | |

**ACX-specific processing:**
- Room tone padding enabled (see Room Tone Padding section)
- Plosive detection enabled
- Breath detection enabled
- Human review risk assessment included in report
- Batch cross-chapter consistency pass available

---

### Preset: Podcast Ready (`podcast_ready`)

**Use case:** Podcast hosts, co-hosted shows, and interview recordings. Source material may include multiple speakers in a single file, recordings from different microphones and environments, and remote guests. The goal is a consistent, listenable output that meets streaming platform loudness standards.

**Character:** Punchy, intimate, consistent. More compression than ACX Audiobook to even out the dynamics of conversational speech and create the "close and present" sound that podcast listeners expect. EQ tuned for intelligibility on earbuds and phone speakers. Stereo output preserved for dual-host shows.

| Parameter | Value | Rationale |
|---|---|---|
| Target loudness | -16 LUFS integrated | Spotify, Apple Podcasts, and most streaming platforms normalize to -14 to -16 LUFS |
| True peak ceiling | -1 dBFS | Streaming standard; slightly more headroom than ACX |
| Noise floor target | Not enforced | Podcasts are not subject to ACX's noise floor gate; reduction applied for quality only |
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
| Default compliance | `standard` | |

**Podcast-specific notes:**
- LUFS measurement (integrated loudness, K-weighted) is used instead of unweighted RMS for the normalization target, matching how streaming platforms measure loudness
- Room tone padding not applied
- ACX-specific human review risk flags not shown; general quality flags still active

---

### Preset: Voice Ready (`voice_ready`)

**Use case:** Voice actors recording commercial copy, explainer videos, corporate narration, e-learning, and general voice-over work. Unlike ACX Audiobook, there is no single platform standard — the output needs to sound professional and versatile across different downstream contexts.

**Character:** Clean, broadcast-quality, neutral. Sits between ACX Audiobook (very transparent, minimal processing) and Podcast Ready (punchy, compressed) in character. Enough presence to cut through a mix but not so bright it clashes with music beds. Compression applied to ensure consistent delivery across a wide range of copy styles.

| Parameter | Value | Rationale |
|---|---|---|
| Target loudness | -20 dBFS RMS | Broadcast-neutral; compatible with ACX if compliance is applied, and with most video/multimedia workflows |
| True peak ceiling | -3 dBFS | Leaves headroom for downstream mixing |
| Noise floor target | Not enforced by default | No platform-specific noise floor requirement; reduction applied for quality |
| Noise reduction ceiling | Tier 3 (8 dB max) | |
| Compression | Always applied | Commercial voice-over requires consistent level; dynamics processing is expected |
| Compression ratio | 2.5:1 | More than ACX Audiobook, less than Podcast Ready |
| Compression threshold | -22 dBFS | |
| Compression attack | 8 ms | |
| Compression release | 90 ms | |
| EQ reference profile | Voice-over reference | Presence-forward, mild warmth cut, conservative air boost for studio character |
| De-esser sensitivity | Standard (P95 > mean + 8 dB trigger) | |
| De-esser max reduction | 5 dB | |
| Channel output | Mono | Most voice-over deliverables are mono; downstream mix provides stereo field |
| Default compliance | `acx` | ACX targets are conservative and appropriate for most voice-over deliverables; can be overridden |

**Voice Ready notes:**
- No room tone padding (not applicable outside audiobook)
- No chapter batch processing
- The -3 dBFS peak ceiling and -20 dBFS loudness target make this preset naturally ACX-compatible when `acx` compliance is selected, without additional processing

---

### Preset: General Clean (`general_clean`)

**Use case:** Everything else — meeting recordings, lecture captures, field recordings, dictation, demo submissions, informal audio. The user has a file that sounds bad and wants it to sound better. No platform-specific requirements.

**Character:** Pragmatic. More aggressive noise reduction than other presets (the incoming material is often more problematic). Balanced EQ with no strong character. Moderate compression for consistency. The goal is "sounds good" rather than meeting any specific standard.

| Parameter | Value | Rationale |
|---|---|---|
| Target loudness | -16 LUFS integrated | Good general-purpose listening level; matches streaming norms |
| True peak ceiling | -1 dBFS | |
| Noise floor target | Not enforced | |
| Noise reduction ceiling | Tier 4 (12 dB max), artifact risk warnings relaxed | General clean users have lower quality source material; more reduction is acceptable |
| Compression | Always applied | Inconsistent recording conditions make compression essential |
| Compression ratio | 3:1 | |
| Compression threshold | -20 dBFS | |
| Compression attack | 8 ms | |
| Compression release | 80 ms | |
| EQ reference profile | General reference | Balanced; mud cut + mild presence boost; no strong character |
| De-esser sensitivity | Higher sensitivity (P95 > mean + 6 dB trigger) | General audiences are less tolerant of sibilance than professionals |
| De-esser max reduction | 8 dB | Slightly higher ceiling than other presets given noisier source material |
| Channel output | Preserve original | No channel requirement |
| Default compliance | `standard` | |

**General Clean notes:**
- This preset is the default when no preset is specified
- No room tone padding
- No batch processing
- Artifact risk warnings are relaxed — the source material is often imperfect enough that some processing artifact is acceptable; getting the noise floor down is more valuable than artifact purity

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

**All internal processing uses 32-bit float PCM at 44.1 kHz.** The first step for every file is: decode → resample to 44.1 kHz (if needed) → convert to 32-bit float. Processing on integer PCM is not permitted — intermediate stage headroom is required.

---

## Pre-Processing: Input Normalization

Before the processing chain runs, normalize the input to a consistent internal format. These steps are preparation, not processing.

**Step 1 — Decode**
FFmpeg decodes the input to raw 32-bit float PCM.

**Step 2 — Resample (if needed)**
If input sample rate ≠ 44.1 kHz, resample using FFmpeg's `swr` resampler with high-quality sinc interpolation. Log original sample rate in processing report.

**Step 3 — Channel handling**
Behavior depends on the preset's channel output setting:
- If preset requires **mono** and input is stereo: apply mid-channel mix-down (`mono = (left + right) / 2`). Do not use channel selection. Log conversion in processing report.
- If preset **preserves original** channel count: pass through without conversion.
- If input is already mono: no action regardless of preset.

**Step 4 — Initial analysis**
Before any processing, measure and record:
- Noise floor (from lowest-energy 2 seconds; bootstrap for silence detection)
- RMS of full file (used to establish relative levels)
- True peak
- Fundamental frequency estimate (for de-esser calibration)
- Spectral envelope of voiced speech segments (for EQ calibration)

These are the "before" values in the processing report.

---

## Processing Chain

The chain below applies to all presets. Where a parameter varies by preset, the notation `[preset param]` indicates the value is drawn from the active preset profile.

```
Stage 1:  High-Pass Filter
Stage 2:  Adaptive Noise Reduction
Stage 3:  Enhancement EQ
Stage 4:  De-esser (conditional)
Stage 4a: Compression (conditional or always-on, per preset)
Stage 5:  Loudness Normalization
Stage 6:  True Peak Limiting
Stage 7:  Measurement + Processing Report
```

---

### Stage 1 — High-Pass Filter

**Purpose:** Remove sub-vocal low-frequency energy — HVAC rumble, floor vibration, electrical hum, proximity effect bass buildup — before any level processing.

**Implementation:** FFmpeg `highpass` filter.

**Specification (all presets):**
- Filter type: Butterworth high-pass, 4th order (-24 dB/octave)
- Cutoff frequency: 80 Hz
- Apply to the full file

80 Hz is universal across all presets. Male voice fundamentals begin at ~85 Hz; female at ~165 Hz. Cutting at 80 Hz removes everything below the voice without thinning it.

**Supplementary: 60 Hz notch filter (conditional, all presets)**
Detect tonal spike at 50 or 60 Hz in the pre-processing noise floor measurement. If either band is > 6 dB above surrounding noise floor, apply a narrow notch filter (Q = 10, -20 dB attenuation) at the detected frequency. This addresses electrical hum that broadband noise reduction handles poorly.

---

### Stage 2 — Adaptive Noise Reduction

**Purpose:** Reduce background noise to improve listening quality and, where required by the compliance target, bring the noise floor to -60 dBFS.

**Implementation:** DeepFilterNet3 (neural network speech enhancement). Python `deepfilternet` package or Rust `libdf` bindings, server-side.

#### 2a — Pre-Reduction Analysis

**Silence detection:**
Segment the file into 100 ms frames. Classify as silence when RMS < `(noise_floor_estimate + 6 dB)`. Dynamic threshold — prevents false positives in noisier recordings.

**Noise floor measurement:**
Average RMS of all silence frames.

**SNR calculation:**
`SNR = average_voiced_RMS − measured_noise_floor`

**Noise character classification:**
Analyze spectral shape of silence frames:
- **Broadband stationary:** Flat spectrum 100 Hz–8 kHz. Consistent HVAC, mic self-noise. Responds well to DeepFilterNet3.
- **Tonal/hum:** Energy concentrated in narrow bands. Supplement with notch filtering before DeepFilterNet3.
- **Non-stationary/variable:** High variance across silence frames. Higher artifact risk — apply more conservatively.
- **Mixed:** Treat as non-stationary.

#### 2b — Adaptive Reduction Tiers

The tier table below applies universally. The preset's **noise reduction ceiling** determines the maximum tier that will be applied:

| Tier | Measured noise floor | Approach |
|---|---|---|
| 1 — Clean | ≤ -60 dBFS | Skip. Log "Noise floor compliant — no reduction applied." |
| 2 — Light | -55 to -60 dBFS | Light DeepFilterNet3 pass. Low artifact risk. |
| 3 — Standard | -50 to -55 dBFS | Standard DeepFilterNet3 pass. Post-reduction artifact check. |
| 4 — Heavy | -45 to -50 dBFS | Maximum safe reduction. Artifact check. Warn user. |
| 5 — At risk | Above -45 dBFS | Apply max safe reduction. Report failure. Do not force further. |

`acx_audiobook` and `voice_ready` cap at Tier 4. `podcast_ready` caps at Tier 3. `general_clean` allows Tier 4 with relaxed artifact warnings.

**Noise floor compliance:** Only applied when the active compliance target includes a noise floor gate (currently only `acx`). For other compliance targets, noise reduction is applied for quality — the goal is perceptual improvement, not hitting a measurement threshold.

**Tier 5 messaging (ACX compliance context):** "Background noise is too high to process cleanly. Measured noise floor: [X] dBFS. Consider re-recording in a quieter environment."

**Tier 5 messaging (non-ACX context):** "Background noise level is high. Some reduction has been applied, but residual noise remains audible."

#### 2c — Post-Reduction Validation

After DeepFilterNet3 processing:
1. Re-measure noise floor. If ACX compliance is active and target not met: report failure; do not re-run.
2. Artifact check: compare spectral flatness of voiced speech before and after. Significant decrease → log human review risk warning (ACX context) or quality warning (other contexts).

---

### Stage 3 — Enhancement EQ

**Purpose:** Improve tonal quality of the recording for the target use case. Runs after noise reduction (cleaner signal), before normalization (so EQ doesn't distort loudness calibration).

**Implementation:** FFmpeg `equalizer` filter, parametric biquad IIR. Multiple bands chained in one FFmpeg pass.

#### 3a — Spectral Analysis

Analyze spectral envelope of voiced speech using Meyda.js. Compute average energy in diagnostic bands:

| Band | Frequency | What it indicates |
|---|---|---|
| Body / warmth | 100–250 Hz | Thin if low |
| Mud / boxiness | 200–400 Hz | Home studio room coloration |
| Clarity zone | 400–700 Hz | Cuts here add clarity |
| Presence | 2–5 kHz | Low = muffled |
| Air / sibilance | 6–12 kHz | Elevated = harsh |

Compare to the **preset's EQ reference profile**. Each preset references a different target spectral shape — see reference profiles below. The delta between measured and reference drives parameter selection.

#### 3b — EQ Reference Profiles

**ACX narration reference:**
Optimized for long-form narration intelligibility. Slight presence emphasis, conservative air, minimal warmth alteration. ACX human reviewers expect a natural, unprocessed character.
- Mud cut: trigger at > 3 dB above reference, -2 to -4 dB, Q = 2–3
- Clarity cut: follow mud cut, -1 to -2 dB at 400–600 Hz
- Presence boost: trigger at > 2 dB below reference, +2 to +3 dB at ~4 kHz, Q = 1.5
- Warmth boost: trigger only if 100–200 Hz is > 4 dB below reference AND mud cut not applied
- Air boost: conservative, trigger at > 4 dB below reference, +1 to +1.5 dB shelf at 10 kHz

**Podcast reference:**
Optimized for intelligibility on earbuds and phone speakers. More assertive mud cut. Presence pushed slightly higher for conversational crispness. Warmth cut to avoid boominess on phone speakers.
- Mud cut: trigger at > 2 dB above reference (lower threshold), -3 to -5 dB, Q = 2
- Warmth cut: gentle cut at 150–200 Hz, -1 to -2 dB if energy is elevated (prevents boominess on small speakers)
- Clarity cut: -1 to -3 dB at 400–600 Hz
- Presence boost: +2 to +4 dB at ~3.5 kHz, Q = 1.5 (slightly lower frequency than ACX for conversational speech)
- Air boost: +1 to +2 dB shelf at 10 kHz if recording quality supports it

**Voice-over reference:**
Optimized for versatility — the output sits well under music beds and in mixed productions. Neutral character, mild presence boost, no strong tonal opinion.
- Mud cut: trigger at > 3 dB above reference, -2 to -3 dB, Q = 2
- Clarity cut: -1 to -2 dB at 400–600 Hz
- Presence boost: +2 to +3 dB at ~4 kHz, Q = 1.5
- Air boost: +1 to +1.5 dB shelf at 10 kHz, conservative trigger

**General reference:**
Balanced. No strong character. Suitable for the widest range of source material.
- Mud cut: trigger at > 3 dB above reference, -2 to -4 dB, Q = 2
- Clarity cut: -1 to -2 dB at 400–600 Hz
- Presence boost: +2 to +3 dB at ~4 kHz, Q = 1.5
- Warmth boost / cut: applied as needed in either direction (≤ ±2 dB)
- Air boost: applied conservatively

#### 3c — Noise Floor Constraint (ACX compliance only)

When `acx` compliance is active: after applying the presence boost, re-check the noise floor. If the boost has raised the measured noise floor above -60 dBFS, reduce the boost by 1 dB increments until compliant, or skip entirely. High-frequency hiss partially suppressed by noise reduction can be re-elevated by presence boosts.

#### 3d — Maximum EQ Gain Constraint (all presets)

No single band adjustment exceeds ±5 dB. Deficiencies larger than this are a recording problem EQ cannot fix without audible processing character. Apply the 5 dB maximum and note in the report.

---

### Stage 4 — De-esser (Conditional)

**Purpose:** Reduce harsh sibilant energy that causes listener fatigue and — in ACX context — human review rejection.

**Implementation:** Custom DSP — Meyda.js spectral analysis driving a frequency-selective compressor.

**Trigger condition:** Determined by the preset's **de-esser sensitivity** setting:
- Standard (ACX Audiobook, Voice Ready): P95 sibilant energy > mean sibilant energy + 8 dB
- Higher sensitivity (Podcast Ready, General Clean): P95 > mean + 6 dB

If the trigger condition is not met, skip this stage entirely for all presets.

#### 4a — Sibilance Analysis (all presets)

1. Estimate fundamental frequency (F0) from voiced frames (autocorrelation or zero-crossing rate):
   - Male (F0 85–180 Hz) → initial sibilant band = 4–7 kHz
   - Female (F0 165–255 Hz) → initial sibilant band = 6–9 kHz
   - Uncertain → 5–8 kHz

2. Identify fricative events (high spectral flatness in sibilant band, low energy below 1 kHz)

3. Find spectral centroid of the 95th percentile fricative events → this is the de-esser target frequency

4. Evaluate trigger condition for the active preset

#### 4b — De-esser Parameters

| Parameter | ACX Audiobook | Podcast Ready | Voice Ready | General Clean |
|---|---|---|---|---|
| Trigger | P95 > mean + 8 dB | P95 > mean + 6 dB | P95 > mean + 8 dB | P95 > mean + 6 dB |
| Threshold | mean + 4 dB | mean + 3 dB | mean + 4 dB | mean + 3 dB |
| Max reduction | 6 dB | 6 dB | 5 dB | 8 dB |
| Attack | 1–2 ms | 1–2 ms | 1–2 ms | 1–2 ms |
| Release | 40–60 ms | 40–60 ms | 40–60 ms | 40–60 ms |

Log in report: target frequency, max reduction applied.

---

### Stage 4a — Compression

**Purpose:** Reduce dynamic range to achieve the consistency appropriate to the target use case.

**Behavior by preset:**

| Preset | Applied | When |
|---|---|---|
| ACX Audiobook | Conditionally | Only when crest factor > 20 dB |
| Podcast Ready | Always | Conversational speech requires compression |
| Voice Ready | Always | Commercial voice-over requires consistent delivery |
| General Clean | Always | Inconsistent source material requires compression |

**Implementation:** Custom DSP compressor (feed-forward, RMS detection).

**Parameters by preset:**

| Parameter | ACX Audiobook | Podcast Ready | Voice Ready | General Clean |
|---|---|---|---|---|
| Threshold | -24 dBFS | -20 dBFS | -22 dBFS | -20 dBFS |
| Ratio | 2:1 | 3:1 | 2.5:1 | 3:1 |
| Attack | 10 ms | 5 ms | 8 ms | 8 ms |
| Release | 100 ms | 80 ms | 90 ms | 80 ms |
| Knee | Soft, 4 dB | Soft, 4 dB | Soft, 4 dB | Soft, 4 dB |
| Makeup gain | 0 dB | 0 dB | 0 dB | 0 dB |

Makeup gain is always 0 dB at this stage — Stage 5 handles level.

---

### Stage 5 — Loudness Normalization

**Purpose:** Bring the average loudness of the voiced speech to the target level via a linear gain adjustment.

**Implementation:** libebur128 (node-ebur128 bindings) for measurement; FFmpeg `loudnorm` filter (two-pass) or linear gain application for adjustment.

#### 5a — Normalization Target

The normalization target is set by the **compliance target**, not the preset. When compliance overrides the preset's natural loudness:

| Compliance target | Normalization target | Measurement method |
|---|---|---|
| `acx` | -20 dBFS RMS | Unweighted RMS, voiced frames only |
| `standard` | -16 LUFS integrated | K-weighted integrated loudness (EBU R128) |
| `broadcast` | -23 LUFS integrated | K-weighted integrated loudness (EBU R128) |

**Why unweighted RMS for ACX:** ACX measures unweighted RMS, not LUFS. Normalizing to LUFS and reporting LUFS would create a systematic measurement mismatch. For ACX compliance, RMS measurement must be used throughout.

**Why LUFS for other targets:** Streaming platforms normalize by LUFS. Using LUFS measurement for podcast and general outputs ensures the files behave correctly in downstream platform normalization.

#### 5b — Silence Exclusion

For RMS measurement, exclude silence frames using the dynamic threshold established in Stage 2a:
`silence_threshold = measured_noise_floor + 6 dB`

For LUFS measurement, EBU R128 gating handles silence exclusion natively via the absolute (-70 LUFS) and relative (-10 LU) gating thresholds in the ITU-R BS.1770-4 standard.

#### 5c — Gain Calculation and Application

```
For RMS: gain_dB = target_RMS_dBFS − measured_RMS_dBFS
For LUFS: gain_dB = target_LUFS − measured_LUFS
```

Apply as a single linear gain to the entire file. No time-varying gain at this stage.

**Edge case:** If `gain_dB > +18 dB`, log a warning: "Recording level is very low. Consider re-recording with higher input gain."

---

### Stage 6 — True Peak Limiting

**Purpose:** Prevent inter-sample peaks from exceeding the compliance target's peak ceiling.

**Implementation:** FFmpeg `loudnorm` filter, two-pass mode with `-tp [ceiling]`. Upsamples to 192 kHz for true peak detection; 100 ms look-ahead; applies minimum gain reduction required per peak.

**Peak ceiling by compliance target:**

| Compliance target | True peak ceiling |
|---|---|
| `acx` | -3 dBFS |
| `standard` | -1 dBFS |
| `broadcast` | -1 dBFS |

The ceiling value is supplied to Stage 6 by the active compliance target, not hardcoded. This is the mechanism that allows any preset to achieve ACX peak compliance when `acx` is selected.

**Expected behavior:** A well-processed file should require minimal limiting. If the limiter is attenuating > 3 dB on frequent transients, Stage 4a's compression settings were insufficient for this material.

---

### Stage 7 — Measurement and Processing Report

**Purpose:** Measure the processed file against the active compliance target, assess quality risk factors, and generate the report returned to the browser.

**Implementation:** libebur128 + custom noise floor measurement + spectral analysis for risk assessment.

#### 7a — Compliance Measurements

Measurements and their pass/fail thresholds are taken from the active compliance target:

| Measurement | `acx` pass threshold | `standard` pass threshold | `broadcast` pass threshold |
|---|---|---|---|
| Loudness | -23 to -18 dBFS RMS | -18 to -14 LUFS | -24 to -22 LUFS |
| True peak | ≤ -3 dBFS | ≤ -1 dBFS | ≤ -1 dBFS |
| Noise floor | ≤ -60 dBFS | Not measured | Not measured |

#### 7b — Quality Risk Assessment (all presets)

Flags that apply regardless of preset or compliance target:

**Overprocessing detection:**
- Spectral flatness decrease in voiced speech > threshold after full chain → "Processing artifacts possible. Review output before submitting."
- Crest factor of output < 8 dB → "Output may be over-compressed."

**Loud breath detection (ACX Audiobook only):**
Detect short high-energy events in silence regions consistent with breath sounds. If average breath energy is within 12 dB of average voiced speech level → "Loud breath sounds detected. These require manual editing before ACX submission."

**Plosive detection (ACX Audiobook only):**
Detect sharp low-frequency transients (50–150 Hz, > 10 dB above baseline, < 20 ms) that survived the HPF → "Possible unedited plosives detected."

**Human review risk (ACX Audiobook only):**
Aggregate of the above into Low / Medium / High risk level, shown prominently in the report.

#### 7c — Processing Report JSON Structure

```json
{
  "file": "chapter_01.wav",
  "preset": "acx_audiobook",
  "compliance": "acx",
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
  "before": {
    "rms_dbfs": -26.4,
    "true_peak_dbfs": -4.1,
    "noise_floor_dbfs": -53.2
  },
  "after": {
    "rms_dbfs": -19.8,
    "true_peak_dbfs": -3.0,
    "noise_floor_dbfs": -62.1,
    "lufs_integrated": null
  },
  "compliance_results": {
    "target": "acx",
    "loudness_pass": true,
    "true_peak_pass": true,
    "noise_floor_pass": true,
    "overall_pass": true
  },
  "human_review_risk": {
    "level": "low",
    "flags": []
  },
  "warnings": []
}
```

---

## Output Format Specification

The internal processing format is always 32-bit float WAV at 44.1 kHz. Delivery format depends on preset and tier.

**Internal processed file (not delivered):**
WAV, 32-bit float, 44.1 kHz, mono or stereo per preset.

**Free tier delivery (all presets):**
MP3, 128 kbps CBR, 44.1 kHz. Sufficient quality for before/after evaluation. The export gate is on full-quality formats, not on audition quality.

**Creator tier delivery — WAV (all presets):**
WAV, 16-bit PCM, 44.1 kHz, channel count per preset.

**Creator tier delivery — preset-specific encoded format:**

| Preset | Encoded format | Specification |
|---|---|---|
| ACX Audiobook | MP3 192 kbps CBR | LAME via FFmpeg, `-b:a 192k -abr 0`. ACX requires strict CBR. |
| Podcast Ready | MP3 320 kbps CBR | High quality for distribution; most podcast hosts accept this |
| Voice Ready | WAV only | Voice-over deliverables are typically WAV; client handles encoding |
| General Clean | MP3 256 kbps CBR | Good general-purpose quality |

For Creator tier, both WAV and the preset-specific encoded format are available. User chooses which to download.

---

## Room Tone Padding (ACX Audiobook only)

ACX requires 0.5–1 second of room tone at the head and 1–5 seconds at the tail of each file.

**Detection:** Measure duration of near-silence (frames ≤ noise floor + 3 dB) at head and tail.

**Correction:**
- Head room tone < 0.5 s → prepend to reach 0.75 s
- Tail room tone < 1 s → append to reach 2 s
- Source: 500 ms sample from the lowest-energy silence segment identified in Stage 2a (actual room ambience, not digital silence)

Room tone padding is skipped for all other presets — it is an ACX-specific requirement.

---

## Batch Processing (ACX Audiobook only)

Batch mode accepts a complete audiobook chapter set and processes them as a cohesive unit. Consistency across chapters is a first-class goal alongside individual file compliance.

**Phase 1 — Batch analysis:** Analyze all files before processing any. Compute batch-wide medians for noise floor, RMS, and spectral centroid. Flag outliers (noise floor > 6 dB from batch median).

**Phase 2 — Individual processing:** Process each file through the full chain independently. Per-file noise profiling, EQ calibration, and normalization. Do not share profiles across files at this phase.

**Phase 3 — Consistency pass:** After all files are individually processed, apply cross-chapter corrections:
- RMS consistency: files deviating > 1 dB from batch median receive a small linear trim to bring within range
- Tonal consistency: files with spectral centroid > 15% from batch median receive 1–2 dB corrective EQ
- Flag files requiring > 1.5 dB tonal correction in the batch report

**Batch report:** One row per file (filename, duration, RMS, true peak, noise floor, pass/fail, risk level, warnings) plus a summary row.

Batch processing is not available for other presets at launch. Future expansion may add batch support for `podcast_ready` (multi-episode normalization).

---

## UI Requirements for Preset and Compliance Architecture

The following requirements ensure the UI correctly reflects the preset/compliance model.

**Preset selector:**
Displayed prominently before processing begins. Four options at launch: ACX Audiobook, Podcast Ready, Voice Ready, General Clean. Default: General Clean (or ACX Audiobook if the user has previously selected it).

**Compliance target selector:**
Shown as a secondary control, below or adjacent to the preset selector. Default is pre-filled based on the selected preset. The control is visible but not foregrounded — it is an advanced option most users won't need to change.

For the ACX Audiobook preset, the compliance selector should be hidden or locked to `acx` — there is no meaningful reason to process an audiobook file without ACX compliance, and surfacing the choice adds confusion.

**Compliance override indicator:**
When a user selects a non-default compliance target for a preset, surface a brief note explaining the override. Example: "Using ACX compliance targets with Podcast Ready preset. Output loudness will be -20 dBFS RMS (not -16 LUFS)."

**Processing report display:**
The report shows:
- Active preset and compliance target
- Before/after measurements with pass/fail indicators (compliance target measurements only)
- Processing applied (as a human-readable summary, not raw JSON)
- Human review risk level (ACX Audiobook only)
- Warnings

For non-ACX compliance targets, omit the noise floor row from the report display — it is not a meaningful measurement for those use cases and showing a number without a pass/fail threshold creates confusion.

---

## Processing Quality Constraints

These constraints apply to all presets.

**Transparency first.** The goal is the same voice, cleaner and at the right level. Never a different voice. When a parameter choice involves a quality/safety tradeoff, choose safety.

**Preset character, not preset uniformity.** Each preset has a distinct character. Do not converge all presets toward the same sound by applying the same processing. A podcast file should sound like a podcast; an audiobook should sound like an audiobook.

**Never force a pass.** If a file cannot meet the active compliance target without artifact levels that would fail human review (ACX) or sound unnatural, report the failure. Do not apply increasingly aggressive processing to make the numbers pass.

**Human review is the real target (ACX Audiobook).** For ACX files, the three measurements are necessary but not sufficient. Every processing decision should be evaluated against: "Would an ACX human reviewer flag this?"

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
FFmpeg decode + HPF + mono conversion → DeepFilterNet3 → FFmpeg normalization + limiting → libebur128 measurement → ACX compliance report → WAV/MP3 output → return to browser

**Sprint 2 — Enhancement quality (ACX Audiobook):**
Meyda.js spectral analysis → adaptive enhancement EQ → dynamic silence exclusion → room tone padding → extended report (human review risk, breath/plosive detection)

**Sprint 3 — De-esser and compression (ACX Audiobook):**
F0 estimation → sibilance analysis → conditional de-esser → conditional compression → report logging

**Sprint 4 — Preset architecture:**
Separate preset config from compliance config → implement Podcast Ready, Voice Ready, General Clean presets → LUFS normalization path → compliance target selector in UI → preset-specific EQ reference profiles → compliance override indicator

**Sprint 5 — Batch processing (ACX Audiobook):**
Batch analysis phase → per-file processing → consistency pass → batch report

**Sprint 6 — Commercial library evaluation:**
Krisp SDK evaluation on real narrator recordings vs. DeepFilterNet3 → commercial licensing decision

---

## AI Enhancement Roadmap

The v3 processing chain is intentionally heuristic-based. DeepFilterNet3 is the one genuine AI component — a neural network model operating at Stage 2. All other adaptive decisions (EQ parameter selection, de-esser frequency targeting, noise reduction tiering) are driven by spectral measurements and deterministic rules.

Two stages are identified as candidates for AI-driven parameter selection in a future version, where a learned model would offer a meaningful quality improvement over heuristics:

**Enhancement EQ Calibration (Stage 3):** The current approach compares the file's spectral envelope to a preset-specific reference profile using fixed thresholds. A model trained on matched before/after pairs (raw narration → professionally mastered output) could predict optimal EQ parameters directly from the input's acoustic features, generalizing better across the range of microphones, voices, and room conditions that Instant Polish users bring. This applies per-preset — each preset would have its own model trained on use-case-appropriate examples.

**De-esser Frequency Targeting (Stage 4):** The current approach estimates the sibilant frequency band from the fundamental frequency of the voice via a lookup table. A regression model taking the spectral profile of detected fricative events as input and predicting the problematic sibilant center frequency directly would be more accurate across edge cases — particularly for voice and microphone combinations that fall outside the population averages the lookup table was built on.

Both improvements are post-launch. The heuristic system ships first, accumulates real-world data, and generates the training material that makes the AI-driven replacements possible. The heuristics are functional and well-calibrated — the AI versions improve at the margin, not from scratch.

---

*This specification supersedes v2.0. Companion documents: `acx_production_workflow.md`, `instant_polish_gtm.md`.*
