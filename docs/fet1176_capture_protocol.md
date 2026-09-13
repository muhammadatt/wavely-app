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

## Step 0 — Control parity: DONE, and it moved four things

Both plugins were read off their own panels and manuals (September 2026).
Quoted text is the vendor's; the ranges are what the plugin displays.

### Waves CLA-76

| Our param | CLA-76 control | Notes |
|---|---|---|
| `inputDrive` | **Input** | **Attenuator, −inf…0 dB, default −30.** ⚠ Faceplate hides the minus sign |
| `outputGainDb` | **Output** | **Attenuator, −inf…0 dB, default −18.** Same hidden sign |
| `attack` | **Attack 1–7** | Direct match to our dial |
| `release` | **Release 1–7** | Direct match to our dial |
| `ratio` | **4 / 8 / 12 / 20** | Direct match |
| `ratio: 'all'` | **ALL** | Direct match — **the only source we have for this** |
| `fetDrive` | *(no control)* | Level-driven, as ours is |
| `scHpfHz` | *(none)* | Broadband detector, as the hardware is |
| — | **Auto makeup** | ⚠ **MUST BE OFF** |
| — | **Analog 50 Hz / 60 Hz / Off** | ⚠ **MUST BE OFF** |
| — | **Rev: Bluey / Blacky** | **Blacky** is primary — ⚠ see below |
| — | **Mix 0–100** | Set **100** |
| — | **Trim ±18 dB** | Set **0** |

⚠ **"The models have different gain stages, time constants, and harmonic
distortion."** That is the vendor's own wording, and *time constants* is the word
that matters: Bluey and Blacky are not two voicings of one unit, **they are two
ballistics.** A matrix run across both is two units and is not recoverable by
relabelling. Fix the Rev, record it, never change it mid-matrix.

⚠ **Auto makeup is the single most damaging control in this list.** With it on,
Output moves with Input, so a `stairs.wav` capture measures compression *and*
makeup summed into one curve and the static fit reads a threshold that does not
exist.

⚠ **Analog adds hum and noise floor by design** — 50 Hz or 60 Hz, the vendor's
whole point. It lands in the recovered gain trace as gain that is not gain, and
it is worst exactly where the trace is most sensitive: near the probe's zero
crossings, where division is already ill-conditioned.

**⚠ INPUT AND OUTPUT ARE BOTH ATTENUATORS, AND THE FACEPLATE HIDES THE MINUS
SIGN.** Resolved: the range is −inf…0 dB with defaults of **−30** and **−18**;
the panel prints "30" and "18". **Zero is maximum on both knobs, and fully
counter-clockwise is silence.**

Two bounces in the first draft of this protocol were impossible because of it,
and both are now corrected below:

- "Input at minimum" would have muted the track, not disengaged compression.
- "Output +10 dB" is unreachable — unity *is* the top of the travel. The Output
  test now raises the knob 10 dB *from its starting position* (−18 → −8).

This is the same class of error as the LA-2A's R37: a control read as one thing
and used as another. It cost nothing this time only because the panel was read
before the bounces.

### ⚠ Blacky is primary, and that choice cuts against the distortion fit

Confirmed from the documentation: **Bluey** is Blue Stripe / Rev A-B — "brighter,
dirtier, more aggressive with added harmonic distortion and grit", pushing the
midrange forward. **Blacky** is Blackface / Rev D-E — "smoother, cleaner, more
neutral", flatter response, "compression without heavily coloring the original
tone".

**Blacky is the right primary.** Our four ratio buttons plus a British-mode
all-buttons is classic 1176LN, and the ballistics and static curve want the
neutral model.

⚠ **But note what that means for `fetDrive`: we are choosing the deliberately
cleaner of the two models as our distortion reference.** Waves' own wording is
that the Revs differ in "gain stages, time constants, **and harmonic
distortion**" — so the one axis where the choice most plausibly changes the
answer is the one `thd.wav` measures.

**So capture `thd.wav` on BOTH Revs.** Three extra bounces, and it is the only
place in the matrix where the Rev difference is both documented and cheap to
measure. Ballistics on both Revs would double the matrix and is not worth it —
note it as an open question instead.

