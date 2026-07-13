// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import {
  commands,
  Disposable,
  Event,
  EventEmitter,
  ExtensionContext,
  Uri,
  window,
  workspace,
  WorkspaceFoldersChangeEvent
} from "vscode";
import {
  RepositoryChangeEvent,
  IOpenRepository,
  RepositoryState
} from "./common/types";
import { debounce } from "./decorators";
import { readdir, stat } from "./fs";
import { configuration } from "./helpers/configuration";
import { RemoteRepository } from "./remoteRepository";
import { Repository } from "./repository";
import { Svn, svnErrorCodes } from "./svn";
import SvnError from "./svnError";
import { logError } from "./util/errorLogger";
import {
  anyEvent,
  dispose,
  filterEvent,
  IDisposable,
  isDescendant,
  isSvnFolder,
  normalizePath,
  eventToPromise,
  processConcurrently
} from "./util";
import { matchAll } from "./util/globMatch";

type State = "uninitialized" | "initialized";

export class SourceControlManager implements IDisposable {
  private _onDidOpenRepository = new EventEmitter<Repository>();
  public readonly onDidOpenRepository: Event<Repository> =
    this._onDidOpenRepository.event;

  private _onDidCloseRepository = new EventEmitter<Repository>();
  public readonly onDidCloseRepository: Event<Repository> =
    this._onDidCloseRepository.event;

  private _onDidChangeRepository = new EventEmitter<RepositoryChangeEvent>();
  public readonly onDidChangeRepository: Event<RepositoryChangeEvent> =
    this._onDidChangeRepository.event;

  private _onDidChangeStatusRepository = new EventEmitter<Repository>();
  public readonly onDidChangeStatusRepository: Event<Repository> =
    this._onDidChangeStatusRepository.event;

  public openRepositories: IOpenRepository[] = [];
  private disposables: Disposable[] = [];
  private possibleSvnRepositoryPaths = new Map<string, number>();
  private pendingOpenPaths = new Set<string>();
  private disposed = false;
  private topologyGeneration = 0;
  private ignoreList: string[] = [];
  private maxDepth: number = 0;
  private excludedPathsCache = new Map<string, Set<string>>(); // Phase 15 perf fix

  private configurationChangeDisposable: Disposable;

  private _onDidChangeState = new EventEmitter<State>();
  readonly onDidchangeState = this._onDidChangeState.event;

  private _state: State = "uninitialized";
  get state(): State {
    return this._state;
  }

  setState(state: State): void {
    this._state = state;
    this._onDidChangeState.fire(state);
  }

  get isInitialized(): Promise<void> {
    if (this._state === "initialized") {
      return Promise.resolve();
    }

    return eventToPromise(
      filterEvent(this.onDidchangeState, s => s === "initialized")
    ) as unknown as Promise<void>;
  }

  get repositories(): Repository[] {
    return this.openRepositories.map(r => r.repository);
  }

  get svn(): Svn {
    return this._svn;
  }

  get context(): ExtensionContext {
    return this.extensionContext;
  }

  constructor(
    private _svn: Svn,
    private extensionContext: ExtensionContext
  ) {
    this.configurationChangeDisposable = workspace.onDidChangeConfiguration(
      this.onDidChangeConfiguration,
      this
    );
  }

  /**
   * Build the manager and run async initialization (repository discovery via
   * enable()). Replaces the old async-returning-constructor cast.
   */
  static create(
    svn: Svn,
    extensionContext: ExtensionContext
  ): Promise<SourceControlManager> {
    const manager = new SourceControlManager(svn, extensionContext);
    // enable() is currently synchronous (workspace scanning is backgrounded
    // inside it); keep the Promise-shaped API so genuinely-async init can be
    // added later without call-site churn
    manager.enable();
    return Promise.resolve(manager);
  }

  public openRepositoriesSorted(): IOpenRepository[] {
    // Sort by path length (First external and ignored over root)
    return [...this.openRepositories].sort(
      (a, b) =>
        b.repository.workspaceRoot.length - a.repository.workspaceRoot.length
    );
  }

  private onDidChangeConfiguration(): void {
    // Depth only applies while multipleFolders is enabled. Unconditional
    // assignment let ANY config change flip maxDepth from 0 to the
    // package.json default (4), enabling recursive directory walks the
    // disabled mode is documented to prevent.
    this.maxDepth = configuration.get<boolean>("multipleFolders.enabled", false)
      ? configuration.get<number>("multipleFolders.depth", 0)
      : 0;
  }

