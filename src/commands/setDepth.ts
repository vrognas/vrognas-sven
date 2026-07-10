// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as fs from "fs";
import * as path from "path";
import {
  CancellationToken,
  commands,
  ProgressLocation,
  QuickPickItem,
  Uri,
  window,
  workspace
} from "vscode";
import { SvnDepth } from "../common/types";
import { Command } from "./command";
import { confirm } from "../ui";
import { formatBytes, formatDuration, formatSpeed } from "../util/formatting";
import { Repository } from "../repository";
import { showActionFeedback } from "../util/actionFeedback";

/** Default download timeout in minutes */
const DEFAULT_DOWNLOAD_TIMEOUT_MINUTES = 10;

/** Pre-scan timeout in seconds */
const PRE_SCAN_TIMEOUT_SECONDS = 30;

/** Progress poll interval in ms */
const POLL_INTERVAL_MS = 500;

/** Max recursion depth for file counting */
const MAX_RECURSION_DEPTH = 100;

/** Smoothing factor for ETA (0-1, higher = more responsive, lower = smoother) */
const ETA_SMOOTHING_FACTOR = 0.3;

/** Minimum elapsed seconds before showing ETA (avoids wild initial estimates) */
const MIN_ELAPSED_FOR_ETA = 2;

/** Folder statistics returned by single traversal */
interface FolderStats {
  count: number;
  size: number;
}

/**
 * Get file count and total size in a single traversal.
 * @param folderPath Path to scan
 * @param recursive If true, scan subdirectories recursively (default: true)
 */
function getFolderStats(
  folderPath: string,
  recursive = true,
  visited = new Set<string>(),
  depth = 0
): FolderStats {
  if (depth > MAX_RECURSION_DEPTH) return { count: 0, size: 0 };

  let count = 0;
  let size = 0;
  try {
    const folderStat = fs.statSync(folderPath);
    const inode = `${folderStat.dev}:${folderStat.ino}`;
    if (visited.has(inode)) return { count: 0, size: 0 };
    visited.add(inode);

    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".svn") continue;
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(folderPath, entry.name);
      if (entry.isDirectory() && recursive) {
        const sub = getFolderStats(fullPath, recursive, visited, depth + 1);
        count += sub.count;
        size += sub.size;
      } else if (entry.isFile()) {
        try {
          size += fs.statSync(fullPath).size;
          count++;
        } catch {
          // File may have been deleted
        }
      }
    }
  } catch {
    // Folder may not exist yet
  }
  return { count, size };
}

/**
 * Find uncommitted changes and unversioned files under a path.
 * Returns relative paths that would be lost on depth change.
 */
function getUnsafeFiles(repo: Repository, targetPath: string): string[] {
  const unsafe: string[] = [];
  const root = repo.workspaceRoot;
  const prefix = targetPath.replace(/\\/g, "/").toLowerCase();

  for (const group of [repo.changes, repo.unversioned]) {
    for (const r of group.resourceStates) {
      const fp = r.resourceUri.fsPath.replace(/\\/g, "/").toLowerCase();
      if (fp.startsWith(prefix + "/") || fp === prefix) {
        unsafe.push(path.relative(root, r.resourceUri.fsPath));
      }
    }
  }
  return unsafe;
}

/** SVN-native depth picker item (no `_omitExternals` sentinel). */
export interface SvnDepthQuickPickItem extends QuickPickItem {
  depth: keyof typeof SvnDepth;
}

/**
 * Wider type used only by the initial-checkout multi-select picker,
 * which adds an `_omitExternals` sentinel alongside real depths.
 */
export interface DepthQuickPickItem extends QuickPickItem {
  depth: keyof typeof SvnDepth | "_omitExternals";
}

/** Checkout depth options (for restoring ghost items - no exclude option) */
export const checkoutDepthOptions: SvnDepthQuickPickItem[] = [
  {
    label: "$(folder-opened) Full",
    description: "Download everything",
    detail: "Downloads the folder and all its contents recursively.",
    depth: "infinity"
  },
  {
    label: "$(list-tree) Shallow",
    description: "Files + empty subfolders",
    detail:
      "Downloads files and shows subfolders as empty. Good for exploring structure.",
    depth: "immediates"
  },
  {
    label: "$(file) Files Only",
    description: "Skip subfolders",
    detail: "Downloads files in this folder, but skips all subfolders.",
    depth: "files"
  },
  {
    label: "$(folder) Folder Only",
    description: "Empty placeholder",
    detail: "Keeps the folder as a placeholder but downloads no files.",
    depth: "empty"
  }
];

