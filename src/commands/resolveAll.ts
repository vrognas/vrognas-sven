// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { pickConflictOption } from "../conflictItems";
import { Repository } from "../repository";
import { Command } from "./command";
import { showActionFeedback } from "../util/actionFeedback";

export class ResolveAll extends Command {
  constructor() {
    super("sven.resolveAll", { repository: true });
  }

  public async execute(repository: Repository) {
    const conflicts = repository.conflicts.resourceStates;

    if (!conflicts.length) {
      showActionFeedback("No Conflicts");
      return;
    }

    for (const conflict of conflicts) {
      const placeHolder = `Select conflict option for ${conflict.resourceUri.path}`;
      const choice = await pickConflictOption(placeHolder);

      if (!choice) {
        return;
      }

      await this.handleRepositoryOperation(async () => {
        // Invocable from the palette where the SCM view (the visible
        // effect) may be closed - status bar
        const response = await repository.resolve(
          [conflict.resourceUri.path],
          choice.label
        );
        showActionFeedback(response);
      }, "Unable to resolve conflict");
    }
  }
}
