# Instant Polish — Noise Eraser Preset Specification
> Addendum to Processing Chain Technical Specification v3.1 | April 2026

---

## Overview

This document specifies the `noise_eraser` preset as an addendum to the v3 processing chain specification. It follows the same preset + output profile architecture established in v3.1. Where this document is silent, v3.1 defaults apply.

Noise Eraser is a **parallel processing path**, not an extension of the standard noise reduction chain. It does not use the Stage 1–6 chain defined in v3. It replaces Stages 1–4a with a source separation pipeline, then rejoins the standard chain at Stage 5 (Loudness Normalization) and Stage 6 (True Peak Limiting). Stage 7 (Measurement and Processing Report) runs as normal with noise-eraser-specific additions.

---

## Design Rationale

The standard processing chain (HPF → DF3 → EQ → compression → normalization → limiting) is designed for files where the noise floor is elevated but the voice is the dominant signal. Its noise reduction ceiling (Tier 4, 12 dB max attenuation) reflects a deliberate quality constraint: beyond that ceiling, artifact risk outweighs noise floor benefit.

Noise Eraser is designed for files where that constraint is the wrong tradeoff — where the noise is so severe that the standard chain cannot produce a usable result at any safe attenuation level. The test file that motivated this preset had a pre-processing noise floor of **-7 dBFS**, 38 dB above Tier 5 threshold. For files in this class, the correct framing is not "reduce the noise" but "extract the voice." Source separation is the appropriate tool.

The tradeoff is explicit: Noise Eraser prioritizes noise removal over voice transparency. The output voice may have a slightly processed or "dry booth" quality that the standard chain avoids. This is an acceptable tradeoff when the alternative is an unusable recording.

---

## Preset Registration

Add to the preset table in v3 § "Presets":

| Preset ID | Display name | Primary audience |
|---|---|---|
| `noise_eraser` | Noise Eraser | Severely noisy recordings where standard processing has failed |

**Default output profile:** `standard`

The output profile is user-overridable. However: noise floor enforcement (`acx`) should not be the default for this preset. Source separation does not guarantee a -60 dBFS noise floor, and presenting ACX compliance as the default target would produce misleading pass/fail results. If a user selects `acx` output profile with `noise_eraser`, surface a warning: *"ACX compliance is not recommended for Noise Eraser output. Separation artifacts may cause ACX human review rejection even if measurements pass."*

---

## Processing Chain: Noise Eraser Path

```
Input
  │
  ├── Pre-processing (decode, resample, channel handling) — same as v3
  │
  ├── Stage NE-1:  Pre-separation RNNoise pass
  ├── Stage NE-2:  Tonal noise pre-treatment (conditional)
  ├── Stage NE-3:  Demucs source separation (htdemucs_ft, vocals model)
  ├── Stage NE-4:  Post-separation validation and artifact assessment
  ├── Stage NE-5:  Residual cleanup (conditional light DF3 pass)
  ├── Stage NE-6:  Bandwidth extension (AudioSR)
  ├── Stage NE-7:  Post-separation enhancement EQ
  │
  ├── Stage 4a:    Serial compression (standard DSP)
  ├── Stage 4a-PC: Parallel compression (wet/dry blend)
  ├── Stage 4a-E:  Vocal Expander (frequency-selective silence-floor attenuator)
  ├── Stage 4b:    Auto Leveler (VAD-gated gain riding, conditional)
  │
  ├── Stage 5:     Loudness Normalization (v3, standard path)
  ├── Stage 6:     True Peak Limiting (v3, standard path)
  └── Stage 7:     Measurement + Processing Report (v3, with NE additions)
```

**Stages skipped vs. v3 standard chain:**
- Stage 1 (High-Pass Filter) — subsumed by NE-2 tonal pre-treatment and Demucs separation
- Stage 2 (Adaptive Noise Reduction / DF3) — replaced by NE-1 through NE-5
- Stage 3 (Enhancement EQ) — replaced by NE-7 (post-separation EQ, different reference profile)
- Stage 4 (De-esser) — not applied; separation-induced sibilance changes are addressed in NE-7

**Note on compression:** The Noise Eraser path now includes Stage 4a / 4a-PC compression (aligned with the standard chain) followed by Stage 4a-E (vocal expander) and Stage 4b (auto leveler). The expander is calibrated from the measured silence P90 on the *current* signal regardless of what produced it, so the absence of upstream compression (for `clearervoice_eraser`) does not break calibration. Output crest factor is still logged; if below 8 dB after normalization, a warning appears in the report.

---

## Stage NE-1 — Pre-separation RNNoise Pass

**Purpose:** Reduce the stationary component of the noise floor before handing off to Demucs. Source separation models perform better when the SNR is improved going in, even modestly. RNNoise is cheap to run and provides a meaningful pre-reduction with minimal artifact risk at this stage.

**Implementation:** RNNoise (Mozilla). Python `pyrnnoise` bindings or equivalent server-side wrapper.

