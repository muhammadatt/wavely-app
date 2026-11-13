export default {
  summary: 'Scales the selection so its loudest peak lands where you set it',

  intro: [
    'Peak Normalize turns the selection up or down so its single loudest sample lands exactly at the level you set. It is one clean gain change, so the dynamics, tone and balance of the recording are untouched',
    'Use it to bring a quiet passage up to match the rest, to set a predictable peak level before compressing or clipping, or simply to get more level from a quiet recording without processing it',
  ],

  quickStart: [
    'Select the passage you want to change',
    'Turn Target Peak to where the loudest sample should land, or click the value and type it',
    'Apply',
  ],

  controls: [
    {
      label: 'Target Peak',
      shot: 'target-peak',
      text: 'Where the loudest sample in the selection ends up, in dBFS',
      details: [
        'The plugin finds the highest sample peak across every channel of the selection and applies the one gain that puts it on this value, so a stereo file keeps its balance',
        'The line under the knob repeats the setting. Click the value to type one, or double-click the knob to reset it',
      ],
      range: '−12 to 0 dBFS in 0.5 dB steps',
      default: '−1.0 dBFS',
    },
  ],

  notes: [
    'This is one gain applied to every sample, so nothing about the balance of the selection changes — only how loud all of it is',
    'It measures sample peaks, not true peaks. For a delivery spec stated in dBTP or LUFS, use Loudness Normalize',
    'It cannot make a quiet passage sound closer to a loud one, because the gap between them moves with everything else — reach for LA Vintage 2A for that',
    'There is no preview: the result is heard after Apply, and Undo takes it back',
    'Mastering re-normalizes the whole file at the end, so a spot normalize is for evening out an edit rather than for hitting a delivery target',
  ],
}
