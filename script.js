/* ===================================================================
   ChitRagupt — script.js   (data schema v2)

   SECTIONS
    1. DATA LAYER ........ DB, schema, settings, counters, audit, atomic()
    2. HELPERS ........... money (integer paise), dates, escaping, words, CSV
    3. LEDGER ............ double-entry store + posting rules (the single source of truth)
    4. BOOKS ............. customer / supplier sub-ledgers, open bills, FIFO, aging, statements
    5. CALC .............. every derived number (cash, receivables, GST, profit …)
    6. RECONCILIATION .... integrity checks that drive the red banner
    7. MIGRATION ......... v1 → v2 (never loses data; raw copy kept)
    8. BACKUP ............ snapshots, file backups, restore with validation
    9. SERVICE LAYER ..... Svc.* business operations (swap these for API calls later)
   10. UI HELPERS ........ toast, modal, print, date-range filter, router, banners
   11. PAGES ............. dashboard, POS, bills, inventory, sales, expenses, P&L,
                          balance sheet, GST, cash book, customers (+ dashboard),
                          suppliers, aging, reports, audit, settings
   12. MANUAL / FORECAST / LOGIN / CALCULATOR / LANGUAGE / CHATBOT / BOOT
   =================================================================== */

/* ===================================================================
   1. DATA LAYER
   All persistence goes through DB. Money is stored as integer PAISE.
   =================================================================== */
const SCHEMA_VERSION = 2;

/* keys that make up a business's data (exported / snapshotted / restored). They live in the server
   database (Neon) and are kept in memory in the browser. */
const DATA_KEYS = ['products','sales','expenses','customers','suppliers','payments','supplierPayments',
  'purchases','returns','held','gstAdjust','ledger','audit','counters','settings',
  'businessName','gstNumber','address','bizPhone'];

/* device-only keys: never sent to the server (backup counters and the rolling snapshots of THIS browser) */
const LOCAL_KEYS = ['meta', 'snapshots'];

let _ledgerStore = null;      // cached LedgerStore (see section 3)
let _idCounter = 0;

/* DB keeps the same synchronous get/set API the whole app was written against.
   - _mem holds every key as JSON text, so get() returns a fresh copy exactly like the old localStorage version
   - set() updates memory, mirrors to the offline cache and queues ONE debounced save (see sync.js)
   - LOCAL_KEYS are stored in this browser only */
const DB = {
  _mem: Object.create(null),
  _undo: [],                  // open atomic() frames (innermost last)
  get(key, def = []) {
    const raw = this._mem[key];
    if (raw === undefined) return def;
    try { const v = JSON.parse(raw); return v ?? def; } catch { return def; }
  },
  has(key) { return this._mem[key] !== undefined; },
  set(key, val) {
    const s = JSON.stringify(val === undefined ? null : val);
    if (key === 'ledger' && _ledgerStore && _ledgerStore.e !== val) _ledgerStore = null;
    const prev = this._mem[key];
    if (prev === s) return;                                       // unchanged: nothing to save
    const local = LOCAL_KEYS.includes(key);
    if (local) {
      try { localStorage.setItem(Sync.k(key), s); }
      catch (e) { if (key !== 'snapshots') toast('Storage full or unavailable — this device could not keep the change. Download a backup and free some space.', 'error'); throw e; }
    }
    this._undo.forEach(f => { if (!(key in f.mem)) f.mem[key] = prev; });
    this._mem[key] = s;
    if (!local) Sync.touch(key, s);
  },
  _rollback(frame) {
    Object.keys(frame.mem).forEach(k => {
      const v = frame.mem[k];
      if (v === undefined) delete this._mem[k]; else this._mem[k] = v;
      if (LOCAL_KEYS.includes(k)) {
        try { if (v === undefined) localStorage.removeItem(Sync.k(k)); else localStorage.setItem(Sync.k(k), v); } catch { /* ignore */ }
      }
    });
    Sync.restore(frame);
  },
  id() { return Date.now().toString(36) + (++_idCounter).toString(36) + Math.random().toString(36).slice(2, 5); }
};

class AppError extends Error {
  constructor(message, code) { super(message); this.code = code || 'ERR'; }
}

/* Run several writes as one unit.
   - every listed key (plus audit + counters, plus anything else the function writes) is snapshotted in memory
   - if fn throws, all of them are rolled back and nothing is queued for the server
   - on success, ALL changed keys go to the server in ONE request, saved in ONE SQL transaction */
function atomic(keys, fn) {
  const all = Array.from(new Set([...keys, 'audit', 'counters']));
  const frame = { mem: Object.create(null), dirty: new Set(Sync.dirty) };
  all.forEach(k => { frame.mem[k] = DB._mem[k]; });
  DB._undo.push(frame);
  let r;
  try {
    r = fn();
    Backup.noteChange();
  } catch (e) {
    DB._undo.pop();
    DB._rollback(frame);
    _ledgerStore = null;
    throw e;
  }
  DB._undo.pop();
  if (!DB._undo.length) Sync.schedule();
  return r;
}

/* ---- settings ---- */
const DEFAULT_SETTINGS = {
  backupSchedule: 'off',       // off | daily | weekly
  snapEvery: 20,               // auto-snapshot after N changes
  creditLimitMode: 'warn',     // warn | block
  autoApplyAdvance: true,
  defaultDueDays: 30
};
const Settings = {
  all() { return { ...DEFAULT_SETTINGS, ...DB.get('settings', {}) }; },
  get(k) { return this.all()[k]; },
  set(k, v) { const s = DB.get('settings', {}); s[k] = v; DB.set('settings', s); }
};

/* ---- sequential numbers ---- */
const Counters = {
  next(name, scope = '') {
    const c = DB.get('counters', {});
    const k = name + scope;
    c[k] = (c[k] || 0) + 1;
    DB.set('counters', c);
    return c[k];
  },
  peek(name, scope = '') { return (DB.get('counters', {})[name + scope] || 0) + 1; }
};
const pad4 = n => String(n).padStart(4, '0');
const nextInvoiceNo = (dateStr) => { const y = dkey(dateStr).slice(0, 4); return `INV-${y}-${pad4(Counters.next('inv', y))}`; };
const peekInvoiceNo = () => { const y = today().slice(0, 4); return `INV-${y}-${pad4(Counters.peek('inv', y))}`; };
const nextCNNo = () => `CN-${pad4(Counters.next('cn'))}`;
const nextReceiptNo = () => `RC-${pad4(Counters.next('rc'))}`;
const nextPurchaseNo = () => `PB-${pad4(Counters.next('pb'))}`;

/* ---- audit log (append-only) ---- */
function currentUserName() {
  return (typeof Sync !== 'undefined' && Sync.user && Sync.user.ownerName) || 'Owner';
}
const Audit = {
  log(action, entity, refId, summary) {
    const a = DB.get('audit');
    a.push({ id: DB.id(), ts: new Date().toISOString(), action, entity, refId: refId || '', summary: summary || '', user: currentUserName() });
    DB.set('audit', a);
  }
};

/* ===================================================================
   2. HELPERS — money (integer paise), dates, escaping, words, CSV
   =================================================================== */
const toP = x => {                         // rupees (number|string) -> integer paise
  const n = typeof x === 'number' ? x : parseFloat(String(x ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100 + (n < 0 ? -1e-7 : 1e-7));
};
const toR = p => (p || 0) / 100;           // paise -> rupees (display only)
const pctOf = (p, rate) => Math.round(p * rate / 100);
const mulQ = (p, q) => Math.round(p * q);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rupeeStr = p => (toR(p)).toFixed(2);
const clone = o => JSON.parse(JSON.stringify(o));
const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);

/* split `total` paise across `weights` so the parts add up exactly (largest remainder) */
function allocateProportional(total, weights) {
  const W = sum(weights);
  if (!W || !total) return weights.map(() => 0);
  const raw = weights.map(w => total * w / W);
  const floor = raw.map(Math.floor);
  let rem = total - sum(floor);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rem > 0 && k < order.length; k++, rem--) floor[order[k][1]]++;
  return floor;
}

const fmt = p => '₹' + toR(p).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtR = n => '₹' + (+n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });   // rupee floats (calculator)

const pad2 = n => String(n).padStart(2, '0');
function dkey(x) {                         // any date -> local 'YYYY-MM-DD'
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  const d = x instanceof Date ? x : new Date(x);
  if (isNaN(d)) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
const today = () => dkey(new Date());
const keyToDate = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
function addDays(k, n) { const d = keyToDate(k); d.setDate(d.getDate() + n); return dkey(d); }
function daysBetween(a, b) {           // whole days from key a to key b (b − a)
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}
const fmtDate = d => { const k = dkey(d); if (!k) return '—'; return keyToDate(k).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
const fmtShort = d => { const k = dkey(d); if (!k) return '—'; return keyToDate(k).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); };
const inRange = (k, r) => !r || ((!r.from || k >= r.from) && (!r.to || k <= r.to));

/* escape ANY user-entered text before it is placed in innerHTML / attributes */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* amount in words — Indian numbering (lakh / crore) */
function amountInWords(paise) {
  paise = Math.max(0, Math.round(paise || 0));
  const rupees = Math.floor(paise / 100), ps = paise % 100;
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = n => n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  const three = n => (n >= 100 ? ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' : '') : '') + (n % 100 ? two(n % 100) : '');
  function words(n) {
    if (n === 0) return 'Zero';
    const parts = [];
    const cr = Math.floor(n / 10000000); n %= 10000000;
    const lk = Math.floor(n / 100000); n %= 100000;
    const th = Math.floor(n / 1000); n %= 1000;
    if (cr) parts.push(words(cr) + ' Crore');
    if (lk) parts.push(two(lk) + ' Lakh');
    if (th) parts.push(two(th) + ' Thousand');
    if (n) parts.push(three(n));
    return parts.join(' ');
  }
  let out = 'Rupees ' + words(rupees);
  if (ps) out += ' and ' + two(ps) + ' Paise';
  return out + ' Only';
}

/* Excel-compatible CSV (UTF-8 BOM, quoted cells) */
function downloadCSV(filename, rows) {
  const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ===================================================================
   3. LEDGER — the single source of truth
   Every sale, payment, return, advance, expense and supplier payment posts
   balanced debit/credit lines here. Cash, receivables, advances, payables
   and GST are all derived from it (see Calc).
   =================================================================== */
const ACCOUNTS = {
  CASH:      { name: 'Cash in Hand',            group: 'asset',     nature: 'debit'  },
  BANK:      { name: 'Bank / UPI / Card',       group: 'asset',     nature: 'debit'  },
  AR:        { name: 'Accounts Receivable',     group: 'asset',     nature: 'debit'  },
  GST_IN:    { name: 'Input GST Credit',        group: 'asset',     nature: 'debit'  },
  ADV:       { name: 'Customer Advances',       group: 'liability', nature: 'credit' },
  AP:        { name: 'Supplier Payables',       group: 'liability', nature: 'credit' },
  GST_OUT:   { name: 'Output GST Payable',      group: 'liability', nature: 'credit' },
  SALES:     { name: 'Sales (ex-GST)',          group: 'income',    nature: 'credit' },
  SALES_RET: { name: 'Sales Returns',           group: 'income',    nature: 'debit'  },   // contra-income
  EXP:       { name: 'Expenses & Purchases',    group: 'expense',   nature: 'debit'  },
  EQ_OPEN:   { name: 'Capital & Opening Balances', group: 'equity', nature: 'credit' }
};
const modeAcc = m => (m === 'Cash' ? 'CASH' : 'BANK');

class LedgerStore {
  constructor(arr) {
    this.e = arr || [];
    this.seq = this.e.reduce((m, x) => Math.max(m, x.seq || 0), 0);
  }
  /* lines: [{a:'CASH', dr:100, cr:0, party, billId, mode, memo, category}] — must balance */
  post(type, date, refId, lines, memo = '') {
    let dr = 0, cr = 0;
    lines.forEach(l => {
      if (!ACCOUNTS[l.a]) throw new Error('Unknown ledger account ' + l.a);
      if (!Number.isInteger(l.dr || 0) || !Number.isInteger(l.cr || 0) || (l.dr || 0) < 0 || (l.cr || 0) < 0) throw new Error('Ledger amounts must be non-negative integer paise');
      dr += l.dr || 0; cr += l.cr || 0;
    });
    if (dr !== cr) throw new Error(`Unbalanced ledger entry (${type}): debit ${dr} ≠ credit ${cr}`);
    const ts = new Date().toISOString();
    lines.forEach(l => {
      if (!(l.dr || l.cr)) return;
      this.e.push({
        id: DB.id(), seq: ++this.seq, date, d: dkey(date), ts, type, account: l.a,
        debit: l.dr || 0, credit: l.cr || 0, refId, party: l.party || '', billId: l.billId || '',
        mode: l.mode || '', memo: l.memo || memo, category: l.category || ''
      });
    });
  }
  /* post the exact opposite of every entry that matches refId + types (used by void) */
  reverse(refId, srcTypes, date, type, memo) {
    const src = this.e.filter(x => x.refId === refId && srcTypes.includes(x.type));
    if (!src.length) return;
    this.post(type, date, refId, src.map(x => ({ a: x.account, dr: x.credit, cr: x.debit, party: x.party, billId: x.billId, mode: x.mode, category: x.category })), memo);
  }
  query(o = {}) {
    return this.e.filter(x =>
      (!o.account || x.account === o.account) && (!o.accounts || o.accounts.includes(x.account)) &&
      (!o.party || x.party === o.party) && (!o.type || x.type === o.type) &&
      (!o.billId || x.billId === o.billId) && (!o.refId || x.refId === o.refId) &&
      (!o.from || x.d >= o.from) && (!o.to || x.d <= o.to) && (!o.before || x.d < o.before));
  }
  dc(o = {}) { let dr = 0, cr = 0; this.query(o).forEach(x => { dr += x.debit; cr += x.credit; }); return { dr, cr }; }
  balance(acc, o = {}) { const { dr, cr } = this.dc({ ...o, account: acc }); return ACCOUNTS[acc].nature === 'debit' ? dr - cr : cr - dr; }
  billOutstanding(account, party, billId) {
    const { dr, cr } = this.dc({ account, party, billId });
    return account === 'AR' ? dr - cr : cr - dr;
  }
}

const Ledger = {
  store() { if (!_ledgerStore) _ledgerStore = new LedgerStore(DB.get('ledger')); return _ledgerStore; },
  persist() { DB.set('ledger', this.store().e); },
  query(o) { return this.store().query(o); },
  dc(o) { return this.store().dc(o); },
  balance(a, o) { return this.store().balance(a, o); }
};

/* ---- posting rules: one function per document type. They take a LedgerStore so the
        same code posts live data and rebuilds the ledger during migration/repair. ---- */
const Post = {
  opening(L, kind, p) {
    const date = p.openingDate || dkey(p.createdAt);
    if (kind === 'customer') {
      L.post('opening', date, p.id, [
        { a: 'AR', dr: p.openingBalance, party: p.id, billId: 'OPEN:' + p.id },
        { a: 'EQ_OPEN', cr: p.openingBalance }], `Opening balance — ${p.name}`);
    } else {
      L.post('opening', date, p.id, [
        { a: 'EQ_OPEN', dr: p.openingBalance },
        { a: 'AP', cr: p.openingBalance, party: p.id, billId: 'OPEN:' + p.id }], `Opening payable — ${p.name}`);
    }
  },
  sale(L, s) {
    const party = s.customer && s.customer !== 'Walk-in' ? s.customer : '';
    const lines = [{ a: 'SALES', cr: s.finalTotal - s.gst, party }, { a: 'GST_OUT', cr: s.gst, party }];
    (s.payments || []).forEach(pm => {
      if (pm.mode === 'Credit') lines.push({ a: 'AR', dr: pm.amount, party, billId: s.id });
      else if (pm.mode === 'Advance') lines.push({ a: 'ADV', dr: pm.amount, party });
      else lines.push({ a: modeAcc(pm.mode), dr: pm.amount, mode: pm.mode, party });
    });
    L.post('sale', s.date, s.id, lines, `Sale ${s.invoiceNo} — ${s.customerName || 'Walk-in'}`);
  },
  saleVoid(L, s, at) {
    const party = s.customer && s.customer !== 'Walk-in' ? s.customer : '';
    L.reverse(s.id, ['sale'], at, 'void', `Void ${s.invoiceNo}`);
    if (party) {   // receipts that were already allocated to this bill become customer advance
      const out = L.billOutstanding('AR', party, s.id);
      if (out < 0) L.post('void', at, s.id, [
        { a: 'AR', dr: -out, party, billId: s.id }, { a: 'ADV', cr: -out, party }], `Receipts on voided ${s.invoiceNo} moved to advance`);
    }
  },
  payment(L, p) {
    const lines = [{ a: modeAcc(p.mode), dr: p.amount, mode: p.mode, party: p.customer }];
    (p.allocations || []).forEach(al => lines.push({ a: 'AR', cr: al.amount, party: p.customer, billId: al.billId }));
    if (p.advanceAdded) lines.push({ a: 'ADV', cr: p.advanceAdded, party: p.customer });
    L.post(p.kind === 'advance' ? 'advance' : 'payment', p.date, p.id, lines,
      `${p.kind === 'advance' ? 'Advance' : 'Payment'} received ${p.receiptNo || ''} — ${p.customerName || ''}`);
  },
  returnNote(L, r) {
    const party = r.customer && r.customer !== 'Walk-in' ? r.customer : '';
    const lines = [{ a: 'SALES_RET', dr: r.net, party }, { a: 'GST_OUT', dr: r.gst, party }];
    (r.applied || []).forEach(al => lines.push({ a: 'AR', cr: al.amount, party, billId: al.billId }));
    if (r.advanceAdded) lines.push({ a: 'ADV', cr: r.advanceAdded, party });
    if (r.refundAmount) lines.push({ a: modeAcc(r.refundMode), cr: r.refundAmount, mode: r.refundMode, party });
    L.post('return', r.date, r.id, lines, `Credit note ${r.cnNo} (ref ${r.invoiceNo})`);
  },
  expense(L, e) {
    L.post('expense', e.date, e.id, [
      { a: 'EXP', dr: e.amount, category: e.category || 'Other' },
      { a: modeAcc(e.mode || 'Cash'), cr: e.amount, mode: e.mode || 'Cash' }], `Expense — ${e.name}`);
  },
  expenseVoid(L, e, at) { L.reverse(e.id, ['expense'], at, 'void', `Void expense — ${e.name}`); },
  purchase(L, pu) {
    L.post('purchase', pu.date, pu.id, [
      { a: 'EXP', dr: pu.amount - pu.gst, category: 'Purchases' },
      { a: 'GST_IN', dr: pu.gst },
      { a: 'AP', cr: pu.amount, party: pu.supplier, billId: pu.id }], `Purchase ${pu.billNo} — ${pu.supplierName || ''}`);
  },
  supplierPayment(L, sp) {
    const lines = [{ a: modeAcc(sp.mode), cr: sp.amount, mode: sp.mode, party: sp.supplier }];
    (sp.allocations || []).forEach(al => lines.push({ a: 'AP', dr: al.amount, party: sp.supplier, billId: al.billId }));
    L.post('supplier-payment', sp.date, sp.id, lines, `Paid supplier ${sp.supplierName || ''} ${sp.note ? '(' + sp.note + ')' : ''}`);
  },
  gstAdjust(L, g) {
    const a = Math.abs(g.amount);
    if (g.amount >= 0) L.post('gst-adjust', g.date, g.id, [{ a: 'GST_IN', dr: a }, { a: 'EQ_OPEN', cr: a }], 'Input GST credit entered');
    else L.post('gst-adjust', g.date, g.id, [{ a: 'EQ_OPEN', dr: a }, { a: 'GST_IN', cr: a }], 'Input GST credit reduced');
  }
};

/* rebuild a complete ledger from the business documents (used by migration & the repair button) */
function buildLedgerFromDocs(d) {
  const L = new LedgerStore([]);
  const ev = [], t = x => Date.parse(x) || 0;
  (d.customers || []).forEach(c => { if (c.openingBalance > 0) ev.push({ t: t(c.createdAt), o: 0, f: () => Post.opening(L, 'customer', c) }); });
  (d.suppliers || []).forEach(s => { if (s.openingBalance > 0) ev.push({ t: t(s.createdAt), o: 0, f: () => Post.opening(L, 'supplier', s) }); });
  (d.gstAdjust || []).forEach(g => ev.push({ t: t(g.createdAt || g.date), o: 0, f: () => Post.gstAdjust(L, g) }));
  (d.sales || []).forEach(s => {
    ev.push({ t: t(s.date), o: 1, f: () => Post.sale(L, s) });
    if (s.status === 'void') ev.push({ t: t(s.voidedAt), o: 5, f: () => Post.saleVoid(L, s, s.voidedAt) });
  });
  (d.payments || []).forEach(p => ev.push({ t: t(p.createdAt || p.date), o: 2, f: () => Post.payment(L, p) }));
  (d.returns || []).forEach(r => { if (r.status !== 'void') ev.push({ t: t(r.createdAt || r.date), o: 3, f: () => Post.returnNote(L, r) }); });
  (d.expenses || []).forEach(e => {
    ev.push({ t: t(e.createdAt || e.date), o: 2, f: () => Post.expense(L, e) });
    if (e.status === 'void') ev.push({ t: t(e.voidedAt), o: 5, f: () => Post.expenseVoid(L, e, e.voidedAt) });
  });
  (d.purchases || []).forEach(p => ev.push({ t: t(p.createdAt || p.date), o: 2, f: () => Post.purchase(L, p) }));
  (d.supplierPayments || []).forEach(p => ev.push({ t: t(p.createdAt || p.date), o: 3, f: () => Post.supplierPayment(L, p) }));
  ev.forEach((x, i) => x.i = i);
  ev.sort((a, b) => a.t - b.t || a.o - b.o || a.i - b.i).forEach(x => x.f());
  return L.e;
}

/* ===================================================================
   4. BOOKS — party sub-ledgers (all derived from the ledger)
   =================================================================== */
const Book = {
  maps() {
    return {
      sales: new Map(DB.get('sales').map(s => [s.id, s])),
      purchases: new Map(DB.get('purchases').map(p => [p.id, p])),
      customers: new Map(DB.get('customers').map(c => [c.id, c])),
      suppliers: new Map(DB.get('suppliers').map(c => [c.id, c]))
    };
  },
  customerName(id) {
    if (!id || id === 'Walk-in') return 'Walk-in';
    return (DB.get('customers').find(c => c.id === id) || {}).name || 'Unknown';
  },

  /* open (unpaid) bills of a customer or supplier, oldest first */
  openBills(kind, partyId, M) {
    M = M || this.maps();
    const L = Ledger.store(), acc = kind === 'customer' ? 'AR' : 'AP';
    const by = {};
    L.query({ account: acc, party: partyId }).forEach(e => {
      by[e.billId] = (by[e.billId] || 0) + (acc === 'AR' ? e.debit - e.credit : e.credit - e.debit);
    });
    const party = (kind === 'customer' ? M.customers : M.suppliers).get(partyId) || {};
    const t = today();
    const out = [];
    Object.entries(by).forEach(([billId, amt]) => {
      if (amt <= 0) return;
      let ref, date, total, dueDays;
      if (billId.startsWith('OPEN:')) { ref = 'Opening balance'; date = party.openingDate || dkey(party.createdAt); dueDays = party.dueDays; total = amt; }
      else if (M.sales.has(billId)) { const s = M.sales.get(billId); ref = s.invoiceNo; date = dkey(s.date); total = s.finalTotal; dueDays = s.dueDays; }
      else if (M.purchases.has(billId)) { const p = M.purchases.get(billId); ref = p.billNo; date = dkey(p.date); total = p.amount; dueDays = p.dueDays; }
      else { ref = billId || 'Unreferenced'; date = t; total = amt; }
      if (dueDays == null) dueDays = Settings.get('defaultDueDays');
      const dueDate = addDays(date, +dueDays || 0);
      out.push({ billId, ref, date, total, outstanding: amt, dueDays: +dueDays || 0, dueDate, overdueDays: daysBetween(dueDate, t) });
    });
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  },

  /* FIFO allocation of `amount` over open bills (oldest first) */
  allocateFIFO(bills, amount) {
    let rest = amount; const allocs = [];
    for (const b of bills) {
      if (rest <= 0) break;
      const a = Math.min(rest, b.outstanding);
      if (a > 0) { allocs.push({ billId: b.billId, ref: b.ref, amount: a }); rest -= a; }
    }
    return { allocs, rest };
  },

  pending(cid)  { return Ledger.balance('AR', { party: cid }); },
  advance(cid)  { return Ledger.balance('ADV', { party: cid }); },
  payable(sid)  { return Ledger.balance('AP', { party: sid }); },

  /* refresh the cached pendingAmount / advanceBalance fields from the ledger */
  sync() {
    const L = Ledger.store();
    const cs = DB.get('customers'); let ch = false;
    cs.forEach(c => {
      const p = L.balance('AR', { party: c.id }), a = L.balance('ADV', { party: c.id });
      if (c.pendingAmount !== p || c.advanceBalance !== a) { c.pendingAmount = p; c.advanceBalance = a; ch = true; }
    });
    if (ch) DB.set('customers', cs);
    const ss = DB.get('suppliers'); ch = false;
    ss.forEach(s => { const p = L.balance('AP', { party: s.id }); if (s.pendingAmount !== p) { s.pendingAmount = p; ch = true; } });
    if (ch) DB.set('suppliers', ss);
  },

  /* aging: kind 'customer' | 'supplier'. Buckets use days past DUE date; not-yet-due falls in 0–30. */
  aging(kind) {
    const M = this.maps(), parties = kind === 'customer' ? DB.get('customers') : DB.get('suppliers');
    const rows = [], totals = { b: [0, 0, 0, 0], total: 0, overdue: 0 };
    parties.forEach(p => {
      const bills = this.openBills(kind, p.id, M);
      if (!bills.length) return;
      const b = [0, 0, 0, 0]; let overdue = 0, maxOver = 0;
      bills.forEach(x => {
        const age = Math.max(0, x.overdueDays);
        b[age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3] += x.outstanding;
        if (x.overdueDays > 0) { overdue += x.outstanding; maxOver = Math.max(maxOver, x.overdueDays); }
      });
      const total = sum(b);
      rows.push({ id: p.id, name: p.name, phone: p.phone, b, total, overdue, maxOver, bills });
      b.forEach((v, i) => totals.b[i] += v); totals.total += total; totals.overdue += overdue;
    });
    rows.sort((a, c) => c.overdue - a.overdue || c.total - a.total);
    return { rows, totals };
  },

  /* customer statement rows (documents), with running balance (+ = customer owes, − = advance) */
  statementRows(cid) {
    const rows = [];
    const c = DB.get('customers').find(x => x.id === cid);
    if (!c) return rows;
    if (c.openingBalance > 0) rows.push({ d: c.openingDate || dkey(c.createdAt), ts: c.createdAt || '', type: 'Opening', ref: 'brought forward', debit: c.openingBalance, credit: 0 });
    DB.get('sales').forEach(s => {
      if (s.customer !== cid || s.status === 'void') return;
      rows.push({ d: dkey(s.date), ts: s.date, type: 'Bill', ref: s.invoiceNo, debit: s.finalTotal, credit: 0, id: s.id });
      (s.payments || []).forEach(pm => {
        if (pm.mode === 'Credit' || pm.mode === 'Advance') return;   // advance use is internal: the bill row already carries it
        rows.push({ d: dkey(s.date), ts: s.date + '~', type: 'Payment', ref: `${s.invoiceNo} · ${pm.mode}`, debit: 0, credit: pm.amount });
      });
    });
    DB.get('payments').forEach(p => {
      if (p.customer !== cid) return;
      rows.push({ d: dkey(p.date), ts: p.createdAt || p.date, type: p.kind === 'advance' ? 'Advance' : 'Payment', ref: `${p.receiptNo || ''} · ${p.mode}${p.note ? ' · ' + p.note : ''}`, debit: 0, credit: p.amount, id: p.id });
    });
    DB.get('returns').forEach(r => {
      if (r.customer !== cid || r.status === 'void') return;
      rows.push({ d: dkey(r.date), ts: r.createdAt || r.date, type: 'Return', ref: `${r.cnNo} (${r.invoiceNo})`, debit: 0, credit: r.total, id: r.id });
      if (r.refundAmount) rows.push({ d: dkey(r.date), ts: (r.createdAt || r.date) + '~', type: 'Refund paid', ref: `${r.cnNo} · ${r.refundMode}`, debit: r.refundAmount, credit: 0 });
    });
    rows.sort((a, b) => a.d.localeCompare(b.d) || String(a.ts).localeCompare(String(b.ts)));
    let run = 0; rows.forEach(r => { run += r.debit - r.credit; r.balance = run; });
    return rows;
  },
  statementClosing(cid) { const r = this.statementRows(cid); return r.length ? r[r.length - 1].balance : 0; },

  customerSummary(cid) {
    const sales = DB.get('sales').filter(s => s.customer === cid && s.status !== 'void');
    const rets = DB.get('returns').filter(r => r.customer === cid && r.status !== 'void');
    const pays = DB.get('payments').filter(p => p.customer === cid);
    const upfront = sum(sales, s => sum((s.payments || []).filter(p => p.mode !== 'Credit' && p.mode !== 'Advance'), p => p.amount));
    const billed = sum(sales, s => s.finalTotal), returns = sum(rets, r => r.total);
    const dates = [
      ...pays.map(p => dkey(p.date)),
      ...sales.filter(s => (s.payments || []).some(p => p.mode !== 'Credit' && p.mode !== 'Advance')).map(s => dkey(s.date))
    ].sort();
    const bills = this.openBills('customer', cid);
    const overdue = sum(bills.filter(b => b.overdueDays > 0), b => b.outstanding);
    return {
      billed, returns, received: upfront + sum(pays, p => p.amount), pending: this.pending(cid), advance: this.advance(cid),
      lastPayment: dates.length ? dates[dates.length - 1] : '', bills, overdue,
      maxOverdueDays: Math.max(0, ...bills.map(b => b.overdueDays))
    };
  }
};

/* ===================================================================
   5. CALC — every derived figure comes from the ledger
   Sales figures are NET of GST and of returns, everywhere.
   =================================================================== */
const Calc = {
  allSales()      { return DB.get('sales'); },
  sales(r)        { const a = DB.get('sales').filter(s => s.status !== 'void'); return r ? a.filter(s => inRange(dkey(s.date), r)) : a; },
  returns(r)      { const a = DB.get('returns').filter(x => x.status !== 'void'); return r ? a.filter(x => inRange(dkey(x.date), r)) : a; },
  expenses(r)     { const a = DB.get('expenses').filter(x => x.status !== 'void'); return r ? a.filter(x => inRange(dkey(x.date), r)) : a; },
  products()      { return DB.get('products'); },

  netSales(r)     { const L = Ledger.store(); return L.balance('SALES', r) - L.balance('SALES_RET', r); },
  totalSales(r)   { return this.netSales(r); },                                   // ex-GST, after returns
  grossBilled(r)  { return sum(this.sales(r), s => s.finalTotal) - sum(this.returns(r), x => x.total); },   // incl. GST
  totalGSTCollected(r) { return Ledger.balance('GST_OUT', r); },
  totalOrders(r)  { return this.sales(r).length; },
  totalExpenses(r){ return Ledger.balance('EXP', r); },
  profit(r)       { return this.netSales(r) - this.totalExpenses(r); },
  inventoryValue(){ return sum(this.products(), p => mulQ(p.price, p.stock)); },

  totalReceivable(){ return Ledger.balance('AR'); },
  totalAdvances() { return Ledger.balance('ADV'); },
  totalPayables() { return Ledger.balance('AP'); },
  cashInHand()    { return Ledger.balance('CASH'); },
  bankBalance()   { return Ledger.balance('BANK'); },
  cashBalance()   { return this.cashInHand() + this.bankBalance(); },
  inputGST(r)     { return Ledger.balance('GST_IN', r); },
  netGST(r)       { return this.totalGSTCollected(r) - this.inputGST(r); },

  assets()        { return this.cashBalance() + this.inventoryValue() + this.totalReceivable() + this.inputGST(); },
  liabilities()   { return this.totalGSTCollected() + this.totalPayables() + this.totalAdvances(); },
  netWorth()      { return this.assets() - this.liabilities(); },     // equity = balancing figure
  overdueReceivable() { return Book.aging('customer').totals.overdue; },
  overduePayable()    { return Book.aging('supplier').totals.overdue; }
};

/* ===================================================================
   6. RECONCILIATION — drives the red "out of balance" banner
   Each check compares the ledger with an independently computed figure.
   =================================================================== */
const Recon = {
  run() {
    const L = Ledger.store(), checks = [];
    const add = (name, a, b, hint) => checks.push({ name, ok: a === b, ledger: a, other: b, hint: hint || '' });
    const all = L.dc();
    add('Trial balance: total debits = total credits', all.dr, all.cr);

    const sales = Calc.sales(), rets = Calc.returns(), custs = DB.get('customers'), sups = DB.get('suppliers');
    add('Receivables: ledger = Σ customer pending', Calc.totalReceivable(), sum(custs, c => c.pendingAmount || 0));
    add('Advances: ledger = Σ customer advance balances', Calc.totalAdvances(), sum(custs, c => c.advanceBalance || 0));
    add('Customer statements net (owed − advance) = ledger AR − advances', sum(custs, c => Book.statementClosing(c.id)), Calc.totalReceivable() - Calc.totalAdvances());
    const supDocs = sum(sups, s => s.openingBalance || 0) + sum(DB.get('purchases'), p => p.amount) - sum(DB.get('supplierPayments'), p => p.amount);
    add('Payables: ledger = opening + purchases − payments', Calc.totalPayables(), supDocs);
    add('Payables: ledger = Σ supplier payable', Calc.totalPayables(), sum(sups, s => s.pendingAmount || 0));
    add('Output GST: ledger = Σ bills GST − Σ credit-note GST', Calc.totalGSTCollected(), sum(sales, s => s.gst) - sum(rets, r => r.gst));
    add('Net sales: ledger = Σ bills (ex-GST) − Σ returns (ex-GST)', Calc.netSales(), sum(sales, s => s.finalTotal - s.gst) - sum(rets, r => r.net));
    const cashDocs = sum(sales, s => sum((s.payments || []).filter(p => p.mode !== 'Credit' && p.mode !== 'Advance'), p => p.amount))
      + sum(DB.get('payments'), p => p.amount) - sum(rets, r => r.refundAmount || 0)
      - sum(Calc.expenses(), e => e.amount) - sum(DB.get('supplierPayments'), p => p.amount);
    add('Cash & bank: ledger = receipts − refunds − expenses − supplier payments', Calc.cashBalance(), cashDocs);
    add('Expenses: ledger = expense records + purchase bills (ex-GST)', Calc.totalExpenses(), sum(Calc.expenses(), e => e.amount) + sum(DB.get('purchases'), p => p.amount - p.gst));
    add('Input GST: ledger = entered credit + purchase GST', Calc.inputGST(), sum(DB.get('gstAdjust'), g => g.amount) + sum(DB.get('purchases'), p => p.gst));

    const negStock = DB.get('products').filter(p => p.stock < 0);
    checks.push({ name: 'No product has negative stock', ok: !negStock.length, ledger: negStock.length, other: 0, hint: negStock.map(p => p.name).join(', ') });
    let negBills = 0;
    custs.forEach(c => { const by = {}; L.query({ account: 'AR', party: c.id }).forEach(e => by[e.billId] = (by[e.billId] || 0) + e.debit - e.credit); negBills += Object.values(by).filter(v => v < 0).length; });
    checks.push({ name: 'No bill has a negative outstanding amount', ok: !negBills, ledger: negBills, other: 0 });
    const bad = checks.filter(c => !c.ok);
    return { ok: !bad.length, checks, failed: bad };
  }
};

/* ledger repair: rebuild from documents (keeps documents untouched) */
window.rebuildLedger = function () {
  if (!confirm('Rebuild the ledger from your bills, payments, returns and expenses?\n\nA safety snapshot is taken first. Documents are not changed.')) return;
  try {
    Backup.snapshot('before-rebuild');
    atomic(['ledger', 'customers', 'suppliers'], () => {
      const d = {}; ['customers', 'suppliers', 'gstAdjust', 'sales', 'payments', 'returns', 'expenses', 'purchases', 'supplierPayments'].forEach(k => d[k] = DB.get(k));
      DB.set('ledger', buildLedgerFromDocs(d));
      Book.sync();
      Audit.log('repair', 'ledger', '', 'Ledger rebuilt from documents');
    });
    toast('Ledger rebuilt');
    navigate(currentPage, routeParam);
  } catch (e) { toast('Rebuild failed: ' + e.message, 'error'); }
};


/* ===================================================================
   7. MIGRATION  (schema v1 → v2)
   - migrateV1toV2() upgrades old (v1) data; it is used by Restore-from-file and by the one-time
     import of the old browser data (see Legacy below). Nothing is dropped.
   - The old browser keys are never modified or deleted by the app: they stay as the raw copy
     until you choose to remove them (Settings).
   - Old rupee values are converted to integer paise.
   =================================================================== */
const emptyData = () => ({
  products: [], sales: [], expenses: [], customers: [], suppliers: [], payments: [], supplierPayments: [],
  purchases: [], returns: [], held: [], gstAdjust: [], ledger: [], audit: [], counters: {},
  settings: { ...DEFAULT_SETTINGS }, businessName: '', gstNumber: '', address: '', bizPhone: ''
});
const dataDefault = k => { const e = emptyData()[k]; return e === undefined ? [] : e; };

function migrateV1toV2(D) {
  const d = clone(D || {});
  const now = new Date().toISOString(), nowKey = dkey(now);
  const out = emptyData();
  out.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  ['businessName', 'gstNumber', 'address', 'bizPhone'].forEach(k => { if (typeof d[k] === 'string') out[k] = d[k]; });
  const notes = [];

  /* products: price -> paise */
  out.products = (d.products || []).map(p => ({ ...p, price: toP(p.price), stock: Math.round(+p.stock || 0), gstRate: +p.gstRate || 0 }));
  const prodByName = new Map(out.products.map(p => [p.name, p]));

  /* customers / suppliers: new fields, balances -> paise (opening balances fixed up below) */
  const custs = (d.customers || []).map(c => ({
    ...c, gstin: c.gstin || '', creditLimit: 0, dueDays: out.settings.defaultDueDays, createdAt: c.createdAt || now,
    openingDate: nowKey, openingBalance: 0, pendingAmount: toP(c.pendingAmount), advanceBalance: 0, archived: false
  }));
  const custById = new Map(custs.map(c => [c.id, c]));
  out.suppliers = (d.suppliers || []).map(s => {
    const op = Math.max(0, toP(s.pendingAmount));
    return { ...s, gstin: s.gstin || '', dueDays: out.settings.defaultDueDays, createdAt: s.createdAt || now, openingDate: nowKey, openingBalance: op, pendingAmount: op, archived: false };
  });

  /* sales */
  out.sales = (d.sales || []).map(s => {
    const items = (s.items || []).map(i => {
      const itemTotal = toP(i.itemTotal != null ? i.itemTotal : (+i.price || 0) * (+i.qty || 0));
      const itemGST = toP(i.itemGST != null ? i.itemGST : (+i.price || 0) * (+i.qty || 0) * (+i.gstRate || 0) / 100);
      return { pid: (prodByName.get(i.name) || {}).id || '', name: i.name, qty: +i.qty || 0, price: toP(i.price), gstRate: +i.gstRate || 0, gross: itemTotal, discount: 0, itemTotal, itemGST };
    });
    const total = sum(items, i => i.itemTotal), gst = sum(items, i => i.itemGST);
    let discount = Math.max(0, toP(s.discount));
    if (discount > total) { notes.push('Discount larger than subtotal clamped on a bill'); discount = total; }
    const finalTotal = total + gst - discount;                 // legacy semantics: discount applied after GST
    const cust = s.customer && s.customer !== 'Walk-in' ? custById.get(s.customer) : null;
    const mode = ['Cash', 'UPI', 'Card', 'Credit'].includes(s.payment) ? s.payment : 'Cash';
    let payments, balanceDue = 0, migrationNote = '';
    if (mode === 'Credit' && cust) { payments = [{ mode: 'Credit', amount: finalTotal }]; balanceDue = finalTotal; }
    else if (mode === 'Credit') { payments = [{ mode: 'Cash', amount: finalTotal }]; migrationNote = 'Credit sale without a customer was treated as cash.'; }
    else payments = [{ mode, amount: finalTotal }];
    if (finalTotal === 0) payments = [];
    return {
      id: s.id, invoiceNo: '', date: s.date, customer: s.customer || 'Walk-in', customerName: cust ? cust.name : (s.customer && s.customer !== 'Walk-in' ? 'Unknown' : 'Walk-in'),
      items, grossTotal: total, discount, total, gst, finalTotal, payments, payment: payments.map(p => p.mode).join(' + ') || mode, balanceDue, advanceUsed: 0,
      cashTendered: 0, change: 0, dueDays: cust ? cust.dueDays : 0, status: 'active', legacy: true, note: '', migrationNote
    };
  });
  /* sequential invoice numbers in chronological order */
  const byDate = out.sales.slice().sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
  byDate.forEach(s => { const y = dkey(s.date).slice(0, 4); out.counters['inv' + y] = (out.counters['inv' + y] || 0) + 1; s.invoiceNo = `INV-${y}-${pad4(out.counters['inv' + y])}`; });

  /* customer balances: pending = opening + credit bills − payments (unknown split resolved safely) */
  custs.forEach(c => {
    const credit = byDate.filter(s => s.customer === c.id && s.balanceDue > 0);
    const dueSum = sum(credit, s => s.balanceDue), P0 = c.pendingAmount;
    if (P0 >= dueSum) c.openingBalance = P0 - dueSum;
    else {
      const paid = dueSum - P0; let rest = paid; const allocations = [];
      credit.forEach(s => { const a = Math.min(rest, s.balanceDue); if (a > 0) { allocations.push({ billId: s.id, ref: s.invoiceNo, amount: a }); rest -= a; } });
      out.counters.rc = (out.counters.rc || 0) + 1;
      out.payments.push({ id: DB.id(), receiptNo: `RC-${pad4(out.counters.rc)}`, customer: c.id, customerName: c.name, date: nowKey, createdAt: now, amount: paid, mode: 'Cash', kind: 'payment',
        note: 'Migrated: payments recorded before the v2 upgrade', allocations, advanceAdded: 0, migrated: true });
    }
  });
  out.customers = custs;

  /* expenses */
  out.expenses = (d.expenses || []).map(e => ({ ...e, amount: toP(e.amount), category: e.category || 'Other', date: e.date || nowKey, mode: 'Cash', status: 'active', createdAt: (e.date || nowKey) + 'T12:00:00' }));

  /* single input-GST figure -> an adjustment document */
  const ig = toP(d.inputGST || 0);
  if (ig > 0) out.gstAdjust.push({ id: DB.id(), date: nowKey, createdAt: now, amount: ig, note: 'Migrated from v1 Input GST figure' });

  out.ledger = buildLedgerFromDocs(out);
  /* cached party balances from the new ledger */
  const L = new LedgerStore(out.ledger);
  out.customers.forEach(c => { c.pendingAmount = L.balance('AR', { party: c.id }); c.advanceBalance = L.balance('ADV', { party: c.id }); });
  out.suppliers.forEach(s => { s.pendingAmount = L.balance('AP', { party: s.id }); });

  out.audit.push({ id: DB.id(), ts: now, action: 'migrate', entity: 'system', refId: '', user: 'System',
    summary: `Upgraded data v1 → v2: ${out.products.length} products, ${out.sales.length} bills, ${out.customers.length} customers, ${out.expenses.length} expenses${notes.length ? ' (' + notes.join('; ') + ')' : ''}` });
  return out;
}

/* ---- the OLD browser-only data (localStorage keys bl_*): read once to import it into the account ---- */
const LEGACY_KEYS = ['products', 'sales', 'expenses', 'customers', 'suppliers'];
const Legacy = {
  has() {
    try {
      return LEGACY_KEYS.some(k => { const v = JSON.parse(localStorage.getItem('bl_' + k)); return Array.isArray(v) && v.length > 0; });
    } catch { return false; }
  },
  counts() {
    const n = k => { try { const v = JSON.parse(localStorage.getItem('bl_' + k)); return Array.isArray(v) ? v.length : 0; } catch { return 0; } };
    return { products: n('products'), sales: n('sales'), customers: n('customers') };
  },
  /* returns complete v2 data; v1 data is upgraded with the same migrateV1toV2 as before. The old keys are NOT modified. */
  read() {
    const ver = parseInt(localStorage.getItem('bl_schemaVersion') || '0', 10);
    if (ver > SCHEMA_VERSION) throw new AppError('Your old data was saved by a newer version of ChitRagupt. Please update the app.');
    let data;
    if (ver === SCHEMA_VERSION) {
      data = {};
      DATA_KEYS.forEach(k => { const v = localStorage.getItem('bl_' + k); if (v !== null) { try { data[k] = JSON.parse(v); } catch { } } });
    } else {
      const D = {};
      ['products', 'sales', 'expenses', 'customers', 'suppliers', 'inputGST', 'businessName', 'gstNumber', 'address', 'bizPhone'].forEach(k => {
        const v = localStorage.getItem('bl_' + k); if (v !== null) { try { D[k] = JSON.parse(v); } catch { } }
      });
      data = migrateV1toV2(D);
    }
    const full = { ...emptyData(), ...data };
    const check = Backup.validate({ app: 'ChitRagupt', schemaVersion: SCHEMA_VERSION, data: full });
    if (!check.ok) throw new AppError('Old data could not be imported: ' + check.errors.slice(0, 2).join('; '));
    return full;
  }
};
window.removeLegacyLocal = function () {
  const rm = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('bl_') && k !== 'bl_lang') rm.push(k); }
  rm.forEach(k => localStorage.removeItem(k));
  toast(t('settings.legacy_removed'));
  if (currentPage === 'settings') navigate('settings');
};

/* make sure every store exists (first run of a new business, or after a reset) */
function seedIfEmpty() {
  DATA_KEYS.forEach(k => { if (!DB.has(k)) DB.set(k, dataDefault(k)); });
  const m = DB.get('meta', {}); if (!m.firstUseAt) { m.firstUseAt = new Date().toISOString(); DB.set('meta', m); }
}

/* ===================================================================
   8. BACKUP — rolling snapshots, scheduled file backup, validated restore
   =================================================================== */
const Backup = {
  _busy: false,
  meta() { return DB.get('meta', {}); },
  setMeta(p) { DB.set('meta', { ...this.meta(), ...p }); },
  hasData() { return DB.get('products').length || DB.get('sales').length || DB.get('customers').length || DB.get('expenses').length || DB.get('suppliers').length; },

  collect() {
    const data = {};
    DATA_KEYS.forEach(k => data[k] = DB.get(k, dataDefault(k)));
    return { app: 'ChitRagupt', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data };
  },

  /* called once per completed business operation */
  noteChange() {
    try {
      if (this._busy) return;
      const n = (this.meta().changes || 0) + 1;
      const every = Math.max(1, parseInt(Settings.get('snapEvery'), 10) || 20);
      if (n >= every) this.snapshot('auto'); else this.setMeta({ changes: n });
    } catch (e) { console.warn('backup counter', e); }
  },

  snapshots() { return DB.get('snapshots'); },
  snapshot(reason) {
    if (this._busy) return null;
    this._busy = true;
    try {
      const obj = this.collect(), payload = JSON.stringify(obj);
      const entry = { id: DB.id(), ts: new Date().toISOString(), reason: reason || 'manual', bytes: payload.length,
        counts: { sales: obj.data.sales.length, customers: obj.data.customers.length, products: obj.data.products.length }, payload };
      let list = this.snapshots(); list.push(entry); list = list.slice(-5);          // keep the last 5
      for (; ;) {
        try { DB.set('snapshots', list); break; }
        catch (e) {
          if (list.length <= 1) { toast('Could not keep a snapshot — browser storage is full. Download a backup file.', 'error'); return null; }
          list.shift();
        }
      }
      this.setMeta({ changes: 0, lastSnapshotAt: entry.ts });
      return entry;
    } finally { this._busy = false; }
  },

  exportFile(auto) {
    const obj = this.collect();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    a.download = `chitragupt-backup-${today()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    this.setMeta({ lastFileBackupAt: new Date().toISOString() });
    Audit.log('backup', 'data', '', auto ? 'Scheduled backup file downloaded' : 'Backup file downloaded');
  },

  scheduledCheck() {
    const sch = Settings.get('backupSchedule');
    if (sch === 'off' || !this.hasData()) return;
    const last = this.meta().lastFileBackupAt, lk = last ? dkey(last) : '';
    const due = sch === 'daily' ? lk !== today() : (!last || daysBetween(lk, today()) >= 7);
    if (due) { this.exportFile(true); setTimeout(() => toast('Scheduled backup downloaded'), 400); }
  },

  /* returns {days, never} when the last file backup is older than 7 days */
  warning() {
    if (!this.hasData()) return null;
    const m = this.meta(), ref = m.lastFileBackupAt || m.firstUseAt;
    if (!ref) return null;
    const days = Math.floor((Date.now() - Date.parse(ref)) / 86400000);
    return days > 7 ? { days, never: !m.lastFileBackupAt } : null;
  },

  /* schema validation — nothing is written unless this passes */
  validate(raw) {
    const errors = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['File is not a ChitRagupt backup'] };
    const wrapped = raw.data && typeof raw.data === 'object';
    const data = wrapped ? raw.data : raw;
    const ver = parseInt(wrapped ? raw.schemaVersion : (raw.schemaVersion || 1), 10) || 1;
    if (wrapped && raw.app && raw.app !== 'ChitRagupt') errors.push('Backup belongs to a different app');
    if (ver > SCHEMA_VERSION) errors.push(`Backup is from a newer version (schema ${ver}); update the app first`);
    const arrKeys = ['products', 'sales', 'expenses', 'customers', 'suppliers'];
    if (!arrKeys.some(k => k in data)) errors.push('No ChitRagupt data found in file');
    const num = v => typeof v === 'number' && Number.isFinite(v);
    const need = (k, fn, what) => {
      if (!(k in data)) return;
      if (!Array.isArray(data[k])) { errors.push(`"${k}" must be a list`); return; }
      const badAt = data[k].findIndex(x => !x || typeof x !== 'object' || !fn(x));
      if (badAt >= 0) errors.push(`"${k}" entry #${badAt + 1} is invalid (${what})`);
    };
    need('products', p => p.id && typeof p.name === 'string' && num(+p.price) && num(+p.stock), 'id, name, price, stock');
    need('sales', s => s.id && s.date && Array.isArray(s.items) && num(+s.finalTotal), 'id, date, items, finalTotal');
    need('expenses', e => e.id && num(+e.amount), 'id, amount');
    need('customers', c => c.id && typeof c.name === 'string', 'id, name');
    need('suppliers', c => c.id && typeof c.name === 'string', 'id, name');
    if (ver >= 2) {
      ['payments', 'supplierPayments', 'purchases', 'returns', 'gstAdjust', 'held', 'audit'].forEach(k => need(k, x => x.id, 'id'));
      if (!Array.isArray(data.ledger)) errors.push('"ledger" is missing');
      else {
        let dr = 0, cr = 0, bad = -1;
        data.ledger.forEach((e, i) => { if (bad < 0 && (!e || !ACCOUNTS[e.account] || !Number.isInteger(e.debit) || !Number.isInteger(e.credit))) bad = i; else if (e) { dr += e.debit; cr += e.credit; } });
        if (bad >= 0) errors.push(`ledger entry #${bad + 1} is invalid`);
        else if (dr !== cr) errors.push('ledger does not balance (debits ≠ credits)');
      }
      if ('sales' in data && 'ledger' in data && data.sales.some(s => !s.invoiceNo || !Array.isArray(s.payments))) errors.push('some bills are missing invoice numbers or payments');
    }
    return { ok: !errors.length, errors, data, ver };
  },

  /* restore from a parsed file object or a snapshot payload */
  restore(raw, label) {
    const v = this.validate(raw);
    if (!v.ok) throw new AppError('Backup rejected: ' + v.errors.slice(0, 3).join('; '), 'INVALID');
    let data = v.ver < 2 ? migrateV1toV2(v.data) : { ...emptyData(), ...v.data };
    this.snapshot('before-restore');                                   // safety net
    atomic(DATA_KEYS, () => {
      DATA_KEYS.forEach(k => DB.set(k, k in data ? data[k] : dataDefault(k)));
      _ledgerStore = null;
      Book.sync();
      Audit.log('restore', 'data', '', `Data restored from ${label || 'backup'} (schema v${v.ver}${v.ver < 2 ? ' → v2' : ''})`);
    });
  },
  restoreSnapshot(id) {
    const s = this.snapshots().find(x => x.id === id);
    if (!s) throw new AppError('Snapshot not found');
    this.restore(JSON.parse(s.payload), 'snapshot ' + new Date(s.ts).toLocaleString('en-IN'));
  }
};

