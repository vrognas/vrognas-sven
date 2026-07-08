// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import {
  FileSystemProvider,
  workspace,
  Disposable,
  FileStat,
  Uri,
  FileSystemError,
  FileType,
  FileChangeEvent,
  EventEmitter,
  Event,
  window,
  FileChangeType
} from "vscode";
import { SourceControlManager } from "./source_control_manager";
import { fromSvnUri } from "./uri";
import { SvnUriAction, RepositoryChangeEvent, Status } from "./common/types";
import { debounce, throttle } from "./decorators";
import {
  filterEvent,
  eventToPromise,
  isDescendant,
  pathEquals,
  EmptyDisposable
} from "./util";
import { getErrorMessage, logError, logWarning } from "./util/errorLogger";

const ONE_MINUTE = 1000 * 60;
const THREE_MINUTES = 1000 * 60 * 3;
const FIVE_MINUTES = 1000 * 60 * 5;

interface CacheRow {
  uri: Uri;
  timestamp: number;
}

interface StatCacheRow {
  result: FileStat;
  timestamp: number;
  fsPath: string; // For invalidation by repository root
}

export class SvnFileSystemProvider implements FileSystemProvider, Disposable {
  private disposables: Disposable[] = [];
  private cache = new Map<string, CacheRow>();
  private cleanupInterval?: ReturnType<typeof setInterval>;

  // Stat result cache - reduces redundant svn list calls
  private statCache = new Map<string, StatCacheRow>();
  // Pending stat requests - dedupes concurrent calls for same URI
  private pendingStats = new Map<string, Promise<FileStat>>();

  private _onDidChangeFile = new EventEmitter<FileChangeEvent[]>();
  readonly onDidChangeFile: Event<FileChangeEvent[]> =
    this._onDidChangeFile.event;

  private changedRepositoryRoots = new Set<string>();

  constructor(private sourceControlManager: SourceControlManager) {
    this.disposables.push(
      sourceControlManager.onDidChangeRepository(
        this.onDidChangeRepository,
        this
      )
    );

    try {
      this.disposables.push(
        workspace.registerFileSystemProvider("svn", this, {
          isReadonly: true,
          isCaseSensitive: true
        })
      );
    } catch (err) {
      // Handle Positron double activation - first registration wins, second is no-op
      logWarning(
        "SvnFileSystemProvider already registered",
        (err as Error).message
      );
    }

    this.cleanupInterval = setInterval(() => this.cleanup(), FIVE_MINUTES);
  }

  private onDidChangeRepository({ repository }: RepositoryChangeEvent): void {
    this.changedRepositoryRoots.add(repository.root);
    this.eventuallyFireChangeEvents();

    // Invalidate stat cache for files in this repository
    for (const [key, row] of this.statCache) {
      if (isDescendant(repository.root, row.fsPath)) {
        this.statCache.delete(key);
      }
    }
  }

  @debounce(1100)
  private eventuallyFireChangeEvents(): void {
    void this.fireChangeEvents();
  }

  @throttle
  private async fireChangeEvents(): Promise<void> {
    if (!window.state.focused) {
      const onDidFocusWindow = filterEvent(
        window.onDidChangeWindowState,
        e => e.focused
      );
      await eventToPromise(onDidFocusWindow);
    }

    const events: FileChangeEvent[] = [];

    for (const { uri } of this.cache.values()) {
      const fsPath = uri.fsPath;

      for (const root of this.changedRepositoryRoots) {
        if (isDescendant(root, fsPath)) {
          events.push({ type: FileChangeType.Changed, uri });
          break;
        }
      }
    }

    if (events.length > 0) {
      this._onDidChangeFile.fire(events);
    }

    this.changedRepositoryRoots.clear();
  }

  watch(): Disposable {
    return EmptyDisposable;
  }

  async stat(uri: Uri): Promise<FileStat> {
    const cacheKey = uri.toString();
    const now = Date.now();

    // Check stat cache first (TTL: 1 minute)
    const cached = this.statCache.get(cacheKey);
    if (cached && now - cached.timestamp < ONE_MINUTE) {
      return cached.result;
    }

    // Dedupe concurrent requests for same URI
    const pending = this.pendingStats.get(cacheKey);
    if (pending) {
      return pending;
    }

    // Execute stat and cache result
    const promise = this.doStat(uri).then(result => {
      const { fsPath } = fromSvnUri(uri);
      this.statCache.set(cacheKey, {
        result,
        timestamp: Date.now(),
        fsPath
      });
      return result;
    });

    // Track pending request
    this.pendingStats.set(cacheKey, promise);
    void promise.finally(() => this.pendingStats.delete(cacheKey));

    return promise;
  }

