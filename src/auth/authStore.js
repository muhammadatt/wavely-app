/**
 * The signed-in user, as one reactive store.
 *
 * Two sources, deliberately kept apart:
 *
 *   session  from Supabase Auth — WHO the user is. Lives in the browser and
 *            refreshes itself.
 *   account  from our API's GET /api/me — WHAT they are entitled to (plan,
 *            subscription). Never derived in the browser: the server reads it
 *            from the database on every call, so a cancelled subscription
 *            lands on the next page load rather than when a token expires.
 *
 * The store is built by `createAuthStore` with its Supabase client and account
 * fetcher passed in, so the state machine is testable under `node --test`
 * without a network. `useAuth` wires the real ones.
 *
 * status:  'disabled'  accounts are not configured in this build
 *          'loading'   waiting for Supabase's first session report
 *          'signedOut'
 *          'signedIn'
 */

import { reactive, computed } from 'vue'

/** Query parameters an auth redirect leaves on the URL. */
const AUTH_REDIRECT_PARAMS = ['code', 'error', 'error_code', 'error_description']

/**
 * GET /api/me with the session's token. Resolves the account, or null when the
 * server has accounts switched off (503); throws on anything else.
 */
export function createAccountFetcher(apiBase, fetchImpl = globalThis.fetch) {
  return async function fetchAccount(accessToken) {
    const res = await fetchImpl(`${apiBase}/api/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (res.status === 503) return null
    if (!res.ok) {
      let message = `Account request failed (${res.status})`
      try {
        const body = await res.json()
        if (body?.error) message = body.error
      } catch { /* not JSON */ }
      const err = new Error(message)
      err.status = res.status
      throw err
    }
    return res.json()
  }
}

/**
 * @param {object}      deps
 * @param {object|null} deps.client        Supabase client, null when accounts are off
 * @param {Function}    deps.fetchAccount  (accessToken) => Promise<account|null>
 * @param {Function}    [deps.redirectUrl] () => URL auth emails and OAuth return to
 * @param {Function}    [deps.cleanUrl]    () => void, strips auth params from the address bar
 * @param {object}      [deps.popup]       { open, isPopup, close } — the OAuth popup window
 */
export function createAuthStore({
  client, fetchAccount, redirectUrl = defaultRedirectUrl, cleanUrl = defaultCleanUrl, popup = browserPopup,
}) {
  const state = reactive({
    status: client ? 'loading' : 'disabled',
    session: null,
    account: null,
    accountError: null,
    // null | 'signIn' | 'signUp' | 'reset' | 'recovery'
    dialog: null,
  })

  const user = computed(() => state.session?.user ?? null)
  const isSignedIn = computed(() => state.status === 'signedIn')
  /** The plan in effect: null signed out, 'free' until the account says otherwise. */
  const plan = computed(() => (isSignedIn.value ? (state.account?.plan ?? 'free') : null))

  let started = false
  let accountRequest = 0

  async function loadAccount() {
    const token = state.session?.access_token
    const request = ++accountRequest
    if (!token) {
      state.account = null
      state.accountError = null
      return
    }
    try {
      const account = await fetchAccount(token)
      if (request !== accountRequest) return // superseded by a sign-out or user switch
      state.account = account
      state.accountError = null
    } catch (err) {
      if (request !== accountRequest) return
      state.account = null
      state.accountError = err?.message ?? 'Could not load account'
    }
  }

  function applySession(event, session) {
    const previousUserId = state.session?.user?.id ?? null
    state.session = session ?? null
    state.status = session ? 'signedIn' : 'signedOut'

    if (event === 'PASSWORD_RECOVERY') state.dialog = 'recovery'
    else if (session && (state.dialog === 'signIn' || state.dialog === 'signUp')) state.dialog = null

    const userId = session?.user?.id ?? null
    // Token refreshes fire this too; only a different user needs a new account.
    if (userId !== previousUserId || event === 'USER_UPDATED') {
      if (userId !== previousUserId) {
        state.account = null
        state.accountError = null
      }
      // Supabase warns against awaiting inside its callback (it holds a lock);
      // the fetch only needs the token, so run it after the callback returns.
      setTimeout(loadAccount, 0)
    }

    if (event === 'INITIAL_SESSION') cleanUrl()

    // This window is the OAuth popup and has just finished: the session is in
    // shared storage now and the editor tab has picked it up.
    if (session && popup.isPopup()) popup.close()
  }

  /** Subscribe to Supabase once. Safe to call from every component. */
  function start() {
    if (started || !client) return
    started = true
    client.auth.onAuthStateChange((event, session) => applySession(event, session))
  }

  // ── Actions. Each resolves { error } (a message or null) for the dialog. ──

  async function run(fn) {
    if (!client) return { error: 'Accounts are not available' }
    try {
      const { data, error } = await fn()
      return { data, error: error ? friendlyError(error) : null }
    } catch (err) {
      return { error: friendlyError(err) }
    }
  }

  const signInWithPassword = (email, password) =>
    run(() => client.auth.signInWithPassword({ email, password }))

  /** Resolves `needsConfirmation` when the project requires email confirmation. */
  async function signUp(email, password) {
    const result = await run(() => client.auth.signUp({
      email, password, options: { emailRedirectTo: redirectUrl() },
    }))
    return { ...result, needsConfirmation: !result.error && !result.data?.session }
  }

  const sendMagicLink = (email) =>
    run(() => client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectUrl() } }))

  /**
   * OAuth in a POPUP, not a redirect: redirecting would navigate the editor
   * away and take every unsaved edit with it. The popup is opened before the
   * first await so it still counts as the click's user gesture (an async
   * window.open is blocked); if it is blocked anyway, fall back to a redirect —
   * the beforeunload guard still asks before unsaved work is dropped.
   */
  async function signInWithProvider(provider) {
    const win = client ? popup.open() : null
    const result = await run(() => client.auth.signInWithOAuth({
      provider, options: { redirectTo: redirectUrl(), skipBrowserRedirect: true },
    }))
    const url = result.data?.url
    if (result.error || !url) {
      win?.close()
      return result.error ? result : { error: 'Could not start sign-in' }
    }
    if (win) win.location.href = url
    else if (typeof window !== 'undefined') window.location.assign(url)
    return result
  }

  const sendPasswordReset = (email) =>
    run(() => client.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() }))

  const updatePassword = (password) =>
    run(() => client.auth.updateUser({ password }))

  async function signOut() {
    const result = await run(() => client.auth.signOut())
    // Clear locally even if the server call failed (offline): the user asked
    // to be signed out of THIS browser, and supabase-js has dropped its copy.
    accountRequest++
    state.account = null
    state.accountError = null
    return result
  }

  /** Current access token, for calls to our API. null when signed out. */
  async function getAccessToken() {
    if (!client) return null
    const { data } = await client.auth.getSession()
    return data?.session?.access_token ?? null
  }

  function openDialog(mode = 'signIn') {
    if (client) state.dialog = mode
  }

  function closeDialog() {
    state.dialog = null
  }

  return {
    state, user, isSignedIn, plan,
    start, loadAccount, getAccessToken,
    signInWithPassword, signUp, sendMagicLink, signInWithProvider,
    sendPasswordReset, updatePassword, signOut,
    openDialog, closeDialog,
  }
}

/** Supabase's error text, made readable where it is cryptic. */
export function friendlyError(err) {
  const message = err?.message ?? String(err ?? 'Something went wrong')
  if (/invalid login credentials/i.test(message)) return 'Email or password is incorrect.'
  if (/email not confirmed/i.test(message)) return 'Confirm your email first — check your inbox for the link.'
  if (/user already registered/i.test(message)) return 'An account with this email already exists. Sign in instead.'
  if (/failed to fetch|network/i.test(message)) return 'Could not reach the sign-in service. Check your connection.'
  return message
}

export const AUTH_POPUP_NAME = 'wavely-auth'

const browserPopup = {
  open() {
    if (typeof window === 'undefined') return null
    const w = 480, h = 640
    const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2)
    const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2)
    return window.open('about:blank', AUTH_POPUP_NAME, `popup,width=${w},height=${h},left=${left},top=${top}`)
  },
  // By name, not window.opener: the provider's pages send COOP headers that
  // can sever the opener on the way back, while the name survives navigation.
  isPopup() {
    return typeof window !== 'undefined' && window.name === AUTH_POPUP_NAME
  },
  // Cleared first so that if the browser refuses the close, this window stays
  // a normal, signed-in copy of the app instead of trying to close on every load.
  close() {
    window.name = ''
    window.close()
  },
}

function defaultRedirectUrl() {
  if (typeof window === 'undefined') return undefined
  return `${window.location.origin}${window.location.pathname}`
}

/**
 * Remove auth parameters from the address bar once Supabase has consumed them,
 * so a reload or a copied link does not replay a spent code.
 */
function defaultCleanUrl() {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  let changed = false
  for (const key of AUTH_REDIRECT_PARAMS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key)
      changed = true
    }
  }
  if (changed) window.history.replaceState(window.history.state, '', url.toString())
}
