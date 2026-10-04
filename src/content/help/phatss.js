export default {
  summary: 'Adds tape-style low-end warmth and rounds off the top end, without raising the peak',

  whenToUse: [
    'A voice sounds thin or clinical and you want body and fatness without an EQ boost',
    'You want the gentle, rounded top end of tape rather than a hard high cut',
    'You want warmth that adds density but never eats into your headroom',
  ],

  controls: [
    { label: 'Warmth', text: 'Low-end body and fatness: an even and an odd saturator on the low band. It lifts and thickens roughly 60–250 Hz rather than adding fizz, and follows the file’s level. The change is spread evenly across the knob; 0 is off' },
    { label: 'Odd/Even', text: 'From pure Odd (firmer, more edge) at 0 toward Even (rounder, fuller). The added level stays about the same as you turn it. The knob covers only the useful part of the blend: 100 is still mostly odd, because further toward Even mostly adds sub' },
    { label: 'Tame', text: 'How hard the tape rounds off the top end. One knob lowers the threshold and deepens the most it may cut together, relative to the file’s voice level, so it acts earlier and goes further as you turn it up. 0 is off; 5 holds the top 8 dB under the voice and cuts at most 12 dB' },
    { label: 'Tone', text: 'Where the top-end tilt starts, 2–12 kHz. The tilt is a gentle 6 dB per octave, so it reaches an octave or more below this' },
    { label: 'Output', text: 'Level after everything, for matching against bypass' },
    { label: 'Readout', text: 'Under the knobs while Warmth is up: how much each low band moves on this selection (SUB 20–60, LOW 60–120, BODY 120–250, LO-MID 250–400 Hz) and how far the highest peak over the whole selection moves after Output, in dB against the selection’s own peak, with the new peak in dBFS under it. A sub boost or a new peak above −1 dBFS shows red' },
  ],

  notes: [
    'Warmth never raises the selection’s peak: a guard turns down only the added warmth, only for the few milliseconds where it would push past the selection’s own peak, and the voice itself is never touched',
    'Some added density and loudness is expected; the peak is what stays put',
    'The top-end stage is the HF Limiter’s shelf with its shape and timing set for tape: the gentle WARM tilt, a 35 ms release, no tail and no transient stage',
    'For a full set of top-end controls, or a hard ceiling, use HF Limiter',
    'With Warmth and Tame both at 0 the audio passes through untouched',
  ],
}
