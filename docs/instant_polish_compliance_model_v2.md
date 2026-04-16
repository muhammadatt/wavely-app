# Instant Polish — Compliance and Quality Review Model
> Version 2.0 | April 2026
> Supersedes the "Human Review Risk" sections of processing spec v3.0 and v3.1

---

## Overview

This document defines the compliance and quality reporting model for Instant Polish. It establishes two independent systems that together form the post-processing report:

1. **ACX Technical Certification** — deterministic, measurable, pass/fail. Runs only when `output_profile = acx`. The tool certifies this with certainty.
2. **Quality Advisory Flags** — probabilistic, subjective, user-reviewable. Runs for all presets and all output profiles. The tool flags concerns; the user decides.

These systems are independent of each other and independent of the output profile selection. A file can receive quality advisory flags regardless of whether ACX certification runs. A file can pass ACX certification and still have advisory flags. Both pieces of information are useful and neither implies the other.

---

## Why ACX Is the Only Formal Certification Standard

ACX publishes specific, measurable, enforceable requirements for every file submitted to its platform. These requirements have defined pass/fail thresholds, are checked by automated tooling, and result in rejection if not met. This is what makes certification meaningful — there is an external authority with published criteria that the tool can check against.

Podcast and broadcast loudness targets (`podcast` and `broadcast` output profiles) are norms, not standards. Spotify does not reject a file for measuring -17 LUFS instead of -16 LUFS — it normalizes on playback. There is no governing body checking these files against a published spec. Certifying output against the tool's own processing targets would be circular — it would always pass by construction and would tell the user nothing.

For `podcast` and `broadcast` output profiles, Stage 7 reports output measurements (LUFS integrated, true peak, RMS, noise floor) as informational values. These are useful — the user can see what the tool achieved — but they are not framed as pass/fail compliance checks.

---

## System 1 — ACX Technical Certification

### When It Runs

ACX certification runs automatically when `output_profile = acx`, regardless of which preset is active. It does not run for `podcast` or `broadcast` output profiles.

### What It Checks

ACX certification is a six-point deterministic check. All six must pass for a certificate to be issued.

| Check | Pass threshold | Method |
|---|---|---|
| RMS (average loudness) | -23 to -18 dBFS | Unweighted RMS, voiced frames only, libebur128 |
| True peak | ≤ -3 dBFS | True peak at 192 kHz upsample, FFmpeg loudnorm |
| Noise floor | ≤ -60 dBFS | Energy threshold method, lowest-energy silence frames |
| Sample rate | 44.1 kHz | FFmpeg probe |
| Bit depth | 16-bit PCM (WAV) or 192 kbps CBR (MP3) | FFmpeg probe |
| Channel format | Mono | FFmpeg probe |

A file that passes RMS, true peak, and noise floor but is stereo does not receive a certificate — it fails the channel format check. All six pass/fail independently, and all six are shown in the report.

### Certificate Format

```
ACX TECHNICAL CERTIFICATION: PASS
  ✓ RMS:          -19.8 dBFS   (target: -23 to -18 dBFS)
  ✓ True peak:    -3.0 dBFS    (target: ≤ -3 dBFS)
  ✓ Noise floor:  -62.1 dBFS   (target: ≤ -60 dBFS)
  ✓ Sample rate:  44.1 kHz
  ✓ Bit depth:    16-bit PCM
  ✓ Channel:      Mono
```

On failure, identify exactly which checks failed and by how much:

```
ACX TECHNICAL CERTIFICATION: FAIL
  ✗ RMS:          -17.1 dBFS   (target: -23 to -18 dBFS) — 0.9 dB over ceiling
  ✓ True peak:    -3.0 dBFS    (target: ≤ -3 dBFS)
  ✓ Noise floor:  -62.1 dBFS   (target: ≤ -60 dBFS)
  ✓ Sample rate:  44.1 kHz
  ✓ Bit depth:    16-bit PCM
  ✓ Channel:      Mono
```

### What the Certificate Means

**The tool certifies technical compliance. It does not certify ACX acceptance.**

ACX also applies a human quality review after the automated technical check passes. That review covers subjective qualities — overprocessing artifacts, inconsistent loudness across chapters, audible background noise that technically passes the -60 dBFS floor, content issues — that no automated tool can certify. The quality advisory system (System 2) addresses these concerns separately.

The certificate is exportable as a PDF or shareable as a link. Narrators sometimes need to demonstrate technical compliance to a rights holder before ACX upload — a shareable certificate makes the tool part of the production workflow, not just the processing step.

