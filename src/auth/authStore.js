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
import { hasFeature, planRank } from './plans.js'

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
    // The feature id that sent the user to the dialog (its copy names it), or null.
    dialogReason: null,
    // A feature id ('plan' for the plan itself) whose upgrade prompt should
    // open once the user has an account — the signed-out "Upgrade" path is
    // create account FIRST, and without this the intent died at the sign-up.
    pendingUpgrade: null,
    // The billing period picked in the upgrade prompt before it gave way to
    // the account dialog ('monthly' | 'yearly'), so the resumed prompt opens
    // on it rather than on its default. null = the prompt's default.
    upgradeInterval: null,
    // The feature id an upgrade prompt is open for ('plan' from the account menu), or null.
    upgradeFor: null,
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
      resumePendingUpgrade()
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
    else if (session && (state.dialog === 'signIn' || state.dialog === 'signUp')) {
      state.dialog = null
      state.dialogReason = null
    }

    const userId = session?.user?.id ?? null
    // Token refreshes fire this too; only a different user needs a new account.
    if (userId !== previousUserId || event === 'USER_UPDATED') {
      if (userId !== previousUserId) {
        state.account = null
        state.accountError = null
      }
      // Supabase warns against awaiting inside its callback (it holds a lock);
      // the fetch only needs the token, so run it after the callback returns.
      // A pending upgrade resumes from that load's success (resumePendingUpgrade).
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
    if (!client) return { error: 'Accounts are not available', errorKind: null }
    try {
      const { data, error } = await fn()
      return { data, error: error ? friendlyError(error) : null, errorKind: error ? errorKind(error) : null }
    } catch (err) {
      return { error: friendlyError(err), errorKind: errorKind(err) }
    }
  }

  /**
   * Reopen the upgrade prompt the user was on before the account dialog, now
   * the account exists. Called from a SUCCESSFUL account load and nowhere
   * else, for two reasons: the plan must be KNOWN (an existing Pro user
   * logging in from the prompt must not be offered what they have), and a
   * failed first load must not use the intent up — the next successful load
   * (a retry, a focus refresh) resumes it. Picked up from the load, not when
   * the dialog closes, because an email link logs this tab in long after.
   *
   * The intent is only ever set while signed out, and a signed-out load
   * returns before fetching, so the first successful load after it is the
   * new session's.
   */
  function resumePendingUpgrade() {
    const resume = state.pendingUpgrade
    if (!resume || state.status !== 'signedIn') return
    state.pendingUpgrade = null
    if (needsUpgrade(resume)) state.upgradeFor = resume
    else state.upgradeInterval = null
  }

  /** Is `featureId` ('plan' = Pro itself) still out of reach on the current plan? */
  function needsUpgrade(featureId) {
    if (featureId === 'plan') return planRank(plan.value) < planRank('pro')
    try {
      return !hasFeature(plan.value, featureId)
    } catch {
      return false // an unknown id never opens a prompt
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
      return result.error ? result : { error: 'Could not start logging in' }
    }
    if (win) win.location.href = url
    else if (typeof window !== 'undefined') window.location.assign(url)
    return result
  }

  /** Send the sign-up confirmation email again. */
  const resendConfirmation = (email) =>
    run(() => client.auth.resend({ type: 'signup', email, options: { emailRedirectTo: redirectUrl() } }))

  const sendPasswordReset = (email) =>
    run(() => client.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() }))

  const updatePassword = (password) =>
    run(() => client.auth.updateUser({ password }))

  /**
   * Change the password from the account dialog.
   *
   * With `currentPassword` the current one is CHECKED FIRST, by signing in
   * with it: Supabase's updateUser takes a new password from any live
   * session, so without the check anyone at an unlocked, signed-in browser
   * could take the account. Signing in as the same user only refreshes the
   * session (applySession skips the account reload for an unchanged id).
   *
   * Without it (`null`) the password is SET outright — for an account that
   * only ever signed in through a provider and so has none to check.
   */
  async function changePassword(currentPassword, newPassword) {
    if (!client) return { error: 'Accounts are not available', errorKind: null }
    if (currentPassword != null) {
      const email = user.value?.email
      if (!email) return { error: 'Your account has no email address to check the password against.', errorKind: null }
      const check = await run(() => client.auth.signInWithPassword({ email, password: currentPassword }))
      if (check.error) {
        return check.errorKind === 'credentials'
          ? { error: 'Your current password is incorrect.', errorKind: 'currentPassword' }
          : check
      }
    }
    return run(() => client.auth.updateUser({ password: newPassword }))
  }

  /**
   * Sign out. On success supabase-js drops its session and emits SIGNED_OUT,
   * and `applySession` clears everything from there — one path for every way
   * a session ends.
   *
   * ⚠ ON FAILURE NOTHING IS CLEARED HERE. supabase-js keeps its session when
   * the revoke call fails (offline, say), so the user IS still signed in:
   * blanking the account alone left a store that read signed-in, still sent
   * tokens and still showed account presets, with a menu that said nothing.
   * The error is returned for the caller to show; state stays consistent.
   */
  function signOut() {
    return run(() => client.auth.signOut())
  }

  /**
   * Sign out on every device: revokes all of the user's refresh tokens, so
   * other browsers drop off when their access token next expires (up to an
   * hour — Supabase's access tokens are self-contained). Same failure rule
   * as signOut: nothing is cleared here.
   */
  function signOutEverywhere() {
    return run(() => client.auth.signOut({ scope: 'global' }))
  }

  /** Current access token, for calls to our API. null when signed out. */
  async function getAccessToken() {
    if (!client) return null
    const { data } = await client.auth.getSession()
    return data?.session?.access_token ?? null
  }

  /**
   * Open the account dialog.
   *   reason     the feature id that needs the account, so the dialog can say
   *              what it is for rather than a generic "sign in"
   *   thenUpgrade  a feature id ('plan' for Pro itself) whose upgrade prompt
   *              opens once signed in — unless the account turns out to have it
   */
  function openDialog(mode = 'signIn', { reason = null, thenUpgrade = null } = {}) {
    if (!client) return
    state.dialog = mode
    state.dialogReason = reason ?? (thenUpgrade && thenUpgrade !== 'plan' ? thenUpgrade : null)
    if (thenUpgrade) state.pendingUpgrade = thenUpgrade
  }

  /**
   * Close the account dialog. `keepIntent` keeps a pending upgrade alive — the
   * dialog passes it once a confirmation or sign-in link has been emailed, so
   * the prompt still resumes when that link signs this tab in.
   */
  function closeDialog({ keepIntent = false } = {}) {
    state.dialog = null
    state.dialogReason = null
    if (!keepIntent) {
      state.pendingUpgrade = null
      state.upgradeInterval = null
    }
  }

  /** Open the upgrade prompt, for a feature or (no argument) for the plan itself. */
  function openUpgrade(featureId = 'plan') {
    if (client) state.upgradeFor = featureId
  }

  /** From the upgrade prompt while signed out: an account first, then back to the prompt. */
  function signUpThenUpgrade(mode = 'signUp', { interval = null } = {}) {
    const featureId = state.upgradeFor ?? 'plan'
    state.upgradeFor = null
    state.upgradeInterval = interval
    openDialog(mode, { thenUpgrade: featureId })
  }

  function closeUpgrade() {
    state.upgradeFor = null
    state.upgradeInterval = null
  }


  return {
    state, user, isSignedIn, plan,
    start, loadAccount, getAccessToken,
    signInWithPassword, signUp, sendMagicLink, signInWithProvider,
    sendPasswordReset, updatePassword, changePassword, signOut, resendConfirmation,
    openDialog, closeDialog, openUpgrade, closeUpgrade, signUpThenUpgrade, needsUpgrade,
    signOutEverywhere,
  }
}

