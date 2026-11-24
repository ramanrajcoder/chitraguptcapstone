/* ===================================================================
   ChitRagupt - sync.js   (loaded after i18n.js, BEFORE script.js)

   Api   : tiny fetch wrapper (cookie session, gzip for big saves)
   Sync  : keeps the in-memory copy of the business data in step with the server
           - DB.set() marks a key dirty -> debounced ONE request to /api/sync with every changed key
           - per-key version check: stale write = 409 -> everything pending is discarded and reloaded
           - localStorage is only an offline cache of the same data
   Auth  : login / register / logout / one-time import screens
   =================================================================== */

/* ---------------------------------------------------------------- Api */
async function gzipB64(str) {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

const Api = {
  /** bodyStr is already-serialised JSON (so a huge ledger is never parsed and re-stringified) */
  async req(method, url, bodyStr) {
    let payload = bodyStr;
    if (bodyStr && bodyStr.length > 200000 && typeof CompressionStream !== 'undefined') {
      try { payload = JSON.stringify({ gz: await gzipB64(bodyStr) }); } catch { payload = bodyStr; }
    }
    let r;
    try {
      r = await fetch(url, { method, credentials: 'same-origin', headers: bodyStr !== undefined ? { 'Content-Type': 'application/json' } : {}, body: payload });
    } catch (e) {
      throw Object.assign(new Error('Network error'), { status: 0, network: true });
    }
    let j = null;
    try { j = await r.json(); } catch { /* non-JSON (e.g. platform 413 page) */ }
    if (!r.ok) throw Object.assign(new Error((j && j.error) || `Server error (${r.status})`), { ...(j || {}), status: r.status });
    return j;
  },
  get(url) { return this.req('GET', url); },
  post(url, obj) { return this.req('POST', url, JSON.stringify(obj)); }
};

/* --------------------------------------------------------------- Sync */
const Sync = {
  user: null,             // {id, businessName, ownerName, loginId}
  ver: {},                // key -> server version we last saw (0 = not on server yet)
  dirty: new Set(),       // keys changed locally but not yet saved
  empty: true,            // server says this business has no records yet
  inflight: false, again: false, timer: null, retryTimer: null, failures: 0,
  cacheOK: true, offlineBoot: false, blocked: false, rejected: false, loggedOut: false, hiddenAt: 0,

  /* ---- localStorage offline cache (namespaced per business: blc_<id>_<key>) ---- */
  k(key) { return 'blc_' + this.user.id + '_' + key; },
  persistMeta() {
    if (!this.cacheOK || this.loggedOut) return;
    try { localStorage.setItem(this.k('_m'), JSON.stringify({ ver: this.ver, dirty: [...this.dirty] })); } catch { this.cacheFailed(); }
  },
  mirror(key, str) {
    if (!this.cacheOK || this.loggedOut) return;
    try { localStorage.setItem(this.k(key), str); } catch { this.cacheFailed(); }
  },
  cacheFailed() {
    if (!this.cacheOK) return;
    this.cacheOK = false;
    try { DATA_KEYS.forEach(k => localStorage.removeItem(this.k(k))); localStorage.removeItem(this.k('_m')); } catch { /* ignore */ }
    toast(t('sync.cache_off'), 'error');
  },
  readCache(key) { try { return localStorage.getItem(this.k(key)); } catch { return null; } },

  /* ---- called by DB.set() for every synced key ---- */
  touch(key, str) {
    this.dirty.add(key);
    this.mirror(key, str);
    this.persistMeta();
    if (!DB._undo.length) this.schedule();
  },
  /* atomic() failed: put the dirty flags and the cache back exactly as they were */
  restore(frame) {
    if (this.loggedOut) return;
    this.dirty = new Set(frame.dirty);
    Object.keys(frame.mem).forEach(k => {
      if (LOCAL_KEYS.includes(k)) return;
      const v = frame.mem[k];
      if (!this.cacheOK) return;
      try { if (v === undefined) localStorage.removeItem(this.k(k)); else localStorage.setItem(this.k(k), v); } catch { this.cacheFailed(); }
    });
    this.persistMeta();
  },

  schedule(delay = 500) {
    if (!this.user || this.blocked) return;
    this.rejected = false;
    clearTimeout(this.timer);
    this.setStatus(this.dirty.size ? 'pending' : 'saved');
    this.timer = setTimeout(() => this.flush(), delay);
  },

  setStatus(state, extra) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    const n = this.dirty.size;
    const map = {
      saved: ['✓ ' + t('sync.saved'), 'ok'],
      saving: ['⟳ ' + t('sync.saving'), 'busy'],
      pending: ['● ' + t('sync.pending'), 'busy'],
      offline: ['⚠ ' + t('sync.offline'), 'warn'],
      error: ['✕ ' + t('sync.not_saved'), 'bad']
    };
    const [text, cls] = map[state] || map.saved;
    el.textContent = text; el.className = 'sync-status ' + cls;
    el.title = extra || (n ? t('sync.unsaved_count', { n }) : '');
    el.setAttribute('data-notranslate', '1');
  },

  /* ---- load everything for this business (login, reload, after a conflict) ---- */
  async load({ reconcile = true } = {}) {
    const r = await Api.get('/api/data');
    if (this.loggedOut) throw Object.assign(new Error('logged out'), { status: 401 });
    this.user = { ...r.user };
    this.empty = !!r.empty;
    this.offlineBoot = false;
    this.cacheOK = true;
    this.applyServer(r.data, { reconcile });
    try { localStorage.setItem('blc_last', JSON.stringify(this.user)); } catch { /* ignore */ }
    return r;
  },

  applyServer(data, { reconcile = false } = {}) {
    // pending changes from an earlier session (tab closed or offline before they were saved)
    let pend = [], pendMeta = null;
    if (reconcile) {
      try { pendMeta = JSON.parse(localStorage.getItem(this.k('_m')) || 'null'); } catch { pendMeta = null; }
      pend = pendMeta?.dirty || [];
    }
    const local = {};
    LOCAL_KEYS.forEach(k => { try { const v = localStorage.getItem(this.k(k)); if (v !== null) local[k] = v; } catch { /* ignore */ } });

    DB._mem = Object.create(null);
    this.ver = {};
    this.dirty = new Set();
    DATA_KEYS.forEach(k => {
      if (data[k]) { DB._mem[k] = JSON.stringify(data[k].value); this.ver[k] = data[k].version; } else this.ver[k] = 0;
    });
    Object.assign(DB._mem, local);

    if (pend.length) {
      const cached = pend.map(k => [k, this.readCache(k)]);
      const intact = cached.every(([k, v]) => v !== null) && pend.every(k => (this.ver[k] || 0) === ((pendMeta.ver || {})[k] || 0));
      if (intact) {
        cached.forEach(([k, v]) => { DB._mem[k] = v; this.dirty.add(k); });
        setTimeout(() => toast(t('sync.pending_restored')), 800);
      } else {
        setTimeout(() => toast(t('sync.pending_discarded'), 'error'), 800);
      }
    }
    // refresh the offline copy
    DATA_KEYS.forEach(k => { if (DB._mem[k] !== undefined) this.mirror(k, DB._mem[k]); else { try { localStorage.removeItem(this.k(k)); } catch { /* ignore */ } } });
    this.persistMeta();
    _ledgerStore = null;
    if (this.dirty.size) this.schedule(300);
  },

  /* no network at start-up: open the last cached copy */
  loadFromCache() {
    let last = null;
    try { last = JSON.parse(localStorage.getItem('blc_last') || 'null'); } catch { /* ignore */ }
    if (!last || !last.id) return false;
    this.user = last;
    let meta = null;
    try { meta = JSON.parse(localStorage.getItem(this.k('_m')) || 'null'); } catch { /* ignore */ }
    if (!meta) return false;
    DB._mem = Object.create(null);
    this.ver = meta.ver || {};
    this.dirty = new Set(meta.dirty || []);
    let any = false;
    DATA_KEYS.concat(LOCAL_KEYS).forEach(k => { const v = this.readCache(k); if (v !== null) { DB._mem[k] = v; any = true; } });
    if (!any) return false;
    this.offlineBoot = true;
    this.empty = false;
    _ledgerStore = null;
    return true;
  },

  /* ---- send every changed key in ONE request ---- */
  async flush() {
    if (!this.user || this.blocked) return;
    if (this.inflight) { this.again = true; return; }
    clearTimeout(this.timer);
    const keys = [...this.dirty].filter(k => DB._mem[k] !== undefined);
    if (!keys.length) { this.dirty.clear(); this.persistMeta(); this.setStatus('saved'); return; }
    this.inflight = true;
    this.rejected = false;
    this.setStatus('saving');
    const sent = {};
    keys.forEach(k => { sent[k] = DB._mem[k]; });
    const body = '{"changes":[' + keys.map(k => `{"key":${JSON.stringify(k)},"base":${this.ver[k] || 0},"value":${sent[k]}}`).join(',') + ']}';
    let conflict = null;
    try {
      const res = await Api.req('POST', '/api/sync', body);
      keys.forEach(k => {
        this.ver[k] = res.versions[k];
        if (DB._mem[k] === sent[k]) this.dirty.delete(k);      // changed again while sending? stays dirty
      });
      this.failures = 0;
      clearTimeout(this.retryTimer);
      this.persistMeta();
      if (this.offlineBoot) { this.offlineBoot = false; setTimeout(() => this.refresh(), 300); }
      this.setStatus(this.dirty.size ? 'pending' : 'saved');
    } catch (e) {
      if (e.status === 409) conflict = e;
      else if (e.status === 401) this.sessionExpired();
      else if (e.status === 400 || e.status === 413) {
        this.rejected = true;                               // the same data would be refused again: wait for the next change
        this.setStatus('error', e.message);
        toast(e.status === 413 ? t('sync.too_large') : t('sync.rejected', { msg: e.message }), 'error');
      } else {
        this.failures++;
        this.setStatus('offline');
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.flush(), Math.min(60000, 3000 * Math.pow(2, this.failures - 1)));
      }
    } finally {
      this.inflight = false;
    }
    if (conflict) { await this.onConflict(conflict); return; }
    if (this.again) { this.again = false; this.schedule(50); }
    else if (this.dirty.size && this.failures === 0 && !this.blocked && !this.rejected) this.schedule(50);
  },

  /* the server refused (nothing was saved) because another device changed the data */
  async onConflict(e) {
    const names = (e.conflicts || []).map(k => t('data.' + k)).join(', ');
    try {
      await this.load({ reconcile: false });              // server wins: replaces memory, drops ALL pending local changes
      this.failures = 0;
      if (typeof closeModal === 'function') closeModal();
      if (typeof renderBanners === 'function') renderBanners();
      if (typeof navigate === 'function') navigate(currentPage, routeParam);
      this.setStatus('saved');
      openModal(`<div class="modal-title">⚠️ ${esc(t('sync.conflict_title'))}</div>
        <p style="font-size:14px;line-height:1.6;margin:8px 0 14px">${esc(t('sync.conflict_body', { keys: names || '—' }))}</p>
        <div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">${esc(t('common.ok'))}</button></div>`);
    } catch (err) {
      // could not reload right now: stay in "not saved" state and try again shortly
      this.setStatus('offline');
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.flush(), 5000);
    }
  },

  sessionExpired() {
    this.blocked = true;
    this.setStatus('error', t('sync.session_expired'));
    openModal(`<div class="modal-title">🔒 ${esc(t('sync.session_expired'))}</div>
      <p style="font-size:14px;line-height:1.6;margin:8px 0 14px">${esc(t('sync.session_expired_body'))}</p>
      <div class="modal-actions"><button class="btn btn-primary" onclick="location.reload()">${esc(t('auth.login_btn'))}</button></div>`);
  },

  /* pick up changes made on another device (only when nothing is waiting to be saved) */
  async refresh() {
    if (!this.user || this.inflight || this.dirty.size || this.blocked) return;
    try {
      const v = (await Api.get('/api/data?versions=1')).versions;
      const changed = DATA_KEYS.filter(k => (v[k] || 0) !== (this.ver[k] || 0));
      if (!changed.length || this.inflight || this.dirty.size) return;
      const r = await Api.get('/api/data?keys=' + changed.join(','));
      if (this.inflight || this.dirty.size || this.loggedOut) return;
      changed.forEach(k => {
        if (r.data[k]) { DB._mem[k] = JSON.stringify(r.data[k].value); this.ver[k] = r.data[k].version; this.mirror(k, DB._mem[k]); }
        else { delete DB._mem[k]; this.ver[k] = 0; }
      });
      this.persistMeta();
      _ledgerStore = null;
      toast(t('sync.updated_elsewhere'));
      const modalOpen = document.getElementById('modal-overlay')?.classList.contains('open');
      if (currentPage !== 'pos' && !modalOpen) { renderBanners(); navigate(currentPage, routeParam); }
    } catch { /* offline: try again next time the tab is shown */ }
  },

  /* wait (max ms) until everything is saved; true if nothing is pending */
  async drain(ms = 8000) {
    const end = Date.now() + ms;
    while ((this.dirty.size || this.inflight) && Date.now() < end) {
      if (!this.inflight) await this.flush(); else await new Promise(r => setTimeout(r, 100));
      if (this.failures || this.rejected) break;
    }
    return !this.dirty.size && !this.inflight;
  },

  /* forget this business on this device */
  wipeLocal() {
    this.loggedOut = true;            // any request still in flight must not write the cache again
    try {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('blc_')) doomed.push(k); }
      doomed.forEach(k => localStorage.removeItem(k));
    } catch { /* ignore */ }
  }
};

