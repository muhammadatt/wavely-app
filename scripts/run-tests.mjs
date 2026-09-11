#!/usr/bin/env node
/**
 * Test entry point: `node --test` with the worker count set explicitly.
 *
 * Node defaults `--test-concurrency` to `availableParallelism() - 1`, which
 * deliberately leaves a core free for the parent process. That default is wrong
 * for this suite: the parent only collects TAP, while the workers are almost
 * pure CPU-bound DSP, so the idle core is simply lost. Measured on a 4-core
 * box, the whole suite runs 118 s at the default (3 workers) against 96 s at 4.
 *
 * ⚠ SLOWEST-FIRST FILE ORDERING WAS TRIED HERE AND IS NOT WORTH IT. It returned
 * ~1 s (95.8 s → 94.5 s) because the wall clock is set by the single longest
 * file rather than by packing, and it would have meant carrying a hand-kept
 * list of slow files that goes stale silently. Ordering is left to the glob.
 *
 * Extra arguments are passed through, so a single file still works:
 *   node scripts/run-tests.mjs test/dsp/scheps.test.js
 */
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'

const passthrough = process.argv.slice(2)
const targets = passthrough.length > 0 ? passthrough : ['test/**/*.test.js']

const child = spawn(
  process.execPath,
  ['--test', `--test-concurrency=${Math.max(1, availableParallelism())}`, ...targets],
  { stdio: 'inherit' },
)
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
