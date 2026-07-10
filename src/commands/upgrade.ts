// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { window } from "vscode";
import { configuration } from "../helpers/configuration";
import { fixPathSeparator } from "../util";
import { Command } from "./command";
import { showActionFeedback } from "../util/actionFeedback";

export class Upgrade extends Command {
  constructor() {
    super("sven.upgrade");
  }

  public async execute(folderPath: string) {
    if (!folderPath) {
      return;
    }

    if (configuration.get("ignoreWorkingCopyIsTooOld", false)) {
      return;
    }

    folderPath = fixPathSeparator(folderPath);

    const yes = "Yes";
    const no = "No";
    const neverShowAgain = "Don't Show Again";
    const choice = await window.showWarningMessage(
      "You want upgrade the working copy (svn upgrade)?",
      yes,
      no,
      neverShowAgain
    );
    const sourceControlManager = await this.getSourceControlManager();

    if (choice === yes) {
      const upgraded =
        await sourceControlManager.upgradeWorkingCopy(folderPath);

      if (upgraded) {
        showActionFeedback(`Working copy "${folderPath}" upgraded`);
        void sourceControlManager.tryOpenRepository(folderPath);
      } else {
        window.showErrorMessage(
          `Error on upgrading working copy "${folderPath}". See log for more detail`
        );
      }
    } else if (choice === neverShowAgain) {
      return configuration.update("ignoreWorkingCopyIsTooOld", true);
    }

    return;
  }
}
