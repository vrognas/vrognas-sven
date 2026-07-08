// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import {
  CancellationToken,
  commands,
  Disposable,
  Event,
  EventEmitter,
  ProgressLocation,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  TreeView,
  ThemeIcon,
  Uri,
  window,
  workspace
} from "vscode";
import {
  ISparseItem,
  ISvnListItem,
  LockStatus,
  SparseDepthKey
} from "../../common/types";
import { checkoutDepthOptions } from "../../commands/setDepth";
import { readdir, stat } from "../../fs";
import { SourceControlManager } from "../../source_control_manager";
import { Repository } from "../../repository";
import BaseNode from "../nodes/baseNode";
import SparseItemNode from "../nodes/sparseItemNode";
import { SparseFileDecorationProvider } from "../sparseFileDecorationProvider";
import { dispose } from "../../util";
import { logError } from "../../util/errorLogger";
import { needsCleanupFromFullError } from "../../commands/errorDetectors";
import {
  formatBytes,
  formatDuration,
  parseSizeToBytes
} from "../../util/formatting";
import { pLimit } from "../../util/pLimit";
import { LRUCache } from "../../util/lruCache";
import { withCachedInFlight } from "../../util/withCachedInFlight";
import {
  createFileSizeMonitor,
  createFolderMonitor,
  FILE_POLL_INTERVAL_MS
} from "./downloadProgressMonitor";

/** Max concurrent svn info subprocess calls (prevents EMFILE / WC lock contention) */
const MAX_CONCURRENT_INFO = 5;

class RepositoryRootNode extends BaseNode {
  constructor(
    private repo: Repository,
    private provider: SparseCheckoutProvider
  ) {
    super();
  }

  public getTreeItem(): TreeItem {
    const repoName = path.basename(this.repo.root);
    const treeItem = new TreeItem(repoName, TreeItemCollapsibleState.Collapsed);
    treeItem.iconPath = new ThemeIcon("repo");
    return treeItem;
  }

  public async getChildren(): Promise<BaseNode[]> {
    const items = await this.provider.getItems(this.repo, this.repo.root);
    return items.map(
      item =>
        new SparseItemNode(
          item,
          this.repo.root,
          p => this.provider.getItems(this.repo, p),
          node => this.provider.triggerRefresh(node)
        )
    );
  }
}

/** Cache TTL in milliseconds (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Max cache entries before forced cleanup */
const MAX_CACHE_SIZE = 100;

/** Debounce delay for visual refresh (ms) - longer to avoid race with context menu */
const REFRESH_DEBOUNCE_MS = 500;

/** Default large file warning threshold in MB (configurable via svn.sparse.largeFileWarningMb) */
const DEFAULT_LARGE_FILE_WARNING_MB = 10;

/** Default download timeout in minutes (configurable via svn.sparse.downloadTimeoutMinutes) */
const DEFAULT_DOWNLOAD_TIMEOUT_MINUTES = 10;

/** Default download speed estimate (bytes/sec) - conservative 1 MB/s */
const DEFAULT_SPEED_BPS = 1 * 1024 * 1024;

/** Max speed samples to keep for averaging */
const MAX_SPEED_SAMPLES = 5;

/** Default pre-scan timeout in seconds (configurable via svn.sparse.preScanTimeoutSeconds) */
const DEFAULT_PRESCAN_TIMEOUT_SECONDS = 30;

