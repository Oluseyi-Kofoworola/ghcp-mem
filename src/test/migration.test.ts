// Tests for the v2.0.0 one-time migration from ghcp-mem to baton-mem.
//
// The migration runs against three surfaces — settings, the disk-mirror
// file, and an idempotency flag in globalState. These tests inject fakes
// for all three so they execute deterministically under Node's test runner
// without touching the user's real ~/.ghcp-mem or VS Code settings.

import { test } from 'node:test';
import assert from 'node:assert';

import { runOneTimeMigration } from '../migration';
import { InMemoryMemento } from './__mocks__/vscode';

type Inspect = {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
};

function fakeConfig(byKey: Record<string, Record<string, Inspect>>) {
  const writes: Array<{ section: string; key: string; value: unknown; target: number }> = [];
  function getConfiguration(section: string) {
    return {
      inspect<T>(key: string): T | undefined {
        return byKey[section]?.[key] as T | undefined;
      },
      get<T>(_key: string, dflt?: T): T | undefined {
        return dflt;
      },
      async update(key: string, value: unknown, target: number): Promise<void> {
        if (!byKey[section]) byKey[section] = {};
        if (!byKey[section][key]) byKey[section][key] = {};
        if (target === 1) byKey[section][key].globalValue = value;
        else if (target === 2) byKey[section][key].workspaceValue = value;
        writes.push({ section, key, value, target });
      },
    } as any;
  }
  return { getConfiguration, writes, byKey };
}

function fakeFs(initial: Record<string, string> = {}) {
  const files = { ...initial };
  return {
    files,
    existsSync: (p: string) => p in files,
    copyFileSync: (src: string, dst: string) => {
      if (!(src in files)) throw new Error(`copy: source ${src} not found`);
      files[dst] = files[src];
    },
    mkdirSync: () => {},
    readFileSync: (p: string) => {
      if (!(p in files)) throw new Error(`read: ${p} not found`);
      return files[p];
    },
  };
}

test('migration: no legacy, no settings → no-op + flag set', async () => {
  const mem = new InMemoryMemento();
  const cfg = fakeConfig({});
  const fs = fakeFs();
  const r = await runOneTimeMigration({
    globalState: mem as any,
    getConfiguration: cfg.getConfiguration,
    fs,
    legacyMirrorPath: '/legacy/sessions.json',
    newMirrorPath: '/new/sessions.json',
    notify: async () => undefined,
  });
  assert.strictEqual(r.alreadyDone, false);
  assert.strictEqual(r.legacyFound, false);
  assert.strictEqual(r.mirrorMigrated, false);
  assert.strictEqual(r.settingsMigrated.length, 0);
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(mem.get('baton.migrationFromGhcpMem'), true);
});

test('migration: idempotent — second run is a fast no-op', async () => {
  const mem = new InMemoryMemento();
  await mem.update('baton.migrationFromGhcpMem', true);
  const cfg = fakeConfig({
    ghcpMem: { retentionDays: { globalValue: 90, defaultValue: 28 } },
    baton: {},
  });
  const fs = fakeFs({ '/legacy/sessions.json': '{"sessions":[]}' });
  const r = await runOneTimeMigration({
    globalState: mem as any,
    getConfiguration: cfg.getConfiguration,
    fs,
    legacyMirrorPath: '/legacy/sessions.json',
    newMirrorPath: '/new/sessions.json',
    notify: async () => undefined,
  });
  assert.strictEqual(r.alreadyDone, true);
  // Should NOT have copied the mirror or migrated settings.
  assert.strictEqual(r.mirrorMigrated, false);
  assert.strictEqual(r.settingsMigrated.length, 0);
  assert.strictEqual(cfg.writes.length, 0);
  assert.strictEqual('/new/sessions.json' in fs.files, false);
});

test('migration: copies legacy mirror when target absent', async () => {
  const mem = new InMemoryMemento();
  const cfg = fakeConfig({});
  const fs = fakeFs({ '/legacy/sessions.json': '{"sessions":[{"id":"abc"}]}' });
  const r = await runOneTimeMigration({
    globalState: mem as any,
    getConfiguration: cfg.getConfiguration,
    fs,
    legacyMirrorPath: '/legacy/sessions.json',
    newMirrorPath: '/new/sessions.json',
    notify: async () => undefined,
  });
  assert.strictEqual(r.legacyFound, true);
  assert.strictEqual(r.mirrorMigrated, true);
  assert.strictEqual(r.mirrorAlreadyExisted, false);
  assert.strictEqual(fs.files['/new/sessions.json'], '{"sessions":[{"id":"abc"}]}');
});

test('migration: does NOT clobber an existing new mirror', async () => {
  const mem = new InMemoryMemento();
  const cfg = fakeConfig({});
  const fs = fakeFs({
    '/legacy/sessions.json': '{"sessions":[{"id":"abc"}]}',
    '/new/sessions.json': '{"sessions":[{"id":"freshly-installed"}]}',
  });
  const r = await runOneTimeMigration({
    globalState: mem as any,
    getConfiguration: cfg.getConfiguration,
    fs,
    legacyMirrorPath: '/legacy/sessions.json',
    newMirrorPath: '/new/sessions.json',
    notify: async () => undefined,
  });
  assert.strictEqual(r.legacyFound, true);
  assert.strictEqual(r.mirrorMigrated, false);
  assert.strictEqual(r.mirrorAlreadyExisted, true);
  assert.strictEqual(
    fs.files['/new/sessions.json'],
    '{"sessions":[{"id":"freshly-installed"}]}',
  );
});

