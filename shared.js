// Shared helpers for Rewiseed offline research tools (BYOK)
// Stores API config in localStorage, calls an OpenAI-compatible /chat/completions endpoint.
// Works with OpenAI, OpenRouter, Groq, Together, Ollama (http://localhost:11434/v1), LM Studio, etc.

const LS_KEY = 'rewiseed_offline_llm_cfg_v1';

function getCfg() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}
function setCfg(cfg) { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); }

function renderSettingsBar(containerId) {
  const cfg = getCfg();
  const el = document.getElementById(containerId);
  el.innerHTML = `
    <details class="settings">
      <summary>⚙️ API settings ${cfg.apiKey ? '<span class="ok">✓ configured</span>' : '<span class="warn">⚠ not set</span>'}</summary>
      <div class="settings-grid">
        <label>Base URL
          <input id="cfg-baseUrl" placeholder="https://api.openai.com/v1" value="${cfg.baseUrl || 'https://api.openai.com/v1'}"/>
        </label>
        <label>API Key
          <input id="cfg-apiKey" type="password" placeholder="sk-... (stored locally)" value="${cfg.apiKey || ''}"/>
        </label>
        <label>Model
          <input id="cfg-model" placeholder="gpt-4o-mini" value="${cfg.model || 'gpt-4o-mini'}"/>
        </label>
        <button id="cfg-save">Save</button>
      </div>
      <p class="hint">Your key stays in this browser (localStorage). Works with OpenAI, OpenRouter, Groq, Together, Ollama (http://localhost:11434/v1), LM Studio, etc.</p>
    </details>`;
  document.getElementById('cfg-save').onclick = () => {
    setCfg({
      baseUrl: document.getElementById('cfg-baseUrl').value.trim().replace(/\/$/, ''),
      apiKey: document.getElementById('cfg-apiKey').value.trim(),
      model: document.getElementById('cfg-model').value.trim() || 'gpt-4o-mini',
    });
    renderSettingsBar(containerId);
  };
}

async function callLLM({ system, user, temperature = 0.2, onStream }) {
  const cfg = getCfg();
  if (!cfg.apiKey) throw new Error('No API key set — open ⚙️ API settings and paste one.');
  const url = `${cfg.baseUrl || 'https://api.openai.com/v1'}/chat/completions`;
  const body = {
    model: cfg.model || 'gpt-4o-mini',
    temperature,
    stream: !!onStream,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  if (!onStream) {
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let full = '', buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
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
      } catch {}
    }
  }
  return full;
}

// Minimal markdown renderer (headings, bold, italics, code, lists, links)
function md(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let s = esc(src);
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>[\s\S]+?<\/li>)/g, '<ul>$1</ul>');
  s = s.replace(/\n{2,}/g, '</p><p>');
  return `<p>${s}</p>`;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}

window.Rewiseed = { renderSettingsBar, callLLM, md, downloadText, getCfg };