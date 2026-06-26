import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  COMMAND_REGISTRY,
  GROUP_ORDER,
  DEFAULT_FOLLOWUPS,
  getFollowups,
  findCommand,
  allCommandNames,
  CommandGroup,
  CommandTier,
} from '../commandRegistry';

const VALID_GROUPS: CommandGroup[] = ['retrieval', 'trust', 'authoring', 'generation', 'admin'];
const VALID_TIERS: CommandTier[] = ['core', 'experimental'];

test('registry: command names + aliases are globally unique', () => {
  const seen = new Set<string>();
  for (const name of allCommandNames()) {
    assert.ok(!seen.has(name), `duplicate command name/alias: ${name}`);
    seen.add(name);
  }
});

test('registry: every spec has a valid group and tier', () => {
  for (const spec of COMMAND_REGISTRY) {
    assert.ok(VALID_GROUPS.includes(spec.group), `${spec.name} has bad group ${spec.group}`);
    assert.ok(VALID_TIERS.includes(spec.tier), `${spec.name} has bad tier ${spec.tier}`);
    assert.ok(spec.signature.length > 0, `${spec.name} missing signature`);
    assert.ok(spec.description.length > 0, `${spec.name} missing description`);
  }
});

test('registry: every group in GROUP_ORDER has at least one command', () => {
  for (const group of GROUP_ORDER) {
    const count = COMMAND_REGISTRY.filter((c) => c.group === group).length;
    assert.ok(count > 0, `group ${group} has no commands`);
  }
});

test('registry: every follow-up chip targets a real command', () => {
  const known = new Set(allCommandNames());
  for (const spec of COMMAND_REGISTRY) {
    for (const chip of spec.followups ?? []) {
      assert.ok(known.has(chip.command), `${spec.name} follow-up targets unknown ${chip.command}`);
      assert.ok(chip.label.length > 0, `${spec.name} follow-up missing label`);
    }
  }
  for (const chip of DEFAULT_FOLLOWUPS) {
    assert.ok(known.has(chip.command), `default follow-up targets unknown ${chip.command}`);
  }
});

test('registry: getFollowups falls back to the default set', () => {
  assert.deepEqual(getFollowups(undefined), DEFAULT_FOLLOWUPS);
  // A command with no declared follow-ups returns the default set.
  assert.deepEqual(getFollowups('detail'), DEFAULT_FOLLOWUPS);
  // A command WITH follow-ups returns its own set.
  assert.deepEqual(
    getFollowups('search').map((c) => c.command),
    ['recent', 'health'],
  );
});

test('registry: aliases resolve to their primary spec', () => {
  assert.equal(findCommand('?')?.name, 'help');
  assert.equal(findCommand('help')?.name, 'help');
  assert.equal(findCommand('nope'), undefined);
});

test('registry: command set matches the contextProvider dispatch switch', () => {
  // Drift guard: parse the dispatch `switch (cmd)` block out of the source and
  // assert it routes exactly the commands the registry declares. This is the
  // one remaining hand-maintained link between dispatch and the registry.
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'src', 'contextProvider.ts'),
    path.resolve(process.cwd(), 'src', 'contextProvider.ts'),
  ];
  const file = candidates.find((c) => fs.existsSync(c));
  assert.ok(file, `could not locate contextProvider.ts source (tried ${candidates.join(', ')})`);
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('switch (cmd) {');
  assert.ok(start >= 0, 'could not locate dispatch switch');
  const end = src.indexOf('private async help', start);
  assert.ok(end > start, 'could not locate end of dispatch switch');
  const block = src.slice(start, end);

  const dispatched = new Set<string>();
  for (const m of block.matchAll(/case '([^']+)':/g)) {
    dispatched.add(m[1]);
  }

  const registered = new Set(allCommandNames());

  const missingFromRegistry = [...dispatched].filter((c) => !registered.has(c));
  const missingFromDispatch = [...registered].filter((c) => !dispatched.has(c));

  assert.deepEqual(
    missingFromRegistry,
    [],
    `dispatched but not registered: ${missingFromRegistry}`,
  );
  assert.deepEqual(
    missingFromDispatch,
    [],
    `registered but not dispatched: ${missingFromDispatch}`,
  );
});
