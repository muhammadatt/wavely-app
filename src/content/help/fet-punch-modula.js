/**
 * FET Punch behind the "Modula" faceplate — the UI evaluation duplicate.
 *
 * Same plugin as `fet-punch.js`, different control names and different
 * gestures, so the help is written against THIS face rather than shared: a
 * user reading "the Output knob" while looking at a fader is worse than no
 * help. Goes with `FET1176ModulaModal.vue`; remove both together.
 */
export default {
  summary: 'FET Punch in the Modula faceplate — the same compressor, a different face',

  whenToUse: [
    'You want to compare this faceplate against the shipping FET Punch on the same audio',
    'Transients are poking out of an otherwise even performance',
    'Opto Comp left the take steady but not loud enough',
  ],

  controls: [
    {
      label: 'Input',
      text: 'Drive into the compressor, which sets how much it catches — the LED ring shows how far it is pushed',
    },
    {
      label: 'Ratio',
      text: 'Clicks between the five positions, from gentle levelling to limiting to all buttons in',
    },
    {
      label: 'Attack',
      text: 'How quickly it reacts to a peak — the readout shows the dial and the real time it sets',
    },
    {
      label: 'Release',
      text: 'How quickly it recovers afterwards',
    },
    {
      label: 'FET Drive',
      text: 'How much of the amplifier colour comes with the compression',
    },
    {
      label: 'Auto Gain',
      text: 'Holds Output at what restores the source peak — dragging the fader takes over and switches it off',
    },
    {
      label: 'SC HPF',
      text: 'Keeps low frequencies out of the detector so plosives stop triggering the whole compressor — the slide picks 90 or 150 Hz',
    },
    {
      label: 'Output',
      text: 'Level after the compressor, on the fader',
    },
    {
      label: 'Dry / Wet',
      text: 'Blends the compressed signal against the original for parallel compression',
    },
    {
      label: 'Power',
      text: 'Engages or bypasses the whole unit — the face dims while bypassed',
    },
  ],

  steps: [
    'Play the selection and raise Input until the needle shows a few dB on the loudest words',
    'Set Attack by ear against the consonants — too fast dulls them, too slow lets them through',
    'Pull Dry / Wet back if the result feels squashed but you want the density',
  ],

  notes: [
    'Every setting is shared with the regular FET Punch window — a change here is a change there',
    'The preset arrows step through the same collection the Presets menu offers',
  ],
}
