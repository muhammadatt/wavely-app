export default {
  summary: 'Levels a performance the way an opto compressor does — slowly, across phrases rather than syllables.',

  intro: [
    'LA Vintage 2A is modelled on the LA-2A, the tube-driven optical leveling amplifier that has been the default first compressor on vocals for decades. Its optical cell reacts slowly and lets go even more slowly, so it rides the level of whole phrases rather than individual syllables, and it is famously hard to hear working.',
    'Use it when a narrator drifts towards and away from the mic, when quiet passages need to sit up without the loud ones jumping, or whenever you want steadier level that still sounds natural. It measures your recording first, so the same Peak Reduction setting does the same job on a quiet file as on a hot one.',
  ],

  quickStart: [
    'Select the passage and turn the plugin ON — it opens engaged.',
    'Play, and raise Peak Reduction until the meter swings 3–6 dB on the loud phrases.',
    'Leave AUTO lit so Gain makes up the level for you.',
    'Use COMP for levelling and LIMIT only for a harder ceiling.',
    'Compare against bypass, then Apply to selection.',
  ],

  controls: [
    {
      label: 'Peak Reduction',
      shot: 'peak-reduction',
      text: 'Sets how much compression you get.',
      details: [
        'Like the hardware, there is no threshold: the knob is side-chain gain into a fixed internal threshold, so turning it up makes the cell react to quieter material.',
        'The file is aligned first (see Pre-Gain), so a given setting does the same job on a quiet recording as on a hot one. Most narration sits between 30 and 60.',
        'Hover, focus or drag the knob to read its value.',
      ],
      range: '0 to 100 in steps of 1',
      default: '50',
    },
    {
      label: 'VU meter',
      shot: 'meter',
      text: 'Shows the gain reduction the cell is applying, in dB.',
      details: [
        'It reads while audio plays. A needle resting at 0 means nothing is being compressed.',
      ],
    },
    {
      label: 'Harmonics lamp',
      shot: 'harmonics',
      text: 'The lamp beside VINTAGE 2A turns the valve and cell colour on or off.',
      details: [
        'Off is not a bypass: the detector, timing and gain reduction are identical, only the harmonic colour goes.',
        'The colour is mostly second harmonic, with a guard that eases it off on loud sibilants so an S does not turn gritty.',
      ],
      range: 'On, Off',
      default: 'On',
    },
    {
      label: 'Gain',
      shot: 'gain',
      text: 'Makeup level after the compressor, feeding the output valve.',
      details: [
        'With AUTO lit the plugin turns this knob for you. Turning it yourself takes over and switches AUTO off.',
      ],
      range: '−24 to +24 dB in 0.1 dB steps',
      default: '0 dB, then set by AUTO',
    },
    {
      label: 'Auto',
      shot: 'auto-makeup',
      text: 'Lets the plugin set Gain from a measurement of the selection.',
      details: [
        'It restores the level of the body of the voice (the 99.9th percentile of the samples), not of the single loudest peak, so the knob never runs backwards as you compress harder.',
        'A ceiling at the selection’s own peak guarantees the output is never louder than the source at any setting.',
        'It follows Mix too, so Gain stays right at any blend.',
      ],
      range: 'On, Off',
      default: 'On',
    },
    {
      label: 'Pre-Gain',
      shot: 'pre-gain',
      text: 'How hard this file drives the compressor, set so Peak Reduction means the same on any recording level.',
      details: [
        'Measured from the whole file’s gated RMS and applied to the side-chain only — it changes what the compressor hears, never the output level.',
        'Click the line to open it. Stepping it takes over from AUTO and the line reads MANUAL until you switch AUTO back on.',
        'The manual range reaches further than the automatic one, for very quiet files.',
      ],
      range: '−48 to +48 dB in 0.5 dB steps, or AUTO',
      default: 'AUTO',
    },
    {
      label: 'Lookahead',
      shot: 'lookahead',
      text: 'Delays the audio so the compressor is ready for an onset that comes out of silence.',
      details: [
        'Off is the hardware. A few milliseconds stops the first syllable after a pause slipping through before the cell reacts.',
        'Past about 20 ms the duck would start audibly before the consonant, which is why it stops there.',
      ],
      range: 'Off to 20 ms in 1 ms steps',
      default: 'Off',
    },
    {
      label: 'Comp / Limit',
      shot: 'mode',
      text: 'Chooses gentle levelling or a harder ceiling.',
      details: [
        'COMP is around 3:1 and is the one to use on voice. LIMIT holds the peaks much more firmly.',
      ],
      range: 'COMP, LIMIT',
      default: 'COMP',
    },
    {
      label: 'HF Emph',
      shot: 'hf-emph',
      text: 'Tilts what the compressor listens to toward the upper mids — the hardware’s R37 trimmer.',
      details: [
        'FLAT is factory. Turning it up adds a high shelf to the side-chain only, up to +21 dB, so the compressor stops reacting to plosives and low-end bumps and follows the voice instead.',
        'It changes what the compressor hears, not the tone of the audio.',
      ],
      range: 'FLAT to +21 dB',
      default: 'FLAT',
    },
    {
      label: 'Mix',
      shot: 'mix',
      text: 'Blends the untouched signal back in, for parallel compression without a second track.',
      details: [
        'The dry path is delay-compensated, so the blend never combs.',
      ],
      range: 'DRY (0 %) to WET (100 %)',
      default: 'WET (100 %)',
    },
  ],

  notes: [
    'It levels phrases, not syllables. When you want individual peaks caught fast, reach for LA Classic 76, or VoxPressor for both in one window.',
    'Presets save Peak Reduction but not Pre-Gain, which is measured for each file.',
  ],
}
