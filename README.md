# My Budget Tracker (personal)

A private, local-only budget tracker: weekly + monthly spending, category budgets, and smart import from bank notifications and CSV statements.

## Security model

- **Not connected to any financial account.** No bank login, no Plaid, no Venmo login — there is nothing in this code that can reach BofA, Capital One, or Venmo.
- **No backend, no cloud sync, no analytics, no relay.** By default the app sends user data nowhere. The CSP allows network calls only to Google's own domains, and only for the optional Gmail sync below; the service worker caches only the app's own files (same-origin) for offline use and never intercepts Google traffic.
- **Optional direct Gmail sync (Settings → Gmail sync).** The user creates their own Google Cloud OAuth client (personal use) and pastes the public Client ID into the app. On sync, Google Identity Services issues a short-lived `gmail.readonly` access token that is kept **in memory only**; the app queries Gmail directly from the device for alert emails from Venmo / Capital One / BofA senders, parses them on-device, and stores only the resulting transactions locally. No transaction data passes through any server of ours, and no client secret or API key is used.
- **Data lives only on the device** where it's used, in that browser's local storage. This repository contains the app code only — no financial data.
- **Optional PIN lock** stores only a salted SHA-256 hash of the PIN. It locks the app screen; it does not encrypt local storage (the phone's own device lock protects that).
- Transactions otherwise come in only when the user pastes a notification or picks a CSV file themselves.

## Import formats

- **Paste:** BofA / Capital One alert text, Venmo "paid you / you paid" notifications, generic "$X at Merchant" lines — one per line for bulk import. Unparseable lines are reported, never silently dropped.
- **CSV:** BofA, Capital One (Debit/Credit columns), and Venmo exports are auto-detected. Duplicates (same date + amount + merchant + source) are skipped and counted.
- Venmo payments and credit-card payments default to **Transfer**, so they never double-count as spending or income; recategorize any transaction with one tap.

## Files

`index.html`, `styles.css`, `app.js` (UI + storage), `parser.js` (pure parsing/totals engine, Node-testable), `manifest.json`, `sw.js`, icons.

## Design credits

- Typeface: [Inter](https://github.com/rsms/inter) by Rasmus Andersson (SIL OFL), vendored locally as woff2.
- Icons: [Lucide](https://github.com/lucide-icons/lucide) (ISC), vendored inline as SVG — no icon fonts, no emoji, no external requests.
- Layout tokens follow the slate + amber conventions popularized by Tailwind CSS / shadcn-style design systems, hand-implemented in `styles.css` so the app stays dependency-free and offline.
