# Instant Polish — Client Vocal Chain: Design Specification
> Version 0.1 | Draft | September 2026
> Addendum to `instant_polish_processing_spec_v3.md`
> Status: **Design agreed, nothing implemented.** Every numeric constant below is a
> starting point to be measured, not a fitted value. Where a number is inherited
> from a shipping plugin it is marked ⚠ and the reason it cannot simply be copied
> is stated.
> Working name: **Vocal Chain** (`vocal-chain`). Naming is open.

---

## Overview

A single client-side plugin that is, in concept and in goal, the browser-side
equivalent of the server mastering chain: cleanup, tone, dynamics, enhancement
and delivery conformance behind one faceplate.

It is **not** a port of the server pipeline, and it is **not** the existing
plugins arranged on a shared faceplate. It is a chain designed for podcast and
audiobook voice, built out of the DSP kernels this repo already has.

### What makes it a chain rather than a rack

The server pipeline's organising idea is not its stage list. It is that
**compression is crest-factor driven with a descending target across passes** —
`acx_audiobook` runs three passes at 14 → 13 → 12 dB target crest,
`podcast_ready` runs 14 → 10 — and that every stage's settings are derived from
measurements of the file rather than dialled by hand.

This plugin takes that idea literally:

1. One **Analyze** pass measures the region.
2. Every section's operating point is derived from that measurement.
3. Each section exposes **one macro**, and a solve distributes that macro across
   the devices underneath it.

A rack cannot do step 3, which is the entire reason this is not a rack.

### Why measurement-derived operating points are non-negotiable

This codebase has paid for this lesson twice, and both incidents are recorded in
`CLAUDE.md`:

- OptoSmooth had no threshold control (correctly — the hardware has none), so
  what Peak Reduction 50 *did* was set by the file's level: 4.62 dB of reduction
  at −1 dBFS peak, 0.36 at −12, **0.00 at −18**. A narrator who gain-staged with
  headroom got a plugin that did nothing at its own default. `dsp/inputAlign.js`
  exists to close that.
- Scheps' `squash` default has been recalibrated twice for inherited changes, and
  once shipped 4× the intended gain reduction because a fix landed on the kernel
  defaults and not the panel's.

A serial chain of six devices multiplies that exposure by six. **Every device in
this chain that drives a fixed internal threshold must be level-aligned before it
is allowed into the chain.** See *Prerequisites*.

---

## Signal Chain

```
                    ┌─ ANALYZE (once per region, whole-region, in a worker) ─┐
                    │  gated RMS · peak · crest · F0 · noise floor ·          │
                    │  corrective EQ bands · sibilance stats · hum            │
                    └────────────────────┬───────────────────────────────────┘
                                         │ derives every operating point below
                                         ▼
  ┌─────────────┐   ┌──────────────────────────────────────────────────┐   ┌─────────┐
  │ 3 · LEVEL   │   │  ONE COMPOSITE WORKLET                           │   │ 6 ·     │
  │             │──▶│                                                  │──▶│ DELIVER │
  │ GainNode    │   │  1 REPAIR → 2 TAME → 4 DYNAMICS → 5 TONE         │   │ (solve) │
  │ + envelope  │   │                                                  │   │         │
  └─────────────┘   └──────────────────────────────────────────────────┘   └─────────┘
       0 lat                        150 samples                              0 lat
```

Section 4, expanded — this is the part that was designed rather than assembled:

```
 in ─▶ Soft Clip ─▶ FET Punch ─▶ ┌─ dry ──── delay(50) ──────────────────┐
       limiter: 0    scHpf on    │                                       ├─ Mix ─▶ out
       (into the     (fast grab) └─ wet ─ Pultec pre ─ Opto ─ Pultec post ┘
        detectors)
```

Sections are numbered in signal order. LEVEL is section 3 because it is section 3
of the *design*, even though it runs first as a node — see *Architecture*.

---

## Section 1 · REPAIR

Static, measured, zero latency. Everything here is a `BiquadCascade`.

| Component | Source | Derived from |
|---|---|---|
| HPF | `dsp/biquad.js` `highpass` | Measured F0 floor, not a fixed 80 Hz |
| Hum notches | `HumNotchKernel`, `dsp/humDetect.js` | Auto-armed **only** if hum is detected |
| Corrective EQ | `voicerx/analysis.js` | The file's own cepstral envelope |

