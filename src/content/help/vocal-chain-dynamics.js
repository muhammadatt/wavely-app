export default {
  summary: 'Clips, compresses and glues a voice in one measured move, from a single Density control',

  whenToUse: [
    'A recording is dynamically all over the place and you want it even and forward without dialling three compressors',
    'You want the same setting to do the same job on a different recording, rather than being re-tuned per file',
    'A performance needs density and glue but you do not want the transients flattened',
  ],

  controls: [
    {
      label: 'Density',
      text: 'How hard the whole section works. It is measured into three devices rather than mapped to them, so the same position does the same job on a different file',
    },
    {
      label: 'Voicing',
      text: 'How far each device is allowed to go — NATURAL leaves most of the performance alone, AUDIOBOOK is even and controlled, PODCAST is denser and more forward',
    },
    {
      label: 'Mix',
      text: 'How much of the opto is blended back in. At 0 you get the clipper and the fast compressor only, which is a real fast-and-dry sound rather than a bypass',
    },
    {
      label: 'Output',
      text: 'A trim on the finished section',
    },
  ],

  steps: [
    'Select the passage and press SOLVE — it renders the section several times to measure it, so it is not instant',
    'Turn the section on and play to hear it, watching the three meters',
    'Move Mix freely; move Density or Voicing and solve again',
  ],

  notes: [
    'The three meters are never summed, because the three devices do different things — the clipper shaves the sharpest peaks, the fast compressor takes the impact out of syllables, the opto evens level out over seconds',
    'The clipper has a hard limit of 3 dB. Past that speech starts to distort audibly, so when Density asks for more it is Density that backs off, and the panel says so',
    'The opto evens level out by riding the body of the voice and letting the onsets through, so at high Density it hands the loudness stage more peak than it received — that trade is reported rather than hidden',
    'Density and Voicing change what is measured, so they invalidate the solve. Mix and Output do not: the blend is measured at its worst case so those two stay valid wherever they land',
    'Editing the file, or moving the selection outside the measured window, invalidates the solve — the numbers describe samples that have moved',
    'Nothing measured here is saved in a preset. A patch is a Density, a Voicing and a Mix; the thresholds and drives belong to the file',
  ],
}
