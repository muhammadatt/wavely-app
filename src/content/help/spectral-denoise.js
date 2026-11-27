export default {
  summary: 'Turns down steady background noise, such as hiss, fans and room tone, in the browser, using a noise profile learned from the recording.',

  intro: [
    'Spectral Denoise learns what the background noise of a recording sounds like and turns that noise down wherever it is louder than the voice, all in the browser with no upload.',
    'It works on steady noise: hiss, a computer fan, air conditioning, preamp noise. Noise that changes from moment to moment, such as traffic, keyboards or other voices, is not in the profile and passes through. For that, use Noise Reduction.',
  ],

  quickStart: [
    'Select the part of the file to clean, or the whole file.',
    'Turn the plugin on. It learns the noise from the quietest moments of the whole file.',
    'Play, and raise REDUCTION until the noise in the pauses is low enough.',
    'If the voice turns watery, lower REDUCTION or raise THRESHOLD.',
    'Apply.',
  ],

  controls: [
    {
      label: 'IN',
      shot: 'in-meter',
      text: 'The level going into the denoiser.',
    },
    {
      label: 'Spectrum',
      shot: 'spectrum',
      text: 'The learned noise as a dashed line, with the live input and output under it while the file plays.',
      details: [
        'The dashed line includes THRESHOLD, so it shows the level a sound must clear to be kept.',
      ],
    },
    {
      label: 'Removed',
      shot: 'removed',
      text: 'How much the output is quieter than the input right now, across the whole spectrum.',
    },
    {
      label: 'Status line',
      shot: 'status',
      text: 'Says where the noise profile came from, how loud the noise is, and how far it sits under the speech.',
      details: [
        'If the noise sits less than 12 dB under the speech, the file may have few clean pauses, and the line suggests learning from a selection of room tone.',
      ],
    },
    {
      label: 'Learn',
      shot: 'learn',
      text: 'Learns the noise from the selection. Select a stretch of room tone with no voice in it first.',
    },
    {
      label: 'Auto',
      shot: 'relearn',
      text: 'Learns the noise again from the quietest tenth of the whole file, which on speech is the pauses.',
    },
    {
      label: 'OUT',
      shot: 'out-meter',
      text: 'The level coming out of the denoiser.',
    },
    {
      label: 'REDUCTION',
      shot: 'reduction',
      text: 'How far the noise is turned down.',
      details: [
        'Higher removes more noise. Past about 20 dB the voice can start to sound thin or watery.',
      ],
      range: '0 to 40 dB',
      default: '12 dB',
    },
    {
      label: 'THRESHOLD',
      shot: 'threshold',
      text: 'How far above the learned noise a sound must be to be kept.',
      details: [
        'Raise it if some noise still comes through. Lower it if quiet parts of the voice are being removed.',
      ],
      range: '−6 to +12 dB',
      default: '+3 dB',
    },
    {
      label: 'SMOOTHING',
      shot: 'smoothing',
      text: 'Smooths the leftover noise in the pauses, so it stays a soft hiss rather than a twinkle.',
      details: [
        'It acts only where the noise is louder than the voice, so it leaves the voice alone.',
      ],
      range: '0 to 100',
      default: '50',
    },
  ],

  notes: [
    'The profile is kept for each open file, so every tab is cleaned with its own noise.',
    'Everything runs on your device. Nothing is uploaded.',
  ],
}