  private enable() {
    const multipleFolders = configuration.get<boolean>(
      "multipleFolders.enabled",
      false
    );

    if (multipleFolders) {
      this.maxDepth = configuration.get<number>("multipleFolders.depth", 0);

      this.ignoreList = configuration.get("multipleFolders.ignore", []);
    }

    workspace.onDidChangeWorkspaceFolders(
      this.onDidChangeWorkspaceFolders,
      this,
      this.disposables
    );

    // Watch only .svn directories for new repo discovery (perf: avoid watching all files)
    const fsWatcher = workspace.createFileSystemWatcher(
      "**/.svn/{wc.db,entries}"
    );
    this.disposables.push(fsWatcher);

    const onWorkspaceChange = anyEvent(
      fsWatcher.onDidChange,
      fsWatcher.onDidCreate,
      fsWatcher.onDidDelete
    );
    const onPossibleSvnRepositoryChange = filterEvent(
      onWorkspaceChange,
      uri => uri.scheme === "file" && !this.getRepository(uri)
    );
    onPossibleSvnRepositoryChange(
      this.onPossibleSvnRepositoryChange,
      this,
      this.disposables
    );

    this.setState("initialized");

    // Startup optimization: Don't await workspace scanning - let activation complete faster
    // Scanning happens in background; repositories appear as they're discovered
    this.scanWorkspaceFolders().catch(err => {
      logError("Background workspace scan failed", err);
    });
  }

  private onPossibleSvnRepositoryChange(uri: Uri): void {
    const possibleSvnRepositoryPath = uri.fsPath.replace(/\.svn.*$/, "");
    this.eventuallyScanPossibleSvnRepository(possibleSvnRepositoryPath);
  }

  private eventuallyScanPossibleSvnRepository(path: string) {
    this.possibleSvnRepositoryPaths.set(path, this.topologyGeneration);
    this.eventuallyScanPossibleSvnRepositories();
  }

  @debounce(500)
  private eventuallyScanPossibleSvnRepositories(): void {
    for (const [path, generation] of this.possibleSvnRepositoryPaths) {
      if (this.isDiscoveryCurrent(generation, path)) {
        void this.tryOpenRepository(path, 1);
      }
    }

    this.possibleSvnRepositoryPaths.clear();
  }

  private scanExternals(repository: Repository): void {
    const shouldScanExternals =
      configuration.get<boolean>("detectExternals") === true;

    if (!shouldScanExternals) {
      return;
    }

    repository.statusExternal
      .map(r => path.join(repository.workspaceRoot, r.path))
      .forEach(p => this.eventuallyScanPossibleSvnRepository(p));
  }

  private scanIgnored(repository: Repository): void {
    const shouldScan = configuration.get<boolean>("detectIgnored") === true;

    if (!shouldScan) {
      return;
    }

    repository.ignored
      .map(r => r.resourceUri.fsPath)
      .forEach(p => this.eventuallyScanPossibleSvnRepository(p));
  }

  private disable(): void {
    [...this.openRepositories].forEach(repository => repository.dispose());

    this.possibleSvnRepositoryPaths.clear();
    this.disposables = dispose(this.disposables);
  }

  private onDidChangeWorkspaceFolders({
    added,
    removed
  }: WorkspaceFoldersChangeEvent) {
    if (this.disposed) return;
    this.topologyGeneration++;

    const removedRoots = removed.map(folder => folder.uri.fsPath);
    const remainingRoots = (workspace.workspaceFolders || []).map(
      folder => folder.uri.fsPath
    );
    const openRepositoriesToDispose = this.openRepositories.filter(
      ({ repository }) =>
        removedRoots.some(root =>
          isDescendant(root, repository.workspaceRoot)
        ) &&
        !remainingRoots.some(root =>
          isDescendant(root, repository.workspaceRoot)
        )
    );

    openRepositoriesToDispose.forEach(repository => repository.dispose());

    added
      .filter(folder => !this.getOpenRepository(folder.uri))
      .forEach(folder => {
        void this.tryOpenRepository(folder.uri.fsPath);
      });
  }

  private async scanWorkspaceFolders() {
    // Phase 8.2 perf fix - parallel scanning instead of sequential
    const folders = workspace.workspaceFolders || [];
    await Promise.all(
      folders.map(folder => this.tryOpenRepository(folder.uri.fsPath))
    );
  }

