export default {
  summary: 'Dips the top end only while a consonant spikes, then lets it go',

  whenToUse: [
    'S, T and CH sounds poke out of an otherwise good recording',
    'A static high cut would dull the voice along with the harshness',
    'You want sibilance calmer without losing breath or air',
  ],

  controls: [
    { label: 'Amount', text: 'How early the shelf starts dipping and how deep it can go, up to 9 dB' },
    { label: 'Context', text: 'How much vowel energy raises the threshold, so a sibilant alone in a gap is treated harder than one inside a word' },
    { label: 'Rotator', text: 'Phase rotation on the detector only, the audio too, or neither' },
    { label: 'Listen', text: 'Hear the output, only what is being removed, or what the detector hears' },
  ],

  steps: [
    'Play a passage with sibilance and set Listen to Delta',
    'Raise Amount until the delta is sibilance and nothing else',
    'Back Amount off if you hear vowels or breath in the delta',
    'Set Listen back to Off and compare against bypass at matched level',
  ],

  notes: [
    'Below threshold the shelf sits at exactly 0 dB, so quiet material passes through untouched',
    'Shelf depth moves more with Context up — the same S reads differently by phrase, and that is intended',
    'In-path rotation changes the waveform, so do not use it on a track you will sum with a double or a second mic',
    'Listen is only for monitoring and never affects what gets applied',
  ],
}
