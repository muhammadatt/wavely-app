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
| Plosives / chest thump trip the detector and duck the whole word | LA-2A: R37 tilt only. 1176: optional one-pole `scHpfHz`, off by default | Voice-shaped detector: high-pass at the speaker's own rumble corner + sibilance excluded |
| "s" sounds get louder after compression (body is pulled down, sibilance isn't) | Separate HF Softener, user must know to add it *after* | De-ess is built in, placed after the compressor, linked to it |
| Two serial compressors (76 → 2A) is the standard vocal chain, but it takes two windows and two gain-staging decisions | Chain them manually in the Plugin Chain | One macro (**Control**) split across both by a **Character** knob |
| "Enhance" (presence, air, warmth) is four more plugins | EQ, Air Boost, PHAT*SS, Saturation Workbench | Three voice-aimed knobs, each measurement-calibrated |

**Positioning:** the Mode 2 / Mode 3 user's single "make my voice sound
produced" plugin. It is *not* the mastering chain — no loudness target, no ACX
claim. It moves character and dynamics; Loudness Normalize or the preset chain
still sets delivery level.

**Design rule — compose, don't copy.** Like Scheps Parallel (which *holds* the
LA-2A kernel rather than a copy), VoxPressor embeds the existing kernels so
every fitted constant, makeup guarantee and test reaches it with no conforming
change. New DSP is limited to the voice detector and the glue.

---

## 2. Signal chain

One AudioWorklet, one kernel class (`VoxPressorKernel`), constant latency.

```
in ─ INPUT ALIGN (drive offset, detector only)
   │
   ├─ VOICE DETECTOR ────────────────────────────────────────────┐ (sidechain)
   │   HP @ voice corner · sibilance shelf-down · 4x RMS/peak    │
   │                                                             ▼
   ├─ [1] PEAK   — FET1176Kernel (fast, catches onsets)  ◄── detector
   ├─ [2] BODY   — LA2AKernel (opto, rides the phrase)   ◄── detector
   ├─ [3] DE-ESS — HFSoftenerKernel (Duck + EQ, lisp guard)
   ├─ [4] TONE   — Presence bell (dynamic) · Air (voiced-only) · Warmth (sat layer + guard)
   ├─ MAKEUP     — percentile reference + source-peak ceiling (dsp/makeupReference.js)
   └─ MIX        — delay-compensated dry/wet (equal-power, as Scheps)
       └─ OUTPUT trim ─ out
```

### Order rationale (pinned, not user-reorderable)

- **76 before 2A.** The canonical vocal chain: the FET clips the fast onsets so
  the opto isn't yanked by them and can ride the phrase smoothly. Reversing it
  makes the 2A pump on every plosive that survives. *(Owner may want this as a
  bench A/B; see §11.)*
- **De-ess after compression.** Compression raises sibilance relative to the
  body; a de-esser before it is undone. The HF Softener's thresholds already
  follow the file's gated RMS (`levelOffset`), so it needs to hear the
  *post-compression* level — the kernel is fed a re-measured offset (§5).
- **Tone after dynamics.** Presence and air pushed into a compressor get
  compressed back out; after it they stay where the user put them. Warmth last
  so its guard can hold the final peak.

---

## 3. The voice detector (the one genuinely new DSP block)

Shared by stages [1] and [2]. Fed from the aligned input.

1. **High-pass at the speaker's rumble corner** — `measureVoiceProfile().cornerHz`
   (`voiceProfile.js`, the same number VoiceRx and Reso Soothe use: 40–100 Hz,
   measured once per file). 2nd order. Falls back to 80 Hz if the profile
   returns `null` (too few voiced frames).
2. **Plosive de-weighting** — a further 6 dB/oct shelf down below 150 Hz
   *(reasoned)*, so a "p" that passes the high-pass still doesn't dominate.
3. **Sibilance exclusion** — a high-shelf cut, −9 dB above 5 kHz *(reasoned)*.
   The compressor should ride the vowels; sibilance is the de-esser's job. Without
   this the compressor and de-esser both cut on an "s" and it lisps.
