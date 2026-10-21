import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createAuthStore, createAccountFetcher, friendlyError } from '../../src/auth/authStore.js'
import { parseProviders, AUTH_ENABLED } from '../../src/auth/config.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

function session(id = 'u1', token = 'tok-' + id) {
  return { access_token: token, user: { id, email: `${id}@example.com` } }
}

/** A Supabase auth stand-in: records calls, lets the test emit auth events. */
function fakeClient(overrides = {}) {
  let listener = null
  const calls = []
  const ok = (data = {}) => async (...args) => { calls.push(args); return { data, error: null } }
  const auth = {
    onAuthStateChange(cb) { listener = cb; return { data: { subscription: { unsubscribe() {} } } } },
    signInWithPassword: ok({ session: session() }),
    signUp: ok({ session: null, user: { id: 'u1' } }),
    signInWithOtp: ok(),
    signInWithOAuth: ok({ url: 'https://accounts.example/oauth' }),
    resetPasswordForEmail: ok(),
    updateUser: ok(),
    signOut: ok(),
    getSession: async () => ({ data: { session: session() } }),
    ...overrides,
  }
  return { auth, calls, emit: (event, s) => listener(event, s) }
}

function noPopup() {
  return { open: () => null, isPopup: () => false, close: () => {} }
}

function makeStore(client, fetchAccount = async () => ({ plan: 'free' }), extra = {}) {
  return createAuthStore({
    client, fetchAccount, redirectUrl: () => 'https://app.example/', cleanUrl: () => {}, popup: noPopup(), ...extra,
  })
}

test('with no client the store is disabled and inert', async () => {
  const store = makeStore(null)
  store.start()
  assert.equal(store.state.status, 'disabled')
  assert.equal(store.plan.value, null)
  store.openDialog('signIn')
  assert.equal(store.state.dialog, null)
  assert.equal((await store.signInWithPassword('a@b.co', 'x')).error, 'Accounts are not available')
  assert.equal(await store.getAccessToken(), null)
})

test('accounts are off in a node build with no Vite env', () => {
  assert.equal(AUTH_ENABLED, false)
})

test('loading until Supabase reports, then signed out or signed in with the account loaded', async () => {
  const client = fakeClient()
  const tokens = []
  const store = makeStore(client, async (token) => { tokens.push(token); return { plan: 'pro', user: { id: 'u1' } } })
  store.start()
  assert.equal(store.state.status, 'loading')

  client.emit('INITIAL_SESSION', null)
  assert.equal(store.state.status, 'signedOut')
  assert.equal(store.plan.value, null)

  client.emit('SIGNED_IN', session('u1'))
  assert.equal(store.state.status, 'signedIn')
  assert.equal(store.plan.value, 'free', 'free until the server says otherwise')
  await tick()
  assert.deepEqual(tokens, ['tok-u1'])
  assert.equal(store.plan.value, 'pro')

  // A token refresh for the same user does not refetch.
  client.emit('TOKEN_REFRESHED', session('u1', 'tok-refreshed'))
  await tick()
  assert.deepEqual(tokens, ['tok-u1'])

  // USER_UPDATED does.
  client.emit('USER_UPDATED', session('u1', 'tok-updated'))
  await tick()
  assert.deepEqual(tokens, ['tok-u1', 'tok-updated'])

  client.emit('SIGNED_OUT', null)
  assert.equal(store.state.status, 'signedOut')
  await tick()
  assert.equal(store.state.account, null)
})

test('a slow account response for a previous user never lands on the next one', async () => {
  const client = fakeClient()
  const pending = {}
  const store = makeStore(client, (token) => new Promise(resolve => { pending[token] = resolve }))
  store.start()

  client.emit('SIGNED_IN', session('u1'))
  await tick()
  client.emit('SIGNED_IN', session('u2'))
  await tick()
  pending['tok-u2']({ plan: 'free', user: { id: 'u2' } })
  await tick()
  pending['tok-u1']({ plan: 'pro', user: { id: 'u1' } })
  await tick()
  assert.equal(store.state.account.user.id, 'u2')
  assert.equal(store.plan.value, 'free')
})

test('an account error is reported without signing the user out', async () => {
  const client = fakeClient()
  const store = makeStore(client, async () => { throw new Error('Could not load account') })
  store.start()
  client.emit('SIGNED_IN', session())
  await tick()
  assert.equal(store.state.status, 'signedIn')
  assert.equal(store.state.accountError, 'Could not load account')
  assert.equal(store.plan.value, 'free')
})

test('signing in closes the sign-in dialog; a recovery link opens the recovery one', () => {
  const client = fakeClient()
  const store = makeStore(client)
  store.start()
  client.emit('INITIAL_SESSION', null)
  store.openDialog('signIn')
  client.emit('SIGNED_IN', session())
  assert.equal(store.state.dialog, null)

  client.emit('PASSWORD_RECOVERY', session())
  assert.equal(store.state.dialog, 'recovery')
})

