import path from "path";
import { vi } from "vitest";

export class Uri {
  constructor(
    public readonly scheme: string,
    public readonly path: string,
    public readonly fsPath: string,
    private readonly raw?: string,
    public readonly query: string = ""
  ) {}

  // Real API semantics: with() preserves query unless overridden
  with(change: {
    scheme?: string;
    path?: string;
    fsPath?: string;
    query?: string;
  }): Uri {
    const nextScheme = change.scheme ?? this.scheme;
    const nextPath = change.path ?? this.path;
    const nextFsPath =
      change.fsPath ?? (nextScheme === "file" ? nextPath : this.fsPath);
    return new Uri(
      nextScheme,
      nextPath,
      nextFsPath,
      undefined,
      change.query ?? this.query
    );
  }

  toString(): string {
    if (this.raw) {
      return this.raw;
    }

    if (this.scheme === "file") {
      const normalized = this.path.startsWith("/")
        ? this.path
        : `/${this.path}`;
      return `file://${normalized}`;
    }

    return `${this.scheme}:${this.path}`;
  }

  static file(filePath: string): Uri {
    const normalized = toPosix(filePath);
    return new Uri("file", normalized, filePath);
  }

  static parse(value: string): Uri {
    if (value.startsWith("data:")) {
      return new Uri("data", value.slice("data:".length), "", value);
    }

    if (value.startsWith("file://")) {
      const parsed = value.replace(/^file:\/\//, "");
      return new Uri("file", parsed, parsed, value);
    }

    const schemeMatch = /^([a-zA-Z][a-zA-Z\d+.-]*):(.*)$/.exec(value);
    if (schemeMatch) {
      const [, scheme, rest] = schemeMatch;
      const normalizedScheme = scheme.toLowerCase();
      const fsPath = normalizedScheme === "data" ? "" : rest;
      return new Uri(normalizedScheme, rest, fsPath, value);
    }

    return new Uri("file", toPosix(value), value);
  }

  static joinPath(
    base: { scheme?: string; path?: string; fsPath?: string },
    ...segments: string[]
  ): Uri {
    const scheme = base.scheme ?? "file";
    const basePath = base.path ?? base.fsPath ?? "";
    const joinedPath = path.posix.join(
      toPosix(basePath),
      ...segments.map(toPosix)
    );
    const fsPath = scheme === "file" ? joinedPath : "";
    return new Uri(scheme, joinedPath, fsPath);
  }
}

const toPosix = (value: string) => value.replace(/\\/g, "/");

const configurationDefaults = new Map<string, unknown>([
  ["sven.sourceControl.ignore", []],
  ["sven.sourceControl.ignoreOnCommit", ["ignore-on-commit"]],
  ["sven.sourceControl.ignoreOnStatusCount", ["ignore-on-commit"]],
  ["sven.layout.trunkRegex", "(trunk)(/.*)?"],
  ["sven.layout.trunkRegexName", 1],
  ["sven.layout.branchesRegex", "branches/([^/]+)(/.*)?"],
  ["sven.layout.branchesRegexName", 1],
  ["sven.layout.tagsRegex", "tags/([^/]+)(/.*)?"],
  ["sven.layout.tagRegexName", 1],
  ["sven.layout.showFullName", true],
  ["sven.commit.changes.selectedAll", true]
]);

const configurationValues = new Map<string, unknown>();
const textDocuments: Array<{ uri: unknown; getText: () => string }> = [];

const configKey = (section: string | undefined, setting: string) =>
  section ? `${section}.${setting}` : setting;

const getConfigValue = (section: string | undefined, setting: string) => {
  const key = configKey(section, setting);
  if (configurationValues.has(key)) {
    return configurationValues.get(key);
  }
  if (configurationDefaults.has(key)) {
    return configurationDefaults.get(key);
  }
  return undefined;
};

// Event mock
export type Event<T> = (
  listener: (e: T) => void,
  thisArgs?: unknown,
  disposables?: Disposable[]
) => Disposable;

// Disposable mock
export class Disposable {
  constructor(private callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
  static from(...disposables: { dispose(): void }[]): Disposable {
    return new Disposable(() => disposables.forEach(d => d.dispose()));
  }
}

// EventEmitter mock
export class EventEmitter<T> {
  private listeners: Array<{ raw: (e: T) => void; wrapped: (e: T) => void }> =
    [];
  event: Event<T> = (listener, thisArgs, disposables) => {
    const wrapped = thisArgs ? (e: T) => listener.call(thisArgs, e) : listener;
    this.listeners.push({ raw: listener, wrapped });
    const disposable = new Disposable(() => {
      const idx = this.listeners.findIndex(
        entry => entry.raw === listener && entry.wrapped === wrapped
      );
      if (idx >= 0) this.listeners.splice(idx, 1);
    });
    if (disposables) {
      disposables.push(disposable);
    }
    return disposable;
  };
  fire = (data: T): void => {
    this.listeners.forEach(entry => entry.wrapped(data));
  };
  dispose(): void {
    this.listeners = [];
  }
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4
}

export class RelativePattern {
  constructor(
    public readonly baseUri: string | { fsPath?: string; path?: string },
    public readonly pattern: string
  ) {}
}

export class Position {
  constructor(
    public line: number,
    public character: number
  ) {}
}

export class Range {
  constructor(
    public startLine: number,
    public startCharacter: number,
    public endLine: number,
    public endCharacter: number
  ) {}
}

export class MarkdownString {
  constructor(public value = "") {}
  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }
}

const createSourceControlGroup = (id: string, label: string) => ({
  id,
  label,
  resourceStates: [] as unknown[],
  hideWhenEmpty: false,
  dispose: vi.fn()
});

const createSourceControl = () => {
  const groups: ReturnType<typeof createSourceControlGroup>[] = [];
  return {
    id: "svn",
    label: "SVN",
    rootUri: undefined as Uri | undefined,
    inputBox: {
      value: "",
      placeholder: "",
      visible: true,
      enabled: true,
      validateInput: undefined as
        | ((text: string) => string | null | undefined)
        | undefined
    },
    count: 0,
    commitTemplate: "",
    quickDiffProvider: undefined as unknown,
    acceptInputCommand: undefined as unknown,
    statusBarCommands: [] as unknown[],
    createResourceGroup: vi.fn((groupId: string, groupLabel: string) => {
      const group = createSourceControlGroup(groupId, groupLabel);
      groups.push(group);
      return group;
    }),
    dispose: vi.fn(() => {
      groups.splice(0, groups.length);
    })
  };
};

// window mock
export const window = {
  // Real API semantics: focused window state + focus-change event
  state: { focused: true },
  onDidChangeWindowState: vi.fn(() => ({ dispose: vi.fn() })),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showQuickPick: vi.fn(),
  showOpenDialog: vi.fn(),
  showInputBox: vi.fn(),
  showTextDocument: vi.fn(async () => ({})),
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    append: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn()
  })),
  createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
  activeTextEditor: undefined,
  activeColorTheme: { kind: ColorThemeKind.Dark },
  onDidChangeActiveTextEditor: vi.fn(() => new Disposable(() => {})),
  onDidChangeActiveColorTheme: vi.fn(() => new Disposable(() => {})),
  onDidChangeTextEditorSelection: vi.fn(() => new Disposable(() => {})),
  onDidChangeVisibleTextEditors: vi.fn(() => new Disposable(() => {})),
  createStatusBarItem: vi.fn(() => ({
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    text: "",
    tooltip: "",
    command: undefined
  })),
  registerFileDecorationProvider: vi.fn(() => new Disposable(() => {})),
  registerTreeDataProvider: vi.fn((...args: unknown[]) => {
    void args;
    return new Disposable(() => {});
  }),
  createTreeView: vi.fn((...args: unknown[]) => {
    void args;
    return {
      reveal: vi.fn(async () => undefined),
      dispose: vi.fn()
    };
  }),
  withProgress: vi.fn((_options, task) => task({ report: vi.fn() }))
};

