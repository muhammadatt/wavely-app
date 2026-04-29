import { applyNoiseReduction, runRnnoise } from './server/pipeline/noiseReduce.js';
import fs from 'fs';

async function test() {
  const inPath = 'impulse.wav';
  const outPath = 'impulse_out.wav';

  await applyNoiseReduction(inPath, outPath);
  console.log('DF3 Done');
  await runRnnoise(inPath, 'impulse_rnn_out.wav');
  console.log('RNNoise Done');
}
test().catch(console.error);