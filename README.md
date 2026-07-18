# Rewiseed Research Tools — Offline Bundle

Five standalone HTML apps that run **entirely in your browser**. No server, no build step, no login. Your API key is stored in your browser's `localStorage` only.

## What's inside

| Tool | File | What it does |
|---|---|---|
| 🔎 Smart Literature Finder | `smart-literature-finder.html` | Search 240M+ scholarly works via OpenAlex (keyless). Optional AI relevance rerank. |
| 🕳️ Research Gap Identifier | `research-gap-identifier.html` | Find unexplored gaps, contradictions, methodological weaknesses. |
| 🧬 Qualitative Coding Assistant | `qualitative-coding-assistant.html` | Braun & Clarke thematic analysis of interview transcripts. |
| 🎓 Peer Review Simulator | `peer-review-simulator.html` | Structured peer review with major/minor concerns and recommendation. |
| 📚 Citation Formatter | `citation-formatter.html` | Convert messy references into APA / MLA / Chicago / Harvard / IEEE / Vancouver. |

## How to use

1. Unzip the folder anywhere on your computer.
2. Double-click `index.html` (or any tool `.html`). It opens in your browser.
3. Click **⚙️ API settings** and paste an OpenAI-compatible API key. Supported:
   - **OpenAI** — `https://api.openai.com/v1`, model e.g. `gpt-4o-mini`
   - **OpenRouter** — `https://openrouter.ai/api/v1`, any model slug
   - **Groq** — `https://api.groq.com/openai/v1`, e.g. `llama-3.3-70b-versatile`
   - **Together / DeepInfra / Fireworks** — their `/v1` endpoints
   - **Local (free)** — Ollama at `http://localhost:11434/v1` with e.g. `llama3.1`, or LM Studio at `http://localhost:1234/v1`
4. Paste input, click the action button, get streamed output. Download as `.md` when done.

> Smart Literature Finder works **without** any API key — search is powered by OpenAlex directly. AI reranking is optional.

## Privacy

- No analytics, no telemetry, no external servers other than your chosen LLM provider and (for the finder) `api.openalex.org`.
- Your API key never leaves your browser except in the LLM request itself.
- Clear it any time in **⚙️ API settings** or via browser devtools → Application → Local Storage.

## Offline / air-gapped use

Point the Base URL at a **local model** (Ollama or LM Studio) to run fully offline. The bundle itself has no external asset dependencies — pure HTML/CSS/JS.

## Files

```
index.html            ← landing page
shared.css            ← shared styles
shared.js             ← shared LLM client + settings + markdown renderer
smart-literature-finder.html
research-gap-identifier.html
qualitative-coding-assistant.html
peer-review-simulator.html
citation-formatter.html
```

No `node_modules`, no build. Edit any `.html` in a text editor to customise prompts.