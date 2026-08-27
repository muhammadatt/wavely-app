export default {
  summary: 'Lifts the top end with a wide shelf shaped from five overlapping bells',

  whenToUse: [
    'A voice sounds dull or closed-in after noise reduction',
    'You want presence and air without the hardness a narrow high boost gives',
    'The recording is fine but sits behind the listener rather than in front of them',
  ],

  controls: [
    { label: 'Air', text: 'How much lift the shelf applies' },
    { label: 'Output', text: 'Level after the shelf, for matching against bypass' },
  ],

  steps: [
    'Play the selection and raise Air until the voice opens up',
    'Pull Output back by roughly the same amount and compare against bypass',
    'Back Air off if sibilance comes forward with the air',
  ],

  notes: [
    'The curve is drawn from the same coefficients the effect runs, so what is on screen is the filter you are hearing',
    'It only ever lifts — reach for the EQ if you need to cut up there',
    'Boosting the top end also lifts hiss, so run this after noise reduction rather than before it',
  ],
}
