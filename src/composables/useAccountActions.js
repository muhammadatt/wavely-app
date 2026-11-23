import { computed } from 'vue'
import { useAuth } from './useAuth.js'
import { useEditorState } from './useEditorState.js'
import { useBilling } from './useBilling.js'
import { useAccountScreen } from './useAccountScreen.js'
import { subscriptionLine as subscriptionLineFor } from '../auth/accountSummary.js'

const PLAN_LABELS = { free: 'Free', pro: 'Pro' }

/**
 * What an account menu shows and does — shared by the desktop's avatar menu
 * (AccountMenu.vue) and the phone header's ⋯ menu (MobileTopBar.vue), so the
 * two cannot offer different things. Each menu closes itself around these.
 */
export function useAccountActions() {
  const auth = useAuth()
  const { state, user, plan } = auth
  const { showToast } = useEditorState()
  const billing = useBilling()
  const accountScreen = useAccountScreen()

  /** 'disabled' (accounts off), 'loading', 'signedOut' or signed in. */
  const status = computed(() => state.status)
  const signedIn = computed(() => !['disabled', 'loading', 'signedOut'].includes(state.status))
  const displayName = computed(() => state.account?.user?.displayName || user.value?.email || '')
  const email = computed(() => user.value?.email || '')
  const initial = computed(() => (displayName.value.trim()[0] ?? '?').toUpperCase())
  const planLabel = computed(() => PLAN_LABELS[plan.value] ?? plan.value ?? '')
  const isPaid = computed(() => !!plan.value && plan.value !== 'free')
  const hasSubscription = computed(() => !!state.account?.subscription)
  const pastDue = computed(() => state.account?.subscription?.status === 'past_due')
  /** "Renews 21 Nov 2026" / "Ends 21 Nov 2026" / "Payment failed — update your card". */
  const subscriptionLine = computed(() => subscriptionLineFor(state.account?.subscription))
  const accountError = computed(() => state.accountError)
  /** Show the way up: a free account whose plan loaded. */
  const canUpgrade = computed(() => !isPaid.value && !state.accountError && !!state.account)

  function signIn() { auth.openDialog('signIn') }
  function signUp() { auth.openDialog('signUp') }
  function upgrade() { auth.openUpgrade() }
  function openAccount(section = 'overview') { accountScreen.open(section) }

  async function manageBilling() {
    const { error } = await billing.manage()
    if (error) showToast(error, 5000)
  }

  async function signOut() {
    const { error } = await auth.signOut()
    // Still signed in — say so rather than leaving the menu looking unchanged.
    if (error) showToast(`Couldn’t sign out: ${error}`, 5000)
  }

  return {
    status, signedIn, displayName, email, initial, planLabel, isPaid, hasSubscription,
    pastDue, subscriptionLine, accountError, canUpgrade,
    signIn, signUp, upgrade, openAccount, manageBilling, signOut,
  }
}