### Analog Obsession FETish

| Our param | FETish control | Notes |
|---|---|---|
| `inputDrive` | **Input**, displays −96…0 dB | ⚠ **Internally compensated — see below** |
| `outputGainDb` | **Output**, displays 0…+36 dB | Manual says −30…+30. Readout ≠ manual |
| `attack` | **Attack, continuous 20–800 µs** | ⚠ **Better than a dial — see below** |
| `release` | **Release, continuous 50–1100 ms** | Same |
| `ratio` | **Continuous 4:1–20:1** | Manual says selectable 4/8/12/20 |
| `ratio: 'all'` | **absent** | ⚠ **SLAM is not all-buttons — see below** |
| `fetDrive` | *(no control)* | |
| `scHpfHz` | **Sidechain HPF 20–500 Hz** | A real counterpart to ours. Set to **20** |
| — | **SLAM** | **OFF** for the whole matrix |
| — | **Sidechain INT/EXT** | **INT** |
| — | **MID F / MID GAIN ±6 dB** | **MID GAIN 0** |
| — | **HF −12…0 (flat)** | **flat** |
| — | **Oversampling** | ⚠ **Hidden behind the logo, default OFF. Turn it ON** — see below |
| — | **Mix 0–100 %** | **100** |

---

### ⚠ FINDING 1 — FETish's Input is a DRIVE OFFSET, not an input gain

> "Internally compensated input knob to drive circuit and get compression. With
> original gear, input will boost signal without compensation. With FETish, you
> don't have to reduce volume while you boost input."

**This is the whole gain-staging feel of the unit, and FETish deliberately does
not have it.** Our model — and the hardware — put Input ahead of a fixed
threshold feeding *both* the detector and the audio path, so turning it up
raises level and compression together and Output brings it back. FETish
compensates that internally: the knob drives the detector and the audio comes
out at the same level.

That is precisely the distinction this codebase already drew for OptoSmooth: a
**drive offset**, not an input gain (`dsp/inputAlign.js`, and the ledger entry
insisting the two are different things even when they render identically).

Consequences, all of which have to be in the log before the bounces start:

- **FETish cannot speak to our Input knob's audio-path behaviour at all.** It is
  a reference for the *detector* side — threshold and taper — and nothing else.
- **The two references will disagree on `stairs.wav` by construction**, in the
  output level at a given Input position. ⚠ **That is expected and is not a bad
  capture.** Someone will otherwise read it as one.
- Our `stairs.wav` collapse test still works on FETish, and measures the
  **detector drive per knob unit** rather than the combined law.

### ⚠ FINDING 1b — FETish's oversampling is a hidden toggle that defaults OFF

Clicking the plugin's logo toggles it. There is no other indication of its state.

**Turn it ON for the entire matrix.** Our kernel runs the gain cell and the FET
stage at 4× (`dsp/oversample.js`) and the reason is measured: at 44.1 kHz the
un-oversampled path put **−47 dBc of folded product on a 9 kHz tone** at the
default `fetDrive`, and **−80 dBc with the FET stage switched off entirely** —
the residue of the gain multiply alone, because the detector is unsmoothed and at
a fast attack the cell tracks the waveform, so the gain signal is itself
broadband. Capturing an aliasing reference against a non-aliasing model would put
folded products into the THD columns at frequencies that are not harmonics of
anything, and into the gain trace as noise.

⚠ **A HIDDEN TOGGLE WITH NO PANEL STATE IS A PROVENANCE HAZARD OF THE FIRST
ORDER.** If half the matrix is captured with it on and half off, the ballistics
fit is polluted and **nothing in the numbers will say so** — it will read as
scatter. Verify it at the start of every session, and log it per capture, not
once per reference.

⚠ **It may also change the plugin's latency.** That is removable by alignment,
but only if it is constant across the matrix — another reason not to let it vary.

**Worth one extra bounce:** `thd.wav` at I3 captured **both ways**. That
measures what FETish's oversampling actually does, which is the closest thing
available to an independent check on whether our own 4× is enough. Not fit data
for any current constant.

### ⚠ FINDING 2 — FETish has no all-buttons-in mode

