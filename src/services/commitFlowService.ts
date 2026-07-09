// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import {
  commands,
  InputBoxValidationSeverity,
  QuickPickItem,
  QuickPickItemKind,
  window
} from "vscode";
import {
  ConventionalCommitService,
  ConventionalCommit
} from "./conventionalCommitService";
import {
  PreCommitUpdateService,
  UpdateResult,
  IPreCommitUpdateRepository
} from "./preCommitUpdateService";
import { truncate } from "../util/formatting";

/**
 * Minimal repository surface CommitFlowService needs: the SCM input box.
 * Depending on this role instead of the concrete ~3000-line Repository keeps
 * the dependency direction pointing away from the god object.
 */
export interface ICommitMessageInput {
  readonly inputBox: { value: string };
}

/**
 * Result of the commit flow
 */
export interface CommitFlowResult {
  message?: string;
  selectedFiles?: string[];
  cancelled: boolean;
}

/**
 * Options for commit flow
 */
export interface CommitFlowOptions {
  updateBeforeCommit?: boolean;
  conventionalCommits?: boolean;
  /** Marks files with pending server changes in the selection picker */
  hasRemoteChange?: (filePath: string) => boolean;
}

interface TypePickItem extends QuickPickItem {
  type?: string;
  isPreviousMessage?: boolean;
  message?: string;
}

interface ConfirmPickItem extends QuickPickItem {
  action?: "commit" | "edit";
}

interface FilePickItem extends QuickPickItem {
  filePath: string;
}

