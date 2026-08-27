export default {
  summary: 'Removes steady background noise from the selection',

  whenToUse: [
    'There is audible hiss, air conditioning or room noise behind the voice',
    'The recording has to reach a noise floor target for delivery',
    'The room is present enough to distract from the words',
  ],

  controls: [
    { label: 'Strength', text: 'How much noise is removed — more also risks thinning the voice' },
    { label: 'Sensitivity', text: 'How readily something is judged to be noise rather than voice' },
  ],

  steps: [
    'Select a stretch that contains both speech and a pause, so the noise can be measured',
    'Start at the middle strength and listen to the result before reaching for more',
    'If the voice starts sounding watery or hollow, reduce Strength — that artefact does not improve with more processing',
  ],

  notes: [
    'This runs on the server, so it takes a moment rather than previewing live',
    'Removing noise before boosting the top end is the right order — Air Boost lifts whatever hiss is left',
    'Never force a pass: if the noise floor cannot be reached without artefacts, the honest result is the quieter one you can still listen to',
  ],
}
