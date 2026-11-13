export default {
  summary: 'Raises quiet detail faster than it raises peaks, for density and apparent loudness without going past full scale',

  intro: [
    'Cambridge Inflator follows the idea behind the classic Inflator mastering processor: it raises quiet detail faster than it raises peaks, so a recording gains density and apparent loudness without anything going past full scale',
    'It suits recordings that are technically fine but sound thin or far away, and situations where you want more weight without a compressor pumping on the syllables. A band split lets it treat lows, mids and highs separately',
  ],

  quickStart: [
    'Select the passage and play it. The plugin opens engaged at EFFECT 50 %',
    'Leave CURVE at 0 and move EFFECT until the recording sounds closer',
    'Use Input to decide how much of the file is lifted, rather than pushing EFFECT further',
    'Move CURVE for character: up lifts quiet detail more, down less',
    'Pull Output down until the level matches bypass, then judge and Apply',
  ],

  controls: [
    {
      label: 'IN',
      shot: 'in',
      text: 'The input meter, with the Input trim under it',
      details: [
        'Input drives the signal into the curve. The effect is not level-invariant: the curve lifts quiet material more than loud, so a hotter input puts more of the file near the top, where it is lifted least',
        'Double-click the trim to reset it',
      ],
      range: '−12 to +12 dB in 0.1 dB steps',
      default: '0 dB',
    },
    {
      label: 'EFFECT',
      shot: 'effect',
      text: 'How much of the curve’s output is blended with the dry signal',
      details: [
        'The blend is linear in amplitude, so the lift on quiet material grows smoothly with the fader. At 0 % the curve is skipped outright and the output is the dry signal exactly',
        'Double-click the fader to return it to 50 %',
      ],
      range: '0 to 100 % in 0.1 % steps',
      default: '50 %',
    },
    {
      label: 'LIFT',
      shot: 'lift',
      text: 'Shows what the curve is adding right now, and the most it can add at these settings',
      details: [
        'The ladder is measured live as output against input, one column per channel. The number is the lift on the quietest material — the curve’s small-signal gain blended by EFFECT — which is the most any part of the file can be raised',
        'At the defaults the number reads +1.9 dB. The largest it can read is +6.0 dB, at CURVE +50 and EFFECT 100 %. It reads OFF while the plugin is bypassed',
      ],
    },
    {
      label: 'BAND SPLIT',
      shot: 'band-split',
      text: 'Runs the curve on three bands instead of the whole signal',
      details: [
        'The bands split at 240 Hz and 2.4 kHz, so a loud low end no longer decides how much the mids and highs are lifted. The caption under the switch says which mode is running',
        'Three bands that are each held at full scale can still sum to more than full scale — about +2.8 dB over on hot material. While BAND SPLIT is on and CLIP 0 dB is off, a warning under the panel says so',
      ],
      range: 'On, Off',
      default: 'Off',
    },
    {
      label: 'CLIP 0 dB',
      shot: 'clip',
      text: 'Holds peaks at full scale',
      details: [
        'With it off, anything that arrives past full scale — from a hot Input, or from BAND SPLIT — folds back toward silence, the way the original hardware-style curve does. With it on, those samples are held at full scale instead',
        'Turn it on whenever you use BAND SPLIT or drive Input hard',
      ],
      range: 'On, Off',
      default: 'Off',
    },
    {
      label: 'CURVE',
      shot: 'curve',
      text: 'Sets the shape of the curve, and with it how much quiet material is lifted',
      details: [
        'It changes shape, never the ceiling: full scale comes out at full scale at every setting, and the curve arrives there flat, so there is no corner to generate harsh harmonics',
        'The small-signal lift is 0 dB at −50, +3.5 dB at 0 and +6.0 dB at +50, before EFFECT blends it in',
        'The curve adds odd harmonics only, which is why it reads as density rather than as distortion. Double-click the fader to return it to 0',
      ],
      range: '−50 to +50 in steps of 0.1',
      default: '0',
    },
    {
      label: 'OUT',
      shot: 'out',
      text: 'The output meter, with the Output trim under it',
      details: [
        'Output only cuts. The curve already raises the level, and taking that back is what makes a fair comparison against bypass possible — otherwise the louder version always wins',
        'Double-click the trim to reset it',
      ],
      range: '−12 to 0 dB in 0.1 dB steps',
      default: '0 dB',
    },
  ],

  notes: [
    'It is not a peak controller. The curve cannot reduce a peak — reach for the Soft Clipper afterwards when you need peak control',
    'It holds the ceiling, not every peak: a file already peaking at full scale comes back at full scale, while a quieter one has its peaks lifted too, by less than its quiet detail',
    'At any CURVE above −50 the plugin is louder than its input, so match the level with Output before deciding whether you like it',
  ],
}
