// ============================================================
// ItsMyResearch — application server
// Static suite + accounts: signup w/ email confirmation,
// drag-to-match captcha, sessions, roles (superadmin/admin/student),
// profiles, org-scoped user management.
// ============================================================
'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'ItsMyResearch <noreply@rewiseed.com>';
const SUPERADMINS = (process.env.SUPERADMINS || 'nagesh@rewiseed.com,johann@rewiseed.com')
  .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const IS_PROD = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'rewiseed.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student',
  org TEXT NOT NULL DEFAULT '',
  confirmed INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  photo TEXT NOT NULL DEFAULT '',
  linkedin TEXT NOT NULL DEFAULT '',
  twitter TEXT NOT NULL DEFAULT '',
  about TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_allow (
  value TEXT PRIMARY KEY, kind TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  added_by TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL
);
`);
// migrations for pre-existing databases
for (const col of ["terms_version TEXT NOT NULL DEFAULT ''", 'terms_accepted_at INTEGER NOT NULL DEFAULT 0', "tool_access TEXT NOT NULL DEFAULT ''", 'seen_intro INTEGER NOT NULL DEFAULT 0',
  // billing
  "plan TEXT NOT NULL DEFAULT 'free'", "plan_status TEXT NOT NULL DEFAULT ''", 'credits INTEGER NOT NULL DEFAULT 0', 'credits_reset_at INTEGER NOT NULL DEFAULT 0',
  'free_run_used INTEGER NOT NULL DEFAULT 0', 'free_reset_at INTEGER NOT NULL DEFAULT 0', "rzp_customer_id TEXT NOT NULL DEFAULT ''", "rzp_subscription_id TEXT NOT NULL DEFAULT ''",
  'credits_reminded_at INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch { /* already present */ }
}
db.exec(`CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  rzp_payment_id TEXT UNIQUE NOT NULL,
  rzp_ref TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);`);
db.exec(`CREATE TABLE IF NOT EXISTS library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  doi TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '',
  year INTEGER,
  venue TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_library_user ON library(user_id);`);
db.exec(`CREATE TABLE IF NOT EXISTS journal_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ms_id TEXT UNIQUE NOT NULL,
  author_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  abstract TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  track TEXT NOT NULL DEFAULT '',
  authors_meta TEXT NOT NULL DEFAULT '',
  manuscript TEXT NOT NULL DEFAULT '',
  cover_letter TEXT NOT NULL DEFAULT '',
  declarations TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted',
  editor_id INTEGER,
  decision_note TEXT NOT NULL DEFAULT '',
  volume INTEGER, issue INTEGER, published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jsub_author ON journal_submissions(author_id);
CREATE TABLE IF NOT EXISTS journal_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  reviewer_id INTEGER NOT NULL,
  scores TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT '',
  comments_author TEXT NOT NULL DEFAULT '',
  comments_editor TEXT NOT NULL DEFAULT '',
  coi TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'invited',
  invited_at INTEGER NOT NULL,
  submitted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jrev_sub ON journal_reviews(submission_id);
CREATE INDEX IF NOT EXISTS idx_jrev_reviewer ON journal_reviews(reviewer_id);
`);
try { db.exec("ALTER TABLE journal_submissions ADD COLUMN doi TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  tool TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'run',
  out_chars INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);`);
const TERMS_VERSION = '2026-07-18';

// tool ids = page filenames without .html
const TOOL_IDS = new Set([
  'smart-literature-finder', 'doi-finder', 'originality-checker',
  'research-gap-identifier', 'research-question-generator', 'instrument-designer',
  'qualitative-coding-assistant', 'ai-peer-review', 'citation-formatter', 'apa-formatter',
  'stats-advisor', 'literature-matrix', 'writing-polisher', 'citation-graph',
  'data-explorer', 'data-sources', 'scholar-profiles', 'statpls', 'rubric-lens',
  'abstract-generator', 'paper-generator', 'bibliometrics', 'journal-metrics', 'journal-rankings',
  'citation-integrity', 'author-impact', 'paper-qa', 'data-qa',
]);
// things that report usage but are not grantable/gateable pages
const TRACKABLE = new Set([...TOOL_IDS, 'assistant', 'library']);
const LEGACY_TOOL = { 'pls-sem': 'statpls', 'ai-pls': 'statpls', 'peer-review-simulator': 'ai-peer-review' };
const parseToolAccess = (s) => String(s || '').split(',').map(x => x.trim()).map(x => LEGACY_TOOL[x] || x).filter(x => TOOL_IDS.has(x)); // remap renamed tool ids

// ---------- role-based feature access ----------
// Four levels: superadmin > admin > educator > student. Each role has a default
// set of enabled tools; an admin can override any single user's set explicitly
// (stored in tool_access). Educators/admins get everything; students get a
// curated essentials set until an admin grants more.
const ROLES = ['basic', 'student', 'educator', 'admin', 'superadmin'];
// non-institutional (e.g. gmail) accounts start here — very limited access
const BASIC_TOOLS = new Set(['smart-literature-finder', 'doi-finder']);
const STUDENT_TOOLS = new Set([
  'smart-literature-finder', 'doi-finder', 'citation-formatter', 'apa-formatter',
  'writing-polisher', 'originality-checker', 'citation-integrity', 'rubric-lens',
  'research-question-generator', 'stats-advisor',
  'research-gap-identifier', 'author-impact', 'journal-rankings',
]);
// null = unrestricted (all tools); a Set = the exact default for that role
function roleDefaultTools(role) { return role === 'basic' ? BASIC_TOOLS : role === 'student' ? STUDENT_TOOLS : null; }
// effective access for a user: explicit override wins, else the role default
function effectiveTools(u) {
  const explicit = parseToolAccess(u.tool_access);
  if (explicit.length) return new Set(explicit);
  return roleDefaultTools(u.role); // null = all
}
// the resolved list the frontend uses to filter the nav ([] = show everything)
function effectiveToolList(u) {
  const eff = effectiveTools(u);
  return eff ? [...eff] : [];
}

// ---------- helpers ----------
const now = () => Date.now();
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}
function verifyPassword(password, salt, expected) {
  const got = Buffer.from(hashPassword(password, salt), 'hex');
  const exp = Buffer.from(expected, 'hex');
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------- account access gate ----------
// Only educational emails (.edu / .edu.<cc> / .ac.<cc>), rewiseed.com admins,
// and addresses the operator has explicitly allow-listed may hold accounts.
// Consumer mail (gmail, yahoo, outlook…) is refused. Superadmins always pass.
const ADMIN_ORG_DOMAIN = 'rewiseed.com';
const ACADEMIC_RE = /\.(edu|ac)(\.[a-z]{2,})?$/i; // mit.edu · iitb.ac.in · ox.ac.uk · unimelb.edu.au
const ENV_ALLOW = (process.env.ACCESS_ALLOW || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
function emailDomain(em) { const i = String(em || '').lastIndexOf('@'); return i < 0 ? '' : em.slice(i + 1).toLowerCase(); }
function accessAllowed(email) {
  const em = String(email || '').toLowerCase().trim();
  const domain = emailDomain(em);
  if (!domain) return false;
  if (SUPERADMINS.includes(em)) return true;                 // hard-coded operators
  if (domain === ADMIN_ORG_DOMAIN) return true;              // rewiseed.com admins
  if (ACADEMIC_RE.test(domain)) return true;                 // educational institutions
  if (ENV_ALLOW.includes(em) || ENV_ALLOW.includes(domain)) return true; // env bootstrap allowlist
  try { return !!db.prepare('SELECT 1 FROM access_allow WHERE value = ? OR value = ?').get(em, domain); }
  catch { return false; }                                    // DB-managed allowlist (admin-granted)
}
const ACCESS_DENIED_MSG = 'Access is limited to institutional accounts. Use your university email (ending in .edu, .ac.in, .ac.uk, and similar) or a rewiseed.com address. If you need access with another email, ask an administrator to add you to the allowlist.';
// cap: length-limit AND strip characters used in unicode spoofing attacks —
// C0 controls (keep \n \t), zero-width chars, and bidi override marks.
const cap = (s, n) => String(s ?? '')
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F​-‏‪-‮⁦-⁩﻿]/g, '')
  .slice(0, n).trim();

function publicUser(u, includePrivate = false) {
  const base = { id: u.id, email: u.email, name: u.name, role: u.role, org: u.org, photo: u.photo, linkedin: u.linkedin, twitter: u.twitter, about: u.about, tool_access: effectiveToolList(u), tool_override: parseToolAccess(u.tool_access), seen_intro: !!u.seen_intro };
  if (includePrivate) { base.confirmed = !!u.confirmed; base.disabled = !!u.disabled; base.created_at = u.created_at; base.credits = u.credits; base.plan_status = u.plan_status; }
  return base;
}

// ---------- email ----------
// Reliability: 3 attempts with backoff on network errors / 429 / 5xx, a
// per-attempt timeout, and no retry on other 4xx (those never self-heal).
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) return { dev: true };
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      if (r.ok) {
        if (attempt > 1) console.log(`email to ${to} succeeded on attempt ${attempt}`);
        return { dev: false };
      }
      const body = (await r.text().catch(() => '')).slice(0, 200);
      lastErr = new Error(`email provider ${r.status}: ${body}`);
      if (r.status < 500 && r.status !== 429) break; // hard client error — retrying won't help
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 3) await new Promise(res => setTimeout(res, attempt * 1500));
  }
  console.error(`email to ${to} FAILED after retries: ${lastErr?.message}`);
  throw lastErr;
}
const resetEmailHtml = (link) => `
<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px">
  <h2 style="color:#1c1a17">Reset your ItsMyResearch password</h2>
  <p style="color:#44403a;line-height:1.6">Someone (hopefully you) asked to reset the password for this account. This link works once and expires in 1 hour:</p>
  <p><a href="${link}" style="background:#211e1a;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Choose a new password</a></p>
  <p style="color:#716b60;font-size:13px">If you didn't request this, you can safely ignore it — your password is unchanged.</p>
</div>`;
const confirmEmailHtml = (name, link) => `
<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px">
  <h2 style="color:#1c1a17">Welcome to ItsMyResearch${name ? ', ' + name.replace(/[<>&]/g, '') : ''}</h2>
  <p style="color:#44403a;line-height:1.6">Confirm your email address to activate your account:</p>
  <p><a href="${link}" style="background:#211e1a;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Confirm my email</a></p>
  <p style="color:#716b60;font-size:13px">This link expires in 24 hours. If you didn't create an account, ignore this email.</p>
</div>`;

const SITE_URL = process.env.SITE_URL || 'https://www.itsmyresearch.com';
const topupReminderHtml = (name, credits) => `
<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px">
  <h2 style="color:#1c1a17">You're out of run credits${name ? ', ' + String(name).replace(/[<>&]/g, '') : ''}</h2>
  <p style="color:#44403a;line-height:1.6">Your ItsMyResearch balance is now <b>${Math.max(0, credits | 0)} credit${(credits | 0) === 1 ? '' : 's'}</b>, so AI tools are paused until you top up or your monthly free allowance refreshes.</p>
  <p style="color:#44403a;line-height:1.6">Two ways to keep going:</p>
  <ul style="color:#44403a;line-height:1.7">
    <li><b>Top up</b> — ₹${TOPUP_AMOUNT_PAISE / 100} for ${TOPUP_CREDITS} run credits, one-time.</li>
    <li><b>Go Pro</b> — ₹${PLAN_AMOUNT_PAISE / 100}/month for ${MONTHLY_CREDITS} credits that stack on your free allowance.</li>
  </ul>
  <p><a href="${SITE_URL}/pricing.html" style="background:#211e1a;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Top up my credits</a></p>
  <p style="color:#716b60;font-size:13px">You're receiving this because you have an ItsMyResearch account and just ran out of credits. We'll only send this at most once a month.</p>
</div>`;

