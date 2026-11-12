/**
 * What the account menu and the account dialog say about the plan.
 *
 * One place, so the menu's one-liner and the dialog's fuller wording never
 * disagree. Pure: the subscription is /api/me's `subscription` object
 * ({ plan, status, currentPeriodEnd, cancelAtPeriodEnd }) or null, which the
 * server sends for a free account AND for a paid one that has fully ended
 * (`resolvePlan` keeps only entitled subscriptions).
 */

import { PLAN_LABELS } from './plans.js'

/** "21 Nov 2026" in the viewer's locale; '' for a missing or bad date. */
export function formatPeriodDate(value, locale = undefined) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The account menu's line after the plan: "Renews 21 Nov 2026" /
 * "Ends 21 Nov 2026" / "Payment failed — update your card", or ''.
 */
export function subscriptionLine(sub, locale) {
  if (!sub) return ''
  if (sub.status === 'past_due') return 'Payment failed — update your card'
  const date = formatPeriodDate(sub.currentPeriodEnd, locale)
  if (!date) return ''
  return `${sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${date}`
}

/**
 * The account dialog's plan card.
 *
 * @returns {{
 *   label: string,          plan name ("Pro")
 *   paid: boolean,
 *   state: 'free'|'active'|'trialing'|'ending'|'pastDue',
 *   status: string,         one line under the name
 *   detail: string,         what managing it does — always says it is done here
 *   canManage: boolean,     there is a subscription for the portal to open on
 * }}
 */
export function planSummary(plan, sub, locale) {
  const label = PLAN_LABELS[plan] ?? (plan ? String(plan) : PLAN_LABELS.free)
  const paid = !!plan && plan !== 'free'
  if (!paid || !sub) {
    return {
      label: PLAN_LABELS.free,
      paid: false,
      state: 'free',
      status: 'You’re on the free plan.',
      detail: 'Upgrade any time from here. When you subscribe, you manage and cancel the subscription from this page too.',
      canManage: false,
    }
  }
  const date = formatPeriodDate(sub.currentPeriodEnd, locale)
  const manage = 'Change your billing period, update your card, download invoices or cancel — all from Manage subscription, without leaving the app.'
  if (sub.status === 'past_due') {
    return {
      label, paid, state: 'pastDue', canManage: true,
      status: 'Your last payment failed.',
      detail: `Update your card in Manage subscription to keep ${label}. ${manage}`,
    }
  }
  if (sub.cancelAtPeriodEnd) {
    return {
      label, paid, state: 'ending', canManage: true,
      status: date ? `Cancelled — ${label} stays on until ${date}.` : `Cancelled — ${label} stays on until the end of the period.`,
      detail: `Changed your mind? Resume it in Manage subscription before then. After that you move to the free plan; your saved presets stay.`,
    }
  }
  return {
    label, paid, state: sub.status === 'trialing' ? 'trialing' : 'active', canManage: true,
    status: sub.status === 'trialing'
      ? (date ? `Trial — first payment ${date}.` : 'Trial.')
      : (date ? `Renews ${date}.` : 'Active.'),
    detail: `${manage} If you cancel, ${label} stays on until the end of the period you’ve paid for.`,
  }
}

const PROVIDER_LABELS = { email: 'Email', google: 'Google', github: 'GitHub', apple: 'Apple', azure: 'Microsoft', facebook: 'Facebook', twitter: 'X' }

/** "Google" for 'google'; an unknown provider id is capitalised. */
export function providerLabel(id) {
  const key = String(id ?? '')
  return PROVIDER_LABELS[key] ?? (key ? key[0].toUpperCase() + key.slice(1) : '')
}

/**
 * The ways a Supabase user can log in, for the Security section: one entry
 * per identity ({ provider, label, email, since }), email first. Falls back
 * to `app_metadata.providers` when the session carries no identities.
 */
export function signInMethods(user, locale) {
  const identities = Array.isArray(user?.identities) ? user.identities : []
  const list = identities.length
    ? identities.map(i => ({
        provider: i.provider,
        label: providerLabel(i.provider),
        email: i.identity_data?.email ?? i.email ?? '',
        since: formatPeriodDate(i.created_at, locale),
      }))
    : (user?.app_metadata?.providers ?? []).map(p => ({ provider: p, label: providerLabel(p), email: '', since: '' }))
  return list.sort((a, b) => (a.provider === 'email' ? -1 : b.provider === 'email' ? 1 : 0))
}
