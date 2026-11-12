#!/usr/bin/env node
// Builds the Supabase Auth email templates in supabase/templates/ from ONE
// layout, so the eight emails cannot drift apart. Run after editing:
//
//   node scripts/build-auth-emails.mjs
//
// The output is plain HTML with Supabase's Go-template variables
// ({{ .ConfirmationURL }}, {{ .Token }}, {{ .SiteURL }}, {{ .Email }},
// {{ .NewEmail }}) left in place. Paste each file into Authentication → Emails
// in the dashboard, with the subject listed in docs/user-accounts.md, or point
// supabase/config.toml at them (`content_path`). Subjects live in SUBJECTS below
// and are printed when the script runs.
//
// Email-client rules this layout follows: tables for layout, every style
// inline, `bgcolor` attributes beside background styles (Outlook), no web
// fonts required (Inter if installed, then system faces), the logo as an
// absolute URL with explicit width/height and alt text, and a plain-text
// fallback link under every button.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'templates')

// Tokens from src/main.css (@theme) and the logo, so the emails match the app.
const C = {
  page: '#0e1116',        // body background
  card: '#141922',        // --gradient-rail's top stop
  border: '#232a35',      // --color-border-2 flattened onto the card
  text: '#eaf6f8',        // --color-text
  soft: '#a9b1b8',        // ~ --color-text-softer on the card
  dim: '#6f7780',         // ~ --color-text-muted
  accent: '#35d3e6',      // --color-accent (primary button fill)
  onAccent: '#08161a',    // .auth-btn--primary text
  link: '#7fe9f6',        // --color-accent-bright
}
const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MONO = "'JetBrains Mono', SFMono-Regular, Menlo, Consolas, monospace"

const SUBJECTS = {
  'confirm-signup': 'Confirm your crisp.fm account',
  'invite': 'You’re invited to crisp.fm',
  'magic-link': 'Your crisp.fm sign-in link',
  'change-email': 'Confirm your new email for crisp.fm',
  'reset-password': 'Reset your crisp.fm password',
  'reauthentication': 'Your crisp.fm verification code',
  'password-changed': 'Your crisp.fm password was changed',
  'email-changed': 'Your crisp.fm email was changed',
}

const button = (href, label) => `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">
              <tr>
                <td bgcolor="${C.accent}" style="border-radius:10px;background:${C.accent};">
                  <a href="${href}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:14px;font-weight:700;line-height:20px;color:${C.onAccent};text-decoration:none;border-radius:10px;">${label}</a>
                </td>
              </tr>
            </table>
            <p style="margin:24px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.dim};">Button not working? Paste this link into your browser:<br><a href="${href}" target="_blank" style="color:${C.link};text-decoration:none;word-break:break-all;">${href}</a></p>`

const code = (token) => `
            <div style="margin:24px 0 0;padding:14px 0;border:1px solid ${C.border};border-radius:10px;text-align:center;font-family:${MONO};font-size:26px;font-weight:700;letter-spacing:0.3em;color:${C.text};">${token}</div>`

const para = (html) => `
            <p style="margin:12px 0 0;font-family:${FONT};font-size:14px;line-height:22px;color:${C.soft};">${html}</p>`

const note = (html) => `
            <p style="margin:24px 0 0;padding-top:16px;border-top:1px solid ${C.border};font-family:${FONT};font-size:12px;line-height:18px;color:${C.dim};">${html}</p>`

const strong = (s) => `<span style="color:${C.text};font-weight:600;">${s}</span>`

function layout({ title, preheader, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};" bgcolor="${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page};">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
        <tr>
          <td style="padding:0 4px 20px;">
            <a href="{{ .SiteURL }}" target="_blank" style="text-decoration:none;"><img src="{{ .SiteURL }}/crisp-fm-logo.png" width="104" height="26" alt="crisp.fm" style="display:block;border:0;width:104px;height:26px;"></a>
          </td>
        </tr>
        <tr>
          <td bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:32px 28px;">
            <h1 style="margin:0;font-family:${FONT};font-size:20px;font-weight:800;line-height:28px;letter-spacing:-0.01em;color:${C.text};">${title}</h1>${body}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 4px 0;font-family:${FONT};font-size:11px;line-height:16px;color:${C.dim};">crisp.fm · audio editing in your browser</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
`
}

const TEMPLATES = {
  'confirm-signup': {
    title: 'Confirm your email',
    preheader: 'One click to finish creating your crisp.fm account.',
    body: para('Click below to finish creating your crisp.fm account.')
      + button('{{ .ConfirmationURL }}', 'Confirm email')
      + note('Didn’t sign up? You can ignore this email.'),
  },
  'invite': {
    title: 'You’re invited',
    preheader: 'Accept your invitation to crisp.fm.',
    body: para('You’ve been invited to create a crisp.fm account.')
      + button('{{ .ConfirmationURL }}', 'Accept invitation')
      + note('Not expecting this? You can ignore this email.'),
  },
  'magic-link': {
    title: 'Sign in to crisp.fm',
    preheader: 'Your sign-in link. It works once.',
    body: para('Click below to sign in. The link works once and expires shortly.')
      + button('{{ .ConfirmationURL }}', 'Sign in')
      + note('Didn’t ask to sign in? You can ignore this email.'),
  },
  'change-email': {
    title: 'Confirm your new email',
    preheader: 'Confirm the change to your crisp.fm sign-in email.',
    body: para(`Confirm changing your sign-in email from ${strong('{{ .Email }}')} to ${strong('{{ .NewEmail }}')}.`)
      + button('{{ .ConfirmationURL }}', 'Confirm change')
      + note('Didn’t ask for this? Ignore this email and your address stays the same.'),
  },
  'reset-password': {
    title: 'Reset your password',
    preheader: 'Choose a new password for crisp.fm.',
    body: para('Click below to choose a new password. The link works once and expires shortly.')
      + button('{{ .ConfirmationURL }}', 'Reset password')
      + note('Didn’t ask for a reset? You can ignore this email. Your password won’t change.'),
  },
  'reauthentication': {
    title: 'Your verification code',
    preheader: 'Enter this code to confirm it’s you.',
    body: para('Enter this code in crisp.fm to confirm it’s you.')
      + code('{{ .Token }}')
      + note('Didn’t ask for a code? Someone may know your password. Change it to be safe.'),
  },
  'password-changed': {
    title: 'Your password was changed',
    preheader: 'The password for your crisp.fm account was just changed.',
    body: para(`The password for ${strong('{{ .Email }}')} was just changed.`)
      + note('Wasn’t you? Reset your password from the sign-in screen right away.'),
  },
  'email-changed': {
    title: 'Your email was changed',
    preheader: 'The sign-in email for your crisp.fm account was changed.',
    body: para('The sign-in email for your crisp.fm account was just changed.')
      + note('Wasn’t you? Contact us right away so we can secure your account.'),
  },
}

mkdirSync(OUT_DIR, { recursive: true })
for (const [name, t] of Object.entries(TEMPLATES)) {
  writeFileSync(join(OUT_DIR, `${name}.html`), layout(t))
  console.log(`${name}.html`.padEnd(24), SUBJECTS[name])
}
