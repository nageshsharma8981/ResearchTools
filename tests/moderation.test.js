// Unit tests for the content-moderation word screen.
// Run: node --test tests/
// Tests BOTH copies (client shared.js + server server.js) stay in sync and behave.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const grab = (file, marker) => {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const m = src.match(/const BANNED_RE = (\/.*?\/i);/);
  assert.ok(m, `${file}: BANNED_RE not found`);
  assert.ok(src.includes(marker), `${file}: KEEP IN SYNC marker missing`);
  return eval(m[1]);
};
const clientRe = grab('shared.js', 'KEEP IN SYNC with the server copy');
const serverRe = grab('server.js', 'KEEP IN SYNC with the client copy');

test('client and server regexes are identical', () => {
  assert.strictEqual(clientRe.source, serverRe.source);
  assert.strictEqual(clientRe.flags, serverRe.flags);
});

const BLOCKED = [
  // each category, base form
  'sex', 'crap', 'shit', 'boobs', 'fuck', 'kill', 'bomb', 'murder', 'rape', 'porn', 'terrorist',
  // uppercase
  'SEX', 'FUCK', 'BOMB',
  // suffix variants
  'sexes', 'crappy', 'shitty', 'boob', 'fucking', 'fucked', 'killed', 'killing', 'killer',
  'bombs', 'bombed', 'bombing', 'murdered', 'murderous', 'raped', 'raping', 'rapist',
  'porno', 'pornography', 'pornographic', 'terrorists', 'terrorism',
  // in sentences
  'I will kill you', 'The Bombing started', 'watch PORN now',
];
const ALLOWED = [
  // required false-positive safety set
  'class', 'skills', 'Essex', 'bombastic', 'assessment',
  // more boundary safety
  'Sussex', 'Middlesex', 'killjoy is one word but skills are many', 'rapid', 'rapport',
  'therapist', 'scrappy', 'terror', 'bombardier',
  'the class assessment covers skills', 'shipment', 'grape', 'drape', 'craftsmanship',
];

for (const w of BLOCKED) {
  test(`blocks: ${w}`, () => { assert.ok(clientRe.test(w), `expected "${w}" to be blocked`); });
}
for (const w of ALLOWED) {
  test(`allows: ${w}`, () => { assert.ok(!clientRe.test(w), `false positive on "${w}"`); });
}
