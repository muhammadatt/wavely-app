/**
 * Tests for the pipeline logger's error path.
 *
 * Validates:
 *   1. logError writes a properly-formatted ERROR block with the message,
 *      stack, and any cause chain.
 *   2. logFailureFooter writes a terminal "Run Failed" block so the log
 *      ends clearly when the pipeline aborts mid-run.
 *   3. End-to-end: the orchestrator's catch path actually invokes logError
 *      + logFailureFooter, so the failing stage's name and error are on
 *      disk when a crash happens. This is the integration we wanted: a
 *      previous run crashed mid-airBoost with nothing in the log; now the
 *      log ends with the ERROR block + footer.
 *
 * Run with:  cd server && npm test
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'fs/promises'
import path from 'path'
import os from 'os'

const TEMP_DIRS = []

async function makeTempLogDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wavely-log-test-'))
  TEMP_DIRS.push(dir)
  return dir
}

/**
 * Import the logger module fresh against a specific log dir + LOG_ENABLED
 * setting. The module captures env vars at top-level evaluation so we need
 * a cache-busting query string to swap config between tests.
 */
async function loadLogger(logDir) {
  process.env.PIPELINE_LOG     = 'true'
  process.env.PIPELINE_LOG_DIR = logDir
  return import(`../pipeline/logger.js?t=${Date.now()}`)
}

after(async () => {
  for (const d of TEMP_DIRS) {
    try { await rm(d, { recursive: true, force: true }) } catch {}
  }
  delete process.env.PIPELINE_LOG
  delete process.env.PIPELINE_LOG_DIR
})

test('logger.logError writes a formatted ERROR block with message and stack', async () => {
  const logDir = await makeTempLogDir()
  const { createLogger } = await loadLogger(logDir)

  // Minimal preset + profile + input — createLogger needs them to write the
  // header and copy the original file into the run dir.
  const preset        = { id: 'test_preset', displayName: 'Test' }
  const outputProfile = { id: 'test_profile' }
  // The input file just needs to exist; logger.init copies it as `00_input.*`.
  const inputPath = path.join(logDir, 'input.wav')
  await writeStubFile(inputPath, 'stub wav bytes')

  const logger = await createLogger(preset, outputProfile, 'input.wav', inputPath)
  assert.ok(logger, 'logger should be created when PIPELINE_LOG is enabled')

  const err = new Error('simulated noiseReduce failure')
  err.stack = 'Error: simulated noiseReduce failure\n    at runPython (/server/pipeline/pythonWorker.js:152:12)\n    at noiseReduce (/server/pipeline/stages.js:550:5)'
  await logger.logError('noiseReduce', err, 4250)

  const logText = await readFile(logger.logPath, 'utf8')
  assert.match(logText, /── ERROR @ Step \d+: noiseReduce \(failed after 4\.25s\)/,
    'ERROR header should include stage name + step number + duration')
  assert.match(logText, /Message:\s+simulated noiseReduce failure/,
    'error message should be rendered under Message:')
  assert.match(logText, /Stack:[\s\S]+at runPython/,
    'stack trace should be rendered under Stack:')
})

test('logger.logError walks the cause chain', async () => {
  const logDir = await makeTempLogDir()
  const { createLogger } = await loadLogger(logDir)
  const inputPath = path.join(logDir, 'input.wav')
  await writeStubFile(inputPath, 'stub')

  const logger = await createLogger(
    { id: 'p', displayName: 'P' },
    { id: 'op' },
    'input.wav',
    inputPath,
  )

  const root  = new Error('Python worker 1 exited (code=137, signal=null)')
  const mid   = new Error('noiseReduce failed', { cause: root })
  const outer = new Error('stage dispatch threw', { cause: mid })
  await logger.logError('noiseReduce', outer)

  const logText = await readFile(logger.logPath, 'utf8')
  assert.match(logText, /Message:\s+stage dispatch threw/,
    'top-level message rendered')
  assert.match(logText, /Caused by \(depth 1\):\s+noiseReduce failed/,
    'first cause rendered')
  assert.match(logText, /Caused by \(depth 2\):\s+Python worker 1 exited \(code=137, signal=null\)/,
    'root cause rendered with worker exit detail')
})

test('logger.logFailureFooter writes a Run Failed terminal block', async () => {
  const logDir = await makeTempLogDir()
  const { createLogger } = await loadLogger(logDir)
  const inputPath = path.join(logDir, 'input.wav')
  await writeStubFile(inputPath, 'stub')

  const logger = await createLogger(
    { id: 'p', displayName: 'P' },
    { id: 'op' },
    'input.wav',
    inputPath,
  )

  const err = new Error('airBoost: out of memory')
  await logger.logFailureFooter('airBoost', err)

  const logText = await readFile(logger.logPath, 'utf8')
  assert.match(logText, /=== Run Failed ===/, 'failure footer header present')
  assert.match(logText, /Failed at stage:\s+airBoost/, 'stage name in footer')
  assert.match(logText, /Error:\s+airBoost: out of memory/, 'error message in footer')
  assert.match(logText, /Total elapsed:\s+\d+\.\d+s/, 'elapsed time in footer')
})

async function writeStubFile(p, content) {
  const { writeFile } = await import('fs/promises')
  await writeFile(p, content, 'utf8')
}