> "SLAM: With this function, you will get ultra-fast and aggressive limiting
> option. You can use this function for every ratio."

Usable *with* every ratio means SLAM is not the ratio buttons ganged together.
Our `ratio: 'all'` models British mode as its own thing — threshold dropped
6 dB, effective ratio climbing with overshoot, attack lagged 2.5×, release tail
lengthened, FET driven 1.6× harder. **Seven constants, and CLA-76 is now the
only reference that can touch any of them.**

⚠ **That makes all-buttons a single-reference fit with no hold-out**, which is
the weakest position in this whole exercise and must be recorded as such in
whatever ships. Do not quietly present it alongside the two-reference results.

SLAM is worth one exploratory bounce for curiosity. It is **not** fit data for
anything we currently model.

### ⚠ FINDING 3 — FETish says the threshold MOVES with ratio. Ours does not.

> "Each has it's own curve and range to start compress. While you use lowest
> ratio, you should get compression quickly when you boost input. With higher
> ratios, compression will start at higher input gains."

Our model holds `THRESHOLD_DBFS` fixed at −18 across all four ratios and varies
only the knee (`RATIO_KNEE_DB` 10 / 8 / 6 / 3). FETish claims the threshold
itself shifts. On real hardware that is plausible — the ratio buttons change the
feedback network — so this may well be a genuine gap in our model rather than a
plugin quirk.

**It is directly measurable**: the ratio sweep in `stairs.wav` reads the
threshold at each ratio. That sweep was in the matrix to fit the knee; it is now
load-bearing for the threshold too, and it is the first place to look if the two
references disagree about the knee.

### ⚠ FINDING 4 — FETish's ballistics are continuous, which is better than a dial

Set the knob to the exact time our own dial produces and compare directly, with
**no interpolation assumption on either side**:

| dial | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| attack | 800 µs | 433 | 234 | 126 | 68 | 37 | 20 |
| release | 1100 ms | 657 | 393 | 235 | 140 | 84 | 50 |

⚠ **BUT THE ENDPOINTS ARE NOT INDEPENDENT EVIDENCE.** FETish's advertised
20–800 µs and 50–1100 ms are *identical* to our `ATTACK_FASTEST_S` /
`ATTACK_SLOWEST_S` and `RELEASE_FASTEST_S` / `RELEASE_SLOWEST_S`, because both
are quoting the same 1176 datasheet. Agreement at the ends confirms nothing. What
these captures can settle is **the taper between them** — our `dialToSeconds`
interpolates geometrically, and that has never been checked against anything.

⚠ **AND A PRINTED NUMBER IS NOT A MEASUREMENT.** FETish's Input reads −96…0
where its manual says 0…60, and its Output reads 0…+36 where the manual says
−30…+30. Two controls, two mismatches, one plugin. Treat every printed µs and ms
as a knob position to be *verified by the capture*, not as a value to fit
against.

---

## Step 1 — The null test. Five bounces, not thirty-eight.

The matrix is 39–45 bounces per reference. Spend five first: they can disqualify
a reference, or show a control is not what it says.

Session set up as in Step 2. Use **`thd.wav`** throughout.

| # | Settings | What it answers |
|---|---|---|
| 1 | Input **low enough that the GR meter reads 0 throughout**, ratio 4, Output at its default (CLA-76 −18, FETish 0) | Insertion gain, and whether anything is nonlinear with **no** gain reduction. |
| 2 | As 1, but **Output raised 10 dB from that position** (CLA-76 −18 → −8, FETish 0 → +10) | Is Output a clean multiply, or does it drive a stage? |
| 3 | Input up for **~10 dB of GR**, Output back at its default | Does distortion rise with **gain reduction**? That is the axis that matters. |
| 4 | `stairs.wav`, ratio 4, mid Input | Sanity: is the plugin actually in circuit? |
| 5 | **FETish only.** `thd.wav` at two Input positions, ratio 4, level low enough for **zero GR** at both | ⚠ **Does the internal compensation exist?** |

