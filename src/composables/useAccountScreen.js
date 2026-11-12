import { useAuth } from './useAuth.js'
import { createAccountScreen } from '../auth/accountScreen.js'

/**
 * The full-screen account dashboard's open state and section, one per app.
 * See src/auth/accountScreen.js. Started in App.vue so a deep link
 * (`#/account/billing`) opens on load.
 */
let screen = null

export function useAccountScreen() {
  if (!screen) screen = createAccountScreen({ auth: useAuth() })
  return screen
}
