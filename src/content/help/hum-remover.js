export default {
  summary: 'Finds mains hum and its harmonics in the selection and cuts each one with a narrow notch.',

  intro: [
    'Hum Remover finds mains hum, the steady buzz at 50 or 60 Hz and its harmonics, in the selection and cuts each one with its own narrow notch, leaving the voice around them alone.',
    'Use it when a low buzz runs under the whole recording, or when noise reduction thinned the voice and the hum is still there.',
  ],

  quickStart: [
    'Select at least 1 second that holds the hum — a pause between phrases is ideal.',
    'Pick the MAINS FREQUENCY for where the recording was made, then press Analyse.',
    'Play: the harmonics the analysis recommends are already ticked, so listen with the plugin on and off.',
    'Untick any row that makes no audible difference, and tick a row yourself if you can still hear hum there.',
    'Raise DEPTH only if hum is still audible, and keep WIDTH high so the notches stay narrow.',
    'Apply to the selection or the whole file.',
  ],

  controls: [
    {
      label: 'IN',
      shot: 'in-meter',
      text: 'The level going into the notches.',
    },
    {
      label: 'MAINS FREQUENCY',
      shot: 'mains',
      text: 'Which mains frequency to look for: 60 Hz in North America and parts of Japan, 50 Hz across most of the rest of the world.',
      details: [
        'Changing it clears the last analysis, since every harmonic in the table belongs to the old series. Analyse again after switching.',
      ],
      range: '60 Hz, 50 Hz',
      default: '60 Hz',
    },
    {
      label: 'Analyse',
      shot: 'analyse',
      text: 'Measures the selection for hum and fills the harmonic table.',
      details: [
        'It looks at up to 10 seconds from the middle of the selection with a very fine spectrum, about 0.08 Hz per point, and compares each harmonic with the floor around it.',
        'It anchors on the second harmonic (120 Hz or 100 Hz) rather than the fundamental, because a high-pass filter often removes 60 Hz and leaves 120 Hz behind.',
        'Hum is declared when at least 2 harmonics stand 8 dB or more above their surroundings in a pattern hum would make.',
        'It needs a selection of at least 1 second. Editing the audio afterwards marks the analysis as out of date.',
      ],
    },
    {
      label: 'Harmonic table',
      shot: 'harmonics',
      text: 'One row per harmonic, the first five multiples of the mains frequency, each with a tick box that turns its notch on.',
      details: [
        'FREQ is the frequency of the row. The bar and Δ DB show how far it stands above the surrounding floor, with the bar full at 48 dB. An amber bar is one the analysis counted as hum.',
        'An unticked row says why it was left out: no hum signature, too quiet, not prominent enough, or louder than the hum pattern.',
        'IN SOURCE means the energy sits on the pitch, or a harmonic of the pitch, of something sustained in the recording, such as a voice near 120 Hz or a held note. It is left unticked because notching it thins the recording. Tick it anyway if you can hear hum there.',
        'The ticks are live: you hear each notch come and go as you play.',
      ],
      default: 'The analysis’s recommendations ticked',
    },
    {
      label: 'Status line',
      shot: 'status',
      text: 'Says what the last analysis found: how many notches are active, why no hum was found, or that the audio changed and needs analysing again.',
    },
    {
      label: 'OUT',
      shot: 'out-meter',
      text: 'The level after the notches.',
    },
    {
      label: 'WIDTH',
      shot: 'width',
      text: 'How narrow each notch is, as a Q value — higher is narrower and takes less of the recording around the hum.',
      details: [
        'At the default Q 30 a notch at 120 Hz is about 4 Hz wide. Lower it only if a notch is missing hum that drifts slightly.',
        'Click the value to type one. Double-click the knob to reset it.',
      ],
      range: 'Q 5 to Q 60 in steps of 1',
      default: 'Q 30',
    },
    {
      label: 'DEPTH',
      shot: 'depth',
      text: 'How far each notch cuts at its centre.',
      details: [
        'Each notch is a peaking cut of finite depth rather than a total null, which leaves the spectrum around the hum far more intact. The default matches the mastering presets’ hum stage.',
        'Click the value to type one. Double-click the knob to reset it.',
      ],
      range: '0 to −40 dB in 1 dB steps',
      default: '−18 dB',
    },
  ],

  notes: [
    'This is for steady hum. For a rumble that comes and goes, use a high-pass filter in the EQ instead.',
    'Leave the highest harmonics unticked unless you can still hear them: they fall inside the voice, and notching them costs more than it removes.',
    'Apply stays unavailable until the plugin is on and at least one harmonic is ticked.',
  ],
}
