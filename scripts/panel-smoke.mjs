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
 * "Opto Comp" (now "LA Vintage 2A"). A miss is a failure.
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
  'LA Vintage 2A', 'LA Classic 76', 'Soft Clipper', 'Scheps Parallel',
  'Reso Soothe', 'EQ', 'Air Boost', 'De-Esser', 'HF Limiter', 'PHAT*SS', 'Saturation Bench', 'Cambridge Inflator', 'Tube Sat',
  'Loudness Normalize', 'Auto Leveler', 'Plosive Tamer', 'Noise Reduction', 'VoxPressor',
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
// Opening goes through showOpenFilePicker where the browser has it, and
// Playwright raises no 'filechooser' for that picker. Hide it so the app falls
// back to the <input type="file"> path, which Playwright can drive.
await page.addInitScript(() => { window.showOpenFilePicker = undefined })
const errors = []
page.on('pageerror', e => errors.push(`PAGEERROR ${e.message}`))
/**
 * ⚠ SOME VUE WARNINGS ARE FAILURES, AND THIS RAN GREEN OVER ONE. A stray
 * `<SavePen />` — a component tag nothing imports — sat inside a live button
 * and shipped: Vue reports an unresolvable component with `console.warn`, not
 * `error`, so nothing here saw it, and `test/ui/componentBindings.test.js` is
 * blind to it too (it reads identifiers in template EXPRESSIONS, and a bare tag
 * is not one). Copilot caught it on review, which is not a gate.
 *
 * Only the warnings that mean "this template is wrong" are promoted; Vue's
 * chattier advice is left alone, because a gate that fires on everything gets
 * switched off.
 */
