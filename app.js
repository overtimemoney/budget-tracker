/* My Budget Tracker — local-only. No fetch/XHR/beacon anywhere in this file by design. */
(function () {
'use strict';
var P = window.PBT;
var KEY = 'pbt-v1';
var state = load();
if (!Array.isArray(state.rules)) state.rules = []; // states saved before rules existed
var period = 'week';
var barSel = null; // ISO date of the tapped daily bar, if any
var anchor = P.todayISO();
var unlocked = !state.pin;

function blank() { return { txns: [], budgets: {}, pin: null, recurring: [], rules: [] }; }
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
function showLock() { $('bootSkel').classList.add('hidden'); $('lockScreen').classList.remove('hidden'); $('app').classList.add('hidden'); $('tabBar').classList.add('hidden'); }
function showApp() {
  $('bootSkel').classList.add('hidden'); $('lockScreen').classList.add('hidden'); $('app').classList.remove('hidden'); $('tabBar').classList.remove('hidden');
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
    else {
      $('pinError').textContent = 'Wrong PIN — try again.';
      var lc = document.querySelector('.lockCard');
      if (lc) { lc.classList.remove('shake'); void lc.offsetWidth; lc.classList.add('shake'); }
    }
  });
}
$('lockBtn').addEventListener('click', function () { unlocked = false; $('pinInput').value = ''; showLock(); });
document.addEventListener('visibilitychange', function () {
  if (document.hidden && state.pin && unlocked) { unlocked = false; showLock(); }
  if (!document.hidden && typeof autoSyncGmail === 'function') autoSyncGmail();
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
$('dayBars').addEventListener('click', function (e) {
  var col = e.target.closest('.barCol');
  if (!col) return;
  barSel = barSel === col.dataset.iso ? null : col.dataset.iso; // tap again to clear
  renderHome();
});
$('nextPeriod').addEventListener('click', function () { shiftAnchor(1); });

/* ---------- Rendering (all totals recomputed fresh from state.txns on every render) ---------- */
function showNote(t) {
  // Justin's option (2026-11-21): Venmo descriptions can be omitted as a
  // whole — one Settings switch hides every Venmo note in the lists. The
  // notes stay stored; flipping the switch back restores them.
  return !!(t.note && !(state.hideVenmoNotes && t.source === 'Venmo'));
}
function txnRow(t, compact, dim) {
  var sign = t.direction === 'in' ? '+' : '−';
  var cls = t.category === 'Transfer' ? 'transfer' : (t.direction === 'in' ? 'in' : 'out');
  return '<div class="txn ' + cls + (dim ? ' dim' : '') + '" data-tid="' + t.id + '">' +
    '<div class="txnMain"><strong>' + esc(t.merchant) + '</strong>' +
    '<span class="meta">' + esc(t.date) + ' · ' + esc(t.source) + (showNote(t) ? ' · ' + esc(t.note) : '') + '</span></div>' +
    '<div class="txnAmt">' + sign + fmt(t.cents) + '</div>' +
    '</div>';
}
/* ---------- Transaction card: tap any row to act on it ---------- */
var tsId = null;
function findTxn(id) { return state.txns.filter(function (x) { return x.id === id; })[0] || null; }
function openTxnSheet(id) {
  var t = findTxn(id);
  if (!t) return;
  tsId = id;
  $('tsMerchant').textContent = t.merchant;
  $('tsDetail').textContent = (t.direction === 'in' ? '+' : '−') + fmt(t.cents) + ' · ' + t.date + ' · ' + t.source + (showNote(t) ? ' · ' + t.note : '');
  $('tsCat').innerHTML = P.CATEGORIES.map(function (c) { return '<option' + (c === t.category ? ' selected' : '') + '>' + c + '</option>'; }).join('');
  var ob = $('tsOffsetBtn');
  ob.classList.toggle('hidden', t.direction !== 'in');
  ob.textContent = t.offset ? 'Stop offsetting spending' : 'Offset spending…';
  $('txnSheet').classList.remove('hidden');
}
function closeTxnSheet() { $('txnSheet').classList.add('hidden'); tsId = null; }
function onRowTap(e) {
  var row = e.target.closest ? e.target.closest('.txn') : null;
  if (row && row.dataset.tid) openTxnSheet(row.dataset.tid);
}

/* ---------- Undo toast: a delete is recoverable for 10 seconds ---------- */
var undoSlot = null, undoTimer = null, msgToastTimer = null;
function showUndoToast(removed) {
  if (msgToastTimer) { clearTimeout(msgToastTimer); msgToastTimer = null; }
  $('toastUndo').classList.remove('hidden');
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
/* Plain message toast (no Undo button) — used for sync feedback. */
function showMsgToast(msg, ms) {
  if (undoSlot) return; // never clobber a delete-undo toast
  $('toastMsg').textContent = msg;
  $('toastUndo').classList.add('hidden');
  $('toast').classList.remove('hidden');
  if (msgToastTimer) clearTimeout(msgToastTimer);
  msgToastTimer = setTimeout(function () {
    msgToastTimer = null;
    if (!undoSlot) { $('toast').classList.add('hidden'); $('toastUndo').classList.remove('hidden'); }
  }, ms || 3500);
}
function deleteTxns(ids) {
  var removed = [];
  state.txns = state.txns.filter(function (x, i) { if (ids.indexOf(x.id) >= 0) { removed.push({ txn: x, idx: i }); return false; } return true; });
  if (!removed.length) return;
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

/* ---------- Scroll lock: while any sheet is open, the page behind it stays put ---------- */
var lockY = 0, scrollLocked = false;
function syncScrollLock() {
  var anyOpen = ['confirmSheet', 'omitSheet', 'txnSheet', 'offsetSheet', 'ruleSheet'].some(function (id) { var el = $(id); return el && !el.classList.contains('hidden'); });
  if (anyOpen && !scrollLocked) {
    lockY = window.scrollY || 0;
    document.body.style.top = (-lockY) + 'px';
    document.body.classList.add('locked');
    scrollLocked = true;
  } else if (!anyOpen && scrollLocked) {
    document.body.classList.remove('locked');
    document.body.style.top = '';
    scrollLocked = false;
    window.scrollTo(0, lockY);
  }
}
(function () {
  var mo = new MutationObserver(syncScrollLock);
  ['confirmSheet', 'omitSheet', 'txnSheet', 'offsetSheet', 'ruleSheet'].forEach(function (id) { var el = $(id); if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] }); });
  syncScrollLock();
})();

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
  }
  $('paceLine').textContent = pace;
  // Daily bars
  var days = [], cur = new Date(range.start + 'T12:00:00');
  var end = new Date(range.end + 'T12:00:00'), max = 1;
  while (cur <= end) { var iso = P.todayISO(cur); var v = t.byDay[iso] || 0; if (v > max) max = v; days.push({ iso: iso, v: v, dow: cur.toLocaleDateString('en-US', { weekday: 'narrow' }), dom: cur.getDate() }); cur.setDate(cur.getDate() + 1); }
  $('dayBars').innerHTML = days.map(function (d, i) {
    // Month view: 30 day-numbers can't each fit a ~12px-wide column — the
    // digits collide. Label only the 1st, every 5th day, and the last day;
    // unlabeled days keep an nbsp span so all bars share one baseline. Every
    // bar stays tappable and the readout names the exact day tapped.
    var lab;
    if (period === 'week') lab = d.dow;
    else lab = (d.dom === 1 || d.dom % 5 === 0 || i === days.length - 1) ? d.dom : '&nbsp;';
    return '<div class="barCol' + (d.iso === barSel ? ' sel' : '') + '" data-iso="' + d.iso + '"><div class="bar" style="height:' + Math.max(2, Math.round(d.v / max * 64)) + 'px" title="' + d.iso + ' ' + fmt(d.v) + '"></div><span>' + lab + '</span></div>';
  }).join('');
  var ro = $('barReadout'), selDay = null;
  days.forEach(function (d) { if (d.iso === barSel) selDay = d; });
  if (selDay) {
    ro.textContent = new Date(selDay.iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + fmt(selDay.v) + (selDay.v > 0 ? ' spent' : ' — no spending');
    ro.classList.add('on');
  } else {
    ro.textContent = 'Tap a bar to see that day’s total';
    ro.classList.remove('on');
  }
  var cats = Object.keys(t.byCat).sort(function (a, b) { return t.byCat[b] - t.byCat[a]; });
  $('catList').innerHTML = cats.length ? cats.map(function (c) {
    var pct = t.spent ? Math.round(t.byCat[c] / t.spent * 100) : 0;
    return '<div class="catRow"><span>' + esc(c) + '</span><div class="track"><div class="fill" style="width:' + pct + '%"></div></div><strong>' + fmt(t.byCat[c]) + '</strong></div>';
  }).join('') : '<p class="hint">Nothing spent in this period yet.</p>';
  var inRange = state.txns.filter(function (x) { return !x.omitted && x.date >= range.start && x.date <= range.end; }).sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, 8);
  // With a day tapped in the chart, Recent greys out everything that isn't
  // that day — the tapped day's rows stay full-strength so they pop.
  $('recentList').innerHTML = inRange.map(function (x) { return txnRow(x, true, !!(selDay && x.date !== barSel)); }).join('');
  $('homeEmpty').classList.toggle('hidden', state.txns.length > 0);
}
var txnShown = 120, txnSig = '';
function renderTxns() {
  var q = ($('searchBox').value || '').toLowerCase(), fs = $('filterSource').value, fc = $('filterCat').value;
  // Cap the rendered rows (a "Show more" button pages further) so a list of
  // thousands stays smooth on a slow phone. The cap resets only when the
  // search/filters actually change, not on every re-render.
  var sig = q + '|' + fs + '|' + fc;
  if (sig !== txnSig) { txnSig = sig; txnShown = 120; }
  var list = state.txns.slice().sort(function (a, b) { return b.date.localeCompare(a.date) || b.cents - a.cents; }).filter(function (t) {
    return !t.omitted && (!q || (t.merchant + ' ' + (t.note || '')).toLowerCase().indexOf(q) >= 0) && (!fs || t.source === fs) && (!fc || t.category === fc);
  });
  $('txnList').innerHTML = list.length ? list.slice(0, txnShown).map(function (t) { return txnRow(t, false); }).join('') : '<p class="hint">No transactions match.</p>';
  var more = $('txnMore');
  if (more) {
    more.classList.toggle('hidden', list.length <= txnShown);
    more.textContent = 'Show more — ' + (list.length - txnShown) + ' more below';
  }
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
/* ---------- Omit: hide a transaction from lists and totals without deleting it ---------- */
var omitSlot = null;
function omitTxns(ids) {
  var batch = [];
  state.txns.forEach(function (t) { if (ids.indexOf(t.id) >= 0 && !t.omitted) { t.omitted = true; batch.push(t); } });
  if (!batch.length) return;
  save(); renderAll();
  showOmitToast(batch);
}
function showOmitToast(batch) {
  omitSlot = batch;
  $('toastMsg').textContent = batch.length === 1
    ? 'Omitted ' + batch[0].merchant + ' ' + (batch[0].direction === 'in' ? '+' : '−') + fmt(batch[0].cents)
    : 'Omitted ' + batch.length + ' items';
  $('toastUndo').onclick = function () {
    if (omitSlot) { omitSlot.forEach(function (t) { t.omitted = false; }); save(); renderAll(); }
    omitSlot = null;
    hideUndoToast();
  };
  $('toast').classList.remove('hidden');
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndoToast, 10000);
}
/* Omit + create a rule: the rule also sweeps matching items already in the
   list, and (via addTxns) every future import. Undo removes the rule too. */
