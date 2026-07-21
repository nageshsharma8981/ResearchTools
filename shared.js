// ============================================================
// ItsMyResearch — shared runtime
// BYOK LLM client (OpenAI-compatible), settings UI, markdown
// renderer, theming, toasts, and the common tool harness.
// No external dependencies. API config lives in localStorage.
// ============================================================

(function () {
  'use strict';

  const LS_CFG = 'rewiseed_offline_llm_cfg_v1';
  const LS_THEME = 'rewiseed_theme';
  const LS_DRAFT_PREFIX = 'rewiseed_draft_';

  // ---------- utils ----------

  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const $ = (id) => document.getElementById(id);

  // The API key is session-only by default: it lives in sessionStorage, which the
  // browser wipes when the tab closes. It is written to persistent localStorage
  // ONLY when the user ticks "Remember my key on this device".
  const SS_KEY = 'rewiseed_apikey_session';
  function getCfg() {
    let cfg = {};
    try { cfg = JSON.parse(localStorage.getItem(LS_CFG) || '{}'); } catch { return {}; }
    if (!cfg.rememberKey) {
      let ss = '';
      try { ss = sessionStorage.getItem(SS_KEY) || ''; } catch { /* storage blocked */ }
      if (cfg.apiKey) {
        // migrate keys persisted before the session-only default existed
        try { sessionStorage.setItem(SS_KEY, cfg.apiKey); ss = cfg.apiKey; } catch { /* storage blocked */ }
        delete cfg.apiKey;
        try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch { /* storage blocked */ }
      }
      cfg.apiKey = ss;
    }
    return cfg;
  }
  function setCfg(cfg) {
    const { apiKey = '', rememberKey = false, ...rest } = cfg;
    try {
      if (rememberKey) {
        sessionStorage.removeItem(SS_KEY);
        localStorage.setItem(LS_CFG, JSON.stringify({ ...rest, rememberKey: true, apiKey }));
      } else {
        sessionStorage.setItem(SS_KEY, apiKey);
        localStorage.setItem(LS_CFG, JSON.stringify({ ...rest, rememberKey: false }));
      }
    } catch { /* storage blocked (private mode) — key works for this page only */ }
  }
  function clearApiKey() {
    try { sessionStorage.removeItem(SS_KEY); } catch { /* ignore */ }
    try {
      const cfg = JSON.parse(localStorage.getItem(LS_CFG) || '{}');
      delete cfg.apiKey;
      localStorage.setItem(LS_CFG, JSON.stringify(cfg));
    } catch { /* ignore */ }
  }

  function isLocalUrl(u) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(u || '') || isBuiltin(u);
  }
  function isBuiltin(u) { return String(u || '').startsWith('webllm:'); }
  function isAnthropic(u) { return String(u || '').includes('api.anthropic.com'); }

  // ---------- built-in browser model (WebLLM, WebGPU) ----------
  let _webllm = null, _webllmModel = '';
  function webllmStatus(html) {
    let el = document.getElementById('webllm-status');
    if (!html) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'webllm-status';
      el.style.cssText = 'position:fixed;left:20px;bottom:20px;z-index:95;background:var(--surface);border:1px solid var(--border);border-radius:999px;box-shadow:var(--shadow-lg);padding:9px 16px;font-size:12.5px;color:var(--ink-2);max-width:320px';
      document.body.appendChild(el);
    }
    el.innerHTML = html;
  }
  async function webllmChat({ system, user, temperature, onStream, signal, model }) {
    if (!navigator.gpu) {
      throw new Error('The built-in model needs WebGPU, which this browser does not support. Use Chrome or Edge — or pick another provider in API settings.');
    }
    const wanted = model || 'Llama-3.2-3B-Instruct-q4f16_1-MLC';
    if (!_webllm || _webllmModel !== wanted) {
      webllmStatus(`<span class="spinner" style="margin-right:7px"></span>Preparing built-in model… <b>0%</b><br/><span style="font-size:11px;color:var(--muted)">First time downloads the model (~2 GB), then it's cached on this device.</span>`);
      try {
        const lib = await import('/vendor-web-llm.js');
        _webllm = await lib.CreateMLCEngine(wanted, {
          initProgressCallback: (p) => webllmStatus(`<span class="spinner" style="margin-right:7px"></span>Preparing built-in model… <b>${Math.round((p.progress || 0) * 100)}%</b><br/><span style="font-size:11px;color:var(--muted)">${esc((p.text || '').slice(0, 70))}</span>`),
        });
        _webllmModel = wanted;
      } catch (e) {
        _webllm = null;
        throw new Error(`Could not load the built-in model: ${String(e.message || e).slice(0, 140)}`);
      } finally {
        webllmStatus(null);
      }
    }
    if (signal) signal.addEventListener('abort', () => { try { _webllm.interruptGenerate(); } catch {} }, { once: true });
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }];
    if (!onStream) {
      const r = await _webllm.chat.completions.create({ messages, temperature });
      return r.choices?.[0]?.message?.content || '';
    }
    const chunks = await _webllm.chat.completions.create({ messages, temperature, stream: true });
    let full = '';
    for await (const c of chunks) {
      if (signal?.aborted) { const err = new Error('aborted'); err.name = 'AbortError'; throw err; }
      const delta = c.choices?.[0]?.delta?.content || '';
      if (delta) { full += delta; onStream(full); }
    }
    return full;
  }

  // ---------- icons (Lucide outline paths, 24px viewBox) ----------

  const ICON_PATHS = {
    logo: 'M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
    search: 'M21 21l-4.34-4.34M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z',
    gap: 'M3 12h4m4 0h10M3 6h18M3 18h18M9.5 9.5L13 12l-3.5 2.5',
    dna: 'M2 15c6.667-6 13.333 0 20-6M9 22c1.798-1.998 2.518-3.995 2.807-5.993M15 2c-1.798 1.998-2.518 3.995-2.807 5.993M17 6l-2.5-2.5M14 8l-1-1M7 18l2.5 2.5M3.5 14.5l.5.5M20 9l.5.5M6.5 12.5l1 1M16.5 10.5l1 1M10 16l1.5 1.5',
    grad: 'M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0zM22 10v6M6 12.5V16a6 3 0 0 0 12 0v-3.5',
    book: 'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20',
    gear: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
    moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
    play: 'M6 4l14 8-14 8V4z',
    stop: 'M6 6h12v12H6z',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    eyeOff: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22',
    external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3',
    check: 'M20 6L9 17l-5-5',
    alert: 'M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
    sparkle: 'M12 3l1.9 5.7a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-2a2 2 0 0 0 1.3-1.2z',
    chevron: 'M6 9l6 6 6-6',
    home: 'M3 10.5L12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5',
    arrow: 'M5 12h14M12 5l7 7-7 7',
    doi: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
    shield: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1zM9 12l2 2 4-4',
    flask: 'M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2M6.453 15h11.094M8.5 2h7',
    doc: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v4a2 2 0 0 0 2 2h4M16 13H8M16 17H8M10 9H8',
    clipboard: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z',
    key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
    chat: 'M7.9 20A9 9 0 1 0 4 16.1L2 22z',
    sigma: 'M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2',
    grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
    pen: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    library: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5zM9 7h6M9 11h6',
    graph: 'M12 3v6m0 6v6M5 8l4 3m6 2l4 3M5 16l4-3m6-2l4-3M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3a1.5 1.5 0 1 0 0.01 0zM12 21a1.5 1.5 0 1 0 .01 0zM5 8a1.5 1.5 0 1 0 .01 0zM19 8a1.5 1.5 0 1 0 .01 0zM5 16a1.5 1.5 0 1 0 .01 0zM19 16a1.5 1.5 0 1 0 .01 0z',
    chart: 'M3 3v16a2 2 0 0 0 2 2h16M7 16l4-6 4 3 5-8',
    globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
    user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36z',
  };

  function icon(name, size = 20) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON_PATHS[name] || ''}"/></svg>`;
  }

  // ---------- theming ----------

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(LS_THEME, theme);
    const btn = $('theme-toggle');
    if (btn) {
      btn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 19);
      btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    }
  }
  function initTheme() {
    const saved = localStorage.getItem(LS_THEME);
    const theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    return theme;
  }
  initTheme();

  // ---------- fetch with timeout (external APIs can hang indefinitely) ----------
  async function fetchWithTimeout(url, { timeout = 20000, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeout);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
    try {
      return await fetch(url, { signal: ctrl.signal });
    } catch (e) {
      if (e?.name === 'TimeoutError' || ctrl.signal.reason?.name === 'TimeoutError') {
        throw new Error(`The request took longer than ${Math.round(timeout / 1000)}s and was stopped. The data service may be busy — try a narrower query.`);
      }
      throw e;
    } finally { clearTimeout(timer); }
  }

  // ---------- reference library save (available on any page) ----------
  async function saveToLibrary(paper, btn) {
    try {
      const res = await fetch('/api/library', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(paper),
      });
      if (res.status === 401) { toast('Sign in to save papers to your library', 'error'); return; }
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast(d.error || 'Could not save', 'error'); return; }
      toast(d.duplicate ? 'Already in your library' : 'Saved to your library');
      if (btn) {
        btn.classList.add('copied');
        btn.innerHTML = `${icon('check', 13)} Saved`;
        btn.disabled = true;
      }
    } catch { toast('Could not reach the library', 'error'); }
  }

  // ---------- intro loader (playable from any page) ----------
  function playIntro() {
    const go = () => window.RewiseedIntro && window.RewiseedIntro.play('');
    if (window.RewiseedIntro) return go();
    const s = document.createElement('script');
    s.src = 'intro.js';
    s.onload = go;
    s.onerror = () => toast('Could not load the intro', 'error');
    document.body.appendChild(s);
  }

  // ---------- toasts ----------

  function toast(msg, kind = 'info', ms = 3200) {
    let root = $('toast-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'toast-root';
      root.setAttribute('aria-live', 'polite');
      document.body.appendChild(root);
    }
    const t = document.createElement('div');
    t.className = 'toast' + (kind === 'error' ? ' error' : '');
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ---------- top navigation ----------

  const TOOLS = [
    { href: 'research-journey.html', icon: 'compass', name: 'Research Journey (start here)' },
    { href: 'paper-generator.html', icon: 'doc', name: 'Research Paper Generator' },
    { href: 'smart-literature-finder.html', icon: 'search', name: 'Smart Literature Finder' },
    { href: 'doi-finder.html', icon: 'doi', name: 'DOI Finder & Lookup' },
    { href: 'originality-checker.html', icon: 'shield', name: 'Originality & AI Checker' },
    { href: 'literature-matrix.html', icon: 'grid', name: 'Literature Synthesis Matrix' },
    { href: 'data-explorer.html', icon: 'chart', name: 'Statistical Data Explorer' },
    { href: 'data-sources.html', icon: 'globe', name: 'Data Source Directory' },
    { href: 'research-gap-identifier.html', icon: 'gap', name: 'Research Gap Identifier' },
    { href: 'research-question-generator.html', icon: 'flask', name: 'Research Question Generator' },
    { href: 'instrument-designer.html', icon: 'clipboard', name: 'Survey & Interview Designer' },
    { href: 'stats-advisor.html', icon: 'sigma', name: 'Statistical Test Advisor' },
    { href: 'ai-pls.html', icon: 'sigma', name: 'AI PLS' },
    { href: 'qualitative-coding-assistant.html', icon: 'dna', name: 'Qualitative Coding Assistant' },
    { href: 'peer-review-simulator.html', icon: 'grad', name: 'Peer Review Simulator' },
    { href: 'rubric-lens.html', icon: 'clipboard', name: 'RubricLens' },
    { href: 'abstract-generator.html', icon: 'doc', name: 'Abstract & Summary Studio' },
    { href: 'writing-polisher.html', icon: 'pen', name: 'Academic Writing Polisher' },
    { href: 'citation-formatter.html', icon: 'book', name: 'Citation Formatter' },
    { href: 'apa-formatter.html', icon: 'doc', name: 'Reference Style Generator' },
    { href: 'citation-graph.html', icon: 'graph', name: 'Citation Graph Explorer' },
    { href: 'scholar-profiles.html', icon: 'user', name: 'Author & Institution Profiles' },
    { href: 'bibliometrics.html', icon: 'chart', name: 'Bibliometric Analysis' },
    { href: 'journal-metrics.html', icon: 'book', name: 'Journal Metrics & Finder' },
  ];

  function renderNav(activeHref) {
    const nav = document.createElement('nav');
    nav.className = 'topnav';
    nav.innerHTML = `
      <a class="brand" href="index.html"><img src="logo.png" alt="ItsMyResearch" class="brand-logo" onerror="this.outerHTML='${icon('logo', 22).replace(/"/g, '&quot;')}<span>ItsMyResearch</span>'"/></a>
      ${activeHref !== 'index.html' ? `<a class="nav-home" href="index.html">${icon('home', 16)}<span>Home</span></a>` : ''}
      <div class="spacer"></div>
      <details class="tool-menu">
        <summary aria-label="Switch tool">Tools ${icon('chevron', 15)}</summary>
        <div class="menu">
          <a href="index.html" class="${activeHref === 'index.html' ? 'active' : ''}">${icon('home', 17)}Home — all tools</a>
          <div class="menu-rule"></div>
          ${TOOLS.map(t => `<a href="${t.href}" class="${t.href === activeHref ? 'active' : ''}">${icon(t.icon, 17)}${esc(t.name)}</a>`).join('')}
          <div class="menu-rule"></div>
          <a href="library.html" class="${activeHref === 'library.html' ? 'active' : ''}">${icon('library', 17)}My Library</a>
          <a href="#" id="menu-intro">${icon('play', 17)}Platform intro</a>
        </div>
      </details>
      <a id="nav-credits" class="nav-credits" href="pricing.html" hidden title="Your AI run credits — click for plans and how runs are counted"></a>
      <button id="theme-toggle" class="icon-btn" aria-label="Toggle theme"></button>`;
    document.body.prepend(nav);
    // credit transparency: signed-in users always see their balance
    billingStatus().then(b => {
      const el = document.getElementById('nav-credits');
      if (!el || !b.enforced || !b.signedIn) return;
      el.hidden = false;
      el.innerHTML = !b.freeRunUsed
        ? `${icon('sparkle', 13)} free run ready`
        : `${icon('sparkle', 13)} ${b.credits ?? 0} credit${b.credits === 1 ? '' : 's'}`;
      if (b.freeRunUsed && (b.credits ?? 0) === 0) el.classList.add('empty');
    });
    applyTheme(document.documentElement.getAttribute('data-theme'));
    $('theme-toggle').onclick = () => {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    };
    // close the menu when clicking outside or pressing Escape
    document.addEventListener('click', (e) => {
      const menu = nav.querySelector('.tool-menu');
      if (menu?.open && !menu.contains(e.target)) menu.open = false;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const menu = nav.querySelector('.tool-menu');
      if (menu?.open) { menu.open = false; menu.querySelector('summary')?.focus(); }
    });
    // account chip: shows when the accounts backend is present; silent otherwise
    fetch('/api/me', { credentials: 'same-origin' }).then(async (r) => {
      const slot = document.createElement('span');
      slot.style.cssText = 'display:inline-flex;align-items:center;gap:8px';
      if (r.ok) {
        const { user } = await r.json();
        const adminBtn = ['admin', 'superadmin'].includes(user.role)
          ? `<a class="nav-home" href="admin.html" title="Admin console">${icon('shield', 15)}<span>Admin</span></a>` : '';
        slot.innerHTML = `${adminBtn}<a class="avatar-btn" href="profile.html" title="${esc(user.name || user.email)} — profile">${
          user.photo ? `<img src="${esc(user.photo)}" alt="Profile"/>` : esc((user.name || user.email)[0].toUpperCase())}</a>`;
        // menu shows only granted tools when the account is restricted
        if (user.tool_access && user.tool_access.length) {
          nav.querySelectorAll('.tool-menu .menu a').forEach(a => {
            const id = (a.getAttribute('href') || '').replace('.html', '');
            if (id !== 'index' && !user.tool_access.includes(id)) a.remove();
          });
        }
      } else if (r.status === 401) {
        slot.innerHTML = `<a class="nav-signin" href="signin.html">Sign in</a>`;
      } else return;
      nav.insertBefore(slot, $('theme-toggle'));
    }).catch(() => { /* static/offline bundle — no accounts */ });
    // replayable platform intro from any page
    nav.querySelector('#menu-intro').addEventListener('click', (e) => {
      e.preventDefault();
      nav.querySelector('.tool-menu').open = false;
      playIntro();
    });
    // load the grounded assistant widget on every page (no-op offline)
    if (!document.getElementById('assistant-fab') && location.protocol.startsWith('http')) {
      const s = document.createElement('script');
      s.src = 'assistant.js'; s.defer = true;
      document.body.appendChild(s);
    }
    // elevate the nav once content scrolls beneath it
    let navRaf = 0;
    addEventListener('scroll', () => {
      if (navRaf) return;
      navRaf = requestAnimationFrame(() => {
        nav.classList.toggle('scrolled', scrollY > 4);
        navRaf = 0;
      });
    }, { passive: true });
  }

  // ---------- settings panel ----------

  const PRESETS = {
    anthropic: { label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5' },
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
    openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-haiku' },
    groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    together: { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
    builtin: { label: 'Built-in browser model (free, no key)', baseUrl: 'webllm://', model: 'Llama-3.2-3B-Instruct-q4f16_1-MLC' },
    ollama: { label: 'Ollama (local, free)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    lmstudio: { label: 'LM Studio (local, free)', baseUrl: 'http://localhost:1234/v1', model: 'local-model' },
    custom: { label: 'Custom endpoint', baseUrl: '', model: '' },
  };

  function detectPreset(cfg) {
    for (const [key, p] of Object.entries(PRESETS)) {
      if (p.baseUrl && cfg.baseUrl === p.baseUrl) return key;
    }
    return cfg.baseUrl ? 'custom' : 'openai';
  }

  // Standard AI disclaimer — shown on every AI-powered tool (settings bar) and
  // available as Rewiseed.aiDisclaimer() for prominent placement.
  const AI_DISCLAIMER_HTML = `<p class="hint" style="margin:10px 0 0;border-top:1px solid var(--border);padding-top:10px"><b>${'⚠️'} AI disclaimer.</b> Outputs are generated by AI and may be incomplete, biased, or wrong — including invented facts and citations. This is a drafting aid, not a source of truth or professional advice. <b>You are responsible for verifying every claim, quote, statistic, and reference before use</b>, and for meeting your institution's rules on AI assistance and academic integrity.</p>`;
  function aiDisclaimer() { return AI_DISCLAIMER_HTML; }

  function renderSettingsBar(containerId) {
    const cfg = getCfg();
    const el = $(containerId);
    if (!el) return;
    const configured = !!cfg.apiKey || isLocalUrl(cfg.baseUrl);
    const preset = detectPreset(cfg);
    el.innerHTML = `
      <details class="settings" id="settings-details">
        <summary>${icon('gear', 17)} API settings
          ${configured
            ? `<span class="badge ok">${icon('check', 12)} configured</span>`
            : `<span class="badge warn">${icon('alert', 12)} not set</span>`}
          <span class="badge" id="credit-badge" hidden></span>
        ${(() => { billingStatus().then(b => { const el = document.getElementById('credit-badge'); if (el && b.enforced && b.signedIn && typeof b.credits === 'number') { el.hidden = false; el.textContent = `${b.credits} credits`; } }); return ''; })()}
        </summary>
        <div class="settings-body">
          <div class="settings-grid">
            <label class="full">Provider
              <select id="cfg-preset">
                ${Object.entries(PRESETS).map(([k, p]) =>
                  `<option value="${k}" ${k === preset ? 'selected' : ''}>${p.label}</option>`).join('')}
              </select>
            </label>
            <label class="full">Base URL
              <input id="cfg-baseUrl" autocomplete="off" spellcheck="false" placeholder="https://api.openai.com/v1" value="${esc(cfg.baseUrl || PRESETS.openai.baseUrl)}"/>
            </label>
            <label>API key
              <span class="key-wrap">
                <input id="cfg-apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-… (stays in this browser)" value="${esc(cfg.apiKey || '')}"/>
                <button type="button" class="icon-btn" id="cfg-eye" aria-label="Show or hide API key">${icon('eye', 16)}</button>
              </span>
              <span class="hint" style="display:block;margin-top:5px;font-weight:500">${icon('shield', 11)} Session-only by default: your key is wiped when you close this tab, is sent only to your provider — never to us — and other sites can't read it. <a class="link" href="security.html">How this is protected</a></span>
            </label>
            <label>Model
              <input id="cfg-model" autocomplete="off" spellcheck="false" placeholder="gpt-4o-mini" value="${esc(cfg.model || '')}"/>
            </label>
            <label class="full" style="display:flex;align-items:center;gap:8px;flex-direction:row;cursor:pointer">
              <input type="checkbox" id="cfg-remember" ${cfg.rememberKey ? 'checked' : ''} style="width:auto;min-height:0;margin:0"/>
              <span style="font-weight:500">Remember my key on this device<span class="hint" style="display:block;font-weight:400">Off (default): the key is forgotten when this tab closes — each new visit asks for it again. On: it stays in this browser until you clear it. Leave off on shared computers.</span></span>
            </label>
          </div>
          <div class="settings-actions">
            <button id="cfg-save">${icon('check', 15)} Save settings</button>
            <button id="cfg-test" class="ghost">Test connection</button>
            <button id="cfg-clear" class="ghost" title="Remove the API key from this browser immediately — both session and remembered copies">Clear key</button>
            <span id="cfg-test-result" role="status"></span>
          </div>
          <p class="hint" style="margin:12px 0 0">Your key never leaves this browser except in requests to the endpoint above. The built-in browser model and local endpoints (Ollama, LM Studio) need no key — the built-in option downloads a ~2 GB model once (needs Chrome/Edge with WebGPU), then runs entirely on your device.</p>
          ${AI_DISCLAIMER_HTML}
        </div>
      </details>`;

    $('cfg-preset').onchange = () => {
      const p = PRESETS[$('cfg-preset').value];
      if (p.baseUrl) $('cfg-baseUrl').value = p.baseUrl;
      if (p.model) $('cfg-model').value = p.model;
    };
    $('cfg-eye').onclick = () => {
      const inp = $('cfg-apiKey');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      $('cfg-eye').innerHTML = icon(show ? 'eyeOff' : 'eye', 16);
    };
    $('cfg-save').onclick = () => {
      const remember = $('cfg-remember').checked;
      setCfg({
        baseUrl: $('cfg-baseUrl').value.trim().replace(/\/+$/, ''),
        apiKey: $('cfg-apiKey').value.trim(),
        model: $('cfg-model').value.trim(),
        rememberKey: remember,
      });
      toast(remember ? 'Settings saved — key remembered on this device' : 'Settings saved — key will be forgotten when this tab closes');
      renderSettingsBar(containerId);
      $('settings-details')?.removeAttribute('open');
      document.dispatchEvent(new CustomEvent('rewiseed:cfg-saved'));
    };
    $('cfg-clear').onclick = () => {
      clearApiKey();
      $('cfg-apiKey').value = '';
      toast('API key removed from this browser');
      renderSettingsBar(containerId);
    };
    $('cfg-test').onclick = async () => {
      const out = $('cfg-test-result');
      out.innerHTML = `<span class="spinner"></span>`;
      // test against the values currently in the form, not just saved ones
      const test = {
        baseUrl: $('cfg-baseUrl').value.trim().replace(/\/+$/, ''),
        apiKey: $('cfg-apiKey').value.trim(),
        model: $('cfg-model').value.trim(),
      };
      try {
        await callLLM({ user: 'Reply with the single word: ok', maxTokens: 5, cfgOverride: test });
        out.innerHTML = `<span class="badge ok">${icon('check', 12)} connected</span>`;
      } catch (e) {
        out.innerHTML = `<span class="badge warn">${icon('alert', 12)} ${esc(String(e.message).slice(0, 120))}</span>`;
      }
    };
  }

  function openSettings() {
    const d = $('settings-details');
    if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }

  // ---------- input validation (no word blocklist — research vocabulary is
  // legitimate; per operator decision the earlier banned-word screen was removed.
  // What remains is safety validation: hidden/control characters and length.) ----------
  const HIDDEN_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F​-‏‪-‮⁦-⁩﻿]/;
  const MOD_CAP_INPUT = 10_000;      // single-line fields
  const MOD_CAP_TEXTAREA = 200_000;  // long-form fields match the platform's run limit

  function checkText(text, cap = MOD_CAP_TEXTAREA) {
    const s = String(text ?? '');
    if (HIDDEN_CHARS_RE.test(s)) return { ok: false, word: null, message: 'Hidden or invisible control characters were found — re-paste as plain text to continue.' };
    if (s.length > cap) return { ok: false, word: null, message: `Text is ${(s.length - cap).toLocaleString()} characters over the ${cap.toLocaleString()}-character limit — please shorten it.` };
    return { ok: true };
  }
  // throwing backstop for every write path — same checker as the live guard
  function assertTextAllowed(fields) {
    for (const [label, value] of Object.entries(fields || {})) {
      const r = checkText(value);
      if (!r.ok) { const e = new Error(`${label}: ${r.message}`); e.moderation = true; throw e; }
    }
  }

  // one global guard: watches every free-text field via document-level capture
  // listeners; no per-form wiring. Flags live as-you-type, blocks Enter/submit.
  function mountModerationGuard() {
    const css = document.createElement('style');
    css.textContent = `[data-mod-flag]{outline:2px solid #b3402a !important;outline-offset:1px}
#mod-notice{position:absolute;z-index:9999;background:#b3402a;color:#fff;font-size:12.5px;font-weight:600;padding:6px 12px;border-radius:8px;max-width:340px;box-shadow:0 4px 14px rgba(0,0,0,.25);pointer-events:none}`;
    document.head.appendChild(css);
    const notice = document.createElement('div'); // portal on document.body only
    notice.id = 'mod-notice'; notice.hidden = true; notice.setAttribute('role', 'alert');
    document.body.appendChild(notice);

    // Scope: only short single-line identity fields (names) and chat inputs are
    // moderated. Long-form research content — every <textarea>, pasted documents,
    // and the AI research text — flows through untouched, because banned words
    // ("sex", "murder", "rape") are legitimate in demographics items, criminology
    // transcripts, clinical and historical research.
    const guards = (el) => el && el.tagName === 'INPUT' && ['text', 'search'].includes(el.type) && !el.dataset.modSkip;
    const capFor = () => MOD_CAP_INPUT;
    let flagged = null;

    const position = () => {
      if (!flagged || notice.hidden) return;
      const r = flagged.getBoundingClientRect();
      notice.style.left = `${Math.max(8, r.left + scrollX)}px`;
      notice.style.top = `${r.bottom + scrollY + 6}px`;
    };
    const validate = (el) => {
      if (!guards(el)) return true;
      const r = checkText(el.value, capFor(el));
      if (!r.ok) {
        el.setAttribute('data-mod-flag', '1'); el.setAttribute('aria-invalid', 'true');
        flagged = el; notice.textContent = r.message; notice.hidden = false; position();
        return false;
      }
      el.removeAttribute('data-mod-flag'); el.removeAttribute('aria-invalid');
      if (flagged === el) { flagged = null; notice.hidden = true; }
      return true;
    };
    const anyFlaggedIn = (root) => root?.querySelector?.('[data-mod-flag]') || null;

    document.addEventListener('input', (e) => validate(e.target), true);
    document.addEventListener('focusin', (e) => { if (guards(e.target)) validate(e.target); }, true);
    document.addEventListener('focusout', (e) => { if (flagged === e.target) { notice.hidden = true; } }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && guards(e.target) && !validate(e.target)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    document.addEventListener('click', (e) => {
      const btn = e.target.closest?.('button[type="submit"], input[type="submit"]');
      if (!btn) return;
      const bad = anyFlaggedIn(btn.form || btn.closest('form'));
      if (bad) { e.preventDefault(); e.stopPropagation(); flagged = bad; notice.textContent = checkText(bad.value, capFor(bad)).message; notice.hidden = false; position(); bad.focus(); }
    }, true);
    document.addEventListener('submit', (e) => {
      const bad = anyFlaggedIn(e.target);
      if (bad) { e.preventDefault(); e.stopPropagation(); bad.focus(); }
    }, true);
    addEventListener('scroll', position, true);
    addEventListener('resize', position);
  }
  if (document.body) mountModerationGuard();
  else document.addEventListener('DOMContentLoaded', mountModerationGuard);

  // ---------- billing / run metering ----------
  let _billing = null;
  async function billingStatus(force = false) {
    if (_billing && !force) return _billing;
    try { _billing = await fetch('/api/billing/status', { credentials: 'same-origin' }).then(r => r.json()); }
    catch { _billing = { enforced: false }; }
    return _billing;
  }
  // asks the server for a run credit before an AI call; throws with a helpful
  // message (and points at pricing) when the run isn't covered
  async function ensureRunCredit(chars) {
    const b = await billingStatus();
    if (!b.enforced) return;
    let r, d = {};
    try {
      r = await fetch('/api/run-credit', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chars }),
      });
      d = await r.json().catch(() => ({}));
    } catch { return; } // metering endpoint unreachable → don't strand the user
    if (r.ok) {
      if (d.metered && typeof d.remaining === 'number') { _billing.credits = d.remaining; _billing.freeRunUsed = true; updateCreditBadge(); }
      if (d.freeRun) toast('That one was on us — your free run. Enjoy!', 'ok', 5000);
      return;
    }
    if (d.reason === 'signin') { setTimeout(() => { location.href = 'signin.html'; }, 1600); }
    else if (d.reason === 'subscribe' || d.reason === 'topup') { setTimeout(() => { location.href = 'pricing.html'; }, 2200); }
    throw new Error(d.error || 'This run needs an active plan — see Pricing.');
  }
  function updateCreditBadge() {
    if (!_billing || typeof _billing.credits !== 'number') return;
    const el = document.getElementById('credit-badge');
    if (el) { el.hidden = false; el.textContent = `${_billing.credits} credits`; }
    const nav = document.getElementById('nav-credits');
    if (nav) {
      nav.hidden = false;
      nav.innerHTML = `${icon('sparkle', 13)} ${_billing.credits} credit${_billing.credits === 1 ? '' : 's'}`;
      nav.classList.toggle('empty', _billing.credits === 0);
    }
  }

  // ---------- LLM client ----------

  async function callLLM({ system, user, temperature = 0.2, maxTokens, onStream, signal, cfgOverride }) {
    // NOTE: research text is intentionally NOT moderated here — long-form academic
    // content routinely contains words banned in short identity/chat fields.
    // metering happens before any provider is contacted (including the built-in model)
    if (!cfgOverride) await ensureRunCredit((user || '').length + (system || '').length);
    const cfg = cfgOverride || getCfg();
    const baseUrl = (cfg.baseUrl || PRESETS.openai.baseUrl).replace(/\/+$/, '');
    if (isBuiltin(baseUrl)) {
      return webllmChat({ system, user, temperature, onStream, signal, model: cfg.model });
    }
    if (!cfg.apiKey && !isLocalUrl(baseUrl)) {
      openSettings();
      throw new Error('No API key set. Open “API settings” above and paste one (or point Base URL at a local model — Ollama / LM Studio need no key).');
    }
    const anthropic = isAnthropic(baseUrl);
    // catch the classic mixup: right key, wrong provider selected
    if (cfg.apiKey?.startsWith('sk-ant-') && !anthropic) {
      openSettings();
      throw new Error(`That looks like an Anthropic Claude key (sk-ant-…), but requests are going to ${baseUrl}. In API settings, pick “Anthropic (Claude)” in the Provider dropdown — it sets the Base URL to https://api.anthropic.com/v1 — then Save.`);
    }
    if (anthropic && cfg.apiKey && !cfg.apiKey.startsWith('sk-ant-')) {
      openSettings();
      throw new Error('The provider is set to Anthropic (Claude), but this key doesn’t look like an Anthropic key — they start with sk-ant-. Get one at console.anthropic.com, or switch the Provider dropdown to match your key.');
    }
    const gemini = baseUrl.includes('generativelanguage.googleapis.com');
    if (cfg.apiKey?.startsWith('AIza') && !gemini) {
      openSettings();
      throw new Error(`That looks like a Google Gemini key (AIza…), but requests are going to ${baseUrl}. In API settings, pick “Google Gemini” in the Provider dropdown, then Save.`);
    }
    if (gemini && cfg.apiKey && !cfg.apiKey.startsWith('AIza')) {
      openSettings();
      throw new Error('The provider is set to Google Gemini, but this key doesn’t look like a Google API key — they start with AIza. Get one at aistudio.google.com/apikey, or switch the Provider dropdown to match your key.');
    }
    let url, headers, body;
    if (anthropic) {
      // Anthropic Messages API: system is top-level, max_tokens is required,
      // and this header is what makes browser-direct calls allowed.
      url = `${baseUrl}/messages`;
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      };
      body = {
        model: cfg.model || 'claude-sonnet-5',
        temperature,
        stream: !!onStream,
        max_tokens: maxTokens || 4096,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: user }],
      };
    } else {
      url = `${baseUrl}/chat/completions`;
      headers = {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      };
      body = {
        model: cfg.model || 'gpt-4o-mini',
        temperature,
        stream: !!onStream,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
      };
      if (maxTokens) body.max_tokens = maxTokens;
    }

    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(isLocalUrl(baseUrl)
        ? `Could not reach ${baseUrl} — is your local model server running?`
        : `Network error reaching ${baseUrl}: ${e.message}`);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 400);
      // providers report an empty balance as 429 too — waiting doesn't fix that one
      if (/insufficient_quota|exceeded your current quota|credit balance is too low|billing/i.test(text)) {
        throw new Error(`Your ${anthropic ? 'Anthropic' : 'provider'} account is out of credits. The key is valid, but there’s no remaining balance — add credits on the provider’s billing page, or switch provider in API settings (the built-in browser model is free and needs no key).`);
      }
      let detail = text;
      try { const j = JSON.parse(text); detail = j.error?.message || j.message || text; } catch { /* not JSON */ }
      const hints = { 401: 'Check your API key.', 403: 'Key lacks access to this model.', 404: anthropic ? 'Check the model name — e.g. claude-sonnet-5.' : 'Check the Base URL — it should end in /v1.', 429: 'Rate limited — wait a moment and retry.' };
      throw new Error(`${res.status} from provider. ${hints[res.status] || ''} ${detail}`.trim().slice(0, 300));
    }
    const extract = (j) => anthropic
      ? (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
      : (j.choices?.[0]?.message?.content || '');
    if (!onStream) {
      return extract(await res.json());
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let full = '', buf = '', raw = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      raw += chunk;
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          if (anthropic && j.type === 'error') throw new Error(j.error?.message || 'Provider error mid-stream');
          const delta = anthropic
            ? (j.type === 'content_block_delta' ? (j.delta?.text || '') : '')
            : (j.choices?.[0]?.delta?.content || '');
          if (delta) { full += delta; onStream(full); }
        } catch (e) { if (anthropic && e.message && !(e instanceof SyntaxError)) throw e; /* else partial/keepalive frame */ }
      }
    }
    if (!full && raw.trim()) {
      // some providers/proxies ignore stream:true and reply with plain JSON
      try {
        full = extract(JSON.parse(raw));
        if (full) onStream(full);
      } catch { /* genuinely empty stream */ }
    }
    return full;
  }

  // ---------- markdown renderer (block-based) ----------

  function mdInline(s) {
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return s;
  }

  function md(src) {
    const lines = esc(src).split('\n');
    const out = [];
    let i = 0;
    let list = null; // { tag, items }

    const flushList = () => {
      if (list) {
        out.push(`<${list.tag}>${list.items.map(x => `<li>${x}</li>`).join('')}</${list.tag}>`);
        list = null;
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      if (/^```/.test(line)) {
        flushList();
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
        i++; // closing fence
        out.push(`<pre><code>${code.join('\n')}</code></pre>`);
        continue;
      }
      // table: header row + separator row
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flushList();
        const parseRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => mdInline(c.trim()));
        const head = parseRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(parseRow(lines[i])); i++; }
        out.push(`<div class="tbl-wrap"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
          rows.map(r => `<tr>${head.map((_, c) => `<td>${r[c] ?? ''}</td>`).join('')}</tr>`).join('')
        }</tbody></table></div>`);
        continue;
      }
      // heading
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) { flushList(); const lvl = h[1].length; out.push(`<h${lvl}>${mdInline(h[2])}</h${lvl}>`); i++; continue; }
      // hr
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushList(); out.push('<hr/>'); i++; continue; }
      // blockquote
      if (/^\s*&gt;\s?/.test(line)) {
        flushList();
        const q = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*&gt;\s?/, '')); i++; }
        out.push(`<blockquote>${q.map(mdInline).join('<br/>')}</blockquote>`);
        continue;
      }
      // unordered list item
      const ul = line.match(/^\s*[-*+]\s+(.+)$/);
      if (ul) {
        if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
        list.items.push(mdInline(ul[1])); i++; continue;
      }
      // ordered list item
      const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ol) {
        if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
        list.items.push(mdInline(ol[1])); i++; continue;
      }
      // blank line
      if (!line.trim()) { flushList(); i++; continue; }
      // paragraph (merge consecutive text lines)
      flushList();
      const para = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() &&
             !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\s*&gt;|\s*\|)/.test(lines[i + 1]) &&
             !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i + 1])) {
        para.push(lines[++i]);
      }
      out.push(`<p>${mdInline(para.join(' '))}</p>`);
      i++;
    }
    flushList();
    return out.join('\n');
  }

  // ---------- misc helpers ----------

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Saved ${filename}`);
  }

  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
    ta.remove();
    return ok;
  }

  // fire-and-forget usage metric (tool id + output size only); no-op offline
  function track(kind, outChars = 0) {
    try {
      const tool = location.pathname.replace(/^\//, '').replace(/\.html$/, '') || 'index';
      fetch('/api/track', {
        method: 'POST', keepalive: true, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, kind, outChars }),
      }).catch(() => {});
    } catch { /* offline bundle */ }
  }

  async function copyText(text, btn) {
    try {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        if (!legacyCopy(text)) throw new Error('copy blocked');
      }
      if (btn) {
        const prev = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = `${icon('check', 15)} Copied`;
        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = prev; }, 1400);
      } else {
        toast('Copied to clipboard');
      }
    } catch {
      toast('Copy failed — select and copy manually', 'error');
    }
  }

  // ---------- common streaming-tool harness ----------
  //
  // Wires up the standard page shape shared by the four generate-style
  // tools: input textarea + run/stop button + streamed markdown output
  // with copy/download, draft persistence, example loader, ⌘/Ctrl+Enter.

  function mountStreamingTool(opts) {
    const {
      toolId,            // used for draft persistence + download name
      inputId, runId, outId,
      resultTitle,       // heading shown above the stream
      downloadName,      // e.g. 'research-gaps.md'
      buildSystem,       // () => system prompt (may read page controls)
      runLabel,          // e.g. 'Identify gaps'
      runningLabel,      // e.g. 'Analysing…'
      example,           // optional example input string
      exampleBtnId,
      countId,           // optional word-count element
      next,              // optional hand-off: { href, draftKey, label, carry: 'output'|'input' }
      transformInput,    // optional (text) => ({ text, note }) applied before the LLM call (e.g. PII anonymization)
    } = opts;

    const input = $(inputId), runBtn = $(runId), out = $(outId);
    let lastOutput = '';
    let abort = null;

    // designed empty state so the output column never sits blank
    const emptyState = `
      <div class="empty-state-card">
        ${icon('sparkle', 30)}
        <span class="es-title">${esc(resultTitle)}</span>
        <p>Paste your material, press <b>${esc(runLabel)}</b>, and the analysis will stream in right here.</p>
      </div>`;
    if (!out.innerHTML.trim()) out.innerHTML = emptyState;

    // restore + persist draft
    const draftKey = LS_DRAFT_PREFIX + toolId;
    const saved = localStorage.getItem(draftKey);
    if (saved && !input.value) input.value = saved;
    let saveTimer;
    const updateCount = () => {
      if (!countId) return;
      const words = input.value.trim() ? input.value.trim().split(/\s+/).length : 0;
      $(countId).textContent = words ? `${words.toLocaleString()} words` : '';
    };
    input.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => localStorage.setItem(draftKey, input.value), 400);
      updateCount();
    });
    updateCount();

    if (opts.example && exampleBtnId && $(exampleBtnId)) {
      $(exampleBtnId).onclick = () => {
        input.value = example;
        input.dispatchEvent(new Event('input'));
        input.focus();
        toast('Example loaded — press Run');
      };
    }

    // universal Clear: wipe input, draft, and any previous result
    const chipRow = exampleBtnId && $(exampleBtnId) ? $(exampleBtnId).parentElement : null;
    if (chipRow && !$(`${toolId}-clear-chip`)) {
      chipRow.insertAdjacentHTML('beforeend', `<button type="button" class="chip" id="${toolId}-clear-chip">Clear</button>`);
      $(`${toolId}-clear-chip`).onclick = () => {
        if (abort) abort.abort();
        input.value = '';
        localStorage.removeItem(draftKey);
        input.dispatchEvent(new Event('input'));
        out.innerHTML = emptyState;
        lastOutput = '';
        toast('Cleared');
        input.focus();
      };
    }

    const setRunning = (running) => {
      if (running) {
        runBtn.innerHTML = `${icon('stop', 15)} Stop`;
        runBtn.classList.add('danger');
      } else {
        runBtn.innerHTML = `${icon('play', 15)} ${esc(runLabel)}`;
        runBtn.classList.remove('danger');
      }
    };
    setRunning(false);

    const actionsHtml = `
      <div class="row">
        <button class="ghost" id="${toolId}-copy">${icon('copy', 15)} Copy</button>
        <button class="ghost" id="${toolId}-dl">${icon('download', 15)} Download .md</button>
        ${next ? `<span class="push"></span><button id="${toolId}-next">${esc(next.label)} ${icon('arrow', 15)}</button>` : ''}
      </div>`;
    const wireNext = () => {
      if (!next || !$(`${toolId}-next`)) return;
      $(`${toolId}-next`).onclick = () => {
        const carry = next.carry === 'input' ? input.value : lastOutput;
        localStorage.setItem(next.draftKey, carry);
        toast('Sent — opening next tool');
        location.href = next.href;
      };
    };

    async function run() {
      if (abort) { abort.abort(); return; } // acting as Stop
      const text = input.value.trim();
      if (!text) { toast('Paste some input first', 'error'); input.focus(); return; }

      abort = new AbortController();
      setRunning(true);
      out.innerHTML = `
        <div class="card">
          <span class="overline">Result</span>
          <h2>${esc(resultTitle)}</h2>
          <div class="result" id="${toolId}-stream" aria-live="polite">
            <div class="stream-status"><span class="spinner"></span>${esc(runningLabel)}</div>
          </div>
        </div>`;
      const streamEl = $(`${toolId}-stream`);
      let sendText = text;
      if (transformInput) {
        const tr = transformInput(text);
        sendText = tr.text;
        if (tr.note) out.querySelector('.card').insertAdjacentHTML('afterbegin', `<p class="hint" style="margin:0 0 10px">${tr.note}</p>`);
      }
      let raf = 0, pending = '';
      const paint = () => { streamEl.innerHTML = `<div class="cursor-blink">${md(pending)}</div>`; raf = 0; };
      try {
        lastOutput = await callLLM({
          system: buildSystem(),
          user: sendText,
          temperature: 0.2,
          signal: abort.signal,
          onStream: (t) => {
            pending = t;
            if (!raf) raf = requestAnimationFrame(paint);
          },
        });
        streamEl.innerHTML = md(lastOutput);
        streamEl.insertAdjacentHTML('afterend', actionsHtml);
        $(`${toolId}-copy`).onclick = (e) => copyText(lastOutput, e.currentTarget);
        $(`${toolId}-dl`).onclick = () => downloadText(downloadName, lastOutput);
        wireNext();
        track('run', lastOutput.length);
      } catch (e) {
        if (e.name === 'AbortError') {
          if (pending) {
            lastOutput = pending;
            streamEl.innerHTML = md(pending);
            streamEl.insertAdjacentHTML('afterend', `<p class="hint">Stopped early — partial output shown.</p>${actionsHtml}`);
            $(`${toolId}-copy`).onclick = (e) => copyText(lastOutput, e.currentTarget);
            $(`${toolId}-dl`).onclick = () => downloadText(downloadName, lastOutput);
            wireNext();
          } else {
            out.innerHTML = emptyState;
          }
        } else {
          streamEl.innerHTML = `<div class="error-box">${icon('alert', 18)}<span>${esc(e.message)}</span></div>`;
        }
      } finally {
        if (raf) cancelAnimationFrame(raf);
        abort = null;
        setRunning(false);
      }
    }

    runBtn.onclick = run;
    input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (!abort) run(); }
    });
  }

  window.Rewiseed = {
    renderNav, renderSettingsBar, openSettings, billingStatus, checkText, assertTextAllowed, aiDisclaimer,
    callLLM, md, esc, icon, toast, track,
    downloadText, copyText, getCfg, clearApiKey, isLocalUrl,
    mountStreamingTool, playIntro, saveToLibrary, fetchWithTimeout,
  };
})();
