export default {
  summary: 'Moves the selection to a delivery loudness target and holds a peak ceiling while doing it',

  whenToUse: [
    'You are submitting to a platform with a published spec — ACX, Spotify, a podcast host, a broadcaster',
    'A file measures right by ear but you need the number a submission will be checked against',
    'Two recordings sound different in level and you want both sitting on the same target',
    'You want to know what a region actually measures before deciding anything',
  ],

  controls: [
    {
      label: 'Target',
      text: 'Where the selection ends up, in the unit the chosen benchmark is stated in',
    },
    {
      label: 'Ceiling',
      text: 'The highest peak allowed in the result — true peak for LUFS targets, sample peak for ACX',
    },
    {
      label: 'Peak',
      text: 'LIMIT hits the target and limits peaks to the ceiling; SAFE applies one gain and stops at the ceiling',
    },
  ],

  steps: [
    'Select the region, or leave nothing selected to work on the whole file',
    'Read what it measures now, at the top of the panel',
    'Click a benchmark, or turn Target and Ceiling to your own numbers',
    'Choose LIMIT or SAFE — the line beside the readout says what each will cost on this file',
    'Apply, then read the line at the bottom: that figure is measured on the audio that came out',
  ],

  notes: [
    'The benchmarks are three numbers each — a target, a ceiling and which meter the target is stated on — and nothing else; they do not change the character of the recording',
    'ACX is measured differently from every other target here: ungated, unweighted RMS against sample peak, which is what ACX itself audits',
    'Streaming targets are K-weighted, gated LUFS against true peak, so the same file reads several dB apart on the two meters',
    'A region under 0.4 s is too short for an integrated reading and the panel says so — the figure is a single ungated window',
    'LIMIT can fall short on a very peaky region: the ceiling wins, and the applied figure at the bottom tells you where it landed',
    'Mastering re-normalizes the whole file at the end, so use this for spot work or for a file you are exporting as it stands',
  ],
}