// workspace mock
export const workspace = {
  getConfiguration: vi.fn((section?: string) => ({
    get: vi.fn((setting: string, defaultValue?: unknown) => {
      const value = getConfigValue(section, setting);
      return typeof value === "undefined" ? defaultValue : value;
    }),
    update: vi.fn(async (setting: string, value: unknown) => {
      const key = configKey(section, setting);
      if (typeof value === "undefined") {
        configurationValues.delete(key);
        return;
      }
      configurationValues.set(key, value);
    }),
    has: vi.fn((setting: string) => {
      const key = configKey(section, setting);
      return configurationValues.has(key) || configurationDefaults.has(key);
    }),
    inspect: vi.fn((setting: string) => {
      const key = configKey(section, setting);
      const value = getConfigValue(section, setting);
      return {
        key,
        defaultValue: configurationDefaults.get(key),
        globalValue: value,
        workspaceValue: value
      };
    })
  })),
  workspaceFolders: [],
  textDocuments,
  updateWorkspaceFolders: vi.fn(() => true),
  openTextDocument: vi.fn(async (uri?: unknown) => {
    const normalizedUri =
      typeof uri === "string"
        ? Uri.file(uri)
        : uri instanceof Uri
          ? uri
          : Uri.file("");
    const document = {
      uri: normalizedUri,
      getText: vi.fn(() => "")
    };
    textDocuments.push(document);
    return document;
  }),
  onDidChangeConfiguration: vi.fn(() => new Disposable(() => {})),
  onDidChangeTextDocument: vi.fn(() => new Disposable(() => {})),
  onDidOpenTextDocument: vi.fn(() => new Disposable(() => {})),
  onDidSaveTextDocument: vi.fn(() => new Disposable(() => {})),
  onDidCloseTextDocument: vi.fn(() => new Disposable(() => {})),
  onDidRenameFiles: vi.fn(() => new Disposable(() => {})),
  onDidDeleteFiles: vi.fn(() => new Disposable(() => {})),
  onDidChangeWorkspaceFolders: vi.fn(() => new Disposable(() => {})),
  registerFileSystemProvider: vi.fn((...args: unknown[]) => {
    void args;
    return new Disposable(() => {});
  }),
  createFileSystemWatcher: vi.fn(() => ({
    onDidCreate: vi.fn(() => new Disposable(() => {})),
    onDidChange: vi.fn(() => new Disposable(() => {})),
    onDidDelete: vi.fn(() => new Disposable(() => {})),
    dispose: vi.fn()
  })),
  fs: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    stat: vi.fn(),
    readDirectory: vi.fn(),
    createDirectory: vi.fn(),
    delete: vi.fn()
  }
};