window.addEventListener('online', () => { if (Sync.user) { Sync.failures = 0; Sync.dirty.size ? Sync.flush() : Sync.refresh(); } });
window.addEventListener('offline', () => { if (Sync.user) Sync.setStatus('offline'); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { Sync.hiddenAt = Date.now(); return; }
  if (Sync.user && Sync.hiddenAt && Date.now() - Sync.hiddenAt > 30000) Sync.refresh();   // no polling: only when you come back to the tab
});
window.addEventListener('beforeunload', e => {
  if (Sync.user && (Sync.dirty.size || Sync.inflight)) { e.preventDefault(); e.returnValue = ''; }
});

/* --------------------------------------------------------------- Auth */
const Auth = {
  started: false,

  view(name) {
    ['loading', 'login', 'register', 'import', 'error'].forEach(v => {
      const el = document.getElementById('auth-' + v);
      if (el) el.style.display = v === name ? 'block' : 'none';
    });
    document.getElementById('login-screen').classList.remove('hidden');
    const first = { login: 'login-id', register: 'reg-biz' }[name];
    if (first) setTimeout(() => document.getElementById(first)?.focus(), 80);
  },

  err(id, msg) { const el = document.getElementById(id); if (el) el.textContent = msg || ''; },

  explain(e) {
    if (e.network) return t('auth.err_network');
    if (e.status === 401) return t('auth.err_wrong') + (typeof e.attemptsLeft === 'number' ? ' ' + t('auth.attempts_left', { n: e.attemptsLeft }) : '');
    if (e.status === 429) return t('auth.err_locked', { min: Math.max(1, Math.ceil((e.retryAfterSeconds || 900) / 60)) });
    if (e.status === 409) return t('auth.err_taken');
    if (e.status === 400) return e.message;
    return t('auth.err_server');
  },

  async boot() {
    this.view('loading');
    try { await I18n.init(); } catch (e) { console.error(e); }
    try {
      await Sync.load();
    } catch (e) {
      if (e.status === 401) {
        // a logout leaves a marker; finish wiping this device's cached business data (belt and braces)
        try { if (localStorage.getItem('cr_logged_out')) { Sync.wipeLocal(); Sync.loggedOut = false; localStorage.removeItem('cr_logged_out'); } } catch { /* ignore */ }
        this.view('login'); return;
      }
      if ((e.network || e.status >= 500) && Sync.loadFromCache()) { this.startApp(); Sync.setStatus('offline'); return; }
      this.view('error'); return;
    }
    await this.afterAuth();
  },

  /* first screen after a successful login / register / reload */
  async afterAuth() {
    if (Sync.empty && Legacy.has()) {
      const c = Legacy.counts();
      document.getElementById('import-found').textContent = t('auth.import_found', c);
      this.err('import-error', '');
      this.view('import');
      return;
    }
    this.startApp();
  },

  startApp() {
    seedIfEmpty();
    if (!DB.get('businessName', '')) DB.set('businessName', Sync.user.businessName || '');
    Book.sync();
    document.getElementById('login-screen').classList.add('hidden');
    const who = document.getElementById('who-label');
    if (who) { who.textContent = Sync.user.ownerName || Sync.user.loginId; who.setAttribute('data-notranslate', '1'); }
    this.started = true;
    Sync.setStatus(Sync.dirty.size ? 'pending' : 'saved');
    try { Backup.scheduledCheck(); } catch (e) { console.warn(e); }
    navigate('dashboard');
    I18n.translateNode(document.body);
  }
};

