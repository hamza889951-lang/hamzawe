'use strict';

const fs = require('fs');
const path = require('path');

const targetPath = path.join(__dirname, 'HardeningB6.test.js');
let source = fs.readFileSync(targetPath, 'utf8');
source = source.replace(
  /const result = sandbox\.B6LifecycleService\.recoverRecoveryCase\(\n    recoveryCaseId,\n    \{ operatorId: 'doctor-1', authorityType: 'DOCTOR' \},\n    \{ type: 'RESOLVE_CHANGE' \}\n  \);\n  assert\.strictEqual\(result\.ok, true\);/,
  "const result = sandbox.B6LifecycleService.recoverRecoveryCase(\n    recoveryCaseId,\n    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },\n    { type: 'RESOLVE_CHANGE' }\n  );\n  console.error('DEBUG RESOLVE_CHANGE:', JSON.stringify(result));\n  assert.strictEqual(result.ok, true);"
);
source = source.replace(
  /const result = sandbox\.B6LifecycleService\.recoverRecoveryCase\(\n    recoveryCaseId,\n    \{ operatorId: 'doctor-1', authorityType: 'DOCTOR' \},\n    \{ type: 'RESOLVE_CANCEL' \}\n  \);\n  assert\.strictEqual\(result\.ok, true\);/,
  "const result = sandbox.B6LifecycleService.recoverRecoveryCase(\n    recoveryCaseId,\n    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },\n    { type: 'RESOLVE_CANCEL' }\n  );\n  console.error('DEBUG RESOLVE_CANCEL:', JSON.stringify(result));\n  assert.strictEqual(result.ok, true);"
);
source = source.replace(/if \(failures > 0\) process\.exit\(1\);/, "if (failures > 0) console.error('DEBUG suite failures:', failures);");
eval(source);
