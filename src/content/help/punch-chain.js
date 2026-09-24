export default {
  summary: 'Runs the voice through the fast compressor and then the slow one, level-matched, and shows what each dial bought',

  whenToUse: [
    'The take needs both density and steadiness, and one compressor gives you one or the other',
    'You want the FET and the opto in series without setting up two panels',
    'You are aiming at a loudness target and want to see the level you are gaining',
  ],

  controls: [
    {
      label: 'DENSITY',
      text: 'How much level the file carries for the same peak — higher is denser, and the figure beside it is how far this chain moved it',
    },
    {
      label: 'LEVEL SPREAD',
      text: 'How far apart the loud lines and the quiet ones are — lower is more consistent, and the figure beside it is the change',
    },
    {
      label: 'Input',
      text: 'Drive into the fast stage, which is where density comes from — past about 50 it stops adding and starts taking away',
    },
    {
      label: 'Peak Reduction',
      text: 'How hard the slow stage rides the level — it buys consistency all the way up, and past about 40 it pays for it in density',
    },
    {
      label: 'Output',
      text: 'Level after both stages, on top of the automatic match',
    },
    {
      label: 'AUTO',
      text: 'The automatic level match measured on the selection, so both dials change character rather than loudness',
    },
  ],

  steps: [
    'Set Input first, watching DENSITY — stop where it stops rising',
    'Bring Peak Reduction up until LEVEL SPREAD is where you want it',
    'Check DENSITY again — if it has fallen further than you like, take Peak Reduction back down',
  ],

  notes: [
    'The two dials do different jobs rather than more and less of one — Input buys density, Peak Reduction buys consistency, and past a point it spends the first to buy the second',
    'Both figures are measured on the processed audio, not predicted from the settings',
    'Each stage reads the level the one before it hands over, so the second dial means the same thing wherever the first one sits',
    'DENSITY is read against the loudest thousandth of the file rather than its single loudest sample, so one plosive cannot move it',
  ],
}
