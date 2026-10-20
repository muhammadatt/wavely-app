/**
 * Which plan a user is on, derived from their subscription rows.
 *
 * This is the minimal piece `/api/me` needs. What each plan UNLOCKS is a
 * separate concern (feature gating) and does not live here yet.
 */

export const FREE_PLAN = 'free'

/** Plan ids a subscription row may carry, ordered lowest to highest. */
export const PAID_PLANS = ['pro']

/**
 * Stripe statuses that grant the plan. `past_due` is included on purpose: it
 * is the dunning window while Stripe retries the card, and cutting a paying
 * user off on the first failed charge loses more customers than it protects.
 * Stripe moves the subscription to `unpaid` or `canceled` once retries run out.
 */
export const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due'])

/**
 * The plan in effect and the subscription that grants it.
 *
 * With several entitled subscriptions (a mid-upgrade overlap) the highest plan
 * wins. Rows naming a plan this server does not know are ignored rather than
 * trusted — a typo in a webhook mapping must not hand out access.
 */
export function resolvePlan(subscriptions = []) {
  let best = null
  for (const sub of subscriptions) {
    if (!sub || !ENTITLED_STATUSES.has(sub.status)) continue
    const rank = PAID_PLANS.indexOf(sub.plan)
    if (rank < 0) continue
    if (!best || rank > PAID_PLANS.indexOf(best.plan)) best = sub
  }
  return { plan: best ? best.plan : FREE_PLAN, subscription: best }
}
