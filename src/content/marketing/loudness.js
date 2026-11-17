export default {
  eyebrow: 'Loudness normalizer',
  headline: 'Hit ACX and streaming loudness on the first try.',
  pitch: [
    'Your recording lands on the loudness the platform asks for, with its peaks held under the limit — measured the way the platform measures.',
  ],
  description: 'Normalize audio to ACX, podcast and broadcast loudness in your browser, measured the way each platform measures, with the peak ceiling held. Free.',
  overviewTitle: 'Delivery-ready loudness',
  overview: [
    'Every platform has a loudness it expects: ACX wants audiobooks between −23 and −18 dB RMS with peaks under −3 dB, podcasts sit around −16 LUFS, broadcast at −23. Land on the target and your listeners never reach for the volume; miss it and a file can be turned down, squashed or rejected.',
    'Loudness Normalize moves your recording to the target you pick and holds the peak ceiling, measuring the way the platform does — unweighted RMS for ACX, K-weighted LUFS for streaming and broadcast. Every number it shows after Apply is read from the result, so what you see is what the platform will find.',
  ],
  features: [
    { title: 'On target first time', text: 'the loudness the platform asks for, without guesswork' },
    { title: 'ACX measured like ACX', text: 'unweighted RMS against the sample peak' },
    { title: 'Streaming and broadcast', text: 'K-weighted LUFS against true peak' },
    { title: 'Peaks held', text: 'the ceiling the spec allows is never crossed' },
    { title: 'Limit or Safe', text: 'reach the target with a limiter, or one clean gain change' },
    { title: 'Measured, not predicted', text: 'every figure after Apply is read from the result' },
    { title: 'Built-in targets', text: 'spoken word, podcast, music and video benchmarks' },
    { title: 'Consistent episodes', text: 'every recording on the same loudness' },
    { title: 'Selection or whole file', text: 'match one passage or the entire recording' },
    { title: 'Free in your browser', text: 'no plugin to buy, no DAW, nothing to install' },
  ],
  samples: [
    {
      id: 'audiobook',
      title: 'Narration to ACX',
      text: 'A quiet narration brought up into the ACX range with its peaks held under −3 dB.',
      settings: { target: 'acx' },
      setting: 'ACX audiobook (-20 dB RMS, peaks under -3 dB)',
      brief: '20–30 s of untreated narration recorded on the quiet side (around −28 dB RMS).',
    },
  ],
  hotspots: [
    { shot: 'measurement' },
    { shot: 'benchmarks' },
    { shot: 'target' },
    { shot: 'ceiling' },
    { shot: 'peak' },
  ],
  specs: [
    { label: 'Targets', value: 'ACX, podcast, streaming, broadcast and more' },
    { label: 'Measurement', value: 'BS.1770 LUFS / true peak, or ACX RMS / sample peak' },
    { label: 'Peak handling', value: 'Limit or Safe' },
    { label: 'Works with', value: 'WAV, FLAC, MP3, AIFF, M4A — mono or stereo' },
  ],
}
