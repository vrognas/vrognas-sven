// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import * as semver from "semver";
import * as tmp from "tmp";
import { CancellationToken, Uri, workspace } from "vscode";
import {
  ConstructorPolicy,
  ICpOptions,
  ICleanupOptions,
  IExecutionResult,
  IFileStatus,
  ILockOptions,
  ISvnInfo,
  ISvnLockInfo,
  ISvnLogEntry,
  IUnlockOptions,
  IUpdateResult,
  Status,
  SvnDepth,
  ISvnPathChange,
  ISvnPath,
  ISvnListItem,
  ISvnBlameLine,
  PropertyChange
} from "./common/types";
import { sequentialize } from "./decorators";
import * as encodeUtil from "./encoding";
import {
  IHistoryFilter,
  buildSvnLogArgs,
  filterEntriesByAction,
  hasTextSearchFilter
} from "./historyView/historyFilter";
import { exists, writeFile, stat, readdir } from "./fs";
import { getBranchName } from "./helpers/branch";
import { configuration } from "./helpers/configuration";
import { parseInfoXml } from "./parser/infoParser";
import { parseSvnList } from "./parser/listParser";
import { parseBatchLockInfo, parseLockInfo } from "./parser/lockParser";
import { parseSvnLog } from "./parser/logParser";
import { parseStatusXml } from "./parser/statusParser";
import { parseSvnBlame } from "./parser/blameParser";
import { parseUpdateOutput } from "./parser/updateParser";
import { Svn, BufferResult } from "./svn";
import {
  fixPathSeparator,
  fixPegRevision,
  isDescendant,
  normalizePath,
  unwrap
} from "./util";
import { logError, getErrorMessage } from "./util/errorLogger";
import * as textCodec from "./util/textCodec";
import { matchAll } from "./util/globMatch";
import { LRUCache } from "./util/lruCache";
import { withCachedInFlight } from "./util/withCachedInFlight";
import { parseDiffXml } from "./parser/diffParser";
import SvnError from "./svnError";
import {
  validateChangelist,
  validateAcceptAction,
  validateSearchPattern,
  validateFilePath,
  validateLockComment
} from "./validation";

export class Repository {
  // LRU caches with TTL expiration
  private _infoCache = new LRUCache<ISvnInfo | null>(500, 2 * 60 * 1000);
  private _blameCache = new LRUCache<ISvnBlameLine[]>(100, 5 * 60 * 1000);
  // In-flight dedup for concurrent blame calls (BlameProvider and
  // BlameStatusBar race on the same file at every editor switch).
  private _blameInFlight = new Map<string, Promise<ISvnBlameLine[]>>();
  // Short-TTL negative cache for non-transient blame failures (binary
  // file, unversioned, invalid revision, parse failure). Without it a
  // failing file re-spawns a full `svn blame` on every debounced cursor
  // event because errors never reach _blameCache.
  private _blameErrorCache = new LRUCache<string>(50, 30 * 1000);
  // Bumped by clearBlameCache so fetches that started before an
  // invalidation can't repopulate the cache with pre-mutation data.
  private _blameGeneration = 0;
  private _logCache = new LRUCache<ISvnLogEntry[]>(50, 60 * 1000);
  // A branch's copy origin is stable for a given branch URL, but not
  // strictly immutable (delete + re-create at the same URL) and the URL
  // itself can go stale around switches - so: long TTL instead of
  // session-lifetime, cleared on switch and dispose. null = verified
  // "not a copy" (parsed result); errors propagate and are never cached.
  private _copyPointCache = new LRUCache<{
    copyFromPath: string;
    copyFromRev: string;
    copyToPath: string;
  } | null>(10, 30 * 60 * 1000);
  // URL-keyed cache for `svn list` (remote call). 30s TTL — covers diff-open
  // bursts where multiple svn-scheme URIs resolve to the same fsPath and
  // each stat would otherwise fire its own network list.
  private _listCache = new LRUCache<ISvnListItem[]>(200, 30 * 1000);
  // In-flight dedup for concurrent list() calls with the same URL.
  private _listInFlight = new Map<string, Promise<ISvnListItem[]>>();

  private _info?: ISvnInfo;
  // Phase 10.3 perf fix - timestamp-based caching (5s)
  private lastInfoUpdate: number = 0;
  private readonly INFO_CACHE_MS = 5000;

  // In-flight dedup for svn cat — prevents duplicate calls for same file+revision
  private _catInFlight = new Map<string, Promise<Buffer>>();
  // Short-TTL content cache so sequential cat calls for the same file+rev
  // (e.g. diff editor left side, then BlameProvider line mapping) share a
  // single SVN read instead of re-executing.
  private _catCache = new LRUCache<Buffer>(50, 30 * 1000);
  // Content/diffs keyed to a pinned NUMERIC revision are immutable in
  // SVN's data model - hold them for a day (LRU cap bounds memory).
  // HEAD/BASE/PREV/COMMITTED/date refs are mutable and never qualify.
  private static readonly IMMUTABLE_REVISION_TTL_MS = 24 * 60 * 60 * 1000;
  private _patchRevisionCache = new LRUCache<string>(
    50,
    Repository.IMMUTABLE_REVISION_TTL_MS
  );
  private _patchRevisionInFlight = new Map<string, Promise<string>>();

  // Path-keyed cache for `svn diff --properties-only <path>`. The status
  // refresh flow fetches this per-file for every file with prop changes;
  // without a cache, N files = N spawn/parse cycles per refresh.
  // Cleared on forceRefresh from Repository.updateModelState.
  private _propertyChangesCache = new LRUCache<PropertyChange[]>(
    500,
    30 * 1000
  );
  private _propertyChangesInFlight = new Map<
    string,
    Promise<PropertyChange[]>
  >();

  public username?: string;
  public password?: string;

  constructor(
    private svn: Svn,
    public root: string,
    public workspaceRoot: string,
    policy: ConstructorPolicy,
    prefetchedInfo?: ISvnInfo
  ) {
    if (policy === ConstructorPolicy.LateInit) {
      return (async (): Promise<Repository> => {
        return this;
      })() as unknown as Repository;
    }
    return (async (): Promise<Repository> => {
      if (prefetchedInfo) {
        this._info = prefetchedInfo;
        this._infoCache.set("", prefetchedInfo);
        this.lastInfoUpdate = Date.now();
      } else {
        await this.updateInfo();
      }
      return this;
    })() as unknown as Repository;
  }

  public async updateInfo(forceRefresh: boolean = false) {
    // Check cache first (skip if forced)
    const now = Date.now();
    if (!forceRefresh && now - this.lastInfoUpdate < this.INFO_CACHE_MS) {
      return;
    }
    this.lastInfoUpdate = now;

    const result = await this.exec([
      "info",
      "--xml",
      fixPegRevision(this.workspaceRoot ? this.workspaceRoot : this.root)
    ]);

    try {
      this._info = await parseInfoXml(result.stdout);
      // Seed getInfo() cache so getCurrentBranch() doesn't re-query
      this._infoCache.set("", this._info);
    } catch (err) {
      logError(
        `Failed to parse repository info for ${this.workspaceRoot}`,
        err
      );
      throw new Error(`Repository info unavailable: ${getErrorMessage(err)}`);
    }
  }

  public async exec(
    args: string[],
    options: ICpOptions = {}
  ): Promise<IExecutionResult> {
    this.injectCredentials(options);
    return this.svn.exec(this.workspaceRoot, args, options);
  }

  public async execBuffer(
    args: string[],
    options: ICpOptions = {}
  ): Promise<BufferResult> {
    this.injectCredentials(options);
    return this.svn.execBuffer(this.workspaceRoot, args, options);
  }

  public removeAbsolutePath(file: string) {
    file = fixPathSeparator(file);

    file = path.relative(this.workspaceRoot, file);

    if (file === "") {
      file = ".";
    }

    return fixPegRevision(file);
  }

  /**
   * Normalize an array of absolute file paths to relative paths.
   * Shared helper to reduce duplication across SVN operations.
   */
  private normalizeFilePaths(files: string[]): string[] {
    return files.map(file => this.removeAbsolutePath(file));
  }

  /**
   * Validate file paths to prevent path traversal attacks.
   * Throws if any path is invalid.
   */
  private validateFilePaths(files: string[]): void {
    for (const file of files) {
      if (!validateFilePath(file)) {
        throw new Error(`Invalid file path: ${file}`);
      }
    }
  }

  /**
   * Build path with peg revision for SVN commands.
   * Adds @revision suffix for non-working-copy revisions (not BASE/COMMITTED/PREV).
   */
  private buildPegPath(path: string, revision?: string): string {
    const escaped = fixPegRevision(path);
    if (
      revision &&
      !["BASE", "COMMITTED", "PREV"].includes(revision.toUpperCase())
    ) {
      return `${escaped}@${revision}`;
    }
    return escaped;
  }

  /**
   * Inject credentials into options for SVN command execution.
   */
  private injectCredentials(options: ICpOptions): void {
    options.username = this.username;
    options.password = this.password;
    if (this._info?.url) {
      options.realmUrl = this._info.url;
    }
  }

  /**
   * Push directory target to args array for property operations.
   * Uses fixPegRevision for non-empty paths, "." for root.
   */
  private pushDirTarget(args: string[], directory: string): void {
    if (directory) {
      args.push(fixPegRevision(directory));
    } else {
      args.push(".");
    }
  }

  /**
   * Require minimum SVN version for a feature.
   * Throws descriptive error if version requirement not met.
   */
  private requireSvnVersion(minVersion: string, feature: string): void {
    if (!semver.gte(this.svn.version, minVersion)) {
      throw new Error(
        `${feature} requires SVN ${minVersion}+, you have ${this.svn.version}`
      );
    }
  }

  // ========== Property helper methods (DRY) ==========

  /**
   * Validate and normalize a file path for property operations.
   * @throws Error if path is invalid
   */
  private validatePath(filePath: string): string {
    const normalized = this.removeAbsolutePath(filePath);
    if (!validateFilePath(normalized)) {
      throw new Error(`Invalid file path: ${normalized}`);
    }
    return normalized;
  }

