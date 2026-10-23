import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createBillingClient, openInBillingTab, handleBillingReturn, onAccountChangedElsewhere,
  formatPrice, BILLING_WINDOW_NAME, checkoutReturnMessage,
} from '../../src/auth/billing.js'

function fakeWin(href, name = '') {
  const replaced = []
  const win = {
    name,
    closed: false,
    location: { href, assign(u) { this.href = u; win.assigned = u } },
    history: { state: null, replaceState: (_s, _t, u) => replaced.push(u) },
    close() { win.closed = true },
    opened: [],
    open(url, target) {
      const tab = { location: { href: url }, closed: false, close() { tab.closed = true } }
      win.opened.push({ target, tab })
      return win.blockPopups ? null : tab
    },
    replaced,
  }
  return win
}

function fakeChannelHub() {
  const posted = []
  const channels = []
  return {
    posted,
    make: (name) => {
      const ch = {
        name,
        onmessage: null,
        postMessage: (m) => { posted.push([name, m]); for (const c of channels) if (c !== ch && c.name === name) c.onmessage?.({ data: m }) },
        close() {},
      }
      channels.push(ch)
      return ch
    },
  }
}

test('openInBillingTab opens the tab inside the click, then points it at Stripe', async () => {
  const win = fakeWin('https://app.example/')
  let openedBeforeUrl = false
  const r = await openInBillingTab(async () => { openedBeforeUrl = win.opened.length === 1; return 'https://checkout.stripe.com/x' }, { win })
  assert.equal(r.error, null)
  assert.equal(openedBeforeUrl, true)
  assert.equal(win.opened[0].target, BILLING_WINDOW_NAME)
  assert.equal(win.opened[0].tab.location.href, 'https://checkout.stripe.com/x')
  assert.equal(win.assigned, undefined, 'the editor tab never navigates')
})

test('openInBillingTab: a blocked popup falls back to navigating; a failure closes the tab', async () => {
  const blocked = fakeWin('https://app.example/')
  blocked.blockPopups = true
  await openInBillingTab(async () => 'https://checkout.stripe.com/x', { win: blocked })
  assert.equal(blocked.assigned, 'https://checkout.stripe.com/x')

  const failing = fakeWin('https://app.example/')
  const r = await openInBillingTab(async () => { throw new Error('You already have an active subscription') }, { win: failing })
  assert.match(r.error, /already have/)
  assert.equal(failing.opened[0].tab.closed, true)
})

test('a checkout success syncs the session, tells other tabs, cleans the URL and closes our tab', async () => {
  const hub = fakeChannelHub()
  const heard = []
  onAccountChangedElsewhere(() => heard.push('refresh'), { makeChannel: hub.make })

  const win = fakeWin('https://app.example/editor?checkout=success&session_id=cs_123&keep=1', BILLING_WINDOW_NAME)
  const completed = []
  const client = { completeCheckout: async (id) => { completed.push(id); return { plan: 'pro' } } }
  const r = await handleBillingReturn({ client, whenSignedIn: async () => true, win, makeChannel: hub.make })

  assert.deepEqual(r, { kind: 'success', plan: 'pro' })
  assert.deepEqual(completed, ['cs_123'])
  assert.deepEqual(heard, ['refresh'])
  assert.deepEqual(win.replaced, ['https://app.example/editor?keep=1'])
  assert.equal(win.closed, true)
  assert.equal(win.name, '')
})

test('a return in the editor tab itself (popup was blocked) stays open', async () => {
  const win = fakeWin('https://app.example/?checkout=success&session_id=cs_1')
  const r = await handleBillingReturn({
    client: { completeCheckout: async () => ({ plan: 'pro' }) }, whenSignedIn: async () => true, win, makeChannel: () => null,
  })
  assert.equal(r.kind, 'success')
  assert.equal(win.closed, false)
})

