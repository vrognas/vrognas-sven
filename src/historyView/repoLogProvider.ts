// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import {
  commands,
  Disposable,
  Event,
  EventEmitter,
  ProgressLocation,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  TreeView,
  Uri,
  window
} from "vscode";
import { RepositoryChangeEvent, ISvnLogEntry } from "../common/types";
import { SourceControlManager } from "../source_control_manager";
import { Repository } from "../repository";
import { dispose } from "../util";
import {
  checkIfFile,
  copyCommitToClipboard,
  createLoadingItem,
  createLoadAllItem,
  createLoadMoreItem,
  ensureRevisionLoaded,
  fetchMore,
  fetchNewer,
  getCommitIcon,
  getCommitLabel,
  getCommitToolTip,
  ICachedLog,
  ILogTreeItem,
  insertBaseMarker,
  LogTreeItemKind,
  openDiff,
  openFileRemote,
  openDiffCompared,
  transform,
  getCommitDescription
} from "./common";
import { revealFileInOS, diffWithExternalTool } from "../util/fileOperations";
import { logError } from "../util/errorLogger";
import {
  HistoryFilterService,
  ActionType,
  applyFilterToEntries
} from "./historyFilter";

export class RepoLogProvider
  implements TreeDataProvider<ILogTreeItem>, Disposable
{
  private _onDidChangeTreeData: EventEmitter<ILogTreeItem | undefined> =
    new EventEmitter<ILogTreeItem | undefined>();
  public readonly onDidChangeTreeData: Event<ILogTreeItem | undefined> =
    this._onDidChangeTreeData.event;
  // TODO on-disk cache?
  private readonly logCache: Map<string, ICachedLog> = new Map();
  private _dispose: Disposable[] = [];
  private static readonly MAX_LOG_CACHE_SIZE = 50;

  // Performance optimization: visibility tracking and debouncing
  private treeView?: TreeView<ILogTreeItem>;
  private refreshTimeout?: NodeJS.Timeout;
  // Explicit refresh requested while the view was hidden - run on reveal
  private pendingExplicitRefresh = false;
  private readonly DEBOUNCE_MS = 1000;

  // History filtering
  private readonly filterService = new HistoryFilterService();
  /** In-flight cache rebuild triggered by a filter change (see onFilterChange) */
  private pendingFilterRefresh: Promise<void> | undefined;

  private evictOldestLogEntry(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this.logCache.entries()) {
      const accessTime = entry.lastAccessed ?? 0;
      if (accessTime < oldestTime) {
        oldestTime = accessTime;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) {
      this.logCache.delete(oldestKey);
    }
  }

  private getCached(maybeItem?: ILogTreeItem): ICachedLog | undefined {
    // With flat structure, commits are at root level
    // Walk up to find root, then return first cache entry
    if (!maybeItem) {
      // Return first repo in cache (should only be one workspace repo)
      const first = this.logCache.values().next().value;
      if (first) {
        first.lastAccessed = Date.now();
      }
      return first;
    }

    // For commits at root level, return first cache entry
    if (!maybeItem.parent) {
      const first = this.logCache.values().next().value;
      if (first) {
        first.lastAccessed = Date.now();
      }
      return first;
    }

    return this.getCached(maybeItem.parent);
  }

  constructor(private sourceControlManager: SourceControlManager) {
    void this.refresh();

    // Create TreeView for visibility tracking
    try {
      this.treeView = window.createTreeView("sven.repolog", {
        treeDataProvider: this
      });
      this._dispose.push(
        this.treeView.onDidChangeVisibility(e =>
          this.onVisibilityChanged(e.visible)
        )
      );
      this._dispose.push(this.treeView);
    } catch (err) {
      // Handle dev reload race condition where previous view wasn't yet disposed
      logError("Failed to create repolog TreeView (may be dev reload)", err);
    }

    this._dispose.push(
      commands.registerCommand(
        "sven.repolog.copymsg",
        async (item: ILogTreeItem) => copyCommitToClipboard("msg", item)
      ),
      commands.registerCommand(
        "sven.repolog.copyrevision",
        async (item: ILogTreeItem) => copyCommitToClipboard("revision", item)
      ),
      commands.registerCommand(
        "sven.repolog.openFileRemote",
        this.openFileRemoteCmd,
        this
      ),
      commands.registerCommand("sven.repolog.openDiff", this.openDiffCmd, this),
      commands.registerCommand(
        "sven.repolog.openFileLocal",
        this.openFileLocal,
        this
      ),
      commands.registerCommand(
        "sven.repolog.refresh",
        () => this._onDidChangeTreeData.fire(undefined),
        this
      ),
      commands.registerCommand("sven.repolog.goToBase", this.goToBase, this),
      commands.registerCommand(
        "sven.repolog.goToRevision",
        this.goToRevision,
        this
      ),
      commands.registerCommand(
        "sven.repolog.fetch",
        this.explicitRefreshCmd,
        this
      ),
      commands.registerCommand("sven.repolog.fetchAll", this.fetchAll, this),
      commands.registerCommand(
        "sven.repolog.showIncoming",
        this.showIncoming,
        this
      ),
      commands.registerCommand(
        "sven.repolog.refreshHard",
        this.refreshHard,
        this
      ),
      commands.registerCommand(
        "sven.repolog.revealInExplorer",
        this.revealInExplorerCmd,
        this
      ),
      commands.registerCommand(
        "sven.repolog.diffWithExternalTool",
        this.diffWithExternalToolCmd,
        this
      ),
      this.sourceControlManager.onDidChangeRepository(
        (_e: RepositoryChangeEvent) => {
          // Performance: Skip refresh when view is hidden
          if (!this.treeView?.visible) {
            return;
          }

          // Performance: Debounce rapid events (2 second window)
          if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
          }

          this.refreshTimeout = setTimeout(() => {
            void this.refresh();
          }, this.DEBOUNCE_MS);
        }
      ),
      // Fix: Refresh when repositories are opened/closed (startup timing issue)
      // SourceControlManager discovers repos asynchronously after providers are created,
      // so we must listen for repo open/close events to update tree data
      this.sourceControlManager.onDidOpenRepository(() => {
        void this.refresh();
      }),
      this.sourceControlManager.onDidCloseRepository(() => {
        void this.refresh();
      }),
      // Filter commands - unified entry point
      commands.registerCommand(
        "sven.repolog.filterHistory",
        this.filterHistory,
        this
      ),
      commands.registerCommand(
        "sven.repolog.clearFilter",
        this.clearFilter,
        this
      ),
      // Subscribe to filter changes
      this.filterService.onDidChangeFilter(() => {
        this.onFilterChange();
      }),
      this.filterService
    );

    // Initialize context variable for menu visibility
    this.updateFilterUI();
  }

  public dispose() {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    dispose(this._dispose);
  }

  public async openFileRemoteCmd(element: ILogTreeItem) {
    if (element.kind !== LogTreeItemKind.CommitDetail) {
      return;
    }
    const commit = element.data;
    const item = this.getCached(element);
    if (!item) {
      return;
    }
    const ri = item.repo.getPathNormalizer().parse(commit._);
    if ((await checkIfFile(ri, false)) === false) {
      return;
    }
    const parent = (element.parent as ILogTreeItem).data as ISvnLogEntry;
    return openFileRemote(item.repo, ri.remoteFullPath, parent.revision);
  }

  public async openFileLocal(element: ILogTreeItem) {
    if (element.kind !== LogTreeItemKind.CommitDetail) {
      return;
    }
    const commit = element.data;
    const item = this.getCached(element);
    if (!item) {
      return;
    }
    const ri = item.repo.getPathNormalizer().parse(commit._);
    if (!(await checkIfFile(ri, true))) {
      return;
    }
    if (ri.localFullPath) {
      await commands.executeCommand("vscode.open", ri.localFullPath);
    }
  }

  public async openDiffCmd(element: ILogTreeItem) {
    if (element.kind !== LogTreeItemKind.CommitDetail) {
      return;
    }
    const commit = element.data;
    const item = this.getCached(element);
    if (!item) {
      return;
    }
    const parent = (element.parent as ILogTreeItem).data as ISvnLogEntry;
    const remotePath = item.repo
      .getPathNormalizer()
      .parse(commit._).remoteFullPath;

    // Handle added files - no previous revision exists
    if (commit.action === "A") {
      return openDiff(item.repo, remotePath, undefined, parent.revision);
    }

    // Start the right-side content fetch NOW - it runs concurrently with
    // the prev-revision log lookup below. The noop catch prevents an
    // unhandled rejection if the log lookup fails first; openDiffCompared
    // still observes the real rejection when it awaits.
    const rightContent = item.repo.show(remotePath, parent.revision);
    rightContent.catch(() => undefined);

    let prevRev: ISvnLogEntry;
    try {
      // Use peg revision to handle files renamed/moved/deleted after this revision
      // Fix: Pass peg revision separately to avoid double-@ escaping bug
      const revs = await item.repo.log(
        parent.revision,
        "1",
        2,
        remotePath,
        parent.revision
      );

      if (revs.length === 2) {
        prevRev = revs[1]!;
      } else {
        window.showWarningMessage("Cannot find previous commit");
        return;
      }
    } catch (error) {
      // File may not exist at the queried path (renamed, moved, etc.)
      window.showWarningMessage("Cannot find previous revision for this file");
      return;
    }

    // Parallel left fetch + content-equality property-only detection
    // (replaces the discarded-on-every-click `svn diff` pre-check)
    return openDiffCompared(
      item.repo,
      remotePath,
      prevRev.revision,
      parent.revision,
      rightContent
    );
  }

  public async revealInExplorerCmd(element: ILogTreeItem) {
    if (element.kind !== LogTreeItemKind.CommitDetail) {
      return;
    }

    try {
      const commit = element.data;
      const item = this.getCached(element);
      if (!item) {
        return;
      }
      const pathInfo = item.repo.getPathNormalizer().parse(commit._);

      // Use local path if available
      if (pathInfo.localFullPath) {
        await revealFileInOS(pathInfo.localFullPath);
      } else {
        window.showWarningMessage("File not available locally");
      }
    } catch (error) {
      logError("Failed to reveal file in explorer", error);
      window.showErrorMessage("Could not reveal file in explorer");
    }
  }

  public async diffWithExternalToolCmd(element: ILogTreeItem) {
    if (element.kind !== LogTreeItemKind.CommitDetail) {
      return;
    }

    try {
      const commit = element.data;
      const item = this.getCached(element);
      if (!item) {
        return;
      }
      const parent = (element.parent as ILogTreeItem).data as ISvnLogEntry;
      const remotePath = item.repo
        .getPathNormalizer()
        .parse(commit._).remoteFullPath;

      // Handle added files - no previous revision exists
      if (commit.action === "A") {
        window.showWarningMessage(
          "This is the first revision of this file - no previous version to diff"
        );
        return;
      }

      // Use peg revision to handle files renamed/moved/deleted after this revision
      // Fix: Pass peg revision separately to avoid double-@ escaping bug
      const revs = await item.repo.log(
        parent.revision,
        "1",
        2,
        remotePath,
        parent.revision
      );

      if (revs.length < 2) {
        window.showWarningMessage("Cannot find previous commit for diff");
        return;
      }

      const prevRev = revs[1]!;

      // Diff between previous and current revision
      // Use workspaceRoot if available (Repository), otherwise empty string (RemoteRepository)
      // Empty string is handled by svn.exec - uses current process working directory
      const workspaceRoot =
        item.repo instanceof Repository ? item.repo.workspaceRoot : "";

      const scm = this.sourceControlManager;
      await diffWithExternalTool(
        workspaceRoot,
        remotePath.toString(),
        scm.svn.exec.bind(scm.svn),
        prevRev.revision,
        parent.revision,
        scm.context
      );
    } catch (error) {
      logError("Failed to open external diff", error);
      window.showErrorMessage("Could not open external diff tool");
    }
  }

  // Wrapper for explicit user refresh (clears cache)
  public async explicitRefreshCmd(
    element?: ILogTreeItem,
    fetchMoreClick?: boolean
  ) {
    // Hidden view: defer the server fetch until reveal. Post-commit and
    // post-update flows fire this command unconditionally, and panels
    // are hidden in the common case - the 2 svn log calls bought nothing.
    // Load-more clicks (fetchMoreClick) bypass: a click implies visible.
    if (!fetchMoreClick && this.treeView && !this.treeView.visible) {
      // Keep the post-commit invariant cheaply: consumers of the low-
      // level log cache must not see pre-commit entries; only the
      // server refetch is deferred until reveal
      for (const repo of this.sourceControlManager.repositories) {
        repo.clearLogCache();
      }
      this.pendingExplicitRefresh = true;
      return;
    }
    return this.refresh(element, fetchMoreClick, true);
  }

  /**
   * Reveal incoming (server-only) revisions: fetch anything newer than the
   * cached head and focus the top of the view. The at-newest refresh keep
   * and downward-only fetchMore mean incoming commits otherwise only
   * appear after an update - too late for a preview.
   */
  public async showIncoming() {
    await commands.executeCommand("sven.repolog.focus");
    let cached = this.getCached();
    if (!cached) {
      return;
    }
    if (this.filterService.hasActiveFilter()) {
      this.filterService.clearFilter();
      if (this.pendingFilterRefresh) {
        await this.pendingFilterRefresh;
      }
      cached = this.getCached();
      if (!cached) {
        return;
      }
    }
    const added = await fetchNewer(cached);
    this._onDidChangeTreeData.fire(undefined);
    const top = cached.entries[0];
    if (top) {
      await this.goToRevision(parseInt(top.revision, 10));
    }
    if (added === 0) {
      window.setStatusBarMessage(
        "History already shows the latest server revisions",
        3000
      );
    }
  }

  /**
   * Hard refresh: discard ALL cached history and refetch from the server.
   * Bypasses the at-newest keep, which normal Refresh uses because
   * revision STRUCTURE is immutable - but revision PROPERTIES (svn:log
   * commit messages, authors) are editable via propset --revprop, and this
   * is the escape hatch that picks such edits up.
   */
  public refreshHard() {
    for (const repo of this.sourceControlManager.repositories) {
      repo.clearLogCache();
    }
    this.logCache.clear();
    void this.refresh(undefined, false, true);
  }

  /**
   * Page through the ENTIRE remaining history in large chunks, with
   * progress + cancellation. Streams entries into the tree as chunks land.
   */
  public async fetchAll() {
    const cached = this.getCached();
    if (!cached || cached.isLoading || cached.isComplete) {
      return;
    }
    const repoUrl = cached.svnTarget.toString(true);
    const CHUNK = 500;

    cached.isLoading = true;
    try {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: "SVN: Loading full history",
          cancellable: true
        },
        async (progress, token) => {
          while (!cached.isComplete && !token.isCancellationRequested) {
            // Filter change replaces the cache object - stop streaming
            // into an orphaned entry
            if (this.logCache.get(repoUrl) !== cached) {
              return;
            }
            await fetchMore(cached, CHUNK);
            progress.report({
              message: `${cached.entries.length} revisions loaded`
            });
            this._onDidChangeTreeData.fire(undefined);
          }
        }
      );
    } finally {
      cached.isLoading = false;
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  private onVisibilityChanged(visible: boolean): void {
    if (visible && this.pendingExplicitRefresh) {
      this.pendingExplicitRefresh = false;
      void this.refresh(undefined, undefined, true);
    }
  }

  // Navigate to the BASE revision in the tree view
  public async goToBase() {
    if (!this.treeView) {
      return;
    }
    const cached = this.getCached();
    if (!cached) {
      return;
    }
    const baseRev = cached.persisted.baseRevision;
    if (!baseRev) {
      return;
    }
    // Find the BASE commit in the entries
    for (const entry of cached.entries) {
      if (parseInt(entry.revision, 10) === baseRev) {
        // Create the tree item to reveal
        const item: ILogTreeItem = {
          kind: LogTreeItemKind.Commit,
          data: entry,
          isBase: true
        };
        await this.treeView.reveal(item, {
          select: true,
          focus: true,
          expand: false
        });
        return;
      }
    }
  }

  /**
   * Unified filter command - multi-step QuickPick for native UX
   */
  public async filterHistory() {
    const currentFilter = this.filterService.getFilter() || {};

    // Step 1: Select filter types
    const filterTypes = [
      {
        label: "$(search) Message",
        id: "message",
        detail: currentFilter.message
          ? `Current: "${currentFilter.message}"`
          : undefined
      },
      {
        label: "$(person) Author",
        id: "author",
        detail: currentFilter.author
          ? `Current: "${currentFilter.author}"`
          : undefined
      },
      {
        label: "$(file) Path",
        id: "path",
        detail: currentFilter.path
          ? `Current: "${currentFilter.path}"`
          : undefined
      },
      {
        label: "$(git-commit) Revision Range",
        id: "revision",
        detail:
          currentFilter.revisionFrom || currentFilter.revisionTo
            ? `Current: ${currentFilter.revisionFrom ?? 1}-${currentFilter.revisionTo ?? "HEAD"}`
            : undefined
      },
      {
        label: "$(calendar) Date Range",
        id: "date",
        detail:
          currentFilter.dateFrom || currentFilter.dateTo
            ? `Current: ${currentFilter.dateFrom?.toLocaleDateString() ?? "..."} to ${currentFilter.dateTo?.toLocaleDateString() ?? "..."}`
            : undefined
      },
      {
        label: "$(symbol-event) Action Types",
        id: "action",
        detail: currentFilter.actions?.length
          ? `Current: ${currentFilter.actions.join(", ")}`
          : undefined
      }
    ];

    // One-step reset, also available as the title-bar clear-all button
    if (this.filterService.hasActiveFilter()) {
      filterTypes.unshift({
        label: "$(clear-all) Clear all filters",
        id: "clearAll",
        detail: this.filterService.getFilterDescription()
      });
    }

    const selected = await window.showQuickPick(filterTypes, {
      placeHolder: "Select filter type to configure",
      title: "Filter History"
    });

    if (!selected) return;

    // Step 2: Configure selected filter type
    switch (selected.id) {
      case "clearAll":
        this.clearFilter();
        return;
      case "message":
        await this.promptFilterMessage(currentFilter.message);
        break;
      case "author":
        await this.promptFilterAuthor(currentFilter.author);
        break;
      case "path":
        await this.promptFilterPath(currentFilter.path);
        break;
      case "revision":
        await this.promptFilterRevision(
          currentFilter.revisionFrom,
          currentFilter.revisionTo
        );
        break;
      case "date":
        await this.promptFilterDate(
          currentFilter.dateFrom,
          currentFilter.dateTo
        );
        break;
      case "action":
        await this.promptFilterAction(currentFilter.actions);
        break;
    }
  }

  private async promptFilterMessage(current?: string) {
    const input = await window.showInputBox({
      prompt: "Filter by commit message",
      placeHolder: "Enter text to search in commit messages",
      value: current
    });
    if (input !== undefined) {
      this.filterService.updateFilter({ message: input || undefined });
    }
  }

  private async promptFilterAuthor(current?: string) {
    // Extract unique authors from cached entries
    const authors = new Set<string>();
    for (const cached of this.logCache.values()) {
      for (const entry of cached.entries) {
        if (entry.author) {
          authors.add(entry.author);
        }
      }
    }

    // Build QuickPick items - authors sorted alphabetically
    const authorItems = Array.from(authors)
      .sort((a, b) => a.localeCompare(b))
      .map(author => ({
        label: author,
        picked: author === current
      }));

    // Add "Custom..." option for authors not in cache
    const customOption = { label: "$(edit) Custom...", id: "custom" };

    // Add "Clear" option if filter is active
    const clearOption = current
      ? [{ label: "$(close) Clear author filter", id: "clear" }]
      : [];

    const items = [...clearOption, ...authorItems, customOption];

    const selected = await window.showQuickPick(items, {
      placeHolder: authors.size
        ? "Select author or choose Custom..."
        : "No authors in cache - choose Custom...",
      title: "Filter by Author"
    });

    if (!selected) return;

    if ("id" in selected && selected.id === "clear") {
      this.filterService.updateFilter({ author: undefined });
    } else if ("id" in selected && selected.id === "custom") {
      // Fall back to InputBox for custom author
      const input = await window.showInputBox({
        prompt: "Filter by author",
        placeHolder: "Enter author name",
        value: current
      });
      if (input !== undefined) {
        this.filterService.updateFilter({ author: input || undefined });
      }
    } else {
      this.filterService.updateFilter({ author: selected.label });
    }
  }

  private async promptFilterPath(current?: string) {
    const input = await window.showInputBox({
      prompt: "Filter by path",
      placeHolder: "Enter file or folder path pattern",
      value: current
    });
    if (input !== undefined) {
      this.filterService.updateFilter({ path: input || undefined });
    }
  }

  private async promptFilterRevision(fromVal?: number, toVal?: number) {
    const fromStr = await window.showInputBox({
      prompt: "Revision range - From (older)",
      placeHolder: "e.g., 100 (leave empty for 1)",
      value: fromVal?.toString()
    });
    if (fromStr === undefined) return;

    const toStr = await window.showInputBox({
      prompt: "Revision range - To (newer)",
      placeHolder: "e.g., 200 (leave empty for HEAD)",
      value: toVal?.toString()
    });
    if (toStr === undefined) return;

    const revisionFrom = fromStr ? parseInt(fromStr, 10) : undefined;
    const revisionTo = toStr ? parseInt(toStr, 10) : undefined;

    if (fromStr && isNaN(revisionFrom!)) {
      window.showErrorMessage("Invalid 'from' revision number");
      return;
    }
    if (toStr && isNaN(revisionTo!)) {
      window.showErrorMessage("Invalid 'to' revision number");
      return;
    }

    this.filterService.updateFilter({ revisionFrom, revisionTo });
  }

  private async promptFilterDate(fromVal?: Date, toVal?: Date) {
    const fmt = (d?: Date) => (d ? d.toISOString().split("T")[0] : "");
    const fromStr = await window.showInputBox({
      prompt: "Date range - From",
      placeHolder: "YYYY-MM-DD (e.g., 2024-01-01)",
      value: fmt(fromVal)
    });
    if (fromStr === undefined) return;

    const toStr = await window.showInputBox({
      prompt: "Date range - To",
      placeHolder: "YYYY-MM-DD (e.g., 2024-12-31)",
      value: fmt(toVal)
    });
    if (toStr === undefined) return;

    const dateFrom = fromStr ? new Date(fromStr) : undefined;
    const dateTo = toStr ? new Date(toStr) : undefined;

    if (fromStr && isNaN(dateFrom!.getTime())) {
      window.showErrorMessage("Invalid 'from' date format. Use YYYY-MM-DD");
      return;
    }
    if (toStr && isNaN(dateTo!.getTime())) {
      window.showErrorMessage("Invalid 'to' date format. Use YYYY-MM-DD");
      return;
    }

    this.filterService.updateFilter({ dateFrom, dateTo });
  }

  private async promptFilterAction(current?: ActionType[]) {
    const items = [
      {
        label: "$(add) Added",
        description: "New file (no prior history)",
        value: "A" as ActionType,
        picked: false
      },
      {
        label: "$(history) Renamed/Copied",
        description: "History preserved (R)",
        value: "R" as ActionType,
        picked: false
      },
      {
        label: "$(edit) Modified",
        value: "M" as ActionType,
        picked: false
      },
      {
        label: "$(trash) Deleted",
        value: "D" as ActionType,
        picked: false
      },
      {
        label: "$(replace) Replaced",
        description: "Delete+add at same path, history broken (!)",
        value: "!" as ActionType,
        picked: false
      }
    ];

    if (current) {
      for (const item of items) {
        item.picked = current.includes(item.value);
      }
    }

    const selected = await window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: "Select action types to show"
    });

    if (selected !== undefined) {
      const actions =
        selected.length > 0 ? selected.map(s => s.value) : undefined;
      this.filterService.updateFilter({ actions });
    }
  }

  public clearFilter() {
    this.filterService.clearFilter();
  }

  private onFilterChange() {
    // Replace cached objects (not mutate) to invalidate ongoing fetches
    // This ensures identity check in fetchMore.finally() fails for stale fetches
    const newFilter = this.filterService.getFilter();
    let needsServerRefetch = false;
    for (const [key, cached] of this.logCache.entries()) {
      if (cached.fullHistory) {
        // Full unfiltered history is cached: the new filter is applied
        // locally in getChildren - keep the entries, no server refetch.
        // (New object identity still invalidates any stale in-flight fetch.)
        this.logCache.set(key, {
          ...cached,
          isLoading: false,
          filter: newFilter
        });
      } else {
        needsServerRefetch = true;
        this.logCache.set(key, {
          ...cached,
          entries: [],
          revisionSet: new Set(),
          isComplete: false,
          fullHistory: false,
          isLoading: false,
          filter: newFilter
        });
      }
    }
    // Update tree view description and context variable
    this.updateFilterUI();
    if (needsServerRefetch) {
      // Kept awaitable so flows that must land on a post-filter cache
      // object (goToRevision) can synchronize instead of racing it
      this.pendingFilterRefresh = this.refresh(undefined, false, true);
      void this.pendingFilterRefresh;
    } else {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  private updateFilterUI() {
    const hasFilter = this.filterService.hasActiveFilter();

    // Set context variable for dynamic icon (filter vs filter-filled)
    commands.executeCommand(
      "setContext",
      "sven.historyFilterActive",
      hasFilter
    );

    if (!this.treeView) return;

    // Use description for filter summary (appears next to title)
    this.treeView.description = hasFilter
      ? this.filterService.getShortDescription()
      : undefined;
  }

  // Navigate to a specific revision in the tree view
  public async goToRevision(revision: number) {
    if (!this.treeView) {
      return;
    }
    let cached = this.getCached();
    if (!cached) {
      return;
    }

    // The reveal below needs the revision VISIBLE. A server-side-filtered
    // cache may exclude it entirely; a local (fullHistory) filter hides it
    // from the displayed list. Clearing the filter is what "go to r123"
    // means anyway.
    if (this.filterService.hasActiveFilter()) {
      this.filterService.clearFilter();
      if (this.pendingFilterRefresh) {
        await this.pendingFilterRefresh;
      }
      cached = this.getCached();
      if (!cached) {
        return;
      }
    }

    // Auto-fetch older history until the target is loaded (was: a toast
    // telling the user to click "Load more" repeatedly). Monotonic
    // revisions bound the loop exactly.
    if (!cached.revisionSet.has(String(revision))) {
      const repoUrl = cached.svnTarget.toString(true);
      const target = cached;
      const found = await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `SVN: Locating r${revision} in history`,
          cancellable: true
        },
        (_progress, token) =>
          ensureRevisionLoaded(
            target,
            revision,
            500,
            () =>
              !token.isCancellationRequested &&
              this.logCache.get(repoUrl) === target
          )
      );
      this._onDidChangeTreeData.fire(undefined);
      if (!found) {
        window.showInformationMessage(
          `Revision ${revision} not found in this repository's history.`
        );
        return;
      }
    }

    const baseRev = cached.persisted.baseRevision;
    for (const entry of cached.entries) {
      if (parseInt(entry.revision, 10) === revision) {
        const item: ILogTreeItem = {
          kind: LogTreeItemKind.Commit,
          data: entry,
          isBase: baseRev === revision
        };
        await this.treeView.reveal(item, {
          select: true,
          focus: true,
          expand: false
        });
        return;
      }
    }
  }

  public async refresh(
    element?: ILogTreeItem,
    fetchMoreClick?: boolean,
    explicitRefresh?: boolean
  ) {
    if (fetchMoreClick) {
      // Fetch more commits for current repo
      const cached = this.getCached(element);
      if (cached && !cached.isLoading) {
        cached.isLoading = true;
        try {
          await fetchMore(cached);
        } finally {
          cached.isLoading = false;
        }
      }
    } else if (element === undefined) {
      // Determine if we should clear or preserve cache
      const shouldClearCache = explicitRefresh === true;

      // Snapshot BEFORE the delete loop below: the at-newest skip needs
      // the previous entries even for auto-added repos (which get deleted)
      const prevSnapshot = shouldClearCache
        ? new Map(this.logCache)
        : undefined;

      // Save entries before modifying cache (if preserving)
      const savedEntries = new Map<string, ISvnLogEntry[]>();
      if (!shouldClearCache) {
        for (const [k, v] of this.logCache) {
          savedEntries.set(k, v.entries);
        }
      }

      // Rebuild the cache from scratch (all entries are auto-added;
      // the vestigial user-added distinction is gone)
      this.logCache.clear();

      // Clear low-level log cache on explicit refresh to force fresh SVN call
      if (shouldClearCache) {
        for (const repo of this.sourceControlManager.repositories) {
          repo.clearLogCache();
        }
      }

      // Rebuild cache with preserved or empty entries
      for (const repo of this.sourceControlManager.repositories) {
        const remoteRoot = repo.branchRoot;
        const repoUrl = remoteRoot.toString(true);
        // Use info.revision (BASE revision) for working copy state
        // After commit, BASE is updated to the new revision
        const currentRevision = parseInt(repo.repository.info.revision, 10);
        const prev = this.logCache.get(repoUrl);

        // Detect if working copy revision changed (e.g., after commit/update)
        // If so, cache is stale and should be cleared
        const revisionChanged =
          prev?.persisted.baseRevision !== undefined &&
          prev.persisted.baseRevision !== currentRevision;

        // At-newest skip for explicit refresh: history <= the WC revision
        // is immutable, so a cache whose newest entry already reaches the
        // current revision can only re-download identical data (common
        // case: incoming revisions were already fetched from HEAD, then
        // the user pressed Update). Keep the entries; just move the BASE
        // marker. Post-commit the WC revision jumps past the cache, so
        // that path still refetches.
        const snap = prevSnapshot?.get(repoUrl);
        const newestCached =
          snap && !snap.isLoading && snap.entries.length
            ? parseInt(snap.entries[0]!.revision, 10)
            : NaN;
        const alreadyCurrent =
          !isNaN(newestCached) &&
          !isNaN(currentRevision) &&
          newestCached >= currentRevision;

        let persisted: ICachedLog["persisted"] = {
          commitFrom: "HEAD",
          baseRevision: currentRevision
        };
        // Preserve persisted ONLY if: no explicit refresh AND no revision change
        // Explicit refresh (shouldClearCache) should always update baseRevision
        if (alreadyCurrent && snap) {
          persisted = { ...snap.persisted, baseRevision: currentRevision };
        } else if (prev && !shouldClearCache && !revisionChanged) {
          persisted = prev.persisted;
        }

        // Clear entries if explicit refresh OR revision changed - unless
        // the cache already covers the current revision
        const clearEntries =
          !alreadyCurrent && (shouldClearCache || revisionChanged);
        const entries =
          alreadyCurrent && snap
            ? snap.entries
            : clearEntries
              ? []
              : savedEntries.get(repoUrl) || [];
        // Preserve isComplete/fullHistory if we're keeping entries
        const isComplete =
          alreadyCurrent && snap
            ? snap.isComplete
            : clearEntries
              ? false
              : (prev?.isComplete ?? false);
        const fullHistory =
          alreadyCurrent && snap
            ? snap.fullHistory
            : clearEntries
              ? false
              : (prev?.fullHistory ?? false);

        // LRU eviction before adding (if not updating existing)
        if (
          !this.logCache.has(repoUrl) &&
          this.logCache.size >= RepoLogProvider.MAX_LOG_CACHE_SIZE
        ) {
          this.evictOldestLogEntry();
        }
        const newCached: ICachedLog = {
          entries,
          revisionSet: new Set(entries.map(e => e.revision)),
          isComplete,
          fullHistory,
          repo,
          svnTarget: remoteRoot,
          persisted,
          lastAccessed: Date.now(),
          filter: this.filterService.getFilter()
        };
        this.logCache.set(repoUrl, newCached);

        // If cache was cleared and tree is hidden, fetch now (getChildren won't be called)
        // If visible, getChildren handles loading state for snappy UX
        if (clearEntries && !this.treeView?.visible) {
          await fetchMore(newCached);
        }
      }
    }
    this._onDidChangeTreeData.fire(element);
  }

  public getTreeItem(element: ILogTreeItem): TreeItem {
    let ti: TreeItem;
    if (element.kind === LogTreeItemKind.Commit) {
      const commit = element.data;
      ti = new TreeItem(
        getCommitLabel(commit),
        TreeItemCollapsibleState.Collapsed
      );
      ti.description = getCommitDescription(commit);
      ti.tooltip = getCommitToolTip(commit);
      ti.iconPath = getCommitIcon(commit.author);
      ti.contextValue = "commit";
      // Use resourceUri to trigger FileDecorationProvider for status badges
      if (element.isBase) {
        ti.resourceUri = Uri.parse(
          `svn-commit:r${commit.revision}?isBase=true`
        );
      } else if (element.isServerOnly) {
        ti.resourceUri = Uri.parse(
          `svn-commit:r${commit.revision}?isServerOnly=true`
        );
      }
    } else if (element.kind === LogTreeItemKind.CommitDetail) {
      // TODO optional tree-view instead of flat
      const pathElem = element.data;
      const basename = path.basename(pathElem._);
      const dirname = path.dirname(pathElem._);
      const cached = this.getCached(element);
      if (!cached) {
        // Cache expired or element orphaned - return placeholder
        ti = new TreeItem(basename, TreeItemCollapsibleState.None);
        ti.description = dirname;
        return ti;
      }
      const nm = cached.repo.getPathNormalizer();
      const parsedPath = nm.parse(pathElem._);

      ti = new TreeItem(basename, TreeItemCollapsibleState.None);

      // Show directory path (decoration badge added automatically by FileDecorationProvider)
      ti.description = dirname;
      ti.tooltip = parsedPath.relativeFromBranch;

      // Determine action for badge
      // SVN "A" + copyfrom → R (renamed), SVN "R" → ! (replaced)
      let action = pathElem.action;
      if (action === "A" && pathElem.copyfromPath) {
        action = "R"; // Renamed/copied with history
      } else if (action === "R") {
        action = "!"; // Replaced (history broken)
      }

      // Use resourceUri to show file type icon and trigger file decorations
      // For files without local path, use synthetic URI for badge only
      const encodedAction = encodeURIComponent(action);
      if (parsedPath.localFullPath) {
        ti.resourceUri = parsedPath.localFullPath.with({
          query: `action=${encodedAction}`
        });
      } else {
        // Synthetic URI for historical files not in working copy
        ti.resourceUri = Uri.parse(
          `svn-history:${encodeURIComponent(pathElem._)}?action=${encodedAction}`
        );
      }

      ti.contextValue = "diffable";
      ti.command = {
        command: "sven.repolog.openDiff",
        title: "Open diff",
        arguments: [element]
      };
    } else if (element.kind === LogTreeItemKind.TItem) {
      ti = element.data;
    } else {
      throw new Error("Unknown tree elem");
    }

    return ti;
  }

  // Required for TreeView.reveal() to work
  public getParent(element: ILogTreeItem): ILogTreeItem | undefined {
    return element.parent;
  }

  public getChildren(element: ILogTreeItem | undefined): ILogTreeItem[] {
    if (element === undefined) {
      // Show commits directly at root level (skip repo folder)
      const cached = this.getCached();
      // Return empty array if no repositories in cache yet
      if (!cached) {
        return [];
      }

      // Full history cached: answer the active filter locally (instant,
      // no server round-trip). Partial windows keep the server-side path -
      // local filtering over a partial window would show misleading gaps.
      const activeFilter = this.filterService.getFilter();
      const logentries =
        cached.fullHistory &&
        activeFilter &&
        this.filterService.hasActiveFilter()
          ? applyFilterToEntries(cached.entries, activeFilter)
          : cached.entries;

      // Show loading indicator while fetching
      if (cached.isLoading) {
        return [createLoadingItem()];
      }

      // Fetch more if needed (non-blocking)
      if (logentries.length === 0 && !cached.isComplete) {
        cached.isLoading = true;
        const repoUrl = cached.svnTarget.toString(true);
        // Fetch in background, refresh when done
        void fetchMore(cached).finally(() => {
          // Only refresh if this cached object is still current (not replaced by filter change)
          const currentCached = this.logCache.get(repoUrl);
          if (currentCached === cached) {
            cached.isLoading = false;
            this._onDidChangeTreeData.fire(undefined);
          }
        });
        return [createLoadingItem()];
      }

      const result = transform(logentries, LogTreeItemKind.Commit, undefined);
      insertBaseMarker(cached, logentries, result);

      // Check if we've reached r1 (no more revisions possible) - on the
      // underlying entries, not the locally-filtered view
      const lastEntry = cached.entries[cached.entries.length - 1];
      const atFirstRevision =
        lastEntry && parseInt(lastEntry.revision, 10) <= 1;
      if (atFirstRevision) {
        cached.isComplete = true;
      }

      if (!cached.isComplete) {
        result.push(
          createLoadMoreItem("sven.repolog.fetch", [undefined, true]),
          createLoadAllItem("sven.repolog.fetchAll")
        );
      }
      return result;
    } else if (element.kind === LogTreeItemKind.Commit) {
      const commit = element.data;
      // Filter out root "/" path - occurs in property-only commits and cannot be parsed
      const paths = commit.paths.filter(p => p._ !== "/");
      return transform(paths, LogTreeItemKind.CommitDetail, element);
    }
    return [];
  }
}