/* ===================================================================
   9. SERVICE LAYER — all business operations.
   UI code calls Svc.*; nothing here touches the DOM. Replace the bodies with
   API calls later and the UI keeps working. Every method throws AppError on
   invalid input, and writes through atomic() so a failure never half-saves.
   =================================================================== */
const PAY_MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Cheque'];
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

/* price / discount / GST for a set of cart lines (also used for the live POS preview) */
function computeBill(lines, billDiscount) {
  const items = lines.map(l => {
    const gross = mulQ(l.price, l.qty), itemDisc = clamp(l.discount || 0, 0, gross);
    return { ...l, gross, itemDisc, net0: gross - itemDisc };
  });
  const bd = clamp(billDiscount || 0, 0, sum(items, i => i.net0));
  const alloc = allocateProportional(bd, items.map(i => i.net0));
  items.forEach((i, k) => {
    i.discount = i.itemDisc + alloc[k];
    i.itemTotal = i.gross - i.discount;
    i.itemGST = pctOf(i.itemTotal, i.gstRate);
  });
  const total = sum(items, i => i.itemTotal), gst = sum(items, i => i.itemGST);
  return { items, grossTotal: sum(items, i => i.gross), discount: sum(items, i => i.discount), total, gst, finalTotal: total + gst };
}

/* effective (net of any legacy post-GST discount) amounts per bill line, for returns */
function effItems(sale) {
  if (!sale.legacy || !sale.discount) return sale.items.map(i => ({ eNet: i.itemTotal, eGST: i.itemGST }));
  const parts = allocateProportional(sale.finalTotal - sale.gst, sale.items.map(i => i.itemTotal));
  return sale.items.map((i, k) => ({ eNet: parts[k], eGST: i.itemGST }));
}
function findProduct(products, it) { return products.find(p => p.id === it.pid) || products.find(p => p.name === it.name); }

const Svc = {
  /* ---------- products ---------- */
  saveProduct({ id, name, price, gstRate, stock }) {
    name = (name || '').trim();
    if (!name) throw new AppError('Product name required');
    if (!(price >= 0)) throw new AppError('Enter a valid price');
    if (!(stock >= 0) || !Number.isInteger(stock)) throw new AppError('Stock must be a whole number ≥ 0');
    atomic(['products'], () => {
      const ps = DB.get('products');
      if (id) {
        const p = ps.find(x => x.id === id); if (!p) throw new AppError('Product not found');
        const before = `${p.name}, ${fmt(p.price)}, GST ${p.gstRate}%, stock ${p.stock}`;
        Object.assign(p, { name, price, gstRate, stock });
        Audit.log('edit', 'product', id, `${before} → ${name}, ${fmt(price)}, GST ${gstRate}%, stock ${stock}`);
      } else {
        const nid = DB.id(); ps.push({ id: nid, name, price, gstRate, stock });
        Audit.log('create', 'product', nid, `${name} @ ${fmt(price)}, stock ${stock}`);
      }
      DB.set('products', ps);
    });
  },
  deleteProduct(id) {
    atomic(['products'], () => {
      const ps = DB.get('products'), p = ps.find(x => x.id === id); if (!p) return;
      DB.set('products', ps.filter(x => x.id !== id));
      Audit.log('delete', 'product', id, `${p.name} removed from catalogue (past bills keep their copy)`);
    });
  },
  adjustStock(id, delta, why) {
    atomic(['products'], () => {
      const ps = DB.get('products'), p = ps.find(x => x.id === id); if (!p) throw new AppError('Product not found');
      if (p.stock + delta < 0) throw new AppError(`Only ${p.stock} in stock`);
      const old = p.stock; p.stock += delta; DB.set('products', ps);
      Audit.log('edit', 'stock', id, `${p.name}: ${old} → ${p.stock} (${why || 'adjustment'})`);
    });
  },

  /* ---------- sales ---------- */
  createSale(o) {
    const products = DB.get('products');
    if (!o.lines || !o.lines.length) throw new AppError('Cart is empty');
    const lines = o.lines.map(l => {
      const p = products.find(x => x.id === l.pid); if (!p) throw new AppError('A product in the cart no longer exists');
      if (!Number.isInteger(l.qty) || l.qty < 1) throw new AppError(`Invalid quantity for ${p.name}`);
      if (p.stock < l.qty) throw new AppError(`Insufficient stock for ${p.name} (available ${p.stock})`);
      return { pid: p.id, name: p.name, qty: l.qty, price: p.price, gstRate: p.gstRate, discount: l.discount || 0 };
    });
    const bill = computeBill(lines, o.billDiscount);
    if (bill.finalTotal <= 0) throw new AppError('Bill total must be greater than ₹0');

    const custId = o.customerId && o.customerId !== 'Walk-in' ? o.customerId : 'Walk-in';
    const cust = custId === 'Walk-in' ? null : DB.get('customers').find(c => c.id === custId);
    if (custId !== 'Walk-in' && !cust) throw new AppError('Selected customer not found');

    const pays = (o.payments || []).filter(p => p.amount > 0).map(p => ({ mode: p.mode, amount: p.amount }));
    pays.forEach(p => { if (!['Cash', 'UPI', 'Card', 'Credit'].includes(p.mode)) throw new AppError('Invalid payment mode ' + p.mode); });
    const paid = sum(pays.filter(p => p.mode !== 'Credit'), p => p.amount), credit = sum(pays.filter(p => p.mode === 'Credit'), p => p.amount);
    if (paid + credit !== bill.finalTotal)
      throw new AppError(`Paid ${fmt(paid)} + Credit ${fmt(credit)} must equal the bill total ${fmt(bill.finalTotal)}`, 'PAY_MISMATCH');
    if (credit > 0 && !cust) throw new AppError('Credit or part-payment needs a customer — Walk-in is not allowed', 'NEEDS_CUSTOMER');

    let adv = 0;
    if (cust && credit > 0 && o.applyAdvance) adv = Math.min(Book.advance(cust.id), credit);
    const balanceDue = credit - adv;

    if (cust && balanceDue > 0 && cust.creditLimit > 0) {
      const after = Book.pending(cust.id) + balanceDue;
      if (after > cust.creditLimit) {
        const msg = `Credit limit ${fmt(cust.creditLimit)} exceeded — pending would become ${fmt(after)}.`;
        if (Settings.get('creditLimitMode') === 'block') throw new AppError(msg + ' (blocked by settings)', 'LIMIT_BLOCK');
        if (!o.overrideLimit) throw new AppError(msg, 'LIMIT_WARN');
      }
    }
    const cashLine = sum(pays.filter(p => p.mode === 'Cash'), p => p.amount);
    const tendered = o.cashTendered > 0 ? o.cashTendered : 0;
    if (tendered && tendered < cashLine) throw new AppError('Cash tendered is less than the cash amount');

    const stored = pays.filter(p => p.mode !== 'Credit');
    if (adv > 0) stored.push({ mode: 'Advance', amount: adv });
    if (balanceDue > 0) stored.push({ mode: 'Credit', amount: balanceDue });

    return atomic(['sales', 'products', 'ledger', 'customers'], () => {
      const date = new Date().toISOString();
      const sale = {
        id: DB.id(), invoiceNo: nextInvoiceNo(date), date, customer: custId, customerName: cust ? cust.name : 'Walk-in',
        items: bill.items.map(i => ({ pid: i.pid, name: i.name, qty: i.qty, price: i.price, gstRate: i.gstRate, gross: i.gross, discount: i.discount, itemTotal: i.itemTotal, itemGST: i.itemGST })),
        grossTotal: bill.grossTotal, discount: bill.discount, total: bill.total, gst: bill.gst, finalTotal: bill.finalTotal,
        payments: stored, payment: stored.map(p => p.mode).join(' + '), balanceDue, advanceUsed: adv,
        cashTendered: tendered, change: tendered ? tendered - cashLine : 0,
        dueDays: cust ? (cust.dueDays ?? Settings.get('defaultDueDays')) : 0, status: 'active', note: o.note || ''
      };
      const sales = DB.get('sales'); sales.push(sale); DB.set('sales', sales);
      const ps = DB.get('products');
      sale.items.forEach(i => { const p = ps.find(x => x.id === i.pid); if (p) p.stock = Math.max(0, p.stock - i.qty); });
      DB.set('products', ps);
      Post.sale(Ledger.store(), sale); Ledger.persist();
      Book.sync();
      Audit.log('create', 'sale', sale.id, `${sale.invoiceNo} · ${fmt(sale.finalTotal)} · ${sale.customerName} · ${sale.payment}${balanceDue ? ' · due ' + fmt(balanceDue) : ''}`);
      return sale;
    });
  },

  voidSale(id, reason) {
    const sales = DB.get('sales'), s = sales.find(x => x.id === id);
    if (!s) throw new AppError('Bill not found');
    if (s.status === 'void') throw new AppError('Bill is already void');
    if (DB.get('returns').some(r => r.saleId === id && r.status !== 'void')) throw new AppError('This bill has credit notes, so it cannot be voided.');
    atomic(['sales', 'products', 'ledger', 'customers'], () => {
      const at = new Date().toISOString();
      s.status = 'void'; s.voidedAt = at; s.voidReason = reason || '';
      DB.set('sales', sales);
      const ps = DB.get('products');
      s.items.forEach(i => { const p = findProduct(ps, i); if (p) p.stock += i.qty; });          // restore stock
      DB.set('products', ps);
      Post.saleVoid(Ledger.store(), s, at); Ledger.persist();                                     // reverse every effect
      Book.sync();
      Audit.log('void', 'sale', id, `${s.invoiceNo} voided (${fmt(s.finalTotal)})${reason ? ' — ' + reason : ''}`);
    });
  },

  /* sales return / credit note. items: [{idx, qty}] ; settlement: reduce_pending | refund | advance */
  createReturn({ saleId, items, settlement, refundMode, note }) {
    const sale = DB.get('sales').find(s => s.id === saleId);
    if (!sale || sale.status === 'void') throw new AppError('Bill not found or void');
    const eff = effItems(sale);
    const prior = DB.get('returns').filter(r => r.saleId === saleId && r.status !== 'void').flatMap(r => r.items);
    const lines = [];
    (items || []).filter(x => x.qty > 0).forEach(({ idx, qty }) => {
      const it = sale.items[idx]; if (!it) throw new AppError('Invalid item');
      const pr = prior.filter(x => x.idx === idx);
      const pq = sum(pr, x => x.qty), pn = sum(pr, x => x.net), pg = sum(pr, x => x.gst);
      const rem = it.qty - pq;
      if (!Number.isInteger(qty) || qty > rem) throw new AppError(`Cannot return ${qty} × ${it.name}; only ${rem} left to return`);
      let net, gst;
      if (qty === rem) { net = eff[idx].eNet - pn; gst = eff[idx].eGST - pg; }
      else { net = Math.min(Math.round(eff[idx].eNet * qty / it.qty), eff[idx].eNet - pn); gst = Math.min(Math.round(eff[idx].eGST * qty / it.qty), eff[idx].eGST - pg); }
      lines.push({ idx, name: it.name, pid: it.pid, qty, price: it.price, gstRate: it.gstRate, net, gst, total: net + gst });
    });
    if (!lines.length) throw new AppError('Select at least one item to return');
    const net = sum(lines, l => l.net), gst = sum(lines, l => l.gst), total = net + gst;
    if (total <= 0) throw new AppError('Return value is zero');

    const cust = sale.customer !== 'Walk-in' ? DB.get('customers').find(c => c.id === sale.customer) : null;
    let applied = [], advanceAdded = 0, refundAmount = 0;
    if (settlement === 'refund') {
      if (!['Cash', 'UPI', 'Card'].includes(refundMode)) throw new AppError('Choose a refund mode');
      refundAmount = total;
    } else {
      if (!cust) throw new AppError('Walk-in bills can only be refunded');
      if (settlement === 'advance') advanceAdded = total;
      else if (settlement === 'reduce_pending') {
        const bills = Book.openBills('customer', cust.id);
        const ordered = [...bills.filter(b => b.billId === sale.id), ...bills.filter(b => b.billId !== sale.id)];
        applied = Book.allocateFIFO(ordered, Math.min(total, Book.pending(cust.id))).allocs;
        advanceAdded = total - sum(applied, a => a.amount);          // anything beyond the pending amount becomes advance
      } else throw new AppError('Choose how to settle the credit note');
    }
    return atomic(['returns', 'products', 'ledger', 'customers'], () => {
      const date = new Date().toISOString();
      const r = { id: DB.id(), cnNo: nextCNNo(), date, createdAt: date, saleId, invoiceNo: sale.invoiceNo, customer: sale.customer, customerName: sale.customerName,
        items: lines, net, gst, total, settlement, refundMode: refundAmount ? refundMode : '', refundAmount,
        applied: applied.map(a => ({ billId: a.billId, ref: a.ref, amount: a.amount })), advanceAdded, note: note || '', status: 'active' };
      const rs = DB.get('returns'); rs.push(r); DB.set('returns', rs);
      const ps = DB.get('products');
      lines.forEach(l => { const p = findProduct(ps, l); if (p) p.stock += l.qty; });               // restock
      DB.set('products', ps);
      Post.returnNote(Ledger.store(), r); Ledger.persist();
      Book.sync();
      Audit.log('create', 'credit-note', r.id, `${r.cnNo} for ${sale.invoiceNo} · ${fmt(total)} · ${settlement}`);
      return r;
    });
  },

  /* ---------- customer money in ---------- */
  recordCustomerPayment({ customerId, amount, mode, date, note, advanceOnly }) {
    const cust = DB.get('customers').find(c => c.id === customerId);
    if (!cust) throw new AppError('Select a customer');
    if (!Number.isInteger(amount) || amount <= 0) throw new AppError('Enter an amount greater than 0');
    if (!PAY_MODES.includes(mode)) throw new AppError('Choose a payment mode');
    date = dkey(date || today());
    if (!date) throw new AppError('Invalid date');
    if (date > today()) throw new AppError('Payment date cannot be in the future');
    let allocations = [], adv = amount;
    if (!advanceOnly) { const r = Book.allocateFIFO(Book.openBills('customer', cust.id), amount); allocations = r.allocs; adv = r.rest; }
    return atomic(['payments', 'ledger', 'customers'], () => {
      const p = { id: DB.id(), receiptNo: nextReceiptNo(), customer: cust.id, customerName: cust.name, date, createdAt: new Date().toISOString(), amount, mode, note: note || '',
        kind: advanceOnly ? 'advance' : 'payment', allocations, advanceAdded: adv };
      const ps = DB.get('payments'); ps.push(p); DB.set('payments', ps);
      Post.payment(Ledger.store(), p); Ledger.persist();
      Book.sync();
      Audit.log('create', advanceOnly ? 'advance' : 'payment', p.id, `${p.receiptNo} ${cust.name} · ${fmt(amount)} ${mode}${adv ? ' · ' + fmt(adv) + ' to advance' : ''}`);
      return p;
    });
  },

  /* ---------- expenses ---------- */
  addExpense({ name, category, amount, date, mode }) {
    name = (name || '').trim();
    if (!name) throw new AppError('Description required');
    if (!Number.isInteger(amount) || amount <= 0) throw new AppError('Enter an amount greater than 0');
    date = dkey(date || today()); if (!date) throw new AppError('Invalid date');
    mode = mode || 'Cash';
    return atomic(['expenses', 'ledger'], () => {
      const e = { id: DB.id(), name, category: category || 'Other', amount, date, mode, status: 'active', createdAt: new Date().toISOString() };
      const es = DB.get('expenses'); es.push(e); DB.set('expenses', es);
      Post.expense(Ledger.store(), e); Ledger.persist();
      Audit.log('create', 'expense', e.id, `${name} · ${fmt(amount)} · ${e.category}`);
      return e;
    });
  },
  voidExpense(id, reason) {
    const es = DB.get('expenses'), e = es.find(x => x.id === id);
    if (!e) throw new AppError('Expense not found');
    if (e.status === 'void') throw new AppError('Already void');
    atomic(['expenses', 'ledger'], () => {
      const at = new Date().toISOString();
      e.status = 'void'; e.voidedAt = at; e.voidReason = reason || ''; DB.set('expenses', es);
      Post.expenseVoid(Ledger.store(), e, at); Ledger.persist();
      Audit.log('void', 'expense', id, `${e.name} · ${fmt(e.amount)} voided${reason ? ' — ' + reason : ''}`);
    });
  },

  /* ---------- customers ---------- */
  saveCustomer(o) {
    const name = (o.name || '').trim();
    if (!name) throw new AppError('Name required');
    const gstin = (o.gstin || '').trim().toUpperCase();
    if (gstin && !GSTIN_RE.test(gstin)) throw new AppError('GSTIN looks invalid (expected 15 characters, e.g. 27ABCDE1234F1Z5)');
    o.creditLimit = o.creditLimit || 0;
    if (!(o.creditLimit >= 0)) throw new AppError('Credit limit must be ≥ 0');
    const dueDays = Number.isFinite(+o.dueDays) && +o.dueDays >= 0 ? Math.round(+o.dueDays) : Settings.get('defaultDueDays');
    return atomic(['customers', 'ledger'], () => {
      const cs = DB.get('customers');
      if (o.id) {
        const c = cs.find(x => x.id === o.id); if (!c) throw new AppError('Customer not found');
        Object.assign(c, { name, phone: (o.phone || '').trim(), city: (o.city || '').trim(), gstin, creditLimit: o.creditLimit || 0, dueDays });
        DB.set('customers', cs); Audit.log('edit', 'customer', c.id, `${name} updated (limit ${fmt(c.creditLimit)}, due ${dueDays}d)`);
        return c;
      }
      const ob = Math.max(0, o.openingBalance || 0), now = new Date().toISOString();
      const c = { id: DB.id(), name, phone: (o.phone || '').trim(), city: (o.city || '').trim(), gstin, creditLimit: o.creditLimit || 0, dueDays,
        createdAt: now, openingDate: dkey(o.openingDate || now), openingBalance: ob, pendingAmount: 0, advanceBalance: 0, archived: false };
      cs.push(c); DB.set('customers', cs);
      if (ob > 0) { Post.opening(Ledger.store(), 'customer', c); Ledger.persist(); }
      Book.sync();
      Audit.log('create', 'customer', c.id, `${name}${ob ? ' · opening ' + fmt(ob) : ''}`);
      return c;
    });
  },
  /* customers/suppliers with history are archived, never deleted */
  removeParty(kind, id) {
    const key = kind === 'customer' ? 'customers' : 'suppliers';
    return atomic([key], () => {
      const list = DB.get(key), p = list.find(x => x.id === id); if (!p) throw new AppError('Not found');
      const used = Ledger.query({ party: id }).length || DB.get('sales').some(s => s.customer === id) ||
        DB.get('payments').some(x => x.customer === id) || DB.get('purchases').some(x => x.supplier === id) || DB.get('supplierPayments').some(x => x.supplier === id);
      if (used) {
        p.archived = !p.archived; DB.set(key, list);
        Audit.log('edit', kind, id, `${p.name} ${p.archived ? 'archived' : 'restored'} (has history — records kept)`);
        return p.archived ? 'archived' : 'restored';
      }
      DB.set(key, list.filter(x => x.id !== id));
      Audit.log('delete', kind, id, `${p.name} removed (no transactions)`);
      return 'deleted';
    });
  },

  /* ---------- suppliers ---------- */
  saveSupplier(o) {
    const name = (o.name || '').trim();
    if (!name) throw new AppError('Name required');
    const dueDays = Number.isFinite(+o.dueDays) && +o.dueDays >= 0 ? Math.round(+o.dueDays) : Settings.get('defaultDueDays');
    return atomic(['suppliers', 'ledger'], () => {
      const ss = DB.get('suppliers');
      if (o.id) {
        const s = ss.find(x => x.id === o.id); if (!s) throw new AppError('Supplier not found');
        Object.assign(s, { name, phone: (o.phone || '').trim(), city: (o.city || '').trim(), gstin: (o.gstin || '').trim().toUpperCase(), dueDays });
        DB.set('suppliers', ss); Audit.log('edit', 'supplier', s.id, `${name} updated`); return s;
      }
      const ob = Math.max(0, o.openingBalance || 0), now = new Date().toISOString();
      const s = { id: DB.id(), name, phone: (o.phone || '').trim(), city: (o.city || '').trim(), gstin: (o.gstin || '').trim().toUpperCase(), dueDays,
        createdAt: now, openingDate: dkey(o.openingDate || now), openingBalance: ob, pendingAmount: 0, archived: false };
      ss.push(s); DB.set('suppliers', ss);
      if (ob > 0) { Post.opening(Ledger.store(), 'supplier', s); Ledger.persist(); }
      Book.sync();
      Audit.log('create', 'supplier', s.id, `${name}${ob ? ' · opening payable ' + fmt(ob) : ''}`);
      return s;
    });
  },
  addPurchase({ supplierId, date, amount, gst, dueDays, billNo, note }) {
    const sup = DB.get('suppliers').find(s => s.id === supplierId);
    if (!sup) throw new AppError('Select a supplier');
    if (!Number.isInteger(amount) || amount <= 0) throw new AppError('Enter the bill amount');
    gst = gst || 0;
    if (gst < 0 || gst > amount) throw new AppError('GST amount cannot exceed the bill amount');
    date = dkey(date || today()); if (!date) throw new AppError('Invalid date');
    return atomic(['purchases', 'ledger', 'suppliers'], () => {
      const pu = { id: DB.id(), billNo: (billNo || '').trim() || nextPurchaseNo(), supplier: sup.id, supplierName: sup.name, date, createdAt: new Date().toISOString(),
        amount, gst, dueDays: Number.isFinite(+dueDays) ? Math.round(+dueDays) : (sup.dueDays ?? Settings.get('defaultDueDays')), note: note || '' };
      const ps = DB.get('purchases'); ps.push(pu); DB.set('purchases', ps);
      Post.purchase(Ledger.store(), pu); Ledger.persist(); Book.sync();
      Audit.log('create', 'purchase', pu.id, `${pu.billNo} ${sup.name} · ${fmt(amount)}`);
      return pu;
    });
  },
  paySupplier({ supplierId, amount, mode, date, note }) {
    const sup = DB.get('suppliers').find(s => s.id === supplierId);
    if (!sup) throw new AppError('Supplier not found');
    if (!Number.isInteger(amount) || amount <= 0) throw new AppError('Enter an amount greater than 0');
    if (!PAY_MODES.includes(mode)) throw new AppError('Choose a payment mode');
    const due = Book.payable(sup.id);
    if (amount > due) throw new AppError(`Amount exceeds the payable ${fmt(due)}`);
    date = dkey(date || today()); if (!date) throw new AppError('Invalid date');
    if (date > today()) throw new AppError('Payment date cannot be in the future');
    const { allocs } = Book.allocateFIFO(Book.openBills('supplier', sup.id), amount);
    return atomic(['supplierPayments', 'ledger', 'suppliers'], () => {
      const sp = { id: DB.id(), supplier: sup.id, supplierName: sup.name, date, createdAt: new Date().toISOString(), amount, mode, note: note || '',
        allocations: allocs.map(a => ({ billId: a.billId, ref: a.ref, amount: a.amount })) };
      const l = DB.get('supplierPayments'); l.push(sp); DB.set('supplierPayments', l);
      Post.supplierPayment(Ledger.store(), sp); Ledger.persist(); Book.sync();
      Audit.log('create', 'supplier-payment', sp.id, `${sup.name} · ${fmt(amount)} ${mode}`);
      return sp;
    });
  },

  /* ---------- GST input credit (total figure; a delta is posted) ---------- */
  setInputGST(totalPaise) {
    if (!(totalPaise >= 0)) throw new AppError('Enter a valid amount');
    const delta = totalPaise - Calc.inputGST();
    if (!delta) return;
    atomic(['gstAdjust', 'ledger'], () => {
      const g = { id: DB.id(), date: today(), createdAt: new Date().toISOString(), amount: delta, note: 'Manual input GST entry' };
      const l = DB.get('gstAdjust'); l.push(g); DB.set('gstAdjust', l);
      Post.gstAdjust(Ledger.store(), g); Ledger.persist();
      Audit.log('edit', 'input-gst', g.id, `Input GST credit set to ${fmt(totalPaise)} (${delta > 0 ? '+' : ''}${fmt(delta)})`);
    });
  },

  /* ---------- held bills ---------- */
  holdBill(h) {
    atomic(['held'], () => {
      const l = DB.get('held'); const rec = { id: DB.id(), date: new Date().toISOString(), ...h };
      l.push(rec); DB.set('held', l); Audit.log('create', 'held-bill', rec.id, `Bill held (${h.cart.length} item types)`);
    });
  },
  deleteHeld(id) {
    atomic(['held'], () => { DB.set('held', DB.get('held').filter(x => x.id !== id)); Audit.log('delete', 'held-bill', id, 'Held bill discarded'); });
  }
};


