export default {
  summary: 'Blends a squashed, EQ-steered copy of the voice under the original',

  whenToUse: [
    'The take is clean but thin, and you want weight without a level change',
    'You want density that survives quiet playback',
    'Compression alone made it steadier but not richer',
  ],

  controls: [
    {
      label: 'THICK / PRESENCE',
      text: 'THICK adds weight and body, PRESENCE lifts 4 to 10 kHz and scoops the top octave',
    },
    {
      label: 'Squash',
      text: 'How hard the parallel copy is compressed',
    },
    {
      label: 'Mix',
      text: 'How much of that copy is blended in — at 0 the output is the dry signal, sample for sample',
    },
    {
      label: 'Output',
      text: 'Level after the blend',
    },
    {
      label: 'TRIM',
      text: 'The automatic level match measured on the selection, so pushing Mix changes character rather than loudness',
    },
  ],

  steps: [
    'Pick a character and leave Squash where it opens',
    'Raise Mix until the voice thickens, then back off until you stop noticing it',
    'Compare against bypass — the trim means both should be about equally loud',
  ],

  notes: [
    'The blend is level-matched on the speech band, so Mix is a character control rather than a volume control',
    'The two Pultec stages are not inverses of each other — that is what leaves the character behind after the compression is undone',
    'Squash sits above a middle position by default because the side-chain arrives filtered, so it sees far less than the raw signal',
  ],
}
