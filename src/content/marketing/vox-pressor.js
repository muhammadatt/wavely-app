export default {
  feature: 'voxPressor',
  eyebrow: 'Vocal dynamics chain',
  headline: 'A finished vocal chain in one window.',
  pitch: [
    'Dense, even, ready-to-master vocals from a handful of knobs, with readouts that tell you when to stop — right in your browser.',
  ],
  description: 'A 1176-into-LA-2A vocal chain with de-essing and parallel density, in one window in your browser. Measured readouts guide every knob.',

  overview: [
    'The vocal chain engineers wire by hand, already staged: a fast FET stage modelled on the 1176 trims the loudest peaks, an optical stage modelled on the LA-2A levels the body of the voice, a de-esser cleans up what the compressors bring up, and a parallel copy fills in density underneath.',
    'Built for narration, podcasts and dialogue. Every stage measures what it did to your selection and shows it under the meter, and the knobs’ guide colours turn amber before a stage starts to squash the voice — a finished, dense vocal without guessing, ready for mastering or delivery.',
  ],

  features: [
    { title: 'Soft or hard knee', text: '4:1 for gentle peak control, 12:1 to hold them firmly' },
    { title: 'Pitch-timed release', text: 'set from your voice’s own pitch, so low voices don’t ripple' },
    { title: 'Opto body leveler', text: '10 ms of lookahead and a voice-tuned side-chain' },
    { title: 'Guide colours', text: 'green, then amber and red as a stage starts to touch the voice' },
    { title: 'Measured readouts', text: 'dB off the peaks, cost to the voice, average leveling' },
    { title: 'De-esser after the compressors', text: 'with a lisp guard and a wide / split-band control' },
    { title: 'Parallel density', text: 'an LA-2A or 1176 copy, with its own de-esser' },
    { title: 'Enhance Detail', text: 'presence without raising the peak' },
    { title: 'Automatic makeup', text: 'at every stage, each one holding the source’s peak' },
    { title: 'Delivery output level', text: 'source peak, −1 dB for streaming or −3 dB for ACX' },
    { title: 'Input alignment', text: 'the same settings work on quiet and hot recordings' },
    { title: 'Real-time preview', text: 'free in your browser; Apply with Pro' },
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
}
