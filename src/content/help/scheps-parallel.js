export default {
  summary: 'Blends a squashed, EQ-steered copy of the voice under the original for density without a jump in level.',

  intro: [
    'Scheps Parallel recreates a well-known mix engineer\'s parallel vocal chain: a Pultec-style EQ pushes the voice into an LA-2A-style compressor, a second EQ shapes the squashed copy, and that copy is blended under the untouched original.',
    'The result is weight and density without a jump in level, a voice that stays rich even at quiet playback. Use it when a take is clean but thin, or when compression alone made it steadier but not fuller.',
  ],

  quickStart: [
    'Select the passage and turn the plugin ON — it opens engaged with AUTO TRIM lit.',
    'Pick a Character: THICK for weight, PRESENCE for clarity.',
    'Play, and leave Squash where it opens unless the reduction bar barely moves or pins.',
    'Raise Mix until the voice thickens, then back off until you stop noticing it.',
    'Compare against bypass, then Apply to selection.',
  ],

  controls: [
    {
      label: 'IN',
      shot: 'input-meter',
      text: 'Shows the level going into the plugin.',
    },
    {
      label: 'GAIN REDUCTION',
      shot: 'reduction',
      text: 'Shows how much the compressor is turning the parallel copy down, in dB.',
      details: [
        'The large figure is the reading now, AVG is the average over the last second of audio, and the thin marker holds the deepest recent peak.',
        'It reads the squashed copy only, not the output — the blend passes on just a share of it, so the voice you hear moves far less than this bar.',
      ],
    },
    {
      label: 'Response curve',
      shot: 'curve',
      text: 'Draws the EQ around the compressor for the chosen Character.',
      details: [
        'Into compressor (dashed) is the EQ ahead of the compressor: it pushes the lows out of the way and lifts the upper mids, so the compressor rides the voice instead of the plosives.',
        'Recovery (dotted) is the EQ after it, which puts the low end back. Net (solid, filled) is the two together — the tone the parallel copy actually carries.',
        'The two stages are not opposites, and what is left over is the character.',
      ],
    },
    {
      label: 'Character',
      shot: 'character',
      text: 'Chooses the EQ curves on the parallel copy.',
      details: [
        'THICK is bass-forward: the low end comes back louder than it left, adding weight and body.',
        'PRESENCE is top-forward: a 4 to 10 kHz lift with the top octave scooped, for clarity and forward mids.',
        'The caption under the switch names what the chosen curve does.',
      ],
      range: 'THICK, PRESENCE',
      default: 'THICK',
    },
    {
      label: 'Squash',
      shot: 'squash',
      text: 'Sets how hard the opto compressor rides the parallel copy.',
      details: [
        'It is the Peak Reduction of an LA Vintage 2A on the copy. The compressor hears the voice through the bright pre-EQ, so it reacts far more than the same number would on the LA Vintage 2A by itself — 40 lands around 7.6 dB of peak reduction on speech at normal level.',
        'The whole file’s level is measured first, so a setting does the same job on a quiet recording as on a hot one.',
        'Double-click to reset, or click the value to type one.',
      ],
      range: '0 to 100 in steps of 1',
      default: '40',
    },
    {
      label: 'Mix',
      shot: 'mix',
      text: 'Sets how much of the squashed copy sits under the original.',
      details: [
        'At 0 the output is the original, sample for sample. The dry path is delayed to match the compressor, so the blend never combs.',
        'The blend is corrected for how closely the two paths track each other, so the middle of the sweep does not bulge. With AUTO TRIM lit, raising Mix adds density and only a little loudness.',
      ],
      range: '0 to 100 % in steps of 1',
      default: '35 %',
    },
    {
      label: 'AUTO TRIM',
      shot: 'auto-trim',
      text: 'Level-matches the squashed copy to the original, so Mix is a character control rather than a volume control.',
      details: [
        'It measures the selection in the speech band and sets the copy’s makeup gain so its loud parts land where the original’s are. The line under the lamp shows that gain, or measuring… while it works.',
        'A ceiling at the selection’s own peak keeps the output from going louder than the source.',
        'Off, the copy runs at whatever level the compressor leaves it and the blend is a plain equal-power crossfade. The line then reads wet path unmatched.',
      ],
      range: 'On, Off',
      default: 'On',
    },
    {
      label: 'OUT',
      shot: 'output-meter',
      text: 'Shows the level leaving the plugin.',
    },
    {
      label: 'Output',
      shot: 'output',
      text: 'A level trim on the whole plugin, after the blend.',
      details: [
        'Double-click to reset.',
      ],
      range: '−12 to +12 dB in 0.1 dB steps',
      default: '0.0 dB',
    },
  ],

  notes: [
    'Presets save Character, Squash, Mix and Output. The trim is measured for each file.',
    'For a parallel stage alongside peak control and de-essing in one window, use VoxPressor.',
  ],
}