const registeredCommands = new Map<
  string,
  {
    callback: (...args: unknown[]) => unknown;
    thisArg?: unknown;
  }
>();

// commands mock
export const commands = {
  registerCommand: vi.fn(
    (
      id: string,
      callback: (...args: unknown[]) => unknown,
      thisArg?: unknown
    ) => {
      registeredCommands.set(id, { callback, thisArg });
      return new Disposable(() => {
        registeredCommands.delete(id);
      });
    }
  ),
  registerTextEditorCommand: vi.fn(
    (
      id: string,
      callback: (...args: unknown[]) => unknown,
      thisArg?: unknown
    ) => {
      registeredCommands.set(id, { callback, thisArg });
      return new Disposable(() => {
        registeredCommands.delete(id);
      });
    }
  ),
  executeCommand: vi.fn(async (id: string, ...args: unknown[]) => {
    const command = registeredCommands.get(id);
    if (!command) {
      return undefined;
    }
    return await command.callback.apply(command.thisArg, args);
  }),
  getCommands: vi.fn(async () => Array.from(registeredCommands.keys()))
};

export const env = {
  remoteName: undefined as string | undefined
};

export const scm = {
  createSourceControl: vi.fn((_id?: string, _label?: string, rootUri?: Uri) => {
    const sourceControl = createSourceControl();
    sourceControl.rootUri = rootUri;
    return sourceControl;
  })
};

const extensionSecrets = new Map<string, string>();

const extensionContext = {
  subscriptions: [] as { dispose(): void }[],
  extensionPath: process.cwd(),
  globalState: {
    get: vi.fn(),
    update: vi.fn()
  },
  workspaceState: {
    get: vi.fn(),
    update: vi.fn()
  },
  secrets: {
    get: vi.fn(async (key: string) => extensionSecrets.get(key)),
    store: vi.fn(async (key: string, value: string) => {
      extensionSecrets.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      extensionSecrets.delete(key);
    }),
    onDidChange: vi.fn(() => new Disposable(() => {}))
  }
};

const extensionMock = {
  id: "vrognas.sven",
  isActive: false,
  packageJSON: { extensionKind: ["workspace"] },
  activate: vi.fn(async () => {
    const extensionModule = await import("../../src/extension");
    const api = await extensionModule.activate(
      extensionContext as Parameters<typeof extensionModule.activate>[0]
    );
    extensionMock.isActive = true;
    return api;
  })
};

// extensions mock
export const extensions = {
  getExtension: vi.fn((id: string) => {
    if (id === "vrognas.sven") {
      return extensionMock;
    }
    return undefined;
  }),
  all: []
};

// Enums
export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64
}

export enum FileChangeType {
  Changed = 1,
  Created = 2,
  Deleted = 3
}

// Additional types
export interface Command {
  title: string;
  command: string;
  tooltip?: string;
  arguments?: unknown[];
}

export interface QuickPickItem {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  alwaysShow?: boolean;
}
