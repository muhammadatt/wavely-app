export default {
  summary: 'Dips the top end only while a consonant spikes, then lets it go',

  whenToUse: [
    'S, T and CH sounds poke out of an otherwise good recording',
    'A static high cut would dull the voice along with the harshness',
    'You want sibilance calmer without losing breath or air',
  ],

  controls: [
    { label: 'Amount', text: 'How early the cut starts and how hard it bites — threshold, ratio (up to 6:1) and depth (up to 24 dB) rise together in even steps' },
    { label: 'Split', text: 'How the reduction is taken. Toward 0 % it is a band cut: the voice keeps its level but each S changes tone. Toward 100 % it is a broadband dip: the S keeps its tone but the voice dips a little. The total stays the same, so a mix of both lets each work more gently' },
    { label: 'Shape', text: 'Band cuts the sibilance region and leaves the air above 11 kHz; Shelf cuts everything above 4.5 kHz' },
    { label: 'Lisp guard', text: 'Stops any S being pulled further below the voice than a normal S sits, so heavy settings cannot turn S into TH' },
    { label: 'Detect', text: 'Where the detector starts listening. Raise it if bright vowels are being dipped: an ordinary S reads the same at any setting, but vowel top end drops out of the detector' },
    { label: 'Air', text: 'Adds top after the cut, on the same curve as Air Boost. It is yours: HF Comp adds to it, never changes it' },
    { label: 'HF Comp', text: 'Removing sibilance makes the whole file less bright even though the vowels are untouched. On, this adds Air to make up for half the top end the cut is measured to take, and follows every setting that changes the cut' },
    { label: 'Air mode', text: 'VOICED lifts the vowels only: the air fades out as each S arrives and stays out of the pauses, so it neither hands the cut back to the sibilants nor lifts room noise. STATIC lifts everything, as Air Boost does' },
    { label: 'Reso', text: 'A band-limited ResoTame ahead of the softener; 0 takes it out. On vowels it only ever takes rings and whistles. On the S it takes more as you turn it up, in even steps, and the softener’s own cut eases off as it does. The lisp guard covers it too' },
    { label: 'Delta', text: 'Hear only what is being removed, from the button in the title bar' },
  ],

  steps: [
    'Play a passage with sibilance and turn on Delta',
    'Raise Amount until the delta is sibilance and nothing else',
    'Back Amount off if you hear vowels or breath in the delta',
    'Turn Delta off and compare against bypass at matched level',
  ],

  notes: [
    'Thresholds follow the file’s own level, so a setting means the same on a quiet recording and a hot one',
    'If the result sounds a touch dull, a dB or two of Air puts the top back — it is Air Boost’s curve, so there is no need for a separate Air Boost pass',
    'Delta never includes the Air makeup or the saturation: it plays only what the cut removes — the band cut and the broadband dip together',
    'The meter shows the total taken off each S; the readout under it splits that into TONE (band cut) and LEVEL (broadband dip)',
    'The lisp guard limits the total, so turning Split toward level cannot sink an S further than the band cut alone could',
    'Saturation adds about 1 ms of latency while Drive is above zero',
    'Below threshold the shelf sits at exactly 0 dB, so quiet material passes through untouched',
    'A sibilant alone in a gap is treated a little harder than one inside a word — the threshold rises slightly with the surrounding vowel energy',
    'The cut lets go within about 10 ms as each vowel starts, so the sound after an S keeps its top end',
    'Delta is only for monitoring and never affects what gets applied',
    'With HF Reso on, Delta covers both stages, playback runs about 12 ms late, and the applied result can differ very slightly from the preview, as with ResoTame itself',
  ],
}