function omitWithRules(ids) {
  var newRules = [], seenKey = {};
  (state.rules || []).forEach(function (r) { seenKey[normMerchant(r.merchant) + '|' + r.source] = 1; });
  state.txns.forEach(function (t) {
    if (ids.indexOf(t.id) < 0) return;
    var k = normMerchant(t.merchant) + '|' + t.source;
    if (!seenKey[k]) { seenKey[k] = 1; var r = { id: uid(), merchant: t.merchant, source: t.source }; state.rules.push(r); newRules.push(r); }
  });
  var batch = [];
  state.txns.forEach(function (t) { if (!t.omitted && (ids.indexOf(t.id) >= 0 || matchesAnyRule(t))) { t.omitted = true; batch.push(t); } });
  if (!batch.length && !newRules.length) return;
  save(); renderAll();
  showRuleOmitToast(batch, newRules);
}
function showRuleOmitToast(batch, rules) {
  omitSlot = batch;
  var created = rules;
  $('toastMsg').textContent = 'Omitted ' + batch.length + ' item' + (batch.length === 1 ? '' : 's') + (created.length ? ' · rule created: ' + created.map(function (r) { return r.merchant; }).join(', ') : '');
  $('toastUndo').onclick = function () {
    if (omitSlot) omitSlot.forEach(function (t) { t.omitted = false; });
    if (created.length) { var rids = created.map(function (r) { return r.id; }); state.rules = state.rules.filter(function (r) { return rids.indexOf(r.id) < 0; }); }
    omitSlot = null;
    save(); renderAll();
    hideUndoToast();
  };
  $('toast').classList.remove('hidden');
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndoToast, 10000);
}
function ruleSummary(r) {
  var scope = [r.source || 'Any source'];
  if (r.direction) scope.push(r.direction === 'in' ? 'money in' : 'money out');
  if (r.amountOp && r.amountCents != null) scope.push((r.amountOp === 'eq' ? '= ' : r.amountOp === 'lte' ? '≤ ' : '≥ ') + fmt(r.amountCents));
  if (r.note) scope.push('description contains “' + r.note + '”');
  var a = r.action || 'omit', effect;
  if (a === 'omit') effect = 'omits from budget · ' + state.txns.filter(function (t) { return t.omitted && ruleMatches(r, t); }).length + ' omitted now';
  else if (a === 'offset') effect = 'offsets ' + (r.category ? r.category + ' ' : '') + 'spending · applied to ' + state.txns.filter(function (t) { return !t.omitted && t.offset && ruleMatches(r, t); }).length;
  else if (a === 'category') effect = 'sets category to ' + (r.category || 'Other') + ' · matches ' + state.txns.filter(function (t) { return ruleMatches(r, t); }).length;
  else effect = 'renames to “' + (r.newName || '') + '” · matches ' + state.txns.filter(function (t) { return ruleMatches(r, t); }).length;
  return scope.join(' · ') + ' · ' + effect;
}
function renderRules() {
  var box = $('rulesList');
  if (!box) return;
  var rules = state.rules || [];
  box.innerHTML = rules.length ? rules.map(function (r) {
    return '<div class="txn ' + ((r.action || 'omit') === 'offset' ? 'in' : 'out') + '"><div class="txnMain"><strong>' + esc(r.merchant || (r.note ? 'Description: “' + r.note + '”' : 'Any name')) + '</strong><span class="meta">' + esc(ruleSummary(r)) + '</span></div><button class="ghost small" type="button" data-del-rule="' + r.id + '">Delete</button></div>';
  }).join('') : '<p class="hint">No rules yet — tap a transaction → “Make a rule…”, or use New rule below.</p>';
}
function migrateOmitFix() {
  if (state.omitFixV22) return;
  state.omitFixV22 = true;
  var changed = false;
  state.txns.forEach(function (t) { if (isCardPayment(t) && !t.omitted) { t.omitted = true; changed = true; } });
  if (changed) save();
}
function migrateArtifactFix() {
  if (state.artifactFixV44) return;
  state.artifactFixV44 = true;
  var changed = false;
  // The $912.44 Capital One card payment that an old parser build filed as a
  // purchase (merchant literally "Capital One purchase", counted as spending).
  // Justin confirmed on 2026-11-20 that it's his card payment and must not
  // show — it gets the standard card-payment treatment: omitted. Matched
  // exactly (source + artifact merchant + amount) so no real charge can be
  // swept up in it.
  state.txns.forEach(function (t) { if (t.source === 'Capital One' && /^capital one purchase$/i.test(t.merchant || '') && t.cents === 91244 && !t.omitted) { t.omitted = true; changed = true; } });
  if (changed) save();
}
function migrateMerchantFix() {
  if (state.merchantFixV49) return;
  state.merchantFixV49 = true;
  var changed = false;
  // The Berryline charge (Capital One, 2026-11-20): if the phone synced in
  // the ~90 minutes before the v44 parser fix shipped that night, the row
  // imported under the placeholder name "Capital One purchase" and dedup
  // blocks re-import. Rename that exact row (source + placeholder name +
  // $4.95 + date) to the real vendor. Any other row is untouched.
  state.txns.forEach(function (t) {
    if (t.source === 'Capital One' && /^capital one purchase$/i.test(t.merchant || '') && t.cents === 495 && t.date === '2026-11-20') {
      t.merchant = 'Berryline';
      if (/^capital one purchase$/i.test(t.origMerchant || '')) t.origMerchant = 'Berryline';
      changed = true;
    }
  });
  if (changed) save();
}
function migrateNoteFix() {
  if (state.noteFixV47) return;
  state.noteFixV47 = true;
  var changed = false;
  // The Ivan Lin Venmo payment (2026-11-21): its description ("One Ramen
  // and Sushi") was dropped by the pre-v47 note extractor — the email's
  // [See transaction] link left a stray "[" line the extractor mistook for
  // the description and blanked. Matched exactly, and only fills an EMPTY
  // note, so nothing already correct can be overwritten.
  state.txns.forEach(function (t) { if (t.source === 'Venmo' && /^ivan lin$/i.test(t.merchant || '') && t.cents === 2568 && t.date === '2026-11-21' && !t.note) { t.note = 'One Ramen and Sushi'; changed = true; } });
  if (changed) save();
}
var omitOpen = false;
function renderOmitted() {
  var btn = $('omitToggleBtn'), box = $('omitList');
  if (!btn || !box) return;
  var list = state.txns.filter(function (t) { return t.omitted; }).sort(function (a, b) { return b.date.localeCompare(a.date) || b.cents - a.cents; });
  btn.textContent = (omitOpen ? 'Hide omitted' : 'Show omitted') + ' (' + list.length + ')';
  box.innerHTML = list.length ? list.map(function (t) {
    var sign = t.direction === 'in' ? '+' : '−';
    return '<div class="txn ' + (t.direction === 'in' ? 'in' : 'out') + '"><div class="txnMain"><strong>' + esc(t.merchant) + '</strong><span class="meta">' + esc(t.date) + ' · ' + esc(t.source) + '</span></div><div class="txnAmt">' + sign + fmt(t.cents) + '</div><button class="ghost small" type="button" data-restore="' + t.id + '">Restore</button></div>';
  }).join('') : '<p class="hint">Nothing omitted right now.</p>';
}
function renderAll() { if (!unlocked) return; migrateCountFix(); migrateOmitFix(); migrateArtifactFix(); migrateNoteFix(); migrateMerchantFix(); fileDueRecurring(); renderRecurring(); renderHome(); renderTxns(); renderBudgets(); renderOmitted(); renderRules(); syncDisplayPrefs(); updatePinStatus(); $('removePinBtn').classList.toggle('hidden', !state.pin); }
function syncDisplayPrefs() { var tg = $('venmoDescToggle'); if (tg) tg.checked = !state.hideVenmoNotes; }
$('venmoDescToggle').addEventListener('change', function () { state.hideVenmoNotes = !$('venmoDescToggle').checked; save(); renderAll(); });

