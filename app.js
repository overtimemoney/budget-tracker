/* My Budget Tracker — local-only. No fetch/XHR/beacon anywhere in this file by design. */
(function () {
'use strict';
var P = window.PBT;
var KEY = 'pbt-v1';
var state = load();
var period = 'week';
var anchor = P.todayISO();
var unlocked = !state.pin;

function blank() { return { txns: [], budgets: {}, pin: null, recurring: [] }; }
function load() {
  try { var raw = localStorage.getItem(KEY); if (raw) { var s = JSON.parse(raw); if (s && Array.isArray(s.txns)) return s; } } catch (e) {}
  return blank();
}
if (!Array.isArray(state.recurring)) state.recurring = [];
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
  if (location.hash.indexOf('#import=') === 0 || location.hash.indexOf('#add=') === 0) handleHashImport();
  maybeAutoSyncGmail();
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
  return '<div class="txn ' + cls + '" data-tid="' + t.id + '">' +
    (compact ? '' : '<span class="selBox"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></span>') +
    '<div class="txnMain"><strong>' + esc(t.merchant) + '</strong>' +
    '<span class="meta">' + esc(t.date) + ' · ' + esc(t.source) + (t.note ? ' · ' + esc(t.note) : '') + '</span></div>' +
    '<div class="txnAmt">' + sign + fmt(t.cents) + '</div>' +
    (compact ? '' : '<select class="catSel" data-id="' + t.id + '">' + P.CATEGORIES.map(function (c) { return '<option' + (c === t.category ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select><button class="delBtn" data-id="' + t.id + '" aria-label="Delete"><svg width="14" height="14" xmlns="http://www.w3.org/2000/svg" class="ic delIc" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M18 6 6 18" /> <path d="m6 6 12 12" /> </svg></button>') +
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
      if (selMode) return;
      var t = state.txns.filter(function (x) { return x.id === btn.dataset.id; })[0];
      if (!t) return;
      openConfirm('Delete this item?', t.merchant + ' · ' + (t.direction === 'in' ? '+' : '−') + fmt(t.cents) + ' · ' + t.date, 'Delete', function () { deleteTxns([t.id]); });
    });
  });
  if (selMode && root.id === 'txnList') {
    root.querySelectorAll('.txn').forEach(function (row) {
      row.addEventListener('pointerdown', function (e) { startDragSelect(row, e); });
    });
  }
}

/* ---------- Undo toast: a delete is recoverable for 10 seconds ---------- */
var undoSlot = null, undoTimer = null;
function showUndoToast(removed) {
  undoSlot = { items: removed };
  $('toastMsg').textContent = removed.length === 1
    ? 'Deleted ' + removed[0].txn.merchant + ' ' + (removed[0].txn.direction === 'in' ? '+' : '−') + fmt(removed[0].txn.cents)
    : 'Deleted ' + removed.length + ' items';
  $('toastUndo').onclick = function () {
    if (undoSlot) {
      undoSlot.items.slice().sort(function (a, b) { return a.idx - b.idx; }).forEach(function (it) {
        state.txns.splice(Math.min(it.idx, state.txns.length), 0, it.txn);
      });
      save(); renderAll();
    }
    hideUndoToast();
  };
  $('toast').classList.remove('hidden');
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndoToast, 10000);
}
function hideUndoToast() {
  var t = $('toast'); if (t) t.classList.add('hidden');
  undoSlot = null;
  if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
}
function deleteTxns(ids) {
  var removed = [];
  state.txns = state.txns.filter(function (x, i) { if (ids.indexOf(x.id) >= 0) { removed.push({ txn: x, idx: i }); return false; } return true; });
  if (!removed.length) return;
  ids.forEach(function (id) { delete selIds[id]; });
  save(); renderAll();
  showUndoToast(removed);
}