// ---------- captcha: drag-to-match, server-verified ----------
const CAPTCHA_POOL = [
  ['🦉', 'owl'], ['🐢', 'turtle'], ['🐝', 'bee'], ['🦊', 'fox'], ['🐘', 'elephant'],
  ['🌵', 'cactus'], ['🍄', 'mushroom'], ['⚓', 'anchor'], ['🔑', 'key'], ['🕰️', 'clock'],
  ['🎻', 'violin'], ['🧭', 'compass'],
];
const captchas = new Map();   // id -> {solution:{name:emoji}, expires}
const solvedTokens = new Map(); // token -> expires
setInterval(() => {
  const t = now();
  for (const [k, v] of captchas) if (v.expires < t) captchas.delete(k);
  for (const [k, v] of solvedTokens) if (v < t) solvedTokens.delete(k);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(t);
  db.prepare('DELETE FROM tokens WHERE expires < ?').run(t);
}, 60_000).unref();

// ---------- rate limiting (in-memory) ----------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const t = now();
  const b = buckets.get(key) || { count: 0, reset: t + windowMs };
  if (t > b.reset) { b.count = 0; b.reset = t + windowMs; }
  b.count++;
  buckets.set(key, b);
  return b.count <= max;
}
setInterval(() => { const t = now(); for (const [k, v] of buckets) if (t > v.reset) buckets.delete(k); }, 300_000).unref();

// ---------- app ----------
// ---------- billing (Razorpay) ----------
// Ships dark: with no keys configured everything stays free. Set
// RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET + RAZORPAY_WEBHOOK_SECRET, then
// BILLING_ENFORCED=on to start metering. Plan auto-creates on first use.
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RZP_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const BILLING_CONFIGURED = !!(RZP_KEY_ID && RZP_KEY_SECRET);
const BILLING_ENFORCED = BILLING_CONFIGURED && process.env.BILLING_ENFORCED === 'on';
const MONTHLY_CREDITS = 150;         // ₹499/month (Pro must beat the free educator allowance)
// Free monthly AI-run credits by account level. A floor that refreshes every 30
// days: if the balance is below the allowance at rollover it is topped UP TO the
// allowance (never stacked), so paid credits above it are untouched and free
// credits can't be hoarded. Basic gets a one-time signup taste, no refresh.
const FREE_ALLOWANCE = { basic: 0, student: 25, educator: 50 };
const SIGNUP_CREDITS = { basic: 5, student: 25, educator: 50 };
function refreshFreeCredits(u) {
  if (!u || !FREE_ALLOWANCE[u.role]) return u;
  const allowance = FREE_ALLOWANCE[u.role];
  if (now() < (u.free_reset_at || 0) + 30 * 24 * 3600_000) return u;
  if (u.credits < allowance) {
    db.prepare('UPDATE users SET credits = ?, free_reset_at = ? WHERE id = ?').run(allowance, now(), u.id);
    u.credits = allowance;
  } else {
    db.prepare('UPDATE users SET free_reset_at = ? WHERE id = ?').run(now(), u.id);
  }
  u.free_reset_at = now();
  return u;
}
const TOPUP_CREDITS = 25;            // ₹199 one-time
const CREDIT_CAP = 300;              // rollover ceiling — stops infinite hoarding
const PLAN_AMOUNT_PAISE = 49900;
const TOPUP_AMOUNT_PAISE = 19900;
// run weight by input size: the heavy-document guardrail
const runWeight = (chars) => chars <= 20_000 ? 1 : chars <= 80_000 ? 2 : chars <= 200_000 ? 4 : 0;
// per-tool cost for a data run (default 1); heavier tools cost more
const DATA_RUN_COST = { 'citation-integrity': 5 };

// email a user a top-up reminder when they hit zero credits — at most once per 30 days
function maybeSendCreditReminder(u) {
  if (!u || !BILLING_ENFORCED) return;
  if (['admin', 'superadmin'].includes(u.role)) return; // staff are never metered
  const row = db.prepare('SELECT email, name, credits, credits_reminded_at FROM users WHERE id = ?').get(u.id);
  if (!row || row.credits > 0) return;                                        // only when truly out
  if (now() - (row.credits_reminded_at || 0) < 30 * 24 * 3600_000) return;    // reminded recently
  db.prepare('UPDATE users SET credits_reminded_at = ? WHERE id = ?').run(now(), u.id); // stamp first (dedupe concurrent 402s)
  sendEmail(row.email, "You're out of ItsMyResearch credits — top up to keep going", topupReminderHtml(row.name, row.credits)).catch(() => {});
}

async function rzp(pathname, method = 'GET', body = null) {
  const r = await fetch(`https://api.razorpay.com/v1${pathname}`, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`razorpay ${r.status}: ${(j.error && j.error.description) || 'request failed'}`);
  return j;
}
const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// plan id persists in the data dir so we create it exactly once
const BILLING_STATE_FILE = path.join(DATA_DIR, 'billing.json');
async function getPlanId() {
  if (process.env.RAZORPAY_PLAN_ID) return process.env.RAZORPAY_PLAN_ID;
  try { const s = JSON.parse(fs.readFileSync(BILLING_STATE_FILE, 'utf8')); if (s.plan_id) return s.plan_id; } catch { /* first run */ }
  const plan = await rzp('/plans', 'POST', {
    period: 'monthly', interval: 1,
    item: { name: 'ItsMyResearch Pro', amount: PLAN_AMOUNT_PAISE, currency: 'INR', description: `${MONTHLY_CREDITS} AI run credits per month` },
  });
  fs.writeFileSync(BILLING_STATE_FILE, JSON.stringify({ plan_id: plan.id }));
  return plan.id;
}

function grantCredits(userId, kind, paymentId, ref, amount, credits, replace = false) {
  // idempotent by payment id — a replayed webhook grants nothing twice
  const tx = db.transaction(() => {
    try {
      db.prepare('INSERT INTO payments (user_id, rzp_payment_id, rzp_ref, kind, amount, credits, ts) VALUES (?,?,?,?,?,?,?)')
        .run(userId, paymentId, ref, kind, amount, credits, now());
    } catch { return false; } // duplicate payment id
    if (replace) {
      db.prepare("UPDATE users SET credits = MIN(credits + ?, ?), credits_reset_at = ?, plan = 'pro', plan_status = 'active' WHERE id = ?")
        .run(credits, CREDIT_CAP, now(), userId);
    } else {
      db.prepare('UPDATE users SET credits = MIN(credits + ?, ?) WHERE id = ?').run(credits, CREDIT_CAP, userId);
    }
    return true;
  });
  return tx();
}

