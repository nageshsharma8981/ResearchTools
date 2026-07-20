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
`);
// migrations for pre-existing databases
for (const col of ["terms_version TEXT NOT NULL DEFAULT ''", 'terms_accepted_at INTEGER NOT NULL DEFAULT 0', "tool_access TEXT NOT NULL DEFAULT ''", 'seen_intro INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch { /* already present */ }
}
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
  'qualitative-coding-assistant', 'peer-review-simulator', 'citation-formatter', 'apa-formatter',
  'stats-advisor', 'literature-matrix', 'writing-polisher', 'citation-graph',
  'data-explorer', 'data-sources', 'scholar-profiles', 'ai-pls', 'rubric-lens',
  'abstract-generator',
]);
// things that report usage but are not grantable/gateable pages
const TRACKABLE = new Set([...TOOL_IDS, 'assistant', 'library']);
const parseToolAccess = (s) => String(s || '').split(',').map(x => x.trim()).map(x => x === 'pls-sem' ? 'ai-pls' : x).filter(x => TOOL_IDS.has(x)); // pls-sem: legacy id after the AI PLS rename

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
// cap: length-limit AND strip characters used in unicode spoofing attacks —
// C0 controls (keep \n \t), zero-width chars, and bidi override marks.
const cap = (s, n) => String(s ?? '')
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F​-‏‪-‮⁦-⁩﻿]/g, '')
  .slice(0, n).trim();

function publicUser(u, includePrivate = false) {
  const base = { id: u.id, email: u.email, name: u.name, role: u.role, org: u.org, photo: u.photo, linkedin: u.linkedin, twitter: u.twitter, about: u.about, tool_access: parseToolAccess(u.tool_access), seen_intro: !!u.seen_intro };
  if (includePrivate) { base.confirmed = !!u.confirmed; base.disabled = !!u.disabled; base.created_at = u.created_at; }
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
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '500kb' }));

// Content-Security-Policy notes: inline scripts/styles are how this suite ships
// (no build step), so 'unsafe-inline' stays; 'wasm-unsafe-eval' + worker-src
// blob: are required by the built-in WebLLM model; connect-src must stay open
// to https + localhost because BYOK users point at any provider they choose.
// The teeth are in object-src/base-uri/form-action/frame-ancestors.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "worker-src 'self' blob:",
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
  const role = SUPERADMINS.includes(em) ? 'superadmin' : 'student';
  const info = db.prepare('INSERT INTO users (email, name, pass_hash, salt, role, created_at, terms_version, terms_accepted_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(em, displayName, hashPassword(password, salt), salt, role, now(), TERMS_VERSION, now());
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
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  let rows;
  if (req.user.role === 'superadmin') {
    rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 500').all();
  } else {
    // org-scoped: admins see only their own school/university, never other admins/superadmins
    rows = db.prepare("SELECT * FROM users WHERE org = ? AND role = 'student' ORDER BY created_at DESC LIMIT 500").all(req.user.org);
  }
  res.json({ users: rows.map(u => publicUser(u, true)), scope: req.user.role === 'superadmin' ? 'all' : req.user.org });
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'superadmin') return res.status(403).json({ error: 'Super admin accounts cannot be modified.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Use your profile page to edit your own account.' });
  const { role, disabled, org, toolAccess } = req.body || {};
  if (req.user.role === 'admin') {
    // admins: only students in their own org — enable/disable and tool access
    if (target.org !== req.user.org || target.role !== 'student') return res.status(403).json({ error: 'You can only manage students of your own institution.' });
    if (role !== undefined || org !== undefined) return res.status(403).json({ error: 'Only super admins can change roles or institutions.' });
  }
  const updates = {};
  if (disabled !== undefined) updates.disabled = disabled ? 1 : 0;
  if (toolAccess !== undefined) {
    if (!Array.isArray(toolAccess) || !toolAccess.length || toolAccess.some(t => !TOOL_IDS.has(String(t)))) {
      return res.status(400).json({ error: 'Select at least one tool — to block everything, disable the account instead.' });
    }
    // full selection = unrestricted (stored as ''); partial = CSV of granted ids
    updates.tool_access = toolAccess.length === TOOL_IDS.size ? '' : toolAccess.join(',');
  }
  if (req.user.role === 'superadmin') {
    if (role !== undefined) {
      if (!['student', 'admin'].includes(role)) return res.status(400).json({ error: 'Role must be student or admin.' });
      updates.role = role;
    }
    if (org !== undefined) updates.org = cap(org, 120);
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update.' });
  const sets = Object.keys(updates).map(k => `${k}=?`).join(', ');
  db.prepare(`UPDATE users SET ${sets} WHERE id=?`).run(...Object.values(updates), target.id);
  if (updates.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(target.id), true) });
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

// ---------- usage metrics (privacy-respecting: tool id + output size only) ----------
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
  res.json({
    windowDays: 30,
    byTool: byTool.map(r => ({ tool: r.tool, runs: r.runs, estTokens: Math.round((r.chars || 0) / 4), users: r.users })),
    totals: { runs: totals.runs || 0, estTokens: Math.round((totals.chars || 0) / 4), anonRuns },
    users,
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
// When a signed-in user has a restricted tool list, block ungranted tool
// pages. Anonymous visitors keep public access (the product default).
app.use((req, res, next) => {
  const name = req.path.replace(/^\//, '').replace(/\.html$/, '');
  if (!TOOL_IDS.has(name)) return next();
  const u = currentUser(req);
  if (!u) return next();
  const allowed = parseToolAccess(u.tool_access);
  if (!allowed.length || allowed.includes(name)) return next();
  res.status(403).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Tool not enabled — ItsMyResearch</title><link rel="stylesheet" href="/shared.css"/></head>
<body><div class="hero"><h1>Tool not enabled</h1><p class="lede">Your administrator hasn't enabled this tool for your account. If you think that's a mistake, contact your institution's admin.</p></div>
<main style="max-width:480px;text-align:center"><div class="card"><a href="/index.html"><button type="button">Back to home</button></a></div></main>
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
app.get(['/pls-sem', '/pls-sem.html'], (_req, res) => res.redirect(301, '/ai-pls'));
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
