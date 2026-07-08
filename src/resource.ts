// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import {
  Command,
  SourceControlResourceDecorations,
  SourceControlResourceState,
  ThemeColor,
  Uri
} from "vscode";
import { LockStatus, PropStatus, PropertyChange, Status } from "./common/types";
import { memoize } from "./decorators";
import { configuration } from "./helpers/configuration";
import { capitalize } from "./util/formatting";

export class Resource implements SourceControlResourceState {
  constructor(
    private _resourceUri: Uri,
    private _type: string,
    private _renameResourceUri?: Uri,
    private _props?: string,
    private _remote: boolean = false,
    private _locked: boolean = false,
    private _lockOwner?: string,
    private _hasLockToken: boolean = false,
    private _lockStatus?: LockStatus,
    private _changelist?: string,
    private _kind?: "file" | "dir",
    private _localFileExists?: boolean,
    private _propertyChanges?: PropertyChange[]
  ) {}

  /** Property changes: which properties changed and how */
  get propertyChanges(): PropertyChange[] | undefined {
    return this._propertyChanges;
  }

  /** For DELETED status: true = untracked (file kept), false = truly deleted */
  get localFileExists(): boolean | undefined {
    return this._localFileExists;
  }

  get kind(): "file" | "dir" | undefined {
    return this._kind;
  }

  get changelist(): string | undefined {
    return this._changelist;
  }

  @memoize
  get resourceUri(): Uri {
    return this._resourceUri;
  }

  @memoize
  get type(): string {
    return this._type;
  }
  get renameResourceUri(): Uri | undefined {
    return this._renameResourceUri;
  }
  get props(): string | undefined {
    return this._props;
  }

  get remote(): boolean {
    return this._remote;
  }

  get locked(): boolean {
    return this._locked;
  }

  get lockOwner(): string | undefined {
    return this._lockOwner;
  }

  /** True if we hold the lock token (K), false if locked by others (O) */
  get hasLockToken(): boolean {
    return this._hasLockToken;
  }

  /** Lock status: K=mine, O=other, B=broken, T=stolen */
  get lockStatus(): LockStatus | undefined {
    return this._lockStatus;
  }

  /**
   * Return a copy with lock fields overridden, preserving every other field.
   * Replaces hand-written positional clones (which silently dropped the
   * trailing propertyChanges argument).
   */
  public withLock(lock: {
    locked?: boolean;
    lockOwner?: string;
    hasLockToken?: boolean;
    lockStatus?: LockStatus;
  }): Resource {
    return new Resource(
      this._resourceUri,
      this._type,
      this._renameResourceUri,
      this._props,
      this._remote,
      lock.locked ?? this._locked,
      lock.lockOwner ?? this._lockOwner,
      lock.hasLockToken ?? this._hasLockToken,
      lock.lockStatus ?? this._lockStatus,
      this._changelist,
      this._kind,
      this._localFileExists,
      this._propertyChanges
    );
  }

  get contextValue(): string {
    return this._kind === "dir" ? "folder" : "file";
  }

  get decorations(): SourceControlResourceDecorations {
    // No iconPath - VS Code uses file extension icons for files
    // FileDecorationProvider adds badges (A/M/D for files, FA/FM/FD for folders)
    return {
      strikeThrough: this.strikeThrough,
      tooltip: this.tooltip
    };
  }

  @memoize
  get command(): Command {
    const diffHead = configuration.get<boolean>("diff.withHead", true);
    const changesLeftClick = configuration.get<string>(
      "sourceControl.changesLeftClick",
      "open diff"
    );

    if (!this.remote && changesLeftClick === "open") {
      return {
        command: "sven.openFile",
        title: "Open file",
        arguments: [this]
      };
    }

    if (this.remote || diffHead) {
      return {
        command: "sven.openResourceHead",
        title: "Open Diff With Head",
        arguments: [this]
      };
    }

    return {
      command: "sven.openResourceBase",
      title: "Open Diff With Base",
      arguments: [this]
    };
  }

