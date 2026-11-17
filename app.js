/* My Budget Tracker — local-only. No fetch/XHR/beacon anywhere in this file by design. */
(function () {
'use strict';
var P = window.PBT;
var KEY = 'pbt-v1';
var state = load();
var period = 'week';
var anchor = P.todayISO();
var unlocked = !state.pin;

function blank() { return { txns: [], budgets: {}, pin: null }; }
function load() {
  try { var raw = localStorage.getItem(KEY); if (raw) { var s = JSON.parse(raw); if (s && Array.isArray(s.txns)) return s; } } catch (e) {}
  return blank();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function fmt(c) { var s = c < 0 ? '-' : ''; return s + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
function $(id) { return document.getElementById(id); }

/* ---------- PIN (UI lock; SHA-256 hash + salt, never the PIN itself) ---------- */
function sha256(str) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  });
}
function showLock() { $('lockScreen').classList.remove('hidden'); $('app').classList.add('hidden'); $('tabBar').classList.add('hidden'); }
function showApp() {
  $('lockScreen').classList.add('hidden'); $('app').classList.remove('hidden'); $('tabBar').classList.remove('hidden');
  $('lockBtn').classList.toggle('hidden', !state.pin);
  renderAll();
}
$('unlockBtn').addEventListener('click', tryUnlock);
$('pinInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') tryUnlock(); });
function tryUnlock() {
  var pin = $('pinInput').value;
  if (!state.pin) { unlocked = true; showApp(); return; }
  sha256(state.pin.salt + ':' + pin).then(function (h) {
    if (h === state.pin.hash) { unlocked = true; $('pinError').textContent = ''; showApp(); }
    else $('pinError').textContent = 'Wrong PIN — try again.';
  });
}
$('lockBtn').addEventListener('click', function () { unlocked = false; $('pinInput').value = ''; showLock(); });
document.addEventListener('visibilitychange', function () {
  if (document.hidden && state.pin && unlocked) { unlocked = false; showLock(); }
});
$('setPinBtn').addEventListener('click', function () {
  var pin = $('newPin').value.trim();
  if (pin.length < 4) { $('settingsResult').textContent = 'PIN needs at least 4 characters.'; return; }
  var salt = uid() + uid();
  sha256(salt + ':' + pin).then(function (h) {
    state.pin = { salt: salt, hash: h }; save(); $('newPin').value = '';
    $('settingsResult').textContent = 'PIN set. The app will lock when you switch away from it.';
    $('removePinBtn').classList.remove('hidden'); $('lockBtn').classList.remove('hidden'); updatePinStatus();
  });
});
$('removePinBtn').addEventListener('click', function () {
  state.pin = null; save(); $('settingsResult').textContent = 'PIN removed.';
  $('removePinBtn').classList.add('hidden'); $('lockBtn').classList.add('hidden'); updatePinStatus();
});
function updatePinStatus() { $('pinStatus').textContent = state.pin ? 'PIN is set — the app locks when you switch away from it.' : 'No PIN set. A PIN locks the app screen on this device (it does not encrypt the stored data — your phone’s own lock does that).'; }

/* ---------- Navigation ---------- */
document.querySelectorAll('.tab').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('active', x === b); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
    $('view-' + b.dataset.view).classList.remove('hidden');
    renderAll();
  });
});
document.querySelectorAll('.segBtn').forEach(function (b) {
  b.addEventListener('click', function () {
    period = b.dataset.period;
    document.querySelectorAll('.segBtn').forEach(function (x) { x.classList.toggle('active', x === b); });
    renderHome();
  });
});
function shiftAnchor(dir) {
  var d = new Date(anchor + 'T12:00:00');
  if (period === 'week') d.setDate(d.getDate() + dir * 7); else d.setMonth(d.getMonth() + dir);
  anchor = P.todayISO(d); renderHome();
}
$('prevPeriod').addEventListener('click', function () { shiftAnchor(-1); });
$('nextPeriod').addEventListener('click', function () { shiftAnchor(1); });

