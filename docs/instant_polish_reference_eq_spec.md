# Instant Polish — Reference EQ Stage
> Specification v1.0 | May 2026
> Addendum to Processing Chain Technical Specification v3.1
> Read alongside the Stage 3a Corrective EQ spec, the Compliance and Quality Review Model, and the Noise Eraser preset spec.

This document supersedes the draft "Stage 3b — Character EQ" spec. It incorporates the design
decisions taken during review: the stage is named **`referenceEQ`** (the `3b` numbering is
deprecated and not used — `3b` already labels both Air Boost and the Dynamic Resonance
Suppressor in the shipped code); v1 ships **one corpus-derived reference curve per preset**
with no voice-type split; and **Air Boost remains a separate, unchanged stage** — it is not
absorbed.

---

## Overview

`referenceEQ` corrects *global* tonal imbalance by comparing a recording's overall spectral
shape against a corpus-derived reference curve and applying a smooth, broad correction that
pushes the recording's tonal balance toward the reference.

It complements the already-shipped **Stage 3a — Corrective EQ** (`correctiveEQ.js`), which
detects and corrects *localised* spectral anomalies (narrow humps and dips) with adaptive
parametric bands. The two are non-overlapping by resolution:

| | Stage 3a — Corrective EQ | `referenceEQ` |
|---|---|---|
| Target | Localised anomalies (resonances, mic colorations) | Broad tonal imbalance (dark/bright across a region) |
| Resolution | 1/3-octave, voiced-frame cepstral envelope | ½-octave, all-speech-frame spectrum |
| Reference | None — measurement-driven | Corpus-derived per-preset curve |
| Order | Runs first | Runs immediately after, on the 3a-corrected signal |

A recording with a mud resonance at 320 Hz needs Stage 3a. A recording that is broadly dark
across the 1.5–5 kHz presence region — a deficiency invisible to localised detection — needs
`referenceEQ`.

`referenceEQ` has two phases:

- **Offline (corpus processing):** Run once per preset to convert a curated set of
  professional recordings into a stored reference curve. Reference curves are static assets
  committed to the repository, updated deliberately.
- **Online (per-recording):** For each recording, measure its spectral shape, compare against
  the preset's reference curve, and derive a smooth broad correction.

---

## Architectural Boundaries

**`referenceEQ` vs. Air Boost.** Air Boost (`airBoost.js`) is **retained unchanged**. The two
stages overlap in the 6–16 kHz region: Air Boost applies a fixed per-preset dB lift modelled
on the Maag EQ4, while `referenceEQ` applies an adaptive correction toward the corpus target.
This overlap is a known v1 limitation — a bright file will receive Air Boost's fixed lift
*and* a (small or negative) `referenceEQ` correction. v1 mitigates this by keeping
`referenceEQ`'s air-region caps conservative (see §B7); a future revision should reconcile the
two stages, with `referenceEQ` the natural long-term replacement for the fixed-gain Air Boost.
**This spec does not modify Air Boost.**

**`referenceEQ` and the Noise Eraser preset.** `referenceEQ` does **not** run for the
`noise_eraser` preset. Source separation alters the spectral character of the voice in ways
that make corpus-derived reference comparisons unreliable — the same reason Stage 3a is
skipped for `noise_eraser`.

**Voice type.** v1 ships **one curve per preset**, aggregated across male and female corpus
files together. There is no voice-type split, no `ambiguous` interpolation, and no F0-based
curve selection. This is a deliberate v1 simplification; a per-voice-type split may be
revisited once the corpus is large enough to support stable per-type medians.

---

## Pipeline Placement

`referenceEQ` runs immediately after the **final** `correctiveEQ` entry in each
non-`noise_eraser` preset's stage sequence. It operates on the corrective-EQ'd signal and
writes a new audio file into the pool, following the existing `ctx.currentPath` convention.

In the shipped presets the EQ stages are not a single contiguous block — `airBoost` runs
earlier in the chain than the final `correctiveEQ`. `referenceEQ` is placed directly after
that final `correctiveEQ`, so its real position is:

```
… → airBoost → … → correctiveEQ → referenceEQ → … → normalize → …
```

That `airBoost` precedes `referenceEQ` is the reason the air-region correction caps are kept
conservative (see Architectural Boundaries).


---

## Prerequisites

