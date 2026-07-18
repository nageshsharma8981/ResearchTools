// ============================================================
// ReWiseEd Research Tools — application server
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
const EMAIL_FROM = process.env.EMAIL_FROM || 'ReWiseEd Research <noreply@rewiseed.com>';
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
const cap = (s, n) => String(s ?? '').slice(0, n).trim();

function publicUser(u, includePrivate = false) {
  const base = { id: u.id, email: u.email, name: u.name, role: u.role, org: u.org, photo: u.photo, linkedin: u.linkedin, twitter: u.twitter, about: u.about };
  if (includePrivate) { base.confirmed = !!u.confirmed; base.disabled = !!u.disabled; base.created_at = u.created_at; }
  return base;
}

// ---------- email ----------
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) return { dev: true };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
  });
  if (!r.ok) throw new Error(`email provider ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { dev: false };
}
const confirmEmailHtml = (name, link) => `
<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:24px">
  <h2 style="color:#1c1a17">Welcome to ReWiseEd Research${name ? ', ' + name.replace(/[<>&]/g, '') : ''}</h2>
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

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
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
  const { email, password, name, captchaToken } = req.body || {};
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
  if (existing) { hashPassword(password, rand(16)); return res.json(genericOk); }
  const salt = rand(16);
  const role = SUPERADMINS.includes(em) ? 'superadmin' : 'student';
  const info = db.prepare('INSERT INTO users (email, name, pass_hash, salt, role, created_at) VALUES (?,?,?,?,?,?)')
    .run(em, displayName, hashPassword(password, salt), salt, role, now());
  const confirmToken = rand(32);
  db.prepare('INSERT INTO tokens (token, user_id, kind, expires) VALUES (?,?,?,?)')
    .run(sha(confirmToken), info.lastInsertRowid, 'confirm', now() + 24 * 3600_000);
  const link = `${BASE_URL}/api/auth/confirm?token=${confirmToken}`;
  try {
    const sent = await sendEmail(em, 'Confirm your ReWiseEd Research account', confirmEmailHtml(displayName, link));
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
  if (!u.confirmed) return res.status(403).json({ error: 'Please confirm your email first — check your inbox.' });
  if (u.disabled) return res.status(403).json({ error: 'This account has been disabled. Contact your administrator.' });
  const token = rand(32);
  db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)').run(sha(token), u.id, now() + 30 * 24 * 3600_000);
  setSession(res, token, 30 * 24 * 3600_000);
  res.json({ ok: true, user: publicUser(u) });
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
  const { name, org, linkedin, twitter, about, photo } = req.body || {};
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
  if (photo !== undefined) {
    if (photo === '') clean.photo = '';
    else {
      if (typeof photo !== 'string' || photo.length > 400_000) return res.status(400).json({ error: 'Photo too large (300 KB max after compression).' });
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return res.status(400).json({ error: 'Photo must be a PNG, JPEG, or WebP image.' });
      clean.photo = photo;
    }
  }
  db.prepare('UPDATE users SET name=?, org=?, linkedin=?, twitter=?, about=?, photo=? WHERE id=?')
    .run(clean.name, clean.org, clean.linkedin, clean.twitter, clean.about, clean.photo, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id), true) });
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
  const { role, disabled, org } = req.body || {};
  if (req.user.role === 'admin') {
    // admins: only students in their own org, only enable/disable
    if (target.org !== req.user.org || target.role !== 'student') return res.status(403).json({ error: 'You can only manage students of your own institution.' });
    if (role !== undefined || org !== undefined) return res.status(403).json({ error: 'Only super admins can change roles or institutions.' });
  }
  const updates = {};
  if (disabled !== undefined) updates.disabled = disabled ? 1 : 0;
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

// ---------- static suite ----------
// Never serve server internals: the database, source, configs, deps.
const BLOCKED_STATIC = /^\/(data(\/|$)|node_modules(\/|$)|server\.js$|dev-server\.py$|package(-lock)?\.json$|\.gitignore$)/;
app.use((req, res, next) => {
  if (BLOCKED_STATIC.test(req.path)) return res.status(404).send('Not found');
  next();
});
app.use(express.static(__dirname, { extensions: ['html'], index: 'index.html' }));

app.listen(PORT, '0.0.0.0', () => console.log(`ReWiseEd Research serving on :${PORT} (email: ${RESEND_API_KEY ? 'live' : 'dev mode'})`));
