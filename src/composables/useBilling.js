import { reactive, watch } from 'vue'
import { API_BASE } from '../auth/config.js'
import {
  createBillingClient, openInBillingTab, handleBillingReturn, onAccountChangedElsewhere,
} from '../auth/billing.js'
import { authHeaders } from '../api/serverError.js'
import { useAuth } from './useAuth.js'

/**
 * Billing for the current user: prices, Checkout, the customer portal, and
 * picking up a plan change made in another tab. See src/auth/billing.js.
 */
let billing = null

/** Refreshing on focus catches a change made in Stripe's dashboard; once a minute is plenty. */
const FOCUS_REFRESH_MS = 60_000

export function useBilling() {
  if (billing) return billing

  const auth = useAuth()
  const client = createBillingClient({ apiBase: API_BASE, authHeaders })
  const state = reactive({
    enabled: false,
    prices: [],
    loading: false,
    busy: false,
    error: null,
  })

  /** Where Stripe sends the browser back to: this page, without its query. */
  const returnUrl = () => `${window.location.origin}${window.location.pathname}`

  async function loadPrices() {
    state.loading = true
    try {
      const data = await client.prices()
      state.enabled = !!data.enabled
      state.prices = data.prices ?? []
    } finally {
      state.loading = false
    }
  }

  async function run(getUrl) {
    state.busy = true
    state.error = null
    const { error } = await openInBillingTab(getUrl)
    state.busy = false
    state.error = error
    return { error }
  }

  /** Start Checkout for Pro, billed `interval` ('monthly' | 'yearly'). Call from a click. */
  const upgrade = (interval) => run(() => client.checkoutUrl(interval, returnUrl()))

  /** Open the Stripe customer portal (card, invoices, switch interval, cancel). Call from a click. */
  const manage = () => run(() => client.portalUrl(returnUrl()))

  /** Resolves true once the session is known to be signed in, false if it settles otherwise. */
  function whenSignedIn() {
    if (auth.state.status !== 'loading') return Promise.resolve(auth.state.status === 'signedIn')
    return new Promise(resolve => {
      const stop = watch(() => auth.state.status, (s) => {
        if (s === 'loading') return
        stop()
        resolve(s === 'signedIn')
      })
    })
  }

  /**
   * Run once at startup: finish a Checkout / portal return if this page is
   * one, and keep the account fresh when another tab changes it.
   */
  let started = false
  async function start() {
    if (started || auth.state.status === 'disabled') return null
    started = true
    onAccountChangedElsewhere(() => auth.loadAccount())
    let lastFocusRefresh = Date.now()
    window.addEventListener('focus', () => {
      if (auth.state.status !== 'signedIn' || Date.now() - lastFocusRefresh < FOCUS_REFRESH_MS) return
      lastFocusRefresh = Date.now()
      auth.loadAccount()
    })
    const result = await handleBillingReturn({ client, whenSignedIn })
    if (result && result.kind !== 'cancel') await auth.loadAccount()
    return result
  }

  billing = { state, loadPrices, upgrade, manage, start }
  return billing
}