| Input | Source | Notes |
|---|---|---|
| 32-bit float PCM, 44.1 kHz, mono | Pre-processing | All internal processing uses this format |
| Stage 3a output audio | `correctiveEQ` | `referenceEQ` operates on the 3a-corrected signal |
| Canonical noise floor | Pre-4 frame analysis (`ctx.results.metrics`) | Used for the speech-frame energy gate |
| Active preset | Pipeline configuration | Selects the reference curve |
| Reference curve files | Offline corpus processing | Loaded from `data/reference_curves/` at startup |

If no reference curve file exists for the active preset, `referenceEQ` logs a warning and
skips. This makes the stage safe to wire into the pipeline before the corpus is sourced.

---

## Part A — Offline: Building and Storing Reference Curves

### A1 — Corpus Structure

Maintain a curated set of professional audio files per preset. Files must be:

- Fully mastered, broadcast-quality recordings (not raw unprocessed audio).
- Representative of the target output sound for the preset (ACX-compliant narration for
  `acx_audiobook`, professionally produced podcast audio for `podcast_ready`, etc.).
- At least 30 seconds of speech content per file after silence removal.
- Processed to the same output profile the preset targets (ACX files at ACX levels, podcast
  files at −16 LUFS).
- A mix of male and female voices (v1 aggregates both into a single curve).

**Minimum corpus size: 8 files per preset.** This is a hard floor, enforced consistently by
the build script — fewer than 8 files risks over-representing individual voice
characteristics in the median. The minimum is the same number everywhere in this spec; there
is no separate lower "absolute" threshold.

> **Sourcing note.** A corpus of mastered commercial recordings raises licensing
> considerations — corpus files are analysis inputs, not redistributed assets, but the source
> of each file should be documented. Only the *derived curve* (an anonymised spectral median)
> is committed to the repository, never the corpus audio itself. `data/corpus/` is
> `.gitignore`d.

Corpus directory layout (no voice-type subdirectories in v1):

```
data/corpus/                  (gitignored — not committed)
  acx_audiobook/
    narrator_01.wav
    narrator_02.wav
    ...
  podcast_ready/
  general_clean/
```

### A2 — Per-File Spectrum Computation

For each corpus file, compute its mean power spectrum across all **speech frames** — not
voiced-only. Sibilants and consonants are unvoiced but contribute meaningfully to
high-frequency character, and the online measurement (§B3) uses the same all-speech basis;
the two must match.

