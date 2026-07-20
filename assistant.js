// ReWiseEd Assistant — RAG chatbot grounded in kb.json.
// With an AI key: retrieval-augmented streamed answers restricted to
// retrieved context, with citations and an explicit "not in my docs" path.
// Without a key: extractive answers straight from the knowledge base —
// zero generation, zero hallucination.
(function () {
  'use strict';
  if (!window.Rewiseed) return;
  const { icon, esc, md, toast } = window.Rewiseed;

  let KB = null, panel = null, open = false;
  const HISTORY_KEY = 'rewiseed_assistant_history';

  // ---------- retrieval (lexical tf-idf) ----------
  const STOP = new Set('the a an and or of to in on for with by is are was were be been do does how what which who can i my your it its as at from this that these those you we they not no about use using'.split(' '));
  const tokens = (t) => (String(t).toLowerCase().match(/[a-z0-9']+/g) || []).filter(w => w.length > 2 && !STOP.has(w));

  function retrieve(query, k = 5) {
    const q = [...new Set(tokens(query))];
    if (!q.length) return [];
    const N = KB.length;
    const scored = KB.map(chunk => {
      const body = tokens(chunk.text);
      const title = tokens(chunk.title);
      let score = 0;
      for (const term of q) {
        const tf = body.filter(w => w === term || w.startsWith(term)).length;
        const inTitle = title.some(w => w === term || w.startsWith(term));
        if (!tf && !inTitle) continue;
        const df = KB.filter(c => tokens(c.title + ' ' + c.text).some(w => w === term || w.startsWith(term))).length;
        const idf = Math.log(1 + N / (df || 1));
        score += (tf * idf) + (inTitle ? 3 * idf : 0);
      }
      return { chunk, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(x => x.chunk);
  }

  const SYS = `You are the ItsMyResearch assistant. Answer questions about the platform using ONLY the documentation excerpts provided in the user message. Hard rules:
- If the excerpts do not contain the answer, reply exactly: "That's not covered in my documentation." — optionally pointing to the closest relevant page. Never guess or invent features, prices, limits, or behavior.
- Never mention features, tools, or policies that are not in the excerpts.
- Be concise (2-6 sentences or a short list). Cite the source pages you used at the end as markdown links, e.g. [Privacy](/privacy).
- If asked for opinions, comparisons with competitors, or anything beyond the platform docs, say that you only answer questions about ItsMyResearch.`;

  // ---------- UI ----------
  function mount() {
    const btn = document.createElement('button');
    btn.id = 'assistant-fab';
    btn.setAttribute('aria-label', 'Ask the ItsMyResearch assistant');
    btn.innerHTML = icon('chat', 22);
    btn.onclick = toggle;
    document.body.appendChild(btn);
  }

  function panelHtml() {
    return `
      <div class="asst-head">
        <span class="asst-title">${icon('chat', 16)} Ask ItsMyResearch</span>
        <span class="badge gold" title="Answers come only from the platform documentation">grounded</span>
        <span style="flex:1"></span>
        <button type="button" class="icon-btn" id="asst-clear" aria-label="Clear conversation">${icon('stop', 14)}</button>
        <button type="button" class="icon-btn" id="asst-close" aria-label="Close assistant">✕</button>
      </div>
      <div class="asst-msgs" id="asst-msgs" aria-live="polite"></div>
      <div class="asst-suggest" id="asst-suggest"></div>
      <form class="asst-form" id="asst-form">
        <input id="asst-in" autocomplete="off" placeholder="Ask about tools, privacy, accounts…" maxlength="400"/>
        <button type="submit" aria-label="Send">${icon('arrow', 16)}</button>
      </form>`;
  }

  const SUGGESTIONS = ['Which tools work without an API key?', 'Is my document uploaded anywhere?', 'How do admins restrict tool access?', 'What does the APA formatter do?'];

  function toggle() {
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'assistant-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'ItsMyResearch assistant');
      panel.innerHTML = panelHtml();
      document.body.appendChild(panel);
      panel.querySelector('#asst-close').onclick = toggle;
      panel.querySelector('#asst-clear').onclick = () => { sessionStorage.removeItem(HISTORY_KEY); msgsEl().innerHTML = ''; greet(); };
      panel.querySelector('#asst-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) toggle(); });
      restore();
    }
    open = !open;
    panel.classList.toggle('on', open);
    document.getElementById('assistant-fab').classList.toggle('open', open);
    if (open) panel.querySelector('#asst-in').focus();
  }

  const msgsEl = () => panel.querySelector('#asst-msgs');
  function addMsg(who, html) {
    const div = document.createElement('div');
    div.className = 'asst-msg ' + who;
    div.innerHTML = html;
    msgsEl().appendChild(div);
    msgsEl().scrollTop = msgsEl().scrollHeight;
    return div;
  }
  function persist() {
    try { sessionStorage.setItem(HISTORY_KEY, msgsEl().innerHTML.slice(0, 100_000)); } catch {}
  }
  function greet() {
    addMsg('bot', `<p>Hi — I answer questions about ItsMyResearch, strictly from the platform documentation. If I don't know, I'll say so rather than guess.</p>`);
    renderSuggestions();
  }
  function renderSuggestions() {
    panel.querySelector('#asst-suggest').innerHTML = SUGGESTIONS.map(s => `<button type="button" class="chip">${esc(s)}</button>`).join('');
    panel.querySelectorAll('#asst-suggest .chip').forEach(c => c.onclick = () => { panel.querySelector('#asst-in').value = c.textContent; send(); });
  }
  function restore() {
    const h = sessionStorage.getItem(HISTORY_KEY);
    if (h) { msgsEl().innerHTML = h; renderSuggestions(); msgsEl().scrollTop = msgsEl().scrollHeight; }
    else greet();
  }

  async function ensureKb() {
    if (KB) return true;
    try { KB = await fetch('/kb.json').then(r => r.json()); return Array.isArray(KB); }
    catch { return false; }
  }

  let busy = false;
  async function send() {
    if (busy) return;
    const inp = panel.querySelector('#asst-in');
    const q = inp.value.trim();
    if (!q) return;
    inp.value = '';
    panel.querySelector('#asst-suggest').innerHTML = '';
    addMsg('user', `<p>${esc(q)}</p>`);
    busy = true;
    const thinking = addMsg('bot', `<div class="stream-status"><span class="spinner"></span>Checking the docs…</div>`);
    try {
      if (!await ensureKb()) throw new Error('Documentation is unavailable right now.');
      const hits = retrieve(q);
      if (!hits.length) {
        thinking.innerHTML = `<p>That's not covered in my documentation — I only answer questions about ItsMyResearch. Try asking about the tools, privacy, accounts, or admin features.</p>`;
      } else {
        const cfg = window.Rewiseed.getCfg();
        const hasAI = cfg.apiKey || window.Rewiseed.isLocalUrl(cfg.baseUrl);
        if (hasAI) {
          const context = hits.map((h, i) => `[${i + 1}] ${h.title} (${h.url})\n${h.text}`).join('\n\n');
          let raf = 0, pending = '';
          const paint = () => { thinking.innerHTML = md(pending); msgsEl().scrollTop = msgsEl().scrollHeight; raf = 0; };
          const out = await window.Rewiseed.callLLM({
            system: SYS,
            user: `Documentation excerpts:\n\n${context}\n\nQuestion: ${q}`,
            temperature: 0,
            onStream: (t) => { pending = t; if (!raf) raf = requestAnimationFrame(paint); },
          });
          if (raf) cancelAnimationFrame(raf);
          thinking.innerHTML = md(out);
        } else {
          // extractive mode: verbatim docs, zero generation
          thinking.innerHTML = `<p class="asst-note">${icon('check', 12)} From the documentation (add an AI key in any tool's API settings for conversational answers):</p>` +
            hits.slice(0, 2).map(h => `<div class="asst-extract"><b>${esc(h.title)}</b><p>${esc(h.text)}</p><a class="link" href="${esc(h.url)}">Open ${esc(h.title)} ${icon('external', 11)}</a></div>`).join('');
        }
        thinking.insertAdjacentHTML('beforeend', `<div class="asst-sources">Sources: ${hits.map(h => `<a href="${esc(h.url)}">${esc(h.title)}</a>`).join(' · ')}</div>`);
      }
    } catch (e) {
      thinking.innerHTML = `<div class="error-box">${icon('alert', 16)}<span>${esc(e.message)}</span></div>`;
    } finally {
      busy = false;
      persist();
      msgsEl().scrollTop = msgsEl().scrollHeight;
      try { fetch('/api/track', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'assistant', kind: 'run', outChars: 0 }) }).catch(() => {}); } catch {}
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
