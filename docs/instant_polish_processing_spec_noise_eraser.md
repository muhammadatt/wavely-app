# Instant Polish — Noise Eraser Preset Specification
> Addendum to Processing Chain Technical Specification v3.2 | May 2026

---

## Architecture Note

**The `noise_eraser` preset is a standard preset in the unified config-driven pipeline.** It uses the same pipeline runner and stage registry as `acx_audiobook`, `podcast_ready`, and `general_clean`. There is no separate "Noise Eraser pipeline" in the codebase. The preset declares its own `stages` array in `src/audio/presets.js`, and the orchestrator executes those stages like any other preset.

The stage numbering in this document (NE-1 through NE-7) is a **documentation convention only** — it does not exist in the code. The authoritative stage sequence is the `noise_eraser` preset's `stages` array. Use this document for understanding the purpose and parameters of each separation-related stage; use `src/audio/presets.js` for the actual ordering, inline config, and currently active stages.

---

## Overview

This document specifies the `noise_eraser` preset as an addendum to the v3 processing chain specification. It follows the same preset + output profile architecture established in v3.1. Where this document is silent, v3.1 defaults apply.

Noise Eraser's distinguishing characteristic is its use of **source separation** (Demucs) rather than noise reduction filters as its primary voice extraction method. The pre-separation and post-separation stages are otherwise drawn from the same stage registry used by all other presets.

---

## Design Rationale

The standard processing chain (HPF → DF3 → EQ → compression → normalization → limiting) is designed for files where the noise floor is elevated but the voice is the dominant signal. Its noise reduction ceiling (Tier 4, 12 dB max attenuation) reflects a deliberate quality constraint: beyond that ceiling, artifact risk outweighs noise floor benefit.

Noise Eraser is designed for files where that constraint is the wrong tradeoff — where the noise is so severe that the standard chain cannot produce a usable result at any safe attenuation level. The test file that motivated this preset had a pre-processing noise floor of **-7 dBFS**, 38 dB above Tier 5 threshold. For files in this class, the correct framing is not "reduce the noise" but "extract the voice." Source separation is the appropriate tool.

The tradeoff is explicit: Noise Eraser prioritizes noise removal over voice transparency. The output voice may have a slightly processed or "dry booth" quality that the standard chain avoids. This is an acceptable tradeoff when the alternative is an unusable recording.

---

## Preset Registration

The `noise_eraser` preset is defined in `src/audio/presets.js` alongside the other presets.

| Preset ID | Display name | Primary audience |
|---|---|---|
| `noise_eraser` | Noise Eraser | Severely noisy recordings where standard processing has failed |

**Default output profile:** `podcast`

The output profile is user-overridable. However: noise floor enforcement (`acx`) should not be the default for this preset. Source separation does not guarantee a -60 dBFS noise floor, and presenting ACX compliance as the default target would produce misleading pass/fail results. If a user selects `acx` output profile with `noise_eraser`, surface a warning: *"ACX compliance is not recommended for Noise Eraser output. Separation artifacts may cause ACX human review rejection even if measurements pass."*

---

## Processing Chain: Noise Eraser Stage Sequence

The active stage sequence is defined in `src/audio/presets.js`. As of May 2026, the `noise_eraser` stages array runs approximately:

```
decode → measureBefore → peakNormalize → analyzeFramesRaw
→ humDetect → hpf
→ spectralSubtraction → noiseReduce (df3)
→ tonalPretreatment
→ separateVocals (demucs)
→ separationValidation
→ bandwidthExtension (currently disabled — enabled: false)
→ remeasureFramesPostNr
→ vocalExpander (pass 1, conservative)
→ vocalSaturation
→ compress (3 passes)
→ vocalExpander (pass 2, more aggressive)
→ vadGate (currently disabled)
→ autoLevel
→ airBoost → roomPresence (currently disabled)
→ normalize → truePeakLimit → measureAfter
→ acxCertification → qualityAdvisory → encode → extractPeaks
```

