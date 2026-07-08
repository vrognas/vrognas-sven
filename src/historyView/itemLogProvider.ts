// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import {
  commands,
  Disposable,
  Event,
  EventEmitter,
  TextEditor,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  TreeView,
  Uri,
  window
} from "vscode";
import { confirmRollback } from "../ui/confirm";
import { SourceControlManager } from "../source_control_manager";
import { dispose } from "../util";
import {
  copyCommitToClipboard,
  createLoadMoreItem,
  fetchMore,
  getCommitIcon,
  getCommitLabel,
  getCommitToolTip,
  ICachedLog,
  ILogTreeItem,
  insertBaseMarker,
  LogTreeItemKind,
  openDiff,
  openFileRemote,
  showPatchIfPropertyOnly,
  transform,
  getCommitDescription
} from "./common";
import { getErrorMessage, logError } from "../util/errorLogger";

export class ItemLogProvider
  implements TreeDataProvider<ILogTreeItem>, Disposable
{
  private _onDidChangeTreeData: EventEmitter<ILogTreeItem | undefined> =
    new EventEmitter<ILogTreeItem | undefined>();
  public readonly onDidChangeTreeData: Event<ILogTreeItem | undefined> =
    this._onDidChangeTreeData.event;

  private currentItem?: ICachedLog;
  private _dispose: Disposable[] = [];
  private isRollingBack = false;
  private refreshDebounceTimer?: ReturnType<typeof setTimeout>;
  private treeView?: TreeView<ILogTreeItem>;
  // Explicit refresh requested while the view was hidden - run on reveal
  private pendingExplicitRefresh = false;

  constructor(private sourceControlManager: SourceControlManager) {
    try {
      this.treeView = window.createTreeView("sven.itemlog", {
        treeDataProvider: this
      });
      // Refresh once when the view becomes visible — editorChanged skips
      // refreshes while hidden, so without this the panel can show stale
      // history after the user un-hides it.
      this._dispose.push(
        this.treeView.onDidChangeVisibility(e =>
          this.onVisibilityChanged(e.visible)
        )
      );
      this._dispose.push(this.treeView);
    } catch (err) {
      // Handle dev reload race condition where previous provider wasn't yet disposed
      logError(
        "Failed to register itemlog TreeDataProvider (may be dev reload)",
        err
      );
    }

    this._dispose.push(
      window.onDidChangeActiveTextEditor(this.editorChanged, this),
      // Refresh when repositories open/close — route through editorChanged debounce
      // to prevent duplicate log fetches when open fires alongside initial refresh
      sourceControlManager.onDidOpenRepository(() =>
        this.editorChanged(window.activeTextEditor)
      ),
      sourceControlManager.onDidCloseRepository(() =>
        this.editorChanged(window.activeTextEditor)
      ),
      commands.registerCommand(
        "sven.itemlog.copymsg",
        async (item: ILogTreeItem) => copyCommitToClipboard("msg", item)
      ),
      commands.registerCommand(
        "sven.itemlog.copyrevision",
        async (item: ILogTreeItem) => copyCommitToClipboard("revision", item)
      ),
      commands.registerCommand(
        "sven.itemlog.openFileRemote",
        this.openFileRemoteCmd,
        this
      ),
      commands.registerCommand("sven.itemlog.openDiff", this.openDiffCmd, this),
      commands.registerCommand(
        "sven.itemlog.openDiffBase",
        this.openDiffBaseCmd,
        this
      ),
      commands.registerCommand(
        "sven.itemlog.refresh",
        this.explicitRefreshCmd,
        this
      ),
      commands.registerCommand(
        "sven.itemlog.gotoRepolog",
        this.gotoRepologCmd,
        this
      ),
      commands.registerCommand(
        "sven.itemlog.rollbackToRevision",
        this.rollbackToRevisionCmd,
        this
      )
    );
    // Route through editorChanged debounce to coalesce with onDidOpenRepository
    void this.editorChanged(window.activeTextEditor);
  }

  // Navigate to the same revision in repository history
  public async gotoRepologCmd(element: ILogTreeItem) {
    if (element.kind !== LogTreeItemKind.Commit) {
      return;
    }
    const commit = element.data;
    const revision = parseInt(commit.revision, 10);
    await commands.executeCommand("sven.repolog.goToRevision", revision);
  }

  // Rollback file to selected revision using reverse merge
  public async rollbackToRevisionCmd(element: ILogTreeItem) {
    if (!this.currentItem || !this.currentItem.localPath) {
      return;
    }
    if (element.kind !== LogTreeItemKind.Commit) {
      return;
    }

    const commit = element.data;
    const targetRevision = parseInt(commit.revision, 10);

    // Check if already at this revision (no-op)
    if (
      this.currentItem.persisted.baseRevision &&
      targetRevision === this.currentItem.persisted.baseRevision
    ) {
      window.showInformationMessage(
        `Already at revision ${commit.revision}. No rollback needed.`
      );
      return;
    }

    if (!(await confirmRollback(commit.revision))) {
      return;
    }

    this.isRollingBack = true;
    // Clear any pending refresh to prevent stale data flash
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = undefined;
    }
    try {
      const filePath = this.currentItem.localPath;
      const fileUri = Uri.file(filePath);

      // Get full Repository for grace period and cache refresh
      const repo = this.sourceControlManager.getRepository(fileUri);
      if (repo) {
        // Block file watcher status updates during SVN operations
        repo.setGracePeriod();
      }

      // Revert any local changes first to prevent merge conflicts
      await this.currentItem.repo.revert([filePath]);
      await this.currentItem.repo.rollbackToRevision(filePath, commit.revision);

      if (repo) {
        // Rebuild property caches from SVN for immediate badge update
        await repo.refreshAllPropertyCaches();
        // Refresh Explorer decorations (L badge, etc)
        repo.refreshExplorerDecorations([fileUri]);
      }

      window.showInformationMessage(
        `Rolled back to revision ${commit.revision}. Review changes and commit.`
      );
    } catch (error) {
      window.showErrorMessage(`Rollback failed: ${getErrorMessage(error)}`);
    } finally {
      // Keep blocking refreshes briefly to let file change events settle.
      // Rollback doesn't change BASE revision, so no refresh is needed.
      setTimeout(() => {
        this.isRollingBack = false;
      }, 1000);
    }
  }

  public dispose() {
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }
    dispose(this._dispose);
  }

  public async openFileRemoteCmd(element: ILogTreeItem) {
    if (!this.currentItem || element.kind !== LogTreeItemKind.Commit) {
      return;
    }
    const commit = element.data;
    await openFileRemote(
      this.currentItem.repo,
      this.currentItem.svnTarget,
      commit.revision
    );
    // Reveal and select the item to highlight it
    if (this.treeView) {
      try {
        await this.treeView.reveal(element, {
          select: true,
          focus: false,
          expand: false
        });
      } catch {
        // Ignore reveal errors (item may not be visible)
      }
    }
  }

  public async openDiffBaseCmd(element: ILogTreeItem) {
    if (!this.currentItem || element.kind !== LogTreeItemKind.Commit) {
      return;
    }
    const commit = element.data;
    return openDiff(
      this.currentItem.repo,
      this.currentItem.svnTarget,
      commit.revision,
      "BASE"
    );
  }

  public async openDiffCmd(element: ILogTreeItem) {
    if (!this.currentItem || element.kind !== LogTreeItemKind.Commit) {
      return;
    }
    const commit = element.data;
    const pos = this.currentItem.entries.findIndex(e => e === commit);
    if (pos === this.currentItem.entries.length - 1) {
      // First revision - no previous to diff against, show file content instead
      return openFileRemote(
        this.currentItem.repo,
        this.currentItem.svnTarget,
        commit.revision
      );
    }

    // Property-only change - show patch instead of empty diff
    if (
      await showPatchIfPropertyOnly(
        this.currentItem.repo,
        this.currentItem.svnTarget,
        commit.revision
      )
    ) {
      return;
    }

    const prevRev = this.currentItem.entries[pos + 1]!.revision;
    return openDiff(
      this.currentItem.repo,
      this.currentItem.svnTarget,
      prevRev,
      commit.revision
    );
  }

  /**
   * Explicit refresh (post-commit/update flows, user command). Hidden
   * view: defer the cache-clearing server fetch until reveal.
   */
  public async explicitRefreshCmd(
    element?: ILogTreeItem,
    te?: TextEditor,
    loadMore?: boolean
  ) {
    // Load-more button: page older history - never clear caches, never
    // defer (a click implies the view is visible). The previous inline
    // handler dropped these args and reset the whole view instead.
    if (loadMore) {
      return this.refresh(element, te, true);
    }
    if (this.treeView && !this.treeView.visible) {
      // Keep the post-commit invariant cheaply: consumers of the low-
      // level log cache must not see pre-commit entries; only the
      // server refetch is deferred until reveal
      for (const repo of this.sourceControlManager.repositories) {
        repo.clearLogCache();
      }
      this.pendingExplicitRefresh = true;
      return;
    }
    return this.refresh(undefined, undefined, false, true);
  }

  private onVisibilityChanged(visible: boolean): void {
    if (!visible) {
      return;
    }
    if (this.pendingExplicitRefresh) {
      this.pendingExplicitRefresh = false;
      void this.refresh(undefined, undefined, false, true);
    } else {
      // Refresh once on reveal - editorChanged skips refreshes while
      // hidden, so the panel could otherwise show stale history
      void this.editorChanged(window.activeTextEditor);
    }
  }

  public async editorChanged(te?: TextEditor) {
    // Skip refresh during rollback to prevent flashing
    if (this.isRollingBack) {
      return;
    }
    // Skip when the view isn't visible: refresh() fires `svn log` per tab
    // switch and the cost has no payoff while the panel is hidden. Matches
    // the guard repoLogProvider already has.
    if (this.treeView && !this.treeView.visible) {
      return;
    }
    // Debounce rapid editor changes to prevent flashing
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = undefined;
      // Re-check in case rollback started while waiting
      if (!this.isRollingBack) {
        void this.refresh(undefined, te);
      }
    }, 100);
  }

  public async refresh(
    element?: ILogTreeItem,
    te?: TextEditor,
    loadMore?: boolean,
    explicitRefresh?: boolean
  ) {
    // TODO maybe make autorefresh optionable?
    if (loadMore && this.currentItem) {
      await fetchMore(this.currentItem);
      this._onDidChangeTreeData.fire(element);
      return;
    }

    if (te === undefined) {
      te = window.activeTextEditor;
    }
    if (te) {
      const uri = te.document.uri;
      if (uri.scheme === "file") {
        const repo = this.sourceControlManager.getRepository(uri);
        if (repo !== null) {
          // Wait for initial status to load before checking file version
          await repo.statusReady;

          // Skip unversioned/ignored/added files - they have no history
          const resource = repo.getResourceFromFile(uri);
          const { Status } = await import("../common/types");
          if (resource) {
            if (
              resource.type === Status.UNVERSIONED ||
              resource.type === Status.IGNORED ||
              resource.type === Status.ADDED
            ) {
              this._onDidChangeTreeData.fire(element);
              return;
            }
          } else {
            // Fallback: check if file is inside an unversioned/ignored folder
            const parentStatus = repo.isInsideUnversionedOrIgnored(uri.fsPath);
            if (
              parentStatus === Status.UNVERSIONED ||
              parentStatus === Status.IGNORED
            ) {
              this._onDidChangeTreeData.fire(element);
              return;
            }
          }
          // Clean versioned files have no resource but still have history
          try {
            // Clear low-level log cache on explicit refresh to force fresh SVN call
            if (explicitRefresh) {
              repo.clearLogCache();
            }
            const info = await repo.getInfo(uri.fsPath);
            this.currentItem = {
              isComplete: false,
              entries: [],
              revisionSet: new Set(),
              repo,
              svnTarget: Uri.parse(info.url),
              localPath: uri.fsPath,
              persisted: {
                commitFrom: "HEAD",
                baseRevision: parseInt(info.revision, 10)
              }
            };
            // Pre-load entries before firing tree change to prevent flash
            await fetchMore(this.currentItem);
          } catch (e) {
            // doesn't belong to this repo
          }
        }
      }
      this._onDidChangeTreeData.fire(element);
    }
  }

  public async getTreeItem(element: ILogTreeItem): Promise<TreeItem> {
    let ti: TreeItem;
    if (element.kind === LogTreeItemKind.Commit) {
      const commit = element.data;
      ti = new TreeItem(getCommitLabel(commit), TreeItemCollapsibleState.None);
      ti.description = getCommitDescription(commit);
      ti.iconPath = getCommitIcon(commit.author);
      ti.tooltip = getCommitToolTip(commit);
      ti.contextValue = "diffable";
      ti.command = {
        command: "sven.itemlog.openDiff",
        title: "Open diff",
        arguments: [element]
      };
      // Use resourceUri to trigger FileDecorationProvider for BASE badge
      if (element.isBase) {
        ti.resourceUri = Uri.parse(
          `svn-commit:r${commit.revision}?isBase=true`
        );
      }
    } else if (element.kind === LogTreeItemKind.TItem) {
      ti = element.data;
    } else {
      throw new Error("Shouldn't happen");
    }
    return ti;
  }

  public async getChildren(
    element: ILogTreeItem | undefined
  ): Promise<ILogTreeItem[]> {
    if (this.currentItem === undefined) {
      return [];
    }
    if (element === undefined) {
      const fname = path.basename(this.currentItem.svnTarget.fsPath);
      const ti = new TreeItem(fname, TreeItemCollapsibleState.Expanded);
      ti.tooltip = path.dirname(this.currentItem.svnTarget.fsPath);
      ti.description = path.dirname(this.currentItem.svnTarget.fsPath);
      ti.iconPath = new ThemeIcon("history");
      const item: ILogTreeItem = {
        kind: LogTreeItemKind.TItem,
        data: ti
      };
      return [item];
    } else {
      const entries = this.currentItem.entries;
      if (entries.length === 0) {
        await fetchMore(this.currentItem);
      }
      // Pass parent (the file root item) for getParent support
      const result = transform(entries, LogTreeItemKind.Commit, element);
      insertBaseMarker(this.currentItem, entries, result);
      if (!this.currentItem.isComplete) {
        result.push(
          createLoadMoreItem("sven.itemlog.refresh", [element, undefined, true])
        );
      }
      return result;
    }
  }

  public getParent(element: ILogTreeItem): ILogTreeItem | undefined {
    // Commits have parent set to the file root item
    return element.parent;
  }
}
