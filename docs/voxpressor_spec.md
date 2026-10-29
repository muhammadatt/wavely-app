# VoxPressor — Vocal Dynamics & Enhancement Plugin Spec

> Status: **DRAFT for owner review** (October 2026). **Stage 1 is built** (dev
> only, registry id `vox-pressor`): the voice detector and the Peaks (1176) →
> Body (LA-2A) core with level-matched makeup and the source-peak ceiling.
> Parallel, De-ess, Air and Density are not built yet. Every number marked
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
   ├─ [2] BODY    — LA2AKernel (opto, rides the phrase)       ◄── detector (full)
   ├─ [3] PARALLEL — SchepsKernel, PRESENCE (or THICK): Pultec push → LA-2A → Pultec recovery, blended with its own delayed dry
   ├─ [4] DE-ESS  — HFSoftenerKernel (Duck + EQ, lisp guard)
   ├─ [5] AIR     — Air Boost curve, voiced-only
   ├─ MAKEUP      — level-matched (gated RMS) + source-peak soft ceiling (dsp/makeupReference.js)
   ├─ [6] DENSITY — InflatorKernel, anchored so the ceiling sits at f(1) = 1, Clip on
   └─ MIX         — delay-compensated dry/wet (equal-power, as Scheps)
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
- **De-ess after compression *and* the parallel stage.** Compression raises
  sibilance relative to the body, and the parallel stage's pre-EQ is an 8 kHz
  push into a cell that then spends its reduction on sibilance (Scheps'
  own module notes this). A de-esser before either is undone. The HF Softener's thresholds already
  follow the file's gated RMS (`levelOffset`), so it needs to hear the
  *post-compression* level — the kernel is fed a re-measured offset (§5).
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
| PEAKS (76) | ✓ | **✗** | ✓ | A plosive is often the loudest peak in a narration take. The FET's release is tens of ms, so catching one costs a few ms of gain, and *not* catching it leaves it to the ceiling. Peaks the FET can't see are peaks the Peaks knob can't trim |

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
| **Peaks** | 0–10 dB | 3 | dB taken off the loudest voice peaks by the 76 (§4.2). Solved per file. 0 = stage out, a pure delay |
| **Body** | 0–100 | 40 | Average leveling by the 2A: target avg GR on voiced material, ~0–10 dB *(reasoned)*, solved per file on the Peaks stage's output |
| **De-ess** | 0–100 | 40 | HF Softener **Amount** (Split pinned at its default 33; Guard 100) |
| **Parallel** | 0–100 % (+ PRESENCE / THICK toggle) | 30, PRESENCE | Scheps Parallel's **Mix** (§4.4). The squashed, Pultec-coloured LA-2A copy blended under the voice. 0 = stage out, a pure delay |
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

**What the user sets:** one number, "dB off the loudest peaks". Same contract
as PHAT*SS's TAPE knob (the dB taken off the selection's peak, solved per file).
Everything else on the 1176 is pinned or solved.

**Pinned patch** *(reasoned, to audition)* — the classic peak-catcher setting:

| 1176 control | Value | Why |
|---|---|---|
| Ratio | 12:1 | Limiting, not leveling. The moving threshold (`ratioThreshold: 'moving'`) raises it 2.7 dB over 4:1, which the solve absorbs |
| Attack | dial 6 | Fast enough to take a consonant onset, one short of 7 so the first cycle of a vowel isn't sliced |
| Release | dial 6 | Recovers within tens of ms so the body between peaks is untouched. Not 7: at 7 the feed-forward release rode bass cycles (+1.1 to +1.4 dB of modulation). `fbRelease: 'open'` fixed that, but 6 keeps the margin |
| Output | 0 | Makeup is VoxPressor's, at the end |
| Mix | 1 | Parallel is VoxPressor's own Mix |
| Input | **solved** | See below |

**The solve (built, `voxPressorSolve.js`).** The 1176's Input knob stays at 50
with Output cancelling its drive, so the audio gain through the stage is unity;
the solve moves a **detector-only offset** (`inputAlignDb`) instead:

1. **What "dB off the peaks" means:** split the region into 100 ms blocks; take
   the loudest 10 % by peak (5–60 blocks); the reduction is the **median** over
   those blocks of input peak − output peak.