  public async tryOpenRepository(path: string, level = 0): Promise<void> {
    const discoveryGeneration = this.topologyGeneration;
    if (!this.isDiscoveryCurrent(discoveryGeneration, path)) return;
    if (this.getRepository(path)) {
      return;
    }

    const normalized = normalizePath(path);
    if (this.pendingOpenPaths.has(normalized)) {
      return;
    }
    this.pendingOpenPaths.add(normalized);

    const checkParent = level === 0;

    try {
      const isRepository = await isSvnFolder(path, checkParent);
      if (!this.isDiscoveryCurrent(discoveryGeneration, path)) return;
      if (isRepository) {
        // Config based on folder path
        const resourceConfig = workspace.getConfiguration(
          "sven",
          Uri.file(path)
        );

        const ignoredRepos = new Set(
          (resourceConfig.get<string[]>("ignoreRepositories") || []).map(p =>
            normalizePath(p)
          )
        );

        if (ignoredRepos.has(normalized)) {
          return;
        }

        const { root: repositoryRoot, info } =
          await this.svn.getRepositoryRoot(path);
        if (!this.isDiscoveryCurrent(discoveryGeneration, path)) return;

        const baseRepository = await this.svn.open(repositoryRoot, path, info);
        if (!this.isDiscoveryCurrent(discoveryGeneration, path)) {
          baseRepository.clearInfoCacheTimers();
          return;
        }
        const repository = new Repository(
          baseRepository,
          this.extensionContext.secrets
        );

        this.open(repository);
        return;
      }
    } catch (err) {
      if (!this.isDiscoveryCurrent(discoveryGeneration, path)) return;
      if (err instanceof SvnError) {
        if (err.svnErrorCode === svnErrorCodes.WorkingCopyIsTooOld) {
          await commands.executeCommand("sven.upgrade", path);
          return;
        }
      }
      logError("Repository scan failed", err);
      return;
    } finally {
      this.pendingOpenPaths.delete(normalized);
    }

    const newLevel = level + 1;
    if (newLevel <= this.maxDepth) {
      if (!this.isDiscoveryCurrent(discoveryGeneration, path)) return;
      let files: string[] | Buffer[] = [];

      try {
        files = await readdir(path);
      } catch (error) {
        return;
      }
      if (!this.isDiscoveryCurrent(discoveryGeneration, path)) return;

      // Phase 9.1 perf fix - bounded parallel operations (max 16 concurrent)
      // Previously: Unlimited Promise.all() → file descriptor exhaustion on 1000+ files
      // Now: processConcurrently() with 16 concurrent limit (45% users, no freeze)
      await processConcurrently(
        files,
        async file => {
          const dir = path + "/" + file;

          try {
            const stats = await stat(dir);
            if (
              this.isDiscoveryCurrent(discoveryGeneration, dir) &&
              stats.isDirectory() &&
              !matchAll(dir, this.ignoreList, { dot: true })
            ) {
              await this.tryOpenRepository(dir, newLevel);
            }
          } catch (error) {
            // Ignore errors for individual files
          }
        },
        16 // Concurrency limit
      );
    }
  }

  private isDiscoveryCurrent(
    generation: number,
    candidatePath: string
  ): boolean {
    if (this.disposed) return false;
    if (generation === this.topologyGeneration) return true;
    return (workspace.workspaceFolders || []).some(folder =>
      isDescendant(folder.uri.fsPath, candidatePath)
    );
  }

  public async getRemoteRepository(uri: Uri): Promise<RemoteRepository> {
    return RemoteRepository.open(this.svn, uri);
  }

  public getRepository(hint: unknown): Repository | null {
    const liveRepository = this.getOpenRepository(hint);
    if (liveRepository && liveRepository.repository) {
      return liveRepository.repository;
    }

    return null;
  }

  public getOpenRepository(hint: unknown): IOpenRepository | undefined {
    if (!hint) {
      return undefined;
    }

    if (hint instanceof Repository) {
      return this.openRepositories.find(r => r.repository === hint);
    }

    if (
      typeof hint === "object" &&
      hint !== null &&
      "repository" in hint &&
      hint.repository instanceof Repository
    ) {
      const hintWithRepo = hint as { repository: Repository };
      return this.openRepositories.find(
        r => r.repository === hintWithRepo.repository
      );
    }

    if (typeof hint === "string") {
      hint = Uri.file(hint);
    }

    if (hint instanceof Uri) {
      return this.openRepositoriesSorted().find(liveRepository => {
        if (
          !isDescendant(liveRepository.repository.workspaceRoot, hint.fsPath)
        ) {
          return false;
        }

        // Phase 15 perf fix - O(n×m) → O(n×k) with cached Set lookup
        const excludedPaths = this.excludedPathsCache.get(
          liveRepository.repository.workspaceRoot
        );
        if (excludedPaths) {
          for (const excluded of excludedPaths) {
            if (isDescendant(excluded, hint.fsPath)) {
              return false;
            }
          }
        }

        return true;
      });
    }

    for (const liveRepository of this.openRepositories) {
      const repository = liveRepository.repository;

      if (hint === repository.sourceControl) {
        return liveRepository;
      }

      if (hint === repository.changes) {
        return liveRepository;
      }
    }

    return undefined;
  }

  public getRepositoryFromUri(uri: Uri): Repository | null {
    // Phase 9.3 perf fix - use path descendant check instead of expensive info() call
    // Previously: Sequential info() SVN commands (network/IO bound) on each repo
    // Now: O(n) path checks only (8% users, changelist ops 50-300ms → <50ms)
    for (const liveRepository of this.openRepositoriesSorted()) {
      const repository = liveRepository.repository;

      // Fast path check - descendant path match
      if (isDescendant(repository.workspaceRoot, uri.fsPath)) {
        return repository;
      }
    }

    return null;
  }