const app = express();
app.set('trust proxy', 1);
// webhook needs the RAW body for signature verification — registered before the JSON parser
app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '200kb' }), (req, res) => {
  if (!RZP_WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhooks not configured.' });
  const sig = req.headers['x-razorpay-signature'] || '';
  const expected = hmacHex(RZP_WEBHOOK_SECRET, req.body);
  if (!safeEqual(sig, expected)) return res.status(400).json({ error: 'Bad signature.' });
  let ev;
  try { ev = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Bad payload.' }); }
  try {
    if (ev.event === 'subscription.charged') {
      const sub = ev.payload?.subscription?.entity, pay = ev.payload?.payment?.entity;
      const u = sub && db.prepare('SELECT id FROM users WHERE rzp_subscription_id = ?').get(sub.id);
      if (u && pay) grantCredits(u.id, 'charge', pay.id, sub.id, pay.amount || PLAN_AMOUNT_PAISE, MONTHLY_CREDITS, true);
    } else if (ev.event === 'subscription.cancelled' || ev.event === 'subscription.halted' || ev.event === 'subscription.expired') {
      const sub = ev.payload?.subscription?.entity;
      if (sub) db.prepare("UPDATE users SET plan_status = 'cancelled' WHERE rzp_subscription_id = ?").run(sub.id);
    }
  } catch (e) { console.error('webhook handling error:', e.message); }
  res.json({ ok: true }); // always 200 on verified events — Razorpay retries otherwise
});

app.use(express.json({ limit: '500kb' }));

// Content-Security-Policy notes: inline scripts/styles are how this suite ships
// (no build step), so 'unsafe-inline' stays; 'wasm-unsafe-eval' + worker-src
// blob: are required by the built-in WebLLM model; connect-src must stay open
// to https + localhost because BYOK users point at any provider they choose.
// The teeth are in object-src/base-uri/form-action/frame-ancestors.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://checkout.razorpay.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "worker-src 'self' blob:",
  "frame-src https://api.razorpay.com https://checkout.razorpay.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // CSRF: state-changing API requests must come from our own origin
  if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin || '';
    const host = req.headers.host || '';
    if (origin && new URL(origin).host !== host) return res.status(403).json({ error: 'Cross-origin request rejected.' });
  }
  next();
});

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSession(res, token, maxAgeMs) {
  res.setHeader('Set-Cookie',
    `rw_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${IS_PROD ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `rw_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${IS_PROD ? '; Secure' : ''}`);
}
function currentUser(req) {
  const tok = parseCookies(req).rw_session;
  if (!tok) return null;
  const sess = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires > ?').get(sha(tok), now());
  if (!sess) return null;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
  return u && !u.disabled ? u : null;
}
const requireAuth = (req, res, next) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not signed in.' });
  req.user = u; next();
};
const requireAdmin = (req, res, next) => {
  if (!['admin', 'superadmin'].includes(req.user.role)) return res.status(403).json({ error: 'Admin access required.' });
  next();
};

function consumeCaptcha(token) {
  if (!token || !solvedTokens.has(token)) return false;
  const ok = solvedTokens.get(token) > now();
  solvedTokens.delete(token);
  return ok;
}

// ---------- captcha routes ----------
app.get('/api/captcha', (req, res) => {
  if (!rateLimit('captcha:' + req.ip, 30, 15 * 60_000)) return res.status(429).json({ error: 'Too many requests — wait a few minutes.' });
  const picks = [...CAPTCHA_POOL].sort(() => Math.random() - 0.5).slice(0, 3);
  const id = rand(16);
  captchas.set(id, { solution: Object.fromEntries(picks.map(([e, n]) => [n, e])), expires: now() + 5 * 60_000 });
  res.json({
    id,
    items: picks.map(([e]) => e).sort(() => Math.random() - 0.5),
    targets: picks.map(([, n]) => n).sort(() => Math.random() - 0.5),
  });
});
app.post('/api/captcha/verify', (req, res) => {
  if (!rateLimit('captchaV:' + req.ip, 30, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  const { id, mapping } = req.body || {};
  const c = captchas.get(id);
  captchas.delete(id); // single attempt per challenge
  if (!c || c.expires < now() || typeof mapping !== 'object' || !mapping) return res.status(400).json({ error: 'Challenge expired — try again.' });
  const names = Object.keys(c.solution);
  const correct = names.length === Object.keys(mapping).length && names.every(n => mapping[n] === c.solution[n]);
  if (!correct) return res.status(400).json({ error: 'Not quite — try a new puzzle.' });
  const token = rand(24);
  solvedTokens.set(token, now() + 5 * 60_000);
  res.json({ token });
});

// ---------- auth routes ----------
app.post('/api/auth/signup', async (req, res) => {
  if (!rateLimit('signup:' + req.ip, 10, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  const { email, password, name, captchaToken, acceptTerms } = req.body || {};
  if (acceptTerms !== true) return res.status(400).json({ error: 'You must accept the Terms of Service and Privacy Policy to create an account.' });
  if (!consumeCaptcha(captchaToken)) return res.status(400).json({ error: 'Please complete the puzzle first.' });
  const em = cap(email, 254).toLowerCase();
  if (!EMAIL_RE.test(em)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  // In production, refuse signups outright until real email sending is
  // configured — otherwise confirmation links would have to be exposed in
  // responses, letting anyone confirm any address (incl. superadmin emails).
  if (IS_PROD && !RESEND_API_KEY) {
    return res.status(503).json({ error: 'Signups are not open yet — email delivery is being configured. Please try again soon.' });
  }
  const displayName = cap(name, 80);
  const existing = db.prepare('SELECT id, confirmed FROM users WHERE email = ?').get(em);
  // Anti-enumeration: same response whether or not the account exists,
  // with the same scrypt cost either way (no timing oracle).
  const genericOk = { ok: true, message: 'Check your inbox — if this address is new, a confirmation email is on its way.' };
  if (existing) {
    hashPassword(password, rand(16)); // keep timing identical
    // Unconfirmed re-signup means the first email never arrived — resend a
    // fresh confirmation instead of silently doing nothing. The response is
    // identical either way, so nothing is enumerable.
    if (!existing.confirmed) {
      const confirmToken = rand(32);
      db.prepare('INSERT INTO tokens (token, user_id, kind, expires) VALUES (?,?,?,?)')
        .run(sha(confirmToken), existing.id, 'confirm', now() + 24 * 3600_000);
      const link = `${BASE_URL}/api/auth/confirm?token=${confirmToken}`;
      sendEmail(em, 'Confirm your ItsMyResearch account', confirmEmailHtml(displayName, link))
        .then(s => { if (s.dev) console.log(`[dev-email] re-confirmation for ${em}: ${link}`); })
        .catch(() => {});
    }
    return res.json(genericOk);
  }
  const salt = rand(16);
  // institutional emails (edu/ac/rewiseed/allow-listed) get the student essentials;
  // everyone else may join but starts on the limited 'basic' tier (2 tools)
  const role = SUPERADMINS.includes(em) ? 'superadmin' : accessAllowed(em) ? 'student' : 'basic';
  const info = db.prepare('INSERT INTO users (email, name, pass_hash, salt, role, created_at, terms_version, terms_accepted_at, credits, free_reset_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(em, displayName, hashPassword(password, salt), salt, role, now(), TERMS_VERSION, now(), SIGNUP_CREDITS[role] || 0, now());
  const confirmToken = rand(32);
  db.prepare('INSERT INTO tokens (token, user_id, kind, expires) VALUES (?,?,?,?)')
    .run(sha(confirmToken), info.lastInsertRowid, 'confirm', now() + 24 * 3600_000);
  const link = `${BASE_URL}/api/auth/confirm?token=${confirmToken}`;
  try {
    const sent = await sendEmail(em, 'Confirm your ItsMyResearch account', confirmEmailHtml(displayName, link));
    if (sent.dev) {
      console.log(`[dev-email] confirmation for ${em}: ${link}`);
      return res.json({ ...genericOk, devConfirmLink: link, devNote: 'Email sending not configured (RESEND_API_KEY unset) — use this link.' });
    }
  } catch (e) {
    console.error('email send failed:', e.message);
    return res.status(502).json({ error: 'Could not send the confirmation email. Try again shortly.' });
  }
  res.json(genericOk);
});

app.get('/api/auth/confirm', (req, res) => {
  const t = cap(req.query.token, 200);
  const row = t && db.prepare("SELECT * FROM tokens WHERE token = ? AND kind = 'confirm' AND expires > ?").get(sha(t), now());
  if (!row) return res.redirect('/signin.html?confirmed=expired');
  db.prepare('DELETE FROM tokens WHERE token = ?').run(sha(t));
  db.prepare('UPDATE users SET confirmed = 1 WHERE id = ?').run(row.user_id);
  res.redirect('/signin.html?confirmed=1');
});

// Resend a confirmation email on demand — the escape hatch when the first
// one lands in spam or the 24h token expires. Generic response always.
app.post('/api/auth/resend-confirm', async (req, res) => {
  if (!rateLimit('reconfirm:' + req.ip, 5, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  const em = cap((req.body || {}).email, 254).toLowerCase();
  if (!EMAIL_RE.test(em)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!rateLimit('reconfirmE:' + em, 3, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts for this address — wait a few minutes.' });
  const generic = { ok: true, message: 'If an unconfirmed account exists for that address, a fresh confirmation email is on its way.' };
  const u = db.prepare('SELECT id, name, confirmed FROM users WHERE email = ?').get(em);
  if (u && !u.confirmed) {
    const confirmToken = rand(32);
    db.prepare('INSERT INTO tokens (token, user_id, kind, expires) VALUES (?,?,?,?)')
      .run(sha(confirmToken), u.id, 'confirm', now() + 24 * 3600_000);
    const link = `${BASE_URL}/api/auth/confirm?token=${confirmToken}`;
    try {
      const sent = await sendEmail(em, 'Confirm your ItsMyResearch account', confirmEmailHtml(u.name, link));
      if (sent.dev) console.log(`[dev-email] resend confirmation for ${em}: ${link}`);
    } catch { /* generic response regardless; failure already logged */ }
  }
  res.json(generic);
});

app.post('/api/auth/signin', (req, res) => {
  if (!rateLimit('signin:' + req.ip, 15, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  const { email, password, captchaToken } = req.body || {};
  if (!consumeCaptcha(captchaToken)) return res.status(400).json({ error: 'Please complete the puzzle first.' });
  const em = cap(email, 254).toLowerCase();
  if (!rateLimit('signinE:' + em, 8, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts for this account — wait a few minutes.' });
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(em);
  if (!u || !verifyPassword(String(password || ''), u.salt, u.pass_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  if (!u.confirmed) return res.status(403).json({ error: 'Please confirm your email first — check your inbox (and spam).', unconfirmed: true });
  if (u.disabled) return res.status(403).json({ error: 'This account has been disabled. Contact your administrator.' });
  // anyone with a confirmed account may sign in; non-institutional accounts simply
  // hold the limited 'basic' tier until an admin grants more.
  const token = rand(32);
  db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)').run(sha(token), u.id, now() + 30 * 24 * 3600_000);
  setSession(res, token, 30 * 24 * 3600_000);
  res.json({ ok: true, user: publicUser(u) });
});

app.post('/api/auth/forgot', async (req, res) => {
  if (!rateLimit('forgot:' + req.ip, 6, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  const { email, captchaToken } = req.body || {};
  if (!consumeCaptcha(captchaToken)) return res.status(400).json({ error: 'Please complete the puzzle first.' });
  const em = cap(email, 254).toLowerCase();
  if (!EMAIL_RE.test(em)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (IS_PROD && !RESEND_API_KEY) return res.status(503).json({ error: 'Email delivery is being configured — try again soon.' });
  const genericOk = { ok: true, message: 'If that address has an account, a reset link is on its way.' };
  if (!rateLimit('forgotE:' + em, 3, 3600_000)) return res.json(genericOk); // silent per-email cap
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(em);
  if (!u) return res.json(genericOk);
  const token = rand(32);
  db.prepare("DELETE FROM tokens WHERE user_id = ? AND kind = 'reset'").run(u.id);
  db.prepare('INSERT INTO tokens (token, user_id, kind, expires) VALUES (?,?,?,?)').run(sha(token), u.id, 'reset', now() + 3600_000);
  const link = `${BASE_URL}/reset.html?token=${token}`;
  try {
    const sent = await sendEmail(em, 'Reset your ItsMyResearch password', resetEmailHtml(link));
    if (sent.dev) { console.log(`[dev-email] reset for ${em}: ${link}`); return res.json({ ...genericOk, devResetLink: link }); }
  } catch (e) {
    console.error('reset email failed:', e.message);
    return res.status(502).json({ error: 'Could not send the reset email. Try again shortly.' });
  }
  res.json(genericOk);
});

app.post('/api/auth/reset', (req, res) => {
  if (!rateLimit('reset:' + req.ip, 10, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  const { token, password } = req.body || {};
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const row = token && db.prepare("SELECT * FROM tokens WHERE token = ? AND kind = 'reset' AND expires > ?").get(sha(cap(token, 200)), now());
  if (!row) return res.status(400).json({ error: 'This reset link is invalid or expired — request a new one.' });
  db.prepare('DELETE FROM tokens WHERE token = ?').run(sha(cap(token, 200)));
  const salt = rand(16);
  // proving control of the inbox also confirms the address
  db.prepare('UPDATE users SET pass_hash = ?, salt = ?, confirmed = 1 WHERE id = ?').run(hashPassword(password, salt), salt, row.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
  res.json({ ok: true, message: 'Password updated — sign in with it now.' });
});

app.post('/api/auth/password', requireAuth, (req, res) => {
  if (!rateLimit('pwchange:' + req.user.id, 8, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(String(currentPassword || ''), req.user.salt, req.user.pass_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const salt = rand(16);
  db.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').run(hashPassword(newPassword, salt), salt, req.user.id);
  // sign out every other device, keep this session
  const current = sha(parseCookies(req).rw_session);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, current);
  res.json({ ok: true });
});

app.post('/api/auth/signout', requireAuth, (req, res) => {
  const tok = parseCookies(req).rw_session;
  if (tok) db.prepare('DELETE FROM sessions WHERE token = ?').run(sha(tok));
  clearSession(res);
  res.json({ ok: true });
});

// ---------- profile ----------
app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user, true) }));

app.put('/api/me', requireAuth, (req, res) => {
  if (!rateLimit('profile:' + req.user.id, 30, 15 * 60_000)) return res.status(429).json({ error: 'Too many profile updates — wait a few minutes.' });
  const { name, org, linkedin, twitter, about, photo, introSeen } = req.body || {};
  if (introSeen === true) db.prepare('UPDATE users SET seen_intro = 1 WHERE id = ?').run(req.user.id);
  const clean = {
    name: cap(name ?? req.user.name, 80),
    org: cap(org ?? req.user.org, 120),
    linkedin: cap(linkedin ?? req.user.linkedin, 200),
    twitter: cap(twitter ?? req.user.twitter, 200),
    about: cap(about ?? req.user.about, 2000),
    photo: req.user.photo,
  };
  for (const k of ['linkedin', 'twitter']) {
    if (clean[k] && !/^https:\/\/(www\.)?(linkedin\.com|x\.com|twitter\.com)\/[\w\-/.%?=&]+$/i.test(clean[k])) {
      return res.status(400).json({ error: `${k === 'linkedin' ? 'LinkedIn' : 'Twitter/X'} must be a full https:// profile URL on the official domain.` });
    }
  }
  // profile links: https only (they may be rendered as anchors) — no other schemes
  for (const f of ['linkedin', 'twitter']) {
    if (clean[f] && !/^https:\/\/[^\s]+$/i.test(clean[f])) {
      return res.status(400).json({ error: `The ${f === 'twitter' ? 'Twitter/X' : 'LinkedIn'} link must start with https://` });
    }
  }
  if (photo !== undefined) {
    if (photo === '') clean.photo = '';
    else {
      if (typeof photo !== 'string' || photo.length > 400_000) return res.status(400).json({ error: 'Photo too large (300 KB max after compression).' });
      const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(photo);
      if (!m) return res.status(400).json({ error: 'Photo must be a PNG, JPEG, or WebP image.' });
      // magic-byte sniff: the bytes must actually be the declared format
      const head = Buffer.from(m[2].slice(0, 24), 'base64');
      const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
      const isJpg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
      const isWebp = head.slice(0, 4).toString('latin1') === 'RIFF' && head.slice(8, 12).toString('latin1') === 'WEBP';
      const ok = (m[1] === 'png' && isPng) || (m[1] === 'jpeg' && isJpg) || (m[1] === 'webp' && isWebp);
      if (!ok) return res.status(400).json({ error: 'That file does not look like a valid image — re-export it as PNG or JPEG and try again.' });
      clean.photo = photo;
    }
  }
  db.prepare('UPDATE users SET name=?, org=?, linkedin=?, twitter=?, about=?, photo=? WHERE id=?')
    .run(clean.name, clean.org, clean.linkedin, clean.twitter, clean.about, clean.photo, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id), true) });
});

