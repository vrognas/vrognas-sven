// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

"use strict";

import { Uri } from "vscode";
import { Command } from "../command";
import {
  blameStateManager,
  getBlameTargetUri
} from "../../blame/blameStateManager";
import { showActionFeedback } from "../../util/actionFeedback";

export class ShowBlame extends Command {
  constructor() {
    super("sven.blame.showBlame");
  }

  execute(uri?: Uri): void {
    const target = getBlameTargetUri(uri);
    if (!target) return;

    blameStateManager.setBlameEnabled(target, true);
    showActionFeedback(`SVN Blame enabled for ${target.fsPath}`);
  }
}
