export default {
  summary: 'Catches peaks fast and lifts everything underneath them, the way a 1176-style FET compressor does',

  whenToUse: [
    'You want the recording to sound denser, more present and more forward',
    'Transients and loud words poke out of an otherwise even performance',
    'LA Vintage 2A left the take steady but not loud enough',
    'You want parallel compression without a second track',
  ],

  quickStart: [
    'Select the passage and open the window — it opens engaged',
    'Leave Ratio on 4 and play, raising Input until the meter swings 3–6 dB on the loudest words',
    'Leave Auto Makeup lit so Output restores the level for you',
    'Set Attack by ear against the consonants, and Release so the level does not pump between words',
    'Pull Mix down if the result feels squashed but you want the density',
    'Compare against bypass, then Apply to selection',
  ],

  controls: [
    {
      label: 'Input',
      shot: 'input',
      text: 'Drives the compressor, and so sets how much it catches',
      details: [
        'Like the hardware, there is no threshold control: Input raises the signal into a fixed internal threshold, so turning it up makes the unit compress more',
        'It gains the audio as well as the detector, as the hardware’s input attenuator does, which is why Auto Makeup matters so much here',
        'The file is aligned first (see Pre-Gain), so a given setting does the same job on a quiet recording as on a hot one',
        'Hover, focus or drag the knob to read its value',
      ],
      range: '0 to 100 in steps of 1',
      default: '50',
    },
    {
      label: 'Ratio',
      shot: 'ratio',
      text: 'How hard it holds once it is working, from firm levelling to limiting',
      details: [
        '4 is gentle enough to leave on a whole take. 8 is firm control, 12 tames peaks and 20 is effectively a limiter',
        'As on the hardware, a higher ratio also raises the threshold, so the higher buttons start working later and change the character more than the amount',
        'ALL is all buttons in: a very high ratio near the threshold that eases off further above it, for an aggressive, crushed, loud sound',
      ],
      range: '20, 12, 8, 4, ALL',
      default: '4',
    },
    {
      label: 'VU meter',
      shot: 'meter',
      text: 'Shows the gain reduction the compressor is applying, in dB',
      details: [
        'It reads while audio plays. A needle resting at 0 means nothing is being compressed',
      ],
    },
    {
      label: 'Harmonics lamp',
      shot: 'harmonics',
      text: 'The lamp beside CLASSIC 76 turns the FET stage’s colour on or off',
      details: [
        'Off is not a bypass: the detector, timing and gain reduction are identical, only the harmonic colour goes',
      ],
      range: 'On, Off',
      default: 'On',
    },
    {
      label: 'Output',
      shot: 'output',
      text: 'Level after the compressor',
      details: [
        'With Auto Makeup lit the plugin turns this knob for you. Turning it yourself takes over and switches Auto Makeup off',
      ],
      range: '−24 to +24 dB in 0.1 dB steps',
      default: '0.0 dB, then set by Auto Makeup',
    },
    {
      label: 'Pre-Gain',
      shot: 'pre-gain',
      text: 'How hard this file drives the compressor, set so Input means the same on any recording level',
      details: [
        'Measured from the whole file’s gated RMS and applied to the detector only — it changes what the compressor hears, never the output level',
        'Click the line to open it. Stepping it takes over from AUTO and the line reads MANUAL until you switch AUTO back on',
        'The manual range reaches further than the automatic one, for very quiet files',
      ],
      range: '−48 to +48 dB in 0.5 dB steps, or AUTO',
      default: 'AUTO',
    },
    {
      label: 'SC HPF',
      shot: 'sc-hpf',
      text: 'Keeps low frequencies out of the detector, so plosives and rumble stop ducking a whole phrase',
      details: [
        'The hardware’s detector hears the full band, which is what Off gives you. 90 Hz stops plosives and rumble from triggering it; 150 Hz keeps chest weight out of it entirely',
        'It changes what the compressor hears, not the tone of the audio',
      ],
      range: 'Off, 90 Hz, 150 Hz',
      default: 'Off',
    },
    {
      label: 'Attack',
      shot: 'attack',
      text: 'How quickly it reacts to a peak',
      details: [
        'As on the hardware, 1 is the slowest and 7 the fastest. Faster catches more of each transient and can dull consonants; slower lets the front of each word through',
        'The time at each position is 800 µs, 433 µs, 234 µs, 126 µs, 68 µs, 37 µs and 20 µs. Hover the knob to read it',
      ],
      range: 'Dial 1 (800 µs) to Dial 7 (20 µs)',
      default: 'Dial 4 (126 µs)',
    },
    {
      label: 'Release',
      shot: 'release',
      text: 'How quickly it recovers after a peak',
      details: [
        '1 is the slowest and 7 the fastest. The time at each position is 0.73 s, 435 ms, 260 ms, 156 ms, 93 ms, 56 ms and 33 ms',
        'Fast settings add density and energy but can pump or ripple on a low voice; slower ones are smoother',
      ],
      range: 'Dial 1 (0.73 s) to Dial 7 (33 ms)',
      default: 'Dial 4 (156 ms)',
    },
    {
      label: 'Auto Makeup',
      shot: 'auto-makeup',
      text: 'Lets the plugin set Output from a measurement of the selection',
      details: [
        'It restores the level of the body of the voice (the 99.9th percentile of the samples), not of the single loudest peak, so a plosive the compressor cannot catch never makes the knob run backwards',
        'A ceiling at the selection’s own peak guarantees the output is never louder than the source. It follows Mix too, so Output stays right at any blend',
        'When you apply, the result is measured once more and its loudest peak is brought back up to the source’s peak, and the message after Apply reports that trim. At light settings the applied file can therefore be up to about 2 dB louder than the preview',
      ],
      range: 'On, Off',
      default: 'On',
    },
    {
      label: 'Mix',
      shot: 'mix',
      text: 'Blends the untouched signal back in, for parallel compression without a second track',
      details: [
        'The dry path is delay-compensated, so the blend never combs',
      ],
      range: '0 to 100 % in 1 % steps',
      default: '100 %',
    },
  ],

  notes: [
    'It reaches for peaks rather than the body, so it typically adds 1 to 2 dB of average level where LA Vintage 2A adds none',
    'Turn on SC HPF before reaching for a slower attack when plosives are the problem',
    'The effect delays the audio by 50 samples at every setting; Apply compensates, so the result lines up with the original',
    'Pre-Gain is a property of the file and is never saved in a preset; Input, Ratio, Attack and Release are',
  ],
}
