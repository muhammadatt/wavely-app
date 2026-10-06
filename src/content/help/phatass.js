export default {
  summary: 'Adds tape-style low-end warmth and rounds off the top end, without raising the peak',

  whenToUse: [
    'Attacks, clicks or hard consonants sound too sharp and you want them rounded without a compressor',
    'A voice sounds thin or clinical and you want body and fatness without an EQ boost',
    'You want the gentle, rounded top end of tape rather than a hard high cut',
    'You want warmth that adds density but never eats into your headroom',
  ],

  controls: [
    { label: 'Warmth', text: 'Low-end body and fatness: an even and an odd saturator on the low band. It lifts and thickens roughly 60–250 Hz rather than adding fizz, and follows the file’s level. The change is spread evenly across the knob; 0 is off' },
    { label: 'Odd/Even', text: 'From pure Odd (firmer, more edge) at 0 toward Even (rounder, fuller). The added level stays about the same as you turn it. The knob covers only the useful part of the blend: 100 is still mostly odd, because further toward Even mostly adds sub' },
    { label: 'Soften', text: 'On or off. Rounds off sudden attacks the way tape softens transients: when the band above 500 Hz jumps suddenly (a click, a lip smack, a hard T or K, the snap of an onset) it is turned down for a few milliseconds. It reacts to how suddenly the voice rises, not how loud it is, so steady sound is left alone. It has no knob of its own: Tame sets how deep it goes, up to 36 dB at 10, so the top end and the attacks turn down together. The caption under the switch shows the current depth. It is a gain on a band, not distortion, and adds no latency' },
    { label: 'Tape', text: 'How many dB to take off the selection’s loudest peak, the way tape saturation does: the top of each wave is rounded off by a soft clipper, while everything more than about 9 dB under the peak passes untouched — so it lowers the peaks without turning the whole signal down like a compressor would. It works by distortion (odd harmonics): roughly 2 % at 1 dB, 4 % at 2 dB and 9 % at 3.5 dB on narration. Past 3.5 dB the very top is clipped flat, which is harsher. A peak made of sibilance loses somewhat less than the number (its harmonics land above the audible band and are filtered out). Matched to a Studer A800 tape emulation, which took about 4 dB off an acoustic guitar. Tape comes first in the chain, so Warmth works on the already-rounded signal. Makeup is automatic: what Tape actually took off the peak is measured over the selection and given back right after it, so the peak returns to where it started and the reduction becomes loudness (about +1.7 dB of level at Tape 2). The caption under the knob shows it; Warmth’s knobs never change it. 0 is off' },
    { label: 'Tame', text: 'How hard the tape rounds off the top end from 2 kHz, and with Soften on how deep sudden attacks are taken down. One knob lowers the threshold and deepens the most it may cut together, relative to the file’s voice level, so it acts earlier and goes further as you turn it up. 0 is off' },
    { label: 'Tape curve', text: 'The shape Tape rounds peaks with. CUBIC (default) is the closer match to a Studer A800 emulation: only the third harmonic until about 3.5 dB, then the very top of the wave is clipped flat. TANH bends earlier and never goes flat, so it adds a little more distortion at light settings, and at heavy ones the peak lands closer to the number. ALGEBRAIC goes further the same way: it bends earliest and adds the most distortion at every setting, with the peak as close to the number as TANH. The knob means the same dB of peak reduction on all three' },
    { label: 'Curve', text: 'Which law Tame follows. VOICE is voiced on narration: low settings already reach the brightest sibilance, and it keeps going deeper to the top of the knob (up to 27 dB). FATSO is fitted to the Warmth knob of an EL7 Fatso on music: about 6 dB lighter, with Fatso Warmth 5, 6 and 7 at Tame 1, 4 and 6 on a file around −23 dBFS. The caption shows the most it may currently cut' },
    { label: 'Detect', text: 'Where the top-end stage listens. 2K hears everything above 2 kHz, the band it cuts, so loud vowel brightness and sibilance both trigger it. 4K hears only above 4 kHz, so sibilance triggers it first; the cut is still from 2 kHz, and the threshold is set 3 dB lower so the two positions take off about the same overall. Choosing a Curve sets its usual partner — VOICE with 4K for narration, FATSO with 2K for music — and you can still change Detect afterwards' },
    { label: 'Output', text: 'Level after everything, for matching against bypass' },
    { label: 'Saturation meter', text: 'How much TAPE and Warmth are adding to the signal right now: the energy of everything they add, against the clean signal, averaged over a fraction of a second and shown on a needle that moves like a VU meter. 0 is −40 dB (barely there), 100 is as much added as the signal itself, red from about half. Warmth reads far higher than Tape, because its low layers reshape the whole low band rather than only adding harmonics, so with Warmth up the needle mostly shows Warmth. The top-end shelf and Output are level changes, not saturation, and are not counted' },
    { label: 'Readout', text: 'Under the knobs while Warmth is up: how much each low band moves on this selection (SUB 20–60, LOW 60–120, BODY 120–250, LO-MID 250–400 Hz) and how far the highest peak over the whole selection moves after Output, in dB against the selection’s own peak, with the new peak in dBFS under it. A sub boost or a new peak above −1 dBFS shows red' },
  ],

  notes: [
    'Warmth never raises the selection’s peak: a guard turns down only the added warmth, only for the few milliseconds where it would push past the selection’s own peak, and the voice itself is never touched',
    'Some added density and loudness is expected; the peak is what stays put',
    'The top-end stage is the HF Limiter’s shelf with its shape and timing set for tape: the gentle WARM tilt from 2 kHz, a 35 ms release, no tail and no transient stage',
    'For a full set of top-end controls, or a hard ceiling, use HF Limiter',
    'With Warmth, Soften and Tame all at 0 the audio passes through untouched',
  ],
}
