// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { Disposable, Uri, workspace } from "vscode";
import {
  IFileStatus,
  LockStatus,
  PropertyChange,
  PropStatus,
  Status
} from "../common/types";
import { configuration } from "../helpers/configuration";
import { stat } from "../fs";
import { Resource } from "../resource";
import { Repository as BaseRepository } from "../svnRepository";
import { isDescendant } from "../util";
import { chunkArray } from "../util/batchOperations";
import { matchAll } from "../util/globMatch";
import * as path from "path";

/**
 * Result from status update operation
 */
/**
 * Lock info for a file (for cache population)
 */
export type LockInfo = {
  readonly lockStatus: LockStatus;
  readonly lockOwner?: string;
  readonly hasLockToken: boolean;
};

export type StatusResult = {
  readonly changes: Resource[];
  readonly conflicts: Resource[];
  readonly unversioned: Resource[];
  readonly changelists: ReadonlyMap<string, Resource[]>;
  readonly remoteChanges: Resource[];
  readonly statusExternal: readonly IFileStatus[];
  /** Raw svn:externals paths before same-repository UI combining. */
  readonly externalWorkingCopyPaths: readonly string[];
  readonly ignored: Resource[];
  readonly isIncomplete: boolean;
  readonly needCleanUp: boolean;
  /** Lock statuses for all locked files (by relative path) */
  readonly lockStatuses: ReadonlyMap<string, LockInfo>;
};

/**
 * Options for status update operation
 */
export type StatusUpdateOptions = {
  readonly checkRemoteChanges: boolean;
  readonly fetchLockStatus?: boolean;
};

/**
 * Configuration values extracted for status processing
 */
type StatusConfig = {
  readonly combineExternal: boolean;
  readonly hideUnversioned: boolean;
  readonly ignoreList: readonly string[];
  readonly ignoreOnStatusCountList: readonly string[];
  readonly countUnversioned: boolean;
  readonly filesExclude: Record<string, boolean>;
};

/**
 * Service responsible for status parsing and resource categorization.
 * Extracts logic from Repository.updateModelState() (lines 451-711).
 *
 * Responsibilities:
 * - Execute SVN status command
 * - Parse status results
 * - Categorize resources into groups
 * - Apply filtering rules (ignore patterns, exclusions)
 * - Handle externals and remote changes
 *
 * Does NOT:
 * - Manage VS Code resource groups (UI concern)
 * - Emit events (Repository concern)
 * - Update status bar (UI concern)
 * - Handle authentication (Repository concern)
 */
export interface IStatusService {
  /**
   * Update repository status and categorize resources
   * @param options Options including whether to check remote changes
   * @returns Categorized resources and metadata
   */
  updateStatus(options: StatusUpdateOptions): Promise<StatusResult>;
}

/**
 * Implementation of status service
 */
export class StatusService implements IStatusService {
  private _configCache: StatusConfig | undefined;
  private readonly _configChangeDisposable: Disposable;

  constructor(
    private readonly repository: BaseRepository,
    private readonly workspaceRoot: string,
    private readonly root: string
  ) {
    // Invalidate cache only for relevant config keys
    this._configChangeDisposable = configuration.onDidChange(e => {
      if (
        e.affectsConfiguration("sven.sourceControl") ||
        e.affectsConfiguration("files.exclude")
      ) {
        this._configCache = undefined;
      }
    });
  }

  async updateStatus(options: StatusUpdateOptions): Promise<StatusResult> {
    const config = this.getConfiguration();

    // Fetch statuses from SVN
    const statuses = await this.fetchStatuses(
      config.combineExternal,
      options.checkRemoteChanges,
      options.fetchLockStatus
    );

    // Get file exclusion patterns
    const excludeList = this.buildExcludeList(config.filesExclude);

    // Separate external statuses
    const externalWorkingCopyPaths = statuses
      .filter(status => status.status === Status.EXTERNAL)
      .map(status => status.path);
    const { statusExternal, statusesRepository } = await this.separateExternals(
      statuses,
      config.combineExternal
    );

    // Categorize resources
    const categorized = await this.categorizeStatuses(
      statusesRepository,
      excludeList
    );

    return {
      changes: categorized.changes,
      conflicts: categorized.conflicts,
      unversioned: categorized.unversioned,
      changelists: categorized.changelists,
      remoteChanges: categorized.remoteChanges,
      statusExternal,
      externalWorkingCopyPaths,
      ignored: categorized.ignored,
      isIncomplete: categorized.isIncomplete,
      needCleanUp: categorized.needCleanUp,
      lockStatuses: categorized.lockStatuses
    };
  }

