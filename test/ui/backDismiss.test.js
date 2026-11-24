import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerBackDismiss, dismissTopOverlay } from '../../src/ui/backDismiss.js'

test('the newest open overlay takes the Back; a closed one passes it on', () => {
  const calls = []
  let menuOpen = true
  const offDialog = registerBackDismiss(() => { calls.push('dialog'); return true })
  const offMenu = registerBackDismiss(() => {
    calls.push('menu')
    if (!menuOpen) return false
    menuOpen = false
    return true
  })
  assert.equal(dismissTopOverlay(), true)
  assert.deepEqual(calls, ['menu'])
  assert.equal(dismissTopOverlay(), true)
  assert.deepEqual(calls, ['menu', 'menu', 'dialog'])
  offDialog()
  offMenu()
  assert.equal(dismissTopOverlay(), false, 'nothing registered: the ladder carries on')
})
