# Stripe integration — remaining steps

Stripe Checkout was already integrated (scenario A): the one Checkout Session
call, `createCheckout` in [server/lib/billing.js](server/lib/billing.js), was
updated with the Checkout Studio parameters. No other code changed.

## Values to Replace

None. `mode`, `success_url`, `cancel_url` and `line_items` already carry real
values (prices come from the configured price IDs), so nothing was reset to a
placeholder.

## Configured Parameters

**Files containing these parameters:**
- [server/lib/billing.js](server/lib/billing.js)

| Parameter | Value |
|-----------|-------|
| ui_mode | hosted_page (SDK 23.0.0; use `hosted` below 21.0.0) |
| billing_address_collection | auto |
| phone_number_collection | `{ enabled: false }` |
| automatic_tax | `{ enabled: false }` |
| allow_promotion_codes | false (was `true`) |
| payment_method_collection | always (subscription mode only) |
| submit_type | auto |
| integration_identifier | hosted_web_0001 |
| origin_context | web |

## Kept although not in the Studio list

`customer`, `client_reference_id` and `subscription_data.metadata.user_id` stay.
They tie the session to the signed-in user: `completeCheckout` rejects a session
whose `client_reference_id` isn't the caller, and the webhook sync finds the user
through the subscription metadata. Removing them would break plan syncing.

## Things to check

- `allow_promotion_codes` flipped from `true` to `false`, so promo codes are no
  longer accepted at checkout.
- `automatic_tax` is off. If you owe sales tax/VAT, enable Stripe Tax first.

## Setup

Environment variables, webhook endpoint and price IDs are documented in
[docs/user-accounts.md](docs/user-accounts.md). Test with card `4242 4242 4242 4242`
(any future expiry, any CVC) in test mode; `npm test` in `server/` runs
`test/billing.test.js`.

Resources: https://support.stripe.com and https://docs.stripe.com/mcp