  private open(repository: Repository): void {
    const onDidDisappearRepository = filterEvent(
      repository.onDidChangeState,
      state => state === RepositoryState.Disposed
    );

    const changeListener = repository.onDidChangeRepository(uri =>
      this._onDidChangeRepository.fire({ repository, uri })
    );

    const changeStatus = repository.onDidChangeStatus(() => {
      this._onDidChangeStatusRepository.fire(repository);
    });

    // Blame decorations are handled by a single shared BlameProvider
    // (created in extension.ts). It hooks this repo via onDidOpenRepository.
    const localDisposables: { dispose(): void }[] = [
      changeListener,
      changeStatus
    ];

    // Mutable reference for statusListener (defined in try block)
    let statusListener: { dispose(): void } | undefined;

    // Phase 15 perf fix - build excluded paths cache for O(1) lookup
    const buildExcludedCache = () => {
      const excluded = new Set<string>();
      for (const ext of repository.statusExternal) {
        excluded.add(path.join(repository.workspaceRoot, ext.path));
      }
      for (const ign of repository.ignored) {
        excluded.add(ign.resourceUri.fsPath);
      }
      this.excludedPathsCache.set(repository.workspaceRoot, excluded);
    };

    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      disappearListener.dispose();
      changeListener.dispose();
      changeStatus.dispose();
      if (statusListener) {
        statusListener.dispose();
      }
      repository.dispose();

      this.openRepositories = this.openRepositories.filter(
        e => e !== openRepository
      );
      this.excludedPathsCache.delete(repository.workspaceRoot); // Phase 15 perf fix
      this._onDidCloseRepository.fire(repository);
    };

    const disappearListener = onDidDisappearRepository(() => dispose());
    const openRepository = { repository, dispose };

    try {
      statusListener = repository.onDidChangeStatus(() => {
        buildExcludedCache();
        this.scanExternals(repository);
        this.scanIgnored(repository);
      });
      localDisposables.push(statusListener);

      buildExcludedCache();
      this.scanExternals(repository);
      this.scanIgnored(repository);

      this.openRepositories.push(openRepository);
      this._onDidOpenRepository.fire(repository);

      // Prompt walkthrough on first repository open (P0.3)
      if (this.openRepositories.length === 1) {
        void this.promptWalkthrough();
      }
    } catch (error) {
      // Cleanup on failure to prevent resource leaks
      // Repository included — onDidOpenRepository didn't fire so dispose closure
      // (which fires onDidCloseRepository) is not appropriate here.
      const failureDisposables: { dispose(): void }[] = [
        disappearListener,
        ...localDisposables,
        repository
      ];
      for (const d of failureDisposables) {
        try {
          d.dispose();
        } catch {
          // Ignore disposal errors during cleanup
        }
      }
      throw error;
    }
  }

  public close(repository: Repository): void {
    const openRepository = this.getOpenRepository(repository);

    if (!openRepository) {
      return;
    }

    openRepository.dispose();
  }

  public async pickRepository() {
    if (this.openRepositories.length === 0) {
      throw new Error("There are no available repositories");
    }

    const picks: Array<{ label: string; repository: Repository }> =
      this.repositories.map(repository => {
        return {
          label: path.basename(repository.root),
          repository
        };
      });
    const placeHolder = "Choose a repository";
    const pick = await window.showQuickPick(picks, { placeHolder });

    return pick && pick.repository;
  }

  public async upgradeWorkingCopy(folderPath: string): Promise<boolean> {
    try {
      const result = await this.svn.exec(folderPath, ["upgrade"]);
      return result.exitCode === 0;
    } catch (e) {
      logError("Working copy upgrade failed", e);
    }
    return false;
  }

  /**
   * Prompt user with walkthrough on first repository open.
   * Design: Only show once per installation, not per session.
   */
  private async promptWalkthrough(): Promise<void> {
    const hasCompletedSetup =
      this.context.globalState.get<boolean>("sven.setupComplete");
    if (hasCompletedSetup) {
      return;
    }

    const action = await window.showInformationMessage(
      "SVN repository detected. Need help getting started?",
      "Quick Tour",
      "Dismiss"
    );

    if (action === "Quick Tour") {
      await commands.executeCommand(
        "workbench.action.openWalkthrough",
        "vrognas.sven#sven.gettingStarted"
      );
    }

    // Mark as complete regardless of choice (don't ask again)
    await this.context.globalState.update("sven.setupComplete", true);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.topologyGeneration++;
    try {
      this.disable();
    } finally {
      this.configurationChangeDisposable.dispose();
    }
  }
}
