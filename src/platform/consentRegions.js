/**
 * Which consent model a visitor's country gets — shared by the browser
 * (`consent.js`) and the server (`server/routes/consent.js`), so the two can
 * never disagree about who is asked.
 *
 *   'opt-in'  — nothing that tracks runs until the visitor says yes (GDPR +
 *               ePrivacy: the EEA, the UK, Switzerland). An UNKNOWN country is
 *               opt-in too: a failed lookup must never be the reason a pixel
 *               fired on someone in Berlin.
 *   'opt-out' — ads run by default; the footer's "Your privacy choices" turns
 *               them off and Global Privacy Control is honoured (US state laws).
 *
 * Extending the opt-in list is a data change here and nothing else.
 */

/** EU 27 + EEA (Iceland, Liechtenstein, Norway) + UK + Switzerland. ISO 3166-1 alpha-2. */
export const OPT_IN_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB', 'CH',
])

/** Normalise a country code; Cloudflare's XX (unknown) and T1 (Tor) read as unknown. */
export function normalizeCountry(code) {
  if (typeof code !== 'string') return null
  const c = code.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX' || c === 'T1') return null
  return c
}

/** @returns {'opt-in' | 'opt-out'} */
export function consentModelFor(country) {
  const c = normalizeCountry(country)
  if (c === null) return 'opt-in'
  return OPT_IN_COUNTRIES.has(c) ? 'opt-in' : 'opt-out'
}
