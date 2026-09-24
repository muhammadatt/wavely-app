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
      text: 'Makeup level after the compressor, and the tube stage it feeds. Hover or drag either big knob to read its value',
    },
    {
      label: 'Auto Makeup',
      text: 'Sets Gain to give back what the peaks lost, measured on the selection — turning the knob takes over from it',
    },
    {
      label: 'Comp / Limit',
      text: 'Comp levels at around 3:1, Limit holds a harder ceiling',
    },
    {
      label: 'HF Emph',
      text: 'Side-chain emphasis (the hardware\'s R37 trimmer): Flat is factory; turning it up makes the compressor ignore the low end and ride the presence band instead. It changes what the compressor listens to, not the tone',
    },
    {
      label: 'Harmonics lamp',
      text: 'The lamp beside VINTAGE 2A turns the valve and cell colour on or off. Off is clean with exactly the same compression',
    },
    {
      label: 'Mix',
      text: 'Blends the untouched signal back in for parallel compression. Auto Makeup accounts for the blend, so Gain stays right at any Mix',
    },
    {
      label: 'Pre-Gain',
      text: 'The line in the bottom-left corner: how hard the compressor is driven to suit this file\'s level, so a Peak Reduction setting does the same on a quiet file as on a hot one. Measured automatically; click it to open the control in place and set it by hand (it turns amber and reads MANUAL until you switch AUTO back on)',
    },
    {
      label: 'Lookahead',
      text: 'Folded under Pre-Gain; click it to open. Off is the hardware. A few ms lets the compressor catch the first syllable after a pause instead of letting it through',
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
    'Turn HF Emph up when plosives are pushing the compressor around, and it will follow the voice instead',
  ],
}