function deleteUserCascade(id) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM tokens WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

app.delete('/api/me', requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (!verifyPassword(String(password || ''), req.user.salt, req.user.pass_hash)) {
    return res.status(401).json({ error: 'Password is incorrect.' });
  }
  if (req.user.role === 'superadmin') {
    const others = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'superadmin' AND id != ?").get(req.user.id).c;
    if (!others) return res.status(400).json({ error: 'You are the last super admin — promote another before deleting this account.' });
  }
  deleteUserCascade(req.user.id);
  clearSession(res);
  res.json({ ok: true });
});

// ---------- admin ----------
// ---------- access allowlist management (superadmin only) ----------
const requireSuperadmin = (req, res, next) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only a superadmin can manage the access allowlist.' });
  next();
};
app.get('/api/admin/access', requireAuth, requireSuperadmin, (_req, res) => {
  const rows = db.prepare('SELECT value, kind, note, added_by, added_at FROM access_allow ORDER BY added_at DESC').all();
  res.json({ allow: rows, policy: { academic: '.edu, .edu.<cc>, .ac.<cc>', adminDomain: ADMIN_ORG_DOMAIN, env: ENV_ALLOW } });
});
app.post('/api/admin/access', requireAuth, requireSuperadmin, (req, res) => {
  const raw = cap((req.body || {}).value, 254).toLowerCase().trim();
  const note = cap((req.body || {}).note, 200);
  if (!raw) return res.status(400).json({ error: 'Enter an email or domain to allow.' });
  const isEmail = raw.includes('@');
  if (isEmail && !EMAIL_RE.test(raw)) return res.status(400).json({ error: 'That is not a valid email address.' });
  if (!isEmail && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(raw)) return res.status(400).json({ error: 'That is not a valid domain (e.g. example.org).' });
  db.prepare('INSERT INTO access_allow (value, kind, note, added_by, added_at) VALUES (?,?,?,?,?) ON CONFLICT(value) DO UPDATE SET note = excluded.note')
    .run(raw, isEmail ? 'email' : 'domain', note, req.user.email, now());
  res.json({ ok: true, value: raw, kind: isEmail ? 'email' : 'domain' });
});
app.delete('/api/admin/access/:value', requireAuth, requireSuperadmin, (req, res) => {
  db.prepare('DELETE FROM access_allow WHERE value = ?').run(String(req.params.value || '').toLowerCase());
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  let rows;
  if (req.user.role === 'superadmin') {
    rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 500').all();
  } else {
    // org-scoped: admins see students and educators of their own institution, never other admins/superadmins
    rows = db.prepare("SELECT * FROM users WHERE org = ? AND role IN ('basic','student','educator') ORDER BY created_at DESC LIMIT 500").all(req.user.org);
  }
  res.json({ users: rows.map(u => publicUser(u, true)), scope: req.user.role === 'superadmin' ? 'all' : req.user.org });
});

// bulk-assign the same tool set to many users at once
app.post('/api/admin/users/bulk-tools', requireAuth, requireAdmin, (req, res) => {
  const { ids, toolAccess } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Select at least one user.' });
  if (!Array.isArray(toolAccess) || !toolAccess.length || toolAccess.some(t => !TOOL_IDS.has(String(t)))) {
    return res.status(400).json({ error: 'Select at least one tool — to block everything, disable the accounts instead.' });
  }
  let updated = 0, skipped = 0;
  db.transaction(() => {
    for (const rawId of ids.slice(0, 500)) {
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(rawId));
      // same guardrails as the single-user route: never touch superadmins, yourself,
      // or (for org admins) anyone outside your institution / above student+educator
      if (!target || target.role === 'superadmin' || target.id === req.user.id) { skipped++; continue; }
      if (req.user.role === 'admin' && (target.org !== req.user.org || !['basic', 'student', 'educator'].includes(target.role))) { skipped++; continue; }
      const def = roleDefaultTools(target.role);
      const sel = new Set(toolAccess);
      const isDefault = def === null ? toolAccess.length === TOOL_IDS.size : (sel.size === def.size && [...def].every(t => sel.has(t)));
      db.prepare('UPDATE users SET tool_access = ? WHERE id = ?').run(isDefault ? '' : toolAccess.join(','), target.id);
      updated++;
    }
  })();
  res.json({ ok: true, updated, skipped });
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'superadmin') return res.status(403).json({ error: 'Super admin accounts cannot be modified.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Use your profile page to edit your own account.' });
  const { role, disabled, org, toolAccess } = req.body || {};
  if (req.user.role === 'admin') {
    // admins: only students/educators in their own org
    if (target.org !== req.user.org || !['basic', 'student', 'educator'].includes(target.role)) return res.status(403).json({ error: 'You can only manage users of your own institution.' });
    if (org !== undefined) return res.status(403).json({ error: 'Only super admins can change institutions.' });
    if (role !== undefined && !['basic', 'student', 'educator'].includes(role)) return res.status(403).json({ error: 'Admins can set the basic, student, or educator level only.' });
  }
  // determine the role that WILL apply, so tool_access collapses against the right default
  const nextRole = role !== undefined ? role : target.role;
  const updates = {};
  if (disabled !== undefined) updates.disabled = disabled ? 1 : 0;
  if (role !== undefined) {
    const allowedRoles = req.user.role === 'superadmin' ? ['basic', 'student', 'educator', 'admin'] : ['basic', 'student', 'educator'];
    if (!allowedRoles.includes(role)) return res.status(400).json({ error: `Role must be one of: ${allowedRoles.join(', ')}.` });
    updates.role = role;
    updates.free_reset_at = 0; // the new level's free allowance applies immediately
  }
  if (toolAccess !== undefined) {
    if (!Array.isArray(toolAccess) || !toolAccess.length || toolAccess.some(t => !TOOL_IDS.has(String(t)))) {
      return res.status(400).json({ error: 'Select at least one tool — to block everything, disable the account instead.' });
    }
    // Collapse to '' (= "follow role default") only when the selection exactly
    // equals that role's default, so unrestricted users keep auto-getting new
    // tools; anything else is stored as an explicit override CSV.
    const def = roleDefaultTools(nextRole); // null = all
    const sel = new Set(toolAccess);
    const isDefault = def === null
      ? toolAccess.length === TOOL_IDS.size
      : (sel.size === def.size && [...def].every(t => sel.has(t)));
    updates.tool_access = isDefault ? '' : toolAccess.join(',');
  }
  if (req.user.role === 'superadmin' && org !== undefined) updates.org = cap(org, 120);
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update.' });
  const sets = Object.keys(updates).map(k => `${k}=?`).join(', ');
  db.prepare(`UPDATE users SET ${sets} WHERE id=?`).run(...Object.values(updates), target.id);
  if (updates.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(target.id), true) });
});

// grant (or deduct) run credits for a specific user — admin goodwill, workshops, refunds
app.post('/api/admin/users/:id/credits', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot grant credits to yourself.' });
  // staff (admin/superadmin) are never metered, so credits do nothing for them
  if (!['basic', 'student', 'educator'].includes(target.role)) {
    return res.status(400).json({ error: 'Staff accounts are never metered — credits do not apply to them.' });
  }
  // org admins may only top up their own institution's users
  if (req.user.role === 'admin' && target.org !== req.user.org) {
    return res.status(403).json({ error: 'You can only manage users of your own institution.' });
  }
  const amount = Math.trunc(Number((req.body || {}).amount));
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'Enter a non-zero whole number of credits (use a negative number to deduct).' });
  if (Math.abs(amount) > 5000) return res.status(400).json({ error: 'One adjustment is limited to ±5000 credits.' });
  const result = db.transaction(() => {
    const cur = db.prepare('SELECT credits FROM users WHERE id = ?').get(target.id).credits;
    // keep the invariant credits <= CREDIT_CAP that top-ups/subscriptions rely on; never below 0
    const next = Math.max(0, Math.min(cur + amount, CREDIT_CAP));
    const applied = next - cur;
    db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(next, target.id);
    // audit trail in the payments ledger — ₹0 so it never counts as revenue
    db.prepare('INSERT INTO payments (user_id, rzp_payment_id, rzp_ref, kind, amount, credits, ts) VALUES (?,?,?,?,?,?,?)')
      .run(target.id, 'admin:' + rand(12), req.user.email, applied >= 0 ? 'admin_grant' : 'admin_deduct', 0, applied, now());
    return { next, applied };
  })();
  const capped = result.applied !== amount;
  res.json({ ok: true, credits: result.next, applied: result.applied, capped, cap: CREDIT_CAP });
});

// ---------- statistics proxy (public data only, cached) ----------
// The World Bank API has been observed at 38-60s per query; caching here makes
// repeat queries instant and shields users from upstream slowness. Only public
// statistical data passes through — never user content.
const statsCache = new Map();          // url -> { at, body }
const STATS_TTL = 6 * 3600_000;
const STATS_HOSTS = new Set(['api.worldbank.org', 'ec.europa.eu', 'sdmx.oecd.org']);
setInterval(() => {
  const t = now();
  for (const [k, v] of statsCache) if (t - v.at > STATS_TTL) statsCache.delete(k);
}, 3600_000).unref();

app.get('/api/data', async (req, res) => {
  if (!rateLimit('data:' + req.ip, 120, 15 * 60_000)) return res.status(429).json({ error: 'Too many data requests — wait a few minutes.' });
  const target = String(req.query.url || '');
  let u;
  try { u = new URL(target); } catch { return res.status(400).json({ error: 'Invalid url parameter.' }); }
  if (u.protocol !== 'https:' || !STATS_HOSTS.has(u.hostname)) {
    return res.status(403).json({ error: 'Only approved public statistics hosts are proxied.' });
  }
  const key = u.toString();
  const hit = statsCache.get(key);
  if (hit && now() - hit.at < STATS_TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.type('application/json').send(hit.body);
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 75_000);
    const r = await fetch(key, { signal: ctrl.signal, headers: { 'User-Agent': 'ItsMyResearch/1.0 (+https://www.itsmyresearch.com)' } });
    clearTimeout(timer);
    const body = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: `Upstream returned ${r.status}.` });
    if (body.length < 5_000_000) statsCache.set(key, { at: now(), body });
    res.setHeader('X-Cache', 'MISS');
    res.type('application/json').send(body);
  } catch (e) {
    res.status(504).json({ error: 'The statistics service did not respond in time. It is often slow — please try again shortly.' });
  }
});