**How this differs from standard presets:**
- Uses `tonalPretreatment` → `separateVocals` → `separationValidation` as the core voice extraction path
- No `correctiveEQ` or `referenceEQ` — post-separation tonal correction relies on `airBoost` + `vocalSaturation`
- No `clipGainDeEss` — de-essing on separated audio can further damage already-altered sibilance
- `vocalExpander` runs twice: once before compression (conservative) and once after (more aggressive)
- RNNoise pre-pass described in earlier specs is replaced by spectral subtraction + DF3 before separation
- `bandwidthExtension` is present in the stages array but currently disabled

---

## Stage NE-1 — Pre-separation Noise Reduction

**Current implementation:** The preset runs `spectralSubtraction` followed by `noiseReduce` (DF3) before handing off to Demucs. This replaces the earlier design of a standalone RNNoise pre-pass.

**Purpose:** Reduce the stationary component of the noise floor before source separation. Separation models perform better when the SNR is improved going in, even modestly.

**Stage sequence in current preset:** `spectralSubtraction` (MMSE Wiener with transient shaping) → `noiseReduce { model: "df3" }` → then separation.

**Expected contribution:** Reduces stationary broadband noise before separation. Non-stationary components will be reduced less. The goal is not to fully clean the file — it is to reduce the job Demucs has to do.

**Logging:** Frame analysis (`analyzeFramesRaw`) before this block establishes the pre-processing noise floor.

---

## Stage NE-2 — Tonal Noise Pre-treatment (Conditional)

**Purpose:** Remove strong tonal components (electrical hum, fan resonances, periodic mechanical noise) before separation. Demucs handles broadband noise well but is relatively weak on strong periodic tonal noise — its learned voice model can confuse stable harmonic content with the voice's own harmonics, leading to incomplete separation or voice coloration.

**Trigger condition:** Detect tonal spikes in the pre-NE-1 noise floor measurement. A frequency bin qualifies as tonal if its energy is > 8 dB above the surrounding noise floor in a ±100 Hz window. This is a stricter threshold than the 6 dB used in v3 Stage 1 — the higher threshold prevents over-notching on files where the voice's own harmonics are present in the noise floor measurement.

**Implementation:** FFmpeg `equalizer` filter, narrow notch (Q = 12, -24 dB attenuation) at each detected tonal frequency. Maximum 6 notches applied; if more than 6 tonal components are detected, apply to the 6 highest-amplitude spikes only and log a warning.

**Frequency scan range:** 40 Hz – 2 kHz. Tonal noise above 2 kHz is rare in practice and more likely to be voice harmonics; do not notch above this limit.

**If no tonal components detected:** Skip this stage entirely. Log "No tonal components detected — NE-2 skipped."

---

## Stage NE-3 — Source Separation (Demucs)

**Purpose:** Extract the voice signal from the mixture, discarding all non-voice content.

**Implementation:** Demucs `htdemucs_ft` (fine-tuned hybrid transformer), vocals model. Python `demucs` package, server-side. GPU-accelerated where available; CPU fallback supported.

**Model selection rationale:** `htdemucs_ft` is the fine-tuned variant trained specifically for high-quality vocal separation. It processes both the waveform domain and the spectrogram domain in parallel (hybrid architecture), which improves separation quality on speech compared to spectrogram-only models like Spleeter. The fine-tuned variant outperforms the base `htdemucs` on voice-only content at the cost of marginally higher compute.

**Parameters:**
- `segment`: 7.8 seconds (default; do not reduce — shorter segments introduce audible boundary artifacts on speech)
- `overlap`: 0.25 (25% overlap between segments; standard for speech quality)
- `shifts`: 1 (single shift; higher values improve quality marginally but multiply compute cost proportionally — not warranted for this use case)
- Output: vocals stem only; discard all other stems

