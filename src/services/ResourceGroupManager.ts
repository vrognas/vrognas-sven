// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { Uri } from "vscode";
import type { Disposable, SourceControl } from "vscode";
import { ISvnResourceGroup, LockStatus, Status } from "../common/types";
import { Resource } from "../resource";
import type { StatusResult } from "./StatusService";
import { StagingService, STAGING_CHANGELIST } from "./stagingService";
import { normalizePath, toDisposable } from "../util";
import { matchAll } from "../util/globMatch";
import * as path from "path";

type UnversionedIgnoredIndex = {
  readonly exact: Map<string, Status>;
  readonly folders: Map<string, Status>;
};

function createUnversionedIgnoredIndex(): UnversionedIgnoredIndex {
  return {
    exact: new Map(),
    folders: new Map()
  };
}

/**
 * Configuration for resource group updates
 */
export type ResourceGroupConfig = {
  readonly ignoreOnStatusCountList: readonly string[];
  readonly countUnversioned: boolean;
  readonly hideUnversioned: boolean;
  /** Patterns to filter from UI display (but keep in index for pre-checks) */
  readonly ignoreList: readonly string[];
  /** Workspace root for computing relative paths */
  readonly workspaceRoot: string;
};

/**
 * Combined data for resource group updates
 */
export type ResourceGroupUpdateData = {
  readonly result: StatusResult;
  readonly config: ResourceGroupConfig;
  /** If true, lock status in result is fresh (from --show-updates), don't preserve old status */
  readonly lockStatusFresh?: boolean;
};

/**
 * Manages VS Code source control resource groups.
 */
export class ResourceGroupManager {
  private _staged: ISvnResourceGroup;
  private _changes: ISvnResourceGroup;
  private _conflicts: ISvnResourceGroup;
  private _unversioned: ISvnResourceGroup;
  private _ignored: ISvnResourceGroup;
  private _changelists = new Map<string, ISvnResourceGroup>();
  private _remoteChanges?: ISvnResourceGroup;
  private _disposables: Disposable[] = [];
  private _prevChangelistsSize = 0;
  private _resourceIndex = new Map<string, Resource>(); // Phase 8.1 perf fix - O(1) lookup
  private _unversionedIgnoredIndex = createUnversionedIgnoredIndex();
  private _resourceHash = ""; // Phase 16 perf fix - conditional rebuild
  private _staging: StagingService;
  private _stagedDirectories = new Set<string>(); // Track staged dirs (changelists can't hold them)
  private _allUnversioned: Resource[] = []; // All unversioned (including hidden) for index lookup

  get staged(): ISvnResourceGroup {
    return this._staged;
  }

  get changes(): ISvnResourceGroup {
    return this._changes;
  }

  get conflicts(): ISvnResourceGroup {
    return this._conflicts;
  }

  get unversioned(): ISvnResourceGroup {
    return this._unversioned;
  }

  get ignored(): ISvnResourceGroup {
    return this._ignored;
  }

  get changelists(): ReadonlyMap<string, ISvnResourceGroup> {
    return this._changelists;
  }

  get remoteChanges(): ISvnResourceGroup | undefined {
    return this._remoteChanges;
  }

  get staging(): StagingService {
    return this._staging;
  }

  /**
   * @param sourceControl VS Code SourceControl instance
   * @param parentDisposables Parent's disposable array to register cleanup
   */
  constructor(
    private readonly sourceControl: SourceControl,
    parentDisposables: Disposable[]
  ) {
    // Create staging service (uses SVN changelist for persistence)
    this._staging = new StagingService();

    // Create static groups (order matters for UI display)
    // Staged appears first
    this._staged = this.createGroup("staged", "Staged for Commit");
    this._staged.hideWhenEmpty = true;

    this._changes = this.createGroup("changes", "Changes");
    this._changes.hideWhenEmpty = true;

    this._conflicts = this.createGroup("conflicts", "Conflicts");
    this._conflicts.hideWhenEmpty = true;

    this._unversioned = this.createGroup("unversioned", "Unversioned");
    this._unversioned.hideWhenEmpty = true;

    // Ignored files - hidden from SCM panel but indexed for badges
    this._ignored = this.createGroup("ignored", "Ignored");
    this._ignored.hideWhenEmpty = true;

    // Register with parent for disposal
    this._disposables.push(this._staged, this._changes, this._conflicts);
    this._disposables.push(this._staging);

    // Unversioned and Ignored can be recreated, use toDisposable wrapper
    this._disposables.push(toDisposable(() => this._unversioned.dispose()));
    this._disposables.push(toDisposable(() => this._ignored.dispose()));

    // Remote changes can be recreated and may be undefined
    this._disposables.push(
      toDisposable(() => {
        if (this._remoteChanges) {
          this._remoteChanges.dispose();
        }
      })
    );

    // Add to parent disposables for cleanup
    parentDisposables.push(toDisposable(() => this.dispose()));
  }

