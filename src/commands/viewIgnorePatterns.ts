// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { window } from "vscode";
import { Command } from "./command";
import { Repository } from "../repository";
import { formatSvnError, logError } from "../util/errorLogger";
import { showActionFeedback } from "../util/actionFeedback";

interface DirectoryItem {
  label: string;
  description: string;
  directory: string;
  patterns: string[];
}

interface ActionItem {
  label: string;
  description: string;
  action: "edit" | "remove" | "back";
}

interface PatternItem {
  label: string;
  description: string;
  pattern: string;
}

export class ViewIgnorePatterns extends Command {
  constructor() {
    super("sven.viewIgnorePatterns");
  }

  public async execute() {
    const sourceControlManager = await this.getSourceControlManager();

    if (
      !sourceControlManager ||
      sourceControlManager.repositories.length === 0
    ) {
      window.showErrorMessage("No SVN repository found");
      return;
    }

    // Use first repository if only one, otherwise let user pick
    let repository: Repository;
    if (sourceControlManager.repositories.length === 1) {
      repository = sourceControlManager.repositories[0]!;
    } else {
      const picks = sourceControlManager.repositories.map(r => ({
        label: r.root,
        repository: r
      }));
      const pick = await window.showQuickPick(picks, {
        placeHolder: "Select repository"
      });
      if (!pick) return;
      repository = pick.repository;
    }

    await this.showDirectoryPicker(repository);
  }

  private async showDirectoryPicker(repository: Repository): Promise<void> {
    const allPatterns = await repository.getAllIgnorePatterns();

    if (allPatterns.size === 0) {
      showActionFeedback("No svn:ignore patterns found in this repository");
      return;
    }

    // Build directory items
    const items: DirectoryItem[] = [];
    for (const [dir, patterns] of allPatterns) {
      items.push({
        label: dir === "." ? "$(folder) Repository root" : `$(folder) ${dir}`,
        description: `${patterns.length} pattern${patterns.length === 1 ? "" : "s"}`,
        directory: dir,
        patterns
      });
    }

    const pick = await window.showQuickPick(items, {
      placeHolder: "Select directory to view/edit ignore patterns"
    });

    if (!pick) return;

    await this.showActionPicker(repository, pick.directory, pick.patterns);
  }

  private async showActionPicker(
    repository: Repository,
    directory: string,
    patterns: string[]
  ): Promise<void> {
    const actions: ActionItem[] = [
      {
        label: "$(edit) Edit patterns...",
        description: "Modify all patterns for this directory",
        action: "edit"
      },
      {
        label: "$(trash) Remove pattern...",
        description: "Remove a specific pattern",
        action: "remove"
      },
      {
        label: "$(arrow-left) Back",
        description: "Return to directory list",
        action: "back"
      }
    ];

    const pick = await window.showQuickPick(actions, {
      placeHolder: `${directory} - ${patterns.length} pattern(s): ${patterns.join(", ")}`
    });

    if (!pick) return;

    switch (pick.action) {
      case "edit":
        await this.editPatterns(repository, directory, patterns);
        break;
      case "remove":
        await this.removePattern(repository, directory, patterns);
        break;
      case "back":
        await this.showDirectoryPicker(repository);
        break;
    }
  }

  private async editPatterns(
    repository: Repository,
    directory: string,
    patterns: string[]
  ): Promise<void> {
    const currentValue = patterns.join("\n");

    const newValue = await window.showInputBox({
      prompt: `Edit ignore patterns for ${directory}`,
      value: currentValue,
      placeHolder: "Enter patterns (one per line, use \\n for newlines)",
      validateInput: _value => {
        // Allow empty to clear all patterns
        return undefined;
      }
    });

    if (newValue === undefined) {
      // User cancelled
      await this.showActionPicker(repository, directory, patterns);
      return;
    }

    try {
      if (newValue.trim() === "") {
        // Confirm before deleting all patterns
        const confirm = await window.showQuickPick(
          [
            {
              label: "Yes",
              description: `Remove all patterns from ${directory}`
            },
            { label: "No", description: "Cancel" }
          ],
          { placeHolder: "Remove ALL ignore patterns?" }
        );
        if (confirm?.label !== "Yes") {
          await this.showActionPicker(repository, directory, patterns);
          return;
        }
        // Delete property
        await repository.deleteIgnoreProperty(directory);
        showActionFeedback(`Removed all ignore patterns from ${directory}`);
        // Navigate back to directory picker after clearing
        await this.showDirectoryPicker(repository);
      } else {
        // Parse patterns (handle both actual newlines and \n escape sequences)
        const newPatterns = newValue
          .split(/\\n|\r?\n/)
          .map(p => p.trim())
          .filter(p => p.length > 0);

        await repository.setIgnoreProperty(newPatterns, directory);
        showActionFeedback(
          `Updated ignore patterns for ${directory}: ${newPatterns.join(", ")}`
        );
        // Refresh and show updated list
        await this.showActionPicker(repository, directory, newPatterns);
      }
    } catch (error) {
      logError("Failed to update ignore patterns", error);
      window.showErrorMessage(
        formatSvnError(error, "Failed to update ignore patterns")
      );
      await this.showActionPicker(repository, directory, patterns);
    }
  }

  private async removePattern(
    repository: Repository,
    directory: string,
    patterns: string[]
  ): Promise<void> {
    const items: PatternItem[] = patterns.map(p => ({
      label: p,
      description: "Click to remove",
      pattern: p
    }));

    const pick = await window.showQuickPick(items, {
      placeHolder: "Select pattern to remove"
    });

    if (!pick) {
      await this.showActionPicker(repository, directory, patterns);
      return;
    }

    // Confirm removal
    const confirm = await window.showQuickPick(
      [
        {
          label: "Yes",
          description: `Remove '${pick.pattern}' from ${directory}`
        },
        { label: "No", description: "Cancel" }
      ],
      { placeHolder: `Remove pattern '${pick.pattern}'?` }
    );

    if (confirm?.label !== "Yes") {
      await this.showActionPicker(repository, directory, patterns);
      return;
    }

    try {
      await repository.removeFromIgnore(pick.pattern, directory);
      showActionFeedback(`Removed '${pick.pattern}' from ${directory}`);

      // Refresh and show updated list
      const updatedPatterns = (
        await repository.getCurrentIgnore(directory)
      ).filter(p => p.trim() !== "");
      if (updatedPatterns.length > 0) {
        await this.showActionPicker(repository, directory, updatedPatterns);
      } else {
        await this.showDirectoryPicker(repository);
      }
    } catch (error) {
      logError("Failed to remove pattern", error);
      window.showErrorMessage(
        formatSvnError(error, "Failed to remove ignore pattern")
      );
      await this.showActionPicker(repository, directory, patterns);
    }
  }
}
