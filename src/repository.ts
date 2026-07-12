// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import {
  CancellationToken,
  commands,
  Disposable,
  env,
  Event,
  EventEmitter,
  ProgressLocation,
  scm,
  SecretStorage,
  SourceControl,
  SourceControlInputBox,
  SourceControlResourceGroup,
  TextDocument,
  Uri,
  window,
  workspace
} from "vscode";

// Input box validation types (not in older vscode types)
interface InputBoxValidation {
  message: string;
  type: InputBoxValidationType;
}
enum InputBoxValidationType {
  Error = 0,
  Warning = 1,
  Information = 2
}

import type { CredentialMode } from "./common/credentialMode";

/**
 * Determine if extension storage should be used for credentials.
 * @returns true if extension storage should be used
 */
function shouldUseExtensionStorage(): boolean {
  const mode = configuration.get<CredentialMode>("auth.credentialMode", "auto");
  const isRemote = !!env.remoteName;

  switch (mode) {
    case "auto":
      // Extension storage only when remote
      return isRemote;
    case "extensionStorage":
      // Always use extension storage
      return true;
    case "systemKeyring":
    case "prompt":
      // Never use extension storage
      return false;
    default:
      return isRemote;
  }
}
import { StatusService } from "./services/StatusService";
import { ResourceGroupManager } from "./services/ResourceGroupManager";
import { RemoteChangeService } from "./services/RemoteChangeService";
import { STAGING_CHANGELIST } from "./services/stagingService";
import { SvnFileDecorationProvider } from "./fileDecorationProvider";
import {
  IAuth,
  ICleanupOptions,
  IFileStatus,
  ILockOptions,
  IOperations,
  ISvnErrorData,
  ISvnInfo,
  ISvnLockInfo,
  ISvnResourceGroup,
  IUnlockOptions,
  IUpdateResult,
  LockStatus,
  Operation,
  RepositoryState,
  Status,
  SvnDepth,
  SvnUriAction,
  ISvnPathChange,
  IStoredAuth,
  ISvnListItem
} from "./common/types";
import { debounce, globalSequentialize, memoize, throttle } from "./decorators";
import { exists, rename as fsRename, stat } from "./fs";
import { configuration } from "./helpers/configuration";
import OperationsImpl from "./operationsImpl";
import { PathNormalizer } from "./pathNormalizer";
import { IRemoteRepository } from "./remoteRepository";
import { Resource } from "./resource";
import { StatusBarCommands } from "./statusbar/statusBarCommands";
import { svnErrorCodes } from "./svn";
import { Repository as BaseRepository } from "./svnRepository";
import { toSvnUri } from "./uri";
import {
  anyEvent,
  dispose,
  eventToPromise,
  filterEvent,
  BLAME_INVALIDATING_OPERATIONS,
  FORCE_REFRESH_OPERATIONS,
  getSvnDir,
  isDescendant,
  isReadOnly,
  shouldFetchLockStatus,
  timeout
} from "./util";
import { logError } from "./util/errorLogger";
import { match } from "./util/globMatch";
import { IHistoryFilter } from "./historyView/historyFilter";
import { RepositoryFilesWatcher } from "./watchers/repositoryFilesWatcher";

function shouldShowProgress(operation: Operation): boolean {
  switch (operation) {
    case Operation.CurrentBranch:
    case Operation.Show:
    case Operation.Info:
    // Blame and List are background reads fired by cursor movement and
    // quickdiff stats - flashing the SCM spinner for them reads as
    // "extension permanently busy"
    case Operation.Blame:
    case Operation.List:
      return false;
    default:
      return true;
  }
}

/**
 * Cached configuration values (Phase 8.1 perf fix)
 */
type RepositoryConfig = {
  actionForDeletedFiles: string;
  ignoredRulesForDeletedFiles: string[];
  updateFrequency: number;
  autorefresh: boolean;
  remoteChangesCheckFrequency: number;
  ignoreOnStatusCount: string[];
  countUnversioned: boolean;
  hideUnversioned: boolean;
  ignore: string[];
};

export class Repository implements IRemoteRepository {
  public sourceControl: SourceControl;
  public statusBar: StatusBarCommands;
  public ignored: Resource[] = [];
  public statusExternal: IFileStatus[] = [];
  private disposables: Disposable[] = [];
  public currentBranch = "";
  public remoteChangedFiles: number = 0;
  public isIncomplete: boolean = false;
  public needCleanUp: boolean = false;
  private deletedUris = new Set<Uri>(); // Phase 8.1 perf fix - Set for auto-deduplication
  private canSaveAuth: boolean = false;
  private statusService: StatusService;
  private groupManager: ResourceGroupManager;
  private remoteChangeService: RemoteChangeService;
  private fileDecorationProvider: SvnFileDecorationProvider;
  private _configCache: RepositoryConfig | undefined;

  // Property accessors for backward compatibility
  get staged(): ISvnResourceGroup {
    return this.groupManager.staged;
  }

  get changes(): ISvnResourceGroup {
    return this.groupManager.changes;
  }

  get conflicts(): ISvnResourceGroup {
    return this.groupManager.conflicts;
  }

  get unversioned(): ISvnResourceGroup {
    return this.groupManager.unversioned;
  }

  get changelists(): ReadonlyMap<string, ISvnResourceGroup> {
    return this.groupManager.changelists;
  }

  get remoteChanges(): ISvnResourceGroup | undefined {
    return this.groupManager.remoteChanges;
  }

  get staging() {
    return this.groupManager.staging;
  }

  private lastPromptAuth?: Thenable<IAuth | undefined>;
  private saveAuthLock: Promise<void> = Promise.resolve();
  private credentialLock: Promise<void> = Promise.resolve(); // Mutex for credential assignment
  private promptAuthCooldown: boolean = false;
  private promptAuthCooldownTimer?: ReturnType<typeof setTimeout>;
  private storedAuthsCache?: { accounts: IStoredAuth[]; expiry: number };

  // Needs-lock cache: set of relative paths with svn:needs-lock property
  // Populated in batch by refreshAllPropertyCaches() for efficient decoration
  private needsLockFilesSet = new Set<string>();
  // Defer first propget until 3s after construction — unblocks first paint
  private needsLockCacheExpiry = Date.now() + 3000;
  private needsLockCacheWarmed = false;
  private static readonly NEEDS_LOCK_CACHE_TTL = 60000; // 60 seconds

  // Cached result from last remote-change check (background polling or explicit)
  private _lastRemoteCheck?: { hasChanges: boolean; timestamp: number };

  // Server-knowledge tracker - see recordServerRevision()
  private _lastKnownServerRevision?: { revision: number; timestamp: number };

  // Repo-GLOBAL youngest revision (any branch). Distinct from the WC-
  // subtree probe above: branch-changes must react to commits on the
  // SOURCE branch, which never touch this working copy's subtree.
  private _lastKnownRepoRevision?: { revision: number; timestamp: number };

  // getChanges() result, valid while branch URL + repo youngest revision
  // hold. Cleared alongside the blame caches on mutating operations; the
  // generation counter blocks stale write-backs from in-flight fetches
  // (same pattern as the blame cache).
  private _changesCache?: { key: string; changes: ISvnPathChange[] };
  private _changesGeneration = 0;

  // Property caches for decoration tooltips (eol-style, mime-type)
  private eolStyleCache = new Map<string, string>();
  private mimeTypeCache = new Map<string, string>();
  private propertyCacheExpiry = Date.now() + 3000;
  private propertyCacheWarmed = false;
  // In-flight dedup — concurrent callers share one `svn proplist -R -v .`
  private _propertyRefreshInFlight?: Promise<void>;

  // Promise that resolves after initial status refresh completes
  private _statusReadyResolve!: () => void;
  public readonly statusReady: Promise<void> = new Promise(resolve => {
    this._statusReadyResolve = resolve;
  });

  // Lock status cache: preserves lock info between status calls
  // Lock status is only visible with --show-updates, so we cache it
  // Map: relative path -> { lockStatus, lockOwner, hasLockToken }
  private lockStatusCache = new Map<
    string,
    { lockStatus: LockStatus; lockOwner?: string; hasLockToken: boolean }
  >();

  private _fsWatcher: RepositoryFilesWatcher;
  public get fsWatcher() {
    return this._fsWatcher;
  }

  private _onDidChangeRepository = new EventEmitter<Uri>();
  public readonly onDidChangeRepository: Event<Uri> =
    this._onDidChangeRepository.event;

  private _onDidChangeState = new EventEmitter<RepositoryState>();
  public readonly onDidChangeState: Event<RepositoryState> =
    this._onDidChangeState.event;

  private _onDidChangeStatus = new EventEmitter<void>();
  public readonly onDidChangeStatus: Event<void> =
    this._onDidChangeStatus.event;

  private _onDidChangeRemoteChangedFiles = new EventEmitter<void>();
  public readonly onDidChangeRemoteChangedFile: Event<void> =
    this._onDidChangeRemoteChangedFiles.event;

  private _onDidChangeNeedsLock = new EventEmitter<void>();
  public readonly onDidChangeNeedsLock: Event<void> =
    this._onDidChangeNeedsLock.event;

  private _onDidChangeLockStatus = new EventEmitter<void>();
  public readonly onDidChangeLockStatus: Event<void> =
    this._onDidChangeLockStatus.event;

  private _onRunOperation = new EventEmitter<Operation>();
  public readonly onRunOperation: Event<Operation> = this._onRunOperation.event;

  private _onDidRunOperation = new EventEmitter<Operation>();
  public readonly onDidRunOperation: Event<Operation> =
    this._onDidRunOperation.event;

  @memoize
  get onDidChangeOperations(): Event<void> {
    return anyEvent(
      this.onRunOperation as unknown as Event<void>,
      this.onDidRunOperation as unknown as Event<void>
    );
  }

  private _operations = new OperationsImpl();
  get operations(): IOperations {
    return this._operations;
  }

  private _state = RepositoryState.Idle;
  get state(): RepositoryState {
    return this._state;
  }
  set state(state: RepositoryState) {
    this._state = state;
    this._onDidChangeState.fire(state);

    this.groupManager.clearAll();

    this.isIncomplete = false;
    this.needCleanUp = false;
  }

  /**
   * Flag to suppress status updates during sparse checkout downloads.
   * When true, file watcher events won't trigger SVN status commands,
   * preventing working copy lock conflicts on Windows.
   */
  private _sparseDownloadCount = 0;
  get sparseDownloadInProgress(): boolean {
    return this._sparseDownloadCount > 0;
  }
  /** Increment/decrement the concurrent download counter. */
  beginSparseDownload(): void {
    this._sparseDownloadCount++;
  }
  endSparseDownload(): void {
    this._sparseDownloadCount = Math.max(0, this._sparseDownloadCount - 1);
  }

  get root(): string {
    return this.repository.root;
  }

  get workspaceRoot(): string {
    return this.repository.workspaceRoot;
  }

  /** 'svn://repo.x/branches/b1' e.g. */
  get branchRoot(): Uri {
    return Uri.parse(this.repository.info.url);
  }

  get inputBox(): SourceControlInputBox {
    return this.sourceControl.inputBox;
  }

  private setOptionalInputBoxProperty(
    property: "visible" | "enabled" | "validateInput",
    value: unknown
  ): void {
    try {
      (this.sourceControl.inputBox as unknown as Record<string, unknown>)[
        property
      ] = value;
    } catch {
      // Some SCM inputBox options are proposal-gated in stable VS Code.
      // Ignore when unavailable to preserve baseline repository functionality.
    }
  }

  get username(): string | undefined {
    return this.repository.username;
  }

  set username(username: string | undefined) {
    this.repository.username = username;
  }

  get password(): string | undefined {
    return this.repository.password;
  }

  set password(password: string | undefined) {
    this.repository.password = password;
  }

