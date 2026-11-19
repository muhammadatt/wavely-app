import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  bufferBytes, decodedBytes, isMobileDevice, memoryBudget, checkImport,
  estimateDecodedBytes, probeDuration, importMessage, formatBytes,
  MOBILE_BUDGET_BYTES, DESKTOP_BUDGET_BYTES, MOBILE_BUDGET_MIN_BYTES, MOBILE_BUDGET_MAX_BYTES,
} from '../../src/platform/memoryBudget.js'

const GiB = 1024 ** 3
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'

test('a buffer holds four bytes per sample per channel', () => {
  assert.equal(bufferBytes({ length: 48000, numberOfChannels: 2 }), 384000)
  assert.equal(bufferBytes(null), 0)
})

test('an hour of stereo at 48 kHz decodes to 1.38 GB', () => {
  assert.equal(decodedBytes({ durationSec: 3600, channels: 2, sampleRate: 48000 }), 1_382_400_000)
  assert.equal(decodedBytes({ durationSec: null, channels: 2, sampleRate: 48000 }), null)
  assert.equal(decodedBytes({ durationSec: 10, channels: 0, sampleRate: 48000 }), null)
})

test('phones and tablets are recognised by device, not by window size', () => {
  assert.equal(isMobileDevice({ userAgent: IPHONE }), true)
  assert.equal(isMobileDevice({ userAgent: ANDROID }), true)
  // iPadOS reports a Mac; multi-touch gives it away.
  assert.equal(isMobileDevice({ userAgent: MAC, maxTouchPoints: 5 }), true)
  assert.equal(isMobileDevice({ userAgent: MAC, maxTouchPoints: 0 }), false)
  assert.equal(isMobileDevice({ userAgent: WINDOWS }), false)
  assert.equal(isMobileDevice(undefined), false)
})

test('the budget follows the device and what it reports', () => {
  assert.equal(memoryBudget({ userAgent: IPHONE }), MOBILE_BUDGET_BYTES)
  assert.equal(memoryBudget({ userAgent: ANDROID, deviceMemory: 4 }), 1 * GiB)
  assert.equal(memoryBudget({ userAgent: ANDROID, deviceMemory: 1 }), MOBILE_BUDGET_MIN_BYTES)
  assert.equal(memoryBudget({ userAgent: ANDROID, deviceMemory: 8 }), MOBILE_BUDGET_MAX_BYTES)
  assert.equal(memoryBudget({ userAgent: MAC }), DESKTOP_BUDGET_BYTES)
  assert.equal(memoryBudget({ userAgent: WINDOWS, deviceMemory: 4 }), 2 * GiB)
  assert.equal(memoryBudget({ userAgent: WINDOWS, deviceMemory: 8 }), DESKTOP_BUDGET_BYTES)
})

test('a phone refuses a file whose decode would not fit, before decoding it', () => {
  const budgetBytes = 1 * GiB
  // An hour of stereo: 1.38 GB, over the budget on its own.
  const hour = decodedBytes({ durationSec: 3600, channels: 2, sampleRate: 48000 })
  assert.equal(checkImport({ newBytes: hour, poolBytes: 0, budgetBytes, mobile: true }).action, 'refuse')
  // Twenty minutes of mono (230 MB) fits an empty pool…
  const chapter = decodedBytes({ durationSec: 1200, channels: 1, sampleRate: 48000 })
  assert.equal(checkImport({ newBytes: chapter, poolBytes: 0, budgetBytes, mobile: true }).action, 'ok')
  // …warns once the pool is past 60 % of the budget afterwards…
  assert.equal(checkImport({ newBytes: chapter, poolBytes: 500e6, budgetBytes, mobile: true }).action, 'warn')
  // …and is refused when decoding's peak (twice the decoded size) would not fit.
  assert.equal(checkImport({ newBytes: chapter, poolBytes: 700e6, budgetBytes, mobile: true }).action, 'refuse')
})

test('the compressed file counts toward the decode peak on a phone', () => {
  const budgetBytes = 1 * GiB
  const newBytes = 400e6
  assert.equal(checkImport({ newBytes, fileBytes: 0, poolBytes: 0, budgetBytes, mobile: true }).action, 'ok')
  assert.equal(checkImport({ newBytes, fileBytes: 300e6, poolBytes: 0, budgetBytes, mobile: true }).action, 'refuse')
})

test('a desktop never refuses; it warns past the budget', () => {
  const budgetBytes = 4 * GiB
  assert.equal(checkImport({ newBytes: 3e9, poolBytes: 0, budgetBytes, mobile: false }).action, 'ok')
  assert.equal(checkImport({ newBytes: 3e9, poolBytes: 2e9, budgetBytes, mobile: false }).action, 'warn')
  assert.equal(checkImport({ newBytes: 50e9, poolBytes: 0, budgetBytes, mobile: false }).action, 'warn')
})

test('a file whose length cannot be read is let through', () => {
  assert.equal(checkImport({ newBytes: null, poolBytes: 9e9, budgetBytes: 1, mobile: true }).action, 'ok')
})

