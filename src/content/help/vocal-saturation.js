export default {
  summary: 'Adds tube-style warmth, with each frequency band driven separately',

  whenToUse: [
    'A digital recording sounds correct but sterile',
    'You want harmonic weight rather than more level',
    'You want to warm the low end without softening the consonants',
  ],

  controls: [
    { label: 'Drive', text: 'How hard the signal is pushed into the curve' },
    { label: 'Topology', text: 'PARA adds a saturated copy underneath the original, which keeps every transient intact and thickens what is around it. SERIES puts the curve in the path, so it can absorb and round transients instead' },
    { label: 'Emphasis', text: 'Makes the curve act hardest on high frequencies, which takes the edge off attacks while leaving the body thick. This is the control that turns a crisp saturator into a soft one' },
    { label: 'Asymmetry', text: 'Runs the curve off centre, which is the only thing here that makes even harmonics — the warm half of tube colour. Which way it leans is measured from your recording' },
    { label: 'Hardness', text: 'How abruptly the curve bends. Low is dense and buzzy, high is spiky and close to a clipper. It changes the kind of distortion, not the amount' },
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
    'Add Asymmetry if you want warmth rather than edge',
    'Pull Low Drive up and High Drive down to weight the bottom without hardening sibilance',
    'If you want it softer rather than crisper, switch to SERIES and raise Emphasis',
    'Set Wet / Dry last, and compare against bypass at matched level',
  ],

  notes: [
    'HF Loss acts on the finished output rather than only the wet path, so with it raised Wet / Dry at 0 no longer bypasses the plugin',
    'Saturation is not level-invariant: a quieter selection is driven less at the same Drive setting',
    'Hardness does not go below 2, because the soft end of this curve family aliases more than the hard end, not less',
    'In PARA the dry signal always passes at full level, so no setting of Wet / Dry will soften a transient. Use SERIES for that',
    'Asymmetry and transient softening pull against each other: an off-centre curve clips one half of the waveform before the other, which makes peaks stand out more. Keep Asymmetry low if you are after the soft, absorbing sound',
    'Hardness has most to say at lower Drive settings. Once Drive is high enough to square the waveform off there is no knee left for it to shape, and it stops making much difference',
  ],
}
