/**
 * Developer-only feature flags.
 *
 * These gate UI that exists for tuning the processing chain, not for using it.
 * The distinction matters: the sibilance detector's parameters are calibration
 * constants fitted against narrator recordings, several with open TODOs in
 * sibilance_detector.py. Exposing them to someone who is trying to de-ess an
 * audiobook is worse than useless — it invites a session tuned into a corner
 * with no way back.
 *
 * NOT A PERMISSION CHECK, AND NOT MEANT TO BE. This is a build-time constant so
 * the guarded code is *removed* from production bundles rather than hidden in
 * them: Vite substitutes a literal for `import.meta.env.*`, and the minifier
 * drops the dead branch and everything only it referenced. A `localStorage`
 * toggle would have been friendlier to flip on a deployed build, but it ships
 * the panel to every user and relies on them not finding the switch.
 *
 * On by default under `vite dev`. For a build — say, tuning against a staging
 * deployment — set VITE_DEV_PANELS=1 in .env.local, which is not committed.
 *
 * If you add a flag here, check the production bundle afterwards — `node --test`
 * cannot see a Vite build, so this is a manual check rather than a test:
 *
 *   put a distinctive marker string inside the guard, then
 *   `npx vite build && grep -r MARKER dist/`   -> absent
 *   `VITE_DEV_PANELS=1 npx vite build && grep -r MARKER dist/`  -> present
 *
 * Verified that way when this file was added.
 */

/** Tuning UI for the sibilance detector's calibration constants. */
export const DEV_TUNING_PANELS =
  import.meta.env.DEV || import.meta.env.VITE_DEV_PANELS === '1'
