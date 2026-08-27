export default {
  summary: 'Holds the loudest peaks down to a ceiling you set, so the rest of the chain has room to work',

  whenToUse: [
    'A few isolated peaks are forcing everything else to sit low',
    'You want more level before compressing, without the compressor chasing single transients',
    'A plosive or a mouth click is the loudest thing in an otherwise even take',
  ],

  controls: [
    {
      label: 'Ceiling',
      text: 'Where peaks stop, in dBFS — the line drawn across the display, which you can also drag',
    },
    {
      label: 'GENTLE / MED / HARD / SQUASH',
      text: 'Measure the selection and place the ceiling so it catches the top 3, 7, 15 or 25 percent of peaks',
    },
    {
      label: 'PEAK CONTROL',
      text: 'CLIP shapes the peaks themselves at about 1 ms of latency, LIMIT rides them down with a lookahead limiter at about 5 ms for much less distortion',
    },
    {
      label: 'Trim',
      text: 'Output level, for matching loudness when comparing against bypass',
    },
    {
      label: 'CLIP LAMP',
      text: 'Lights while the stage is working',
    },
    {
      label: 'ENGAGED',
      text: 'What share of recent voiced audio reached the ceiling',
    },
  ],

  steps: [
    'Make a selection — the ceiling presets measure it, so they do nothing without one',
    'Press MED and listen',
    'Move the Ceiling knob or drag the line if you want more or less, which clears the preset lamp',
    'Use Trim to match levels before deciding whether you prefer it',
  ],

  notes: [
    'A ceiling is measured from this recording’s own peaks, so GENTLE means the same thing on a quiet file and a loud one',
    'LIMIT is the default and in that mode the clipper is idle — the lookahead limiter is doing all of the peak control, which is why it distorts so much less',
    'Switching PEAK CONTROL shifts the preview by about 4 ms — the applied result is placed correctly either way',
    'ENGAGED is a share of the material, not a guarantee that a given percentage was clipped',
    'Below the ceiling the signal is untouched',
  ],
}