// ---------- Semantic Scholar proxy (second author-metrics source) ----------
// The keyless S2 API is heavily rate-limited (shared ~1 req/s) and 429s without CORS headers,
// so browsers can't call it reliably. We proxy it: same-origin (no CORS), cached, and able to
// attach a free S2 API key server-side (SEMANTIC_SCHOLAR_API_KEY) for a much higher rate limit.
const S2_KEY = (process.env.SEMANTIC_SCHOLAR_API_KEY || process.env.S2_API_KEY || '').trim();
const s2Cache = new Map();             // cacheKey -> { at, body }
const S2_TTL = 24 * 3600_000;          // author/paper metrics change slowly — cache a day

// Shared upstream fetcher: same 24h cache, optional server-side key, and uniform
// error mapping (429 passthrough so the client can degrade to its primary source).
async function s2Proxy(res, cacheKey, upstreamUrl) {
  const hit = s2Cache.get(cacheKey);
  if (hit && now() - hit.at < S2_TTL) { res.setHeader('X-Cache', 'HIT'); return res.type('application/json').send(hit.body); }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const headers = { 'User-Agent': 'ItsMyResearch/1.0 (+https://www.itsmyresearch.com)' };
    if (S2_KEY) headers['x-api-key'] = S2_KEY;
    const r = await fetch(upstreamUrl, { signal: ctrl.signal, headers });
    clearTimeout(timer);
    const body = await r.text();
    if (!r.ok) return res.status(r.status === 429 ? 429 : (r.status === 404 ? 404 : 502)).json({ error: `Semantic Scholar returned ${r.status}.` });
    if (s2Cache.size > 4000) s2Cache.clear();
    s2Cache.set(cacheKey, { at: now(), body });
    res.setHeader('X-Cache', 'MISS');
    res.type('application/json').send(body);
  } catch {
    res.status(504).json({ error: 'Semantic Scholar did not respond in time.' });
  }
}

// Graph API — author search (second author-metrics source for Author & Institution Profiles)
app.get('/api/s2-author', (req, res) => {
  if (!rateLimit('s2:' + req.ip, 60, 15 * 60_000)) return res.status(429).json({ error: 'Too many lookups — wait a few minutes.' });
  const q = String(req.query.query || '').trim().slice(0, 160);
  if (!q) return res.status(400).json({ error: 'Missing query.' });
  const fields = 'name,hIndex,citationCount,paperCount,affiliations,url,externalIds';
  // limit=100: S2 relevance ranking often buries an author's canonical (merged) record below many
  // fragment duplicates, so a small window can miss it entirely — the client picks the best match.
  const url = `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(q)}&limit=100&fields=${fields}`;
  return s2Proxy(res, 'author:' + q.toLowerCase(), url);
});

// Graph API — single paper by ID (DOI:/ ARXIV:/ SHA / CorpusId:) or best title match.
// Surfaces S2's distinctive signals: TLDR, influentialCitationCount, open-access PDF, fields of study.
const S2_PAPER_FIELDS = 'paperId,corpusId,externalIds,url,title,abstract,venue,year,publicationDate,referenceCount,citationCount,influentialCitationCount,isOpenAccess,openAccessPdf,fieldsOfStudy,publicationTypes,tldr,authors';
app.get('/api/s2-paper', (req, res) => {
  if (!rateLimit('s2:' + req.ip, 60, 15 * 60_000)) return res.status(429).json({ error: 'Too many lookups — wait a few minutes.' });
  const id = String(req.query.id || '').trim().slice(0, 200);
  const title = String(req.query.title || '').trim().slice(0, 300);
  if (!id && !title) return res.status(400).json({ error: 'Provide an id or title.' });
  const url = id
    ? `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=${S2_PAPER_FIELDS}`
    : `https://api.semanticscholar.org/graph/v1/paper/search/match?query=${encodeURIComponent(title)}&fields=${S2_PAPER_FIELDS}`;
  return s2Proxy(res, 'paper:' + (id || 't:' + title).toLowerCase(), url);
});

// Recommendations API — papers similar to a single seed paper (by S2 paperId or DOI:/ARXIV: id).
app.get('/api/s2-recommendations', (req, res) => {
  if (!rateLimit('s2:' + req.ip, 60, 15 * 60_000)) return res.status(429).json({ error: 'Too many lookups — wait a few minutes.' });
  const id = String(req.query.paperId || '').trim().slice(0, 200);
  if (!id) return res.status(400).json({ error: 'Missing paperId.' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);
  const from = req.query.from === 'all-cs' ? 'all-cs' : 'recent';
  const fields = 'title,year,authors,venue,url,externalIds,citationCount,isOpenAccess,openAccessPdf';
  const url = `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(id)}?fields=${fields}&limit=${limit}&from=${from}`;
  return s2Proxy(res, `rec:${from}:${limit}:${id.toLowerCase()}`, url);
});

// ---------- reference library ----------
app.get('/api/library', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM library WHERE user_id = ? ORDER BY added_at DESC').all(req.user.id);
  res.json({ papers: rows });
});
app.post('/api/library', requireAuth, (req, res) => {
  if (!rateLimit('libw:' + req.user.id, 120, 15 * 60_000)) return res.status(429).json({ error: 'Too many saves — wait a few minutes.' });
  const { doi, title, authors, year, venue, url } = req.body || {};
  const t = cap(title, 400);
  if (!t) return res.status(400).json({ error: 'A title is required.' });
  const count = db.prepare('SELECT COUNT(*) c FROM library WHERE user_id = ?').get(req.user.id).c;
  if (count >= 1000) return res.status(400).json({ error: 'Library limit reached (1000 papers).' });
  const d = cap(doi, 200).toLowerCase();
  if (d) {
    const dup = db.prepare('SELECT id FROM library WHERE user_id = ? AND doi = ?').get(req.user.id, d);
    if (dup) return res.json({ ok: true, duplicate: true, id: dup.id });
  }
  const cleanUrl = cap(url, 400);
  if (cleanUrl && !/^https:\/\//.test(cleanUrl)) return res.status(400).json({ error: 'URL must be https.' });
  const info = db.prepare('INSERT INTO library (user_id, doi, title, authors, year, venue, url, added_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.user.id, d, t, cap(Array.isArray(authors) ? authors.join(', ') : authors, 500), Number(year) || null, cap(venue, 200), cleanUrl, now());
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.put('/api/library/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM library WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Not in your library.' });
  db.prepare('UPDATE library SET notes = ? WHERE id = ?').run(cap(req.body?.notes, 1000), row.id);
  res.json({ ok: true });
});
app.delete('/api/library/:id', requireAuth, (req, res) => {
  const r = db.prepare('DELETE FROM library WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Not in your library.' });
  res.json({ ok: true });
});

// ========================================================================
// Journal of Business, Management & Sustainability — editorial workflow
// Submit → desk screen → double-anonymous peer review → decision → publish.
// Editors = admin/superadmin; reviewers = any user an editor invites.
// ========================================================================
const JOURNAL_TRACKS = ['General Management', 'Strategy', 'Entrepreneurship & Innovation', 'Marketing', 'Finance & Accounting', 'Organizational Behaviour & HRM', 'Operations & Supply Chain', 'Information Systems & Digital', 'Economics & Policy', 'Sustainability & CSR', 'International Business'];
// A DOI needs a registered prefix from Crossref (10.NNNNN). Set CROSSREF_DOI_PREFIX
// once the journal is a Crossref member; until then articles carry a reserved,
// human-readable DOI suffix that becomes a live https://doi.org/ link the moment
// the prefix (and Crossref deposit) are in place.
const DOI_PREFIX = (process.env.CROSSREF_DOI_PREFIX || '').trim();
const doiSuffix = (s) => `jbms.v${s.volume}i${s.issue}.${String(s.id).padStart(4, '0')}`;
const fullDoi = (s) => s.doi || (DOI_PREFIX ? `${DOI_PREFIX}/${doiSuffix(s)}` : '');
const JOURNAL_STATUSES = ['submitted', 'screening', 'under_review', 'minor_revision', 'major_revision', 'revised', 'accepted', 'rejected', 'withdrawn', 'published'];
const isEditor = (u) => u && ['admin', 'superadmin'].includes(u.role);
function nextMsId() {
  const y = new Date(now()).getUTCFullYear();
  const n = db.prepare("SELECT COUNT(*) c FROM journal_submissions").get().c + 1;
  return `JBMS-${y}-${String(n).padStart(4, '0')}`;
}
function submissionPublic(s, viewer, opts = {}) {
  const out = {
    id: s.id, ms_id: s.ms_id, title: s.title, abstract: s.abstract, keywords: s.keywords,
    track: s.track, status: s.status, created_at: s.created_at, updated_at: s.updated_at,
    volume: s.volume, issue: s.issue, published_at: s.published_at, decision_note: s.decision_note,
    doi: s.doi || '',
  };
  if (opts.full) {
    out.authors_meta = safeJson(s.authors_meta, []);
    out.declarations = safeJson(s.declarations, {});
    out.cover_letter = s.cover_letter;
    // manuscript withheld from reviewers is not needed — double-anonymous is about identity, not text;
    // authors and editors always see it; assigned reviewers see it too (identity fields are separate)
    out.manuscript = s.manuscript;
    out.is_author = viewer && s.author_id === viewer.id;
    out.is_editor = isEditor(viewer);
  }
  return out;
}
const safeJson = (s, fb) => { try { return JSON.parse(s || ''); } catch { return fb; } };

