# FET Punch (1176) — Reference Capture Protocol

> Companion tooling: `scripts/fet-ballistics.mjs`, `scripts/lib/gainTrace.js`
> Target constants: `src/audio/fet1176Processor.js`
> Read alongside `docs/la2a_tube_capture_protocol.md` — it is the precedent for
> most of the warnings here, and it is also the record of what happens when they
> are ignored.

---

## What this measures and why it exists

**Not one constant in `fet1176Processor.js` has been measured against
anything.** The input taper and its −18 dBFS threshold reference, the four ratio
knees, both ballistics ranges, `TAIL_FRACTION` / `TAIL_MULT`, all seven
all-buttons-in constants and `fetDrive` were each chosen to reproduce a
*described* behaviour — a datasheet number, a review, a general account of what
an 1176 does. The module's header says so plainly. OptoSmooth went through the
same phase and came out the other side with three constants that had been
fitted to the wrong plugin entirely.

The references are **Analog Obsession FETish** and **Waves CLA-76**.

⚠ **BOTH ARE PLUGINS. NEITHER IS EVIDENCE ABOUT HARDWARE.** A plugin capture is
a reference, not a measurement of a real 1176, and this protocol does not claim
otherwise. Two precedents in this repo, both expensive:

- LAEA was asked for an output-stage saturation **it does not model at all** —
  four bounces to find out, after a protocol had been written for twenty-two.
- Two LA-2A captures that "looked like one dataset" were a plugin and an analog
  unit of unknown provenance, and they **disagreed exactly where it mattered**.
- Analog Obsession ships **two** opto compressors and only one of them is an
  LA-2A. Eight captures were fitted to the wrong one, and the Peak Reduction
  taper — the law the whole plugin is calibrated through — had to be redone.

So: **label every capture with its reference and its settings**, fit one
reference, hold the other out, and **do not average them.**

---

## Step 0 — Control parity, before any bounce

You cannot fit a knob until you know what it is. Fill this in for each plugin
and keep it with the captures. A row you cannot confirm is a row that does not
get fitted.

| Our param | Expected control | FETish | CLA-76 |
|---|---|---|---|
| `inputDrive` | Input — attenuator into a fixed threshold, feeding **both** the audio path and the detector | | |
| `outputGainDb` | Output — makeup, **after** the FET stage | | |
| `attack` | Attack dial 1–7, **7 = fastest** | | |
| `release` | Release dial 1–7, **7 = fastest** | | |
| `ratio` | Buttons 4 / 8 / 12 / 20 | | |
| `ratio: 'all'` | All buttons in ("British mode") | | |
| `fetDrive` | *(no control — driven by level alone)* | | |
| `scHpfHz` | *(not on the hardware; a modern extension)* | | |
| — | Anything else the plugin has | | |

⚠ **THE DIALS ARE REVERSED ON THE HARDWARE AND EVERY EMULATION KEEPS THAT.**
7 is the *fastest* position on both Attack and Release, not the slowest. Confirm
it on the panel before you start — a capture matrix run backwards fits the
ballistics inside out and every number in it looks plausible.

⚠ **TURN OFF ANYTHING THAT IS NOT THE COMPRESSOR.** CLA-76 has an analog-noise
control; any hiss it adds lands in the recovered gain trace as gain that is not
gain, and it is worst exactly where the trace is most sensitive — near the
probe's zero crossings. Same for any mix/blend control (set fully wet), any
sidechain filter (off), and any auto-gain or output-normalisation feature. This
protocol wants the plugin's transfer function, not its opinion about level.

⚠ **CLA-76 HAS MORE THAN ONE MODEL** (component buttons). Pick one, write down
which, and never change it mid-matrix. They are different units.

---

## Step 1 — The null test. Four bounces, not thirty-eight.

The full matrix is 38 bounces per reference. Spend four first, because they can
disqualify a reference or tell you a control is not what it says.

Use **`thd.wav`** for all four. Session set up as in Step 2 below.

| # | Settings | What it answers |
|---|---|---|
| 1 | Input at **minimum**, ratio 4, Output unity | Insertion gain, and whether there is any nonlinearity with **no** gain reduction. GR meter must read 0. |
| 2 | Same as 1, but **Output +10 dB** | Is Output a clean multiply, or does it drive something? On the hardware it sits after the FET and feeds a class-A amp. |
| 3 | Input high enough for **~10 dB of GR**, Output unity | Does distortion rise with **gain reduction**? This is the axis that matters. |
| 4 | `stairs.wav`, Input 50, ratio 4 | Sanity: is the plugin actually in circuit? |

**How to read them:**

- **Bounce 4 comes back bit-identical to the stimulus** → the plugin is
  bypassed, or the bounce exported the source track. Every reading downstream
  will say "no compression", which looks exactly like "the Input knob is too
  low". Fix this before anything else.
- **1 and 2 are both perfectly linear, and 3 distorts** → the nonlinearity lives
  with the gain cell, not the output amp. That is what `fetDrive` should be
  fitted against, and it is the same answer the Moore paper reached for the
  LA-2A after two years of a model that put it in the valves.
