export default {
  summary: 'Dips the top end only while a consonant spikes, then lets it go',

  whenToUse: [
    'S, T and CH sounds poke out of an otherwise good recording',
    'A static high cut would dull the voice along with the harshness',
    'You want sibilance calmer without losing breath or air',
  ],

  controls: [
    { label: 'Amount', text: 'How early the cut starts and how hard it bites — threshold, ratio (up to 6:1) and depth (up to 24 dB) rise together in even steps' },
    { label: 'Context', text: 'How much vowel energy raises the threshold, so a sibilant alone in a gap is treated harder than one inside a word' },
    { label: 'Shape', text: 'Band cuts the sibilance region and leaves the air above 11 kHz; Shelf cuts everything above 4.5 kHz' },
    { label: 'Lisp guard', text: 'Stops any S being pulled further below the voice than a normal S sits, so heavy settings cannot turn S into TH' },
    { label: 'HF Reso', text: 'Runs a band-limited ResoTame ahead of the softener: it takes narrow rings and whistly S between 5 and 12 kHz and leaves ordinary S to the softener. For comparing the pairing; its settings are fixed' },
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
    'If the result still sounds a touch dull, a dB or two of Air Boost afterwards puts the top end back',
    'Below threshold the shelf sits at exactly 0 dB, so quiet material passes through untouched',
    'Shelf depth moves more with Context up — the same S reads differently by phrase, and that is intended',
    'The cut lets go within about 10 ms as each vowel starts, so the sound after an S keeps its top end',
    'Delta is only for monitoring and never affects what gets applied',
    'With HF Reso on, Delta covers both stages, playback runs about 12 ms late, and the applied result can differ very slightly from the preview, as with ResoTame itself',
  ],
}