  /**
   * Get a property value from a file.
   * @returns Property value or null if not set
   */
  private async getProperty(
    name: string,
    filePath: string
  ): Promise<string | null> {
    const normalized = this.validatePath(filePath);
    try {
      const result = await this.exec(["propget", name, normalized]);
      const value = result.stdout.trim();
      return value || null;
    } catch {
      return null;
    }
  }

  /**
   * Set a property on a file or directory.
   */
  private async setProperty(
    name: string,
    value: string,
    filePath: string,
    recursive = false
  ): Promise<IExecutionResult> {
    const normalized = this.validatePath(filePath);
    const args = ["propset", name, value];
    if (recursive) args.push("-R");
    args.push(normalized);
    return this.exec(args);
  }

  /**
   * Delete a property from a file or directory.
   */
  private async deleteProperty(
    name: string,
    filePath: string,
    recursive = false
  ): Promise<IExecutionResult> {
    const normalized = this.validatePath(filePath);
    const args = ["propdel", name];
    if (recursive) args.push("-R");
    args.push(normalized);
    return this.exec(args);
  }

  /**
   * Get all files with a property recursively.
   * @returns Map of path -> value
   */
  private async getAllPropertyValues(
    name: string
  ): Promise<Map<string, string>> {
    try {
      const result = await this.exec(["propget", name, "-R", "."]);
      return this.parsePropertyListOutput(result.stdout);
    } catch {
      return new Map();
    }
  }