  /**
   * Update all resource groups from status result.
   * Returns the total count for source control badge.
   */
  updateGroups(data: ResourceGroupUpdateData): number {
    const { result, config, lockStatusFresh } = data;

    // Preserve lock status from existing resources (lock info is only visible with --show-updates)
    // When status is called without --show-updates, we don't want to lose lock info
    // BUT if lockStatusFresh=true, the current status is authoritative (from --show-updates)
    const preservedLockStatus = new Map<
      string,
      { lockStatus: LockStatus; lockOwner?: string; hasLockToken: boolean }
    >();

    // Only preserve lock status if current call did NOT use --show-updates
    if (!lockStatusFresh) {
      for (const resource of this._resourceIndex.values()) {
        if (resource.lockStatus) {
          const key = normalizePath(resource.resourceUri.fsPath);
          preservedLockStatus.set(key, {
            lockStatus: resource.lockStatus,
            lockOwner: resource.lockOwner,
            hasLockToken: resource.hasLockToken
          });
        }
      }
    }

    // Helper to merge preserved lock status into new resources
    const mergePreservedLockStatus = (resources: Resource[]): Resource[] => {
      if (lockStatusFresh) {
        return resources; // Don't merge if current status is authoritative
      }
      return resources.map(r => {
        if (!r.lockStatus) {
          const key = normalizePath(r.resourceUri.fsPath);
          const preserved = preservedLockStatus.get(key);
          if (preserved) {
            // Copy with preserved lock status; withLock keeps every other
            // field (the old positional clone dropped propertyChanges).
            return r.withLock({
              locked: true,
              lockOwner: preserved.lockOwner,
              hasLockToken: preserved.hasLockToken,
              lockStatus: preserved.lockStatus
            });
          }
        }
        return r;
      });
    };

    // Extract staged files from __staged__ changelist
    const stagedResources = result.changelists.get(STAGING_CHANGELIST) ?? [];

    // Sync staging service cache with SVN changelist data
    this._staging.syncFromChangelist(
      stagedResources.map(r => r.resourceUri.fsPath)
    );

    // Find staged directories in changes/conflicts (changelists can't hold dirs)
    const stagedDirs: Resource[] = [];
    const filterStagedDirs = (resources: Resource[]): Resource[] => {
      return resources.filter(r => {
        const normalizedPath = normalizePath(r.resourceUri.fsPath);
        if (this._stagedDirectories.has(normalizedPath)) {
          stagedDirs.push(r);
          return false; // Remove from original group
        }
        return true;
      });
    };

    // Filter first to populate stagedDirs, then assign groups
    const filteredChanges = filterStagedDirs(result.changes);
    const filteredConflicts = filterStagedDirs(result.conflicts);

    // Clean up staged directories that no longer have status (committed)
    const allResourcePaths = new Set([
      ...result.changes.map(r => normalizePath(r.resourceUri.fsPath)),
      ...result.conflicts.map(r => normalizePath(r.resourceUri.fsPath))
    ]);
    for (const dirPath of this._stagedDirectories) {
      if (!allResourcePaths.has(dirPath)) {
        this._stagedDirectories.delete(dirPath);
      }
    }

    // Update groups, preserving staged directories
    // Apply lock status preservation to all resources
    this._staged.resourceStates = mergePreservedLockStatus([
      ...stagedResources,
      ...stagedDirs
    ]);
    this._changes.resourceStates = mergePreservedLockStatus(filteredChanges);
    this._conflicts.resourceStates =
      mergePreservedLockStatus(filteredConflicts);

    // Clear existing changelist groups
    this._changelists.forEach(group => {
      group.resourceStates = [];
    });

    // Update or create changelist groups (excluding __staged__)
    result.changelists.forEach((resources, changelist) => {
      // Skip staging changelist - handled separately as "Staged for Commit"
      if (changelist === STAGING_CHANGELIST) {
        return;
      }

      let group = this._changelists.get(changelist);
      if (!group) {
        // Prefix 'changelist-' to prevent ID collision with 'changes'
        group = this.createGroup(
          `changelist-${changelist}`,
          `Changelist "${changelist}"`
        );
        group.hideWhenEmpty = true;
        this._disposables.push(group);
        this._changelists.set(changelist, group);
      }

      group.resourceStates = mergePreservedLockStatus(resources);
    });

    // Dispose removed changelists (excluding __staged__ which is never in _changelists)
    const currentChangelists = new Set(
      [...result.changelists.keys()].filter(k => k !== STAGING_CHANGELIST)
    );
    this._changelists.forEach((group, changelist) => {
      if (!currentChangelists.has(changelist)) {
        group.dispose();
        this._changelists.delete(changelist);
      }
    });

    // Recreate unversioned if changelist count changed (for ordering)
    if (this._prevChangelistsSize !== this._changelists.size) {
      this._unversioned.dispose();
      this._unversioned = this.createGroup("unversioned", "Unversioned");
      this._unversioned.hideWhenEmpty = true;
    }

    // Store all unversioned for index lookup (including hidden and ignored-by-pattern)
    this._allUnversioned = mergePreservedLockStatus(result.unversioned);

    // Filter for UI display: hide if hideUnversioned enabled, or matches ignoreList
    if (config.hideUnversioned) {
      this._unversioned.resourceStates = [];
    } else if (config.ignoreList.length > 0) {
      // Filter out files matching ignoreList patterns (for UI only, index keeps all)
      this._unversioned.resourceStates = this._allUnversioned.filter(r => {
        // Compute relative path from workspace root (matches original StatusService logic)
        const relativePath = path.relative(
          config.workspaceRoot,
          r.resourceUri.fsPath
        );
        return !matchAll(path.sep + relativePath, config.ignoreList, {
          dot: true,
          matchBase: true
        });
      });
    } else {
      this._unversioned.resourceStates = this._allUnversioned;
    }

    // Ignored files (for file explorer badges, not shown in SCM panel)
    this._ignored.resourceStates = result.ignored;

    // Recreate or create remote changes group (must be last)
    if (
      !this._remoteChanges ||
      this._prevChangelistsSize !== this._changelists.size
    ) {
      const tempResourceStates: Resource[] =
        this._remoteChanges?.resourceStates ?? [];
      this._remoteChanges?.dispose();

      this._remoteChanges = this.createGroup("remotechanges", "Remote Changes");
      this._remoteChanges.hideWhenEmpty = true;
      this._remoteChanges.resourceStates = tempResourceStates;
    }

    // Always update remote changes (clear when empty)
    this._remoteChanges.resourceStates = result.remoteChanges;

    // Update tracked size
    this._prevChangelistsSize = this._changelists.size;

    // Phase 16 perf fix: Only rebuild index if resources changed
    // Calculate hash of current resource state
    const currentHash = this.calculateResourceHash(result);
    if (currentHash !== this._resourceHash) {
      this.rebuildResourceIndex();
      this._resourceHash = currentHash;
    }

    // Calculate count
    return this.calculateCount(config);
  }