**Bounce 5 is the most valuable single bounce in this protocol.** If the output
level is the *same* at both Input positions, Input is drive-only and Finding 1
holds — FETish tells us nothing about our Input's audio path. If the level
*rises* with the knob, the manual is wrong, the compensation is not there, and
FETish becomes a full reference for the Input law after all. Either answer
reshapes the rest of the matrix, and it costs one bounce.

⚠ **"INPUT AT MINIMUM" IS NOT WHAT BOUNCE 1 WANTS ON EITHER PLUGIN, AND ON
CLA-76 IT IS SILENCE.** Both Input controls bottom out at −inf. What the test
needs is the lowest position that still passes full signal with the GR meter at
zero — find it by ear and by the meter, and **write it down**, because it is also
the bottom of the I1–I4 sweep.

**Reading the rest:**

- **4 comes back bit-identical to the stimulus** → the plugin is bypassed, or the
  bounce exported the source. Everything downstream will say "no compression",
  which looks exactly like "the Input knob is too low". Fix this first.
- **1 and 2 linear, 3 distorts** → the nonlinearity lives with the gain cell, not
  the output amp. That is what `fetDrive` fits against, and it is the same answer
  the Moore paper reached for the LA-2A after two years of a model that put it in
  the valves.
- **2 distorts and 3 does not** → Output drives a stage. We model no such thing,
  and `fetDrive` cannot be fitted from that reference.
- **Nothing distorts anywhere** → no output stage modelled. Still perfectly good
  for ballistics and the static curve. **Log it and stop asking that reference
  about `fetDrive`.** This is the LAEA outcome; it is not a failure of the
  protocol.

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
- **Every control from the Step 0 tables at its stated neutral setting.** CLA-76:
  Auto makeup **off**, Analog **off**, Mix **100**, Trim **0**, Rev **Blacky**.
  FETish: SLAM **off**, sidechain **INT**, HPF **20**, MID GAIN **0**, HF
  **flat**, Mix **100**, and ⚠ **oversampling ON** — it is behind the logo, it
  defaults off, and nothing on the panel shows its state. **Check it at the start
  of every session.**
- **Disable plugin delay compensation, or write down that it is on.** A constant
  latency is removable by alignment. What is not removable is a host quietly
  compensating by a number it will not tell you, while the trace is being read as
  an attack time.

### ⚠ Start every bounce at the file's first sample

The events are **positioned around the Waves demo mute** — measured across nine
captures from three sessions: first at 20.01 s, then every 20.00 s, lasting
0.99 s. **That grid is relative to the render's start, not the file's**, so a
bounce with pre-roll slides every event into the mutes it was placed to avoid,
and the only symptom is events going missing.

The scheduling runs for both references. FETish does not mute, and scheduling
around a mute that is not there costs only a slightly longer rest — which is the
point: **one stimulus serves both, and two references measured on two different
stimuli cannot be compared.**

---

## Step 3 — The capture matrix

**The stimulus files do not change across it. Only the plugin's knobs do.**

### Choosing the Input positions

