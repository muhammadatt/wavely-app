# VoxPressor — Vocal Dynamics & Enhancement Plugin Spec

> Status: **DRAFT for owner review** (October 2026). **Built** (dev only,
> registry id `vox-pressor`): the voice detector, the Peaks (1176) → Body
> (LA-2A) core with per-stage makeup, and — stage 2 — De-ess → Parallel →
> Density. Air is not built yet. Every number marked
> *reasoned* is a starting point to be measured or auditioned, per this repo's
> habit of saying which numbers are which.

---

## 1. Why another compressor

LA Vintage 2A and LA Classic 76 are **general-purpose analog emulations**. They
are faithful to hardware on purpose, which is exactly why they are awkward as
the one dynamics tool a narrator reaches for:

| Problem on voice | What the analog plugins do today | What VoxPressor does |
|---|---|---|
| Plosives / chest thump trip the detector and duck the whole word | LA-2A: R37 tilt only. 1176: optional one-pole `scHpfHz`, off by default | Voice-shaped detector: high-pass at the speaker's own rumble corner, plosives and sibilance turned down |
| "s" sounds get louder after compression (body is pulled down, sibilance isn't) | Separate HF Softener, user must know to add it *after* | De-ess is built in, placed after the compressor, linked to it |
| Two serial compressors (76 → 2A) is the standard vocal chain, but it takes two windows and nine 1176/LA-2A controls to stage | Chain them manually in the Plugin Chain | Two knobs that say what they do: **Peaks** (dB off the loudest peaks, the 76) and **Body** (average leveling, the 2A) |
| "Enhance" (presence, air, density) is four more plugins | Scheps Parallel, Air Boost, Cambridge Inflator, Saturation Workbench | Three knobs: **Parallel** (Scheps' Pultec → LA-2A trick), **Air**, **Density** |

**Positioning:** the Mode 2 / Mode 3 user's single "make my voice sound
produced" plugin. It is *not* the mastering chain — no loudness target, no ACX
claim. It moves character and dynamics; Loudness Normalize or the preset chain
still sets delivery level.

**Design rule — compose, don't copy.** Like Scheps Parallel (which *holds* the
LA-2A kernel rather than a copy), VoxPressor embeds the existing kernels so
every fitted constant, makeup guarantee and test reaches it with no conforming
change. New DSP is limited to the voice detector, the Peaks solve and the glue.

---

## 2. Signal chain

One AudioWorklet, one kernel class (`VoxPressorKernel`), constant latency.

```
in ─ INPUT ALIGN (drive offset, detector only)
   │
   ├─ VOICE DETECTOR ─────────────────────────────────────────────┐ (sidechain)
   │   HP @ voice corner · plosive shelf · sibilance shelf        │
   │                                                              ▼
   ├─ [1] PEAKS   — FET1176Kernel, pinned peak-catcher patch  ◄── detector (no plosive shelf, §3)
   │     makeup (closed form) → LIMITER (source peak)
   ├─ [2] BODY    — LA2AKernel (opto, rides the phrase)       ◄── detector (full)
   │     makeup + restore → LIMITER (source peak)
   ├─ [3] DE-ESS  — HFSoftenerKernel (Duck + EQ, lisp guard), level from the Body output   (built)
   ├─ [4] PARALLEL — FET1176Kernel at its own Mix (New York: fast 4:1 copy under the dry),
   │     detector hears sibilance +15 dB; makeup on the blend; measured on the de-esser's output  (built)
   │     restore → LIMITER (source peak)
   ├─ [5] DENSITY — InflatorKernel, anchored at the source peak, Clip on                   (built)
   │     → LIMITER (source peak: the downsampler's inter-sample ringing, §4.3)
   ├─ [6] AIR     — Air Boost curve, voiced-only                                         (not built)
   └─ MIX         — delay-compensated dry/wet (not built)
       └─ OUTPUT trim ─ out
```

### Order rationale (pinned, not user-reorderable)

- **76 before 2A.** The canonical vocal chain: the FET takes the fast onsets so
  the opto isn't yanked by them and can ride the phrase smoothly. Reversing it
  makes the 2A pump on every plosive that survives. *(Owner may want this as a
  bench A/B; see §11.)*
- **Parallel after the serial pair.** It is a layer added to the finished
  dynamics, the way it is run on a console: the squashed copy is blended under
  a voice that is already level, so it adds density without making the level
  ride any harder.
- **De-ess after compression, BEFORE the parallel stage (owner's order,
  October 2026).** Compression raises sibilance relative to the body, so the
  de-esser follows the serial pair. ⚠ A parallel compressor lifts whatever
  its detector leaves alone, sibilance included, so the parallel 1176's
  detector hears sibilance shelved up (§4.4) — without that the blend gave
  back most of what the de-esser took. Its thresholds follow the
  level it HEARS: `deEssLevelOffsetDb` is measured on the Body stage's output,
  made up, and until it lands the source's level stands in.
- **Air after the de-esser.** Air pushed into a compressor gets compressed
  back out, and Air before the de-esser just hands it more to cut.
- **Density after makeup and the ceiling.** The Inflator's curve is defined
  against full scale, so it has to see a signal whose peak is known. After the
  ceiling, the loudest sample is at most the source peak, which is exactly the
  point the curve is anchored to (§4.3).

---

## 3. The voice detector (the one genuinely new DSP block)

One filter design, two instances. The PEAKS tap reads the input; the BODY tap
reads the **Peaks output**, so the opto rides a signal whose onsets the 1176
has already taken (stage 1, `dsp/voiceDetector.js`).

1. **High-pass at the speaker's rumble corner** — `measureVoiceProfile().cornerHz`
   (`voiceProfile.js`, the same number VoiceRx and Reso Soothe use: 40–100 Hz,
   measured once per file). 2nd order. Falls back to 80 Hz if the profile
   returns `null` (too few voiced frames).
2. **Plosive de-weighting** — a low shelf, −10 dB below 150 Hz
   *(reasoned)*, so a "p" that passes the high-pass still doesn't dominate.
3. **Sibilance de-weighting** — a high-shelf cut, −9 dB above 5 kHz *(reasoned)*.
   The compressors should ride the vowels; sibilance is the de-esser's job. Without
   this the compressor and de-esser both cut on an "s" and it lisps.

**The two compressors tap it differently.**

| Tap | HP | Plosive shelf | Sibilance shelf | Why |
|---|---|---|---|---|
| BODY (2A) | ✓ | ✓ | ✓ | An opto release is hundreds of ms to seconds: a plosive in its detector ducks the rest of the phrase |
| PEAKS (76) | ✓ | **✗** | **✗** | A plosive or a bright "s" is often the loudest peak in a take, and the makeup restores the processed peak, so every peak the 1176 cannot see sets the whole region's loudness. Shipped with the sibilance shelf first: on the owner's "Messy and Bright" clip one "s" (−5.2 dBFS above 5 kHz) went through untouched and the clip came out 3.6 dB QUIETER; hearing sibilance, Peaks 3 makes it 3.8 dB louder. The FET lets go in tens of ms, so catching either costs a few ms of gain |

**Wiring (built).** Both kernels take an optional fourth `process()` argument,
`sidechain`: a mono detector signal that replaces their own mono tap. Absent,
both are unchanged; fed their own mono tap, both render bit-identically
(tested). The LA-2A's own 80 Hz one-pole HPF and R37 still run on it.

The FET's **feedback** detector needs no special handling: the loop is solved
in dB on the detector's level (`_solveFeedback`), so a filtered detector signal
closes the same loop. (The earlier note here proposed filtering the cell output
instead; reading the code showed it is unnecessary.)

⚠ **Measured on synthetic narration, the detector's plosive and sibilance
shaping barely matters to this LA-2A model.** Its own side-chain already
high-passes at 80 Hz and its detector is slow, so even a plain LA-2A gains at
most ~0.65 dB of average reduction from loud plosive puffs; the Body tap cuts
that by a third or more (pinned in `test/dsp/voxPressor.test.js`). Sibilance
moved neither compressor measurably. Whether real plosives and real "s" sounds
behave the same way needs real recordings: audition with **Listen: PEAKS SC /
BODY SC** and compare against a plain LA Vintage 2A.

---

## 4. Controls

### 4.1 Front panel (Modula, single face)

| Knob | Range | Default | What it does |
|---|---|---|---|
| **Peaks** | 0–10 | 3 | The 76's detector drive on a linear scale (Input pinned at 26), aligned to the file's gated RMS (§4.2): ≈ N dB off the loudest peaks of typical narration. Readout: dB off the loudest peaks, voice touched. 0 = stage out, a pure delay |
| **Speed** | AUTO / GENTLE / NORMAL / FAST | AUTO | The 76's attack / release (§10): AUTO sets the release from the voice's pitch. Readout: gain ripple, amber past −22 dB |
| **Body** | 0–100 | 57 | The 2A's **Peak Reduction**, aligned the same way and net of the Peaks stage's makeup. Readout: avg leveling on voiced material. 0 = stage out |
| **De-ess** | 0–100 | 40 | HF Softener **Amount** (Split pinned at its default 33; Guard 100) |
| **Parallel** | 0–100 % | 30 | The parallel 1176's **Mix** (§4.4): a fast 4:1 copy blended under the voice, peaks held, the rest raised. 0 = stage out, a pure delay |
| **Air** | 0–6 dB | 1.5 | Air Boost curve (`dsp/airBandCurve.js`), VOICED mode only (vowels), the HF Softener's existing Air path |
| **Density** | 0–100 % | 30 | Cambridge Inflator **Effect** (§4.3). Lifts the body up to +3.5 dB under a fixed peak, with odd harmonics on the loudest syllables |
| **Mix** | 0–100 % | 100 | Parallel blend against delay-compensated dry |
| **Output** | ±12 dB | AUTO | Owned by auto makeup until touched (the LA Vintage 2A Gain-knob contract) |

There is no Character knob any more: what it used to blend (opto vs. FET) is
now two knobs with separate jobs.

Header: preset browser, ON/BYPASS lamp, **DELTA** pill (plays what VoxPressor
removed + added), **Listen: SC** (plays the voice detector — the HF Softener's
MONITOR contract).

### 4.2 Peaks — the 1176 as an automatic peak trimmer

**What the user sets:** Peaks 0–10, the 1176's detector drive on a linear
scale (`peaksDriveDb`, 1.13 dB a step), on top of the file's gated-RMS
alignment exactly as LA Classic 76 aligns (`regionAlignDb` over the whole
file), so a position means the same at any recording level. The Input is
pinned at 26, so the knee (which reads the Input's drive) never moves.
Calibrated so Peaks N ≈ N dB off the loudest peaks of typical narration:
with the Input pinned, each dB of drive takes 0.88–0.90 dB off the peaks,
linearly past 10 dB, and both owner clips are first caught 3.9 dB under
Input 26's drive (Peaks 0). Measured at Peaks 3: 2.3 / 3.3 dB on the clips,
6.4 on synthetic narration. Everything else on the 1176 is pinned. The panel
reads back what it did.

**Pinned patch** *(reasoned, to audition)* — the classic peak-catcher setting:

| 1176 control | Value | Why |
|---|---|---|
| Ratio | 12:1 | Limiting, not leveling. The moving threshold (`ratioThreshold: 'moving'`) raises it 2.7 dB over 4:1 |
| Attack | dial 6 | Fast enough to take a consonant onset, one short of 7 so the first cycle of a vowel isn't sliced |
| Release | dial 6 | Recovers within tens of ms so the body between peaks is untouched. Not 7: at 7 the feed-forward release rode bass cycles (+1.1 to +1.4 dB of modulation). `fbRelease: 'open'` fixed that, but 6 keeps the margin |
| Output | −Input's drive | Unity through the stage; the stage's makeup rides on it |
| Mix | 1 | Parallel is VoxPressor's own Mix |
| Input | 26, pinned | The Peaks knob moves the detector drive instead |

**The readouts (`measureVoxPressor`, one render per stage, in the worker):**
"dB off the peaks" splits the region into 100 ms blocks, takes the loudest
10 % by peak (5–60 blocks), and reads the **median** over those blocks of input
peak − output peak; Body reads the LA-2A's average cell reduction on the voiced
blocks of the Peaks output. Measured together with each stage's makeup —
one kernel render for the 1176 stage, one or two for the LA-2A, the limiters
offline: 0.6–0.8 s per 30 s window during a drag (1.1–1.8 s cold), on the
compressors' `createMeasureThrottle` — while the knobs themselves act at once.

**History: the knobs were TARGETS first (owner's call to replace them).**
Peaks was "dB off the peaks" and Body "dB of average leveling", each solved by a
safeguarded secant over a detector-only offset, so "Peaks 3" meant 3 dB on any
voice. Beyond the gated-RMS alignment the solve moved the offset only
1.1–1.2 dB (Peaks) and 0.3–0.4 dB (Body) between the owner's two clips (crest
16.6 vs 19.9 dB) — at the price of a 4–7 s wait on every knob move, during
which the old setting kept playing. ⚠ What it was absorbing is real, though:
synthetic narration (crest 20.2 dB) reads 6.75 dB off its peaks at Input 26,
where the two real clips read 2.7 and 3.8.

**Calibration (owner's clips, aligned):**

| Input | 20 | 26 | 30 | 40 | 50 |
|---|---|---|---|---|---|
| Messy and Bright: dB off peaks / voice | 0.4 / 0.00 | 2.7 / 0.01 | 4.5 / 0.38 | 8.8 / 3.14 | 12.9 / 7.00 |
| David Greenberg | 1.2 / 0.00 | 3.8 / 0.01 | 5.6 / 0.30 | 9.8 / 3.00 | 13.9 / 6.67 |

| Peak Reduction (Input 25) | 40 | 50 | 57 | 60 | 70 |
|---|---|---|---|---|---|
| Messy and Bright: avg leveling | 0.5 | 2.3 | 3.8 | 4.7 | 7.5 |
| David Greenberg | 0.4 | 1.9 | 3.4 | 4.3 | 7.1 |

⚠ That is why Peaks is not the Input knob any more: the useful span was
Input ~20–35, a quarter of its travel, and the knee moved with it.

**Keeping it on the peaks — warn, don't cap (owner's decision).** The knob
always delivers what it asks for; what that costs the voice is measured and
shown:

- **Voice readout:** under the Peaks knob, "voice touched X dB" is the median
  level drop on the voiced blocks. Past `PEAKS_BODY_WARN_DB` (0.5 dB,
  *reasoned*) it turns amber and adds "compressing the voice".
- **Why no cap:** an early build shipped a fixed floor (the knee kept ≥ 8 dB over the
  detector's gated level). On a real narration clip (−1 dBFS peak, −20.9 dBFS
  gated) it stopped Peaks at 2.57 dB for every setting from 3 to 10 while the
  voice measured 0.01 dB touched.

**Why not fully automatic (no knob)?** How much peak to take is a taste call
(narration ~2–3 dB, podcast punch ~5–6). A fixed crest target would be wrong
on half the voices.

### 4.3 Density — the Cambridge Inflator, anchored to the ceiling

**What it does on voice, honestly.** The Inflator's curve is pinned to full
scale: f(1) = 1 at every setting, f'(0) = 1.5 (+3.5 dB at Curve 0). At voice
level it is mostly a **level-dependent lift**, i.e. upward compression: quiet
material comes up as much as +3.5 dB, the peak doesn't move. It generates
**odd harmonics only**, and mostly near the top of the curve, so on the loudest
syllables. It is *not* a peak controller and must not be sold as one (its own
module says so).

**Anchoring.** The curve's behaviour depends entirely on where the signal sits
on it, so it is anchored per file: Inflator `inputDb = −ceilingDb` (the source
peak maps to s = 1), and an exact inverse gain after it. Then:

- The peak can't rise: the curve is monotone on [0, 1] with f(1) = 1, and
  **Clip is pinned on**, so the fold-back above full scale is unreachable.
  ⚠ **But the anchor alone does NOT hold the peak, and this said it did.**
  Samples at the anchor reconstruct to inter-sample peaks over full scale in
  the Inflator's oversampled curve; its Clip catches them there and its
  downsampler rings back over: +0.18 dB on "Messy and Bright" at Density 30,
  +0.43 on synthetic narration with sibilants, +1.71 on white noise. A last
  lookahead limiter at the source peak takes it with a gain (built).
- **Density** = Inflator **Effect** (0–1). Curve pinned at 0; Band Split off
  *(both on the bench)*.
- **It adds loudness at the same peak.** That is the point of it, but it means
  Density makes the A/B louder. Output AUTO does *not* take it back (that would
  pull the peak under the source).

**Alongside the LA-2A harmonics, not instead of them — recommended.** They
don't overlap:

| | LA-2A (shipping quartic cell + valve) | Inflator |
|---|---|---|
| Harmonic family | Even: ~1 % of distortion energy is odd | Odd only (odd-symmetric curve) |
| Driven by | Gain reduction and level, no knob | Distance from the peak, Density knob |
| Sounds like | Warmth, thickness | Density, forwardness |

Stacked, they cover both families with no double-counting, and the LA-2A's
colour is the 2A's own voice, which is why you'd use it. That is why the
separate **Warmth** knob (a quartic Saturation Bench layer) is **dropped**: it
duplicated the LA-2A's even harmonics.

**"Instead of" goes on the bench** as a Color switch: TUBE + DENSE (ships) /
DENSE only (the 2A's shapers off, via a clean patch) / TUBE only (Density
forced to 0). If DENSE-only wins by ear it can be promoted.

### 4.4 Parallel — New York compression with the 1176

⚠ **THIS WAS SCHEPS PARALLEL, AND IT COULD NOT ADD LOUDNESS** (owner, October
2026: "we typically want to use parallel processing to make quiet parts
louder"). The draft embedded `SchepsKernel` on the argument that its mix law
"gently raises loudness"; on the owner's clips it added 0.2–0.4 dB. The mix
law was not the cause: Scheps' trim is already referenced to the 99.9th
percentile, and the LA-2A's mix law (a straight blend with the wet makeup
solved on it) measured within a few tenths of Scheps' at Mix 0.3 and BELOW it
from 0.5 up. The cause is the OPTO: a cell with a multi-second release turns the
whole voice down nearly evenly, so its copy is barely denser than the dry
(0.75 / 1.9 dB, "Messy and Bright" / David Greenberg), and squashing it harder
stops helping past Squash ~60. A fast compressor reduces the crest factor,
which is what parallel compression lifts. Same law, same reference, raw clips,
Mix 0.3: bare LA-2A +0.41 / +1.11 dB; 1176 4:1 attack 6 +0.91 / +1.70.

**The stage:** a second `FET1176Kernel` (`PARALLEL_PATCH` in
`voxPressorProcessor.js`) at the Parallel knob's Mix, through the 1176's own
delay-compensated dry path:

- **Ratio 4, attack 6, fetDrive 0, Input 40** on the file-relative alignment
  (measured on what it hears). Density PEAKS around Input 40 — drive harder and
  the copy delivers LESS (In 50 / 60 / 70 at Mix 0.5: +1.11 / +0.78 / +0.45 on
  Messy), because the onsets the attack lets through set the percentile the
  makeup holds.
- **Release voice-adaptive**, the Peaks stage's AUTO rule, never a fixed fast
  release (it ripples a low voice, §10). It costs nothing here: within 0.04 dB
  of release 5 on both clips.
- **The LA-2A mix law:** `dry·(1−mix) + wet·mix·g`, g (the wet's Output) solved
  so the BLEND's 99.9th percentile lands on the stage input's — peaks held,
  everything under them raised. The makeup is therefore a function of Mix, and
  the knob re-measures.
- ⚠ **ITS DETECTOR HEARS SIBILANCE +15 dB** (`ParallelDetector`, a 4 kHz high
  shelf, nothing else). In a parallel copy whatever the detector leaves alone
  comes UP by the copy's ~9.5 dB of makeup, and sibilance sits under the voiced
  peaks: with a plain detector, energy above 5 kHz rose 2.6 dB at Mix 0.3 on
  Messy against 0.76 dB of level, undoing the de-esser. By the same argument it
  has no corner high-pass and no plosive shelf. +15 is reasoned from the two
  clips (+12 left Greenberg's top end above the level, +18 took Messy's
  under); it costs ~0.1 dB.
- **Peak restore → limiter**, as Peaks' and Body's (per-stage makeup): the
  emphasis lets the copy catch the "s" peaks that set the region's peak, which
  left the blend 0.3–0.6 dB under the source peak. Measured on the window; past
  it the limiter holds the peak.
- **0 is a true bypass** (a delay line of the 1176's latency).

Measured, owner's clips (30 s, change vs the source; Peaks 3 / Body 57 / De-ess
40, Density 0): Parallel 0 → 30 → 50 %: Messy +2.38 → +3.36 → +4.00 dB of
loudness, energy above 5 kHz +0.63 → +0.49 → +0.46; Greenberg +4.81 → +5.81 →
+6.50, above 5 kHz +5.21 → +6.01 → +6.59. Peak on the source's throughout.

**BENCH A/B — 1176 vs LA-2A** (`parallelComp`, owner, October 2026: "I let
you talk me out of using the LA-2A on the parallel stage twice now"). Both
share the LA-2A mix law, the peak restore, the limiter and the latency, so
switching never moves the audio. 1176 ships until the audition decides.

⚠⚠ **THE LA-2A IS VOICED AS AN LA VINTAGE 2A CHAIN SLOT, NOT AS THE 1176.**
The first build gave it the 1176's sibilance-weighted detector, Peak
Reduction 60 and alignment on the de-esser's output. The owner compared it
(Mix 50–75, Density 0) against a plain LA Vintage 2A slot after VoxPressor at
PR 50 / Mix 50: "the latter sounds much better". On the owner's clips the three
differences are the whole gap (Mix 50, change vs Parallel off; level / above
5 kHz / average wet GR):

| | Messy and Bright | David Greenberg |
|---|---|---|
| Chain slot (preview) | −0.19 / +1.09 / 3.6 dB | −0.03 / +1.53 / 4.9 dB |
| VoxPressor LA-2A, first build | −0.15 / −0.54 / 5.2 | +0.02 / +0.49 / 5.6 |
| + Peak Reduction 50 | −0.07 / −0.53 / 3.0 | +0.11 / +0.42 / 3.0 |
| + its own detector | −0.19 / +0.80 / 2.6 | +0.06 / +0.98 / 2.7 |
| + aligned on the source | −0.23 / +1.07 / 3.6 | −0.06 / +1.51 / 4.9 |

- **The detector.** The sibilance emphasis is right for the 1176, whose fast
  release lets go after an "s". An opto's release is seconds long, so every
  "s" held the copy down through the vowels after it (peak GR 12.5 dB against
  the slot's 8.0) and the copy came out DULL. The LA-2A now listens through its
  own detector (mono, its 80 Hz side-chain HPF, R37).
- **Peak Reduction 50**, the slot's.
- **Aligned on the source** (the file's `alignDb`), which is what the slot's
  PREVIEW does — it measures the unprocessed file. ⚠ A chain slot's APPLY
  aligns on its running input instead (the chain's rule, CLAUDE.md), which for
  a slot after VoxPressor is the core's made-up output, 2.4–4.8 dB hotter: it
  would have driven the cell ~1 dB softer (avg GR 2.6 / 2.7) than what the
  owner previewed. VoxPressor's stage uses the source in both.

Matched, the stage renders the slot's preview within 0.03–0.08 dB of level and
0.01–0.03 dB above 5 kHz at Mix 50 and 75, the difference 30–34 dB under the
output. What the LA-2A adds is top end and density, not level (−0.2 to 0 dB at
Mix 50 against the 1176's ~+1), so the A/B is ~1 dB apart: match it with Output.

⚠ **Overlap with Density.** Both add density: Parallel by dynamic upward
compression, Density by a static curve with odd harmonics. Different
mechanisms, but presets should not max both (§11).

### 4.5 Meters

- IN / OUT ladders (`LevelMeter variant="modula"`).
- Three stacked GR bars: **PEAKS** (76, with the body-GR tick from §4.2),
  **BODY** (2A), **DE-ESS**.
- The HF Softener's activity scope is *not* included — one scope per window is
  enough, and it is the busiest part of that panel.

### 4.6 Advanced (dev bench, gated like the PHAT*SS bench)

Peaks patch (ratio, attack, release, Input = knee width), Body ballistics, detector
corner/shelf depths per tap, Parallel Squash, Inflator Curve and Band Split, the Color switch,
chain-order A/B, `VOX_LEGACY_PATCH`. Nothing on the bench ships to presets.

---

## 5. Measurements (never user settings, never in presets)

All measured once per file / selection, in the worker, against the **running
`segments`** when in the Plugin Chain (CLAUDE.md rule):

| Measurement | Source | Used by |
|---|---|---|
| Gated RMS (whole file) → alignment | `regionAlignDb` | Both detectors' offset (Body's net of the Peaks makeup) |
| Gated RMS → voiced-block gate | `dsp/inputAlign.js` | Body readout; Peaks voice-touched readout |
| Rumble corner, median F0 | `voiceProfile.js` | Detector HP |
| Loudest blocks (by peak), voiced blocks (gated RMS − 10 dB) | `referenceBlocks` | Peaks / Body readouts |
| Parallel alignment, wet makeup (on the blend, at the Mix), peak restore | the parallel 1176's wet path rendered on the de-esser's output + `percentileBlendGain` | Parallel stage |
| Post-compression gated RMS | render of stages [1]–[3] on ≤ 400 blocks | De-ess `levelOffset` |
| Makeup, per stage | `measureVoxPressor`: percentile makeup per stage (the 1176's in closed form, the LA-2A's by `solveMakeupPlan`, warm-started), a lookahead limiter at the source peak, restore to it; both restores re-measured over the whole region before apply when the region outgrew the window | 1176 Output; LA-2A Gain + the restore after the chain |
| Source peak | `peakOfChannels` | Ceiling; Density anchor |

⚠ **The measurements are sequential.** Peaks first (on the input), then Body (on the
Peaks output), then Parallel's trim (on the Body output), then the de-ess
offset and makeup. Moving a knob invalidates every measurement after its stage;
Parallel's Mix and character invalidate only de-ess and makeup. Cache by
document + span + the knobs upstream of each solve.

---

## 6. Latency, apply, chunking

- Latency: FET 50 + LA-2A 50 + FET 50 (Parallel) + Inflator 50 (all 4x oversampled) =
  **200 samples, constant**, reported once and trimmed by the apply path. Dry
  path in Mix delayed by the same amount. (Dropping Warmth also dropped its
  3 ms guard.)
- Preview (worklet) and apply (OfflineAudioContext) sample-identical, **except**
  if the owner chooses LA Classic 76-style peak restore on apply (§11).
- Chunked apply (`chunkedApply.js`): eligible — every stage is a kernel already
  chunk-tested. Grid 128 samples, 6 s shared run-in. Add VoxPressor to
  `test/dsp/chunkedApply*.test.js` at the −130 dBFS floor.
- Plugin Chain: `chain: true`, copies via `pluginCopies`, worker measurements
  keyed by owner (`ownedWorkerJob`).
- Pin every apply to its document (`pinActiveDocument`).

---

## 7. Factory presets

A preset stores the panel values only. *All reasoned, to be auditioned; the presets are not built, and the Parallel column predates the 1176 stage (§4.4), which has no character toggle.*

| Preset | Peaks | Body | Parallel | De-ess | Air | Density | Mix |
|---|---|---|---|---|---|---|---|
| **Default** | 3 | 40 | 30 PRESENCE | 40 | 1.5 | 20 | 100 |
| **Audiobook Natural** | 2 | 30 | 15 PRESENCE | 35 | 1 | 10 | 100 |
| **Podcast Punch** | 5 | 50 | 40 THICK | 50 | 2 | 30 | 100 |
| **Voiceover Forward** | 6 | 60 | 45 PRESENCE | 55 | 3 | 30 | 100 |
| **Gentle Glue** | 1 | 35 | 35 THICK | 30 | 0 | 10 | 50 |

---

## 8. Files (following the existing plugin layout)

```
src/audio/voxPressorParams.js        panel ↔ kernel mapping, defaults, pinned Peaks patch
src/audio/voxPressorProcessor.js     VoxPressorKernel + worklet registration
src/audio/voxPressorWorkletLoader.js ?worker&url loader
src/audio/voxPressorSolve.js         readouts + per-stage makeup (worker side)
src/audio/dsp/voiceDetector.js       §3 detector filter, two taps
src/audio/effects/voxPressor.js      effect wrapper
src/composables/useVoxPressor.js     pluginCopies, measurements, chain registration
src/components/VoxPressorModal.vue   Modula panel
src/audio/pluginPresets/voxPressor.js
test/dsp/voxPressor*.test.js
```

Registry: Dynamics category, `release: 'dev'` until auditioned (plus the
`test/ui/releaseGating.test.js` entry). Plan gating: same as the compressors
(Apply free) unless the owner wants it Pro (§11).

---

## 9. Build phases

1. **Kernel sidechain inputs** — `sidechainIn` on LA2A / FET kernels,
   bit-identical when unset. Smallest change, unblocks everything.
2. **Peaks** — detector + 76 + the Peaks solve, alone. This is the riskiest
   piece (does a pinned 12:1 at dial 6/6 trim peaks without touching the body
   on real narration?), so prove it first with the body-GR readout.
3. **Body + makeup + Mix.** Audition against the 76 → 2A chain built by hand
   in the Plugin Chain (should be near-identical at matched settings — a
   useful test).
4. **De-ess** — embed HF Softener, fed the post-compression level offset.
5. **Parallel, Air, Density** — a parallel 1176 measured on the de-esser's output (was embedded Scheps, §4.4), Air, anchored Inflator.
6. **Panel, presets, chunked apply, smoke.**

### Acceptance tests (minimum)

- All knobs at their "off" positions (Peaks 0, Body 0, Parallel 0, De-ess 0,
  Air 0, Density 0, Mix 100, Output 0) → **pure delay**, bit-exact.
- Peaks: GR at the reference peak within ±0.3 dB of the knob across −30…−6 dBFS
  input levels, while median voiced GR stays under 0.5 dB at Peaks ≤ 4 on
  narration.
- Peaks: never capped — 4 / 7 / 10 dB are each reached to ±0.1 dB, and the
  voice-touched figure grows with the knob and passes the warning by 10.
- Body's avg GR within ±0.5 dB of target across −30…−6 dBFS input levels.
- Parallel holds the source peak (restore + limiter), raises the level, and
  does not undo the de-esser: the top end rises under the level, not with it
  (`test/dsp/voxPressor.test.js`).
- Output never exceeds the source peak, at every Parallel and Density (ceiling + anchored
  Inflator with Clip).
- Preview ≡ apply (sample-identical), chunked ≡ one-thread (≤ −130 dBFS).
- Detector: a plosive burst produces < 1 dB of extra BODY GR vs. the same word
  without it *(the headline vocal-specific claim — measure it)*.

---

## 10. Decided

- **Kept:** the voice detector (plosive and sibilance de-weighting), the
  76 → 2A core, the built-in de-esser.
- **No Presence EQ** (owner, October 2026): replaced by a parallel LA-2A
  stage, the embedded Scheps Parallel in its PRESENCE character — itself since
  replaced by a parallel 1176 (§4.4).
- **Makeup is PER STAGE, always on, no switch** (owner, October 2026): each
  compressor makes up its own level the way it would on its own — the
  compressors' 99.9th-percentile reference (`solveMakeupPlan`), then the
  stage's peak restored to the source's, held by a lookahead limiter —
  1176 first, then the LA-2A on the 1176's output. This is the owner's
  hand-built 1176 → LA-2A chain. On "Messy and Bright" it lands +3.4 to
  +3.8 dB louder at the source peak (the chain: +3.3), almost all from the 1176
  stage; on the earlier narration clip +4.6 to +5.4.
  - *Replaced:* (1) level-matched makeup, stage 1's — never louder; (2) ONE
    peak restore after both stages — the opto lowers the sustained voice more
    than each onset, the crest grows, and one restore hands back only what the
    peak-to-body gap shrank: +1.0 dB at Peaks 3 / Body 4 on "Messy and Bright",
    +2.5 on the earlier clip. ⚠ Synthetic narration does NOT show this
    difference (the two designs land within 0.2 dB there), so it is pinned by
    the owner's clips, not by a unit test.
  - *The trade:* the percentile makeup lifts a few onsets 3–4.7 dB over the
    source peak and the extra level depends on taking them back down. The
    chain's plugins (and the first build of this) bend them with a tanh soft
    ceiling — a waveshaper on loud transients, never voiced.
- **Limiters, not soft ceilings** (owner, October 2026): each stage runs into
  a linked lookahead limiter at the source peak (`dsp/peakLimiter.js`: 2 ms
  half-width, 50 ms upward-only release, 4 ms of latency; reasoned). The
  colour stays the LA-2A's. On "Messy and Bright" at Peaks 3 / Body 4: +3.41 dB
  (tanh: +3.53), peak exactly the source's, gain dipping > 0.5 dB on ~1.7 % of
  samples and > 0.1 dB on ~5 %. To audition: pumping around hard consonants.
- **Body lookahead is on the bench** (October 2026): LA Vintage 2A's own
  Lookahead, 0 / 5 / 10 / 20 ms, off ships, solved with. "Messy and Bright":
  +0.6 dB at 10 ms, +0.8 at 20 (Peaks 3 / Body 4) — and the limiters catch
  MORE with it, not less: taming the onsets lowers the percentile reference,
  so the makeup rises by about as much. Costs its ms of latency and pre-ducks
  consonants at 20.
  - ⚠ The LA-2A stage's makeup moves ~0.3–0.4 dB per 10 dB of recording level
    (its output valve is level-driven by design); the 1176 stage's is exact.
  - ⚠ Regions past the solve's 30 s window re-measure both restores over the
    whole region before apply (`measureVoxPressorExact`); on a 46 s clip the
    window+exact result sat 0.2–0.3 dB under a whole-region solve.
- **The 1176 hears sibilance** (October 2026): with a sibilance shelf on its
  detector one bright "s" on "Messy and Bright" escaped it and, under the
  single-restore makeup, left the clip 3.6 dB quieter. See `peaksTap`.
- **SPEED: AUTO / GENTLE / NORMAL / FAST, with a gain-ripple warning**
  (owner, October 2026). GENTLE A3/R3, NORMAL A4/R4, FAST A6/R6 (the first
  build's pinned timing). AUTO: attack 4, release 16 pitch periods of the
  measured median F0 (100 Hz → 160 ms), clamped to GENTLE..FAST, NORMAL until
  the F0 is measured. Owner's clips, Peaks 3 (dB off peaks / ripple dB):
  Messy and Bright (184 Hz) AUTO 2.7 / −29.5, GENTLE 2.6 / −32.0, FAST
  3.1 / −27.5; David Greenberg (144 Hz) AUTO 3.3 / −25.1, GENTLE 3.2 / −28.2,
  FAST 3.8 / −23.2. The warning (−22) fires on FAST at Peaks 6 on David
  Greenberg (−20.5). ⚠ The ripple figure also rises with how hard Peaks
  works; see `PEAKS_RIPPLE_WARN_DB`. ⚠ A slower speed holds the voice down
  longer after each peak. To audition: a low male narrator (≤ 110 Hz) —
  neither real clip is one.
- **Stage 2: De-ess → Parallel → Density, in that order** (owner, October
  2026: de-ess before the parallel stage). Defaults De-ess 40 (the HF
  Softener's Amount, Split pinned at its panel default 33, Guard 100),
  Parallel 30 % PRESENCE, Density 30 %. Measured on the owner's clips (30 s,
  loudness / energy above 5 kHz vs the source; core = Peaks 3 / Body 57 / AUTO):
  Messy and Bright core +2.44 / +4.84 dB, + De-ess +2.30 / +0.77, + Parallel
  +2.61 / +0.21, + Density +3.57 / +1.33; David Greenberg core +4.98 / +7.05,
  + De-ess +4.93 / +5.28, + Parallel +5.34 / +5.26, + Density +6.34 / +6.35.
  Peak at or under the source throughout. The measurement grew to ~1.8–2.1 s
  per 30 s window (the de-esser's render and Scheps' trim solve). Parallel is
  bypassed until its measurement lands; Density until the source peak is known.
- **Parallel is a 1176, not Scheps** (owner, October 2026, after Scheps'
  stage added only 0.2–0.4 dB — see §4.4 for why and the measurements).
  PRESENCE / THICK went with it. New York compression with the LA-2A mix law
  (makeup solved on the blend at the 99.9th percentile), its detector hearing
  sibilance +15 dB, a peak restore. All defaults now: Messy and Bright +4.28
  dB of loudness / +1.63 above 5 kHz (was +3.57 / +1.33), David Greenberg
  +6.82 / +7.14 (was +6.34 / +6.35). Measurement ~2.5 s per 30 s window once
  warm; the parallel solve is ~0.35 s of it.
- **No breath / room expander** (owner, October 2026): too hard to tune for
  the value. Compression will lift breaths and room tone between phrases;
  that is left to Noise Reduction or the preset chain's `vocalExpander`.

## 11. Open decisions for the owner

0. **Stage 1 audition** (dev panel, registry id `vox-pressor`): does the 1176 →
   LA-2A core sound right on real narration at the default Peaks 3 / Body 4?
   Specifically: (a) does Peaks 3 take the loudest syllables down without
   audible clamping; (b) does the voice detector make the LA-2A ride better
   than a plain LA Vintage 2A on plosive-heavy takes (synthetic tests say the
   difference is small, see §3); (c) settled: per-stage makeup.

1. **DECIDED (see §10): SPEED.** The measurements that led to it:
   **The 1176's timing — the pinned attack 6 / release 6 can be destructive.**
   Owner, October 2026: the 1176 imparts modulation distortion on some voices
   at fast attack / release, and a pinned setting must not be one that harms a
   voice. Measured (modulation products re the signal):
   - Held vowels at ~6 dB of reduction, attack 6, release dial 1 → 7:
     70 Hz −39.8 → −20.0 dBc, 100 Hz −43.0 → −21.7, 140 Hz −46.0 → −21.7,
     200 Hz −53.3 → −32.9. At the shipped release 6: −21.6 / −23.1 / −26.0 /
     −36.3. Release moves it ~4 dB a step; attack (release 6, dial 1 → 7)
     only 5–6 dB over its whole travel. Low voices are the exposed ones.
   - On real speech (the gain trajectory's motion above 20 Hz, voice-weighted,
     Peaks 3), attack and release both matter: release 6 → 3 buys 2–4 dB,
     attack 6 → 1 buys 2–7 dB. Slower pairs catch less per knob step
     (Messy and Bright: A6/R6 2.5 dB off peaks, −28.9 dBc; A3/R3 2.1, −33.5;
     A2/R3 1.7, −35.0) and touch the voice slightly more.
   Options: a voice-adaptive release from the measured F0 (the profile is
   already measured for the detector), safer fixed timing, or a SPEED control
   with a modulation readout that warns as Peaks' voice-touched does.
2. **Plosives in the Peaks detector** — let the 76 see them (proposed, so it
   can trim them) or de-weight them for the 76 too and leave plosive peaks to
   the ceiling / Plosive Tamer?
3. **Density with or instead of the LA-2A harmonics** — stacked (proposed),
   with "instead" on the bench?
4. **Parallel and Density together** — keep both (proposed; different
   mechanisms), or drop the Inflator now that Parallel adds density? And with
   Parallel on the panel, is the outer **Mix** still needed, or is it a second,
   confusing dry/wet control?
5. **Density's loudness** — accept that it makes the A/B louder (proposed), or
   level-match the A/B in the preview only?
6. **Chain order** — pin 76 → 2A, or expose a 2A → 76 A/B on the bench?
7. ~~Peak restore on apply~~ — settled: VoxPressor restores the peak in preview
   AND apply (§10). Preview and apply agree except where the region outgrew the
   solve's 30 s window, where apply's exact makeup can be lower.
8. **Tier** — free like the compressors, or Pro like Auto Leveler / Plugin Chain?
9. **Name on the toolbar** — "VoxPressor" in Dynamics, or its own top-level
   "Voice" entry for Mode 1/2 users who never open Dynamics?
