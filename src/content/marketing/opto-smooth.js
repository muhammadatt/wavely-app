export default {
  eyebrow: 'Opto leveling amplifier',
  headline: 'Smooth, phrase-level leveling with real tube warmth.',
  pitch: [
    'Transparent leveling for vocals and spoken word, with the valve colour the original is loved for. It runs in your browser — nothing to install.',
  ],
  description: 'An LA-2A style opto compressor that runs in your browser: smooth phrase-level leveling, tube harmonics and auto makeup that never clips. Free to use.',

  overview: [
    'Modelled on the Teletronix LA-2A — a studio favourite on vocals, bass and guitar for over half a century. Its optical cell reacts gently and lets go slowly, so it rides whole phrases rather than syllables: the performance comes out even, not squeezed.',
    'Behind the simple two-knob face sits what a file-based workflow needs. It measures your recording first, so a setting behaves the same on a quiet take as a hot one. Makeup gain follows the body of the voice and never passes the source’s peak. The valve colour is fitted to measured harmonic data, with a guard that keeps loud S sounds clean.',
  ],

  features: [
    { title: 'Classic opto character', text: 'modelled on the electro-optical tube leveling amplifier' },
    { title: 'Rides phrases, not syllables', text: 'smooth, program-dependent leveling' },
    { title: 'Natural under heavy reduction', text: 'stays transparent even when it’s working hard' },
    { title: 'Input alignment', text: 'Peak Reduction does the same job at any recording level' },
    { title: 'Auto makeup', text: 'matched to the body of the voice, never past the source’s peak' },
    { title: 'Valve harmonics', text: 'musical warmth, or switch off for a clean compressor' },
    { title: 'Sibilance guard', text: 'loud S sounds stay free of grit' },
    { title: 'Compress and Limit', text: 'two modes, about 3:1 or full limiting' },
    { title: 'HF Emph', text: 'side-chain trim so plosives and low thumps don’t pump the level' },
    { title: 'Lookahead', text: 'up to 20 ms to catch the first syllable after a pause' },
    { title: 'Mix', text: 'parallel compression, delay-compensated' },
    { title: '4× oversampling', text: 'on both the gain cell and the valve' },
    { title: 'Presets', text: 'factory presets, plus your own' },
    { title: 'Real-time preview', text: 'free while you play, right in your browser' },
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