  /**
   * True when the URI's content tracks the working copy (quickdiff BASE
   * originals, log/patch documents) rather than being pinned to a specific
   * revision. Pinned content is immutable, so its stat can be constant.
   */
  private static isWorkingCopyRef(ref: string | undefined): boolean {
    if (!ref) {
      return true; // provideOriginalResource passes no ref -> BASE
    }
    const upper = ref.toUpperCase();
    return upper === "BASE" || upper === "PREV" || upper === "COMMITTED";
  }

  /**
   * Core stat implementation.
   *
   * NO remote calls: this used to run `svn list <URL>` (a server round-trip
   * per opened tracked file, fired by VS Code's quickdiff stat) to fetch
   * HEAD size/mtime for content that is actually served from the LOCAL
   * pristine BASE. Instead, mtime now comes from local `svn info` (wc.db,
   * 2-min cache): the BASE last-changed date moves exactly when commit/
   * update change BASE, which is what drives VS Code to reload the
   * original. Size is not available locally and is reported as 0 - the
   * old HEAD size already disagreed with the BASE content whenever the
   * server was ahead, so nothing may depend on it.
   */
  private async doStat(uri: Uri): Promise<FileStat> {
    try {
      await this.sourceControlManager.isInitialized;

      const { fsPath, action, extra } = fromSvnUri(uri);

      // Revision-pinned content never changes - constant stat, no svn call
      if (
        action === SvnUriAction.SHOW &&
        !SvnFileSystemProvider.isWorkingCopyRef(extra.ref)
      ) {
        return { type: FileType.File, size: 0, mtime: 0, ctime: 0 };
      }

      // For virtual SVN files, be lenient - return default stats if repository
      // not found yet. Let readFile() handle the actual error. This prevents
      // false FileNotFound during async repository discovery.
      const repository = this.sourceControlManager.getRepository(fsPath);

      let mtime = new Date().getTime();

      if (repository) {
        // Wait for initial status to load before checking file version
        await repository.statusReady;

        // Skip SVN calls for files we know are unversioned/ignored/added
        const resource = repository.getResourceFromFile(fsPath);
        if (
          resource?.type === Status.UNVERSIONED ||
          resource?.type === Status.IGNORED ||
          resource?.type === Status.ADDED
        ) {
          return { type: FileType.File, size: 0, mtime: 0, ctime: 0 };
        }

        // Fallback: check if file is inside an unversioned/ignored folder
        // (Files inside unversioned folders aren't individually indexed)
        if (!resource) {
          const parentStatus = repository.isInsideUnversionedOrIgnored(fsPath);
          if (
            parentStatus === Status.UNVERSIONED ||
            parentStatus === Status.IGNORED
          ) {
            return { type: FileType.File, size: 0, mtime: 0, ctime: 0 };
          }
        }

        try {
          const info = await repository.getInfo(fsPath);
          if (info.commit?.date) {
            mtime = Date.parse(info.commit.date);
          }
        } catch (error) {
          // Suppress "not found" errors for untracked/unversioned files.
          // getInfo's negative cache replays a plain Error without stderr,
          // so match the message as well as stderr codes.
          const text = `${
            error && typeof error === "object" && "stderr" in error
              ? String((error as { stderr?: unknown }).stderr)
              : ""
          } ${error instanceof Error ? error.message : ""}`;
          const isUntrackedFile =
            /W155010|E155010|W160013|E200009|W200005|E155007|not under version control/.test(
              text
            );
          if (!isUntrackedFile) {
            logError("Failed to stat SVN file", error);
          }
        }
      }

      return { type: FileType.File, size: 0, mtime, ctime: 0 };
    } catch (error) {
      // Re-throw FileSystemErrors as-is
      if (error instanceof FileSystemError) {
        throw error;
      }
      // Wrap other errors
      logError("stat failed", error);
      throw FileSystemError.Unavailable(
        error instanceof Error ? getErrorMessage(error) : "Failed to stat file"
      );
    }
  }

  readDirectory(): Thenable<[string, FileType][]> {
    throw new Error("readDirectory is not implemented");
  }

