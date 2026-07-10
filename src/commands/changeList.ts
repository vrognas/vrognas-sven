// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { Uri, window } from "vscode";
import { inputSwitchChangelist } from "../changelistItems";
import { Resource } from "../resource";
import { Repository } from "../repository";
import { normalizePath } from "../util";
import { logError } from "../util/errorLogger";
import { Command } from "./command";

export class ChangeList extends Command {
  constructor() {
    super("sven.changelist");
  }

  private canRemovePathsFromChangelists(
    repository: Repository,
    paths: string[]
  ): boolean {
    const normalizedPaths = new Set(paths.map(normalizePath));
    return Array.from(repository.changelists.values()).some(group =>
      group.resourceStates.some(state =>
        normalizedPaths.has(normalizePath(state.resourceUri.path))
      )
    );
  }

  private resolveCommandUris(
    args: (Resource | Uri | Uri[])[]
  ): Uri[] | undefined {
    const extractedUris = this.extractUris(args as unknown[]);

    if (args[0] instanceof Resource) {
      return this.toUris(args as Resource[]);
    }
    if (extractedUris) {
      return extractedUris;
    }
    if (window.activeTextEditor) {
      return [window.activeTextEditor.document.uri];
    }

    logError(
      "Unhandled type for changelist command",
      new Error("No valid URI source")
    );
    return undefined;
  }

  private async resolveSingleRepository(
    uris: Uri[]
  ): Promise<Repository | undefined> {
    const sourceControlManager = await this.getSourceControlManager();
    const repositories = uris
      .map(uri => sourceControlManager.getRepositoryFromUri(uri))
      .filter(
        (repository): repository is Repository =>
          repository !== undefined && repository !== null
      );

    if (repositories.length === 0) {
      window.showErrorMessage(
        "Files are not under version control and cannot be added to a change list"
      );
      return undefined;
    }

    if (new Set(repositories).size !== 1) {
      window.showErrorMessage(
        "Unable to add files from different repositories to change list"
      );
      return undefined;
    }

    if (repositories.length !== uris.length) {
      window.showErrorMessage(
        "Some Files are not under version control and cannot be added to a change list"
      );
      return undefined;
    }

    return repositories[0];
  }

  private async applyChangelistChange(
    repository: Repository,
    paths: string[],
    changelistName: string | false
  ): Promise<void> {
    const pathList = paths.join(",");
    let operation: () => Promise<void>;
    let errorMessage: string;

    if (changelistName === false) {
      operation = async () => {
        await repository.removeChangelist(paths);
      };
      errorMessage = `Unable to remove file "${pathList}" from changelist`;
    } else {
      operation = async () => {
        // Silent: the files visibly moving into the changelist group
        // in the SCM view IS the feedback
        await repository.addChangelist(paths, changelistName);
      };
      errorMessage = `Unable to add file "${pathList}" to changelist "${changelistName}"`;
    }

    await this.handleRepositoryOperation(operation, errorMessage);
  }

  public async execute(...args: (Resource | Uri | Uri[])[]) {
    const uris = this.resolveCommandUris(args);
    if (!uris) {
      return;
    }

    const repository = await this.resolveSingleRepository(uris);
    if (!repository) {
      return;
    }

    const paths = uris.map(uri => uri.fsPath);
    const canRemove = this.canRemovePathsFromChangelists(repository, paths);

    const changelistName = await inputSwitchChangelist(repository, canRemove);

    if (changelistName === undefined) {
      return;
    }

    await this.applyChangelistChange(repository, paths, changelistName);
  }
}
