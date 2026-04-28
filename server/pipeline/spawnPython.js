/**
 * Shared Python subprocess spawners for ML pipeline stages.
 *
 * spawnPython        — fire-and-forget; streams stdout/stderr in real time
 * spawnPythonCapture — collects stdout, returns parsed JSON
 *
 * Environment:
 *   SEPARATION_PYTHON  — Python executable (default: python3)
 *   SEPARATION_DEVICE  — Compute device for device-aware scripts (default: auto)
 *   TORCH_NUM_THREADS  — PyTorch thread count (default: CPU count)
 */

import { spawn } from 'child_process'
import os from 'os'

export const PYTHON = process.env.SEPARATION_PYTHON ?? 'python3'
export const DEVICE = process.env.SEPARATION_DEVICE ?? 'auto'
const NUM_THREADS = process.env.TORCH_NUM_THREADS ?? String(os.cpus().length)

/**
 * Spawn a Python script, streaming stdout/stderr line-by-line in real time.
 * Resolves when the script exits 0; rejects on non-zero exit or spawn error.
 */
export function spawnPython(script, args, label, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMP_NUM_THREADS:   NUM_THREADS,
        MKL_NUM_THREADS:   NUM_THREADS,
        TORCH_NUM_THREADS: NUM_THREADS,
        ...extraEnv,
      },
    })

    let stderr = ''

    // Stream stdout line-by-line — tqdm and other model progress bars are
    // visible in server logs without waiting for the process to finish.
    proc.stdout.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) console.log(`[${label}] ${line}`)
      }
    })

    // Drain stderr in real time; keep a rolling tail for error messages.
    proc.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr += text
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[${label}] ${line}`)
      }
    })

    proc.on('close', (code, signal) => {
      if (code === 0 && signal === null) {
        resolve()
      } else {
        const parts = []
        if (code   !== null) parts.push(`code ${code}`)
        if (signal !== null) parts.push(`signal ${signal}`)
        reject(new Error(`${label} exited with ${parts.join(', ') || 'unknown reason'}.\n${stderr.slice(-3000)}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn ${label}: ${err.message}`))
    })
  })
}

/**
 * Like spawnPython but collects all stdout and returns it as parsed JSON.
 * Stderr is still streamed to console in real time.
 */
export function spawnPythonCapture(script, args, label, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMP_NUM_THREADS:   NUM_THREADS,
        MKL_NUM_THREADS:   NUM_THREADS,
        TORCH_NUM_THREADS: NUM_THREADS,
        ...extraEnv,
      },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', chunk => { stdout += chunk.toString() })

    proc.stderr.on('data', chunk => {
      const text = chunk.toString()
      stderr += text
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[${label}] ${line}`)
      }
    })

    proc.on('close', (code, signal) => {
      if (code === 0 && signal === null) {
        try {
          resolve(JSON.parse(stdout))
        } catch (err) {
          const details = [
            `${label} produced invalid JSON on stdout: ${err.message}`,
            `stdout (tail):\n${stdout.trim().slice(-3000) || '(empty)'}`,
          ]
          if (stderr.trim()) details.push(`stderr (tail):\n${stderr.trim().slice(-3000)}`)
          reject(new Error(details.join('\n')))
        }
      } else {
        const parts = []
        if (code   !== null) parts.push(`code ${code}`)
        if (signal !== null) parts.push(`signal ${signal}`)
        reject(new Error(`${label} exited with ${parts.join(', ') || 'unknown reason'}.\n${stderr.slice(-3000)}`))
      }
    })

    proc.on('error', err => {
      reject(new Error(`Failed to spawn ${label}: ${err.message}`))
    })
  })
}