**Macro: Repair 0–100**, scaling the corrective gains and notch depth together.

The corrective EQ is the client port of the server's Stage 3a and needs no corpus
and no reference curve — the reference is the file's own spectrum, anchored just
outside each scan region. That is what makes it usable in a spot-editing tool at
all; `referenceEQ`'s corpus route is not portable here.

⚠ Ships with the `chord` baseline, matching `voicerx/analysis.js`'s shipping
default. Do not silently substitute `trend`: the two make opposite errors and the
choice is a listening decision already taken once, documented at length in that
file's header.

⚠ **The HPF corner is derived, not dialled, and that is a real behaviour change
versus the server's fixed `hpf` stage.** `dsp/f0.js` bounds F0 to 70–400 Hz; the
corner should sit a stated margin below the measured floor and must fall back to
a fixed corner when `computeVoiceProfile` returns null (no pitched material). A
null profile is not an error and must not produce a fallback correction.

---

## Section 2 · TAME

Dynamic spectral control. Replaces **both** the server's `clipGainDeEss` and
`resonanceSuppressor`, because they are one problem: excess over a local
reference, reduced dynamically.

**Macro: Tame 0–100.**

### Implementation: time domain, not STFT

Build this as a crossover plus `AttackReleaseFollower` (`dsp/envelope.js`) driving
a dynamic shelf/bell pair, with the sibilance band placed from the measured F0.

⚠ **Do not embed `ResonanceKernel` here, despite it being the better resonance
detector.** Its apply path has a known STFT grid-phase error — `applyWorkletRegion`'s
own comment records that pre-roll cannot fix it and that a render which happens to
land hop-aligned "looks exact and is not". Importing a preview/apply divergence
into the flagship chain is the wrong trade: preview ≡ apply is this app's single
strongest invariant and the reason every plugin renders through its own worklet.

ResoTame stays a separate surgical plugin. Revisit only if the grid-phase error is
closed on its own terms.

⚠ **The existing client de-esser cannot be reused.** `effects/clipGainDeEss.js`
has no DSP at play time by design — it replays a gain envelope computed from
**server-side** sibilance detection. It is excellent at what it does and is
useless to a self-contained client chain. This section is new DSP.

---

## Section 3 · LEVEL

Ahead of the dynamics. The server's `autoLevel`, and the reason its compression
passes sound effortless. ✓ **DSP landed** (`src/audio/dsp/autoLevel.js`); not yet
wired to a node, an apply path or a panel.

**Macro: Level 0–100**, scaling max up/down travel.

⚠ **It is NOT "slow gain riding", which is what this spec first called it.** The
server's leveller is **clip-based**: segment into voiced clips, give each clip
ONE flat gain, crossfade between them at the quietest point in the gap. Nothing
is smoothed continuously. That matters here — a continuously-ridden gain is a
slow compressor wearing a different name, and it flattens exactly the
syllable-scale movement the DYNAMICS section is supposed to act on. Piecewise-
constant preserves the dynamics *inside* a clip exactly.

### Two things the port had to decide

⚠ **The voiced mask is energy, not Silero — and not `F0Tracker` either.** There
is no Silero in the browser. `frameAnalysis.js` ships an **energy backend** as a
first-class path (`VAD_BACKEND=energy`), used whenever Silero is unavailable, and
that is what is ported: frame RMS against `noiseFloor + 6 dB`. This is a
different substitution from VoiceRx's, and the two are not interchangeable —
VoiceRx wants *pitched* frames because its computation is about harmonic
structure; a leveller wants "is anyone talking", where a pitch tracker would drop
every fricative outright.

The cost is real and lands in one place: an energy gate labels quiet fricatives
and breaths as silence, which could **fragment** a clip at its own "s". The
hysteresis absorbs it — an unvoiced run under 300 ms is bridged, and speech
fricatives are always shorter than that. Measured: a sub-300 ms gap inside speech
is bridged, a real pause is not.

⚠ **The head step is a server behaviour this port deliberately does not copy.**
`buildSampleGainArray` fills everything before the first clip with 0 dB and the
clip with its own gain, so the envelope jumps by the whole of that gain on one
sample — landing exactly where the first word begins. Measured at 6.00 dB. Every
ACX file meets it, because `roomTonePad` exists to put 0.75 s of room tone at the
head. The port adds a head ramp using the rule the other boundaries already
follow (quietest window in the preceding silence): 6.00 dB → 7.12e-3 dB.