  /**
   * Get configuration values needed for status processing
   * Cached for performance (Phase 8.1 fix - prevents 1-10x/sec workspace.getConfiguration calls)
   */
  private getConfiguration(): StatusConfig {
    if (this._configCache) {
      return this._configCache;
    }

    const fileConfig = workspace.getConfiguration("files", Uri.file(this.root));
    const filesExclude =
      fileConfig.get<Record<string, boolean>>("exclude") ?? {};

    this._configCache = {
      combineExternal: configuration.get<boolean>(
        "sourceControl.combineExternalIfSameServer",
        false
      ),
      hideUnversioned: configuration.get<boolean>(
        "sourceControl.hideUnversioned",
        false
      ),
      ignoreList: configuration.get<string[]>("sourceControl.ignore", []),
      ignoreOnStatusCountList: configuration.get<string[]>(
        "sourceControl.ignoreOnStatusCount",
        []
      ),
      countUnversioned: configuration.get<boolean>(
        "sourceControl.countUnversioned",
        false
      ),
      filesExclude
    };

    return this._configCache;
  }

  /**
   * Fetch statuses from SVN repository
   */
  private async fetchStatuses(
    includeExternals: boolean,
    checkRemoteChanges: boolean,
    fetchLockStatus?: boolean
  ): Promise<IFileStatus[]> {
    return await this.repository.getStatus({
      includeIgnored: true,
      includeExternals,
      checkRemoteChanges,
      fetchLockStatus,
      // Only fetch external UUIDs when combineExternal=true (needed to filter by repo)
      // Skips N sequential svn info calls when combineExternal=false (default)
      fetchExternalUuids: includeExternals
    });
  }

  /**
   * Build exclusion pattern list from files.exclude config
   */
  private buildExcludeList(filesExclude: Record<string, boolean>): string[] {
    const excludeList: string[] = [];

    for (const pattern in filesExclude) {
      if (Object.hasOwn(filesExclude, pattern)) {
        const negate = !filesExclude[pattern];
        excludeList.push((negate ? "!" : "") + pattern);
      }
    }

    return excludeList;
  }

  /**
   * Separate external statuses from repository statuses
   */
  private async separateExternals(
    statuses: IFileStatus[],
    combineExternal: boolean
  ): Promise<{
    statusExternal: IFileStatus[];
    statusesRepository: IFileStatus[];
  }> {
    let statusExternal = statuses.filter(
      status => status.status === Status.EXTERNAL
    );

    // Filter externals by repository UUID if combining
    if (combineExternal && statusExternal.length) {
      const repositoryUuid = await this.repository.getRepositoryUuid();
      statusExternal = statusExternal.filter(
        status => repositoryUuid !== status.repositoryUuid
      );
    }

    // Phase 21.B fix - O(e×n) → O(n) single-pass descendant lookup
    // Build Set of external paths for O(1) membership check
    const externalPaths = new Set<string>();
    for (const external of statusExternal) {
      externalPaths.add(external.path);
    }

    // Single pass through statuses, check against all externals
    const descendantPaths = new Set<string>();
    for (const status of statuses) {
      if (status.status === Status.EXTERNAL) {
        continue;
      }

      // Check if this status is descendant of ANY external
      for (const externalPath of externalPaths) {
        if (isDescendant(externalPath, status.path)) {
          descendantPaths.add(status.path);
          break; // No need to check other externals
        }
      }
    }

    // Filter out external paths and their descendants
    const statusesRepository = statuses.filter(status => {
      if (status.status === Status.EXTERNAL) {
        return false;
      }
      return !descendantPaths.has(status.path);
    });

    return { statusExternal, statusesRepository };
  }

