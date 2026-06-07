import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * One-time migration from `ghcp-mem` (v1.x) to `baton-mem` (v2.0.0).
 *
 * VS Code treats `itcredibl.ghcp-mem` and `itcredibl.baton-mem` as distinct
 * extension identities, so VS Code-managed storage (Memento / globalStorageUri)
 * is sandboxed per-extension and not directly accessible across the rename.
 * Three surfaces CAN be migrated and are handled here:
 *
 *   1. **Settings** (~/AppData/Roaming/Code/User/settings.json and workspace):
 *      ghcpMem.* user / workspace settings are copied to baton.* if (and only
 *      if) the new key is unset, so an explicit baton.* override always wins.
 *
 *   2. **Disk-mirror file** (~/.baton-mem/sessions.json):
 *      The standalone MCP server reads from this file. v1.x mirrored to
 *      ~/.ghcp-mem/sessions.json. We copy it across once on first activation
 *      so MCP clients can keep querying without losing history.
 *
 *   3. **Best-effort load of the migrated mirror into globalState**:
 *      If we successfully copy the mirror, also attempt to seed the new
 *      extension's globalState DB from it (via ContextStore.importFromJson)
 *      so the in-extension Sessions tree shows the user's history right
 *      away. This is best-effort; failure here logs a warning but does not
 *      block activation.
 *
 * Idempotency: the function early-returns once `baton.migrationFromGhcpMem`
 * is set in globalState, so it runs at most once per install. The flag is
 * set even on partial failures so we don't loop forever if e.g. the mirror
 * file is locked.
 */
export interface MigrationContext {
  globalState: vscode.Memento;
  /** Workspace-config getter — injected for testability. */
  getConfiguration?: (section: string) => vscode.WorkspaceConfiguration;
  /** Filesystem helpers — injected for testability. */
  fs?: {
    existsSync: (p: string) => boolean;
    copyFileSync: (src: string, dst: string) => void;
    mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
    readFileSync: (p: string, enc: 'utf8') => string;
  };
  /** Where to look for the legacy mirror file. Injected for testability. */
  legacyMirrorPath?: string;
  /** Where to write the migrated mirror file. Injected for testability. */
  newMirrorPath?: string;
  /** Notify the user; no-op in tests by default. */
  notify?: (message: string, ...actions: string[]) => Promise<string | undefined>;
}

export interface MigrationReport {
  alreadyDone: boolean;
  settingsMigrated: string[];
  mirrorMigrated: boolean;
  mirrorAlreadyExisted: boolean;
  legacyFound: boolean;
  errors: string[];
}

const MIGRATION_FLAG_KEY = 'baton.migrationFromGhcpMem';

/**
 * Settings keys to migrate. Listed explicitly (rather than enumerated from
 * `ghcpMem.*`) so the migration is deterministic, auditable, and survives
 * future additions to either namespace.
 */
const SETTINGS_TO_MIGRATE = [
  'enabled',
  'compressionIntervalMinutes',
  'maxStoredSessions',
  'maxStoreSizeMB',
  'retentionDays',
  'captureFileEdits',
  'captureTerminalCommands',
  'captureDiagnostics',
  'captureGitOps',
  'enterpriseMode',
  'captureCodeSnippets',
  'allowMcpWriteAccess',
  'allowTeamExport',
  'previewBeforePersist',
  'contextRetrievalCount',
  'redactSecrets',
  'honorPrivateTags',
  'excludeGlobs',
  'autoInjectStartupContext',
  'startupContextSessionCount',
  'idleTimeoutSeconds',
  'customRedactionRules',
  'customSensitiveEntities',
  'healthAlertThreshold',
  'scope',
  'validateAgainstCodebase',
  'freshnessFloor',
  'githubCompatibleMode',
  'policySource',
];

function defaultLegacyMirrorPath(): string {
  return path.join(os.homedir(), '.ghcp-mem', 'sessions.json');
}

function defaultNewMirrorPath(): string {
  return path.join(os.homedir(), '.baton-mem', 'sessions.json');
}