  createDirectory(): void {
    throw new Error("createDirectory is not implemented");
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    try {
      await this.sourceControlManager.isInitialized;

      const { fsPath, extra, action } = fromSvnUri(uri);

      // Try multiple methods to find the repository
      let repository = this.sourceControlManager.getRepository(fsPath);

      // Fallback: try getRepositoryFromUri which may use different lookup
      if (!repository && fsPath) {
        repository = await this.sourceControlManager.getRepositoryFromUri(
          Uri.file(fsPath)
        );
      }

      if (!repository) {
        // Debug: show URI and parsed data for diagnosis
        const repos = this.sourceControlManager.repositories;
        const roots = repos.map(r => r.workspaceRoot).join("; ");
        throw FileSystemError.Unavailable(
          `fsPath: ${fsPath || "(empty)"} | query: ${uri.query?.slice(0, 100) || "(none)"} | roots: ${roots || "(none)"}`
        );
      }

      const cacheKey = uri.toString();
      const timestamp = new Date().getTime();
      const cacheValue: CacheRow = { uri: uri, timestamp };

      this.cache.set(cacheKey, cacheValue);

      // Wait for initial status to load before checking file version
      await repository.statusReady;

      if (action === SvnUriAction.SHOW) {
        // Skip SVN calls for files we know are unversioned/ignored
        const resource = repository.getResourceFromFile(fsPath);
        if (
          resource?.type === Status.UNVERSIONED ||
          resource?.type === Status.IGNORED
        ) {
          throw FileSystemError.FileNotFound(uri);
        }
        // Newly added files have no BASE/pristine version until committed
        if (resource?.type === Status.ADDED) {
          throw FileSystemError.FileNotFound(uri);
        }
        // Fallback: check if file is inside an unversioned/ignored folder
        if (!resource) {
          const parentStatus = repository.isInsideUnversionedOrIgnored(fsPath);
          if (
            parentStatus === Status.UNVERSIONED ||
            parentStatus === Status.IGNORED
          ) {
            throw FileSystemError.FileNotFound(uri);
          }
        }
        return await repository.showBuffer(fsPath, extra.ref);
      }
      if (action === SvnUriAction.LOG) {
        return await repository.plainLogBuffer();
      }
      if (action === SvnUriAction.LOG_REVISION && extra.revision) {
        return await repository.plainLogByRevisionBuffer(extra.revision);
      }
      if (action === SvnUriAction.LOG_SEARCH && extra.search) {
        return await repository.plainLogByTextBuffer(extra.search);
      }
      if (action === SvnUriAction.PATCH) {
        return await repository.patchBuffer([fsPath]);
      }

      return new Uint8Array(0);
    } catch (error) {
      // Re-throw FileSystemErrors as-is (already properly formatted)
      if (error instanceof FileSystemError) {
        throw error;
      }

      // Extract SVN error details for proper VS Code error display
      let svnErrorCode: string | undefined;
      let errorDetails = "";

      if (error && typeof error === "object" && "svnErrorCode" in error) {
        // SvnError object - get the specific error code and stderr
        const svnError = error as {
          svnErrorCode?: string;
          stderr?: string;
          stderrFormated?: string;
          message?: string;
        };
        svnErrorCode = svnError.svnErrorCode;
        errorDetails =
          svnError.stderrFormated || svnError.stderr || svnError.message || "";
      } else if (error instanceof Error) {
        errorDetails = error.message;
        const errorCodeMatch = errorDetails.match(/E\d+|W\d+/);
        if (errorCodeMatch) {
          svnErrorCode = errorCodeMatch[0];
        }
      } else {
        errorDetails = String(error);
      }

      // Check for "not found" error patterns
      if (
        svnErrorCode === "E160013" || // Path not found
        svnErrorCode === "E200009" || // Could not cat
        svnErrorCode === "W160013" || // URL not found
        errorDetails.includes("E160013") ||
        errorDetails.includes("E200009") ||
        errorDetails.includes("W160013")
      ) {
        throw FileSystemError.FileNotFound(uri);
      }

      // Log and re-throw with detailed message (never empty)
      logError("Failed to read SVN file", error);
      const message = errorDetails || "SVN operation failed";
      throw FileSystemError.Unavailable(message);
    }
  }

  writeFile(): void {
    throw new Error("writeFile is not implemented");
  }

  delete(): void {
    throw new Error("delete is not implemented");
  }

  rename(): void {
    throw new Error("rename is not implemented");
  }

  private cleanup(): void {
    const now = new Date().getTime();
    const cache = new Map<string, CacheRow>();

    for (const row of this.cache.values()) {
      const { fsPath } = fromSvnUri(row.uri);
      const isOpen = workspace.textDocuments
        .filter(d => d.uri.scheme === "file")
        .some(d => pathEquals(d.uri.fsPath, fsPath));

      if (isOpen || now - row.timestamp < THREE_MINUTES) {
        cache.set(row.uri.toString(), row);
      } else {
        // TODO: should fire delete events?
      }
    }

    this.cache = cache;

    // Cleanup stat cache - remove entries older than 3 minutes
    for (const [key, row] of this.statCache) {
      if (now - row.timestamp > THREE_MINUTES) {
        this.statCache.delete(key);
      }
    }
  }

  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.disposables.forEach(d => d.dispose());
  }
}
