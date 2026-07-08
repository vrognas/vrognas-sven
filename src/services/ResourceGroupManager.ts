// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { Disposable, SourceControl, Uri } from "vscode";
import { ISvnResourceGroup, LockStatus, Status } from "../common/types";
import { Resource } from "../resource";
import { StatusResult } from "./StatusService";
import { StagingService, STAGING_CHANGELIST } from "./stagingService";
import { normalizePath, toDisposable } from "../util";
import { matchAll } from "../util/globMatch";
import * as path from "path";

/**
 * True when target matches resource path exactly, or resource is a directory
 * and target is inside it (path-prefix match).
 */
function matchesPathOrFolder(
  resource: Resource,
  normalizedTarget: string
): boolean {
  const normalizedRes = normalizePath(resource.resourceUri.fsPath);
  if (normalizedRes === normalizedTarget) {
    return true;
  }
  return (
    resource.kind === "dir" &&
    normalizedTarget.startsWith(normalizedRes + path.sep)
  );
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
 * Extracted from Repository.updateModelState() (lines 463-552).
 *
 * Responsibilities:
 * - Create/dispose resource groups
 * - Update resource states from StatusResult
 * - Manage dynamic changelist groups
 * - Handle group ordering (recreate when needed)
 * - Calculate source control count
 *
 * Does NOT:
 * - Parse SVN status (StatusService concern)
 * - Execute SVN commands (Repository concern)
 * - Emit status events (Repository concern)
 */
export interface IResourceGroupManager {
  /**
   * Update all resource groups from status result
   */
  updateGroups(data: ResourceGroupUpdateData): number;

  /**
   * Find resource by URI across all groups
   */
  getResourceFromFile(uri: string | Uri): Resource | undefined;

  /**
   * Check if a file path is inside an unversioned or ignored FOLDER.
   * Used when getResourceFromFile() returns undefined.
   */
  isInsideUnversionedOrIgnored(filePath: string): Status | undefined;

  /**
   * Get flat resource map for batch operations (Phase 21.A perf)
   * Returns map of file paths (as strings) to resources
   */
  getResourceMap(): Map<string, Resource>;

  /**
   * Access to static groups
   */
  readonly staged: ISvnResourceGroup;
  readonly changes: ISvnResourceGroup;
  readonly conflicts: ISvnResourceGroup;
  readonly unversioned: ISvnResourceGroup;
  readonly ignored: ISvnResourceGroup;
  readonly changelists: ReadonlyMap<string, ISvnResourceGroup>;

  /**
   * Remote changes group (may be undefined if not enabled)
   */
  readonly remoteChanges: ISvnResourceGroup | undefined;

  /**
   * Staging service for managing staged files
   */
  readonly staging: StagingService;

  /**
   * Dispose all managed groups
   */
  dispose(): void;
}

/**
 * Implementation of resource group manager
 */
export class ResourceGroupManager implements IResourceGroupManager {
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
   * Hash resources including path, type, and lock status for change detection.
   * Includes type/lockStatus so index is rebuilt when properties change.
   */
  private hashPaths(resources: Resource[]): string {
    // Include path, type, and lockStatus to detect property changes
    const hashes = resources
      .map(r => `${r.resourceUri.fsPath}:${r.type}:${r.lockStatus ?? ""}`)
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

    // Atomic swap - eliminates race window where old index is cleared but new not ready
    this._resourceIndex = newIndex;
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
   * Uses _allUnversioned (not UI-filtered) to correctly detect hidden files/folders.
   * Unversioned takes precedence over ignored.
   */
  isInsideUnversionedOrIgnored(filePath: string): Status | undefined {
    const normalizedPath = normalizePath(filePath);

    for (const resource of this._allUnversioned) {
      if (matchesPathOrFolder(resource, normalizedPath)) {
        return Status.UNVERSIONED;
      }
    }

    for (const resource of this._ignored.resourceStates) {
      if (
        resource instanceof Resource &&
        matchesPathOrFolder(resource, normalizedPath)
      ) {
        return Status.IGNORED;
      }
    }

    return undefined;
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
    this._conflicts.resourceStates = [];
    this._changelists.forEach((group, _changelist) => {
      group.resourceStates = [];
    });
    this._remoteChanges?.dispose();
    this._remoteChanges = undefined;
    this._resourceIndex.clear();
    this._resourceHash = "";
    this._stagedDirectories.clear();
  }

  /**
   * Dispose all managed groups
   */
  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    this._changelists.clear();
  }
}
