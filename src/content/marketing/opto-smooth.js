export default {
  eyebrow: 'Opto leveling amplifier',
  headline: 'Smooth, phrase-level leveling with real tube warmth.',
  pitch: [
    'LA Vintage 2A is modelled on the Teletronix LA-2A, the optical leveling amplifier engineers have trusted on vocals for six decades. It rides whole phrases rather than syllables, so a performance comes out even without sounding compressed.',
    'It runs in your browser, on the file you are editing — no download, no install, no plugin host.',
  ],
  description: 'An LA-2A style opto compressor that runs in your browser: smooth phrase-level leveling, tube harmonics and auto makeup that never clips. Free to use.',

  highlights: [
    {
      title: 'The same knob, any recording level',
      text: 'The hardware has no threshold, so Peak Reduction 50 does almost nothing to a quietly recorded file. LA Vintage 2A measures your file first and aligns its side-chain, so a setting does the same job on a whisper-quiet take as on a hot one — and a preset travels between files.',
    },
    {
      title: 'Makeup that never runs backwards',
      text: 'Auto makeup matches the body of the voice, not one stray peak, so turning Peak Reduction up always makes it denser, never quieter. A ceiling at the source’s own peak means the result is never louder than what went in.',
    },
    {
      title: 'Harmonics fitted from measurement',
      text: 'The valve colour is a second-harmonic-led curve fitted to measured harmonic data, chosen by ear over three alternatives. A sibilance guard eases it off on loud S sounds, so the warmth never turns to grit.',
    },
    {
      title: 'What the original could not do',
      text: 'Up to 20 ms of lookahead catches the first syllable after a pause. The R37 HF emphasis trim stops plosives driving the cell. And a delay-compensated Mix knob gives you parallel compression without a second track.',
    },
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

  related: ['vox-pressor'],
}
