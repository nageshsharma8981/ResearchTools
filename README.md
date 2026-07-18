# Rewiseed Research Tools

Five standalone research tools that run **entirely in your browser**. No server, no build step, no account, no tracking. Bring your own OpenAI-compatible API key — or run a free local model and stay fully offline.

## The tools

| Tool | File | What it does |
|---|---|---|
| Smart Literature Finder | `smart-literature-finder.html` | Search 240M+ scholarly works via OpenAlex (keyless). Year/open-access filters, citation sorting, BibTeX export, optional AI relevance rerank. |
| Research Gap Identifier | `research-gap-identifier.html` | Find unexplored gaps, contradictions, and methodological weaknesses in a literature set. |
| Qualitative Coding Assistant | `qualitative-coding-assistant.html` | Braun & Clarke reflexive thematic analysis of interview transcripts — codes, themes, thematic map. |
| Peer Review Simulator | `peer-review-simulator.html` | Structured peer review with selectable reviewer temperament (constructive → adversarial) and a recommendation. |
| Citation Formatter | `citation-formatter.html` | Convert messy references into APA 7 / MLA 9 / Chicago / Harvard / IEEE / Vancouver. |

## How to use

1. Unzip the folder anywhere and double-click `index.html` (or any tool page).
2. Open **API settings**, pick a provider preset, and paste a key:
   - **OpenAI** — `https://api.openai.com/v1` (e.g. `gpt-4o-mini`)
   - **OpenRouter** — `https://openrouter.ai/api/v1` (any model slug)
   - **Groq** — `https://api.groq.com/openai/v1` (e.g. `llama-3.3-70b-versatile`)
   - **Together / DeepInfra / Fireworks** — their `/v1` endpoints
   - **Local, free, no key** — Ollama (`http://localhost:11434/v1`) or LM Studio (`http://localhost:1234/v1`)
3. Use **Test connection** to confirm the endpoint works.
4. Paste your material, press the action button (or **⌘/Ctrl+Enter**), watch the analysis stream in, then **Copy** or **Download .md**.

The Literature Finder works **without any key** — search is powered directly by OpenAlex. Only the optional AI rerank uses your key.

## Features

- **Light & dark mode** — follows your system, toggleable, remembered.
- **Streaming output** with a live cursor, and a **Stop** button that keeps partial output.
- **Draft persistence** — inputs are saved locally as you type, so a closed tab loses nothing.
- **Example inputs** on every tool to try it in one click.
- **Full Markdown rendering** — tables, numbered lists, blockquotes, code blocks.
- **Friendly errors** — every failure states the cause and how to fix it.

## Privacy

- No analytics, no telemetry, no external assets, no backend.
- Your API key and drafts live only in this browser's `localStorage`.
- The only network traffic is to the LLM endpoint you configure and (for the finder) `api.openalex.org`.
- Clear everything any time via **API settings** or devtools → Application → Local Storage.

## Offline / air-gapped use

Point the Base URL at a local model (Ollama or LM Studio) and the whole suite runs with zero external traffic. The bundle itself has no external asset dependencies — pure HTML/CSS/JS with system fonts.

## Files

```
index.html                        landing page
shared.css                        design system (light + dark)
shared.js                         LLM client · settings · markdown renderer · tool harness
smart-literature-finder.html
research-gap-identifier.html
qualitative-coding-assistant.html
peer-review-simulator.html
citation-formatter.html
```

No `node_modules`, no build. Edit any `.html` in a text editor to customise the prompts.