test('migration: copies global settings from ghcpMem.* to baton.*', async () => {
  const mem = new InMemoryMemento();
  const cfg = fakeConfig({
    ghcpMem: {
      retentionDays: { globalValue: 90, defaultValue: 28 },
      maxStoredSessions: { globalValue: 500, defaultValue: 100 },
    },
    baton: {},
  });
  const fs = fakeFs();
  const r = await runOneTimeMigration({
    globalState: mem as any,
    getConfiguration: cfg.getConfiguration,
    fs,
    legacyMirrorPath: '/legacy/sessions.json',
    newMirrorPath: '/new/sessions.json',
    notify: async () => undefined,
  });
  assert.ok(r.settingsMigrated.includes('global:retentionDays'));
  assert.ok(r.settingsMigrated.includes('global:maxStoredSessions'));
  const retentionWrite = cfg.writes.find((w) => w.key === 'retentionDays');
  assert.ok(retentionWrite, 'retentionDays should have been written');
  assert.strictEqual(retentionWrite!.value, 90);
  assert.strictEqual(retentionWrite!.target, 1); // Global
});

test('migration: explicit baton.* override wins over legacy ghcpMem.*', async () => {
  const mem = new InMemoryMemento();
  const cfg = fakeConfig({
    ghcpMem: { retentionDays: { globalValue: 90, defaultValue: 28 } },
    baton: { retentionDays: { globalValue: 14, defaultValue: 28 } },
  });
  const fs = fakeFs();
  const r = await runOneTimeMigration({
    globalState: mem as any,
    getConfiguration: cfg.getConfiguration,
    fs,
    legacyMirrorPath: '/legacy/sessions.json',
    newMirrorPath: '/new/sessions.json',
    notify: async () => undefined,
  });
  assert.strictEqual(
    r.settingsMigrated.includes('global:retentionDays'),
    false,
    'should NOT overwrite explicit baton.retentionDays',
  );
});

test('migration: ignores settings that equal their default (nothing to migrate)', async () => {
  const mem = new InMemoryMemento();
  const cfg = fakeConfig({
    ghcpMem: { retentionDays: { globalValue: 28, defaultValue: 28 } },
    baton: {},
  });
  const fs = fakeFs();
  const r = await runOneTimeMigration({
    globalState: mem as any,
    getConfiguration: cfg.getConfiguration,
    fs,
    legacyMirrorPath: '/legacy/sessions.json',
    newMirrorPath: '/new/sessions.json',
    notify: async () => undefined,
  });
  assert.strictEqual(r.settingsMigrated.length, 0);
});

test('migration: migrates workspace settings as well as global', async () => {
  const mem = new InMemoryMemento();
  const cfg = fakeConfig({
    ghcpMem: { redactSecrets: { workspaceValue: false, defaultValue: true } },
    baton: {},
  });
  const fs = fakeFs();
  const r = await runOneTimeMigration({
    globalState: mem as any,
    getConfiguration: cfg.getConfiguration,
    fs,
    legacyMirrorPath: '/legacy/sessions.json',
    newMirrorPath: '/new/sessions.json',
    notify: async () => undefined,
  });
  assert.ok(r.settingsMigrated.includes('workspace:redactSecrets'));
  const w = cfg.writes.find((x) => x.key === 'redactSecrets');
  assert.strictEqual(w!.value, false);
  assert.strictEqual(w!.target, 2); // Workspace
});

test('migration: notifies user when something was migrated', async () => {
  const mem = new InMemoryMemento();
  const cfg = fakeConfig({
    ghcpMem: { retentionDays: { globalValue: 90, defaultValue: 28 } },
    baton: {},
  });
  const fs = fakeFs({ '/legacy/sessions.json': '{}' });
  let notified: string | undefined;
  await runOneTimeMigration({
    globalState: mem as any,
    getConfiguration: cfg.getConfiguration,
    fs,
    legacyMirrorPath: '/legacy/sessions.json',
    newMirrorPath: '/new/sessions.json',
    notify: async (m) => {
      notified = m;
      return undefined;
    },
  });
  assert.ok(notified, 'expected notification');
  assert.match(notified!, /GHCP-MEM is now Baton/);
  assert.match(notified!, /mirror/);
  assert.match(notified!, /settings/);
});

test('migration: does NOT notify when there was nothing to migrate', async () => {
  const mem = new InMemoryMemento();
  const cfg = fakeConfig({});
  const fs = fakeFs();
  let notified = false;
  await runOneTimeMigration({
    globalState: mem as any,
    getConfiguration: cfg.getConfiguration,
    fs,
    legacyMirrorPath: '/legacy/sessions.json',
    newMirrorPath: '/new/sessions.json',
    notify: async () => {
      notified = true;
      return undefined;
    },
  });
  assert.strictEqual(notified, false);
});