/** Supabase's error text, made readable where it is cryptic. */
export function friendlyError(err) {
  const message = err?.message ?? String(err ?? 'Something went wrong')
  if (/invalid login credentials/i.test(message)) return 'Email or password is incorrect.'
  if (/email not confirmed/i.test(message)) return 'Confirm your email first — check your inbox for the link.'
  if (/user already registered/i.test(message)) return 'An account with this email already exists. Log in instead.'
  if (/failed to fetch|network/i.test(message)) return 'Could not reach the login service. Check your connection.'
  if (/rate limit|only request this after/i.test(message)) return 'Too many attempts — wait a minute, then try again.'
  return message
}

/**
 * What kind of failure it is, for the dialog to offer the way out:
 *   'exists'       sign-up with an email that has an account → "Sign in instead"
 *   'unconfirmed'  sign-in before confirming → "Resend the link"
 *   'credentials'  wrong email or password → "Email me a link instead"
 * null for anything else. Supabase's error `code` first, its text as a fallback.
 */
export function errorKind(err) {
  const code = err?.code ?? ''
  const message = err?.message ?? ''
  if (code === 'user_already_exists' || code === 'email_exists' || /user already registered/i.test(message)) return 'exists'
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(message)) return 'unconfirmed'
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(message)) return 'credentials'
  return null
}

/**
 * Can this user prove their current password? Supabase lists the ways an
 * account has signed in under `app_metadata.providers`; 'email' means an
 * email identity, which is the only kind that can hold a password. An
 * account with only provider identities (Google, say) has nothing to check,
 * so the dialog SETS a password for it instead. An email account that only
 * ever used magic links has no password either — it gets the reset-link way
 * out instead, since nothing in the session says which kind it is.
 */
export function hasEmailIdentity(user) {
  const providers = user?.app_metadata?.providers
  if (Array.isArray(providers)) return providers.includes('email')
  return user?.app_metadata?.provider ? user.app_metadata.provider === 'email' : true
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
