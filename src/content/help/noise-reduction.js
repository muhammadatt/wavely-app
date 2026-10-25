export default {
  summary: 'Removes background noise, hiss and room tone with DeepFilterNet3, RNNoise or both',

  whenToUse: [
    'A steady hiss, fan or air conditioner runs under the voice',
    'The room tone between phrases is too loud for ACX',
    'A passage was recorded somewhere noisier than the rest',
  ],

  controls: [
    { label: 'Engine', text: 'DF3 is the strongest model and the right first choice. RNNoise is lighter. Both runs DF3, then RNNoise on what it leaves, as the ACX Audiobook preset does' },
    { label: 'Max reduction', text: 'The most DF3 may take out at any frequency and moment. Lower keeps more of the edges of S, F and breath sounds; MAX is uncapped' },
    { label: 'Protect consonants', text: 'Keeps the original audio where speech is detected but RNNoise would suppress it, which is usually the start of an S or F' },
    { label: 'Mix', text: 'How much of the denoised audio to use. Below 100% blends the original back in to hide artefacts, at the cost of some noise' },
    { label: 'Process and Listen', text: 'Processes the selection on the server, then plays it from the start. Original and Denoised switch sides while it plays' },
  ],

  steps: [
    'Select the noisy passage, or the whole file',
    'Press Process and wait for the server',
    'Listen, switching between Original and Denoised',
    'If the voice sounds watery or the S sounds are dulled, lower Max reduction or Mix. Mix changes straight away, while the other settings need another Process',
    'Apply writes exactly what you heard',
  ],

  notes: [
    'Noise reduction runs on the server, so there is no real-time preview and it cannot take a Plugin Chain slot',
    'Run it before compression or loudness normalisation, since both bring the noise floor up',
    'The level is left as the model returned it. It is not re-normalised the way the mastering presets do',
    'Free accounts can process the first 30 seconds of a selection to hear the result. Applying needs Pro',
  ],
}
