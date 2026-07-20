# ReWiseEd Research Tools

Twenty research tools spanning the full research lifecycle — discovery, design, analysis, writing, and review — that run **in your browser**. Seven are fully keyless (literature search, DOI lookup, citation graphs, scholar profiles, statistics, citation formatting); the AI tools use the free built-in browser model, your own OpenAI-compatible key, or a local model for fully offline use. Optional accounts add a saved-paper library, recommendations, and admin-managed tool access.

## The tools

| Tool | File | What it does |
|---|---|---|
| Smart Literature Finder | `smart-literature-finder.html` | Search 240M+ scholarly works via OpenAlex (keyless). Year/open-access filters, citation sorting, BibTeX export, optional AI relevance rerank. |
| DOI Finder & Lookup | `doi-finder.html` | Paste a DOI to get the full paper record (metadata, abstract, citation, BibTeX) — or paste messy references and find their DOIs via Crossref, with match-confidence checks. Keyless. |
| Originality & AI Checker | `originality-checker.html` | "The checker that shows its work": sentence-level evidence heatmap with per-sentence tooltips, three independent signal families (rhythm/vocabulary/phrasing) with an honest agreement verdict — disagreement reported as inconclusive, never hidden behind one score — free revision guidance per flagged sentence, keyless scholarly-overlap scan against OpenAlex, optional LLM forensic assessment, downloadable evidence report. Fully in-browser. |
| Abstract & Summary Studio | `abstract-generator.html` | Upload a thesis/dissertation (.docx/.pdf, parsed in-browser); generate an APA abstract + keywords, an executive summary, a 250-word conference abstract, and a plain-language summary — each grounded strictly in the document, with smart section prioritization for long theses. |
| Statistical Data Explorer | `data-explorer.html` | Search 1,500+ World Bank indicators, compare countries/years, trend chart, CSV export with provenance, APA dataset citation. Keyless; routed through a caching proxy for speed. |
| Data Source Directory | `data-sources.html` | Curated guide to official statistics (World Bank, IMF, Eurostat, OECD, UN, StatCan, ADB, JETRO, globalEDGE, US federal) with coverage and access notes. |
| Citation Graph Explorer | `citation-graph.html` | Walk a paper's citation network — references and citing works — as a clickable graph. Keyless via OpenAlex. |
| Author & Institution Profiles | `scholar-profiles.html` | Look up any researcher or institution — works, citations, h-index, affiliations, top papers. Keyless via OpenAlex. |
| Academic Writing Polisher | `writing-polisher.html` | Polish tone, tighten clarity, generate abstracts or title options — with every substantive edit explained. |
| My Library | `library.html` | Signed-in users save papers from any finder tool, add notes, export BibTeX, and send the set into the pipeline. |
| Literature Synthesis Matrix | `literature-matrix.html` | Papers side by side — aims, methods, samples, findings, limitations — plus a written synthesis of agreements, conflicts, and trends. |
| Research Gap Identifier | `research-gap-identifier.html` | Find unexplored gaps, contradictions, and methodological weaknesses in a literature set. |
| Research Question Generator | `research-question-generator.html` | Turn a topic into precise, testable research questions — each with independent, dependent, and control variables, hypotheses, and a suggested design. |
| Survey & Interview Designer | `instrument-designer.html` | Turn research questions into a survey questionnaire (proper scales, validated instruments, attention checks, pilot notes) or a semi-structured interview guide with probes. |
| AI PLS | `ai-pls.html` | Multi-method quant workbench: SmartPLS-style PLS-SEM with AI interpretation, PROCESS-style mediation (Model 4, bootstrapped indirect) & moderation (Model 1, simple slopes), and multiple regression —, fully in-browser: TAM template + auto-build from column prefixes, drag-and-drop item assignment, α/ρA/CR/AVE, outer weights, cross-loadings, Fornell–Larcker, HTMT, 5,000-resample bootstrap (custom 100–10,000), total effects, f²/VIF/R², draggable path diagram, APA write-up. Keyless; data never leaves the device. |
| Statistical Test Advisor | `stats-advisor.html` | The right statistical test per research question — assumptions with checks, non-parametric fallbacks, effect sizes, APA results templates, starter R/Python/SPSS code. |
| Qualitative Coding Assistant | `qualitative-coding-assistant.html` | Braun & Clarke reflexive thematic analysis of interview transcripts — codes, themes, thematic map. |
| RubricLens | `rubric-lens.html` | Match a draft against the assignment rubric: per-criterion band with evidence quotes from your own text, gap to the top band, and the highest-impact fixes. Accepts pasted text or .docx/.pdf/.txt uploads for both draft and rubric (parsed fully in-browser). Three grader personas. |
| Peer Review Simulator | `peer-review-simulator.html` | Structured peer review with selectable reviewer temperament (constructive → adversarial) and a recommendation. |
| Citation Formatter | `citation-formatter.html` | Precise keyless mode: DOI-match each reference and render Crossref's official citation (APA 7 / MLA 9 / Chicago / Harvard / IEEE / Vancouver) — exact, never invented. AI mode covers DOI-less references. |
| Reference Style Generator | `apa-formatter.html` | Upload a `.docx` (parsed fully in-browser — no upload to any server) or paste text; download a formatted Word document in APA 7, MLA 9, Chicago 17 (author–date), Harvard, Vancouver/ICMJE, or IEEE — each with its own title page/first-page header, page-number style, and reference-list conventions (hanging indent or numbered). Optional AI pass rewrites in-text citations and the reference list to match the chosen style exactly. |

## How to use

1. Unzip the folder anywhere and double-click `index.html` (or any tool page).
2. Open **API settings** and pick a provider:
   - **Built-in browser model — free, no key**: downloads an open model (~2 GB) once via WebGPU (Chrome/Edge), then everything runs on your device
   - **Anthropic (Claude)** — `https://api.anthropic.com/v1` (e.g. `claude-sonnet-5`; key from console.anthropic.com, calls go directly from your browser)
   - **OpenAI** — `https://api.openai.com/v1` (e.g. `gpt-4o-mini`)
   - **Google Gemini** — `https://generativelanguage.googleapis.com/v1beta/openai` (e.g. `gemini-2.5-flash`; key from aistudio.google.com/apikey)
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
- The only network traffic is to the LLM endpoint you configure and, for the keyless tools, the free `api.openalex.org` and `api.crossref.org` scholarly indexes.
- Clear everything any time via **API settings** or devtools → Application → Local Storage.

## Offline / air-gapped use

Point the Base URL at a local model (Ollama or LM Studio) and the whole suite runs with zero external traffic. The bundle itself has no external asset dependencies — pure HTML/CSS/JS with system fonts.

## Files

```
index.html                        landing page
shared.css                        design system (light + dark)
shared.js                         LLM client · settings · markdown renderer · tool harness
smart-literature-finder.html
doi-finder.html
research-gap-identifier.html
qualitative-coding-assistant.html
peer-review-simulator.html
citation-formatter.html
```

No `node_modules`, no build. Edit any `.html` in a text editor to customise the prompts.