- **2 distorts and 3 does not** → the reference's Output drives a stage; our
  model has no such thing, and `fetDrive` cannot be fitted from it.
- **Nothing distorts anywhere** → this reference has no output stage modelled.
  It is still perfectly good for ballistics and the static curve. **Say so in
  the capture log and stop asking it about `fetDrive`.** This is the LAEA
  outcome and it is not a failure of the protocol.

---

## Step 2 — Session setup, once per reference

```
npm run fet:stimulus
```

Writes four 32-bit float mono WAVs at 96 kHz to
`data/corpus/fet1176/stimulus/` (gitignored, like everything under
`data/corpus/`). Re-running regenerates them deterministically; nothing needs
committing or backing up.

- **Session sample rate 96 kHz.** Pass `--rate 192000` and run there instead if
  the session can — `ATTACK_FASTEST_S` is 20 µs, which is 1.92 samples at 96 kHz
  and 3.84 at 192. ⚠ **Capture at the same rate the stimulus was written at.** A
  rate mismatch is not recoverable downstream.
- **Bounce at 32-bit float, no dither.**
- **The plugin alone on the track.** Fader at unity, clip gain 0 dB, no other
  processing anywhere in the path including the master bus.
- **Disable plugin delay compensation, or write down that it is on.** A constant
  latency is removable by alignment. What is not removable is a host quietly
  compensating by a number it will not tell you, while the trace is being read
  as an attack time.

### ⚠ Start every bounce at the file's first sample

The events are **positioned around the Waves demo mute** — measured across nine
captures from three sessions: first at 20.01 s, then every 20.00 s, lasting
0.99 s. **That grid is relative to the render's start, not the file's**, so a
bounce with pre-roll slides every event into the mutes it was placed to avoid,
and the only symptom is events going missing.

The scheduling runs for both references. FETish does not mute, and scheduling
around a mute that is not there costs only a slightly longer rest — which is
the point: **one stimulus serves both, and two references measured on two
different stimuli cannot be compared.**

---

## Step 3 — The capture matrix

38 bounces per reference. **The stimulus files do not change across it. Only the
plugin's knobs do.**

### `stairs.wav` — static curve (20 bounces)

44.6 s. Fifteen 1 s steps from −45 to −3 dBFS in 3 dB.

**Ballistics: attack 1 (slowest), release 7 (fastest), for both files, always.**
Both halves matter and neither is arbitrary:

- The detector is a bare full-wave rectifier with no smoothing, so at a **fast**
  attack the gain tracks |sin| *within* the cycle — the trace swings between no
  reduction at the crossings and full reduction at the peaks, and there is no
  settled value to read. The slowest attack (800 µs against a 250 µs probe
  period) smooths that into a steady, peak-referenced number, which is the
  quantity the static curve is defined on.
- The **fastest** release then settles each step in ~200 ms, so the steps can sit
  1.5 s apart instead of needing ten.

| | |
|---|---|
| ratio | 4 / 8 / 12 / 20 / all |
| Input | 20 / 40 / 60 / 80 |

⚠ **SWEEPING INPUT LOOKS REDUNDANT AND THAT IS EXACTLY WHY IT IS IN THE
MATRIX.** Our model says drive and level add in dB, so a level staircase at
fixed Input and an Input sweep at fixed level are the same experiment. If the
curves **collapse onto one another** when shifted by the knob's dB, the additive
model holds and **the shift that collapses them is the taper, measured
directly**. If they do not collapse, the Input knob is doing something our model
does not have, and that is a finding worth the twenty bounces on its own.

### `bursts.wav` — ballistics (14 bounces)

83.1 s. Four holds at −12 dBFS: 50 ms at t=2.0, 200 ms at 22.1, 1 s at 42.1,
3 s at 62.1. Ratio 4, Input 50 throughout.

| | |
|---|---|
| attack sweep | attack **1…7** at release 4 — 7 bounces |
| release sweep | release **1…7** at attack 7 — 7 bounces |
| all-buttons | ratio **all**, attack 4, release 4 — 1 bounce |

Sweeping the **hold length** is what separates the release tail from the main
release: a single time constant recovers identically after every hold, and a
two-stage network does not. ⚠ It is also the check that caught a mislabelled
LA-2A capture — a release trace *bit-identical* after 50 ms and 10 s cannot be a
photocell, and that signature is how an 1176 got into the LA-2A corpus.

### `frequency.wav` — hold-out (1 bounce)

57.0 s. The same −12 dBFS step at 100 / 400 / 1000 / 4000 / 10000 Hz. Ratio 4,
Input 50, attack 1, release 7.

