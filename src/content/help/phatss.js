export default {
  summary: 'Adds tape-style low-end warmth and rounds off the top end, without raising the peak',

  whenToUse: [
    'Syllable attacks sound too sharp or clicky and you want them rounded without a compressor',
    'A voice sounds thin or clinical and you want body and fatness without an EQ boost',
    'You want the gentle, rounded top end of tape rather than a hard high cut',
    'You want warmth that adds density but never eats into your headroom',
  ],

  controls: [
    { label: 'Warmth', text: 'Low-end body and fatness: an even and an odd saturator on the low band. It lifts and thickens roughly 60–250 Hz rather than adding fizz, and follows the file’s level. The change is spread evenly across the knob; 0 is off' },
    { label: 'Odd/Even', text: 'From pure Odd (firmer, more edge) at 0 toward Even (rounder, fuller). The added level stays about the same as you turn it. The knob covers only the useful part of the blend: 100 is still mostly odd, because further toward Even mostly adds sub' },
    { label: 'Soften', text: 'Rounds off the attack of every syllable, the way tape softens transients. Wherever a syllable starts louder than it then settles, the whole signal is turned down by part of that overshoot: 5 halves it, 10 flattens it to the syllable’s own level. It compares each attack with the rest of its syllable rather than with what came before, so the first word after a pause is treated like any other. Steady vowels, the ends of syllables and syllables that simply step up are untouched. It is a gain, not distortion, and it can only lower a peak. 0 is off' },
    { label: 'Tame', text: 'How hard the tape rounds off the top end. One knob lowers the threshold and deepens the most it may cut together, relative to the file’s voice level, so it acts earlier and goes further as you turn it up. 0 is off; 5 holds the top 8 dB under the voice and cuts at most 12 dB' },
    { label: 'Tone', text: 'Where the top-end tilt starts, 2–12 kHz. The tilt is a gentle 6 dB per octave, so it reaches an octave or more below this' },
    { label: 'Output', text: 'Level after everything, for matching against bypass' },
    { label: 'Soften bench', text: 'Three fields under the knobs for auditioning Soften. Floor is the dB of each attack’s overshoot that is never cut (lower softens more, but below about 1 the steady parts of syllables start to move). Attack is how long the detector takes to accept a new level; an attack is cut only as far as it both rose over that recent past and overshoots its own syllable, so a shorter Attack cuts less. Scale is what Soften 10 means: 1 flattens each overshoot, above 1 dips the attack below the syllable. Reset returns them to 1.5 dB, 30 ms and 1' },
    { label: 'Readout', text: 'Under the knobs while Warmth is up: how much each low band moves on this selection (SUB 20–60, LOW 60–120, BODY 120–250, LO-MID 250–400 Hz) and how far the highest peak over the whole selection moves after Output, in dB against the selection’s own peak, with the new peak in dBFS under it. A sub boost or a new peak above −1 dBFS shows red' },
  ],

  notes: [
    'Warmth never raises the selection’s peak: a guard turns down only the added warmth, only for the few milliseconds where it would push past the selection’s own peak, and the voice itself is never touched',
    'Some added density and loudness is expected; the peak is what stays put',
    'The top-end stage is the HF Limiter’s shelf with its shape and timing set for tape: the gentle WARM tilt, a 35 ms release, no tail and no transient stage',
    'For a full set of top-end controls, or a hard ceiling, use HF Limiter',
    'Soften is subtle by design: at 10, attacks on narration come down about 0.7 dB against the rest of their syllable (1.3 at Scale 2, 1.7 at Scale 3), and steady speech does not move',
    'With Warmth, Soften and Tame all at 0 the audio passes through untouched',
    'Soften looks 80 ms ahead to find each syllable’s own level, so with PHAT*SS on, preview runs that far behind bypass; Apply lines it up exactly',
  ],
}