### Measured

On 60 s of narration with a 20 dB drift, `global` mode: clip loudness spread
sd 5.75 → 1.60 dB, range 18.33 → 4.33 dB. A file already inside the deadband is
skipped outright (`file_already_leveled`) rather than nudged, so a level file
comes back bit-identical.

### Implementation: a precomputed envelope, not a live follower

Measure over the whole region, build a gain envelope, render it into an
`AudioBuffer`, drive a `GainNode`'s `gain` AudioParam with it — exactly the
modulator pattern `effects/clipGainDeEss.js` documents and has verified
sample-exact.

Three things fall out of that choice, and together they are why it is not a
worklet stage:

- **Zero latency.**
- **No convergence problem.** A 30–60 s analysis window cannot be pre-rolled; a
  live follower with that time constant has no correct cold-start behaviour.
- **Preview ≡ apply structurally**, not by measurement. The envelope is the same
  buffer in both paths.

⚠ **Whole region, never window-capped.** `analysisWindow.js`'s 30 s centred cap
(`AUTO_MAKEUP_MAX_ANALYSIS_S`) is right for the makeup measurements and wrong
here, for the reason the loudness normalizer already states for
`measureWholeRegionInWorker`: a chapter that opens loud would normalize the rest
of the recording down to match. Long-term drift is the quantity being removed, so
the measurement must span the drift.

⚠ **Pin the modulator buffer to the region, not the timeline.** The de-esser's
envelope is scheduled with the same `when`/`offset` arithmetic as the audio,
which is what makes alignment a property of construction rather than something to
maintain on every seek. Follow that exactly.

⚠ **Analysis is whole-file; the envelope is evaluated per span.** That split is
what the apply path's pre-roll needs — `renderAutoLevelGainDb(analysis,
startSample, numSamples)` is a function of absolute position, so the pre-roll
carries the same gain the preview gave it and the composite's compressors do not
meet a step at the region boundary. A test pins that the envelope is identical
whichever span it is evaluated from; it is the property everything else here
rests on.

---

## Section 4 · DYNAMICS

```
 Soft Clip ─▶ FET Punch ─▶ ┌─ dry ──── delay(50) ──────────────────┐
                           │                                       ├─ Mix ─▶
                           └─ wet ─ Pultec pre ─ Opto ─ Pultec post ┘
