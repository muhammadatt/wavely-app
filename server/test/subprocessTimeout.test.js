import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { killAfter, timeoutError } from '../lib/subprocessTimeout.js'

const exited = proc => new Promise(resolve => proc.on('exit', (code, signal) => resolve({ code, signal })))

test('killAfter SIGKILLs a process still running at the limit', async () => {
  const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'])
  const watch = killAfter(proc, 'sleeper', 100)
  const { signal } = await exited(proc)
  assert.equal(signal, 'SIGKILL')
  assert.equal(watch.timedOut, true)
})

test('killAfter leaves a process that finishes in time alone', async () => {
  const proc = spawn(process.execPath, ['-e', 'process.exit(0)'])
  const watch = killAfter(proc, 'quick', 5_000)
  const { code } = await exited(proc)
  assert.equal(code, 0)
  assert.equal(watch.timedOut, false)
})

test('killAfter with 0 arms nothing', async () => {
  const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'])
  const watch = killAfter(proc, 'unlimited', 0)
  const { code } = await exited(proc)
  assert.equal(code, 0)
  assert.equal(watch.timedOut, false)
})

test('timeoutError names the stage and carries ETIMEDOUT', () => {
  const err = timeoutError('Demucs', 90_000)
  assert.equal(err.code, 'ETIMEDOUT')
  assert.match(err.message, /Demucs timed out after 2 min/)
})

// ── The persistent Python worker ────────────────────────────────────────────

const moduleDir = await mkdtemp(join(tmpdir(), 'wavely-worker-'))
await writeFile(join(moduleDir, '_sleep_for_test.py'),
  'import time\n\ndef run(argv):\n    time.sleep(float(argv[0]))\n    return {"slept": float(argv[0])}\n')
process.env.PYTHONPATH = moduleDir
process.env.PYTHON_WORKER_POOL_SIZE = '1'
const worker = await import(`../pipeline/pythonWorker.js?timeout-test=${Date.now()}`)

after(async () => {
  await worker.stopWorker()
  await rm(moduleDir, { recursive: true, force: true })
})

test('a worker call past its limit is rejected, the worker killed, and the next call gets a fresh one', async () => {
  const before = await worker.pingWorker()
  await assert.rejects(
    worker.runPython('_sleep_for_test', ['30'], 'Sleeper', { timeoutMs: 300 }),
    err => err.code === 'ETIMEDOUT' && /Sleeper timed out/.test(err.message),
  )
  const afterKill = await worker.pingWorker()
  assert.notEqual(afterKill.pid, before.pid, 'a new worker process serves the next call')
  assert.deepEqual(await worker.runPython('_sleep_for_test', ['0.01'], 'Quick', { timeoutMs: 10_000 }), { slept: 0.01 })
})

test('a task queued behind a timed-out one runs on the fresh worker instead of failing with it', async () => {
  const slow = worker.runPython('_sleep_for_test', ['30'], 'Wedged', { timeoutMs: 300 })
  const queued = worker.runPython('_sleep_for_test', ['0.01'], 'Behind', { timeoutMs: 10_000 })
  await assert.rejects(slow, /Wedged timed out/)
  assert.deepEqual(await queued, { slept: 0.01 })
})