/* ---------- Rendering (all totals recomputed fresh from state.txns on every render) ---------- */
function txnRow(t, compact) {
  var sign = t.direction === 'in' ? '+' : '−';
  var cls = t.category === 'Transfer' ? 'transfer' : (t.direction === 'in' ? 'in' : 'out');
  return '<div class="txn ' + cls + '"><div class="txnMain"><strong>' + esc(t.merchant) + '</strong>' +
    '<span class="meta">' + esc(t.date) + ' · ' + esc(t.source) + (t.note ? ' · ' + esc(t.note) : '') + '</span></div>' +
    '<div class="txnAmt">' + sign + fmt(t.cents) + '</div>' +
    (compact ? '' : '<select class="catSel" data-id="' + t.id + '">' + P.CATEGORIES.map(function (c) { return '<option' + (c === t.category ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select><button class="delBtn" data-id="' + t.id + '" aria-label="Delete">✕</button>') +
    '</div>';
}
function bindTxnControls(root) {
  root.querySelectorAll('.catSel').forEach(function (sel) {
    sel.addEventListener('change', function () {
      var t = state.txns.filter(function (x) { return x.id === sel.dataset.id; })[0];
      if (t) { t.category = sel.value; save(); renderAll(); }
    });
  });
  root.querySelectorAll('.delBtn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.txns = state.txns.filter(function (x) { return x.id !== btn.dataset.id; });
      save(); renderAll();
    });
  });
}
function renderHome() {
  var range = P.periodRange(period, anchor);
  var t = P.totals(state.txns, range);
  var label = period === 'week' ? range.start + ' → ' + range.end : new Date(anchor + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  $('periodLabel').textContent = label;
  $('statSpent').textContent = fmt(t.spent);
  $('statIncome').textContent = fmt(t.income);
  $('statNet').textContent = fmt(t.net);
  $('statNet').className = t.net < 0 ? 'red' : 'green';
  // Pace: for the current month, compare spent vs a straight-line pace to today
  var pace = '';
  if (period === 'month' && range.start <= P.todayISO() && P.todayISO() <= range.end) {
    var totalBudget = Object.keys(state.budgets).reduce(function (s, k) { return s + (state.budgets[k] || 0); }, 0);
    if (totalBudget > 0) {
      var dayOfMonth = +P.todayISO().slice(8, 10);
      var expected = Math.round(totalBudget * dayOfMonth / range.days);
      pace = 'Budget pace: ' + fmt(t.spent) + ' spent of ' + fmt(totalBudget) + ' budgeted · straight-line pace for today is ' + fmt(expected) + (t.spent <= expected ? ' — you’re on pace ✅' : ' — ahead of pace ⚠️');
    }
  } else if (period === 'week') {
    pace = 'Transfers (Venmo, card payments) are listed but never counted as spending.';
  }
  $('paceLine').textContent = pace;
  // Daily bars
  var days = [], cur = new Date(range.start + 'T12:00:00');
  var end = new Date(range.end + 'T12:00:00'), max = 1;
  while (cur <= end) { var iso = P.todayISO(cur); var v = t.byDay[iso] || 0; if (v > max) max = v; days.push({ iso: iso, v: v, dow: cur.toLocaleDateString('en-US', { weekday: 'narrow' }), dom: cur.getDate() }); cur.setDate(cur.getDate() + 1); }
  $('dayBars').innerHTML = days.map(function (d) {
    return '<div class="barCol"><div class="bar" style="height:' + Math.max(2, Math.round(d.v / max * 64)) + 'px" title="' + d.iso + ' ' + fmt(d.v) + '"></div><span>' + (period === 'week' ? d.dow : d.dom) + '</span></div>';
  }).join('');
  var cats = Object.keys(t.byCat).sort(function (a, b) { return t.byCat[b] - t.byCat[a]; });
  $('catList').innerHTML = cats.length ? cats.map(function (c) {
    var pct = t.spent ? Math.round(t.byCat[c] / t.spent * 100) : 0;
    return '<div class="catRow"><span>' + esc(c) + '</span><div class="track"><div class="fill" style="width:' + pct + '%"></div></div><strong>' + fmt(t.byCat[c]) + '</strong></div>';
  }).join('') : '<p class="hint">Nothing spent in this period yet.</p>';
  var inRange = state.txns.filter(function (x) { return x.date >= range.start && x.date <= range.end; }).sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, 8);
  $('recentList').innerHTML = inRange.map(function (x) { return txnRow(x, true); }).join('');
  $('homeEmpty').classList.toggle('hidden', state.txns.length > 0);
}
function renderTxns() {
  var q = ($('searchBox').value || '').toLowerCase(), fs = $('filterSource').value, fc = $('filterCat').value;
  var list = state.txns.slice().sort(function (a, b) { return b.date.localeCompare(a.date) || b.cents - a.cents; }).filter(function (t) {
    return (!q || (t.merchant + ' ' + (t.note || '')).toLowerCase().indexOf(q) >= 0) && (!fs || t.source === fs) && (!fc || t.category === fc);
  });
  $('txnList').innerHTML = list.length ? list.map(function (t) { return txnRow(t, false); }).join('') : '<p class="hint">No transactions match.</p>';
  bindTxnControls($('txnList'));
}
function renderBudgets() {
  var range = P.periodRange('month', P.todayISO());
  var t = P.totals(state.txns, range);
  $('budgetList').innerHTML = P.CATEGORIES.filter(function (c) { return c !== 'Income' && c !== 'Transfer'; }).map(function (c) {
    var spent = t.byCat[c] || 0, limit = state.budgets[c] || 0;
    var pct = limit ? Math.min(100, Math.round(spent / limit * 100)) : 0;
    var over = limit && spent > limit;
    return '<div class="budgetRow"><div class="budgetHead"><strong>' + esc(c) + '</strong><span>' + fmt(spent) + (limit ? ' of ' + fmt(limit) : ' · no limit set') + (over ? ' · OVER ⚠️' : '') + '</span></div>' +
      (limit ? '<div class="track"><div class="fill' + (over ? ' over' : '') + '" style="width:' + pct + '%"></div></div>' : '') +
      '<div class="row gap"><input type="number" min="0" step="1" inputmode="decimal" placeholder="Monthly $" data-budget="' + esc(c) + '" value="' + (limit ? (limit / 100) : '') + '"><button class="ghost small" data-savebudget="' + esc(c) + '">Save</button></div></div>';
  }).join('');
  $('budgetList').querySelectorAll('[data-savebudget]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = $('budgetList').querySelector('[data-budget="' + btn.dataset.savebudget + '"]');
      var v = Math.round(parseFloat(input.value || '0') * 100);
      if (v > 0) state.budgets[btn.dataset.savebudget] = v; else delete state.budgets[btn.dataset.savebudget];
      save(); renderBudgets(); renderHome();
    });
  });
}
function renderAll() { if (!unlocked) return; renderHome(); renderTxns(); renderBudgets(); updatePinStatus(); $('removePinBtn').classList.toggle('hidden', !state.pin); }

