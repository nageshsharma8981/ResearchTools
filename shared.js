// ============================================================
// ReWiseEd Research Tools — shared runtime
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

  function getCfg() {
    try { return JSON.parse(localStorage.getItem(LS_CFG) || '{}'); } catch { return {}; }
  }
  function setCfg(cfg) { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); }

  function isLocalUrl(u) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(u || '');
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
    { href: 'smart-literature-finder.html', icon: 'search', name: 'Smart Literature Finder' },
    { href: 'doi-finder.html', icon: 'doi', name: 'DOI Finder & Lookup' },
    { href: 'research-gap-identifier.html', icon: 'gap', name: 'Research Gap Identifier' },
    { href: 'qualitative-coding-assistant.html', icon: 'dna', name: 'Qualitative Coding Assistant' },
    { href: 'peer-review-simulator.html', icon: 'grad', name: 'Peer Review Simulator' },
    { href: 'citation-formatter.html', icon: 'book', name: 'Citation Formatter' },
  ];

  function renderNav(activeHref) {
    const nav = document.createElement('nav');
    nav.className = 'topnav';
    nav.innerHTML = `
      <a class="brand" href="index.html">${icon('logo', 22)}<span>ReWiseEd Research</span></a>
      <div class="spacer"></div>
      <details class="tool-menu">
        <summary aria-label="Switch tool">Tools ${icon('chevron', 15)}</summary>
        <div class="menu">
          ${TOOLS.map(t => `<a href="${t.href}" class="${t.href === activeHref ? 'active' : ''}">${icon(t.icon, 17)}${esc(t.name)}</a>`).join('')}
        </div>
      </details>
      <button id="theme-toggle" class="icon-btn" aria-label="Toggle theme"></button>`;
    document.body.prepend(nav);
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
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.5-haiku' },
    groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
    together: { label: 'Together AI', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
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
            </label>
            <label>Model
              <input id="cfg-model" autocomplete="off" spellcheck="false" placeholder="gpt-4o-mini" value="${esc(cfg.model || '')}"/>
            </label>
          </div>
          <div class="settings-actions">
            <button id="cfg-save">${icon('check', 15)} Save settings</button>
            <button id="cfg-test" class="ghost">Test connection</button>
            <span id="cfg-test-result" role="status"></span>
          </div>
          <p class="hint" style="margin:12px 0 0">Your key never leaves this browser except in requests to the endpoint above. Local endpoints (Ollama, LM Studio) need no key.</p>
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
      setCfg({
        baseUrl: $('cfg-baseUrl').value.trim().replace(/\/+$/, ''),
        apiKey: $('cfg-apiKey').value.trim(),
        model: $('cfg-model').value.trim(),
      });
      toast('Settings saved');
      renderSettingsBar(containerId);
      $('settings-details')?.removeAttribute('open');
      document.dispatchEvent(new CustomEvent('rewiseed:cfg-saved'));
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

  // ---------- LLM client ----------

  async function callLLM({ system, user, temperature = 0.2, maxTokens, onStream, signal, cfgOverride }) {
    const cfg = cfgOverride || getCfg();
    const baseUrl = (cfg.baseUrl || PRESETS.openai.baseUrl).replace(/\/+$/, '');
    if (!cfg.apiKey && !isLocalUrl(baseUrl)) {
      openSettings();
      throw new Error('No API key set. Open “API settings” above and paste one (or point Base URL at a local model — Ollama / LM Studio need no key).');
    }
    const body = {
      model: cfg.model || 'gpt-4o-mini',
      temperature,
      stream: !!onStream,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
    };
    if (maxTokens) body.max_tokens = maxTokens;

    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error(isLocalUrl(baseUrl)
        ? `Could not reach ${baseUrl} — is your local model server running?`
        : `Network error reaching ${baseUrl}: ${e.message}`);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      const hints = { 401: 'Check your API key.', 403: 'Key lacks access to this model.', 404: 'Check the Base URL — it should end in /v1.', 429: 'Rate limited — wait a moment and retry.' };
      throw new Error(`${res.status} from provider. ${hints[res.status] || ''} ${text}`.trim());
    }
    if (!onStream) {
      const j = await res.json();
      return j.choices?.[0]?.message?.content || '';
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
          const delta = JSON.parse(data).choices?.[0]?.delta?.content || '';
          if (delta) { full += delta; onStream(full); }
        } catch { /* partial/keepalive frame */ }
      }
    }
    if (!full && raw.trim()) {
      // some providers/proxies ignore stream:true and reply with plain JSON
      try {
        const j = JSON.parse(raw);
        full = j.choices?.[0]?.message?.content || '';
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
    } = opts;

    const input = $(inputId), runBtn = $(runId), out = $(outId);
    let lastOutput = '';
    let abort = null;

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
      </div>`;

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
      let raf = 0, pending = '';
      const paint = () => { streamEl.innerHTML = `<div class="cursor-blink">${md(pending)}</div>`; raf = 0; };
      try {
        lastOutput = await callLLM({
          system: buildSystem(),
          user: text,
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
      } catch (e) {
        if (e.name === 'AbortError') {
          if (pending) {
            lastOutput = pending;
            streamEl.innerHTML = md(pending);
            streamEl.insertAdjacentHTML('afterend', `<p class="hint">Stopped early — partial output shown.</p>${actionsHtml}`);
            $(`${toolId}-copy`).onclick = (e) => copyText(lastOutput, e.currentTarget);
            $(`${toolId}-dl`).onclick = () => downloadText(downloadName, lastOutput);
          } else {
            out.innerHTML = '';
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
    renderNav, renderSettingsBar, openSettings,
    callLLM, md, esc, icon, toast,
    downloadText, copyText, getCfg, isLocalUrl,
    mountStreamingTool,
  };
})();