  /**
   * Calculate hash of resource state for change detection (Phase 16 perf fix)
   * Used to skip unnecessary index rebuilds when resources haven't changed
   * Includes file paths to detect renames (same count but different files)
   */
  private calculateResourceHash(result: StatusResult): string {
    // Build hash from resource paths per group (not just counts)
    // This detects renames where count stays same but files differ
    const pathHashes = [
      this.hashPaths(result.changes),
      this.hashPaths(result.conflicts),
      this.hashPaths(result.unversioned),
      this.hashPaths(result.ignored),
      this.hashPaths(result.remoteChanges)
    ];

    // Include changelist names and their path hashes
    const changelistData: string[] = [];
    result.changelists.forEach((resources, name) => {
      changelistData.push(`${name}:${this.hashPaths(resources)}`);
    });

    return `${pathHashes.join("|")}|${changelistData.join(",")}`;
  }

  /**
   * Hash resources including path, type, kind, and lock status.
   * Kind changes rebuild the ancestry index when a file becomes a directory.
   */
  private hashPaths(resources: Resource[]): string {
    const hashes = resources
      .map(
        r =>
          `${r.resourceUri.fsPath}:${r.type}:${r.kind ?? ""}:${r.lockStatus ?? ""}`
      )
      .sort();
    return hashes.join(";");
  }

