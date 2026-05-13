// Post-compile setup for Node test runs: plants a minimal `vscode` module
// inside out-test/node_modules so `require('vscode')` resolves to our mock.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const stubDir = path.join(root, 'out-test', 'node_modules', 'vscode');
fs.mkdirSync(stubDir, { recursive: true });

// The compiled mock sits at out-test/src/test/__mocks__/vscode.js
const relMock = path.relative(stubDir, path.join(root, 'out-test', 'src', 'test', '__mocks__', 'vscode.js')).replace(/\\/g, '/');

fs.writeFileSync(
  path.join(stubDir, 'package.json'),
  JSON.stringify({ name: 'vscode', main: 'index.js', version: '0.0.0-test' }, null, 2)
);

fs.writeFileSync(
  path.join(stubDir, 'index.js'),
  `module.exports = require('${relMock}');\n`
);

console.log('[setup-test-env] vscode stub ready at', stubDir);
