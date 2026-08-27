export default {
  summary: 'Finds passages quieter than a threshold and removes them',

  whenToUse: [
    'Long gaps between takes or sentences are padding the running time',
    'You want to tighten pacing without editing each pause by hand',
  ],

  controls: [
    { label: 'Threshold', text: 'How quiet a passage has to be to count as silence' },
    { label: 'Min Length', text: 'How long it has to stay that quiet before it is removed, so ordinary gaps between words survive' },
  ],

  steps: [
    'Set Threshold just above the room tone, not at digital silence — a real recording is never truly silent',
    'Raise Min Length until natural pauses stop being caught',
  ],

  notes: [
    'Removing every pause makes narration sound breathless — the pauses carry the performance',
    'This deletes audio rather than quietening it, so the file gets shorter',
  ],
}
