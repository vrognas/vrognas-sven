// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import {
  Disposable,
  EventEmitter,
  FileDecoration,
  FileDecorationProvider,
  ThemeColor,
  Uri
} from "vscode";
import { LockStatus, PropertyChange, PropStatus, Status } from "./common/types";
import { configuration } from "./helpers/configuration";
import { Repository } from "./repository";
import { getLockColor, getLockTooltip } from "./util/lockHelpers";

/**
 * Provides file decorations (badges and colors) for SVN-tracked files in Explorer view
 */
export class SvnFileDecorationProvider
  implements FileDecorationProvider, Disposable
{
  private _onDidChangeFileDecorations = new EventEmitter<
    Uri | Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  private disposables: Disposable[] = [];

  constructor(private repository: Repository) {
    this.disposables.push(this._onDidChangeFileDecorations);

    // Refresh decorations when decorator color settings change
    this.disposables.push(
      configuration.onDidChange(e => {
        if (
          e.affectsConfiguration("sven.decorator.baseColor") ||
          e.affectsConfiguration("sven.decorator.serverOnlyColor")
        ) {
          this._onDidChangeFileDecorations.fire(undefined);
        }
      })
    );
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  /**
   * Provide decoration for a file URI
   */
  provideFileDecoration(uri: Uri): FileDecoration | undefined {
    // Check for commit decorations (from repo/item log)
    if (uri.scheme === "svn-commit") {
      const queryParams = new URLSearchParams(uri.query);
      if (queryParams.get("isBase") === "true") {
        const baseColor = configuration.get<string>(
          "decorator.baseColor",
          "charts.blue"
        );
        return {
          badge: "B",
          tooltip: "Your working copy's BASE revision",
          color: new ThemeColor(baseColor)
        };
      }
      if (queryParams.get("isServerOnly") === "true") {
        const serverColor = configuration.get<string>(
          "decorator.serverOnlyColor",
          "charts.green"
        );
        return {
          badge: "S",
          tooltip: "Server revision - not synced yet (run svn update)",
          color: new ThemeColor(serverColor)
        };
      }
      return undefined;
    }

    // Check if this is a historical file from repository log (has action query param)
    const queryParams = new URLSearchParams(uri.query);
    const action = queryParams.get("action");

    if (action) {
      // Historical file from repository log - use action directly
      const status = this.actionToStatus(action);
      if (!status) {
        return undefined;
      }

      const badge = this.getBadge(status, undefined);
      const color = this.getColor(status);
      const tooltip = this.getTooltip(status, undefined);

      if (!badge && !color) {
        return undefined;
      }

      return {
        badge,
        tooltip,
        color,
        propagate: true
      };
    }

    // Look up file status from repository (current working copy)
    const resource = this.repository.getResourceFromFile(uri.fsPath);

    if (!resource) {
      // File not in changes list - check lock cache and needs-lock
      return this.getLockOnlyDecoration(uri);
    }

    const status = resource.type;

    // Don't decorate external files
    if (status === Status.EXTERNAL) {
      return undefined;
    }

    const isFolder = resource.kind === "dir";
    let badge = this.getBadge(
      status,
      resource.renameResourceUri,
      isFolder,
      resource.localFileExists
    );
    let color = this.getColor(status);
    let tooltip = this.getTooltip(
      status,
      resource.renameResourceUri,
      isFolder,
      resource.localFileExists
    );

    // Property changes: P for property-only, PM for content+property
    if (
      resource.props &&
      resource.props !== PropStatus.NONE &&
      resource.props !== PropStatus.NORMAL
    ) {
      if (status === Status.NORMAL) {
        // Property-only change - show details if available
        badge = "P";
        color = new ThemeColor("gitDecoration.modifiedResourceForeground");
        tooltip = this.formatPropertyChangesTooltip(resource.propertyChanges);
      } else if (status === Status.MODIFIED) {
        // Content + property change
        badge = "PM";
        const propDetails = this.formatPropertyChangesTooltip(
          resource.propertyChanges
        );
        tooltip = `Modified + ${propDetails}`;
      }
    }

    // Add lock info to tooltip, badge, and color (K/O/B/T per SVN convention)
    // VS Code limits badges to 2 chars, so only append lock if badge is 1 char
    if (resource.lockStatus) {
      const lockInfo = getLockTooltip(resource.lockStatus, resource.lockOwner);
      tooltip = tooltip ? `${tooltip} (${lockInfo})` : lockInfo;
      // Use SVN lock letters: K=yours, O=others, B=broken, T=stolen
      const lockLetter = resource.lockStatus;
      // Only combine if result is ≤2 chars (e.g., MK ok, PMK not ok)
      if (!badge || badge.length === 1) {
        badge = badge ? `${badge}${lockLetter}` : lockLetter;
      }
      // Lock color: B/T always red, K/O if no status color
      if (
        resource.lockStatus === LockStatus.B ||
        resource.lockStatus === LockStatus.T ||
        !color
      ) {
        color = getLockColor(resource.lockStatus);
      }
    } else if (resource.locked) {
      // Fallback for legacy lock detection without lockStatus
      const lockInfo = resource.hasLockToken
        ? "Locked by you"
        : resource.lockOwner
          ? `Locked by ${resource.lockOwner}`
          : "Locked by others";
      tooltip = tooltip ? `${tooltip} (${lockInfo})` : lockInfo;
      // K=yours, O=others
      const lockLetter = resource.hasLockToken ? LockStatus.K : LockStatus.O;
      // Only combine if result is ≤2 chars
      if (!badge || badge.length === 1) {
        badge = badge ? `${badge}${lockLetter}` : lockLetter;
      }
      // Use lock color if no status color
      if (!color) {
        color = getLockColor(lockLetter);
      }
    }

    // Check if file has needs-lock property - add to tooltip only (no L badge)
    const hasNeedsLock = this.repository.hasNeedsLockCached(uri.fsPath);

    if (!badge && !color) {
      // No status decoration - needs-lock shown in status bar, not badge
      if (hasNeedsLock) {
        return {
          tooltip: "Needs lock - file is read-only until locked",
          propagate: false
        };
      }
      return undefined;
    }

    // Add needs-lock to tooltip only (no L badge - shown in status bar instead)
    if (hasNeedsLock) {
      tooltip = tooltip
        ? `${tooltip} (needs-lock)`
        : "Needs lock - file is read-only until locked";
    }

    // Add SVN property info to tooltip
    tooltip = this.appendPropertyTooltip(uri.fsPath, tooltip);

    return {
      badge,
      tooltip,
      color,
      propagate: true // Show on parent folders like Git
    };
  }

  /**
   * Get decoration for locked-only files, needs-lock files, or files inside
   * unversioned/ignored folders (not directly in resource index).
   * Checks: 1) lock cache, 2) parent folder status, 3) needs-lock
   */
  private getLockOnlyDecoration(uri: Uri): FileDecoration | undefined {
    // Only check file scheme
    if (uri.scheme !== "file") {
      return undefined;
    }

    // Check if file is in working copy (case-insensitive on Windows)
    if (!this.isInWorkingCopy(uri.fsPath)) {
      return undefined;
    }

    // Check lock cache first (for locked-only files)
    const lockInfo = this.repository.getLockStatusCached(uri.fsPath);
    if (lockInfo) {
      const lockLetter = lockInfo.lockStatus;
      let tooltip: string | undefined = getLockTooltip(
        lockInfo.lockStatus,
        lockInfo.lockOwner
      );
      const color = getLockColor(lockInfo.lockStatus);

      // Append property info (eol-style, mime-type)
      tooltip = this.appendPropertyTooltip(uri.fsPath, tooltip);

      return {
        badge: lockLetter,
        tooltip,
        color,
        propagate: false
      };
    }

    // Check if file is inside an unversioned or ignored folder
    const parentStatus = this.repository.isInsideUnversionedOrIgnored(
      uri.fsPath
    );
    if (parentStatus) {
      const badge = this.getBadge(parentStatus, undefined, false);
      const color = this.getColor(parentStatus);
      const statusName =
        parentStatus === Status.UNVERSIONED ? "Unversioned" : "Ignored";
      return {
        badge,
        tooltip: `${statusName} (inside ${statusName.toLowerCase()} folder)`,
        color,
        propagate: false
      };
    }

    // Check for needs-lock property
    const hasNeedsLock = this.repository.hasNeedsLockCached(uri.fsPath);

    // Check for SVN property info (eol-style, mime-type)
    const propertyTooltip = this.getPropertyTooltip(uri.fsPath);

    // Build tooltip from available info
    let tooltip: string | undefined;
    if (hasNeedsLock) {
      tooltip = "Needs lock - file is read-only until locked";
    }
    if (propertyTooltip) {
      tooltip = tooltip ? `${tooltip} | ${propertyTooltip}` : propertyTooltip;
    }

    if (!tooltip) {
      return undefined;
    }

    return {
      tooltip,
      propagate: false
    };
  }

  /**
   * Refresh decorations for changed files
   */
  refresh(uris?: Uri | Uri[]): void {
    // Fire with undefined to refresh all, or specific URIs to refresh those
    // Note: empty array [] means refresh nothing, undefined means refresh all
    this._onDidChangeFileDecorations.fire(uris);
  }

  /**
   * Convert repository log action to Status constant
   * Actions: A=added, M=modified, D=deleted, R=renamed, !=replaced
   */
  private actionToStatus(action: string): string | undefined {
    switch (action) {
      case "A":
        return Status.ADDED;
      case "R":
        return "RENAMED"; // Rename/copy with history preserved
      case "M":
        return Status.MODIFIED;
      case "D":
        return Status.DELETED;
      case "!":
        return Status.REPLACED; // History broken
      // Legacy support for old "A+" action
      case "A+":
        return "RENAMED";
      default:
        return undefined;
    }
  }

  private getBadge(
    status: string,
    renameUri?: Uri,
    isFolder: boolean = false,
    localFileExists?: boolean
  ): string | undefined {
    // Renamed files (from working copy with renameUri)
    if (status === Status.ADDED && renameUri) {
      return isFolder ? "📁R" : "R";
    }
    // Renamed files (from history view)
    if (status === "RENAMED") {
      return isFolder ? "📁R" : "R";
    }
    // Replaced in chain rename (has renameUri)
    if (status === Status.REPLACED && renameUri) {
      return isFolder ? "📁R" : "R";
    }

    let badge: string | undefined;
    switch (status) {
      case Status.ADDED:
        badge = "A";
        break;
      case Status.CONFLICTED:
        badge = "C";
        break;
      case Status.DELETED:
        // U for untracked (file kept), D for truly deleted
        badge = localFileExists ? "U" : "D";
        break;
      case Status.MODIFIED:
        badge = "M";
        break;
      case Status.REPLACED:
        // ! for replaced without rename (history broken)
        badge = "!";
        break;
      case Status.UNVERSIONED:
        badge = "?";
        break;
      case Status.MISSING:
        badge = "!";
        break;
      case Status.IGNORED:
        badge = "I";
        break;
      default:
        return undefined;
    }

    // Prefix with folder emoji for folders (📁A, 📁M, 📁D, etc.)
    return isFolder ? `📁${badge}` : badge;
  }

  private getColor(status: string): ThemeColor | undefined {
    switch (status) {
      case Status.MODIFIED:
      case "RENAMED": // Renamed gets modified color (orange)
        return new ThemeColor("gitDecoration.modifiedResourceForeground");
      case Status.DELETED:
      case Status.MISSING:
        return new ThemeColor("gitDecoration.deletedResourceForeground");
      case Status.ADDED:
      case Status.UNVERSIONED:
      case Status.REPLACED: // Replaced gets untracked color (green)
        return new ThemeColor("gitDecoration.untrackedResourceForeground");
      case Status.IGNORED:
        return new ThemeColor("gitDecoration.ignoredResourceForeground");
      case Status.CONFLICTED:
        return new ThemeColor("gitDecoration.conflictingResourceForeground");
      default:
        return undefined;
    }
  }

  /**
   * Format property changes for tooltip display.
   * Shows: "svn:needs-lock added, svn:ignore modified"
   */
  private formatPropertyChangesTooltip(
    propertyChanges?: PropertyChange[]
  ): string {
    if (!propertyChanges || propertyChanges.length === 0) {
      return "Property modified";
    }

    // Format each property change
    const parts = propertyChanges.map(
      change => `${change.name} ${change.changeType}`
    );

    return parts.join(", ");
  }

  private getTooltip(
    status: string,
    renameUri?: Uri,
    isFolder: boolean = false,
    localFileExists?: boolean
  ): string | undefined {
    const prefix = isFolder ? "Folder " : "";

    // Renamed from working copy (has renameUri) - show just filename
    if ((status === Status.ADDED || status === Status.REPLACED) && renameUri) {
      const oldName = path.basename(renameUri.fsPath);
      return `${prefix}Renamed from ${oldName} (history preserved)`;
    }
    // Renamed from history view
    if (status === "RENAMED") {
      return `${prefix}Renamed (history preserved)`;
    }

    switch (status) {
      case Status.ADDED:
        return `${prefix}Added: New file (no prior history)`;
      case Status.CONFLICTED:
        return `${prefix}Conflicted`;
      case Status.DELETED:
        // Distinguish untracked (file kept) from truly deleted
        return localFileExists
          ? `${prefix}Untracked: Remove from server; keep local`
          : `${prefix}Deleted: Remove from server and local`;
      case Status.MODIFIED:
        return `${prefix}Modified`;
      case Status.REPLACED:
        return `${prefix}Replaced: Delete+add at same path (history broken)`;
      case Status.UNVERSIONED:
        return `${prefix}Unversioned`;
      case Status.MISSING:
        return `${prefix}Missing`;
      case Status.IGNORED:
        return `${prefix}Ignored`;
      default:
        return undefined;
    }
  }

  /**
   * Get property tooltip for a file (eol-style, mime-type).
   * Returns undefined if no properties set.
   */
  private getPropertyTooltip(filePath: string): string | undefined {
    const parts: string[] = [];

    const eolStyle = this.repository.getEolStyleCached(filePath);
    if (eolStyle) {
      parts.push(`eol: ${eolStyle}`);
    }

    const mimeType = this.repository.getMimeTypeCached(filePath);
    if (mimeType) {
      parts.push(`mime: ${mimeType}`);
    }

    return parts.length > 0 ? parts.join(", ") : undefined;
  }

  /**
   * Append property info to existing tooltip.
   */
  private appendPropertyTooltip(
    filePath: string,
    tooltip: string | undefined
  ): string | undefined {
    const propertyTooltip = this.getPropertyTooltip(filePath);
    if (!propertyTooltip) {
      return tooltip;
    }
    return tooltip ? `${tooltip} | ${propertyTooltip}` : propertyTooltip;
  }

  /**
   * Check if file is in working copy (case-insensitive on Windows).
   */
  private isInWorkingCopy(filePath: string): boolean {
    const root = this.repository.workspaceRoot;
    if (process.platform === "win32") {
      // Case-insensitive comparison with trailing separator
      return (
        filePath.toLowerCase().startsWith(root.toLowerCase() + "\\") ||
        filePath.toLowerCase().startsWith(root.toLowerCase() + "/") ||
        filePath.toLowerCase() === root.toLowerCase()
      );
    }
    // Unix: case-sensitive
    return filePath.startsWith(root + "/") || filePath === root;
  }
}
