// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { commands, window } from "vscode";
import { Command } from "./command";
import { Repository } from "../repository";

/**
 * Preview picker for incoming server changes. The sync status-bar counter
 * previously fired a full `svn update` directly - on a large checkout
 * that's a heavy, blind action for "I just want to see what's coming".
 */
export class IncomingChanges extends Command {
  constructor() {
    super("sven.incomingChanges", { repository: true });
  }

  public async execute(repository: Repository) {
    const n = repository.remoteChangedFiles;
    const items = [
      {
        label: "$(cloud-download) Update Working Copy",
        description: "svn update - pull everything now",
        action: "update"
      },
      {
        label: "$(history) Show Incoming Revisions",
        description: "Reveal the server-only commits in Repo History",
        action: "history"
      },
      {
        label: "$(list-unordered) Show Changed Files",
        description: "Open the Remote Changes group in Source Control",
        action: "files"
      }
    ];

    const selected = await window.showQuickPick(items, {
      placeHolder:
        n > 0 ? `${n} file(s) changed on the server` : "Incoming changes"
    });
    if (!selected) {
      return;
    }

    switch (selected.action) {
      case "update":
        await commands.executeCommand("sven.update", repository);
        break;
      case "history":
        await commands.executeCommand("sven.repolog.showIncoming");
        break;
      case "files":
        await commands.executeCommand("workbench.view.scm");
        break;
    }
  }
}