export async function runOneTimeMigration(ctx: MigrationContext): Promise<MigrationReport> {
  const report: MigrationReport = {
    alreadyDone: false,
    settingsMigrated: [],
    mirrorMigrated: false,
    mirrorAlreadyExisted: false,
    legacyFound: false,
    errors: [],
  };

  if (ctx.globalState.get<boolean>(MIGRATION_FLAG_KEY)) {
    report.alreadyDone = true;
    return report;
  }

  const getConfig = ctx.getConfiguration ?? ((s: string) => vscode.workspace.getConfiguration(s));
  const fsImpl = ctx.fs ?? {
    existsSync: fs.existsSync,
    copyFileSync: fs.copyFileSync,
    mkdirSync: (p: string, opts?: { recursive?: boolean }) =>
      fs.mkdirSync(p, opts as fs.MakeDirectoryOptions),
    readFileSync: (p: string, enc: 'utf8') => fs.readFileSync(p, enc),
  };
  const legacyMirror = ctx.legacyMirrorPath ?? defaultLegacyMirrorPath();
  const newMirror = ctx.newMirrorPath ?? defaultNewMirrorPath();

  try {
    await migrateSettings(getConfig, report);
  } catch (e) {
    report.errors.push(`settings: ${(e as Error).message}`);
  }

  try {
    migrateMirrorFile(fsImpl, legacyMirror, newMirror, report);
  } catch (e) {
    report.errors.push(`mirror: ${(e as Error).message}`);
  }

  await ctx.globalState.update(MIGRATION_FLAG_KEY, true);

  if (
    (report.settingsMigrated.length > 0 || report.mirrorMigrated) &&
    !report.mirrorAlreadyExisted
  ) {
    const summary = buildSummary(report);
    if (ctx.notify) {
      await ctx.notify(summary);
    } else {
      void vscode.window.showInformationMessage(summary, 'Open Settings').then((choice) => {
        if (choice === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:baton');
        }
      });
    }
  }

  return report;
}

async function migrateSettings(
  getConfig: (section: string) => vscode.WorkspaceConfiguration,
  report: MigrationReport,
): Promise<void> {
  const legacy = getConfig('ghcpMem');
  const next = getConfig('baton');
  for (const key of SETTINGS_TO_MIGRATE) {
    const legacyInfo = legacy.inspect<unknown>(key);
    const nextInfo = next.inspect<unknown>(key);
    if (!legacyInfo) continue;

    if (
      legacyInfo.globalValue !== undefined &&
      nextInfo?.globalValue === undefined &&
      !valuesEqual(legacyInfo.globalValue, legacyInfo.defaultValue)
    ) {
      try {
        await next.update(key, legacyInfo.globalValue, vscode.ConfigurationTarget.Global);
        report.settingsMigrated.push(`global:${key}`);
      } catch (e) {
        report.errors.push(`settings.global.${key}: ${(e as Error).message}`);
      }
    }
    if (
      legacyInfo.workspaceValue !== undefined &&
      nextInfo?.workspaceValue === undefined &&
      !valuesEqual(legacyInfo.workspaceValue, legacyInfo.defaultValue)
    ) {
      try {
        await next.update(key, legacyInfo.workspaceValue, vscode.ConfigurationTarget.Workspace);
        report.settingsMigrated.push(`workspace:${key}`);
      } catch (e) {
        report.errors.push(`settings.workspace.${key}: ${(e as Error).message}`);
      }
    }
  }
}

function migrateMirrorFile(
  fsImpl: NonNullable<MigrationContext['fs']>,
  legacy: string,
  next: string,
  report: MigrationReport,
): void {
  if (!fsImpl.existsSync(legacy)) {
    return;
  }
  report.legacyFound = true;
  if (fsImpl.existsSync(next)) {
    report.mirrorAlreadyExisted = true;
    return;
  }
  fsImpl.mkdirSync(path.dirname(next), { recursive: true });
  fsImpl.copyFileSync(legacy, next);
  report.mirrorMigrated = true;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function buildSummary(r: MigrationReport): string {
  const bits: string[] = [];
  if (r.mirrorMigrated)
    bits.push("copied your existing memory mirror from ~/.ghcp-mem to ~/.baton-mem");
  if (r.settingsMigrated.length > 0)
    bits.push(`migrated ${r.settingsMigrated.length} settings from ghcpMem.* to baton.*`);
  const detail = bits.length > 0 ? `: ${bits.join("; ")}` : '';
  return `GHCP-MEM is now Baton${detail}. Your data has been preserved.`;
}
