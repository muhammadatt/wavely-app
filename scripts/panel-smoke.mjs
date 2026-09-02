/**
 * Open every plugin panel in a real browser and fail on any console error.
 *
 *   npm run smoke
 *
 * ⚠ THIS EXISTS BECAUSE `npm test` CANNOT SEE THIS CLASS OF BUG AND NEITHER CAN
 * `vite build`. A composable that references an identifier it never declares
 * compiles cleanly and throws a ReferenceError on the panel's first render —
 * for every user, every time. It has now shipped twice from the same cause: a
 * scripted edit that applied to one file and silently missed the sibling it was
 * meant to match. `test/ui/componentBindings.test.js` catches the template→script
 * shape of this by reading source; nothing catches the script→module-scope shape,
 * because the composables' import chain reaches `?worker&url` specifiers that
 * only Vite resolves, so they cannot be imported under node.
 *
 * The only instrument that sees it is a browser. This is that instrument, run
 * the way `npm run scorecard:real` and `npm run reso:real` are — outside the
 * unit suite, because it needs a dev server and a browser.
 *
 * ⚠ IT ASSERTS "OPENED", NOT JUST "NO ERROR". A panel whose command-palette
 * entry has been renamed silently fails to open and then reports clean, which is
 * how the first run of this missed OptoSmooth entirely — its registry label is
 * "Opto Comp". A miss is a failure.
 *
 * The audio is generated here rather than read from data/corpus/, which is
 * gitignored: this checks that panels render, not what they sound like.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.SMOKE_PORT ?? 5199)
const URL_ = `http://localhost:${PORT}/`

/** Command-palette search terms. These are the REGISTRY labels, not our names. */
const PANELS = [
  'Opto Comp', 'FET Punch', 'Soft Clipper', 'Scheps Parallel',
  'Reso', 'EQ', 'Air Boost', 'De-Esser', 'Inflator', 'Tube Sat',
]

function writeProbeWav(path) {
  const sr = 44100, n = sr * 6, b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const env = (0.5 + 0.5 * Math.sin(2 * Math.PI * 3.7 * t)) ** 2
    const k = i % sr
    const transient = k < 200 ? 0.8 * Math.exp(-k / 40) : 0
    const v = 0.25 * env * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 3000 * t)) + transient
    b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2)
  }
  writeFileSync(path, b)
}

async function waitForServer(ms = 40000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { if ((await fetch(URL_)).ok) return true } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 400))
  }
  return false
}

const wav = join(tmpdir(), 'wavely-panel-smoke.wav')
writeProbeWav(wav)

let server = null
if (!(await waitForServer(1000))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
  if (!(await waitForServer())) { console.error('dev server did not start'); process.exit(1) }
}

/**
 * ⚠ HONOURS AN EXPLICIT BROWSER PATH. Environments that pre-install Chromium
 * outside Playwright's own cache (CI images, this repo's remote sandbox) have a
 * working browser that `chromium.launch()` refuses to find, and the error it
 * gives — "run npx playwright install" — points at the wrong problem.
 */
const executablePath = process.env.SMOKE_CHROMIUM
  ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message}`))
page.on('console', m => { if (m.type() === 'error') errors.push(`CONSOLE ${m.text().slice(0, 200)}`) })

let failures = 0
try {
  await page.goto(URL_, { waitUntil: 'networkidle' })
  const chooser = page.waitForEvent('filechooser')
  await page.getByText('Choose audio files').click()
  await (await chooser).setFiles(wav)
  await page.waitForTimeout(4000)
  await page.getByText('Select All', { exact: false }).first().click()
  await page.waitForTimeout(600)

  for (const name of PANELS) {
    const before = errors.length
    await page.keyboard.press('Control+k'); await page.waitForTimeout(250)
    await page.keyboard.type(name); await page.waitForTimeout(450)
    await page.keyboard.press('Enter'); await page.waitForTimeout(3000)
    const opened = await page.evaluate(() => !!document.querySelector('.win-frame'))
    const fresh = errors.slice(before)
    const ok = opened && fresh.length === 0
    if (!ok) failures++
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(16)} ${opened ? '' : 'did not open (renamed in the registry?) '}${fresh.join(' | ')}`)
    await page.keyboard.press('Escape'); await page.waitForTimeout(400)
  }
} finally {
  await browser.close()
  server?.kill()
}

console.log(failures ? `\n${failures} panel(s) failed` : '\nall panels opened clean')
process.exit(failures ? 1 : 0)
