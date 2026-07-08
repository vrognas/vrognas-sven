// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

"use strict";

import { Uri, window } from "vscode";
import { Command } from "../command";

/**
 * Command shown for untracked files (circle-slash icon)
 * Shows info message, does not toggle state
 */
export class UntrackedInfo extends Command {
  constructor() {
    super("sven.blame.untrackedInfo");
  }

  execute(_uri?: Uri): void {
    // Show subtle info message
    window.showInformationMessage("File not tracked by SVN");
  }
}
