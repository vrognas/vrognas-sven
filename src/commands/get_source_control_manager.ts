// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { SourceControlManager } from "../source_control_manager";
import { Command } from "./command";

export class GetSourceControlManager extends Command {
  constructor(protected sourceControlManager: SourceControlManager) {
    super("sven.getSourceControlManager");
  }

  public execute() {
    // Non-async: CommandResult requires void or a Promise, so return one
    return Promise.resolve(this.sourceControlManager);
  }
}
