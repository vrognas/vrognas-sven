// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { CancellationToken, ProgressLocation, Uri, window } from "vscode";
import { ISvnErrorData, IUpdateResult, Status } from "../common/types";
import { Resource } from "../resource";

/**
 * The slice of Repository that PreCommitUpdateService drives. Depending on
 * this role keeps the service decoupled from the concrete god object; a real
 * Repository satisfies it structurally.
 */
export interface IPreCommitUpdateRepository {
  getResourceFromFile(uri: string | Uri): Resource | undefined;
  isInsideUnversionedOrIgnored(filePath: string): Status | undefined;
  getLastRemoteCheckResult():
    | { hasChanges: boolean; timestamp: number }
    | undefined;
  getRemoteCheckFrequencyMs(): number;
  hasRemoteChanges(): Promise<boolean>;
  updateRevision(
    ignoreExternals?: boolean,
    opts?: {
      skipHistoryRefresh?: boolean;
      token?: CancellationToken;
      files?: string[];
    }
  ): Promise<IUpdateResult>;
}

// E155015 = "One or more conflicts produced" (commit-side).
// E200024 = MergeConflict (update-side; mirrored from svn.svnErrorCodes).
// Inlined as literals so this module doesn't pull svn.ts → configuration.ts
// into its import graph (test vscode mock doesn't cover the full chain).
const COMMIT_CONFLICT_CODE = "E155015";
const MERGE_CONFLICT_CODE = "E200024";

/**
 * Result of pre-commit update operation
 */
export interface UpdateResult {
  success: boolean;
  revision?: number;
  hasConflicts?: boolean;
  cancelled?: boolean;
  skipped?: boolean;
  error?: string;
}

/**
 * User choice for conflict resolution
 */
export type ConflictChoice = "abort" | "continue";

/**
 * Service for running SVN update before commit.
 * Checks for remote changes first, only updates if needed.
 * Uses cached polling result when fresh enough to avoid redundant network call.
 */
export class PreCommitUpdateService {
  /**
   * Run SVN update with progress notification.
   * First checks if server has new commits - skips update if already at HEAD.
   * Reuses cached remote-check result from background polling when fresh.
   */
  async runUpdate(
    repository: IPreCommitUpdateRepository,
    files?: string[]
  ): Promise<UpdateResult> {
    // Filter to versioned files only — new/unversioned files don't need updating
    const versionedFiles = files?.filter(f => {
      const resource = repository.getResourceFromFile(f);
      if (!resource) {
        // Not in any resource group — check if inside unversioned/ignored folder
        const folderStatus = repository.isInsideUnversionedOrIgnored(f);
        // If inside unversioned/ignored folder, skip; otherwise treat as versioned
        return !folderStatus;
      }
      return (
        resource.type !== Status.ADDED && resource.type !== Status.UNVERSIONED
      );
    });

    // No versioned files to update — skip entirely
    if (versionedFiles && versionedFiles.length === 0) {
      return { success: true, skipped: true };
    }

    return window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: "Checking for updates...",
        cancellable: true
      },
      async (progress, token: CancellationToken) => {
        if (token.isCancellationRequested) {
          return { success: false, cancelled: true };
        }

        try {
          // For targeted updates, skip the remote check — svn update is a no-op at HEAD
          // This saves a full network round-trip (svn log -r BASE:HEAD)
          if (!versionedFiles) {
            // Full update: check if update is needed first
            progress.report({ message: "Checking server for new commits..." });
            let hasChanges: boolean;

            const cached = repository.getLastRemoteCheckResult();
            const frequencyMs = repository.getRemoteCheckFrequencyMs();
            if (
              cached &&
              frequencyMs > 0 &&
              Date.now() - cached.timestamp < frequencyMs
            ) {
              hasChanges = cached.hasChanges;
            } else {
              hasChanges = await repository.hasRemoteChanges();
            }

            if (!hasChanges) {
              return { success: true, skipped: true };
            }
          }

          if (token.isCancellationRequested) {
            return { success: false, cancelled: true };
          }

          progress.report({ message: "Running svn update..." });
          const updateResult = await repository.updateRevision(false, {
            token,
            files: versionedFiles
          });

          if (updateResult.conflicts.length > 0) {
            return {
              success: false,
              hasConflicts: true,
              revision: updateResult.revision ?? undefined
            };
          }

          return {
            success: true,
            revision: updateResult.revision ?? undefined
          };
        } catch (error: unknown) {
          const errorMsg = (error as Error)?.message || String(error);

          // Check for cancellation (exitCode 130 from killed SVN process)
          if ((error as { exitCode?: number }).exitCode === 130) {
            return { success: false, cancelled: true };
          }

          // Prefer the structured svnErrorCode when present; fall back to
          // substring match for non-SvnError throws (e.g. wrapped errors).
          const svnErrorCode = (error as ISvnErrorData).svnErrorCode;
          const isConflict =
            svnErrorCode === MERGE_CONFLICT_CODE ||
            svnErrorCode === COMMIT_CONFLICT_CODE ||
            errorMsg.includes(COMMIT_CONFLICT_CODE) ||
            errorMsg.includes(MERGE_CONFLICT_CODE) ||
            errorMsg.includes("conflict");

          if (isConflict) {
            return {
              success: false,
              hasConflicts: true,
              error: errorMsg
            };
          }

          return {
            success: false,
            error: errorMsg
          };
        }
      }
    );
  }

  /**
   * Prompt user to choose action when conflicts detected
   */
  async promptConflictResolution(): Promise<ConflictChoice> {
    // Non-modal warning - less disruptive UX
    const choice = await window.showWarningMessage(
      "Conflicts detected during update. Resolve before committing?",
      "Resolve First",
      "Commit Anyway"
    );

    if (choice === "Commit Anyway") {
      return "continue";
    }

    return "abort";
  }
}