// --- author: submit a manuscript ---
app.post('/api/journal/submit', requireAuth, (req, res) => {
  if (!rateLimit('jsub:' + req.user.id, 20, 60 * 60_000)) return res.status(429).json({ error: 'Too many submissions in a short time — please wait.' });
  const b = req.body || {};
  const title = cap(b.title, 400);
  const abstract = cap(b.abstract, 5000);
  const manuscript = cap(b.manuscript, 400_000);
  const track = JOURNAL_TRACKS.includes(b.track) ? b.track : '';
  if (!title || title.length < 8) return res.status(400).json({ error: 'A descriptive title (8+ characters) is required.' });
  if (abstract.length < 100) return res.status(400).json({ error: 'An abstract of at least 100 characters is required.' });
  if (manuscript.length < 2000) return res.status(400).json({ error: 'The full manuscript text is required (paste or upload the whole paper).' });
  if (!track) return res.status(400).json({ error: 'Choose a subject track.' });
  const d = b.declarations || {};
  const required = ['original', 'notConcurrent', 'ethics', 'coiDisclosed', 'aiDisclosed', 'allAuthorsAgree'];
  if (!required.every(k => d[k] === true)) return res.status(400).json({ error: 'All submission declarations must be confirmed before you can submit.' });
  const authors = Array.isArray(b.authors_meta) ? b.authors_meta.slice(0, 30).map(a => ({ name: cap(a.name, 120), affiliation: cap(a.affiliation, 200), email: cap(a.email, 254), orcid: cap(a.orcid, 40), corresponding: !!a.corresponding })) : [];
  if (!authors.length || !authors.some(a => a.name)) return res.status(400).json({ error: 'List at least one author with a name.' });
  const msId = nextMsId();
  const info = db.prepare(`INSERT INTO journal_submissions (ms_id, author_id, title, abstract, keywords, track, authors_meta, manuscript, cover_letter, declarations, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(msId, req.user.id, title, abstract, cap(b.keywords, 400), track,
    JSON.stringify(authors), manuscript, cap(b.cover_letter, 5000), JSON.stringify({ ...d, funding: cap(d.funding, 500), dataAvailability: cap(d.dataAvailability, 500), aiUse: cap(d.aiUse, 1000) }), 'submitted', now(), now());
  res.json({ ok: true, ms_id: msId, id: info.lastInsertRowid });
});

// --- author: my submissions ---
app.get('/api/journal/mine', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM journal_submissions WHERE author_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ submissions: rows.map(s => submissionPublic(s, req.user)) });
});
app.post('/api/journal/withdraw/:id', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM journal_submissions WHERE id = ? AND author_id = ?').get(Number(req.params.id), req.user.id);
  if (!s) return res.status(404).json({ error: 'Submission not found.' });
  if (['published', 'withdrawn'].includes(s.status)) return res.status(400).json({ error: 'This submission cannot be withdrawn.' });
  db.prepare("UPDATE journal_submissions SET status='withdrawn', updated_at=? WHERE id=?").run(now(), s.id);
  res.json({ ok: true });
});

// --- shared: full submission view (author, editor, or assigned reviewer) ---
app.get('/api/journal/submission/:id', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM journal_submissions WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found.' });
  const assigned = db.prepare('SELECT * FROM journal_reviews WHERE submission_id = ? AND reviewer_id = ?').get(s.id, req.user.id);
  if (s.author_id !== req.user.id && !isEditor(req.user) && !assigned) return res.status(403).json({ error: 'Not authorised.' });
  const out = submissionPublic(s, req.user, { full: true });
  // reviewers see an anonymised copy: author identity fields stripped
  if (!isEditor(req.user) && s.author_id !== req.user.id) { out.authors_meta = undefined; out.anonymised = true; }
  if (isEditor(req.user) || s.author_id === req.user.id) {
    out.reviews = db.prepare('SELECT r.*, u.name reviewer_name, u.email reviewer_email FROM journal_reviews r JOIN users u ON u.id=r.reviewer_id WHERE submission_id = ?').all(s.id)
      .map(r => ({ id: r.id, recommendation: r.recommendation, scores: safeJson(r.scores, {}), comments_author: r.comments_author, status: r.status,
        // editors see reviewer identity + confidential comments; authors do not
        ...(isEditor(req.user) ? { reviewer_name: r.reviewer_name, reviewer_email: r.reviewer_email, comments_editor: r.comments_editor, coi: r.coi } : {}) }));
  }
  if (assigned) out.myReview = { id: assigned.id, status: assigned.status, scores: safeJson(assigned.scores, {}), recommendation: assigned.recommendation, comments_author: assigned.comments_author, comments_editor: assigned.comments_editor };
  res.json({ submission: out });
});

// --- editor: queue ---
app.get('/api/journal/editor/queue', requireAuth, (req, res) => {
  if (!isEditor(req.user)) return res.status(403).json({ error: 'Editor access required.' });
  const rows = db.prepare(`SELECT s.*, u.name author_name, u.email author_email,
    (SELECT COUNT(*) FROM journal_reviews r WHERE r.submission_id=s.id) invited,
    (SELECT COUNT(*) FROM journal_reviews r WHERE r.submission_id=s.id AND r.status='submitted') reviews_in
    FROM journal_submissions s JOIN users u ON u.id=s.author_id ORDER BY s.updated_at DESC LIMIT 500`).all();
  res.json({ queue: rows.map(s => ({ ...submissionPublic(s, req.user), author_name: s.author_name, author_email: s.author_email, invited: s.invited, reviews_in: s.reviews_in })), tracks: JOURNAL_TRACKS });
});

// --- editor: desk screen (advance to review or desk-reject) ---
app.post('/api/journal/editor/screen/:id', requireAuth, (req, res) => {
  if (!isEditor(req.user)) return res.status(403).json({ error: 'Editor access required.' });
  const s = db.prepare('SELECT * FROM journal_submissions WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found.' });
  const action = (req.body || {}).action;
  const note = cap((req.body || {}).note, 3000);
  if (action === 'advance') db.prepare("UPDATE journal_submissions SET status='under_review', editor_id=?, decision_note=?, updated_at=? WHERE id=?").run(req.user.id, note, now(), s.id);
  else if (action === 'desk_reject') db.prepare("UPDATE journal_submissions SET status='rejected', editor_id=?, decision_note=?, updated_at=? WHERE id=?").run(req.user.id, note || 'Desk rejected at editorial screening.', now(), s.id);
  else return res.status(400).json({ error: 'Unknown screening action.' });
  res.json({ ok: true });
});

// --- editor: invite a reviewer by email ---
app.post('/api/journal/editor/assign/:id', requireAuth, (req, res) => {
  if (!isEditor(req.user)) return res.status(403).json({ error: 'Editor access required.' });
  const s = db.prepare('SELECT * FROM journal_submissions WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found.' });
  const email = cap((req.body || {}).email, 254).toLowerCase();
  const reviewer = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!reviewer) return res.status(400).json({ error: 'No account with that email. The reviewer must have an ItsMyResearch account first.' });
  if (reviewer.id === s.author_id) return res.status(400).json({ error: 'The author cannot review their own manuscript.' });
  const dup = db.prepare('SELECT id FROM journal_reviews WHERE submission_id=? AND reviewer_id=?').get(s.id, reviewer.id);
  if (dup) return res.status(400).json({ error: 'That reviewer is already invited.' });
  db.prepare("INSERT INTO journal_reviews (submission_id, reviewer_id, status, invited_at) VALUES (?,?,?,?)").run(s.id, reviewer.id, 'invited', now());
  if (s.status === 'submitted' || s.status === 'screening') db.prepare("UPDATE journal_submissions SET status='under_review', updated_at=? WHERE id=?").run(now(), s.id);
  res.json({ ok: true });
});

// --- editor: record a decision ---
app.post('/api/journal/editor/decision/:id', requireAuth, (req, res) => {
  if (!isEditor(req.user)) return res.status(403).json({ error: 'Editor access required.' });
  const s = db.prepare('SELECT * FROM journal_submissions WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found.' });
  const decision = (req.body || {}).decision;
  const map = { accept: 'accepted', minor: 'minor_revision', major: 'major_revision', reject: 'rejected' };
  if (!map[decision]) return res.status(400).json({ error: 'Unknown decision.' });
  db.prepare("UPDATE journal_submissions SET status=?, editor_id=?, decision_note=?, updated_at=? WHERE id=?")
    .run(map[decision], req.user.id, cap((req.body || {}).note, 5000), now(), s.id);
  res.json({ ok: true });
});

// --- editor: publish an accepted manuscript into an issue ---
app.post('/api/journal/editor/publish/:id', requireAuth, (req, res) => {
  if (!isEditor(req.user)) return res.status(403).json({ error: 'Editor access required.' });
  const s = db.prepare('SELECT * FROM journal_submissions WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found.' });
  if (s.status !== 'accepted') return res.status(400).json({ error: 'Only accepted manuscripts can be published.' });
  const dt = new Date(now());
  const volume = dt.getUTCFullYear() - 2025; // Vol 1 = 2026
  const issue = dt.getUTCMonth() + 1;
  // reserve a DOI (real, resolvable once CROSSREF_DOI_PREFIX is set + deposited)
  const doi = DOI_PREFIX ? `${DOI_PREFIX}/${doiSuffix({ volume, issue, id: s.id })}` : '';
  db.prepare("UPDATE journal_submissions SET status='published', volume=?, issue=?, published_at=?, doi=?, updated_at=? WHERE id=?").run(volume, issue, now(), doi, now(), s.id);
  res.json({ ok: true, volume, issue, doi: doi || `${doiSuffix({ volume, issue, id: s.id })} (prefix pending)` });
});

// --- editor: set/override the DOI once a Crossref prefix is registered ---
app.post('/api/journal/editor/doi/:id', requireAuth, (req, res) => {
  if (!isEditor(req.user)) return res.status(403).json({ error: 'Editor access required.' });
  const s = db.prepare('SELECT * FROM journal_submissions WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found.' });
  const doi = cap((req.body || {}).doi, 200).trim();
  if (doi && !/^10\.\d{4,9}\/\S+$/.test(doi)) return res.status(400).json({ error: 'A DOI looks like 10.xxxxx/suffix.' });
  db.prepare("UPDATE journal_submissions SET doi=?, updated_at=? WHERE id=?").run(doi, now(), s.id);
  res.json({ ok: true, doi });
});

// --- reviewer: my invitations ---
app.get('/api/journal/reviews', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT r.*, s.ms_id, s.title, s.abstract, s.track, s.status sub_status
    FROM journal_reviews r JOIN journal_submissions s ON s.id=r.submission_id
    WHERE r.reviewer_id = ? ORDER BY r.invited_at DESC`).all(req.user.id);
  res.json({ reviews: rows.map(r => ({ id: r.id, submission_id: r.submission_id, ms_id: r.ms_id, title: r.title, abstract: r.abstract, track: r.track, status: r.status, sub_status: r.sub_status, invited_at: r.invited_at })) });
});

// --- reviewer: submit or decline a review ---
app.post('/api/journal/review/:id', requireAuth, (req, res) => {
  const rev = db.prepare('SELECT * FROM journal_reviews WHERE id = ? AND reviewer_id = ?').get(Number(req.params.id), req.user.id);
  if (!rev) return res.status(404).json({ error: 'Review invitation not found.' });
  const b = req.body || {};
  if (b.action === 'decline') { db.prepare("UPDATE journal_reviews SET status='declined' WHERE id=?").run(rev.id); return res.json({ ok: true }); }
  const rec = b.recommendation;
  if (!['accept', 'minor', 'major', 'reject'].includes(rec)) return res.status(400).json({ error: 'Choose a recommendation.' });
  const scores = {};
  for (const k of ['originality', 'contribution', 'methodology', 'clarity', 'literature', 'ethics']) {
    const v = Number((b.scores || {})[k]); if (v >= 1 && v <= 5) scores[k] = v;
  }
  if (Object.keys(scores).length < 6) return res.status(400).json({ error: 'Score every criterion (1–5).' });
  const commentsAuthor = cap(b.comments_author, 20000);
  if (commentsAuthor.length < 150) return res.status(400).json({ error: 'Comments to the author must be substantive (150+ characters).' });
  db.prepare("UPDATE journal_reviews SET scores=?, recommendation=?, comments_author=?, comments_editor=?, coi=?, status='submitted', submitted_at=? WHERE id=?")
    .run(JSON.stringify(scores), rec, commentsAuthor, cap(b.comments_editor, 10000), cap(b.coi, 1000), now(), rev.id);
  res.json({ ok: true });
});

