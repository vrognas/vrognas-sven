// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { Uri } from "vscode";
import {
  buildExpandedCommitPaths,
  executeCommit,
  type ExpandedCommitPaths,
  requireStaged,
  runCommitMessageFlow
} from "../helpers/commitHelper";
import { Repository } from "../repository";
import { Resource } from "../resource";
import { Command } from "./command";

export interface StagedCommitContext extends ExpandedCommitPaths {
  stagedResources: Resource[];
}

export abstract class BaseStagedCommitCommand extends Command {
  protected buildStagedCommitContext(
    repository: Repository,
    stagedResources: Resource[] = this.filterResources(
      repository.staged.resourceStates
    )
  ): StagedCommitContext {
    const { displayPaths, renameMap, commitPaths } = buildExpandedCommitPaths(
      stagedResources,
      repository
    );

    return { stagedResources, displayPaths, renameMap, commitPaths };
  }

  protected prepareStagedCommit(
    repository: Repository
  ): StagedCommitContext | null {
    const context = this.buildStagedCommitContext(repository);
    if (!requireStaged(context.stagedResources)) {
      return null;
    }

    return context;
  }

  protected async commitWithMessageFlow(
    repository: Repository,
    displayPaths: string[],
    renameMap: Map<string, string>
  ): Promise<void> {
    const flowResult = await runCommitMessageFlow(
      repository,
      displayPaths,
      renameMap
    );
    if (
      flowResult.cancelled ||
      !flowResult.message ||
      !flowResult.commitPaths
    ) {
      return;
    }

    const { message, commitPaths } = flowResult;

    // The composed message lives only in transient QuickPick state -
    // park it in the input box so a failed commit doesn't lose it
    // (executeCommit clears the box on success)
    repository.inputBox.value = message;

    await this.handleRepositoryOperation(
      () => executeCommit(repository, message, commitPaths),
      "Unable to commit",
      commitPaths.map(p => Uri.file(p))
    );
  }
}
