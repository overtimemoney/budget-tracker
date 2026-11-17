# My Budget Tracker (personal)

A private, local-only budget tracker: weekly + monthly spending, category budgets, and smart import from bank notifications and CSV statements.

## Security model

- **Not connected to any financial account.** No bank login, no Plaid, no Venmo login, no API keys — there is nothing in this code that can reach BofA, Capital One, or Venmo.
- **No backend, no cloud, no analytics.** The app makes zero network requests with user data (`connect-src 'none'` in the CSP; service worker only caches the app's own files for offline use).
- **Data lives only on the device** where it's used, in that browser's local storage. This repository contains the app code only — no financial data.
- **Optional PIN lock** stores only a salted SHA-256 hash of the PIN. It locks the app screen; it does not encrypt local storage (the phone's own device lock protects that).
- Transactions come in only when the user pastes a notification or picks a CSV file themselves.

## Import formats

- **Paste:** BofA / Capital One alert text, Venmo "paid you / you paid" notifications, generic "$X at Merchant" lines — one per line for bulk import. Unparseable lines are reported, never silently dropped.
- **CSV:** BofA, Capital One (Debit/Credit columns), and Venmo exports are auto-detected. Duplicates (same date + amount + merchant + source) are skipped and counted.
- Venmo payments and credit-card payments default to **Transfer**, so they never double-count as spending or income; recategorize any transaction with one tap.

## Files

`index.html`, `styles.css`, `app.js` (UI + storage), `parser.js` (pure parsing/totals engine, Node-testable), `manifest.json`, `sw.js`, icons.
