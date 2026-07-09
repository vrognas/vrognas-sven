// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import {
  ensureNoUnsavedChanges,
  executeCommit,
  withPreCommitUpdate
} from "../helpers/commitHelper";
import { Repository } from "../repository";
import { BaseStagedCommitCommand } from "./baseStagedCommitCommand";

/**
 * Quick commit without message prompt.
 * Uses input box value if present, otherwise auto-generates message.
 */
export class CommitQuick extends BaseStagedCommitCommand {
  constructor() {
    super("sven.commitQuick", { repository: true });
  }

  public async execute(repository: Repository) {
    const context = this.prepareStagedCommit(repository);
    if (!context) {
      return;
    }
    const { stagedResources, commitPaths: filePaths } = context;

    // Use input box value or auto-generate message
    let message = repository.inputBox.value.trim();
    if (!message) {
      // Auto-generate message based on file count and primary action
      const fileCount = stagedResources.length;
      const primaryFile = path.basename(stagedResources[0]!.resourceUri.fsPath);
      message =
        fileCount === 1 ? `Update ${primaryFile}` : `Update ${fileCount} files`;
    }

    // Quick != unguarded: unsaved-editor warning and the pre-commit
    // update gate still apply (getMessage resolves instantly here)
    if (!(await ensureNoUnsavedChanges(context.displayPaths))) {
      return;
    }
    const gated = await withPreCommitUpdate(
      repository,
      context.displayPaths,
      async () => message
    );
    if (gated === undefined) {
      return;
    }

    await this.handleRepositoryOperation(
      () => executeCommit(repository, message, filePaths),
      "Unable to commit"
    );
  }
}
