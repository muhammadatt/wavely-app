# Scheps Vocal Chain — Preset Spec: "Thick"
> Addendum to `instant_polish_processing_spec_v3.md`
> Version 0.2 | Draft
> Supersedes: `scheps_vocal_chain_bassier_spec.md` (v0.1, preset formerly named "Bassier")
> Status: Curve data measured and validated. Biquad fit and component wiring left to implementation.
> Companion file: `scheps_thick_curve_data.csv` (120-point log-spaced frequency/gain data, 20 Hz–20 kHz)

---

## Overview

The Scheps Vocal Chain replicates Andrew Scheps' Pultec-EQP-1A + LA-2A vocal trick: a passive-EQ push before compression, and a complementary pull-back after it. This document specifies the **Thick** preset (formerly "Bassier") for the `PultecStage` / `SchepsVocalChain` effect — the bass-forward end of the preset range. See `scheps_vocal_chain_presence_spec.md` for the complementary preset.

This spec covers target curves, signal path, and control surface — not filter implementation. Biquad topology and fit methodology are left to the developer, per the curve-fit approach already established elsewhere in this project (Maag Air Band precedent).

---

## Signal Chain

```
Input ──┬── dry path ────────────────────────────────────────┐
        │                                                     │
        └── wet path:                                         ├──▶ Mix (equal-power) ──▶ Output Trim ──▶ Output
             PultecStage(pre)  [Low Cut / High Boost]
             → OptoSmooth (existing LA-2A engine, reused as-is)
             → PultecStage(post) [Low Boost / High Cut]
```

Parallel blend architecture (dry/wet Mix, equal-power crossfade). `PultecStage` is a fixed two-band module (low shelf @ 100 Hz, high peaking @ 8–10 kHz) — no frequency selectors, no CPS switch. Each of the four curves below is an **independent filter definition**, not a shared band with a sign-flipped gain — confirmed necessary, since measured boost and cut curves at the same nominal frequency are not mirror images (see Curve Shape Notes).

---

## Preset: Thick

### Reference Knob Settings

Position values (0–10 scale) on the reference VST3 plugin used for measurement — for reproducibility of the source measurement only, not meaningful on other plugins.

| Stage | Band | Control | Knob Position |
|---|---|---|---|
| Pre-EQ ("Push") | Low @ 100 Hz | Atten | 4.2 |
| Pre-EQ ("Push") | High @ 8 kHz | Boost | 5.2 |
| Post-EQ ("Recovery") | Low @ 100 Hz | Boost | 4.6 |
| Post-EQ ("Recovery") | High @ 10 kHz | Atten | 3.2 |

*(v0.1 used Boost 3.6 and Boost 3.8 respectively for the pre/post low-adjacent controls; both were increased in this revision.)*

### Measured Target Curves

Measured via swept-sine (Farina) deconvolution against a reference Pultec EQP-1A emulation, gated to exclude harmonic-distortion pre-echo (confirmed <0.05% of peak IR energy in both stages). Fractional-octave smoothed (1/24 oct). Full 120-point curve in `scheps_thick_curve_data.csv`; key points below.

| Frequency | Pre-EQ (dB) | Post-EQ (dB) | Net (Pre+Post) |
|---|---|---|---|
| 30 Hz | −4.68 | +8.96 | +4.29 |
| 100 Hz | −4.64 | +8.65 | +4.01 |
| 200 Hz | −4.47 | +7.81 | +3.35 |
| 500 Hz | −3.56 | +4.75 | +1.19 |
| 1000 Hz | −1.85 | +1.60 | −0.24 |
| 2000 Hz | +0.55 | −1.06 | −0.51 |
| 4000 Hz | +3.78 | −3.15 | +0.63 |
| 6000 Hz | +5.83 | −4.20 | +1.63 |
| 8000 Hz | +6.45 | −4.88 | +1.57 |
| 10000 Hz | +6.07 | −5.36 | +0.71 |
| 15000 Hz | +4.06 | −6.17 | −2.10 |
| 20000 Hz | +2.24 | −6.90 | −4.65 |

### Curve Shape Notes

- **Pre-EQ low cut and Post-EQ low boost are not mirror images** — different corner behavior and rolloff shape at the same nominal frequency, confirmed via isolated boost-alone vs. cut-alone measurement (see project measurement history).
- **Post-EQ high cut does not shelf off** — continues increasing in magnitude out to 20 kHz. Fit accordingly.
- **Boost knob response is compressive near the top of its range.** Pre-EQ high boost knob moved from 3.6→5.2 (v0.1→v0.2, +44% knob position) but only gained ~+3 dB at 8 kHz (+3.44→+6.45 dB); Post-EQ low boost moved 3.8→4.6 (+21%) for +0.91 dB at 100 Hz. Diminishing returns are expected as the knob approaches the circuit's gain ceiling — relevant if tuning future variants by knob feel rather than target dB.
- **Net character:** strong low-frequency lift (+3.3 to +4.3 dB, 30–200 Hz), near-neutral through the low-mids, a modest presence bump (+1.6 dB peak near 6–8 kHz), and a substantial net cut at the top octave (−2.1 to −4.65 dB, 15–20 kHz). This is a deeper, more pronounced version of the same bass-forward, top-scooped character as v0.1 — consistent with and intentional for this preset's role as the "thick" end of the preset range.

---

## Open Items

- Cross-band interaction (low-band setting affecting high-band curve, or vice versa) not tested. Same-band boost/cut interaction (Boost + Atten together on one band) was confirmed non-additive — see project measurement history — low↔high interaction is a separate, untested question.
- Knob-to-gain taper is only characterized at the specific points measured (v0.1 and v0.2 settings); not a general-purpose calibration curve.