⚠ **HOLD-OUT, NOT FIT DATA, AND IT MUST STAY THAT WAY.** The hardware's detector
is broadband and ours models it that way, so the settled reduction has to be
*identical* at every probe frequency. That is a testable claim rather than an
assumption baked into the model. If a reference ducks 100 Hz harder than 4 kHz,
no retuning of the taper or the knee can reproduce it — it would mean the
detector needs a filter, not that a constant is wrong. Keeping it out of the fit
is the only thing that lets it answer that. (The LA-2A's side-chain turned out
to be HF-tilted by 2.5 dB, and ours tilted the other way. Nobody guessed it.)

### `thd.wav` — distortion (3 bounces)

26.6 s. Five 3 s tones at 1 kHz: −30, −24, −18, −12, −6 dBFS. Ratio 4, attack 1,
release 7. Input **20 / 50 / 80**.

⚠ **THE AXIS IS GAIN REDUCTION, NOT INPUT LEVEL.** THD against input level
cannot tell a gain-cell nonlinearity from an output-amp one. THD against dB of
GR can. Record the plugin's GR meter reading for each tone at each Input
position — **that is the x-axis**, and without it these three bounces measure
the wrong thing.

⚠ **WATCH FOR THE REFERENCE CLIPPING AT INPUT 80.** A −6 dBFS tone with the
Input knob up drives the audio path hot; if the output exceeds 0 dBFS, bring it
back with **Output**, which sits after the FET and therefore does not change
harmonic content measured in dBc. Note the trim you used.

---

## Step 4 — What to write down

Captures go in `data/corpus/fet1176/captures/`, gitignored — `*.wav` is ignored
repo-wide, so no licensed audio reaches the repo.

Name each file for its cell and keep a log beside them:

```
<reference>_<stimulus>_<ratio>_in<input>_a<attack>_r<release>.wav

fetish_stairs_r8_in60_a1_r7.wav
cla76_bursts_r4_in50_a3_r4.wav
```

Per capture, log: reference and version, model/component variant, every knob
position, **the GR meter reading**, the Output trim if any, session rate, and
whether delay compensation was on. Provenance is part of the measurement.

---

## ⚠ What the tooling already knows that you should not re-derive

Two things were settled by running `npm run fet:selftest` against our own kernel
— whose constants are known exactly — **before any reference was touched**. Both
would have been invisible in a result fitted from reference captures alone.

**1. Coherent detection cannot measure this unit, so the gain is recovered by
division.** The LA-2A suite demodulates at the probe and low-passes at ≤500 Hz:
two poles rising in ~0.8 ms, fine against a 1–10 ms opto attack. Against 20 µs
it would report every dial from about 5 upward as the *detector's* own rise
time, **and that number would look like a measurement.** The FET suite divides
the capture by the known stimulus instead — no filter in the path, so resolution
is the sample period. Verified at 2.8e-17 reconstruction error. The probe is
4 kHz rather than 1 kHz because division is blind while the probe is near zero,
for `asin(floor)/(π·f)` seconds twice a cycle: **31.9 µs at 1 kHz, 8.0 µs at
4 kHz**, against a 20 µs attack.

**2. Measured t63 is about 2.9× the attack constant that produced it.** Against
our own kernel:

| dial | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| declared | 800 µs | 433 µs | 234 µs | 126 µs |
| measured | 2313 | 1188 | 688 | 438 µs |
| ratio | 2.89 | 2.75 | 2.94 | 3.46 |

The cause is structural and **the references will have it too**: the bare
rectifier puts the detector under threshold at every zero crossing, so the gain
attacks in bursts and releases between them, and the peak-to-peak envelope
climbs slower than the coefficient. The factor is **not** a constant to divide
out — it moves with Input, level and knee.

⚠ **So the fit is by matched measurement, never by converting a t63 into a
constant.** Run our kernel at each dial, measure its t63 the identical way, find
the dial whose measurement matches the reference's; both sides carry the same
bias and it cancels. Fitting `ATTACK_FASTEST_S` to a reference's raw t63 would
have landed it ~3× too slow, and the number would have looked entirely
reasonable.

**And first-peak overshoot is the better statistic anyway** — 3.55 / 3.42 /
3.20 / 2.83 / 2.27 / 1.52 / 0.78 dB across dials 1–7, monotone over the *whole*
range including the three dials no audio-band probe resolves as a time constant,
and it is what a listener is actually buying from this unit.

---

## What happens after the captures

Not yet built, deliberately — the recovery is proved against a kernel with known
constants before it is pointed at one whose constants are not.

1. Fitters for each plan, matched-measurement as above.
2. A real-program hold-out: a narration dry/wet pair through both references,
   scored on crest factor (scale-invariant, so immune to whatever makeup was
   dialled by hand), delivered ratio, and gain-envelope error. Never in the fit.
3. Then, before anything ships: a `FET_LEGACY_PATCH` and a test pinning it —
   a retune changes **every existing FET Punch render** and there is currently no
   way back. And the five factory presets in `src/audio/pluginPresets/fetPunch.js`
   are calibrated against today's kernel; the Scheps inheritance bug, which
   shipped **4× the intended gain reduction** because a recalibration landed on
   the kernel defaults and not the panel's, is the precedent for what happens
   when that is not handled deliberately.
