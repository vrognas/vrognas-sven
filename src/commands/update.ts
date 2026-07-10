// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { commands, ProgressLocation, window } from "vscode";
import { configuration } from "../helpers/configuration";
import { Repository } from "../repository";
import { Command } from "./command";
import { showActionFeedback } from "../util/actionFeedback";

export class Update extends Command {
  constructor() {
    super("sven.update", { repository: true });
  }

  public async execute(repository: Repository) {
    await this.handleRepositoryOperation(async () => {
      const ignoreExternals = configuration.get<boolean>(
        "update.ignoreExternals",
        false
      );
      const showUpdateMessage = configuration.get<boolean>(
        "showUpdateMessage",
        true
      );

      const result = await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: "Updating from repository..."
        },
        () => repository.updateRevision(ignoreExternals)
      );

      // Show conflict warning with action button
      if (result.conflicts.length > 0) {
        const fileList = result.conflicts.slice(0, 3).join(", ");
        const more =
          result.conflicts.length > 3
            ? ` (+${result.conflicts.length - 3} more)`
            : "";
        const conflictMsg =
          result.conflicts.length === 1
            ? `Conflict: ${result.conflicts[0]}`
            : `${result.conflicts.length} conflicts: ${fileList}${more}`;

        const choice = await window.showWarningMessage(
          conflictMsg,
          "Resolve Conflicts",
          "View SCM"
        );
        if (choice === "Resolve Conflicts") {
          await commands.executeCommand("sven.resolveAll");
        } else if (choice === "View SCM") {
          await commands.executeCommand("workbench.view.scm");
        }
      } else if (showUpdateMessage && result.revision !== null) {
        showActionFeedback(result.message);
      } else if (showUpdateMessage) {
        showActionFeedback("Update completed");
      }
    }, "Unable to update");
  }
}
