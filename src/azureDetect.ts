/**
 * Azure-awareness classifier.
 *
 * Pure functions (no VS Code / az-CLI deps) so they can be unit-tested and
 * called from sessionCapture to auto-tag sessions.
 */

export type AzureSubsystem =
  | 'iac-bicep'
  | 'iac-terraform'
  | 'iac-arm'
  | 'azd'
  | 'functions'
  | 'appservice'
  | 'aks'
  | 'containerapps'
  | 'storage'
  | 'keyvault'
  | 'openai'
  | 'cli';

export interface AzureClassification {
  isAzure: boolean;
  subsystems: AzureSubsystem[];
  tags: string[];
}

/** File-path / filename patterns that unambiguously indicate Azure content. */
const FILE_RULES: Array<{ re: RegExp; subsystem: AzureSubsystem; tag: string }> = [
  { re: /\.bicep$/i,                                    subsystem: 'iac-bicep',      tag: 'bicep' },
  { re: /\.bicepparam$/i,                               subsystem: 'iac-bicep',      tag: 'bicep' },
  { re: /(^|\/)main\.tf$|\.tf$|\.tfvars$/i,             subsystem: 'iac-terraform',  tag: 'terraform' },
  { re: /(^|\/)azuredeploy\.json$/i,                    subsystem: 'iac-arm',        tag: 'arm' },
  { re: /(^|\/)azure\.ya?ml$/i,                         subsystem: 'azd',            tag: 'azd' },
  { re: /(^|\/)\.azure\//i,                             subsystem: 'azd',            tag: 'azd' },
  { re: /(^|\/)host\.json$/i,                           subsystem: 'functions',      tag: 'functions' },
  { re: /(^|\/)local\.settings\.json$/i,                subsystem: 'functions',      tag: 'functions' },
  { re: /(^|\/)function\.json$/i,                       subsystem: 'functions',      tag: 'functions' },
  { re: /(^|\/)staticwebapp\.config\.json$/i,           subsystem: 'appservice',     tag: 'swa' },
  { re: /(^|\/)web\.config$/i,                          subsystem: 'appservice',     tag: 'appservice' },
  { re: /(^|\/)containerapp\.ya?ml$/i,                  subsystem: 'containerapps',  tag: 'containerapps' },
];

/** Terminal command prefixes that indicate Azure activity. */
const COMMAND_RULES: Array<{ re: RegExp; subsystem: AzureSubsystem; tag: string }> = [
  { re: /^\s*az\s+(?!webapp\s+log\s+tail\s+devcontainer)/i, subsystem: 'cli',           tag: 'az-cli' },
  { re: /^\s*azd\s+/i,                                      subsystem: 'azd',           tag: 'azd' },
  { re: /^\s*func\s+/i,                                     subsystem: 'functions',     tag: 'functions' },
  { re: /^\s*kubectl\s+/i,                                  subsystem: 'aks',           tag: 'aks' },
  { re: /^\s*helm\s+/i,                                     subsystem: 'aks',           tag: 'aks' },
  { re: /^\s*kubelogin\s+/i,                                subsystem: 'aks',           tag: 'aks' },
  { re: /^\s*terraform\s+/i,                                subsystem: 'iac-terraform', tag: 'terraform' },
  { re: /^\s*bicep\s+/i,                                    subsystem: 'iac-bicep',     tag: 'bicep' },
];

/** Keywords in file content / summaries that hint at Azure (weak signal). */
const CONTENT_KEYWORDS = [
  'microsoft.web/sites',
  'microsoft.storage',
  'microsoft.keyvault',
  'microsoft.containerservice',
  'microsoft.app/containerapps',
  'defaultazurecredential',
  'azurecredential',
  '@azure/',
  'azure.identity',
];

function addUnique<T>(arr: T[], v: T): void {
  if (!arr.includes(v)) arr.push(v);
}

export function classifyFile(filePath: string): AzureClassification {
  const subsystems: AzureSubsystem[] = [];
  const tags: string[] = ['azure'];
  for (const rule of FILE_RULES) {
    if (rule.re.test(filePath)) {
      addUnique(subsystems, rule.subsystem);
      addUnique(tags, rule.tag);
    }
  }
  return { isAzure: subsystems.length > 0, subsystems, tags: subsystems.length ? tags : [] };
}

export function classifyCommand(cmd: string): AzureClassification {
  const subsystems: AzureSubsystem[] = [];
  const tags: string[] = ['azure'];
  for (const rule of COMMAND_RULES) {
    if (rule.re.test(cmd)) {
      addUnique(subsystems, rule.subsystem);
      addUnique(tags, rule.tag);
    }
  }
  return { isAzure: subsystems.length > 0, subsystems, tags: subsystems.length ? tags : [] };
}

/** Scan a free-text blob (e.g. summary or snippet) for Azure keyword hits. */
export function classifyContent(text: string): AzureClassification {
  if (!text) return { isAzure: false, subsystems: [], tags: [] };
  const lower = text.toLowerCase();
  const hit = CONTENT_KEYWORDS.some(k => lower.includes(k));
  return hit
    ? { isAzure: true, subsystems: [], tags: ['azure'] }
    : { isAzure: false, subsystems: [], tags: [] };
}

/**
 * Map a classification to the best-fit ObservationType for Azure sessions.
 * Returns `undefined` to let the LM classifier pick freely when the signal is weak.
 */
export function inferAzureObservationType(subsystems: AzureSubsystem[]):
  | 'deployment'
  | 'infra'
  | undefined {
  if (subsystems.some(s => s === 'azd' || s === 'cli')) return 'deployment';
  if (subsystems.some(s => s === 'iac-bicep' || s === 'iac-terraform' || s === 'iac-arm')) return 'infra';
  return undefined;
}
