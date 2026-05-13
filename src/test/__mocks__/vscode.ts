// Minimal stub of the `vscode` module so pure-logic tests can run under Node.
// Only members touched by tested code paths are implemented.

export class EventEmitter<T> {
  private listeners: Array<(e: T) => any> = [];
  event = (listener: (e: T) => any) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(data: T) { for (const l of this.listeners) l(data); }
  dispose() { this.listeners = []; }
}

export const workspace = {
  workspaceFolders: undefined as any,
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue?: T) => defaultValue as T,
  }),
  fs: {
    createDirectory: async (_uri: any) => {},
    writeFile: async (_uri: any, _content: Uint8Array) => {},
    readFile: async (_uri: any) => new Uint8Array(),
    readDirectory: async (_uri: any): Promise<[string, number][]> => [],
    delete: async (_uri: any) => {},
  },
};

export const Uri = {
  joinPath: (base: any, ...segments: string[]) => ({
    fsPath: [base?.fsPath ?? '', ...segments].join('/'),
    path: [base?.path ?? '', ...segments].join('/'),
    toString: () => [base?.fsPath ?? '', ...segments].join('/'),
  }),
  file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
};

export const window = {
  showInformationMessage: async (_m: string, ..._args: any[]) => undefined,
  showWarningMessage: async (_m: string, ..._args: any[]) => undefined,
  showErrorMessage: async (_m: string, ..._args: any[]) => undefined,
  showQuickPick: async (_items: any, _opts?: any) => undefined,
  showInputBox: async (_opts?: any) => undefined,
  createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
  registerTreeDataProvider: () => ({ dispose() {} }),
};

export const commands = {
  registerCommand: (_id: string, _cb: any) => ({ dispose() {} }),
  executeCommand: async (..._args: any[]) => undefined,
};

export const lm = {
  registerTool: (_id: string, _tool: any) => ({ dispose() {} }),
  selectChatModels: async () => [],
};

export const StatusBarAlignment = { Left: 1, Right: 2 };
export class LanguageModelTextPart { constructor(public value: string) {} }
export class LanguageModelToolResult { constructor(public content: any[]) {} }
export class ThemeIcon { constructor(public id: string) {} }
export class TreeItem { constructor(public label: string, public collapsibleState?: number) {} }
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

// MementoStub for tests
export class InMemoryMemento {
  private m = new Map<string, any>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.m.has(key) ? (this.m.get(key) as T) : defaultValue;
  }
  async update(key: string, value: any): Promise<void> { this.m.set(key, value); }
  keys(): readonly string[] { return [...this.m.keys()]; }
}

export default {
  EventEmitter, workspace, window, commands, Uri, lm,
  StatusBarAlignment, LanguageModelTextPart, LanguageModelToolResult, ThemeIcon,
  TreeItem, TreeItemCollapsibleState, ConfigurationTarget, InMemoryMemento,
};