/* ---------- Confirm sheet (asked before any delete) ---------- */
var confirmCb = null;
function openConfirm(title, detail, okLabel, cb) {
  $('confirmTitle').textContent = title;
  $('confirmDetail').textContent = detail || '';
  $('confirmOk').textContent = okLabel || 'Delete';
  confirmCb = cb;
  $('confirmSheet').classList.remove('hidden');
}
function closeConfirm() { $('confirmSheet').classList.add('hidden'); confirmCb = null; }

/* ---------- Select mode: tap rows or drag across them, delete together ---------- */
var selMode = false, selIds = {}, dragSel = null, lastFilteredIds = [];
function setSelMode(on) {
  selMode = on;
  if (!on) { selIds = {}; dragSel = null; }
  $('selBar').classList.toggle('hidden', !on);
  $('selectModeBtn').classList.toggle('hidden', on);
  renderTxns();
}
function updateSelBar() {
  var n = Object.keys(selIds).length;
  $('selCount').textContent = n + ' selected';
  $('selDeleteBtn').textContent = n ? 'Delete (' + n + ')' : 'Delete';
}
function applySel(row, on) {
  var id = row.dataset.tid;
  if (!id) return;
  if (on) selIds[id] = 1; else delete selIds[id];
  row.classList.toggle('selected', !!on);
  updateSelBar();
}
function startDragSelect(row, e) {
  if (!selMode || !row.dataset.tid) return;
  e.preventDefault();
  dragSel = { mode: !selIds[row.dataset.tid] };
  applySel(row, dragSel.mode);
}
document.addEventListener('pointermove', function (e) {
  if (!dragSel) return;
  var el = document.elementFromPoint(e.clientX, e.clientY);
  var row = el && el.closest ? el.closest('.txn') : null;
  if (row && row.closest && row.closest('#txnList')) applySel(row, dragSel.mode);
});
document.addEventListener('pointerup', function () { dragSel = null; });
document.addEventListener('pointercancel', function () { dragSel = null; });
function weekLabel(startISO, endISO) {
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var s = new Date(startISO + 'T12:00:00'), e = new Date(endISO + 'T12:00:00');
  var lbl = MON[s.getMonth()] + ' ' + s.getDate();
  if (s.getFullYear() !== e.getFullYear()) lbl += ', ' + s.getFullYear();
  lbl += ' – ' + (e.getMonth() !== s.getMonth() ? MON[e.getMonth()] + ' ' : '') + e.getDate() + ', ' + e.getFullYear();
  return lbl;
}
function renderHome() {
  var range = P.periodRange(period, anchor);
  var t = P.totals(state.txns, range);
  var label = period === 'week' ? weekLabel(range.start, range.end) : new Date(anchor + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
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
      pace = 'Budget pace: ' + fmt(t.spent) + ' spent of ' + fmt(totalBudget) + ' budgeted · straight-line pace for today is ' + fmt(expected) + (t.spent <= expected ? ' — you’re on pace' : ' — ahead of pace');
    }
  } else if (period === 'week') {
    pace = 'Transfers (card payments, Venmo-to-bank) are listed but never counted as spending.';
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
  lastFilteredIds = list.map(function (t) { return t.id; });
  var existing = {}; state.txns.forEach(function (t) { existing[t.id] = 1; });
  Object.keys(selIds).forEach(function (id) { if (!existing[id]) delete selIds[id]; });
  $('txnList').innerHTML = list.length ? list.map(function (t) { return txnRow(t, false); }).join('') : '<p class="hint">No transactions match.</p>';
  $('txnList').classList.toggle('selecting', selMode);
  if (selMode) $('txnList').querySelectorAll('.txn').forEach(function (row) { if (selIds[row.dataset.tid]) row.classList.add('selected'); });
  bindTxnControls($('txnList'));
  updateSelBar();
}