---

## System 2 — Quality Advisory Flags

### What They Are

Quality advisory flags are probabilistic observations about aspects of the output that a human reviewer might notice, or that the user should verify before considering the file complete. The tool detects conditions that correlate with quality concerns but cannot determine whether a specific reviewer will flag a specific file, or whether a specific user will find a specific artifact acceptable.

**Core principle:** The user reviews the output. The tool provides targeted information to support that review. A technically certified file with advisory flags is still a valid, submittable file — the user decides whether to submit it.

### When They Run

Quality advisory flags run for all presets and all output profiles. The specific flags generated depend on the active preset. ACX-specific flags only apply when `preset = acx_audiobook` or when ACX-relevant conditions are present.

### Flag Definitions

| Flag ID | Condition | Severity | Message shown to user |
|---|---|---|---|
| `overprocessing` | Spectral flatness of voiced speech decreased significantly after full chain | Review | "Processing artifacts may be audible. Listen carefully before submitting." |
| `over_compression` | Output crest factor < 8 dB | Review | "Output may sound over-compressed. The narration may lack natural dynamic range." |
| `loud_breaths` | Average breath energy within 12 dB of average voiced speech level | Review | "Loud breath sounds detected. ACX reviewers sometimes flag these. Listen and decide." |
| `plosives` | Sharp low-frequency transients consistent with unedited plosives | Review | "Possible plosive sounds detected. These may require manual editing." |
| `noise_floor_marginal` | Noise floor -60 to -62 dBFS (passes certification but close to limit) | Info | "Noise floor is within spec but close to the limit. Re-recording in a quieter environment would add headroom." |
| `high_nr_tier` | Noise reduction Tier 4 was applied | Info | "Heavy noise reduction was applied. Some processing character may be audible on close listening." |
| `separation_used` | `noise_eraser` preset was used | Review | "Voice separation was used. The output may have a processed quality. Review carefully before submitting to ACX." |
| `over_expansion` | `pct_frames_expanded` > 35% OR any VAD-voiced frame received > 3 dB attenuation from the Stage 4a-E vocal expander | Review | "The expander may have affected quiet speech. Listen for unnatural silences between words or clipped consonants." |
| `chapter_outlier` | Batch mode: this file deviates > 2 dB from batch median after consistency pass | Review | "This chapter sounds noticeably different from the rest of the batch. Review for consistency." |

**`loud_breaths` and `plosives`** apply when `preset = acx_audiobook` only. These are specifically ACX human review concerns and are not meaningful outside that context.

**`noise_floor_marginal`** applies when `output_profile = acx` only — the marginal threshold is defined relative to ACX's -60 dBFS requirement.

**`separation_used`** applies when `preset = noise_eraser` regardless of output profile.

**`over_expansion`** applies only when the Stage 4a-E vocal expander actually ran (`vocal_expander.applied = true`).

All other flags apply to all presets and output profiles.

### Severity Levels

**Info** — informational, no action required. The tool is reporting what it did. User may dismiss.

**Review** — the tool recommends listening to the output before treating the file as complete. The flag identifies specifically what to listen for. The user decides whether the result is acceptable.

There is no aggregate risk score. Aggregating flags into a High/Medium/Low rating implies the tool is estimating ACX's rejection probability, which it cannot do. Each flag stands alone with a specific description of what was detected and what to listen for.

### What Advisory Flags Are Not

- They are not failures. A technically certified file with advisory flags is valid and submittable.
- They are not recommendations to re-process. The tool has applied its best processing. The flags inform the user's review decision, not a reprocessing decision.
- They are not ACX predictions. The tool does not say "ACX will reject this." It says "a human reviewer might notice this" or "this condition is worth verifying."

---

## UI Model

### Report Layout

The processing report renders in three sections, in order:

**Section 1 — Output Measurements** (always present, all presets, all output profiles)

Shows before/after values for RMS, LUFS integrated, true peak, and noise floor. No pass/fail framing. These are what the tool achieved.

**Section 2 — ACX Technical Certification** (present only when `output_profile = acx`)

Shows the six-point certificate prominently. Green pass or red fail per check. Specific measured values and thresholds for each check. This is the headline result for ACX users.

When `output_profile` is `podcast` or `broadcast`: this section is absent entirely. The report does not show empty or greyed-out certification — it simply does not include certification framing.

**Section 3 — Before You Submit** (present when any advisory flags exist)

Title: **"Before you submit — things to listen for."**