**Parameters:**
- Apply unconditionally to all `noise_eraser` files — no tier gating
- No attenuation ceiling — allow RNNoise to operate at its natural output level
- Do not apply post-pass artifact check at this stage; artifact assessment runs after full separation in NE-4

**Expected contribution:** Approximately 5–10 dB reduction of stationary broadband noise. Non-stationary components (wind, crowd, variable ambient) will be reduced less. The goal is not to clean the file — it is to reduce the job Demucs has to do, improving separation quality on the residual.

**Logging:** Record pre-RNNoise and post-RNNoise noise floor in processing report.

---

## Stage NE-2 — Tonal Noise Pre-treatment (Conditional)

**Purpose:** Remove strong tonal components (electrical hum, fan resonances, periodic mechanical noise) before separation. Demucs handles broadband noise well but is relatively weak on strong periodic tonal noise — its learned voice model can confuse stable harmonic content with the voice's own harmonics, leading to incomplete separation or voice coloration.

**Trigger condition:** Detect tonal spikes in the pre-NE-1 noise floor measurement. A frequency bin qualifies as tonal if its energy is > 8 dB above the surrounding noise floor in a ±100 Hz window. This is a stricter threshold than the 6 dB used in v3 Stage 1 — the higher threshold prevents over-notching on files where the voice's own harmonics are present in the noise floor measurement.

**Implementation:** FFmpeg `equalizer` filter, narrow notch (Q = 12, -24 dB attenuation) at each detected tonal frequency. Maximum 6 notches applied; if more than 6 tonal components are detected, apply to the 6 highest-amplitude spikes only and log a warning.

**Frequency scan range:** 40 Hz – 2 kHz. Tonal noise above 2 kHz is rare in practice and more likely to be voice harmonics; do not notch above this limit.

**If no tonal components detected:** Skip this stage entirely. Log "No tonal components detected — NE-2 skipped."

---

## Stage NE-3 — Demucs Source Separation

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

## Stage NE-5 — Residual Cleanup (Conditional)

**Purpose:** Mop up residual noise bleed that Demucs did not fully suppress. Separation is not perfect — low-level background content bleeds through, particularly in the high-frequency range.

**Trigger condition:** Post-separation noise floor (measured in NE-4) > -55 dBFS. If the noise floor is already below -55 dBFS, skip this stage.

**Implementation:** DeepFilterNet3, light pass. Tier 2 ceiling (8 dB max attenuation). This is a cleanup pass, not a primary reduction pass — DF3 is being asked to handle a much smaller residual problem than in the standard chain. Apply conservatively.

**Artifact check:** Run post-pass spectral flatness check as in v3 Stage 2c. If artifacts are detected, reduce DF3 attenuation by 50% and re-run once. If artifacts persist, skip NE-5 and log "Residual cleanup skipped — artifact risk. Residual noise floor: [X] dBFS."

**If noise floor is still above -55 dBFS after NE-5:** Do not apply further reduction. Log the measured value. Report will surface this as a warning, not a failure — the separation has already done the primary work, and the residual is likely low-amplitude non-stationary content that further processing cannot cleanly address.

---

## Stage NE-6 — Bandwidth Extension

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

**Purpose:** Correct tonal imbalances introduced by the separation and bandwidth extension process. The post-separation voice has a different spectral character than a cleanly recorded voice — the EQ reference used in v3 Stage 3 is calibrated for recorded voices, not separated voices. A separation-specific reference is needed.

**Implementation:** FFmpeg `equalizer` filter, parametric biquad IIR. Same implementation as v3 Stage 3, different reference profile.

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
| Processing path | Parallel (NE-1 through NE-7) | Replaces v3 Stages 1–4a |
| Pre-separation pass | RNNoise (unconditional) | Improves Demucs input SNR |
| Tonal pre-treatment | Notch filtering (conditional) | Removes periodic noise Demucs handles poorly |
| Primary separation | Demucs `htdemucs_ft` | Voice extraction rather than noise reduction |
| Residual cleanup | DF3 Tier 2 (conditional, > -55 dBFS) | Mops up separation bleed |
| Bandwidth extension | AudioSR | Restores high-frequency content lost in separation |
| Post-separation EQ | Separation-specific reference profile | Corrects tonal imbalances from separation process |
| De-esser | Not applied | Separation already alters sibilance; calibration not validated |
| Compression | Not applied | Separation output has compressed character; avoid stacking |
| Channel output | Mono (default) | Most Noise Eraser use cases are mono deliverables |
| Default output profile | `standard` | ACX output profile not recommended for separation output |
| Noise floor enforcement | Not enforced by default | Separation does not guarantee -60 dBFS |

---

## Library Additions

Add to the Library Reference table in v3:

| Stage | Library / Tool | License | Cost |
|---|---|---|---|
| Pre-separation noise reduction | RNNoise (`pyrnnoise`) | BSD | Free |
| Source separation | Demucs `htdemucs_ft` (`demucs` Python package) | MIT | Free |
| Bandwidth extension | AudioSR (`audiosr` Python package) | MIT | Free |

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
