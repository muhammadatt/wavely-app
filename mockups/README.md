# Mockups

Throwaway harnesses for judging UI before wiring it. **Nothing here is imported
by the app**, and nothing here is shipped — `npm run build` does not reach it
(no entry point references it) and `npm test` does not run it.

Run one with `npx vite` and open the page:

| Page | What it is for |
|---|---|
| `/mockups/focus.html` | Four candidate treatments for putting the focus targeting nodes INSIDE the ResoTame display, instead of on a separate rail under it. |

## Why these exist

This panel has twice shipped a layout fault that reading the markup could not
catch — the soft clipper faceplate's dead space and clipped lamp, and the focus
detector row overflowing by ~56 px. The rule the codebase settled on is
*screenshot the panel, do not review a faceplate from its template*. These
harnesses are how a treatment gets screenshotted before it costs anything.

`focusFrame.js` synthesises a narration-shaped display frame so the real
`ResonanceSpectrum` can be rendered with plausible curves in it. Its reduction
curve is computed from the focus patch being drawn, so moving a node really does
move the cut — a node layer that looks fine over a static cut can still fail to
explain the cut it caused.
