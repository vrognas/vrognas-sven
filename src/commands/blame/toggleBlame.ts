// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

"use strict";

import { Uri, window } from "vscode";
import { Command } from "../command";
import {
  blameStateManager,
  getBlameTargetUri
} from "../../blame/blameStateManager";

export class ToggleBlame extends Command {
  constructor() {
    super("sven.blame.toggleBlame");
  }

  execute(uri?: Uri): void {
    const target = getBlameTargetUri(uri);
    if (!target) return;

    const newState = blameStateManager.toggleBlame(target);
    const action = newState ? "enabled" : "disabled";
    window.showInformationMessage(`SVN Blame ${action} for ${target.fsPath}`);
  }
}