  /**
   * Categorize statuses into resource groups
   * (ignoreList filtering moved to ResourceGroupManager, so config no longer needed)
   */
  private async categorizeStatuses(
    statuses: IFileStatus[],
    excludeList: string[]
  ): Promise<{
    changes: Resource[];
    conflicts: Resource[];
    unversioned: Resource[];
    changelists: Map<string, Resource[]>;
    remoteChanges: Resource[];
    ignored: Resource[];
    isIncomplete: boolean;
    needCleanUp: boolean;
    lockStatuses: Map<string, LockInfo>;
  }> {
    const changes: Resource[] = [];
    const conflicts: Resource[] = [];
    const unversioned: Resource[] = [];
    const changelists = new Map<string, Resource[]>();
    const remoteChanges: Resource[] = [];
    const ignored: Resource[] = [];
    const lockStatuses = new Map<string, LockInfo>();
    let isIncomplete = false;
    let needCleanUp = false;

    // Phase 13 perf fix - O(n) → O(1) conflict path lookup
    const conflictPaths = new Set<string>();
    for (const status of statuses) {
      if (status.status === Status.CONFLICTED) {
        conflictPaths.add(status.path);
      }
    }

    // Pre-fetch property changes for files with property modifications
    const propertyChangesMap = await this.fetchPropertyChanges(statuses);

    for (const status of statuses) {
      // Check for incomplete/WC-admin-locked status on root
      if (status.path === ".") {
        isIncomplete = status.status === Status.INCOMPLETE;
        // WC admin lock (from wc-locked attr) means cleanup needed, not user lock
        needCleanUp = !!status.wcStatus.wcAdminLocked;
      }

      // If exists a switched item, the repository is incomplete
      if (status.wcStatus.switched) {
        isIncomplete = true;
      }

      // Skip WC-admin-locked/switched/incomplete items (but NOT user-locked files)
      // wcAdminLocked = WC admin lock from interrupted checkout, needs cleanup
      // locked = user lock (K/O/B/T), should NOT be skipped
      if (
        status.wcStatus.wcAdminLocked ||
        status.wcStatus.switched ||
        status.status === Status.INCOMPLETE
      ) {
        continue;
      }

      // Skip excluded files
      if (matchAll(status.path, excludeList, { dot: true })) {
        continue;
      }

      const uri = Uri.file(path.join(this.workspaceRoot, status.path));
      const renameUri = status.rename
        ? Uri.file(path.join(this.workspaceRoot, status.rename))
        : undefined;

      // Handle remote changes (skip if only lock-related, no content changes)
      if (status.reposStatus) {
        const remoteItem = status.reposStatus.item;
        const remoteProps = status.reposStatus.props;
        const hasRemoteContentChanges =
          (remoteItem &&
            remoteItem !== Status.NONE &&
            remoteItem !== Status.NORMAL) ||
          (remoteProps &&
            remoteProps !== Status.NONE &&
            remoteProps !== Status.NORMAL);

        if (hasRemoteContentChanges) {
          remoteChanges.push(
            new Resource(uri, remoteItem, undefined, remoteProps, true)
          );
        }
      }

      // Detect T (stolen) lock: we have token but server shows different owner
      let lockStatus = status.wcStatus.lockStatus;

      if (
        lockStatus === LockStatus.K &&
        status.wcStatus.hasLockToken &&
        status.wcStatus.lockOwner &&
        this.repository.username &&
        status.wcStatus.lockOwner !== this.repository.username
      ) {
        lockStatus = LockStatus.T;
      }

      // Collect lock statuses for cache (BEFORE skip check)
      if (lockStatus) {
        lockStatuses.set(status.path, {
          lockStatus,
          lockOwner: status.wcStatus.lockOwner,
          hasLockToken: status.wcStatus.hasLockToken ?? false
        });
      }

      // Detect kind if not provided by SVN status
      let kind = status.kind;
      if (!kind) {
        try {
          const stats = await stat(uri.fsPath);
          kind = stats.isDirectory() ? "dir" : "file";
        } catch {
          // If stat fails, assume file
          kind = "file";
        }
      }

      // For DELETED items, check if local file still exists
      // (distinguishes "untracked" from "truly deleted")
      let localFileExists: boolean | undefined;
      if (status.status === Status.DELETED) {
        try {
          await stat(uri.fsPath);
          localFileExists = true;
        } catch {
          localFileExists = false;
        }
      }

      // Get property changes from pre-fetched map
      const propertyChanges = propertyChangesMap.get(status.path);

      const resource = new Resource(
        uri,
        status.status,
        renameUri,
        status.props,
        false, // not remote
        status.wcStatus.locked,
        status.wcStatus.lockOwner,
        status.wcStatus.hasLockToken,
        lockStatus,
        status.changelist,
        kind,
        localFileExists,
        propertyChanges
      );

      // Skip normal/unchanged items (locked-only files get decorator from cache)
      const isNormal =
        status.status === Status.NORMAL || status.status === Status.NONE;
      const propsNormal =
        status.props === PropStatus.NORMAL || status.props === PropStatus.NONE;
      const noChangelist = !status.changelist;
      // Skip locked-only files (no content changes) - lock is already on server
      // Lock badge is shown via lockStatusCache, not resource group
      const willSkip = isNormal && propsNormal && noChangelist;

      if (willSkip) {
        continue;
      } else if (status.status === Status.IGNORED) {
        ignored.push(resource);
      } else if (status.status === Status.CONFLICTED) {
        conflicts.push(resource);
      } else if (status.status === Status.UNVERSIONED) {
        // Skip conflict-related files (*.mine, *.r123, etc) - Phase 13 perf fix
        const matches = status.path.match(
          /(.+?)\.(mine|working|merge-\w+\.r\d+|r\d+)$/
        );
        if (matches && matches[1] && conflictPaths.has(matches[1])) {
          continue;
        }

        // Note: ignoreList filtering moved to ResourceGroupManager for UI only
        // All unversioned files are returned for resource index (enables pre-checks)
        unversioned.push(resource);
      } else if (status.changelist) {
        // Add to changelist group
        let changelist = changelists.get(status.changelist);
        if (!changelist) {
          changelist = [];
        }
        changelist.push(resource);
        changelists.set(status.changelist, changelist);
      } else {
        changes.push(resource);
      }
    }

    return {
      changes,
      conflicts,
      unversioned,
      changelists,
      remoteChanges,
      ignored,
      isIncomplete,
      needCleanUp,
      lockStatuses
    };
  }

