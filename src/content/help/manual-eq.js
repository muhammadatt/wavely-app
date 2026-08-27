export default {
  summary: 'Shapes tone by hand, with up to twelve bands and a live analyzer behind them',

  whenToUse: [
    'You know which frequency is wrong and want to fix exactly that',
    'VoiceRx found something and you want to shape its correction further',
    'You want a tonal change that is the same everywhere, rather than one that follows the audio',
  ],

  controls: [
    { label: 'Gain', text: 'How much the band lifts or cuts, per strip' },
    { label: 'Shape', text: 'What kind of filter the band is — cuts and shelves are offered only on the lowest and highest bands' },
    { label: 'Frequency', text: 'Where the band sits' },
    { label: 'Width', text: 'How much of the spectrum either side comes with it' },
    { label: 'RESET', text: 'Returns every band to the neutral opening layout' },
  ],

  steps: [
    'Play the selection so you can hear the band while you move it',
    'Sweep Frequency with a large boost to find the offending spot, then invert the gain to cut it',
    'Narrow Width for a resonance, widen it for a tonal tilt',
  ],

  notes: [
    'This runs after VoiceRx in the chain — corrective first, creative second',
    'VoiceRx can move its own corrections here, where they become ordinary bands you can edit; they are moved rather than copied, so nothing is applied twice',
    'A fixed cut is the right answer for a constant resonance — reach for Reso Smooth when the resonance comes and goes',
  ],
}