Frames are classified as speech by an energy gate at `noise_floor + 8 dB`. For corpus files,
`noise_floor` is the 10th percentile of per-frame energy. (The online path substitutes the
pipeline's canonical Pre-4 noise floor — see §B3.) The exact floor estimate matters little
because both corpus and recording spectra are subsequently normalised at a fixed reference
band (§A3); only the *shape* is compared.

```
frame_size = 4096, hop_size = 1024, Hann window
for each frame:
    energy_db = 20 * log10( rms(frame) + 1e-10 )
noise_floor = percentile(energy_db, 10)
speech_mask = energy_db > noise_floor + 8
spectrum    = mean( |rfft(frame * hann)|^2  for speech frames )   → dB
```

### A3 — 1/3-Octave Smoothing and Normalisation

Resample the spectrum to the standard ISO 1/3-octave centre frequencies (25 bands), averaging
power within each band's `fc / 2^(1/6) … fc · 2^(1/6)` edges in the **linear** domain, then
converting back to dB. Bands with no FFT bins are marked `NaN` and excluded from all
downstream aggregation.

```
THIRD_OCTAVE_CENTERS =
  [63, 80, 100, 125, 160, 200, 250, 315, 400, 500,
   630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000,
   6300, 8000, 10000, 12500, 16000]
```

Normalise each spectrum to 0 dB at the **mean level in the 800–1200 Hz band**. Normalising at
a band rather than a single bin is robust to narrow features. The correction is therefore a
tonal-*shape* correction; absolute level is handled later by Stage 5 normalisation.

### A4 — Aggregation

Aggregate the normalised per-file spectra using the **median** at each band (ignoring `NaN`).
Median suppresses individual outliers — one atypically dark or bright file does not pull the
reference curve. Also store the P25/P75 interquartile range for diagnostics (not used in the
online correction).

```
reference_levels = nanmedian(spectra, axis=0)
```

If fewer than 8 valid spectra are available, the build fails for that preset.

### A5 — Reference Curve Storage Format

One JSON file per preset, stored in `data/reference_curves/` and committed to the repository.
File naming: `{preset_id}.json`.

One file per non-`noise_eraser` preset defined in `src/audio/presets.js`:

```
data/reference_curves/
  acx_audiobook.json
  podcast_ready.json
  general_clean.json
```

**Versioning.** Two independent version fields, kept distinct:

- `spec_version` — the version of *this spec / the JSON format*. Changes only when the file
  schema changes.
- `corpus_version` — an integer incremented every time the curve is rebuilt from a changed
  corpus. Logged with every correction so a shift in processing behaviour is traceable.

Example (`acx_audiobook.json`):

```json
{
  "preset": "acx_audiobook",
  "spec_version": "1.0",
  "corpus_version": 1,
  "generated": "2026-05-15T00:00:00Z",
  "n_corpus_files": 12,
  "normalization_band_hz": [800, 1200],
  "frequencies_hz": [63, 80, 100, 125, 160, 200, 250, 315, 400, 500,
                     630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000,
                     5000, 6300, 8000, 10000, 12500, 16000],
  "levels_db":     [-9.2, -7.8, -6.1, -4.4, -2.9, -1.6, -0.7, -0.2, 0.3, 0.6,
                     0.4,  0.1,  0.0, -0.3, -1.0, -2.2, -3.8, -5.9, -8.1,
                    -10.6, -13.4, -16.8, -20.2, -25.1, -32.4],
  "levels_db_p25": [],
  "levels_db_p75": []
}
```

When a curve is updated: rebuild from the new corpus, increment `corpus_version`, validate
against known-clean recordings (§Validation), and commit with a message noting the corpus
change. Do not update curves silently.

### A6 — Corpus Build Script

A standalone offline script (`server/scripts/build_reference_curves.py`) builds all curves
from `data/corpus/`. Run when the corpus changes, not on each server start. It enforces the
8-file minimum and writes one JSON per preset to `data/reference_curves/`.

---

## Part B — Online: Per-Recording Correction

### B1 — Reference Curve Loading

`referenceEQ` runs in a `reference_eq.py` subprocess, so the curve JSON is read by that
subprocess on each invocation — the file is small (~25 floats) and the read cost is
negligible against the FIR convolution. The Node stage module caches only the resolved curve
*path* per preset for the process lifetime (`getReferenceCurvePath`), so the on-disk lookup
happens at most once per preset. If no curve file exists for a preset, `referenceEQ` skips
cleanly for it.

### B2 — Recording Spectrum Measurement

Compute the recording's 1/3-octave spectrum using the **same** speech-frame method as the
offline corpus processing (§A2–A3): all speech frames, energy gate, 1/3-octave smoothing,
normalised at 800–1200 Hz. The only difference: `noise_floor` for the gate is the pipeline's
canonical Pre-4 noise floor (`ctx.results.metrics.noiseFloorDbfs`) rather than a re-derived
10th-percentile estimate.

If the recording has too few speech frames to produce a spectrum, skip the stage.

### B3 — Difference, Smoothing, Centering, Taper

1. **Raw correction** = `reference_levels − recording_levels`. Positive = needs boost.
2. **½-octave smoothing** in log-frequency space, applied as a proper weighted (e.g.
   Gaussian) kernel over the 1/3-octave array — *not* a plain neighbour average, which is too
   grid-dependent at this spacing. The kernel σ corresponds to ½ octave.
3. **Unweighted least-squares centering.** Both the recording spectrum and the reference
   curve are normalised at 800–1200 Hz (§A3, §B2), so the raw correction carries an arbitrary
   global dB offset. That offset does not change the correction's *relative shape* (the only
   thing that matters — a constant offset is erased by Stage 5 loudness normalisation), so it
   is free to choose. Subtract the **unweighted mean** of the correction over the actively
   corrected bands; this minimises the total squared excursion, which is what determines how
   hard the per-region caps in §B4 bite. A poorly placed offset forces one region to carry
   its whole correction by moving every other band, pushing the far bands into their caps and
   distorting the realised shape; centering spreads the excursion so no region is forced to
   the cap unnecessarily. The mean is taken **only over the fully active bands** (taper
   factor 1.0, i.e. ≥ 500 Hz) — the tapered low bands are untrusted and would bias the
   offset. Centering is unweighted by design: every actively corrected band's shape error
   counts equally, which is the correct objective for faithful shape reproduction. A
   perceptually weighted offset was considered and rejected — weighting the offset toward the
   presence region collapses it back toward a fixed single-band anchor, recreating exactly
   the clamping concentration centering is meant to avoid.