**Channel handling:** Demucs accepts stereo input and outputs stereo. If the preset's channel output requires mono (default for `noise_eraser` — see below), apply mid-channel mix-down after separation, not before. Running separation on a stereo signal and converting afterward preserves more separation quality than pre-converting to mono.

**Default channel output:** Mono. Most use cases for Noise Eraser (rescued narration, voice-over, field interview) are mono deliverables. Override available.

**Processing time expectation:** Demucs `htdemucs_ft` on GPU: approximately 5–10x real-time. On CPU: approximately 0.5–1x real-time. A 5-minute file will take approximately 1–2 minutes on CPU. This is the compute-dominant stage in the Noise Eraser path. Surface a progress indicator in the UI; this preset should not show a spinner with no feedback.

---

## Stage NE-4 — Post-separation Validation and Artifact Assessment

**Purpose:** Assess the quality of the separation output before proceeding. Catch cases where separation has introduced significant artifacts or failed to cleanly isolate the voice.

**Measurements:**

**Residual noise floor:**
Measure noise floor of the separated output using the same silence frame method as v3 Stage 2a. The Demucs output will typically show a significantly improved noise floor vs. the input. Record this value — it determines whether NE-5 (residual cleanup) is needed.

**Separation artifact detection:**
Compare spectral flatness of voiced frames before separation (post-NE-1) and after (NE-3 output). Significant increase in spectral flatness in voiced frames is a signal that Demucs has over-separated — flattening spectral content that belonged to the voice. Threshold: spectral flatness increase > 0.15 (on a 0–1 scale) in the 2–8 kHz band → log "Separation artifacts detected in high-frequency voice content. Review output carefully."

**Sibilance assessment:**
Measure energy ratio in the 4–9 kHz band between pre- and post-separation voiced frames. A ratio below 0.6 (i.e., more than 40% of sibilant energy removed) indicates Demucs has over-attenuated fricatives. Log "Sibilance loss detected — bandwidth extension (NE-6) will attempt to restore." This is expected behavior for severely noisy files; NE-6 is designed to address it.

**Breath detection:**
Detect short low-energy voiced-adjacent events in the post-separation output consistent with breath sounds. If the ratio of detected breaths in the post-separation output vs. the pre-separation signal is below 0.5, log "Breath sounds may have been partially removed during separation. Review output for naturalness."

**Voice presence check:**
If no voiced frames are detected in the post-separation output (separation has produced only noise or silence), abort processing and return error: "Voice could not be isolated from this recording. The signal-to-noise ratio may be too low for separation."

---

## Stage NE-5 — Residual Cleanup

**Note:** A separate explicit residual cleanup stage is not currently in the `noise_eraser` stages array. The `noiseReduce` call before separation (NE-1) handles pre-separation noise reduction. Post-separation cleanup is handled by the `remeasureFramesPostNr` + `vocalExpander` combination which attenuates the remaining noise floor in silence gaps.

The design rationale below describes the intended behavior if a post-separation DF3 pass is added:

**Trigger condition:** Post-separation noise floor > -55 dBFS. Light DF3 pass (8 dB max attenuation) to mop up residual bleed. If artifacts are detected, reduce attenuation and re-run once. If the noise floor remains above -55 dBFS after cleanup, report the value as a warning — do not over-process.

---

## Stage NE-6 — Bandwidth Extension

**Current status:** The `bandwidthExtension` stage is present in the `noise_eraser` stages array with `enabled: false`. It can be enabled per-request via `presetOverrides` or by updating the preset config.

**Purpose:** Restore high-frequency voice content attenuated during source separation. Demucs, like all separation models, tends to suppress high-frequency content in noisy conditions because broadband noise and voice air/presence occupy the same spectral region. The output voice can sound dull or "close" compared to the original.

**Implementation:** AP-BWE (Amplitude-Phase Bandwidth Extension). Python script `server/scripts/ap_bwe_extend.py`, using the `APNet_BWE_Model` from the cloned repo at `vendor/ap_bwe`. Server-side.