2. **First guess from the static curve** (put the loudest peaks' detector level
   `target / slope` dB over the threshold), then a safeguarded secant on
   renders of the 1176 alone at the base rate. 3–5 renders.
3. **Re-solved before apply** unless the last solve was for exactly this
   timeline, region and pair of targets.

Measured: on 30 s of synthetic narration at −34 / −24 / −14 dBFS the solve lands
Peaks within 0.05 dB and the offset shifts by exactly 10 dB per 10 dB of level;
a whole solve (Peaks + Body + makeup) takes 1.2–1.6 s when the voice corner is
already known (the first solve on a region also measures it, ~1.2 s more).

**Keeping it on the peaks — warn, don't cap (owner's decision).** The knob
always delivers what it asks for; what that costs the voice is measured and
shown:

- **Voice readout:** under the Peaks knob, "voice touched X dB" is the median
  level drop on the voiced blocks. Past `PEAKS_BODY_WARN_DB` (0.5 dB,
  *reasoned*) it turns amber and adds "compressing the voice".
- **Why no cap:** stage 1 shipped a fixed floor (the knee kept ≥ 8 dB over the
  detector's gated level). On a real narration clip (−1 dBFS peak, −20.9 dBFS
  gated) it stopped Peaks at 2.57 dB for every setting from 3 to 10 while the
  voice measured 0.01 dB touched. Uncapped, the same clip reads (Peaks →
  voice touched): 3 → 0.01, 4 → 0.07, 6 → 0.62, 8 → 1.84, 10 → 3.45 dB.

**Why not fully automatic (no knob)?** How much peak to take is a taste call
(narration ~2–3 dB, podcast punch ~5–6). A fixed crest target would be wrong
on half the voices. One knob in dB is the smallest honest control, and AUTO
could be a preset value rather than a mode.

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
  The ceiling guarantee survives Density at every setting, with no guard stage.
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

### 4.4 Parallel — Scheps Parallel, embedded

**Embed `SchepsKernel` rather than a second bare LA-2A.** It already *is* a
parallel LA-2A built for presence and density on voice, and everything a bare
parallel copy would need is solved there:

- **Pre-EQ that aims the cell.** The Pultec push cuts ~4.7 dB of lows before the
  LA-2A and lifts 8 kHz, with R37 pinned fully counter-clockwise, so the cell
  rides the presence band instead of ducking on chest and plosives. The recovery
  EQ after it is a real, measured curve, not an exact inverse, and that residue
  is the sound.
- **Two characters, both measured:** **PRESENCE** (8 kHz push, 20 kHz recovery;
  `docs/scheps_vocal_chain_presence_spec.md`) and **THICK** (net +4 dB at 30 Hz;
  `docs/scheps_vocal_chain_thick_spec.md`). PRESENCE ships as the default, since
  that is what this stage is for; THICK is a toggle beside the knob.
- **Its own delay-compensated dry path** inside the kernel, so the blend doesn't
  comb-filter.
- **A mix law that keeps level while adding density:** equal power, corrected
  for the measured dry/wet correlation, and passing through the compression's
  yield (`densityDb`) so turning Parallel up *gently raises loudness* instead of
  being level-flat. That is the density being asked for.
- **Auto wet trim, input alignment, and a ceiling at its own output** (the
  source peak), all measured (`computeSchepsAutoTrim`).

**What is pinned and what is exposed:**

