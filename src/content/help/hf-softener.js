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
    { label: 'Drive', text: 'Saturation ahead of the cut, for density and warmth on the voice. At 50 % every curve makes the same amount of distortion, so switching curves compares their character, not their strength' },
    { label: 'Sat curve', text: 'The saturation shape to audition. Quartic is the even-harmonic warmth OptoSmooth uses; the others add odd harmonics, from gentle (Atan) to edgy (Tanh, Cubic)' },
    { label: 'Emph', text: 'Emphasis around the saturation. OPTO is OptoSmooth’s: highs pushed into the curve and taken back out, which on a voice comes out smoothest up top. REV is the reverse: it keeps high content clean but brightens the harmonics vowels make' },
    { label: 'Sat mode', text: 'Voiced saturates only the vowels and fades out as each S arrives, so it never adds harmonics to sibilance. Full saturates everything and leaves the cut to clean up after it' },
    { label: 'Air', text: 'Puts back a few dB of top after the cut, on the same curve as Air Boost. It is static, so it lifts the air everywhere, not just between sibilants' },
    { label: 'HF Reso', text: 'Runs a band-limited ResoTame ahead of the softener: it takes narrow rings and whistly S between 5 and 12 kHz and leaves ordinary S to the softener' },
    { label: 'Reso', text: 'The pre-stage’s threshold, as on ResoTame, and the split between the two stages. High, it takes only rings and whistly S; turned down, it takes the sibilance as well and the softener’s cut shrinks to match. Below about 20 dB the lisp guard no longer limits the total' },
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
