# VoxPressor — Vocal Dynamics & Enhancement Plugin Spec

> Status: **DRAFT for owner review** (October 2026). Nothing here is built. Every
> number marked *reasoned* is a starting point to be measured or auditioned, per
> this repo's habit of saying which numbers are which.

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
| "Enhance" (presence, air, density) is four more plugins | EQ, Air Boost, Cambridge Inflator, Saturation Workbench | Three voice-aimed knobs, each measurement-calibrated |

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
   ├─ [3] DE-ESS  — HFSoftenerKernel (Duck + EQ, lisp guard)
   ├─ [4] TONE    — Presence bell (dynamic) · Air (voiced-only)
   ├─ MAKEUP      — percentile reference + source-peak soft ceiling (dsp/makeupReference.js)
   ├─ [5] DENSITY — InflatorKernel, anchored so the ceiling sits at f(1) = 1, Clip on
   └─ MIX         — delay-compensated dry/wet (equal-power, as Scheps)
       └─ OUTPUT trim ─ out
```

### Order rationale (pinned, not user-reorderable)

- **76 before 2A.** The canonical vocal chain: the FET takes the fast onsets so
  the opto isn't yanked by them and can ride the phrase smoothly. Reversing it
  makes the 2A pump on every plosive that survives. *(Owner may want this as a
  bench A/B; see §11.)*
- **De-ess after compression.** Compression raises sibilance relative to the
  body; a de-esser before it is undone. The HF Softener's thresholds already
  follow the file's gated RMS (`levelOffset`), so it needs to hear the
  *post-compression* level — the kernel is fed a re-measured offset (§5).
- **Tone after dynamics.** Presence and air pushed into a compressor get
  compressed back out; after it they stay where the user put them.
- **Density after makeup and the ceiling.** The Inflator's curve is defined
  against full scale, so it has to see a signal whose peak is known. After the
  ceiling, the loudest sample is at most the source peak, which is exactly the
  point the curve is anchored to (§4.3).

---

## 3. The voice detector (the one genuinely new DSP block)

Fed from the aligned input. Built once, tapped twice.

1. **High-pass at the speaker's rumble corner** — `measureVoiceProfile().cornerHz`
   (`voiceProfile.js`, the same number VoiceRx and Reso Soothe use: 40–100 Hz,
   measured once per file). 2nd order. Falls back to 80 Hz if the profile
   returns `null` (too few voiced frames).
2. **Plosive de-weighting** — a further 6 dB/oct shelf down below 150 Hz
   *(reasoned)*, so a "p" that passes the high-pass still doesn't dominate.
3. **Sibilance de-weighting** — a high-shelf cut, −9 dB above 5 kHz *(reasoned)*.
   The compressors should ride the vowels; sibilance is the de-esser's job. Without
   this the compressor and de-esser both cut on an "s" and it lisps.

**The two compressors tap it differently.**

| Tap | HP | Plosive shelf | Sibilance shelf | Why |
|---|---|---|---|---|
| BODY (2A) | ✓ | ✓ | ✓ | An opto release is hundreds of ms to seconds: a plosive in its detector ducks the rest of the phrase |
| PEAKS (76) | ✓ | **✗** | ✓ | A plosive is often the loudest peak in a narration take. The FET's release is tens of ms, so catching one costs a few ms of gain, and *not* catching it leaves it to the ceiling. Peaks the FET can't see are peaks the Peaks knob can't trim |

**Wiring.** Neither kernel takes an external sidechain today. Add an opt-in
`sidechainIn` (per-sample detector buffer) to `LA2AKernel` and `FET1176Kernel`,
**bit-identical when unset** (same contract as the FET's `transientCornerHz`
forwarding on the HF Limiter). Test: `undefined sidechain renders bit-identical`
for both kernels.

⚠ The FET ships with a **feedback** detector (reads the cell output). An
external sidechain is necessarily feed-forward on the *detector filter*, but the
loop can stay feedback by filtering the cell output with the same voice filter.
Implement it that way — the attack fit (`FB_ATTACK_*`) assumes feedback.

---

## 4. Controls

### 4.1 Front panel (Modula, single face)

| Knob | Range | Default | What it does |
|---|---|---|---|
| **Peaks** | 0–10 dB | 3 | dB taken off the loudest voice peaks by the 76 (§4.2). Solved per file. 0 = stage out, a pure delay |
| **Body** | 0–100 | 40 | Average leveling by the 2A: target avg GR on voiced material, ~0–10 dB *(reasoned)*, solved per file on the Peaks stage's output |
| **De-ess** | 0–100 | 40 | HF Softener **Amount** (Split pinned at its default 33; Guard 100) |
| **Presence** | −6…+6 dB | +1.5 | Dynamic bell at the voice's presence peak (2–5 kHz, placed from VoiceRx's analysis). Boost is *ducked* while the de-esser cuts, so it can't feed the sibilance it is next to |
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

**The solve.** Input drive is bisected so that the 76's gain reduction at the
voice's loudest peaks equals the knob:

1. **Reference peak:** the 99.9th percentile of |x| on the aligned input
   (`percentileOfChannels(…, MAKEUP_PERCENTILE)`), the same "loudest thing that
   isn't a one-sample outlier" statistic the makeup reference uses.
2. **Measure GR at those samples** on a render of the 76 alone. Only the loudest
   blocks matter, so use PHAT*SS's **fast bounded search**: sort blocks by input
   peak, render loudest first with pre-roll, stop once no remaining block can
   reach the reference. Typically a few seconds of audio per solve.
3. **Re-solve exactly on apply**, cached by document + span + Peaks.

**Keeping it on the peaks — the body guard.** The knob is a target, and a large
target on a low-crest voice would push the threshold into the body. So:

- **Threshold floor:** the solve never sets the effective threshold below the
  file's gated RMS + 6 dB *(reasoned)*. If the target needs more, it stops
  there.
- **Report the shortfall:** the knob's readout then shows what was achieved
  ("3.0 → 2.1 dB, voice crest too low"), the same honesty Loudness Normalize's
  SAFE mode uses.
- **Body GR meter:** the PEAKS bar shows median GR on voiced blocks under the
  peak GR. If the median goes over 0.5 dB, it turns amber: the 76 is compressing
  the voice, not trimming it.

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

### 4.4 Meters

- IN / OUT ladders (`LevelMeter variant="modula"`).
- Three stacked GR bars: **PEAKS** (76, with the body-GR tick from §4.2),
  **BODY** (2A), **DE-ESS**.
- The HF Softener's activity scope is *not* included — one scope per window is
  enough, and it is the busiest part of that panel.

### 4.5 Advanced (dev bench, gated like the PHAT*SS bench)

Peaks patch (ratio, attack, release, threshold floor), Body ballistics, detector
corner/shelf depths per tap, Inflator Curve and Band Split, the Color switch,
chain-order A/B, `VOX_LEGACY_PATCH`. Nothing on the bench ships to presets.

---

## 5. Measurements (never user settings, never in presets)

All measured once per file / selection, in the worker, against the **running
`segments`** when in the Plugin Chain (CLAUDE.md rule):

| Measurement | Source | Used by |
|---|---|---|
| Gated RMS → input align | `dsp/inputAlign.js` | Both compressor stages' drive offset; Peaks threshold floor |
| Rumble corner, median F0 | `voiceProfile.js` | Detector HP; Presence placement |
| Presence peak frequency | VoiceRx analysis (port of Stage 3a) | Presence bell centre |
| Reference peak (99.9th pct) | `percentileOfChannels` | Peaks solve |
| Peaks drive | bounded search over loudest blocks (§4.2) | 76 Input |
| Body drive | sampled render of [1]–[2], bisected | 2A Peak Reduction |
| Post-compression gated RMS | render of stages [1]–[2] on ≤ 400 blocks | De-ess `levelOffset` |
| Makeup plan | `solveMakeupPlan` (iterated — the 2A's valve makes output non-affine) | Output AUTO |
| Source peak | `peakOfChannels` | Ceiling; Density anchor |

⚠ **The solves are sequential.** Peaks first (on the input), then Body (on the
Peaks output), then the de-ess offset and makeup. Moving Peaks invalidates
everything after it; moving Body invalidates de-ess and makeup only. Cache by
document + span + the knobs upstream of each solve.

---

## 6. Latency, apply, chunking

- Latency: FET 50 + LA-2A 50 + Inflator 50 (all 4x oversampled) =
  **150 samples, constant**, reported once and trimmed by the apply path. Dry
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

A preset stores the eight panel values only. *All reasoned, to be auditioned.*

| Preset | Peaks | Body | De-ess | Presence | Air | Density | Mix |
|---|---|---|---|---|---|---|---|
| **Default** | 3 | 40 | 40 | +1.5 | 1.5 | 30 | 100 |
| **Audiobook Natural** | 2 | 30 | 35 | +0.5 | 1 | 15 | 100 |
| **Podcast Punch** | 5 | 50 | 50 | +3 | 2 | 50 | 100 |
| **Voiceover Forward** | 6 | 60 | 55 | +4 | 3 | 60 | 100 |
| **Gentle Glue** | 1 | 35 | 30 | 0 | 0 | 20 | 50 |

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
5. **Tone + Density** — Presence, Air, anchored Inflator.
6. **Panel, presets, chunked apply, smoke.**

### Acceptance tests (minimum)

- All knobs at their "off" positions (Peaks 0, Body 0, De-ess 0, Presence 0,
  Air 0, Density 0, Mix 100, Output 0) → **pure delay**, bit-exact.
- Peaks: GR at the reference peak within ±0.3 dB of the knob across −30…−6 dBFS
  input levels, while median voiced GR stays under 0.5 dB at Peaks ≤ 4 on
  narration.
- Peaks: on a low-crest file the solve stops at the threshold floor and reports
  the shortfall rather than compressing the body.
- Body's avg GR within ±0.5 dB of target across −30…−6 dBFS input levels.
- Output never exceeds the source peak, at every Density (ceiling + anchored
  Inflator with Clip).
- Preview ≡ apply (sample-identical), chunked ≡ one-thread (≤ −130 dBFS).
- Detector: a plosive burst produces < 1 dB of extra BODY GR vs. the same word
  without it *(the headline vocal-specific claim — measure it)*.

---

## 10. Decided

- **Kept:** the voice detector (plosive and sibilance de-weighting), the
  76 → 2A core, the built-in de-esser.
- **No breath / room expander** (owner, October 2026): too hard to tune for
  the value. Compression will lift breaths and room tone between phrases;
  that is left to Noise Reduction or the preset chain's `vocalExpander`.

## 11. Open decisions for the owner

1. **Peaks as proposed?** One knob in dB off the loudest peaks, 76 patch pinned
   at 12:1 / attack 6 / release 6, threshold floor at gated RMS + 6 dB. Or keep
   a punch control on the panel (e.g. attack 4 ↔ 7)?
2. **Plosives in the Peaks detector** — let the 76 see them (proposed, so it
   can trim them) or de-weight them for the 76 too and leave plosive peaks to
   the ceiling / Plosive Tamer?
3. **Density with or instead of the LA-2A harmonics** — stacked (proposed),
   with "instead" on the bench?
4. **Density's loudness** — accept that it makes the A/B louder (proposed), or
   level-match the A/B in the preview only?
5. **Chain order** — pin 76 → 2A, or expose a 2A → 76 A/B on the bench?
6. **Peak restore on apply** — LA Classic 76 restores the peak to the ceiling
   on apply (the one place preview ≠ apply). Inherit that, or keep VoxPressor
   sample-identical and level-matched for the A/B?
7. **Tier** — free like the compressors, or Pro like Auto Leveler / Plugin Chain?
8. **Name on the toolbar** — "VoxPressor" in Dynamics, or its own top-level
   "Voice" entry for Mode 1/2 users who never open Dynamics?