⚠ **NOT by knob percentage.** The two plugins have different scales (and
CLA-76's readout is currently self-contradictory), so a position stated as a
number is not portable between them and may not be reproducible on either.

Instead, pick four Input positions by the **gain reduction they produce on the
−12 dBFS step of `stairs.wav`**, read off the plugin's own GR meter:

| position | target GR |
|---|---|
| I1 | ~2 dB |
| I2 | ~6 dB |
| I3 | ~12 dB |
| I4 | ~18 dB |

**Write down the knob readout for each.** Those four numbers are data: the shift
that collapses the four static curves onto one *is* the taper, and the readouts
are what it gets expressed in.

### `stairs.wav` — static curve

44.6 s. Fifteen 1 s steps from −45 to −3 dBFS in 3 dB.

**Ballistics: attack slowest, release fastest, always** — CLA-76 attack 1 /
release 7; FETish attack 800 µs / release 50 ms. Both halves matter:

- The detector is a bare full-wave rectifier with no smoothing, so at a **fast**
  attack the gain tracks |sin| *within* the cycle — the trace swings between no
  reduction at the crossings and full reduction at the peaks, and there is no
  settled value to read. The slowest attack (800 µs against a 250 µs probe
  period) smooths that into a steady, peak-referenced number, which is the
  quantity the static curve is defined on.
- The **fastest** release settles each step in ~200 ms, so the steps can sit
  1.5 s apart instead of needing ten.

| reference | ratio | Input | bounces |
|---|---|---|---|
| CLA-76 | 4 / 8 / 12 / 20 / **ALL** | I1–I4 | **20** |
| FETish | 4 / 8 / 12 / 20 | I1–I4 | **16** |

⚠ **THE RATIO SWEEP NOW CARRIES TWO QUESTIONS, NOT ONE.** It was in the matrix
to fit `RATIO_KNEE_DB`. Per Finding 3 it also measures **whether the threshold
moves with ratio**, which our model says it does not and FETish's manual says it
does. Read the threshold per ratio before reading the knee — a moving threshold
misfits as a knee if you assume it is fixed.

⚠ **AND THE INPUT SWEEP IS NOT REDUNDANT, DESPITE LOOKING IT.** Our model says
drive and level add in dB, so a level staircase at fixed Input and an Input sweep
at fixed level should be the same experiment. If the curves **collapse onto one
another** when shifted, the additive model holds and the shift is the taper. If
they do not, the Input knob does something we do not model. On FETish, per
Finding 1, what collapses is the **detector** drive only — the output level will
*not* shift with Input, and that is the compensation, not a fault.

### `bursts.wav` — ballistics

83.1 s. Four holds at −12 dBFS: 50 ms at t=2.0, 200 ms at 22.1, 1 s at 42.1,
3 s at 62.1. Ratio 4, Input at **I3** (~12 dB GR) throughout.

**CLA-76 — 14 bounces**

| | |
|---|---|
| attack **1…7** at release 4 | 7 |
| release **1…7** at attack 7 | 7 (one shared corner) |
| ratio **ALL**, attack 4, release 4 | 1 |

**FETish — 13 bounces.** Same shape, but set the continuous knobs to the exact
times in the Finding 4 table rather than to dial numbers, and **there is no
all-buttons bounce**:

| | |
|---|---|
| attack **800 / 433 / 234 / 126 / 68 / 37 / 20 µs** at release 235 ms | 7 |
| release **1100 / 657 / 393 / 235 / 140 / 84 / 50 ms** at attack 20 µs | 7 (one shared corner) |

Optional, not fit data: one **SLAM** bounce at ratio 4, attack 126 µs, release
235 ms. We model nothing like it; capture it only if you are curious what it is.

Sweeping the **hold length** is what separates the release tail from the main
release: a single time constant recovers identically after every hold, and a
two-stage network does not. ⚠ It is also the check that caught a mislabelled
LA-2A capture — a release trace *bit-identical* after 50 ms and 10 s cannot be a
photocell, and that signature is how an 1176 got into the LA-2A corpus.

### `frequency.wav` — hold-out, 1 bounce each

57.0 s. The same −12 dBFS step at 100 / 400 / 1000 / 4000 / 10000 Hz. Ratio 4,
Input I3, attack slowest, release fastest.

⚠ **HOLD-OUT, NOT FIT DATA, AND IT MUST STAY THAT WAY.** The hardware's detector
is broadband and ours models it that way, so the settled reduction has to be
*identical* at every probe frequency. That is a testable claim rather than an
assumption baked into the model. If a reference ducks 100 Hz harder than 4 kHz,
no retuning of the taper or the knee can reproduce it — it would mean the
detector needs a filter, not that a constant is wrong. Keeping it out of the fit
is the only thing that lets it answer that. (The LA-2A's side-chain turned out to
be HF-tilted by 2.5 dB, and ours tilted the other way. Nobody guessed it.)

⚠ **FETish's sidechain HPF has no bypass** — 20 Hz is the floor, so its detector
is not perfectly broadband even at the neutral setting. A one-pole at 20 Hz costs
about **0.17 dB at the 100 Hz probe**, which is below anything this test is
looking for, but note it rather than discovering it later. (Its HPF is also a
direct counterpart to our `scHpfHz`, so it is worth its own small sweep once the
main matrix is in.)

### `thd.wav` — distortion, 3 bounces each

26.6 s. Five 3 s tones at 1 kHz: −30, −24, −18, −12, −6 dBFS. Ratio 4, attack
slowest, release fastest. Input at **I1 / I3 / I4**.

⚠ **THE AXIS IS GAIN REDUCTION, NOT INPUT LEVEL.** THD against input level cannot
tell a gain-cell nonlinearity from an output-amp one. THD against dB of GR can.
**Record the plugin's GR meter for each tone at each Input position — that is the
x-axis**, and without it these bounces measure the wrong thing.

⚠ **WATCH FOR CLIPPING AT I4.** A −6 dBFS tone with the Input up drives the audio
path hot. If the output exceeds 0 dBFS, bring it back with **Output** (CLA-76:
or **Trim**), which sits after the FET and therefore does not change harmonic
content measured in dBc. **Note the trim you used.** On FETish, per Finding 1,
this is less likely to bite — which is itself a check on the compensation.

### Totals

| | CLA-76 (Blacky) | FETish |
|---|---|---|
| null test | 4 | **5** |
| stairs | 20 | 16 |
| bursts | 14 | 13 |
| frequency | 1 | 1 |
| thd | 3 | 3 |
| thd, Bluey Rev | **3** | — |
| thd, oversampling off | — | **1** |
| **total** | **45** | **39** |

The last two rows are the cheap ones that answer a question nothing else in the
matrix can: whether the Rev choice moves the distortion we fit `fetDrive`
against, and what FETish's oversampling actually does. Neither is fit data for a
current constant.

---

## Step 4 — What to write down

Captures go in `data/corpus/fet1176/captures/`, gitignored — `*.wav` is ignored
repo-wide, so no licensed audio reaches the repo.

Name each file for its cell and keep a log beside them:

```
<reference>_<stimulus>_<ratio>_<inputPos>_a<attack>_r<release>.wav

fetish_stairs_r8_I3_a800us_r50ms.wav
cla76_bursts_rALL_I3_a4_r4.wav
cla76_stairs_r4_I1_a1_r7.wav
```

Per capture, log: reference and version; **Rev / component variant**; every knob
position **as the plugin displays it** (the Input readouts for I1–I4 are data,
not bookkeeping — see "Choosing the Input positions"); **the GR meter reading**;
the Output or Trim used, if any; session rate; and whether delay compensation was
on.

⚠ **Log the neutral controls too** — Auto makeup, Analog, Rev, Mix, Trim, SLAM,
sidechain. "It was off" recorded nowhere is indistinguishable later from "nobody
checked". Provenance is part of the measurement, and this repo has lost eight
captures to it once already.

⚠ **FETish's oversampling goes in EVERY row, not once per reference.** It is
behind the logo, it defaults off, and the panel shows nothing. A matrix captured
half one way and half the other reads as scatter, and no number in it will say
which rows were which.

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
2. ⚠ **All-buttons-in is a single-reference fit and must be labelled one.**
   FETish has no such mode (SLAM is a different thing), so all seven `ALL_*`
   constants can only come from CLA-76, with no hold-out and no second opinion.
   That is the weakest result this exercise will produce; it does not get
   presented alongside the two-reference numbers as though it were one of them.
3. ⚠ **Check the fixed threshold before fitting the knees.** FETish's manual says
   compression starts at a higher input as the ratio climbs; our model holds
   `THRESHOLD_DBFS` fixed across all four and varies only the knee. If the
   captures agree with the manual, that is a missing term in the model, and a
   moving threshold misfits as a knee if you assume it is fixed.
4. A real-program hold-out: a narration dry/wet pair through both references,
   scored on crest factor (scale-invariant, so immune to whatever makeup was
   dialled by hand), delivered ratio, and gain-envelope error. Never in the fit.
5. Then, before anything ships: a `FET_LEGACY_PATCH` and a test pinning it —
   a retune changes **every existing FET Punch render** and there is currently no
   way back. And the five factory presets in `src/audio/pluginPresets/fetPunch.js`
   are calibrated against today's kernel; the Scheps inheritance bug, which
   shipped **4× the intended gain reduction** because a recalibration landed on
   the kernel defaults and not the panel's, is the precedent for what happens
   when that is not handled deliberately.