const $val = id => (document.getElementById(id)?.value ?? '');

window.showRegister = () => { Auth.err('login-error', ''); Auth.view('register'); };
window.showLogin = () => { Auth.err('reg-error', ''); Auth.view('login'); };
window.retryBoot = () => location.reload();

window.handleLogin = async function () {
  const loginId = $val('login-id').trim(), password = $val('login-pass');
  Auth.err('login-error', '');
  if (!loginId || !password) { Auth.err('login-error', t('auth.err_fill')); return; }
  const btn = document.getElementById('login-btn'); btn.disabled = true;
  try {
    await Api.post('/api/auth/login', { loginId, password });
    document.getElementById('login-pass').value = '';
    await Sync.load();
    await Auth.afterAuth();
  } catch (e) { Auth.err('login-error', Auth.explain(e)); document.getElementById('login-pass').value = ''; }
  finally { btn.disabled = false; }
};

window.handleRegister = async function () {
  const biz = $val('reg-biz').trim(), owner = $val('reg-owner').trim(), loginId = $val('reg-id').trim();
  const p1 = $val('reg-pass'), p2 = $val('reg-pass2');
  Auth.err('reg-error', '');
  if (!biz) return Auth.err('reg-error', t('auth.err_biz'));
  if (!owner) return Auth.err('reg-error', t('auth.err_owner'));
  if (loginId.length < 3 || !/^[A-Za-z0-9._@+-]+$/.test(loginId)) return Auth.err('reg-error', t('auth.err_loginid'));
  if (p1.length < 6) return Auth.err('reg-error', t('auth.err_password_len'));
  if (p1 !== p2) return Auth.err('reg-error', t('auth.err_password_match'));
  const btn = document.getElementById('reg-btn'); btn.disabled = true;
  try {
    await Api.post('/api/auth/register', { businessName: biz, ownerName: owner, loginId, password: p1 });
    ['reg-pass', 'reg-pass2'].forEach(id => { document.getElementById(id).value = ''; });
    await Sync.load();
    toast(t('auth.welcome_new', { name: owner }));
    await Auth.afterAuth();
  } catch (e) { Auth.err('reg-error', Auth.explain(e)); }
  finally { btn.disabled = false; }
};