**Model configuration:** `8kto48k` — assumes maximally degraded narrowband input (8 kHz) and restores full wideband output (48 kHz). This is the most conservative input assumption and is appropriate for separation output where HF content may be severely attenuated. The 48 kHz output is resampled back to the pipeline's 44.1 kHz format by the Node.js stage via `decodeToFloat32`.

**Setup:**
- Clone repo: `git clone https://github.com/yxlu-0102/AP-BWE vendor/ap_bwe`
- Download 8kto48k checkpoint from Google Drive (see `server/requirements.txt`)
- Set `AP_BWE_CHECKPOINT` env var to the `.pt` file path
- `config.json` must be colocated with the checkpoint

**Parameters:**
- Input: post-NE-5 output (or post-NE-3 if NE-5 was skipped)
- Narrowband input rate: 8 kHz (model downsamples internally)
- Output rate: 48 kHz (resampled to 44.1 kHz by caller)

**Availability:** Stage NE-6 is also present in the standard preset pipelines (acx_audiobook, podcast_ready, voice_ready, general_clean), gated by `preset.bwe.enabled`. It is `false` by default for standard presets — enable via preset config to recover HF content attenuated by DeepFilterNet3 at aggressive tiers.

**Skip condition:** If the sibilance assessment in NE-4 showed no significant sibilance loss (ratio ≥ 0.8), and post-separation noise floor is already below -55 dBFS, bandwidth extension is skipped to reduce processing time. Log decision. For standard presets (no NE-4 data), the skip condition does not apply — the stage runs whenever `preset.bwe.enabled` is true.

**Logging:** Record spectral energy in the 8–16 kHz band before and after NE-6. A meaningful increase (> 3 dB) confirms the stage contributed to the output.

---

## Stage NE-7 — Post-separation Enhancement EQ

**Current status:** The `noise_eraser` preset does not currently run `correctiveEQ` or `referenceEQ`. Post-separation tonal correction is handled by `airBoost` and `vocalSaturation`. A full post-separation EQ pass with a separation-specific reference profile is the intended future state.

**Purpose:** Correct tonal imbalances introduced by the separation and bandwidth extension process. The post-separation voice has a different spectral character than a cleanly recorded voice — a separation-specific EQ reference is needed.

**Implementation:** FFmpeg `equalizer` filter, parametric biquad IIR.

**Noise Eraser EQ reference profile:**

The separation process tends to produce a voice that is:
- Slightly thin in the 200–400 Hz body range (Demucs attenuates some lower-mid content along with noise)
- Potentially harsh in the 3–6 kHz presence range if bandwidth extension over-synthesized
- Slightly reduced in the 100–200 Hz warmth range
- Variable in the 8–12 kHz air range depending on how much bandwidth extension contributed

| Band | Trigger condition | Adjustment |
|---|---|---|
| Warmth (100–200 Hz) | Energy > 3 dB below reference | +2 to +3 dB, shelf |
| Body (200–400 Hz) | Energy > 4 dB below reference | +2 to +3 dB, Q = 1.5 |
| Mud (200–400 Hz) | Energy > 3 dB above reference | -2 to -3 dB, Q = 2 |
| Presence (3–6 kHz) | Energy > 3 dB above reference (post-BWE harshness) | -1 to -3 dB, Q = 1.5 |
| Presence (3–6 kHz) | Energy > 3 dB below reference | +1 to +2 dB, Q = 1.5 |
| Air (10–16 kHz) | Energy > 4 dB above reference (BWE over-synthesis) | -2 to -3 dB, shelf |

