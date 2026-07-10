// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { QuickPickItem, window, Uri, commands } from "vscode";
import { Command } from "./command";
import { Repository } from "../repository";
import { confirmDestructive } from "../ui";
import * as path from "path";
import { showActionFeedback } from "../util/actionFeedback";

interface EolStyleFileItem extends QuickPickItem {
  filePath: string;
  value: string;
}

/**
 * Manage svn:eol-style properties across the repository.
 * View all files with eol-style, change values, or clear all.
 */
export class ManageEolStyle extends Command {
  constructor() {
    super("sven.manageEolStyle", { repository: true });
  }

  public async execute(repository: Repository) {
    // Get all files with eol-style
    const eolStyleFiles = await repository.getAllEolStyleFiles();

    if (eolStyleFiles.size === 0) {
      const addNew = await window.showInformationMessage(
        "No files have svn:eol-style set.",
        "Set EOL Style on Files"
      );
      if (addNew === "Set EOL Style on Files") {
        // Trigger file picker or suggest using context menu
        window.showInformationMessage(
          "Right-click on files in Explorer and select 'Set EOL Style' to add the property."
        );
      }
      return;
    }

    // Build list of files with their eol-style values
    const items: EolStyleFileItem[] = [];

    for (const [filePath, value] of eolStyleFiles) {
      const fileName = path.basename(filePath);
      const dirName = path.dirname(filePath);

      items.push({
        label: `$(file) ${fileName}`,
        description: value,
        detail: dirName === "." ? undefined : dirName,
        filePath,
        value
      });
    }

    // Sort by path
    items.sort((a, b) => a.filePath.localeCompare(b.filePath));

    // Add action items at the top
    const actionItems: QuickPickItem[] = [
      {
        label: "$(trash) Clear All EOL Styles",
        description: `Remove svn:eol-style from all ${items.length} files`,
        detail: "Warning: This action cannot be undone"
      },
      { label: "", kind: -1 } as QuickPickItem // Separator
    ];

    const allItems = [...actionItems, ...items];

    const selected = await window.showQuickPick(allItems, {
      placeHolder: `${items.length} file(s) have svn:eol-style set`,
      title: "Manage EOL Styles",
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (!selected) return;

    // Handle "Clear All" action
    if (selected.label.includes("Clear All")) {
      await this.clearAllEolStyles(repository, eolStyleFiles);
      return;
    }

    // Handle individual file selection
    const fileItem = selected as EolStyleFileItem;
    if (fileItem.filePath) {
      await this.manageFileEolStyle(repository, fileItem);
    }
  }

  private async clearAllEolStyles(
    repository: Repository,
    files: Map<string, string>
  ): Promise<void> {
    const confirmed = await confirmDestructive(
      `Remove svn:eol-style from ${files.size} file(s)?`,
      "Remove All"
    );
    if (!confirmed) return;

    let successCount = 0;
    for (const [filePath] of files) {
      try {
        const result = await repository.removeEolStyle(filePath, false);
        if (result.exitCode === 0) {
          successCount++;
        }
      } catch {
        // Continue on error
      }
    }

    showActionFeedback(
      `Removed svn:eol-style from ${successCount} of ${files.size} file(s)`
    );
  }

  private async manageFileEolStyle(
    repository: Repository,
    fileItem: EolStyleFileItem
  ): Promise<void> {
    const actions: QuickPickItem[] = [
      {
        label: "$(edit) Change EOL Style",
        description: `Current: ${fileItem.value}`
      },
      {
        label: "$(trash) Remove EOL Style",
        description: "Delete the property from this file"
      },
      {
        label: "$(go-to-file) Open File",
        description: "Open the file in editor"
      }
    ];

    const action = await window.showQuickPick(actions, {
      placeHolder: fileItem.filePath,
      title: `Manage EOL Style: ${path.basename(fileItem.filePath)}`
    });

    if (!action) return;

    if (action.label.includes("Change")) {
      // Reuse SetEolStyle logic
      const values = ["native", "LF", "CRLF", "CR"];
      const selected = await window.showQuickPick(
        values.map(v => ({
          label: v,
          picked: v === fileItem.value
        })),
        {
          placeHolder: "Select new EOL style",
          title: `Change EOL Style for ${path.basename(fileItem.filePath)}`
        }
      );

      if (selected) {
        const result = await repository.setEolStyle(
          fileItem.filePath,
          selected.label as "native" | "LF" | "CRLF" | "CR",
          false
        );
        if (result.exitCode === 0) {
          showActionFeedback(
            `Changed eol-style to ${selected.label} on ${path.basename(fileItem.filePath)}`
          );
        }
      }
    } else if (action.label.includes("Remove")) {
      const result = await repository.removeEolStyle(fileItem.filePath, false);
      if (result.exitCode === 0) {
        showActionFeedback(
          `Removed eol-style from ${path.basename(fileItem.filePath)}`
        );
      }
    } else if (action.label.includes("Open")) {
      const workspaceRoot = repository.workspaceRoot;
      const fullPath = path.isAbsolute(fileItem.filePath)
        ? fileItem.filePath
        : path.join(workspaceRoot, fileItem.filePath);
      await commands.executeCommand("vscode.open", Uri.file(fullPath));
    }
  }
}
