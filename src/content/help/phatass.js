export default {
  summary: 'Adds tape-style low-end warmth and rounds off the top end, without raising the peak',

  whenToUse: [
    'A voice sounds thin or clinical and you want body and fatness without an EQ boost',
    'You want the gentle, rounded top end of tape rather than a hard high cut',
    'You want warmth that adds density but never eats into your headroom',
  ],

  controls: [
    { label: 'Warmth', text: 'Low-end body and fatness: an even and an odd saturator on the low band. It lifts and thickens roughly 60–250 Hz rather than adding fizz, and follows the file’s level. The change is spread evenly across the knob; 0 is off' },
    { label: 'Character', text: 'The flavour of Warmth: ROUND leans to the even saturator — rounder, fuller — and FIRM to the odd one — firmer, with more edge. The added level stays about the same either way' },
    { label: 'Tape', text: 'How many dB to take off the selection’s loudest peak, the way tape saturation does: the top of each wave is rounded off, while everything more than about 9 dB under the peak passes untouched — so it lowers the peaks without turning the whole signal down like a compressor would. It works by distortion (odd harmonics): roughly 2 % at 1 dB, 4 % at 2 dB and 9 % at 3.5 dB on narration. Past 3.5 dB the very top is clipped flat, which is harsher; 6 to 12 drives that clip harder still for dense, squashed drums (about 6–7 dB of real snare flattening at 12), at a lot of distortion. A peak made of sibilance loses somewhat less than the number (its harmonics land above the audible band and are filtered out). Matched to a Studer A800 tape emulation, which took about 4 dB off an acoustic guitar. Tape comes first in the chain, so Warmth works on the already-rounded signal. Makeup is automatic: what Tape actually took off the peak is measured over the selection and given back right after it, so the peak returns to where it started and the reduction becomes loudness (about +1.7 dB of level at Tape 2). The caption under the knob shows it; Warmth’s knobs never change it. Turning it up also drives the top end into the Speed dial’s sag, and brings in the speed’s head bump. 0 is off' },
    { label: 'Tape type', text: 'Which tape the Tape knob drives. CLEAN is a soft clipper: it rounds off only the top of each wave, adding mostly the third harmonic, and clips flat past about 3.5 dB. THICK is magnetic tape’s own loop, with memory: low, heavy hits like kicks are squashed about twice as hard as snares, and peaks round off without a hard clip. THICK uses more of the processor, and its makeup takes a little longer to measure. The caption shows the head bump in play' },
    { label: 'Speed', text: 'The tape speed, 30, 15 or 7.5 IPS, and with it how the top end behaves as you drive the tape. The treble sags on bright, hot passages: the louder the top end gets, the more of it is turned down and the further down the loss reaches. Slower tape has less high-frequency headroom, so it sags sooner, deeper and lower. It listens to energy rather than peaks and does not look ahead, so attacks and short S sounds stay bright while sustained brightness darkens — the way tape behaves, and the opposite of a limiter. Turning Tape up drives the tape harder, so the top end sags sooner; a take whose treble is already soft is left mostly alone. The speed also sets Tape’s head bump — the playback head’s low-end lift, measured on a Studer A800 — an octave lower at each slower speed. The caption shows the most the current speed may cut' },
    { label: 'Output', text: 'Level after everything, for matching against bypass' },
    { label: 'Saturation meter', text: 'How much TAPE and Warmth are adding to the signal right now: the energy of everything they add, against the clean signal, averaged over a fraction of a second and shown on a needle that moves like a VU meter. 0 is −40 dB (barely there), 100 is as much added as the signal itself, red from about half. Warmth reads far higher than Tape, because its low layers reshape the whole low band rather than only adding harmonics, so with Warmth up the needle mostly shows Warmth. The top-end shelf and Output are level changes, not saturation, and are not counted' },
    { label: 'Readout', text: 'Under the knobs while Warmth is up: how much each low band moves on this selection (SUB 20–60, LOW 60–120, BODY 120–250, LO-MID 250–400 Hz) and how far the highest peak over the whole selection moves after Output, in dB against the selection’s own peak, with the new peak in dBFS under it. A sub boost or a new peak above −1 dBFS shows red' },
  ],

  notes: [
    'Warmth never raises the selection’s peak: a guard turns down only the added warmth, only for the few milliseconds where it would push past the selection’s own peak, and the voice itself is never touched',
    'Some added density and loudness is expected; the peak is what stays put',
    'The top-end stage is not a limiter: it reacts to how much bright energy there is, with no lookahead, so a single click or S gets through and only sustained brightness is softened',
    'For a full set of top-end controls, or a hard ceiling, use HF Limiter',
    'With Warmth and Tape at 0 the audio is untouched except for the Speed dial’s top-end sag, which at 30 IPS only reaches the brightest passages',
    'Soften, the onset softener that used to be here, is now in HF Softener',
  ],
}