test('a sync failure is reported but still refreshes other tabs (the webhook will deliver it)', async () => {
  const hub = fakeChannelHub()
  const win = fakeWin('https://app.example/?checkout=success&session_id=cs_1')
  const r = await handleBillingReturn({
    client: { completeCheckout: async () => { throw new Error('timeout') } }, whenSignedIn: async () => true, win, makeChannel: hub.make,
  })
  assert.equal(r.error, 'timeout')
  assert.equal(hub.posted.length, 1)
})

test('cancel tidies up without a sync or a broadcast; portal returns broadcast; other pages are untouched', async () => {
  const hub = fakeChannelHub()
  const client = { completeCheckout: async () => assert.fail('no sync on cancel') }
  const cancel = fakeWin('https://app.example/?checkout=cancel', BILLING_WINDOW_NAME)
  assert.deepEqual(await handleBillingReturn({ client, whenSignedIn: async () => true, win: cancel, makeChannel: hub.make }), { kind: 'cancel' })
  assert.equal(hub.posted.length, 0)
  assert.equal(cancel.closed, true)

  const portal = fakeWin('https://app.example/?billing=portal')
  assert.equal((await handleBillingReturn({ client, whenSignedIn: async () => true, win: portal, makeChannel: hub.make })).kind, 'portal')
  assert.equal(hub.posted.length, 1)

  const plain = fakeWin('https://app.example/?foo=1')
  assert.equal(await handleBillingReturn({ client, whenSignedIn: async () => true, win: plain, makeChannel: hub.make }), null)
  assert.deepEqual(plain.replaced, [])
})

test('the client posts with auth, surfaces server errors and retries prices only when off', async () => {
  const calls = []
  let enabled = false
  const fetchImpl = async (url, init) => {
    calls.push([url, init])
    if (url.endsWith('/prices')) return { ok: true, json: async () => ({ enabled, prices: enabled ? [{ interval: 'monthly' }] : [] }) }
    if (url.endsWith('/checkout')) return { ok: false, status: 409, json: async () => ({ error: 'already', code: 'already_subscribed' }) }
    return { ok: true, json: async () => ({ url: 'https://billing.stripe.com/p' }) }
  }
  const client = createBillingClient({ apiBase: 'https://api.example', authHeaders: async () => ({ Authorization: 'Bearer t' }), fetchImpl })

  assert.equal((await client.prices()).enabled, false)
  enabled = true
  assert.equal((await client.prices()).enabled, true, 'a disabled answer is not cached')
  await client.prices()
  assert.equal(calls.filter(c => c[0].endsWith('/prices')).length, 2, 'an enabled answer is')

  await assert.rejects(client.checkoutUrl('monthly', 'https://app.example/'), e => e.code === 'already_subscribed' && e.status === 409)
  const [url, init] = calls.find(c => c[0].endsWith('/checkout'))
  assert.equal(url, 'https://api.example/api/billing/checkout')
  assert.equal(init.headers.Authorization, 'Bearer t')
  assert.deepEqual(JSON.parse(init.body), { plan: 'pro', interval: 'monthly', returnUrl: 'https://app.example/' })

  assert.equal(await client.portalUrl('https://app.example/'), 'https://billing.stripe.com/p')
})

test('formatPrice drops zero cents', () => {
  assert.equal(formatPrice(900, 'usd', 'en-US'), '$9')
  assert.equal(formatPrice(1250, 'eur', 'en-US'), '€12.50')
  assert.equal(formatPrice(null, 'usd'), '')
})

test('the checkout-return message never calls a failed confirmation a success', () => {
  assert.equal(checkoutReturnMessage(null), null)
  assert.equal(checkoutReturnMessage({ kind: 'cancel' }), null)
  assert.equal(checkoutReturnMessage({ kind: 'portal' }), null)
  assert.equal(checkoutReturnMessage({ kind: 'success', plan: 'pro' }).text, 'Welcome to Pro!')
  assert.match(checkoutReturnMessage({ kind: 'success', plan: null }).text, /Payment received/)
  const failed = checkoutReturnMessage({ kind: 'success', error: 'timeout' })
  assert.match(failed.text, /^Couldn’t confirm your subscription: timeout/)
  assert.doesNotMatch(failed.text, /Payment received|Welcome/)
})
