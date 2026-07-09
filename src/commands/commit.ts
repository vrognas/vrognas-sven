// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { SourceControlResourceState, window } from "vscode";
import {
  buildExpandedCommitPaths,
  ensureNoUnsavedChanges,
  executeCommit,
  withPreCommitUpdate
} from "../helpers/commitHelper";
import { inputCommitMessage } from "../messages";
import { Command } from "./command";

export class Commit extends Command {
  constructor() {
    super("sven.commit");
  }

  public async execute(...resources: SourceControlResourceState[]) {
    const selection = await this.getResourceStatesOrExit(resources);
    if (!selection) return;

    // Enforce changelist requirement - only allow files in changelists
    const notInChangelist = selection.filter(r => !r.changelist);
    if (notInChangelist.length > 0) {
      window.showWarningMessage(
        "Stage files before committing. Use the Stage button or Ctrl+Enter."
      );
      return;
    }

    await this.runBySelectionPaths(selection, async (repository, paths) => {
      const selectedPaths = new Set(paths);
      const repoResources = selection.filter(resource =>
        selectedPaths.has(resource.resourceUri.fsPath)
      );
      const { displayPaths, commitPaths } = buildExpandedCommitPaths(
        repoResources,
        repository
      );

      // Same commit-safety gates as the staged flows
      if (!(await ensureNoUnsavedChanges(displayPaths))) {
        return;
      }
      const message = await withPreCommitUpdate(repository, displayPaths, () =>
        inputCommitMessage(repository.inputBox.value, true, displayPaths)
      );

      if (message === undefined) {
        return;
      }

      repository.inputBox.value = message;

      await this.handleRepositoryOperation(
        () => executeCommit(repository, message, commitPaths),
        "Unable to commit"
      );
    });
  }
}
