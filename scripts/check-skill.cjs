#!/usr/bin/env node
// check-skill.cjs - electron-recon integrity self-check
//
// Run:  node scripts/check-skill.cjs
// Exit: 0 = all good, 1 = something missing.

'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKILL_DIR = path.join(__dirname, '..');
const results = [];
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    failed++;
    results.push({ name, ok: false, detail: String(e && e.message || e) });
  }
}

function mustExist(rel) {
  const p = path.join(SKILL_DIR, rel);
  if (!fs.existsSync(p)) throw new Error('missing: ' + rel);
  return rel;
}

// 1. SKILL.md with valid frontmatter
check('SKILL.md', () => {
  mustExist('SKILL.md');
  const t = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
  if (!t.startsWith('---')) throw new Error('no frontmatter');
  for (const k of ['name:', 'description:', 'whenToUse:']) {
    if (!t.includes(k)) throw new Error('frontmatter missing ' + k);
  }
  return 'frontmatter ok';
});

// 2. orchestrator
check('scripts/recon.cjs', () => {
  mustExist('scripts/recon.cjs');
  execFileSync('node', ['--check', path.join(SKILL_DIR, 'scripts/recon.cjs')], { timeout: 30000 });
  const s = fs.statSync(path.join(SKILL_DIR, 'scripts/recon.cjs'));
  return (s.size / 1024).toFixed(1) + 'KB, syntax ok';
});

// 3. help output works
check('recon.cjs --help', () => {
  const out = execFileSync('node', [path.join(SKILL_DIR, 'scripts/recon.cjs'), '--help'], {
    encoding: 'utf8', timeout: 30000
  });
  if (!out.includes('electron-recon')) throw new Error('no banner');
  if (!out.includes('--probe-only')) throw new Error('no --probe-only');
  return 'help ok';
});

// 4. docs
check('README.md', () => {
  mustExist('README.md');
  mustExist('LICENSE');
  return 'README + LICENSE';
});

// 5. jscd dependency is discoverable (warn only, not fatal)
check('jscd skill', () => {
  const dir = process.env.JSCD_SKILL_DIR || 'C:\\Users\\LiuZY\\.dsh\\skills\\jscd-decompiler';
  const manage = path.join(dir, 'scripts', 'manage.cjs');
  if (!fs.existsSync(manage)) {
    throw new Error('not found at ' + dir + ' (set JSCD_SKILL_DIR)');
  }
  return 'manage.cjs found';
});

console.log('electron-recon integrity check');
console.log('='.repeat(46));
for (const r of results) {
  const mark = r.ok ? '\u2713' : '\u2717';
  console.log('  ' + mark + ' ' + r.name.padEnd(22) + (r.ok ? r.detail : '[' + r.detail + ']'));
}
console.log('='.repeat(46));
console.log(failed === 0
  ? 'Result: complete and usable'
  : 'Result: ' + failed + ' item(s) missing');
process.exit(failed === 0 ? 0 : 1);
