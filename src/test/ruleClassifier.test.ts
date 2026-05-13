import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyByRules } from '../ruleClassifier';
import { SessionEvent } from '../types';

function ev(type: SessionEvent['type'], data: any, t = Date.now()): SessionEvent {
  return { type, timestamp: t, data };
}

test('ruleClassifier — only test files → test', () => {
  const events: SessionEvent[] = [
    ev('file_edit', { filePath: 'src/foo.test.ts', languageId: 'ts', changeCount: 2, linesAdded: 5, linesRemoved: 1, snippet: '' }),
    ev('file_edit', { filePath: 'src/bar.spec.ts', languageId: 'ts', changeCount: 1, linesAdded: 3, linesRemoved: 0, snippet: '' }),
  ];
  assert.equal(classifyByRules(events), 'test');
});

test('ruleClassifier — only markdown → docs', () => {
  const events: SessionEvent[] = [
    ev('file_edit', { filePath: 'README.md', languageId: 'md', changeCount: 1, linesAdded: 10, linesRemoved: 2, snippet: '' }),
    ev('file_edit', { filePath: 'docs/guide.md', languageId: 'md', changeCount: 1, linesAdded: 1, linesRemoved: 0, snippet: '' }),
  ];
  assert.equal(classifyByRules(events), 'docs');
});

test('ruleClassifier — only config files → config', () => {
  const events: SessionEvent[] = [
    ev('file_edit', { filePath: 'package.json', languageId: 'json', changeCount: 1, linesAdded: 2, linesRemoved: 1, snippet: '' }),
    ev('file_edit', { filePath: 'tsconfig.json', languageId: 'json', changeCount: 1, linesAdded: 1, linesRemoved: 0, snippet: '' }),
  ];
  assert.equal(classifyByRules(events), 'config');
});

test('ruleClassifier — 3+ creates with new-file edits → feature', () => {
  const events: SessionEvent[] = [
    ev('file_create', { filePath: 'src/feature/a.ts' }),
    ev('file_create', { filePath: 'src/feature/b.ts' }),
    ev('file_create', { filePath: 'src/feature/c.ts' }),
    ev('file_edit', { filePath: 'src/feature/a.ts', languageId: 'ts', changeCount: 4, linesAdded: 20, linesRemoved: 0, snippet: '' }),
  ];
  assert.equal(classifyByRules(events), 'feature');
});

test('ruleClassifier — diagnostics went from errors to zero → bugfix', () => {
  const events: SessionEvent[] = [
    ev('diagnostic_change', { filePath: 'src/a.ts', errorCount: 3, warningCount: 0, topMessages: ['err'] }),
    ev('file_edit', { filePath: 'src/a.ts', languageId: 'ts', changeCount: 3, linesAdded: 4, linesRemoved: 2, snippet: '' }),
    ev('diagnostic_change', { filePath: 'src/a.ts', errorCount: 0, warningCount: 0, topMessages: [] }),
  ];
  assert.equal(classifyByRules(events), 'bugfix');
});

test('ruleClassifier — git revert → bugfix', () => {
  const events: SessionEvent[] = [
    ev('terminal_command', { command: 'git revert HEAD' }),
  ];
  assert.equal(classifyByRules(events), 'bugfix');
});

test('ruleClassifier — azure infra subsystem → infra', () => {
  const events: SessionEvent[] = [
    ev('file_edit', { filePath: 'infra/main.bicep', languageId: 'bicep', changeCount: 1, linesAdded: 2, linesRemoved: 0, snippet: '' }),
  ];
  assert.equal(classifyByRules(events, ['iac-bicep']), 'infra');
});

test('ruleClassifier — azure azd subsystem → deployment', () => {
  const events: SessionEvent[] = [
    ev('terminal_command', { command: 'azd up' }),
  ];
  assert.equal(classifyByRules(events, ['azd']), 'deployment');
});

test('ruleClassifier — ambiguous mix → unknown', () => {
  const events: SessionEvent[] = [
    ev('file_edit', { filePath: 'src/a.ts', languageId: 'ts', changeCount: 1, linesAdded: 2, linesRemoved: 0, snippet: '' }),
    ev('file_edit', { filePath: 'README.md', languageId: 'md', changeCount: 1, linesAdded: 2, linesRemoved: 0, snippet: '' }),
  ];
  assert.equal(classifyByRules(events), 'unknown');
});

test('ruleClassifier — empty input → unknown', () => {
  assert.equal(classifyByRules([]), 'unknown');
});
