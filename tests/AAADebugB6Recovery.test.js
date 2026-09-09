'use strict';
const fs = require('fs');
const path = require('path');
let source = fs.readFileSync(path.join(__dirname, 'HardeningB6.test.js'), 'utf8');
source = source.replace(
  "  assert.strictEqual(result.ok, true);\n  assert.strictEqual(createdEventCount, countBeforeRecovery);",
  "  console.error('DEBUG RESOLVE_CHANGE:', JSON.stringify(result));\n  assert.strictEqual(result.ok, true);\n  assert.strictEqual(createdEventCount, countBeforeRecovery);"
);
source = source.replace(
  "  assert.strictEqual(result.ok, true);\n  assert.strictEqual(claim(PHONE), undefined);\n  assert.strictEqual(free('OLD').status, 'FREE');",
  "  console.error('DEBUG RESOLVE_CANCEL:', JSON.stringify(result));\n  assert.strictEqual(result.ok, true);\n  assert.strictEqual(claim(PHONE), undefined);\n  assert.strictEqual(free('OLD').status, 'FREE');"
);
source = source.replace(/if \(failures > 0\) process\.exit\(1\);/, "if (failures > 0) console.error('DEBUG suite failures:', failures);");
eval(source);