**Maximum gain constraint:** ±4 dB per band (tighter than v3's ±5 dB — post-separation audio is more sensitive to EQ overcorrection).

**De-esser:** Not applied in the Noise Eraser path. The separation and bandwidth extension process already alters sibilance character significantly. Applying a de-esser on top of that without validated calibration for separated audio risks further sibilance damage. Post-launch, a separation-aware de-esser calibration can be developed if real-world output warrants it.

---

## Stage 5 — Loudness Normalization (v3 standard)

No changes to v3 Stage 5. The normalization target is supplied by the active output profile as normal.

**Default normalization target for `noise_eraser` with `standard` output profile:** -16 LUFS integrated.

**Note:** The silence exclusion logic in v3 Stage 5b (dynamic threshold from measured noise floor) uses the **post-NE-5** noise floor measurement, not the original pre-processing noise floor. This is important — the pre-processing noise floor for Noise Eraser files is often so high that the silence exclusion threshold would incorrectly classify voiced frames as silence.

---

## Stage 6 — True Peak Limiting (v3 standard)

No changes to v3 Stage 6.

---

## Stage 7 — Measurement and Processing Report (NE additions)

The standard v3 Stage 7 report runs as normal. The following additions apply when `preset = noise_eraser`:

**Additional measurements:**
- Pre-RNNoise noise floor (NE-1 input)
- Post-RNNoise noise floor (NE-1 output)
- Post-separation noise floor (NE-3 output)
- Post-residual-cleanup noise floor (NE-5 output, if applied)
- Sibilance ratio (NE-4 measurement)
- Breath detection ratio (NE-4 measurement)
- Bandwidth extension contribution (NE-6 spectral delta)

**Separation quality rating:**
Aggregate the NE-4 assessments into a single separation quality indicator with three levels:

| Level | Conditions | Report display |
|---|---|---|
| Good | No artifact flags, sibilance ratio ≥ 0.7, breath ratio ≥ 0.5 | "Separation quality: Good" |
| Fair | One artifact flag, or sibilance ratio 0.5–0.7, or breath ratio 0.3–0.5 | "Separation quality: Fair — review output" |
| Poor | Multiple artifact flags, or sibilance ratio < 0.5, or breath ratio < 0.3 | "Separation quality: Poor — significant voice content may be affected" |

**Processing report JSON additions:**

```json
{
  "preset": "noise_eraser",
  "separation_pipeline": {
    "rnnoise_pre_pass": {
      "applied": true,
      "pre_noise_floor_dbfs": -7.0,
      "post_noise_floor_dbfs": -18.3
    },
    "tonal_pretreatment": {
      "applied": true,
      "notches": [
        { "freq_hz": 60, "gain_db": -24 },
        { "freq_hz": 120, "gain_db": -24 }
      ]
    },
    "demucs": {
      "model": "htdemucs_ft",
      "post_separation_noise_floor_dbfs": -48.2,
      "sibilance_ratio": 0.71,
      "breath_ratio": 0.62,
      "artifact_flags": []
    },
    "residual_cleanup": {
      "applied": true,
      "tier": 2,
      "post_cleanup_noise_floor_dbfs": -57.1
    },
    "bandwidth_extension": {
      "applied": true,
      "model": "AudioSR",
      "hf_energy_delta_db": 4.2
    },
    "separation_quality": "good"
  }
}
```

---

## Preset Profile Summary

| Parameter | Value | Rationale |
|---|---|---|
| Pipeline | Unified (same runner as all presets) | `noise_eraser` is a preset, not a separate pipeline |
| Pre-separation NR | spectralSubtraction → DF3 | Improves Demucs input SNR |
| Tonal pre-treatment | `tonalPretreatment` (conditional notch filtering) | Removes periodic noise Demucs handles poorly |
| Primary separation | `separateVocals` — Demucs `htdemucs_ft` (default) or ConvTasNet | Voice extraction rather than noise reduction |
| Post-separation validation | `separationValidation` | Artifact assessment, sibilance/breath ratios |
| Residual cleanup | Not currently an explicit stage — handled by vocalExpander | Future: conditional DF3 light pass |
| Bandwidth extension | AP-BWE (present but disabled) | Can be enabled; restores HF lost in separation |
| Post-separation EQ | `airBoost` + `vocalSaturation` | Full corrective/reference EQ not applied to separated audio |
| De-esser | Not applied | Separation already alters sibilance; clip-gain de-esser would need re-calibration |
| Compression | 3 passes (crest-factor driven) | Runs on separated signal |
| Vocal expander | 2 passes (before and after compression) | Addresses noise floor bleed in silence gaps |
| Channel output | Mono | Most Noise Eraser use cases are mono deliverables |
| Default output profile | `podcast` | ACX output profile not recommended for separation output |
| Noise floor enforcement | Not enforced by default | Separation does not guarantee -60 dBFS |

---

## Library Reference (Noise Eraser specific)

| Stage | Library / Tool | License | Cost |
|---|---|---|---|
| Source separation | Demucs `htdemucs_ft` (`demucs` Python package) | MIT | Free |
| Source separation (fallback) | ConvTasNet via `asteroid` | MIT | Free |
| Bandwidth extension | AP-BWE (`ap_bwe`) / LavaSR | MIT | Free |

---

## Processing Time Targets

| Workload | Target | Notes |
|---|---|---|
| Single file, 5 min, GPU | ≤ 3 minutes | Demucs is the dominant stage |
| Single file, 5 min, CPU | ≤ 8 minutes | CPU fallback; surface progress indicator |
| Single file, 20 min, GPU | ≤ 10 minutes | |
| Single file, 20 min, CPU | ≤ 30 minutes | Warn user before processing begins |

Noise Eraser processing times are substantially longer than the standard chain. The UI must surface a time estimate before the user commits to processing, and must show granular progress (which stage is running) rather than a single spinner. For CPU-only servers, consider queuing Noise Eraser jobs separately from standard chain jobs to prevent blocking.

---

## Implementation Sprint

**Sprint NE-1 — Core separation path:**
RNNoise pre-pass → Demucs `htdemucs_ft` vocals separation → post-separation noise floor measurement → DF3 Tier 2 residual cleanup (conditional) → v3 Stage 5–7 → return to browser. Validate on test corpus of high-noise recordings.

**Sprint NE-2 — Full pipeline:**
Tonal pre-treatment (NE-2) → sibilance and breath assessment (NE-4) → AudioSR bandwidth extension (NE-6) → post-separation EQ (NE-7) → separation quality rating in report → processing time estimates in UI.

**Sprint NE-3 — Benchmarking and calibration:**
Build test corpus across noise floor severity levels (-7 dBFS through -45 dBFS). Calibrate NE-4 thresholds (spectral flatness, sibilance ratio, breath ratio) against real-world output. Validate AudioSR guidance scale parameter. Compare Demucs `htdemucs_ft` vs. Spleeter on this corpus to confirm model selection.

---

## Known Limitations

**Non-stationary outdoor noise:** The test file that motivated this preset (pre-noise-floor -7 dBFS, outdoor crowd/ambient) represents the most difficult class of input. Demucs will produce a usable separation on this material but the output will have "Fair" or "Poor" separation quality rating in most cases. This is expected and acceptable — a fair-quality separated voice is more usable than a failed standard-chain output.

**Multiple speakers:** Demucs `htdemucs_ft` separates vocals from non-vocals — it does not separate individual speakers from each other. A multi-speaker file will have all voices in the separated output, which is correct behavior. No change needed, but worth documenting for user expectation management.

**Music backgrounds:** If the input contains music (not just ambient noise), Demucs' separation of voice from music is less clean than voice from noise. Demucs was designed for this use case (music demixing), but musical backgrounds produce more bleed in the vocals stem than noise does. The processing chain handles this without changes; the separation quality rating will reflect the result.

**Very short files (< 10 seconds):** Demucs segment-based processing with 25% overlap can introduce boundary artifacts on very short files. Log a warning for files below 15 seconds: "File is very short — separation quality may be reduced."

---

*This document is an addendum to `instant_polish_processing_spec_v3.md` (v3.1). It should be read alongside the v3.1 spec and `instant_polish_compliance_model_v2.md`, not as a standalone document.*
