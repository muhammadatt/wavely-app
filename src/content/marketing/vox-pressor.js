export default {
  feature: 'voxPressor',
  eyebrow: 'Vocal dynamics chain',
  headline: 'A finished vocal chain in one window.',
  pitch: [
    'VoxPressor is the classic 1176-into-LA-2A vocal chain, with a de-esser and parallel density built in. The FET stage trims the loudest peaks, the opto stage levels the body of the voice, and every stage measures what it did to your file and shows you.',
    'It is built for narration, podcasts and dialogue: dial in four knobs, pick your delivery level, and the voice is dense, even and ready for mastering.',
  ],
  description: 'A 1176-into-LA-2A vocal chain with de-essing and parallel density, in one window in your browser. Measured readouts guide every knob.',

  highlights: [
    {
      title: 'Two classic compressors, already staged',
      text: 'A fast FET stage catches the peaks so the slow opto stage can level the phrases — the order engineers wire by hand. Each stage makes up its own level and holds the source’s peak, so they never fight.',
    },
    {
      title: 'Knobs that tell you when to stop',
      text: 'The Peak reduction and Body leveler rings are measured on your selection: green while the voice is untouched, amber when a stage starts to lean on it, red when it is squashing. The meter readout shows exactly how many dB each stage took.',
    },
    {
      title: 'De-essing where it belongs',
      text: 'Compression brings sibilance up, so the de-esser sits after both compressors and listens to what they deliver. Its lisp guard never pushes an S below the voice around it.',
    },
    {
      title: 'Density without the harshness',
      text: 'A parallel LA-2A or 1176 copy fills in the quiet parts under the voice, with its own de-esser so the blend never brings the sibilance back.',
    },
    {
      title: 'Lands on your delivery spec',
      text: 'Output level holds the peak at the source’s, at −1 dB for podcasts and streaming, or at −3 dB for ACX.',
    },
  ],

  samples: [
    {
      id: 'narration',
      title: 'Raw narration',
      text: 'Peaks trimmed, phrases levelled and the S sounds kept in check — the factory settings, untouched.',
      settings: {},
      setting: 'Factory default',
      brief: '20–30 s of untreated narration, mono, with some loud syllables and quiet trailing phrases and a few clear S sounds.',
    },
    {
      id: 'podcast',
      title: 'Podcast, broadcast density',
      text: 'A fuller, closer voice: the 1176 parallel copy pulled up for more presence.',
      settings: { parallel: 50, parallelComp: '1176', ceiling: '-1' },
      setting: 'Density Mix 50 %, 1176, Output −1 dB',
      brief: '20–30 s of conversational podcast speech, close-miked, untreated, with some energy changes.',
    },
    {
      id: 'audiobook',
      title: 'Audiobook, ready for ACX',
      text: 'Gentle, transparent leveling that lands the peak at −3 dB.',
      settings: { peaks: 2, body: 4, ceiling: '-3' },
      setting: 'Peak reduction 20, Body leveler 40, Output −3 dB',
      brief: '20–30 s of an audiobook read, mono, recorded with ACX-style headroom (peaks around −6 dBFS), untreated.',
    },
  ],

  hotspots: [
    { shot: 'peak-reduction', text: 'How hard the 1176 stage catches the loudest peaks — its ring turns amber before it touches the voice.' },
    { shot: 'attack-release' },
    { shot: 'knee' },
    { shot: 'meter' },
    { shot: 'meter-select' },
    { shot: 'readout' },
    { shot: 'body-leveler', text: 'How hard the LA-2A stage levels the voice, with its own amber and red guide.' },
    { shot: 'enhance-detail' },
    { shot: 'de-ess-amount' },
    { shot: 'de-ess-band' },
    { shot: 'density-drive' },
    { shot: 'density-mix' },
    { shot: 'density-comp' },
    { shot: 'output-level' },
    { shot: 'io-meters' },
  ],

  specs: [
    { label: 'Stages', value: '1176 peaks → LA-2A body → de-esser → parallel density → enhance' },
    { label: 'Peaks', value: 'Soft knee 4:1 or hard knee 12:1, release from the voice’s pitch' },
    { label: 'Output level', value: 'Source peak, −1 dB or −3 dB' },
    { label: 'Readouts', value: 'Measured dB per stage, on your selection' },
    { label: 'Preview', value: 'Real time, free for everyone' },
    { label: 'Apply', value: 'Pro plan' },
    { label: 'Works with', value: 'WAV, FLAC, MP3, AIFF, M4A — mono or stereo' },
  ],

  related: ['opto-smooth'],
}
