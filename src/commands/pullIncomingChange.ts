// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { SourceControlResourceState, window } from "vscode";
import { configuration } from "../helpers/configuration";
import { Repository } from "../repository";
import { Command } from "./command";
import { showActionFeedback } from "../util/actionFeedback";

interface PullBatchResult {
  results: string[];
  failureCount: number;
}

export class PullIncomingChange extends Command {
  constructor() {
    super("sven.treeview.pullIncomingChange");
  }

  private async pullBatch(
    repository: Repository,
    files: string[]
  ): Promise<PullBatchResult> {
    const results: string[] = [];
    let failureCount = 0;

    await Promise.all(
      files.map(async filePath => {
        try {
          const result = await repository.pullIncomingChange(filePath);
          results.push(result);
        } catch {
          failureCount++;
        }
      })
    );

    // Refresh remote changes once after batch completes
    repository.refreshRemoteChanges();

    return { results, failureCount };
  }

  private notifyPullBatch(result: PullBatchResult): void {
    if (result.failureCount > 0 && result.results.length === 0) {
      window.showErrorMessage(`Failed to update ${result.failureCount} files`);
      return;
    }

    if (result.failureCount > 0) {
      window.showWarningMessage(
        `Updated ${result.results.length} files, ${result.failureCount} failed`
      );
      return;
    }

    if (result.results.length === 1) {
      showActionFeedback(result.results[0] ?? "Updated 1 file");
      return;
    }

    if (result.results.length > 1) {
      showActionFeedback(`Updated ${result.results.length} files`);
    }
  }

  public async execute(...changes: SourceControlResourceState[]) {
    const showUpdateMessage = configuration.get<boolean>(
      "showUpdateMessage",
      true
    );

    const uris = this.resourceStatesToUris(changes);

    await this.runByRepositoryPaths(uris, async (repository, files) => {
      const result = await this.pullBatch(repository, files);

      // Show notification
      if (showUpdateMessage) {
        this.notifyPullBatch(result);
      }
    });
  }
}