/* ---------- Adding / importing (dedup + honest counts) ---------- */
/* Card-bill payments (Capital One / BofA) are omitted on arrival: paying the
   bill is not spending — the individual charges are what count. */
function isCardPayment(t) { return (t.source === 'Capital One' || t.source === 'BofA') && /payment/i.test(t.merchant || ''); }
/* User rules ("omit all similar"): match on merchant name + source. */
function normMerchant(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
/* A rule matches on source, direction, and amount when set, plus the merchant
   name: an exact normalized match by default, or a keyword "contains" match
   for rules made in the editor (Rocket Money style). */
function ruleMatches(rule, t) {
  if (rule.source && rule.source !== 'Any' && rule.source !== t.source) return false;
  if (rule.direction && rule.direction !== t.direction) return false;
  if (rule.amountOp && rule.amountCents != null) {
    var a = Math.abs(t.cents);
    if (rule.amountOp === 'eq' && a !== rule.amountCents) return false;
    if (rule.amountOp === 'lte' && a > rule.amountCents) return false;
    if (rule.amountOp === 'gte' && a < rule.amountCents) return false;
  }
  if (rule.note && (t.note || '').toLowerCase().indexOf(String(rule.note).toLowerCase()) < 0) return false;
  var kw = normMerchant(rule.merchant || '');
  if (!kw) return true; // no name set: the rule matches on its other criteria alone
  var name = normMerchant(t.origMerchant || t.merchant);
  return rule.contains ? name.indexOf(kw) >= 0 : name === kw;
}
function applyRuleTo(t, r) {
  var a = r.action || 'omit';
  if (a === 'omit') t.omitted = true;
  else if (a === 'offset') { if (t.direction === 'in' && !t.omitted) { t.offset = true; if (r.category) t.category = r.category; } }
  else if (a === 'category') { if (r.category) t.category = r.category; }
  else if (a === 'rename') { if (r.newName) { if (!t.origMerchant) t.origMerchant = t.merchant; t.merchant = r.newName; } }
}
function applyAllRules(t) { (state.rules || []).forEach(function (r) { if (ruleMatches(r, t)) applyRuleTo(t, r); }); }
function matchesAnyRule(t) { return (state.rules || []).some(function (r) { return (r.action || 'omit') === 'omit' && ruleMatches(r, t); }); }
function findRule(t, action) { return (state.rules || []).filter(function (r) { return (r.action || 'omit') === action && ruleMatches(r, t); })[0] || null; }
function addTxns(drafts) {
  var withIds = drafts.map(function (d) { var t = Object.assign({ id: uid() }, d); if (isCardPayment(t)) t.omitted = true; applyAllRules(t); return t; });
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
  var mt = { id: uid(), date: $('mDate').value, cents: cents, direction: dir, merchant: merchant, source: src, category: cat, note: $('mNote').value.trim() };
  if (isCardPayment(mt)) mt.omitted = true;
  state.txns.push(mt);
  save(); renderAll();
  $('manualForm').reset(); $('mDate').value = P.todayISO();
  document.querySelector('[data-view="txns"]').click();
});
var searchTimer = null;
$('searchBox').addEventListener('input', function () { if (searchTimer) clearTimeout(searchTimer); searchTimer = setTimeout(renderTxns, 120); });
$('txnMore').addEventListener('click', function () { txnShown += 120; renderTxns(); });
$('filterSource').addEventListener('change', renderTxns);
$('filterCat').addEventListener('change', renderTxns);
$('txnList').addEventListener('click', onRowTap);
$('recentList').addEventListener('click', onRowTap);
$('tsCloseBtn').addEventListener('click', closeTxnSheet);
$('txnSheet').addEventListener('click', function (e) { if (e.target === $('txnSheet')) closeTxnSheet(); });
$('tsCat').addEventListener('change', function () {
  var t = tsId ? findTxn(tsId) : null;
  if (t) { t.category = $('tsCat').value; save(); renderAll(); }
});
$('tsDeleteBtn').addEventListener('click', function () {
  var t = tsId ? findTxn(tsId) : null;
  if (!t) { closeTxnSheet(); return; }
  var id = t.id;
  closeTxnSheet();
  openConfirm('Delete this item?', t.merchant + ' · ' + (t.direction === 'in' ? '+' : '−') + fmt(t.cents) + ' · ' + t.date, 'Delete', function () { deleteTxns([id]); });
});
/* ---------- Offset: money back that pays down spending instead of counting as income ---------- */
var offsetSheetIds = null;
var offsetSlot = null;
function showOffsetToast(batch, madeRules) {
  if (!batch.length) { showMsgToast('Nothing to offset.'); return; }
  offsetSlot = batch;
  var created = madeRules || [];
  $('toastMsg').textContent = (batch.length === 1 ? 'Offsetting ' + batch[0].merchant + ' +' + fmt(batch[0].cents) : 'Offsetting ' + batch.length + ' items') + (created.length ? ' · rule created: ' + created.map(function (r) { return r.merchant; }).join(', ') : '');
  $('toastUndo').onclick = function () {
    if (offsetSlot) offsetSlot.forEach(function (t) { t.offset = false; });
    if (created.length) { var rids = created.map(function (r) { return r.id; }); state.rules = state.rules.filter(function (r) { return rids.indexOf(r.id) < 0; }); }
    offsetSlot = null;
    save(); renderAll();
    hideUndoToast();
  };
  $('toast').classList.remove('hidden');
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndoToast, 10000);
}
function showMsgToast(msg) {
  $('toastMsg').textContent = msg;
  $('toastUndo').onclick = function () { hideUndoToast(); };
  $('toast').classList.remove('hidden');
  if (undoTimer) clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndoToast, 10000);
}
function offsetTxns(ids) {
  var batch = [];
  state.txns.forEach(function (t) { if (!t.omitted && !t.offset && t.direction === 'in' && ids.indexOf(t.id) >= 0) { t.offset = true; batch.push(t); } });
  if (batch.length) save();
  renderAll();
  showOffsetToast(batch, []);
}
function offsetWithRules(ids) {
  var keys = {}, made = [];
  ids.forEach(function (id) {
    var t = state.txns.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    var k = normMerchant(t.merchant) + '|' + t.source;
    if (keys[k]) return;
    keys[k] = 1;
    if (!findRule(t, 'offset')) {
      var rule = { id: uid(), merchant: t.merchant, source: t.source, action: 'offset', category: t.category !== 'Income' ? t.category : null };
      state.rules.push(rule); made.push(rule);
    }
  });
  var batch = [];
  state.txns.forEach(function (t) {
    if (t.omitted || t.offset || t.direction !== 'in') return;
    var r = findRule(t, 'offset');
    if (r) { t.offset = true; if (r.category) t.category = r.category; batch.push(t); }
  });
  save(); renderAll();
  showOffsetToast(batch, made);
}
function openOffsetSheet(ids) {
  offsetSheetIds = ids;
  var keys = {}, names = [];
  state.txns.forEach(function (t) {
    if (ids.indexOf(t.id) < 0) return;
    var k = normMerchant(t.merchant) + '|' + t.source;
    if (!keys[k]) { keys[k] = 1; names.push(t.merchant + ' · ' + t.source); }
  });
  $('offsetDetail').textContent = 'Offsetting means this money pays down your spending instead of counting as income. “Offset all similar” creates a rule for ' + names.join(' and ') + ' — it also offsets matching items already in your list, and every future one with the same name and source.';
  $('offsetSheet').classList.remove('hidden');
}
function closeOffsetSheet() { $('offsetSheet').classList.add('hidden'); offsetSheetIds = null; }
$('offsetCancelBtn').addEventListener('click', closeOffsetSheet);
$('offsetSheet').addEventListener('click', function (e) { if (e.target === $('offsetSheet')) closeOffsetSheet(); });
$('offsetJustBtn').addEventListener('click', function () { var ids = offsetSheetIds; closeOffsetSheet(); if (ids) offsetTxns(ids); });
$('offsetRuleBtn').addEventListener('click', function () { var ids = offsetSheetIds; closeOffsetSheet(); if (ids) offsetWithRules(ids); });
$('tsOffsetBtn').addEventListener('click', function () {
  var t = tsId ? findTxn(tsId) : null;
  if (!t) { closeTxnSheet(); return; }
  var id = t.id;
  closeTxnSheet();
  if (t.offset) { t.offset = false; save(); renderAll(); showMsgToast('No longer offsetting ' + t.merchant + ' — it counts as income again.'); }
  else openOffsetSheet([id]);
});

