# OptoSmooth Tube Stage — LAEA Capture Protocol

> Companion tooling: `scripts/la2a-tube-capture-tones.mjs`, `scripts/la2a-tube-fit.mjs`
> Reference: `TUBE_DRIVE_LIN` / `TUBE_BIAS` in `src/audio/la2aProcessor.js`

---

## What this answers, and what it does not

OptoSmooth's output tube stage is a fixed, level-driven `tanh` waveshaper:
`f(x) = (tanh(d·x + b) − tanh(b)) / (d·(1 − tanh(b)²))`. Its two constants,
`TUBE_DRIVE_LIN` (`d`) and `TUBE_BIAS` (`b`), are calibrated against a single
published fact — the LA-2A's own spec of under 0.5% THD at nominal level — at
one operating point. That is not a capture, and the code says so.

Analog Obsession's **LAEA** is a free LA-2A emulation this codebase already
uses as a reference for the sidechain taper (`SC_DRIVE_MAX_DB` and friends).
This protocol captures its own output-stage harmonic content and fits our two
constants against it, the same way the taper was fitted — with the difference
that harmonic ratios (dBc) are immune to a plugin's overall output trim, where
the taper's target (dB of gain reduction) was not. See the header comment in
`la2a-tube-capture-tones.mjs` for why that removes a whole step the taper fit
needed (no bypass reference, no insertion-gain correction).

**What it can settle:** whether `d` and `b` should move, and by how much, to
better match one plugin's model of the hardware at one operating point per
level.

**What it cannot settle:** whether LAEA's model is itself faithful to a real
LA-2A. There is no hardware capture in this repo, and none is claimed by
fitting to LAEA. If a bench measurement of a real unit, or a manufacturer's
own THD-vs-level curve, ever turns up, it outranks this — the same way this
protocol's opening move is to check whether LAEA is worth measuring at all.

---

## Before anything else: the null test

**Analog Obsession plugins are free and sometimes light on the nonlinearity
they're modelling.** The last time this codebase went to LAEA for a
constant — the R37 side-chain emphasis — the control taken for it turned out
to be a mix knob, and its `HPF` toggle turned out to be an unrelated utility
filter. Fitting to it would have calibrated one control against a different
one and recorded the result as measured.

So before capturing anything: insert LAEA on a track, feed it a steady 1 kHz
tone at −6 dBFS, Peak Reduction at 0, and turn the Gain knob up. **If the
output doesn't visibly distort — if THD doesn't rise with Gain — stop here.**
A flat plugin answers nothing, and the rest of this protocol is not worth the
time. If it does distort and rises with Gain, proceed.

---

## Generate the stimulus

```
npm run la2a:tube:tones
```

Writes 17 tones (32-bit float WAV, 96 kHz) to
`data/corpus/la2a/tube_capture/tones/` — gitignored, like everything under
`data/corpus/`. Re-running this regenerates the same files deterministically;
nothing here needs to be committed or backed up.

### Session setup, once

- **Session sample rate: 96 kHz or higher.** The frequency sweep goes up to
  5 kHz and harmonics are read through H8 — 40 kHz — which needs headroom
  above it. 44.1/48 kHz sessions will alias the top of that sweep back into
  the harmonics being measured.
- **Bounce at 24-bit or 32-bit float.** 16-bit dither sits around −96 dBFS,
  which is louder than several of the harmonics this is trying to read at the
  quiet end of the level sweep.
- Insert LAEA alone on the track. No other processing, track fader at unity,
  clip gain at 0 dB.
- Disable any auto-gain / output-trim feature the plugin offers, if it has
  one. This protocol wants the plugin's own transfer function, not its idea
  of how loud the result should be.

### Per capture

1. Load a tone from `tones/`.
2. Set Peak Reduction and Gain per the sweep it belongs to (below).
3. **Watch the plugin's own gain-reduction meter. It should read 0 dB
   throughout.** If it doesn't, Peak Reduction isn't actually disengaged and
   the capture is measuring the cell's gain modulation, not the tube.
4. Bounce the full 3.0 s clip (a little tail is fine — the analysis reads
   only the last 1.5 s, ending 0.5 s before the file's end, so head latency
   and an imprecisely-trimmed start don't matter as long as the file is at
   least ~3 s).
5. Save under the **exact filename described below** into
   `data/corpus/la2a/tube_capture/captures/` — the fit script matches by
   filename, not by a manifest, so the name is the whole contract.

---

## The three sweeps

### 1. Level sweep — this is the one that calibrates the curve

**1 kHz, Gain 0, Peak Reduction 0.** Eight tones,
`level_01000hz_{-040,-030,-024,-018,-012,-006,-003,-001}dbfs.wav`. Bounce each
one, save under its own filename unchanged.

