export default {
  summary: 'Dips the top end only while a consonant spikes, then lets it go',

  whenToUse: [
    'S, T and CH sounds poke out of an otherwise good recording',
    'A static high cut would dull the voice along with the harshness',
    'You want sibilance calmer without losing breath or air',
  ],

  controls: [
    { label: 'Duck', text: 'The first stage: turns the whole S down while it lasts, keeping its shape and tone — the most natural-sounding way to de-ess. Threshold, ratio (up to 4:1) and depth (up to 12 dB) rise together' },
    { label: 'EQ', text: 'The second stage: a dynamic cut of the top end, on whatever the Duck left hot. It hears the ducked S, so the more Duck does, the less EQ has to. Threshold, ratio (up to 6:1) and depth (up to 24 dB) rise together' },
    { label: 'Shape', text: 'Band cuts the sibilance region and leaves the air above it; Shelf cuts everything above the Band corner' },
    { label: 'Guard', text: 'Under Advanced. The lisp guard: stops any S being pulled further below the voice than a normal S sits, so heavy settings cannot turn S into TH. Higher is stricter (a naturally lispy or dark voice); lower lets a hot, strident S go deeper; 0 turns it off. Flatter fricatives like F, which sit naturally quieter and cannot lisp, get less of it, so a hot F can still be reduced. It covers Reso too' },
    { label: 'Band', text: 'Under Advanced. Where the EQ cuts — the band’s lower corner, 3–6 kHz, default 4.5. Lower it for an S that sits low (deeper voices, SH); raise it for a high, thin S. The band keeps its shape as it moves. Detect decides what sets the cut off; Band decides what it takes' },
    { label: 'Plosives', text: 'Under Advanced. On, T, K and P releases — a short burst straight out of a stop’s silence — are caught and cut harder than S’s, with the lisp guard lifted: a burst cannot lisp. Turn it off if an S that starts abruptly after a pause is being hit too hard' },
    { label: 'Detect', text: 'Where the detector starts listening. Raise it if bright vowels are being dipped: an ordinary S reads the same at any setting, but vowel top end drops out of the detector' },
    { label: 'Air', text: 'Adds top after the cut, on the same curve as Air Boost. It is yours: HF Comp adds to it, never changes it' },
    { label: 'HF Comp', text: 'Removing sibilance makes the whole file less bright even though the vowels are untouched. On, this adds Air to make up for half the top end the cut is measured to take, and follows every setting that changes the cut' },
    { label: 'Air mode', text: 'VOICED lifts the vowels only: the air fades out as each S arrives and stays out of the pauses, so it neither hands the cut back to the sibilants nor lifts room noise. STATIC lifts everything, as Air Boost does' },
    { label: 'Reso', text: 'A band-limited ResoTame at the end of the chain; 0 takes it out. On vowels it only ever takes rings and whistles. On an S it only takes what Duck and EQ left above a normal S, so with the lisp guard on a well-treated S is left alone — cutting an S’s peak is what makes it lisp. Lower Guard to let it go deeper' },
    { label: 'Delta', text: 'Hear only what is being removed, from the button in the title bar' },
  ],

  steps: [
    'Play a passage with sibilance and turn on Delta',
    'Raise Duck until the delta is sibilance and nothing else, then add EQ for any harshness left',
    'Back them off if you hear vowels or breath in the delta',
    'Turn Delta off and compare against bypass at matched level',
  ],

  notes: [
    'The scope at the top is the waveform after the cut: the coloured rim around it is what was removed, and how thick it is is how much. Lavender marks a T, K or P given the plosive treatment; a dashed line inside the rim is where the lisp guard stopped the cut. Left of the playhead is what has played, right of it what is coming (not yet processed, so drawn plain)',
    'Behind the curve is the input’s spectrum. The dotted line is where the detector starts listening (Detect), the solid one where the EQ cuts (Band): an S sitting below the solid line wants Band lower; vowel energy crossing the dotted line wants Detect higher',
    'Thresholds follow the file’s own level, so a setting means the same on a quiet recording and a hot one',
    'If the result sounds a touch dull, a dB or two of Air puts the top back — it is Air Boost’s curve, so there is no need for a separate Air Boost pass',
    'Delta never includes the Air makeup: it plays only what is removed — the Duck, the EQ and Reso together',
    'REDUCTION under the scope is the total taken off each S, split into DUCK (level), EQ (tone) and RESO (rings)',
    'The lisp guard limits the total of both stages, so Duck and EQ together cannot sink an S further than a normal S sits',
    'Below threshold the shelf sits at exactly 0 dB, so quiet material passes through untouched',
    'A sibilant alone in a gap is treated a little harder than one inside a word — the threshold rises slightly with the surrounding vowel energy',
    'The cut lets go within about 10 ms as each vowel starts, so the sound after an S keeps its top end',
    'Delta is only for monitoring and never affects what gets applied',
    'With Reso up, Delta covers it too, playback runs about 12 ms late, and the applied result can differ very slightly from the preview, as with ResoTame itself',
  ],
}