const FATAL_WARNINGS = /Failed to resolve component|Invalid VNode type|is not a valid prop name|was accessed during render but is not defined/
page.on('console', m => {
  const text = m.text().slice(0, 200)
  if (m.type() === 'error') errors.push(`CONSOLE ${text}`)
  else if (m.type() === 'warning' && FATAL_WARNINGS.test(text)) errors.push(`WARNING ${text}`)
})

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
   * The plugin chain, checked for what it DOES: opening plugins adds nothing
   * to it; a plugin outside the chain opens alone and the chain counts as a
   * plugin; a plugin IN the chain still opens alone as its solo copy; the Add picker is the way in and its plugins open beside the chain
   * with no Apply of their own; the arrows reorder; Apply commits every live
   * slot in order as one edit and bypasses them afterwards.
   */
  {
    const before = errors.length
    const openOp = async (name) => {
      await page.keyboard.press('Control+k'); await page.waitForTimeout(250)
      await page.keyboard.type(name); await page.waitForTimeout(450)
      await page.keyboard.press('Enter'); await page.waitForTimeout(2000)
    }
    const frames = () => page.locator('.win-frame').count()
    const chainWin = page.locator('.win-frame').filter({ hasText: 'PLUGIN CHAIN' })
    const rowNames = () => chainWin.locator('.pc-name').allInnerTexts()
    const addFromPicker = async (label) => {
      await chainWin.getByRole('button', { name: 'Add plugin', exact: true }).dispatchEvent('click'); await page.waitForTimeout(300)
      await page.keyboard.type(label); await page.waitForTimeout(250)
      await page.keyboard.press('Enter'); await page.waitForTimeout(2000)
    }

    // A plugin outside the chain opens alone, and the chain counts as a plugin.
    await openOp('Inflator')
    await openOp('Air Boost')
    const soloWindows = await frames()
    await openOp('Plugin Chain')
    const chainReplaced = (await frames()) === 1 && (await chainWin.count()) === 1
    // Every panel opened above — none of them joined the chain.
    const kept = (await rowNames()).length

    // The picker is the way in; its plugins open beside the chain.
    await addFromPicker('Inflator')
    await addFromPicker('Air Boost')
    const groupWindows = await frames()
    const inflatorWin = page.locator('.win-frame').filter({ hasText: 'IN CHAIN · 1' })
    const memberApplyOff = await inflatorWin.locator('.win-apply').isDisabled().catch(() => false)

    // A plugin outside the chain bypasses it (it must preview what its own
    // Apply writes), and the chain STAYS bypassed when it closes: only the
    // user turns it back on, from the chain window's master switch.
    const chainBadge = () => page.locator('.chain-count').innerText().catch(() => '')
    const liveBefore = await chainBadge()
    await openOp('LA Vintage 2A')
    const pausedBadge = await chainBadge()
    await page.keyboard.press('Escape'); await page.waitForTimeout(400)
    const closedBadge = await chainBadge()
    const masterOn = async () => {
      await chainWin.locator('.win-pill-m').first().dispatchEvent('click'); await page.waitForTimeout(300)
    }
    await openOp('Plugin Chain')
    await masterOn()
    const resumedBadge = await chainBadge()
    const pauseOk = liveBefore === 'ACTIVE' && pausedBadge === 'BYPASSED' && closedBadge === 'BYPASSED'
      && resumedBadge === 'ACTIVE'

    // A plugin that is ALSO in the chain still opens on its own: its solo copy,
    // alone, with a live Apply and no IN CHAIN badge — the chain suspended
    // underneath and its slot untouched.
    await openOp('Inflator')
    const soloCopyAlone = (await frames()) === 1
      && (await page.locator('.win-frame').filter({ hasText: 'IN CHAIN' }).count()) === 0
      && !(await page.locator('.win-frame .win-apply').isDisabled())
      && (await chainBadge()) === 'BYPASSED'
    await page.keyboard.press('Escape'); await page.waitForTimeout(400)
    await openOp('Plugin Chain')
    const slotKept = (await rowNames()).join(',') === 'Cambridge Inflator,AirBoost' && (await chainBadge()) === 'BYPASSED'
    await masterOn()

    const order1 = await rowNames()
    await chainWin.getByRole('button', { name: 'Move Cambridge Inflator later' }).dispatchEvent('click')
    await page.waitForTimeout(300)
    const order2 = await rowNames()

    await chainWin.locator('.win-apply').dispatchEvent('click')
    const toast = await page.getByText('Chain applied — AirBoost → Cambridge Inflator').waitFor({ timeout: 20000 })
      .then(() => true, () => false)
    await page.waitForTimeout(500)
    // The whole chain is bypassed; each slot keeps its own ON.
    const pills = await chainWin.locator('.pc-row .m-pill-text').allInnerTexts()
    const masterPill = await chainWin.locator('.win-pill-m').first().getAttribute('aria-pressed')
    const bypassedAfter = pills.length === 2 && pills.every(t => t === 'ON') && masterPill === 'false'
      && (await page.locator('.chain-count').innerText()) === 'BYPASSED'
      && await chainWin.locator('.win-apply').isDisabled()

    // A plugin can take more than one slot; the slots are numbered, and a
    // removed one's number is the next to be handed out again.
    await addFromPicker('Inflator')
    const twice = (await rowNames()).join(',')
    await chainWin.getByRole('button', { name: 'Remove Cambridge Inflator 1 from the chain' }).dispatchEvent('click')
    await page.waitForTimeout(300)
    const afterRemove = (await rowNames()).join(',')
    await addFromPicker('Inflator')
    const readded = (await rowNames()).join(',')
    const repeatsOk = twice === 'AirBoost,Cambridge Inflator 1,Cambridge Inflator 2' && afterRemove === 'AirBoost,Cambridge Inflator'
      && readded === 'AirBoost,Cambridge Inflator 2,Cambridge Inflator 1'

    // A plugin outside the chain takes the whole chain group off the screen.
    await openOp('LA Vintage 2A')
    const soloAfterGroup = await frames()
    await openOp('Plugin Chain')
    await chainWin.getByRole('button', { name: 'Clear' }).dispatchEvent('click'); await page.waitForTimeout(300)
    await page.keyboard.press('Escape'); await page.waitForTimeout(400)

    const fresh = errors.slice(before)
    const ok = soloWindows === 1 && chainReplaced && kept === 0 && groupWindows === 3 && memberApplyOff
      && order1.join(',') === 'Cambridge Inflator,AirBoost' && order2.join(',') === 'AirBoost,Cambridge Inflator'
      && toast && bypassedAfter && soloAfterGroup === 1 && pauseOk && soloCopyAlone && slotKept && repeatsOk
      && fresh.length === 0
    if (!ok) failures++
    const why = [
      soloWindows === 1 ? '' : `${soloWindows} solo plugin windows open at once; `,
      chainReplaced ? '' : 'opening the chain did not replace the open plugin; ',
      kept === 0 ? '' : `opening panels put ${kept} plugin(s) in the chain; `,
      groupWindows === 3 ? '' : `chain + 2 plugins should be 3 windows, got ${groupWindows}; `,
      memberApplyOff ? '' : 'a plugin in the chain still has a live Apply; ',
      order1.join(',') === 'Cambridge Inflator,AirBoost' ? '' : `picker did not append in order (${order1.join(',')}); `,
      order2.join(',') === 'AirBoost,Cambridge Inflator' ? '' : `move did not reorder (${order2.join(',')}); `,
      toast ? '' : 'Apply did not report the chain in order; ',
      bypassedAfter ? '' : `apply should bypass the chain and keep the slots on (slots ${pills.join(',')}, chain ON=${masterPill}); `,
      soloAfterGroup === 1 ? '' : `a solo plugin left ${soloAfterGroup} windows open; `,
      pauseOk ? '' : `chain should bypass for a solo plugin, stay bypassed after it closes and come back on its switch (${liveBefore} → ${pausedBadge} → ${closedBadge} → ${resumedBadge}); `,
      soloCopyAlone ? '' : 'a plugin in the chain did not open on its own with its own Apply; ',
      slotKept ? '' : 'opening the solo copy disturbed the chain slot; ',
      repeatsOk ? '' : `repeat slots misnumbered (${twice} / ${afterRemove} / ${readded}); `,
    ].join('')
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${'Plugin chain'.padEnd(16)} ${why}${fresh.join(' | ')}`)
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
    // The panel's first file row. Scoped by the waveform thumbnail, which only
    // this panel's rows render — the tab strip and the top bar carry buttons
    // with the same names, and an unscoped locator finds those instead.
    const panelRow = () => page.locator('.group').filter({ has: page.locator('canvas') }).first()
    const visible = async loc => (await loc.count()) > 0 && await loc.first().isVisible().catch(() => false)

    await page.keyboard.press('Control+p'); await page.waitForTimeout(500)
    const opened = await isOpen()

    // Double-click the name. The row's own click handler used to fire first and
    // dismiss the panel, so the rename input never mounted.
    let dblclickOk = false
    if (opened) {
      // Scoped by the waveform thumbnail: the tab strip behind the overlay
      // renders an element carrying the same filename in its title, and an
      // unscoped locator picks that one and then waits 30 s for the overlay to
      // stop intercepting the click.
      //
      // ⚠ MATCHED ON THE TITLE, NOT THE TAG. This read `div[title*=…]` and went
      // red when the name became a <span> — the rename it was checking still
      // worked. The row's own element shape is not part of the contract.
      await panelRow().locator(`[title*="${'wavely-panel-smoke'}"]`)
        .first().dblclick().catch(() => {})
      await page.waitForTimeout(350)
      dblclickOk = await visible(renameInput) && await isOpen()
      if (dblclickOk) { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
    }

    // Escape out of a rename must close the input and leave the panel standing.
    let escapeOk = false
    if (await isOpen()) {
      const pencil = panelRow().locator('[aria-label^="Rename "]')
      if (await pencil.count()) {
        await pencil.first().click(); await page.waitForTimeout(300)
        const editing = await visible(renameInput)
        await page.keyboard.press('Escape'); await page.waitForTimeout(300)
        escapeOk = editing && !(await visible(renameInput)) && await isOpen()
      }
    }

    // The row click ticks the file for export, the way the export dialog's rows
    // do — and every per-file control has to survive sitting inside that click
    // target. The pencil stands in for all of them: it is the one that can be
    // driven here without opening a file picker, and they all carry the same
    // @click.stop.
    let tickOk = false
    if (await isOpen()) {
      const row = panelRow()
      const box = row.locator('[aria-label^="Select "]').first()
      const ticked = async () => (await box.getAttribute('aria-pressed')) === 'true'
      await row.locator('canvas').first().click(); await page.waitForTimeout(250)
      const onAfterRowClick = await ticked()
      await row.locator('[aria-label^="Rename "]').first().click(); await page.waitForTimeout(250)
      const stillOnAfterRename = await ticked() && await visible(renameInput)
      await page.keyboard.press('Escape'); await page.waitForTimeout(250)
      await row.locator('canvas').first().click(); await page.waitForTimeout(250)
      tickOk = onAfterRowClick && stillOnAfterRename && !(await ticked())
    }

    // Go to, Save, Save As and the per-file Close are each a button of its own.
    //
    // ⚠ FOUND BY ACCESSIBLE NAME, NOT BY VISIBLE TEXT. These were text buttons
    // and are now lucide icons; the labels moved into aria-label and title and
    // the actions did not change, so the check follows the name rather than
    // going red over an icon swap. An unnamed icon button IS a failure here —
    // that is the thing worth holding.
    //
    // ⚠ SCOPED TO THE ROW, and that is not tidiness. Unscoped, every one of
    // these matched something else on the page — the top bar's own Save
    // (text "Save"), its Save As dropdown (aria-label "Save As"), the tab
    // strip's per-tab ✕ (`Close <name>`) — so the check passed with the panel's
    // buttons deleted. Mutation-tested: removing the Save button's aria-label
    // reported ok until this was scoped.
    const actionsOk = await isOpen() && await (async () => {
      const row = panelRow()
      return await visible(row.locator('[aria-label^="Switch to "]'))
        && await visible(row.locator('[aria-label^="Save "]:not([aria-label$="as a new file"])'))
        && await visible(row.locator('[aria-label$="as a new file"]'))
        && await visible(row.locator('[aria-label^="Close "]'))
    })()

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
    // Export runs HERE, not in the export dialog. The panel used to hand its
    // ticked set over and open that dialog, so the assertion that matters is a
    // file actually arriving from a click in this panel.
    let exportOk = false
    if (await isOpen()) {
      const row = panelRow()
      await row.locator('canvas').first().click(); await page.waitForTimeout(250)
      const download = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
      // Scoped to the panel: the top bar has an Export button too, and an
      // unscoped locator is a strict-mode violation rather than a miss.
      await page.getByRole('dialog', { name: 'Files' })
        .getByRole('button', { name: 'Export' }).click()
      const got = await download
      await page.waitForTimeout(500)
      // A single ticked file downloads as itself, not as a zip — and the panel
      // dismisses once the bytes are handed over.
      exportOk = !!got && got.suggestedFilename().endsWith('.wav') && !(await isOpen())
    }

    if (await isOpen()) { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }

    const fresh = errors.slice(before)
    const ok = opened && dblclickOk && escapeOk && tickOk && actionsOk && dismissOk
      && exportOk && fresh.length === 0
    if (!ok) failures++
    const why = [
      opened ? '' : 'did not open; ',
      dblclickOk ? '' : 'double-click on the name did not start a rename; ',
      escapeOk ? '' : 'Escape out of a rename misbehaved; ',
      tickOk ? '' : 'row click did not tick the file, or a per-file button ticked it; ',
      actionsOk ? '' : 'per-file Go to / Save / Save As / Close missing or unnamed; ',
      dismissOk ? '' : 'dismiss ✕ did not close the panel and leave the file open; ',
      exportOk ? '' : 'Export from the files panel did not deliver a file; ',
    ].join('')
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${'Files panel'.padEnd(16)} ${why}${fresh.join(' | ')}`)
  }

  /**
   * A PHONE, held sideways, driven by touch. The desktop pass above never
   * touches the screen, and every touch path in the editor is wiring a unit
   * test cannot see: pointer capture on the waveform, the long-press timer,
   * the ghost click it must swallow, and FloatingWindow turning into a sheet.
   * Measured before these existed: a drag on the waveform selected nothing,
   * and lifting a long press ran the menu item under the finger (Split).
   */
  {
    const before = errors.length
    const phone = await browser.newContext({
      viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    })
    const pp = await phone.newPage()
    await pp.addInitScript(() => { window.showOpenFilePicker = undefined })
    pp.on('pageerror', e => errors.push(`PAGEERROR (phone) ${e.message}`))
    const why = []
    try {
      await pp.goto(URL_, { waitUntil: 'networkidle' })
      const chooserP = pp.waitForEvent('filechooser')
      await pp.getByText('Choose audio files').click()
      await (await chooserP).setFiles(wav)
      await pp.waitForTimeout(3000)

      const cdp = await phone.newCDPSession(pp)
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })),
      })
      const box = await pp.locator('canvas.waveform-canvas').boundingBox()
      const y = box.y + box.height / 2
      const at = f => box.x + box.width * f
      const onCanvas = await pp.evaluate(([x, yy]) =>
        document.elementFromPoint(x, yy)?.classList.contains('waveform-canvas'), [at(0.5), y])
      if (!onCanvas) why.push('something covers the waveform on a phone; ')

      // One-finger drag selects.
      await touch('touchStart', [[at(0.2), y]])
      for (let f = 0.25; f <= 0.5; f += 0.05) { await touch('touchMove', [[at(f), y]]); await pp.waitForTimeout(16) }
      await touch('touchEnd', [])
      await pp.waitForTimeout(200)
      const selected = await pp.locator('.selection-bar').innerText()
      if (!/\d:\d\d\.\d\d[\s\S]*→[\s\S]*\d:\d\d\.\d\d/.test(selected)) why.push('a touch drag did not select; ')

      // Two-finger pinch zooms in: the scrollbar thumb appears once the whole
      // file no longer fits, and the selection survives the second finger.
      await touch('touchStart', [[at(0.45), y], [at(0.55), y]])
      for (let k = 1; k <= 10; k++) {
        await touch('touchMove', [[at(0.45 - k * 0.02), y], [at(0.55 + k * 0.02), y]])
        await pp.waitForTimeout(16)
      }
      await touch('touchEnd', [])
      await pp.waitForTimeout(200)
      if (!(await pp.locator('.wf-thumb').count())) why.push('a pinch did not zoom; ')
      if ((await pp.locator('.selection-bar').innerText()) !== selected) why.push('a pinch changed the selection; ')

      // Long press opens the menu, and lifting must not run what is under the finger.
      // Checked as "did a click reach the menu at all", not "is the menu still
      // open": the item under the finger may be disabled, and a click on that
      // closes nothing — which let this pass with the guard removed. Counted on
      // `document`, beneath the window-level listener that swallows it.
      const menu = pp.locator('[role=menu][aria-label="Waveform actions"]')
      await pp.evaluate(() => {
        window.__menuClicks = 0
        document.addEventListener('click', e => { if (e.target.closest?.('[role=menu]')) window.__menuClicks++ }, true)
      })
      await touch('touchStart', [[at(0.5), y]])
      await pp.waitForTimeout(700)
      const opened = await menu.count()
      await touch('touchEnd', [])
      await pp.waitForTimeout(300)
      const menuClicks = await pp.evaluate(() => window.__menuClicks)
      if (!opened) why.push('long press did not open the menu; ')
      else if (menuClicks || !(await menu.count())) why.push('lifting a long press clicked the menu item under the finger; ')
      await pp.keyboard.press('Escape')

      // A plugin opens as a full-screen sheet with Apply on screen.
      await pp.keyboard.press('Control+k'); await pp.waitForTimeout(250)
      await pp.keyboard.type('PHAT*SS'); await pp.waitForTimeout(400)
      await pp.keyboard.press('Enter'); await pp.waitForTimeout(900)
      const sheet = await pp.evaluate(() => {
        const f = document.querySelector('.win-frame')
        const a = f?.querySelector('.win-apply')?.getBoundingClientRect()
        return { isSheet: !!f?.classList.contains('is-sheet'), applyOnScreen: !!a && a.bottom <= innerHeight && a.right <= innerWidth }
      })
      if (!sheet.isSheet) why.push('plugin did not open as a sheet; ')
      if (!sheet.applyOnScreen) why.push('Apply is off screen in the sheet; ')
      await pp.keyboard.press('Escape'); await pp.waitForTimeout(300)

      // ⚠ A ZOOMED-OUT PAGE. On a mobile browser innerWidth / innerHeight are
      // the VISUAL viewport and grow when the page zooms out (anything
      // overflowing sideways does it): an iPhone 16 read 701 x 1518. Sized from
      // them, EQ stayed a floating desktop window with Apply off the screen.
      // The sheet has to follow the layout viewport, so the visual one is made
      // to lie here and EQ (narrow enough to float on a wide screen) must
      // still open as a sheet.
      await pp.evaluate(() => {
        Object.defineProperty(window, 'innerWidth', { get: () => 1400, configurable: true })
        Object.defineProperty(window, 'innerHeight', { get: () => 900, configurable: true })
      })
      await pp.keyboard.press('Control+k'); await pp.waitForTimeout(250)
      await pp.keyboard.type('EQ'); await pp.waitForTimeout(400)
      await pp.keyboard.press('Enter'); await pp.waitForTimeout(900)
      const zoomed = await pp.evaluate(() => {
        const f = document.querySelector('.win-frame')
        const a = f?.querySelector('.win-apply')?.getBoundingClientRect()
        const de = document.documentElement
        return { isSheet: !!f?.classList.contains('is-sheet'), applyOnScreen: !!a && a.bottom <= de.clientHeight && a.right <= de.clientWidth }
      })
      if (!zoomed.isSheet || !zoomed.applyOnScreen) why.push('with the page zoomed out a plugin floated with Apply off screen; ')
    } catch (e) {
      why.push(`threw: ${e.message.split('\n')[0]}; `)
    } finally {
      await phone.close()
    }
    const fresh = errors.slice(before)
    const ok = why.length === 0 && fresh.length === 0
    if (!ok) failures++
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${'Phone (touch)'.padEnd(16)} ${why.join('')}${fresh.join(' | ')}`)
  }
} finally {
  await browser.close()
  server?.kill()
}

console.log(failures ? `\n${failures} panel(s) failed` : '\nall panels opened clean')
process.exit(failures ? 1 : 0)