window.handleLogout = async function () {
  if (!confirm(t('auth.confirm_logout'))) return;
  toast(t('auth.saving_before_logout'));
  const saved = await Sync.drain(8000);
  if (!saved && !confirm(t('auth.unsaved_logout', { n: Sync.dirty.size }))) return;
  Sync.blocked = true;
  try { localStorage.setItem('cr_logged_out', '1'); } catch { /* ignore */ }
  try { await Api.post('/api/auth/logout', {}); } catch { /* cookie expires by itself */ }
  Sync.wipeLocal();
  Sync.dirty.clear();            // already confirmed above
  location.reload();
};

/* ---- one-time import of the old localStorage data, or of a backup file ---- */
async function importPayload(data, sourceLabel) {
  const payload = {};
  DATA_KEYS.forEach(k => { payload[k] = k in data ? data[k] : dataDefault(k); });
  await Api.post('/api/import', { data: payload });
  await Sync.load();
  Auth.startApp();
  Audit.log('import', 'data', '', `Imported existing data from ${sourceLabel}: ${payload.sales.length} bills, ${payload.customers.length} customers, ${payload.products.length} products`);
  toast(t('auth.import_ok'));
  if (Legacy.has() && sourceLabel === 'this browser' && confirm(t('auth.import_cleanup'))) removeLegacyLocal();
}