/* ---------- Rule editor: match (merchant keyword, source, direction, amount) + action ---------- */
function syncRuleParamVisibility() {
  var a = $('ruleAction').value;
  $('ruleCatWrap').classList.toggle('hidden', !(a === 'category' || a === 'offset'));
  $('ruleNameWrap').classList.toggle('hidden', a !== 'rename');
  var sel = $('ruleCat'), first = sel.options[0];
  if (a === 'offset' && (!first || first.value !== '')) {
    var o = document.createElement('option');
    o.value = ''; o.textContent = 'Total spending (no category)';
    sel.insertBefore(o, sel.firstChild);
    sel.value = '';
  }
  if (a === 'category' && first && first.value === '') { sel.removeChild(first); if (!sel.value) sel.value = 'Other'; }
}
function ruleErr(msg, el) {
  var e = $('ruleError');
  e.textContent = msg;
  e.classList.remove('hidden');
  if (el) el.classList.add('fieldBad');
}
function clearRuleErr() {
  $('ruleError').classList.add('hidden');
  ['ruleMerchant', 'ruleAmt', 'ruleName'].forEach(function (id) { $(id).classList.remove('fieldBad'); });
}
['ruleMerchant', 'ruleAmt', 'ruleName'].forEach(function (id) { $(id).addEventListener('input', clearRuleErr); });
$('ruleAmtOp').addEventListener('change', function () { $('ruleAmtStar').hidden = !$('ruleAmtOp').value; clearRuleErr(); });
function openRuleEditor(prefill) {
  clearRuleErr();
  $('ruleAmtStar').hidden = true;
  $('ruleMerchant').value = prefill && prefill.merchant || '';
  $('ruleNote').value = prefill && prefill.note || '';
  $('ruleSource').value = prefill && prefill.source || '';
  $('ruleDir').value = prefill && prefill.direction || '';
  $('ruleAmtOp').value = '';
  $('ruleAmt').value = '';
  $('ruleAction').value = 'category';
  $('ruleCat').innerHTML = P.CATEGORIES.map(function (c) { return '<option>' + c + '</option>'; }).join('');
  $('ruleCat').value = prefill && prefill.category && prefill.category !== 'Income' ? prefill.category : 'Other';
  $('ruleName').value = '';
  syncRuleParamVisibility();
  $('ruleSheet').classList.remove('hidden');
}
function closeRuleSheet() { $('ruleSheet').classList.add('hidden'); }
$('ruleAction').addEventListener('change', syncRuleParamVisibility);
$('newRuleBtn').addEventListener('click', function () { openRuleEditor(null); });
$('ruleCancelBtn').addEventListener('click', closeRuleSheet);
$('ruleSheet').addEventListener('click', function (e) { if (e.target === $('ruleSheet')) closeRuleSheet(); });
$('tsRuleBtn').addEventListener('click', function () {
  var t = tsId ? findTxn(tsId) : null;
  closeTxnSheet();
  openRuleEditor(t ? { merchant: t.origMerchant || t.merchant, source: t.source, direction: t.direction, category: t.category, note: t.note || '' } : null);
});
$('ruleSaveBtn').addEventListener('click', function () {
  var kw = $('ruleMerchant').value.trim();
  var noteKw = $('ruleNote').value.trim();
  var action = $('ruleAction').value;
  var amtOp = $('ruleAmtOp').value || null, amtCents = null;
  if (amtOp) {
    var v = parseFloat($('ruleAmt').value);
    if (isNaN(v) || v < 0) { ruleErr('Enter an amount, or set Amount to “Any amount”.', $('ruleAmt')); return; }
    amtCents = Math.round(v * 100);
  }
  if (!kw && !noteKw && !$('ruleSource').value && !$('ruleDir').value && !amtOp) { ruleErr('Set at least one thing for the rule to match: a merchant name, a description, a source, a direction, or an amount.', $('ruleMerchant')); return; }
  var newName = action === 'rename' ? $('ruleName').value.trim() : null;
  if (action === 'rename' && !newName) { ruleErr('Enter the new name for the rule.', $('ruleName')); return; }
  var rule = { id: uid(), merchant: kw, contains: true, note: noteKw || null, source: $('ruleSource').value || null, direction: $('ruleDir').value || null, amountOp: amtOp, amountCents: amtCents, action: action, category: action === 'category' ? $('ruleCat').value : action === 'offset' ? ($('ruleCat').value || null) : null, newName: newName };
  state.rules.push(rule);
  var n = 0;
  state.txns.forEach(function (t) {
    if (!ruleMatches(rule, t)) return;
    var before = t.merchant + '|' + t.category + '|' + t.omitted + '|' + t.offset;
    applyRuleTo(t, rule);
    if ((t.merchant + '|' + t.category + '|' + t.omitted + '|' + t.offset) !== before) n++;
  });
  save(); renderAll();
  closeRuleSheet();
  showMsgToast('Rule created — applied to ' + n + ' transaction' + (n === 1 ? '' : 's') + '.');
});