/* ---------- Recurring expenses: file themselves on their due date ---------- */
var FREQ_LABEL = { monthly: 'Monthly', weekly: 'Weekly', biweekly: 'Every 2 weeks', yearly: 'Yearly' };
function recAdvance(iso, freq) {
  var d = new Date(iso + 'T12:00:00');
  if (freq === 'weekly') d.setDate(d.getDate() + 7);
  else if (freq === 'biweekly') d.setDate(d.getDate() + 14);
  else if (freq === 'yearly') { var yd = d.getDate(); d.setFullYear(d.getFullYear() + 1); if (d.getDate() < yd) d.setDate(0); }
  else { var day = d.getDate(); d.setMonth(d.getMonth() + 1); if (d.getDate() < day) d.setDate(0); }
  return P.todayISO(d);
}
function recNext(r) { return r.lastFiled ? recAdvance(r.lastFiled, r.freq) : r.start; }
function fileDueRecurring() {
  var today = P.todayISO(), drafts = [], changed = false;
  state.recurring.forEach(function (r) {
    if (!r.active) return;
    var due = recNext(r), guard = 0;
    while (due <= today && guard < 120) {
      drafts.push({ date: due, cents: r.cents, direction: 'out', merchant: r.name, source: 'Recurring', category: r.category, note: FREQ_LABEL[r.freq] || r.freq });
      r.lastFiled = due; due = recAdvance(due, r.freq); changed = true; guard++;
    }
  });
  if (drafts.length) {
    var res = P.dedup(state.txns, drafts.map(function (d) { return Object.assign({ id: uid() }, d); }));
    state.txns = state.txns.concat(res.added);
  }
  if (changed) save();
  return drafts.length;
}
function recMonthlyCents(r) {
  if (r.freq === 'weekly') return Math.round(r.cents * 52 / 12);
  if (r.freq === 'biweekly') return Math.round(r.cents * 26 / 12);
  if (r.freq === 'yearly') return Math.round(r.cents / 12);
  return r.cents;
}
function prettyDate(iso) { return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function renderRecurring() {
  var today = P.todayISO();
  var active = state.recurring.filter(function (r) { return r.active; });
  var monthly = active.reduce(function (s, r) { return s + recMonthlyCents(r); }, 0);
  $('recSummary').innerHTML = state.recurring.length ?
    '<p class="pace">' + active.length + ' active · about <strong>' + fmt(monthly) + '/mo</strong> in recurring expenses</p>' : '';
  $('recList').innerHTML = state.recurring.map(function (r) {
    var next = recNext(r);
    var when = !r.active ? 'Paused' : (next <= today ? 'Due now · files on open' : 'Next · ' + prettyDate(next));
    return '<div class="recRow' + (r.active ? '' : ' paused') + '"><div class="recMain"><strong>' + esc(r.name) + '</strong>' +
      '<span class="meta">' + esc(r.category) + ' · ' + (FREQ_LABEL[r.freq] || r.freq) + ' · ' + when + '</span></div>' +
      '<div class="recAmt">' + fmt(r.cents) + '</div>' +
      '<button class="ghost small" data-rec-toggle="' + r.id + '">' + (r.active ? 'Pause' : 'Resume') + '</button>' +
      '<button class="delBtn" data-rec-del="' + r.id + '" aria-label="Delete ' + esc(r.name) + '"><svg xmlns="http://www.w3.org/2000/svg" class="ic delIc" width="14" height="14" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M18 6 6 18" /> <path d="m6 6 12 12" /> </svg></button></div>';
  }).join('');
  $('recList').querySelectorAll('[data-rec-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      var r = state.recurring.filter(function (x) { return x.id === b.dataset.recToggle; })[0];
      if (r) { r.active = !r.active; save(); renderAll(); }
    });
  });
  $('recList').querySelectorAll('[data-rec-del]').forEach(function (b) {
    b.addEventListener('click', function () {
      var r = state.recurring.filter(function (x) { return x.id === b.dataset.recDel; })[0];
      if (!r) return;
      openConfirm('Delete this recurring expense?', r.name + ' · ' + fmt(r.cents) + ' · ' + (FREQ_LABEL[r.freq] || r.freq), 'Delete', function () {
        state.recurring = state.recurring.filter(function (x) { return x.id !== b.dataset.recDel; });
        save(); renderAll();
      });
    });
  });
}
$('recAdd').addEventListener('click', function () {
  var name = $('recName').value.trim();
  var cents = Math.round(parseFloat($('recAmount').value || '0') * 100);
  var date = $('recDate').value;
  if (!name) { $('recResult').textContent = 'Give the expense a name first.'; return; }
  if (!(cents > 0)) { $('recResult').textContent = 'Enter an amount above $0.'; return; }
  if (!date) { $('recResult').textContent = 'Pick the next due date.'; return; }
  state.recurring.push({ id: uid(), name: name, cents: cents, category: $('recCat').value, freq: $('recFreq').value, start: date, lastFiled: null, active: true });
  save();
  $('recName').value = ''; $('recAmount').value = ''; $('recDate').value = P.todayISO();
  $('recResult').textContent = 'Added — ' + name + ' will file itself on ' + prettyDate(date) + '.';
  renderAll();
});

