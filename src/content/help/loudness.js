export default {
  summary: 'Moves the selection to a delivery loudness target and holds a peak ceiling while doing it',

  whenToUse: [
    'You are submitting to a platform with a published spec — ACX, a podcast host, a broadcaster, a streaming service',
    'A file sounds right but you need the number a submission will be checked against',
    'Two recordings differ in level and you want both sitting on the same target',
    'You want to know what a region actually measures before deciding anything',
  ],

  quickStart: [
    'Select a region, or leave nothing selected to work on the whole file',
    'Read what it measures now, at the top of the window',
    'Click a benchmark such as ACX or PODCAST, or turn Target and Ceiling to your own numbers',
    'Choose LIMIT or SAFE — the line beside the reading says what each will cost on this file',
    'Apply, then read the line at the bottom: that figure is measured on the audio that came out',
  ],

  controls: [
    {
      label: 'Selection / Whole file',
      shot: 'measurement',
      text: 'What the region measures now, and what Apply will do to it',
      details: [
        'For a LUFS target it shows the integrated loudness (K-weighted and gated, per BS.1770) and the true peak in dBTP. For ACX it shows ungated, unweighted RMS and the sample peak in dBFS, which is what ACX itself audits',
        'The line beside the readings is the plan: the gain Apply will use and, when the target and the ceiling disagree, what gives — the peaks limited to the ceiling (LIMIT) or how far short of the target it stops (SAFE)',
        'It re-measures whenever the selection or the file changes. The whole region is measured, however long — integrated loudness is a statement about all of it',
        'A region under 0.4 s is too short for an integrated reading and the window says so: the figure is a single ungated window, fine for evening out a phrase but not a number to submit against',
      ],
    },
    {
      label: 'SPOKEN WORD / MUSIC & VIDEO',
      shot: 'benchmarks',
      text: 'Benchmark buttons that set Target, the meter it is stated on, and Ceiling to a published delivery spec in one click',
      details: [
        'SPOKEN WORD: ACX (−20 dBFS RMS, −3 dBFS sample peak; ACX accepts −23 to −18), PODCAST (−16 LUFS, −1 dBTP) and EBU R128 (−23 LUFS, −1 dBTP)',
        'MUSIC & VIDEO: SPOTIFY, YOUTUBE and TIDAL (−14 LUFS, −1 dBTP), APPLE (−16 LUFS, −1 dBTP) and AMAZON (−14 LUFS, −2 dBTP)',
        'The buttons describe values rather than modes: every benchmark the settings match lights up, including ones you reach by turning the knobs, and they go out when you turn off them. The line underneath says where the numbers come from',
        'A benchmark is three numbers and nothing else — it does not change the character of the recording',
      ],
      default: 'PODCAST, with APPLE lit beside it since the two share the same numbers',
    },
    {
      label: 'Target',
      shot: 'target',
      text: 'The loudness to move the region to, in the unit printed under the knob',
      details: [
        'LUFS integrated for every benchmark except ACX, which is dBFS RMS, ungated. The unit follows the benchmark you last clicked, and the knob’s travel follows the unit',
        'Click the value to type one, or double-click the knob to reset it',
      ],
      range: '−32 to −8 LUFS, or −30 to −10 dBFS RMS, in 0.1 dB steps',
      default: '−16.0 LUFS',
    },
    {
      label: 'Ceiling',
      shot: 'ceiling',
      text: 'The highest the peaks may land',
      details: [
        'True peak (dBTP) for LUFS targets, which catches the overs that appear between samples after conversion. Sample peak (dBFS) for ACX, which is how ACX checks it',
      ],
      range: '−9 to 0 in 0.1 dB steps',
      default: '−1.0 dBTP',
    },
    {
      label: 'Peak',
      shot: 'peak',
      text: 'Decides what gives when reaching the target would push the peaks past the ceiling',
      details: [
        'LIMIT hits the target and limits peaks to the ceiling with a lookahead limiter. Limiting lowers the loudness the gain has just set, so it re-measures and closes the gap, stopping early if another pass would not help',
        'SAFE applies one gain only and stops at the ceiling, leaving the dynamics untouched but possibly short of the target',
        'If the target and the ceiling agree, both give the same result: one gain, nothing limited',
      ],
      range: 'LIMIT, SAFE',
      default: 'LIMIT',
    },
    {
      label: 'Applied',
      text: 'After Apply, a line at the bottom of the window reports the loudness and peak the result actually measures',
      details: [
        'It is measured on the rendered audio, never predicted from the gain, because the figure is aimed at a spec somebody else will measure. It is highlighted if the result missed the target by more than 0.5 dB',
      ],
    },
  ],

  notes: [
    'The same file reads several dB apart on the two meters: streaming targets are K-weighted, gated LUFS against true peak, ACX is ungated, unweighted RMS against sample peak',
    'LIMIT can fall short on a very peaky region — the ceiling always wins, and the Applied line tells you where it landed',
    'There is no preview: the result is heard after Apply, and Undo takes it back',
    'Mastering re-normalizes the whole file at the end, so use this for spot work or for a file you are exporting as it stands',
  ],
}