Each flag shows:
- What was detected
- What to listen for specifically
- A "Mark as reviewed" checkbox

The "Mark as reviewed" interaction is important. It makes the review step explicit — the user is actively deciding to accept the flag, not passively scrolling past it. This creates a clear decision boundary between "the tool processed this file" and "I have reviewed and am ready to submit this file."

If no advisory flags are present, show: **"No quality concerns detected."**

Do not block the download on advisory flags. The user can download at any point. The flags are information, not gates.

### Certificate Export

When `output_profile = acx` and certification passes, surface an "Export Certificate" option. Generates a PDF or shareable link showing the six-point pass with measured values. Useful for narrators who need to demonstrate compliance to a rights holder before ACX upload.

---

## Processing Report JSON

### Full structure

```json
{
  "file": "chapter_01.wav",
  "preset": "acx_audiobook",
  "output_profile": "acx",
  "measurements": {
    "before": {
      "rms_dbfs": -26.4,
      "lufs_integrated": -28.1,
      "true_peak_dbfs": -4.1,
      "noise_floor_dbfs": -53.2
    },
    "after": {
      "rms_dbfs": -19.8,
      "lufs_integrated": -21.4,
      "true_peak_dbfs": -3.0,
      "noise_floor_dbfs": -62.1
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
    "flags": [
      {
        "id": "high_nr_tier",
        "severity": "info",
        "message": "Heavy noise reduction was applied. Some processing character may be audible on close listening."
      }
    ],
    "review_recommended": false
  }
}
```

**`acx_certification`** is absent (not null, absent) when `output_profile` is `podcast` or `broadcast`.

**`review_recommended`** is `true` when any flag with severity `review` is present. `false` when only `info` flags are present or no flags are present.

**`measurements.after`** is always present and always fully populated regardless of output profile.

---

## Practical Examples

**Clean file, ACX output profile (typical treated-room narrator):**
- Output measurements: all values in expected range
- ACX certification: Pass, all six checks green
- Quality advisory: No flags — "No quality concerns detected"
- User experience: Clear, confident, ready to submit

**Noisy file processed successfully, ACX output profile:**
- ACX certification: Pass
- Quality advisory: `high_nr_tier` info flag
- User experience: Certified compliant, informed about heavy processing, user decides

**File with loud breaths, ACX output profile:**
- ACX certification: Pass (breaths don't meaningfully affect RMS/peak/noise floor)
- Quality advisory: `loud_breaths` review flag with listening instruction
- User experience: Technically certified, prompted to verify breath handling. User listens, ticks "Mark as reviewed," submits.

**Noise Eraser file, ACX output profile:**
- ACX certification: Pass (if measurements hit targets)
- Quality advisory: `separation_used` review flag, possibly `overprocessing`
- User experience: Certified on measurements, explicitly informed that separation elevates human review risk. User makes an informed submission decision.

**File that fails RMS, ACX output profile:**
- ACX certification: Fail — RMS check shows exact value and delta from ceiling
- Quality advisory: Not surfaced prominently — fix the certification failure first
- User experience: Clear failure with exact numbers. No ambiguity about what needs to change.

**File processed with Podcast output profile:**
- Output measurements: LUFS, true peak, RMS, noise floor shown as informational values
- ACX certification: Absent
- Quality advisory: `overprocessing` or `over_compression` if applicable
- User experience: Clean measurement report, no pass/fail framing

---

## Changes from Previous Versions

**From processing spec v3.0 and compliance model v1:**

- "Compliance target" renamed to "output profile" throughout. Output profiles drive processing (normalization target, peak ceiling, measurement method). Compliance certification is a separate post-processing step.
- `standard` and `broadcast` compliance targets are retired as certification concepts. The `podcast` and `broadcast` output profiles replace them as loudness targets only — they drive Stage 5 and Stage 6 parameters but do not produce certification output.
- ACX certification is now explicitly the only formal certification standard. For all other output profiles, Stage 7 reports measurements as informational values with no pass/fail framing.
- The aggregate `human_review_risk` Low/Medium/High score is removed. Individual quality advisory flags replace it.
- Quality advisory flags now include a "Mark as reviewed" checkbox interaction in the UI.
- The `noise_floor` check is removed from non-ACX output profile reports entirely — it is not a requirement of any other standard and showing it without a threshold creates confusion.

---

*This document is a companion to `instant_polish_processing_spec_v3.md` and `instant_polish_processing_spec_noise_eraser.md`.*
