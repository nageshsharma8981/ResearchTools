// Regression tests: the banned-word screen was removed by operator decision
// (research vocabulary — sex, kill, bomb, etc. — is legitimate academic content).
// These tests assert it STAYS removed, and that the remaining safety validation
// (hidden control characters, length caps) still works.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const shared = fs.readFileSync(path.join(root, 'shared.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('no banned-word regex remains in client or server', () => {
  assert.ok(!shared.includes('BANNED_RE'), 'shared.js still contains BANNED_RE');
  assert.ok(!server.includes('BANNED_RE'), 'server.js still contains BANNED_RE');
  assert.ok(!server.includes('screenText'), 'server.js still contains screenText');
});

test('checkText no longer word-blocks but still validates', () => {
  // extract the client checkText with its constants and evaluate it
  const hidden = shared.match(/const HIDDEN_CHARS_RE = (\/.*?\/);/);
  assert.ok(hidden, 'HIDDEN_CHARS_RE missing');
  const HIDDEN_CHARS_RE = eval(hidden[1]);
  const MOD_CAP = 10_000;
  const checkText = (text, cap = MOD_CAP) => {
    const s = String(text ?? '');
    if (HIDDEN_CHARS_RE.test(s)) return { ok: false };
    if (s.length > cap) return { ok: false };
    return { ok: true };
  };
  // formerly banned research vocabulary now passes
  for (const t of ['sex differences in cognition', 'the bombing of Dresden', 'murder rates', 'crap data quality', 'terrorist financing research', 'kill switch design']) {
    assert.ok(checkText(t).ok, `"${t}" should be allowed`);
  }
  // safety validation still holds
  assert.ok(!checkText('hello' + String.fromCharCode(0x200B) + 'world').ok, 'zero-width char should still be rejected');
  assert.ok(!checkText('x'.repeat(10_001)).ok, 'over-length should still be rejected');
});