$('tsOmitBtn').addEventListener('click', function () {
  var id = tsId;
  closeTxnSheet();
  if (id) openOmitSheet([id]);
});
var omitSheetIds = null, omitSheetNote = null;
function openOmitSheet(ids) {
  omitSheetIds = ids;
  omitSheetNote = null;
  if (ids.length === 1) { var t0 = findTxn(ids[0]); if (t0 && showNote(t0)) omitSheetNote = t0.note; }
  var nb = $('omitNoteRuleBtn');
  nb.classList.toggle('hidden', !omitSheetNote);
  if (omitSheetNote) nb.textContent = 'Omit all “' + omitSheetNote + '” — create rule';
  var keys = {}, names = [];
  state.txns.forEach(function (t) {
    if (ids.indexOf(t.id) < 0) return;
    var k = normMerchant(t.merchant) + '|' + t.source;
    if (!keys[k]) { keys[k] = 1; names.push(t.merchant + ' · ' + t.source); }
  });
  $('omitTitle').textContent = 'Omit ' + ids.length + ' item' + (ids.length === 1 ? '' : 's') + '?';
  $('omitDetail').textContent = '“Omit all similar” creates a rule for ' + names.join(' and ') + ' — it also omits matching items already in your list, and every future import with the same name and source.';
  $('omitSheet').classList.remove('hidden');
}
function closeOmitSheet() { $('omitSheet').classList.add('hidden'); omitSheetIds = null; omitSheetNote = null; }
$('omitCancelBtn').addEventListener('click', closeOmitSheet);
$('omitSheet').addEventListener('click', function (e) { if (e.target === $('omitSheet')) closeOmitSheet(); });
$('omitJustBtn').addEventListener('click', function () { var ids = omitSheetIds; closeOmitSheet(); if (ids) omitTxns(ids); });
$('omitRuleBtn').addEventListener('click', function () { var ids = omitSheetIds; closeOmitSheet(); if (ids) omitWithRules(ids); });
$('omitNoteRuleBtn').addEventListener('click', function () { var note = omitSheetNote; closeOmitSheet(); if (note) omitWithNoteRule(note); });
function omitWithNoteRule(note) {
  // Justin's ask (2026-11-21): the Venmo description itself can be the rule —
  // omit everything whose description matches, now and on future imports.
  var rule = { id: uid(), merchant: '', contains: true, note: note, source: null, direction: null, amountOp: null, amountCents: null, action: 'omit', category: null, newName: null };
  state.rules.push(rule);
  var batch = [];
  state.txns.forEach(function (t) { if (!t.omitted && ruleMatches(rule, t)) { t.omitted = true; batch.push(t); } });
  save(); renderAll();
  showRuleOmitToast(batch, [rule]);
}
$('confirmCancel').addEventListener('click', closeConfirm);
$('confirmOk').addEventListener('click', function () { var cb = confirmCb; closeConfirm(); if (cb) cb(); });
$('confirmSheet').addEventListener('click', function (e) { if (e.target === $('confirmSheet')) closeConfirm(); });
$('omitToggleBtn').addEventListener('click', function () { omitOpen = !omitOpen; $('omitList').classList.toggle('hidden', !omitOpen); renderOmitted(); });
$('omitList').addEventListener('click', function (e) {
  var b = e.target.closest ? e.target.closest('[data-restore]') : null;
  if (!b) return;
  state.txns.forEach(function (t) { if (t.id === b.dataset.restore) t.omitted = false; });
  save(); renderAll();
});
$('rulesList').addEventListener('click', function (e) {
  var b = e.target.closest ? e.target.closest('[data-del-rule]') : null;
  if (!b) return;
  state.rules = state.rules.filter(function (r) { return r.id !== b.dataset.delRule; });
  save(); renderAll();
});

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
  // Every Gmail call gets a 20-second timeout — a hung connection used to
  // stall the whole sync forever with no message.
  var ctl = ('AbortController' in window) ? new AbortController() : null;
  var timer = ctl ? setTimeout(function () { ctl.abort(); }, 20000) : null;
  return fetch('https://gmail.googleapis.com/gmail/v1/users/me/' + path, { headers: { 'Authorization': 'Bearer ' + token }, signal: ctl ? ctl.signal : undefined }).then(function (r) {
    if (timer) clearTimeout(timer);
    if (r.status === 401) { gmailToken = null; var e = new Error('Google session expired — tap Sync now to reconnect.'); e.code = 401; throw e; }
    if (!r.ok) throw new Error('Gmail request failed (' + r.status + ').');
    return r.json();
  }).catch(function (e) {
    if (timer) clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error('Gmail took too long to respond — check your connection and try again.');
    throw e;
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
var OFFLINE_SYNC_MSG = 'You’re offline — Gmail sync will work again when you’re back online. Everything else in the app keeps working.';
function syncGmail(interactive) {
  if (gmailSyncing) return Promise.resolve({ busy: true });
  if (!gmailClientId()) { renderGmailStatus(); $('gmailResult').textContent = 'Paste your Google Client ID first — the one-time setup steps are right above it.'; return Promise.resolve({ error: 'Gmail isn’t set up yet — open Settings → Gmail sync to connect it.' }); }
  if (navigator.onLine === false) { $('gmailResult').textContent = OFFLINE_SYNC_MSG; return Promise.resolve({ error: OFFLINE_SYNC_MSG }); }
  gmailSyncing = true; $('gmailResult').innerHTML = '<span class="skelLine" aria-hidden="true"></span>';
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
      // Fetch in small parallel batches (4 at a time): a first sync can mean
      // dozens of alert emails, and fetching one-by-one made that take most
      // of a minute. Order doesn't matter — addTxns dedups and the list
      // sorts by date. A 401 stops new batches and fails the sync, exactly
      // like the old one-by-one chain did.
      function fetchOne(id) {
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
      }
      function batches(i) {
        if (fatal || i >= fresh.length) return Promise.resolve();
        return Promise.all(fresh.slice(i, i + 4).map(fetchOne)).then(function () { return batches(i + 4); });
      }
      return batches(0).then(function () {
        if (fatal) throw fatal;
        var res = addTxns(drafts);
        gmailSet(GMAIL_LS.seen, JSON.stringify(Object.keys(seen).slice(-2000)));
        gmailSet(GMAIL_LS.last, new Date().toISOString());
        gmailSyncing = false;
        renderGmailStatus();
        $('gmailResult').textContent = 'Gmail sync done: added ' + res.added + ' new transaction' + (res.added === 1 ? '' : 's') + (res.dupes ? ', ' + res.dupes + ' already in the app' : '') + ', ignored ' + ignored + ' alert email' + (ignored === 1 ? '' : 's') + ' that weren’t completed payments.';
        return { added: res.added, dupes: res.dupes, ignored: ignored };
      });
    });
  }).catch(function (e) {
    gmailSyncing = false;
    renderGmailStatus();
    $('gmailResult').textContent = navigator.onLine === false ? OFFLINE_SYNC_MSG : (interactive ? (e.message || 'Gmail sync failed.') : 'Gmail is connected, but Google needs a tap this time — open Settings → Gmail sync → Sync now.');
    return { error: $('gmailResult').textContent };
  });
}
var gmailLastAttempt = 0;
function autoSyncGmail() {
  // Runs on open AND every time the app comes back to the front. On iOS the
  // app usually resumes from the background instead of reloading, so a
  // page-load-only sync would leave purchases made hours ago unsynced until
  // he taps Sync himself. Throttled to one attempt per 3 minutes; silent
  // when nothing new arrives, and a toast announces it when it does bring
  // something in — so he can see it working.
  if (gmailSyncing) return;
  if (gmailGet(GMAIL_LS.connected, '') !== '1' || !gmailClientId()) return;
  var now = Date.now();
  if (now - gmailLastAttempt < 3 * 60 * 1000) return;
  gmailLastAttempt = now;
  syncGmail(false).then(function (r) {
    if (r && r.added > 0) showMsgToast('Synced — ' + r.added + ' new transaction' + (r.added === 1 ? '' : 's') + ' from Gmail');
  });
}
function maybeAutoSyncGmail() {
  if (gmailAutoTried) return; gmailAutoTried = true;
  autoSyncGmail();
}
window.addEventListener('pageshow', autoSyncGmail);
window.addEventListener('focus', autoSyncGmail);
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
      state = { txns: s.txns, budgets: s.budgets || {}, pin: state.pin, recurring: s.recurring || [], rules: s.rules || [] }; save(); renderAll();
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
  var el = document.documentElement;
  el.classList.add('theme-switching'); // kill transitions mid-flip so colors snap instead of crossfading muddily
  el.setAttribute('data-theme', t);
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'dark' ? '#000000' : '#ffffff');
  requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.remove('theme-switching'); }); });
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
  if (btn) { btn.textContent = 'Reloading'; btn.classList.add('skelBusy'); btn.disabled = true; }
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
  setTimeout(function () { if (btn) { btn.textContent = old; btn.classList.remove('skelBusy'); btn.disabled = false; } }, 4000);
}
/* ---------- Sync button: pull new transactions from Gmail, THEN reload the app code.
   If Gmail isn't connected there's nothing to pull, so it just reloads. If the
   sync fails in a way that needs Justin (sign-in closed, session expired), the
   error is shown and the reload is skipped so he can act on it. ---------- */
