export default {
  eyebrow: 'Opto leveling amplifier',
  headline: 'The silky, warm sound of a studio legend.',
  pitch: [
    'Modeled after the world\'s most famous opto-compressor, the LA Vintage 2A adds analog warmth and richness to vocals, synths, guitars and full mixes.',
  ],
  description: 'The smooth, warm sound of a classic opto compressor, in your browser. Pull a voice forward and level it without squashing it. Free to use.',

  overviewTitle: 'The sound of countless great vocals',
  overview: [
    'For over 50 years, studio mix engineers have reached for the LA-2A compressor to give vocals warmth, fullness and polish. Its optical cell eases into loud phrases and releases slowly — adding warmth and fullness while remaining remarkably transparent.',
    'LA Vintage 2A was painstakingly modeled to re-create the classic creamy opto-compression and rich tube harmonics of the original hardware - right in your browser.',
  ],

  features: [
    { title: 'Silky opto leveling', text: 'rides whole phrases, so the voice stays even and natural' },
    { title: 'Vocal glue', text: 'pulls a vocal forward, adding presence and clarity' },
    { title: 'Tube warmth', text: 'valve harmonics provide thickness and warmth' },
    { title: 'Multi-stage, program-dependent release', text: 'for smoothest, most natural transparent compression' },
    { title: 'Parallel mode', text: 'blend the dry voice back in for density with natural range' },
    { title: 'Beyond vocals', text: 'the same smooth control on bass, guitar and narration' },
    { title: 'Two-knob simplicity', text: 'turn on auto gain and turn up Peak Reduction until desired effect is reached' },
    { title: 'Free, in your browser', text: 'no plugin to buy, no DAW, nothing to install' },
  ],

  samples: [
    {
      id: 'narration',
      title: 'Uneven narration',
      text: 'Quiet sentence endings come up to meet the loud starts and the voice moves forward — even and warm, and still natural.',
      settings: {},
      setting: 'Peak Reduction 50, COMP, Auto makeup',
      brief: '20–30 s of audiobook narration, mono, read with real level swings: a few phrases pushed, a few trailing off quietly. Unprocessed, no limiter.',
    },
    {
      id: 'podcast',
      title: 'Animated podcast host',
      text: 'Laughs and emphasis stop jumping out, and the host sounds closer and more present, like a produced show.',
      settings: { peakReduction: 62 },
      setting: 'Peak Reduction 62, COMP, Auto makeup',
      brief: '20–30 s of conversational speech with laughter or excited emphasis, close-miked. Unprocessed.',
    },
    {
      id: 'parallel',
      title: 'Parallel thickening',
      text: 'Half the dry voice blended back in: natural attacks with a thicker, denser body underneath.',
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
