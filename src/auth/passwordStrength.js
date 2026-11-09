/**
 * The sign-up form's live strength meter (design 2c,
 * docs/design/create-account/): 0 = nothing typed, 1 weak … 4 very strong.
 *
 * A NUDGE, NOT A RULE. The only requirement is MIN_PASSWORD characters (and
 * Supabase's own policy, which the server enforces); a low score never blocks
 * the form. Length counts twice because it is what actually makes a password
 * hard to guess; case and digit/symbol mixes are one step each.
 */

export const MIN_PASSWORD = 8

export function passwordScore(p) {
  if (!p) return 0
  let s = p.length >= MIN_PASSWORD ? 1 : 0
  if (p.length >= 12) s++
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++
  if (/\d/.test(p) || /[^\w]/.test(p)) s++
  return Math.max(1, s)
}

const COLORS = ['rgba(255,255,255,.1)', '#ff8a80', '#e0b84a', '#7fe9f6', '#35d3e6']

/** { score, color, hint, weak } for the meter under the password field. */
export function passwordStrength(p) {
  const score = passwordScore(p)
  const short = (p?.length ?? 0) < MIN_PASSWORD
  const hint = [
    `At least ${MIN_PASSWORD} characters`,
    short ? `${MIN_PASSWORD - p.length} more character${MIN_PASSWORD - p.length === 1 ? '' : 's'}` : 'Weak — add length or mix',
    'Okay — a few more characters helps',
    'Strong',
    'Very strong',
  ][score]
  return { score, color: COLORS[score], hint, weak: score === 1 }
}