  /**
   * Rebuild resource index from all groups (Phase 8.1 perf fix)
   * Called conditionally after updating resource groups (Phase 16 perf fix)
   * Uses atomic swap to prevent race conditions during rebuild.
   */
  private rebuildResourceIndex(): void {
    // Build new index first (atomic - no race window)
    const newIndex = new Map<string, Resource>();
    const newAncestryIndex = createUnversionedIgnoredIndex();

    // Add local resources first (these have lock status and real file status)
    // Use _allUnversioned for index (includes hidden unversioned files)
    const localResources = [
      ...this._staged.resourceStates,
      ...this._changes.resourceStates,
      ...this._conflicts.resourceStates,
      ...this._allUnversioned,
      ...this._ignored.resourceStates
    ];

    // Add changelist resources
    this._changelists.forEach(group => {
      localResources.push(...group.resourceStates);
    });

    // Build index from local resources
    for (const resource of localResources) {
      if (resource instanceof Resource) {
        const normalizedPath = normalizePath(resource.resourceUri.fsPath);
        newIndex.set(normalizedPath, resource);
      }
    }

    // Add remote changes only if no local resource exists for that path
    // Remote resources have type="none" and no lock status, so local takes precedence
    if (this._remoteChanges) {
      for (const resource of this._remoteChanges.resourceStates) {
        if (resource instanceof Resource) {
          const normalizedPath = normalizePath(resource.resourceUri.fsPath);
          if (!newIndex.has(normalizedPath)) {
            newIndex.set(normalizedPath, resource);
          }
        }
      }
    }

    const indexAncestry = (
      resources: readonly Resource[],
      status: Status
    ): void => {
      for (const resource of resources) {
        if (!(resource instanceof Resource)) {
          continue;
        }
        const normalizedPath = normalizePath(resource.resourceUri.fsPath);
        newAncestryIndex.exact.set(normalizedPath, status);
        if (resource.kind === "dir") {
          newAncestryIndex.folders.set(normalizedPath, status);
        }
      }
    };

    // Add ignored first so unversioned wins same-path collisions.
    indexAncestry(this._ignored.resourceStates, Status.IGNORED);
    indexAncestry(this._allUnversioned, Status.UNVERSIONED);

    // Atomic swaps eliminate partially rebuilt lookup state.
    this._resourceIndex = newIndex;
    this._unversionedIgnoredIndex = newAncestryIndex;
  }

  /**
   * Find resource by URI across all groups
   * Phase 8.1 perf fix - O(1) Map lookup instead of O(n*m) nested loops
   */
  getResourceFromFile(uri: string | Uri): Resource | undefined {
    if (typeof uri === "string") {
      uri = Uri.file(uri);
    }

    const normalizedPath = normalizePath(uri.fsPath);
    return this._resourceIndex.get(normalizedPath);
  }