function defaultFileName(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

function defaultRelativePath(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  if (parts.length <= 2) {
    return "";
  }
  return parts.slice(0, -1).join("/");
}

/**
 * Build the file-selection QuickPick items, badging files the server has
 * newer versions of ("commit safety": the author learns about the pending
 * incoming change BEFORE committing on top of it, not from the conflict).
 */
export function buildFilePickItems(
  filePaths: string[],
  hasRemoteChange?: (filePath: string) => boolean,
  getName: (p: string) => string = defaultFileName,
  getRelative: (p: string) => string = defaultRelativePath
): FilePickItem[] {
  return filePaths.map(filePath => {
    const changedOnServer = hasRemoteChange?.(filePath) ?? false;
    return {
      label: `$(file) ${getName(filePath)}`,
      description: changedOnServer
        ? `${getRelative(filePath)}  $(cloud-download) changed on server`.trim()
        : getRelative(filePath),
      filePath,
      picked: true
    };
  });
}

/**
 * Service orchestrating the multi-step commit QuickPick flow.
 * Implements VS Code UX guidelines for multi-step Quick Picks.
 */
export class CommitFlowService {
  private conventionalService: ConventionalCommitService;
  private updateService: PreCommitUpdateService;

  constructor(
    conventionalService?: ConventionalCommitService,
    updateService?: PreCommitUpdateService
  ) {
    this.conventionalService =
      conventionalService || new ConventionalCommitService();
    this.updateService = updateService || new PreCommitUpdateService();
  }

  /**
   * Run the complete commit flow
   */
  async runCommitFlow(
    repository: ICommitMessageInput & IPreCommitUpdateRepository,
    filePaths: string[],
    options: CommitFlowOptions = {}
  ): Promise<CommitFlowResult> {
    const { updateBeforeCommit = false, conventionalCommits = false } = options;

    // Step 0: File selection with checkboxes
    const selectedFiles = await this.showFileSelectionStep(
      filePaths,
      options.hasRemoteChange
    );
    if (!selectedFiles || selectedFiles.length === 0) {
      return { cancelled: true };
    }

    // Start pre-commit update in background (runs during message input)
    const updatePromise = updateBeforeCommit
      ? this.startPreCommitUpdate(repository, selectedFiles)
      : undefined;

    // Build commit message (user interacts while update runs)
    let message: string | undefined;

    if (conventionalCommits) {
      message = await this.runConventionalFlow(repository, selectedFiles);
    } else {
      message = await this.showCustomMessageStep(repository);
    }

    if (message === undefined) {
      return { cancelled: true };
    }

    if (updatePromise) {
      const proceed = await this.settlePreCommitUpdate(
        updatePromise,
        repository,
        message
      );
      if (!proceed) {
        return { cancelled: true };
      }
    }

    return { message, selectedFiles, cancelled: false };
  }

  /**
   * Kick off the pre-commit update in the background. Targets only the
   * committed files for speed; the .catch prevents an unhandled rejection
   * while the user is still in the message flow.
   */
  public startPreCommitUpdate(
    repository: ICommitMessageInput & IPreCommitUpdateRepository,
    files: string[]
  ): Promise<UpdateResult> {
    return this.updateService
      .runUpdate(repository, files)
      .catch((err): UpdateResult => ({ success: false, error: String(err) }));
  }

  /**
   * Await the pre-commit update and route its outcome. Returns whether the
   * commit should proceed. On conflict-abort or failure the TYPED MESSAGE
   * is preserved into the SCM input box (it used to be silently lost) and
   * the Source Control view is revealed so the conflicts are in sight.
   */
  public async settlePreCommitUpdate(
    updatePromise: Promise<UpdateResult>,
    repository: ICommitMessageInput,
    message: string
  ): Promise<boolean> {
    const updateResult = await updatePromise;

    if (updateResult.cancelled) {
      repository.inputBox.value = message;
      return false;
    }

    if (updateResult.hasConflicts) {
      const choice = await this.updateService.promptConflictResolution();
      if (choice === "abort") {
        repository.inputBox.value = message;
        void commands.executeCommand("workbench.view.scm");
        return false;
      }
    }

    if (!updateResult.success && !updateResult.hasConflicts) {
      window.showErrorMessage(`Update failed: ${updateResult.error}`);
      repository.inputBox.value = message;
      return false;
    }

    return true;
  }

  /**
   * Run conventional commit flow with type selection
   */
  private async runConventionalFlow(
    repository: ICommitMessageInput,
    filePaths: string[]
  ): Promise<string | undefined> {
    // Step 1: Select commit type
    const typeResult = await this.showTypeStep(repository);
    if (!typeResult) {
      return undefined;
    }

    // Handle previous message selection
    if (typeResult.isPreviousMessage && typeResult.message) {
      return typeResult.message;
    }

    // Handle custom message
    if (typeResult.type === "custom") {
      return this.showCustomMessageStep(repository);
    }

    // Step 2: Enter scope (optional)
    const scope = await this.showScopeStep(typeResult.type!);
    if (scope === undefined) {
      return undefined; // Cancelled
    }

    // Step 3+4: description with confirm loop (every branch returns)
    const existingMessage = repository.inputBox.value;

    for (;;) {
      const description = await this.showDescriptionStep(
        typeResult.type!,
        scope,
        existingMessage
      );
      if (description === undefined) {
        return undefined;
      }

      const commit: ConventionalCommit = {
        type: typeResult.type!,
        scope: scope || undefined,
        description
      };
      const message = this.conventionalService.format(commit);

      const confirmResult = await this.showConfirmStep(message, filePaths);
      if (confirmResult === undefined) {
        return undefined;
      }
      if (confirmResult === "commit") {
        return message;
      }
      // confirmResult === "edit" -> loop again
    }
  }

  /**
   * Show commit type selection (Step 1)
   */
  private async showTypeStep(
    repository: ICommitMessageInput
  ): Promise<TypePickItem | undefined> {
    const types = this.conventionalService.getCommitTypes();
    const items: TypePickItem[] = [];

    // Add previous message if available
    const prevMessage = repository.inputBox.value;
    if (prevMessage && prevMessage.trim()) {
      items.push({
        label: "$(history) Use previous message",
        description: truncate(prevMessage, 40),
        isPreviousMessage: true,
        message: prevMessage
      });
      items.push({
        label: "",
        kind: QuickPickItemKind.Separator
      });
    }

    // Add commit types
    for (const t of types) {
      items.push({
        label: `${t.icon} ${t.label}`,
        description: t.description,
        type: t.type
      });
    }

    const selected = await window.showQuickPick(items, {
      title: "Commit (1/3): type(scope): description",
      placeHolder: "Choose commit type"
    });

    return selected;
  }

  /**
   * Show scope input (Step 2)
   * Shows the message prefix being built (e.g., "feat: _")
   */
  private async showScopeStep(type: string): Promise<string | undefined> {
    const scope = await window.showInputBox({
      title: `Commit (2/3): ${type}(scope): description`,
      prompt: "Optional scope — narrows what this change affects",
      placeHolder: "Leave empty to skip"
    });

    // undefined means cancelled, empty string means skipped
    return scope;
  }

  /**
   * Show description input (Step 3)
   * Shows real-time character count as user types
   * Pre-populates with SCM input box value if available
   */
  private async showDescriptionStep(
    type: string,
    scope: string,
    existingMessage?: string
  ): Promise<string | undefined> {
    const prefix = scope ? `${type}(${scope}): ` : `${type}: `;
    const maxTotal = this.conventionalService.getMaxLength();

    // Try to extract description from existing message
    let initialValue = "";
    if (existingMessage) {
      // If message starts with prefix, extract description
      if (existingMessage.startsWith(prefix)) {
        initialValue = existingMessage.slice(prefix.length);
      } else {
        // Otherwise use the whole message (user can edit)
        initialValue = existingMessage;
      }
    }

    const description = await window.showInputBox({
      title: `Commit (3/3): ${prefix}description`,
      prompt: "Use imperative mood: add, fix, update, remove...",
      placeHolder: "If applied, this commit will...",
      value: initialValue,
      validateInput: value => {
        if (!value || value.trim() === "") {
          return {
            message: "Description required",
            severity: InputBoxValidationSeverity.Error
          };
        }
        const totalLen = prefix.length + value.length;
        const remaining = maxTotal - totalLen;

        if (remaining < 0) {
          return {
            message: `${totalLen}/${maxTotal} (${remaining}) - exceeds 50 char recommendation`,
            severity: InputBoxValidationSeverity.Warning
          };
        }
        // Show real-time character count as info
        return {
          message: `${totalLen}/${maxTotal}`,
          severity: InputBoxValidationSeverity.Info
        };
      }
    });

    return description;
  }

  /**
   * Show confirmation step with file list
   */
  private async showConfirmStep(
    message: string,
    filePaths: string[]
  ): Promise<"commit" | "edit" | undefined> {
    const items: ConfirmPickItem[] = [
      {
        label: `$(check) Commit ${filePaths.length} file(s)`,
        description: message,
        action: "commit"
      },
      {
        label: "$(edit) Edit message",
        description: "Go back and change description",
        action: "edit"
      },
      {
        label: "",
        kind: QuickPickItemKind.Separator
      }
    ];

    // Add file list preview (max 5)
    const previewFiles = filePaths.slice(0, 5);
    for (const file of previewFiles) {
      items.push({
        label: `  $(file) ${this.getFileName(file)}`,
        description: this.getRelativePath(file)
      });
    }

    if (filePaths.length > 5) {
      items.push({
        label: `  ... and ${filePaths.length - 5} more`
      });
    }

    const selected = await window.showQuickPick(items, {
      title: "Confirm commit",
      placeHolder: message
    });

    if (!selected) {
      return undefined;
    }

    return selected.action;
  }

  /**
   * Show file selection step with checkboxes (Step 0)
   * All files selected by default, user can deselect
   */
  private async showFileSelectionStep(
    filePaths: string[],
    hasRemoteChange?: (filePath: string) => boolean
  ): Promise<string[] | undefined> {
    if (filePaths.length === 0) {
      return [];
    }

    // Skip picker if only one file
    if (filePaths.length === 1) {
      return filePaths;
    }

    const items = buildFilePickItems(
      filePaths,
      hasRemoteChange,
      p => this.getFileName(p),
      p => this.getRelativePath(p)
    );

    const selected = await window.showQuickPick(items, {
      title: `Select files to commit (${filePaths.length} changed)`,
      placeHolder: "Check/uncheck files to include in commit",
      canPickMany: true
    });

    if (!selected) {
      return undefined; // Cancelled
    }

    if (selected.length === 0) {
      return undefined; // No files selected
    }

    return selected.map(item => item.filePath);
  }

  /**
   * Show custom message input (skip conventional format)
   * Shows real-time character count
   */
  private async showCustomMessageStep(
    repository: ICommitMessageInput
  ): Promise<string | undefined> {
    const maxLen = this.conventionalService.getMaxLength();

    return window.showInputBox({
      title: "Commit: Enter message",
      prompt: "Enter your commit message",
      value: repository.inputBox.value,
      placeHolder: "Your commit message",
      validateInput: value => {
        if (!value || value.trim() === "") {
          return {
            message: "Message required",
            severity: InputBoxValidationSeverity.Error
          };
        }
        const remaining = maxLen - value.length;
        if (remaining < 0) {
          return {
            message: `${value.length}/${maxLen} (${remaining}) - exceeds 50 char recommendation`,
            severity: InputBoxValidationSeverity.Warning
          };
        }
        // Show real-time character count as info
        return {
          message: `${value.length}/${maxLen}`,
          severity: InputBoxValidationSeverity.Info
        };
      }
    });
  }

  /**
   * Get file name from path
   */
  private getFileName(filePath: string): string {
    const parts = filePath.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || filePath;
  }

  /**
   * Get relative path (simplified)
   */
  private getRelativePath(filePath: string): string {
    const parts = filePath.replace(/\\/g, "/").split("/");
    if (parts.length <= 2) {
      return "";
    }
    return parts.slice(0, -1).join("/");
  }
}
