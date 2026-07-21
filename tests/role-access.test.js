// Role-based feature access: student (few tools), educator (all), admin/superadmin
// (all + user management). Mirrors the server's effectiveTools / collapse logic.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TOOL_IDS = new Set(['smart-literature-finder', 'doi-finder', 'originality-checker',
  'research-gap-identifier', 'research-question-generator', 'instrument-designer',
  'qualitative-coding-assistant', 'peer-review-simulator', 'citation-formatter', 'apa-formatter',
  'stats-advisor', 'literature-matrix', 'writing-polisher', 'citation-graph',
  'data-explorer', 'data-sources', 'scholar-profiles', 'statpls', 'rubric-lens',
  'abstract-generator', 'paper-generator', 'bibliometrics', 'journal-metrics', 'journal-rankings',
  'citation-integrity']);
const STUDENT_TOOLS = new Set(['smart-literature-finder', 'doi-finder', 'citation-formatter', 'apa-formatter',
  'writing-polisher', 'originality-checker', 'citation-integrity', 'rubric-lens',
  'research-question-generator', 'stats-advisor']);
const parseToolAccess = (s) => String(s || '').split(',').map(x => x.trim()).filter(x => TOOL_IDS.has(x));
const roleDefaultTools = (role) => role === 'student' ? STUDENT_TOOLS : null;
function effectiveTools(u) {
  const explicit = parseToolAccess(u.tool_access);
  if (explicit.length) return new Set(explicit);
  return roleDefaultTools(u.role);
}
// gate: returns true if the user may open `tool`
const canOpen = (u, tool) => { const e = effectiveTools(u); return e === null || e.has(tool); };

test('students get the curated set only', () => {
  const s = { role: 'student', tool_access: '' };
  assert.ok(canOpen(s, 'smart-literature-finder'), 'student can use lit finder');
  assert.ok(canOpen(s, 'citation-integrity'), 'student can use citation integrity');
  assert.ok(!canOpen(s, 'statpls'), 'student CANNOT use StatPLS');
  assert.ok(!canOpen(s, 'paper-generator'), 'student CANNOT use paper generator');
  assert.ok(!canOpen(s, 'bibliometrics'), 'student CANNOT use bibliometrics');
  assert.equal(effectiveTools(s).size, STUDENT_TOOLS.size);
});

test('educators and admins get everything by default', () => {
  for (const role of ['educator', 'admin', 'superadmin']) {
    const u = { role, tool_access: '' };
    assert.equal(effectiveTools(u), null, `${role} => unrestricted`);
    assert.ok(canOpen(u, 'statpls') && canOpen(u, 'paper-generator') && canOpen(u, 'journal-rankings'), `${role} can open advanced tools`);
  }
});

test('explicit override beats the role default (both directions)', () => {
  // admin grants a student two extra tools
  const grantedStudent = { role: 'student', tool_access: 'smart-literature-finder,statpls,bibliometrics' };
  assert.ok(canOpen(grantedStudent, 'statpls'), 'granted student can use StatPLS');
  assert.ok(!canOpen(grantedStudent, 'doi-finder'), 'override is exact — doi-finder not in it');
  // admin restricts an educator to a subset
  const limitedEducator = { role: 'educator', tool_access: 'smart-literature-finder,doi-finder' };
  assert.ok(!canOpen(limitedEducator, 'statpls'), 'restricted educator loses StatPLS');
});

// the collapse rule the save handler uses (kept identical to server.js)
function collapse(nextRole, toolAccess) {
  const def = roleDefaultTools(nextRole);
  const sel = new Set(toolAccess);
  const isDefault = def === null
    ? toolAccess.length === TOOL_IDS.size
    : (sel.size === def.size && [...def].every(t => sel.has(t)));
  return isDefault ? '' : toolAccess.join(',');
}
test('saving the exact role default collapses to "" so new tools auto-apply', () => {
  assert.equal(collapse('student', [...STUDENT_TOOLS]), '', 'student default => ""');
  assert.equal(collapse('educator', [...TOOL_IDS]), '', 'educator all => ""');
  assert.notEqual(collapse('student', [...TOOL_IDS]), '', 'student granted all => explicit CSV, not ""');
  assert.ok(collapse('student', ['statpls', 'doi-finder']).includes('statpls'), 'custom student set stored as CSV');
});

test('server wires role defaults into the gate, publicUser, and the update route', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.includes('const STUDENT_TOOLS'), 'STUDENT_TOOLS defined');
  assert.ok(server.includes('function effectiveTools'), 'effectiveTools defined');
  assert.ok(server.includes('tool_access: effectiveToolList(u)'), 'publicUser returns effective list');
  assert.ok(server.includes("['student', 'educator', 'admin']"), 'superadmin can set all three roles');
  assert.ok(server.includes("role IN ('student','educator')"), 'admin query includes educators');
});
