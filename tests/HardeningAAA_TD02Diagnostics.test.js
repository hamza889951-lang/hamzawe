'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SKIP = { tests: true, '.git': true, node_modules: true };
function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); }
function walk(dir, offenders) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
    if (SKIP[entry.name]) return;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(abs, offenders);
    if (!entry.isFile() || !entry.name.endsWith('.js')) return;
    const rel = path.relative(ROOT, abs);
    if (rel === 'Clock.js') return;
    const src = strip(fs.readFileSync(abs, 'utf8'));
    if (/new\s+Date\s*\(\s*\)/.test(src) || /Date\.now\s*\(/.test(src)) offenders.push(rel);
  });
}
const offenders = [];
walk(ROOT, offenders);
console.log('TD02 DIAGNOSTICS START');
console.log(offenders.join('\n') || 'NONE');
console.log('TD02 DIAGNOSTICS END');
