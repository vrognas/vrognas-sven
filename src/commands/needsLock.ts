// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { SourceControlResourceState, Uri, window } from "vscode";
import { BasePropertyCommand } from "./basePropertyCommand";
import { makeReadOnly, makeWritable } from "../fs";
import type { Repository } from "../repository";
import { showActionFeedback } from "../util/actionFeedback";

/**
 * Toggle svn:needs-lock property on files.
 * Files with this property are read-only until locked.
 */
export class ToggleNeedsLock extends BasePropertyCommand {
  // Prevent concurrent toggles on same paths
  private inProgress = new Set<string>();

  constructor() {
    super("sven.toggleNeedsLock");
  }

  public async execute(...args: (SourceControlResourceState | Uri)[]) {
    await this.executePropertyOperation(
      args,
      (repository, paths) => this.toggleNeedsLockOnPaths(repository, paths),
      "Unable to toggle needs-lock property"
    );
  }

  private async toggleNeedsLockOnPaths(
    repository: Repository,
    paths: string[]
  ): Promise<void> {
    let successCount = 0;
    let action = "";

    for (const filePath of paths) {
      // Skip if already toggling this path
      if (this.inProgress.has(filePath)) {
        continue;
      }
      this.inProgress.add(filePath);

      try {
        // Use cached check to avoid propget warning when property doesn't exist
        const hasProperty = repository.hasNeedsLockCached(filePath);

        if (hasProperty) {
          const result = await repository.removeNeedsLock(filePath);
          if (result.exitCode === 0) {
            // Make file writable since needs-lock is removed
            try {
              await makeWritable(filePath);
            } catch {
              // Ignore permission errors
            }
            successCount++;
            action = "removed";
          } else {
            window.showErrorMessage(
              `Failed to remove needs-lock: ${result.stderr || "Unknown error"}`
            );
          }
        } else {
          const result = await repository.setNeedsLock(filePath);
          if (result.exitCode === 0) {
            // Make file read-only since needs-lock is set
            try {
              await makeReadOnly(filePath);
            } catch {
              // Ignore permission errors
            }
            successCount++;
            action = "set";
          } else {
            window.showErrorMessage(
              `Failed to set needs-lock: ${result.stderr || "Unknown error"}`
            );
          }
        }
      } finally {
        this.inProgress.delete(filePath);
      }
    }

    if (successCount > 0) {
      if (action === "removed") {
        showActionFeedback(
          `Removed svn:needs-lock from ${successCount} file(s)`
        );
      } else {
        // Kept as a notification: teaches the non-obvious read-only
        // consequence of needs-lock
        window.showInformationMessage(
          `Set svn:needs-lock on ${successCount} file(s). Files are now read-only until locked.`
        );
      }
    }
  }
}