  private get tooltip(): string {
    let tip = "";

    if (
      (this.type === Status.ADDED || this.type === Status.REPLACED) &&
      this.renameResourceUri
    ) {
      // Renamed file (R badge) - show just filename, not full path
      const oldName = path.basename(this.renameResourceUri.fsPath);
      tip = `Renamed from ${oldName} (history preserved)`;
    } else if (this.type === Status.ADDED) {
      // A badge
      tip = "Added: New file (no prior history)";
    } else if (this.type === Status.REPLACED) {
      // ↻ badge (no rename = history broken)
      tip = "Replaced: Delete+add at same path (history broken)";
    } else if (this.type === Status.DELETED && this._localFileExists) {
      // Untracked (svn delete --keep-local)
      tip = "Untracked: Remove from server; keep local";
    } else if (this.type === Status.DELETED) {
      // Truly deleted
      tip = "Deleted: Remove from server and local";
    } else if (
      this.type === Status.NORMAL &&
      this.props &&
      this.props !== PropStatus.NONE
    ) {
      // Property-only change - show which properties changed
      tip = this.formatPropertyChangesTooltip();
    } else {
      tip = capitalize(this.type);
    }

    // Add lock info to tooltip
    if (this._locked) {
      const lockInfo = this._lockOwner
        ? `Locked by ${this._lockOwner}`
        : "Locked";
      tip = `${tip} (${lockInfo})`;
    }

    return tip;
  }

  private get strikeThrough(): boolean {
    // Only strikethrough truly deleted files, not untracked (kept locally)
    if (this.type === Status.DELETED && !this._localFileExists) {
      return true;
    }

    return false;
  }

  /**
   * Format property changes for tooltip display.
   * Shows: "svn:needs-lock added, svn:ignore modified"
   */
  private formatPropertyChangesTooltip(): string {
    if (!this._propertyChanges || this._propertyChanges.length === 0) {
      // Fallback if no detailed info available
      const propStatus = capitalize(this.props!);
      return `Property ${propStatus}`;
    }

    // Format each property change
    const parts = this._propertyChanges.map(
      change => `${change.name} ${change.changeType}`
    );

    return parts.join(", ");
  }

  get letter(): string | undefined {
    switch (this.type) {
      case Status.ADDED:
        // Renamed: R; otherwise A
        return this.renameResourceUri ? "R" : "A";
      case Status.CONFLICTED:
        return "C";
      case Status.DELETED:
        // U for untracked (file kept), D for truly deleted
        return this._localFileExists ? "U" : "D";
      case Status.EXTERNAL:
        return "E";
      case Status.IGNORED:
        return "I";
      case Status.MODIFIED:
        return "M";
      case Status.REPLACED:
        // Replaced with rename = R; without rename = ! (history broken)
        return this.renameResourceUri ? "R" : "!";
      case Status.UNVERSIONED:
        return "U";
      case Status.MISSING:
        return "!";
      default:
        return undefined;
    }
  }

  get color(): ThemeColor | undefined {
    switch (this.type) {
      case Status.MODIFIED:
        return new ThemeColor("gitDecoration.modifiedResourceForeground");
      case Status.ADDED:
        // Renamed files get modified color (orange), regular adds get untracked (green)
        if (this.renameResourceUri) {
          return new ThemeColor("gitDecoration.modifiedResourceForeground");
        }
        return new ThemeColor("gitDecoration.untrackedResourceForeground");
      case Status.REPLACED:
        // Replaced with rename = modified color, replaced without rename = untracked
        if (this.renameResourceUri) {
          return new ThemeColor("gitDecoration.modifiedResourceForeground");
        }
        return new ThemeColor("gitDecoration.untrackedResourceForeground");
      case Status.DELETED:
      case Status.MISSING:
        return new ThemeColor("gitDecoration.deletedResourceForeground");
      case Status.UNVERSIONED:
        return new ThemeColor("gitDecoration.untrackedResourceForeground");
      case Status.EXTERNAL:
      case Status.IGNORED:
        return new ThemeColor("gitDecoration.ignoredResourceForeground");
      case Status.CONFLICTED:
        return new ThemeColor("gitDecoration.conflictingResourceForeground");
      default:
        return undefined;
    }
  }

  get priority(): number {
    switch (this.type) {
      case Status.MODIFIED:
        return 2;
      case Status.IGNORED:
        return 3;
      case Status.DELETED:
      case Status.ADDED:
      case Status.REPLACED:
      case Status.MISSING:
        return 4;
      default:
        return 1;
    }
  }
}
