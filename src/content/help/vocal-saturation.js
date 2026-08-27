export default {
  summary: 'Adds tube-style warmth, with each frequency band driven separately',

  whenToUse: [
    'A digital recording sounds correct but sterile',
    'You want harmonic weight rather than more level',
    'You want to warm the low end without softening the consonants',
  ],

  controls: [
    { label: 'Drive', text: 'How hard the signal is pushed into the curve' },
    { label: 'Bias', text: 'Shifts the curve off centre, which brings in even harmonics — the warm half of tube colour' },
    { label: 'Softness', text: 'How gradually the curve bends, from a rounded knee to a harder one' },
    { label: 'Wet / Dry', text: 'How much of the saturated signal is blended against the original' },
    { label: 'HF Loss', text: 'Rolls the top end off the finished output, the way a tape machine does when pushed' },
    { label: 'Low Crossover', text: 'Where the low band ends' },
    { label: 'Mid Crossover', text: 'Where the mid band ends and the high band starts' },
    { label: 'Low Drive', text: 'Extra drive into the low band only' },
    { label: 'Mid Drive', text: 'Extra drive into the mid band only' },
    { label: 'High Drive', text: 'Extra drive into the high band only' },
  ],

  steps: [
    'Raise Drive until you hear the tone thicken, then halve it',
    'Add Bias if you want warmth rather than edge',
    'Pull Low Drive up and High Drive down to weight the bottom without hardening sibilance',
    'Set Wet / Dry last, and compare against bypass at matched level',
  ],

  notes: [
    'HF Loss acts on the finished output rather than only the wet path, so with it raised Wet / Dry at 0 no longer bypasses the plugin',
    'Saturation is not level-invariant: a quieter selection is driven less at the same Drive setting',
  ],
}
