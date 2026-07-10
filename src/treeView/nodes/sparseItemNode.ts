// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import {
  TreeItem,
  TreeItemCollapsibleState,
  ThemeIcon,
  ThemeColor,
  Uri
} from "vscode";
import { ISparseItem, SparseDepthKey } from "../../common/types";
import BaseNode from "./baseNode";
import { formatDate, formatSize } from "../../util/formatting";
import { getLockTooltip } from "../../util/lockHelpers";

type ChildrenLoader = (path: string) => Promise<ISparseItem[]>;
/** Callback to refresh tree; pass node for targeted refresh, undefined for full */
type RefreshCallback = (node?: BaseNode) => void;

const depthLabels: Record<SparseDepthKey, string> = {
  exclude: "Excluded",
  empty: "Empty",
  files: "Files Only",
  immediates: "Shallow",
  infinity: "Full"
};

export default class SparseItemNode extends BaseNode {
  constructor(
    private item: ISparseItem,
    private repoRoot: string,
    private loadChildren: ChildrenLoader,
    private onRefresh?: RefreshCallback
  ) {
    super();
  }

  public getTreeItem(): TreeItem {
    const isDir = this.item.kind === "dir";
    const fullPath = path.join(this.repoRoot, this.item.path);

    // Directories are expandable (both local and ghost)
    // Ghost dirs show server contents, local dirs show local + ghost
    const treeItem = new TreeItem(
      this.item.name,
      isDir ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None
    );

    // Set resourceUri to get file icons from VS Code's file icon theme
    // Query params for FileDecorationProvider: sparse, lock, lockOwner
    const baseUri = Uri.file(fullPath);
    treeItem.resourceUri = this.buildResourceUri(baseUri);

    // Build rich tooltip with metadata
    treeItem.tooltip = this.buildTooltip();

    // Build description with metadata
    const descParts: string[] = [];

    if (this.item.isGhost) {
      // Ghost item: decoration provider de-emphasizes
      treeItem.contextValue = isDir ? "sparseGhostDir" : "sparseGhostFile";
    } else {
      // Local item
      if (isDir && this.item.depth) {
        // Show partial indicator if folder has excluded children
        if (this.item.hasExcludedChildren) {
          // Use descriptionForeground - partial is informational
          treeItem.iconPath = new ThemeIcon(
            "folder",
            new ThemeColor("descriptionForeground")
          );
          const label = depthLabels[this.item.depth] || this.item.depth;
          descParts.push(`${label} (partial)`);
        } else {
          descParts.push(depthLabels[this.item.depth] || this.item.depth);
        }
      }
      treeItem.contextValue = isDir ? "sparseLocalDir" : "sparseLocalFile";
    }

    // Add metadata to description (for both local and ghost items)
    if (this.item.revision) {
      descParts.push(`r${this.item.revision}`);
    }
    if (this.item.author) {
      descParts.push(this.item.author);
    }
    if (this.item.date) {
      descParts.push(formatDate(this.item.date));
    }
    if (!isDir && this.item.size) {
      descParts.push(formatSize(this.item.size));
    }
    // Lock indicator now shown via badge decoration (like explorer view)

    if (descParts.length > 0) {
      // Same dot separators as the repo/file history descriptions
      treeItem.description = descParts.join(" · ");
    }

    return treeItem;
  }

  /** Build rich tooltip with all metadata */
  private buildTooltip(): string {
    const lines: string[] = [this.item.path];

    // Show revision comparison for local items
    if (!this.item.isGhost && this.item.localRevision && this.item.revision) {
      const local = parseInt(this.item.localRevision, 10);
      const server = parseInt(this.item.revision, 10);
      if (local < server) {
        lines.push(
          `Local: r${this.item.localRevision} → Server: r${this.item.revision} (update available)`
        );
      } else {
        lines.push(`Revision: r${this.item.revision} (up to date)`);
      }
    } else if (this.item.revision) {
      lines.push(`Revision: r${this.item.revision}`);
    }
    if (this.item.author) {
      lines.push(`Author: ${this.item.author}`);
    }
    if (this.item.date) {
      lines.push(`Date: ${formatDate(this.item.date)}`);
    }
    if (this.item.kind === "file" && this.item.size) {
      lines.push(`Size: ${formatSize(this.item.size)}`);
    }
    if (this.item.lockStatus) {
      lines.push(
        `Lock: ${getLockTooltip(this.item.lockStatus, this.item.lockOwner)}`
      );
      if (this.item.lockComment) {
        lines.push(`Comment: ${this.item.lockComment}`);
      }
    }
    if (this.item.isGhost) {
      lines.push("(Not downloaded - on server only)");
    }

    return lines.join("\n");
  }

  /** Build URI with query params for FileDecorationProvider */
  private buildResourceUri(baseUri: Uri): Uri {
    const params = new URLSearchParams();

    // Ghost marker for de-emphasized styling
    if (this.item.isGhost) {
      params.set("sparse", "ghost");
    }

    // Outdated detection: localRevision < serverRevision
    if (
      !this.item.isGhost &&
      this.item.localRevision &&
      this.item.revision &&
      parseInt(this.item.localRevision, 10) < parseInt(this.item.revision, 10)
    ) {
      params.set("outdated", "true");
    }

    // Lock status for badge decoration (K/O/B/T)
    if (this.item.lockStatus) {
      params.set("lock", this.item.lockStatus);
      if (this.item.lockOwner) {
        params.set("lockOwner", this.item.lockOwner);
      }
    }

    const query = params.toString();
    // Use svn-sparse scheme to prevent VS Code SCM decorations
    return query
      ? baseUri.with({ scheme: "svn-sparse", query })
      : baseUri.with({ scheme: "svn-sparse" });
  }

  public async getChildren(): Promise<BaseNode[]> {
    if (this.item.kind !== "dir") {
      return [];
    }
    const fullPath = path.join(this.repoRoot, this.item.path);
    const items = await this.loadChildren(fullPath);

    // Track if folder has excluded children (for partial indicator)
    // Fire targeted refresh if flag actually changed in either direction
    const hasGhosts = items.some(i => i.isGhost);
    const flagChanged = hasGhosts !== (this.item.hasExcludedChildren ?? false);
    this.item.hasExcludedChildren = hasGhosts;
    if (flagChanged) {
      // Targeted refresh for just this node - updates icon without full rebuild
      this.onRefresh?.(this);
    }

    return items.map(
      i =>
        new SparseItemNode(
          i, // Path is already correct from getItems()
          this.repoRoot,
          this.loadChildren,
          this.onRefresh
        )
    );
  }

  public get path(): string {
    return this.item.path;
  }

  public get fullPath(): string {
    return path.join(this.repoRoot, this.item.path);
  }

  public get isGhost(): boolean {
    return this.item.isGhost;
  }

  public get kind(): "file" | "dir" {
    return this.item.kind;
  }

  public get size(): string | undefined {
    return this.item.size;
  }
}