  /**
   * Check if a file path is unversioned/ignored (directly or inside a folder).
   * Used when getResourceFromFile() returns undefined.
   * Uses an ancestry index built from all resources, including hidden entries.
   * Unversioned takes precedence over ignored.
   */
  isInsideUnversionedOrIgnored(filePath: string): Status | undefined {
    const normalizedPath = normalizePath(filePath);
    const exactStatus = this._unversionedIgnoredIndex.exact.get(normalizedPath);
    if (exactStatus === Status.UNVERSIONED) {
      return Status.UNVERSIONED;
    }

    let ignoredMatch = exactStatus === Status.IGNORED;
    let ancestor = normalizedPath;
    const rootLength = path.parse(ancestor).root.length;
    while (ancestor.length > rootLength && ancestor.endsWith(path.sep)) {
      ancestor = ancestor.slice(0, -1);
    }

    while (true) {
      const folderStatus = this._unversionedIgnoredIndex.folders.get(ancestor);
      if (folderStatus === Status.UNVERSIONED) {
        return Status.UNVERSIONED;
      }
      ignoredMatch ||= folderStatus === Status.IGNORED;

      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }

    return ignoredMatch ? Status.IGNORED : undefined;
  }

  /**
   * Get flat resource map for batch operations (Phase 21.A perf)
   * Exposes internal map to avoid repeated URI conversion overhead
   * @returns Map keyed by URI string (use Uri.file(path).toString())
   */
  getResourceMap(): Map<string, Resource> {
    return this._resourceIndex;
  }

  /**
   * Optimistically move resources to staged group without SVN status refresh.
   * Used for instant UI feedback after staging operations.
   * When staging a file, also stages any parent folders that are in changes.
   * @param paths File paths to move to staged
   * @returns Resources that were moved (for potential rollback)
   */
  moveToStaged(paths: string[]): Resource[] {
    const movedResources: Resource[] = [];
    const pathSet = new Set(paths.map(p => normalizePath(p)));

    // Find parent directories that need to be staged with files
    // (can't commit a file without its parent folder existing)
    const parentsToStage = this.findParentDirectoriesToStage(pathSet);
    for (const parentPath of parentsToStage) {
      pathSet.add(parentPath);
    }

    // Drain matching resources out of changes, unversioned, and each changelist
    this.extractMatching(this._changes, pathSet, movedResources);
    this.extractMatching(this._unversioned, pathSet, movedResources);
    this._changelists.forEach(group => {
      this.extractMatching(group, pathSet, movedResources);
    });

    // Add to staged group
    this._staged.resourceStates = [
      ...this._staged.resourceStates,
      ...movedResources
    ];

    // Track staged directories (changelists can't hold them)
    for (const r of movedResources) {
      if (r.kind === "dir") {
        this._stagedDirectories.add(normalizePath(r.resourceUri.fsPath));
      }
    }

    // Update staging cache
    this._staging.syncFromChangelist(
      this._staged.resourceStates.map(r => r.resourceUri.fsPath)
    );

    return movedResources;
  }

  /**
   * Find parent directories of paths that need to be staged together.
   * When staging a file in a new folder, the folder must also be staged.
   */
  private findParentDirectoriesToStage(pathSet: Set<string>): string[] {
    const parentsToStage: string[] = [];

    // Build set of all directory paths in changes, unversioned, and changelists
    const availableDirs = new Map<string, Resource>();
    const collectDirs = (resources: readonly { resourceUri: Uri }[]) => {
      for (const r of resources) {
        if (r instanceof Resource && r.kind === "dir") {
          availableDirs.set(normalizePath(r.resourceUri.fsPath), r);
        }
      }
    };

    collectDirs(this._changes.resourceStates);
    collectDirs(this._unversioned.resourceStates);
    this._changelists.forEach(group => collectDirs(group.resourceStates));

    // For each path being staged, check if its parents are in available dirs
    for (const filePath of pathSet) {
      let parentPath = this.getParentPath(filePath);
      while (parentPath) {
        const normalizedParent = normalizePath(parentPath);
        if (
          availableDirs.has(normalizedParent) &&
          !pathSet.has(normalizedParent)
        ) {
          parentsToStage.push(normalizedParent);
        }
        parentPath = this.getParentPath(parentPath);
      }
    }

    return parentsToStage;
  }

