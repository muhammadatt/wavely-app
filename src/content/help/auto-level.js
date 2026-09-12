export default {
  summary: 'Evens out how loud each phrase is, without touching the dynamics inside a phrase',

  whenToUse: [
    'A narrator drifts louder or quieter across a chapter and you want it consistent end to end',
    'Some phrases sit noticeably below the rest and a compressor only makes the gap breathe',
    'You want the compressors that follow to see a steady input so their character stays put',
  ],

  controls: [
    {
      label: 'Target',
      text: 'WHOLE aims every phrase at one level for the file, which is what removes drift across a chapter; LOCAL follows a rolling median instead, so a deliberate slow build survives',
    },
    {
      label: 'Max Up',
      text: 'The most any phrase may be raised — capped further, automatically, when raising it would bring the room tone up with it',
    },
    {
      label: 'Max Down',
      text: 'The most any phrase may be lowered',
    },
    {
      label: 'Deadband',
      text: 'Phrases already within this much of the target are left completely alone, not corrected gently',
    },
  ],

  steps: [
    'Press ANALYSE — it measures the whole file, because a phrase is judged against its neighbours',
    'Turn the effect on and play to hear it, watching the gain readout follow each phrase',
    'Select the part you want written back and press APPLY',
  ],

  notes: [
    'Each phrase gets one flat gain and the changes happen in the gaps between them, so nothing inside a phrase is compressed, ducked or ridden',
    'Analysis covers the whole file but APPLY writes back only the selection — the two are deliberately different, because a phrase measured against only its neighbours inside a selection would be judged differently from the same phrase in the whole recording',
    'Any edit to the file invalidates the analysis, since the measurements point at sample positions that have moved',
    'Where two neighbouring phrases would need very different gains the pair is merged and given one average instead — a large step between them is audible however well it is hidden',
    'This runs before compression, not after — it is what lets a compressor keep one character across a whole chapter',
  ],
}