/* ---------- Adding / importing (dedup + honest counts) ---------- */
function addTxns(drafts) {
  var withIds = drafts.map(function (d) { return Object.assign({ id: uid() }, d); });
  var res = P.dedup(state.txns, withIds);
  state.txns = state.txns.concat(res.added); save(); renderAll();
  return res;
}
$('pasteImportBtn').addEventListener('click', function () {
  var res = P.parseBulk($('pasteBox').value, P.todayISO());
  if (!res.txns.length) { $('importResult').textContent = 'Nothing I could read there — check the format, or add it by hand below.'; return; }
  var added = addTxns(res.txns);
  var msg = 'Imported ' + added.added.length + ' new transaction' + (added.added.length === 1 ? '' : 's') + '.';
  if (added.dupes) msg += ' Skipped ' + added.dupes + ' duplicate' + (added.dupes === 1 ? '' : 's') + ' already in the tracker.';
  if (res.skipped.length) msg += ' Couldn’t parse ' + res.skipped.length + ' of ' + res.totalLines + ' lines — those were NOT imported: “' + res.skipped[0].slice(0, 60) + '”' + (res.skipped.length > 1 ? '…' : '');
  $('importResult').textContent = msg;
  if (added.added.length) $('pasteBox').value = '';
});
$('csvFile').addEventListener('change', function () {
  var f = $('csvFile').files[0]; if (!f) return;
  var reader = new FileReader();
  reader.onload = function () {
    var res = P.parseCSV(String(reader.result || ''));
    if (!res.txns.length) { $('csvResult').textContent = 'No transactions read from that file (format: ' + res.format + '). If it’s a BofA, Capital One, or Venmo export, make sure it’s the CSV, not a PDF.'; return; }
    var added = addTxns(res.txns);
    var msg = 'Read a ' + res.format + ' file: imported ' + added.added.length + ' new, skipped ' + added.dupes + ' duplicates';
    if (res.skipped) msg += ', and ' + res.skipped + ' rows couldn’t be read and were NOT imported';
    $('csvResult').textContent = msg + '.';
    $('csvFile').value = '';
  };
  reader.readAsText(f);
});
$('manualForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var cents = Math.round(parseFloat($('mAmount').value) * 100);
  if (!cents || cents < 0) return;
  var dir = $('mDir').value, src = $('mSource').value, merchant = $('mMerchant').value.trim();
  var cat = $('mCat').value;
  state.txns.push({ id: uid(), date: $('mDate').value, cents: cents, direction: dir, merchant: merchant, source: src, category: cat, note: $('mNote').value.trim() });
  save(); renderAll();
  $('manualForm').reset(); $('mDate').value = P.todayISO();
  document.querySelector('[data-view="txns"]').click();
});
$('searchBox').addEventListener('input', renderTxns);
$('filterSource').addEventListener('change', renderTxns);
$('filterCat').addEventListener('change', renderTxns);

