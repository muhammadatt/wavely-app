export default {
  summary: 'Adds harmonic warmth, density or brightness with up to four saturation layers in series, each with its own curve, band and drive',

  whenToUse: [
    'A voice needs density or warmth without sounding processed',
    'Vowels sound dull after de-essing and you want harmonic brightness rather than EQ',
    'You want to audition saturation curves against each other at matched strength',
  ],

  quickStart: [
    'Select the passage and play it — the window opens engaged with two layers: a full-band Quartic for warmth and a Tanh exciter above 3 kHz',
    'Click a layer tab to show its controls, and press SOLO to hear that layer on its own',
    'Switch DELTA on to hear only what the layers add, and raise Drive until you can just hear it',
    'Use Amount to set how loud the result is, and Frequency Range to keep it where you want it',
    'Add a layer with + if you need a third character, compare against bypass, then Apply',
  ],

  controls: [
    {
      label: 'IN',
      shot: 'input',
      text: 'Input meter, with a trim under it that sets the level going into the layers',
      details: [
        'Because the curves respond to level, the trim moves how hard every layer is driven at once — a drive offset for the whole stack',
      ],
      range: '−24 to +24 dB in 0.1 dB steps',
      default: '0.0 dB',
    },
    {
      label: 'Layer tabs',
      shot: 'layers',
      text: 'One tab per layer in use, each showing its curve and drive; click a tab to show that layer’s controls below',
      details: [
        'Layers run in series, left to right: each one shapes what the layer before it left',
        'The + tab adds the next layer, up to four, with the settings that slot last held. The ✕ on a tab removes that layer; the ones after it move up, and its settings come back if you add it again. The last layer cannot be removed',
      ],
      range: '1 to 4 layers',
      default: '2 layers',
    },
    {
      label: 'ON / OFF',
      shot: 'layer-on',
      text: 'Takes the selected layer out of the sound while keeping it in the stack with all its settings',
      details: [
        'Off applies to both preview and Apply. Use it to compare the stack with and without one layer',
      ],
      range: 'ON, OFF',
      default: 'ON',
    },
    {
      label: 'SOLO',
      shot: 'solo',
      text: 'Plays only the selected layer, working on the unprocessed input',
      details: [
        'A listening aid only: it never reaches Apply, and adding or removing a layer clears it',
      ],
      range: 'On, Off',
      default: 'Off',
    },
    {
      label: 'Curve',
      group: 'CHARACTER',
      shot: 'curve',
      text: 'The saturation shape, which decides the harmonic character the layer adds',
      details: [
        'QUARTIC adds mostly second harmonic — warmth without edge. ASYM mixes even and odd, a tube-like lean',
        'ATAN, ALGEBRAIC, TANH and CUBIC add odd harmonics and are the ones that brighten and excite. ALGEBRAIC bends earliest and most gently, TANH has the most bite when pushed, and CUBIC is pure third harmonic until it flattens',
        'HYSTERESIS is a tape magnetisation model with memory: run full band, it softens onsets and compresses much like TANH, and keeps a grain on quiet passages. It costs about three times as much to run',
      ],
      range: 'QUARTIC, ASYM, ATAN, ALGEBRAIC, TANH, CUBIC, HYSTERESIS',
      default: 'Layer 1 QUARTIC, layer 2 TANH',
    },
    {
      label: 'Drive',
      group: 'CHARACTER',
      shot: 'drive',
      text: 'How hard the layer’s curve is pushed, in dB above a matched point',
      details: [
        'At 0 dB every curve makes 1 % distortion on a sine peaking at this band’s typical level, measured from the whole file (its gated level in the band plus 12 dB). So the same setting means the same strength on any curve, band or recording level, and switching curves compares character rather than loudness',
        'A high band sits far below the voice, so 0 dB there is barely audible: an exciter layer wants roughly +12 to +27 dB',
      ],
      range: '−12 to +60 dB in 0.5 dB steps',
      default: 'Layer 1 0 dB, layer 2 +27 dB',
    },
    {
      label: 'Amount',
      group: 'CHARACTER',
      shot: 'amount',
      text: 'The level of what the layer adds; the clean signal is never touched',
      details: [
        'Drive sets how hard the curve bends, Amount how loud its result is. Reach for it when Drive has run out — the Quartic stops growing past about +15 dB of drive',
        'At 0 dB the layer adds exactly what its curve makes',
      ],
      range: '−24 to +24 dB in 0.5 dB steps',
      default: '0.0 dB',
    },
    {
      label: 'Low',
      group: 'FREQUENCY RANGE',
      shot: 'low',
      text: 'The bottom of the band this layer saturates',
      details: [
        'Fully down (1 Hz) leaves the bottom open. The next step is a gentle 2 Hz corner, so moving off open never takes a sudden bite out of an even curve’s low weight',
        'What the curve adds is filtered to the band again on the way out, so the harmonics it makes stay inside the band',
      ],
      range: '1 Hz to 20 kHz',
      default: 'Layer 1 1 Hz (open), layer 2 3 kHz',
    },
    {
      label: 'High',
      group: 'FREQUENCY RANGE',
      shot: 'high',
      text: 'The top of the band this layer saturates',
      details: [
        'Fully up (20 kHz) leaves the top open. The band never closes tighter than a third of an octave',
      ],
      range: '20 Hz to 20 kHz',
      default: '20 kHz (open)',
    },
    {
      label: 'Band readout',
      group: 'FREQUENCY RANGE',
      shot: 'band-range',
      text: 'Spells out the band in words: FULL BAND, ABOVE or BELOW a frequency, or a range',
    },
    {
      label: 'Pre-Emphasis',
      group: 'PRE-EMPHASIS',
      shot: 'emph-on',
      text: 'Switches the layer’s pre-emphasis in or out without losing its frequency, Q or gain',
      details: [
        'Pre-emphasis is one filter that boosts or cuts a region on its way into the curve, and the exact opposite filter after it, so the clean tone is unchanged and only what the curve does changes',
      ],
      range: 'ON, OFF',
      default: 'ON',
    },
    {
      label: 'HI / BELL / LO',
      group: 'PRE-EMPHASIS',
      shot: 'emph-shape',
      text: 'The filter shape: a high shelf, a bell around one frequency, or a low shelf',
      range: 'HI, BELL, LO',
      default: 'HI',
    },
    {
      label: 'Response plot',
      group: 'PRE-EMPHASIS',
      shot: 'emph-plot',
      text: 'Shows the pre-emphasis curve; drag its node to set Freq and Gain, and scroll over it for Q',
      details: [
        'Positive gain pushes the region into the curve harder, so it saturates first and the harmonics made above it are trimmed on the way out — the smoothest choice on a voice. Negative gain pulls the region out of the curve, which lifts the harmonics it makes',
        'On a high band the gain acts mostly like extra or less drive: a −20.4 dB high shelf needs about 11 dB more Drive to brighten as much as no emphasis, a +20.4 dB one about 15 dB less',
        'The Freq, Gain and Q figures beside the plot read the current values. Double-click the plot to reset all three to the slot’s factory setting. While the emphasis is off the curve is drawn dashed',
      ],
      range: 'Freq 100 Hz to 16 kHz · Gain −24 to +24 dB · Q 0.30 to 4.00',
      default: '2.3 kHz, Q 0.71; layer 1 +20.4 dB, layer 2 −20.4 dB',
    },
    {
      label: 'Reset layers',
      shot: 'reset-layers',
      text: 'Returns the stack to the two factory layers: a full-band Quartic for warmth and a Tanh exciter above 3 kHz',
    },
    {
      label: 'OUT',
      shot: 'output',
      text: 'Output meter, with a trim under it that sets the level after the layers',
      details: [
        'Use it to level-match the processed sound against bypass before you judge it',
      ],
      range: '−24 to +24 dB in 0.1 dB steps',
      default: '0.0 dB',
    },
    {
      label: 'DELTA',
      text: 'The header switch plays only what the layers add',
      details: [
        'Monitoring only: Apply always renders the full processed sound',
      ],
      range: 'On, Off',
      default: 'Off',
    },
  ],

  notes: [
    'Drive is calibrated on this file: each layer measures how loud its band is here, so the same setting means the same thing on a quiet recording and a hot one',
    'The Quartic does not excite: its harmonics are even and weak at high-band levels. Use an odd curve for brightness',
    'Small amounts from several layers usually sound more natural than a lot from one',
    'Every layer slot adds a fixed 50 samples of latency, in use or not — 200 samples, about 4.5 ms at 44.1 kHz — so adding or removing a layer never shifts the audio. It is compensated when you apply',
  ],
}