| Scheps control | In VoxPressor |
|---|---|
| Mix | **Parallel** knob |
| Character | PRESENCE / THICK toggle |
| Squash (Peak Reduction) | Pinned at its calibrated 40 (~7.6 dB peak GR on the wet copy), on the bench |
| Wet trim, correlation, density, alignment | Measured, as in Scheps |
| Output | 0 (VoxPressor's makeup does this) |

⚠ **Measure it on what it hears.** Standalone, Scheps measures the file it is
given. Here it must measure the **Body stage's output**, so its trim and
alignment are solved after Body (§5). Measuring the raw input would over-drive
the cell by however much leveling Body did.

⚠ **0 must be a true bypass.** At Mix 0 Scheps is bit-exact against its
delayed input *except* for its ceiling's knee (a known ~0.25 dB residual). So
Parallel 0 skips the stage and runs a 50-sample delay instead.

⚠ **Overlap with Density.** Both now add density: Parallel by dynamic upward
compression with a presence tilt, Density by a static curve with odd harmonics.
They are different mechanisms, but presets should not max both (§11).

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
| Gated RMS → voiced-block gate | `dsp/inputAlign.js` | Body solve; Peaks voice-touched readout; makeup |
| Rumble corner, median F0 | `voiceProfile.js` | Detector HP |
| Loudest blocks (by peak), voiced blocks (gated RMS − 10 dB) | `referenceBlocks` | Peaks / Body solves |
| Peaks offset | secant on 1176 renders (§4.2) | 76 `inputAlignDb` |
| Body offset | secant on LA-2A renders of the Peaks output; avg cell GR on voiced blocks | 2A `inputAlignDb` (Peak Reduction pinned at 50) |
| Parallel trim, correlation, density, alignment | `computeSchepsAutoTrim` on the Body output | Parallel stage |
| Post-compression gated RMS | render of stages [1]–[3] on ≤ 400 blocks | De-ess `levelOffset` |
| Makeup | closed form: gated RMS in − gated RMS out (the makeup is the last multiply) | Output AUTO |
| Source peak | `peakOfChannels` | Ceiling; Density anchor |

⚠ **The solves are sequential.** Peaks first (on the input), then Body (on the
Peaks output), then Parallel's trim (on the Body output), then the de-ess
offset and makeup. Moving a knob invalidates every solve after its stage;
Parallel's Mix and character invalidate only de-ess and makeup. Cache by
document + span + the knobs upstream of each solve.

---

## 6. Latency, apply, chunking

- Latency: FET 50 + LA-2A 50 + Scheps 50 + Inflator 50 (all 4x oversampled) =
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

A preset stores the eight panel values and the Parallel character only. *All reasoned, to be auditioned.*

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
src/audio/voxPressorSolve.js         Peaks / Body solves (worker side)
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
5. **Parallel, Air, Density** — embedded Scheps measured on the Body output, Air, anchored Inflator.
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
- Parallel at matched settings is sample-identical to standalone Scheps Parallel
  fed the Body stage's output.
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
  stage, the embedded Scheps Parallel in its PRESENCE character.
- **Makeup is level-matched, not percentile-referenced** (stage 1, October
  2026). The compressors' shared 99.9th-percentile reference is near-peak by
  design, and the Peaks stage exists to move exactly those samples: referenced
  to them, the makeup handed back what the 1176 took (+7.0 dB at Peaks 3 /
  Body 4) and the soft ceiling did the peak control as a clipper. Matched on
  the gated level instead, the voice comes out as loud as it went in and the
  peaks come out lower; Loudness Normalize spends the headroom. *Owner to
  confirm by ear.*
- **No breath / room expander** (owner, October 2026): too hard to tune for
  the value. Compression will lift breaths and room tone between phrases;
  that is left to Noise Reduction or the preset chain's `vocalExpander`.

## 11. Open decisions for the owner

0. **Stage 1 audition** (dev panel, registry id `vox-pressor`): does the 1176 →
   LA-2A core sound right on real narration at the default Peaks 3 / Body 4?
   Specifically: (a) does Peaks 3 take the loudest syllables down without
   audible clamping; (b) does the voice detector make the LA-2A ride better
   than a plain LA Vintage 2A on plosive-heavy takes (synthetic tests say the
   difference is small, see §3); (c) is the level-matched makeup the right
   default?

1. **Peaks as proposed?** One knob in dB off the loudest peaks, 76 patch pinned
   at 12:1 / attack 6 / release 6, uncapped with a voice-touched warning. Or keep
   a punch control on the panel (e.g. attack 4 ↔ 7)?
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
7. **Peak restore on apply** — LA Classic 76 restores the peak to the ceiling
   on apply (the one place preview ≠ apply). Inherit that, or keep VoxPressor
   sample-identical and level-matched for the A/B?
8. **Tier** — free like the compressors, or Pro like Auto Leveler / Plugin Chain?
9. **Name on the toolbar** — "VoxPressor" in Dynamics, or its own top-level
   "Voice" entry for Mode 1/2 users who never open Dynamics?
