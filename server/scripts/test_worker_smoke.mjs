/**
 * Smoke test for the persistent Python worker.
 *
 * Run from anywhere:   node server/scripts/test_worker_smoke.mjs
 *
 * Verifies:
 *   1. Worker spawns and answers __ping__
 *   2. Invalid script name produces a clear error
 *   3. The same worker pid handles multiple requests (no respawn per call)
 *   4. Shutdown is clean
 *
 * Does NOT test actual audio processing — that requires the heavy Python
 * deps (torch, numpy, scipy, deepfilternet, pyrnnoise) and a real input
 * WAV. End-to-end verification belongs in a normal pipeline run.
 */

import { runPython, pingWorker, stopWorker } from '../pipeline/pythonWorker.js'

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('OK:', msg)
}

const ping1 = await pingWorker()
assert(typeof ping1.pid === 'number', `ping returned pid=${ping1.pid}`)

const ping2 = await pingWorker()
assert(ping2.pid === ping1.pid, `second ping reuses worker (pid ${ping2.pid} === ${ping1.pid})`)

let caught = null
try {
  await runPython('definitely_does_not_exist_xyz', [], 'BadScript')
} catch (err) {
  caught = err
}
assert(caught && /BadScript|definitely_does_not_exist/.test(caught.message),
  'unknown script name produces a labeled error')

await stopWorker()
console.log('\nAll smoke checks passed.')
process.exit(0)