function syncAndReload(btn) {
  var connected = gmailGet(GMAIL_LS.connected, '') === '1' && !!gmailClientId();
  if (!connected) { reloadApp(btn); return; }
  var oldHTML = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing'; btn.classList.add('skelBusy'); }
  var done = function (outcome) {
    if (outcome && outcome.error) {
      if (btn) { btn.disabled = false; btn.innerHTML = oldHTML; btn.classList.remove('skelBusy'); }
      showMsgToast(outcome.error, 6000);
      return;
    }
    var known = outcome && typeof outcome.added === 'number';
    if (known) showMsgToast(outcome.added
      ? 'Synced — ' + outcome.added + ' new transaction' + (outcome.added === 1 ? '' : 's') + '. Reloading the app…'
      : 'Already up to date. Reloading the app…', 1600);
    setTimeout(function () { reloadApp(btn); }, known ? 1100 : 0);
  };
  if (gmailSyncing) { // the on-open auto-sync is already running — wait for it, then reload
    var waited = 0;
    var iv = setInterval(function () {
      waited += 300;
      if (!gmailSyncing || waited >= 60000) { clearInterval(iv); done({}); }
    }, 300);
    return;
  }
  syncGmail(true).then(done, function () { done({}); });
}
$('reloadBtn').addEventListener('click', function () { syncAndReload($('reloadBtn')); });
$('reloadBtn2').addEventListener('click', function () { syncAndReload($('reloadBtn2')); });