  /**
   * Remove resources whose fsPath is in pathSet from group, appending unique
   * matches to collector. Used by moveToStaged to drain three different groups.
   */
  private extractMatching(
    group: ISvnResourceGroup,
    pathSet: Set<string>,
    collector: Resource[]
  ): void {
    group.resourceStates = group.resourceStates.filter(r => {
      if (
        r instanceof Resource &&
        pathSet.has(normalizePath(r.resourceUri.fsPath))
      ) {
        if (!collector.includes(r)) {
          collector.push(r);
        }
        return false;
      }
      return true;
    });
  }

  /**
   * Get parent directory path, or undefined if at root
   */
  private getParentPath(filePath: string): string | undefined {
    const lastSep = Math.max(
      filePath.lastIndexOf("/"),
      filePath.lastIndexOf("\\")
    );
    if (lastSep <= 0) {
      return undefined;
    }
    return filePath.substring(0, lastSep);
  }

  /**
   * Optimistically move resources from staged group without SVN status refresh.
   * Used for instant UI feedback after unstaging operations.
   * @param paths File paths to move from staged
   * @param targetChangelist Optional changelist to move to (otherwise goes to changes)
   * @returns Resources that were moved
   */
  moveFromStaged(paths: string[], targetChangelist?: string): Resource[] {
    const movedResources: Resource[] = [];
    const pathSet = new Set(paths.map(p => normalizePath(p)));

    // Find and remove from staged group
    const remainingStaged = this._staged.resourceStates.filter(r => {
      if (
        r instanceof Resource &&
        pathSet.has(normalizePath(r.resourceUri.fsPath))
      ) {
        movedResources.push(r);
        // Untrack staged directories
        if (r.kind === "dir") {
          this._stagedDirectories.delete(normalizePath(r.resourceUri.fsPath));
        }
        return false;
      }
      return true;
    });
    this._staged.resourceStates = remainingStaged;

    // Add to target group
    if (targetChangelist) {
      let group = this._changelists.get(targetChangelist);
      if (!group) {
        // Create changelist group if it doesn't exist
        group = this.createGroup(
          `changelist-${targetChangelist}`,
          `Changelist "${targetChangelist}"`
        );
        group.hideWhenEmpty = true;
        this._disposables.push(group);
        this._changelists.set(targetChangelist, group);
      }
      group.resourceStates = [...group.resourceStates, ...movedResources];
    } else {
      // Add to changes group
      this._changes.resourceStates = [
        ...this._changes.resourceStates,
        ...movedResources
      ];
    }

    // Update staging cache
    this._staging.syncFromChangelist(
      this._staged.resourceStates.map(r => r.resourceUri.fsPath)
    );

    return movedResources;
  }

  /**
   * Calculate source control count based on configuration
   */
  private calculateCount(config: ResourceGroupConfig): number {
    const counts: ISvnResourceGroup[] = [
      this._staged,
      this._changes,
      this._conflicts
    ];

    // Add changelists not in ignore list
    this._changelists.forEach((group, changelist) => {
      if (!config.ignoreOnStatusCountList.includes(changelist)) {
        counts.push(group);
      }
    });

    // Optionally include unversioned
    if (config.countUnversioned) {
      counts.push(this._unversioned);
    }

    return counts.reduce((sum, group) => sum + group.resourceStates.length, 0);
  }

  /**
   * Create a resource group
   */
  private createGroup(id: string, label: string): ISvnResourceGroup {
    return this.sourceControl.createResourceGroup(
      id,
      label
    ) as ISvnResourceGroup;
  }

  /**
   * Clear all resource states and dispose remote changes
   */
  clearAll(): void {
    this._staged.resourceStates = [];
    this._changes.resourceStates = [];
    this._unversioned.resourceStates = [];
    this._ignored.resourceStates = [];
    this._conflicts.resourceStates = [];
    this._changelists.forEach((group, _changelist) => {
      group.resourceStates = [];
    });
    this._remoteChanges?.dispose();
    this._remoteChanges = undefined;
    this.clearIndexes();
    this._stagedDirectories.clear();
  }

  private clearIndexes(): void {
    this._resourceIndex.clear();
    this._unversionedIgnoredIndex = createUnversionedIgnoredIndex();
    this._allUnversioned = [];
    this._resourceHash = "";
  }

  /**
   * Dispose all managed groups
   */
  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    this._changelists.clear();
    this.clearIndexes();
  }
}