// --- public: published issues archive ---
app.get('/api/journal/issues', (_req, res) => {
  const rows = db.prepare("SELECT id, ms_id, title, abstract, keywords, track, authors_meta, volume, issue, published_at, doi FROM journal_submissions WHERE status='published' ORDER BY published_at DESC LIMIT 500").all();
  const articles = rows.map(s => ({ ms_id: s.ms_id, title: s.title, abstract: s.abstract, keywords: s.keywords, track: s.track, volume: s.volume, issue: s.issue, published_at: s.published_at, doi: fullDoi(s), doiPending: !s.doi && !DOI_PREFIX, authors: safeJson(s.authors_meta, []).map(a => a.name).filter(Boolean) }));
  res.json({ articles, tracks: JOURNAL_TRACKS });
});
app.get('/api/journal/article/:msId', (req, res) => {
  const s = db.prepare("SELECT * FROM journal_submissions WHERE ms_id = ? AND status='published'").get(String(req.params.msId));
  if (!s) return res.status(404).json({ error: 'Article not found.' });
  res.json({ article: { ms_id: s.ms_id, title: s.title, abstract: s.abstract, keywords: s.keywords, track: s.track,
    authors: safeJson(s.authors_meta, []), manuscript: s.manuscript, volume: s.volume, issue: s.issue, published_at: s.published_at,
    doi: fullDoi(s), doiPending: !s.doi && !DOI_PREFIX, doiSuffix: doiSuffix(s),
    declarations: (() => { const d = safeJson(s.declarations, {}); return { funding: d.funding, dataAvailability: d.dataAvailability, aiUse: d.aiUse }; })() } });
});

// ---------- feedback: any visitor can send us a note (recipients hidden) ----------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FEEDBACK_TO = ['nagesh@rewiseed.com', 'johann@rewiseed.com'];
app.post('/api/feedback', async (req, res) => {
  if (!rateLimit('fb:' + req.ip, 8, 60 * 60_000)) return res.status(429).json({ error: 'Thanks — you have sent a few already. Please try again later.' });
  const message = cap((req.body || {}).message, 5000).trim();
  const fromEmail = cap((req.body || {}).email, 254).trim();
  const page = cap((req.body || {}).page, 300);
  if (message.length < 3) return res.status(400).json({ error: 'Please write your feedback first.' });
  if (fromEmail && !EMAIL_RE.test(fromEmail)) return res.status(400).json({ error: 'That reply email doesn’t look valid — leave it blank or fix it.' });
  const u = currentUser(req);
  const html = `<h3>New feedback — ItsMyResearch</h3>
    <p><b>Message:</b></p><p style="white-space:pre-wrap">${esc(message)}</p>
    <hr/><p style="color:#666;font-size:13px">
      Reply-to: ${esc(fromEmail || (u && u.email) || 'not provided')}<br/>
      Account: ${u ? esc(u.email + ' (' + u.role + ')') : 'not signed in'}<br/>
      Page: ${esc(page || 'unknown')}</p>`;
  // send to each internal recipient; addresses never leave the server
  const results = await Promise.allSettled(FEEDBACK_TO.map(to => sendEmail(to, 'ItsMyResearch feedback', html)));
  const anyOk = results.some(r => r.status === 'fulfilled');
  if (!anyOk) { console.error('feedback email failed', results.map(r => r.reason?.message)); return res.status(502).json({ error: 'Could not send just now — please try again shortly.' }); }
  const dev = results.every(r => r.status === 'fulfilled' && r.value?.dev);
  res.json({ ok: true, ...(dev ? { devNote: 'Email sending not configured — feedback logged to server console.' } : {}) });
  if (dev) console.log(`[dev-feedback] from ${fromEmail || (u && u.email) || 'anon'}: ${message}`);
});

// ---------- usage metrics (privacy-respecting: tool id + output size only) ----------
// ---------- billing routes ----------
app.get('/api/billing/status', (req, res) => {
  const u = currentUser(req);
  const base = {
    configured: BILLING_CONFIGURED, enforced: BILLING_ENFORCED, signedIn: !!u,
    priceInr: PLAN_AMOUNT_PAISE / 100, monthlyCredits: MONTHLY_CREDITS,
    topupInr: TOPUP_AMOUNT_PAISE / 100, topupCredits: TOPUP_CREDITS,
    weights: { standard: '≤20k chars = 1 credit', large: '≤80k = 2', heavy: '≤200k = 4' },
    paperUnlockCredits: PAPER_UNLOCK_CREDITS,
  };
  if (!u) return res.json(base);
  refreshFreeCredits(u);
  const staff = ['admin', 'superadmin'].includes(u.role);
  res.json({ ...base, plan: u.plan, planStatus: u.plan_status, credits: u.credits, freeRunUsed: !!u.free_run_used, staff, unlimited: staff,
    role: u.role, freeMonthly: FREE_ALLOWANCE[u.role] || 0,
    nextFreeRefresh: FREE_ALLOWANCE[u.role] ? (u.free_reset_at || 0) + 30 * 24 * 3600_000 : null });
});

app.post('/api/billing/subscribe', requireAuth, async (req, res) => {
  if (!BILLING_CONFIGURED) return res.status(503).json({ error: 'Payments are not configured yet.' });
  if (!rateLimit('sub:' + req.user.id, 10, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  try {
    const planId = await getPlanId();
    const sub = await rzp('/subscriptions', 'POST', {
      plan_id: planId, total_count: 120, quantity: 1, customer_notify: 1,
      notes: { user_id: String(req.user.id), email: req.user.email },
    });
    db.prepare('UPDATE users SET rzp_subscription_id = ? WHERE id = ?').run(sub.id, req.user.id);
    res.json({ subscriptionId: sub.id, keyId: RZP_KEY_ID, name: 'ItsMyResearch Pro', email: req.user.email });
  } catch (e) {
    console.error('subscribe failed:', e.message);
    res.status(502).json({ error: 'Could not start the subscription — try again shortly.' });
  }
});

app.post('/api/billing/verify-sub', requireAuth, (req, res) => {
  const { paymentId, subscriptionId, signature } = req.body || {};
  if (!paymentId || !subscriptionId || !signature) return res.status(400).json({ error: 'Missing payment details.' });
  if (db.prepare('SELECT rzp_subscription_id FROM users WHERE id = ?').get(req.user.id).rzp_subscription_id !== subscriptionId) {
    return res.status(403).json({ error: 'Subscription does not belong to this account.' });
  }
  const expected = hmacHex(RZP_KEY_SECRET, `${cap(paymentId, 100)}|${cap(subscriptionId, 100)}`);
  if (!safeEqual(signature, expected)) return res.status(400).json({ error: 'Payment could not be verified.' });
  grantCredits(req.user.id, 'sub', cap(paymentId, 100), subscriptionId, PLAN_AMOUNT_PAISE, MONTHLY_CREDITS, true);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, credits: u.credits, plan: u.plan });
});