/* ---------- Swipe-to-dismiss: drag a sheet down by its grab handle ----------
   Past ~90px it dismisses through the sheet's own Cancel/Close button (so all
   the normal close cleanup runs). Dragging UP meets rubber-band resistance —
   offset = 64 * over/(over+150), over = pull past 12px — and springs back. */
(function () {
  var CLOSE_BTN = { confirmSheet: 'confirmCancel', omitSheet: 'omitCancelBtn', txnSheet: 'tsCloseBtn', offsetSheet: 'offsetCancelBtn', ruleSheet: 'ruleCancelBtn' };
  Object.keys(CLOSE_BTN).forEach(function (sid) {
    var sheet = $(sid); if (!sheet) return;
    var card = sheet.querySelector('.sheetCard'), grab = sheet.querySelector('.grab');
    if (!card || !grab) return;
    var startY = null, dy = 0, dragging = false;
    grab.addEventListener('pointerdown', function (e) {
      startY = e.clientY; dy = 0; dragging = true;
      card.style.animation = 'none'; card.style.transition = 'none';
      if (grab.setPointerCapture) { try { grab.setPointerCapture(e.pointerId); } catch (err) {} }
      e.preventDefault();
    });
    grab.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      dy = e.clientY - startY;
      if (dy >= 0) card.style.transform = 'translateY(' + dy + 'px)';
      else { var over = Math.max(0, -dy - 12); card.style.transform = 'translateY(' + (-64 * (over / (over + 150))) + 'px)'; }
    });
    function end() {
      if (!dragging) return; dragging = false;
      card.style.transition = 'transform .3s cubic-bezier(.32,.72,0,1)';
      if (dy > 90) {
        card.style.transform = 'translateY(110%)';
        var btn = $(CLOSE_BTN[sid]);
        setTimeout(function () { if (btn) btn.click(); }, 190);
      } else {
        card.style.transform = '';
        setTimeout(function () { card.style.transition = ''; }, 320);
      }
    }
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', end);
    // When the sheet hides, clear the drag's inline styles so the next open
    // gets its entrance animation and a clean transform again.
    new MutationObserver(function () {
      if (sheet.classList.contains('hidden')) { card.style.animation = ''; card.style.transform = ''; card.style.transition = ''; }
    }).observe(sheet, { attributes: true, attributeFilter: ['class'] });
  });
})();

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
/* Offline strip: show it whenever the phone reports no connection. */
function updateOfflineBar() { var b = $('offlineBar'); if (b) b.classList.toggle('hidden', navigator.onLine !== false); }
window.addEventListener('online', updateOfflineBar);
window.addEventListener('offline', updateOfflineBar);
updateOfflineBar();
if (state.pin) showLock(); else { unlocked = true; showApp(); }
if (unlocked) handleHashImport();
window.addEventListener('hashchange', function () { if (unlocked) handleHashImport(); });
})();
