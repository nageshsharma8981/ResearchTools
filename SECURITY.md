# ItsMyResearch — Security & Safety Policy

This is the platform's working security policy: what is enforced, where, and —
just as important — what the original enterprise-style checklist would demand
that we deliberately adapt or decline, and why. The guiding fact: **this is a
browser-first application.** Research content (documents, transcripts, data)
is processed in the user's browser and never uploaded to our server, which
eliminates entire attack classes server-side scanning exists to mitigate.

## 1. Input validation (server)

Every API field is length-capped and sanitized (`cap()`): C0 control
characters (except newline/tab), zero-width characters, and Unicode bidi
override marks are stripped — the character classes used in spoofing and
log-injection attacks. Emails are format-validated and lowercased (max 254).
Profile links must be `https://` (no `javascript:`/`data:` schemes can ever
be stored). Numbers are clamped (`outChars` 0–2M). Enums are allow-listed
(tool ids, event kinds, roles). JSON bodies are capped at 500 KB and an
oversize body returns a clean 413. The statistics proxy accepts only https
URLs on a host allow-list (World Bank/Eurostat/OECD) — no internal addresses,
no other schemes — closing SSRF.

**Adapted from the checklist:** blanket rejection of "prompt-injection
phrases" ("ignore previous instructions" etc.) is deliberately NOT applied to
research content — researchers legitimately analyze documents *about* prompt
injection, and phrase blocklists are trivially bypassed while breaking real
use. Instead, tool prompts treat uploaded content strictly as data (grounding
rules, refusal paths, no-fabrication rules), which is the defense that
actually works.

## 2. Files & uploads

The server accepts exactly one file-like object: the profile photo, as a
data-URL ≤300 KB that must declare PNG/JPEG/WebP **and** match on magic
bytes. Everything else — .docx, .pdf, .txt, .md, CSV — is parsed entirely
in the browser and never transmitted; there is nothing server-side to scan,
store, or leak. Client-side parsers enforce a 25 MB input cap and an 80 MB
decompressed-XML cap (zip-bomb protection for .docx); PDF parsing is
text-extraction only (no JS execution, no external fetches). SVG/HTML are
never accepted as inputs anywhere.

**Not applicable by design:** malware scanning, signed storage URLs, and
upload buckets — there are no stored user files.

## 3. AI guardrails

BYOK: keys live in the user's browser only and requests go browser→provider
directly; the server never sees keys or content. Tool prompts are grounded
("only from the document", `[missing]`/`[not stated]` markers, no invented
citations, verbatim-quote requirements). The RAG assistant answers only from
kb.json with an explicit refusal path. The Qualitative Coding Assistant
anonymizes participant PII in-browser before any provider call (on by
default). StatPLS's interpretation sends aggregate statistics only, never raw
data. Usage telemetry records tool id + output size — never content. Server
logs never contain passwords, tokens, or document content.

## 4. Output & rendering

The markdown renderer HTML-escapes ALL input before building markup — raw
HTML in model output renders as text. Generated links allow only http(s) and
carry `rel="noreferrer"`/`noopener`. No `dangerouslySetInnerHTML`-equivalent
is used with unescaped user/model content. Enforced by CSP as defense in
depth: `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
`frame-ancestors 'none'`. (`script-src` retains `'unsafe-inline'` because the
suite ships as no-build inline-script pages, and `'wasm-unsafe-eval'` +
`worker-src blob:` for the built-in WebLLM model; `connect-src` allows https
broadly because BYOK users choose their own provider endpoints. These are
documented trade-offs, not oversights.)

## 5. Transport, session, auth

HTTPS everywhere with HSTS in production; scrypt password hashing with
per-user salts and timing-safe comparison; session tokens stored as SHA-256
hashes; httpOnly/SameSite=Lax/Secure cookies; CSRF origin checks on all
state-changing requests; rate limits on every auth endpoint (per-IP and
per-account) plus tracking/proxy routes; server-verified single-attempt
captcha with one-time tokens; anti-enumeration on signup/reset/resend
(identical responses and hash timing); email confirmation with 24 h
single-use tokens; all sessions revoked on password change/reset.
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: same-origin`, `Permissions-Policy` denying
camera/mic/geolocation/payment, `Cross-Origin-Opener-Policy: same-origin`.

## 6. Privacy & compliance

Minimum collection (email, name, optional profile); consent recorded with
terms version + timestamp at signup; self-service account deletion (full
cascade) and per-item library deletion; uploads are never retained because
they are never received; the only third parties are the user's chosen AI
provider (disclosed, direct from browser), Resend (transactional email),
OpenAlex/Crossref (public scholarly queries), and the statistics proxy
(public query parameters only) — all named in the Privacy Policy.

## 7. Failure mode

Fail closed and quiet: a global error handler returns generic messages
(413 "Request too large", 500 "Something went wrong on our side") and logs
details server-side only; unknown API routes return clean JSON 404s; the
tool-access gate denies before serving; user-facing errors state what was
blocked and the compliant alternative (e.g., file-size messages name the
limit and suggest pasting text) without exposing internals, stack traces, or
infrastructure names.

## Closed audit items (iteration 2)

- **Built-in model under CSP** — verified in production: module import,
  CDN weight fetch, and worker/WASM setup run with zero CSP violations.
- **Per-user write rate limits** — profile updates (30/15 min) and library
  saves (120/15 min) now rate-limited per account, alongside the existing
  per-IP limits on auth, tracking, and proxy routes.
- **Archives** — the only archive ever opened is .docx, in the browser, with
  a 25 MB input cap and an 80 MB decompressed guard; password-protected or
  corrupt archives fail closed with a plain-language error.
- **Session upload totals** — N/A: no session uploads exist server-side; the
  single photo endpoint is size-capped, format-sniffed, and rate-limited.
- **Output filtering** — model output renders through an escape-first
  markdown pipeline (no HTML execution possible), stack traces never reach
  clients, and secrets can't echo because the server never possesses user
  keys or content. A regex "PII detector" over model output was considered
  and rejected: high false-positive cost on research text, no added control.
- **DPA disclosure** — the Privacy Policy now states explicitly that BYOK
  processing happens under the user's own provider agreement, that
  ItsMyResearch is not a party to it, and that DPA-requiring institutions
  should contract with their provider or use the local/built-in models.

## Standing review triggers

Re-review this policy when: any user file starts being stored server-side;
any new proxy host is added; authentication changes; or a report arrives at
the contact address. Last full review: 2026-07-20.
