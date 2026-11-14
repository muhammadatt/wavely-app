export default {
  eyebrow: 'Opto leveling amplifier',
  headline: 'Smooth, phrase-level leveling with real tube warmth.',
  pitch: [
    'Transparent leveling for vocals and spoken word, with the valve colour the original is loved for. It runs in your browser — nothing to install.',
  ],
  description: 'An LA-2A style opto compressor that runs in your browser: smooth phrase-level leveling, tube harmonics and auto makeup that never clips. Free to use.',

  overview: [
    'LA Vintage 2A is modelled on the Teletronix LA-2A, the electro-optical tube leveling amplifier that has been a studio favourite on vocals, bass and guitar for more than half a century. Its optical cell reacts gently and lets go slowly, so it rides the level of whole phrases rather than individual syllables — a performance comes out even without sounding compressed.',
    'Behind the famously simple two-knob face, LA Vintage 2A adds what a file-based workflow needs. It measures your recording before it compresses, so a setting does the same job on a quiet take as on a hot one; its makeup gain follows the body of the voice and can never push the result past the source’s own peak; and its valve colour is a second-harmonic-led curve fitted to measured harmonic data, with a guard that keeps loud S sounds clean.',
  ],

  features: [
    'Modelled on the classic electro-optical tube leveling amplifier',
    'Smooth, program-dependent leveling that rides phrases, not syllables',
    'Natural-sounding, even with heavy gain reduction',
    'Input alignment: Peak Reduction does the same job at any recording level',
    'Auto makeup matched to the body of the voice — never louder than the source’s peak',
    'Valve harmonics for musical warmth, switchable off for a clean compressor',
    'Sibilance guard keeps loud S sounds free of grit',
    'Compress and Limit modes',
    'HF Emph side-chain trim, so plosives and low thumps don’t pump the level',
    'Up to 20 ms of lookahead to catch the first syllable after a pause',
    'Mix control for parallel compression, delay-compensated',
    '4× oversampled gain cell and valve',
    'Factory presets, plus your own',
    'Real-time preview while you play — free, in your browser',
  ],

  samples: [
    {
      id: 'narration',
      title: 'Uneven narration',
      text: 'Listen to the quiet ends of sentences come up to meet the loud starts, without the voice sounding squeezed.',
      settings: {},
      setting: 'Peak Reduction 50, COMP, Auto makeup',
      brief: '20–30 s of audiobook narration, mono, read with real level swings: a few phrases pushed, a few trailing off quietly. Unprocessed, no limiter.',
    },
    {
      id: 'podcast',
      title: 'Animated podcast host',
      text: 'Laughs and emphasis stop jumping out, and the whole read sits closer to the mic.',
      settings: { peakReduction: 62 },
      setting: 'Peak Reduction 62, COMP, Auto makeup',
      brief: '20–30 s of conversational speech with laughter or excited emphasis, close-miked. Unprocessed.',
    },
    {
      id: 'parallel',
      title: 'Parallel thickening',
      text: 'Half the dry voice blended back in: the transients stay natural while the body gets denser.',
      settings: { peakReduction: 70, mix: 0.5 },
      setting: 'Peak Reduction 70, Mix 50 %',
      brief: '15–25 s of a sung or spoken vocal with clear consonants and some dynamic range. Unprocessed.',
    },
  ],

  hotspots: [
    { shot: 'peak-reduction' },
    { shot: 'meter' },
    { shot: 'gain', text: 'Makeup level into the output valve — set for you while AUTO is lit.' },
    { shot: 'auto-makeup' },
    { shot: 'harmonics' },
    { shot: 'pre-gain' },
    { shot: 'lookahead' },
    { shot: 'mode' },
    { shot: 'hf-emph' },
    { shot: 'mix' },
  ],

  specs: [
    { label: 'Type', value: 'Optical leveling amplifier' },
    { label: 'Modes', value: 'Compress (about 3:1), Limit' },
    { label: 'Controls', value: 'Peak Reduction, Gain, Mix, HF Emph, Lookahead, Pre-Gain' },
    { label: 'Processing', value: '4× oversampled gain cell and valve' },
    { label: 'Preview', value: 'Real time, while you play' },
    { label: 'Presets', value: 'Factory and your own' },
    { label: 'Works with', value: 'WAV, FLAC, MP3, AIFF, M4A — mono or stereo' },
  ],
}