/** Full depth options including exclude (for setDepth command on local items) */
export const depthPickerOptions: SvnDepthQuickPickItem[] = [
  {
    label: "$(eye-closed) Exclude",
    description: "Don't download this folder",
    detail:
      "Removes the folder and all contents locally. Use for large folders you don't need.",
    depth: "exclude"
  },
  ...checkoutDepthOptions
];

export class SetDepth extends Command {
  constructor() {
    super("sven.setDepth");
  }

  public async execute(arg?: Uri | { fullPath: string }): Promise<void> {
    // Get URI from argument (Uri from explorer, or SparseItemNode from tree)
    let uri: Uri | undefined;

    if (arg instanceof Uri) {
      uri = arg;
    } else if (arg && typeof arg === "object" && "fullPath" in arg) {
      // SparseItemNode from sparse checkout tree view
      uri = Uri.file(arg.fullPath);
    }

    if (!uri) {
      return;
    }

    // Get repository for this path
    const sourceControlManager = await this.getSourceControlManager();

    const repository = sourceControlManager.getRepository(uri);
    if (!repository) {
      window.showErrorMessage("No SVN repository found for this folder");
      return;
    }

    // Get folder name for display
    const folderName = uri.fsPath.split(/[\\/]/).pop() || "folder";

    // Show QuickPick for depth selection
    const selected = await window.showQuickPick(depthPickerOptions, {
      placeHolder: "What should be downloaded for this folder?",
      title: `SVN: Sparse Checkout - ${folderName}`
    });

    if (!selected) {
      return; // User cancelled
    }

    // For destructive depths, check for uncommitted/unversioned files first
    const destructiveDepths = ["exclude", "empty", "files", "immediates"];
    if (destructiveDepths.includes(selected.depth)) {
      const unsafeFiles = getUnsafeFiles(repository, uri.fsPath);
      if (unsafeFiles.length > 0) {
        const fileList = unsafeFiles.slice(0, 5).join("\n");
        const more =
          unsafeFiles.length > 5
            ? `\n...and ${unsafeFiles.length - 5} more`
            : "";
        const choice = await window.showWarningMessage(
          `${unsafeFiles.length} uncommitted/unversioned file(s) will be lost:\n\n${fileList}${more}\n\nCommit or move them first, or proceed to discard.`,
          { modal: true },
          "Continue Anyway"
        );
        if (choice !== "Continue Anyway") return;
      } else {
        // No unsafe files — show normal confirmation
        const warningMessages: Record<string, string> = {
          exclude:
            "This will remove the folder and all its contents locally. " +
            "The files still exist on the server and can be restored later.",
          empty:
            "This will remove all files and subfolders inside this folder. " +
            "The folder itself will remain as an empty placeholder.",
          files:
            "This will remove all subfolders (but keep files). " +
            "Subfolder contents can be restored later.",
          immediates:
            "This will remove contents of subfolders (keeping them as empty). " +
            "Deeper contents can be restored later."
        };

        const confirmed = await confirm(
          warningMessages[selected.depth] ||
            "This operation may remove local files.",
          "Continue"
        );
        if (!confirmed) return;
      }
    }

    // Get configurable timeout
    const timeoutMinutes = workspace
      .getConfiguration("sven.sparse")
      .get<number>("downloadTimeoutMinutes", DEFAULT_DOWNLOAD_TIMEOUT_MINUTES);
    const downloadTimeoutMs = timeoutMinutes * 60 * 1000;

    // Suppress status updates during download (prevents WC lock conflicts)
    repository.beginSparseDownload();

    try {
      // Detect ghost folder (not locally present) - these are downloads regardless of depth
      const isGhostFolder = !fs.existsSync(uri.fsPath);

      // Download mode: ghost folder with any download depth, or infinity on local folder
      // Depths that download content: infinity, immediates, files
      // Depths that don't download: empty (placeholder only), exclude (removal)
      const downloadDepths = ["infinity", "immediates", "files"] as const;
      const isDownload = isGhostFolder
        ? downloadDepths.includes(
            selected.depth as (typeof downloadDepths)[number]
          )
        : selected.depth === "infinity";

      const result = await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: isDownload
            ? `Downloading "${folderName}"...`
            : `Setting depth for "${folderName}"...`,
          cancellable: isDownload
        },
        async (progress, token: CancellationToken) => {
          // Immediate feedback
          progress.report({
            message: isDownload ? "Starting download..." : "Preparing..."
          });

          // Check for cancellation before starting
          if (token.isCancellationRequested) {
            return { exitCode: -1, cancelled: true, stderr: "" };
          }

          let pollInterval: ReturnType<typeof setInterval> | undefined;
          let expectedFileCount = 0;
          let expectedTotalSize = 0;
          let initialFileCount = 0;
          let initialTotalSize = 0;

          try {
            if (isDownload) {
              // For downloads, pre-scan server to get expected file count and size
              // Use depth-aware listing: recursive for infinity, non-recursive for immediates/files
              progress.report({ message: `Scanning ${folderName}...` });

              try {
                const relativePath = repository.repository.removeAbsolutePath(
                  uri.fsPath
                );

                // Depth-aware pre-scan:
                // - infinity: list all files recursively
                // - immediates/files: list only direct children (non-recursive)
                const items =
                  selected.depth === "infinity"
                    ? await repository.listRecursive(
                        relativePath,
                        PRE_SCAN_TIMEOUT_SECONDS * 1000
                      )
                    : await repository.list(uri.fsPath);

                const files = items.filter(i => i.kind === "file");
                expectedFileCount = files.length;
                expectedTotalSize = files.reduce(
                  (sum, f) => sum + parseInt(f.size ?? "0", 10),
                  0
                );

                if (token.isCancellationRequested) {
                  return { exitCode: -1, cancelled: true, stderr: "" };
                }

                progress.report({
                  message: `Found ${expectedFileCount} files (${formatBytes(expectedTotalSize)}) in ${folderName}`
                });
              } catch {
                expectedFileCount = 0;
                expectedTotalSize = 0;
              }

              // Start progress polling for downloads
              if (expectedFileCount > 0) {
                const startTime = Date.now();
                let smoothedSpeed = 0; // Exponential moving average
                let lastSize = 0;
                let lastTime = startTime;

                // Depth-aware polling: recursive for infinity, non-recursive for immediates/files
                const pollRecursive = selected.depth === "infinity";

                progress.report({
                  message: `Downloading ${folderName} (0/${expectedFileCount} files)...`
                });

                pollInterval = setInterval(() => {
                  if (token.isCancellationRequested) return;
                  const stats = getFolderStats(uri.fsPath, pollRecursive);
                  const pct = Math.max(
                    0,
                    Math.min(
                      100,
                      Math.round((stats.size / expectedTotalSize) * 100)
                    )
                  );

                  // Calculate smoothed speed with exponential moving average
                  const now = Date.now();
                  const elapsed = (now - startTime) / 1000;
                  const deltaTime = (now - lastTime) / 1000;
                  const deltaSize = stats.size - lastSize;

                  if (deltaTime > 0 && deltaSize > 0) {
                    const instantSpeed = deltaSize / deltaTime;
                    smoothedSpeed =
                      smoothedSpeed === 0
                        ? instantSpeed
                        : ETA_SMOOTHING_FACTOR * instantSpeed +
                          (1 - ETA_SMOOTHING_FACTOR) * smoothedSpeed;
                  }
                  lastSize = stats.size;
                  lastTime = now;

                  // Build progress message with speed and ETA
                  let speedEtaLabel = "";
                  if (smoothedSpeed > 0) {
                    speedEtaLabel = ` ${formatSpeed(smoothedSpeed)}`;
                    // Only show ETA after minimum elapsed time
                    if (elapsed >= MIN_ELAPSED_FOR_ETA) {
                      const remaining = expectedTotalSize - stats.size;
                      if (remaining > 0) {
                        const eta = remaining / smoothedSpeed;
                        speedEtaLabel += ` ~${formatDuration(eta)}`;
                      }
                    }
                  }

                  progress.report({
                    message: `${folderName}: ${formatBytes(stats.size)}/${formatBytes(expectedTotalSize)} (${pct}%)${speedEtaLabel}`
                  });
                }, POLL_INTERVAL_MS);
              } else {
                progress.report({ message: `Downloading ${folderName}...` });
              }
            } else {
              // For removals (exclude, empty, files, immediates), count existing files
              const initialStats = getFolderStats(uri.fsPath);
              initialFileCount = initialStats.count;
              initialTotalSize = initialStats.size;

              if (initialFileCount > 0) {
                const startTime = Date.now();
                let smoothedSpeed = 0;
                let lastRemovedSize = 0;
                let lastTime = startTime;

                const actionLabel =
                  selected.depth === "exclude" ? "Excluding" : "Removing files";
                progress.report({
                  message: `${actionLabel} ${initialFileCount} files (${formatBytes(initialTotalSize)})...`
                });

                pollInterval = setInterval(() => {
                  const stats = getFolderStats(uri.fsPath);
                  const removedSize = initialTotalSize - stats.size;
                  const pct = Math.max(
                    0,
                    Math.min(
                      100,
                      Math.round((removedSize / initialTotalSize) * 100)
                    )
                  );

                  // Calculate smoothed speed with exponential moving average
                  const now = Date.now();
                  const elapsed = (now - startTime) / 1000;
                  const deltaTime = (now - lastTime) / 1000;
                  const deltaRemoved = removedSize - lastRemovedSize;

                  if (deltaTime > 0 && deltaRemoved > 0) {
                    const instantSpeed = deltaRemoved / deltaTime;
                    smoothedSpeed =
                      smoothedSpeed === 0
                        ? instantSpeed
                        : ETA_SMOOTHING_FACTOR * instantSpeed +
                          (1 - ETA_SMOOTHING_FACTOR) * smoothedSpeed;
                  }
                  lastRemovedSize = removedSize;
                  lastTime = now;

                  if (removedSize > 0) {
                    // Build progress message with speed and ETA
                    let speedEtaLabel = "";
                    if (smoothedSpeed > 0) {
                      speedEtaLabel = ` ${formatSpeed(smoothedSpeed)}`;
                      // Only show ETA after minimum elapsed time
                      if (elapsed >= MIN_ELAPSED_FOR_ETA && stats.size > 0) {
                        const eta = stats.size / smoothedSpeed;
                        speedEtaLabel += ` ~${formatDuration(eta)}`;
                      }
                    }

                    progress.report({
                      message: `${actionLabel}: ${formatBytes(removedSize)}/${formatBytes(initialTotalSize)} (${pct}%)${speedEtaLabel}`
                    });
                  }
                }, POLL_INTERVAL_MS);
              } else {
                progress.report({ message: "Applying changes..." });
              }
            }

            // Check cancellation before starting SVN operation
            if (token.isCancellationRequested) {
              return { exitCode: -1, cancelled: true, stderr: "" };
            }

            const res = await repository.setDepth(uri.fsPath, selected.depth, {
              parents: true,
              timeout: downloadTimeoutMs
            });

            // SVN completed — show success even if cancel was pressed during execution,
            // since the operation actually finished and the working copy was changed.
            return { ...res, cancelled: false };
          } catch (err) {
            return {
              exitCode: 1,
              cancelled: token.isCancellationRequested,
              stderr: String(err)
            };
          } finally {
            if (pollInterval) {
              clearInterval(pollInterval);
            }
          }
        }
      );

      if (result.cancelled) {
        showActionFeedback(`Operation cancelled`);
        return;
      }

      if (result.exitCode === 0) {
        const successMessages: Record<string, string> = {
          exclude: `"${folderName}" excluded`,
          empty: `"${folderName}" contents removed (folder kept)`,
          files: `"${folderName}" set to files only`,
          immediates: `"${folderName}" set to shallow`,
          infinity: `"${folderName}" fully restored`
        };
        showActionFeedback(
          successMessages[selected.depth] || `Checkout depth changed`
        );
        // Refresh sparse checkout tree to reflect changes
        commands.executeCommand("sven.sparse.refresh");
      } else {
        // Full recovery chain: auth/lock/cleanup/update/conflict prompts,
        // sanitized stderr - replaces the hand-rolled cleanup-only branch
        // that showed raw stderr
        await this.handleOperationError(
          result,
          "Failed to change checkout depth"
        );
      }
    } catch (error) {
      await this.handleOperationError(error, "Failed to change checkout depth");
    } finally {
      // Re-enable status updates
      repository.endSparseDownload();
    }
  }
}
