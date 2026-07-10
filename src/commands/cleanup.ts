// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { ProgressLocation, QuickPickItem, window } from "vscode";
import { ICleanupOptions } from "../common/types";
import { Repository } from "../repository";
import { sanitizeString } from "../security/errorSanitizer";
import { confirmDestructive } from "../ui";
import { Command } from "./command";
import { showActionFeedback } from "../util/actionFeedback";

interface CleanupQuickPickItem extends QuickPickItem {
  id: keyof ICleanupOptions;
  destructive?: boolean;
  /** Short name for progress/completion messages */
  shortName: string;
}

/**
 * Cleanup options for multi-select dialog (TortoiseSVN-style).
 *
 * Note: Basic cleanup always fixes timestamps and repairs locks automatically
 * (hardcoded in SVN CLI). No separate options needed for those.
 *
 * @see https://tortoisesvn.net/docs/release/TortoiseSVN_en/tsvn-dug-cleanup.html
 */
const cleanupOptions: CleanupQuickPickItem[] = [
  {
    label: "$(trash) Remove Unversioned Files",
    description: "Delete untracked files in this repo only",
    detail:
      "Deletes files not in SVN. Enable 'Clean Nested Repositories' to include externals. Cannot be undone!",
    id: "removeUnversioned",
    shortName: "unversioned files",
    destructive: true,
    picked: false
  },
  {
    label: "$(exclude) Remove Ignored Files",
    description: "Delete ignored files in this repo only",
    detail:
      "Removes files matching svn:ignore, svn:global-ignores, and config. Cannot be undone!",
    id: "removeIgnored",
    shortName: "ignored files",
    destructive: true,
    picked: false
  },
  {
    label: "$(database) Reclaim Disk Space",
    description: "Remove old cached file copies (SVN 1.10+)",
    detail: "Cleans up internal SVN cache to free disk space. Safe operation.",
    id: "vacuumPristines",
    shortName: "disk space",
    picked: true // Safe, recommended default
  },
  {
    label: "$(link-external) Clean Nested Repositories",
    description: "Also clean svn:externals linked repos",
    detail:
      "Applies cleanup to repositories embedded via svn:externals (if any).",
    id: "includeExternals",
    shortName: "nested repos",
    picked: false
  }
];

/**
 * SVN Cleanup command with TortoiseSVN-style options dialog.
 *
 * Always runs basic cleanup (repairs locks, fixes timestamps).
 * Optionally can also remove files and vacuum pristines.
 */
export class Cleanup extends Command {
  private static readonly MAX_RETRIES = 3;
  private retryCount = 0;

  constructor() {
    super("sven.cleanup", { repository: true });
  }

  public async execute(repository: Repository) {
    // Show multi-select picker
    const selected = await window.showQuickPick(cleanupOptions, {
      canPickMany: true,
      placeHolder: "Space to toggle, Enter to run (empty = basic cleanup)",
      title: "SVN Cleanup — Repairs locks & timestamps automatically"
    });

    // User cancelled (Escape)
    if (selected === undefined) {
      return;
    }

    // Check for destructive options
    const destructive = selected.filter(s => s.destructive);
    if (destructive.length > 0) {
      const names = destructive
        .map(d => d.label.replace(/\$\([^)]+\)\s*/, ""))
        .join(", ");
      const confirmed = await confirmDestructive(
        `WARNING: "${names}" will permanently delete files. Continue?`,
        "Delete Files"
      );
      if (!confirmed) return;
    }

    // Build options object and collect operation names
    const options: ICleanupOptions = {};
    const operations: string[] = [];
    for (const item of selected) {
      options[item.id] = true;
      if (item.id !== "includeExternals") {
        operations.push(item.shortName);
      }
    }

    // Build progress title
    const progressTitle =
      operations.length > 0
        ? `Cleaning: ${operations.join(", ")}...`
        : "Running SVN Cleanup...";

    // Run cleanup with progress (not cancellable - SVN ops run to completion)
    try {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: progressTitle,
          cancellable: false
        },
        async () => {
          await repository.cleanupAdvanced(options);
        }
      );

      this.retryCount = 0;

      // Show descriptive completion message
      const completedOps =
        operations.length > 0 ? `Removed ${formatList(operations)}. ` : "";
      const externalsNote = options.includeExternals
        ? "Included externals."
        : "";
      showActionFeedback(
        `Cleanup completed. ${completedOps}${externalsNote}`.trim()
      );
    } catch (err) {
      const error = err as { svnErrorCode?: string; message?: string };
      const message = error.message ?? String(err);

      // Provide helpful message for locked working copy
      if (
        error.svnErrorCode === "E155037" ||
        error.svnErrorCode === "E155004"
      ) {
        if (this.retryCount >= Cleanup.MAX_RETRIES) {
          this.retryCount = 0;
          window.showErrorMessage(
            "Cleanup failed after multiple attempts. " +
              "Try running 'svn cleanup' in terminal."
          );
          return;
        }

        const choice = await window.showErrorMessage(
          "Cleanup failed: Working copy is locked. " +
            "A previous SVN operation was interrupted. " +
            "Try running cleanup again, or use 'svn cleanup' in terminal.",
          "Retry Cleanup"
        );
        if (choice === "Retry Cleanup") {
          this.retryCount++;
          await this.execute(repository);
        } else {
          this.retryCount = 0;
        }
        return;
      }

      this.retryCount = 0;
      window.showErrorMessage(`Cleanup failed: ${sanitizeString(message)}`);
    }
  }
}

/** Format list with commas and "and" (e.g., "a, b, and c") */
function formatList(items: string[]): string {
  if (items.length <= 2) {
    return items.join(" and ");
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
