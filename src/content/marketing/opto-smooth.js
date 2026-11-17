export default {
  eyebrow: 'Opto leveling amplifier',
  headline: 'The silky, warm vocal sound of a studio legend.',
  pitch: [
    'Smooth, musical leveling that pulls a voice forward and wraps it in tube warmth. Two knobs, and it’s hard to make it sound bad — right in your browser.',
  ],
  description: 'The smooth, warm sound of a classic opto compressor, in your browser. Pull a voice forward and level it without squashing it. Free to use.',

  overviewTitle: 'The sound of countless great vocals',
  overview: [
    'For more than half a century, engineers have reached for the LA-2A when a voice has to sound finished: smooth, forward and warm, with every word sitting right where it should. Its optical cell reacts more like an ear than a meter — it eases into loud phrases and lets go slowly — so a performance comes out even without losing its life.',
    'LA Vintage 2A brings that character to your browser: the creamy opto compression, the tube harmonics that thicken a voice, and the famous simplicity — turn up Peak Reduction until it sounds right. It takes care of the fiddly parts, so a setting you like works on a quiet take and a hot one, and the result never gets louder than your original peak.',
  ],

  features: [
    { title: 'Silky opto leveling', text: 'rides whole phrases, so the voice stays even and natural' },
    { title: 'Voice up front', text: 'pulls a vocal forward and keeps every word audible' },
    { title: 'Tube warmth', text: 'valve harmonics that thicken and round out a voice' },
    { title: 'Smooth, never squashed', text: 'a slow, program-dependent release keeps the performance breathing' },
    { title: 'Parallel thickening', text: 'blend the dry voice back in for density with natural attacks' },
    { title: 'Beyond vocals', text: 'the same smooth control on bass, guitar and narration' },
    { title: 'Limit mode', text: 'firmer control for peaky, dynamic performances' },
    { title: 'Clean when you need it', text: 'switch the harmonics off for transparent leveling' },
    { title: 'Two-knob simplicity', text: 'turn up Peak Reduction until it sounds right' },
    { title: 'Same sound, any level', text: 'a setting you like works on quiet and hot recordings alike' },
    { title: 'Never clips', text: 'automatic makeup that never passes your original peak' },
    { title: 'Free in your browser', text: 'no plugin to buy, no DAW, nothing to install' },
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
