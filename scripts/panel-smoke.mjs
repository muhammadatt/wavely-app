/**
 * Open every plugin panel — and the files panel — in a real browser, and fail
 * on any console error.
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

  /**
   * ⚠ CHECK THE BOOT BEFORE TOUCHING THE UI, or a module that throws at load
   * reports as a 30 s timeout waiting for a file chooser that was never going to
   * appear. Measured: a re-export without a matching local import threw
   * `ReferenceError: SCHEPS_LATENCY_SAMPLES is not defined` at module scope, the
   * app never rendered, and the only output was `waitForEvent: Timeout` — which
   * points at the harness rather than the bug. The error was already in
   * `errors`; nothing looked at it until far too late.
   */
  /**
   * ⚠ PAGEERRORS ONLY, NOT EVERY CONSOLE ERROR, and the first cut of this check
   * got that wrong and failed a healthy app. A dev server being spawned and
   * killed between runs leaves transient `net::ERR_CONNECTION_RESET` console
   * entries that say nothing about whether the code loaded. An UNCAUGHT
   * EXCEPTION is the signal this gate exists for — that is what a module
   * throwing at load produces, and it cannot be ambient.
   *
   * The per-panel checks below still count every console error, because there
   * they are scoped to one panel opening rather than to whatever the page did
   * while starting.
   */
  const bootFailures = errors.filter(e => e.startsWith('PAGEERROR'))
  if (bootFailures.length) {
    console.error('the app failed to boot:')
    for (const e of bootFailures) console.error(`  ${e}`)
    await browser.close()
    if (server) server.kill()
    process.exit(1)
  }

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

  /**
   * The files panel, which is not a plugin window and so is not in PANELS.
   *
   * ⚠ THIS CHECKS WHAT EACH CONTROL DOES, NOT ONLY THAT THE PANEL RENDERS, and
   * that is the whole reason it is here. Its three shipped bugs were all
   * behavioural and all invisible to a render check: the dismiss ✕ closed the
   * *file* instead of the panel, double-click-to-rename lost a fight with the
   * row's own click handler and never opened an input, and Escape out of a
   * rename dismissed the panel along with it.
   *
   * ⚠ NOTHING HERE KEYS OFF A SELECTOR THAT ONLY THE FIXED PANEL HAS. The first
   * cut located the panel by the `role="dialog"` added in the same change, so
   * against the broken panel it reported "did not open" and never reached a
   * single behavioural assertion — it passed for the wrong reason and would have
   * kept passing through a regression of all three bugs. Everything below is
   * found by what both versions render (the search box, the file's own name) or
   * counted before it is clicked, so each line fails on its own.
   */
  {
    const before = errors.length
    // Present in every version of this panel, so "open" means open.
    const search = page.locator('input[placeholder="Search open files…"]')
    const isOpen = () => search.isVisible().catch(() => false)
    const renameInput = page.locator('input[aria-label="File name"]')
    const visible = async loc => (await loc.count()) > 0 && await loc.first().isVisible().catch(() => false)

    await page.keyboard.press('Control+p'); await page.waitForTimeout(500)
    const opened = await isOpen()

    // Double-click the name. The row's own click handler used to fire first and
    // dismiss the panel, so the rename input never mounted.
    let dblclickOk = false
    if (opened) {
      // Scoped by the waveform thumbnail: the tab strip behind the overlay
      // renders a div carrying the same filename in its title, and an unscoped
      // locator picks that one and then waits 30 s for the overlay to stop
      // intercepting the click.
      await page.locator('.group').filter({ has: page.locator('canvas') }).first()
        .locator(`div[title*="${'wavely-panel-smoke'}"]`).first().dblclick().catch(() => {})
      await page.waitForTimeout(350)
      dblclickOk = await visible(renameInput) && await isOpen()
      if (dblclickOk) { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
    }

    // Escape out of a rename must close the input and leave the panel standing.
    let escapeOk = false
    if (await isOpen()) {
      const pencil = page.locator('[aria-label^="Rename "]')
      if (await pencil.count()) {
        await pencil.first().click(); await page.waitForTimeout(300)
        const editing = await visible(renameInput)
        await page.keyboard.press('Escape'); await page.waitForTimeout(300)
        escapeOk = editing && !(await visible(renameInput)) && await isOpen()
      }
    }

    // Save, Save As and the per-file Close are each a button with a name on it.
    const actionsOk = await isOpen()
      && await visible(page.getByRole('button', { name: 'Save', exact: true }))
      && await visible(page.getByRole('button', { name: 'Save As…' }))
      && await visible(page.locator('[aria-label^="Close "]:not([aria-label="Close files panel"])'))

    // The dismiss ✕ closes the PANEL. The file it was listing stays open —
    // reopening and finding it still counted is the assertion that matters.
    let dismissOk = false
    if (await isOpen()) {
      const dismiss = page.locator('[aria-label="Close files panel"]')
      if (await dismiss.count()) {
        await dismiss.first().click(); await page.waitForTimeout(400)
        const gone = !(await isOpen())
        await page.keyboard.press('Control+p'); await page.waitForTimeout(500)
        // "1/1" is the search row's match count, rendered by every version.
        dismissOk = gone && await visible(page.getByText('1/1'))
      }
    }
    if (await isOpen()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }

    const fresh = errors.slice(before)
    const ok = opened && dblclickOk && escapeOk && actionsOk && dismissOk && fresh.length === 0
    if (!ok) failures++
    const why = [
      opened ? '' : 'did not open; ',
      dblclickOk ? '' : 'double-click on the name did not start a rename; ',
      escapeOk ? '' : 'Escape out of a rename misbehaved; ',
      actionsOk ? '' : 'per-file Save / Save As / Close missing; ',
      dismissOk ? '' : 'dismiss ✕ did not close the panel and leave the file open; ',
    ].join('')
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${'Files panel'.padEnd(16)} ${why}${fresh.join(' | ')}`)
  }
} finally {
  await browser.close()
  server?.kill()
}

console.log(failures ? `\n${failures} panel(s) failed` : '\nall panels opened clean')
process.exit(failures ? 1 : 0)