export default class SparseCheckoutProvider
  implements TreeDataProvider<BaseNode>, Disposable
{
  private _onDidChangeTreeData = new EventEmitter<BaseNode | undefined>();
  private _disposables: Disposable[] = [];

  /** Server list cache: LRU-bounded TTL cache + in-flight dedup */
  private serverListCache = new LRUCache<ISvnListItem[]>(
    MAX_CACHE_SIZE,
    CACHE_TTL_MS
  );
  private serverListInFlight = new Map<string, Promise<ISvnListItem[]>>();

  /** Folder depth cache. Boxed: `undefined` depth is a legitimate cached
   *  value ("no wc depth info"), distinct from a cache miss. */
  private depthCache = new LRUCache<{ depth: SparseDepthKey | undefined }>(
    MAX_CACHE_SIZE,
    CACHE_TTL_MS
  );
  private depthInFlight = new Map<
    string,
    Promise<{ depth: SparseDepthKey | undefined }>
  >();

  /** Pending debounced refresh timeout */
  private refreshTimeout: ReturnType<typeof setTimeout> | undefined;

  /** Recent download speeds (bytes/sec) for ETA estimation */
  private speedSamples: number[] = [];

  public readonly onDidChangeTreeData: Event<BaseNode | undefined> =
    this._onDidChangeTreeData.event;

  /** Tree view instance for multi-select support */
  private treeView: TreeView<BaseNode> | undefined;

  constructor(private sourceControlManager: SourceControlManager) {
    // Use createTreeView for multi-select support
    this.treeView = window.createTreeView("sven.sparseCheckout", {
      treeDataProvider: this,
      canSelectMany: true
    });

    this._disposables.push(
      this.treeView,
      new SparseFileDecorationProvider(),
      commands.registerCommand("sven.sparse.refresh", () => this.refresh()),
      commands.registerCommand(
        "sven.sparse.checkout",
        (node: SparseItemNode, selected?: SparseItemNode[]) =>
          this.checkoutItems(
            selected && selected.length > 0 ? selected : [node]
          )
      ),
      commands.registerCommand(
        "sven.sparse.exclude",
        (node: SparseItemNode, selected?: SparseItemNode[]) =>
          this.excludeItems(selected && selected.length > 0 ? selected : [node])
      ),
      // Fix: Refresh when repositories are opened/closed (startup timing issue)
      // SourceControlManager discovers repos asynchronously after providers are created,
      // so we must listen for repo open/close events to update tree data
      this.sourceControlManager.onDidOpenRepository(() => {
        this.triggerRefresh();
      }),
      this.sourceControlManager.onDidCloseRepository(() => {
        this.triggerRefresh();
      })
    );
  }

  public refresh(): void {
    // Clear caches on manual refresh
    this.serverListCache.clear();
    this.serverListInFlight.clear();
    this.depthCache.clear();
    this.depthInFlight.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Trigger tree refresh without clearing caches (for visual updates) */
  public triggerRefresh(node?: BaseNode): void {
    // Targeted refresh: immediate, no debounce needed
    if (node) {
      this._onDidChangeTreeData.fire(node);
      return;
    }

    // Full refresh: debounce to avoid multiple rapid refreshes
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    this.refreshTimeout = setTimeout(() => {
      this.refreshTimeout = undefined;
      this._onDidChangeTreeData.fire(undefined);
    }, REFRESH_DEBOUNCE_MS);
  }

  public getTreeItem(element: BaseNode): TreeItem | Promise<TreeItem> {
    return element.getTreeItem();
  }

  public async getChildren(element?: BaseNode): Promise<BaseNode[]> {
    if (!this.sourceControlManager.openRepositories.length) {
      return [];
    }

    if (element) {
      return element.getChildren();
    }

    // Root: show one node per repository
    return this.sourceControlManager.openRepositories.map(
      openRepo => new RepositoryRootNode(openRepo.repository, this)
    );
  }

  /**
   * Get items for a folder: only server items, marked as local or ghost.
   * Untracked local items (like .vscode, .idea, .claude) are excluded when server is available.
   */
  public async getItems(
    repo: Repository,
    folderPath: string
  ): Promise<ISparseItem[]> {
    const relativeFolder = path.relative(repo.root, folderPath);

    // Fetch local items and server items in parallel
    const [localItemsRaw, serverResult] = await Promise.all([
      this.getLocalItemsRaw(repo, folderPath),
      this.getServerItems(repo, folderPath).catch(err => {
        // Server list failed (offline, etc.) - log and continue
        logError("Failed to fetch server items for sparse view", err);
        return null;
      })
    ]);

    // If server fetch failed, fall back to showing local items (no filtering)
    // Don't try to get depth for potentially untracked items
    if (!serverResult) {
      return this.mergeItems(localItemsRaw, []);
    }

    // Filter local items to only those on server (exclude untracked like .vscode, .claude)
    const trackedLocalItems = this.filterToTrackedItems(
      localItemsRaw,
      serverResult
    );

    // NOW get depth for tracked directories only (safe - they exist in SVN)
    await this.populateDepths(repo, trackedLocalItems);

    // Add lock status from repository status (fast, uses existing data)
    this.populateLockStatus(repo, trackedLocalItems);

    // Fetch local revisions for outdated detection
    await this.populateLocalRevisions(repo, trackedLocalItems);

    // Always compute ghosts - even with infinity depth, individual items may be excluded
    const ghosts = this.computeGhosts(
      trackedLocalItems,
      serverResult,
      relativeFolder
    );

    // Fetch lock status for ghost files (batch SVN info call)
    await this.populateGhostLockStatus(repo, ghosts);

    return this.mergeItems(trackedLocalItems, ghosts);
  }

  /**
   * Filter local filesystem items to only include tracked items (on server).
   * This excludes untracked items like .vscode, .idea, node_modules, etc.
   * Uses case-insensitive comparison for Windows/macOS compatibility.
   */
  private filterToTrackedItems(
    localItems: ISparseItem[],
    serverItems: ISvnListItem[]
  ): ISparseItem[] {
    // Build lookup for server metadata (case-insensitive)
    const serverByName = new Map<string, ISvnListItem>();
    for (const s of serverItems) {
      serverByName.set(s.name.toLowerCase(), s);
    }

    // Single pass: filter + enrich (avoid 2× toLowerCase per item)
    const result: ISparseItem[] = [];
    for (const item of localItems) {
      const lowerName = item.name.toLowerCase();
      const serverData = serverByName.get(lowerName);
      if (!serverData) continue;

      if (serverData.commit) {
        result.push({
          ...item,
          revision: serverData.commit.revision,
          author: serverData.commit.author,
          date: serverData.commit.date,
          size: serverData.size
        });
      } else {
        result.push(item);
      }
    }
    return result;
  }

  /**
   * Get local items WITHOUT fetching depth (fast, pure filesystem)
   * Depth is populated later only for tracked items to avoid svn info on untracked folders
   */
  private async getLocalItemsRaw(
    repo: Repository,
    folderPath: string
  ): Promise<ISparseItem[]> {
    const items: ISparseItem[] = [];

    try {
      const entries = await readdir(folderPath);
      for (const name of entries) {
        if (name === ".svn") continue;

        const fullPath = path.join(folderPath, name);
        const relativePath = path.relative(repo.root, fullPath);

        try {
          const stats = await stat(fullPath);
          const kind = stats.isDirectory() ? "dir" : "file";

          items.push({
            name,
            path: relativePath,
            kind,
            depth: undefined,
            isGhost: false
          });
        } catch {
          // stat failed, skip
        }
      }
    } catch {
      // readdir failed
    }

    return items;
  }

  /**
   * Populate depth for tracked directory items only.
   * Called AFTER filtering to tracked items to avoid svn info on untracked folders.
   */
  private async populateDepths(
    repo: Repository,
    items: ISparseItem[]
  ): Promise<void> {
    const dirItems = items.filter(i => i.kind === "dir");
    if (dirItems.length === 0) return;

    const depths = await pLimit(
      dirItems.map(
        d => () => this.getDepth(repo, path.join(repo.root, d.path))
      ),
      MAX_CONCURRENT_INFO
    );

    dirItems.forEach((item, i) => {
      item.depth = depths[i];
    });
  }

  /**
   * Enrich local items with lock status from repository status.
   * Only items that appear in SCM status will have lock info.
   */
  private populateLockStatus(repo: Repository, items: ISparseItem[]): void {
    for (const item of items) {
      if (item.isGhost) continue; // Ghosts don't have local lock status

      const fullPath = path.join(repo.root, item.path);
      const resource = repo.getResourceFromFile(fullPath);
      if (resource?.lockStatus) {
        item.lockStatus = resource.lockStatus;
        item.lockOwner = resource.lockOwner;
        // Note: lockComment not available from status, would need svn info
      }
    }
  }

  /**
   * Populate local revision for tracked items (non-ghost).
   * Used to detect outdated files (localRevision < serverRevision).
   */
  private async populateLocalRevisions(
    repo: Repository,
    items: ISparseItem[]
  ): Promise<void> {
    const localItems = items.filter(i => !i.isGhost);
    if (localItems.length === 0) return;

    // Batch fetch info with bounded concurrency (prevents EMFILE / WC lock contention)
    const infos = await pLimit(
      localItems.map(item => async () => {
        try {
          const fullPath = path.join(repo.root, item.path);
          const info = await repo.getInfo(fullPath);
          return info.commit?.revision;
        } catch {
          return undefined;
        }
      }),
      MAX_CONCURRENT_INFO
    );

    // Apply local revisions
    localItems.forEach((item, i) => {
      item.localRevision = infos[i];
    });
  }

  /**
   * Fetch lock status for ghost files via batch svn info.
   * Only fetches for files (directories don't have locks).
   */
  private async populateGhostLockStatus(
    repo: Repository,
    ghosts: ISparseItem[]
  ): Promise<void> {
    // Filter to ghost files only (dirs don't have locks)
    const ghostFiles = ghosts.filter(g => g.isGhost && g.kind === "file");
    if (ghostFiles.length === 0) return;

    try {
      // Get repo URL from info
      const info = await repo.getInfo(repo.root);
      const baseUrl = info.url;
      if (!baseUrl) return;

      // For subfolder checkouts, detect potential path overlap
      // info.url is checkout URL, info.repository.root is repo root
      // The checkout subfolder is the difference between them
      let checkoutSubfolder = "";
      if (info.repository?.root && baseUrl.startsWith(info.repository.root)) {
        checkoutSubfolder = baseUrl
          .slice(info.repository.root.length)
          .replace(/^\//, ""); // Remove leading slash
      }

      // Build URLs for each ghost file
      const urls = ghostFiles.map(g => {
        // Convert Windows backslashes to forward slashes
        let urlPath = g.path.replace(/\\/g, "/");

        // Fix: If ghost path starts with checkout subfolder, strip it
        // This can happen due to path confusion in subfolder checkouts
        if (checkoutSubfolder && urlPath.startsWith(checkoutSubfolder + "/")) {
          urlPath = urlPath.slice(checkoutSubfolder.length + 1);
        } else if (checkoutSubfolder && urlPath === checkoutSubfolder) {
          urlPath = "";
        }

        return urlPath ? `${baseUrl}/${urlPath}` : baseUrl;
      });

      // Batch fetch lock info
      const lockInfoMap = await repo.getBatchLockInfo(urls);

      // Get current username to determine K vs O status
      const currentUser = repo.username;

      // Apply lock info to ghost items
      for (let i = 0; i < ghostFiles.length; i++) {
        const url = urls[i]!;
        const lockInfo = lockInfoMap.get(url);
        if (lockInfo) {
          ghostFiles[i]!.lockOwner = lockInfo.owner;
          ghostFiles[i]!.lockComment = lockInfo.comment;
          // K if locked by current user, O if locked by others
          ghostFiles[i]!.lockStatus =
            currentUser && lockInfo.owner === currentUser
              ? LockStatus.K
              : LockStatus.O;
        }
      }
    } catch (err) {
      // Lock fetch failed - not critical, just log
      logError("Failed to fetch ghost lock status", err);
    }
  }

  private async getDepth(
    repo: Repository,
    folderPath: string
  ): Promise<SparseDepthKey | undefined> {
    // Include repo root in cache key for multi-repo safety
    const cacheKey = `${repo.root}:${folderPath}`;
    try {
      const boxed = await withCachedInFlight(
        cacheKey,
        this.depthCache,
        this.depthInFlight,
        async () => ({
          depth: (await repo.getInfo(folderPath)).wcInfo?.depth as
            | SparseDepthKey
            | undefined
        })
      );
      return boxed.depth;
    } catch {
      // Errors are NOT cached (withCachedInFlight caches success only),
      // preserving retry on the next call
      return undefined;
    }
  }

  private async getServerItems(
    repo: Repository,
    folderPath: string
  ): Promise<ISvnListItem[]> {
    const cacheKey = `${repo.root}:${folderPath}`;
    // LRU-bounded TTL cache + in-flight dedup: concurrent expansions of the
    // same folder share one `svn list`; errors propagate uncached
    return withCachedInFlight(
      cacheKey,
      this.serverListCache,
      this.serverListInFlight,
      () => repo.list(folderPath)
    );
  }

  private computeGhosts(
    localItems: ISparseItem[],
    serverItems: ISvnListItem[],
    relativeFolder: string
  ): ISparseItem[] {
    // Case-insensitive Set for Windows/macOS compatibility
    const localNamesLower = new Set(localItems.map(i => i.name.toLowerCase()));
    return (
      serverItems
        .filter(s => !localNamesLower.has(s.name.toLowerCase()))
        // Reject path traversal from malicious server responses
        .filter(
          s =>
            !s.name.includes("/") &&
            !s.name.includes("\\") &&
            s.name !== ".." &&
            s.name !== "."
        )
        .map(s => ({
          name: s.name,
          path: relativeFolder ? path.join(relativeFolder, s.name) : s.name,
          kind: (s.kind === "dir" ? "dir" : "file") as "file" | "dir",
          isGhost: true,
          // Include commit metadata from server
          revision: s.commit?.revision,
          author: s.commit?.author,
          date: s.commit?.date,
          size: s.size
        }))
    );
  }

  /** Get file extension (lowercase, without dot) */
  private getExtension(name: string): string {
    const lastDot = name.lastIndexOf(".");
    if (lastDot === -1 || lastDot === 0) return "";
    return name.slice(lastDot + 1).toLowerCase();
  }

  private mergeItems(
    local: ISparseItem[],
    ghosts: ISparseItem[]
  ): ISparseItem[] {
    const items = [...local, ...ghosts];

    // Pre-compute extensions once O(n) instead of O(n log n) in comparator
    const extensions = new Map<ISparseItem, string>();
    for (const item of items) {
      if (item.kind === "file") {
        extensions.set(item, this.getExtension(item.name));
      }
    }

    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base"
    });
    return items.sort((a, b) => {
      // Dirs first
      if (a.kind !== b.kind) {
        return a.kind === "dir" ? -1 : 1;
      }
      // For files: sort by extension, then natural sort
      if (a.kind === "file") {
        const extA = extensions.get(a) ?? "";
        const extB = extensions.get(b) ?? "";
        if (extA !== extB) {
          return collator.compare(extA, extB);
        }
      }
      // Within same kind/extension: natural sort
      return collator.compare(a.name, b.name);
    });
  }

  /**
   * Download items from server (sparse checkout)
   * - Shows progress with cancellation support
   * - Warns about large files (configurable threshold)
   */
  private async checkoutItems(nodes: SparseItemNode[]): Promise<void> {
    // Filter valid nodes and pre-fetch repositories (single lookup per node)
    const validNodes = nodes.filter(n => n?.fullPath);
    if (validNodes.length === 0) {
      window.showErrorMessage("No valid items selected. Please try again.");
      return;
    }

    // Pre-fetch all repositories once (O(n) instead of O(2n))
    const nodeRepos = validNodes.map(n => ({
      node: n,
      repo: this.sourceControlManager.getRepository(Uri.file(n.fullPath))
    }));

    // Validate all nodes have repositories
    const invalidCount = nodeRepos.filter(nr => !nr.repo).length;
    if (invalidCount === validNodes.length) {
      window.showErrorMessage("No SVN repository found for selected items");
      return;
    }

    // Get configurable threshold for large file warning
    const thresholdMb = workspace
      .getConfiguration("sven.sparse")
      .get<number>("largeFileWarningMb", DEFAULT_LARGE_FILE_WARNING_MB);
    const thresholdBytes = thresholdMb * 1024 * 1024;

    // Get configurable timeout for downloads (in minutes, convert to ms)
    const timeoutMinutes = workspace
      .getConfiguration("sven.sparse")
      .get<number>("downloadTimeoutMinutes", DEFAULT_DOWNLOAD_TIMEOUT_MINUTES);
    const downloadTimeoutMs = timeoutMinutes * 60 * 1000;

    // Build file size map for O(1) lookups (fixes basename collision + O(n²))
    const fileSizeMap = this.getFileSizeMap(validNodes);

    // Calculate total size from map values
    let totalSize = 0;
    for (const size of fileSizeMap.values()) {
      totalSize += size;
    }

    // Check for large files and warn user (if threshold > 0)
    if (thresholdMb > 0) {
      // Filter large files from map
      const largeFiles: { name: string; size: number }[] = [];
      for (const [fullPath, size] of fileSizeMap) {
        if (size > thresholdBytes) {
          largeFiles.push({ name: path.basename(fullPath), size });
        }
      }
      if (largeFiles.length > 0) {
        const largeTotal = largeFiles.reduce((sum, f) => sum + f.size, 0);
        // Show up to 5 large files for better visibility
        const fileList = largeFiles
          .slice(0, 5)
          .map(f => `• ${f.name} (${formatBytes(f.size)})`)
          .join("\n");
        const more =
          largeFiles.length > 5
            ? `\n... and ${largeFiles.length - 5} more`
            : "";

        // Lead with total download size (most important info first)
        const totalLabel =
          totalSize > largeTotal
            ? `Total download: ${formatBytes(totalSize)}\n\n`
            : "";

        const proceed = await window.showWarningMessage(
          `Download ${formatBytes(largeTotal)} of large files?\n\n` +
            `${totalLabel}` +
            `Large files (>${thresholdMb} MB):\n${fileList}${more}`,
          { modal: true },
          "Download"
        );

        if (proceed !== "Download") return;
      }
    }

    // Determine if we need to ask for depth (any dirs selected?)
    const hasDirs = validNodes.some(n => n.kind === "dir");
    let depth: SparseDepthKey = "infinity";

    if (hasDirs) {
      const selected = await window.showQuickPick(checkoutDepthOptions, {
        placeHolder:
          validNodes.length > 1
            ? `How much should be downloaded? (${validNodes.length} items)`
            : "How much should be downloaded?"
      });

      if (!selected) return;
      depth = selected.depth;
    }

    const label =
      validNodes.length === 1
        ? `"${path.basename(validNodes[0]!.fullPath)}"`
        : `${validNodes.length} items`;

    // Include size and ETA estimate in title if known
    const avgSpeed = this.getAverageSpeed();
    const etaSeconds = totalSize > 0 ? totalSize / avgSpeed : 0;
    const etaLabel =
      totalSize > 0 && etaSeconds > 5 ? ` ~${formatDuration(etaSeconds)}` : "";
    const sizeLabel =
      totalSize > 0 ? ` (${formatBytes(totalSize)}${etaLabel})` : "";

    // Track start time for speed calculation
    const startTime = Date.now();

    // Collect unique repos for status suppression (prevents WC lock conflicts)
    const affectedRepos = new Set(
      nodeRepos
        .map(nr => nr.repo)
        .filter((r): r is Repository => r !== undefined)
    );

    // Suppress status updates during download (fixes svn info spam on Windows)
    for (const repo of affectedRepos) {
      repo.beginSparseDownload();
    }

    try {
      // Use notification for cancellation support
      const isBatch = validNodes.length > 1;

      const result = await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Downloading ${label}${sizeLabel}`,
          cancellable: true
        },
        async (progress, token: CancellationToken) => {
          // Immediate feedback that download is starting
          progress.report({ message: "Starting download..." });

          let success = 0;
          let failed = 0;
          let cancelled = false;
          let bytesDownloaded = 0;

          // Active monitors for cleanup on cancellation
          let activeFileMonitor:
            | ReturnType<typeof createFileSizeMonitor>
            | undefined;
          let activeFolderMonitor:
            | ReturnType<typeof createFolderMonitor>
            | undefined;
          let activeInterval: ReturnType<typeof setInterval> | undefined;

          /** Cleanup current monitors and interval */
          const cleanup = () => {
            activeFileMonitor?.stop();
            activeFileMonitor = undefined;
            activeFolderMonitor?.stop();
            activeFolderMonitor = undefined;
            if (activeInterval) {
              clearInterval(activeInterval);
              activeInterval = undefined;
            }
          };

          for (let i = 0; i < nodeRepos.length; i++) {
            // Check cancellation before each item
            if (token.isCancellationRequested) {
              cleanup(); // Memory leak fix: cleanup on cancel
              cancelled = true;
              break;
            }

            const { node, repo } = nodeRepos[i]!;
            if (!repo) {
              failed++;
              continue;
            }

            // Calculate dynamic ETA based on current progress
            const elapsed = (Date.now() - startTime) / 1000;
            const currentSpeed =
              elapsed > 0 && bytesDownloaded > 0
                ? bytesDownloaded / elapsed
                : avgSpeed;
            const remainingBytes = totalSize - bytesDownloaded;
            const etaRemaining =
              remainingBytes > 0 && currentSpeed > 0
                ? remainingBytes / currentSpeed
                : 0;
            const etaText =
              etaRemaining > 3 ? ` ~${formatDuration(etaRemaining)} left` : "";

            progress.report({
              message: isBatch
                ? `(${i + 1}/${nodeRepos.length}) ${path.basename(node.fullPath)}${etaText}`
                : `${path.basename(node.fullPath)}${etaText}`,
              increment: 100 / nodeRepos.length
            });

            // Get file size using fullPath key (fixes basename collision)
            const expectedSize = fileSizeMap.get(node.fullPath) ?? 0;

            // For folders with infinity depth: pre-scan for file count and size
            let expectedFileCount = 0;
            let expectedFolderSize = 0;
            if (node.kind === "dir" && depth === "infinity") {
              // Check cancellation BEFORE pre-scan (can be slow for large folders)
              if (token.isCancellationRequested) {
                cleanup();
                cancelled = true;
                break;
              }

              // Get configurable pre-scan timeout
              const preScanTimeoutSeconds = workspace
                .getConfiguration("sven.sparse")
                .get<number>(
                  "preScanTimeoutSeconds",
                  DEFAULT_PRESCAN_TIMEOUT_SECONDS
                );
              const preScanTimeoutMs = preScanTimeoutSeconds * 1000;

              // Show scanning progress (user feedback that something is happening)
              const folderName = path.basename(node.fullPath);
              progress.report({
                message: `Scanning ${folderName}...`
              });

              try {
                // Pre-scan folder to get expected file count and total size
                const folderContents = await repo.listRecursive(
                  node.fullPath,
                  preScanTimeoutMs
                );
                const files = folderContents.filter(f => f.kind === "file");
                expectedFileCount = files.length;
                expectedFolderSize = files.reduce(
                  (sum: number, f: ISvnListItem) =>
                    sum + parseInt(f.size ?? "0", 10),
                  0
                );

                // Show file count and size found
                progress.report({
                  message: `Found ${expectedFileCount} files (${formatBytes(expectedFolderSize)}) in ${folderName}`
                });
              } catch (err) {
                // Pre-scan failed - log error, continue without progress tracking
                logError("Pre-scan failed for folder progress", err);
              }

              // Check cancellation AFTER pre-scan (user may have cancelled during scan)
              if (token.isCancellationRequested) {
                cleanup();
                cancelled = true;
                break;
              }
            }

            // Start appropriate monitor based on item type
            if (node.kind === "file" && expectedSize > 1024 * 1024) {
              // File monitor for large files (>1MB)
              activeFileMonitor = createFileSizeMonitor(node.fullPath);
            } else if (node.kind === "dir" && expectedFolderSize > 0) {
              // Folder monitor only if we have size to track (skip empty folders)
              activeFolderMonitor = createFolderMonitor(
                node.fullPath,
                expectedFolderSize,
                expectedFileCount
              );
            }

            // Progress update interval during download
            // Clear any existing interval before creating new one (prevents leak)
            if (activeInterval) {
              clearInterval(activeInterval);
              activeInterval = undefined;
            }
            if (activeFileMonitor && expectedSize > 0) {
              const monitor = activeFileMonitor; // Capture for closure
              activeInterval = setInterval(() => {
                if (monitor.isStopped()) return;
                const realSpeed = monitor.getSpeed();
                const downloaded = Math.min(monitor.getSize(), expectedSize);
                if (realSpeed > 0) {
                  const remaining = expectedSize - downloaded;
                  const eta = remaining > 0 ? remaining / realSpeed : 0;
                  const speedLabel = `${formatBytes(realSpeed)}/s`;
                  const etaLabel = eta > 2 ? ` ~${formatDuration(eta)}` : "";
                  progress.report({
                    message: `${path.basename(node.fullPath)} ${speedLabel}${etaLabel}`
                  });
                }
              }, FILE_POLL_INTERVAL_MS);
            } else if (activeFolderMonitor && expectedFolderSize > 0) {
              const monitor = activeFolderMonitor; // Capture for closure
              const folderName = path.basename(node.fullPath);
              activeInterval = setInterval(() => {
                if (monitor.isStopped()) return;
                const currentSize = monitor.getSize();
                const pct = Math.round(monitor.getProgress() * 100);
                const speed = monitor.getSpeed();
                // Speed and ETA label
                let speedEtaLabel = "";
                if (speed > 0) {
                  speedEtaLabel = ` ${formatBytes(speed)}/s`;
                  const remaining = expectedFolderSize - currentSize;
                  if (remaining > 0) {
                    const eta = remaining / speed;
                    if (eta > 2) speedEtaLabel += ` ~${formatDuration(eta)}`;
                  }
                }
                progress.report({
                  message: `${folderName}: ${formatBytes(currentSize)}/${formatBytes(expectedFolderSize)} (${pct}%)${speedEtaLabel}`
                });
              }, FILE_POLL_INTERVAL_MS);
            }

            try {
              // Show that actual download is starting (after pre-scan)
              const itemName = path.basename(node.fullPath);
              if (node.kind === "dir" && expectedFolderSize > 0) {
                progress.report({
                  message: `Downloading ${itemName} (${formatBytes(expectedFolderSize)})...`
                });
              } else {
                progress.report({
                  message: `Downloading ${itemName}...`
                });
              }

              const res = await repo.setDepth(node.fullPath, depth, {
                parents: true,
                timeout: downloadTimeoutMs
              });

              cleanup();

              if (res.exitCode === 0) {
                success++;
                // Track bytes from file size or folder size (for ETA)
                bytesDownloaded +=
                  node.kind === "dir" ? expectedFolderSize : expectedSize;
              } else {
                failed++;
              }
            } catch {
              cleanup();
              failed++;
            }
          }

          return { success, failed, cancelled, bytesDownloaded };
        }
      );

      // Track download speed for future ETA estimates (only if we had size data)
      if (totalSize > 0 && result.success > 0 && !result.cancelled) {
        const elapsedMs = Date.now() - startTime;
        if (elapsedMs > 1000) {
          // Only track if >1s to avoid noise
          const speed = totalSize / (elapsedMs / 1000);
          this.recordDownloadSpeed(speed);
        }
      }

      this.refresh();

      // Show appropriate message based on outcome
      const totalItems = nodeRepos.length;
      const remaining = totalItems - result.success - result.failed;
      if (result.cancelled) {
        window.showInformationMessage(
          `Download cancelled. ${result.success} of ${totalItems} completed, ${remaining} not downloaded.`
        );
      } else if (result.failed > 0) {
        window
          .showWarningMessage(
            `Download completed with errors: ${result.success} succeeded, ${result.failed} failed`,
            "Show Output"
          )
          .then(choice => {
            if (choice === "Show Output") {
              commands.executeCommand("sven.showOutputChannel");
            }
          });
      } else if (result.success > 0) {
        // Success notification - users need positive feedback
        const sizeInfo = totalSize > 0 ? ` (${formatBytes(totalSize)})` : "";
        window.showInformationMessage(
          `Downloaded ${result.success} ${result.success === 1 ? "item" : "items"}${sizeInfo}`
        );
      }
    } catch (err) {
      logError("Sparse checkout failed", err);
      const errStr = String(err);
      if (needsCleanupFromFullError(errStr)) {
        window
          .showErrorMessage(
            "Working copy is locked. Run cleanup to fix.",
            "Run Cleanup"
          )
          .then(choice => {
            if (choice === "Run Cleanup") {
              commands.executeCommand("sven.cleanup");
            }
          });
      } else {
        window
          .showErrorMessage(`Download failed: ${err}`, "Show Output")
          .then(choice => {
            if (choice === "Show Output") {
              commands.executeCommand("sven.showOutputChannel");
            }
          });
      }
    } finally {
      // Re-enable status updates after download completes
      for (const repo of affectedRepos) {
        repo.endSparseDownload();
      }
    }
  }

  /**
   * Get file sizes for ghost files (server-only items with known size)
   * Returns Map<fullPath, size> for O(1) lookup (fixes O(n²) in download loop)
   */
  private getFileSizeMap(nodes: SparseItemNode[]): Map<string, number> {
    const sizeMap = new Map<string, number>();
    for (const n of nodes) {
      if (n.kind === "file" && n.isGhost) {
        const size = parseSizeToBytes(n.size);
        if (size > 0) {
          sizeMap.set(n.fullPath, size);
        }
      }
    }
    return sizeMap;
  }

  /**
   * Get average download speed from recent samples (bytes/sec)
   */
  private getAverageSpeed(): number {
    if (this.speedSamples.length === 0) {
      return DEFAULT_SPEED_BPS;
    }
    const sum = this.speedSamples.reduce((a, b) => a + b, 0);
    return sum / this.speedSamples.length;
  }

  /**
   * Record a download speed sample for future ETA estimates
   */
  private recordDownloadSpeed(bytesPerSec: number): void {
    this.speedSamples.push(bytesPerSec);
    // Keep only recent samples
    if (this.speedSamples.length > MAX_SPEED_SAMPLES) {
      this.speedSamples.shift();
    }
  }

  /**
   * Find uncommitted changes and unversioned files under the given nodes.
   * Returns list of relative paths that would be lost on exclude.
   */
  private getUnsafeItems(nodes: SparseItemNode[]): string[] {
    const unsafe: string[] = [];
    for (const node of nodes) {
      const repo = this.sourceControlManager.getRepository(
        Uri.file(node.fullPath)
      );
      if (!repo) continue;

      const root = repo.workspaceRoot;
      const prefix = node.fullPath.replace(/\\/g, "/").toLowerCase();

      // Check tracked changes (modified, added, conflicted, etc.)
      for (const r of repo.changes.resourceStates) {
        const fp = r.resourceUri.fsPath.replace(/\\/g, "/").toLowerCase();
        if (fp.startsWith(prefix + "/") || fp === prefix) {
          unsafe.push(path.relative(root, r.resourceUri.fsPath));
        }
      }

      // Check unversioned files (would be silently deleted by SVN)
      for (const r of repo.unversioned.resourceStates) {
        const fp = r.resourceUri.fsPath.replace(/\\/g, "/").toLowerCase();
        if (fp.startsWith(prefix + "/") || fp === prefix) {
          unsafe.push(path.relative(root, r.resourceUri.fsPath));
        }
      }
    }
    return unsafe;
  }

  /**
   * Exclude multiple items (remove from working copy)
   */
  private async excludeItems(nodes: SparseItemNode[]): Promise<void> {
    // Filter valid nodes
    const validNodes = nodes.filter(n => n?.fullPath);
    if (validNodes.length === 0) {
      window.showErrorMessage("No valid items selected. Please try again.");
      return;
    }

    // Build label for messages
    const label =
      validNodes.length === 1
        ? `"${path.basename(validNodes[0]!.fullPath)}"`
        : `${validNodes.length} items`;

    // Check for uncommitted changes or unversioned files under target paths
    const unsafeItems = this.getUnsafeItems(validNodes);
    if (unsafeItems.length > 0) {
      const fileList = unsafeItems.slice(0, 5).join("\n");
      const more =
        unsafeItems.length > 5 ? `\n...and ${unsafeItems.length - 5} more` : "";
      const choice = await window.showWarningMessage(
        `${unsafeItems.length} uncommitted/unversioned file(s) will be lost:\n\n${fileList}${more}\n\nCommit or move them first, or proceed to discard.`,
        { modal: true },
        "Exclude Anyway"
      );
      if (choice !== "Exclude Anyway") return;
    }

    // Check if confirmation is enabled (skip if user already confirmed unsafe dialog)
    const confirmEnabled =
      unsafeItems.length === 0 &&
      workspace
        .getConfiguration("sven.sparse")
        .get<boolean>("confirmExclude", true);

    if (confirmEnabled) {
      const confirm = await window.showWarningMessage(
        `Exclude ${label} from download? Local copy will be removed. Files are kept on server.`,
        { modal: true },
        "Exclude",
        "Don't Ask Again"
      );

      if (!confirm) return;

      // If user chose "Don't Ask Again", disable the setting
      if (confirm === "Don't Ask Again") {
        await workspace
          .getConfiguration("sven.sparse")
          .update("confirmExclude", false, true);
      }
    }

    // Build repo map for status suppression
    const repoMap = new Map<string, Repository>();
    for (const node of validNodes) {
      const repo = this.sourceControlManager.getRepository(
        Uri.file(node.fullPath)
      );
      if (repo) {
        repoMap.set(node.fullPath, repo);
      }
    }

    // Suppress status updates during exclude (prevents WC lock conflicts)
    const affectedRepos = new Set(repoMap.values());
    for (const repo of affectedRepos) {
      repo.beginSparseDownload();
    }

    try {
      // Use status bar for single items, notification for batches
      const isBatch = validNodes.length > 1;

      const result = await window.withProgress(
        {
          location: isBatch
            ? ProgressLocation.Notification
            : ProgressLocation.Window,
          title: `Excluding ${label}...`,
          cancellable: false
        },
        async progress => {
          let success = 0;
          let failed = 0;

          for (let i = 0; i < validNodes.length; i++) {
            const node = validNodes[i]!;
            const repo = repoMap.get(node.fullPath);
            if (!repo) {
              failed++;
              continue;
            }

            if (isBatch) {
              progress.report({
                message: `(${i + 1}/${validNodes.length}) ${path.basename(node.fullPath)}`,
                increment: 100 / validNodes.length
              });
            }

            try {
              const res = await repo.setDepth(node.fullPath, "exclude");
              if (res.exitCode === 0) {
                success++;
              } else {
                failed++;
              }
            } catch {
              failed++;
            }
          }

          return { success, failed };
        }
      );

      this.refresh();

      if (result.failed > 0) {
        window.showWarningMessage(
          `Exclude: ${result.success} succeeded, ${result.failed} failed`
        );
      }
    } catch (err) {
      logError("Sparse exclude failed", err);
      const errStr = String(err);
      if (needsCleanupFromFullError(errStr)) {
        window
          .showErrorMessage(
            "Working copy is locked. Run cleanup to fix.",
            "Run Cleanup"
          )
          .then(choice => {
            if (choice === "Run Cleanup") {
              commands.executeCommand("sven.cleanup");
            }
          });
      } else {
        window
          .showErrorMessage(`Exclude failed: ${err}`, "Show Output")
          .then(choice => {
            if (choice === "Show Output") {
              commands.executeCommand("sven.showOutputChannel");
            }
          });
      }
    } finally {
      // Re-enable status updates after exclude completes
      for (const repo of affectedRepos) {
        repo.endSparseDownload();
      }
    }
  }

  public dispose(): void {
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    dispose(this._disposables);
  }
}
