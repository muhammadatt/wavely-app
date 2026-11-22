/**
 * Loading and revoking the ad pixels. Called ONLY by `consent.js` — nothing
 * else may inject a vendor script, or the "nothing before a yes" rule has a
 * hole in it (`test/ui/consent.test.js` checks no other module names the
 * vendors' hosts).
 *
 * Google: Consent Mode v2, BASIC — the default (everything denied) is set and
 * then updated to granted in the same breath, and only then is gtag.js
 * requested. `analytics_storage` stays denied: there is no analytics vendor,
 * and a yes to advertising is not a yes to analytics.
 *
 * Meta: the standard pixel bootstrap, with `fbq('consent', 'grant')` ahead of
 * `init`. A revoke calls `fbq('consent', 'revoke')`, which stops further
 * events on this page.
 *
 * On revoke the vendors' first-party cookies are deleted as well (they are
 * set on this site's domain, so this site can and must remove them).
 */

const META_SRC = 'https://connect.facebook.net/en_US/fbevents.js'
const GTAG_SRC = 'https://www.googletagmanager.com/gtag/js'

const AD_COOKIES = /^(_fbp|_fbc|_gcl_[a-z]+|_gac_.*|IDE|test_cookie)$/

let metaLoaded = false
let googleLoaded = false
let granted = false

function injectScript(src) {
  const s = document.createElement('script')
  s.async = true
  s.src = src
  s.dataset.consent = 'ads'
  document.head.appendChild(s)
}

function loadMeta(pixelId) {
  if (metaLoaded) { window.fbq('consent', 'grant'); return }
  metaLoaded = true
  // Meta's own bootstrap, minus the inline <script> tag: queue calls until
  // fbevents.js arrives.
  const fbq = function (...args) { fbq.callMethod ? fbq.callMethod(...args) : fbq.queue.push(args) }
  if (!window._fbq) window._fbq = fbq
  fbq.push = fbq
  fbq.loaded = true
  fbq.version = '2.0'
  fbq.queue = []
  window.fbq = fbq
  injectScript(META_SRC)
  fbq('consent', 'grant')
  fbq('init', pixelId)
  fbq('track', 'PageView')
}

function gtag() { window.dataLayer.push(arguments) } // eslint-disable-line prefer-rest-params -- gtag reads an Arguments object

function loadGoogle(adsId) {
  window.dataLayer = window.dataLayer || []
  window.gtag = window.gtag || gtag
  if (!googleLoaded) {
    window.gtag('consent', 'default', {
      ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied',
    })
  }
  window.gtag('consent', 'update', { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' })
  if (googleLoaded) return
  googleLoaded = true
  window.gtag('js', new Date())
  window.gtag('config', adsId)
  injectScript(`${GTAG_SRC}?id=${encodeURIComponent(adsId)}`)
}

function revokeAll() {
  if (metaLoaded) window.fbq('consent', 'revoke')
  if (googleLoaded) {
    window.gtag('consent', 'update', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' })
  }
  deleteAdCookies()
}

/** Remove the vendors' cookies on this host and on each parent domain. */
export function deleteAdCookies(doc = document, host = location.hostname) {
  const names = doc.cookie.split(';').map(c => c.split('=')[0].trim()).filter(n => AD_COOKIES.test(n))
  if (names.length === 0) return
  const parts = host.split('.')
  const domains = ['']
  for (let i = 0; i < parts.length - 1; i++) domains.push(`; domain=.${parts.slice(i).join('.')}`)
  for (const name of names) {
    for (const d of domains) doc.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d}`
  }
}

/** `consent.js`'s `apply`: load every configured vendor, or revoke them. */
export function applyAdPixels(ads, { metaPixelId, googleAdsId } = {}) {
  if (typeof window === 'undefined') return
  granted = Boolean(ads)
  if (!ads) { revokeAll(); return }
  if (metaPixelId) loadMeta(metaPixelId)
  if (googleAdsId) loadGoogle(googleAdsId)
}

/**
 * A conversion or custom event, sent to whichever pixels are loaded. Safe to
 * call at any time: with no consent nothing is loaded and nothing is sent.
 *
 * @param {string} metaEvent    e.g. 'Lead', 'ViewContent'
 * @param {object} [params]
 * @param {string} [googleSendTo]  a Google Ads conversion's 'AW-…/label', if it is one
 */
export function trackAdEvent(metaEvent, params = {}, googleSendTo = null) {
  if (typeof window === 'undefined' || !granted) return
  if (metaLoaded) window.fbq('track', metaEvent, params)
  if (googleLoaded && googleSendTo) window.gtag('event', 'conversion', { send_to: googleSendTo, ...params })
}
