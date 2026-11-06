export default {
  summary: 'Evens out the level between phrases, leaving the dynamics inside each phrase alone',

  whenToUse: [
    'Some sentences sit noticeably quieter than others in the same take',
    'You drifted off-mic or changed delivery part-way through a session',
    'A compressor is working too hard because the level going into it wanders',
    'Chapters have to match each other and one of them rides low',
  ],

  controls: [
    { label: 'Apply to selection', text: 'Finds the phrases in the selection, evens them out and replaces the selection in one undoable step' },
    { label: 'Deadband dB', text: 'How far a phrase may sit from the target before anything moves it — inside this band it is left untouched' },
    { label: 'Knee dB', text: 'How gradually the correction opens up past the deadband, so two similar phrases do not get different treatment' },
    { label: 'Max Boost dB', text: 'The most any phrase will be lifted' },
    { label: 'Max Cut dB', text: 'The most any phrase will be turned down' },
    { label: 'WHOLE SELECTION / ROLLING', text: 'Whether every phrase aims at one level for the whole selection, or at a median that follows the recording' },
    { label: 'Window s', text: 'How far back the rolling median looks — only used in ROLLING mode' },
    { label: 'Floor dBFS', text: 'Where room tone is allowed to end up, which caps how far a quiet phrase can be lifted' },
    { label: 'Settings', text: 'Every value box can be dragged up or down, typed into, or double-clicked to go back to its default' },
    { label: 'Last run', text: 'What the last Apply did: how many phrases it levelled, how far apart they were before and after, and the largest cut and boost. It says so when the leveler declined or when room tone capped the boost' },
  ],

  steps: [
    'Select at least 10 seconds containing at least 5 seconds of speech — usually the whole chapter — and press Apply to selection',
    'Listen in the editor. Undo puts the original back',
    'If phrases you can hear as uneven were left alone, undo, lower the deadband and level again',
    'Use ROLLING if the take deliberately changes level and WHOLE SELECTION should not flatten it',
  ],

  notes: [
    'Gain is flat within a phrase, so the dynamics you performed inside a sentence survive exactly',
    'Run this before compression, not after — it hands the compressor a steady input',
    'Lifting a quiet phrase lifts its room tone with it, so Floor dBFS can cap the boost below Max Boost',
    'Where two neighbouring phrases would end up more than 6 dB apart, both are left at their average instead — a step that large is usually the analysis being wrong about where a phrase ended',
    'Under 10 seconds of selection, under 5 seconds of speech, or only one phrase found, and it declines rather than guessing',
    'Auto Leveler is an offline process, so it has no real-time preview and cannot take a Plugin Chain slot',
    'Auto Leveler is a Pro feature',
  ],
}