```

**Macros: Density 0–100** (drives the crest ladder) and **Mix 0–1** (the opto
block's parallel blend).

### Why this order

The canonical 1176 → LA-2A order is correct here for the reason it is always
correct: **the LA-2A's attack is too slow to catch transients, so anything after
it still has to deal with them.** Leading with the opto would have it level a
signal that still carries full peak range, leaving the FET to clean up after it.

The one argument that would have favoured opto-first — that the opto is the
long-term leveller — is already spent, because LEVEL does that job before the
section begins. That does slightly weaken the classic case (the 1176-first
argument is strongest on raw, unlevelled tracking, and by this point the signal
is already even), but transient-versus-body separation is a different axis and
that argument survives intact.

### Soft Clip — clipping *into the detectors*, not peak control

The clipper is first, and that reframes it. It is not catching residual peaks; it
is shaving spikes so that neither compressor's detector is triggered by
transients it cannot musically respond to. Peak control belongs at DELIVER.

- Runs at **`limiter: 0`**, which `softClipperProcessor.js` documents as
  bit-identical to the build before the limiter existed. Latency drops from 242
  samples to 50, and there is no lookahead smoothing reaching below threshold.
- Its depth is a **solve input, not a solve output**: set from crest excess over
  the voicing's transient target, before the compressors are allocated.
- ⚠ **Hard cap ~3 dB.** Measured stock depth is 2.77–3.21 dB across two narrators
  at Headroom 7.0. If the solve wants more, **Density backs off and the panel says
  so.** This is the same rule as the server's "never force a pass" on noise floor:
  report the shortfall, do not over-process.

### FET Punch — fast grab

Stock topology. `scHpfHz` comes **off zero** here: the FET is the one stage
between the clipper and the opto that can still be yanked by a plosive, and it
has a native sidechain high-pass for exactly this.

### Opto block — Scheps' topology, not Scheps the composite

Hold `LA2AKernel` directly, wrap it in the fitted `pultecSections` pre/post, and
let the **section's Mix be the blend** — one wet path, one dry delay line.

⚠ **Do not nest `SchepsKernel`.** Three reasons, each recorded in existing source:

1. Two nested parallel blends means two delay lines, which is the single most
   likely place to introduce a subtle alignment bug.
2. Scheps' output ceiling sits at *its own output* because it is the last stage.
   Here it would be mid-chain, with TONE after it — precisely the mistake Scheps'
   own source warns about for its embedded LA-2A: "a ceiling inside it would
   clamp the wet path and then be undone by everything downstream."
3. It carries a known ~0.25 dB knee residual at Mix 0, which compounds under a
   second blend.

Rebuilding the topology gets the trick's sound with strictly less machinery than
ships today.

### Why the dry tap is the block's input, not the section's

This is a serial chain. A dry path running parallel to the *whole* dynamics
section would mean there is a knob position where nothing happens at all, which
is not what a chain is. The blend is local to the opto block, and its dry side is
the **post-FET** signal — which is also exactly what Scheps does, since its dry
tap has always been its own input.

Four consequences, all improvements:

- **Latency is simple.** The dry line compensates only the opto's 50 samples.
  Composite total: 50 (clip) + 50 (FET) + 50 (opto) = **150 samples, constant.**
  No per-patch term, now that the clipper runs at `limiter: 0` and the opto's
  `lookaheadMs` is pinned to 0 as `LA2A_FIXED` already does.
- **The crest solve becomes monotonic.** A global blend diluted all three devices
  at once, so allocation fed back on itself. Locally, the clipper and FET
  contribute their full reduction deterministically and only the opto's share is
  scaled by the mix law. One pass, and honestly reportable per device.
- **Mix 0 is a real setting.** Scheps is bit-exact against its delayed input at
  Mix 0, so here that position gives clip → FET with no opto and no Pultec — a
  legitimate fast-and-dry voicing, not a bypass.
- **No internal ceiling is needed.** Peak control moves to DELIVER, the knee
  disappears, and with it the structural exposure `CLAUDE.md` records: Scheps'
  residual exists *because* the ceiling is the source peak and at low Mix the
  output is approximately the source. Everything stays float internally. The only
  caveat is that TONE's saturation is level-dependent, so the block needs a sane
  output trim rather than an unbounded one.

### The crest ladder

Density sets a target crest via the voicing's trajectory. Allocation, in order:

| Device | Takes | Bound |
|---|---|---|
| LEVEL (upstream) | slow variance across voiced blocks | target ≈ 1 dB std dev |
| Soft Clip | fixed shave of the spikes | ⚠ ≤ ~3 dB, hard |
| FET Punch | the fast component | full strength |
| Opto | the syllabic residue | scaled by the mix law |

Each device reports what it actually did, and the panel prints all four. A solve
that cannot reach the target reports the shortfall rather than pushing the
clipper.

### ⚠ Constants that must be re-measured, not inherited

**`squash` (the opto's Peak Reduction).** Scheps' default of 40 is calibrated for
an opto that sees the raw signal through a Pultec pre-emphasis. Here the opto sees
an already-clipped, already-FET-compressed signal, and the Pultec pre stage now
shapes only its sidechain — clip and FET sit *ahead* of the sandwich rather than
inside it. That constant has been recalibrated twice already for exactly this kind
of inheritance. Third measurement, not a copied number.

**The mix law.** `mixGains` is not an equal-power crossfade. It is level-compensated
from a measured `correlation` and `densityDb` (`computeSchepsAutoTrim`),
specifically so that Mix does not shift loudness and so the compression's density
yield survives the blend. Our dry side is post-FET — already compressed — so both
quantities move: correlation up (the paths are more alike), density yield down
(the FET already took some). Reusing Scheps' measurement would make Mix drift in
loudness across its sweep, which is the exact failure the compensation exists to
prevent. Same machinery, new measurement.

---

## Section 5 · TONE

Static, post-dynamics. **Macros: Warmth, Presence, Air.**

Band-weighted, not broadband — this is the distinction the server chain already
draws with `vocalSaturation`'s per-band drive multipliers (low 2.5–7×, mid
0.1–0.25×, high 0.1–6.25×).

| Macro | Built from | Server analogue |
|---|---|---|
| Warmth | low-band saturation drive, `satCurves` / `vocalSatProcessor` band split | `bassEnhance` (drive 3, mix 0.3, ~300 Hz) |
| Presence | broad peak/shelf, `BiquadCascade` | part of `referenceEQ` |
| Air | `airBandSections` — the existing fitted cascade | `airBoost` (`gainDb` 6) |

Air comes after TAME. That is the only order that works: an air lift ahead of
de-essing raises exactly the band the de-esser then has to pull back down.

---

## Section 6 · DELIVER

Loudness target and peak ceiling, through `dsp/loudnessNormalize.js`
(`planNormalization`, `limitToCeiling`, `renderLoudnessNormalize`) and the
`loudnessTargets.js` benchmarks already pinned to `OUTPUT_PROFILES` by test.

⚠ **This cannot be a realtime worklet stage and must not be built as one.**
Integrated loudness is a statement about the whole region, not something a
per-block follower can assert. It is measure-then-apply, and — following the
contract LoudnessWindow already ships — **every figure the panel prints after
apply is measured on the render, never predicted from the gain.**

The target/ceiling disagreement is the same one the loudness normalizer already
solves: the PEAK switch decides which constraint gives, and LIMIT is a solve
rather than arithmetic, because limiting lowers the loudness the gain just set.
Reuse it; do not re-derive it.

---

## Voicings

Three characters, setting the crest trajectory, tone tilt and delivery benchmark.

| Voicing | Crest trajectory | Tone | Delivery |
|---|---|---|---|
| Audiobook | conservative, transparent | flat-ish, controlled air | ACX benchmark |
| Podcast | punchy, denser | warmth + air forward | −16 LUFS benchmark |
| Natural | minimal | near-flat | −16 LUFS benchmark |

Deliberately three, not four, and deliberately **not** mirroring the server preset
IDs. There is no client equivalent of `noise_eraser` — separation is server-only —
and inventing one would imply a capability this plugin does not have.

---

## Architecture

Three nodes, not six.

| Node | Sections | Latency |
|---|---|---|
| `GainNode` + envelope buffer | LEVEL | 0 |
| **one composite `AudioWorkletNode`** | REPAIR, TAME, DYNAMICS, TONE | 150 samples |
| solve on the rendered output | DELIVER | 0 |

### The composite kernel

Follows `schepsProcessor.js` precisely: it **holds** `LA2AKernel`,
`FET1176Kernel`, `SoftClipperKernel`, `AirBandKernel` and `BiquadCascade` rather
than copying them, so every future tuning change reaches it with no conforming
edit. One reported latency, one dry `DelayLine`, one `applyWorkletRegion` call.

⚠ Scheps records the cost of getting this half-right: holding the kernel means
bench tuning is module *state* and has to be wired through explicitly
(`onLA2ATuningChange`). Do the same here from the start.

⚠ Params reach the kernel over a message port from UI state, so one `undefined`
or `NaN` is always one bug away — and a non-finite value entering the T4 cell's
persistent envelope makes the effect output NaN *forever*, until page reload.
Use `schepsProcessor.js`'s `finite()` guard on every param, not `clamp`.

### The Analyze pass

One worker call per region producing the file profile:

```
gatedRmsDb · peakDb · crestDb · f0Profile · noiseFloorDb
correctiveBands[] · sibilanceStats · humFrequencies[]
```

Every section's starting point derives from it. The macros then move *relative* to
that calibrated point, so a knob position means the same thing on every file.

⚠ **Measured file properties never go into a preset.** `inputAlignDb`,
`ceilingDb`, `ceilingKneeDb`, the corrective bands and the LEVEL envelope are
properties of the *file*. A preset stores macro positions and voicing only. This
is the rule `measuredKeys.js` and `la2aParams.js` already enforce, and the
portability failure it exists to prevent: absorbing a bad measurement into a
patch value gets the right sound with the wrong number, and ships the
compensation to every other file the preset touches.

### Apply path

`applyWorkletRegion` currently renders `source → worklet`. LEVEL needs it
generalised to `source → gain(modulated) → worklet` inside the same
`OfflineAudioContext`. Modest work — `effects/clipGainDeEss.js` already builds
that graph shape for its own apply path.

**Pre-roll:** the slowest envelope in the composite — which is the FET's release
tail, not the opto's ballistics. `fet1176PreRollSeconds` computes it per patch
(2 s floor, up to 26.4 s at the slowest dial in all-buttons mode), so the
composite should ask its embedded kernel rather than carry a constant of its own.
⚠ That also caps what the composite can claim: OptoSmooth and Scheps are
bit-exact at their pre-rolls and the FET is not, so the composite converges to
~1e-4 rather than to zero. The LEVEL envelope needs none — it is precomputed.

---

## Prerequisites

Three pieces of work that must land before the composite can be trusted.

**1 · FET Punch must be input-aligned.** ✓ **Landed.** In a serial chain an
unaligned second compressor is a level-dependent surprise sitting behind a macro
knob — the exact defect `inputAlign` was written to remove, reintroduced one
level up.

⚠ **It did NOT apply directly, and the reason matters for the composite.** The
opto can add its offset to `scDriveDb` because Peak Reduction is side-chain gain
and nothing else. This unit's Input knob is an attenuator on the audio path as
well, exactly as the hardware wires it, so the same move would have made the
alignment an input gain — raising the output by the same amount, requiring
Output to cancel it, and driving the FET saturator harder on a quiet file. The
offset rides a separate detector-only coefficient instead, and the panel calls it
ALIGN because INPUT is already a different control. Any future stage folded into
this chain needs the same question asked of it before `inputAlign.js` is pointed
at it.

⚠ The reference statistic is **gated RMS, not the makeup percentile.** Reusing
`MAKEUP_PERCENTILE` scores 4.99 dB of spread against 1.26 on the opto's corpus:
a near-peak statistic answers "how loud is the loudest thing", and this asks
"how much energy drives the detector".

⚠ **That argument was made for the opto and has NOT been re-made for this unit.**
It rests on gain reduction being an integral over the envelope distribution,
which in turn rests on the T4's ~10 ms attack smoothing the detector into
something envelope-like. FET Punch's detector is a rectified peak follower with
deliberately no smoothing. It ships on gated RMS anyway — one statistic across
both compressors is what stops the chain's two devices drifting apart on material
that separates them — and `npm run fet:align` scores the alternatives against
this unit specifically. There is no corpus in the repo to settle it with, and a
synthetic stimulus cannot: variants built here score plain RMS at 0.40 dB against
gated RMS's 3.21 on the OPTO, where the real corpus says the opposite, so the
bench fails its own control.

**2 · FET Punch needs a pre-roll on its apply path.** ✓ **Landed, and it was not
the job this prerequisite described.**

⚠ **The premise was wrong.** This said the makeup tracker's unbounded running
maximum was a preview/apply divergence with no workaround, quoting
`applyWorkletRegion`'s own note. The tracker is unbounded — but it is read only
by `liveAutoMakeupDb()`, which leaves the kernel as a port message for the
panel's knob. It cannot reach a sample: the audio path's output gain comes from
the `outputGainDb` param. So it was never in the render's error budget, and
`useFET1176.apply()` already re-measures offline before committing, which closes
the knob's history-dependence at the app level. Nothing in the composite will use
the live tracker at all.

**The real defect was next door: `applyFET1176Region` had no pre-roll whatever.**
Measured against a settled preview on an adversarial region, the stock patch
rendered 5.03 dB hot over its first half-second. What the old note's table was
actually showing is the release tail — which *does* decay — probed at well under
one of its own time constants.

The pre-roll is per-patch, because the tail is: `release × TAIL_MULT` spans
0.20 s at dial 7 to 6.60 s at dial 1 in all-buttons mode, a 33:1 range no single
constant serves. Four tail time constants, floored at 2 s for the rate-
independent state (oversampler history, DC blocker, the 8 ms output smoother),
lands every dial and both ratio modes inside 1e-4 worst-case sample error against
1e-2…1e-1 cold.

⚠ **It converges asymptotically, not exactly, and the composite inherits that.**
OptoSmooth and Scheps are bit-exact at their pre-rolls; this stage is not. The
fast dials do reach exactly zero given ~40 taus, but 40 taus at dial 1 is 176 s
of pre-roll for a 2 s region. The composite's pre-roll is therefore bounded below
by whatever its embedded FET asks for, and its convergence claim has to be
"~1e-4", not "bit-exact" — which is a claim to make in the composite's own test
rather than inherit by assumption.

**3 · `applyWorkletRegion` gains a pre-worklet gain stage.** Not yet done, and
the shape has changed since this was written.

⚠ **The precedent cited here was wrong.** This said `effects/clipGainDeEss.js`
"already builds that graph shape for its own apply path". It does not — it builds
the modulated-`GainNode` graph for *preview*, and its APPLY path multiplies the
envelope into the rendered arrays directly, because that was measured
bit-identical and needs no graph or promise. So the generalisation wanted is a
**pre-multiply hook**, not a node: `applyWorkletRegion` already renders the
extended span into `channelData` before copying it into the worklet's input
buffer, and the envelope can be multiplied in there.

⚠ **It must cover the pre-roll, not just the region** — otherwise the pre-roll
enters the composite ungained and the compressors meet at the boundary exactly
the step the pre-roll exists to remove. `renderAutoLevelGainDb` takes an absolute
`startSample` for this reason.

---

## Deliberate omissions

**Noise reduction is not in this chain and should not be.** RNNoise is
meaningfully worse than DeepFilterNet3, and shipping an inferior NR path inside
the flagship client chain contradicts the product's whole positioning. Instead
the Analyze pass should **detect** an elevated noise floor and say so, because
both LEVEL and the clipper amplify it — a chain run on a noisy file makes the
noise worse in a way the user will hear and not understand.

**No dereverb, no source separation.** Server-only, and not close.

---

## Relationship to the existing plugins

Additive. Nothing is replaced or removed.

- Modes 1–2 (preset and edit-then-preset users) get this chain.
- Mode 3 (manual power users) keep OptoSmooth, FET Punch, Scheps, Soft Clipper,
  ResoTame, Tube Saturation, Air Band, Manual EQ and VoiceRx as they are.

Because the composite holds the same kernel objects, a tuning change made for one
reaches the other. That is the point of holding rather than copying.

---

## Proposed build order

**Phase 1 — prove the solve.** Prerequisites 1–3, then LEVEL + DYNAMICS +
DELIVER. These three carry the loudness and density win, and the crest ladder is
the part of the design most likely to need revision once it is measured on real
narration. Prove it before the surface area grows.

**Phase 2 — REPAIR + TONE.** Mostly assembly of existing fitted cascades.

**Phase 3 — TAME.** The only genuinely new DSP block, and the one that can be
deferred longest, since ResoTame and the server de-esser both exist today.

---

## Open questions

1. **Name.** "Vocal Chain" is a working title. House style leans device-like
   (OptoSmooth, FET Punch, ResoTame, VoiceRx).
2. **Does Density move Mix?** Currently separable — Density drives the ladder,
   Mix is the opto block's character. An argument exists for Density nudging Mix
   at the top of its travel; it costs the separability.
3. **Should the composite expose its internals at all?** An "advanced" reveal
   showing the four devices' actual settings is useful for trust and useless for
   Mode 1. Recommend: read-only reporting of what each device did, no direct
   control.
4. **Plugin presets.** Factory + user-saved, following `pluginPresets/`. Storing
   macro positions and voicing only makes them genuinely portable — which is the
   first time that has been true of a preset in this app.

---

## Testing

Unit coverage in `test/dsp/` following the existing patterns, plus:

- **Latency pinned.** A test asserting the composite's reported latency equals
  the sum of its parts, as `SCHEPS_LATENCY_SAMPLES` is pinned today.
- **Mix 0 bit-exactness.** The opto block at Mix 0 must be bit-exact against its
  delayed input, as Scheps is.
- **Preview ≡ apply.** Extend `previewApplyConvergence.test.js` to the composite,
  including the LEVEL envelope node.
- **Inheritance round-trip.** Scheps ships a test pinning `SCHEPS_DEFAULTS` to
  `SCHEPS_KERNEL_DEFAULTS` because inheritance silently re-tuned its calibrated
  defaults twice. The composite has four inherited default sets. Pin all four.
- **Level invariance.** The whole chain's output at a fixed macro position, across
  a 27 dB input sweep — the measurement that validates Prerequisite 1.
- `npm run smoke` before merging anything touching composables or params modules.