function renderBudgets() {
  var range = P.periodRange('month', P.todayISO());
  var t = P.totals(state.txns, range);
  $('budgetList').innerHTML = P.CATEGORIES.filter(function (c) { return c !== 'Income' && c !== 'Transfer'; }).map(function (c) {
    var spent = t.byCat[c] || 0, limit = state.budgets[c] || 0;
    var pct = limit ? Math.min(100, Math.round(spent / limit * 100)) : 0;
    var over = limit && spent > limit;
    return '<div class="budgetRow"><div class="budgetHead"><strong>' + esc(c) + '</strong><span>' + fmt(spent) + (limit ? ' of ' + fmt(limit) : ' · no limit set') + (over ? ' · OVER' : '') + '</span></div>' +
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
/* One-time recount (Nov 2026): Venmo payments to/from people are real money
   and count; only Venmo→bank cash-outs and card-bill payments never count. */
function migrateCountFix() {
  if (state.countFixV17) return;
  state.countFixV17 = true;
  var changed = false;
  state.txns.forEach(function (t) {
    if (t.source === 'Venmo' && t.category === 'Transfer' && !/bank/i.test(t.merchant)) {
      t.category = t.direction === 'in' ? 'Income' : P.categorize(t.merchant + ' ' + (t.note || ''), t.source, t.direction);
      changed = true;
    } else if ((t.source === 'Capital One' || t.source === 'BofA') && /payment/i.test(t.merchant) && t.category !== 'Transfer') {
      t.category = 'Transfer'; changed = true;
    }
  });
  if (changed) save();
}
function renderAll() { if (!unlocked) return; migrateCountFix(); fileDueRecurring(); renderRecurring(); renderHome(); renderTxns(); renderBudgets(); updatePinStatus(); $('removePinBtn').classList.toggle('hidden', !state.pin); }

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
$('selectModeBtn').addEventListener('click', function () { setSelMode(true); });
$('selCancelBtn').addEventListener('click', function () { setSelMode(false); });
$('selAllBtn').addEventListener('click', function () { lastFilteredIds.forEach(function (id) { selIds[id] = 1; }); renderTxns(); });
$('selDeleteBtn').addEventListener('click', function () {
  var ids = Object.keys(selIds);
  if (!ids.length) return;
  openConfirm('Delete ' + ids.length + ' item' + (ids.length === 1 ? '' : 's') + '?', 'They will be removed from your list and your totals.', 'Delete', function () { deleteTxns(ids); setSelMode(false); });
});
$('confirmCancel').addEventListener('click', closeConfirm);
$('confirmOk').addEventListener('click', function () { var cb = confirmCb; closeConfirm(); if (cb) cb(); });
$('confirmSheet').addEventListener('click', function (e) { if (e.target === $('confirmSheet')) closeConfirm(); });

/* ---------- Direct Gmail sync ----------
   The app talks to Google directly from this phone: Google Identity Services
   issues a short-lived, read-only access token (kept in memory only, never
   stored), the app lists alert emails from the three senders, parses them
   on-device, and files them locally. No server, no relay, no Luna. */
var GMAIL_LS = { client: 'pbt_gmail_client_id', connected: 'pbt_gmail_connected', seen: 'pbt_gmail_seen', last: 'pbt_gmail_last_sync', lookback: 'pbt_gmail_lookback' };
var gmailToken = null, gmailTokenExp = 0, gmailSyncing = false, gmailAutoTried = false;
function gmailGet(key, fallback) { try { var v = localStorage.getItem(key); return v == null ? fallback : v; } catch (e) { return fallback; } }
function gmailSet(key, val) { try { if (val == null) localStorage.removeItem(key); else localStorage.setItem(key, val); } catch (e) {} }
function gmailSeen() { try { return JSON.parse(gmailGet(GMAIL_LS.seen, '[]')) || []; } catch (e) { return []; } }
function gmailClientId() { return String(($('gmailClientId').value || gmailGet(GMAIL_LS.client, '')).trim()); }
function renderGmailStatus() {
  var cid = gmailGet(GMAIL_LS.client, '');
  var connected = gmailGet(GMAIL_LS.connected, '') === '1';
  var last = gmailGet(GMAIL_LS.last, '');
  if (cid && !$('gmailClientId').value) $('gmailClientId').value = cid;
  var lb = gmailGet(GMAIL_LS.lookback, '');
  if (lb) $('gmailLookback').value = lb;
  $('gmailStatus').innerHTML = !cid ? '<strong>Not set up yet</strong> — paste your Google Client ID below.'
    : connected ? '<strong>Connected.</strong>' + (last ? ' Last synced ' + new Date(last).toLocaleString() + '.' : ' Not synced yet — tap Sync now.')
    : '<strong>Client ID saved.</strong> Tap Connect Gmail to link your account.';
  $('gmailDisconnectBtn').classList.toggle('hidden', !connected);
  $('gmailConnectBtn').textContent = connected ? 'Reconnect Gmail' : 'Connect Gmail';
}
function loadGis() {
  return new Promise(function (resolve, reject) {
    if (window.google && google.accounts && google.accounts.oauth2) return resolve();
    var done = false;
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = function () { if (!done) { done = true; resolve(); } };
    s.onerror = function () { if (!done) { done = true; reject(new Error('Could not load Google sign-in — check your connection and try again.')); } };
    document.head.appendChild(s);
    setTimeout(function () { if (!done) { done = true; reject(new Error('Google sign-in took too long to load — try again.')); } }, 20000);
  });
}
function gmailRequestToken(interactive) {
  return loadGis().then(function () {
    return new Promise(function (resolve, reject) {
      var cid = gmailClientId();
      if (!cid) return reject(new Error('Paste your Google Client ID first — the one-time setup steps are in this section.'));
      if (!/\.apps\.googleusercontent\.com$/.test(cid)) return reject(new Error('That Client ID doesn’t look right — it should end in .apps.googleusercontent.com'));
      var settled = false;
      var timer = setTimeout(function () { if (!settled) { settled = true; reject(new Error('Google sign-in timed out — tap Sync now to try again.')); } }, 90000);
      var client = google.accounts.oauth2.initTokenClient({
        client_id: cid,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        callback: function (resp) {
          if (settled) return; settled = true; clearTimeout(timer);
          if (resp && resp.access_token) { gmailToken = resp.access_token; gmailTokenExp = Date.now() + (resp.expires_in ? resp.expires_in * 1000 : 3600000); gmailSet(GMAIL_LS.connected, '1'); resolve(gmailToken); }
          else reject(new Error('Google did not grant access.'));
        },
        error_callback: function () { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Google sign-in was closed or blocked — tap Sync now and finish the Google prompt.')); } }
      });
      try { client.requestAccessToken({ prompt: interactive ? '' : 'none' }); }
      catch (e) { if (!settled) { settled = true; clearTimeout(timer); reject(e); } }
    });
  });
}
function gmailEnsureToken(interactive) {
  if (gmailToken && Date.now() < gmailTokenExp - 60000) return Promise.resolve(gmailToken);
  return gmailRequestToken(interactive);
}
function gmailApi(path, token) {
  return fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { 'Authorization': 'Bearer ' + token } }).then(function (r) {
    if (r.status === 401) { gmailToken = null; var e = new Error('Google session expired — tap Sync now to reconnect.'); e.code = 401; throw e; }
    if (!r.ok) throw new Error('Gmail request failed (' + r.status + ').');
    return r.json();
  });
}
function gmailHeader(msg, name) {
  var hs = (msg.payload && msg.payload.headers) || [];
  for (var i = 0; i < hs.length; i++) if (String(hs[i].name).toLowerCase() === name) return hs[i].value || '';
  return '';
}
function gmailBodyText(part) {
  if (!part) return '';
  var out = '';
  if (part.body && part.body.data) {
    var text = P.decodeBase64Url(part.body.data);
    if (part.mimeType === 'text/plain') out += text + '\n';
    else if (part.mimeType === 'text/html') out += text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ') + '\n';
  }
  (part.parts || []).forEach(function (p) { out += gmailBodyText(p); });
  return out;
}
function syncGmail(interactive) {
  if (gmailSyncing) return Promise.resolve();
  if (!gmailClientId()) { renderGmailStatus(); $('gmailResult').textContent = 'Paste your Google Client ID first — the one-time setup steps are right above it.'; return Promise.resolve(); }
  gmailSyncing = true; $('gmailResult').textContent = 'Syncing with Gmail…';
  return gmailEnsureToken(interactive).then(function (token) {
    var last = gmailGet(GMAIL_LS.last, ''), since, d;
    if (last) { d = new Date(last); d.setDate(d.getDate() - 3); since = P.todayISO(d); }
    else { d = new Date(); d.setDate(d.getDate() - parseInt($('gmailLookback').value || '90', 10)); since = P.todayISO(d); }
    var q = P.gmailSearchQuery(since), ids = [];
    function page(pageToken) {
      return gmailApi('messages?maxResults=100&q=' + encodeURIComponent(q) + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), token).then(function (res) {
        (res.messages || []).forEach(function (mm) { ids.push(mm.id); });
        if (res.nextPageToken && ids.length < 500) return page(res.nextPageToken);
      });
    }
    return page(null).then(function () {
      var seen = {}; gmailSeen().forEach(function (id) { seen[id] = 1; });
      var fresh = ids.filter(function (id) { return !seen[id]; });
      var drafts = [], ignored = 0, fatal = null;
      var chain = Promise.resolve();
      fresh.forEach(function (id) {
        chain = chain.then(function () {
          if (fatal) return;
          return gmailApi('messages/' + encodeURIComponent(id) + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date', token).then(function (msg) {
            var dateISO = msg.internalDate ? P.todayISO(new Date(Number(msg.internalDate))) : P.todayISO();
            var draft = P.parseGmailAlert(gmailHeader(msg, 'from'), gmailHeader(msg, 'subject'), dateISO);
            if (draft) { drafts.push(draft); seen[id] = 1; return; }
            return gmailApi('messages/' + encodeURIComponent(id) + '?format=full', token).then(function (full) {
              var text = gmailHeader(full, 'subject') + '\n' + (full.snippet || '') + '\n' + gmailBodyText(full.payload || {});
              var g = P.parseNotification(text, dateISO);
              if (g) {
                var from = gmailHeader(full, 'from').toLowerCase();
                g.source = from.indexOf('venmo') >= 0 ? 'Venmo' : (from.indexOf('capitalone') >= 0 ? 'Capital One' : (from.indexOf('bankofamerica') >= 0 ? 'BofA' : (from.indexOf('gusto') >= 0 ? 'Gusto' : g.source)));
                if (g.source === 'Venmo' && /bank transfer/i.test(g.merchant)) g.category = 'Transfer';
                drafts.push(g);
              } else ignored++;
              seen[id] = 1;
            }).catch(function (e) { if (e && e.code === 401) fatal = e; else { ignored++; seen[id] = 1; } });
          }).catch(function (e) { if (e && e.code === 401) fatal = e; });
        });
      });
      return chain.then(function () {
        if (fatal) throw fatal;
        var res = addTxns(drafts);
        gmailSet(GMAIL_LS.seen, JSON.stringify(Object.keys(seen).slice(-2000)));
        gmailSet(GMAIL_LS.last, new Date().toISOString());
        gmailSyncing = false;
        renderGmailStatus();
        $('gmailResult').textContent = 'Gmail sync done: added ' + res.added + ' new transaction' + (res.added === 1 ? '' : 's') + (res.dupes ? ', ' + res.dupes + ' already in the app' : '') + ', ignored ' + ignored + ' alert email' + (ignored === 1 ? '' : 's') + ' that weren’t completed payments.';
      });
    });
  }).catch(function (e) {
    gmailSyncing = false;
    renderGmailStatus();
    $('gmailResult').textContent = interactive ? (e.message || 'Gmail sync failed.') : 'Gmail is connected, but Google needs a tap this time — open Settings → Gmail sync → Sync now.';
  });
}
function maybeAutoSyncGmail() {
  if (gmailAutoTried) return; gmailAutoTried = true;
  if (gmailGet(GMAIL_LS.connected, '') !== '1' || !gmailGet(GMAIL_LS.client, '')) return;
  syncGmail(false);
}
$('gmailSaveClientBtn').addEventListener('click', function () {
  var cid = gmailClientId();
  if (!/\.apps\.googleusercontent\.com$/.test(cid)) { $('gmailResult').textContent = 'That Client ID doesn’t look right — it should end in .apps.googleusercontent.com'; return; }
  gmailSet(GMAIL_LS.client, cid);
  renderGmailStatus();
  $('gmailResult').textContent = 'Client ID saved on this phone. Now tap Connect Gmail.';
});
$('gmailConnectBtn').addEventListener('click', function () { syncGmail(true); });
$('gmailSyncBtn').addEventListener('click', function () { syncGmail(true); });
$('gmailDisconnectBtn').addEventListener('click', function () {
  if (gmailToken && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(gmailToken, function () {});
  gmailToken = null; gmailTokenExp = 0;
  gmailSet(GMAIL_LS.connected, null);
  renderGmailStatus();
  $('gmailResult').textContent = 'Disconnected. Imported transactions stay in the app. You can also remove this app’s access anytime in your Google Account → Security → Third-party access.';
});
$('gmailLookback').addEventListener('change', function () { gmailSet(GMAIL_LS.lookback, $('gmailLookback').value); });
renderGmailStatus();

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
      state = { txns: s.txns, budgets: s.budgets || {}, pin: state.pin, recurring: s.recurring || [] }; save(); renderAll();
      $('settingsResult').textContent = 'Backup restored: ' + state.txns.length + ' transactions.';
    } catch (e) { $('settingsResult').textContent = 'That file isn’t a valid backup — nothing was changed.'; }
    $('restoreFile').value = '';
  };
  reader.readAsText(f);
});
$('clearBtn').addEventListener('click', function () {
  if (!confirm('Erase ALL budget data stored on this device? This cannot be undone.')) return;
  if (!confirm('Really erase everything? Export a backup first if you might want it back.')) return;
  state = blank(); save();
  Object.keys(GMAIL_LS).forEach(function (k) { gmailSet(GMAIL_LS[k], null); });
  gmailToken = null; gmailTokenExp = 0;
  if ($('gmailClientId')) $('gmailClientId').value = '';
  renderGmailStatus(); renderAll();
  $('settingsResult').textContent = 'All data erased from this device.';
});

