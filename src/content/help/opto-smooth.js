export default {
  summary: 'Levels a performance the way an opto compressor does — slowly, across phrases rather than syllables',

  whenToUse: [
    'A narrator drifts closer to and further from the mic across a take',
    'You want the quiet passages to sit up without the loud ones jumping',
    'You want compression that is hard to hear working',
  ],

  controls: [
    {
      label: 'Peak Reduction',
      text: 'How hard the cell is driven, which is how much compression you get',
    },
    {
      label: 'Gain',
      text: 'Makeup level after the compressor, and the tube stage it feeds',
    },
    {
      label: 'AUTO',
      text: 'Sets Gain to give back what the peaks lost, measured on the selection — turning the knob takes over from it',
    },
    {
      label: 'COMP / LIMIT',
      text: 'COMP levels at around 3:1, LIMIT holds a harder ceiling',
    },
    {
      label: 'Tube Drive',
      text: 'How much of the output stage colour you get',
    },
    {
      label: 'R37',
      text: 'Side-chain emphasis, as a knob rotation: 100 is factory flat, winding down makes the compressor ignore the low end and ride the presence band instead',
    },
  ],

  steps: [
    'Play the selection and raise Peak Reduction until the gain reduction meter moves on the loud phrases',
    'Leave AUTO on unless you are matching levels by hand',
    'Compare against bypass — this effect is doing its job when you notice the level is steadier rather than hearing the compression',
  ],

  notes: [
    'It levels phrases, not syllables — a 10 ms attack into a release measured in seconds cannot follow a fast envelope, and that is the character rather than a limitation',
    'Peak-referenced makeup means the output can never come out hotter than the source at any setting',
    'On fast material this can leave the average quieter while making it steadier — reach for FET Punch when you want it louder',
    'Wind R37 down when plosives are pushing the compressor around, and it will follow the voice instead',
  ],
}
