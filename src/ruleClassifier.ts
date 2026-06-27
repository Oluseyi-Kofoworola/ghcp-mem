import {
  SessionEvent,
  ObservationType,
  FileEditData,
  DiagnosticData,
  FileLifecycleData,
  TerminalData,
} from './types';
import { classifyFile, inferAzureObservationType, AzureSubsystem } from './azureDetect';

/**
 * Rule-based observation pre-classifier.
 *
 * Cheap heuristics that run BEFORE the LM is invoked. If the rules return a
 * confident classification, the LM prompt is biased toward it; if they return
 * 'unknown' the LM is free to choose. Reduces LM cost and stabilises typing.
 *
 * Rules (in priority order):
 *   1. Azure signals → deployment | infra (delegated to azureDetect).
 *   2. Diagnostics-heavy sessions that ended with a clean transition → bugfix.
 *   3. Only *.test.* / *.spec.* edits → test.
 *   4. >3 file_create events and dominant edits in new files → feature.
 *   5. Only *.md / docs/** edits → docs.
 *   6. Only package.json / tsconfig / *.yml / dotfiles edits → config.
 *   7. Terminal history contains "git revert|reset|bisect" → bugfix.
 *   8. Otherwise → 'unknown' (LM decides).
 */
export function classifyByRules(
  events: SessionEvent[],
  azureSubsystems: AzureSubsystem[] = [],
): ObservationType {
  if (!events.length) return 'unknown';

  // Rule 1 — Azure dominance
  const azureType = inferAzureObservationType(azureSubsystems);
  if (azureType) return azureType;

  const editPaths: string[] = [];
  const createdPaths: string[] = [];
  const terminalCmds: string[] = [];
  let diagStart = 0;
  let diagEnd = 0;
  let diagChanges = 0;

  for (const ev of events) {
    switch (ev.type) {
      case 'file_edit': {
        const d = ev.data as FileEditData;
        if (d.filePath) editPaths.push(d.filePath);
        break;
      }
      case 'file_create': {
        const d = ev.data as FileLifecycleData;
        if (d.filePath) {
          createdPaths.push(d.filePath);
          editPaths.push(d.filePath);
        }
        break;
      }
      case 'terminal_command': {
        const d = ev.data as TerminalData;
        if (d.command) terminalCmds.push(d.command);
        break;
      }
      case 'diagnostic_change': {
        const d = ev.data as DiagnosticData;
        const total = (d.errorCount ?? 0) + (d.warningCount ?? 0);
        if (diagChanges === 0) diagStart = total;
        diagEnd = total;
        diagChanges++;
        break;
      }
    }
  }

  // Rule 7 — destructive git operations suggest bugfix / revert
  for (const cmd of terminalCmds) {
    if (/\bgit\s+(revert|reset|bisect|cherry-pick)\b/i.test(cmd)) return 'bugfix';
  }

  // Rule 2 — diagnostics collapsed from >0 to 0 with real edit activity
  if (diagChanges >= 2 && diagStart > 0 && diagEnd === 0 && editPaths.length > 0) {
    return 'bugfix';
  }

  if (editPaths.length === 0) return 'unknown';

  // Azure rules via individual file classification (redundant safety net)
  let azureInfraHits = 0;
  let azureDeployHits = 0;
  for (const p of editPaths) {
    const cls = classifyFile(p);
    if (!cls.isAzure) continue;
    if (cls.subsystems.some((s) => ['iac-bicep', 'iac-terraform', 'iac-arm'].includes(s)))
      azureInfraHits++;
    else azureDeployHits++;
  }
  if (azureInfraHits > editPaths.length / 2) return 'infra';
  if (azureDeployHits > editPaths.length / 2) return 'deployment';

  const isTest = (p: string) => /(^|\/)(__tests__\/|test\/|tests\/)|\.test\.|\.spec\./i.test(p);
  const isDoc = (p: string) => /\.md$|\.mdx$|(^|\/)docs?\//i.test(p);
  const isConfig = (p: string) =>
    /(^|\/)(package\.json|tsconfig(\..+)?\.json|\.eslintrc.*|\.prettierrc.*|\.gitignore|\.env\..*|\.editorconfig|\.npmrc|Dockerfile|docker-compose\..*|\.ya?ml|\.toml|\.ini)$/i.test(
      p,
    ) || /(^|\/)\.github\//i.test(p);

  const testCount = editPaths.filter(isTest).length;
  const docCount = editPaths.filter(isDoc).length;
  const configCount = editPaths.filter(isConfig).length;

  // Rule 3 — only test files touched
  if (testCount === editPaths.length && testCount > 0) return 'test';

  // Rule 5 — only doc files touched
  if (docCount === editPaths.length && docCount > 0) return 'docs';

  // Rule 6 — only config files touched
  if (configCount === editPaths.length && configCount > 0) return 'config';

  // Rule 4 — many new files and most edits are in new files → feature
  if (createdPaths.length >= 3) {
    const createdSet = new Set(createdPaths);
    const touchedNew = editPaths.filter((p) => createdSet.has(p)).length;
    if (touchedNew >= editPaths.length * 0.6) return 'feature';
  }

  return 'unknown';
}
