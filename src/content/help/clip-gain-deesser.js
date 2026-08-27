export default {
  summary: 'Finds sibilant events and turns each one down, the way an editor would with clip gain',

  whenToUse: [
    'S and F sounds are harsh or spitty',
    'Sibilance got worse after adding air or compression',
    'You want the harshness gone without dulling the whole take',
  ],

  controls: [
    { label: 'ANALYSE', text: 'Measures the selection and finds the sibilant events — the controls below reshape that result without re-detecting' },
    { label: '/s/ Ceiling dB', text: 'How loud an S is allowed to be before it is turned down' },
    { label: '/f/ Ceiling dB', text: 'The same for F and other fricatives, which sit lower and need their own ceiling' },
    { label: 'Amount', text: 'How much of the excess above a ceiling is removed' },
    { label: 'Max Cut dB', text: 'The most any single event will be turned down' },
    { label: 'Fric In / Fric Out', text: 'How quickly the reduction arrives and leaves on a fricative' },
    { label: 'Affr In / Affr Out', text: 'The same for affricates, which start with a burst and need the cut placed before it' },
  ],

  steps: [
    'Select the passage and press ANALYSE',
    'Lower the /s/ ceiling until the count of treated events covers the ones you can hear',
    'Raise Amount until they stop poking out',
    'Compare against bypass — if the take now sounds lisping, lower Amount rather than the ceiling',
  ],

  notes: [
    'It turns events down rather than filtering them, so the timbre of an S is preserved and only its level moves',
    'Apply is unavailable until an analysis exists and at least one event is above its ceiling',
    'Moving the selection outside the analysed region invalidates the analysis — run it again',
  ],
}
