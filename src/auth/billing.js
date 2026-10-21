/**
 * Browser side of billing (Stripe Checkout and the customer portal).
 *
 * ⚠ STRIPE PAGES OPEN IN A NEW TAB, NEVER BY NAVIGATING THE EDITOR AWAY. The
 * editor holds unsaved work in memory; a redirect to Checkout would cost it
 * all, or at best stop on the beforeunload prompt. The tab is opened during
 * the click (an async window.open is popup-blocked) and pointed at Stripe once
 * the server has made the session. If it is blocked anyway, the editor
 * redirects — the unsaved-work guard still asks first.
 *
 * Coming back, Stripe lands that tab on the app with `?checkout=success&
 * session_id=…` (or `?checkout=cancel`, or `?billing=portal`).
 * `handleBillingReturn` then:
 *   - on success, asks the server to sync the subscription NOW (no waiting
 *     on the webhook), so the plan is right on the very next /api/me;
 *   - tells every other tab — the editor — to refresh its account, over a
 *     BroadcastChannel;
 *   - closes itself when it is the tab we opened, or tidies the URL if not.
 */

export const BILLING_WINDOW_NAME = 'wavely-billing'
export const BILLING_CHANNEL = 'wavely-billing'

/** Query parameters a billing return leaves on the URL. */
const RETURN_PARAMS = ['checkout', 'session_id', 'billing']

/**
 * @param {object}   deps
 * @param {string}   deps.apiBase
 * @param {Function} deps.authHeaders   async () => headers object
 * @param {Function} [deps.fetchImpl]
 */
export function createBillingClient({ apiBase, authHeaders, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  async function call(path, body) {
    const res = await fetchImpl(`${apiBase}/api/billing/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(data.error || `Billing request failed (${res.status})`)
      err.code = data.code
      err.status = res.status
      throw err
    }
    return data
  }

  let pricesPromise = null

  return {
    /** { enabled, prices: [{ plan, interval, amount, currency }] }, fetched once per page. */
    prices() {
      pricesPromise ??= fetchImpl(`${apiBase}/api/billing/prices`)
        .then(r => (r.ok ? r.json() : { enabled: false, prices: [] }))
        .catch(() => ({ enabled: false, prices: [] }))
        .then(data => {
          if (!data.enabled) pricesPromise = null // try again next time the prompt opens
          return data
        })
      return pricesPromise
    },
    checkoutUrl: (interval, returnUrl, plan = 'pro') => call('checkout', { plan, interval, returnUrl }).then(d => d.url),
    portalUrl: (returnUrl) => call('portal', { returnUrl }).then(d => d.url),
    completeCheckout: (sessionId) => call('checkout/complete', { sessionId }),
  }
}

/**
 * Open a tab now (inside the click), point it at the URL `getUrl` resolves.
 * Resolves { error } — a message, or null.
 */
export async function openInBillingTab(getUrl, { win = globalThis.window } = {}) {
  const tab = win?.open?.('about:blank', BILLING_WINDOW_NAME) ?? null
  try {
    const url = await getUrl()
    if (tab && !tab.closed) tab.location.href = url
    else win.location.assign(url)
    return { error: null }
  } catch (err) {
    tab?.close?.()
    return { error: err?.message ?? 'Billing is unavailable right now' }
  }
}

/**
 * Run on every page load. Resolves what happened: null (not a billing
 * return), or { kind: 'success' | 'cancel' | 'portal', plan?, error? }.
 *
 * @param {object}   deps
 * @param {object}   deps.client            createBillingClient() result
 * @param {Function} deps.whenSignedIn      async () => boolean — waits for the session
 * @param {object}   [deps.win]
 * @param {Function} [deps.makeChannel]     (name) => BroadcastChannel-like
 */
export async function handleBillingReturn({ client, whenSignedIn, win = globalThis.window, makeChannel = defaultChannel }) {
  if (!win?.location) return null
  const url = new URL(win.location.href)
  const checkout = url.searchParams.get('checkout')
  const portal = url.searchParams.get('billing') === 'portal'
  if (!checkout && !portal) return null

  const kind = portal ? 'portal' : checkout === 'success' ? 'success' : 'cancel'
  let result = { kind }
  if (kind === 'success') {
    const sessionId = url.searchParams.get('session_id')
    try {
      if (sessionId && await whenSignedIn()) {
        const { plan } = await client.completeCheckout(sessionId)
        result = { kind, plan }
      }
    } catch (err) {
      // The webhook will still deliver it; the editor refreshes either way.
      result = { kind, error: err?.message ?? 'Could not confirm the subscription' }
    }
  }

  if (kind !== 'cancel') {
    const channel = makeChannel(BILLING_CHANNEL)
    channel?.postMessage({ type: 'account-changed' })
    channel?.close?.()
  }

  for (const key of RETURN_PARAMS) url.searchParams.delete(key)
  win.history?.replaceState?.(win.history.state, '', url.toString())

  // The tab we opened has done its job; the editor tab carries on.
  if (win.name === BILLING_WINDOW_NAME) {
    win.name = ''
    win.close?.()
  }
  return result
}

/** Calls `onChange` when another tab reports an account change. Returns a stop function. */
export function onAccountChangedElsewhere(onChange, { makeChannel = defaultChannel } = {}) {
  const channel = makeChannel(BILLING_CHANNEL)
  if (!channel) return () => {}
  channel.onmessage = (e) => { if (e?.data?.type === 'account-changed') onChange() }
  return () => channel.close?.()
}

function defaultChannel(name) {
  return typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null
}

/** "$9" / "$90" / "€12.50" for a Stripe unit amount. */
export function formatPrice(amount, currency, locale) {
  if (!Number.isFinite(amount)) return ''
  const whole = amount % 100 === 0
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: (currency ?? 'usd').toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount / 100)
}
