// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { window, Uri } from "vscode";
import { Command } from "./command";
import { Repository } from "../repository";
import { Resource } from "../resource";
import { Status } from "../common/types";
import { blameStateManager } from "../blame/blameStateManager";
import { logError } from "../util/errorLogger";

/**
 * Execute SVN blame on a file and display results
 * This command directly calls repository.blame() and can be used for:
 * - Programmatic blame access
 * - Testing blame functionality
 * - Integration with other tools
 *
 * For UI-integrated blame, use showBlame/toggleBlame commands
 * which work with BlameProvider.
 */
export class Blame extends Command {
  constructor() {
    super("sven.blameFile", { repository: true });
  }

  /**
   * Execute blame on a file
   * @param repository Repository instance
   * @param arg Resource or Uri to blame (defaults to active editor)
   * @param revision Optional revision to blame (defaults to HEAD)
   */
  public async execute(
    repository: Repository,
    arg?: Resource | Uri,
    revision?: string
  ) {
    await this.handleRepositoryOperation(async () => {
      const uri = this.extractUri(arg) ?? window.activeTextEditor?.document.uri;

      if (!uri) {
        window.showErrorMessage("No file selected for blame");
        return;
      }

      // Wait for status to load before checking file version
      await repository.statusReady;

      // Skip unversioned/ignored/added files - can't blame
      const resource = repository.getResourceFromFile(uri);
      if (resource) {
        if (
          resource.type === Status.UNVERSIONED ||
          resource.type === Status.IGNORED ||
          resource.type === Status.ADDED
        ) {
          window.showWarningMessage("Cannot blame unversioned or added file");
          return;
        }
      } else {
        // Fallback: check if file is inside unversioned/ignored folder
        const parentStatus = repository.isInsideUnversionedOrIgnored(
          uri.fsPath
        );
        if (
          parentStatus === Status.UNVERSIONED ||
          parentStatus === Status.IGNORED
        ) {
          window.showWarningMessage("Cannot blame file in unversioned folder");
          return;
        }
      }

      try {
        if (revision) {
          // Programmatic path: explicit revision, direct fetch
          const blameLines = await repository.blame(uri.fsPath, revision);
          window.showInformationMessage(
            `Blame loaded: ${blameLines.length} lines from ${uri.fsPath}`
          );
          return;
        }

        // UI path ("Show Annotations"): enable blame for the file - the
        // BlameProvider reacts to the state change and fetches through the
        // shared caches. The previous implementation ran a remote HEAD
        // blame here and threw the result away (toast only).
        blameStateManager.setBlameEnabled(uri, true);
      } catch (err) {
        logError("Blame command failed", err);
        throw err; // handleRepositoryOperation will catch and show to user
      }
    }, "Unable to blame file");
  }
}
