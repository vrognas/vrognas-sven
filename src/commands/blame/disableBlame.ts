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

/**
 * Command shown when blame is enabled (eye icon)
 * Clicking disables blame for the file
 */
export class DisableBlame extends Command {
  constructor() {
    super("sven.blame.disableBlame");
  }

  execute(uri?: Uri): void {
    const target = getBlameTargetUri(uri);
    if (!target) return;
    blameStateManager.setBlameEnabled(target, false);
  }
}