  /**
   * Parse "path - value" format from propget -R output.
   */
  private parsePropertyListOutput(stdout: string): Map<string, string> {
    const files = new Map<string, string>();
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && trimmed.includes(" - ")) {
        const lastDash = trimmed.lastIndexOf(" - ");
        const path = trimmed.substring(0, lastDash).trim();
        const value = trimmed.substring(lastDash + 3).trim();
        if (path && value) {
          files.set(path, value);
        }
      }
    }
    return files;
  }

  /**
   * Get all properties for all files in one call.
   * Replaces 3 separate propget calls with a single `svn proplist -R -v .`.
   * Output format:
   *   Properties on 'path/file':
   *     svn:needs-lock
   *       *
   *     svn:eol-style
   *       native
   */
  public async getAllProperties(): Promise<{
    needsLock: Set<string>;
    eolStyle: Map<string, string>;
    mimeType: Map<string, string>;
  }> {
    const needsLock = new Set<string>();
    const eolStyle = new Map<string, string>();
    const mimeType = new Map<string, string>();

    try {
      const result = await this.exec(["proplist", "-R", "-v", "."]);
      let currentPath = "";
      let currentProp = "";

      for (const line of result.stdout.split("\n")) {
        const pathMatch = line.match(/^Properties on '(.+)':$/);
        if (pathMatch?.[1]) {
          currentPath = pathMatch[1];
          currentProp = "";
          continue;
        }

        const trimmed = line.trim();
        if (!trimmed) continue;

        // Property name lines are indented with 2 spaces, values with 4+
        if (line.startsWith("    ") && currentProp && currentPath) {
          // Value line
          const value = trimmed;
          if (currentProp === "svn:needs-lock") {
            needsLock.add(currentPath);
          } else if (currentProp === "svn:eol-style") {
            eolStyle.set(currentPath, value);
          } else if (currentProp === "svn:mime-type") {
            mimeType.set(currentPath, value);
          }
          currentProp = "";
        } else if (line.startsWith("  ") && !line.startsWith("    ")) {
          // Property name line
          currentProp = trimmed;
        }
      }
    } catch (e) {
      logError("getAllProperties", e);
    }

    return { needsLock, eolStyle, mimeType };
  }

  /**
   * Cheap server probe: youngest revision in [BASE, HEAD] touching this
   * working copy's subtree, via one constant-cost round-trip.
   *
   * Range is DESCENDING (`HEAD:BASE`) so `--limit 1` returns the YOUNGEST
   * matching revision — ascending would return the oldest, which would
   * freeze any "did HEAD move since last time" gate built on it. The
   * range is inclusive of BASE, so a single entry AT BASE means no
   * incoming changes.
   *
   * @returns hasChanges: new revisions exist beyond BASE for this subtree;
   *          youngestRevision: that revision (or BASE when up to date);
   *          undefined youngestRevision means the probe failed.
   */
  public async hasRemoteChanges(): Promise<{
    hasChanges: boolean;
    youngestRevision?: number;
  }> {
    try {
      const result = await this.exec([
        "log",
        "-r",
        "HEAD:BASE",
        "--limit",
        "1",
        "--xml"
      ]);

      const base = parseInt(this._info?.revision ?? "0", 10);
      const match = /<logentry\s+[^>]*revision="(\d+)"/.exec(result.stdout);

      if (match) {
        const youngest = parseInt(match[1]!, 10);
        return { hasChanges: youngest > base, youngestRevision: youngest };
      }

      // Empty log: no revision in [BASE, HEAD] touches this subtree
      return { hasChanges: false, youngestRevision: base };
    } catch (err) {
      // Probe failed - assume changes exist so callers fall back to a
      // full status; omit youngestRevision (nothing was learned)
      logError("hasRemoteChanges failed, falling back to full status", err);
      return { hasChanges: true };
    }
  }

  public async getStatus(params: {
    includeIgnored?: boolean;
    includeExternals?: boolean;
    checkRemoteChanges?: boolean;
    fetchLockStatus?: boolean;
    fetchExternalUuids?: boolean;
  }): Promise<IFileStatus[]> {
    params = Object.assign(
      {},
      {
        includeIgnored: false,
        includeExternals: true,
        checkRemoteChanges: false,
        fetchLockStatus: false,
        fetchExternalUuids: false
      },
      params
    );

    // Optimization: Check for remote changes before expensive status call
    // Skip this optimization if fetchLockStatus=true (need --show-updates for locks)
    if (params.checkRemoteChanges && !params.fetchLockStatus) {
      const probe = await this.hasRemoteChanges();
      if (!probe.hasChanges) {
        console.log("Remote poll: No new revisions, skipping status");
        return [];
      }
    }

    const args = ["stat", "--xml"];

    if (params.includeIgnored) {
      args.push("--no-ignore");
    }
    if (!params.includeExternals) {
      args.push("--ignore-externals");
    }
    // --show-updates needed for both remote changes AND lock status
    if (params.checkRemoteChanges || params.fetchLockStatus) {
      args.push("--show-updates");
    }

    const result = await this.exec(args);

    let status: IFileStatus[];
    try {
      status = await parseStatusXml(result.stdout);
    } catch (err) {
      logError(`Failed to parse status XML for ${this.workspaceRoot}`, err);
      throw new Error(`Status update failed: ${getErrorMessage(err)}`);
    }

    // Only fetch external UUIDs when needed (combineExternal=true)
    // Skips N sequential svn info calls when combineExternal=false (default)
    if (params.fetchExternalUuids) {
      // Note: getInfo is @sequentialize so these run sequentially despite Promise.all
      // TODO: Add batch getInfo variant for true parallelism
      await Promise.all(
        status
          .filter(s => s.status === Status.EXTERNAL)
          .map(async s => {
            try {
              const info = await this.getInfo(s.path);
              s.repositoryUuid = info.repository?.uuid;
            } catch (error) {
              logError(
                `Failed to fetch external repository info for ${s.path}`,
                error
              );
            }
          })
      );
    }

    return status;
  }

  /**
   * Get status for a specific path with depth control.
   * Use this instead of getStatus() when you only need status for a subset of the repo.
   * Avoids parsing massive XML for large repositories.
   *
   * @param targetPath Path to get status for (relative or absolute)
   * @param depth SVN depth: empty, files, immediates, infinity
   * @returns File statuses for the specified path and depth
   */
  public async getScopedStatus(
    targetPath: string,
    depth: keyof typeof SvnDepth
  ): Promise<IFileStatus[]> {
    const relativePath = this.removeAbsolutePath(targetPath);

    const args = ["stat", "--xml", "--depth", depth, relativePath];

    const result = await this.exec(args);

    let status: IFileStatus[];
    try {
      status = await parseStatusXml(result.stdout);
    } catch (err) {
      logError(`Failed to parse scoped status XML for ${relativePath}`, err);
      throw new Error(`Scoped status failed: ${getErrorMessage(err)}`);
    }

    return status;
  }

  public get info(): ISvnInfo {
    return unwrap(this._info);
  }

  public resetInfoCache(file: string = ""): void {
    this._infoCache.delete(file);
  }

  public resetBlameCache(cacheKey: string): void {
    this._blameCache.delete(cacheKey);
  }

  /**
   * Clear all blame cache entries (call after any operation that can
   * change BASE content: commit, update, revert, switch, merge, ...).
   * Revision-keyed blame entries are pegged fetches (content matches the
   * key by construction), so external svn operations cannot poison them;
   * they only delay key re-resolution by up to the 2-min info TTL.
   */
  public clearBlameCache(): void {
    this._blameCache.clear();
    this._blameErrorCache.clear();
    // Drop in-flight promises too: callers arriving after the clear must
    // not be handed a pre-mutation fetch. The generation bump prevents
    // those orphaned fetches from writing their result back on completion.
    this._blameInFlight.clear();
    this._blameGeneration++;
    // Per-file info entries feed blame cache keys (BASE resolution) and
    // resetInfoCache() deletes only the repo-root entry - clear the whole
    // info cache so key resolution stays coherent with the mutated WC
    this._infoCache.clear();
  }

  public resetLogCache(cacheKey: string): void {
    this._logCache.delete(cacheKey);
  }

  /** Clear all log cache entries (call after commit/update). */
  public clearLogCache(): void {
    this._logCache.clear();
  }

  public async getInfo(
    file: string = "",
    revision?: string,
    skipCache: boolean = false,
    isUrl: boolean = false
  ): Promise<ISvnInfo> {
    // Fast-path cache check OUTSIDE @sequentialize so concurrent callers for
    // a path that's already cached don't queue behind an unrelated in-flight
    // info fetch. Cache miss falls through to the sequentialized fetch.
    const normalizedFile = file ? fixPathSeparator(file).toLowerCase() : "";
    const cacheKey = revision
      ? `${normalizedFile}@${revision}`
      : normalizedFile;

    if (!skipCache && this._infoCache.has(cacheKey)) {
      const cached = this._infoCache.get(cacheKey);
      // Check for negative cache (unversioned file marker)
      if (cached === null) {
        throw new Error(`File not under version control: ${file}`);
      }
      if (cached !== undefined) {
        return cached;
      }
    }

    return this._doGetInfoFetch(file, revision, isUrl, cacheKey);
  }

  // The actual network fetch + cache-write path. Sequentialized so that two
  // concurrent misses for different paths can't both spawn `svn info`
  // simultaneously (matches the original behaviour); cache hits no longer
  // queue here, see getInfo() above.
  @sequentialize
  private async _doGetInfoFetch(
    file: string,
    revision: string | undefined,
    isUrl: boolean,
    cacheKey: string
  ): Promise<ISvnInfo> {
    // Re-check cache in case a previous queued fetch populated it while we
    // were waiting for the sequentialize lock.
    if (this._infoCache.has(cacheKey)) {
      const cached = this._infoCache.get(cacheKey);
      if (cached === null) {
        throw new Error(`File not under version control: ${file}`);
      }
      if (cached !== undefined) {
        return cached;
      }
    }

    const args = ["info", "--xml"];

    if (revision) {
      args.push("-r", revision);
    }

    let targetFile = file;
    if (file) {
      if (!isUrl) {
        targetFile = fixPathSeparator(file);
      }
      args.push(this.buildPegPath(targetFile, revision));
    }

    let result;
    try {
      result = await this.exec(args);
    } catch (err) {
      // Negative cache for unversioned files (W155010/E200009)
      if (
        err &&
        typeof err === "object" &&
        "stderr" in err &&
        typeof err.stderr === "string" &&
        (err.stderr.includes("W155010") || err.stderr.includes("E200009"))
      ) {
        this._infoCache.set(cacheKey, null);
      }
      throw err;
    }

    let info: ISvnInfo;
    try {
      info = await parseInfoXml(result.stdout);
    } catch (err) {
      logError(`Failed to parse info XML for ${file}`, err);
      throw new Error(
        `File info unavailable for ${file}: ${getErrorMessage(err)}`
      );
    }

    this._infoCache.set(cacheKey, info);
    return info;
  }

  /**
   * Get blame information for a file
   *
   * @param file Absolute or relative path to file
   * @param revision Revision to blame (default: HEAD)
   * @param skipCache Skip cache and force fresh blame
   * @returns Array of blame line information
   *
   * @example
   * const blame = await repository.blame("src/file.ts");
   * const blameAtRev = await repository.blame("src/file.ts", "100");
   */
  public async blame(
    file: string,
    revision: string = "BASE",
    skipCache: boolean = false
  ): Promise<ISvnBlameLine[]> {
    // Convert to relative path
    const relativePath = this.removeAbsolutePath(file);

    // Resolve BASE to the file's actual base revision: revision-keyed
    // entries are immutable (long TTL) and mixed-revision working copies
    // get per-file-correct keys. Local wc.db read, 2-min info cache; on
    // failure (unversioned, offline) fall back to the literal keyword.
    // The svn args keep the BASE keyword - only the key is resolved.
    let keyRevision = revision;
    if (revision.toUpperCase() === "BASE") {
      try {
        const info = await this.getInfo(file);
        if (/^\d+$/.test(info.revision)) {
          keyRevision = info.revision;
        }
      } catch {
        // keep the literal BASE key
      }
    }

    // COHERENCE BY CONSTRUCTION: once BASE resolves to a number, fetch
    // that exact pegged revision too. Fetching the mutable BASE keyword
    // while keying on a (possibly stale) resolved number lets new-BASE
    // content land under an old revision key with the immutable TTL.
    // With a pegged fetch the content always matches the key; a stale
    // resolution only means a briefly stale DISPLAY, bounded by the
    // 2-min info TTL and the full info clear on mutating operations.
    revision = keyRevision;

    // Cache key includes revision for per-revision caching
    const cacheKey = `${relativePath}@${keyRevision}`;

    if (!skipCache) {
      // Fast-path cache check OUTSIDE @sequentialize (getInfo pattern) so
      // cache hits don't queue behind an unrelated in-flight network blame.
      const cached = this._blameCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      // Replay recent non-transient failures without re-spawning svn
      const cachedError = this._blameErrorCache.get(cacheKey);
      if (cachedError !== undefined) {
        throw new Error(cachedError);
      }

      // Concurrent callers for the same file share one fetch
      const inFlight = this._blameInFlight.get(cacheKey);
      if (inFlight !== undefined) {
        return inFlight;
      }
    }

    const fetchPromise = this._doBlameFetch(
      relativePath,
      revision,
      cacheKey,
      skipCache
    );

    if (!skipCache) {
      this._blameInFlight.set(cacheKey, fetchPromise);
      const cleanup = () => {
        if (this._blameInFlight.get(cacheKey) === fetchPromise) {
          this._blameInFlight.delete(cacheKey);
        }
      };
      fetchPromise.then(cleanup, cleanup);
    }

    return fetchPromise;
  }

  // The actual subprocess + parse path. Sequentialized so concurrent misses
  // for different files can't spawn multiple `svn blame` simultaneously;
  // cache hits no longer queue here, see blame() above.
  @sequentialize
  private async _doBlameFetch(
    relativePath: string,
    revision: string,
    cacheKey: string,
    skipCache: boolean
  ): Promise<ISvnBlameLine[]> {
    // Re-check cache in case a queued fetch populated it while waiting
    // (skipCache callers demanded a fresh exec - don't hand them a cache hit)
    if (!skipCache) {
      const cached = this._blameCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    // Snapshot the generation: if clearBlameCache runs while this fetch is
    // in flight (commit/update finished), the result is pre-mutation data
    // and must not be written back.
    const generation = this._blameGeneration;

    // Build SVN blame command
    const args = [
      "blame",
      "--xml",
      "-x",
      "-w --ignore-eol-style", // Ignore whitespace/EOL changes
      "-r",
      revision
    ];

    // Add peg revision for specific revisions to handle renamed/moved/deleted files
    // BASE = working copy revision (matches what's in editor)
    // HEAD = server's latest (might not match working copy)
    if (
      revision.toUpperCase() !== "HEAD" &&
      revision.toUpperCase() !== "BASE"
    ) {
      args.push(fixPegRevision(relativePath) + "@" + revision);
    } else {
      args.push(fixPegRevision(relativePath));
    }

    // Execute SVN command
    let result: IExecutionResult;
    try {
      result = await this.exec(args);
    } catch (err: unknown) {
      // Handle known SVN errors. Non-transient failures are negative-cached
      // (short TTL) so cursor-event traffic doesn't re-spawn a doomed blame.
      if (
        typeof err === "object" &&
        err !== null &&
        "stderr" in err &&
        typeof err.stderr === "string"
      ) {
        if (err.stderr.includes("E195012") && err.stderr.includes("binary")) {
          throw this.cacheBlameError(
            cacheKey,
            `Cannot blame binary file: ${relativePath}`,
            generation
          );
        }
        if (err.stderr.includes("E155007")) {
          // Keep the code in the message: callers silent-skip on it
          throw this.cacheBlameError(
            cacheKey,
            `File not under version control (E155007): ${relativePath}`,
            generation
          );
        }
        if (err.stderr.includes("E160006")) {
          throw this.cacheBlameError(
            cacheKey,
            `Invalid revision: ${revision}`,
            generation
          );
        }
        // W155010: node not found (file/dir outside working copy or shallow checkout)
        // E200009: could not perform operation on some targets
        // These are expected for unversioned/non-existent files - don't log as errors.
        // Cache the stderr (contains the code) so replayed errors still match
        // the callers' silent-skip checks.
        if (err.stderr.includes("W155010") || err.stderr.includes("E200009")) {
          if (generation === this._blameGeneration) {
            this._blameErrorCache.set(cacheKey, err.stderr);
          }
          throw err; // Re-throw without logging (caller handles silently)
        }
      }
      // Transient errors (network, auth, repo lock) are NOT cached - retryable
      logError(`Failed to execute blame for ${relativePath}`, err);
      throw new Error(
        `Blame failed for ${relativePath}: ${getErrorMessage(err)}`
      );
    }

    // Parse blame XML
    let blame: ISvnBlameLine[];
    try {
      blame = await parseSvnBlame(result.stdout);
    } catch (err) {
      logError(`Failed to parse blame XML for ${relativePath}`, err);
      throw this.cacheBlameError(
        cacheKey,
        `Blame parse failed for ${relativePath}: ${getErrorMessage(err)}`,
        generation
      );
    }

    if (generation === this._blameGeneration) {
      // Revision-keyed entries are immutable - hold them for a day
      this._blameCache.set(
        cacheKey,
        blame,
        /@\d+$/.test(cacheKey)
          ? Repository.IMMUTABLE_REVISION_TTL_MS
          : undefined
      );
    }
    return blame;
  }

  /**
   * Store a non-transient blame failure and return the Error to throw.
   * Skips the write when the cache generation moved (invalidation ran
   * while the fetch was in flight - the failure may be pre-mutation).
   */
  private cacheBlameError(
    cacheKey: string,
    message: string,
    generation: number
  ): Error {
    if (generation === this._blameGeneration) {
      this._blameErrorCache.set(cacheKey, message);
    }
    return new Error(message);
  }

  /**
   * Where was the current branch copied from? Immutable per branch URL,
   * so the `svn log --stop-on-copy` round-trip runs once per session.
   */
  private async resolveCopyPoint(): Promise<{
    copyFromPath: string;
    copyFromRev: string;
    copyToPath: string;
  } | null> {
    const branchUrl = this._info?.url ?? "";
    if (branchUrl) {
      const cached = this._copyPointCache.get(branchUrl);
      if (cached !== undefined) {
        return cached;
      }
    }

    const logArgs = [
      "log",
      "-r1:HEAD",
      "--limit=1",
      "--stop-on-copy",
      "--xml",
      "--with-all-revprops",
      "--verbose"
    ];
    const logResult = await this.exec(logArgs); // errors propagate, uncached
    const entries = await parseSvnLog(logResult.stdout);

    let point: {
      copyFromPath: string;
      copyFromRev: string;
      copyToPath: string;
    } | null = null;

    const copyCommitPath = entries[0]?.paths[0];
    if (
      copyCommitPath?.copyfromRev?.trim() &&
      copyCommitPath.copyfromPath?.trim() &&
      copyCommitPath._?.trim()
    ) {
      point = {
        copyFromPath: copyCommitPath.copyfromPath,
        copyFromRev: copyCommitPath.copyfromRev,
        copyToPath: copyCommitPath._
      };
    }

    // Re-read the URL after the awaited exec: a switch completing mid-
    // fetch refreshes _info, and writing under the pre-switch URL would
    // poison that entry
    const writeUrl = this._info?.url ?? "";
    if (writeUrl && writeUrl === branchUrl) {
      this._copyPointCache.set(writeUrl, point);
    }
    return point;
  }

  public async getChanges(): Promise<ISvnPathChange[]> {
    // First, check to see if this branch was copied from somewhere.
    const copyPoint = await this.resolveCopyPoint();
    if (!copyPoint) {
      return [];
    }

    const { copyFromPath, copyFromRev, copyToPath } = copyPoint;
    const copyFromUrl = this.info.repository.root + copyFromPath;
    const copyToUrl = this.info.repository.root + copyToPath;

    // Get last merge revision from path that this branch was copied from.
    let args = ["mergeinfo", "--show-revs=merged", copyFromUrl, copyToUrl];
    let result = await this.exec(args);
    const revisions = result.stdout.trim().split("\n");
    let latestMergedRevision: string = "";

    if (revisions.length) {
      latestMergedRevision = revisions[revisions.length - 1]!;
    }

    if (latestMergedRevision.trim().length === 0) {
      latestMergedRevision = copyFromRev;
    }

    // Now, diff the source branch at the latest merged revision with the current branch's revision
    const info = await this.getInfo(copyToUrl, undefined, true, true);
    args = [
      "diff",
      `${copyFromUrl}@${latestMergedRevision}`,
      copyToUrl,
      "--ignore-properties",
      "--xml",
      "--summarize"
    ];
    result = await this.exec(args);
    let paths: ISvnPath[];
    try {
      paths = await parseDiffXml(result.stdout);
    } catch (err) {
      logError("Failed to parse diff XML for branch changes", err);
      return [];
    }

    const changes: ISvnPathChange[] = [];

    // Now, we have all the files that this branch changed.
    for (const path of paths) {
      changes.push({
        oldPath: Uri.parse(path._),
        newPath: Uri.parse(path._.replace(copyFromUrl, copyToUrl)),
        oldRevision: latestMergedRevision.replace("r", ""),
        newRevision: info.revision,
        item: path.item,
        props: path.props,
        kind: path.kind,
        repo: Uri.parse(this.info.repository.root),
        localPath: Uri.parse(path._.replace(copyFromUrl, ""))
      });
    }

    return changes;
  }

  /**
   * Prepare arguments for 'svn cat' command
   * @private
   */
  private async prepareCatArgs(
    file: string | Uri,
    revision?: string
  ): Promise<{ args: string[]; uri: Uri; filePath: string }> {
    const args = ["cat"];

    let uri: Uri;
    let filePath: string;

    if (file instanceof Uri) {
      uri = file;
      filePath = file.toString(true);
    } else {
      uri = Uri.file(file);
      filePath = file;
    }

    const isChild =
      uri.scheme === "file" && isDescendant(this.workspaceRoot, uri.fsPath);

    // `svn cat` without -r defaults to BASE for working-copy paths. Normalize
    // explicitly so callers with revision=undefined share a cache key with
    // callers passing revision="BASE" for the same file.
    if (!revision && isChild) {
      revision = "BASE";
    }

    let target: string = filePath;

    if (isChild) {
      target = this.removeAbsolutePath(target);
    }

    if (revision) {
      args.push("-r", revision);
      if (
        isChild &&
        !["BASE", "COMMITTED", "PREV"].includes(revision.toUpperCase())
      ) {
        const info = await this.getInfo();
        target = info.url + "/" + target.replace(/\\/g, "/");
        // TODO move to SvnRI
      }
    }

    args.push(this.buildPegPath(target, revision));

    return { args, uri, filePath };
  }

  public async show(file: string | Uri, revision?: string): Promise<string> {
    const { args, uri, filePath } = await this.prepareCatArgs(file, revision);

    // Use showBuffer's dedup with pre-built args to avoid calling prepareCatArgs twice
    const buffer = await this.showBufferWithArgs(args);

    /**
     * ENCODE DETECTION
     * if TextDocuments exists and autoGuessEncoding is true,
     * try detect current encoding of content
     */
    const configs = workspace.getConfiguration("files", uri);

    let encoding: string | undefined | null = configs.get("encoding");
    let autoGuessEncoding: boolean = configs.get<boolean>(
      "autoGuessEncoding",
      false
    );

    const textDocument = workspace.textDocuments.find(
      doc => normalizePath(doc.uri.fsPath) === normalizePath(filePath)
    );

    if (textDocument) {
      const languageConfigs = workspace.getConfiguration(
        `[${textDocument.languageId}]`,
        uri
      );
      if (languageConfigs["files.encoding"] !== undefined) {
        encoding = languageConfigs["files.encoding"];
      }
      if (languageConfigs["files.autoGuessEncoding"] !== undefined) {
        autoGuessEncoding = languageConfigs["files.autoGuessEncoding"];
      }

      if (autoGuessEncoding) {
        const textBuffer = Buffer.from(textDocument.getText(), "utf-8");
        const detectedEncoding = encodeUtil.detectEncoding(textBuffer);
        if (detectedEncoding) {
          encoding = detectedEncoding;
        }
      }
    } else {
      const svnEncoding = configuration.defaultEncoding();
      if (svnEncoding) {
        encoding = svnEncoding;
      }

      // Byte-sniff overrides default when enabled
      if (autoGuessEncoding) {
        const detectedEncoding = encodeUtil.detectEncoding(buffer);
        if (detectedEncoding) {
          encoding = detectedEncoding;
        }
      }
    }

    const experimental = configuration.get<boolean>(
      "experimental.detect_encoding",
      false
    );
    if (experimental) {
      encoding = null;
    }

    // Decode buffer with detected encoding (defensive — invalid labels
    // from VS Code config or sven.default.encoding fall back to utf-8
    // rather than propagating a RangeError).
    if (encoding && textCodec.encodingSupported(encoding)) {
      return textCodec.decode(buffer, encoding);
    }
    return buffer.toString("utf-8");
  }

  public async showBuffer(
    file: string | Uri,
    revision?: string
  ): Promise<Buffer> {
    const { args } = await this.prepareCatArgs(file, revision);
    return this.showBufferWithArgs(args);
  }

  /** Dedup concurrent + short-window-sequential svn cat calls for the same args */
  private showBufferWithArgs(args: string[]): Promise<Buffer> {
    const key = args.join("\0");
    // Pinned numeric revision => immutable content => day-long TTL
    const revIdx = args.indexOf("-r");
    const revision = revIdx >= 0 ? args[revIdx + 1] : undefined;
    const ttlOverride =
      revision && /^\d+$/.test(revision)
        ? Repository.IMMUTABLE_REVISION_TTL_MS
        : undefined;
    return withCachedInFlight(
      key,
      this._catCache,
      this._catInFlight,
      async () => {
        const result = await this.execBuffer(args);
        if (result.exitCode !== 0) {
          const errorCodeMatch = result.stderr.match(/E(\d+)/);
          const svnErrorCode = errorCodeMatch
            ? `E${errorCodeMatch[1]}`
            : undefined;
          throw new SvnError({
            message: `SVN cat command failed: ${result.stderr}`,
            stderr: result.stderr,
            exitCode: result.exitCode,
            svnErrorCode,
            svnCommand: "cat"
          });
        }
        return result.stdout;
      },
      ttlOverride
    );
  }

  public async commitFiles(message: string, files: string[]) {
    files = this.normalizeFilePaths(files);

    const args = ["commit", ...files];

    if (await exists(path.join(this.workspaceRoot, message))) {
      args.push("--force-log");
    }

    let tmpFile: tmp.FileResult | undefined;

    /**
     * For message with line break or non:
     * \x00-\x7F -> ASCII
     * \x80-\xFF -> Latin
     * Use a file for commit message
     */
    if (/\n|[^\x00-\x7F\x80-\xFF]/.test(message)) {
      tmp.setGracefulCleanup();

      tmpFile = tmp.fileSync({
        prefix: "svn-commit-message-",
        mode: 0o600 // Owner read/write only - commit messages may contain sensitive info
      });

      await writeFile(tmpFile.name, message, { encoding: "utf-8" });

      args.push("-F", tmpFile.name);
      args.push("--encoding", "UTF-8");
    } else {
      args.push("-m", message);
    }

    // Prevents commit the files inside the folder
    args.push("--depth", "empty");

    let result: IExecutionResult;
    try {
      result = await this.exec(args);
    } finally {
      // Remove temporary file if exists - cleanup on success or error
      if (tmpFile) {
        try {
          tmpFile.removeCallback();
        } catch (cleanupError) {
          logError(
            "Failed to remove temporary commit message file",
            cleanupError
          );
        }
      }
    }

    const matches = result.stdout.match(/Committed revision (.*)\./i);
    if (matches && matches[0]) {
      const sendedFiles = (
        result.stdout.match(/(Sending|Adding|Deleting)\s+/g) ?? []
      ).length;

      const filesMessage = `${sendedFiles} ${
        sendedFiles === 1 ? "file" : "files"
      } commited`;

      return `${filesMessage}: revision ${matches[1]}.`;
    }

    return result.stdout;
  }

  private async addFilesByIgnore(files: string[], ignoreList: string[]) {
    const allFiles = async (file: string): Promise<string[]> => {
      if ((await stat(file)).isDirectory()) {
        return (
          await Promise.all(
            (await readdir(file)).map(subfile => {
              const abspath = path.resolve(file + path.sep + subfile);
              const relpath = this.removeAbsolutePath(abspath);
              if (
                !matchAll(path.sep + relpath, ignoreList, {
                  dot: true,
                  matchBase: true
                })
              ) {
                return allFiles(abspath);
              }
              return [];
            })
          )
        ).reduce<string[]>((acc, cur) => acc.concat(cur), [file]);
      }
      return [file];
    };
    files = (await Promise.all(files.map(file => allFiles(file)))).flat();
    files = this.normalizeFilePaths(files);
    return this.exec(["add", "--depth=empty", ...files]);
  }

  public async addFiles(files: string[]) {
    const ignoreList = configuration.get<string[]>("sourceControl.ignore", []);
    if (ignoreList.length > 0) {
      return this.addFilesByIgnore(files, ignoreList);
    }
    files = this.normalizeFilePaths(files);

    // Phase 21.D: Adaptive batching for large file sets
    const { executeBatched } = await import("./util/batchOperations");
    const results = await executeBatched(files, async chunk => {
      return this.exec(["add", ...chunk]);
    });

    // Combine results - return last non-empty stdout
    return results.reverse().find(r => r.stdout)?.stdout || "";
  }

  public addChangelist(files: string[], changelist: string) {
    if (!validateChangelist(changelist)) {
      throw new Error("Invalid changelist name");
    }
    files = this.normalizeFilePaths(files);
    return this.exec(["changelist", changelist, ...files]);
  }

  public removeChangelist(files: string[]) {
    files = this.normalizeFilePaths(files);
    return this.exec(["changelist", "--remove", ...files]);
  }

  public async getCurrentBranch(): Promise<string> {
    const info = await this.getInfo();
    const branch = getBranchName(info.url);

    if (branch) {
      const showFullName = configuration.get<boolean>("layout.showFullName");
      if (showFullName) {
        return branch.path;
      } else {
        return branch.name;
      }
    }

    return "";
  }

  public async getRepositoryUuid(): Promise<string> {
    const info = await this.getInfo();

    return info.repository.uuid;
  }

  public async getRepoUrl() {
    const info = await this.getInfo();

    const branch = getBranchName(info.url);

    if (!branch) {
      // No branch detected (non-standard layout): return checkout URL
      // NOT repository.root - that breaks subfolder checkouts
      return info.url;
    }

    const regex = new RegExp(branch.path + "$");

    return info.url.replace(regex, "").replace(/\/$/, "");
  }

  public async getBranches() {
    const trunkLayout = configuration.get<string>("layout.trunk");
    const branchesLayout = configuration.get<string>("layout.branches");
    const tagsLayout = configuration.get<string>("layout.tags");

    const repoUrl = await this.getRepoUrl();

    const branches: string[] = [];

    const promises = [];

    if (trunkLayout) {
      promises.push(
        (async (): Promise<string[]> => {
          try {
            await this.exec([
              "ls",
              repoUrl + "/" + trunkLayout,
              "--depth",
              "empty"
            ]);

            return [trunkLayout];
          } catch (error) {
            return [];
          }
        })()
      );
    }

    const trees: string[] = [];

    if (branchesLayout) {
      trees.push(branchesLayout);
    }

    if (tagsLayout) {
      trees.push(tagsLayout);
    }

    for (const tree of trees) {
      promises.push(
        (async (): Promise<string[]> => {
          const branchUrl = repoUrl + "/" + tree;

          try {
            const result = await this.exec(["ls", branchUrl]);

            const list = result.stdout
              .trim()
              .replace(/\/|\\/g, "")
              .split(/[\r\n]+/)
              .filter((x: string) => !!x)
              .map((i: string) => tree + "/" + i);

            return list;
          } catch (error) {
            return [];
          }
        })()
      );
    }

    const all = await Promise.all(promises);
    all.forEach(list => {
      branches.push(...list);
    });

    return branches;
  }

  public async newBranch(
    name: string,
    commitMessage: string = "Created new branch"
  ) {
    const repoUrl = await this.getRepoUrl();
    const newBranch = repoUrl + "/" + name;
    const info = await this.getInfo();
    const currentBranch = info.url;

    await this.exec(["copy", currentBranch, newBranch, "-m", commitMessage]);

    await this.switchBranch(name);

    return true;
  }

  public async switchBranch(ref: string, force: boolean = false) {
    const repoUrl = await this.getRepoUrl();
    const branchUrl = repoUrl + "/" + ref;

    try {
      await this.exec(
        ["switch", branchUrl].concat(force ? ["--ignore-ancestry"] : [])
      );
    } finally {
      // Clear on failure too - a partial switch can still mutate the WC
      this.resetInfoCache();
      this.clearBlameCache();
      this._copyPointCache.clear();
    }
    return true;
  }

  public async merge(
    ref: string,
    reintegrate: boolean = false,
    accept_action: string = "postpone"
  ) {
    if (!validateAcceptAction(accept_action)) {
      throw new Error("Invalid accept action");
    }
    const repoUrl = await this.getRepoUrl();
    const branchUrl = repoUrl + "/" + ref;

    let args = ["merge", "--accept", accept_action];
    args = args.concat(reintegrate ? ["--reintegrate"] : []);
    args = args.concat([branchUrl]);

    try {
      await this.exec(args);
    } finally {
      // Clear on failure too - a conflicted merge still mutates the WC
      this.resetInfoCache();
      this.clearBlameCache();
    }
    return true;
  }

  /**
   * Rollback a file to a previous revision using reverse merge.
   * Uses: svn merge -r HEAD:TARGET_REV file
   *
   * This creates local modifications that must be committed separately.
   * Per SVN book: reverse merge undoes changes by merging backwards.
   *
   * @param filePath Absolute path to the file
   * @param targetRevision The revision to rollback to
   * @returns SVN merge output
   */
  public async rollbackToRevision(
    filePath: string,
    targetRevision: string
  ): Promise<string> {
    const relativePath = this.removeAbsolutePath(filePath);
    // Fix peg revision for filenames with @ (e.g., file@2024.txt)
    const safePath = fixPegRevision(relativePath);
    const args = ["merge", "-r", `HEAD:${targetRevision}`, safePath];

    let result;
    try {
      result = await this.exec(args);
    } finally {
      this.resetInfoCache();
      this.clearBlameCache();
    }

    return result.stdout;
  }

  public async revert(files: string[], depth: keyof typeof SvnDepth) {
    files = this.normalizeFilePaths(files);

    // Phase 21.D: Adaptive batching for large file sets
    const { executeBatched } = await import("./util/batchOperations");
    const results = await executeBatched(files, async chunk => {
      return this.exec(["revert", "--depth", depth, ...chunk]);
    });

    // Combine results - return last non-empty stdout
    return results.reverse().find(r => r.stdout)?.stdout || "";
  }

  public async update(
    ignoreExternals: boolean = false,
    options: { token?: CancellationToken; files?: string[] } = {}
  ): Promise<IUpdateResult> {
    const args = ["update"];

    if (ignoreExternals) {
      args.push("--ignore-externals");
    }

    // Target specific files for speed; re-throw all errors (no fallback to full update)
    if (options.files && options.files.length > 0) {
      const normalized = this.normalizeFilePaths(options.files);
      const targetedArgs = [...args, "--parents", ...normalized];
      const result = await this.exec(targetedArgs, { token: options.token });
      this.resetInfoCache();
      return parseUpdateOutput(result.stdout);
    }

    const result = await this.exec(args, { token: options.token });

    this.resetInfoCache();

    return parseUpdateOutput(result.stdout);
  }

  public async pullIncomingChange(path: string): Promise<string> {
    const args = ["update", path];

    const result = await this.exec(args);

    this.resetInfoCache();

    const message = result.stdout.trim().split(/\r?\n/).pop();

    if (message) {
      return message;
    }
    return result.stdout;
  }

  public async patch(files: string[]) {
    files = this.normalizeFilePaths(files);
    const result = await this.exec(["diff", "--internal-diff", ...files]);
    const message = result.stdout;
    return message;
  }

  public async patchBuffer(files: string[]) {
    files = this.normalizeFilePaths(files);
    const result = await this.execBuffer(["diff", "--internal-diff", ...files]);
    const message = result.stdout;
    return message;
  }

  public async patchChangelist(changelistName: string) {
    const result = await this.exec([
      "diff",
      "--internal-diff",
      "--changelist",
      changelistName
    ]);
    const message = result.stdout;
    return message;
  }

  /**
   * Get diff for a specific revision (svn diff -c REV URL)
   * Includes property changes in addition to content changes
   */
  public async patchRevision(revision: string, url: Uri): Promise<string> {
    const fetch = async () => {
      const result = await this.exec([
        "diff",
        "-c",
        revision,
        url.toString(true)
      ]);
      return result.stdout;
    };

    // Numeric revision diffs are immutable - fired on every history-view
    // diff click, so cache them; mutable refs (HEAD/dates) bypass
    if (!/^\d+$/.test(revision)) {
      return fetch();
    }
    return withCachedInFlight(
      `${revision}@${url.toString(true)}`,
      this._patchRevisionCache,
      this._patchRevisionInFlight,
      fetch
    );
  }

  public async removeFiles(files: string[], keepLocal: boolean) {
    files = this.normalizeFilePaths(files);
    const args = ["remove"];

    if (keepLocal) {
      args.push("--keep-local");
    }

    args.push(...files);

    const result = await this.exec(args);

    return result.stdout;
  }

  public async resolve(files: string[], action: string) {
    if (!validateAcceptAction(action)) {
      throw new Error(
        `Invalid resolve action: "${action}". ` +
          `Valid options: base, working, mine-full, theirs-full, mine-conflict, theirs-conflict`
      );
    }

    files = this.normalizeFilePaths(files);

    const result = await this.exec(["resolve", "--accept", action, ...files]);

    return result.stdout;
  }

  public async plainLog(): Promise<string> {
    const result = await this.exec([
      "log",
      "-r",
      "HEAD:1",
      "--limit",
      configuration.logLength().toString()
    ]);

    return result.stdout;
  }

  public async plainLogBuffer(): Promise<Buffer> {
    const result = await this.execBuffer([
      "log",
      "-r",
      "HEAD:1",
      "--limit",
      configuration.logLength().toString()
    ]);

    return result.stdout;
  }

  public async plainLogByRevision(revision: number) {
    const result = await this.exec(["log", "-r", revision.toString()]);

    return result.stdout;
  }

  public async plainLogByRevisionBuffer(revision: number) {
    const result = await this.execBuffer(["log", "-r", revision.toString()]);

    return result.stdout;
  }

  public async plainLogByText(search: string) {
    if (!validateSearchPattern(search)) {
      throw new Error("Invalid search pattern");
    }
    const result = await this.exec(["log", "--search", search]);

    return result.stdout;
  }

  public async plainLogByTextBuffer(search: string) {
    if (!validateSearchPattern(search)) {
      throw new Error("Invalid search pattern");
    }
    const result = await this.execBuffer(["log", "--search", search]);

    return result.stdout;
  }

  public async log(
    rfrom: string,
    rto: string,
    limit: number,
    target?: string | Uri,
    pegRevision?: string
  ): Promise<ISvnLogEntry[]> {
    const targetStr =
      target instanceof Uri ? target.toString(true) : target || "";
    const cacheKey = `log:${targetStr}:${rfrom}:${rto}:${limit}:${pegRevision || ""}`;

    // Check cache
    const cached = this._logCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const args = [
      "log",
      "-r",
      `${rfrom}:${rto}`,
      `--limit=${limit}`,
      "--xml",
      "-v"
    ];
    if (target !== undefined) {
      // Fix: Build peg revision path correctly - escape @ in path, then add peg revision
      let targetPath = fixPegRevision(targetStr);
      if (pegRevision) {
        targetPath += "@" + pegRevision;
      }
      args.push(targetPath);
    }
    const result = await this.exec(args);
    const entries = await parseSvnLog(result.stdout);

    this._logCache.set(cacheKey, entries);
    return entries;
  }

  /**
   * Fetch log entries with filter criteria
   * Uses SVN --search for text filters, -r for date/revision ranges
   * Action filtering is done client-side after fetch
   */
  public async logWithFilter(
    filter: IHistoryFilter,
    limit: number,
    target?: string | Uri
  ): Promise<ISvnLogEntry[]> {
    const targetStr =
      target instanceof Uri ? target.toString(true) : target || "";

    // Build cache key including filter
    const filterKey = JSON.stringify(filter, (_, v) =>
      v instanceof Date ? v.toISOString() : v
    );
    const cacheKey = `logFilter:${targetStr}:${limit}:${filterKey}`;

    // Check cache
    const cached = this._logCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Build base args
    // IMPORTANT: SVN --limit restricts commits SEARCHED, not results returned.
    // So with --search filters, we CANNOT use --limit or we miss matches outside
    // the first N commits. Instead, search full history and limit results client-side.
    const useTextSearch = hasTextSearchFilter(filter);
    const args = useTextSearch
      ? ["log", "--xml", "-v"]
      : ["log", `--limit=${limit}`, "--xml", "-v"];

    // Add filter-based args (--search, -r)
    const filterArgs = buildSvnLogArgs(filter);
    args.push(...filterArgs);

    // If no revision range from filter, default to HEAD:1
    if (
      !filter.revisionFrom &&
      !filter.revisionTo &&
      !filter.dateFrom &&
      !filter.dateTo
    ) {
      args.push("-r", "HEAD:1");
    }

    // Add target if specified
    if (target !== undefined) {
      const targetPath = fixPegRevision(targetStr);
      args.push(targetPath);
    }

    const result = await this.exec(args);
    let entries = await parseSvnLog(result.stdout);

    // Apply client-side action filter (SVN doesn't support server-side action filtering)
    if (filter.actions?.length) {
      entries = filterEntriesByAction(entries, filter.actions);
    }

    // Apply client-side limit for text search (since we didn't use --limit in SVN command)
    if (useTextSearch && entries.length > limit) {
      entries = entries.slice(0, limit);
    }

    this._logCache.set(cacheKey, entries);
    return entries;
  }

  /**
   * Fetch commit messages for multiple revisions in a single batch
   * Optimizes blame message fetching by using revision range instead of N individual calls
   *
   * @param revisions Array of revision numbers (e.g., ["100", "150", "200"])
   * @param target Optional file/directory path to filter log entries
   * @returns Array of log entries matching requested revisions
   *
   * @example
   * const entries = await repository.logBatch(["100", "105", "200"]);
   * // Executes: svn log -r 100:200 --xml -v
   * // Returns: entries for revisions 100, 105, 200 (filters out 101-104, 106-199)
   */
  public async logBatch(
    revisions: string[],
    target?: string | Uri,
    pegRevision?: string
  ): Promise<ISvnLogEntry[]> {
    // Edge case: empty array
    if (revisions.length === 0) {
      return [];
    }

    // Edge case: single revision (use existing log method - also cached)
    if (revisions.length === 1) {
      return this.log(revisions[0]!, revisions[0]!, 1, target, pegRevision);
    }

    // Parse revisions as numbers
    const revNums = revisions.map(r => parseInt(r, 10)).filter(n => !isNaN(n));
    if (revNums.length === 0) {
      return [];
    }

    // Calculate min/max range
    const minRev = Math.min(...revNums);
    const maxRev = Math.max(...revNums);

    const targetStr =
      target instanceof Uri ? target.toString(true) : target || "";
    const cacheKey = `logBatch:${targetStr}:${minRev}:${maxRev}:${pegRevision || ""}`;

    // Check cache - stores full range, filter to requested
    const cached = this._logCache.get(cacheKey);
    if (cached !== undefined) {
      const requestedSet = new Set(revisions);
      return cached.filter(e => requestedSet.has(e.revision));
    }

    // Fetch entire range (trade bandwidth for speed)
    const args = ["log", "-r", `${minRev}:${maxRev}`, "--xml", "-v"];

    if (target !== undefined) {
      // Fix: Build peg revision path correctly - escape @ in path, then add peg revision
      let targetPath = fixPegRevision(targetStr);
      if (pegRevision) {
        targetPath += "@" + pegRevision;
      }
      args.push(targetPath);
    }

    const result = await this.exec(args);
    const allEntries = await parseSvnLog(result.stdout);

    this._logCache.set(cacheKey, allEntries);

    // Filter to only requested revisions (discard intermediate entries)
    const requestedSet = new Set(revisions);
    return allEntries.filter(entry => requestedSet.has(entry.revision));
  }

  public async logByUser(user: string) {
    const result = await this.exec(["log", "--xml", "-v", "--search", user]);

    return parseSvnLog(result.stdout);
  }

  public async cleanup() {
    const result = await this.exec(["cleanup"]);
    this.svn.logOutput(result.stdout);
    this.resetInfoCache();
    return result.stdout;
  }

  /**
   * Remove unversioned files from working copy.
   * WARNING: Permanent deletion, no recovery via SVN.
   * @requires SVN 1.9+
   * @throws Error if SVN version < 1.9
   */
  public async removeUnversioned(): Promise<string> {
    this.requireSvnVersion("1.9.0", "--remove-unversioned");
    const result = await this.exec(["cleanup", "--remove-unversioned"]);
    this.svn.logOutput(result.stdout);
    this.resetInfoCache();
    return result.stdout;
  }

  /**
   * Remove files matching svn:ignore patterns.
   * WARNING: Permanent deletion, no recovery via SVN.
   * @requires SVN 1.9+
   * @throws Error if SVN version < 1.9
   */
  public async removeIgnored(): Promise<string> {
    this.requireSvnVersion("1.9.0", "--remove-ignored");
    const result = await this.exec(["cleanup", "--remove-ignored"]);
    this.svn.logOutput(result.stdout);
    this.resetInfoCache();
    return result.stdout;
  }

  /**
   * Reclaim disk space by removing unreferenced pristine copies.
   * Safe operation - only removes truly unreferenced files.
   * @requires SVN 1.10+
   * @throws Error if SVN version < 1.10
   */
  public async vacuumPristines(): Promise<string> {
    this.requireSvnVersion("1.10.0", "--vacuum-pristines");
    const result = await this.exec(["cleanup", "--vacuum-pristines"]);
    this.svn.logOutput(result.stdout);
    return result.stdout;
  }

  /**
   * Run cleanup with externals support.
   * Processes all svn:externals directories recursively.
   * @requires SVN 1.9+
   * @throws Error if SVN version < 1.9
   */
  public async cleanupWithExternals(): Promise<string> {
    this.requireSvnVersion("1.9.0", "--include-externals");
    const result = await this.exec(["cleanup", "--include-externals"]);
    this.svn.logOutput(result.stdout);
    this.resetInfoCache();
    return result.stdout;
  }

  /**
   * Advanced cleanup with multiple options.
   * Combines multiple cleanup operations in single SVN call.
   *
   * Note: Timestamps are always fixed automatically (hardcoded in SVN CLI).
   *
   * @param options Cleanup options to enable
   * @requires SVN 1.9+ for most options, 1.10+ for vacuumPristines
   * @throws Error if version requirements not met
   */
  public async cleanupAdvanced(options: ICleanupOptions): Promise<string> {
    // Version checks
    const needs19 =
      options.removeUnversioned ||
      options.removeIgnored ||
      options.includeExternals;
    if (needs19) {
      this.requireSvnVersion("1.9.0", "Cleanup options");
    }
    if (options.vacuumPristines) {
      this.requireSvnVersion("1.10.0", "--vacuum-pristines");
    }

    const args = ["cleanup"];
    const hasOptions =
      options.vacuumPristines ||
      options.removeUnversioned ||
      options.removeIgnored ||
      options.includeExternals;

    if (options.vacuumPristines) {
      args.push("--vacuum-pristines");
    }
    if (options.removeUnversioned) {
      args.push("--remove-unversioned");
    }
    if (options.removeIgnored) {
      args.push("--remove-ignored");
    }
    if (options.includeExternals) {
      args.push("--include-externals");
    }

    try {
      const result = await this.exec(args);
      this.svn.logOutput(result.stdout);

      // Always invalidate — cleanup changes lock state, timestamps, etc.
      this.resetInfoCache();

      return result.stdout;
    } catch (err) {
      // Working copy locked — auto-retry: plain cleanup to clear lock, then retry
      const error = err as { svnErrorCode?: string; stderr?: string };
      const stderr = (error.stderr ?? "").toLowerCase();
      const isLocked =
        error.svnErrorCode === "E155037" ||
        error.svnErrorCode === "E155004" ||
        stderr.includes("e155037") ||
        stderr.includes("e155004");
      if (isLocked && hasOptions) {
        // Clear the lock with plain cleanup
        try {
          await this.exec(["cleanup"]);
        } catch (cleanupErr) {
          logError("Auto-retry cleanup failed to clear lock", cleanupErr);
          throw err; // Rethrow original error — caller handles it
        }

        // Retry with original options
        const result = await this.exec(args);
        this.svn.logOutput(result.stdout);
        this.resetInfoCache();

        return result.stdout;
      }
      throw err;
    }
  }

  public async finishCheckout() {
    const info = await this.getInfo();

    const result = await this.exec(["switch", info.url]);

    return result.stdout;
  }

  public async list(folder?: string): Promise<ISvnListItem[]> {
    let url = await this.getRepoUrl();

    if (folder) {
      // Convert Windows backslashes to forward slashes for URL
      const urlPath = folder.replace(/\\/g, "/");
      url += "/" + urlPath;
    }

    return withCachedInFlight(
      url,
      this._listCache,
      this._listInFlight,
      async () => {
        const result = await this.exec(["list", url, "--xml"]);
        return parseSvnList(result.stdout);
      }
    );
  }

  /**
   * List folder contents recursively (for folder size/count estimation).
   * @param folder Relative folder path
   * @param timeout Optional timeout in ms for large folders
   * @returns All files/dirs in folder tree
   */
  public async listRecursive(
    folder: string,
    timeout?: number
  ): Promise<ISvnListItem[]> {
    let url = await this.getRepoUrl();

    // Convert Windows backslashes to forward slashes for URL
    const urlPath = folder.replace(/\\/g, "/");
    url += "/" + urlPath;

    const result = await this.exec(
      ["list", url, "--xml", "--depth", "infinity"],
      timeout ? { timeout } : {}
    );

    return parseSvnList(result.stdout);
  }

  public async ls(file: string): Promise<ISvnListItem[]> {
    const result = await this.exec(["list", file, "--xml"]);

    return parseSvnList(result.stdout);
  }

  // ========== svn:ignore property methods ==========

  /**
   * Get svn:ignore patterns for a directory.
   * Returns empty array if property not set (W200017 handled gracefully).
   */
  public async getCurrentIgnore(directory: string): Promise<string[]> {
    const normalized = this.removeAbsolutePath(directory);
    const value = await this.getIgnorePropertyValue(normalized);
    return value ? value.split(/[\r\n]+/).filter(p => p.trim()) : [];
  }

  /**
   * Get raw svn:ignore property value with W200017 handling.
   * @returns Property value or null if not set
   */
  private async getIgnorePropertyValue(
    directory: string
  ): Promise<string | null> {
    try {
      const result = await this.getProperty("svn:ignore", directory || ".");
      return result;
    } catch (error) {
      // W200017 = "Property 'svn:ignore' not found" - expected when no patterns set
      if (!String(error).includes("W200017")) {
        logError(`Failed to get svn:ignore for ${directory || "."}`, error);
      }
      return null;
    }
  }

  /**
   * Modify svn:ignore patterns atomically (read-modify-write).
   * If updateFn returns empty array, deletes the property.
   *
   * WARNING: Non-atomic read-modify-write. Concurrent modifications may be lost.
   */
  private async modifyIgnorePatterns(
    directory: string,
    updateFn: (patterns: string[]) => string[]
  ): Promise<void> {
    const normalized = this.removeAbsolutePath(directory);
    const current = await this.getCurrentIgnore(directory);
    const updated = updateFn(current);

    if (updated.length === 0) {
      await this.deleteProperty("svn:ignore", normalized || ".");
    } else {
      const value = [...new Set(updated)].sort().join("\n");
      await this.setProperty("svn:ignore", value, normalized || ".");
    }
  }

  public async addToIgnore(
    expressions: string[],
    directory: string,
    recursive: boolean = false
  ): Promise<string> {
    const normalized = this.removeAbsolutePath(directory);

    if (recursive) {
      // Recursive mode uses raw exec (setProperty doesn't support --recursive flag position)
      const ignores = await this.getCurrentIgnore(directory);
      ignores.push(...expressions);
      const newIgnore = [...new Set(ignores)]
        .filter(v => !!v)
        .sort()
        .join("\n");
      const args = ["propset", "svn:ignore", newIgnore];
      this.pushDirTarget(args, normalized);
      args.push("--recursive");
      const result = await this.exec(args);
      return result.stdout;
    }

    await this.modifyIgnorePatterns(directory, patterns => [
      ...patterns,
      ...expressions
    ]);
    return "";
  }

  /**
   * Remove a pattern from svn:ignore property.
   * If the pattern is the last one, deletes the property entirely.
   */
  public async removeFromIgnore(
    expression: string,
    directory: string
  ): Promise<void> {
    await this.modifyIgnorePatterns(directory, patterns =>
      patterns.filter(p => p !== expression)
    );
  }

  /**
   * Delete the svn:ignore property from a directory.
   */
  public async deleteIgnoreProperty(directory: string): Promise<void> {
    const normalized = this.removeAbsolutePath(directory);
    await this.deleteProperty("svn:ignore", normalized || ".");
  }

  /**
   * Set the svn:ignore property to specific patterns.
   */
  public async setIgnoreProperty(
    patterns: string[],
    directory: string
  ): Promise<void> {
    const normalized = this.removeAbsolutePath(directory);
    const value = patterns.sort().join("\n");
    await this.setProperty("svn:ignore", value, normalized || ".");
  }

  /**
   * Get all svn:ignore patterns recursively from the repository.
   * Returns a Map of directory path to array of patterns.
   * Uses XML output for reliable parsing (handles dirs with special chars).
   */
  public async getAllIgnorePatterns(): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();

    try {
      const execResult = await this.exec([
        "propget",
        "svn:ignore",
        "-R",
        "--xml",
        fixPegRevision(".")
      ]);
      const output = execResult.stdout;

      if (!output || output.trim().length === 0) {
        return result;
      }

      // Parse XML output format:
      // <properties>
      //   <target path="dir1">
      //     <property name="svn:ignore">pattern1\npattern2</property>
      //   </target>
      // </properties>
      const { XmlParserAdapter } = await import("./parser/xmlParserAdapter");
      const parsed = XmlParserAdapter.parse(output, {
        mergeAttrs: true,
        explicitRoot: false,
        explicitArray: false,
        camelcase: true
      });

      // Handle single target vs multiple targets
      const targets = parsed?.target
        ? Array.isArray(parsed.target)
          ? parsed.target
          : [parsed.target]
        : [];

      for (const target of targets) {
        const targetPath = target?.path || ".";
        const property = target?.property;
        if (property) {
          // Property value contains newline-separated patterns
          const propValue =
            typeof property === "string" ? property : property?._ || "";
          const patterns = propValue
            .split(/\r?\n/)
            .map((p: string) => p.trim())
            .filter((p: string) => p.length > 0);
          if (patterns.length > 0) {
            result.set(targetPath, patterns);
          }
        }
      }
    } catch (error) {
      logError("Failed to get all ignore patterns", error);
    }

    return result;
  }

  public async rename(oldName: string, newName: string): Promise<string> {
    oldName = this.removeAbsolutePath(oldName);
    newName = this.removeAbsolutePath(newName);
    const args = ["rename", oldName, newName];

    const result = await this.exec(args);

    return result.stdout;
  }

  /**
   * Lock files or directories to prevent concurrent modifications.
   * Supports both files and directories.
   *
   * @param files Array of file/directory paths to lock
   * @param options Lock options (comment, force)
   * @returns SVN lock output
   */
  public async lock(
    files: string[],
    options: ILockOptions = {}
  ): Promise<IExecutionResult> {
    files = this.normalizeFilePaths(files);
    this.validateFilePaths(files);

    // Validate comment to prevent command injection
    if (options.comment && !validateLockComment(options.comment)) {
      throw new Error("Invalid characters in lock comment");
    }

    const args = ["lock"];

    if (options.comment) {
      args.push("--message", options.comment);
    }

    if (options.force) {
      args.push("--force");
    }

    args.push(...files);

    return this.exec(args);
  }

  /**
   * Unlock files or directories.
   * Use force option to break locks owned by other users.
   *
   * @param files Array of file/directory paths to unlock
   * @param options Unlock options (force to break others' locks)
   * @returns SVN unlock output
   */
  public async unlock(
    files: string[],
    options: IUnlockOptions = {}
  ): Promise<IExecutionResult> {
    files = this.normalizeFilePaths(files);
    this.validateFilePaths(files);

    const args = ["unlock"];

    if (options.force) {
      args.push("--force");
    }

    args.push(...files);

    return this.exec(args);
  }

  /**
   * Get lock information for a file or directory.
   * Returns null if the path is not locked.
   *
   * @param filePath Path to check for lock
   * @returns Lock info or null if not locked
   */
  public async getLockInfo(filePath: string): Promise<ISvnLockInfo | null> {
    filePath = this.removeAbsolutePath(filePath);

    try {
      const result = await this.exec([
        "info",
        "--xml",
        fixPegRevision(filePath)
      ]);
      return parseLockInfo(result.stdout);
    } catch (err) {
      logError(`Failed to get lock info for ${filePath}`, err);
      return null;
    }
  }

  /**
   * Get lock information for multiple URLs in a single SVN call.
   * Efficient batch operation for checking locks on remote files.
   *
   * @param urls Array of repository URLs to check
   * @returns Map from URL to lock info (null if not locked)
   */
  public async getBatchLockInfo(
    urls: string[]
  ): Promise<Map<string, ISvnLockInfo | null>> {
    if (urls.length === 0) {
      return new Map();
    }

    try {
      // svn info can take multiple URLs at once
      const args = ["info", "--xml", ...urls.map(u => fixPegRevision(u))];
      const result = await this.exec(args);
      return parseBatchLockInfo(result.stdout);
    } catch (err) {
      logError("Failed to get batch lock info", err);
      return new Map();
    }
  }

  /**
   * Set the depth of a working copy folder for sparse checkouts.
   * Use this to exclude large directories or selectively include content.
   *
   * @param folderPath Path to the folder
   * @param depth One of: exclude, empty, files, immediates, infinity
   * @returns SVN update output
   */
  public async setDepth(
    folderPath: string,
    depth: keyof typeof SvnDepth,
    options?: { parents?: boolean; timeout?: number }
  ): Promise<IExecutionResult> {
    // Validate depth is a valid SvnDepth key
    const validDepths = Object.keys(SvnDepth);
    if (!validDepths.includes(depth)) {
      throw new Error(`Invalid depth: ${depth}`);
    }

    folderPath = this.removeAbsolutePath(folderPath);

    // Validate path to prevent path traversal
    if (!validateFilePath(folderPath)) {
      throw new Error(`Invalid folder path: ${folderPath}`);
    }

    const args = ["update", "--set-depth", depth];

    // Add --parents to restore items in excluded parent folders
    if (options?.parents) {
      args.push("--parents");
    }

    args.push(folderPath);

    // Pass timeout option for long-running downloads
    return this.exec(
      args,
      options?.timeout ? { timeout: options.timeout } : {}
    );
  }

  /**
   * Check if a file has the svn:needs-lock property set.
   * Files with this property are read-only until locked.
   */
  public async hasNeedsLock(filePath: string): Promise<boolean> {
    const value = await this.getProperty("svn:needs-lock", filePath);
    return value !== null;
  }

  /**
   * Set the svn:needs-lock property on a file.
   * This makes the file read-only until locked.
   */
  public async setNeedsLock(filePath: string): Promise<IExecutionResult> {
    // Value doesn't matter - SVN just checks property presence
    // Using 'yes' instead of '*' to avoid glob expansion on Windows
    return this.setProperty("svn:needs-lock", "yes", filePath);
  }

  /**
   * Remove the svn:needs-lock property from a file.
   */
  public async removeNeedsLock(filePath: string): Promise<IExecutionResult> {
    return this.deleteProperty("svn:needs-lock", filePath);
  }

  /**
   * Get list of property names on a file.
   * Returns array of property names (e.g., ["svn:needs-lock", "svn:executable"]).
   */
  public async getPropertyList(filePath: string): Promise<string[]> {
    const normalized = this.validatePath(filePath);
    try {
      const result = await this.exec(["proplist", normalized]);
      const props: string[] = [];
      // Output format: "Properties on 'file.txt':" followed by property names
      for (const line of result.stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("Properties on")) {
          props.push(trimmed);
        }
      }
      return props;
    } catch {
      return [];
    }
  }

  /**
   * Get property changes for a file (which properties changed and how).
   * Uses `svn diff --properties-only` to detect added/deleted/modified properties.
   * Cache + in-flight dedup keyed by normalized path. The status refresh flow
   * fetches this per-file for every file with prop changes; without a cache,
   * N files would mean N spawn/parse cycles per refresh.
   */
  public async getPropertyChanges(filePath: string): Promise<PropertyChange[]> {
    const normalized = this.validatePath(filePath);
    return withCachedInFlight(
      normalized,
      this._propertyChangesCache,
      this._propertyChangesInFlight,
      async () => {
        try {
          const result = await this.exec([
            "diff",
            "--properties-only",
            normalized
          ]);
          return this.parsePropertyDiff(result.stdout);
        } catch {
          return [];
        }
      }
    );
  }

  /** Clear the property-changes cache (called on forceRefresh). */
  public clearPropertyChangesCache(): void {
    this._propertyChangesCache.clear();
  }

  /**
   * Parse `svn diff --properties-only` output to extract property changes.
   * Output format:
   * ```
   * Property changes on: file.txt
   * ___________________________________________________________________
   * Added: svn:needs-lock
   * ## -0,0 +1 ##
   * +*
   * Deleted: svn:executable
   * Modified: svn:ignore
   * ## -1 +1,2 ##
   * ...
   * ```
   */
  private parsePropertyDiff(output: string): PropertyChange[] {
    const changes: PropertyChange[] = [];
    // Match lines like "Added: svn:needs-lock", "Deleted: svn:ignore", "Modified: svn:executable"
    const regex = /^(Added|Deleted|Modified):\s+(.+)$/gm;
    let match;

    while ((match = regex.exec(output)) !== null) {
      if (match[1] && match[2]) {
        const changeType = match[1].toLowerCase() as
          | "added"
          | "deleted"
          | "modified";
        const name = match[2].trim();
        changes.push({ name, changeType });
      }
    }

    return changes;
  }

  /**
   * Get all files with svn:needs-lock property in the working copy.
   * Returns relative paths from working copy root.
   */
  public async getAllNeedsLockFiles(): Promise<Set<string>> {
    const map = await this.getAllPropertyValues("svn:needs-lock");
    return new Set(map.keys());
  }

  // ========== svn:eol-style property methods ==========

  /**
   * Get svn:eol-style property value for a file.
   * @returns "native" | "LF" | "CRLF" | "CR" | null (if not set)
   */
  public async getEolStyle(filePath: string): Promise<string | null> {
    return this.getProperty("svn:eol-style", filePath);
  }

  /**
   * Set svn:eol-style property on a file or directory.
   * @param filePath Path to file or directory
   * @param value One of: native, LF, CRLF, CR
   * @param recursive If true and path is directory, apply recursively
   */
  public async setEolStyle(
    filePath: string,
    value: "native" | "LF" | "CRLF" | "CR",
    recursive = false
  ): Promise<IExecutionResult> {
    return this.setProperty("svn:eol-style", value, filePath, recursive);
  }

  /**
   * Remove svn:eol-style property from a file or directory.
   */
  public async removeEolStyle(
    filePath: string,
    recursive = false
  ): Promise<IExecutionResult> {
    return this.deleteProperty("svn:eol-style", filePath, recursive);
  }

  /**
   * Get all files with svn:eol-style property in working copy.
   * @returns Map of relative path -> eol-style value
   */
  public async getAllEolStyleFiles(): Promise<Map<string, string>> {
    return this.getAllPropertyValues("svn:eol-style");
  }

  // ========== svn:mime-type property methods ==========

  /**
   * Get svn:mime-type property value for a file.
   * @returns MIME type string or null if not set
   */
  public async getMimeType(filePath: string): Promise<string | null> {
    return this.getProperty("svn:mime-type", filePath);
  }

  /**
   * Set svn:mime-type property on a file.
   * @param filePath Path to file
   * @param value MIME type (e.g., "text/plain", "application/octet-stream")
   */
  public async setMimeType(
    filePath: string,
    value: string
  ): Promise<IExecutionResult> {
    return this.setProperty("svn:mime-type", value, filePath);
  }

  /**
   * Remove svn:mime-type property from a file.
   */
  public async removeMimeType(filePath: string): Promise<IExecutionResult> {
    return this.deleteProperty("svn:mime-type", filePath);
  }

  /**
   * Get all files with svn:mime-type property in working copy.
   * @returns Map of relative path -> mime-type value
   */
  public async getAllMimeTypeFiles(): Promise<Map<string, string>> {
    return this.getAllPropertyValues("svn:mime-type");
  }

  // ========== svn:auto-props property methods ==========

  /**
   * Get svn:auto-props property from repository root directory.
   * @returns Auto-props configuration string or null if not set
   */
  public async getAutoProps(): Promise<string | null> {
    return this.getProperty("svn:auto-props", ".");
  }

  /**
   * Set svn:auto-props property on repository root directory.
   * Format: "*.txt = svn:eol-style=native\n*.png = svn:mime-type=image/png"
   */
  public async setAutoProps(value: string): Promise<IExecutionResult> {
    return this.setProperty("svn:auto-props", value, ".");
  }

  /**
   * Remove svn:auto-props property from repository root directory.
   */
  public async removeAutoProps(): Promise<IExecutionResult> {
    return this.deleteProperty("svn:auto-props", ".");
  }

  /** Clear all caches (call on repository disposal). */
  public clearInfoCacheTimers(): void {
    this._infoCache.clear();
    // Delegate so the generation bump also blocks in-flight write-backs
    this.clearBlameCache();
    this._logCache.clear();
    this._listCache.clear();
    this._catCache.clear();
    this._catInFlight.clear();
    this._listInFlight.clear();
    this._copyPointCache.clear();
    this._patchRevisionCache.clear();
    this._patchRevisionInFlight.clear();
  }
}
