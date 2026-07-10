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

export class ClearBlame extends Command {
  constructor() {
    super("sven.blame.clearBlame");
  }

  execute(uri?: Uri): void {
    const target = getBlameTargetUri(uri);
    if (!target) return;

    blameStateManager.clearBlame(target);
    showActionFeedback(`SVN Blame cleared for ${target.fsPath}`);
  }
}