4. **Low-frequency taper** to zero below 500 Hz: correction = 0 below 150 Hz, linear ramp
   0→full from 150→500 Hz, unchanged above 500 Hz. Applied *after* centering, so the centered
   low-band values are tapered back toward zero. Below 500 Hz, recording-vs-reference
   differences reflect F0 and vocal-anatomy variation more than correctable recording
   problems, and v1 has no voice-type split to disambiguate them.

> The rigorous optimum would choose the offset to directly minimise the *post-clamp* error
> (a cheap 1-D search, since the offset is a single scalar). The unweighted mean lands within
> a fraction of a dB of that for the small caps this stage uses, so v1 ships the mean; the
> cap-aware search is a possible future refinement.

### B4 — Scaling and Per-Region Caps

Apply a conservative scaling factor of **0.65** — correct 65% of the measured gap, leave 35%.
The reference is a *median* of professional recordings, not a ceiling; many excellent
recordings sit slightly below it in some bands, and correcting 100% would over-process them.

Then clamp per region:

| Frequency range | Max boost | Max cut | Notes |
|---|---|---|---|
| Below 500 Hz | +2.0 dB | −2.0 dB | After taper; minimal corrections only |
| 500 Hz – 2 kHz | +3.0 dB | −4.0 dB | Fundamental presence region |
| 2 kHz – 6 kHz | +3.5 dB | −4.5 dB | Upper presence; most audible range |
| 6 kHz – 10 kHz | +2.5 dB | −4.0 dB | Brilliance; sibilance-adjacent |
| 10 kHz – 16 kHz | +2.0 dB | −5.0 dB | Air; cuts more generous than boosts |

The 6–16 kHz boost caps are deliberately conservative because Air Boost also lifts this
region (see Architectural Boundaries).

### B5 — Skip Condition

If the maximum absolute correction after scaling and capping is below **0.5 dB**, skip the
stage and apply no processing — a correction this small is inaudible. Log
`referenceEQ: max correction X dB below 0.5 dB threshold — skipped`.

### B6 — Applying the Correction as a Linear-Phase FIR

The correction is applied as a linear-phase FIR filter. Linear phase introduces no phase
distortion (unlike IIR), which matters for speech intelligibility, and an FIR represents an
arbitrary smooth shape without fitting error. This is a deliberate divergence from the
FFmpeg-based EQ used by `correctiveEQ`/`airBoost`/`humEQ`: a broad smooth match-curve is the
one EQ task where FIR is clearly the right tool. Application runs in a Python script
(`server/scripts/reference_eq.py`, scipy), consistent with the existing Python-script
pattern; the Node stage module spawns it and parses the result, mirroring `correctiveEQ.js`.

**FIR construction — fixed in this revision.** `scipy.signal.firwin2` interpolates **linearly
in linear frequency and linear gain** between the supplied points. Handing it the 25
log-spaced 1/3-octave centres directly under-samples the low end and over-weights the high
end, so the realised filter does not match the intended curve. Instead:

1. Resample the dB correction curve onto a **dense linear-frequency grid** (e.g. 512 points,
   0 Hz → Nyquist) by interpolating in **log-frequency, dB** space.
2. Convert that dense curve to linear gain.
3. Pass the dense grid to `firwin2` (`n_taps = 2049`, odd, Type I, Hann window). Edge values
   extend flat to 0 Hz and Nyquist.

2049 taps at 44.1 kHz gives ~23 ms group delay and ~21 Hz resolution — more than sufficient
for a smooth correction. Apply via `scipy.signal.fftconvolve(audio, fir, mode='same')`; a
single convolution of a symmetric FIR is already linear-phase and `mode='same'` compensates
the group delay. The ~23 ms latency is irrelevant for offline processing.

### B7 — ACX Noise Floor Constraint