test('the URL is cleaned once, on the initial session', () => {
  const client = fakeClient()
  let cleaned = 0
  const store = makeStore(client, undefined, { cleanUrl: () => { cleaned++ } })
  store.start()
  store.start() // idempotent
  client.emit('INITIAL_SESSION', session())
  client.emit('TOKEN_REFRESHED', session())
  assert.equal(cleaned, 1)
})

test('actions pass the redirect URL and report errors in plain words', async () => {
  const client = fakeClient({
    signInWithPassword: async () => ({ data: null, error: { message: 'Invalid login credentials' } }),
  })
  const store = makeStore(client)

  assert.equal((await store.signInWithPassword('a@b.co', 'nope')).error, 'Email or password is incorrect.')

  const signUp = await store.signUp('a@b.co', 'longenough')
  assert.equal(signUp.error, null)
  assert.equal(signUp.needsConfirmation, true)
  assert.equal(client.calls[0][0].options.emailRedirectTo, 'https://app.example/')

  await store.sendMagicLink('a@b.co')
  assert.equal(client.calls[1][0].options.emailRedirectTo, 'https://app.example/')

  await store.sendPasswordReset('a@b.co')
  assert.deepEqual(client.calls[2], ['a@b.co', { redirectTo: 'https://app.example/' }])
})

test('OAuth opens a popup synchronously and points it at the provider', async () => {
  const client = fakeClient()
  const win = { location: { href: 'about:blank' }, closed: false, close() { this.closed = true } }
  let openedBeforeAwait = false
  const popup = { open: () => { openedBeforeAwait = client.calls.length === 0; return win }, isPopup: () => false, close() {} }
  const store = makeStore(client, undefined, { popup })

  const result = await store.signInWithProvider('google')
  assert.equal(result.error, null)
  assert.equal(openedBeforeAwait, true)
  assert.equal(win.location.href, 'https://accounts.example/oauth')
  assert.equal(client.calls[0][0].options.skipBrowserRedirect, true)

  // A failure closes the popup again.
  const failing = fakeClient({ signInWithOAuth: async () => ({ data: null, error: { message: 'Provider disabled' } }) })
  const win2 = { location: {}, closed: false, close() { this.closed = true } }
  const store2 = makeStore(failing, undefined, { popup: { open: () => win2, isPopup: () => false, close() {} } })
  assert.equal((await store2.signInWithProvider('google')).error, 'Provider disabled')
  assert.equal(win2.closed, true)
})

test('the OAuth popup closes itself once it has a session', () => {
  const client = fakeClient()
  let closed = 0
  const store = makeStore(client, undefined, { popup: { open: () => null, isPopup: () => true, close: () => { closed++ } } })
  store.start()
  client.emit('INITIAL_SESSION', null)
  assert.equal(closed, 0)
  client.emit('SIGNED_IN', session())
  assert.equal(closed, 1)
})

test('a failed sign-out reports the error and leaves the session intact', async () => {
  const client = fakeClient({ signOut: async () => { throw new Error('Failed to fetch') } })
  const store = makeStore(client)
  store.start()
  client.emit('SIGNED_IN', session())
  await tick()
  const account = store.state.account
  const r = await store.signOut()
  assert.match(r.error, /Could not reach/)
  assert.equal(store.state.status, 'signedIn')
  assert.equal(store.state.account, account, 'the account is not blanked under a live session')
  assert.equal(await store.getAccessToken(), 'tok-u1')
  assert.equal(store.plan.value, 'free')
})

test('a successful sign-out clears everything through the SIGNED_OUT event', async () => {
  const client = fakeClient()
  const store = makeStore(client)
  store.start()
  client.emit('SIGNED_IN', session())
  await tick()
  assert.equal((await store.signOut()).error, null)
  client.emit('SIGNED_OUT', null)
  await tick()
  assert.equal(store.state.status, 'signedOut')
  assert.equal(store.state.account, null)
  assert.equal(store.plan.value, null)
})

test('the account fetcher sends the bearer token and maps 503 to null', async () => {
  const seen = []
  const respond = (status, body) => async (url, init) => {
    seen.push({ url, init })
    return { status, ok: status >= 200 && status < 300, json: async () => body }
  }
  assert.deepEqual(await createAccountFetcher('https://api.example', respond(200, { plan: 'pro' }))('t1'), { plan: 'pro' })
  assert.equal(seen[0].url, 'https://api.example/api/me')
  assert.equal(seen[0].init.headers.Authorization, 'Bearer t1')
  assert.equal(await createAccountFetcher('', respond(503, { error: 'off' }))('t1'), null)
  await assert.rejects(createAccountFetcher('', respond(401, { error: 'Token expired' }))('t1'), /Token expired/)
})

test('parseProviders keeps known providers, once, in order', () => {
  assert.deepEqual(parseProviders(undefined), [])
  assert.deepEqual(parseProviders(' Google, github,google,myspace '), ['google', 'github'])
})

test('friendlyError passes unknown messages through', () => {
  assert.equal(friendlyError({ message: 'Rate limit exceeded' }), 'Rate limit exceeded')
  assert.equal(friendlyError(null), 'Something went wrong')
})