  /**
   * Fetch property changes for files with property modifications.
   * Returns a Map of path → PropertyChange[] for efficient lookup.
   * Uses concurrent fetching with limit to avoid spawning too many SVN processes.
   */
  private async fetchPropertyChanges(
    statuses: IFileStatus[]
  ): Promise<Map<string, PropertyChange[]>> {
    const result = new Map<string, PropertyChange[]>();

    // Find files with property changes (not none/normal)
    const filesWithPropChanges = statuses.filter(
      s =>
        s.props &&
        s.props !== PropStatus.NONE &&
        s.props !== PropStatus.NORMAL &&
        s.status !== Status.UNVERSIONED // Unversioned files can't have prop changes
    );

    if (filesWithPropChanges.length === 0) {
      return result;
    }

    // Fetch property changes concurrently (limit to 5 parallel)
    const chunks = chunkArray(filesWithPropChanges, 5);

    for (const chunk of chunks) {
      const promises = chunk.map(async status => {
        const fullPath = path.join(this.workspaceRoot, status.path);
        const changes = await this.repository.getPropertyChanges(fullPath);
        return { path: status.path, changes };
      });

      const results = await Promise.all(promises);
      for (const { path: filePath, changes } of results) {
        if (changes.length > 0) {
          result.set(filePath, changes);
        }
      }
    }

    return result;
  }

  /**
   * Dispose resources (config change listener)
   */
  dispose(): void {
    this._configChangeDisposable.dispose();
  }
}
