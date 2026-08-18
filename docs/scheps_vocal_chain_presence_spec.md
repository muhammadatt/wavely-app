# Scheps Vocal Chain — Preset Spec: "Presence"
> Addendum to `instant_polish_processing_spec_v3.md`
> Version 0.1 | Draft
> (Preset previously referred to during development as "Airy" — renamed; see Naming Note below)
> Status: Curve data measured and validated. Biquad fit and component wiring left to implementation.
> Companion file: `scheps_presence_curve_data.csv` (120-point log-spaced frequency/gain data, 20 Hz–20 kHz)

---

## Overview

The Scheps Vocal Chain replicates Andrew Scheps' Pultec-EQP-1A + LA-2A vocal trick: a passive-EQ push before compression, and a complementary pull-back after it. This document specifies the **Presence** preset for the `PultecStage` / `SchepsVocalChain` effect — the complementary preset to `scheps_vocal_chain_thick_spec.md`.

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

Parallel blend architecture (dry/wet Mix, equal-power crossfade). `PultecStage` is a fixed two-band module — no frequency selectors, no CPS switch. Note the high band's frequency point differs between pre and post stages in this preset (8 kHz boost / 20 kHz cut — see below), same asymmetric-independent-filter requirement as the Thick preset.

---

## Preset: Presence

### Reference Knob Settings

Position values (0–10 scale) on the reference VST3 plugin used for measurement — for reproducibility of the source measurement only.

| Stage | Band | Control | Knob Position |
|---|---|---|---|
| Pre-EQ ("Push") | Low @ 100 Hz | Atten | 3.8 |
| Pre-EQ ("Push") | High @ 8 kHz | Boost | 3.6 |
| Post-EQ ("Recovery") | Low @ 100 Hz | Boost | 2.8 |
| Post-EQ ("Recovery") | High @ **20 kHz** | Atten | 1.8 |

**High Atten frequency is 20 kHz, not 10 kHz** — deliberate, per Andrew Scheps' own stated preference for the 20 kHz Atten setting on the hardware EQP-1A. Do not "correct" this to match the Thick preset's 10 kHz point; it's the source of this preset's character (see Curve Shape Notes).

### Measured Target Curves

Measured via swept-sine (Farina) deconvolution against a reference Pultec EQP-1A emulation, gated to exclude harmonic-distortion pre-echo (confirmed <0.04% of peak IR energy in both stages). Fractional-octave smoothed (1/24 oct). Full 120-point curve in `scheps_presence_curve_data.csv`; key points below.

| Frequency | Pre-EQ (dB) | Post-EQ (dB) | Net (Pre+Post) |
|---|---|---|---|
| 30 Hz | −4.19 | +6.55 | +2.36 |
| 100 Hz | −4.16 | +6.36 | +2.20 |
| 200 Hz | −4.01 | +5.86 | +1.84 |
| 500 Hz | −3.24 | +3.80 | +0.56 |
| 1000 Hz | −1.74 | +1.63 | −0.11 |
| 2000 Hz | +0.27 | +0.08 | +0.35 |
| 4000 Hz | +2.34 | −1.03 | +1.31 |
| 6000 Hz | +3.22 | −1.64 | +1.58 |
| 8000 Hz | +3.44 | −2.06 | +1.38 |
| 10000 Hz | +3.33 | −2.40 | +0.92 |
| 15000 Hz | +2.47 | −3.12 | −0.64 |
| 20000 Hz | +1.35 | −3.88 | −2.53 |

### Curve Shape Notes

- **Net effect peaks in the presence range, not the air range.** Net gain is highest (+1.3 to +1.6 dB) between roughly 4–10 kHz, and turns *negative* above ~14 kHz (down to −2.5 dB at 20 kHz). This preset does not deliver a top-octave lift — it delivers a mid-to-upper-presence lift with a scooped top end. This is the direct, intentional consequence of anchoring the post-EQ cut at 20 kHz (see Naming Note).
- **Pre-EQ low cut and Post-EQ low boost are not mirror images** — same asymmetric behavior documented in the Thick spec, confirmed via isolated boost-alone/cut-alone measurement (see project measurement history).
- **Pre-EQ high band (8 kHz boost) is close to identical to the Thick preset's original v0.1 pre-EQ high band** — both used the same knob setting (3.6) before Thick was revised upward to 5.2 in v0.2. Coincidental shared calibration point, not a design link between presets.

### Naming Note

This preset was developed under the working name "Airy." It was renamed to **Presence** once the measured net curve showed a clear presence-band lift (peaking 6–8 kHz) rather than a genuine top-octave "air" lift — the 20 kHz post-EQ cut nets out the top octave negative, the opposite of what "airy" implies. The name was changed to match measured behavior rather than intent, to avoid the same mismatch this exercise surfaced.

---

## Open Items

- Cross-band interaction not tested (same caveat as Thick preset).
- Only one calibration point measured per curve — no knob-to-gain taper data specific to this preset's settings.