4. **Presence emphasis** — optional; the LA-2A's own emphasis/R37 path is left
   at its shipping value so the opto voicing is unchanged.

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
| **Control** | 0–100 | 40 | Total target gain reduction on voiced material. Maps to ~0–12 dB avg GR *(reasoned)*, solved per file through input alignment so it means the same on any recording level |
| **Character** | Smooth ↔ Punch, 0–100 | 35 | Splits Control's GR between BODY (2A) and PEAK (76). 0 = all opto, 100 = all FET. Also moves the FET attack dial 3 → 6 and ratio 4 → 8 across its travel |
| **De-ess** | 0–100 | 40 | HF Softener **Amount** (Split pinned at its default 33; Guard 100) |
| **Presence** | −6…+6 dB | +1.5 | Dynamic bell at the voice's presence peak (2–5 kHz, placed from VoiceRx's analysis). Boost is *ducked* while the de-esser cuts, so it can't feed the sibilance it is next to |
| **Air** | 0–6 dB | 1.5 | Air Boost curve (`dsp/airBandCurve.js`), VOICED mode only (vowels), the HF Softener's existing Air path |
| **Warmth** | 0–10 | 2 | One quartic Saturation Bench layer, 1–250 Hz *(PHAT*SS's first Warmth layer, reused)*, with `warmthGuard` holding the source peak |
| **Mix** | 0–100 % | 100 | Parallel blend against delay-compensated dry |
| **Output** | ±12 dB | AUTO | Owned by auto makeup until touched (the LA Vintage 2A Gain-knob contract) |

Header: preset browser, ON/BYPASS lamp, **DELTA** pill (plays what VoxPressor
removed + added), **Listen: SC** (plays the voice detector — the HF Softener's
MONITOR contract).

### 4.2 Meters

- IN / OUT ladders (`LevelMeter variant="modula"`).
- Three stacked GR bars: **PEAK** (76), **BODY** (2A), **DE-ESS**.
- The HF Softener's activity scope is *not* included — one scope per window is
  enough, and it is the busiest part of that panel.

### 4.3 Advanced (dev bench, gated like the PHAT*SS bench)

Attack/release overrides per stage, detector corner/shelf depths, chain-order
A/B, `VOX_LEGACY_PATCH`. Nothing on the bench ships to presets.

---

## 5. Measurements (never user settings, never in presets)

All measured once per file / selection, in the worker, against the **running
`segments`** when in the Plugin Chain (CLAUDE.md rule):

| Measurement | Source | Used by |
|---|---|---|
| Gated RMS → input align | `dsp/inputAlign.js` | Both compressor stages' drive offset |
| Rumble corner, median F0 | `voiceProfile.js` | Detector HP; Presence placement |
| Presence peak frequency | VoiceRx analysis (port of Stage 3a) | Presence bell centre |
| Post-compression gated RMS | render of stages [1]–[2] on ≤ 400 blocks | De-ess `levelOffset` |
| Makeup plan | `solveMakeupPlan` (iterated — the 2A's valve makes output non-affine) | Output AUTO |
| Source peak | `peakOfChannels` | Ceiling, Warmth guard |

⚠ **Control is a target, so it needs a solve.** Avg GR is not linear in either
kernel's drive. Use a bounded bisection on a ≤ 30 s sampled render (the
Saturation Bench / PHAT*SS readout's strata approach), cached by
document + span + Control + Character, re-solved exactly before apply.

---

## 6. Latency, apply, chunking

- Latency: FET 50 + LA-2A 50 (both 4x oversampled) + Warmth layer 0 (base-rate
  quartic, ≤ 250 Hz allowed under `WARMTH_BASE_RATE_MAX_HZ`) + Warmth guard 3 ms
  = **constant**, reported once and trimmed by the apply path. Dry path in Mix delayed by the same amount.
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

| Preset | Control | Character | De-ess | Presence | Air | Warmth | Mix |
|---|---|---|---|---|---|---|---|
| **Default** | 40 | 35 | 40 | +1.5 | 1.5 | 2 | 100 |
| **Audiobook Natural** | 30 | 15 | 35 | +0.5 | 1 | 1 | 100 |
| **Podcast Punch** | 60 | 65 | 50 | +3 | 2 | 4 | 100 |
| **Voiceover Forward** | 70 | 80 | 55 | +4 | 3 | 3 | 100 |
| **Gentle Glue** | 35 | 25 | 30 | 0 | 0 | 2 | 50 |

---

## 8. Files (following the existing plugin layout)

```
src/audio/voxPressorParams.js        panel ↔ kernel mapping, defaults, Character split law
src/audio/voxPressorProcessor.js     VoxPressorKernel + worklet registration
src/audio/voxPressorWorkletLoader.js ?worker&url loader
src/audio/dsp/voiceDetector.js       §3 detector filter
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
2. **Dynamics core** — detector + PEAK + BODY + makeup + Mix, Control/Character
   solve. Ship to dev; audition against the 76 → 2A chain built by hand in the
   Plugin Chain (should be near-identical at matched settings — a useful test).
3. **De-ess** — embed HF Softener, fed the post-compression level offset.
4. **Tone** — Presence, Air, Warmth.
5. **Panel, presets, chunked apply, smoke.**

### Acceptance tests (minimum)

- All knobs at their "off" positions (Control 0, De-ess 0, Presence 0,
  Air 0, Warmth 0, Mix 100, Output 0) → **pure delay**, bit-exact.
- Control's avg GR within ±0.5 dB of target across −30…−6 dBFS input levels.
- Output never exceeds the source peak (ceiling + warmth guard).
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

1. **Chain order** — pin 76 → 2A, or expose a 2A → 76 A/B on the bench?
2. **Peak restore on apply** — LA Classic 76 restores the peak to the ceiling
   on apply (the one place preview ≠ apply). Inherit that, or keep VoxPressor
   sample-identical and level-matched for the A/B?
3. **Control as target GR vs. raw drive** — target GR (spec'd above) is
   friendlier but costs a solve per knob move; raw drive is instant but means
   different things on different voices.
4. **Saturation voice** — reuse the LA-2A's quartic cell/valve for Warmth
   (zero new character), or the PHAT*SS Warmth layer as spec'd?
5. **Tier** — free like the compressors, or Pro like Auto Leveler / Plugin Chain?
6. **Name on the toolbar** — "VoxPressor" in Dynamics, or its own top-level
   "Voice" entry for Mode 1/2 users who never open Dynamics?