This needs no assumption about what the plugin's Gain knob does — the only
thing driving the tube here is the input level, which the generated tone sets
exactly. 1 kHz because that's the frequency hardware THD specs are
conventionally quoted at, including the LA-2A's own, so a bench figure or a
datasheet number is comparable without a correction.

### 2. Frequency sweep — a hold-out, not more fit data

**−6 dBFS, Gain 0, Peak Reduction 0.** Seven tones,
`freq_{00050,00100,00200,00500,01000,02000,05000}hz_-006dbfs.wav`.

Our shaper is memoryless, so it predicts *identical* harmonic ratios at every
frequency for a given level — that's a testable claim, not a free parameter.
`la2a-tube-fit.mjs` deliberately does not fit against this sweep, because
including it would let an optimiser paper over a frequency dependence instead
of revealing one. If a real LA-2A's output transformer saturates low
frequencies harder than high ones — plausible; that's what output
transformers do — no retuning of `TUBE_DRIVE_LIN` or `TUBE_BIAS` can
reproduce it, because neither constant has a frequency axis. That would mean
the memoryless curve is the wrong *shape* for this stage, which is a
structural finding, not a tuning one.

### 3. Gain-knob sweep — qualitative only

**1 kHz, −18 dBFS input (the app's own `NOMINAL_DBFS`), Peak Reduction 0.**
One tone, `gain_01000hz_-018dbfs.wav`, bounced multiple times at different
Gain settings.

Save each bounce as `gain_01000hz_-018dbfs_g<label>.wav`, where `<label>` is
whatever you want printed as the x-axis — a dB reading if the plugin shows
one (`g+00`, `g+06`, `g+12`, `g+18`, `g+24`), or just an ordinal
(`g1`, `g2`, `g3`...) if it doesn't. The fit script does not parse `<label>`
as a number for anything quantitative; it prints it as a category and checks
that THD rises monotonically with it.

**Why this doesn't feed the fit.** The level sweep already calibrates the
curve without trusting the Gain knob's printed value at all. This sweep exists
to confirm the same thing happens through the plugin's actual control — the
"makeup drives the tube" claim, checked end-to-end rather than only via a
level this protocol sets itself.

**Optional calibration check, if you want the knob label to mean something:**
compare a gain-sweep capture's measured H2/H3 against the level-sweep
capture whose *input level* equals `-18 + <knob reading in dB>`. If they
agree, the knob reads in dB relative to the same reference this stage uses,
and the label can be read quantitatively. If they don't, the knob's taper or
reference point differs from ours — informative on its own, and worth noting
in whatever writeup follows.

### Noise floor (recommended, not required)

Bounce `noise_silence.wav` — digital silence — through the same signal chain
at Peak Reduction 0, Gain 0. Without it, the fit script still runs; it just
can't flag harmonics that are actually reading the plugin's own noise rather
than the tube.

---

## Run the analysis

```
npm run la2a:tube:fit            # report only
npm run la2a:tube:fit -- --fit   # also search for a better (d, b)
```

Reports every sweep's measured harmonics against the currently shipped
constants, flags anything within 6 dB of the measured noise floor (excluded
from the fit), and warns if the two quietest level-sweep captures disagree on
fundamental gain by more than 0.5 dB — the tube itself shouldn't touch the
fundamental that quietly, so a mismatch there usually means Peak Reduction
wasn't fully disengaged (see step 3 above).

`--fit` runs a small Nelder-Mead search (same routine `fit-pultec-curves.mjs`
uses) against the level sweep only, and prints a candidate `(d, b)` alongside
the current constants' own objective value for comparison.

**It does not write to `la2aProcessor.js`.** Unlike the Pultec curve fitter's
`--write`, there is no auto-apply here. `TUBE_DRIVE_LIN` and `TUBE_BIAS` are
constants that move the sound of a shipped plugin, and — like the R37 taper
before them — belong hand-written into the source with the capture's own
evidence in the comment next to them, not committed by a script on its own
judgement.

---

## Reading the result

- **If the fit barely moves `(d, b)`** — the old calibration (a spec figure
  at one point) and a real capture (eight points across the travel) agree,
  which is worth recording as independent confirmation rather than nothing
  happening.
- **If the fit moves it and the frequency sweep still agrees with the level
  sweep at every frequency** — update the constants, with the capture's
  numbers in the comment, the same way `SC_DRIVE_MAX_DB` records its eight
  captures.
- **If the frequency sweep disagrees with the level sweep** — this is the
  finding that matters most and the one no refit can absorb: the memoryless
  curve is missing a mechanism (frequency-dependent saturation, i.e.
  something transformer-shaped) that no amount of retuning `d` or `b` can
  add. That's a scope question for a different, larger change — not this
  protocol's to resolve.
