export default {
  summary: 'Holds the loudest peaks down to a ceiling measured from your recording, then hands the room it made back as level',

  intro: [
    'Soft Clipper rounds off the very loudest peaks with a smooth curve instead of a hard limit. The ceiling is measured from your own recording, so it only touches the few peaks that stand far above everything else, and the room it frees is handed back as level',
    'Use it when a single plosive, click or shout is forcing the rest of a take to sit low, or before a compressor so it is not chasing isolated transients. A LIMIT mode adds a lookahead limiter for the cleanest result on hard peaks',
  ],

  quickStart: [
    'Select the region you want to treat — the window opens engaged and places the ceiling on GENTLE for it',
    'Play, and watch the scope: shaded peaks are the ones reaching the ceiling',
    'Press MED or HARD for more, or drag the line on the scope to place the ceiling yourself',
    'Leave Peak control on LIMIT for the cleanest result, and AUTO lit so Output brings the level back up',
    'Compare against bypass, then Apply',
  ],

  controls: [
    {
      label: 'Clip',
      group: 'READOUTS',
      shot: 'clip-lamp',
      text: 'A lamp that glows while the stage is taking peaks down, brighter the more it takes',
      details: [
        'It reaches full brightness at 3 dB of reduction and holds briefly after each peak so a single click is still visible',
      ],
    },
    {
      label: 'dB peak',
      group: 'READOUTS',
      shot: 'peak-reduction',
      text: 'How far the most recent peaks are being pulled down, in dB',
      details: [
        'The figure holds for 0.7 s and then falls at 2.5 dB per second, so it reads the last loud peak rather than flickering. A dash means nothing is being reduced',
      ],
    },
    {
      label: 'Engaged',
      group: 'READOUTS',
      shot: 'engaged',
      text: 'The share of recent voiced audio in which the stage reached the ceiling',
      details: [
        'It is averaged over about the last 2 s of speech and ignores silence, so it tells you how often the ceiling is working, not how hard',
      ],
    },
    {
      label: 'Scope',
      shot: 'scope',
      text: 'The waveform around the playhead against the ceiling line, with every peak the ceiling catches shaded',
      details: [
        'It shows 8 s: what has played to the left of the centre and what is about to play to the right, so you can park the playhead before a loud passage and see what the current ceiling will do to it before you hear it',
        'Drag the line up or down to set the ceiling directly. It moves in 0.5 dB steps and stays between −24 and −1 dBFS',
        'Before anything has played, clicking the label in the middle starts playback',
      ],
    },
    {
      label: 'IN / OUT',
      shot: 'meters',
      text: 'Level meters for the signal entering and leaving the stage',
      details: [
        'With AUTO lit the two peaks land in the same place and OUT reads louder underneath — that difference is the level the clipper has bought you',
      ],
    },
    {
      label: 'Ceiling',
      shot: 'ceiling',
      text: 'Where the peaks stop, in dBFS — the same number as the line on the scope',
      details: [
        'Below the ceiling the audio is untouched',
        'With AUTO lit this is a threshold inside the stage rather than the output peak: the makeup gain lifts everything afterwards, so the output peak lands back where the source peak was',
        'Click the value to type one, or double-click the knob to reset it',
      ],
      range: '−24 to −1 dBFS in 0.5 dB steps',
      default: 'Set by GENTLE when the window opens on a selection',
    },
    {
      label: 'Set ceiling',
      shot: 'set-ceiling',
      text: 'Four buttons that measure the selection and place the ceiling so it catches a given share of its peaks',
      details: [
        'GENTLE, MED, HARD and SQUASH catch the top 3, 7, 15 and 25 % of the selection’s peaks, measured over 10 ms blocks of the voiced audio. Because the measurement comes from this recording, GENTLE does the same job on a quiet file as on a hot one',
        'A button lights whenever the ceiling sits on its value, however it got there, and goes out as soon as the ceiling moves off it. The line under the bank names the preset and its dBFS value',
        'They need a selection and the plugin switched on. Hover a button to see why it is greyed out',
      ],
      range: 'GENTLE, MED, HARD, SQUASH',
      default: 'GENTLE',
    },
    {
      label: 'Peak control',
      shot: 'peak-control',
      text: 'Chooses how the peaks are taken down',
      details: [
        'LIMIT rides the peaks down with a lookahead limiter and leaves the clip curve idle behind it. It distorts far less and can never overshoot the ceiling, at about 5.1 ms of latency',
        'CLIP reshapes the peaks themselves with a soft clip curve. It is low latency, about 1.1 ms, and the cost is genuine harmonic distortion on the peaks it shapes',
        'The latency is compensated when you apply, so the result lands in place either way',
      ],
      range: 'CLIP, LIMIT',
      default: 'LIMIT',
    },
    {
      label: 'Output',
      group: 'OUTPUT',
      shot: 'output',
      text: 'Makeup gain after the stage',
      details: [
        'With AUTO lit the plugin sets this for you. Turning it yourself takes over and switches AUTO off',
        'It only adds level: nothing in the stage raises the peak, so a cut would never be needed to keep it under the source',
      ],
      range: '0 to +24 dB in 0.1 dB steps',
      default: '0 dB, then set by AUTO',
    },
    {
      label: 'AUTO',
      group: 'OUTPUT',
      shot: 'auto',
      text: 'Lets the plugin set Output so the output peak lands exactly where the source peak was',
      details: [
        'It measures the selection with the current settings and hands back what the ceiling took off the peaks as broadband gain. Peaks carry very little energy, so this is close to free loudness — often around 9 dB at an unchanged peak',
        'It is re-measured whenever the selection, the ceiling or Peak control changes, and never makes the output louder than the source at its peak',
      ],
      range: 'On, Off',
      default: 'On',
    },
    {
      label: 'DELTA',
      text: 'In the window header: plays only what the stage is removing, so you can hear exactly what is being taken off the peaks',
      details: [
        'It is for listening only — Apply always renders the processed audio',
      ],
      range: 'On, Off',
      default: 'Off',
    },
  ],

  notes: [
    'The ceiling presets measure the selection, so they do nothing until you make one',
    'Switching Peak control shifts the preview by about 4 ms; the applied result is placed correctly either way',
    'Engaged is a share of the material, not a guarantee that a given percentage was clipped',
    'Clip before you compress: with the rare peaks held down, the compressor reacts to the voice instead of to single transients',
  ],
}
