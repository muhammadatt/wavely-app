export default {
  summary: 'Measures a voice recording and corrects the tonal problems it finds with a few gentle EQ bands',

  whenToUse: [
    'A recording sounds wrong and you cannot name which frequency is at fault',
    'You want a starting point before shaping tone by hand',
    'You are checking a take for problems before mastering it',
  ],

  quickStart: [
    'Select a stretch that is representative of the whole take, at least a few phrases long',
    'Press ANALYZE — every correction it recommends is switched on at once, so the first thing you hear is the corrected voice',
    'Read ISSUES IDENTIFIED, and use S to hear a correction alone or ON / OFF to drop one you disagree with',
    'Trim any correction with its Gain knob, then compare against bypass',
    'Apply to selection, or press TRANSFER TO EQ → to keep shaping the bands in the EQ',
  ],

  controls: [
    {
      label: 'ANALYZE',
      shot: 'analyze',
      text: 'Measures the selection and switches on every correction it recommends',
      details: [
        'The window opens on this alone. It reads the average tone of the voiced parts of the selection and compares each region of the spectrum with its own neighbourhood, so a resonance is something that stands out from the voice around it rather than a departure from a stored reference curve',
        'It also places the voice as lower or higher pitched, which shifts where each region sits',
        'A very short selection is read a little wider into the surrounding audio. The correction is still applied only to what you selected',
        'Skip — go straight to the controls opens the plot without measuring, with a smaller ANALYZE strip under it',
      ],
    },
    {
      label: 'ISSUES IDENTIFIED',
      text: 'Lists each problem the analysis found, in words, with the correction recommended for it',
      details: [
        'Each row names the symptom, the region and the recommended gain, which stays fixed while the analysis stands. If you have changed that region, a note shows what is in force now — off, not set or the current gain',
        'Pointing at a row lights its region on the plot',
        'Only a deviation of 3 dB or more is reported, and a recommendation never boosts more than 4 dB or cuts more than 5 dB',
      ],
    },
    {
      label: 'APPLY / RESTORE',
      text: 'Puts one row’s recommended correction back in force',
      details: [
        'APPLY adds a correction that is not set, RESTORE overrides one you have changed or switched off, and APPLIED means it is already at the recommended value',
      ],
    },
    {
      label: 'RE-ANALYZE',
      text: 'Measures the current selection again and replaces the corrections with the new findings',
      details: [
        'If you move the selection after analysing, a line above the plot says the findings are from the earlier measurement. Its corrections keep running until you re-analyse',
      ],
    },
    {
      label: 'CLEAR',
      text: 'Removes every correction, leaving the findings in place so you can apply them again',
    },
    {
      label: 'APPLY ALL',
      text: 'Puts every recommended correction in force at once',
      details: [
        'It dims when every correction is already at its recommended value',
      ],
    },
    {
      label: 'ALSO FOUND — NOT CORRECTED',
      text: 'Reports what the analysis noticed but will not fix with EQ, such as a deep notch in the spectrum',
      details: [
        'A notch can hide the regions around it from the measurement, so when one is reported the rest of the findings may be incomplete',
      ],
    },
    {
      label: 'IN',
      shot: 'input-meter',
      text: 'Shows the level going into the plugin',
    },
    {
      label: 'Plot',
      text: 'Draws your voice’s measured tone, the areas to fix and the curve of your changes',
      details: [
        'Press an empty spot to place the nearest region’s band there and drag it. Drag a dot to move its frequency and gain, scroll over it to change its width, and double-click it to remove it',
        'The line under the plot describes what your changes are doing, or what the control under the pointer means',
        'Drag the window’s corner to make the plot taller',
      ],
    },
    {
      label: 'Rumble, Body, Mud, Boxy, Nasal, Clarity, Presence, Sibilance, Air',
      text: 'One column of controls per region of the voice, under its name on the plot’s axis, from low to high',
      details: [
        'Rumble is the weight under the voice — traffic, air conditioning, desk knocks. Body is the chest. Mud is crowding just above the fundamental. Boxy is a hollow, carton-like ring. Nasal is a pinched, blocked-nose quality. Clarity is how cleanly words separate. Presence is how far forward the voice sits, harsh when pushed. Sibilance is the edge on S and T. Air is openness at the very top',
        'Rumble and Air are shelves, the rest are bells. Where each region sits depends on the voice the analysis measured',
        'Double-click a column to reset its region',
      ],
    },
    {
      label: 'S',
      text: 'Solos one region’s correction so you hear what it is doing on its own',
    },
    {
      label: 'ON / OFF',
      text: 'Switches one region’s correction off and back on without losing its settings',
      details: [
        'It is unavailable while the region has no correction or sits at 0 dB — turn its Gain knob to start one',
      ],
      range: 'ON, OFF',
    },
    {
      label: 'Gain',
      text: 'Boosts or cuts the region',
      range: '−12 to +12 dB in 0.1 dB steps',
      default: '0 dB, or the recommended gain after ANALYZE',
    },
    {
      label: 'Width / Slope',
      text: 'Sets how wide a bell reaches, or how steeply a shelf climbs through its corner',
      details: [
        'Shown only while the region’s correction is on. Width on a bell, Slope on Rumble and Air',
        'A slope past about 1.4 starts to add a bump or dip at the corner rather than just steepening',
        'Double-click to reset',
      ],
      range: 'Width 0.3 to 10 · Slope 0.3 to 2',
      default: 'The width the analysis measured, or the region’s standard width for a band you placed yourself',
    },
    {
      label: 'OUT',
      shot: 'output-meter',
      text: 'Shows the level leaving the plugin',
    },
    {
      label: 'TRANSFER TO EQ →',
      text: 'Moves the corrections into the EQ, where they become ordinary bands you can shape further',
      details: [
        'It is a move, not a copy, so the same correction can never be applied twice. The findings stay, so you can apply them here again',
        'The count beside it shows how many corrections are in force',
      ],
    },
  ],

  notes: [
    'Nothing touches the file until you apply — until then the corrections are live monitoring',
    'It reports what it measured rather than a score, and a finding is a suggestion rather than a fault',
    'It is deliberately conservative: it would rather miss a problem than invent one on a recording that is already fine',
    'Most controls appear only after ANALYZE or Skip, so the window opens with only the analysis button in view',
  ],
}