test('the estimate uses the header channels, else assumes stereo, at the context rate', async () => {
  const probe = async () => 600 // ten minutes
  assert.equal(
    await estimateDecodedBytes({}, { sourceFormat: { channels: 1 }, sampleRate: 48000, probe }),
    600 * 48000 * 4,
  )
  assert.equal(
    await estimateDecodedBytes({}, { sourceFormat: { channels: null }, sampleRate: 44100, probe }),
    600 * 44100 * 2 * 4,
  )
  assert.equal(await estimateDecodedBytes({}, { sampleRate: 48000, probe: async () => null }), null)
})

/** An audio element stand-in that reports `duration` (or fails) on load. */
function fakeDom({ duration = 12.5, fail = false, never = false } = {}) {
  const revoked = []
  const doc = {
    createElement: () => {
      const el = {
        removeAttribute() {}, load() {},
        set src(_) {
          if (never) return
          queueMicrotask(() => {
            if (fail) el.onerror?.()
            else { el.duration = duration; el.onloadedmetadata?.() }
          })
        },
      }
      return el
    },
  }
  const url = { createObjectURL: () => 'blob:x', revokeObjectURL: (u) => revoked.push(u) }
  return { doc, url, revoked }
}

test('probeDuration reads the length from metadata and frees the object URL', async () => {
  const { doc, url, revoked } = fakeDom({ duration: 12.5 })
  assert.equal(await probeDuration({}, { doc, url }), 12.5)
  assert.deepEqual(revoked, ['blob:x'])
})

test('probeDuration resolves null on an error, a non-finite length or a timeout', async () => {
  assert.equal(await probeDuration({}, fakeDom({ fail: true })), null)
  assert.equal(await probeDuration({}, fakeDom({ duration: Infinity })), null)
  const { doc, url, revoked } = fakeDom({ never: true })
  assert.equal(await probeDuration({}, { doc, url, timeoutMs: 5 }), null)
  assert.deepEqual(revoked, ['blob:x'])
  assert.equal(await probeDuration({}, { doc: undefined, url }), null)
})

test('a refusal quotes what opening needs and what is free, not the decoded size', () => {
  const refuse = importMessage('refuse', {
    fileName: 'Ch 04.wav', newBytes: 423e6, peakBytes: 1076e6, poolBytes: 0, budgetBytes: GiB, mobile: true,
  })
  assert.match(refuse, /Ch 04\.wav is too long to open on this phone or tablet/)
  assert.match(refuse, /takes about 1\.08 GB of memory, and about 1\.07 GB is free/)
  assert.doesNotMatch(refuse, /423 MB/)
  assert.doesNotMatch(refuse, /Closing other files/)
  const crowded = importMessage('refuse', {
    fileName: 'a.wav', newBytes: 200e6, peakBytes: 900e6, poolBytes: 500e6, budgetBytes: GiB, mobile: true,
  })
  assert.match(crowded, /takes about 400 MB of memory, and about 574 MB is free\. Closing other files frees memory/)
})

test('checkImport reports the decode peak alongside the verdict', () => {
  const r = checkImport({ newBytes: 100, fileBytes: 10, poolBytes: 1000, budgetBytes: 1e9, mobile: true })
  assert.equal(r.afterBytes, 1100)
  assert.equal(r.peakBytes, 1210)
})

test('a warning names the file and its size', () => {
  assert.match(importMessage('warn', { fileName: 'a.mp3', newBytes: 820e6, budgetBytes: GiB, mobile: false }), /a\.mp3 uses about 820 MB/)
  assert.equal(importMessage('ok', { fileName: 'a.mp3', newBytes: 1, budgetBytes: 1, mobile: false }), null)
  assert.equal(formatBytes(1), '1 MB')
  assert.equal(formatBytes(1.382e9), '1.38 GB')
  assert.equal(formatBytes(12.4e9), '12.4 GB')
})

test('memory warnings and refusals are shown as warnings, not with the success tick', () => {
  const src = readFileSync(new URL('../../src/composables/useFileImport.js', import.meta.url), 'utf8')
  assert.match(src, /showToast\(message, action === 'refuse' \? 12000 : 9000, \{ tone: 'warn' \}\)/)
})

// ── Wiring ───────────────────────────────────────────────────────────────────

test('every change to the buffer pool goes through the counting helpers', () => {
  const src = readFileSync(new URL('../../src/composables/useEditorState.js', import.meta.url), 'utf8')
  const outsideHelpers = src
    .replace(/function poolSet[\s\S]*?\n}\n/, '')
    .replace(/function poolDelete[\s\S]*?\n}\n/, '')
  assert.doesNotMatch(outsideHelpers, /bufferPool\.(set|delete|clear)\(/)
})

test('import checks the memory budget before it decodes', () => {
  const src = readFileSync(new URL('../../src/composables/useFileImport.js', import.meta.url), 'utf8')
  const check = src.indexOf('await checkFits(')
  const decode = src.indexOf('await decodeAudioFile(')
  assert.ok(check > 0 && decode > 0 && check < decode)
})