When `output_profile = acx` and `referenceEQ` applies any boost in the 150–500 Hz range
(the only sub-500 Hz range that survives the taper), re-measure the noise floor after FIR
application via `remeasureFrames` — the same helper `correctiveEQ` and `airBoost` use. If the
boost has lifted the noise floor above the −60 dBFS ACX ceiling, reduce the sub-500 Hz
correction (regenerate the FIR with that region's caps lowered) and re-apply. Log the cap.
This is rare — sub-500 Hz corrections are already limited to ±2 dB — but must be handled for
ACX compliance.

---

## Online Stage Flow (summary)

```
load reference curve for preset       → skip if absent
measure recording spectrum (§B2)      → skip if too few speech frames
raw correction = reference − recording
smooth (½-octave, log-Gaussian)       (§B3)
center (subtract unweighted mean of   (§B3)
        active bands ≥ 500 Hz)
taper below 500 Hz                    (§B3)
scale ×0.65, clamp per region         (§B4)
if max|correction| < 0.5 dB           → skip (§B5)
build linear-phase FIR (§B6), apply
if acx and sub-500 Hz boost           → noise-floor re-check (§B7)
write new ctx.currentPath, log result
```

---

## Processing Report

`referenceEQ` writes a `reference_eq` result key. The Node report builder
(`buildReport` in `pipeline/index.js`) renders it under `processing_applied` only when the
stage ran and applied a correction, following the existing absent-key convention.

The full correction curve (raw / smoothed / applied dB arrays, plus the recording and
reference spectra) is logged in the processing JSON for diagnostics. The **user-facing**
report shows a simplified summary only, derived from the applied curve:

- Mean correction in 1.5–5 kHz > +0.5 dB → "Presence lifted"; < −0.5 dB → "Presence reduced"
- Mean correction in 6–16 kHz > +0.5 dB → "Air boosted"; < −0.5 dB → "High-frequency reduced"
- Mean correction in 150–500 Hz > +0.5 dB → "Warmth boosted"; < −0.5 dB → "Low-mid reduced"

Show only labels whose band mean exceeds ±0.5 dB. Do not show the stage when it was skipped.
`referenceEQ` raises **no quality advisory flag** — broad tonal adjustment is expected
processing.

### Log entry shape

```json
{
  "stage": "referenceEQ",
  "status": "applied",
  "preset": "acx_audiobook",
  "reference_corpus_version": 1,
  "reference_spec_version": "1.0",
  "n_corpus_files": 12,
  "max_correction_db": 3.67,
  "centering_offset_db": 1.21,
  "fir_taps": 2049,
  "acx_constrained": false,
  "correction_curve": {
    "frequencies_hz": [63, 80, 100],
    "raw_db":      [-0.3, -0.2, 0.1],
    "smoothed_db": [-0.2, -0.1, 0.2],
    "applied_db":  [-0.1, -0.1, 0.2]
  },
  "recording_spectrum_db": [],
  "reference_spectrum_db": []
}
```

---

## Calibration and Validation

Before deploying a new reference curve set:

1. **Clean recording test.** Run `referenceEQ` on known-clean professional recordings from
   outside the corpus. Expected: max correction < 1 dB. A larger correction on a known-clean
   file indicates a corpus problem (unrepresentative files or a normalisation error).
2. **Problem recording test.** Run on recordings with known tonal issues. Verify the
   correction direction is correct (presence deficit → boost) and the magnitude is reasonable.
3. **A/B listening test.** Apply to 3–5 test recordings and blind-listen against the
   uncorrected versions. Corrected versions should sound closer to the reference character
   without sounding processed.

**Spread as a quality indicator.** A wide corpus spread (P75 − P25 > 4 dB at any band)
indicates high corpus variance — the median may not be representative. Investigate whether
outlier files should be removed.

---

## Relationship to Existing Spec

- Stage 3a (Corrective EQ) is **already implemented and shipped** (`correctiveEQ.js`). It
  already retired the v3.1 Stage 3 Enhancement EQ fixed reference profiles. `referenceEQ` is a
  new stage added *after* it, not a co-introduced sibling.
- Air Boost (`airBoost.js`) is **retained unchanged**. It is not absorbed into `referenceEQ`.
- `referenceEQ` does not run for `noise_eraser`.
- The `3b` stage number is deprecated and unused by this spec.

*This document is an addendum to `instant_polish_processing_spec_v3.md` (v3.1).*
