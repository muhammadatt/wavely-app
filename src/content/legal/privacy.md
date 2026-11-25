<!--
  EDITING THIS FILE
  This is the text of https://<your domain>/privacy/. Plain Markdown: # headings,
  - bullets, **bold**, [links](https://…). Comments like this one never show.
  `npm run dev` reloads the page as you save; production updates on the next deploy.

  BEFORE PUBLISHING: replace every [BRACKETED] placeholder, check the list of
  service providers against the accounts you actually use, and have a lawyer
  read it. This draft describes how the code works as of November 2026 —
  if you add analytics, ads, error tracking or a new provider, update it here.
-->

# Privacy Policy

**Effective date:** 21 November 2026

This policy explains what personal data crisp.fm collects, why, how long we keep it, and the choices you have. It applies to the crisp.fm editor, its product and help pages, and related services (the "Service"), operated by [COMPANY LEGAL NAME], [REGISTERED ADDRESS] ("we", "us"). We are the controller of the personal data described here.

> **In short:** most editing happens on your own device and never reaches us. Audio you send for server processing is used only to process it and is deleted automatically, normally within an hour. We keep the minimum needed to run accounts, billing and fair-use limits. We don't sell your data, show ads, or use your audio to train models.

## 1. Audio and files

**Processed on your device.** Opening files, editing, nearly all effects, and saving or exporting run in your browser. That audio is not sent to us.

**Sent to our servers.** Some features upload audio to our servers: mastering presets, noise reduction, and certain analyses (for example, the speech detection the Auto Leveler uses). For these:

- the audio is uploaded, processed and the result returned to you;
- an upload that is not used is deleted after 60 minutes of inactivity; an upload is moved out of the upload store as soon as a job takes it;
- finished results are held in memory for download and deleted when downloaded or one hour after the job finishes, whichever comes first; temporary processing files are deleted when the job ends;
- we do not listen to your audio, use it to train machine-learning models, or share it with anyone other than the hosting provider that runs our processing servers and our network provider (Cloudflare), through which uploads pass in transit.

**Shared before / after pages.** If you choose Share in the Plugin Chain, we store two MP3 copies of the part you share (before and after the chain), the chain's settings, and the title and note you write, in our storage provider (Supabase), linked to your account. Anyone who has the page's link can listen to and download both copies and see the title, note and chain; the page does not show who shared it, and shares are not listed or indexed by us. They stay until you delete them (Plugin Chain → Share… → Your shares), or until your account is deleted. Only share audio you have the right to share.

**Kept in your browser.** To protect unsaved work, the editor keeps copies of files with unsaved edits in your browser's private storage (the Origin Private File System), with your timeline and selection. This stays on your device and is never sent to us. It is removed when you save or discard the work, or you can remove it by clearing this site's data in your browser.

**Folders you choose.** If you pick a working folder or save over an original file, your browser gives the page permission to write there. We never see the folder's location on your computer.

## 2. Information we collect

**Account information** (if you create an account): your email address, a display name if you give one, and which sign-in methods you use (email and password, email link, or a provider such as Google). If you sign in with a provider, we receive your email address and basic profile information from it. Passwords are handled by our authentication provider and stored only as secure hashes.

**Saved presets and settings.** Effect presets and saved plugin chains you choose to save to your account.

**Billing information** (if you subscribe): your plan, billing interval, subscription status and dates, and a Stripe customer ID. Card details are collected and stored by Stripe, not by us.

**Usage records for server features.** When you use a server feature we record: your account ID (if signed in), your IP address, the feature used, the time, the size and duration of the audio, how long processing took, and whether it succeeded. We use these to enforce plan and fair-use limits, prevent abuse, and understand load.

**Technical logs.** Our servers and our network provider log requests, including IP address, browser user agent, time, and the address requested. These are used for security, rate limiting and troubleshooting.

**Communications.** If you email us, we keep the correspondence.

We do not knowingly collect special categories of data. Please do not include sensitive personal information in recordings you send for server processing unless you need to.

## 3. Cookies and local storage

We do not use advertising or cross-site tracking cookies, and we do not currently use analytics tools.

The Service stores a few things in your browser so it works:

- your sign-in session (so you stay logged in);
- preferences such as layout, panel settings and recently used options;
- records of server jobs in progress, so a job can be picked up if you close and reopen a tab;
- unsaved work, as described above.

These are strictly necessary for the features you use, or are preferences you set, so we do not ask for consent separately. Clearing your browser's site data removes them.

The editor, product and help pages load fonts from Google Fonts, which means your browser connects to Google, which receives your IP address. [Consider self-hosting the fonts to remove this.]

## 4. How we use information and our legal bases

- **To provide the Service** — processing your audio, running your account, storing your presets, delivering paid features. *Legal basis: performance of our contract with you.*
- **Billing** — taking payment and managing subscriptions. *Contract; legal obligation for tax and accounting records.*
- **Security and fair use** — rate limits, queue limits, blocking abuse, investigating problems. *Our legitimate interest in keeping the Service secure and available.*
- **Service emails** — sign-in links, password resets, receipts and important changes to the Service or these policies. *Contract; legitimate interest.*
- **Improving the Service** — aggregate counts of feature use and processing times. *Legitimate interest.*
- **Legal compliance** — responding to lawful requests and enforcing our [Terms](/terms/). *Legal obligation; legitimate interest.*

We do not sell or rent personal data, and we do not use it for targeted advertising. We do not make decisions with legal or similarly significant effects about you by automated means.

## 5. Service providers

We share personal data only with providers that process it on our behalf, under contract, to run the Service:

- **Supabase** — authentication and our account database (email, profile, presets, subscription status, usage records).
- **Stripe** — payments and subscription management. Stripe is also an independent controller for some data under its own [privacy policy](https://stripe.com/privacy).
- **Vercel** — hosts the website and editor.
- **[SERVER HOSTING PROVIDER]** — hosts our processing servers, where uploaded audio is processed.
- **Cloudflare** — network security and delivery for our API; audio you upload for processing passes through it in transit.
- **Google** — sign-in with Google (if you choose it) and web fonts.
- **[EMAIL PROVIDER]** — sends sign-in and account emails.

We may also disclose information if required by law, to protect the rights and safety of our users or others, or as part of a merger, acquisition or sale of assets, in which case this policy will continue to apply to your data.

## 6. International transfers

Our providers may process data outside your country, including in the United States. Where data from the EEA, UK or Switzerland is transferred to a country without an adequacy decision, we rely on the European Commission's Standard Contractual Clauses (and the UK addendum) or another lawful transfer mechanism.

## 7. How long we keep data

- **Server uploads and results:** deleted automatically — unused uploads after 60 minutes idle, results at download or one hour after the job finishes.
- **Usage records:** 90 days, then deleted automatically.
- **Server and network logs:** [30] days.
- **Account data and saved presets:** while your account exists; deleted within [30] days of account deletion, except as below.
- **Billing records:** as long as tax and accounting law requires (typically [7] years). Stripe keeps its own records under its policy.
- **Shared before / after pages:** until you delete them; with your account, within [30] days of account deletion.
- **Data on your device:** until you save, discard or clear it.

## 8. Your rights

Depending on where you live, you may have the right to:

- access the personal data we hold about you and get a copy;
- correct inaccurate data;
- delete your data;
- object to or restrict certain processing, including processing based on legitimate interests;
- receive your data in a portable format;
- withdraw consent where we rely on it.

**California residents** have the right to know, delete and correct personal information and to opt out of its sale or sharing; we do not sell or share personal information as those terms are defined. We will not discriminate against you for exercising your rights.

To exercise any right, email [PRIVACY CONTACT EMAIL]. We will respond within the time the law requires (usually one month) and may need to verify your identity. You can also lodge a complaint with your local data protection authority.

## 9. Security

We use encryption in transit (HTTPS), access controls on our database so each account can read only its own data, short retention for audio, and limits on uploads and processing. No system is perfectly secure; if a breach affects your personal data we will notify you and the authorities as the law requires.

## 10. Children

The Service is not directed at children under 16, and we do not knowingly collect their personal data. If you believe a child has given us personal data, contact us and we will delete it.

## 11. Changes to this policy

We may update this policy. If the changes are material, we will tell you by email or in the app before they take effect. The effective date at the top shows the current version.

## 12. Contact

**[COMPANY LEGAL NAME]**, [REGISTERED ADDRESS] — [PRIVACY CONTACT EMAIL]

[If you are in the EEA or UK and we are established outside it, add the details of our EU / UK representative here.]