// cancel the subscription — access continues until the period ends (cancel_at_cycle_end)
app.post('/api/billing/cancel', requireAuth, async (req, res) => {
  if (!BILLING_CONFIGURED) return res.status(503).json({ error: 'Payments are not configured yet.' });
  if (!rateLimit('cancel:' + req.user.id, 6, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  const u = db.prepare('SELECT rzp_subscription_id, plan_status FROM users WHERE id = ?').get(req.user.id);
  if (!u.rzp_subscription_id || u.plan_status !== 'active') return res.status(400).json({ error: 'No active subscription to cancel.' });
  try {
    await rzp(`/subscriptions/${u.rzp_subscription_id}/cancel`, 'POST', { cancel_at_cycle_end: 1 });
    db.prepare("UPDATE users SET plan_status = 'cancelled' WHERE id = ?").run(req.user.id);
    res.json({ ok: true, message: 'Subscription cancelled — you keep Pro access and your credits until the end of the current billing period, then it won’t renew.' });
  } catch (e) {
    console.error('cancel failed:', e.message);
    res.status(502).json({ error: 'Could not cancel right now — try again shortly, or contact us.' });
  }
});

// full-paper unlock: charge a fixed credit amount, then the client generates the rest
const PAPER_UNLOCK_CREDITS = 6;
app.post('/api/paper-unlock', requireAuth, (req, res) => {
  if (!BILLING_ENFORCED) return res.json({ ok: true, metered: false });
  if (['admin', 'superadmin'].includes(req.user.role)) return res.json({ ok: true, metered: false, staff: true });
  if (!rateLimit('paperu:' + req.user.id, 20, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  const cost = PAPER_UNLOCK_CREDITS;
  const result = db.transaction(() => {
    const cur = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
    if (cur.credits >= cost) { db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(cost, req.user.id); return { ok: true, remaining: cur.credits - cost }; }
    return { ok: false, have: cur.credits };
  })();
  if (result.ok) return res.json({ ok: true, metered: true, cost, remaining: result.remaining });
  maybeSendCreditReminder(req.user); // out of credits → reminder email (rate-limited)
  res.status(402).json({ error: `Unlocking the full paper costs ${cost} credits — you have ${result.have}. Top up ₹${TOPUP_AMOUNT_PAISE / 100} for ${TOPUP_CREDITS} credits, or subscribe to Pro.`, reason: 'topup', cost });
});

app.post('/api/billing/topup', requireAuth, async (req, res) => {
  if (!BILLING_CONFIGURED) return res.status(503).json({ error: 'Payments are not configured yet.' });
  if (!rateLimit('topup:' + req.user.id, 10, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts — wait a few minutes.' });
  try {
    const order = await rzp('/orders', 'POST', {
      amount: TOPUP_AMOUNT_PAISE, currency: 'INR', receipt: `topup_${req.user.id}_${now()}`,
      notes: { user_id: String(req.user.id), kind: 'topup' },
    });
    res.json({ orderId: order.id, amount: order.amount, keyId: RZP_KEY_ID, email: req.user.email });
  } catch (e) {
    console.error('topup order failed:', e.message);
    res.status(502).json({ error: 'Could not start the payment — try again shortly.' });
  }
});

app.post('/api/billing/verify-topup', requireAuth, (req, res) => {
  const { paymentId, orderId, signature } = req.body || {};
  if (!paymentId || !orderId || !signature) return res.status(400).json({ error: 'Missing payment details.' });
  const expected = hmacHex(RZP_KEY_SECRET, `${cap(orderId, 100)}|${cap(paymentId, 100)}`);
  if (!safeEqual(signature, expected)) return res.status(400).json({ error: 'Payment could not be verified.' });
  grantCredits(req.user.id, 'topup', cap(paymentId, 100), cap(orderId, 100), TOPUP_AMOUNT_PAISE, TOPUP_CREDITS, false);
  const u = db.prepare('SELECT credits FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, credits: u.credits });
});

// the metering gate: called by the client before every AI run
app.post('/api/run-credit', (req, res) => {
  if (!BILLING_ENFORCED) return res.json({ ok: true, metered: false });
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Sign in to run tools — your first AI run is free.', reason: 'signin' });
  // staff run the platform — never metered
  if (['admin', 'superadmin'].includes(u.role)) return res.json({ ok: true, metered: false, staff: true });
  refreshFreeCredits(u); // apply the monthly free allowance before charging
  if (!rateLimit('runc:' + u.id, 60, 15 * 60_000)) return res.status(429).json({ error: 'Too many runs — wait a few minutes.' });
  const isData = (req.body || {}).mode === 'data'; // non-AI run (search, lookup, comparison, model run)
  const chars = Math.max(0, Math.min(10_000_000, Number((req.body || {}).chars) || 0));
  const w = isData ? (DATA_RUN_COST[String((req.body || {}).tool)] || 1) : runWeight(chars);
  if (w === 0) return res.status(400).json({ error: 'This document is too large for one run (200k character limit) — split it into parts.', reason: 'toolarge' });
  const result = db.transaction(() => {
    const cur = db.prepare('SELECT credits, free_run_used, plan_status FROM users WHERE id = ?').get(u.id);
    if (!cur.free_run_used && w <= 2 && !isData) { // the welcome free run covers an AI generation, not data runs
      db.prepare('UPDATE users SET free_run_used = 1 WHERE id = ?').run(u.id);
      return { ok: true, freeRun: true, remaining: cur.credits, weight: w };
    }
    if (cur.credits >= w) {
      db.prepare('UPDATE users SET credits = credits - ? WHERE id = ?').run(w, u.id);
      return { ok: true, remaining: cur.credits - w, weight: w };
    }
    return { ok: false, active: cur.plan_status === 'active', freeUsed: !!cur.free_run_used, weight: w };
  })();
  if (result.ok) return res.json({ ...result, metered: true });
  maybeSendCreditReminder(u); // out of credits → reminder email (rate-limited)
  const heavyFirst = !result.freeUsed && result.weight > 2;
  res.status(402).json({
    error: heavyFirst
      ? 'Heavy documents (over 80k characters) need a Pro plan — your free run covers standard and large documents.'
      : result.active
        ? `Not enough credits for this run (needs ${result.weight}). Top up ₹${TOPUP_AMOUNT_PAISE / 100} for ${TOPUP_CREDITS} more, or wait for your monthly renewal.`
        : `You're out of credits. Your free allowance refreshes monthly, or ItsMyResearch Pro is ₹499/month for ${MONTHLY_CREDITS} run credits.`,
    reason: result.active ? 'topup' : 'subscribe',
  });
});

app.post('/api/track', (req, res) => {
  if (!rateLimit('track:' + req.ip, 120, 15 * 60_000)) return res.status(429).json({});
  const { tool, kind, outChars } = req.body || {};
  if (!TRACKABLE.has(String(tool))) return res.status(400).json({});
  const u = currentUser(req);
  db.prepare('INSERT INTO events (ts, user_id, tool, kind, out_chars) VALUES (?,?,?,?,?)')
    .run(now(), u ? u.id : null, String(tool), ['run', 'search', 'export'].includes(kind) ? kind : 'run', Math.max(0, Math.min(2_000_000, Number(outChars) || 0)));
  res.json({ ok: true });
});

app.get('/api/admin/analytics', requireAuth, requireAdmin, (req, res) => {
  const since30 = now() - 30 * 24 * 3600_000;
  const since7 = now() - 7 * 24 * 3600_000;
  let orgFilter = '', orgArgs = [];
  if (req.user.role === 'admin') {
    // org admins see aggregate for their institution's signed-in users only
    orgFilter = 'AND user_id IN (SELECT id FROM users WHERE org = ?)';
    orgArgs = [req.user.org];
  }
  const byTool = db.prepare(`
    SELECT tool, COUNT(*) runs, SUM(out_chars) chars, COUNT(DISTINCT user_id) users
    FROM events WHERE ts > ? ${orgFilter} GROUP BY tool ORDER BY runs DESC`).all(since30, ...orgArgs);
  const totals = db.prepare(`SELECT COUNT(*) runs, SUM(out_chars) chars FROM events WHERE ts > ? ${orgFilter}`).get(since30, ...orgArgs);
  const anonRuns = req.user.role === 'superadmin'
    ? db.prepare('SELECT COUNT(*) c FROM events WHERE ts > ? AND user_id IS NULL').get(since30).c : null;
  const users = req.user.role === 'superadmin' ? {
    total: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    confirmed: db.prepare('SELECT COUNT(*) c FROM users WHERE confirmed = 1').get().c,
    newLast30d: db.prepare('SELECT COUNT(*) c FROM users WHERE created_at > ?').get(since30).c,
    activeLast7d: db.prepare('SELECT COUNT(DISTINCT user_id) c FROM sessions WHERE expires > ?').get(now()).c,
  } : {
    total: db.prepare('SELECT COUNT(*) c FROM users WHERE org = ?').get(req.user.org).c,
  };
  // per-user feature usage (top 100 by runs in window); org admins see their org only
  const byUser = db.prepare(`
    SELECT e.user_id, u.email, u.role, u.plan_status, u.credits,
           COUNT(*) runs, SUM(e.out_chars) chars, COUNT(DISTINCT e.tool) toolsUsed,
           MAX(e.ts) lastActive
    FROM events e JOIN users u ON u.id = e.user_id
    WHERE e.ts > ? ${orgFilter.replace(/user_id/g, 'e.user_id')}
    GROUP BY e.user_id ORDER BY runs DESC LIMIT 100`).all(since30, ...orgArgs)
    .map(r => {
      const tools = db.prepare(
        'SELECT tool, COUNT(*) runs FROM events WHERE user_id = ? AND ts > ? GROUP BY tool ORDER BY runs DESC LIMIT 5'
      ).all(r.user_id, since30);
      return { email: r.email, role: r.role, pro: r.plan_status === 'active', credits: r.credits,
               runs: r.runs, estTokens: Math.round((r.chars || 0) / 4), toolsUsed: r.toolsUsed,
               lastActive: r.lastActive, topTools: tools };
    });
  // billing & cost metrics — superadmin only (revenue is platform-wide, not org-scoped)
  let billing = null;
  if (req.user.role === 'superadmin') {
    const pay30 = db.prepare('SELECT kind, COUNT(*) n, SUM(amount) amt, SUM(credits) cr FROM payments WHERE ts > ? GROUP BY kind').all(since30);
    const payAll = db.prepare('SELECT COUNT(*) n, SUM(amount) amt FROM payments').get();
    billing = {
      activePro: db.prepare("SELECT COUNT(*) c FROM users WHERE plan_status = 'active'").get().c,
      cancelling: db.prepare("SELECT COUNT(*) c FROM users WHERE plan_status = 'cancelled'").get().c,
      // amounts are paise; expose INR
      last30d: pay30.map(p => ({ kind: p.kind, count: p.n, inr: Math.round((p.amt || 0) / 100), creditsGranted: p.cr || 0 })),
      allTimeInr: Math.round((payAll.amt || 0) / 100),
      allTimePayments: payAll.n || 0,
      creditsOutstanding: db.prepare('SELECT SUM(credits) s FROM users').get().s || 0,
      creditsSpent30d: db.prepare("SELECT COUNT(*) c FROM events WHERE ts > ? AND kind = 'run' AND user_id IS NOT NULL").get(since30).c,
      byRole: db.prepare('SELECT role, COUNT(*) n, SUM(credits) credits FROM users GROUP BY role').all(),
    };
  }
  res.json({
    windowDays: 30,
    byTool: byTool.map(r => ({ tool: r.tool, runs: r.runs, estTokens: Math.round((r.chars || 0) / 4), users: r.users })),
    totals: { runs: totals.runs || 0, estTokens: Math.round((totals.chars || 0) / 4), anonRuns },
    users, byUser, billing,
    note: 'Token figures are estimates derived from output length (~4 chars/token). BYOK requests go directly from the browser to the AI provider, so exact provider token counts are not visible to this server.',
  });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Only super admins can delete accounts.' });
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'superadmin') return res.status(403).json({ error: 'Super admin accounts cannot be deleted here.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Use your profile page to delete your own account.' });
  deleteUserCascade(target.id);
  res.json({ ok: true });
});

// ---------- tool access gate ----------
// Tools require an account: signed-out visitors can browse the whole site
// (home, about, pricing, journal, guides) but must sign in to open any tool.
// Signed-in users with a restricted tool list are blocked from ungranted tools.
app.use((req, res, next) => {
  const name = req.path.replace(/^\//, '').replace(/\.html$/, '');
  if (!TOOL_IDS.has(name)) return next();
  const u = currentUser(req);
  if (!u) {
    // non-logged-in → sign-in-required page (keeps them oriented and offers a free account)
    const nextPath = '/' + name + '.html';
    return res.status(401).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Sign in to use this tool — ItsMyResearch</title><link rel="stylesheet" href="/shared.css"/><script>(function(){var t=localStorage.getItem('rewiseed_theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-theme',t);})();</script></head>
<body><div class="hero"><h1>Sign in to use this tool</h1>
<p class="lede">You're welcome to explore ItsMyResearch, but the tools themselves need a free account — it's how we keep your work private and metered to you. Create one in under a minute, or sign in to continue.</p></div>
<main style="max-width:520px;text-align:center"><div class="card">
<div class="btn-row" style="justify-content:center;gap:10px"><a href="/signin.html?next=${encodeURIComponent(nextPath)}"><button type="button">Sign in</button></a>
<a href="/signup.html?next=${encodeURIComponent(nextPath)}"><button type="button" class="ghost">Create free account</button></a></div>
<p class="hint" style="margin:12px 0 0">Browsing is open to everyone — the home page, the Research Journey, pricing, and the JBMS journal need no account.</p>
<div class="btn-row" style="justify-content:center;margin-top:10px"><a class="link" href="/index.html">← Back to home</a></div>
</div></main>
<script src="/shared.js"></script><script>Rewiseed.renderNav('');</script></body></html>`);
  }
  const eff = effectiveTools(u); // null = all tools
  if (eff === null || eff.has(name)) return next();
  const inStudent = STUDENT_TOOLS.has(name), inBasic = BASIC_TOOLS.has(name);
  const includedIn = inBasic ? 'every account level' : inStudent ? 'the Student level and above' : 'the Educator / Researcher level';
  res.status(403).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Tool not in your plan — ItsMyResearch</title><link rel="stylesheet" href="/shared.css"/></head>
<body><div class="hero"><h1>This tool isn't in your plan yet</h1>
<p class="lede">You're signed in as <b>${esc(u.role)}</b>. This tool is included in <b>${includedIn}</b>. Two ways to get it: ask an administrator to raise your level or grant this tool, or see what each level includes.</p></div>
<main style="max-width:520px;text-align:center"><div class="card">
<div class="btn-row" style="justify-content:center"><a href="/pricing.html"><button type="button">See plans &amp; what's included</button></a>
<a href="/index.html"><button type="button" class="ghost">Back to home</button></a></div>
<p class="hint" style="margin:12px 0 0">Institutional users: your admin can enable tools per account from the Admin console. You keep full access to everything already in your level.</p>
</div></main>
<script src="/shared.js"></script><script>Rewiseed.renderNav('');</script></body></html>`);
});

// ---------- static suite ----------
// Never serve server internals: the database, source, configs, deps.
const BLOCKED_STATIC = /^\/(data(\/|$)|node_modules(\/|$)|server\.js$|dev-server\.py$|package(-lock)?\.json$|\.gitignore$)/;
app.use((req, res, next) => {
  if (BLOCKED_STATIC.test(req.path)) return res.status(404).send('Not found');
  next();
});
// legacy-friendly alias: the APA formatter grew into the Reference Style Generator
app.get(['/reference-style-generator', '/reference-style-generator.html'], (_req, res) => res.redirect(301, '/apa-formatter'));
app.get(['/pls-sem', '/pls-sem.html', '/ai-pls', '/ai-pls.html'], (_req, res) => res.redirect(301, '/statpls'));
app.get(['/peer-review-simulator', '/peer-review-simulator.html'], (_req, res) => res.redirect(301, '/ai-peer-review'));
app.use(express.static(__dirname, { extensions: ['html'], index: 'index.html' }));

// unknown API route → clean JSON 404 (no HTML fallthrough)
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// fail closed and quiet: log the real error server-side, never leak internals
// (message, stack, paths) to the client
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('unhandled error:', err?.message);
  if (res.headersSent) return;
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ error: 'Malformed request.' });
  res.status(500).json({ error: 'Something went wrong on our side — try again.' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`ItsMyResearch serving on :${PORT} (email: ${RESEND_API_KEY ? 'live' : 'dev mode'})`));
