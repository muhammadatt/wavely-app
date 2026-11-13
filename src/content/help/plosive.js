export default {
  summary: 'Takes the thump out of P and B sounds and the spit out of hard T, K and P releases, only where they happen',

  intro: [
    'The Plosive Tamer takes the thump out of P and B sounds, where air from the mouth hits the microphone, and the spit out of hard T, K and P releases, acting only at the moments they happen',
    'Use it when plosives boom or click, and you want them fixed without a high-pass filter thinning the whole voice. Deep voices are spared because it only acts on a sudden jump of low-end energy, not on a voice that is simply low',
  ],

  quickStart: [
    'Select a passage with P, B and T sounds and press Preview — the plugin opens engaged',
    'Turn on DELTA: you should hear thumps and short spits, not words',
    'Raise each SENSITIVITY until the plosives you can hear are caught, watching the POPS and BURSTS counters',
    'Set each DEPTH so the plosive sits naturally — too deep and a P loses its punch',
    'Turn DELTA off, compare against bypass and apply',
  ],

  controls: [
    {
      label: 'IN',
      shot: 'in-meter',
      text: 'The input level, in dBFS',
    },
    {
      label: 'POP / BURST meters',
      shot: 'reduction-bars',
      text: 'How far each stage is cutting right now, in dB',
      details: [
        'POP reads up to 24 dB and BURST up to 18 dB, each stage’s own maximum. Each bar holds its peak for 0.4 s and then falls at 20 dB per second, so a 20 ms cut is still visible',
      ],
    },
    {
      label: 'Activity scope',
      shot: 'scope',
      text: 'The waveform around the playhead, shaded amber where a pop was cut and lavender where a T, K or P release was',
      details: [
        'The playhead is at the centre: what has played is to its left, what is coming to its right',
        'It freezes on what last played while the transport is stopped, and starts over if playback resumes somewhere else. Click it to start playback',
      ],
    },
    {
      label: 'POPS',
      shot: 'pops-count',
      text: 'How many pops the POP stage has caught since the last RESET, with a lamp that lights on each one',
    },
    {
      label: 'BURSTS',
      shot: 'bursts-count',
      text: 'How many releases the BURST stage has caught since the last RESET, with a lamp that lights on each one',
    },
    {
      label: 'RESET',
      shot: 'reset',
      text: 'Sets both counters back to 0',
    },
    {
      label: 'OUT',
      shot: 'out-meter',
      text: 'The output level after the plugin, in dBFS',
    },
    {
      label: 'Output',
      shot: 'output',
      text: 'A level trim after the plugin, for matching against bypass',
      details: ['Double-click it to reset'],
      range: '−12 to +12 dB in 0.1 dB steps',
      default: '0.0 dB',
    },
    {
      label: 'POP DEPTH',
      group: 'POP · P AND B THUMPS',
      shot: 'pop-depth',
      text: 'The deepest a P or B thump is taken down',
      details: [
        'Each pop is cut only as far as its low band stands over the voice above it, so a mild pop gets less than the maximum',
        'The cut blends in a high-pass filter at FREQ for the length of the pop, so the voice band above it is left alone. At 0 the knob reads OFF and the POP stage is out',
      ],
      range: 'OFF to 24 dB in 0.5 dB steps',
      default: '12.0 dB',
    },
    {
      label: 'POP FREQ',
      group: 'POP · P AND B THUMPS',
      shot: 'pop-freq',
      text: 'Where the thump lives: the band below this is what is detected and turned down',
      details: [
        'Raise it for a boomy close mic. Lower it to keep a deep voice’s weight',
        'The voice band the pop is compared against runs from twice this frequency up to 3 kHz',
        'Click the value to type one, in Hz or with a k (for example 0.12k)',
      ],
      range: '60 to 250 Hz',
      default: '120 Hz',
    },
    {
      label: 'POP SENSITIVITY',
      group: 'POP · P AND B THUMPS',
      shot: 'pop-sensitivity',
      text: 'How easily a pop is caught',
      details: [
        'A pop has to jump suddenly in the low band (within 20 ms) and then stand over the voice above it. At 50 that is a 10 dB jump and 3 dB over the voice; higher settings catch milder pops',
        'A deep voice’s steady low end never jumps, so held low vowels are left alone at any setting',
        'Material more than 40 dB below the file’s own voice level is never treated',
      ],
      range: '0 to 100 in steps of 1',
      default: '50',
    },
    {
      label: 'POP RELEASE',
      group: 'POP · P AND B THUMPS',
      shot: 'pop-release',
      text: 'How quickly the low end comes back after a pop',
      range: '15 to 300 ms',
      default: '60 ms',
    },
    {
      label: 'BURST DEPTH',
      group: 'BURST · T, K AND P RELEASES',
      shot: 'burst-depth',
      text: 'How far a caught T, K or P release is turned down above FREQ',
      details: [
        'The cut blends in a low-pass filter at FREQ for the length of the burst, so only the top of the release is taken down. At 0 the knob reads OFF and the BURST stage is out',
      ],
      range: 'OFF to 18 dB in 0.5 dB steps',
      default: '6.0 dB',
    },
    {
      label: 'BURST FREQ',
      group: 'BURST · T, K AND P RELEASES',
      shot: 'burst-freq',
      text: 'The band above this is cut on a burst',
      details: [
        'Lower takes more of the release’s body; higher takes only its hiss',
        'Click the value to type one, in Hz or with a k (for example 2.5k)',
      ],
      range: '1.50 to 8.00 kHz in 10 Hz steps',
      default: '3.00 kHz',
    },
    {
      label: 'BURST SENSITIVITY',
      group: 'BURST · T, K AND P RELEASES',
      shot: 'burst-sensitivity',
      text: 'How sharp an onset must be to count as a release',
      details: [
        'A burst has to come straight out of a stop’s silence — at least 15 dB under the held voice for 15 to 200 ms — and then rise suddenly above 4 kHz. At 50 that rise is 12 dB in 5 ms; higher settings catch softer releases',
      ],
      range: '0 to 100 in steps of 1',
      default: '50',
    },
    {
      label: 'BURST LENGTH',
      group: 'BURST · T, K AND P RELEASES',
      shot: 'burst-length',
      text: 'How long a caught release is held down',
      details: [
        'It lets go early when the vowel after the release arrives, so the vowel keeps its top end',
      ],
      range: '15 to 80 ms',
      default: '40 ms',
    },
    {
      label: 'DELTA',
      text: 'Plays only what is being removed, from the button in the title bar',
      details: [
        'It should sound like thumps and short spits, not words. It is for listening only: Apply always renders the processed audio',
      ],
      range: 'On, Off',
      default: 'Off',
    },
  ],

  notes: [
    'Where nothing is caught the audio passes through untouched, bit for bit',
    'An S that starts very abruptly right after a short silence can be caught as a release. Lower BURST SENSITIVITY if an S sounds dulled',
    'The plugin delays playback by 8 ms so each cut is in place before the plosive starts. Apply removes the delay',
    'For a constant rumble rather than occasional thumps, use a high-pass filter in the EQ instead',
  ],
}
