/* Parser + totals engine. Pure functions, no network, no storage.
   Works in browser (window.PBT) and Node (module.exports) for tests. */
(function (root) {
'use strict';

var CATEGORIES = ['Dining','Groceries','Transport','Shopping','Bills & Utilities', 'Housing','Entertainment','Health','Travel','Income','Transfer','Other'];

var RULES = [
  [/chipotle|mcdonald|starbucks|dunkin|wendy|burger|pizza|taco|doordash|uber ?eats|grubhub|restaurant|cafe|coffee|panera|chick-fil-a|subway|kfc|five guys|shake shack/i,'Dining'],
  [/market basket|trader joe|whole foods|stop ?& ?shop|shaw|hannaford|aldi|kroger|walmart grocery|instacart|grocery|supermarket|costco/i,'Groceries'],
  [/shell|exxon|mobil|bp |gas station|uber(?! ?eats)|lyft|mbta|parking|toll|amtrak|delta|united air|american air|jetblue|southwest|airbnb|hotel/i,'Transport'],
  [/amazon|target|walmart(?! grocery)|best buy|nike|apple store|etsy|ebay|home depot|lowe|tj ?maxx|marshalls/i,'Shopping'],
  [/electric|water bill|comcast|xfinity|verizon|at&t|t-mobile|internet|utility|rent|mortgage|insurance|geico|progressive/i,'Bills & Utilities'],
  [/netflix|spotify|hulu|hbo|disney|movie|theater|steam|playstation|xbox|ticketmaster/i,'Entertainment'],
  [/cvs|walgreens|pharmacy|doctor|dental|hospital|clinic|gym|planet fitness/i,'Health']
];
function categorize(merchant, source, direction) {
  if (direction === 'in') return 'Income';
  if (source === 'Venmo') return 'Transfer';
  var m = String(merchant || '');
  for (var i = 0; i < RULES.length; i++) if (RULES[i][0].test(m)) return RULES[i][1];
  if (/hotel|airbnb|flight|airlines/i.test(m)) return 'Travel';
  return 'Other';
}

function moneyToCents(s) {
  if (s == null) return null;
  var neg = /\(|^-|^-\$/.test(String(s).trim());
  var n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
  if (isNaN(n)) return null;
  var c = Math.round(n * 100);
  return neg ? -c : c;
}
function todayISO(d) {
  d = d || new Date();
  var p = function (x) { return String(x).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
var MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
function extractDate(text, fallback) {
  var m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[3]).padStart(2,'0');
  m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { var y = +m[3]; if (y < 100) y += 2000; return y + '-' + String(m[1]).padStart(2,'0') + '-' + String(m[2]).padStart(2,'0'); }
  m = text.match(/(\d{1,2})\/(\d{1,2})\b/);
  if (m) { var yr = new Date().getFullYear(); return yr + '-' + String(m[1]).padStart(2,'0') + '-' + String(m[2]).padStart(2,'0'); }
  m = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (m) return (m[3] ? +m[3] : new Date().getFullYear()) + '-' + String(MONTHS[m[1].slice(0,3).toLowerCase()] + 1).padStart(2,'0') + '-' + String(m[2]).padStart(2,'0');
  return fallback || todayISO();
}
function cleanMerchant(s) {
  var out = String(s || '').replace(/\s+/g, ' ')
    .replace(/\s+(was posted|was charged|has posted|posted to your account|on your card.*|ending in \d+.*)$/i, '')
    .replace(/\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*$/, '')
    .replace(/[.·]+$/, '').trim();
  return out.slice(0, 60) || 'Unknown';
}
function detectSource(text) {
  if (/venmo/i.test(text)) return 'Venmo';
  if (/capital one/i.test(text)) return 'Capital One';
  if (/bank of america|bofa|bk of america/i.test(text)) return 'BofA';
  return 'Other';
}

/* Parse ONE notification / text line into a txn draft, or null. */
function parseNotification(line, fallbackDate) {
  var text = String(line || '').trim();
  if (!text) return null;
  var amtM = text.match(/\$\s?([\d,]+\.\d{2}|[\d,]+)/);
  if (!amtM) return null;
  var cents = Math.abs(moneyToCents(amtM[1]));
  if (!cents) return null;
  var source = detectSource(text);
  var date = extractDate(text, fallbackDate);
  var merchant = '', direction = 'out', m;

  // Venmo: "X paid you $25.00 for ..." / "You paid X $25.00"
  if ((m = text.match(/^(.*?)\s+paid you\b/i)) && source === 'Venmo' || /paid you/i.test(text)) {
    merchant = cleanMerchant((text.match(/^(.*?)\s+paid you\b/i) || [])[1] || 'Venmo');
    direction = 'in'; source = 'Venmo';
    var noteM = text.match(/paid you[^$]*\$[\d,.]+\s*(?:for\s+)?(.+)$/i);
    var note = noteM ? cleanMerchant(noteM[1].replace(/\s+on venmo$/i, '')) : '';
    return mk(date, cents, direction, merchant, source, note);
  }
  if ((m = text.match(/you (?:paid|sent|charged)\s+(.*?)\s+\$/i))) {
    merchant = cleanMerchant(m[1]); direction = 'out'; if (/venmo/i.test(text)) source = 'Venmo';
    return mk(date, cents, direction, merchant, source, '');
  }
  if (/venmo/i.test(text) && (m = text.match(/\$[\d,.]+\s*(?:to|from)\s+(.+?)(?:\s+for\b|[.·]|$)/i))) {
    merchant = cleanMerchant(m[1]); direction = /from/i.test(text) ? 'in' : 'out'; source = 'Venmo';
    return mk(date, cents, direction, merchant, source, '');
  }
  // Refund / deposit / payment received
  if (/(refund|deposit|credited|payment received|direct dep|payroll|salary)/i.test(text)) direction = 'in';
  // Merchant after at/for
  if ((m = text.match(/\$[\d,.]+\s+(?:at|for|to)\s+([^.·\n]+?)(?:\s+on\s+|\s+ending|\.|$)/i))) merchant = cleanMerchant(m[1]);
  else if ((m = text.match(/(?:charge of|purchase of|spent|charged)\s+\$[\d,.]+\s+(?:at\s+)?([^.·\n]+?)(?:\.|$)/i))) merchant = cleanMerchant(m[1]);
  else if ((m = text.match(/^([^:$]+?)\s*[:\-]\s*\$/))) merchant = cleanMerchant(m[1].replace(/alert|notification|bank of america|capital one/gi, ''));
  if (!merchant || /^(bank of america|capital one|bofa|alert)$/i.test(merchant)) merchant = source !== 'Other' ? source + ' purchase' : 'Purchase';
  return mk(date, cents, direction, merchant, source, '');
}
function mk(date, cents, direction, merchant, source, note) {
  var cat = categorize(merchant, source, direction);
  if (/card payment|payment.*thank you|autopay payment/i.test(merchant)) cat = 'Transfer'; // paying your own card is not income
  else if (source === 'Venmo') cat = 'Transfer'; // Venmo in/out defaults to Transfer: excluded from spent/income until the user recategorizes it
  else if (direction === 'in') cat = 'Income';
  if ((merchant === 'Purchase' || merchant === 'Unknown') && direction === 'in') merchant = 'Deposit';
  return { date: date, cents: cents, direction: direction, merchant: merchant, source: source, category: cat, note: note || '' };
}

/* Bulk paste: one notification per line. Reports parsed AND skipped — never silent. */
function parseBulk(text, fallbackDate) {
  var lines = String(text || '').split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
  var out = [], skipped = [];
  lines.forEach(function (l) { var t = parseNotification(l, fallbackDate); if (t) out.push(t); else skipped.push(l); });
  return { txns: out, skipped: skipped, totalLines: lines.length };
}

/* ---- CSV ---- */
function parseCSVText(text) {
  var rows = [], row = [], cur = '', q = false;
  text = String(text || '');
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (q) { if (ch === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i+1] === '\n') i++; row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}
function parseCSV(text) {
  var rows = parseCSVText(text).filter(function (r) { return r.join('').trim(); });
  if (rows.length < 2) return { txns: [], skipped: rows.length, format: 'unknown' };
  // Find header row within first 6 rows
  var hi = -1, hdr = null;
  for (var r = 0; r < Math.min(6, rows.length); r++) {
    var j = rows[r].join(',').toLowerCase();
    if (/date/.test(j) && /(description|name|note|from|merchant)/.test(j)) { hi = r; hdr = rows[r].map(function (h) { return h.trim().toLowerCase(); }); break; }
  }
  if (hi < 0) return { txns: [], skipped: rows.length, format: 'unknown' };
  function col() { for (var a = 0; a < arguments.length; a++) { var ix = hdr.indexOf(arguments[a]); if (ix >= 0) return ix; } return -1; }
  function colLike(re) { for (var i = 0; i < hdr.length; i++) if (re.test(hdr[i])) return i; return -1; }
  var isVenmo = hdr.indexOf('from') >= 0 && colLike(/amount/) >= 0 && /venmo|note/.test(hdr.join(','));
  var iDate = col('transaction date', 'posted date', 'date', 'datetime') >= 0 ? (col('transaction date') >= 0 ? col('transaction date') : colLike(/date/)) : colLike(/date/);
  var iDesc = col('description', 'name', 'note', 'details');
  var iFrom = col('from'), iTo = col('to');
  var iAmt = colLike(/^amount/);
  var iDebit = col('debit'), iCredit = col('credit');
  var format = isVenmo ? 'Venmo' : (iDebit >= 0 || iCredit >= 0 ? 'Capital One' : (iAmt >= 0 ? 'BofA / generic' : 'generic'));
  var source = isVenmo ? 'Venmo' : (format === 'Capital One' ? 'Capital One' : 'BofA');
  var txns = [], skipped = 0;
  for (var k = hi + 1; k < rows.length; k++) {
    var cells = rows[k];
    var date = extractDate(cells[iDate] || '', null);
    if (!cells[iDate] || date === todayISO() && !/\d/.test(cells[iDate])) { skipped++; continue; }
    var cents = null, direction = 'out', merchant = '';
    if (isVenmo) {
      cents = moneyToCents(cells[iAmt]);
      if (cents == null) { skipped++; continue; }
      direction = cents < 0 ? 'out' : 'in'; cents = Math.abs(cents);
      merchant = cleanMerchant(direction === 'out' ? (cells[iTo] || cells[iDesc]) : (cells[iFrom] || cells[iDesc]));
    } else if (iDebit >= 0 || iCredit >= 0) {
      var d = moneyToCents(cells[iDebit]), c = moneyToCents(cells[iCredit]);
      if (d) { cents = Math.abs(d); direction = 'out'; } else if (c) { cents = Math.abs(c); direction = 'in'; }
      if (!cents) { skipped++; continue; }
      merchant = cleanMerchant(cells[iDesc]);
    } else {
      cents = moneyToCents(cells[iAmt]);
      if (cents == null) { skipped++; continue; }
      direction = cents < 0 ? 'out' : 'in';
      if (/bank of america/i.test(text.slice(0, 500))) direction = cents < 0 ? 'out' : 'in';
      cents = Math.abs(cents); merchant = cleanMerchant(cells[iDesc]);
    }
    if (!merchant) { skipped++; continue; }
    txns.push(mk(date, cents, direction, merchant, source, ''));
  }
  return { txns: txns, skipped: skipped, format: format };
}

/* ---- Dedup + totals (totals always recomputed fresh from the txn list) ---- */
function hashTxn(t) {
  return [t.date, t.cents, String(t.merchant || '').toLowerCase().replace(/[^a-z0-9]/g, ''), t.source, t.direction].join('|');
}
function dedup(existing, incoming) {
  var seen = {}, added = [], dupes = 0;
  existing.forEach(function (t) { seen[hashTxn(t)] = 1; });
  incoming.forEach(function (t) { var h = hashTxn(t); if (seen[h]) dupes++; else { seen[h] = 1; added.push(t); } });
  return { added: added, dupes: dupes };
}
function periodRange(kind, anchorISO) {
  var a = new Date(anchorISO + 'T12:00:00');
  var p = function (x) { return String(x).padStart(2, '0'); };
  var iso = function (d) { return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  if (kind === 'month') {
    var s = new Date(a.getFullYear(), a.getMonth(), 1), e = new Date(a.getFullYear(), a.getMonth() + 1, 0);
    return { start: iso(s), end: iso(e), days: e.getDate() };
  }
  var dow = (a.getDay() + 6) % 7; // Monday start
  var s2 = new Date(a); s2.setDate(a.getDate() - dow);
  var e2 = new Date(s2); e2.setDate(s2.getDate() + 6);
  return { start: iso(s2), end: iso(e2), days: 7 };
}
function totals(txns, range) {
  var spent = 0, income = 0, byCat = {}, byDay = {};
  txns.forEach(function (t) {
    if (t.date < range.start || t.date > range.end) return;
    if (t.direction === 'out' && t.category !== 'Transfer') { spent += t.cents; byCat[t.category] = (byCat[t.category] || 0) + t.cents; byDay[t.date] = (byDay[t.date] || 0) + t.cents; }
    else if (t.direction === 'in' && t.category !== 'Transfer') income += t.cents;
    else if (t.category === 'Transfer') { /* transfers tracked in list, excluded from spent/income */ }
  });
  return { spent: spent, income: income, net: income - spent, byCat: byCat, byDay: byDay };
}

/* ---- Gmail alert emails (used by the direct Gmail sync) ----
   Mirrors the subject rules of the Luna-side scanner: only completed payments
   count; requests, cancellations, comments, statements and marketing are out. */
var GMAIL_SENDERS = ['venmo@venmo.com', 'capitalone@notification.capitalone.com', 'onlinebanking@ealerts.bankofamerica.com'];
function gmailSearchQuery(sinceISO) {
  var d = new Date(sinceISO + 'T12:00:00');
  var p = function (x) { return String(x).padStart(2, '0'); };
  return 'from:(' + GMAIL_SENDERS.join(' OR ') + ') after:' + d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate());
}
function parseGmailAlert(from, subject, dateISO) {
  var subj = String(subject || '').trim();
  var sender = String(from || '').toLowerCase();
  var date = dateISO || todayISO();
  if (!subj) return null;
  var low = subj.toLowerCase();
  var skip = ['request', 'cancel', 'comment', 'history', 'statement', 'security', 'rewards', 'autopay', 'password', 'verification', 'sign-in', 'sign in'];
  for (var i = 0; i < skip.length; i++) if (low.indexOf(skip[i]) >= 0) return null;
  var m;
  if (sender.indexOf('venmo') >= 0) {
    if ((m = subj.match(/^You paid (.+?) \$([\d,]+\.\d{2})/))) return mk(date, Math.round(parseFloat(m[2].replace(/,/g, '')) * 100), 'out', cleanMerchant(m[1]), 'Venmo', '');
    if ((m = subj.match(/^(.+?) paid (?:you )?\$([\d,]+\.\d{2})(?:\s+for\s+(.+))?$/))) return mk(date, Math.round(parseFloat(m[2].replace(/,/g, '')) * 100), 'in', cleanMerchant(m[1]), 'Venmo', m[3] ? cleanMerchant(m[3]) : '');
    return null;
  }
  var src = sender.indexOf('capitalone') >= 0 ? 'Capital One' : (sender.indexOf('bankofamerica') >= 0 ? 'BofA' : null);
  if (src) {
    if ((m = subj.match(/\$([\d,]+\.\d{2})\s+(?:charge|spent|purchase)[^$]*?(?:at|from)\s+(.+)$/i))) {
      var draft = mk(date, Math.round(parseFloat(m[1].replace(/,/g, '')) * 100), 'out', cleanMerchant(m[2]), src, '');
      draft.category = categorize(draft.merchant, src, 'out');
      return draft;
    }
    // Fall back to the generic notification parser for other bank subject shapes.
    var g = parseNotification(subj + ' ' + src, date);
    if (g) { g.source = src; if (g.category === 'Transfer' && !/payment/i.test(subj)) g.category = categorize(g.merchant, src, g.direction); return g; }
  }
  return null;
}
function decodeBase64Url(data) {
  var b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

var api = { CATEGORIES: CATEGORIES, categorize: categorize, moneyToCents: moneyToCents, todayISO: todayISO, extractDate: extractDate, parseNotification: parseNotification, parseBulk: parseBulk, parseCSV: parseCSV, parseCSVText: parseCSVText, hashTxn: hashTxn, dedup: dedup, periodRange: periodRange, totals: totals, GMAIL_SENDERS: GMAIL_SENDERS, gmailSearchQuery: gmailSearchQuery, parseGmailAlert: parseGmailAlert, decodeBase64Url: decodeBase64Url };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
root.PBT = api;
})(typeof window !== 'undefined' ? window : globalThis);