/* ===================================================================
   10. UI HELPERS — toast, modal, print, date-range filter, router, banners
   =================================================================== */
function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), type === 'error' ? 5000 : 3000);
}

function openModal(html, wide) {
  const m = document.getElementById('modal-body');
  m.innerHTML = html;
  m.classList.toggle('modal-wide', !!wide);
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

/* run a UI action; show any validation error as a toast */
function guard(fn) {
  try { return fn(); }
  catch (e) {
    if (e instanceof AppError) toast(e.message, 'error');
    else { console.error(e); toast('Unexpected error: ' + e.message, 'error'); }
  }
}

const PRINT_CSS = `body{font-family:'Segoe UI',Arial,sans-serif;padding:20px;color:#111;font-size:13px}
table{width:100%;border-collapse:collapse}th,td{padding:7px 10px;border:1px solid #ddd;text-align:left}th{background:#f3f5fa}
.mono,.num{font-family:monospace;text-align:right}h2{margin:0 0 4px}.sub{color:#666;margin-bottom:14px}
.btn,.no-print,.topbar-actions,.range-bar{display:none!important}.badge{padding:1px 8px;border-radius:10px;border:1px solid #bbb;font-size:11px}
.hl-green{color:#1a7a4a}.hl-red{color:#c0392b}.hl-yellow{color:#8a6a1f}.hl-blue{color:#203C74}.row-overdue td{background:#fdecea}.row-void td{color:#999;text-decoration:line-through}
.card{margin-bottom:14px}.card-title{font-weight:700;margin:10px 0 6px}.pl-row,.pl-total{display:flex;justify-content:space-between;padding:4px 0}.pl-total{font-weight:700;border-top:1px solid #999}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.stat-card{border:1px solid #ddd;padding:8px;border-radius:6px}
.stat-label{font-size:11px;color:#666}.stat-val{font-size:16px;font-weight:700}canvas,.chart-container{display:none}`;

function printHTML(title, body) {
  const w = window.open('', '_blank');
  if (!w) { toast('Pop-up blocked — allow pop-ups to print.', 'error'); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`);
  w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch { } }, 300);
}
function printSection(id, title) {
  const el = document.getElementById(id);
  if (!el) return;
  printHTML(title, `<h2>${esc(DB.get('businessName', 'My Business'))} — ${esc(title)}</h2>${el.innerHTML}`);
}
function downloadPDF(id, title) {
  const el = document.getElementById(id);
  if (!el) return;
  if (typeof html2pdf === 'undefined') { toast('PDF library not loaded (check internet). Use Print → Save as PDF.', 'error'); return; }
  html2pdf().set({ margin: 10, filename: title.replace(/\s+/g, '_') + '.pdf', html2canvas: { scale: 2 }, jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' } }).from(el).save();
}

/* ---- date-range filter (today / this month / FY / custom / all) ---- */
const RangeState = {};
function fyRange() {
  const t = new Date(), y = t.getMonth() >= 3 ? t.getFullYear() : t.getFullYear() - 1;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
}
function resolveRange(s) {
  const t = today(), d = new Date();
  switch (s.preset) {
    case 'today': return { from: t, to: t };
    case 'month': return { from: dkey(new Date(d.getFullYear(), d.getMonth(), 1)), to: dkey(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
    case 'fy': return fyRange();
    case 'custom': return { from: s.from || '', to: s.to || '' };
    default: return { from: '', to: '' };
  }
}
const getRange = page => resolveRange(RangeState[page] || (RangeState[page] = { preset: 'all' }));
const rangeLabel = r => (!r.from && !r.to) ? 'All time' : `${r.from ? fmtDate(r.from) : 'Beginning'} → ${r.to ? fmtDate(r.to) : 'Today'}`;
function rangeBar(page, extra = '') {
  const s = RangeState[page] || (RangeState[page] = { preset: 'all' }), r = resolveRange(s);
  const opt = (v, l) => `<option value="${v}" ${s.preset === v ? 'selected' : ''}>${l}</option>`;
  return `<div class="range-bar no-print">
    <span class="range-title">📅 Period</span>
    <select onchange="setRangePreset('${page}',this.value)">${opt('all', 'All time')}${opt('today', 'Today')}${opt('month', 'This month')}${opt('fy', 'Financial year')}${opt('custom', 'Custom…')}</select>
    <input type="date" id="rf-${page}" value="${r.from}" ${s.preset === 'custom' ? '' : 'disabled'} onchange="setRangeCustom('${page}')">
    <span>to</span>
    <input type="date" id="rt-${page}" value="${r.to}" ${s.preset === 'custom' ? '' : 'disabled'} onchange="setRangeCustom('${page}')">
    <span class="range-label">${esc(rangeLabel(r))}</span>${extra}
  </div>`;
}
window.setRangePreset = (page, p) => {
  const cur = resolveRange(RangeState[page] || { preset: 'all' });
  RangeState[page] = p === 'custom' ? { preset: 'custom', from: cur.from || today(), to: cur.to || today() } : { preset: p };
  navigate(currentPage, routeParam);
};
window.setRangeCustom = page => {
  const f = document.getElementById('rf-' + page).value, t = document.getElementById('rt-' + page).value;
  if (f && t && f > t) { toast('"From" date is after "To" date', 'error'); return; }
  RangeState[page] = { preset: 'custom', from: f, to: t };
  navigate(currentPage, routeParam);
};

/* ---- ROUTER ---- */
const pages = {};
let currentPage = 'dashboard', routeParam = null;
let activeCharts = [];
const PAGE_TITLES = {
  dashboard: 'Overview Dashboard', pos: 'POS / Billing', bills: 'Bill History', inventory: 'Inventory Management',
  sales: 'Sales Analytics', expenses: 'Expenses Management', pl: 'Profit & Loss',
  balance: 'Balance Sheet', gst: 'GST Dashboard', cashbook: 'Bank / Cash Book',
  customers: 'Customers', customer: 'Customer Dashboard', suppliers: 'Suppliers', aging: 'Aging & Overdue',
  reports: 'Reports', audit: 'Audit Log', settings: 'Settings', forecast: 'Demand Forecast',
  manual: 'User Manual & System Description', calculator: 'Business Calculator'
};
const NAV_PARENT = { customer: 'customers' };

function navigate(page, param) {
  currentPage = page;
  routeParam = param ?? null;
  const navPage = NAV_PARENT[page] || page;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === navPage));
  activeCharts.forEach(c => { try { c.destroy(); } catch { } });
  activeCharts = [];
  const tk = 'page.' + page, tt = t(tk);
  document.getElementById('page-title').textContent = tt !== tk ? tt : (PAGE_TITLES[page] || page);
  document.getElementById('topbar-actions').innerHTML = '';
  document.getElementById('content').innerHTML = '';
  document.getElementById('sidebar').classList.remove('open');
  renderBanners();
  try { if (pages[page]) pages[page](routeParam); }
  catch (e) {
    console.error(e);
    document.getElementById('content').innerHTML = `<div class="card"><div class="empty"><div class="empty-icon">⚠️</div><div class="empty-text">This page failed to load: ${esc(e.message)}</div></div></div>`;
  }
  const c = document.getElementById('content'); if (c) c.scrollTop = 0;
}

document.querySelectorAll('.nav-item[data-page]').forEach(n => {
  n.addEventListener('click', () => navigate(n.dataset.page));
});
window.toggleSidebar = () => document.getElementById('sidebar').classList.toggle('open');

/* ---- global banners: books out of balance (red) + stale backup (yellow) ---- */
let _hideBackupBanner = false;
function renderBanners() {
  const el = document.getElementById('banner-area');
  if (!el) return;
  let html = '';
  try {
    const r = Recon.run();
    if (!r.ok) html += `<div class="banner banner-red"><span>⚠️ <b>Books are out of balance</b> — ${r.failed.length} integrity check${r.failed.length > 1 ? 's' : ''} failed (${esc(r.failed.slice(0, 2).map(c => c.name.split(':')[0]).join(', '))}${r.failed.length > 2 ? '…' : ''}).</span><button class="btn btn-sm" onclick="navigate('balance')">View details</button></div>`;
    const w = Backup.warning();
    if (w && !_hideBackupBanner) html += `<div class="banner banner-yellow"><span>💾 ${w.never ? 'You have never downloaded a backup file' : 'Last backup file was ' + w.days + ' days ago'} — your data is saved online; a downloaded copy is your extra safety.</span>
      <span><button class="btn btn-sm" onclick="Backup.exportFile();navigate(currentPage,routeParam)">Download backup now</button>
      <button class="btn btn-sm" onclick="_hideBackupBanner=true;renderBanners()">✕</button></span></div>`;
  } catch (e) { console.error('banner', e); }
  el.innerHTML = html;
}

/* ===================================================================
   11. PAGES
   =================================================================== */
/* ---------- helpers shared by pages ---------- */
const statusBadge = s => s.status === 'void' ? '<span class="badge badge-gray">Void</span>' : '';
const customerOptions = (sel, includeWalkin = true) =>
  (includeWalkin ? `<option value="Walk-in">Walk-in</option>` : '') +
  DB.get('customers').filter(c => !c.archived || c.id === sel).map(c => `<option value="${esc(c.id)}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
const todayInput = () => `<input type="date" value="${today()}" max="${today()}">`;
const chartScales = (money = true) => ({
  x: { grid: { color: 'rgba(32,60,116,0.08)' }, ticks: { color: '#7a8fb5', font: { size: 10 } } },
  y: { grid: { color: 'rgba(32,60,116,0.08)' }, ticks: { color: '#7a8fb5', font: { size: 10 }, callback: v => money ? '₹' + v.toLocaleString('en-IN') : v } }
});

/* ===================================================================
   PAGE: DASHBOARD
   =================================================================== */
pages.dashboard = function () {
  const sales = Calc.totalSales(), exp = Calc.totalExpenses(), profit = Calc.profit();
  const orders = Calc.totalOrders(), gst = Calc.totalGSTCollected(), inv = Calc.inventoryValue();
  const overR = Calc.overdueReceivable(), overP = Calc.overduePayable();

  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = dkey(d);
    last7.push({ label: fmtShort(d), val: toR(Calc.netSales({ from: k, to: k })) });
  }
  const recentSales = Calc.allSales().slice(-5).reverse();
  const lowStock = DB.get('products').filter(p => p.stock < 20).slice(0, 5);
  const custCount = DB.get('customers').filter(c => !c.archived).length;

  document.getElementById('content').innerHTML = `
  <div class="stats-grid">
    <div class="stat-card green"><div class="stat-icon">💰</div><div class="stat-label">Net Sales (ex-GST)</div>
      <div class="stat-val" style="color:#1a7a4a">${fmt(sales)}</div><div class="stat-sub">${orders} orders · ${fmt(Calc.grossBilled())} billed incl. GST</div></div>
    <div class="stat-card red"><div class="stat-icon">💸</div><div class="stat-label">Total Expenses</div>
      <div class="stat-val" style="color:var(--red)">${fmt(exp)}</div><div class="stat-sub">${Calc.expenses().length} entries + purchases</div></div>
    <div class="stat-card ${profit >= 0 ? 'accent' : 'orange'}"><div class="stat-icon">📊</div><div class="stat-label">Net Profit</div>
      <div class="stat-val ${profit >= 0 ? 'hl-accent' : 'hl-red'}">${fmt(profit)}</div><div class="stat-sub">${profit >= 0 ? 'Profitable' : 'Loss making'} · net sales − expenses</div></div>
    <div class="stat-card blue"><div class="stat-icon">🧮</div><div class="stat-label">GST Collected (net)</div>
      <div class="stat-val" style="color:var(--royal-blue)">${fmt(gst)}</div><div class="stat-sub">Output GST after returns</div></div>
    <div class="stat-card purple"><div class="stat-icon">📦</div><div class="stat-label">Inventory Value</div>
      <div class="stat-val" style="color:var(--purple)">${fmt(inv)}</div><div class="stat-sub">${DB.get('products').length} products</div></div>
    <div class="stat-card pink"><div class="stat-icon">👥</div><div class="stat-label">Receivables</div>
      <div class="stat-val" style="color:var(--accent3)">${fmt(Calc.totalReceivable())}</div><div class="stat-sub">${custCount} customers</div></div>
    <div class="stat-card green"><div class="stat-icon">🏦</div><div class="stat-label">Cash &amp; Bank</div>
      <div class="stat-val ${Calc.cashBalance() >= 0 ? 'hl-green' : 'hl-red'}">${fmt(Calc.cashBalance())}</div><div class="stat-sub">Cash ${fmt(Calc.cashInHand())} · Bank ${fmt(Calc.bankBalance())}</div></div>
    <div class="stat-card orange"><div class="stat-icon">🏭</div><div class="stat-label">Supplier Payables</div>
      <div class="stat-val hl-yellow">${fmt(Calc.totalPayables())}</div><div class="stat-sub">Customer advances held: ${fmt(Calc.totalAdvances())}</div></div>
    <div class="stat-card ${overR > 0 ? 'red' : 'green'}" style="cursor:pointer" onclick="navigate('aging')"><div class="stat-icon">⏰</div><div class="stat-label">Total Overdue</div>
      <div class="stat-val ${overR > 0 ? 'hl-red' : 'hl-green'}">${fmt(overR)}</div><div class="stat-sub">Receivable overdue · payables overdue ${fmt(overP)}</div></div>
  </div>
  <div class="grid-2" style="margin-bottom:20px">
    <div class="card"><div class="card-title">📈 Net Sales — Last 7 Days</div><div class="chart-container"><canvas id="salesChart"></canvas></div></div>
    <div class="card"><div class="card-title">🥧 Revenue Breakdown</div><div class="chart-container"><canvas id="breakChart"></canvas></div></div>
  </div>
  <div class="grid-2">
    <div class="card"><div class="card-title">🧾 Recent Bills</div>
      ${recentSales.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th>Amount</th></tr></thead>
        <tbody>${recentSales.map(s => `<tr class="${s.status === 'void' ? 'row-void' : ''}">
          <td class="mono">${esc(s.invoiceNo)}</td><td>${fmtDate(s.date)}</td><td>${esc(s.customerName || 'Walk-in')}</td>
          <td class="mono hl-green">${fmt(s.finalTotal)} ${statusBadge(s)}</td></tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty"><div class="empty-icon">🧾</div><div class="empty-text">No bills yet</div></div>`}
    </div>
    <div class="card"><div class="card-title">⚠️ Low Stock Alert</div>
      ${lowStock.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Product</th><th>Stock</th><th>Value</th></tr></thead>
        <tbody>${lowStock.map(p => `<tr><td>${esc(p.name)}</td>
          <td><span class="badge ${p.stock <= 5 ? 'badge-red' : 'badge-yellow'}">${p.stock} units</span></td>
          <td class="mono">${fmt(mulQ(p.price, p.stock))}</td></tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty"><div class="empty-icon">✅</div><div class="empty-text">All stock healthy</div></div>`}
    </div>
  </div>`;

  activeCharts.push(new Chart(document.getElementById('salesChart').getContext('2d'), {
    type: 'bar',
    data: { labels: last7.map(d => d.label), datasets: [{ data: last7.map(d => d.val), backgroundColor: 'rgba(110,231,183,0.3)', borderColor: '#203C74', borderWidth: 1.5, borderRadius: 4 }] },
    options: { plugins: { legend: { display: false } }, scales: chartScales(), responsive: true, maintainAspectRatio: false }
  }));
  activeCharts.push(new Chart(document.getElementById('breakChart').getContext('2d'), {
    type: 'doughnut',
    data: { labels: ['Net Sales (ex-GST)', 'GST Collected', 'Expenses'],
      datasets: [{ data: [Math.max(0, toR(sales)), Math.max(0, toR(gst)), Math.max(0, toR(exp))], backgroundColor: ['rgba(110,231,183,0.7)', 'rgba(56,189,248,0.7)', 'rgba(248,113,113,0.7)'], borderWidth: 0 }] },
    options: { plugins: { legend: { labels: { color: '#3d5080', font: { size: 11 } } } }, responsive: true, maintainAspectRatio: false, cutout: '65%' }
  }));
};

/* ===================================================================
   PAGE: POS / BILLING
   split payments · advance · credit limit · hold/resume · per-item discount
   =================================================================== */
let cart = [];                      // {id,name,price(paise),gstRate,qty,stock,disc(paise)}
const newPosState = () => ({ customer: 'Walk-in', billDiscount: '', lines: [{ mode: 'Cash', amount: '' }], auto: true, tendered: '', applyAdvance: null, note: '' });
let posState = newPosState();

function posBill() {
  return computeBill(cart.map(c => ({ pid: c.id, name: c.name, qty: c.qty, price: c.price, gstRate: c.gstRate, discount: c.disc || 0 })), toP(posState.billDiscount));
}
const posCustomer = () => posState.customer !== 'Walk-in' ? DB.get('customers').find(c => c.id === posState.customer) : null;

pages.pos = function () {
  const held = DB.get('held').length;
  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-secondary" onclick="showHeld()">⏸ Held (${held})</button>
    <button class="btn btn-secondary" onclick="navigate('bills')">📜 Bill History</button>`;

  document.getElementById('content').innerHTML = `
  <div class="pos-layout">
    <div class="pos-left">
      <div class="form-row" style="margin-bottom:10px">
        <div class="form-group"><label>Search Product</label><input id="pos-search" placeholder="Type to filter…" oninput="renderProductGrid()"></div>
        <div class="form-group"><label>Customer</label>
          <select id="pos-customer" onchange="setPosCustomer(this.value)">${customerOptions(posState.customer)}</select></div>
      </div>
      <div id="pos-cust-info"></div>
      <div id="product-grid" class="product-grid"></div>
    </div>
    <div class="pos-right">
      <div class="pos-header">
        <div style="font-family:var(--font-head);font-weight:700;font-size:15px">🧾 Current Bill</div>
        <div id="pos-bill-no" style="font-family:var(--font-mono);font-size:11px;color:var(--text3);margin-top:2px">Next invoice: ${esc(peekInvoiceNo())}</div>
      </div>
      <div class="pos-items" id="pos-cart"></div>
      <div class="pos-summary">
        <div class="pos-summary-row"><span>Subtotal</span><span id="pos-subtotal" class="mono">₹0.00</span></div>
        <div class="pos-summary-row"><span>Item discounts</span><span id="pos-itemdisc" class="mono hl-red">₹0.00</span></div>
        <div class="pos-summary-row"><span>Bill discount (₹, before GST)</span>
          <input id="pos-discount" type="number" min="0" step="0.01" placeholder="0" value="${esc(posState.billDiscount)}" style="width:90px;text-align:right;padding:4px 8px;font-size:13px" oninput="posState.billDiscount=this.value;updateCartSummary()"></div>
        <div class="pos-summary-row"><span>GST</span><span id="pos-gst" class="mono hl-blue">₹0.00</span></div>
        <div class="pos-summary-total"><span>TOTAL</span><span id="pos-total">₹0.00</span></div>

        <div class="pos-pay">
          <div class="pos-pay-head"><b>Payment</b>
            <span><button class="btn btn-sm btn-secondary" onclick="addPayLine()">+ Split</button>
            <button class="btn btn-sm btn-secondary" onclick="addCreditBalance()" title="Put the remaining amount on credit">Balance → Credit</button></span></div>
          <div id="pay-lines"></div>
          <div id="pos-adv-row"></div>
          <div id="pos-cash-row" class="pay-cash" style="display:none">
            <label>Cash tendered ₹</label><input id="pos-tendered" type="number" min="0" step="0.01" value="${esc(posState.tendered)}" oninput="posState.tendered=this.value;updatePayStatus()">
            <span>Change: <b id="pos-change" class="mono">₹0.00</b></span></div>
          <div id="pay-status" class="pay-status"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-secondary" onclick="clearCart()" title="Clear bill">🗑</button>
          <button class="btn btn-secondary" onclick="holdBill()" title="Hold this bill and resume later">⏸ Hold</button>
          <button class="btn btn-primary" style="flex:1" onclick="completeSale()">✅ Charge &amp; Print</button>
        </div>
      </div>
    </div>
  </div>`;
  renderProductGrid(); renderPosCustInfo(); renderCart(); renderPayLines();
};

window.renderProductGrid = function () {
  const q = (document.getElementById('pos-search')?.value || '').toLowerCase();
  const products = DB.get('products').filter(p => p.name.toLowerCase().includes(q));
  const el = document.getElementById('product-grid');
  if (!el) return;
  el.innerHTML = products.map(p => `
    <div class="product-tile ${p.stock <= 0 ? 'out' : ''}" onclick="addToCart('${esc(p.id)}')">
      <div class="p-name">${esc(p.name)}</div><div class="p-price">${fmt(p.price)}</div>
      <div class="p-gst">GST: ${p.gstRate}%</div><div class="p-stock ${p.stock < 10 ? 'hl-red' : ''}">${p.stock} in stock</div>
    </div>`).join('') || '<div class="empty"><div class="empty-icon">🔍</div><div class="empty-text">No products found — add some in Inventory</div></div>';
};

window.renderPosCustInfo = function () {
  const el = document.getElementById('pos-cust-info'); if (!el) return;
  const c = posCustomer();
  if (!c) { el.innerHTML = ''; renderAdvRow(); return; }
  const pend = Book.pending(c.id), adv = Book.advance(c.id);
  el.innerHTML = `<div class="cust-strip">
    <span><b>${esc(c.name)}</b> ${c.phone ? '· ' + esc(c.phone) : ''}</span>
    <span>Pending <b class="${pend > 0 ? 'hl-yellow' : ''}">${fmt(pend)}</b></span>
    ${adv > 0 ? `<span>Advance <b class="hl-green">${fmt(adv)}</b></span>` : ''}
    <span>Limit <b>${c.creditLimit ? fmt(c.creditLimit) : 'none'}</b></span></div>`;
  renderAdvRow();
};
function renderAdvRow() {
  const el = document.getElementById('pos-adv-row'); if (!el) return;
  const c = posCustomer(), adv = c ? Book.advance(c.id) : 0;
  if (adv <= 0) { el.innerHTML = ''; return; }
  const on = posState.applyAdvance ?? Settings.get('autoApplyAdvance');
  el.innerHTML = `<label class="adv-toggle"><input type="checkbox" ${on ? 'checked' : ''} onchange="posState.applyAdvance=this.checked;updatePayStatus()">
    Auto-apply customer advance (${fmt(adv)} available) against the credit part</label>`;
}
window.setPosCustomer = function (v) {
  posState.customer = v; posState.applyAdvance = null;
  renderPosCustInfo(); updatePayStatus();
};

window.addToCart = function (id) {
  const p = DB.get('products').find(x => x.id === id);
  if (!p) return;
  if (p.stock <= 0) { toast('Out of stock!', 'error'); return; }
  const ex = cart.find(x => x.id === id);
  if (ex) {
    if (ex.qty >= p.stock) { toast('Max stock reached!', 'error'); return; }
    ex.qty++;
  } else cart.push({ id, name: p.name, price: p.price, gstRate: p.gstRate, qty: 1, stock: p.stock, disc: 0 });
  renderCart();
};
window.removeFromCart = function (id) { cart = cart.filter(x => x.id !== id); renderCart(); };
window.updateQty = function (id, delta) {
  const item = cart.find(x => x.id === id); if (!item) return;
  item.qty = Math.max(1, Math.min(item.stock, item.qty + delta));
  renderCart();
};
window.setItemDisc = function (id, v) {
  const item = cart.find(x => x.id === id); if (!item) return;
  item.disc = clamp(toP(v), 0, mulQ(item.price, item.qty));
  renderCart();
};

window.renderCart = function () {
  const el = document.getElementById('pos-cart');
  if (!el) return;
  if (!cart.length) { el.innerHTML = '<div class="empty"><div class="empty-icon">🛒</div><div class="empty-text">Add products to bill</div></div>'; updateCartSummary(); return; }
  const b = posBill();
  el.innerHTML = cart.map((item, i) => {
    const li = b.items[i];
    return `<div class="pos-item-row">
      <div class="pos-item-name"><div>${esc(item.name)}</div>
        <div style="font-size:11px;color:var(--text3)">${fmt(item.price)} × ${item.qty} · GST ${item.gstRate}% → ${fmt(li.itemGST)}</div>
        <div class="item-disc"><label>Disc ₹</label><input type="number" min="0" step="0.01" value="${item.disc ? rupeeStr(item.disc) : ''}" placeholder="0" onchange="setItemDisc('${esc(item.id)}',this.value)"></div></div>
      <button class="btn btn-sm btn-secondary" onclick="updateQty('${esc(item.id)}',-1)" style="padding:3px 8px">−</button>
      <span class="mono" style="min-width:24px;text-align:center">${item.qty}</span>
      <button class="btn btn-sm btn-secondary" onclick="updateQty('${esc(item.id)}',1)" style="padding:3px 8px">+</button>
      <span class="pos-item-price">${fmt(li.itemTotal + li.itemGST)}</span>
      <button onclick="removeFromCart('${esc(item.id)}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:16px">✕</button>
    </div>`;
  }).join('');
  updateCartSummary();
};

window.updateCartSummary = function () {
  const b = posBill();
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('pos-subtotal', fmt(b.grossTotal));
  set('pos-itemdisc', '−' + fmt(sum(b.items, i => i.itemDisc)));
  set('pos-gst', fmt(b.gst));
  set('pos-total', fmt(b.finalTotal));
  if (posState.auto && posState.lines.length === 1) {          // single line follows the total
    posState.lines[0].amount = b.finalTotal ? rupeeStr(b.finalTotal) : '';
    const inp = document.getElementById('pl-amt-0'); if (inp) inp.value = posState.lines[0].amount;
  }
  updatePayStatus();
};

/* ---- split payment lines ---- */
function renderPayLines() {
  const el = document.getElementById('pay-lines'); if (!el) return;
  el.innerHTML = posState.lines.map((l, i) => `<div class="pay-line">
    <select onchange="setPayMode(${i},this.value)">${['Cash', 'UPI', 'Card', 'Credit'].map(m => `<option ${l.mode === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
    <input id="pl-amt-${i}" type="number" min="0" step="0.01" placeholder="Amount ₹" value="${esc(l.amount)}" oninput="setPayAmt(${i},this.value)">
    <button class="btn btn-sm btn-secondary" title="Fill the remaining amount" onclick="fillPayLine(${i})">⇥</button>
    ${posState.lines.length > 1 ? `<button class="pay-x" onclick="removePayLine(${i})">✕</button>` : ''}
  </div>`).join('');
  updatePayStatus();
}
window.setPayMode = (i, v) => { posState.lines[i].mode = v; updatePayStatus(); };
window.setPayAmt = (i, v) => { posState.lines[i].amount = v; posState.auto = false; updatePayStatus(); };
window.addPayLine = () => {
  const rem = payRemaining();
  posState.lines.push({ mode: posState.lines.some(l => l.mode === 'UPI') ? 'Card' : 'UPI', amount: rem > 0 ? rupeeStr(rem) : '' });
  posState.auto = false; renderPayLines();
};
window.addCreditBalance = () => {
  const rem = payRemaining();
  if (rem <= 0) { toast('Nothing left to put on credit', 'error'); return; }
  posState.lines.push({ mode: 'Credit', amount: rupeeStr(rem) }); posState.auto = false; renderPayLines();
};
window.removePayLine = i => { posState.lines.splice(i, 1); if (posState.lines.length === 1) posState.auto = true; renderPayLines(); updateCartSummary(); };
window.fillPayLine = i => {
  const l = posState.lines[i], cur = toP(l.amount), rem = payRemaining();
  l.amount = rupeeStr(Math.max(0, cur + rem)); posState.auto = false; renderPayLines();
};
function payTotals() {
  const b = posBill();
  const paid = sum(posState.lines.filter(l => l.mode !== 'Credit'), l => toP(l.amount));
  const credit = sum(posState.lines.filter(l => l.mode === 'Credit'), l => toP(l.amount));
  return { total: b.finalTotal, paid, credit, rem: b.finalTotal - paid - credit,
    cash: sum(posState.lines.filter(l => l.mode === 'Cash'), l => toP(l.amount)) };
}
const payRemaining = () => payTotals().rem;
window.updatePayStatus = function () {
  const el = document.getElementById('pay-status'); if (!el) return;
  const t = payTotals(), c = posCustomer();
  const advAvail = c ? Book.advance(c.id) : 0;
  const applyAdv = posState.applyAdvance ?? Settings.get('autoApplyAdvance');
  const adv = c && t.credit > 0 && applyAdv ? Math.min(advAvail, t.credit) : 0;
  let msg = '';
  if (!cart.length) msg = '<span class="text3">Add items to start a bill</span>';
  else if (t.rem !== 0) msg = `<span class="hl-red">${t.rem > 0 ? 'Short by ' : 'Over by '}${fmt(Math.abs(t.rem))} — paid + credit must equal the total</span>`;
  else msg = '<span class="hl-green">✔ Payment matches bill total</span>';
  let extra = `<div>Paid <b>${fmt(t.paid)}</b> · Credit <b>${fmt(t.credit)}</b>`;
  if (adv) extra += ` · Advance applied <b class="hl-green">−${fmt(adv)}</b> → due <b>${fmt(t.credit - adv)}</b>`;
  else if (t.credit > 0 && c) extra += ` · becomes pending ${fmt(t.credit)}`;
  extra += '</div>';
  if (t.credit > 0 && !c) extra += '<div class="hl-red">Credit / part-payment needs a customer (not Walk-in)</div>';
  if (c && c.creditLimit > 0 && t.credit - adv > 0 && Book.pending(c.id) + t.credit - adv > c.creditLimit)
    extra += `<div class="hl-yellow">⚠ Exceeds credit limit ${fmt(c.creditLimit)} (pending would be ${fmt(Book.pending(c.id) + t.credit - adv)})</div>`;
  el.innerHTML = extra + `<div>${msg}</div>`;
  const cr = document.getElementById('pos-cash-row');
  if (cr) {
    cr.style.display = t.cash > 0 ? 'flex' : 'none';
    const tend = toP(posState.tendered);
    const ch = document.getElementById('pos-change');
    if (ch) { ch.textContent = fmt(tend > 0 ? Math.max(0, tend - t.cash) : 0); ch.className = 'mono ' + (tend > 0 && tend < t.cash ? 'hl-red' : 'hl-green'); }
  }
};

window.clearCart = function () {
  if (cart.length && !confirm('Clear the current bill?')) return;
  posState = newPosState(); cart = []; navigate('pos');
};

/* ---- hold / resume ---- */
window.holdBill = function () {
  if (!cart.length) { toast('Nothing to hold — cart is empty', 'error'); return; }
  guard(() => {
    Svc.holdBill({ cart: clone(cart), customer: posState.customer, billDiscount: posState.billDiscount, note: posState.note });
    posState = newPosState(); cart = [];
    toast('Bill held — resume it from “Held”'); navigate('pos');
  });
};
window.showHeld = function () {
  const held = DB.get('held').slice().reverse();
  openModal(`<div class="modal-title">⏸ Held Bills</div>
    ${held.length ? `<div class="table-wrap"><table><thead><tr><th>Held at</th><th>Customer</th><th>Items</th><th></th></tr></thead><tbody>
      ${held.map(h => `<tr><td>${new Date(h.date).toLocaleString('en-IN')}</td><td>${esc(Book.customerName(h.customer))}</td>
        <td>${h.cart.map(c => esc(c.name) + ' ×' + c.qty).join(', ')}</td>
        <td style="white-space:nowrap"><button class="btn btn-sm btn-primary" onclick="resumeHeld('${esc(h.id)}')">Resume</button>
        <button class="btn btn-sm btn-danger" onclick="discardHeld('${esc(h.id)}')">✕</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty"><div class="empty-icon">⏸</div><div class="empty-text">No held bills</div></div>'}
    <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Close</button></div>`, true);
};
window.resumeHeld = function (id) {
  const h = DB.get('held').find(x => x.id === id); if (!h) return;
  if (cart.length && !confirm('Replace the current bill with the held bill?')) return;
  guard(() => {
    const ps = DB.get('products');
    cart = h.cart.map(c => { const p = ps.find(x => x.id === c.id); return p ? { ...c, price: p.price, gstRate: p.gstRate, stock: p.stock, qty: Math.min(c.qty, p.stock) } : null; }).filter(c => c && c.qty > 0);
    posState = { ...newPosState(), customer: DB.get('customers').some(c => c.id === h.customer) ? h.customer : 'Walk-in', billDiscount: h.billDiscount || '' };
    Svc.deleteHeld(id); closeModal(); navigate('pos'); toast('Held bill resumed');
  });
};
window.discardHeld = function (id) { if (!confirm('Discard this held bill?')) return; guard(() => { Svc.deleteHeld(id); showHeld(); }); };

/* ---- charge ---- */
window.completeSale = function () {
  if (!cart.length) { toast('Cart is empty!', 'error'); return; }
  const c = posCustomer();
  const t = payTotals();
  let applyAdvance = posState.applyAdvance ?? Settings.get('autoApplyAdvance');
  if (c && t.credit > 0 && !applyAdvance && Book.advance(c.id) > 0)
    applyAdvance = confirm(`${c.name} has an advance of ${fmt(Book.advance(c.id))}.\n\nApply it to this bill's credit part?`);
  const base = {
    lines: cart.map(x => ({ pid: x.id, qty: x.qty, discount: x.disc || 0 })), customerId: posState.customer,
    payments: posState.lines.map(l => ({ mode: l.mode, amount: toP(l.amount) })), billDiscount: toP(posState.billDiscount),
    cashTendered: toP(posState.tendered), applyAdvance, note: posState.note
  };
  let sale;
  try { sale = Svc.createSale(base); }
  catch (e) {
    if (e.code === 'LIMIT_WARN' && confirm(e.message + '\n\nSave this bill anyway?')) {
      try { sale = Svc.createSale({ ...base, overrideLimit: true }); } catch (e2) { toast(e2.message, 'error'); return; }
    } else { if (e.code !== 'LIMIT_WARN') toast(e.message, 'error'); return; }
  }
  posState = newPosState(); cart = [];
  navigate('pos');
  showInvoice(sale);
  toast(`Sale ${sale.invoiceNo} completed!`);
};

/* ---------- invoice (modal + print) ---------- */
function invoiceHTML(sale) {
  const biz = esc(DB.get('businessName', 'My Business')), gstNo = esc(DB.get('gstNumber', '') || 'N/A');
  const addr = esc(DB.get('address', '')), ph = esc(DB.get('bizPhone', ''));
  const cust = sale.customer !== 'Walk-in' ? DB.get('customers').find(c => c.id === sale.customer) : null;
  const rets = DB.get('returns').filter(r => r.saleId === sale.id && r.status !== 'void');
  const th = 'text-align:right;padding:6px 4px;color:#7a8fb5';
  const td = 'padding:7px 4px;text-align:right;font-family:monospace';
  const row = (l, v, st = '') => `<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;${st}"><span>${l}</span><span>${v}</span></div>`;
  const pays = (sale.payments || []).map(p => row(`${esc(p.mode)}`, fmt(p.amount), 'color:#3d5080')).join('');
  const hasDisc = sale.items.some(i => i.discount > 0);
  return `<div id="invoice-content" style="position:relative">
    ${sale.status === 'void' ? '<div class="void-stamp">VOID</div>' : ''}
    <div style="text-align:center;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #D4DCF0">
      <div style="font-size:20px;font-weight:800;color:#203C74">${biz}</div>
      <div style="font-size:11px;color:#7a8fb5;font-family:monospace">GSTIN: ${gstNo}</div>
      ${addr || ph ? `<div style="font-size:11px;color:#7a8fb5">${addr} ${ph ? '· ' + ph : ''}</div>` : ''}
      <div style="font-size:12px;color:#3d5080;margin-top:4px;letter-spacing:1px">TAX INVOICE</div>
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:12px;color:#3d5080">
      <div>Invoice #: <b style="font-family:monospace">${esc(sale.invoiceNo)}</b></div><div>Date: ${fmtDate(sale.date)}</div></div>
    <div style="font-size:12px;color:#3d5080;margin-bottom:12px">Customer: <b>${esc(sale.customerName || 'Walk-in')}</b>${cust && cust.gstin ? ' · GSTIN ' + esc(cust.gstin) : ''}${cust && cust.phone ? ' · ' + esc(cust.phone) : ''}</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px">
      <thead><tr style="border-bottom:1px solid #D4DCF0"><th style="${th};text-align:left">Item</th><th style="${th}">Qty</th><th style="${th}">Rate</th>${hasDisc ? `<th style="${th}">Disc</th>` : ''}<th style="${th}">GST</th><th style="${th}">Amount</th></tr></thead>
      <tbody>${sale.items.map(i => `<tr style="border-bottom:1px solid rgba(32,60,116,0.08)">
        <td style="padding:7px 4px">${esc(i.name)}</td><td style="${td}">${i.qty}</td><td style="${td}">${fmt(i.price)}</td>
        ${hasDisc ? `<td style="${td}">${i.discount ? '−' + fmt(i.discount) : '—'}</td>` : ''}
        <td style="${td}">${i.gstRate}%</td><td style="${td}">${fmt(i.itemTotal + i.itemGST)}</td></tr>`).join('')}</tbody>
    </table>
    <div style="border-top:1px solid #D4DCF0;padding-top:8px">
      ${sale.legacy
        ? row('Subtotal', fmt(sale.total)) + row('GST', fmt(sale.gst), 'color:#BD954E') + (sale.discount ? row('Discount', '−' + fmt(sale.discount), 'color:#c0392b') : '')
        : row('Subtotal', fmt(sale.grossTotal)) + (sale.discount ? row('Discount', '−' + fmt(sale.discount), 'color:#c0392b') + row('Taxable value', fmt(sale.total)) : '') + row('GST', fmt(sale.gst), 'color:#BD954E')}
      <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:700;color:#203C74;margin-top:6px;padding-top:6px;border-top:1px solid #D4DCF0"><span>TOTAL</span><span>${fmt(sale.finalTotal)}</span></div>
      <div style="font-size:11px;color:#3d5080;margin-top:4px;font-style:italic">${esc(amountInWords(sale.finalTotal))}</div>
    </div>
    <div style="margin-top:12px;padding-top:8px;border-top:1px dashed #D4DCF0"><div style="font-size:11px;color:#7a8fb5;margin-bottom:4px">PAYMENT</div>${pays || '<div style="font-size:12px">—</div>'}
      ${sale.balanceDue ? row('<b>Balance due (pending)</b>', '<b>' + fmt(sale.balanceDue) + '</b>', 'color:#c0392b') : ''}
      ${sale.cashTendered ? row('Cash tendered', fmt(sale.cashTendered), 'color:#3d5080') + row('Change returned', fmt(sale.change), 'color:#3d5080') : ''}
    </div>
    ${rets.length ? `<div style="margin-top:10px;font-size:11px;color:#c0392b">↩ Credit notes: ${rets.map(r => esc(r.cnNo) + ' (' + fmt(r.total) + ')').join(', ')}</div>` : ''}
    ${sale.status === 'void' ? `<div style="margin-top:10px;font-size:11px;color:#c0392b">Voided ${fmtDate(sale.voidedAt)}${sale.voidReason ? ' — ' + esc(sale.voidReason) : ''}</div>` : ''}
    <div style="text-align:center;margin-top:14px;font-size:11px;color:#7a8fb5">Thank you for your business!</div>
  </div>`;
}
window.showInvoice = function (sale) {
  if (typeof sale === 'string') sale = DB.get('sales').find(s => s.id === sale);
  if (!sale) return;
  openModal(invoiceHTML(sale) + `
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">Close</button>
      <button class="btn btn-blue" onclick="printInvoice()">🖨 Print</button>
      <button class="btn btn-primary" onclick="downloadInvoicePDF('${esc(sale.invoiceNo)}')">⬇ PDF</button>
    </div>`);
};
window.printInvoice = function () {
  const el = document.getElementById('invoice-content'); if (!el) return;
  printHTML('Invoice', `<div style="max-width:420px;margin:auto">${el.outerHTML}</div>`);
};
window.downloadInvoicePDF = function (name) {
  const el = document.getElementById('invoice-content'); if (!el) return;
  if (typeof html2pdf === 'undefined') { toast('PDF library not loaded (check internet). Use Print → Save as PDF.', 'error'); return; }
  html2pdf().set({ margin: 10, filename: (name || 'invoice') + '.pdf', html2canvas: { scale: 2 }, jsPDF: { unit: 'mm', format: 'a4' } }).from(el).save();
};

/* ===================================================================
   PAGE: BILL HISTORY — search, view, return (credit note), void
   =================================================================== */
let billSearch = '', billFilter = 'all';
pages.bills = function () {
  const r = getRange('bills');
  const outMap = {};
  DB.get('customers').forEach(c => Book.openBills('customer', c.id).forEach(b => outMap[b.billId] = b));
  const rets = DB.get('returns').filter(x => x.status !== 'void');
  const q = billSearch.trim().toLowerCase();
  let list = DB.get('sales').filter(s => inRange(dkey(s.date), r)).slice().reverse();
  list = list.filter(s => {
    const hasRet = rets.some(x => x.saleId === s.id), out = outMap[s.id] ? outMap[s.id].outstanding : 0;
    if (billFilter === 'active' && s.status === 'void') return false;
    if (billFilter === 'void' && s.status !== 'void') return false;
    if (billFilter === 'returns' && !hasRet) return false;
    if (billFilter === 'due' && !(out > 0 && s.status !== 'void')) return false;
    if (!q) return true;
    return [s.invoiceNo, s.customerName, rupeeStr(s.finalTotal), (s.items || []).map(i => i.name).join(' '), s.payment, fmtDate(s.date)].join(' ').toLowerCase().includes(q) ||
      rets.some(x => x.saleId === s.id && x.cnNo.toLowerCase().includes(q));
  });
  const cns = rets.filter(x => inRange(dkey(x.date), r)).slice().reverse();

  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-secondary" onclick="exportBillsCSV()">⬇ CSV</button>
    <button class="btn btn-secondary" onclick="printSection('bills-print','Bill History')">🖨 Print</button>`;
  document.getElementById('content').innerHTML = `
  ${rangeBar('bills')}
  <div class="card no-print" style="margin-bottom:16px"><div class="form-row" style="margin-bottom:0">
    <div class="form-group" style="flex:3"><label>Search</label><input id="bill-search" value="${esc(billSearch)}" placeholder="Invoice no, customer, item, amount, CN no…" oninput="billSearch=this.value;clearTimeout(window._bs);window._bs=setTimeout(()=>{navigate('bills');const e=document.getElementById('bill-search');e.focus();e.setSelectionRange(e.value.length,e.value.length)},350)"></div>
    <div class="form-group"><label>Show</label><select onchange="billFilter=this.value;navigate('bills')">
      ${[['all', 'All bills'], ['active', 'Active'], ['void', 'Void'], ['returns', 'With returns'], ['due', 'Credit due']].map(([v, l]) => `<option value="${v}" ${billFilter === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
  </div></div>
  <div id="bills-print">
  <div class="card" style="margin-bottom:20px"><div class="card-title">🧾 Bills (${list.length})</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th>Items</th><th>Total</th><th>Paid</th><th>Due now</th><th>Status</th><th class="no-print">Actions</th></tr></thead>
      <tbody>${list.map(s => {
        const sr = rets.filter(x => x.saleId === s.id), out = outMap[s.id] ? outMap[s.id].outstanding : 0;
        const paid = sum((s.payments || []).filter(p => p.mode !== 'Credit'), p => p.amount);
        const retQty = sum(sr.flatMap(x => x.items), i => i.qty), allQty = sum(s.items, i => i.qty);
        return `<tr class="${s.status === 'void' ? 'row-void' : ''}">
          <td class="mono">${esc(s.invoiceNo)}</td><td>${fmtDate(s.date)}</td><td>${esc(s.customerName || 'Walk-in')}</td>
          <td>${s.items.length}</td><td class="mono">${fmt(s.finalTotal)}</td><td class="mono">${fmt(paid)}</td>
          <td class="mono ${out > 0 ? 'hl-yellow' : ''}">${out > 0 ? fmt(out) : '—'}</td>
          <td>${s.status === 'void' ? '<span class="badge badge-gray">Void</span>' : out > 0 ? '<span class="badge badge-yellow">Credit due</span>' : '<span class="badge badge-green">Paid</span>'}
            ${sr.length ? `<span class="badge badge-red" title="${esc(sr.map(x => x.cnNo).join(', '))}">↩ ${retQty >= allQty ? 'Fully' : 'Part'} returned</span>` : ''}</td>
          <td class="no-print" style="white-space:nowrap"><button class="btn btn-sm btn-secondary" onclick="showInvoice('${esc(s.id)}')">👁</button>
            ${s.status !== 'void' && retQty < allQty ? `<button class="btn btn-sm btn-secondary" onclick="showReturn('${esc(s.id)}')" title="Return items / credit note">↩</button>` : ''}
            ${s.status !== 'void' ? `<button class="btn btn-sm btn-danger" onclick="voidBill('${esc(s.id)}')" title="Void bill">⊘</button>` : ''}</td></tr>`;
      }).join('') || `<tr><td colspan="9"><div class="empty"><div class="empty-icon">🧾</div><div class="empty-text">${q || billFilter !== 'all' ? 'No bills match your search' : 'No bills in this period'}</div></div></td></tr>`}</tbody>
    </table></div></div>
  <div class="card"><div class="card-title">↩ Credit Notes / Sales Returns (${cns.length})</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Credit Note</th><th>Date</th><th>Against</th><th>Customer</th><th>Net</th><th>GST</th><th>Total</th><th>Settled by</th><th class="no-print"></th></tr></thead>
      <tbody>${cns.map(x => `<tr><td class="mono">${esc(x.cnNo)}</td><td>${fmtDate(x.date)}</td><td class="mono">${esc(x.invoiceNo)}</td><td>${esc(x.customerName || 'Walk-in')}</td>
        <td class="mono">${fmt(x.net)}</td><td class="mono">${fmt(x.gst)}</td><td class="mono hl-red">${fmt(x.total)}</td>
        <td>${x.refundAmount ? `Refund (${esc(x.refundMode)})` : ''}${sum(x.applied || [], a => a.amount) ? 'Reduced pending ' + fmt(sum(x.applied, a => a.amount)) : ''}${x.advanceAdded ? ' Advance +' + fmt(x.advanceAdded) : ''}</td>
        <td class="no-print"><button class="btn btn-sm btn-secondary" onclick="showCreditNote('${esc(x.id)}')">👁</button></td></tr>`).join('') ||
        '<tr><td colspan="9"><div class="empty"><div class="empty-icon">↩</div><div class="empty-text">No returns yet</div></div></td></tr>'}</tbody>
    </table></div></div></div>`;
};
window.exportBillsCSV = function () {
  const r = getRange('bills');
  const rows = [['Invoice', 'Date', 'Customer', 'Net (ex-GST)', 'GST', 'Total', 'Payment', 'Balance due at billing', 'Status']];
  DB.get('sales').filter(s => inRange(dkey(s.date), r)).forEach(s => rows.push([s.invoiceNo, dkey(s.date), s.customerName, rupeeStr(s.finalTotal - s.gst), rupeeStr(s.gst), rupeeStr(s.finalTotal), s.payment, rupeeStr(s.balanceDue || 0), s.status]));
  downloadCSV(`chitragupt-bills-${today()}.csv`, rows);
};

window.voidBill = function (id) {
  const s = DB.get('sales').find(x => x.id === id); if (!s) return;
  if (!confirm(`Void ${s.invoiceNo} (${fmt(s.finalTotal)})?\n\nStock is restored and all accounting effects are reversed. The bill stays on record marked VOID.`)) return;
  const reason = prompt('Reason for voiding (optional):', '');
  if (reason === null) return;
  guard(() => { Svc.voidSale(id, reason.trim()); toast(`${s.invoiceNo} voided`); navigate(currentPage, routeParam); });
};

/* ---- sales return -> credit note ---- */
window.showReturn = function (saleId) {
  const s = DB.get('sales').find(x => x.id === saleId); if (!s) return;
  const prior = DB.get('returns').filter(r => r.saleId === saleId && r.status !== 'void').flatMap(r => r.items);
  const cust = s.customer !== 'Walk-in' ? DB.get('customers').find(c => c.id === s.customer) : null;
  openModal(`<div class="modal-title">↩ Return items — ${esc(s.invoiceNo)}</div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:12px">${esc(s.customerName || 'Walk-in')} · ${fmtDate(s.date)} · Total ${fmt(s.finalTotal)}</div>
    <div class="table-wrap"><table><thead><tr><th>Item</th><th>Sold</th><th>Returned</th><th>Return qty</th></tr></thead><tbody>
      ${s.items.map((it, i) => { const rq = sum(prior.filter(x => x.idx === i), x => x.qty), rem = it.qty - rq;
        return `<tr><td>${esc(it.name)}</td><td>${it.qty}</td><td>${rq}</td>
          <td><input type="number" class="ret-qty" data-idx="${i}" min="0" max="${rem}" value="0" ${rem ? '' : 'disabled'} style="width:80px" oninput="previewReturn('${esc(saleId)}')"></td></tr>`; }).join('')}
    </tbody></table></div>
    <div id="ret-preview" class="ret-preview"></div>
    <div class="form-row" style="margin-top:14px"><div class="form-group"><label>Settle credit note by</label>
      <select id="ret-settle" onchange="previewReturn('${esc(saleId)}')">
        ${cust ? '<option value="reduce_pending">Reduce customer pending amount</option>' : ''}
        <option value="refund">Refund money</option>
        ${cust ? '<option value="advance">Add to customer advance balance</option>' : ''}</select></div>
      <div class="form-group" id="ret-mode-wrap"><label>Refund mode</label><select id="ret-mode"><option>Cash</option><option>UPI</option><option>Card</option></select></div></div>
    <div class="form-row"><div class="form-group"><label>Note (optional)</label><input id="ret-note" placeholder="e.g. damaged / wrong size"></div></div>
    <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitReturn('${esc(saleId)}')">Create Credit Note</button></div>`, true);
  previewReturn(saleId);
};
function readReturnItems() {
  return Array.from(document.querySelectorAll('.ret-qty')).map(e => ({ idx: +e.dataset.idx, qty: parseInt(e.value, 10) || 0 })).filter(x => x.qty > 0);
}
window.previewReturn = function (saleId) {
  const el = document.getElementById('ret-preview'); if (!el) return;
  const settle = document.getElementById('ret-settle').value;
  document.getElementById('ret-mode-wrap').style.display = settle === 'refund' ? '' : 'none';
  const items = readReturnItems();
  if (!items.length) { el.innerHTML = '<span class="text3">Enter a quantity for at least one item</span>'; return; }
  try {
    // dry-run the amounts exactly as Svc.createReturn will compute them
    const s = DB.get('sales').find(x => x.id === saleId), eff = effItems(s);
    const prior = DB.get('returns').filter(r => r.saleId === saleId && r.status !== 'void').flatMap(r => r.items);
    let net = 0, gst = 0;
    items.forEach(({ idx, qty }) => {
      const it = s.items[idx], pr = prior.filter(x => x.idx === idx);
      const rem = it.qty - sum(pr, x => x.qty), pn = sum(pr, x => x.net), pg = sum(pr, x => x.gst);
      if (qty > rem) throw new Error(`Only ${rem} of ${it.name} can be returned`);
      if (qty === rem) { net += eff[idx].eNet - pn; gst += eff[idx].eGST - pg; }
      else { net += Math.min(Math.round(eff[idx].eNet * qty / it.qty), eff[idx].eNet - pn); gst += Math.min(Math.round(eff[idx].eGST * qty / it.qty), eff[idx].eGST - pg); }
    });
    const total = net + gst;
    let how = '';
    if (settle === 'reduce_pending') {
      const pend = Book.pending(s.customer), applied = Math.min(total, pend);
      how = `<div>Reduces pending by <b>${fmt(applied)}</b> (customer owes ${fmt(pend)})${total > applied ? `; the excess <b>${fmt(total - applied)}</b> is added to their advance` : ''}.</div>`;
    } else if (settle === 'refund') how = `<div>Refund <b>${fmt(total)}</b> to the customer.</div>`;
    else how = `<div><b>${fmt(total)}</b> is added to the customer's advance balance.</div>`;
    el.innerHTML = `<div>Sales reduced by <b>${fmt(net)}</b> · GST reversed <b>${fmt(gst)}</b> · Credit note total <b class="hl-red">${fmt(total)}</b></div>${how}`;
  } catch (e) { el.innerHTML = `<span class="hl-red">${esc(e.message)}</span>`; }
};
window.submitReturn = function (saleId) {
  guard(() => {
    const r = Svc.createReturn({ saleId, items: readReturnItems(), settlement: document.getElementById('ret-settle').value,
      refundMode: document.getElementById('ret-mode').value, note: document.getElementById('ret-note').value.trim() });
    toast(`Credit note ${r.cnNo} created`);
    navigate(currentPage, routeParam); showCreditNote(r.id);
  });
};
window.showCreditNote = function (id) {
  const r = DB.get('returns').find(x => x.id === id); if (!r) return;
  const biz = esc(DB.get('businessName', 'My Business')), th = 'text-align:right;padding:6px 4px;color:#7a8fb5', td = 'padding:7px 4px;text-align:right;font-family:monospace';
  const row = (l, v, st = '') => `<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;${st}"><span>${l}</span><span>${v}</span></div>`;
  openModal(`<div id="cn-content">
    <div style="text-align:center;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #D4DCF0"><div style="font-size:20px;font-weight:800;color:#203C74">${biz}</div>
      <div style="font-size:12px;color:#c0392b;margin-top:4px;letter-spacing:1px">CREDIT NOTE</div></div>
    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px"><div>Credit note #: <b style="font-family:monospace">${esc(r.cnNo)}</b></div><div>Date: ${fmtDate(r.date)}</div></div>
    <div style="font-size:12px;margin-bottom:10px">Against invoice <b style="font-family:monospace">${esc(r.invoiceNo)}</b> · ${esc(r.customerName || 'Walk-in')}</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:10px"><thead><tr style="border-bottom:1px solid #D4DCF0"><th style="${th};text-align:left">Item</th><th style="${th}">Qty</th><th style="${th}">Net</th><th style="${th}">GST</th><th style="${th}">Total</th></tr></thead>
      <tbody>${r.items.map(i => `<tr><td style="padding:7px 4px">${esc(i.name)}</td><td style="${td}">${i.qty}</td><td style="${td}">${fmt(i.net)}</td><td style="${td}">${fmt(i.gst)}</td><td style="${td}">${fmt(i.total)}</td></tr>`).join('')}</tbody></table>
    <div style="border-top:1px solid #D4DCF0;padding-top:8px">${row('Net value', fmt(r.net))}${row('GST reversed', fmt(r.gst))}
      <div style="display:flex;justify-content:space-between;font-size:16px;font-weight:700;color:#c0392b;margin-top:6px;padding-top:6px;border-top:1px solid #D4DCF0"><span>CREDIT TOTAL</span><span>${fmt(r.total)}</span></div>
      <div style="font-size:11px;font-style:italic;color:#3d5080;margin-top:4px">${esc(amountInWords(r.total))}</div></div>
    <div style="margin-top:10px;font-size:12px;color:#3d5080">Settlement: ${r.refundAmount ? 'Refunded ' + fmt(r.refundAmount) + ' via ' + esc(r.refundMode) + '. ' : ''}${sum(r.applied || [], a => a.amount) ? 'Reduced pending by ' + fmt(sum(r.applied, a => a.amount)) + '. ' : ''}${r.advanceAdded ? 'Added ' + fmt(r.advanceAdded) + ' to advance. ' : ''}</div>
    ${r.note ? `<div style="margin-top:6px;font-size:11px;color:#7a8fb5">Note: ${esc(r.note)}</div>` : ''}</div>
    <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Close</button>
      <button class="btn btn-blue" onclick="printHTML('Credit Note',document.getElementById('cn-content').outerHTML)">🖨 Print</button></div>`);
};


/* ===================================================================
   PAGE: INVENTORY
   =================================================================== */
pages.inventory = function () {
  const products = DB.get('products');
  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-secondary" onclick="printSection('inv-table','Inventory')">🖨 Print</button>
    <button class="btn btn-primary" onclick="showAddProduct()">+ Add Product</button>`;
  document.getElementById('content').innerHTML = `
  <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)">
    <div class="stat-card blue"><div class="stat-label">Total Products</div><div class="stat-val hl-blue">${products.length}</div></div>
    <div class="stat-card green"><div class="stat-label">Inventory Value</div><div class="stat-val hl-green">${fmt(Calc.inventoryValue())}</div></div>
    <div class="stat-card orange"><div class="stat-label">Low Stock (&lt; 20)</div><div class="stat-val" style="color:var(--accent4)">${products.filter(p => p.stock < 20).length}</div></div>
    <div class="stat-card red"><div class="stat-label">Out of Stock</div><div class="stat-val hl-red">${products.filter(p => p.stock === 0).length}</div></div>
  </div>
  <div class="card"><div class="card-title">📦 Product Inventory</div>
    <div class="table-wrap" id="inv-table"><table>
      <thead><tr><th>#</th><th>Product Name</th><th>Price</th><th>GST Rate</th><th>Stock</th><th>Stock Value</th><th>Status</th><th class="no-print">Actions</th></tr></thead>
      <tbody>${products.map((p, i) => `<tr>
        <td class="mono" style="color:var(--text3)">${i + 1}</td><td><b>${esc(p.name)}</b></td><td class="mono">${fmt(p.price)}</td>
        <td><span class="gst-rate-tag">${p.gstRate}%</span></td>
        <td class="mono ${p.stock === 0 ? 'hl-red' : p.stock < 20 ? 'hl-yellow' : ''}">${p.stock}</td>
        <td class="mono">${fmt(mulQ(p.price, p.stock))}</td>
        <td><span class="badge ${p.stock === 0 ? 'badge-red' : p.stock < 20 ? 'badge-yellow' : 'badge-green'}">${p.stock === 0 ? 'Out of Stock' : p.stock < 20 ? 'Low Stock' : 'In Stock'}</span></td>
        <td class="no-print"><button class="btn btn-sm btn-secondary" onclick="stockAdjust('${esc(p.id)}')">± Adjust</button>
          <button class="btn btn-sm btn-secondary" onclick="editProduct('${esc(p.id)}')" style="margin-left:4px">✏</button>
          <button class="btn btn-sm btn-danger" onclick="deleteProduct('${esc(p.id)}')" style="margin-left:4px">🗑</button></td>
      </tr>`).join('') || `<tr><td colspan="8"><div class="empty"><div class="empty-icon">📦</div><div class="empty-text">No products added yet</div></div></td></tr>`}
      </tbody></table></div></div>`;
};
window.showAddProduct = function (existing = null) {
  openModal(`<div class="modal-title">${existing ? 'Edit' : 'Add'} Product</div>
    <div class="form-row"><div class="form-group"><label>Product Name</label><input id="p-name" value="${esc(existing?.name || '')}" placeholder="e.g. Product A"></div></div>
    <div class="form-row">
      <div class="form-group"><label>Price (₹, ex-GST)</label><input id="p-price" type="number" min="0" step="0.01" value="${existing ? rupeeStr(existing.price) : ''}" placeholder="0.00"></div>
      <div class="form-group"><label>GST Rate (%)</label><select id="p-gst">${[0, 5, 12, 18, 28].map(r => `<option value="${r}" ${existing?.gstRate == r ? 'selected' : ''}>${r}%</option>`).join('')}</select></div>
      <div class="form-group"><label>Stock (qty)</label><input id="p-stock" type="number" min="0" step="1" value="${existing?.stock ?? 0}"></div>
    </div>
    <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveProduct('${esc(existing?.id || '')}')">Save Product</button></div>`);
};
window.saveProduct = function (id) {
  guard(() => {
    Svc.saveProduct({ id, name: document.getElementById('p-name').value, price: toP(document.getElementById('p-price').value),
      gstRate: parseInt(document.getElementById('p-gst').value, 10) || 0, stock: parseInt(document.getElementById('p-stock').value, 10) || 0 });
    closeModal(); navigate('inventory'); toast(id ? 'Product updated!' : 'Product added!');
  });
};
window.editProduct = function (id) { const p = DB.get('products').find(x => x.id === id); if (p) showAddProduct(p); };
window.deleteProduct = function (id) {
  if (!confirm('Delete this product from the catalogue? Past bills keep their own copy.')) return;
  guard(() => { Svc.deleteProduct(id); navigate('inventory'); toast('Product deleted'); });
};
window.stockAdjust = function (id) {
  const p = DB.get('products').find(x => x.id === id); if (!p) return;
  openModal(`<div class="modal-title">Stock Adjustment — ${esc(p.name)}</div>
    <div style="margin-bottom:14px;color:var(--text2)">Current Stock: <b class="hl-accent">${p.stock}</b></div>
    <div class="form-row"><div class="form-group"><label>Type</label><select id="adj-type"><option>Add (Purchase)</option><option>Remove (Write-off)</option></select></div>
      <div class="form-group"><label>Quantity</label><input id="adj-qty" type="number" min="1" step="1" value="1"></div></div>
    <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="doStockAdj('${esc(id)}')">Apply</button></div>`);
};
window.doStockAdj = function (id) {
  const qty = parseInt(document.getElementById('adj-qty').value, 10) || 0;
  const add = document.getElementById('adj-type').value.includes('Add');
  if (qty < 1) { toast('Enter a quantity of 1 or more', 'error'); return; }
  guard(() => { Svc.adjustStock(id, add ? qty : -qty, add ? 'purchase / add' : 'write-off'); closeModal(); navigate('inventory'); toast(`Stock ${add ? 'added' : 'removed'}: ${qty} units`); });
};

/* ===================================================================
   PAGE: SALES ANALYTICS  (net of GST and returns, date-range aware)
   =================================================================== */
pages.sales = function () {
  const r = getRange('sales');
  const all = DB.get('sales').filter(s => inRange(dkey(s.date), r));
  const active = all.filter(s => s.status !== 'void');
  const rets = Calc.returns(r);
  const net = Calc.netSales(r), gst = Calc.totalGSTCollected(r), orders = active.length;
  const avg = orders ? Math.round(net / orders) : 0;

  const monthly = {};
  const slot = m => monthly[m] || (monthly[m] = { total: 0, gst: 0, count: 0 });
  active.forEach(s => { const m = dkey(s.date).slice(0, 7), o = slot(m); o.total += s.finalTotal - s.gst; o.gst += s.gst; o.count++; });
  rets.forEach(x => { const o = slot(dkey(x.date).slice(0, 7)); o.total -= x.net; o.gst -= x.gst; });
  const months = Object.keys(monthly).sort().slice(-12);

  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-secondary" onclick="printSection('sales-print','Sales Analytics')">🖨 Print</button>`;
  document.getElementById('content').innerHTML = rangeBar('sales') + `
  <div id="sales-print">
  <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)">
    <div class="stat-card green"><div class="stat-label">Net Sales (ex-GST)</div><div class="stat-val hl-green">${fmt(net)}</div><div class="stat-sub">after ${fmt(sum(rets, x => x.net))} returns</div></div>
    <div class="stat-card blue"><div class="stat-label">GST Collected (net)</div><div class="stat-val hl-blue">${fmt(gst)}</div></div>
    <div class="stat-card purple"><div class="stat-label">Total Orders</div><div class="stat-val" style="color:var(--purple)">${orders}</div><div class="stat-sub">${all.length - orders} void</div></div>
    <div class="stat-card accent"><div class="stat-label">Avg Order Value</div><div class="stat-val hl-accent">${fmt(avg)}</div><div class="stat-sub">ex-GST</div></div>
  </div>
  <div class="grid-2" style="margin-bottom:20px">
    <div class="card"><div class="card-title">📊 Monthly Net Sales</div><div class="chart-container"><canvas id="monthChart"></canvas></div></div>
    <div class="card"><div class="card-title">📋 Monthly Summary</div><div class="table-wrap"><table>
      <thead><tr><th>Month</th><th>Orders</th><th>Net Sales</th><th>GST</th></tr></thead>
      <tbody>${months.map(m => `<tr><td class="mono">${m}</td><td>${monthly[m].count}</td><td class="mono hl-green">${fmt(monthly[m].total)}</td><td class="mono hl-blue">${fmt(monthly[m].gst)}</td></tr>`).join('') ||
        '<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text3)">No data in this period</td></tr>'}</tbody></table></div></div>
  </div>
  <div class="card"><div class="card-title">🧾 All Bills</div><div class="table-wrap"><table>
    <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th>Items</th><th>Net</th><th>GST</th><th>Total</th><th>Payment</th></tr></thead>
    <tbody>${all.slice().reverse().map(s => `<tr class="${s.status === 'void' ? 'row-void' : ''}">
      <td class="mono">${esc(s.invoiceNo)}</td><td>${fmtDate(s.date)}</td><td>${esc(s.customerName || 'Walk-in')}</td><td>${s.items.length}</td>
      <td class="mono">${fmt(s.finalTotal - s.gst)}</td><td class="mono hl-blue">${fmt(s.gst)}</td><td class="mono hl-green">${fmt(s.finalTotal)}</td>
      <td><span class="badge badge-blue">${esc(s.payment || 'Cash')}</span> ${statusBadge(s)}</td></tr>`).join('') ||
      '<tr><td colspan="8"><div class="empty"><div class="empty-icon">📈</div><div class="empty-text">No sales in this period</div></div></td></tr>'}</tbody></table></div></div>
  </div>`;
  activeCharts.push(new Chart(document.getElementById('monthChart').getContext('2d'), {
    type: 'line',
    data: { labels: months.map(m => { const [y, mo] = m.split('-'); return new Date(y, mo - 1).toLocaleString('en-IN', { month: 'short', year: '2-digit' }); }),
      datasets: [{ label: 'Net sales', data: months.map(m => toR(monthly[m].total)), borderColor: '#203C74', backgroundColor: 'rgba(110,231,183,0.1)', tension: 0.4, fill: true },
        { label: 'GST', data: months.map(m => toR(monthly[m].gst)), borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.05)', tension: 0.4 }] },
    options: { plugins: { legend: { labels: { color: '#3d5080', font: { size: 11 } } } }, scales: chartScales(), responsive: true, maintainAspectRatio: false }
  }));
};

/* ===================================================================
   PAGE: EXPENSES  (void instead of delete)
   =================================================================== */
pages.expenses = function () {
  const r = getRange('expenses');
  const all = DB.get('expenses').filter(e => inRange(dkey(e.date), r));
  const exps = all.filter(e => e.status !== 'void');
  const total = Calc.totalExpenses(r);
  const cats = {};
  Ledger.query({ account: 'EXP', from: r.from, to: r.to }).forEach(e => { const k = e.category || 'Other'; cats[k] = (cats[k] || 0) + e.debit - e.credit; });
  Object.keys(cats).forEach(k => { if (cats[k] <= 0) delete cats[k]; });

  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-secondary" onclick="printSection('exp-print','Expenses')">🖨 Print</button>
    <button class="btn btn-primary" onclick="showAddExpense()">+ Add Expense</button>`;
  document.getElementById('content').innerHTML = rangeBar('expenses') + `
  <div id="exp-print">
  <div class="stats-grid" style="grid-template-columns:repeat(3,1fr)">
    <div class="stat-card red"><div class="stat-label">Total Expenses</div><div class="stat-val hl-red">${fmt(total)}</div><div class="stat-sub">incl. supplier purchase bills</div></div>
    <div class="stat-card orange"><div class="stat-label">No. of Entries</div><div class="stat-val" style="color:var(--accent4)">${exps.length}</div></div>
    <div class="stat-card purple"><div class="stat-label">Categories</div><div class="stat-val" style="color:var(--purple)">${Object.keys(cats).length}</div></div>
  </div>
  <div class="grid-2" style="margin-bottom:20px">
    <div class="card"><div class="card-title">📂 By Category</div>
      ${Object.entries(cats).map(([k, v]) => `<div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:13px"><span>${esc(k)}</span><span class="mono">${fmt(v)}</span></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${total ? Math.round(v / total * 100) : 0}%;background:var(--accent4)"></div></div></div>`).join('') ||
        '<div class="empty" style="padding:20px"><div class="empty-text">No expenses</div></div>'}</div>
    <div class="card"><div class="card-title">🥧 Category Split</div><div class="chart-container"><canvas id="expChart"></canvas></div></div>
  </div>
  <div class="card"><div class="card-title">💸 Expense Entries</div><div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Name</th><th>Category</th><th>Date</th><th>Paid via</th><th>Amount</th><th class="no-print">Actions</th></tr></thead>
    <tbody>${all.slice().reverse().map((e, i) => `<tr class="${e.status === 'void' ? 'row-void' : ''}">
      <td class="mono" style="color:var(--text3)">${all.length - i}</td><td data-tr="1">${esc(e.name)}</td><td><span class="badge badge-yellow">${esc(e.category || 'Other')}</span></td>
      <td>${fmtDate(e.date)}</td><td>${esc(e.mode || 'Cash')}</td><td class="mono hl-red">${fmt(e.amount)}</td>
      <td class="no-print">${e.status === 'void' ? '<span class="badge badge-gray">Void</span>' : `<button class="btn btn-sm btn-danger" onclick="voidExpense('${esc(e.id)}')" title="Void (keeps the record)">⊘ Void</button>`}</td></tr>`).join('') ||
      '<tr><td colspan="7"><div class="empty"><div class="empty-icon">💸</div><div class="empty-text">No expenses recorded</div></div></td></tr>'}</tbody></table></div></div>
  </div>`;
  if (Object.keys(cats).length) {
    activeCharts.push(new Chart(document.getElementById('expChart').getContext('2d'), {
      type: 'doughnut',
      data: { labels: Object.keys(cats), datasets: [{ data: Object.values(cats).map(toR), backgroundColor: ['rgba(248,113,113,0.7)', 'rgba(251,191,36,0.7)', 'rgba(167,139,250,0.7)', 'rgba(56,189,248,0.7)', 'rgba(110,231,183,0.7)', 'rgba(32,60,116,0.6)'], borderWidth: 0 }] },
      options: { plugins: { legend: { labels: { color: '#3d5080', font: { size: 11 } } } }, responsive: true, maintainAspectRatio: false, cutout: '60%' }
    }));
  }
};
window.showAddExpense = function () {
  openModal(`<div class="modal-title">Add Expense</div>
    <div class="form-row"><div class="form-group"><label>Description</label><input id="e-name" placeholder="e.g. Office Rent"></div></div>
    <div class="form-row">
      <div class="form-group"><label>Category</label><select id="e-cat">${['Rent', 'Utilities', 'Salaries', 'Marketing', 'Travel', 'Supplies', 'Other'].map(c => `<option>${c}</option>`).join('')}</select></div>
      <div class="form-group"><label>Amount (₹)</label><input id="e-amount" type="number" min="0" step="0.01" placeholder="0.00"></div></div>
    <div class="form-row">
      <div class="form-group"><label>Date</label><input id="e-date" type="date" value="${today()}"></div>
      <div class="form-group"><label>Paid via</label><select id="e-mode"><option>Cash</option><option>UPI</option><option>Card</option><option>Bank Transfer</option></select></div></div>
    <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveExpense()">Add Expense</button></div>`);
};
window.saveExpense = function () {
  guard(() => {
    Svc.addExpense({ name: document.getElementById('e-name').value, category: document.getElementById('e-cat').value,
      amount: toP(document.getElementById('e-amount').value), date: document.getElementById('e-date').value, mode: document.getElementById('e-mode').value });
    closeModal(); navigate('expenses'); toast('Expense added!');
  });
};
window.voidExpense = function (id) {
  const e = DB.get('expenses').find(x => x.id === id); if (!e) return;
  if (!confirm(`Void expense "${e.name}" (${fmt(e.amount)})?\nIt stays on record, marked void, and the cash is returned in the books.`)) return;
  const reason = prompt('Reason (optional):', ''); if (reason === null) return;
  guard(() => { Svc.voidExpense(id, reason.trim()); navigate('expenses'); toast('Expense voided'); });
};
window.deleteExpense = window.voidExpense;      // backwards-compatible name: financial records are voided, never deleted

/* ===================================================================
   PAGE: PROFIT & LOSS  (net sales everywhere)
   =================================================================== */
pages.pl = function () {
  const r = getRange('pl'), L = Ledger.store();
  const gross = L.balance('SALES', r), ret = L.balance('SALES_RET', r), netSales = gross - ret;
  const cats = {};
  L.query({ account: 'EXP', from: r.from, to: r.to }).forEach(e => { const k = e.category || 'Other'; cats[k] = (cats[k] || 0) + e.debit - e.credit; });
  Object.keys(cats).forEach(k => { if (!cats[k]) delete cats[k]; });
  const exp = Calc.totalExpenses(r), profit = netSales - exp, gst = Calc.totalGSTCollected(r);

  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-secondary" onclick="printSection('pl-print','Profit & Loss')">🖨 Print</button>`;
  document.getElementById('content').innerHTML = rangeBar('pl') + `
  <div id="pl-print">
  <div style="text-align:center;margin-bottom:20px"><div style="font-family:var(--font-head);font-size:20px;font-weight:800">${esc(DB.get('businessName', 'My Business'))}</div>
    <div style="color:var(--text3);font-size:12px;font-family:var(--font-mono)">Profit &amp; Loss Statement — ${esc(rangeLabel(r))}</div></div>
  <div class="grid-2"><div>
    <div class="card" style="margin-bottom:16px"><div class="card-title">💹 Income</div>
      <div class="pl-row"><span>Sales (ex-GST)</span><span class="mono hl-green">${fmt(gross)}</span></div>
      <div class="pl-row" style="color:var(--text3)"><span>Less: Sales returns (credit notes)</span><span class="mono">- ${fmt(ret)}</span></div>
      <div class="pl-total"><span>Net Sales</span><span class="hl-green">${fmt(netSales)}</span></div>
      <div style="font-size:11px;color:var(--text3);margin-top:6px">GST collected (${fmt(gst)}) is a liability, not income, and is excluded.</div></div>
    <div class="card"><div class="card-title">💸 Expenses</div>
      ${Object.entries(cats).map(([k, v]) => `<div class="pl-row"><span>${esc(k)}</span><span class="mono hl-red">- ${fmt(v)}</span></div>`).join('') || '<div class="empty-text" style="padding:10px;color:var(--text3)">No expenses in this period</div>'}
      <div class="pl-total"><span>Total Expenses</span><span class="hl-red">${fmt(exp)}</span></div></div>
  </div><div>
    <div class="card" style="margin-bottom:16px"><div class="card-title">⚖️ Summary</div>
      <div class="pl-row"><span>Net Sales</span><span class="mono hl-green">${fmt(netSales)}</span></div>
      <div class="pl-row"><span>Total Expenses</span><span class="mono hl-red">${fmt(exp)}</span></div>
      <div style="margin-top:16px;padding:20px;background:${profit >= 0 ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)'};border:1px solid ${profit >= 0 ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'};border-radius:var(--radius-lg);text-align:center">
        <div style="font-size:12px;color:var(--text3);margin-bottom:8px;font-family:var(--font-mono)">${profit >= 0 ? 'NET PROFIT' : 'NET LOSS'}</div>
        <div style="font-family:var(--font-head);font-size:36px;font-weight:800;color:${profit >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(Math.abs(profit))}</div>
        <div style="font-size:12px;color:var(--text3);margin-top:6px">Margin: ${netSales ? (profit / netSales * 100).toFixed(1) : 0}%</div></div></div>
    <div class="card"><div class="card-title">📊 Revenue vs Expenses</div><div class="chart-container"><canvas id="plChart"></canvas></div></div>
  </div></div></div>`;
  activeCharts.push(new Chart(document.getElementById('plChart').getContext('2d'), {
    type: 'bar',
    data: { labels: ['Net Sales', 'GST (memo)', 'Expenses', 'Profit'], datasets: [{ data: [toR(netSales), toR(gst), toR(exp), toR(Math.abs(profit))],
      backgroundColor: ['rgba(74,222,128,0.6)', 'rgba(56,189,248,0.6)', 'rgba(248,113,113,0.6)', profit >= 0 ? 'rgba(110,231,183,0.6)' : 'rgba(248,113,113,0.6)'], borderRadius: 6 }] },
    options: { plugins: { legend: { display: false } }, scales: chartScales(), responsive: true, maintainAspectRatio: false }
  }));
};

/* ===================================================================
   PAGE: BALANCE SHEET — rebuilt from the ledger + reconciliation
   =================================================================== */
pages.balance = function () {
  const cash = Calc.cashInHand(), bank = Calc.bankBalance(), inv = Calc.inventoryValue(), ar = Calc.totalReceivable(), gin = Calc.inputGST();
  const gout = Calc.totalGSTCollected(), ap = Calc.totalPayables(), adv = Calc.totalAdvances();
  const assets = cash + bank + inv + ar + gin, liab = gout + ap + adv, equity = assets - liab;
  const L = Ledger.store();
  const capital = L.balance('EQ_OPEN'), retained = Calc.profit();
  const stockAdj = equity - capital - retained;
  const rec = Recon.run();
  const row = (l, v, cls = '') => `<div class="pl-row"><span>${l}</span><span class="mono ${cls}">${fmt(v)}</span></div>`;

  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-secondary" onclick="printSection('bs-print','Balance Sheet')">🖨 Print</button>`;
  document.getElementById('content').innerHTML = `
  ${rec.ok ? `<div class="banner banner-green">✔ Books reconcile — ${rec.checks.length} checks passed.</div>` :
    `<div class="banner banner-red"><span>⚠️ <b>Out of balance:</b> ${rec.failed.length} of ${rec.checks.length} checks failed. See the reconciliation table below.</span>
      <button class="btn btn-sm" onclick="rebuildLedger()">Rebuild ledger from records</button></div>`}
  <div id="bs-print">
  <div style="text-align:center;margin-bottom:20px"><div style="font-family:var(--font-head);font-size:20px;font-weight:800">${esc(DB.get('businessName', 'My Business'))}</div>
    <div style="color:var(--text3);font-size:12px;font-family:var(--font-mono)">Balance Sheet — As on ${fmtDate(new Date())}</div></div>
  <div class="grid-2" style="margin-bottom:20px">
    <div class="bs-col"><div class="bs-head" style="color:var(--green)">ASSETS</div>
      ${row('Cash in Hand', cash, 'hl-green')}${row('Bank / UPI / Card', bank, 'hl-green')}${row('Inventory (at selling value)', inv)}
      ${row('Accounts Receivable (customers)', ar)}${row('Input GST Credit', gin)}
      <div class="pl-total" style="margin-top:10px"><span>TOTAL ASSETS</span><span class="hl-green">${fmt(assets)}</span></div></div>
    <div class="bs-col"><div class="bs-head" style="color:var(--red)">LIABILITIES</div>
      ${row('Output GST Payable', gout, 'hl-red')}${row('Supplier Payables', ap, 'hl-red')}${row('Customer Advances', adv, 'hl-red')}
      <div class="pl-total" style="margin-top:10px"><span>TOTAL LIABILITIES</span><span class="hl-red">${fmt(liab)}</span></div>
      <div class="bs-head" style="margin-top:18px;color:var(--royal-blue)">EQUITY (balancing figure)</div>
      ${row('Capital &amp; opening balances', capital)}${row('Retained earnings (net sales − expenses)', retained)}
      ${row('Stock valuation &amp; other adjustments', stockAdj)}
      <div class="pl-total" style="margin-top:10px"><span>TOTAL EQUITY</span><span>${fmt(equity)}</span></div></div>
  </div>
  <div style="background:${equity >= 0 ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)'};border:1px solid ${equity >= 0 ? 'rgba(74,222,128,0.2)' : 'rgba(248,113,113,0.2)'};border-radius:var(--radius-lg);padding:24px;text-align:center">
    <div style="font-size:12px;color:var(--text3);margin-bottom:8px;font-family:var(--font-mono)">NET WORTH (Assets − Liabilities)</div>
    <div style="font-family:var(--font-head);font-size:38px;font-weight:800;color:${equity >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt(equity)}</div>
    <div style="font-size:11px;color:var(--text3);margin-top:6px">Assets ${fmt(assets)} = Liabilities ${fmt(liab)} + Equity ${fmt(equity)}</div></div>
  <div style="font-size:11px;color:var(--text3);margin:10px 0 20px">Inventory is valued at selling price (no cost price is recorded), so the “stock valuation” line absorbs the difference between stock value and cumulative sales/expenses.</div>
  </div>
  <div class="card"><div class="card-title">🔍 Reconciliation checks</div><div class="table-wrap"><table>
    <thead><tr><th></th><th>Check</th><th>Ledger</th><th>Independent figure</th></tr></thead>
    <tbody>${rec.checks.map(c => `<tr class="${c.ok ? '' : 'row-overdue'}"><td>${c.ok ? '✅' : '❌'}</td><td>${esc(c.name)}${c.hint ? ' <small>(' + esc(c.hint) + ')</small>' : ''}</td>
      <td class="mono">${/stock|negative/.test(c.name) ? c.ledger : fmt(c.ledger)}</td><td class="mono">${/stock|negative/.test(c.name) ? c.other : fmt(c.other)}</td></tr>`).join('')}</tbody></table></div></div>`;
};

/* ===================================================================
   PAGE: GST DASHBOARD
   =================================================================== */
pages.gst = function () {
  const r = getRange('gst');
  const outputGST = Calc.totalGSTCollected(r), inputGST = Calc.inputGST(r), netGST = outputGST - inputGST;
  const slabs = {};
  const slot = k => slabs[k] || (slabs[k] = { taxable: 0, gst: 0, count: 0 });
  Calc.sales(r).forEach(s => {
    const eff = effItems(s);
    s.items.forEach((i, n) => { const o = slot(i.gstRate + '%'); o.taxable += eff[n].eNet; o.gst += eff[n].eGST; o.count++; });
  });
  Calc.returns(r).forEach(x => x.items.forEach(i => { const o = slot(i.gstRate + '%'); o.taxable -= i.net; o.gst -= i.gst; }));

  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-secondary" onclick="printSection('gst-print','GST Dashboard')">🖨 Print</button>`;
  document.getElementById('content').innerHTML = rangeBar('gst') + `
  <div id="gst-print">
  <div class="stats-grid" style="grid-template-columns:repeat(3,1fr)">
    <div class="stat-card green"><div class="stat-label">Output GST (net of returns)</div><div class="stat-val hl-green">${fmt(outputGST)}</div><div class="stat-sub">From sales</div></div>
    <div class="stat-card blue"><div class="stat-label">Input GST (credit)</div><div class="stat-val hl-blue">${fmt(inputGST)}</div><div class="stat-sub">Entered + supplier bills</div></div>
    <div class="stat-card ${netGST >= 0 ? 'orange' : 'green'}"><div class="stat-label">Net GST Payable</div><div class="stat-val ${netGST >= 0 ? 'hl-yellow' : 'hl-green'}">${fmt(Math.abs(netGST))}</div><div class="stat-sub">${netGST >= 0 ? 'To pay' : 'Refund due'}</div></div>
  </div>
  <div class="card no-print" style="margin-bottom:20px"><div class="card-title" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">Input GST Entry (all-time total)
      <div style="display:flex;gap:10px;align-items:center"><input id="input-gst-val" type="number" min="0" step="0.01" value="${rupeeStr(Calc.inputGST())}" style="width:140px"><button class="btn btn-primary btn-sm" onclick="saveInputGST()">Save</button></div></div>
    <div style="color:var(--text3);font-size:12px">Total GST paid on purchases (input tax credit). Saving posts only the difference to the ledger. GST on supplier bills is added automatically.</div></div>
  <div class="card" style="margin-bottom:20px"><div class="card-title">🧮 GST by Tax Slab (sales minus returns)</div><div class="table-wrap"><table>
    <thead><tr><th>GST Rate</th><th>Line items</th><th>Taxable Value</th><th>GST Amount</th></tr></thead>
    <tbody>${Object.entries(slabs).sort().map(([k, d]) => `<tr><td><span class="gst-rate-tag">${esc(k)}</span></td><td>${d.count}</td><td class="mono">${fmt(d.taxable)}</td><td class="mono hl-blue">${fmt(d.gst)}</td></tr>`).join('') ||
      '<tr><td colspan="4"><div class="empty"><div class="empty-icon">🧮</div><div class="empty-text">No GST data in this period</div></div></td></tr>'}</tbody></table></div></div>
  <div class="card"><div class="card-title">📝 GST Reconciliation</div>
    <div class="pl-row"><span>Output GST (collected, after returns)</span><span class="mono hl-green">${fmt(outputGST)}</span></div>
    <div class="pl-row"><span>Input GST (credit)</span><span class="mono hl-blue">${fmt(inputGST)}</span></div>
    <div class="pl-total"><span>${netGST >= 0 ? 'NET GST PAYABLE' : 'GST REFUND'}</span><span class="${netGST >= 0 ? 'hl-yellow' : 'hl-green'}">${fmt(Math.abs(netGST))}</span></div></div></div>`;
};
window.saveInputGST = function () {
  guard(() => { Svc.setInputGST(toP(document.getElementById('input-gst-val').value)); navigate('gst'); toast('Input GST saved!'); });
};

/* ===================================================================
   PAGE: CASH BOOK — every cash/bank movement comes from the ledger
   =================================================================== */
let cashTab = 'all';
pages.cashbook = function () {
  const r = getRange('cashbook'), L = Ledger.store();
  const accs = cashTab === 'cash' ? ['CASH'] : cashTab === 'bank' ? ['BANK'] : ['CASH', 'BANK'];
  const opening = sum(accs, a => (r.from ? L.balance(a, { before: r.from }) : 0));
  const rows = L.query({ accounts: accs, from: r.from, to: r.to }).sort((a, b) => a.d.localeCompare(b.d) || a.seq - b.seq);
  const inflow = sum(rows, x => x.debit), outflow = sum(rows, x => x.credit), closing = opening + inflow - outflow;
  let run = opening;
  const lines = rows.map(x => { run += x.debit - x.credit; return { ...x, run }; });

  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-secondary" onclick="exportCashCSV()">⬇ CSV</button>
    <button class="btn btn-secondary" onclick="printSection('cb-print','Cash Book')">🖨 Print</button>`;
  document.getElementById('content').innerHTML = rangeBar('cashbook') + `
  <div class="tabs no-print">${[['all', 'Cash + Bank'], ['cash', 'Cash only'], ['bank', 'Bank / UPI / Card']].map(([v, l]) => `<div class="tab ${cashTab === v ? 'active' : ''}" onclick="cashTab='${v}';navigate('cashbook')">${l}</div>`).join('')}</div>
  <div id="cb-print">
  <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)">
    <div class="stat-card blue"><div class="stat-label">Opening Balance</div><div class="stat-val hl-blue">${fmt(opening)}</div></div>
    <div class="stat-card green"><div class="stat-label">Total Inflow</div><div class="stat-val hl-green">${fmt(inflow)}</div><div class="stat-sub">actual receipts only</div></div>
    <div class="stat-card red"><div class="stat-label">Total Outflow</div><div class="stat-val hl-red">${fmt(outflow)}</div></div>
    <div class="stat-card ${closing >= 0 ? 'accent' : 'orange'}"><div class="stat-label">Closing Balance</div><div class="stat-val ${closing >= 0 ? 'hl-accent' : 'hl-red'}">${fmt(closing)}</div></div>
  </div>
  <div class="card"><div class="card-title">💰 Cash Book Ledger</div><div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Description</th><th>Mode</th><th>Inflow</th><th>Outflow</th><th>Balance</th></tr></thead>
    <tbody>${r.from ? `<tr style="background:var(--surface2)"><td colspan="5"><i>Opening balance</i></td><td class="mono">${fmt(opening)}</td></tr>` : ''}
    ${lines.map(t => `<tr><td>${fmtDate(t.date)}</td><td>${esc(t.memo)}</td><td><span class="badge badge-blue">${esc(t.mode || (t.account === 'CASH' ? 'Cash' : 'Bank'))}</span></td>
      <td class="mono ${t.debit ? 'hl-green' : ''}">${t.debit ? fmt(t.debit) : '—'}</td><td class="mono ${t.credit ? 'hl-red' : ''}">${t.credit ? fmt(t.credit) : '—'}</td><td class="mono">${fmt(t.run)}</td></tr>`).join('') ||
      '<tr><td colspan="6"><div class="empty"><div class="empty-icon">💰</div><div class="empty-text">No transactions in this period</div></div></td></tr>'}</tbody>
    <tfoot><tr style="background:var(--surface2)"><td colspan="3" style="padding:10px 14px;font-weight:700">CLOSING BALANCE</td>
      <td class="mono hl-green" style="padding:10px 14px">${fmt(inflow)}</td><td class="mono hl-red" style="padding:10px 14px">${fmt(outflow)}</td><td class="mono" style="padding:10px 14px"><b>${fmt(closing)}</b></td></tr></tfoot>
  </table></div></div></div>`;
};
window.exportCashCSV = function () {
  const r = getRange('cashbook'), L = Ledger.store();
  const accs = cashTab === 'cash' ? ['CASH'] : cashTab === 'bank' ? ['BANK'] : ['CASH', 'BANK'];
  let run = sum(accs, a => (r.from ? L.balance(a, { before: r.from }) : 0));
  const out = [['Date', 'Description', 'Mode', 'Inflow', 'Outflow', 'Balance']];
  L.query({ accounts: accs, from: r.from, to: r.to }).sort((a, b) => a.d.localeCompare(b.d) || a.seq - b.seq)
    .forEach(x => { run += x.debit - x.credit; out.push([x.d, x.memo, x.mode, rupeeStr(x.debit), rupeeStr(x.credit), rupeeStr(run)]); });
  downloadCSV(`chitragupt-cashbook-${today()}.csv`, out);
};


/* ===================================================================
   PAGE: CUSTOMERS (list)
   =================================================================== */
let custSearch = '', showArchived = false;
const waDigits = ph => { let d = String(ph || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d; };
window.sendWhatsApp = function (cid) {
  const c = DB.get('customers').find(x => x.id === cid); if (!c) return;
  const pend = Book.pending(cid);
  if (!waDigits(c.phone)) { toast('Add a phone number for this customer first', 'error'); return; }
  if (pend <= 0) { toast('Nothing pending for this customer', 'error'); return; }
  const biz = DB.get('businessName', 'our shop');
  const msg = `Hello ${c.name}, this is a reminder from ${biz}. Your pending amount is ${fmt(pend)}. Kindly pay at your earliest convenience. Thank you!`;
  window.open(`https://wa.me/${waDigits(c.phone)}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
};

pages.customers = function () {
  const all = DB.get('customers');
  const q = custSearch.trim().toLowerCase();
  const customers = all.filter(c => (showArchived || !c.archived) && (!q || [c.name, c.phone, c.city, c.gstin].join(' ').toLowerCase().includes(q)));
  const M = Book.maps();
  const overdueOf = c => sum(Book.openBills('customer', c.id, M).filter(b => b.overdueDays > 0), b => b.outstanding);
  const total = Calc.totalReceivable();

  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-secondary" onclick="printSection('cust-print','Customers')">🖨 Print</button>
    <button class="btn btn-secondary" onclick="showRecordPayment('',true)">➕ Receive Advance</button>
    <button class="btn btn-primary" onclick="showAddCustomer()">+ Add Customer</button>`;
  document.getElementById('content').innerHTML = `
  <div id="cust-print">
  <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)">
    <div class="stat-card blue"><div class="stat-label">Total Customers</div><div class="stat-val hl-blue">${all.filter(c => !c.archived).length}</div></div>
    <div class="stat-card orange"><div class="stat-label">Total Outstanding</div><div class="stat-val hl-yellow">${fmt(total)}</div></div>
    <div class="stat-card green"><div class="stat-label">Advances Held</div><div class="stat-val hl-green">${fmt(Calc.totalAdvances())}</div></div>
    <div class="stat-card red"><div class="stat-label">Overdue</div><div class="stat-val hl-red">${fmt(Calc.overdueReceivable())}</div></div>
  </div>
  <div class="card no-print" style="margin-bottom:16px"><div class="form-row" style="margin-bottom:0">
    <div class="form-group" style="flex:3"><label>Search</label><input id="cust-search" value="${esc(custSearch)}" placeholder="Name, phone, city, GSTIN…" oninput="custSearch=this.value;clearTimeout(window._cs);window._cs=setTimeout(()=>{navigate('customers');const e=document.getElementById('cust-search');e.focus();e.setSelectionRange(e.value.length,e.value.length)},300)"></div>
    <div class="form-group" style="flex:0 0 auto"><label>&nbsp;</label><label style="text-transform:none;font-size:12px"><input type="checkbox" style="width:auto" ${showArchived ? 'checked' : ''} onchange="showArchived=this.checked;navigate('customers')"> Show archived</label></div></div></div>
  <div class="card"><div class="card-title">👥 Customer List</div><div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Name</th><th>Phone</th><th>City</th><th>GSTIN</th><th>Pending</th><th>Advance</th><th>Limit</th><th>Status</th><th class="no-print">Actions</th></tr></thead>
    <tbody>${customers.map((c, i) => { const od = overdueOf(c); return `<tr class="${od > 0 ? 'row-overdue' : ''} ${c.archived ? 'row-archived' : ''}">
      <td class="mono" style="color:var(--text3)">${i + 1}</td>
      <td><a class="link" onclick="navigate('customer','${esc(c.id)}')"><b>${esc(c.name)}</b></a></td>
      <td class="mono">${esc(c.phone || '—')}</td><td>${esc(c.city || '—')}</td><td class="mono">${esc(c.gstin || '—')}</td>
      <td class="mono ${c.pendingAmount > 0 ? 'hl-yellow' : ''}">${fmt(c.pendingAmount)}</td>
      <td class="mono ${c.advanceBalance > 0 ? 'hl-green' : ''}">${c.advanceBalance ? fmt(c.advanceBalance) : '—'}</td>
      <td class="mono">${c.creditLimit ? fmt(c.creditLimit) : '—'}</td>
      <td>${c.archived ? '<span class="badge badge-gray">Archived</span>' : od > 0 ? '<span class="badge badge-red">Overdue</span>' : c.pendingAmount > 0 ? '<span class="badge badge-yellow">Pending</span>' : '<span class="badge badge-green">Cleared</span>'}</td>
      <td class="no-print" style="white-space:nowrap">
        ${!c.archived ? `<button class="btn btn-sm btn-primary" onclick="showRecordPayment('${esc(c.id)}')">💳 Record Payment</button>` : ''}
        ${c.pendingAmount > 0 && c.phone ? `<button class="btn btn-sm btn-secondary" title="WhatsApp reminder" onclick="sendWhatsApp('${esc(c.id)}')">💬</button>` : ''}
        <button class="btn btn-sm btn-secondary" onclick="showAddCustomer('${esc(c.id)}')">✏</button>
        <button class="btn btn-sm btn-danger" title="Delete (or archive if it has history)" onclick="deleteEntity('${esc(c.id)}','customers')">🗑</button></td></tr>`; }).join('') ||
      '<tr><td colspan="10"><div class="empty"><div class="empty-icon">👥</div><div class="empty-text">No customers found</div></div></td></tr>'}</tbody></table></div></div></div>`;
};

window.showAddCustomer = function (id) {
  const c = id ? DB.get('customers').find(x => x.id === id) : null;
  openModal(`<div class="modal-title">${c ? 'Edit' : 'Add'} Customer</div>
    <div class="form-row"><div class="form-group"><label>Name</label><input id="c-name" value="${esc(c?.name || '')}" placeholder="Customer name"></div></div>
    <div class="form-row"><div class="form-group"><label>Phone</label><input id="c-phone" value="${esc(c?.phone || '')}" placeholder="Mobile number"></div>
      <div class="form-group"><label>City</label><input id="c-city" value="${esc(c?.city || '')}" placeholder="City"></div></div>
    <div class="form-row"><div class="form-group"><label>GSTIN (optional)</label><input id="c-gstin" value="${esc(c?.gstin || '')}" placeholder="27ABCDE1234F1Z5" style="text-transform:uppercase"></div>
      <div class="form-group"><label>Credit limit (₹, 0 = none)</label><input id="c-limit" type="number" min="0" step="0.01" value="${c ? rupeeStr(c.creditLimit || 0) : '0'}"></div>
      <div class="form-group"><label>Due days</label><input id="c-due" type="number" min="0" step="1" value="${c ? c.dueDays : Settings.get('defaultDueDays')}"></div></div>
    ${c ? `<div style="font-size:12px;color:var(--text3)">Opening balance: ${fmt(c.openingBalance || 0)} (fixed — adjust through bills and payments)</div>` :
      `<div class="form-row"><div class="form-group"><label>Opening Balance owed (₹)</label><input id="c-pending" type="number" min="0" step="0.01" value="0"></div>
        <div class="form-group"><label>Opening balance as on</label><input id="c-opdate" type="date" value="${today()}" max="${today()}"></div></div>`}
    <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveCustomer('${esc(id || '')}')">${c ? 'Save' : 'Add Customer'}</button></div>`);
};
window.saveCustomer = function (id) {
  guard(() => {
    Svc.saveCustomer({ id, name: document.getElementById('c-name').value, phone: document.getElementById('c-phone').value, city: document.getElementById('c-city').value,
      gstin: document.getElementById('c-gstin').value, creditLimit: toP(document.getElementById('c-limit').value), dueDays: document.getElementById('c-due').value,
      openingBalance: id ? 0 : toP(document.getElementById('c-pending').value), openingDate: id ? '' : document.getElementById('c-opdate').value });
    closeModal(); navigate(currentPage, routeParam); toast(id ? 'Customer updated!' : 'Customer added!');
  });
};

/* ---- generic delete used by the customer / supplier lists: never hard-deletes history ---- */
window.deleteEntity = function (id, key) {
  const kind = key === 'customers' ? 'customer' : 'supplier';
  if (!confirm('Remove this ' + kind + '?\n\nIf it has any transactions it will be archived (hidden, records kept) instead of deleted.')) return;
  guard(() => { const r = Svc.removeParty(kind, id); navigate(key === 'customers' ? 'customers' : 'suppliers'); toast(r === 'deleted' ? 'Deleted' : r === 'archived' ? 'Archived — records kept' : 'Restored'); });
};

/* ===================================================================
   RECORD PAYMENT / ADVANCE  (FIFO to oldest bills, excess → advance)
   =================================================================== */
window.recordPayment = function (id, type) {
  if (type === 'supplier') showPaySupplier(id); else showRecordPayment(id);
};
window.showRecordPayment = function (cid, advanceOnly) {
  const c = cid ? DB.get('customers').find(x => x.id === cid) : null;
  openModal(`<div class="modal-title">${advanceOnly ? '➕ Receive Advance' : '💳 Record Payment'}${c ? ' — ' + esc(c.name) : ''}</div>
    <div class="form-row"><div class="form-group"><label>Customer</label>
      <select id="pay-cust" onchange="previewPayment()" ${c ? 'disabled' : ''}><option value="">— select —</option>${customerOptions(cid, false)}</select></div></div>
    <div id="pay-info" style="margin-bottom:10px;font-size:13px;color:var(--text2)"></div>
    <div class="form-row">
      <div class="form-group"><label>Amount (₹)</label><input id="pay-amount" type="number" min="0" step="0.01" oninput="previewPayment()"></div>
      <div class="form-group"><label>Mode</label><select id="pay-mode">${PAY_MODES.map(m => `<option>${m}</option>`).join('')}</select></div>
      <div class="form-group"><label>Date</label><input id="pay-date" type="date" value="${today()}" max="${today()}"></div></div>
    <div class="form-row"><div class="form-group"><label>Note</label><input id="pay-note" placeholder="e.g. cheque no / reference"></div></div>
    <div id="pay-preview" class="ret-preview"></div>
    <input type="hidden" id="pay-adv" value="${advanceOnly ? 1 : 0}">
    <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="applyPayment('${esc(cid || '')}','customers')">${advanceOnly ? 'Save Advance' : 'Record Payment'}</button></div>`);
  if (cid) document.getElementById('pay-cust').value = cid;
  previewPayment();
};
window.previewPayment = function () {
  const cid = document.getElementById('pay-cust').value, info = document.getElementById('pay-info'), pv = document.getElementById('pay-preview');
  if (!cid) { info.innerHTML = ''; pv.innerHTML = '<span class="text3">Select a customer</span>'; return; }
  const bills = Book.openBills('customer', cid), pend = Book.pending(cid), adv = Book.advance(cid);
  info.innerHTML = `Pending <b class="hl-yellow">${fmt(pend)}</b> across ${bills.length} bill(s) · Advance <b class="hl-green">${fmt(adv)}</b>`;
  const amt = toP(document.getElementById('pay-amount').value);
  if (amt <= 0) { pv.innerHTML = '<span class="text3">Enter an amount to see how it is allocated</span>'; return; }
  if (document.getElementById('pay-adv').value === '1') { pv.innerHTML = `Whole amount <b>${fmt(amt)}</b> is kept as customer advance.`; return; }
  const { allocs, rest } = Book.allocateFIFO(bills, amt);
  pv.innerHTML = (allocs.length ? 'Oldest bills first:<br>' + allocs.map(a => `• ${esc(a.ref)} — <b>${fmt(a.amount)}</b>`).join('<br>') : '') +
    (rest > 0 ? `<br>Excess <b class="hl-green">${fmt(rest)}</b> is added to the customer's advance.` : '');
};
window.applyPayment = function (id, key) {
  if (key === 'suppliers') return submitSupplierPayment(id);
  guard(() => {
    const cid = document.getElementById('pay-cust').value || id;
    const p = Svc.recordCustomerPayment({ customerId: cid, amount: toP(document.getElementById('pay-amount').value), mode: document.getElementById('pay-mode').value,
      date: document.getElementById('pay-date').value, note: document.getElementById('pay-note').value.trim(), advanceOnly: document.getElementById('pay-adv').value === '1' });
    closeModal(); navigate(currentPage, routeParam); toast(`${p.kind === 'advance' ? 'Advance' : 'Payment'} ${p.receiptNo} recorded`);
  });
};

/* ===================================================================
   PAGE: CUSTOMER DASHBOARD  (page 'customer', param = customer id)
   =================================================================== */
pages.customer = function (cid) {
  const c = DB.get('customers').find(x => x.id === cid);
  if (!c) { document.getElementById('content').innerHTML = '<div class="card"><div class="empty"><div class="empty-icon">👤</div><div class="empty-text">Customer not found</div></div></div>'; return; }
  const S = Book.customerSummary(cid), rows = Book.statementRows(cid);
  const limitPct = c.creditLimit ? Math.min(100, Math.round(S.pending / c.creditLimit * 100)) : 0;
  const advRows = Ledger.query({ account: 'ADV', party: cid }).sort((a, b) => a.seq - b.seq);
  let advRun = 0;
  const advHist = advRows.map(e => { advRun += e.credit - e.debit; return { ...e, run: advRun }; });
  document.getElementById('page-title').textContent = c.name;
  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-secondary" onclick="navigate('customers')">← Customers</button>
    <button class="btn btn-secondary" onclick="showStatement('${esc(cid)}')">📄 Statement</button>
    <button class="btn btn-primary" onclick="showRecordPayment('${esc(cid)}')">💳 Record Payment</button>`;
  document.getElementById('content').innerHTML = `
  <div class="card cust-head"><div>
      <div style="font-family:var(--font-head);font-size:20px;font-weight:800;color:var(--royal-blue)">${esc(c.name)} ${c.archived ? '<span class="badge badge-gray">Archived</span>' : ''}</div>
      <div style="font-size:12px;color:var(--text2);margin-top:4px">${esc(c.phone || 'no phone')} · ${esc(c.city || 'no city')} · GSTIN ${esc(c.gstin || '—')} · Due in ${c.dueDays} days</div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm btn-secondary" onclick="showRecordPayment('${esc(cid)}',true)">➕ Receive Advance</button>
      <button class="btn btn-sm btn-secondary" onclick="sendWhatsApp('${esc(cid)}')">💬 WhatsApp reminder</button>
      <button class="btn btn-sm btn-secondary" onclick="showAddCustomer('${esc(cid)}')">✏ Edit</button></div></div>
  <div class="stats-grid" style="margin-top:16px">
    <div class="stat-card blue"><div class="stat-label">Total Billed</div><div class="stat-val hl-blue">${fmt(S.billed)}</div><div class="stat-sub">Returns −${fmt(S.returns)}</div></div>
    <div class="stat-card green"><div class="stat-label">Total Paid</div><div class="stat-val hl-green">${fmt(S.received)}</div><div class="stat-sub">Last payment: ${S.lastPayment ? fmtDate(S.lastPayment) : '—'}</div></div>
    <div class="stat-card orange"><div class="stat-label">Pending</div><div class="stat-val hl-yellow">${fmt(S.pending)}</div><div class="stat-sub">${S.bills.length} open bill(s)</div></div>
    <div class="stat-card green"><div class="stat-label">Advance Balance</div><div class="stat-val hl-green">${fmt(S.advance)}</div><div class="stat-sub">auto-adjusts on credit bills</div></div>
    <div class="stat-card purple"><div class="stat-label">Credit Limit</div><div class="stat-val" style="color:var(--purple)">${c.creditLimit ? fmt(c.creditLimit) : 'None'}</div>
      <div class="stat-sub">${c.creditLimit ? `<div class="progress-bar"><div class="progress-fill" style="width:${limitPct}%;background:${limitPct >= 100 ? 'var(--red)' : 'var(--accent4)'}"></div></div>${limitPct}% used` : 'no limit set'}</div></div>
    <div class="stat-card ${S.overdue > 0 ? 'red' : 'green'}"><div class="stat-label">Overdue Status</div>
      <div class="stat-val ${S.overdue > 0 ? 'hl-red' : 'hl-green'}">${S.overdue > 0 ? fmt(S.overdue) : 'On time'}</div><div class="stat-sub">${S.overdue > 0 ? S.maxOverdueDays + ' days overdue (oldest)' : 'nothing past due'}</div></div>
  </div>
  <div class="grid-2" style="margin-bottom:20px">
    <div class="card"><div class="card-title">📊 Billed vs Received (last 6 months)</div><div class="chart-container"><canvas id="custChart"></canvas></div></div>
    <div class="card"><div class="card-title">⏳ Open Bills</div><div class="table-wrap"><table>
      <thead><tr><th>Bill</th><th>Date</th><th>Due</th><th>Outstanding</th><th>Status</th></tr></thead>
      <tbody>${S.bills.map(b => `<tr class="${b.overdueDays > 0 ? 'row-overdue' : ''}"><td class="mono">${esc(b.ref)}</td><td>${fmtDate(b.date)}</td><td>${fmtDate(b.dueDate)}</td>
        <td class="mono hl-yellow">${fmt(b.outstanding)}</td><td>${b.overdueDays > 0 ? `<span class="badge badge-red">${b.overdueDays}d overdue</span>` : `<span class="badge badge-green">${-b.overdueDays}d left</span>`}</td></tr>`).join('') ||
        '<tr><td colspan="5"><div class="empty"><div class="empty-icon">✅</div><div class="empty-text">No pending bills</div></div></td></tr>'}</tbody></table></div></div>
  </div>
  <div class="card" style="margin-bottom:20px"><div class="card-title">📒 Ledger (bills, payments, returns, advances)</div><div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Debit (owed ↑)</th><th>Credit (owed ↓)</th><th>Balance</th></tr></thead>
    <tbody>${rows.slice().reverse().map(r => `<tr><td>${fmtDate(r.d)}</td><td><span class="badge ${r.type === 'Bill' || r.type === 'Opening' || r.type === 'Refund paid' ? 'badge-yellow' : 'badge-green'}">${esc(r.type)}</span></td><td>${esc(r.ref)}</td>
      <td class="mono">${r.debit ? fmt(r.debit) : ''}</td><td class="mono">${r.credit ? fmt(r.credit) : ''}</td><td class="mono ${r.balance > 0 ? 'hl-yellow' : r.balance < 0 ? 'hl-green' : ''}">${fmt(Math.abs(r.balance))} ${r.balance > 0 ? 'Dr' : r.balance < 0 ? 'Cr' : ''}</td></tr>`).join('') ||
      '<tr><td colspan="6"><div class="empty"><div class="empty-icon">📒</div><div class="empty-text">No transactions yet</div></div></td></tr>'}</tbody></table></div>
    <div style="font-size:11px;color:var(--text3);margin-top:6px">Dr = customer owes you · Cr = you owe the customer (advance)</div></div>
  <div class="card"><div class="card-title">💼 Advance history (received &amp; adjusted)</div><div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Event</th><th>Received / added</th><th>Adjusted / used</th><th>Advance balance</th></tr></thead>
    <tbody>${advHist.slice().reverse().map(e => `<tr><td>${fmtDate(e.date)}</td><td>${esc(e.memo)}</td><td class="mono hl-green">${e.credit ? fmt(e.credit) : ''}</td><td class="mono hl-red">${e.debit ? fmt(e.debit) : ''}</td><td class="mono">${fmt(e.run)}</td></tr>`).join('') ||
      '<tr><td colspan="5"><div class="empty"><div class="empty-icon">💼</div><div class="empty-text">No advances recorded</div></div></td></tr>'}</tbody></table></div></div>`;

  /* chart: monthly billed vs received */
  const months = []; const d0 = new Date(); d0.setDate(1);
  for (let i = 5; i >= 0; i--) { const d = new Date(d0.getFullYear(), d0.getMonth() - i, 1); months.push(dkey(d).slice(0, 7)); }
  const billed = months.map(() => 0), recd = months.map(() => 0);
  rows.forEach(r => { const k = months.indexOf(r.d.slice(0, 7)); if (k < 0) return;
    if (r.type === 'Bill') billed[k] += r.debit; else if (['Payment', 'Advance'].includes(r.type)) recd[k] += r.credit; });
  activeCharts.push(new Chart(document.getElementById('custChart').getContext('2d'), {
    type: 'bar', data: { labels: months.map(m => { const [y, mo] = m.split('-'); return new Date(y, mo - 1).toLocaleString('en-IN', { month: 'short' }); }),
      datasets: [{ label: 'Billed', data: billed.map(toR), backgroundColor: 'rgba(32,60,116,0.6)', borderRadius: 4 }, { label: 'Received', data: recd.map(toR), backgroundColor: 'rgba(26,122,74,0.6)', borderRadius: 4 }] },
    options: { plugins: { legend: { labels: { color: '#3d5080', font: { size: 11 } } } }, scales: chartScales(), responsive: true, maintainAspectRatio: false }
  }));
};

/* ---- customer statement (date range, opening / closing balance, print / PDF) ---- */
function statementHTML(cid, from, to) {
  const c = DB.get('customers').find(x => x.id === cid);
  const all = Book.statementRows(cid);
  const before = all.filter(r => from && r.d < from);
  const opening = before.length ? before[before.length - 1].balance : 0;
  const inR = all.filter(r => (!from || r.d >= from) && (!to || r.d <= to));
  const dr = sum(inR, r => r.debit), cr = sum(inR, r => r.credit), closing = opening + dr - cr;
  const bal = v => `${fmt(Math.abs(v))} ${v > 0 ? 'Dr' : v < 0 ? 'Cr' : ''}`;
  return `<div id="stmt-content" style="font-size:12px;color:#1a2540">
    <div style="text-align:center;margin-bottom:12px"><div style="font-size:18px;font-weight:800;color:#203C74">${esc(DB.get('businessName', 'My Business'))}</div>
      <div style="color:#7a8fb5">GSTIN ${esc(DB.get('gstNumber', '') || 'N/A')} ${esc(DB.get('address', ''))}</div>
      <div style="font-weight:700;margin-top:6px;letter-spacing:1px">STATEMENT OF ACCOUNT</div></div>
    <div style="display:flex;justify-content:space-between;margin-bottom:10px"><div><b>${esc(c.name)}</b><br>${esc(c.phone || '')} ${esc(c.city || '')}<br>${c.gstin ? 'GSTIN ' + esc(c.gstin) : ''}</div>
      <div style="text-align:right">Period: ${from ? fmtDate(from) : 'Beginning'} → ${to ? fmtDate(to) : fmtDate(today())}<br>Generated ${fmtDate(today())}</div></div>
    <table style="width:100%;border-collapse:collapse"><thead><tr style="background:#f3f5fa"><th style="text-align:left;padding:6px;border:1px solid #ddd">Date</th><th style="text-align:left;padding:6px;border:1px solid #ddd">Particulars</th>
      <th style="padding:6px;border:1px solid #ddd;text-align:right">Debit</th><th style="padding:6px;border:1px solid #ddd;text-align:right">Credit</th><th style="padding:6px;border:1px solid #ddd;text-align:right">Balance</th></tr></thead>
      <tbody><tr><td style="padding:5px;border:1px solid #ddd" colspan="4"><i>Opening balance</i></td><td style="padding:5px;border:1px solid #ddd;text-align:right;font-family:monospace">${bal(opening)}</td></tr>
      ${inR.map(r => `<tr><td style="padding:5px;border:1px solid #ddd">${fmtDate(r.d)}</td><td style="padding:5px;border:1px solid #ddd">${esc(r.type)} — ${esc(r.ref)}</td>
        <td style="padding:5px;border:1px solid #ddd;text-align:right;font-family:monospace">${r.debit ? fmt(r.debit) : ''}</td><td style="padding:5px;border:1px solid #ddd;text-align:right;font-family:monospace">${r.credit ? fmt(r.credit) : ''}</td>
        <td style="padding:5px;border:1px solid #ddd;text-align:right;font-family:monospace">${bal(r.balance)}</td></tr>`).join('')}
      <tr style="font-weight:700;background:#f3f5fa"><td colspan="2" style="padding:6px;border:1px solid #ddd">Closing balance</td><td style="padding:6px;border:1px solid #ddd;text-align:right;font-family:monospace">${fmt(dr)}</td>
        <td style="padding:6px;border:1px solid #ddd;text-align:right;font-family:monospace">${fmt(cr)}</td><td style="padding:6px;border:1px solid #ddd;text-align:right;font-family:monospace">${bal(closing)}</td></tr></tbody></table>
    <div style="margin-top:8px;color:#7a8fb5">Dr = amount payable by customer · Cr = advance / credit in customer's favour</div></div>`;
}
window.showStatement = function (cid, from, to) {
  const c = DB.get('customers').find(x => x.id === cid); if (!c) return;
  if (from === undefined) { from = fyRange().from; to = today(); }
  openModal(`<div class="modal-title">📄 Statement — ${esc(c.name)}</div>
    <div class="form-row no-print"><div class="form-group"><label>From</label><input type="date" id="st-from" value="${from}"></div>
      <div class="form-group"><label>To</label><input type="date" id="st-to" value="${to}"></div>
      <div class="form-group" style="flex:0 0 auto"><button class="btn btn-secondary" onclick="refreshStatement('${esc(cid)}')">Update</button></div></div>
    ${statementHTML(cid, from, to)}
    <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Close</button>
      <button class="btn btn-blue" onclick="printHTML('Statement',document.getElementById('stmt-content').outerHTML)">🖨 Print</button>
      <button class="btn btn-primary" onclick="downloadPDF('stmt-content','Statement-${esc(c.name.replace(/[^\w]+/g, '_'))}')">⬇ PDF</button></div>`, true);
};
window.refreshStatement = function (cid) {
  const f = document.getElementById('st-from').value, t = document.getElementById('st-to').value;
  if (f && t && f > t) { toast('From date is after To date', 'error'); return; }
  showStatement(cid, f, t);
};

/* ===================================================================
   PAGE: SUPPLIERS  (bills, payments, payables)
   =================================================================== */
pages.suppliers = function () {
  const all = DB.get('suppliers'), suppliers = all.filter(s => showArchived || !s.archived), M = Book.maps();
  const overdueOf = s => sum(Book.openBills('supplier', s.id, M).filter(b => b.overdueDays > 0), b => b.outstanding);
  document.getElementById('topbar-actions').innerHTML = `
    <button class="btn btn-secondary" onclick="printSection('sup-print','Suppliers')">🖨 Print</button>
    <button class="btn btn-secondary" onclick="showAddPurchase()">🧾 Add Purchase Bill</button>
    <button class="btn btn-primary" onclick="showAddSupplier()">+ Add Supplier</button>`;
  document.getElementById('content').innerHTML = `
  <div id="sup-print">
  <div class="stats-grid" style="grid-template-columns:repeat(4,1fr)">
    <div class="stat-card purple"><div class="stat-label">Total Suppliers</div><div class="stat-val" style="color:var(--purple)">${all.filter(s => !s.archived).length}</div></div>
    <div class="stat-card red"><div class="stat-label">Total Payables</div><div class="stat-val hl-red">${fmt(Calc.totalPayables())}</div></div>
    <div class="stat-card orange"><div class="stat-label">Overdue Payables</div><div class="stat-val hl-yellow">${fmt(Calc.overduePayable())}</div></div>
    <div class="stat-card green"><div class="stat-label">Cleared</div><div class="stat-val hl-green">${all.filter(s => !s.pendingAmount).length}</div></div>
  </div>
  <div class="card"><div class="card-title">🏭 Supplier List</div><div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Name</th><th>Phone</th><th>City</th><th>Due days</th><th>Payable</th><th>Status</th><th class="no-print">Actions</th></tr></thead>
    <tbody>${suppliers.map((s, i) => { const od = overdueOf(s); return `<tr class="${od > 0 ? 'row-overdue' : ''} ${s.archived ? 'row-archived' : ''}">
      <td class="mono" style="color:var(--text3)">${i + 1}</td><td><b>${esc(s.name)}</b></td><td class="mono">${esc(s.phone || '—')}</td><td>${esc(s.city || '—')}</td><td>${s.dueDays ?? '—'}</td>
      <td class="mono ${s.pendingAmount > 0 ? 'hl-red' : ''}">${fmt(s.pendingAmount)}</td>
      <td>${s.archived ? '<span class="badge badge-gray">Archived</span>' : od > 0 ? '<span class="badge badge-red">Overdue</span>' : s.pendingAmount > 0 ? '<span class="badge badge-yellow">Payable</span>' : '<span class="badge badge-green">Cleared</span>'}</td>
      <td class="no-print" style="white-space:nowrap">${s.pendingAmount > 0 ? `<button class="btn btn-sm btn-primary" onclick="recordPayment('${esc(s.id)}','supplier')">💳 Pay</button>` : ''}
        <button class="btn btn-sm btn-secondary" onclick="showAddPurchase('${esc(s.id)}')" title="Add purchase bill">🧾</button>
        <button class="btn btn-sm btn-secondary" onclick="showAddSupplier('${esc(s.id)}')">✏</button>
        <button class="btn btn-sm btn-danger" onclick="deleteEntity('${esc(s.id)}','suppliers')">🗑</button></td></tr>`; }).join('') ||
      '<tr><td colspan="8"><div class="empty"><div class="empty-icon">🏭</div><div class="empty-text">No suppliers added</div></div></td></tr>'}</tbody></table></div></div></div>`;
};
window.showAddSupplier = function (id) {
  const s = id ? DB.get('suppliers').find(x => x.id === id) : null;
  openModal(`<div class="modal-title">${s ? 'Edit' : 'Add'} Supplier</div>
    <div class="form-row"><div class="form-group"><label>Name</label><input id="s-name" value="${esc(s?.name || '')}" placeholder="Supplier name"></div></div>
    <div class="form-row"><div class="form-group"><label>Phone</label><input id="s-phone" value="${esc(s?.phone || '')}"></div><div class="form-group"><label>City</label><input id="s-city" value="${esc(s?.city || '')}"></div></div>
    <div class="form-row"><div class="form-group"><label>GSTIN</label><input id="s-gstin" value="${esc(s?.gstin || '')}"></div>
      <div class="form-group"><label>Payment due days</label><input id="s-due" type="number" min="0" value="${s ? s.dueDays : Settings.get('defaultDueDays')}"></div></div>
    ${s ? '' : `<div class="form-row"><div class="form-group"><label>Opening Payable (₹)</label><input id="s-pending" type="number" min="0" step="0.01" value="0"></div>
      <div class="form-group"><label>As on</label><input id="s-opdate" type="date" value="${today()}" max="${today()}"></div></div>`}
    <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="saveSupplier('${esc(id || '')}')">${s ? 'Save' : 'Add Supplier'}</button></div>`);
};
window.saveSupplier = function (id) {
  guard(() => {
    Svc.saveSupplier({ id, name: document.getElementById('s-name').value, phone: document.getElementById('s-phone').value, city: document.getElementById('s-city').value,
      gstin: document.getElementById('s-gstin').value, dueDays: document.getElementById('s-due').value,
      openingBalance: id ? 0 : toP(document.getElementById('s-pending').value), openingDate: id ? '' : document.getElementById('s-opdate').value });
    closeModal(); navigate('suppliers'); toast(id ? 'Supplier updated!' : 'Supplier added!');
  });
};
window.showAddPurchase = function (sid) {
  const sups = DB.get('suppliers').filter(s => !s.archived);
  if (!sups.length) { toast('Add a supplier first', 'error'); return; }
  openModal(`<div class="modal-title">🧾 Purchase Bill from Supplier</div>
    <div class="form-row"><div class="form-group"><label>Supplier</label><select id="pu-sup">${sups.map(s => `<option value="${esc(s.id)}" ${s.id === sid ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="form-group"><label>Bill no (optional)</label><input id="pu-no"></div></div>
    <div class="form-row"><div class="form-group"><label>Bill amount incl. GST (₹)</label><input id="pu-amt" type="number" min="0" step="0.01"></div>
      <div class="form-group"><label>of which GST (₹)</label><input id="pu-gst" type="number" min="0" step="0.01" value="0"></div></div>
    <div class="form-row"><div class="form-group"><label>Bill date</label><input id="pu-date" type="date" value="${today()}"></div>
      <div class="form-group"><label>Due days</label><input id="pu-due" type="number" min="0" value="${Settings.get('defaultDueDays')}"></div></div>
    <div class="form-row"><div class="form-group"><label>Note</label><input id="pu-note"></div></div>
    <div style="font-size:11px;color:var(--text3)">Posts the purchase (ex-GST) to expenses, GST to input credit, and the full amount to supplier payables.</div>
    <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="savePurchase()">Save Bill</button></div>`);
};
window.savePurchase = function () {
  guard(() => {
    Svc.addPurchase({ supplierId: document.getElementById('pu-sup').value, billNo: document.getElementById('pu-no').value, amount: toP(document.getElementById('pu-amt').value),
      gst: toP(document.getElementById('pu-gst').value), date: document.getElementById('pu-date').value, dueDays: document.getElementById('pu-due').value, note: document.getElementById('pu-note').value });
    closeModal(); navigate('suppliers'); toast('Purchase bill saved');
  });
};
window.showPaySupplier = function (id) {
  const s = DB.get('suppliers').find(x => x.id === id); if (!s) return;
  const due = Book.payable(id);
  openModal(`<div class="modal-title">Pay Supplier — ${esc(s.name)}</div>
    <div style="margin-bottom:14px;color:var(--text2)">Payable: <b class="hl-red">${fmt(due)}</b></div>
    <div class="form-row"><div class="form-group"><label>Amount paid (₹)</label><input id="pay-amount" type="number" min="0" step="0.01" max="${rupeeStr(due)}" value="${rupeeStr(due)}"></div>
      <div class="form-group"><label>Mode</label><select id="pay-mode">${PAY_MODES.map(m => `<option>${m}</option>`).join('')}</select></div>
      <div class="form-group"><label>Date</label><input id="pay-date" type="date" value="${today()}" max="${today()}"></div></div>
    <div class="form-row"><div class="form-group"><label>Note</label><input id="pay-note"></div></div>
    <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" onclick="applyPayment('${esc(id)}','suppliers')">Record Payment</button></div>`);
};
window.submitSupplierPayment = function (id) {
  guard(() => {
    Svc.paySupplier({ supplierId: id, amount: toP(document.getElementById('pay-amount').value), mode: document.getElementById('pay-mode').value,
      date: document.getElementById('pay-date').value, note: document.getElementById('pay-note').value.trim() });
    closeModal(); navigate('suppliers'); toast('Payment recorded! (posted to cash book)');
  });
};

/* ===================================================================
   PAGE: AGING / OVERDUE  (receivables & payables)
   =================================================================== */
let agingTab = 'customer';
pages.aging = function () {
  const A = Book.aging(agingTab), isC = agingTab === 'customer';
  const names = ['0–30', '31–60', '61–90', '90+'];
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-secondary" onclick="exportAgingCSV()">⬇ Excel / CSV</button>
    <button class="btn btn-secondary" onclick="printSection('aging-print','${isC ? 'Receivables' : 'Payables'} Aging')">🖨 Print</button>
    <button class="btn btn-primary" onclick="downloadPDF('aging-print','${isC ? 'Receivables' : 'Payables'}_Aging')">⬇ PDF</button>`;
  document.getElementById('content').innerHTML = `
  <div class="tabs no-print"><div class="tab ${isC ? 'active' : ''}" onclick="agingTab='customer';navigate('aging')">Receivables (customers owe us)</div>
    <div class="tab ${!isC ? 'active' : ''}" onclick="agingTab='supplier';navigate('aging')">Payables (we owe suppliers)</div></div>
  <div id="aging-print">
  <div class="stats-grid" style="grid-template-columns:repeat(5,1fr)">
    ${names.map((n, i) => `<div class="stat-card ${i > 1 ? 'red' : i ? 'orange' : 'blue'}"><div class="stat-label">${n} days</div><div class="stat-val">${fmt(A.totals.b[i])}</div></div>`).join('')}
    <div class="stat-card red"><div class="stat-label">Total Overdue</div><div class="stat-val hl-red">${fmt(A.totals.overdue)}</div><div class="stat-sub">of ${fmt(A.totals.total)} outstanding</div></div>
  </div>
  <div style="font-size:11px;color:var(--text3);margin-bottom:12px">Buckets count days past the due date (bill date + due days); bills not yet due fall in 0–30. “Overdue” is the amount already past its due date.</div>
  <div class="card" style="margin-bottom:20px"><div class="card-title">${isC ? '👥 Customer-wise receivables aging' : '🏭 Supplier-wise payables aging'}</div><div class="table-wrap"><table>
    <thead><tr><th>${isC ? 'Customer' : 'Supplier'}</th><th>0–30</th><th>31–60</th><th>61–90</th><th>90+</th><th>Total</th><th>Overdue</th><th>Oldest overdue</th></tr></thead>
    <tbody>${A.rows.map(r => `<tr class="${r.b[3] > 0 ? 'row-overdue2' : r.overdue > 0 ? 'row-overdue' : ''}">
      <td><b>${isC ? `<a class="link" onclick="navigate('customer','${esc(r.id)}')">${esc(r.name)}</a>` : esc(r.name)}</b></td>
      ${r.b.map(v => `<td class="mono">${v ? fmt(v) : '—'}</td>`).join('')}<td class="mono"><b>${fmt(r.total)}</b></td>
      <td class="mono ${r.overdue ? 'hl-red' : ''}">${r.overdue ? fmt(r.overdue) : '—'}</td><td>${r.maxOver ? r.maxOver + ' days' : '—'}</td></tr>`).join('') ||
      `<tr><td colspan="8"><div class="empty"><div class="empty-icon">✅</div><div class="empty-text">Nothing outstanding</div></div></td></tr>`}</tbody>
    ${A.rows.length ? `<tfoot><tr style="background:var(--surface2);font-weight:700"><td style="padding:10px 14px">TOTAL</td>${A.totals.b.map(v => `<td class="mono" style="padding:10px 14px">${fmt(v)}</td>`).join('')}<td class="mono" style="padding:10px 14px">${fmt(A.totals.total)}</td><td class="mono hl-red" style="padding:10px 14px">${fmt(A.totals.overdue)}</td><td></td></tr></tfoot>` : ''}
  </table></div></div>
  <div class="card"><div class="card-title">📑 Bill-wise detail</div><div class="table-wrap"><table>
    <thead><tr><th>${isC ? 'Customer' : 'Supplier'}</th><th>Bill</th><th>Bill date</th><th>Due date</th><th>Days overdue</th><th>Outstanding</th></tr></thead>
    <tbody>${A.rows.flatMap(r => r.bills.map(b => `<tr class="${b.overdueDays > 90 ? 'row-overdue2' : b.overdueDays > 0 ? 'row-overdue' : ''}"><td>${esc(r.name)}</td><td class="mono">${esc(b.ref)}</td><td>${fmtDate(b.date)}</td><td>${fmtDate(b.dueDate)}</td>
      <td>${b.overdueDays > 0 ? b.overdueDays : '—'}</td><td class="mono">${fmt(b.outstanding)}</td></tr>`)).join('') || '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text3)">No open bills</td></tr>'}</tbody></table></div></div>
  </div>`;
};
window.exportAgingCSV = function () {
  const A = Book.aging(agingTab), isC = agingTab === 'customer';
  const rows = [[isC ? 'Customer' : 'Supplier', '0-30', '31-60', '61-90', '90+', 'Total', 'Overdue', 'Oldest overdue (days)']];
  A.rows.forEach(r => rows.push([r.name, ...r.b.map(rupeeStr), rupeeStr(r.total), rupeeStr(r.overdue), r.maxOver]));
  rows.push(['TOTAL', ...A.totals.b.map(rupeeStr), rupeeStr(A.totals.total), rupeeStr(A.totals.overdue), '']);
  rows.push([], ['Bill-wise detail'], [isC ? 'Customer' : 'Supplier', 'Bill', 'Bill date', 'Due date', 'Days overdue', 'Outstanding']);
  A.rows.forEach(r => r.bills.forEach(b => rows.push([r.name, b.ref, b.date, b.dueDate, Math.max(0, b.overdueDays), rupeeStr(b.outstanding)])));
  downloadCSV(`chitragupt-${isC ? 'receivables' : 'payables'}-aging-${today()}.csv`, rows);
};

/* ===================================================================
   PAGE: REPORTS
   =================================================================== */
pages.reports = function () {
  const r = getRange('reports'), products = DB.get('products');
  const rev = {};
  Calc.sales(r).forEach(s => { const eff = effItems(s); s.items.forEach((i, n) => rev[i.name] = (rev[i.name] || 0) + eff[n].eNet); });
  Calc.returns(r).forEach(x => x.items.forEach(i => rev[i.name] = (rev[i.name] || 0) - i.net));
  const top = Object.entries(rev).sort((a, b) => b[1] - a[1]).slice(0, 5);
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-secondary" onclick="navigate('aging')">⏰ Aging</button>
    <button class="btn btn-secondary" onclick="printSection('reports-print','Reports')">🖨 Print</button>`;
  document.getElementById('content').innerHTML = rangeBar('reports') + `
  <div id="reports-print">
  <div class="grid-2" style="margin-bottom:20px">
    <div class="card"><div class="card-title">🏆 Top Products by Net Revenue (ex-GST)</div>
      ${top.map(([name, v], i) => `<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span>${i + 1}. ${esc(name)}</span><span class="mono hl-green">${fmt(v)}</span></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${top[0][1] > 0 ? Math.max(0, Math.round(v / top[0][1] * 100)) : 0}%;background:var(--accent)"></div></div></div>`).join('') ||
        '<div class="empty" style="padding:20px"><div class="empty-text">No data</div></div>'}</div>
    <div class="card"><div class="card-title">📊 Revenue Chart</div><div class="chart-container"><canvas id="topProdChart"></canvas></div></div>
  </div>
  <div class="grid-2">
    <div class="card"><div class="card-title">📦 Stock Report</div><div class="table-wrap"><table><thead><tr><th>Product</th><th>Stock</th><th>Value</th></tr></thead>
      <tbody>${products.map(p => `<tr><td>${esc(p.name)}</td><td class="${p.stock < 10 ? 'hl-red' : p.stock < 20 ? 'hl-yellow' : ''}">${p.stock}</td><td class="mono">${fmt(mulQ(p.price, p.stock))}</td></tr>`).join('') ||
        '<tr><td colspan="3" style="padding:16px;text-align:center;color:var(--text3)">No products</td></tr>'}</tbody></table></div></div>
    <div class="card"><div class="card-title">💹 Financial Summary (${esc(rangeLabel(r))})</div>
      <div class="pl-row"><span>Net Sales (ex-GST)</span><span class="mono hl-green">${fmt(Calc.netSales(r))}</span></div>
      <div class="pl-row"><span>Billed incl. GST (after returns)</span><span class="mono">${fmt(Calc.grossBilled(r))}</span></div>
      <div class="pl-row"><span>GST Collected (net)</span><span class="mono hl-blue">${fmt(Calc.totalGSTCollected(r))}</span></div>
      <div class="pl-row"><span>Total Expenses</span><span class="mono hl-red">${fmt(Calc.totalExpenses(r))}</span></div>
      <div class="pl-row"><span>Net Profit</span><span class="mono ${Calc.profit(r) >= 0 ? 'hl-green' : 'hl-red'}">${fmt(Calc.profit(r))}</span></div>
      <div class="pl-row"><span>Inventory Value (now)</span><span class="mono">${fmt(Calc.inventoryValue())}</span></div>
      <div class="pl-row"><span>Outstanding Receivables (now)</span><span class="mono hl-yellow">${fmt(Calc.totalReceivable())}</span></div>
      <div class="pl-row"><span>Overdue Receivables (now)</span><span class="mono hl-red">${fmt(Calc.overdueReceivable())}</span></div>
      <div class="pl-row"><span>Supplier Payables (now)</span><span class="mono">${fmt(Calc.totalPayables())}</span></div>
      <div class="pl-row"><span>Net Worth (now)</span><span class="mono ${Calc.netWorth() >= 0 ? 'hl-accent' : 'hl-red'}">${fmt(Calc.netWorth())}</span></div></div>
  </div></div>`;
  if (top.length) activeCharts.push(new Chart(document.getElementById('topProdChart').getContext('2d'), {
    type: 'bar', data: { labels: top.map(([n]) => n), datasets: [{ data: top.map(([, v]) => toR(v)), backgroundColor: 'rgba(32,60,116,0.5)', borderColor: '#203C74', borderWidth: 1, borderRadius: 4 }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: chartScales(), responsive: true, maintainAspectRatio: false }
  }));
};

/* ===================================================================
   PAGE: AUDIT LOG  (append-only; financial records are voided, never deleted)
   =================================================================== */
let auditSearch = '', auditLimit = 300;
pages.audit = function () {
  const q = auditSearch.trim().toLowerCase();
  const all = DB.get('audit').slice().reverse().filter(a => !q || [a.action, a.entity, a.summary, a.user].join(' ').toLowerCase().includes(q));
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-secondary" onclick="exportAuditCSV()">⬇ CSV</button>`;
  document.getElementById('content').innerHTML = `
  <div class="card no-print" style="margin-bottom:16px"><div class="form-group"><label>Filter (create / edit / void / entity / text)</label>
    <input id="audit-search" value="${esc(auditSearch)}" placeholder="e.g. void, sale, customer…" oninput="auditSearch=this.value;clearTimeout(window._as);window._as=setTimeout(()=>{navigate('audit');const e=document.getElementById('audit-search');e.focus();e.setSelectionRange(e.value.length,e.value.length)},300)"></div></div>
  <div class="card"><div class="card-title">🕵️ Activity (${all.length})</div><div class="table-wrap"><table>
    <thead><tr><th>When</th><th>User</th><th>Action</th><th>Record</th><th>Details</th></tr></thead>
    <tbody>${all.slice(0, auditLimit).map(a => `<tr><td class="mono">${new Date(a.ts).toLocaleString('en-IN')}</td><td>${esc(a.user)}</td>
      <td><span class="badge ${a.action === 'void' || a.action === 'delete' ? 'badge-red' : a.action === 'create' ? 'badge-green' : 'badge-blue'}">${esc(a.action)}</span></td><td>${esc(a.entity)}</td><td>${esc(a.summary)}</td></tr>`).join('') ||
      '<tr><td colspan="5"><div class="empty"><div class="empty-icon">🕵️</div><div class="empty-text">No activity recorded</div></div></td></tr>'}</tbody></table></div>
    ${all.length > auditLimit ? `<div style="text-align:center;margin-top:10px"><button class="btn btn-secondary" onclick="auditLimit+=500;navigate('audit')">Show more</button></div>` : ''}</div>`;
};
window.exportAuditCSV = function () {
  downloadCSV(`chitragupt-audit-${today()}.csv`, [['Timestamp', 'User', 'Action', 'Entity', 'Ref', 'Details'], ...DB.get('audit').map(a => [a.ts, a.user, a.action, a.entity, a.refId, a.summary])]);
};

/* ===================================================================
   PAGE: SETTINGS  (business, defaults, backup & restore)
   =================================================================== */
pages.settings = function () {
  const S = Settings.all(), m = Backup.meta(), snaps = Backup.snapshots().slice().reverse();
  const ago = ts => { if (!ts) return 'never'; const d = Math.floor((Date.now() - Date.parse(ts)) / 86400000); return `${new Date(ts).toLocaleString('en-IN')} (${d === 0 ? 'today' : d + ' day' + (d > 1 ? 's' : '') + ' ago'})`; };
  const w = Backup.warning();
  document.getElementById('content').innerHTML = `
  <div style="max-width:760px">
    <div class="card settings-section"><div class="card-title">🏢 Business Information</div>
      <div class="form-group" style="margin-bottom:14px"><label>Business Name</label><input id="set-biz" value="${esc(DB.get('businessName', 'My Business'))}"></div>
      <div class="form-group" style="margin-bottom:14px"><label>GSTIN Number</label><input id="set-gst" value="${esc(DB.get('gstNumber', 'N/A'))}"></div>
      <div class="form-group" style="margin-bottom:14px"><label>Address</label><input id="set-addr" value="${esc(DB.get('address', ''))}"></div>
      <div class="form-group" style="margin-bottom:16px"><label>Phone</label><input id="set-phone" value="${esc(DB.get('bizPhone', ''))}"></div>
      <div class="form-row"><div class="form-group"><label>Default due days (new customers / suppliers)</label><input id="set-due" type="number" min="0" value="${S.defaultDueDays}"></div>
        <div class="form-group"><label>When a credit sale exceeds the limit</label><select id="set-limit"><option value="warn" ${S.creditLimitMode === 'warn' ? 'selected' : ''}>Warn (allow override)</option><option value="block" ${S.creditLimitMode === 'block' ? 'selected' : ''}>Block the sale</option></select></div>
        <div class="form-group"><label>Customer advance in POS</label><select id="set-adv"><option value="1" ${S.autoApplyAdvance ? 'selected' : ''}>Auto-apply (toggle per bill)</option><option value="0" ${!S.autoApplyAdvance ? 'selected' : ''}>Ask each time</option></select></div></div>
      <button class="btn btn-primary" onclick="saveSettings()">💾 Save Settings</button></div>

    <div class="card settings-section"><div class="card-title">🗄️ Backup &amp; Restore</div>
      <div class="backup-status ${w ? 'bad' : ''}">
        <div><b>Last backup file:</b> ${esc(ago(m.lastFileBackupAt))}</div>
        <div><b>Last automatic snapshot:</b> ${esc(ago(m.lastSnapshotAt))}</div>
        ${w ? `<div class="hl-red">⚠ ${w.never ? 'No backup file has ever been downloaded.' : 'Backup file is older than 7 days.'}</div>` : ''}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin:14px 0">
        <button class="btn btn-blue" onclick="exportData()">⬇ Download backup (JSON)</button>
        <button class="btn btn-secondary" onclick="importData()">⬆ Restore from file</button>
        <button class="btn btn-secondary" onclick="takeSnapshot()">📸 Snapshot now</button></div>
      <div class="form-row"><div class="form-group"><label>Auto-download backup file when the app opens</label><select id="set-sched"><option value="off" ${S.backupSchedule === 'off' ? 'selected' : ''}>Off</option><option value="daily" ${S.backupSchedule === 'daily' ? 'selected' : ''}>Daily</option><option value="weekly" ${S.backupSchedule === 'weekly' ? 'selected' : ''}>Weekly</option></select></div>
        <div class="form-group"><label>Snapshot after every N changes</label><input id="set-snap" type="number" min="1" value="${S.snapEvery}"></div>
        <div class="form-group" style="flex:0 0 auto"><button class="btn btn-secondary" onclick="saveBackupSettings()">Save</button></div></div>
      <div class="card-title" style="margin-top:18px;font-size:13px">Rolling snapshots (last 5, stored in this browser)</div>
      <div class="table-wrap"><table><thead><tr><th>Taken</th><th>Reason</th><th>Contents</th><th>Size</th><th></th></tr></thead><tbody>
        ${snaps.map(s => `<tr><td>${new Date(s.ts).toLocaleString('en-IN')}</td><td>${esc(s.reason)}</td><td>${s.counts.sales} bills · ${s.counts.customers} customers · ${s.counts.products} products</td><td>${Math.round(s.bytes / 1024)} KB</td>
          <td><button class="btn btn-sm btn-secondary" onclick="restoreSnap('${esc(s.id)}')">Restore</button></td></tr>`).join('') ||
          '<tr><td colspan="5" style="padding:14px;text-align:center;color:var(--text3)">No snapshots yet</td></tr>'}</tbody></table></div></div>

    <div class="card settings-section"><div class="card-title">🧰 Maintenance</div>
      <div style="color:var(--text2);font-size:13px;margin-bottom:12px">Reset removes all business data (bills, customers, products, ledger…). Your login is kept.</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn btn-secondary" onclick="rebuildLedger()">🔧 Rebuild ledger from records</button>
        <button class="btn btn-danger" onclick="resetData()">🗑 Reset All Data</button></div></div>
    <div class="card"><div class="card-title">ℹ️ About</div><div style="color:var(--text2);font-size:13px"><b>ChitRagupt v2.0</b> (data schema v${SCHEMA_VERSION}) — AI-Powered Inventory &amp; Finance<br>
      <span style="color:var(--text3)">Your data is saved to your secure online database (Neon Postgres) so you can use ChitRagupt on any device after you log in. This browser keeps an offline copy while you work. Passwords are stored only as bcrypt hashes. Backup snapshots are kept in this browser only.</span></div></div>
    <div class="card settings-section"><div class="card-title">🔐 Account &amp; Security</div><div style="color:var(--text2);font-size:13px;margin-bottom:16px">Signed in as <b data-notranslate="1">${esc((Sync.user && Sync.user.loginId) || '')}</b>. Logout to lock the app. Your data stays safe online and is not deleted.</div>
      <button class="btn btn-danger" onclick="handleLogout()">🚪 Logout &amp; Lock App</button>
      ${Legacy.has() && !Sync.empty ? `<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);font-size:13px;color:var(--text2)">This browser still holds the <b>old offline copy</b> of your data (including the old PIN). It is no longer used.
        <div style="margin-top:10px"><button class="btn btn-secondary" onclick="if(confirm('Delete the old offline copy from this browser? Your online data is not affected.'))removeLegacyLocal()">Delete old local copy</button></div></div>` : ''}</div>
  </div>`;
};
window.saveSettings = function () {
  guard(() => {
    DB.set('businessName', document.getElementById('set-biz').value.trim() || 'My Business');
    DB.set('gstNumber', document.getElementById('set-gst').value.trim());
    DB.set('address', document.getElementById('set-addr').value.trim());
    DB.set('bizPhone', document.getElementById('set-phone').value.trim());
    const s = { ...Settings.all(), defaultDueDays: Math.max(0, parseInt(document.getElementById('set-due').value, 10) || 0),
      creditLimitMode: document.getElementById('set-limit').value, autoApplyAdvance: document.getElementById('set-adv').value === '1' };
    DB.set('settings', s);
    Audit.log('edit', 'settings', '', 'Business details / defaults updated');
    toast('Settings saved!');
  });
};
window.saveBackupSettings = function () {
  const n = parseInt(document.getElementById('set-snap').value, 10);
  if (!(n >= 1)) { toast('Snapshot interval must be at least 1', 'error'); return; }
  DB.set('settings', { ...Settings.all(), backupSchedule: document.getElementById('set-sched').value, snapEvery: n });
  Audit.log('edit', 'settings', '', 'Backup schedule updated'); toast('Backup settings saved'); navigate('settings');
};
window.takeSnapshot = function () { if (Backup.snapshot('manual')) { toast('Snapshot saved'); navigate('settings'); } };
window.exportData = function () { Backup.exportFile(false); toast('Backup downloaded'); if (currentPage === 'settings') navigate('settings'); renderBanners(); };
window.importData = function () {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      let raw;
      try { raw = JSON.parse(ev.target.result); } catch { toast('That file is not valid JSON', 'error'); return; }
      const v = Backup.validate(raw);
      if (!v.ok) { toast('Restore refused: ' + v.errors.slice(0, 2).join('; '), 'error'); return; }
      if (!confirm(`Restore from "${file.name}"?\n\nThis REPLACES current business data${v.ver < 2 ? ' (old-format file will be upgraded)' : ''}. A safety snapshot is taken first. Your login is not changed.`)) return;
      guard(() => { Backup.restore(raw, 'file ' + file.name); toast('Data restored'); navigate('dashboard'); });
    };
    reader.readAsText(file);
  };
  input.click();
};
window.restoreSnap = function (id) {
  const s = Backup.snapshots().find(x => x.id === id); if (!s) return;
  if (!confirm(`Restore the snapshot from ${new Date(s.ts).toLocaleString('en-IN')}?\nCurrent data is replaced (a safety snapshot is taken first).`)) return;
  guard(() => { Backup.restoreSnapshot(id); toast('Snapshot restored'); navigate('dashboard'); });
};
window.resetData = function () {
  if (!confirm('This will delete ALL business data (bills, customers, products, ledger…).\n\nA safety snapshot is kept so you can undo it from Settings. Continue?')) return;
  guard(() => {
    Backup.snapshot('before-reset');
    atomic(DATA_KEYS, () => {
      DATA_KEYS.forEach(k => DB.set(k, dataDefault(k)));
      DB.set('businessName', (Sync.user && Sync.user.businessName) || '');
      _ledgerStore = null;
      Audit.log('reset', 'data', '', 'All business data deleted (login kept)');
    });
    toast('All business data cleared (login kept)');
    navigate('dashboard');
  });
};

/* ===================================================================
   12. MANUAL / FORECAST / LOGIN / CALCULATOR / LANGUAGE / CHATBOT
   (existing features, kept and updated for the ledger & paise)
   =================================================================== */
/* 
   PAGE: USER MANUAL
 */
pages.manual = function() {
  document.getElementById('topbar-actions').innerHTML = `<button class="btn btn-secondary" onclick="window.print()">🖨 Print Manual</button>`;
  document.getElementById('content').innerHTML = `
  <div style="max-width:860px;margin:0 auto">

    <!-- Header Banner -->
    <div style="background:linear-gradient(135deg,var(--royal-blue) 0%,#2d50a0 100%);border-radius:var(--radius-lg);padding:32px 36px;margin-bottom:28px;color:#fff;position:relative;overflow:hidden;">
      <div style="position:absolute;right:-20px;top:-20px;font-size:120px;opacity:0.07;">📖</div>
      <div style="font-family:var(--font-head);font-size:11px;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.6);margin-bottom:8px;">Documentation</div>
      <div style="font-family:var(--font-head);font-size:28px;font-weight:800;margin-bottom:6px;">Chitragupt User Manual</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.75);">AI-Powered Inventory & Finance — Complete System Guide</div>
      <div style="margin-top:16px;display:flex;gap:12px;flex-wrap:wrap;">
        <span style="background:rgba(255,255,255,0.15);border-radius:20px;padding:4px 14px;font-size:12px;font-family:var(--font-mono);">v1.0</span>
        <span style="background:rgba(189,149,78,0.35);border-radius:20px;padding:4px 14px;font-size:12px;font-family:var(--font-mono);color:#f5d99a;">Web-Based</span>
        <span style="background:rgba(255,255,255,0.15);border-radius:20px;padding:4px 14px;font-size:12px;font-family:var(--font-mono);">Cloud Database · Any Device</span>
      </div>
    </div>

    <!-- Section 1: Introduction -->
    <div class="card" style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:14px;border-bottom:2px solid var(--royal-blue);">
        <div style="width:36px;height:36px;background:rgba(32,60,116,0.10);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">📌</div>
        <div>
          <div style="font-family:var(--font-head);font-size:15px;font-weight:800;color:var(--royal-blue);">1. Introduction</div>
          <div style="font-size:12px;color:var(--text3);">Section 1.1 — What is Chitragupt?</div>
        </div>
      </div>
      <p style="color:var(--text2);font-size:13.5px;line-height:1.8;">
        <strong style="color:var(--royal-blue);">Chitragupt</strong> is a web-based business management system designed for local businesses to manage
        <strong>inventory, billing, sales, expenses,</strong> and <strong>financial records</strong> efficiently.
        It simplifies complex accounting operations and provides real-time insights — saved to your secure online database, so you can use it from any device after you log in.
      </p>
      <div style="margin-top:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;">
        ${['🧾 Billing & Invoices','📦 Inventory Tracking','💸 Expense Management','📊 P&L Reports','🧮 GST Tracking','💰 Bank / Cash Book'].map(f=>`
          <div style="background:rgba(32,60,116,0.05);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;font-size:13px;font-weight:500;color:var(--royal-blue);">${f}</div>
        `).join('')}
      </div>
    </div>

    <!-- Section 1.2: System Access -->
    <div class="card" style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:14px;border-bottom:2px solid var(--royal-blue);">
        <div style="width:36px;height:36px;background:rgba(32,60,116,0.10);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🔐</div>
        <div>
          <div style="font-family:var(--font-head);font-size:15px;font-weight:800;color:var(--royal-blue);">1.2 System Access</div>
          <div style="font-size:12px;color:var(--text3);">How to get started</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${[
          ['1','Open Application','Open the ChitRagupt web address in any modern web browser (Chrome, Edge, Firefox, Safari)'],
          ['2','Access Dashboard','Create your account (or log in) with a login id and password, then you land on the Overview Dashboard'],
          ['3','Start Using','All data is saved automatically to your online database — an internet connection is needed to save. Short outages are fine: changes are kept in this browser and sent when you are back online']
        ].map(([n,title,desc])=>`
          <div style="display:flex;align-items:flex-start;gap:14px;padding:12px 16px;background:rgba(32,60,116,0.04);border-radius:var(--radius);border-left:3px solid var(--royal-gold);">
            <div style="width:26px;height:26px;background:var(--royal-blue);color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${n}</div>
            <div><div style="font-weight:600;color:var(--royal-blue);font-size:13px;">${title}</div><div style="font-size:12px;color:var(--text2);margin-top:2px;">${desc}</div></div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Section 1.4: Modules -->
    <div class="card" style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:14px;border-bottom:2px solid var(--royal-blue);">
        <div style="width:36px;height:36px;background:rgba(32,60,116,0.10);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🗂️</div>
        <div>
          <div style="font-family:var(--font-head);font-size:15px;font-weight:800;color:var(--royal-blue);">1.4 Modules Overview</div>
          <div style="font-size:12px;color:var(--text3);">All available modules and their features</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;">
        ${[
          ['🧾','POS / Billing',['Select product','Enter quantity','Auto GST calculation','Generate & print invoice'],'pos'],
          ['📦','Inventory',['Add/update products','Track stock levels','Low stock alerts','Purchase entries'],'inventory'],
          ['📈','Sales Analytics',['Daily/monthly sales','Top products','Revenue charts','Sales trends'],'sales'],
          ['💸','Expenses',['Add expenses','Categorize spending','Track totals','GST input tracking'],'expenses'],
          ['⚖️','Profit & Loss',['Revenue summary','Expense breakdown','Net profit','Financial clarity'],'pl'],
          ['🧮','GST Dashboard',['Input GST tracking','Output GST collected','Net GST payable','GST reports'],'gst'],
          ['💰','Bank / Cash Book',['Cash inflow/outflow','Balance tracking','Transaction history','Financial records'],'cashbook'],
          ['🏦','Balance Sheet',['Assets overview','Liabilities','Net worth','Financial position'],'balance'],
          ['👥','Customers & Suppliers',['Manage records','Track credit/debit','Payment recording','Contact info'],'customers'],
          ['📋','Reports',['Generate reports','Print statements','Top products','Financial summary'],'reports'],
          ['📜','Bill History',['Search bills','Returns & credit notes','Void bills','Hold / resume'],'bills'],
          ['⏰','Aging & Overdue',['Receivable / payable aging','Overdue highlighting','Excel & PDF export','Dashboard overdue card'],'aging'],
          ['🕵️','Audit Log',['Create / edit / void history','No hard deletes','CSV export'],'audit'],
        ].map(([icon,name,features,page])=>`
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);padding:16px;cursor:pointer;transition:all 0.18s;" 
               onmouseover="this.style.borderColor='var(--royal-blue)';this.style.boxShadow='0 4px 12px rgba(32,60,116,0.10)'"
               onmouseout="this.style.borderColor='var(--border)';this.style.boxShadow='none'"
               onclick="navigate('${page}')">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
              <span style="font-size:20px;">${icon}</span>
              <span style="font-family:var(--font-head);font-weight:700;font-size:13px;color:var(--royal-blue);">${name}</span>
            </div>
            <ul style="list-style:none;padding:0;margin:0;">
              ${features.map(f=>`<li style="font-size:12px;color:var(--text2);padding:2px 0;padding-left:14px;position:relative;">
                <span style="position:absolute;left:0;color:var(--royal-gold);">›</span>${f}
              </li>`).join('')}
            </ul>
            <div style="margin-top:10px;font-size:11px;color:var(--royal-gold);font-family:var(--font-mono);font-weight:600;">Click to open →</div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Section 2: Development Phases -->
    <div class="card" style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:14px;border-bottom:2px solid var(--royal-blue);">
        <div style="width:36px;height:36px;background:rgba(32,60,116,0.10);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🏗️</div>
        <div>
          <div style="font-family:var(--font-head);font-size:15px;font-weight:800;color:var(--royal-blue);">2. Development Phases</div>
          <div style="font-size:12px;color:var(--text3);">How Chitragupt was built</div>
        </div>
      </div>
      <div style="position:relative;padding-left:28px;">
        <div style="position:absolute;left:10px;top:0;bottom:0;width:2px;background:linear-gradient(to bottom,var(--royal-blue),var(--royal-gold));border-radius:2px;"></div>
        ${[
          ['🔍','Requirement Analysis','Identified business problems, defined features and scope'],
          ['🎨','System Design','Created architecture, UI layouts and component structure'],
          ['🗄️','Data Modeling','Structured product, sales, expense and customer data schemas'],
          ['💻','Frontend Development','Built complete UI using HTML, CSS and JavaScript'],
          ['⚙️','Logic Implementation','GST calculations, profit tracking, inventory management'],
          ['💾','Data Storage','Saved to a secure online Postgres database; this browser keeps an offline copy while you work'],
          ['🧪','Testing','Verified all calculations, edge cases and functionality'],
          ['✨','Enhancement','Added reports, print features and analytics charts'],
          ['🚀','Deployment','Ready for demonstration and real-world use'],
        ].map(([icon,phase,desc],i)=>`
          <div style="display:flex;gap:14px;margin-bottom:16px;position:relative;">
            <div style="width:32px;height:32px;background:${i%2===0?'var(--royal-blue)':'var(--royal-gold)'};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;margin-left:-16px;border:3px solid var(--surface);z-index:1;">${icon}</div>
            <div style="padding-top:4px;">
              <div style="font-weight:700;font-size:13px;color:var(--royal-blue);">${phase}</div>
              <div style="font-size:12px;color:var(--text2);margin-top:2px;">${desc}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Section 3: Capabilities -->
    <div class="grid-2" style="margin-bottom:20px;">
      <!-- Core Features -->
      <div class="card">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:14px;border-bottom:2px solid var(--royal-blue);">
          <div style="width:36px;height:36px;background:rgba(32,60,116,0.10);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">✅</div>
          <div>
            <div style="font-family:var(--font-head);font-size:14px;font-weight:800;color:var(--royal-blue);">Core Features</div>
            <div style="font-size:11px;color:var(--text3);">Available Now</div>
          </div>
        </div>
        ${['Billing and invoice generation','Inventory tracking & alerts','Expense management','Profit & Loss calculation','Balance sheet generation','GST tracking & reporting','Bank / Cash book','Customer & supplier CRM','Split payments, returns & credit notes','Ledger-based books with reconciliation','Aging reports & backups'].map(f=>`
          <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);">
            <span style="color:#1a7a4a;font-size:14px;">✔</span>
            <span style="font-size:13px;color:var(--text2);">${f}</span>
          </div>
        `).join('')}
      </div>
      <!-- Future Scope -->
      <div class="card">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:14px;border-bottom:2px solid var(--royal-gold);">
          <div style="width:36px;height:36px;background:rgba(189,149,78,0.12);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🚀</div>
          <div>
            <div style="font-family:var(--font-head);font-size:14px;font-weight:800;color:var(--royal-gold);">Future Scope</div>
            <div style="font-size:11px;color:var(--text3);">Coming Soon</div>
          </div>
        </div>
        ${[
          ['🤖','AI demand forecasting','Predict stock needs using sales patterns'],
          ['🎤','Voice interaction','Hands-free billing via voice commands'],
          ['🌐','Multi-language support','Hindi & regional language UI'],
          ['☁️','Multi-device sync','Your data is now stored online and available on every device you log in from'],
          ['📱','Mobile app','Dedicated Android & iOS application'],
        ].map(([icon,title,desc])=>`
          <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="font-size:16px;flex-shrink:0;">${icon}</span>
            <div>
              <div style="font-size:13px;font-weight:600;color:var(--text);">${title}</div>
              <div style="font-size:11px;color:var(--text3);">${desc}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Business Benefits -->
    <div class="card" style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:14px;border-bottom:2px solid var(--royal-blue);">
        <div style="width:36px;height:36px;background:rgba(32,60,116,0.10);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">💼</div>
        <div>
          <div style="font-family:var(--font-head);font-size:15px;font-weight:800;color:var(--royal-blue);">Business Benefits</div>
          <div style="font-size:12px;color:var(--text3);">Why use Chitragupt?</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;">
        ${[
          ['⚡','Saves Time','Automates repetitive billing and accounting tasks'],
          ['🎯','Reduces Errors','Eliminates manual calculation mistakes'],
          ['📈','Better Decisions','Real-time data drives smarter business choices'],
          ['💡','Financial Clarity','Clear view of profit, loss and cash position'],
          ['📊','Increases Profitability','Identify top products and cut unnecessary costs'],
        ].map(([icon,title,desc])=>`
          <div style="background:rgba(32,60,116,0.04);border:1px solid var(--border);border-radius:var(--radius);padding:16px;text-align:center;">
            <div style="font-size:26px;margin-bottom:8px;">${icon}</div>
            <div style="font-weight:700;font-size:13px;color:var(--royal-blue);margin-bottom:4px;">${title}</div>
            <div style="font-size:12px;color:var(--text3);">${desc}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <!-- Conclusion -->
    <div style="background:linear-gradient(135deg,rgba(32,60,116,0.06) 0%,rgba(189,149,78,0.08) 100%);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px 28px;text-align:center;">
      <div style="font-size:28px;margin-bottom:10px;">🏆</div>
      <div style="font-family:var(--font-head);font-size:16px;font-weight:800;color:var(--royal-blue);margin-bottom:10px;">Conclusion</div>
      <p style="font-size:13.5px;color:var(--text2);line-height:1.8;max-width:620px;margin:0 auto;">
        Chitragupt integrates <strong>inventory, billing,</strong> and <strong>financial analytics</strong> into a single platform, 
        providing real-time insights and enabling efficient, data-driven decision making for local businesses.
      </p>
      <div style="margin-top:16px;">
        <button class="btn btn-primary" onclick="navigate('dashboard')" style="margin-right:10px;">📊 Go to Dashboard</button>
        <button class="btn btn-secondary" onclick="window.print()">🖨 Print Manual</button>
      </div>
    </div>

  </div>`;
};

/* 
   PAGE: DEMAND FORECAST
 */
window.renderForecast = function() {
  const sales    = Calc.sales();
  const products = DB.get('products', []);

  // ── 1. Build per-product daily sales map 
  const productSalesMap = {};
  products.forEach(p => { productSalesMap[p.name] = {}; });

  sales.forEach(sale => {
    const dateStr = sale.date ? dkey(sale.date) : null;
    if (!dateStr) return;
    (sale.items || []).forEach(item => {
      if (!productSalesMap[item.name]) productSalesMap[item.name] = {};
      productSalesMap[item.name][dateStr] = (productSalesMap[item.name][dateStr] || 0) + (item.qty || 0);
    });
  });

  Calc.returns().forEach(r => r.items.forEach(item => {
    const ds = dkey(r.date);
    if (productSalesMap[item.name] && productSalesMap[item.name][ds] != null) productSalesMap[item.name][ds] = Math.max(0, productSalesMap[item.name][ds] - item.qty);
  }));

  // ── 2. Determine date range of all sales 
  const allDates = sales.map(s => s.date ? dkey(s.date) : null).filter(Boolean).sort();
  const firstDate = allDates.length ? keyToDate(allDates[0]) : new Date();
  const today = new Date(); today.setHours(0,0,0,0);
  const daySpan = Math.max(1, Math.round((today - firstDate) / 86400000) + 1);

  // ── 3. For each product, compute metrics 
  const forecastData = products.map(product => {
    const dailyMap  = productSalesMap[product.name] || {};
    const totalSold = Object.values(dailyMap).reduce((a,b)=>a+b, 0);
    const avgDaily  = totalSold / daySpan;

    // Trend: compare last-7-days avg vs prior-7-days avg
    const last7 = [], prior7 = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const ds = dkey(d);
      const qty = dailyMap[ds] || 0;
      if (i < 7) last7.push(qty); else prior7.push(qty);
    }
    const avg7  = last7.reduce((a,b)=>a+b,0)  / 7;
    const avg14 = prior7.reduce((a,b)=>a+b,0) / 7;

    let trend = 'stable', trendIcon = '→', trendColor = 'var(--text3)';
    const diff = avg7 - avg14;
    if (diff > 0.05)       { trend = 'rising';  trendIcon = '↑'; trendColor = 'var(--green)'; }
    else if (diff < -0.05) { trend = 'falling'; trendIcon = '↓'; trendColor = 'var(--red)'; }

    // Weighted forecast: 60% last-7-avg + 40% overall-avg
    const forecastDaily = avg7 > 0 ? (avg7 * 0.6 + avgDaily * 0.4) : avgDaily;
    const demand7  = Math.ceil(forecastDaily * 7);
    const demand30 = Math.ceil(forecastDaily * 30);
    const currentStock = product.stock || 0;

    return {
      name: product.name,
      stock: currentStock,
      avgDaily,
      trend, trendIcon, trendColor,
      demand7, demand30,
      reorderAlert7:  currentStock < demand7,
      reorderAlert30: currentStock < demand30,
      totalSold,
    };
  });

  const alertCount = forecastData.filter(f => f.reorderAlert7).length;

  // ── 4. Render 
  const el = document.getElementById('content');
  el.innerHTML = `
  <div class="stats-grid" style="margin-bottom:24px;">
    <div class="stat-card blue">
      <div class="stat-icon">📦</div>
      <div class="stat-label">Products Tracked</div>
      <div class="stat-val">${products.length}</div>
      <div class="stat-sub">in inventory</div>
    </div>
    <div class="stat-card ${alertCount > 0 ? 'red' : 'green'}">
      <div class="stat-icon">🚨</div>
      <div class="stat-label">Reorder Alerts (7d)</div>
      <div class="stat-val" style="color:${alertCount>0?'var(--red)':'var(--green)'}">${alertCount}</div>
      <div class="stat-sub">${alertCount>0?'products need restocking':'all stocks sufficient'}</div>
    </div>
    <div class="stat-card orange">
      <div class="stat-icon">🔮</div>
      <div class="stat-label">Forecast Horizon</div>
      <div class="stat-val" style="font-size:18px;">7 / 30d</div>
      <div class="stat-sub">based on ${daySpan} days of data</div>
    </div>
    <div class="stat-card purple">
      <div class="stat-icon">📈</div>
      <div class="stat-label">Rising Products</div>
      <div class="stat-val" style="color:var(--purple)">${forecastData.filter(f=>f.trend==='rising').length}</div>
      <div class="stat-sub">demand trending up</div>
    </div>
  </div>

  ${alertCount > 0 ? `
  <div style="background:rgba(192,57,43,0.08);border:1.5px solid rgba(192,57,43,0.30);border-radius:var(--radius-lg);padding:14px 20px;margin-bottom:20px;display:flex;align-items:center;gap:14px;">
    <span style="font-size:24px;">🚨</span>
    <div>
      <div style="font-family:var(--font-head);font-weight:700;color:var(--red);font-size:14px;">Reorder Alert — ${alertCount} Product${alertCount>1?'s':''} Running Low</div>
      <div style="font-size:12px;color:var(--text2);margin-top:3px;">
        ${forecastData.filter(f=>f.reorderAlert7).map(f=>`<strong>${esc(f.name)}</strong> (stock: ${f.stock}, need ${f.demand7} in 7d)`).join(' &nbsp;·&nbsp; ')}
      </div>
    </div>
  </div>` : ''}

  <div class="card" style="margin-bottom:24px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
      <div class="card-title" style="margin-bottom:0;">📊 Product Demand Forecast</div>
      <div style="font-size:11px;color:var(--text3);font-family:var(--font-mono);">Trend = last 7d vs prior 7d · weighted moving avg</div>
    </div>
    <div class="table-wrap">
      <table id="forecast-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Current Stock</th>
            <th>Avg Daily Sales</th>
            <th>Trend</th>
            <th>Predicted (7d)</th>
            <th>Predicted (30d)</th>
            <th>7d Status</th>
            <th>30d Status</th>
          </tr>
        </thead>
        <tbody>
          ${forecastData.map(f=>`
          <tr>
            <td style="font-weight:600;color:var(--royal-blue);">${esc(f.name)}</td>
            <td class="mono">${f.stock} units</td>
            <td class="mono">${f.avgDaily.toFixed(2)}/day</td>
            <td>
              <span style="font-size:18px;font-weight:700;color:${f.trendColor};">${f.trendIcon}</span>
              <span style="font-size:12px;color:${f.trendColor};margin-left:4px;text-transform:capitalize;">${f.trend}</span>
            </td>
            <td class="mono" style="font-weight:600;">${f.demand7} units</td>
            <td class="mono" style="font-weight:600;">${f.demand30} units</td>
            <td>${f.reorderAlert7
              ? '<span class="badge badge-red">⚠ Reorder Now</span>'
              : '<span class="badge badge-green">✔ Sufficient</span>'}</td>
            <td>${f.reorderAlert30
              ? '<span class="badge badge-yellow">⚠ Plan Reorder</span>'
              : '<span class="badge badge-green">✔ Sufficient</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <div style="margin-bottom:8px;font-family:var(--font-head);font-size:13px;font-weight:700;color:var(--royal-blue);text-transform:uppercase;letter-spacing:0.5px;">📦 Per-Product Breakdown</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-bottom:24px;">
    ${forecastData.map(f=>{
      const pct7 = f.demand7>0 ? Math.min(100,Math.round((f.stock/f.demand7)*100)) : 100;
      const barColor = pct7>=100?'var(--green)':pct7>=50?'var(--yellow)':'var(--red)';
      return `
      <div class="card" style="padding:16px;border-top:3px solid ${f.reorderAlert7?'var(--red)':'var(--royal-blue)'};">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
          <div style="font-family:var(--font-head);font-size:13px;font-weight:700;color:var(--royal-blue);">${esc(f.name)}</div>
          <span style="font-size:20px;color:${f.trendColor};">${f.trendIcon}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
          <div style="background:var(--surface2);border-radius:8px;padding:8px 10px;">
            <div style="font-size:10px;color:var(--text3);font-family:var(--font-mono);text-transform:uppercase;">Stock</div>
            <div style="font-size:16px;font-weight:700;color:var(--royal-blue);font-family:var(--font-head);">${f.stock}</div>
          </div>
          <div style="background:var(--surface2);border-radius:8px;padding:8px 10px;">
            <div style="font-size:10px;color:var(--text3);font-family:var(--font-mono);text-transform:uppercase;">Avg/Day</div>
            <div style="font-size:16px;font-weight:700;color:var(--royal-blue);font-family:var(--font-head);">${f.avgDaily.toFixed(1)}</div>
          </div>
          <div style="background:var(--surface2);border-radius:8px;padding:8px 10px;">
            <div style="font-size:10px;color:var(--text3);font-family:var(--font-mono);text-transform:uppercase;">Need (7d)</div>
            <div style="font-size:16px;font-weight:700;color:${f.reorderAlert7?'var(--red)':'var(--green)'};font-family:var(--font-head);">${f.demand7}</div>
          </div>
          <div style="background:var(--surface2);border-radius:8px;padding:8px 10px;">
            <div style="font-size:10px;color:var(--text3);font-family:var(--font-mono);text-transform:uppercase;">Need (30d)</div>
            <div style="font-size:16px;font-weight:700;color:${f.reorderAlert30?'var(--yellow)':'var(--green)'};font-family:var(--font-head);">${f.demand30}</div>
          </div>
        </div>
        <div style="margin-bottom:6px;">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3);margin-bottom:4px;">
            <span>Stock vs 7d Demand</span><span>${pct7}%</span>
          </div>
          <div style="background:var(--surface3);border-radius:20px;height:7px;overflow:hidden;">
            <div style="width:${pct7}%;background:${barColor};height:100%;border-radius:20px;transition:width 0.5s;"></div>
          </div>
        </div>
        ${f.reorderAlert7
          ? `<div style="margin-top:8px;font-size:11px;color:var(--red);font-weight:600;background:rgba(192,57,43,0.08);border-radius:6px;padding:5px 8px;">⚠ Shortfall of ${Math.max(0,f.demand7-f.stock)} units — reorder now</div>`
          : `<div style="margin-top:8px;font-size:11px;color:var(--green);font-weight:600;background:rgba(26,122,74,0.07);border-radius:6px;padding:5px 8px;">✔ Sufficient for 7-day demand</div>`
        }
      </div>`;
    }).join('')}
  </div>

  <div style="background:rgba(32,60,116,0.04);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px;margin-bottom:24px;">
    <div style="font-family:var(--font-head);font-size:12px;font-weight:700;color:var(--royal-blue);margin-bottom:6px;">ℹ️ How Forecasting Works</div>
    <ul style="list-style:none;padding:0;margin:0;font-size:12px;color:var(--text2);line-height:2.0;">
      <li>› <strong>Avg Daily Sales</strong> = Total units sold ÷ Days since first sale</li>
      <li>› <strong>Trend</strong> = Last-7-day average vs prior-7-day average &nbsp;(↑ Rising &nbsp;/ ↓ Falling &nbsp;/ → Stable)</li>
      <li>› <strong>Demand Prediction</strong> = Weighted avg: 60% last-7-day rate + 40% overall rate, multiplied by 7 or 30</li>
      <li>› <strong>Reorder Alert</strong> = Triggered when current stock &lt; predicted demand for that period</li>
    </ul>
  </div>`;
};

pages.forecast = function() {
  renderForecast();
};

/* 
   LOGIN — handled by sync.js (Auth: login id + password, JWT cookie, register, import, logout)
 */

/* 
   PAGE: CALCULATOR
 */
pages.calculator = function() {
  document.getElementById('page-title').textContent = t('page.calculator');
  document.getElementById('content').innerHTML = `
  <div style="max-width:680px">
    <div class="calc-tabs">
      <div class="calc-tab active" onclick="switchCalcTab('gst',this)">🧾 GST Calculator</div>
      <div class="calc-tab" onclick="switchCalcTab('margin',this)">📈 Profit Margin</div>
      <div class="calc-tab" onclick="switchCalcTab('reorder',this)">📦 Reorder Quantity</div>
    </div>

    <!-- GST Calculator -->
    <div class="calc-panel active" id="calc-gst">
      <div class="card">
        <div class="card-title">🧾 GST Calculator</div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:20px;">Calculate GST on any amount. Supports inclusive and exclusive modes.</p>
        <div class="form-row">
          <div class="calc-input-group" style="flex:1">
            <label>Amount (₹)</label>
            <input type="number" id="gst-amount" placeholder="e.g. 1000" min="0" oninput="calcGST()">
          </div>
          <div class="calc-input-group" style="flex:1">
            <label>GST Rate (%)</label>
            <select id="gst-rate" onchange="calcGST()">
              <option value="0">0% (Exempt)</option>
              <option value="5">5%</option>
              <option value="12" selected>12%</option>
              <option value="18">18%</option>
              <option value="28">28%</option>
            </select>
          </div>
          <div class="calc-input-group" style="flex:1">
            <label>Mode</label>
            <select id="gst-mode" onchange="calcGST()">
              <option value="exclusive">Exclusive (Add GST)</option>
              <option value="inclusive">Inclusive (Extract GST)</option>
            </select>
          </div>
        </div>
        <div class="calc-result-box" id="gst-result" style="display:none">
          <div class="calc-result-row"><span>Base Amount</span><span class="val" id="gst-base">—</span></div>
          <div class="calc-result-row"><span>CGST (<span id="gst-half-lbl">9</span>%)</span><span class="val" id="gst-cgst">—</span></div>
          <div class="calc-result-row"><span>SGST (<span id="gst-half-lbl2">9</span>%)</span><span class="val" id="gst-sgst">—</span></div>
          <div class="calc-result-row"><span>Total GST</span><span class="val" id="gst-total-gst">—</span></div>
          <div class="calc-result-row total"><span>Final Amount (with GST)</span><span class="val" id="gst-final">—</span></div>
        </div>
      </div>
    </div>

    <!-- Profit Margin Calculator -->
    <div class="calc-panel" id="calc-margin">
      <div class="card">
        <div class="card-title">📈 Profit Margin Calculator</div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:20px;">Find out your profit amount and margin % from cost and selling price.</p>
        <div class="form-row">
          <div class="calc-input-group" style="flex:1">
            <label>Cost Price (₹)</label>
            <input type="number" id="pm-cost" placeholder="e.g. 600" min="0" oninput="calcMargin()">
          </div>
          <div class="calc-input-group" style="flex:1">
            <label>Selling Price (₹)</label>
            <input type="number" id="pm-sell" placeholder="e.g. 900" min="0" oninput="calcMargin()">
          </div>
        </div>
        <div class="calc-input-group">
          <label>GST Rate on Sale (%) — Optional</label>
          <select id="pm-gst" onchange="calcMargin()">
            <option value="0">0% (No GST)</option>
            <option value="5">5%</option>
            <option value="12">12%</option>
            <option value="18" selected>18%</option>
            <option value="28">28%</option>
          </select>
        </div>
        <div class="calc-result-box" id="margin-result" style="display:none">
          <div class="calc-result-row"><span>Cost Price</span><span class="val" id="pm-r-cost">—</span></div>
          <div class="calc-result-row"><span>Selling Price (excl. GST)</span><span class="val" id="pm-r-sell">—</span></div>
          <div class="calc-result-row"><span>GST Amount</span><span class="val" id="pm-r-gst">—</span></div>
          <div class="calc-result-row"><span>Gross Profit</span><span class="val" id="pm-r-profit">—</span></div>
          <div class="calc-result-row"><span>Profit Margin %</span><span class="val" id="pm-r-margin">—</span></div>
          <div class="calc-result-row"><span>Markup %</span><span class="val" id="pm-r-markup">—</span></div>
          <div class="calc-result-row total"><span>Customer Pays (incl. GST)</span><span class="val" id="pm-r-final">—</span></div>
        </div>
      </div>
    </div>

    <!-- Reorder Quantity Calculator -->
    <div class="calc-panel" id="calc-reorder">
      <div class="card">
        <div class="card-title">📦 Reorder Quantity Calculator</div>
        <p style="font-size:13px;color:var(--text2);margin-bottom:20px;">Calculate the optimal reorder point and Economic Order Quantity (EOQ).</p>
        <div class="form-row">
          <div class="calc-input-group" style="flex:1">
            <label>Daily Sales (units/day)</label>
            <input type="number" id="rq-daily" placeholder="e.g. 20" min="0" oninput="calcReorder()">
          </div>
          <div class="calc-input-group" style="flex:1">
            <label>Lead Time (days)</label>
            <input type="number" id="rq-lead" placeholder="e.g. 5" min="0" oninput="calcReorder()">
          </div>
        </div>
        <div class="form-row">
          <div class="calc-input-group" style="flex:1">
            <label>Safety Stock (units)</label>
            <input type="number" id="rq-safety" placeholder="e.g. 50" min="0" oninput="calcReorder()">
          </div>
          <div class="calc-input-group" style="flex:1">
            <label>Annual Demand (units)</label>
            <input type="number" id="rq-annual" placeholder="e.g. 7300" min="0" oninput="calcReorder()">
          </div>
        </div>
        <div class="form-row">
          <div class="calc-input-group" style="flex:1">
            <label>Ordering Cost per Order (₹)</label>
            <input type="number" id="rq-order-cost" placeholder="e.g. 500" min="0" oninput="calcReorder()">
          </div>
          <div class="calc-input-group" style="flex:1">
            <label>Holding Cost per Unit/Year (₹)</label>
            <input type="number" id="rq-hold" placeholder="e.g. 20" min="0" oninput="calcReorder()">
          </div>
        </div>
        <div class="calc-result-box" id="reorder-result" style="display:none">
          <div class="calc-result-row"><span>Reorder Point (ROP)</span><span class="val" id="rq-r-rop">—</span></div>
          <div class="calc-result-row"><span>Safety Stock</span><span class="val" id="rq-r-safety">—</span></div>
          <div class="calc-result-row"><span>Avg Stock During Lead Time</span><span class="val" id="rq-r-avg">—</span></div>
          <div class="calc-result-row"><span>EOQ (Economic Order Qty)</span><span class="val" id="rq-r-eoq">—</span></div>
          <div class="calc-result-row total"><span>Orders Per Year</span><span class="val" id="rq-r-orders">—</span></div>
        </div>
      </div>
    </div>
  </div>`;
};

window.switchCalcTab = function(tab, el) {
  document.querySelectorAll('.calc-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.calc-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('calc-' + tab).classList.add('active');
};

window.calcGST = function() {
  const amount = parseFloat(document.getElementById('gst-amount').value) || 0;
  const rate = parseFloat(document.getElementById('gst-rate').value) || 0;
  const mode = document.getElementById('gst-mode').value;
  const result = document.getElementById('gst-result');
  if (amount <= 0) { result.style.display = 'none'; return; }
  result.style.display = 'block';
  let base, gstAmt, final;
  if (mode === 'exclusive') {
    base = amount;
    gstAmt = base * rate / 100;
    final = base + gstAmt;
  } else {
    final = amount;
    base = amount / (1 + rate / 100);
    gstAmt = final - base;
  }
  const half = rate / 2;
  document.getElementById('gst-half-lbl').textContent = half;
  document.getElementById('gst-half-lbl2').textContent = half;
  document.getElementById('gst-base').textContent = fmtR(base);
  document.getElementById('gst-cgst').textContent = fmtR(gstAmt / 2);
  document.getElementById('gst-sgst').textContent = fmtR(gstAmt / 2);
  document.getElementById('gst-total-gst').textContent = fmtR(gstAmt);
  document.getElementById('gst-final').textContent = fmtR(final);
};

window.calcMargin = function() {
  const cost = parseFloat(document.getElementById('pm-cost').value) || 0;
  const sell = parseFloat(document.getElementById('pm-sell').value) || 0;
  const gstRate = parseFloat(document.getElementById('pm-gst').value) || 0;
  const result = document.getElementById('margin-result');
  if (cost <= 0 || sell <= 0) { result.style.display = 'none'; return; }
  result.style.display = 'block';
  const gstAmt = sell * gstRate / 100;
  const finalPrice = sell + gstAmt;
  const profit = sell - cost;
  const margin = (profit / sell) * 100;
  const markup = (profit / cost) * 100;
  document.getElementById('pm-r-cost').textContent = fmtR(cost);
  document.getElementById('pm-r-sell').textContent = fmtR(sell);
  document.getElementById('pm-r-gst').textContent = fmtR(gstAmt);
  document.getElementById('pm-r-profit').textContent = fmtR(profit);
  document.getElementById('pm-r-margin').textContent = margin.toFixed(2) + '%';
  document.getElementById('pm-r-markup').textContent = markup.toFixed(2) + '%';
  document.getElementById('pm-r-final').textContent = fmtR(finalPrice);
};

window.calcReorder = function() {
  const daily = parseFloat(document.getElementById('rq-daily').value) || 0;
  const lead = parseFloat(document.getElementById('rq-lead').value) || 0;
  const safety = parseFloat(document.getElementById('rq-safety').value) || 0;
  const annual = parseFloat(document.getElementById('rq-annual').value) || 0;
  const orderCost = parseFloat(document.getElementById('rq-order-cost').value) || 0;
  const hold = parseFloat(document.getElementById('rq-hold').value) || 0;
  const result = document.getElementById('reorder-result');
  if (daily <= 0 || lead <= 0) { result.style.display = 'none'; return; }
  result.style.display = 'block';
  const rop = (daily * lead) + safety;
  const avg = daily * lead;
  const eoq = (orderCost > 0 && hold > 0 && annual > 0)
    ? Math.sqrt((2 * annual * orderCost) / hold)
    : 0;
  const ordersPerYear = eoq > 0 ? (annual / eoq) : 0;
  document.getElementById('rq-r-rop').textContent = Math.round(rop) + ' units';
  document.getElementById('rq-r-safety').textContent = Math.round(safety) + ' units';
  document.getElementById('rq-r-avg').textContent = Math.round(avg) + ' units';
  document.getElementById('rq-r-eoq').textContent = eoq > 0 ? Math.round(eoq) + ' units' : '— (fill all fields)';
  document.getElementById('rq-r-orders').textContent = ordersPerYear > 0 ? ordersPerYear.toFixed(1) + ' orders/year' : '—';
};

/* 
   LANGUAGE — t('key') and I18n live in i18n.js; strings are in i18n/<lang>.json
 */

/* 
   CHATBOT ENGINE
 */
(function initChatbot() {
  const fab    = document.getElementById('cr-chat-fab');
  const panel  = document.getElementById('cr-chat-panel');
  const msgs   = document.getElementById('cr-chat-messages');
  const input  = document.getElementById('cr-chat-input');
  const sendBtn= document.getElementById('cr-chat-send');
  const micBtn = document.getElementById('cr-chat-mic');

  // Toggle panel
  fab.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    fab.classList.toggle('active', open);
    if (open && msgs.children.length === 0) botSay(
      'नमस्ते! 👋 I\'m ChitRagupt AI. Ask me anything about your inventory, sales, or finances!\n\n' +
      'Try: "best selling product", "total sales today", "stock of Product A", "total profit", "low stock items"'
    );
    if (open) setTimeout(() => input.focus(), 100);
  });

  sendBtn.addEventListener('click', handleSend);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') handleSend(); });

  function handleSend() {
    const q = input.value.trim();
    if (!q) return;
    userSay(q);
    input.value = '';
    const typing = showTyping();
    setTimeout(() => {
      typing.remove();
      botSay(answerQuery(q));
    }, 420);
  }

  function userSay(text) {
    const div = document.createElement('div');
    div.className = 'cr-msg user';
    div.innerHTML = `<div class="cr-msg-bubble">${escHtml(text)}</div>`;
    msgs.appendChild(div);
    scrollBottom();
  }

  function botSay(text) {
    const div = document.createElement('div');
    div.className = 'cr-msg bot';
    div.innerHTML = `<div class="cr-bot-icon">🤖</div><div class="cr-msg-bubble">${escHtml(text).replace(/\n/g,'<br>')}</div>`;
    msgs.appendChild(div);
    scrollBottom();
  }

  function showTyping() {
    const div = document.createElement('div');
    div.className = 'cr-msg bot';
    div.innerHTML = `<div class="cr-bot-icon">🤖</div><div class="cr-msg-bubble cr-typing"><span></span><span></span><span></span></div>`;
    msgs.appendChild(div);
    scrollBottom();
    return div;
  }

  function scrollBottom() { msgs.scrollTop = msgs.scrollHeight; }
  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  /* ── RULE-BASED QUERY ENGINE using Calc object ── */
  function answerQuery(q) {
    const lq = q.toLowerCase();
    const products  = Calc.products();
    const sales     = Calc.sales();
    const expenses  = Calc.expenses();

    // ── BEST SELLING PRODUCT
    if (/best.sel|top.product|most.sold|sabse zyada|popular product/i.test(lq)) {
      const tally = {};
      sales.forEach(s => s.items.forEach(it => {
        tally[it.name] = (tally[it.name] || 0) + (it.qty || 1);
      }));
      const sorted = Object.entries(tally).sort((a,b) => b[1]-a[1]);
      if (!sorted.length) return '📊 No sales data yet. Complete some sales first!';
      const [name, qty] = sorted[0];
      const rest = sorted.slice(1,3).map(([n,q]) => `${n} (${q} units)`).join(', ');
      return `🏆 Best selling: **${name}** with ${qty} units sold.${rest ? `\n\nRunners-up: ${rest}` : ''}`;
    }

    // ── STOCK OF A SPECIFIC PRODUCT
    const stockMatch = lq.match(/stock\s+(?:of\s+)?(.+)|(.+)\s+(?:ka\s+)?stock|how much.+?(?:of\s+)?(.+)/i);
    if (stockMatch && /stock|kitna|quantity|inventory/i.test(lq)) {
      const term = (stockMatch[1] || stockMatch[2] || stockMatch[3] || '').trim().toLowerCase();
      if (term.length > 1) {
        const found = products.filter(p => p.name.toLowerCase().includes(term));
        if (!found.length) return `❌ No product found matching "${term}". Check your inventory!`;
        return found.map(p =>
          `📦 **${p.name}**: ${p.stock} units in stock\n   Price: ${fmt(p.price)} | GST: ${p.gstRate}%`
        ).join('\n\n');
      }
    }

    // ── TOTAL SALES TODAY
    if (/today.s?|aaj|today/i.test(lq) && /sale|revenue|billing/i.test(lq)) {
      const todaySales = sales.filter(s => dkey(s.date) === dkey(new Date()));
      const amt = Calc.netSales({from: dkey(new Date()), to: dkey(new Date())});
      return `📅 Today's Net Sales (ex-GST): **${fmt(amt)}** across ${todaySales.length} order(s).`;
    }

    // ── TOTAL SALES (all time)
    if (/total.sale|overall.sale|kitna.bika|all.sale|revenue/i.test(lq)) {
      return `💰 Net Sales (ex-GST): **${fmt(Calc.totalSales())}**\n   Billed incl. GST: ${fmt(Calc.grossBilled())}\n   Orders: ${Calc.totalOrders()}\n   GST Collected: ${fmt(Calc.totalGSTCollected())}`;
    }

    // ── TOTAL PROFIT
    if (/profit|munafa|net.earning|earning/i.test(lq)) {
      const p = Calc.profit();
      const icon = p >= 0 ? '📈' : '📉';
      return `${icon} Net Profit: **${fmt(p)}**\n   Net sales: ${fmt(Calc.totalSales())}\n   Expenses: ${fmt(Calc.totalExpenses())}`;
    }

    // ── TOTAL EXPENSES
    if (/expense|kharcha|spending|cost/i.test(lq)) {
      const byCategory = {};
      expenses.forEach(e => { byCategory[e.category] = (byCategory[e.category]||0)+e.amount; });
      const cats = Object.entries(byCategory).slice(0,4).map(([c,a]) => `  • ${c}: ${fmt(a)}`).join('\n');
      return `💸 Total Expenses: **${fmt(Calc.totalExpenses())}**\n\nBy Category:\n${cats || '  (no categories)'}`;
    }

    // ── LOW STOCK / OUT OF STOCK
    if (/low.stock|kam.stock|stock.alert|out.of.stock|reorder|khatam/i.test(lq)) {
      const low = products.filter(p => p.stock <= 10).sort((a,b) => a.stock-b.stock);
      if (!low.length) return '✅ All products have good stock levels (>10 units).';
      return `⚠️ Low Stock Alert (≤10 units):\n\n` + low.map(p => `📦 ${p.name}: **${p.stock} units**`).join('\n');
    }

    // ── INVENTORY VALUE
    if (/inventory.value|stock.value|total.inventory|saman/i.test(lq)) {
      return `🏪 Total Inventory Value: **${fmt(Calc.inventoryValue())}**\n   Products: ${products.length}`;
    }

    // ── HOW MANY PRODUCTS
    if (/how many product|product count|kitne product|products do/i.test(lq)) {
      return `📦 You have **${products.length} products** in inventory.\n` + products.map(p=>`  • ${p.name} (${p.stock} units)`).join('\n');
    }

    // ── GST
    if (/gst|tax/i.test(lq)) {
      return `🧮 GST Summary:\n   Collected: **${fmt(Calc.totalGSTCollected())}**\n   Net Payable: ${fmt(Calc.netGST())} (Input credit ${fmt(Calc.inputGST())})`;
    }

    // ── CASH BALANCE
    if (/cash|balance|paisa|funds/i.test(lq)) {
      return `💵 Cash & Bank: **${fmt(Calc.cashBalance())}**\n   Cash ${fmt(Calc.cashInHand())} · Bank ${fmt(Calc.bankBalance())} (actual receipts − payments)`;
    }

    // ── OVERDUE / PAYABLES
    if (/overdue|baki|due payment/i.test(lq)) {
      return `⏰ Overdue receivables: **${fmt(Calc.overdueReceivable())}**\n   Overdue payables: ${fmt(Calc.overduePayable())}\n   Total receivable: ${fmt(Calc.totalReceivable())}`;
    }
    if (/payable|supplier.*owe|owe.*supplier/i.test(lq)) {
      return `🏭 Supplier payables: **${fmt(Calc.totalPayables())}**`;
    }
    // ── CUSTOMER RECEIVABLE
    if (/customer|receivable|pending.payment|udhar/i.test(lq)) {
      const cust = DB.get('customers',[]);
      return `👥 Customers: **${cust.length}**\n   Total Receivable: ${fmt(Calc.totalReceivable())}\n   Customer advances held: ${fmt(Calc.totalAdvances())}`;
    }

    // ── LIST ALL PRODUCTS
    if (/list.*product|show.*product|all product|product list/i.test(lq)) {
      if (!products.length) return '📦 No products in inventory yet.';
      return `📦 Products (${products.length}):\n\n` +
        products.map(p => `  • **${p.name}** — ${fmt(p.price)} | Stock: ${p.stock} | GST: ${p.gstRate}%`).join('\n');
    }

    // ── RECENT SALES
    if (/recent.sale|last.sale|latest.order|order/i.test(lq)) {
      if (!sales.length) return '📋 No sales recorded yet.';
      const recent = [...sales].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,3);
      return `📋 Recent Sales:\n\n` + recent.map(s =>
        `  ${fmtShort(s.date)} — **${fmt(s.finalTotal)}** | ${s.customerName || 'Walk-in'} | ${s.invoiceNo}`
      ).join('\n');
    }

    // ── HELP
    if (/help|kya.kar|what can|commands/i.test(lq)) {
      return `🤖 I can answer:\n\n• "best selling product"\n• "stock of [product name]"\n• "total sales today"\n• "total profit"\n• "low stock items"\n• "total expenses"\n• "inventory value"\n• "GST summary"\n• "recent sales"\n• "list all products"\n• "customer balance"`;
    }

    // ── FALLBACK: try product name match
    const matchedProduct = products.find(p => lq.includes(p.name.toLowerCase()));
    if (matchedProduct) {
      const p = matchedProduct;
      const prodSales = sales.filter(s => s.items.some(it => it.name === p.name));
      const unitsSold = prodSales.reduce((sum,s) => {
        const it = s.items.find(i => i.name === p.name);
        return sum + (it ? it.qty : 0);
      }, 0);
      return `📦 **${p.name}**\n   Price: ${fmt(p.price)} | GST: ${p.gstRate}%\n   Stock: ${p.stock} units\n   Units Sold: ${unitsSold}`;
    }

    return `🤔 I didn't understand that. Try asking:\n• "best selling product"\n• "stock of Product A"\n• "total sales today"\n• "show profit"\n\nOr type "help" for all commands.`;
  }

  /* 
     VOICE INPUT — Web Speech API
  */
  let recognition = null;
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

  function startRecognition(targetInput, btnEl) {
    if (!SpeechRec) {
      toast('🎤 Voice input not supported in this browser. Try Chrome.', 'error');
      return;
    }
    if (recognition) { recognition.stop(); return; }
    recognition = new SpeechRec();
    recognition.lang = 'en-IN';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    btnEl.classList.add('listening');
    recognition.start();

    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      targetInput.value = transcript;
      targetInput.dispatchEvent(new Event('input'));
    };
    recognition.onerror = () => { btnEl.classList.remove('listening'); recognition = null; };
    recognition.onend = () => { btnEl.classList.remove('listening'); recognition = null; };
  }

  // Chatbot panel mic
  micBtn.addEventListener('click', () => startRecognition(input, micBtn));

  // Topbar mic button — opens chatbot and fills input
  const topbarMic = document.getElementById('topbar-mic-btn');
  if (topbarMic) {
    topbarMic.addEventListener('click', () => {
      if (!panel.classList.contains('open')) {
        panel.classList.add('open');
        fab.classList.add('active');
        if (msgs.children.length === 0) botSay(
          'नमस्ते! 👋 I\'m ChitRagupt AI. Listening…'
        );
      }
      startRecognition(input, topbarMic);
    });
  }

})(); // end initChatbot

/* ===================================================================
   BOOT — sign in, load the business data, then open the dashboard
   =================================================================== */
/* nothing runs until the user is signed in and the business data is loaded: see Auth.boot() in sync.js,
   which then calls seedIfEmpty(), Book.sync(), Backup.scheduledCheck() and navigate('dashboard'). */
Auth.boot();
