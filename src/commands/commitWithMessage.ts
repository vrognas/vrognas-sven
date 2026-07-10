// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { Uri } from "vscode";
import { inputCommitFiles } from "../changelistItems";
import {
  buildExpandedCommitPaths,
  ensureNoUnsavedChanges,
  executeCommit,
  withPreCommitUpdate
} from "../helpers/commitHelper";
import { inputCommitMessage } from "../messages";
import { Repository } from "../repository";
import { Command } from "./command";

export class CommitWithMessage extends Command {
  constructor() {
    super("sven.commitWithMessage", { repository: true });
  }

  public async execute(repository: Repository) {
    const resourceStates = await inputCommitFiles(repository);
    if (!resourceStates || resourceStates.length === 0) {
      return;
    }

    // Filter to Resource instances for path building
    const resources = this.filterResources(resourceStates);

    // Build initial paths for message input
    const initialPaths = this.resourcesToPaths(resources);

    // Same commit-safety gates as the staged flows: unsaved editors
    // first, pre-commit update concurrent with message input
    if (!(await ensureNoUnsavedChanges(initialPaths))) {
      return;
    }
    const message = await withPreCommitUpdate(repository, initialPaths, () =>
      inputCommitMessage(repository.inputBox.value, false, initialPaths)
    );
    if (message === undefined) {
      return;
    }

    // Build paths including parent dirs and track renames
    const { commitPaths } = buildExpandedCommitPaths(resources, repository);

    // Recoverable if the commit itself fails; cleared on success
    repository.inputBox.value = message;

    await this.handleRepositoryOperation(
      () => executeCommit(repository, message, commitPaths),
      "Unable to commit",
      commitPaths.map(p => Uri.file(p))
    );
  }
}
