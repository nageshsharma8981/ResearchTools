// Access gate: only educational emails (.edu / .edu.<cc> / .ac.<cc>),
// rewiseed.com admins, superadmins, and explicitly allow-listed addresses may
// hold accounts. Consumer mail (gmail, yahoo, outlook…) is refused.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// mirror the server's gate exactly (kept in sync with server.js)
const SUPERADMINS = ['nagesh@rewiseed.com', 'johann@rewiseed.com'];
const ADMIN_ORG_DOMAIN = 'rewiseed.com';
const ACADEMIC_RE = /\.(edu|ac)(\.[a-z]{2,})?$/i;
const emailDomain = (em) => { const i = String(em || '').lastIndexOf('@'); return i < 0 ? '' : em.slice(i + 1).toLowerCase(); };
function accessAllowed(email, envAllow = [], dbHit = false) {
  const em = String(email || '').toLowerCase().trim();
  const d = emailDomain(em);
  if (!d) return false;
  if (SUPERADMINS.includes(em)) return true;
  if (d === ADMIN_ORG_DOMAIN) return true;
  if (ACADEMIC_RE.test(d)) return true;
  if (envAllow.includes(em) || envAllow.includes(d)) return true;
  return dbHit;
}

// accessAllowed now decides the SIGNUP TIER (institutional → student, else → basic),
// it no longer blocks sign-up/sign-in. It must still classify emails correctly.
test('educational and rewiseed emails classify as institutional', () => {
  for (const em of ['prof@mit.edu', 'student@iitb.ac.in', 'r@cse.iitb.ac.in', 'a@ox.ac.uk',
    'b@unimelb.edu.au', 'c@nus.edu.sg', 'nagesh@rewiseed.com', 'anyone@rewiseed.com']) {
    assert.ok(accessAllowed(em), `${em} should classify institutional`);
  }
});

test('consumer and non-academic emails classify as non-institutional (basic tier)', () => {
  for (const em of ['just4nagesh@gmail.com', 'x@yahoo.com', 'y@outlook.com', 'z@acme.com',
    'w@example.education', 'v@foo.academy', 'q@company.com']) {
    assert.ok(!accessAllowed(em), `${em} should classify non-institutional`);
  }
});

test('env allowlist and DB allowlist are escape hatches', () => {
  assert.ok(accessAllowed('partner@ngo.org', ['partner@ngo.org']), 'env email allowlist');
  assert.ok(accessAllowed('anyone@trusted.org', ['trusted.org']), 'env domain allowlist');
  assert.ok(!accessAllowed('late@company.com'), 'not allowed without hit');
  assert.ok(accessAllowed('late@company.com', [], true), 'DB allowlist grants access');
});

test('signup assigns tier by email but no longer blocks anyone', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const signupIdx = server.indexOf("app.post('/api/auth/signup'");
  const block = server.slice(signupIdx, signupIdx + 4000);
  assert.ok(server.includes("accessAllowed(em) ? 'student' : 'basic'"), 'signup sets tier by accessAllowed');
  assert.ok(!block.includes('ACCESS_DENIED_MSG'), 'signup no longer 403-blocks non-institutional emails');
  assert.ok(server.includes("const BASIC_TOOLS = new Set(['smart-literature-finder', 'doi-finder'])"), 'basic tier limited to 2 tools');
});
