'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function load(sandbox, relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, { filename: relativePath });
}

const sandbox = vm.createContext({ console: console });
load(sandbox, 'Result.js', 'Result');
load(sandbox, 'Domain/Validators.js', 'Validators');

const validNames = [
  'محمد علي حسن',
  'محمد عبد الرحمن',
  'محمد علي عبد الرحمن',
  'عبدالرحمن محمد حسن'
];

const invalidNames = [
  '',
  'محمد',
  'محمد علي',
  '123 456 789',
  'محمد 123 حسن',
  'abc def ghi',
  'محمد @ علي',
  'محمد ع حسن'
];

validNames.forEach(function(name) {
  const result = sandbox.Validators.validatePatientName(name);
  assert.strictEqual(result.ok, true, 'Expected valid Arabic name: ' + name);
  assert.strictEqual(result.data, name);
});

invalidNames.forEach(function(name) {
  const result = sandbox.Validators.validatePatientName(name);
  assert.strictEqual(result.ok, false, 'Expected invalid name: ' + JSON.stringify(name));
  assert.strictEqual(result.error.code, 'INVALID_NAME');
});

const whitespaceVariant = sandbox.Validators.validatePatientName('  محمد   علي    حسن  ');
assert.strictEqual(whitespaceVariant.ok, true);
assert.strictEqual(whitespaceVariant.data, 'محمد   علي    حسن');

console.log('HardeningPatientNameValidation: PASS (' + (validNames.length + invalidNames.length + 1) + '/' + (validNames.length + invalidNames.length + 1) + ')');
