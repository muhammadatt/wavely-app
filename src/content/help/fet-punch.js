export default {
  summary: 'Catches peaks fast and lifts everything underneath them',

  whenToUse: [
    'You want the recording to sound denser and more present',
    'Transients are poking out of an otherwise even performance',
    'Opto Comp left the take steady but not loud enough',
  ],

  controls: [
    {
      label: 'Input',
      text: 'Drive into the compressor, which sets how much it catches',
    },
    {
      label: 'Output',
      text: 'Level after the compressor',
    },
    {
      label: 'AUTO',
      text: 'Sets Output to restore what the peaks lost — touching the knob takes over',
    },
    {
      label: 'RATIO',
      text: 'How hard it holds once it is working, from gentle levelling to limiting',
    },
    {
      label: 'Attack',
      text: 'How quickly it reacts to a peak — faster catches more transient, slower lets more through',
    },
    {
      label: 'Release',
      text: 'How quickly it recovers afterwards',
    },
    {
      label: 'SC HPF',
      text: 'Keeps low frequencies out of the detector, so plosives stop triggering the whole compressor',
    },
    {
      label: 'FET Drive',
      text: 'How much of the amplifier colour comes with the compression',
    },
    {
      label: 'Mix',
      text: 'Blends the compressed signal against the original for parallel compression',
    },
  ],

  steps: [
    'Play the selection and raise Input until the meter shows a few dB on the loudest words',
    'Set Attack by ear against the consonants — too fast dulls them, too slow lets them through',
    'Pull Mix back if the result feels squashed but you want the density',
  ],

  notes: [
    'It reaches for peaks rather than the body, so it typically adds 1 to 2 dB of average level where Opto Comp adds none',
    'Turn on SC HPF before reaching for a slower attack when plosives are the problem',
  ],
}
