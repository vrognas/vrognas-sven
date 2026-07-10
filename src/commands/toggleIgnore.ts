// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import { Uri, window } from "vscode";
import { Status } from "../common/types";
import { Command } from "./command";
import { Repository } from "../repository";
import { removeMatchingIgnorePattern } from "../helpers/ignoreHelper";
import { confirm } from "../ui";
import { formatSvnError, logError } from "../util/errorLogger";
import { showActionFeedback } from "../util/actionFeedback";

/**
 * Toggle svn:ignore for a file/folder.
 * - If ignored: remove from svn:ignore
 * - If versioned: untrack (svn delete --keep-local) + add to svn:ignore
 * - If unversioned: add to svn:ignore
 */
export class ToggleIgnore extends Command {
  constructor() {
    super("sven.toggleIgnore");
  }

  public async execute(_mainUri?: Uri, allUris?: Uri[]) {
    if (!allUris || allUris.length === 0) {
      return;
    }

    // For now, handle single file only
    const uri = allUris[0]!;
    const dirName = path.dirname(uri.fsPath);
    const fileName = path.basename(uri.fsPath);

    // Use parent directory for repository lookup (more reliable for ignored files)
    // The directory is always versioned since it has the svn:ignore property
    const dirUri = Uri.file(dirName);

    return this.runByRepository(dirUri, async (repository: Repository) => {
      // Check file status
      const resource = repository.getResourceFromFile(uri);
      const isIgnored = resource?.type === Status.IGNORED;
      const isUnversioned = resource?.type === Status.UNVERSIONED;

      if (isIgnored) {
        // Remove from ignore
        await removeMatchingIgnorePattern(repository, dirName, fileName);
      } else if (isUnversioned) {
        // Unversioned file - add to ignore
        await this.addToIgnore([uri]);
      } else {
        // Check if file is versioned (svn info succeeds for tracked files)
        const isVersioned = await this.isFileVersioned(repository, uri.fsPath);
        if (isVersioned) {
          // Versioned file - prompt user before untracking
          const confirmed = await confirm(
            `'${fileName}' is tracked. Untrack to ignore?`,
            "Untrack & Ignore"
          );
          if (confirmed) {
            await this.untrackAndIgnore(repository, uri, dirName, fileName);
          }
        } else {
          // Not versioned - just add to ignore
          await this.addToIgnore([uri]);
        }
      }
    });
  }

  /**
   * Check if file is versioned (tracked by SVN).
   * Uses svn info - succeeds for tracked files, fails for unversioned.
   */
  private async isFileVersioned(
    repository: Repository,
    filePath: string
  ): Promise<boolean> {
    try {
      await repository.getInfo(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Untrack a versioned file and add to svn:ignore.
   * Uses svn delete --keep-local to preserve the file locally.
   */
  private async untrackAndIgnore(
    repository: Repository,
    uri: Uri,
    dirName: string,
    fileName: string
  ): Promise<void> {
    try {
      // Step 1: Untrack the file (svn delete --keep-local)
      await repository.removeFiles([uri.fsPath], true);

      // Step 2: Add to svn:ignore on parent folder
      await repository.addToIgnore([fileName], dirName, false);

      showActionFeedback(
        `Untracked '${fileName}' and added to svn:ignore on parent folder`
      );
    } catch (error) {
      logError("Failed to untrack and ignore file", error);
      window.showErrorMessage(
        formatSvnError(error, "Failed to untrack and ignore file")
      );
    }
  }
}