window.handleImportLocal = async function () {
  Auth.err('import-error', '');
  const btn = document.getElementById('import-btn'); btn.disabled = true;
  try { await importPayload(Legacy.read(), 'this browser'); }
  catch (e) { Auth.err('import-error', e instanceof AppError ? e.message : Auth.explain(e)); }
  finally { btn.disabled = false; }
};

window.handleImportFile = function () {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      Auth.err('import-error', '');
      try {
        let raw; try { raw = JSON.parse(ev.target.result); } catch { throw new AppError(t('auth.import_notjson')); }
        const v = Backup.validate(raw);
        if (!v.ok) throw new AppError(t('auth.import_refused', { why: v.errors.slice(0, 2).join('; ') }));
        const data = v.ver < 2 ? migrateV1toV2(v.data) : { ...emptyData(), ...v.data };
        await importPayload(data, 'file ' + file.name);
      } catch (e) { Auth.err('import-error', e instanceof AppError ? e.message : Auth.explain(e)); }
    };
    reader.readAsText(file);
  };
  input.click();
};

window.handleImportSkip = function () { Auth.startApp(); };
window.handleLangSwitch = function () { I18n.next(); };
window.onLanguageChanged = function () {
  if (Auth.started) { Sync.setStatus(Sync.dirty.size ? 'pending' : 'saved'); renderBanners(); navigate(currentPage, routeParam); }
};