/* ---------- Auto-import from link (#import=<url-encoded notification text>) ----------
   Used by the iOS Shortcuts automation: a bank text opens the tracker with the
   alert text in the hash, the tracker files it, then wipes the hash so the
   amount/merchant never lingers in the address bar or history. */
function handleHashImport() {
  var m = (location.hash || '').match(/^#(?:import|add)=(.+)$/);
  if (!m) return;
  var text = '';
  try { text = decodeURIComponent(m[1].replace(/\+/g, '%20')); } catch (e) { text = ''; }
  history.replaceState(null, '', location.pathname + location.search);
  if (!text) return;
  var res = P.parseBulk(text, P.todayISO());
  var banner = $('autoImportBanner');
  document.querySelector('[data-view="add"]').click();
  banner.classList.remove('hidden');
  if (!res.txns.length) {
    banner.textContent = 'An automation sent a message I couldn’t read as a transaction: “' + text.slice(0, 90) + '” — nothing was added. You can fix it up by hand below.';
    return;
  }
  var added = addTxns(res.txns);
  banner.textContent = 'Auto-import: filed ' + added.added.length + ' new transaction' + (added.added.length === 1 ? '' : 's') +
    (added.dupes ? ', skipped ' + added.dupes + ' duplicate' + (added.dupes === 1 ? '' : 's') : '') +
    (res.skipped.length ? ', couldn’t parse ' + res.skipped.length + ' line' + (res.skipped.length === 1 ? '' : 's') : '') + '.';
}

/* ---------- Theme: light/dark, saved on-device, defaults to the phone's setting ---------- */
var THEME_KEY = 'mb_theme';
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'dark' ? '#000000' : '#ffffff');
}
function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'light'; }
(function initTheme() {
  var saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  if (saved !== 'dark' && saved !== 'light') {
    saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  applyTheme(saved);
})();
$('themeBtn').addEventListener('click', function () {
  var next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
});

/* ---------- Force reload: drop cached app files + service worker, keep localStorage data ---------- */
function reloadApp(btn) {
  var old = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Reloading…'; btn.disabled = true; }
  var jobs = [];
  if ('serviceWorker' in navigator) {
    jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
      return Promise.all(regs.map(function (r) { return r.unregister(); }));
    }).catch(function () {}));
  }
  if (window.caches && caches.keys) {
    jobs.push(caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) { return caches.delete(k); }));
    }).catch(function () {}));
  }
  Promise.all(jobs).then(function () {
    var url = location.pathname + '?v=' + Date.now() + location.hash;
    location.replace(url);
  });
  setTimeout(function () { if (btn) { btn.textContent = old; btn.disabled = false; } }, 4000);
}
$('reloadBtn').addEventListener('click', function () { reloadApp($('reloadBtn')); });
$('reloadBtn2').addEventListener('click', function () { reloadApp($('reloadBtn2')); });

/* ---------- Init ---------- */
P.CATEGORIES.forEach(function (c) {
  $('mCat').insertAdjacentHTML('beforeend', '<option>' + c + '</option>');
  $('filterCat').insertAdjacentHTML('beforeend', '<option>' + c + '</option>');
  if (c !== 'Income' && c !== 'Transfer') $('recCat').insertAdjacentHTML('beforeend', '<option>' + c + '</option>');
});
if ($('recCat').querySelector('option[value="Housing"]') || [].some.call($('recCat').options, function (o) { return o.text === 'Housing'; })) $('recCat').value = 'Housing';
$('mDate').value = P.todayISO();
$('recDate').value = P.todayISO();
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(function () {}); }
if (state.pin) showLock(); else { unlocked = true; showApp(); }
if (unlocked) handleHashImport();
window.addEventListener('hashchange', function () { if (unlocked) handleHashImport(); });
})();
