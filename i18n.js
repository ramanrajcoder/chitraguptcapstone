/* ===================================================================
   ChitRagupt - i18n.js   (loaded BEFORE sync.js and script.js)

   t('key', {name: 'x'})  -> text from i18n/<lang>.json, falls back to English, then to the key.
   Languages live in i18n/<code>.json and are listed in i18n/languages.json.
   NEW LANGUAGE = add i18n/<code>.json + one line in i18n/languages.json. No code change.

   Two ways text gets translated:
   1. Code and static HTML use keys:      t('nav.dashboard')   /   <span data-i18n="nav.dashboard">
   2. Fixed labels rendered by the big page templates in script.js (table headings, buttons, form labels)
      are translated at display time: a text node that EXACTLY equals an English string from en.json is
      swapped for its translation. Anything with numbers, names or amounts mixed in never matches, so
      money, dates, invoice numbers, GSTIN, product and customer names are never touched.
   =================================================================== */
const I18n = (() => {
  const LS_KEY = 'bl_lang';
  const state = { lang: 'en', langs: [{ code: 'en', name: 'English', pill: 'EN' }], en: {}, dict: {}, rev: new Map(), ready: false };
  const trCache = new Map(); // dynamic-text translations already fetched this session

  async function getJson(url) {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  }

  function interpolate(s, vars) {
    return vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : String(s);
  }
  function t(key, vars) {
    const s = state.dict[key] ?? state.en[key] ?? key;
    return interpolate(s, vars);
  }

  function buildReverse() {
    state.rev = new Map();
    for (const [k, v] of Object.entries(state.en)) {
      if (k.startsWith('_') || typeof v !== 'string') continue;
      const tr = state.dict[k];
      if (tr && tr !== v && !state.rev.has(v)) state.rev.set(v, tr);
    }
  }

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE']);
  function translateNode(node) {
    if (state.lang === 'en' || !state.rev.size) return;
    if (node.nodeType === 3) {
      const p = node.parentElement;
      if (!p || SKIP_TAGS.has(p.tagName) || p.closest('[data-notranslate]')) return;
      const raw = node.data, trimmed = raw.trim();
      if (trimmed.length < 2) return;
      const hit = state.rev.get(trimmed.replace(/\s+/g, ' '));
      if (hit) node.data = raw.replace(trimmed, hit);
      return;
    }
    if (node.nodeType !== 1 || SKIP_TAGS.has(node.tagName) || node.closest?.('[data-notranslate]')) return;
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const v = node.getAttribute(attr);
      if (v) { const hit = state.rev.get(v.trim()); if (hit) node.setAttribute(attr, hit); }
    }
    node.childNodes.forEach(translateNode);
  }

  /** apply data-i18n / data-i18n-ph / data-i18n-title attributes (static HTML in index.html) */
  function applyStatic(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  }

  let observer = null;
  function startObserver() {
    if (observer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(muts => {
      if (state.lang === 'en') return;
      for (const m of muts) {
        if (m.type === 'characterData') translateNode(m.target);
        else m.addedNodes.forEach(translateNode);
      }
      translateDynamic(document.getElementById('main') || document);   // user-entered descriptions (data-tr) via /api/translate
    });
    ['main', 'modal-overlay', 'toast-container', 'cr-chat-panel', 'login-screen'].forEach(id => {
      const el = document.getElementById(id);
      if (el) observer.observe(el, { childList: true, subtree: true, characterData: true });
    });
  }

  async function loadLang(code) {
    if (code === 'en') { state.dict = {}; return; }
    try { state.dict = await getJson(`i18n/${code}.json`); }
    catch (e) { console.warn('language file missing, using English', e); state.dict = {}; code = 'en'; }
    state.lang = code;
  }

  async function init() {
    try { state.en = await getJson('i18n/en.json'); } catch (e) { console.error('en.json missing', e); state.en = {}; }
    try { const l = await getJson('i18n/languages.json'); if (Array.isArray(l) && l.length) state.langs = l; } catch { /* English only */ }
    let saved = 'en';
    try { saved = localStorage.getItem(LS_KEY) || 'en'; } catch { /* private mode */ }
    if (!state.langs.some(l => l.code === saved)) saved = 'en';
    state.lang = saved;
    await loadLang(saved);
    state.ready = true;
    document.documentElement.lang = state.lang;
    buildReverse();
    applyStatic();
    updateSwitcher();
    startObserver();
    if (state.lang !== 'en') translateNode(document.body);
  }

  function updateSwitcher() {
    const cur = state.langs.find(l => l.code === state.lang) || state.langs[0];
    const pill = document.getElementById('lang-pill'), label = document.getElementById('lang-label');
    if (pill) pill.textContent = cur.pill || cur.code.toUpperCase();
    if (label) label.textContent = cur.name;
    document.querySelectorAll('[data-lang-pill]').forEach(el => { el.textContent = cur.pill || cur.code.toUpperCase(); });
  }

  /** cycle to the next language in languages.json; re-render the current screen in it */
  async function next() {
    const i = state.langs.findIndex(l => l.code === state.lang);
    await setLang(state.langs[(i + 1) % state.langs.length].code);
  }
  async function setLang(code) {
    try { localStorage.setItem(LS_KEY, code); } catch { /* ignore */ }
    await loadLang(code);
    document.documentElement.lang = state.lang;
    buildReverse();
    applyStatic();
    updateSwitcher();
    if (typeof window.onLanguageChanged === 'function') window.onLanguageChanged(state.lang);
    if (state.lang !== 'en') { translateNode(document.body); translateDynamic(document); }
  }

  /* ---- user-entered free text (notes, expense descriptions): server translation with cache ---- */
  const MUST_KEEP = [/^[^\p{L}]*$/u, /^[A-Z]{2,4}-(\d{4}-)?\d+$/, /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/];
  const mustKeep = s => !s.trim() || MUST_KEEP.some(r => r.test(s.trim()));
  let trQueue = new Map(), trTimer = null;

  /** translate elements marked data-tr="1" (only user-entered descriptions). Falls back to the original text. */
  function translateDynamic(root = document) {
    if (state.lang === 'en') return;
    const els = [...root.querySelectorAll('[data-tr]')].filter(el => !el.dataset.trDone);
    els.forEach(el => {
      const src = el.dataset.trSrc ?? (el.dataset.trSrc = el.textContent);
      if (mustKeep(src)) { el.dataset.trDone = '1'; return; }
      const hit = trCache.get(state.lang + '|' + src);
      if (hit) { el.textContent = hit; el.dataset.trDone = '1'; return; }
      if (!trQueue.has(src)) trQueue.set(src, []);
      trQueue.get(src).push(el);
    });
    if (trQueue.size && !trTimer) trTimer = setTimeout(flushDynamic, 150);
  }
  async function flushDynamic() {
    trTimer = null;
    const batch = [...trQueue.entries()].slice(0, 25);
    batch.forEach(([k]) => trQueue.delete(k));
    if (!batch.length) return;
    const lang = state.lang;
    try {
      const r = await fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ texts: batch.map(b => b[0]), target: lang }) });
      if (!r.ok) throw new Error('translate ' + r.status);
      const j = await r.json();
      batch.forEach(([src, els], i) => {
        const out = j.translations?.[i]?.translated || src;
        trCache.set(lang + '|' + src, out);
        els.forEach(el => { if (el.isConnected && state.lang === lang) { el.textContent = out; el.dataset.trDone = '1'; } });
      });
    } catch { /* offline / refused: the original text simply stays */ }
    if (trQueue.size) trTimer = setTimeout(flushDynamic, 150);
  }

  return { init, t, next, setLang, applyStatic, translateNode, translateDynamic, get lang() { return state.lang; }, get ready() { return state.ready; } };
})();

window.I18n = I18n;
window.t = (key, vars) => I18n.t(key, vars);
