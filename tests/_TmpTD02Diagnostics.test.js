'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SKIP = { tests: true, '.git': true, node_modules: true };
function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); }
const offenders = [];
function visit(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
    if (SKIP[entry.name]) return;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) return visit(abs);
    if (!entry.isFile() || !entry.name.endsWith('.js')) return;
    const rel = path.relative(ROOT, abs);
    const src = strip(fs.readFileSync(abs, 'utf8'));
    const hits = [];
    if (/new\s+Date\s*\(\s*\)/.test(src)) hits.push('new Date()');
    if (/Date\.now\s*\(/.test(src)) hits.push('Date.now()');
    if (hits.length) offenders.push(rel + ' -> ' + hits.join(', '));
  });
}
visit(ROOT);
console.log('TD02 DIAGNOSTICS:');
console.log(offenders.join('\n') || 'NONE');