/* ---------- Backup / erase ---------- */
function download(name, text, type) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type })); a.download = name; a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
}
$('exportJsonBtn').addEventListener('click', function () { download('budget-backup.json', JSON.stringify(state, null, 2), 'application/json'); });
$('exportCsvBtn').addEventListener('click', function () {
  var rows = [['date', 'merchant', 'amount', 'direction', 'category', 'source', 'note']];
  state.txns.forEach(function (t) { rows.push([t.date, t.merchant, (t.cents / 100).toFixed(2), t.direction, t.category, t.source, t.note || '']); });
  download('budget-transactions.csv', rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n'), 'text/csv');
});
$('restoreFile').addEventListener('change', function () {
  var f = $('restoreFile').files[0]; if (!f) return;
  var reader = new FileReader();
  reader.onload = function () {
    try {
      var s = JSON.parse(String(reader.result || ''));
      if (!s || !Array.isArray(s.txns)) throw new Error('bad file');
      state = { txns: s.txns, budgets: s.budgets || {}, pin: state.pin }; save(); renderAll();
      $('settingsResult').textContent = 'Backup restored: ' + state.txns.length + ' transactions.';
    } catch (e) { $('settingsResult').textContent = 'That file isn’t a valid backup — nothing was changed.'; }
    $('restoreFile').value = '';
  };
  reader.readAsText(f);
});
$('clearBtn').addEventListener('click', function () {
  if (!confirm('Erase ALL budget data stored on this device? This cannot be undone.')) return;
  if (!confirm('Really erase everything? Export a backup first if you might want it back.')) return;
  state = blank(); save(); renderAll();
  $('settingsResult').textContent = 'All data erased from this device.';
});

/* ---------- Init ---------- */
P.CATEGORIES.forEach(function (c) {
  $('mCat').insertAdjacentHTML('beforeend', '<option>' + c + '</option>');
  $('filterCat').insertAdjacentHTML('beforeend', '<option>' + c + '</option>');
});
$('mDate').value = P.todayISO();
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(function () {}); }
if (state.pin) showLock(); else { unlocked = true; showApp(); }
})();
