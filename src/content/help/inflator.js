export default {
  summary: 'Raises quiet detail while leaving the peaks exactly where they are',

  whenToUse: [
    'A recording is technically fine but sounds thin or far away',
    'You want density without a compressor pumping on the syllables',
    'You want more apparent level but the peaks are already where you need them',
  ],

  controls: [
    { label: 'Input', text: 'How hard the signal is driven into the curve — the effect is not level-invariant, so this sets how much lift the material gets' },
    { label: 'Curve', text: 'The shape of the lift. It cannot move the ceiling: full scale comes out at full scale at every setting' },
    { label: 'Effect', text: 'How much of the shaped signal is blended against the original. At 0 the plugin is the dry signal exactly' },
    { label: 'Output', text: 'Takes back the level the curve added. It only cuts' },
    { label: 'Band Split', text: 'Runs the curve on three bands (below 240 Hz, 240 Hz to 2.4 kHz, above) instead of the whole signal' },
    { label: 'Clip', text: 'Holds peaks at full scale. With it off, anything past full scale folds back toward silence' },
  ],

  steps: [
    'Leave Curve at 0 and raise Effect until the recording sounds closer',
    'Use Input to decide how much of the file is being lifted rather than turning Effect up further',
    'Move Curve for character — up for more lift on quiet detail, down for less',
    'Pull Output down to match bypass before judging it, or the louder one always wins',
  ],

  notes: [
    'It is not a peak controller. The curve cannot reduce a peak, and with Clip off, material above full scale folds back rather than limiting — reach for the Soft Clipper for peak control, after this',
    'Band Split can exceed full scale even though the curve cannot: three bands each bounded at full scale still sum to more than one. Turn Clip on when using it',
    'Curve changes shape and never the ceiling, so it is safe to explore — it is the one knob here that cannot make the file louder at the top',
  ],
}
