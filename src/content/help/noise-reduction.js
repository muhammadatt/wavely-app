export default {
  summary: 'Removes background noise, hiss and room tone with DeepFilterNet3, RNNoise or both',

  whenToUse: [
    'A steady hiss, fan or air conditioner runs under the voice',
    'The room tone between phrases is too loud for ACX',
    'A passage was recorded somewhere noisier than the rest',
  ],

  controls: [
    { label: 'Engine', text: 'DeepFilterNet3 is the strongest model and the right first choice. RNNoise is lighter. Both runs DeepFilterNet3, then RNNoise on what it leaves, as the ACX Audiobook preset does. Only the settings the chosen engine uses are shown' },
    { label: 'Max reduction', text: 'The most DeepFilterNet3 may take out at any frequency and moment. Lower keeps more of the edges of S, F and breath sounds; MAX is uncapped' },
    { label: 'Protect consonants', text: 'Keeps the original audio where speech is detected but RNNoise would suppress it, which is usually the start of an S or F' },
    { label: 'Mix', text: 'How much of the denoised audio to use. Below 100% blends the original back in to hide artefacts, at the cost of some noise' },
    { label: 'Process selection', text: 'Cleans the whole selection on the server and replaces it in one undoable step. While it runs the window shows how far it has got, with a Cancel button' },
  ],

  steps: [
    'Select the noisy passage, or the whole file',
    'Choose the engine and settings, then press Process',
    'Listen to the result in the editor. Undo puts the original back',
    'If the voice sounds watery or the S sounds are dulled, undo, lower Max reduction or Mix, and process again. If only Mix changed, the second run is instant — the server result is reused',
  ],

  notes: [
    'Noise reduction is an offline process: it runs on the server, so there is no real-time preview and it cannot take a Plugin Chain slot',
    'Run it before compression or loudness normalisation, since both bring the noise floor up',
    'The level is left as the model returned it. It is not re-normalised the way the mastering presets do',
    'Noise Reduction is a Pro feature',
  ],
}