  constructor(
    public repository: BaseRepository,
    private secrets: SecretStorage
  ) {
    this.statusService = new StatusService(
      repository,
      repository.workspaceRoot,
      repository.root
    );

    this._fsWatcher = new RepositoryFilesWatcher(repository.root);
    this.disposables.push(this._fsWatcher);

    this._fsWatcher.onDidAny(this.onFSChange, this, this.disposables);
    this._fsWatcher.onDidSvnAny(
      async (e: Uri) => {
        try {
          await this.onDidAnyFileChanged(e);
        } catch (err) {
          logError("File watcher callback failed", err);
        }
      },
      this,
      this.disposables
    );

    this.sourceControl = scm.createSourceControl(
      "svn",
      "SVN",
      Uri.file(repository.workspaceRoot)
    );

    // @ts-expect-error - contextValue exists at runtime but not in types
    this.sourceControl.contextValue = "repository";
    this.sourceControl.inputBox.placeholder =
      "Message here or Ctrl+Enter for guided commit";
    this.setOptionalInputBoxProperty("visible", true);
    this.setOptionalInputBoxProperty("enabled", true);
    this.setOptionalInputBoxProperty("validateInput", (text: string) =>
      this.validateCommitInput(text)
    );
    this.sourceControl.acceptInputCommand = {
      command: "sven.commitFromInputBox",
      title: "Commit",
      arguments: [this]
    };
    this.sourceControl.quickDiffProvider = this;
    this.sourceControl.count = 0;
    this.disposables.push(this.sourceControl);

    this.statusBar = new StatusBarCommands(this);
    this.disposables.push(this.statusBar);
    this.statusBar.onDidChange(
      () => (this.sourceControl.statusBarCommands = this.statusBar.commands),
      null,
      this.disposables
    );

    // Update action button when operations start/end (for spinning icon)
    this.onDidChangeOperations(
      () => this.updateActionButton(),
      null,
      this.disposables
    );

    // Initialize ResourceGroupManager
    this.groupManager = new ResourceGroupManager(
      this.sourceControl,
      this.disposables
    );

    // Initialize RemoteChangeService - interval ticks are probe-gated,
    // focus-gated (skip while unfocused, catch up on refocus) and back
    // off when the server is unreachable
    this.remoteChangeService = new RemoteChangeService(
      () => this.pollRemoteChanges(),
      () => ({
        checkFrequencySeconds: configuration.get<number>(
          "remoteChanges.checkFrequency",
          300
        )
      }),
      {
        isFocused: () => window.state.focused,
        onDidFocus: listener =>
          window.onDidChangeWindowState(e => {
            if (e.focused) {
              listener();
            }
          })
      }
    );

    // Initialize FileDecorationProvider for Explorer view decorations
    this.fileDecorationProvider = new SvnFileDecorationProvider(this);
    this.disposables.push(
      window.registerFileDecorationProvider(this.fileDecorationProvider)
    );
    this.disposables.push(this.fileDecorationProvider);

    // Intercept file renames to use svn move for tracked files
    this.disposables.push(
      workspace.onDidRenameFiles(e => this.onDidRenameFiles(e))
    );

    // Intercept file deletes to use svn delete for tracked files
    this.disposables.push(
      workspace.onDidDeleteFiles(e => this.onDidDeleteFiles(e))
    );

    // For each deleted file, add to set (auto-deduplicates)
    this._fsWatcher.onDidWorkspaceDelete(
      uri => this.deletedUris.add(uri),
      this,
      this.disposables
    );

    // Only check deleted files after the status list is fully updated
    this.onDidChangeStatus(this.actionForDeletedFiles, this, this.disposables);

    // Start remote change polling — defer until after initial status is ready
    // Avoids duplicate svn stat calls during startup
    this.remoteChangeService.start();

    // On change config, restart remote change service
    configuration.onDidChange(e => {
      // Invalidate config cache only when cached settings change (v2.32.14 fix)
      // Previously invalidated on ANY config change which was too aggressive
      if (
        e.affectsConfiguration("sven.delete.actionForDeletedFiles") ||
        e.affectsConfiguration("sven.delete.ignoredRulesForDeletedFiles") ||
        e.affectsConfiguration("sven.sourceControl.countBadge") ||
        e.affectsConfiguration("sven.autorefresh") ||
        e.affectsConfiguration("sven.remoteChanges.checkFrequency") ||
        e.affectsConfiguration("sven.sourceControl.ignoreOnStatusCount") ||
        e.affectsConfiguration("sven.sourceControl.countUnversioned") ||
        e.affectsConfiguration("sven.sourceControl.hideUnversioned") ||
        e.affectsConfiguration("sven.sourceControl.ignore")
      ) {
        this._configCache = undefined;
      }

      if (e.affectsConfiguration("sven.remoteChanges.checkFrequency")) {
        this.remoteChangeService.restart();
        void this.updateRemoteChangedFiles();
      }

      // Clear runtime credentials and caches when auth mode changes
      // Forces re-authentication with new storage mode
      if (e.affectsConfiguration("sven.auth.credentialMode")) {
        // Chain credential clearing to saveAuthLock to serialize properly
        // This ensures any concurrent operation waits for clearing to complete
        this.saveAuthLock = this.saveAuthLock.then(() => {
          this.username = undefined;
          this.password = undefined;
          this.canSaveAuth = false;
          this.storedAuthsCache = undefined;
        });
      }
    });

    this.status()
      .then(() => {
        this._statusReadyResolve();
        // First remote check after initial status is ready
        void this.updateRemoteChangedFiles();
        // Defer propget caches past first paint — single svn proplist call
        // Skip if already warmed (e.g., hasNeedsLock triggered refresh early)
        setTimeout(() => {
          if (!this.needsLockCacheWarmed || !this.propertyCacheWarmed) {
            void this.refreshAllPropertyCaches();
          }
        }, 3000);
      })
      .catch(err => {
        // Resolve even on error so callers don't hang
        this._statusReadyResolve();
        // Show user-friendly message for connection errors on startup
        const svnError = err as ISvnErrorData;
        if (
          svnError.svnErrorCode === svnErrorCodes.UnableToConnect ||
          svnError.stderrFormated?.includes("No such host")
        ) {
          window.showErrorMessage(
            "Unable to connect to SVN server. Check VPN/network."
          );
        }
      });

    this.disposables.push(
      workspace.onDidSaveTextDocument(document => {
        this.onDidSaveTextDocument(document);
      }),
      // Prompt to lock files with svn:needs-lock property when opened
      // Also warn if file has pending remote updates
      workspace.onDidOpenTextDocument(document => {
        if (document.uri.scheme === "file") {
          // Fire async - don't block document open
          void this.promptLockIfNeeded(document.uri);
          void this.promptUpdateIfRemoteChanges(document.uri);
        }
      }),
      // First-edit lock guard (cheap: a Set lookup per event after the
      // first prompt per file)
      workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.scheme === "file" && e.contentChanges.length > 0) {
          void this.promptLockOnEdit(e.document.uri);
        }
      })
    );
  }

  /**
   * Get cached configuration values (Phase 8.1 perf fix)
   * Prevents repeated configuration.get() calls in hot paths
   */
  private getConfig(): RepositoryConfig {
    if (this._configCache) {
      return this._configCache;
    }

    this._configCache = {
      actionForDeletedFiles: configuration.get<string>(
        "delete.actionForDeletedFiles",
        "remove"
      ),
      ignoredRulesForDeletedFiles: configuration.get<string[]>(
        "delete.ignoredRulesForDeletedFiles",
        []
      ),
      updateFrequency: configuration.get<number>(
        "sourceControl.countBadge",
        10
      ),
      autorefresh: configuration.get<boolean>("autorefresh"),
      remoteChangesCheckFrequency: configuration.get<number>(
        "remoteChanges.checkFrequency",
        300
      ),
      ignoreOnStatusCount: configuration.get<string[]>(
        "sourceControl.ignoreOnStatusCount",
        []
      ),
      countUnversioned: configuration.get<boolean>(
        "sourceControl.countUnversioned",
        false
      ),
      hideUnversioned: configuration.get<boolean>(
        "sourceControl.hideUnversioned",
        false
      ),
      ignore: configuration.get<string[]>("sourceControl.ignore", [])
    };

    return this._configCache;
  }

  @debounce(500)
  private async onDidAnyFileChanged(e: Uri) {
    // Skip during sparse checkout downloads to prevent svn info spam
    if (this.sparseDownloadInProgress) {
      return;
    }

    // Check grace period after force refresh to avoid redundant calls
    if (this.isInGracePeriod()) {
      return; // Info was already updated during force refresh
    }

    // Event-emitter invocation: nobody awaits this handler, so a failed
    // spawn (e.g. the working copy was deleted out from under us) must
    // not escape as an unhandled rejection
    try {
      await this.repository.updateInfo();
    } catch (err) {
      logError("updateInfo after file change failed", err);
      return;
    }
    this._onDidChangeRepository.fire(e);
  }

  /**
   * Check all recently deleted files and compare with svn status "missing"
   */
  @debounce(300)
  private async actionForDeletedFiles() {
    if (this.deletedUris.size === 0) {
      return;
    }

    const allUris = Array.from(this.deletedUris);
    this.deletedUris.clear();

    const config = this.getConfig();
    const actionForDeletedFiles = config.actionForDeletedFiles;

    if (actionForDeletedFiles === "none") {
      return;
    }

    const resources = allUris
      .map(uri => this.getResourceFromFile(uri))
      .filter(
        resource => resource && resource.type === Status.MISSING
      ) as Resource[];

    let uris = resources.map(resource => resource.resourceUri);

    if (!uris.length) {
      return;
    }

    const rules = config.ignoredRulesForDeletedFiles.map(ignored =>
      match(ignored)
    );

    if (rules.length) {
      uris = uris.filter(uri => {
        // Check first for relative URL (Better for workspace configuration)
        const relativePath = this.repository.removeAbsolutePath(uri.fsPath);

        // If some match, remove from list
        return !rules.some(rule => rule(relativePath) || rule(uri.fsPath));
      });
    }

    if (!uris.length) {
      return;
    }

    if (actionForDeletedFiles === "remove") {
      return this.removeFiles(
        uris.map(uri => uri.fsPath),
        false
      );
    } else if (actionForDeletedFiles === "prompt") {
      return commands.executeCommand("sven.promptRemove", ...uris);
    }

    // Unknown action - do nothing (config enum exhausted above)
    return;
  }

  // Lock badges change WITHOUT revision bumps, so a periodic full
  // --show-updates sweep is needed even when HEAD hasn't moved
  private static readonly LOCK_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
  private lastFullRemoteStatusTs = 0;
  // Youngest revision the probe saw when the last full fetch ran - the
  // poll gate's anchor (see pollRemoteChanges)
  private _lastRemoteStatusRevision?: number;

  /**
   * Event-driven remote refresh (post switch/merge/pull, config change,
   * explicit command): state definitely changed, so always run the full
   * fetch. Interval ticks call pollRemoteChanges() directly and are
   * probe-gated.
   */
  @debounce(500)
  // async is the contract: command callers await it and tests pin that a
  // rejecting implementation propagates; the poll is fire-and-forget
  // eslint-disable-next-line @typescript-eslint/require-await
  public async updateRemoteChangedFiles() {
    void this.pollRemoteChanges(true);
  }

  /**
   * Two-tier remote poll. Interval ticks first run a cheap single
   * round-trip youngest-revision probe and skip the full-working-copy
   * `svn status --show-updates` tree walk when nothing can have changed.
   *
   * The gate compares the probed youngest revision against the one seen
   * at the LAST FULL FETCH - never against BASE. BASE comparisons lie in
   * mixed-revision working copies (own commits bump only committed
   * nodes; the root revision is a single scalar). Revision identity is
   * exact: any new server revision differs from the anchored one.
   *
   * Known probe blind spots, both bounded by the lock sweep: members
   * pinned below the WC root revision, and svn:externals sources (their
   * incoming changes never bumped this subtree's log).
   *
   * force=true (event-driven refresh) always runs the full fetch.
   */
  public async pollRemoteChanges(force = false): Promise<void> {
    const config = this.getConfig();

    if (!config.remoteChangesCheckFrequency) {
      // Clear remote changes when disabled
      if (this.groupManager.remoteChanges) {
        this.groupManager.remoteChanges.resourceStates = [];
      }
      return;
    }

    let probedYoungest: number | undefined;
    if (!force) {
      const probe = await this.probeRemoteChanges();
      probedYoungest = probe.youngestRevision;
      const lockSweepDue =
        Date.now() - this.lastFullRemoteStatusTs >=
        Repository.LOCK_SWEEP_INTERVAL_MS;
      const staleIncomingUi =
        (this.groupManager.remoteChanges?.resourceStates.length ?? 0) > 0;
      const unchangedSinceFullFetch =
        probedYoungest !== undefined &&
        probedYoungest === this._lastRemoteStatusRevision;

      if (unchangedSinceFullFetch && !staleIncomingUi && !lockSweepDue) {
        return; // nothing new since the last full fetch, UI current
      }
    }

    await this.run(Operation.StatusRemote);
    // Anchor the gate to what the probe saw. After force refreshes this
    // is undefined, so the next tick runs one full fetch to re-anchor.
    this._lastRemoteStatusRevision = probedYoungest;
    // Full --show-updates includes lock info - sweep satisfied on success
    this.lastFullRemoteStatusTs = Date.now();
  }

  /**
   * Intercept file renames to use svn move for tracked files.
   * This preserves file history when renaming via Explorer.
   */
  private async onDidRenameFiles(e: {
    files: ReadonlyArray<{ oldUri: Uri; newUri: Uri }>;
  }): Promise<void> {
    for (const { oldUri, newUri } of e.files) {
      // Skip files outside this repository
      if (!oldUri.fsPath.startsWith(this.workspaceRoot)) {
        continue;
      }

      try {
        // Check if old path was tracked by SVN (will show as "missing" now)
        const wasTracked = await this.wasFileTracked(oldUri.fsPath);

        if (wasTracked) {
          // Undo the filesystem rename
          await fsRename(newUri.fsPath, oldUri.fsPath);

          // Use svn rename to preserve history
          await this.rename(oldUri.fsPath, newUri.fsPath);
        }
      } catch (err) {
        // Log but don't block - user can manually fix if needed
        logError(`Failed to convert rename to svn move: ${oldUri.fsPath}`, err);
      }
    }
  }

  /**
   * Intercept file deletes to use svn delete for tracked files.
   * This immediately marks files for deletion instead of leaving as "missing".
   */
  private async onDidDeleteFiles(e: {
    files: ReadonlyArray<Uri>;
  }): Promise<void> {
    const config = this.getConfig();

    // Only auto-delete if setting is "remove"
    if (config.actionForDeletedFiles !== "remove") {
      return;
    }

    // Collect all tracked files first, then delete in batch
    // This prevents race conditions when deleting multiple files
    const trackedFiles: string[] = [];

    for (const uri of e.files) {
      // Skip files outside this repository
      if (!uri.fsPath.startsWith(this.workspaceRoot)) {
        continue;
      }

      try {
        // Check if file was tracked by SVN
        const wasTracked = await this.wasFileTracked(uri.fsPath);
        if (wasTracked) {
          trackedFiles.push(uri.fsPath);
        }
      } catch (err) {
        logError(`Failed to check if tracked: ${uri.fsPath}`, err);
      }
    }

    // Delete all tracked files in a single svn delete call
    if (trackedFiles.length > 0) {
      try {
        await this.removeFiles(trackedFiles, false);
      } catch (err) {
        logError(`Failed to auto-delete files`, err);
      }
    }
  }

  /**
   * Check if a file path was tracked by SVN before it was renamed/deleted.
   * Uses svn info which works even on missing files.
   */
  private async wasFileTracked(filePath: string): Promise<boolean> {
    try {
      // svn info succeeds for tracked files, even if missing
      await this.repository.getInfo(filePath);
      return true;
    } catch {
      // Not tracked or error
      return false;
    }
  }

  private onFSChange(_uri: Uri): void {
    const config = this.getConfig();

    if (!config.autorefresh) {
      return;
    }

    // Skip watcher during bulk operations to reduce CPU spikes
    // These operations trigger many file changes but refresh when complete
    if (
      this.operations.isRunning(Operation.Update) ||
      this.operations.isRunning(Operation.SwitchBranch) ||
      this.operations.isRunning(Operation.Merge)
    ) {
      return;
    }

    // Check grace period after force refresh (Update, Commit, etc.)
    // to avoid redundant status calls from file watcher
    if (this.isInGracePeriod()) {
      this.queueRefreshAfterGracePeriod();
      return;
    }

    // Don't check idle here - eventuallyUpdateWhenIdleAndWait handles
    // idle-waiting via whenIdleAndFocused(). Previously, events were
    // silently dropped if operations were running, causing missed updates.
    this.eventuallyUpdateWhenIdleAndWait();
  }

  /**
   * Check if within grace period after a force refresh operation.
   */
  private isInGracePeriod(): boolean {
    return Date.now() - this.lastForceRefresh < this.FORCE_REFRESH_GRACE_MS;
  }

  /**
   * Queue a refresh for after the grace period ends.
   * Ensures user changes during grace period aren't lost.
   */
  private queueRefreshAfterGracePeriod(): void {
    // Already queued
    if (this.pendingGraceRefresh) {
      return;
    }

    const remaining =
      this.FORCE_REFRESH_GRACE_MS - (Date.now() - this.lastForceRefresh);
    if (remaining <= 0) {
      // Grace period already expired, refresh now
      this.eventuallyUpdateWhenIdleAndWait();
      return;
    }

    // Queue refresh for after grace period
    this.pendingGraceRefresh = setTimeout(() => {
      this.pendingGraceRefresh = undefined;
      this.eventuallyUpdateWhenIdleAndWait();
    }, remaining + 100); // +100ms buffer
  }

  // FS events already pass through RepositoryFilesWatcher's 300ms throttle
  // (util.ts:throttleEvent). Debouncing here adds latency on top of that;
  // 200ms is enough to coalesce burst follow-ups without making save→status
  // refresh feel sluggish.
  @debounce(200)
  private eventuallyUpdateWhenIdleAndWait(): void {
    void this.updateWhenIdleAndWait();
  }

  @throttle
  private async updateWhenIdleAndWait(): Promise<void> {
    await this.whenIdleAndFocused();
    await this.status();
  }

  public async whenIdleAndFocused(): Promise<void> {
    while (true) {
      if (!this.operations.isIdle()) {
        await eventToPromise(this.onDidRunOperation);
        continue;
      }

      if (!window.state.focused) {
        const onDidFocusWindow = filterEvent(
          window.onDidChangeWindowState,
          e => e.focused
        );
        await eventToPromise(onDidFocusWindow);
        continue;
      }

      return;
    }
  }

  private lastModelUpdate: number = 0;
  // Cache window for status updates — prevents duplicate svn stat calls
  // when multiple triggers fire in quick succession (file open, watcher, etc.)
  private readonly MODEL_CACHE_MS = 1000;

  // Grace period after force refresh to avoid redundant file watcher status calls
  private lastForceRefresh: number = 0;
  private readonly FORCE_REFRESH_GRACE_MS = 5000; // 5 seconds
  private pendingGraceRefresh: NodeJS.Timeout | undefined;

  /** Set grace period to block file watcher status updates */
  public setGracePeriod(): void {
    this.lastForceRefresh = Date.now();
  }

  @globalSequentialize("updateModelState")
  public async updateModelState(
    checkRemoteChanges: boolean = false,
    forceRefresh: boolean = false,
    fetchLockStatus: boolean = false
  ) {
    // Skip status updates during sparse checkout downloads
    // Prevents working copy lock conflicts on Windows
    if (this.sparseDownloadInProgress) {
      return;
    }

    // Short-term cache: skip if called within 2s (unless forced)
    // Note: @throttle removed (Phase 15) - cache already handles throttling
    const now = Date.now();
    if (!forceRefresh && now - this.lastModelUpdate < this.MODEL_CACHE_MS) {
      return;
    }
    this.lastModelUpdate = now;

    // Force refresh repository info after revision-changing operations
    // (Commit, Update, etc.) so repo history can detect the new revision
    if (forceRefresh) {
      // Set grace period BEFORE updateInfo to block file watcher events
      // that fire during lock/unlock .svn directory changes
      this.lastForceRefresh = Date.now();
      // Drop the property-changes cache so the upcoming StatusService
      // refresh sees fresh prop diff output for paths that may have
      // changed during the mutating operation.
      this.repository.clearPropertyChangesCache();
      await this.repository.updateInfo(true);
    }

    // Get categorized status from StatusService
    const result = await this.retryRun(async () => {
      return this.statusService.updateStatus({
        checkRemoteChanges,
        fetchLockStatus
      });
    });

    // Update metadata
    this.statusExternal = [...result.statusExternal];
    this.ignored = [...result.ignored];
    this.isIncomplete = result.isIncomplete;
    this.needCleanUp = result.needCleanUp;

    // Only update lock status cache when we actually fetched lock info
    // (--show-updates). Local-only status calls don't return lock data,
    // so clearing the cache would wipe valid entries from previous remote polls.
    if (fetchLockStatus) {
      const prevLockCount = this.lockStatusCache.size;
      this.lockStatusCache.clear();
      for (const [relativePath, lockInfo] of result.lockStatuses) {
        // Normalize key: forward slashes, lowercase on Windows
        const cacheKey = this.normalizeRelativePath(relativePath);
        this.lockStatusCache.set(cacheKey, lockInfo);
      }
      // Fire event if lock count changed
      if (this.lockStatusCache.size !== prevLockCount) {
        this._onDidChangeLockStatus.fire();
      }
    }

    // Delegate group management to ResourceGroupManager
    const config = this.getConfig();
    const count = this.groupManager.updateGroups({
      result,
      config: {
        ignoreOnStatusCountList: config.ignoreOnStatusCount,
        countUnversioned: config.countUnversioned,
        hideUnversioned: config.hideUnversioned,
        ignoreList: config.ignore,
        workspaceRoot: this.workspaceRoot
      },
      // Lock status is authoritative when fetched with --show-updates
      lockStatusFresh: fetchLockStatus
    });

    this.sourceControl.count = count;
    this.updateActionButton();

    // Update context keys for conditional UI
    const hasConflicts = this.groupManager.conflicts.resourceStates.length > 0;
    commands.executeCommand("setContext", "sven.hasConflicts", hasConflicts);

    // Set repository reference on remote changes group
    if (this.groupManager.remoteChanges) {
      this.groupManager.remoteChanges.repository = this;
    }

    // Update remote changes count + cache result for PreCommitUpdateService
    if (checkRemoteChanges) {
      this._lastRemoteCheck = {
        hasChanges: result.remoteChanges.length > 0,
        timestamp: Date.now()
      };
      if (result.remoteChanges.length !== this.remoteChangedFiles) {
        this.remoteChangedFiles = result.remoteChanges.length;
        this._onDidChangeRemoteChangedFiles.fire();
      }
    }

    // Update context key for remote changes
    const hasRemoteChanges = this.remoteChangedFiles > 0;
    commands.executeCommand(
      "setContext",
      "sven.updateAvailable",
      hasRemoteChanges
    );

    this._onDidChangeStatus.fire();

    // Refresh all property caches in a single proplist call when any are expired
    // Fire-and-forget: stale caches are acceptable; don't block the hot path
    if (
      Date.now() >= this.needsLockCacheExpiry ||
      Date.now() >= this.propertyCacheExpiry
    ) {
      void this.refreshAllPropertyCaches().catch(e =>
        logError("property cache refresh", e)
      );
    }

    // Refresh file decorations in Explorer view
    if (this.fileDecorationProvider) {
      // Always refresh all decorations - simpler and handles all cases:
      // - Files added to changes
      // - Files removed from changes (reverted)
      // - Files moved between groups
      // Passing undefined refreshes all tracked files efficiently
      this.fileDecorationProvider.refresh(undefined);
    }

    this.currentBranch = await this.getCurrentBranch();

    return Promise.resolve();
  }

  private updateActionButton(): void {
    const stagedCount = this.groupManager.staged.resourceStates.length;
    const changesCount = this.groupManager.changes.resourceStates.length;
    const hasChanges = stagedCount > 0 || changesCount > 0;

    // Check if commit/update is in progress
    const isCommitting = this.operations.isRunning(Operation.Commit);
    const isUpdating = this.operations.isRunning(Operation.Update);
    const isOperationRunning = isCommitting || isUpdating;

    // Use spinning icon during operations
    let icon = "$(check)";
    let tooltip = "Commit Changes";
    if (isCommitting) {
      icon = "$(sync~spin)";
      tooltip = "Committing...";
    } else if (isUpdating) {
      icon = "$(sync~spin)";
      tooltip = "Updating...";
    }

    const label =
      stagedCount > 0 ? `${icon} Commit (${stagedCount})` : `${icon} Commit`;

    // Secondary commands for dropdown menu (Command[][])
    const secondaryCommands = [
      [
        {
          command: "sven.commitStaged",
          title: "Commit Staged...",
          tooltip: "Commit only staged files",
          arguments: [this]
        },
        {
          command: "sven.commitAll",
          title: "Commit All...",
          tooltip: "Commit all changed files",
          arguments: [this]
        },
        {
          command: "sven.commitQuick",
          title: "Commit (Quick)",
          tooltip: "Commit staged files without message prompt",
          arguments: [this]
        }
      ]
    ];

    // @ts-expect-error - actionButton exists at runtime but not in types
    this.sourceControl.actionButton = {
      command: {
        command: "sven.commitFromInputBox",
        title: label,
        tooltip,
        arguments: [this]
      },
      secondaryCommands,
      enabled: hasChanges && !isOperationRunning
    };
  }

  /**
   * Force re-validation of the commit input box.
   * VS Code only calls validateInput when text changes, so we toggle value
   * to trigger re-validation after staging/unstaging operations.
   */
  private triggerInputValidation(): void {
    const inputBox = this.sourceControl.inputBox;
    const currentValue = inputBox.value;
    // Toggle value to force validateInput callback
    inputBox.value = currentValue + " ";
    inputBox.value = currentValue;
  }

  private validateCommitInput(text: string): InputBoxValidation | undefined {
    const stagedCount = this.groupManager.staged.resourceStates.length;
    const conflictCount = this.groupManager.conflicts.resourceStates.length;

    // Error: conflicts must be resolved first
    if (conflictCount > 0) {
      return {
        message: `${conflictCount} conflict(s) must be resolved before committing`,
        type: InputBoxValidationType.Error
      };
    }

    // Warning: no files staged
    if (stagedCount === 0) {
      return {
        message: "No files staged for commit",
        type: InputBoxValidationType.Warning
      };
    }

    // Info: message empty (but not an error - guided commit will prompt)
    if (!text || text.trim() === "") {
      return {
        message: "Enter message or press Ctrl+Enter for guided commit",
        type: InputBoxValidationType.Information
      };
    }

    return undefined;
  }

  public getResourceFromFile(uri: string | Uri): Resource | undefined {
    return this.groupManager.getResourceFromFile(uri);
  }

  /**
   * Check if a file path is inside an unversioned or ignored FOLDER.
   * Used when getResourceFromFile() returns undefined.
   */
  public isInsideUnversionedOrIgnored(filePath: string): Status | undefined {
    return this.groupManager.isInsideUnversionedOrIgnored(filePath);
  }

  /**
   * Get flat resource map for batch operations (Phase 21.A perf)
   * Avoids repeated URI conversion overhead in hot loops
   * @returns Map of file paths to resources
   */
  public getResourceMap(): Map<string, Resource> {
    return this.groupManager.getResourceMap();
  }

  public provideOriginalResource(uri: Uri): Uri | undefined {
    if (uri.scheme !== "file") {
      return;
    }

    // Not has original resource for content of ".svn" folder
    if (isDescendant(path.join(this.root, getSvnDir()), uri.fsPath)) {
      return;
    }

    return toSvnUri(uri, SvnUriAction.SHOW, {}, true);
  }

  public async getBranches() {
    try {
      return await this.repository.getBranches();
    } catch (error) {
      return [];
    }
  }

  @throttle
  public async status() {
    return this.run(Operation.Status);
  }

  public async show(
    filePath: string | Uri,
    revision?: string,
    pegRevision?: string
  ): Promise<string> {
    return this.run<string>(Operation.Show, () => {
      return this.repository.show(filePath, revision, pegRevision);
    });
  }

  public async rollbackToRevision(
    filePath: string,
    targetRevision: string
  ): Promise<string> {
    return this.run<string>(Operation.Merge, () => {
      return this.repository.rollbackToRevision(filePath, targetRevision);
    });
  }

  public async patchRevision(revision: string, url: Uri): Promise<string> {
    return this.run<string>(Operation.Show, () => {
      return this.repository.patchRevision(revision, url);
    });
  }

  public async showBuffer(
    filePath: string | Uri,
    revision?: string
  ): Promise<Buffer> {
    return this.run<Buffer>(Operation.Show, () => {
      return this.repository.showBuffer(filePath, revision);
    });
  }

  public async addFiles(files: string[]) {
    return this.run(Operation.Add, () => this.repository.addFiles(files));
  }

  public async addChangelist(files: string[], changelist: string) {
    return this.run(Operation.AddChangelist, () =>
      this.repository.addChangelist(files, changelist)
    );
  }

  public async removeChangelist(files: string[]) {
    return this.run(Operation.RemoveChangelist, () =>
      this.repository.removeChangelist(files)
    );
  }

  /**
   * Stage files with optimistic UI update.
   * @param files Paths to stage. Folders are staged for visual grouping.
   * @param opts.expand When true, expands directories to include all changed
   *   descendant files (SVN changelists are file-only).
   *
   * For unversioned files, `svn add` is called first before changelist.
   */
  public async stageOptimistic(
    files: string[],
    opts: { expand?: boolean } = {}
  ): Promise<void> {
    // Suppress watcher reflex (svn info / svn stat / proplist cascade) during
    // .svn/wc.db writes from the changelist command — UI is updated below.
    this.setGracePeriod();

    const targets = opts.expand
      ? this.expandDirectoriesToGroupFiles(files, this.groupManager.changes)
      : files;

    const unversionedPaths = this.findUnversionedPaths(targets);
    if (unversionedPaths.length > 0) {
      // svn add handles parent directories automatically
      await this.repository.addFiles(unversionedPaths);
    }

    // Changelists can't hold directories; UI move keeps them for grouping
    const filesOnly = await this.filterOutDirectories(targets);
    if (filesOnly.length > 0) {
      await this.repository.addChangelist(filesOnly, STAGING_CHANGELIST);
    }

    this.groupManager.moveToStaged(targets);
    this.notifyStagingChanged();
  }

  /**
   * Find paths that are unversioned (need `svn add` before changelist).
   */
  private findUnversionedPaths(paths: string[]): string[] {
    const unversioned: string[] = [];
    for (const p of paths) {
      const resource = this.groupManager.getResourceFromFile(p);
      if (resource && resource.type === Status.UNVERSIONED) {
        unversioned.push(p);
      }
    }
    return unversioned;
  }

  /**
   * Filter out directories from path list.
   */
  private async filterOutDirectories(paths: string[]): Promise<string[]> {
    const files: string[] = [];
    for (const p of paths) {
      try {
        const stats = await stat(p);
        if (!stats.isDirectory()) {
          files.push(p);
        }
      } catch {
        // If stat fails (file doesn't exist), include it anyway
        files.push(p);
      }
    }
    return files;
  }

  /**
   * Expand directory paths to include all descendant files from a resource group.
   * SVN changelists only work with files, not directories.
   */
  private expandDirectoriesToGroupFiles(
    paths: string[],
    group: SourceControlResourceGroup
  ): string[] {
    const result = new Set<string>();
    const groupPaths = group.resourceStates.map(r => r.resourceUri.fsPath);

    for (const p of paths) {
      result.add(p);
      for (const gp of groupPaths) {
        if (isDescendant(p, gp)) {
          result.add(gp);
        }
      }
    }
    return Array.from(result);
  }

  /**
   * Unstage files with optimistic UI update.
   * Runs SVN changelist commands but skips full status refresh.
   *
   * `groups` is keyed by destination changelist; `null` key means "remove
   * from any changelist". All SVN commands run, then ONE UI notification
   * fires — avoids N rounds of action-button + input-box churn when paths
   * span multiple destinations.
   */
  public async unstageOptimistic(
    groups: Map<string | null, string[]>
  ): Promise<void> {
    // Suppress watcher reflex during .svn/wc.db writes — UI is updated below.
    this.setGracePeriod();

    for (const [destination, paths] of groups) {
      const expanded = this.expandDirectoriesToGroupFiles(
        paths,
        this.groupManager.staged
      );
      const filesOnly = await this.filterOutDirectories(expanded);

      if (filesOnly.length > 0) {
        if (destination) {
          await this.repository.addChangelist(filesOnly, destination);
        } else {
          await this.repository.removeChangelist(filesOnly);
        }
      }
      this.groupManager.moveFromStaged(expanded, destination ?? undefined);
    }

    this.notifyStagingChanged();
  }

  /**
   * Notify VS Code SCM UI of staging changes.
   * Refreshes the commit action button and re-validates the input box.
   */
  private notifyStagingChanged(): void {
    this.updateActionButton();
    this.triggerInputValidation();
  }

  public async getCurrentBranch() {
    return this.run(Operation.CurrentBranch, async () => {
      return this.repository.getCurrentBranch();
    });
  }

  public async newBranch(
    name: string,
    commitMessage: string = "Created new branch"
  ) {
    return this.run(Operation.NewBranch, async () => {
      await this.repository.newBranch(name, commitMessage);
      void this.updateRemoteChangedFiles();
    });
  }

  public async switchBranch(name: string, force: boolean = false) {
    await this.run(Operation.SwitchBranch, async () => {
      await this.repository.switchBranch(name, force);
      void this.updateRemoteChangedFiles();
    });
  }

  public async merge(
    name: string,
    reintegrate: boolean = false,
    accept_action: string = "postpone"
  ) {
    await this.run(Operation.Merge, async () => {
      await this.repository.merge(name, reintegrate, accept_action);
      void this.updateRemoteChangedFiles();
    });
  }

  public async updateRevision(
    ignoreExternals: boolean = false,
    {
      skipHistoryRefresh = false,
      token,
      files
    }: {
      skipHistoryRefresh?: boolean;
      token?: CancellationToken;
      files?: string[];
    } = {}
  ): Promise<IUpdateResult> {
    const result = await this.run<IUpdateResult>(Operation.Update, async () => {
      const updateResult = await this.repository.update(ignoreExternals, {
        token,
        files
      });
      // Note: status refresh handled by run() via updateModelState() after callback
      // Do NOT call this.status() here - causes credentialLock deadlock (nested retryRun)
      if (updateResult.revision !== null) {
        this.recordServerRevision(updateResult.revision);
      }
      if (!files || files.length === 0) {
        // Full update — at HEAD, no remote changes
        this._lastRemoteCheck = { hasChanges: false, timestamp: Date.now() };
      } else {
        // Targeted update — invalidate cache so next check re-queries server
        this._lastRemoteCheck = undefined;
      }
      return updateResult;
    });
    // Fetch history views (skipped when caller handles refresh, e.g. commitFiles)
    if (!skipHistoryRefresh) {
      await Promise.all([
        commands.executeCommand("sven.repolog.fetch"),
        commands.executeCommand("sven.itemlog.refresh")
      ]);
    }
    return result;
  }

  /**
   * Cheap server probe (one constant-cost round-trip): are there new
   * revisions beyond BASE, and what is the youngest one observed?
   * Records the revision in the server-knowledge tracker and caches the
   * boolean for reuse by PreCommitUpdateService.
   */
  public async probeRemoteChanges(): Promise<{
    hasChanges: boolean;
    youngestRevision?: number;
  }> {
    const probe = await this.repository.hasRemoteChanges();
    this.recordServerRevision(probe.youngestRevision);
    this._lastRemoteCheck = {
      hasChanges: probe.hasChanges,
      timestamp: Date.now()
    };
    return probe;
  }

  /**
   * Check if server has new commits since last update.
   * Caches result for reuse by PreCommitUpdateService.
   */
  public async hasRemoteChanges(): Promise<boolean> {
    return (await this.probeRemoteChanges()).hasChanges;
  }

  /**
   * Youngest server revision observed via ANY server response (probe,
   * update, commit). One number answers most "is my knowledge current?"
   * questions: any server-side content change bumps the youngest
   * revision. Locks are the exception - they change without revisions.
   */
  public recordServerRevision(revision: number | undefined): void {
    if (revision === undefined || isNaN(revision)) {
      return;
    }
    const current = this._lastKnownServerRevision;
    if (!current || revision > current.revision) {
      this._lastKnownServerRevision = { revision, timestamp: Date.now() };
    } else {
      // Same or older revision observed - still refreshes the timestamp
      // for the current value (the knowledge was just re-confirmed)
      if (revision === current.revision) {
        current.timestamp = Date.now();
      }
    }
  }

  public get lastKnownServerRevision():
    | { revision: number; timestamp: number }
    | undefined {
    return this._lastKnownServerRevision;
  }

  /**
   * Get cached result from last remote-change check.
   * Used by PreCommitUpdateService to skip redundant network call.
   */
  public getLastRemoteCheckResult():
    | { hasChanges: boolean; timestamp: number }
    | undefined {
    return this._lastRemoteCheck;
  }

  /**
   * Get configured remote check frequency in ms.
   * Used as freshness threshold for cached remote-check result.
   */
  public getRemoteCheckFrequencyMs(): number {
    return (
      configuration.get<number>("remoteChanges.checkFrequency", 300) * 1000
    );
  }

  public async pullIncomingChange(path: string) {
    return this.run<string>(Operation.Update, async () => {
      const response = await this.repository.pullIncomingChange(path);
      // Note: updateRemoteChangedFiles() called by caller after batch completes
      // to avoid N redundant calls when pulling N files
      return response;
    });
  }

  /**
   * Trigger remote changes refresh after batch operations complete.
   * Call this once after pulling multiple incoming changes.
   */
  public refreshRemoteChanges(): void {
    void this.updateRemoteChangedFiles();
  }

  public async resolve(files: string[], action: string) {
    return this.run(Operation.Resolve, () =>
      this.repository.resolve(files, action)
    );
  }

  public async commitFiles(message: string, files: string[]) {
    // Ensure needs-lock cache is warm before parallel checks.
    // Cold cache would cause N concurrent svn propget calls hitting wc.db.
    if (Date.now() >= this.needsLockCacheExpiry) {
      await this.refreshAllPropertyCaches();
    }
    // Check for needs-lock files that aren't locked (parallel for performance)
    // Skip warning for property-only changes (e.g., setting svn:needs-lock itself)
    const needsLockResults = await Promise.all(
      files.map(async file => ({
        file,
        hasNeedsLock: await this.hasNeedsLock(file)
      }))
    );
    const unlockedNeedsLock: string[] = [];
    for (const { file, hasNeedsLock } of needsLockResults) {
      if (hasNeedsLock) {
        const resource = this.getResourceFromFile(file);
        if (resource?.type === Status.NORMAL) {
          continue;
        }
        if (!resource?.hasLockToken) {
          unlockedNeedsLock.push(file);
        }
      }
    }

    if (unlockedNeedsLock.length > 0) {
      const answer = await window.showWarningMessage(
        `${unlockedNeedsLock.length} file(s) have svn:needs-lock but are not locked. Commit anyway?`,
        { modal: true },
        "Commit Anyway"
      );
      if (answer !== "Commit Anyway") {
        throw new Error("Commit cancelled: unlock files or lock them first");
      }
    }

    const result = await this.run(Operation.Commit, () =>
      this.repository.commitFiles(message, files)
    );
    // (Log cache is cleared by the explicit `sven.repolog.fetch` invocation
    //  below via explicitRefreshCmd's shouldClearCache=true; no redundant
    //  wholesale clear needed here. Past revisions in the cache are
    //  immutable anyway.)

    // Post-commit update: sync working copy to new revision (if enabled)
    const autoUpdate = configuration.commitAutoUpdate();
    if (autoUpdate === "both" || autoUpdate === "after") {
      try {
        await window.withProgress(
          {
            location: ProgressLocation.Notification,
            title: "Syncing working copy...",
            cancellable: true
          },
          async (_progress, token) => {
            await this.updateRevision(false, {
              skipHistoryRefresh: true,
              token
            });
          }
        );
      } catch (updateErr) {
        // Log (sanitized) but don't fail the commit - it already succeeded
        logError("Post-commit update failed", updateErr);
      }
    }

    // Parse commit revision from result (e.g., "3 files commited: revision 106.")
    // For partial commits, svn info on root might not show new revision
    const revMatch = result.match(/revision (\d+)/i);
    if (revMatch && revMatch[1]) {
      const newRevision = revMatch[1];
      this.recordServerRevision(parseInt(newRevision, 10));
      // Commit revisions are repo-global - feed the branch-changes gate too
      this._lastKnownRepoRevision = {
        revision: parseInt(newRevision, 10),
        timestamp: Date.now()
      };
      // Update info.revision directly so BASE indicator is correct
      // This handles mixed-revision working copies after partial commit
      if (
        parseInt(newRevision, 10) > parseInt(this.repository.info.revision, 10)
      ) {
        (this.repository.info as { revision: string }).revision = newRevision;
      }
    }

    // Refresh repo info + fetch history views in parallel
    await Promise.all([
      this.repository.updateInfo(true),
      commands.executeCommand("sven.repolog.fetch"),
      commands.executeCommand("sven.itemlog.refresh")
    ]);
    return result;
  }

  public clearLogCache(): void {
    this.repository.clearLogCache();
  }

  public async revert(files: string[], depth: keyof typeof SvnDepth = "empty") {
    return this.run(Operation.Revert, () =>
      this.repository.revert(files, depth)
    );
  }

  public async info(path: string) {
    return this.run(Operation.Info, () => this.repository.getInfo(path));
  }

  public async patch(files: string[]) {
    return this.run(Operation.Patch, () => this.repository.patch(files));
  }

  public async patchBuffer(files: string[]) {
    return this.run(Operation.Patch, () => this.repository.patchBuffer(files));
  }

  public async patchChangelist(changelistName: string) {
    return this.run(Operation.Patch, () =>
      this.repository.patchChangelist(changelistName)
    );
  }

  public async removeFiles(files: string[], keepLocal: boolean) {
    return this.run(Operation.Remove, () =>
      this.repository.removeFiles(files, keepLocal)
    );
  }

  public async plainLog() {
    return this.run(Operation.Log, () => this.repository.plainLog());
  }

  public async plainLogBuffer() {
    return this.run(Operation.Log, () => this.repository.plainLogBuffer());
  }

  public async plainLogByRevision(revision: number) {
    return this.run(Operation.Log, () =>
      this.repository.plainLogByRevision(revision)
    );
  }

  public async plainLogByRevisionBuffer(revision: number) {
    return this.run(Operation.Log, () =>
      this.repository.plainLogByRevisionBuffer(revision)
    );
  }

  public async plainLogByText(search: string) {
    return this.run(Operation.Log, () =>
      this.repository.plainLogByText(search)
    );
  }

  public async plainLogByTextBuffer(search: string) {
    return this.run(Operation.Log, () =>
      this.repository.plainLogByTextBuffer(search)
    );
  }

  public async log(
    rfrom: string,
    rto: string,
    limit: number,
    target?: string | Uri
  ) {
    return this.run(Operation.Log, () =>
      this.repository.log(rfrom, rto, limit, target)
    );
  }

  public async logBatch(revisions: string[], target?: string | Uri) {
    return this.run(Operation.Log, () =>
      this.repository.logBatch(revisions, target)
    );
  }

  public async logWithFilter(
    filter: IHistoryFilter,
    limit: number,
    target?: string | Uri
  ) {
    return this.run(Operation.Log, () =>
      this.repository.logWithFilter(filter, limit, target)
    );
  }

  public async logByUser(user: string) {
    return this.run(Operation.Log, () => this.repository.logByUser(user));
  }

  public async cleanup() {
    return this.run(Operation.CleanUp, () => this.repository.cleanup());
  }

  public async removeUnversioned() {
    return this.run(Operation.CleanUp, () =>
      this.repository.removeUnversioned()
    );
  }

  public async removeIgnored() {
    return this.run(Operation.CleanUp, () => this.repository.removeIgnored());
  }

  public async vacuumPristines() {
    return this.run(Operation.CleanUp, () => this.repository.vacuumPristines());
  }

  public async cleanupWithExternals() {
    return this.run(Operation.CleanUp, () =>
      this.repository.cleanupWithExternals()
    );
  }

  public async cleanupAdvanced(options: ICleanupOptions) {
    return this.run(Operation.CleanUp, () =>
      this.repository.cleanupAdvanced(options)
    );
  }

  public async getInfo(path: string, revision?: string): Promise<ISvnInfo> {
    // Warm cache hits bypass run()/credentialLock (see blame() above). A miss
    // or a negative (unversioned) entry falls through to the serialized fetch.
    const cached = this.repository.getInfoCached(path, revision);
    if (cached !== undefined) {
      return cached;
    }
    return this.run(Operation.Info, () =>
      this.repository.getInfo(path, revision)
    );
  }

  /**
   * Repo-global youngest revision, fresh within one poll interval.
   * Falls back to one remote `svn info <repo root>` round-trip when the
   * recorded observation is stale. undefined = offline/unknown (callers
   * must not gate on it).
   */
  private async getRepoYoungestRevision(): Promise<number | undefined> {
    const maxAge = this.getRemoteCheckFrequencyMs();
    const known = this._lastKnownRepoRevision;
    if (known && Date.now() - known.timestamp < maxAge) {
      return known.revision;
    }
    try {
      const info = await this.run(Operation.Info, () =>
        this.repository.getInfo(
          this.repository.info.repository.root,
          undefined,
          true, // skipCache - the gate must not trust the 2-min info cache
          true
        )
      );
      const revision = parseInt(info.revision, 10);
      if (!isNaN(revision)) {
        this._lastKnownRepoRevision = { revision, timestamp: Date.now() };
        return revision;
      }
    } catch {
      // Offline/unreachable - callers run ungated
    }
    return undefined;
  }

  /**
   * Branch-changes pipeline (4 server round-trips), gated on the repo
   * youngest revision: its output can only change when a commit or merge
   * lands on either branch, which by definition creates a new revision.
   */
  public async getChanges(): Promise<ISvnPathChange[]> {
    const revision = await this.getRepoYoungestRevision();

    // Branch identity in the key: an svn switch (even an external one -
    // info refreshes via the watcher) changes the output with no new
    // repository revision.
    let branchUrl = "";
    try {
      branchUrl = this.repository.info.url;
    } catch {
      // info not initialized yet - key on revision alone
    }
    const key = `${branchUrl}@${revision}`;

    if (revision !== undefined && this._changesCache?.key === key) {
      return this._changesCache.changes;
    }

    const generation = this._changesGeneration;
    const changes = await this.run(Operation.Changes, () =>
      this.repository.getChanges()
    );
    // Skip the write when a mutating op invalidated mid-fetch - the
    // result may describe the pre-mutation branch
    if (revision !== undefined && generation === this._changesGeneration) {
      this._changesCache = { key, changes };
    }
    return changes;
  }

  public async blame(path: string, revision?: string, pegRevision?: string) {
    // Warm cache hits bypass run()/credentialLock: blame renders on every
    // editor switch, and queuing an in-memory hit behind a slow in-flight
    // network op (which holds the lock) is the priority inversion we avoid.
    // A miss falls through to the fully-serialized, auth-retrying fetch.
    const cached = this.repository.blameCached(path, revision, pegRevision);
    if (cached !== undefined) {
      return cached;
    }
    return this.run(Operation.Blame, () =>
      this.repository.blame(path, revision, false, pegRevision)
    );
  }

  public async finishCheckout() {
    return this.run(Operation.SwitchBranch, () =>
      this.repository.finishCheckout()
    );
  }

  public async addToIgnore(
    expressions: string[],
    directory: string,
    recursive: boolean = false
  ) {
    return this.run(Operation.Ignore, () =>
      this.repository.addToIgnore(expressions, directory, recursive)
    );
  }

  public async removeFromIgnore(expression: string, directory: string) {
    return this.run(Operation.Ignore, () =>
      this.repository.removeFromIgnore(expression, directory)
    );
  }

  public async getAllIgnorePatterns(): Promise<Map<string, string[]>> {
    return this.run(Operation.Log, () =>
      this.repository.getAllIgnorePatterns()
    );
  }

  public async getCurrentIgnore(directory: string): Promise<string[]> {
    return this.run(Operation.Log, () =>
      this.repository.getCurrentIgnore(directory)
    );
  }

  public async deleteIgnoreProperty(directory: string): Promise<void> {
    return this.run(Operation.Ignore, () =>
      this.repository.deleteIgnoreProperty(directory)
    );
  }

  public async setIgnoreProperty(
    patterns: string[],
    directory: string
  ): Promise<void> {
    return this.run(Operation.Ignore, () =>
      this.repository.setIgnoreProperty(patterns, directory)
    );
  }

  public async rename(oldFile: string, newFile: string) {
    return this.run(Operation.Rename, () =>
      this.repository.rename(oldFile, newFile)
    );
  }

  public async list(filePath: string): Promise<ISvnListItem[]> {
    return this.run<ISvnListItem[]>(Operation.List, () => {
      // Convert local path to relative for URL-based listing (faster, non-recursive)
      const relativePath =
        filePath === this.root ? undefined : path.relative(this.root, filePath);
      return this.repository.list(relativePath);
    });
  }

  /**
   * List folder contents recursively (for folder size/count estimation).
   * @param folderPath Local folder path
   * @param timeout Optional timeout in ms for large folders
   */
  public async listRecursive(
    folderPath: string,
    timeout?: number
  ): Promise<ISvnListItem[]> {
    return this.run<ISvnListItem[]>(Operation.List, () => {
      const relativePath = path.relative(this.root, folderPath);
      return this.repository.listRecursive(relativePath, timeout);
    });
  }

  public getPathNormalizer(): PathNormalizer {
    return new PathNormalizer(this.repository.info);
  }

  /**
   * Get credential storage key based on server (not repo path).
   * This allows multiple repos on same server to share credentials.
   * e.g., https://svn.example.com/repoA and /repoB both use
   * key "vscode.sven:https://svn.example.com"
   */
  public getCredentialServiceName() {
    const info = this.repository.info;
    const repoUrl = info.repository?.root || info.url;

    if (repoUrl) {
      try {
        const url = new URL(repoUrl);
        // Use scheme + host + port (if non-default)
        const server = `${url.protocol}//${url.host}`;
        return `vscode.sven:${server}`;
      } catch {
        // Invalid URL, fall back to full URL
        return `vscode.sven:${repoUrl}`;
      }
    }

    return "vscode.sven";
  }

  public async loadStoredAuths(): Promise<Array<IStoredAuth>> {
    // Skip if extension storage disabled for this environment
    if (!shouldUseExtensionStorage()) {
      return [];
    }

    // Return cached if valid (60s TTL)
    const now = Date.now();
    if (this.storedAuthsCache && now < this.storedAuthsCache.expiry) {
      return this.storedAuthsCache.accounts;
    }

    // Prevent multiple prompts for auth
    if (this.lastPromptAuth) {
      await this.lastPromptAuth;
    }

    try {
      const secret = await this.secrets.get(this.getCredentialServiceName());

      if (secret === undefined) {
        this.storedAuthsCache = { accounts: [], expiry: now + 60000 };
        return [];
      }

      // Safe JSON.parse with runtime type validation
      const parsed = JSON.parse(secret);
      if (!Array.isArray(parsed)) {
        this.storedAuthsCache = { accounts: [], expiry: now + 60000 };
        return [];
      }
      // Filter to only valid credential entries
      const accounts = parsed.filter(
        (c): c is IStoredAuth =>
          c && typeof c.account === "string" && typeof c.password === "string"
      );
      this.storedAuthsCache = { accounts, expiry: now + 60000 };
      return accounts;
    } catch (error) {
      // SecretStorage can fail if keyring is locked/unavailable
      logError("Failed to load stored credentials", error);
      return [];
    }
  }

  public async saveAuth(): Promise<void> {
    // Skip if extension storage disabled for this environment
    if (!shouldUseExtensionStorage()) {
      return;
    }

    if (!this.canSaveAuth || !this.username || !this.password) {
      return;
    }

    // Mutex: serialize concurrent saves to prevent read-modify-write race
    const username = this.username;
    const password = this.password;
    this.canSaveAuth = false;

    this.saveAuthLock = this.saveAuthLock.then(async () => {
      try {
        const secret = await this.secrets.get(this.getCredentialServiceName());
        let credentials: Array<IStoredAuth> = [];

        if (typeof secret === "string") {
          try {
            const parsed = JSON.parse(secret);
            if (Array.isArray(parsed)) {
              credentials = parsed.filter(
                (c): c is IStoredAuth =>
                  c &&
                  typeof c.account === "string" &&
                  typeof c.password === "string"
              );
            }
          } catch (error) {
            logError("Failed to parse stored credentials", error);
            credentials = [];
          }
        }

        // Deduplicate: update existing entry or add new
        const existingIndex = credentials.findIndex(
          c => c.account === username
        );
        if (existingIndex >= 0) {
          credentials[existingIndex]!.password = password;
        } else {
          credentials.push({ account: username, password });
        }

        await this.secrets.store(
          this.getCredentialServiceName(),
          JSON.stringify(credentials)
        );
        // Invalidate cache after save
        this.storedAuthsCache = undefined;
      } catch (error) {
        // SecretStorage can fail if keyring is locked/unavailable
        // Reset canSaveAuth so user can retry on next successful operation
        this.canSaveAuth = true;
        logError("Failed to save credentials", error);
      }
    });

    return this.saveAuthLock;
  }

  /**
   * Clear all saved credentials for this repository
   * Removes from SecretStorage and clears runtime credentials
   */
  public async clearCredentials(): Promise<void> {
    // Clear SecretStorage
    await this.secrets.delete(this.getCredentialServiceName());

    // Clear runtime credentials
    this.username = undefined;
    this.password = undefined;
    this.canSaveAuth = false;
  }

  public async promptAuth(): Promise<IAuth | undefined> {
    // Prevent multiple prompts: active prompt or cooldown period
    if (this.lastPromptAuth || this.promptAuthCooldown) {
      if (this.lastPromptAuth) {
        return this.lastPromptAuth;
      }
      return undefined; // During cooldown, skip prompting
    }

    const repoUrl = this.repository.info?.url;
    this.lastPromptAuth = commands.executeCommand(
      "sven.promptAuth",
      undefined,
      undefined,
      repoUrl
    );
    const result = await this.lastPromptAuth;

    if (result) {
      this.username = result.username;
      this.password = result.password;
      this.canSaveAuth = true;
    }

    // Cooldown: prevent rapid re-prompting after dialog closes
    this.lastPromptAuth = undefined;
    this.promptAuthCooldown = true;
    if (this.promptAuthCooldownTimer) {
      clearTimeout(this.promptAuthCooldownTimer);
    }
    this.promptAuthCooldownTimer = setTimeout(() => {
      this.promptAuthCooldown = false;
      this.promptAuthCooldownTimer = undefined;
    }, 500);

    return result;
  }

  public onDidSaveTextDocument(document: TextDocument) {
    // Schedule status refresh on save to update Changes view
    // Uses same debounce path as file watcher for consistency
    // The 500ms debounce handles rapid saves, then status() runs
    this.eventuallyUpdateWhenIdleAndWait();

    // Handle conflict auto-resolution
    const uriString = document.uri.toString();
    const conflict = this.conflicts.resourceStates.find(
      resource => resource.resourceUri.toString() === uriString
    );
    if (!conflict) {
      return;
    }

    const text = document.getText();

    // Check for lines begin with "<<<<<<", "=======", ">>>>>>>"
    if (!/^<{7}[^]+^={7}[^]+^>{7}/m.test(text)) {
      commands.executeCommand("sven.resolved", conflict.resourceUri);
    }
  }

  private async run<T>(
    operation: Operation,
    runOperation: () => Promise<T> = () => Promise.resolve(null as T)
  ): Promise<T> {
    if (this.state !== RepositoryState.Idle) {
      throw new Error("Repository not initialized");
    }

    const run = async () => {
      this._operations.start(operation);
      this._onRunOperation.fire(operation);

      // Determine forceRefresh BEFORE operation to set grace period early
      const forceRefresh = FORCE_REFRESH_OPERATIONS.has(operation);

      // Set grace period BEFORE operation runs to block file watcher events
      // that fire during .svn directory changes from lock/unlock/commit/etc.
      if (forceRefresh) {
        this.lastForceRefresh = Date.now();
      }

      // Post-mutation invalidation: blame caches + branch-changes cache
      const clearMutationCaches = () => {
        this.repository.clearBlameCache();
        this._changesCache = undefined;
        this._changesGeneration++;
      };

      try {
        const result = await this.retryRun(runOperation);

        // Mutating ops can change BASE content - drop the repo blame cache
        // so blame doesn't show pre-op data for up to 5 min. Must run
        // BEFORE updateModelState: its forced `svn info` seeds the info
        // cache, and clearing afterwards (the old finally-block placement)
        // wiped that fresh entry, forcing a redundant info re-exec on the
        // next getInfo. Also runs before onDidRunOperation fires so
        // subscribers see a clean cache.
        if (BLAME_INVALIDATING_OPERATIONS.has(operation)) {
          clearMutationCaches();
        }

        const checkRemote = operation === Operation.StatusRemote;

        // Only fetch lock status (--show-updates) when needed.
        // Regular status refreshes (file watcher) stay local-only for speed.
        // Lock badges refresh during remote polling and after lock/unlock.
        const fetchLockStatus = shouldFetchLockStatus(operation);

        if (!isReadOnly(operation)) {
          // StatusRemote forces the refresh: the poll already gated the
          // decision, so the 1s model cache must not swallow the fetch
          // (it would mark the lock sweep done with zero lock data)
          await this.updateModelState(
            checkRemote,
            forceRefresh || operation === Operation.StatusRemote,
            fetchLockStatus
          );
        }

        return result;
      } catch (err) {
        // A FAILED commit/update can still have partially mutated the WC -
        // same invalidation as the success path, before the recovery
        // status refresh below
        if (BLAME_INVALIDATING_OPERATIONS.has(operation)) {
          clearMutationCaches();
        }

        // Lock/Unlock: refresh status even on error (e.g., "already locked")
        // to show correct lock state regardless of command success
        if (operation === Operation.Lock || operation === Operation.Unlock) {
          try {
            await this.updateModelState(false, true, true);
          } catch {
            // Ignore status errors during error handling
          }
        }

        const svnError = err as ISvnErrorData;
        if (svnError.svnErrorCode === svnErrorCodes.NotASvnRepository) {
          this.state = RepositoryState.Disposed;
        }

        const rootExists = await exists(this.workspaceRoot);
        if (!rootExists) {
          await commands.executeCommand("sven.close", this);
        }

        throw err;
      } finally {
        this._operations.end(operation);
        this._onDidRunOperation.fire(operation);
      }
    };

    return shouldShowProgress(operation)
      ? window.withProgress(
          { location: ProgressLocation.SourceControl, cancellable: true },
          run
        )
      : run();
  }

  private async retryRun<T>(
    runOperation: () => Promise<T> = () => Promise.resolve(null as T)
  ): Promise<T> {
    let attempt = 0;
    // Phase 8.2 perf fix - pre-load accounts before retry loop to avoid blocking
    const accounts: IStoredAuth[] = await this.loadStoredAuths();

    // Serialize credential initialization to prevent race condition
    // Multiple concurrent retryRun calls could otherwise both set credentials
    // from accounts[0], then both fail and try accounts[1], causing lockout
    await this.credentialLock;
    let releaseLock: () => void = () => {};
    this.credentialLock = new Promise(resolve => {
      releaseLock = resolve;
    });

    try {
      // Pre-set credentials from first stored account if none set
      // Prevents first attempt failing with empty credentials in remote sessions
      if (!this.username && !this.password && accounts.length > 0) {
        this.username = accounts[0]!.account;
        this.password = accounts[0]!.password;
      }

      while (true) {
        try {
          attempt++;
          const result = await runOperation();
          void this.saveAuth().catch(e => logError("save auth", e));
          return result;
        } catch (err) {
          const svnError = err as ISvnErrorData;

          if (
            svnError.svnErrorCode === svnErrorCodes.RepositoryIsLocked &&
            attempt <= 10
          ) {
            // quadratic backoff
            await timeout(Math.pow(attempt, 2) * 50);
          } else if (
            svnError.svnErrorCode === svnErrorCodes.AuthorizationFailed &&
            attempt <= accounts.length
          ) {
            // Backoff with jitter before trying next stored account
            await timeout(400 + Math.random() * 200); // 400-600ms
            // Cycle through stored accounts properly
            // attempt 1 failed with accounts[0], try accounts[1], etc.
            const index = attempt;
            const account = accounts[index];
            if (account) {
              this.username = account.account;
              this.password = account.password;
            }
          } else if (
            svnError.svnErrorCode === svnErrorCodes.AuthorizationFailed &&
            attempt <= 3 + accounts.length
          ) {
            // Backoff with jitter before prompting user
            await timeout(800 + Math.random() * 400); // 800-1200ms
            const result = await this.promptAuth();
            if (!result) {
              throw err;
            }
          } else {
            throw err;
          }
        }
      }
    } finally {
      // Release lock so next operation can proceed
      releaseLock();
    }
  }

  /**
   * Lock files/directories to prevent concurrent modifications.
   * @param files Paths to lock
   * @param options Lock options (comment, force)
   */
  public async lock(files: string[], options: ILockOptions = {}) {
    return this.run(Operation.Lock, () => this.repository.lock(files, options));
  }

  /**
   * Unlock files/directories.
   * @param files Paths to unlock
   * @param options Unlock options (force to break others' locks)
   */
  public async unlock(files: string[], options: IUnlockOptions = {}) {
    return this.run(Operation.Unlock, () =>
      this.repository.unlock(files, options)
    );
  }

  /**
   * Get lock information for a file/directory.
   * @param filePath Path to check
   * @returns Lock info or null if not locked
   */
  public async getLockInfo(filePath: string): Promise<ISvnLockInfo | null> {
    return this.run(Operation.Info, () =>
      this.repository.getLockInfo(filePath)
    );
  }

  /**
   * Get lock information for multiple URLs in a single SVN call.
   * Efficient batch operation for checking locks on remote files.
   */
  public async getBatchLockInfo(
    urls: string[]
  ): Promise<Map<string, ISvnLockInfo | null>> {
    return this.run(Operation.Info, () =>
      this.repository.getBatchLockInfo(urls)
    );
  }

  /**
   * Set depth of a folder for sparse checkouts.
   * @param folderPath Path to folder
   * @param depth One of: exclude, empty, files, immediates, infinity
   * @param options.parents Restore parent folders if excluded
   * @param options.timeout Custom timeout in ms for long downloads
   */
  public async setDepth(
    folderPath: string,
    depth: keyof typeof SvnDepth,
    options?: { parents?: boolean; timeout?: number }
  ) {
    return this.run(Operation.Update, () =>
      this.repository.setDepth(folderPath, depth, options)
    );
  }

  /**
   * Get count of files with svn:needs-lock property.
   */
  public getNeedsLockCount(): number {
    return this.needsLockFilesSet.size;
  }

  /**
   * Get all paths with svn:needs-lock property (relative paths).
   */
  public getNeedsLockPaths(): string[] {
    return Array.from(this.needsLockFilesSet);
  }

  /**
   * Get count of locked files (by me or others).
   */
  public getLockedFileCount(): number {
    return this.lockStatusCache.size;
  }

  /**
   * Get all locked file paths with their lock info.
   */
  public getLockedFilePaths(): Array<{
    relativePath: string;
    lockStatus: LockStatus;
    lockOwner?: string;
  }> {
    const result: Array<{
      relativePath: string;
      lockStatus: LockStatus;
      lockOwner?: string;
    }> = [];
    for (const [relativePath, info] of this.lockStatusCache) {
      result.push({
        relativePath,
        lockStatus: info.lockStatus,
        lockOwner: info.lockOwner
      });
    }
    return result;
  }

  /**
   * Check if a specific file has pending remote changes.
   */
  public hasRemoteChangeForFile(filePath: string): boolean {
    const remoteChanges = this.groupManager.remoteChanges;
    if (!remoteChanges?.resourceStates) {
      return false;
    }
    const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
    for (const resource of remoteChanges.resourceStates) {
      if (!resource.resourceUri) {
        continue;
      }
      const resourcePath = resource.resourceUri.fsPath
        .replace(/\\/g, "/")
        .toLowerCase();
      if (resourcePath === normalizedPath) {
        return true;
      }
    }
    return false;
  }

  /**
   * Invalidate the needs-lock cache so it will be refreshed on next status.
   * Called after propset/propdel svn:needs-lock.
   */
  public invalidateNeedsLockCache(): void {
    this.needsLockCacheExpiry = 0;
  }

  /**
   * Refresh Explorer file decorations for specific URIs.
   * Pass undefined to refresh all decorations.
   */
  public refreshExplorerDecorations(uris?: Uri | Uri[]): void {
    this.fileDecorationProvider?.refresh(uris);
  }

  /**
   * Check if file has svn:needs-lock property (sync, uses batch cache).
   * Returns true if file is in the cached set. Fast for decorations.
   */
  public hasNeedsLockCached(filePath: string): boolean {
    // Convert absolute path to relative
    let relativePath = filePath;
    if (filePath.startsWith(this.workspaceRoot)) {
      relativePath = filePath.substring(this.workspaceRoot.length);
      // Remove leading separator
      if (relativePath.startsWith("/") || relativePath.startsWith("\\")) {
        relativePath = relativePath.substring(1);
      }
    }
    return this.needsLockFilesSet.has(relativePath);
  }

  /**
   * Check if file has svn:needs-lock property (async, accurate).
   * Uses cache if valid, otherwise queries SVN directly.
   */
  public async hasNeedsLock(filePath: string): Promise<boolean> {
    // If cache is valid and has been populated at least once, use it
    if (this.needsLockCacheWarmed && Date.now() < this.needsLockCacheExpiry) {
      return this.hasNeedsLockCached(filePath);
    }

    // Cache expired - refresh all caches in single proplist call
    try {
      await this.refreshAllPropertyCaches();
      return this.hasNeedsLockCached(filePath);
    } catch {
      return false;
    }
  }

  // =========================================================================
  // EOL-Style and MIME-Type Property Caching
  // =========================================================================

  /**
   * Refresh all property caches in a single `svn proplist -R -v .` call.
   * Replaces 3 separate propget calls. Used on startup for efficiency.
   *
   * In-flight dedup: rapid triggers (e.g., two file saves in quick succession)
   * previously fired N concurrent proplists because `propertyCacheExpiry` is
   * only pushed forward AFTER the call returns. Concurrent callers now share
   * the same Promise.
   */
  public async refreshAllPropertyCaches(): Promise<void> {
    if (this._propertyRefreshInFlight) {
      return this._propertyRefreshInFlight;
    }
    this._propertyRefreshInFlight = (async () => {
      try {
        const { needsLock, eolStyle, mimeType } =
          await this.repository.getAllProperties();

        const oldCount = this.needsLockFilesSet.size;
        this.needsLockFilesSet = needsLock;
        this.needsLockCacheExpiry =
          Date.now() + Repository.NEEDS_LOCK_CACHE_TTL;
        this.needsLockCacheWarmed = true;
        if (this.needsLockFilesSet.size !== oldCount) {
          this._onDidChangeNeedsLock.fire();
        }

        this.eolStyleCache = this.normalizeMapKeys(eolStyle);
        this.mimeTypeCache = this.normalizeMapKeys(mimeType);
        this.propertyCacheExpiry = Date.now() + Repository.NEEDS_LOCK_CACHE_TTL;
        this.propertyCacheWarmed = true;
      } catch (e) {
        logError("refreshAllPropertyCaches", e);
      } finally {
        this._propertyRefreshInFlight = undefined;
      }
    })();
    return this._propertyRefreshInFlight;
  }

  /**
   * Normalize map keys: forward slashes and lowercase on Windows.
   */
  private normalizeMapKeys(map: Map<string, string>): Map<string, string> {
    const normalized = new Map<string, string>();
    const isWindows = process.platform === "win32";
    for (const [key, value] of map) {
      // SVN uses forward slashes, but normalize anyway
      let normalizedKey = key.replace(/\\/g, "/");
      if (isWindows) {
        normalizedKey = normalizedKey.toLowerCase();
      }
      normalized.set(normalizedKey, value);
    }
    return normalized;
  }

  /**
   * Get cached eol-style for a file (sync, fast for decorations).
   */
  public getEolStyleCached(filePath: string): string | undefined {
    const cacheKey = this.toCacheKey(filePath);
    return this.eolStyleCache.get(cacheKey);
  }

  /**
   * Get cached mime-type for a file (sync, fast for decorations).
   */
  public getMimeTypeCached(filePath: string): string | undefined {
    const cacheKey = this.toCacheKey(filePath);
    return this.mimeTypeCache.get(cacheKey);
  }

  /**
   * Convert file path to cache key (lowercase on Windows for case-insensitive match).
   */
  private toCacheKey(filePath: string): string {
    const relativePath = this.toRelativePath(filePath);
    return this.normalizeRelativePath(relativePath);
  }

  /**
   * Normalize a relative path for cache key use.
   * Forward slashes, lowercase on Windows.
   */
  private normalizeRelativePath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  /**
   * Get cached lock status for a file (by absolute path).
   * Sync method for use in decorators. Returns undefined if not in cache.
   *
   * All lockStatusCache access goes through toCacheKey/normalizeRelativePath
   * derived keys; raw-relative-path accessors were removed as dead API to
   * keep a single key derivation (the old dual-key hazard).
   */
  public getLockStatusCached(
    filePath: string
  ):
    | { lockStatus: LockStatus; lockOwner?: string; hasLockToken: boolean }
    | undefined {
    // Use same normalization as property caches for consistency
    const cacheKey = this.toCacheKey(filePath);
    return this.lockStatusCache.get(cacheKey);
  }

  /**
   * Set svn:needs-lock property on file (makes read-only until locked).
   */
  public async setNeedsLock(filePath: string) {
    const result = await this.run(Operation.PropertyChange, () =>
      this.repository.setNeedsLock(filePath)
    );
    // Update cache and fire events
    if (result.exitCode === 0) {
      const relativePath = this.toRelativePath(filePath);
      this.needsLockFilesSet.add(relativePath);
      this.fileDecorationProvider?.refresh(Uri.file(filePath));
      this._onDidChangeNeedsLock.fire();
    }
    return result;
  }

  /**
   * Remove svn:needs-lock property from file.
   */
  public async removeNeedsLock(filePath: string) {
    const result = await this.run(Operation.PropertyChange, () =>
      this.repository.removeNeedsLock(filePath)
    );
    // Update cache and fire events
    if (result.exitCode === 0) {
      const relativePath = this.toRelativePath(filePath);
      this.needsLockFilesSet.delete(relativePath);
      this.fileDecorationProvider?.refresh(Uri.file(filePath));
      this._onDidChangeNeedsLock.fire();
    }
    return result;
  }

  /**
   * Convert absolute path to relative path, normalized for cache lookup.
   * SVN uses forward slashes; Windows paths need normalization.
   */
  private toRelativePath(filePath: string): string {
    // Normalize separators to forward slashes (SVN convention)
    const normalized = filePath.replace(/\\/g, "/");
    const normalizedRoot = this.workspaceRoot.replace(/\\/g, "/");

    // Case-insensitive comparison on Windows
    const isWindows = process.platform === "win32";
    const comparePath = isWindows ? normalized.toLowerCase() : normalized;
    const compareRoot = isWindows
      ? normalizedRoot.toLowerCase()
      : normalizedRoot;

    // Check with trailing separator to avoid partial matches
    if (comparePath.startsWith(compareRoot + "/")) {
      // Use original normalized path (preserve case for display)
      return normalized.substring(normalizedRoot.length + 1);
    }
    // Exact match (file is workspace root itself)
    if (comparePath === compareRoot) {
      return ".";
    }

    // Not under workspace - return normalized path
    return normalized;
  }

  /**
   * Check if file needs lock and prompt user to lock it.
   * Called when opening a file that might need locking.
   */
  /** Files already warned about lock contention (once per session). */
  private readonly lockPromptShown = new Set<string>();
  /** Files already lock-guarded on first edit (once per session). */
  private readonly lockEditPromptShown = new Set<string>();

  public async promptLockIfNeeded(uri: Uri): Promise<void> {
    // Only check files in this repository's working copy
    // Use case-insensitive comparison for Windows (drive letter case)
    const normalizedUri = uri.fsPath.toLowerCase();
    const normalizedRoot = this.workspaceRoot.toLowerCase();
    if (!normalizedUri.startsWith(normalizedRoot)) {
      return;
    }

    const resource = this.getResourceFromFile(uri.fsPath);

    // We hold the lock (K): nothing to do
    if (resource?.lockStatus === LockStatus.K) {
      return;
    }

    // Locked by someone else, or our token is broken/stolen. This branch
    // used to return silently and the user found out at save/commit time.
    if (resource?.lockStatus || resource?.locked) {
      if (this.lockPromptShown.has(normalizedUri)) {
        return;
      }
      this.lockPromptShown.add(normalizedUri);
      await this.warnLockContention(uri, resource);
      return;
    }

    // Check if file has needs-lock property
    const needsLock = await this.hasNeedsLock(uri.fsPath);
    if (!needsLock) {
      return;
    }

    // File has needs-lock but isn't locked - prompt user
    const choice = await window.showInformationMessage(
      "This file requires a lock before editing. Lock it now?",
      "Lock File",
      "Not Now"
    );

    if (choice === "Lock File") {
      await commands.executeCommand("sven.lock", uri);
    }
  }

  /**
   * Informed contention warning: who holds the lock and the action that
   * resolves it (steal for O/T, re-lock for a broken token).
   */
  private async warnLockContention(uri: Uri, resource: Resource) {
    const owner = resource.lockOwner ? ` by ${resource.lockOwner}` : "";
    let message: string;
    let action: string;
    let command: string;
    switch (resource.lockStatus) {
      case LockStatus.B:
        // B = the server has NO lock anymore; the parser's lockOwner is
        // the user's own stale local token - never name it as a holder
        message = `Your lock on this file was broken. It is no longer valid on the server.`;
        action = "Lock Again";
        command = "sven.lock";
        break;
      case LockStatus.T:
        message = `Your lock on this file was stolen${owner}.`;
        action = "Steal Lock";
        command = "sven.stealLock";
        break;
      default:
        message = `This file is locked${owner}. Changes can't be committed until the lock is released or stolen.`;
        action = "Steal Lock";
        command = "sven.stealLock";
    }
    const choice = await window.showWarningMessage(message, action, "Dismiss");
    if (choice === action) {
      await commands.executeCommand(command, uri);
    }
  }

  /**
   * First-edit lock guard. VS Code happily lets you type into an
   * OS-read-only file and only fails at save (offering an "Overwrite"
   * that strips the read-only bit - bypassing SVN lock discipline
   * entirely). Prompt on the FIRST keystroke instead, once per file.
   */
  public async promptLockOnEdit(uri: Uri): Promise<void> {
    const normalizedUri = uri.fsPath.toLowerCase();
    if (this.lockEditPromptShown.has(normalizedUri)) {
      return;
    }
    const normalizedRoot = this.workspaceRoot.toLowerCase();
    if (!normalizedUri.startsWith(normalizedRoot)) {
      return;
    }

    const resource = this.getResourceFromFile(uri.fsPath);
    if (resource?.lockStatus === LockStatus.K) {
      return; // we hold the lock - never nag while typing
    }

    // Mark before any await: keystrokes arrive faster than the checks run
    this.lockEditPromptShown.add(normalizedUri);

    if (resource?.lockStatus || resource?.locked) {
      // Same warning as the on-open prompt - share its once-per-file
      // gate so open-then-edit doesn't stack two identical dialogs
      if (!this.lockPromptShown.has(normalizedUri)) {
        this.lockPromptShown.add(normalizedUri);
        await this.warnLockContention(uri, resource);
      }
      return;
    }

    const needsLock = await this.hasNeedsLock(uri.fsPath);
    if (!needsLock) {
      return;
    }

    const choice = await window.showWarningMessage(
      "This file requires a lock: it is read-only and saving will fail until you lock it.",
      "Lock File",
      "Dismiss"
    );
    if (choice === "Lock File") {
      await commands.executeCommand("sven.lock", uri);
    }
  }

  /**
   * Check if file has pending remote changes and prompt user to update.
   * Called when opening a file.
   */
  private async promptUpdateIfRemoteChanges(uri: Uri): Promise<void> {
    // Only check files in this repository's working copy
    // Use case-insensitive comparison for Windows (drive letter case)
    const normalizedUri = uri.fsPath.toLowerCase();
    const normalizedRoot = this.workspaceRoot.toLowerCase();
    if (!normalizedUri.startsWith(normalizedRoot)) {
      return;
    }

    if (!this.hasRemoteChangeForFile(uri.fsPath)) {
      return;
    }

    const choice = await window.showWarningMessage(
      "This file has pending remote updates. Update to get latest changes?",
      "Update",
      "Dismiss"
    );

    if (choice === "Update") {
      // Pass the owning repository - without a hint, multi-root
      // workspaces pop a repo picker for a repo we already know
      await commands.executeCommand("sven.update", this);
    }
  }

  // =========================================================================
  // EOL-Style Property Methods
  // =========================================================================

  /**
   * Set svn:eol-style property on file/directory.
   */
  public async setEolStyle(
    filePath: string,
    value: "native" | "LF" | "CRLF" | "CR",
    recursive = false
  ) {
    const result = await this.run(Operation.PropertyChange, () =>
      this.repository.setEolStyle(filePath, value, recursive)
    );
    // Update cache and refresh decorations on success
    if (result.exitCode === 0) {
      if (recursive) {
        // Recursive: invalidate entire cache, refresh all decorations
        this.propertyCacheExpiry = 0;
        this.fileDecorationProvider?.refresh(undefined);
      } else {
        const cacheKey = this.toCacheKey(filePath);
        this.eolStyleCache.set(cacheKey, value);
        this.fileDecorationProvider?.refresh(Uri.file(filePath));
      }
    }
    return result;
  }

  /**
   * Remove svn:eol-style property from file/directory.
   */
  public async removeEolStyle(filePath: string, recursive = false) {
    const result = await this.run(Operation.PropertyChange, () =>
      this.repository.removeEolStyle(filePath, recursive)
    );
    // Update cache and refresh decorations on success
    if (result.exitCode === 0) {
      if (recursive) {
        // Recursive: invalidate entire cache, refresh all decorations
        this.propertyCacheExpiry = 0;
        this.fileDecorationProvider?.refresh(undefined);
      } else {
        const cacheKey = this.toCacheKey(filePath);
        this.eolStyleCache.delete(cacheKey);
        this.fileDecorationProvider?.refresh(Uri.file(filePath));
      }
    }
    return result;
  }

  /**
   * Get all files with svn:eol-style property.
   */
  public async getAllEolStyleFiles(): Promise<Map<string, string>> {
    return this.repository.getAllEolStyleFiles();
  }

  // =========================================================================
  // MIME-Type Property Methods
  // =========================================================================

  /**
   * Set svn:mime-type property on file.
   */
  public async setMimeType(filePath: string, value: string) {
    const result = await this.run(Operation.PropertyChange, () =>
      this.repository.setMimeType(filePath, value)
    );
    // Update cache and refresh decorations on success
    if (result.exitCode === 0) {
      const cacheKey = this.toCacheKey(filePath);
      this.mimeTypeCache.set(cacheKey, value);
      this.fileDecorationProvider?.refresh(Uri.file(filePath));
    }
    return result;
  }

  /**
   * Remove svn:mime-type property from file.
   */
  public async removeMimeType(filePath: string) {
    const result = await this.run(Operation.PropertyChange, () =>
      this.repository.removeMimeType(filePath)
    );
    // Update cache and refresh decorations on success
    if (result.exitCode === 0) {
      const cacheKey = this.toCacheKey(filePath);
      this.mimeTypeCache.delete(cacheKey);
      this.fileDecorationProvider?.refresh(Uri.file(filePath));
    }
    return result;
  }

  /**
   * Get all files with svn:mime-type property.
   */
  public async getAllMimeTypeFiles(): Promise<Map<string, string>> {
    return this.repository.getAllMimeTypeFiles();
  }

  // =========================================================================
  // Auto-Props Property Methods
  // =========================================================================

  /**
   * Get svn:auto-props configuration from repository root.
   */
  public async getAutoProps(): Promise<string | null> {
    return this.repository.getAutoProps();
  }

  /**
   * Set svn:auto-props configuration on repository root.
   */
  public async setAutoProps(value: string) {
    return this.run(Operation.PropertyChange, () =>
      this.repository.setAutoProps(value)
    );
  }

  /**
   * Remove svn:auto-props from repository root.
   */
  public async removeAutoProps() {
    return this.run(Operation.PropertyChange, () =>
      this.repository.removeAutoProps()
    );
  }

  public dispose(): void {
    // Clear auth cooldown timer to prevent memory leak
    if (this.promptAuthCooldownTimer) {
      clearTimeout(this.promptAuthCooldownTimer);
      this.promptAuthCooldownTimer = undefined;
    }
    // Clear grace period refresh timer
    if (this.pendingGraceRefresh) {
      clearTimeout(this.pendingGraceRefresh);
      this.pendingGraceRefresh = undefined;
    }
    // Stop remote change polling to prevent timer leak
    this.remoteChangeService.dispose();
    this.statusService.dispose();
    this.repository.clearInfoCacheTimers(); // Phase 8.2 perf fix - clear timers

    // Clear caches to free memory
    this.needsLockFilesSet.clear();
    this.eolStyleCache.clear();
    this.mimeTypeCache.clear();
    this.lockStatusCache.clear();

    this.disposables = dispose(this.disposables);
  }
}
