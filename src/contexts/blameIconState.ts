// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { Disposable, window } from "vscode";
import { blameStateManager } from "../blame/blameStateManager";
import { Status } from "../common/types";
import { IDisposable, setVscodeContext } from "../util";
import { logError } from "../util/errorLogger";
import { SourceControlManager } from "../source_control_manager";

export class BlameIconState implements IDisposable {
  private disposables: Disposable[] = [];

  // Remember last-set context values so we skip the cross-IPC setContext
  // call when nothing changed. updateIconContext fires on every editor
  // switch + every status refresh, so most invocations are no-ops.
  private lastActiveForFile?: boolean;
  private lastUntrackedFile?: boolean;

  constructor(private sourceControlManager: SourceControlManager) {
    // Listen to blame state changes
    blameStateManager.onDidChangeState(
      () => this.updateIconContext(),
      this,
      this.disposables
    );

    // Listen to active editor changes
    window.onDidChangeActiveTextEditor(
      () => this.updateIconContext(),
      this,
      this.disposables
    );

    // Listen to repository discovery
    sourceControlManager.onDidOpenRepository(
      () => this.updateIconContext(),
      this,
      this.disposables
    );

    // Listen to repository status changes (for file status updates)
    sourceControlManager.onDidChangeStatusRepository(
      () => this.updateIconContext(),
      this,
      this.disposables
    );

    // Set initial state
    void this.updateIconContext().catch(err => {
      logError("BlameIconState initial context update failed", err);
      // Set safe defaults
      void setVscodeContext("svnBlameActiveForFile", false);
      void setVscodeContext("svnBlameUntrackedFile", false);
    });
  }

  private async updateIconContext(): Promise<void> {
    const editor = window.activeTextEditor;

    if (!editor || editor.document.uri.scheme !== "file") {
      await this.applyContext(false, false);
      return;
    }

    // Check if file is tracked in SVN
    const repository = this.sourceControlManager.getRepositoryFromUri(
      editor.document.uri
    );

    // No repository found - file not in SVN workspace
    if (!repository) {
      await this.applyContext(false, false);
      return;
    }

    const resource = repository.getResourceFromFile(editor.document.uri);

    // Resource not loaded yet - repository still indexing OR file not tracked
    if (!resource) {
      const parentStatus = repository.isInsideUnversionedOrIgnored(
        editor.document.uri.fsPath
      );
      if (
        parentStatus === Status.UNVERSIONED ||
        parentStatus === Status.IGNORED
      ) {
        await this.applyContext(false, true);
        return;
      }
      // No resource = clean file (not in change index)
      // Check state manager for actual blame state
      const isEnabled = blameStateManager.isBlameEnabled(editor.document.uri);
      await this.applyContext(isEnabled, false);
      return;
    }

    // Check if file cannot be blamed:
    // - UNVERSIONED/IGNORED/NONE: not under version control
    // - ADDED: scheduled for addition but never committed (E195002)
    const cannotBlame =
      resource.type === Status.UNVERSIONED ||
      resource.type === Status.IGNORED ||
      resource.type === Status.NONE ||
      resource.type === Status.ADDED;

    if (cannotBlame) {
      await this.applyContext(false, true);
    } else {
      const isEnabled = blameStateManager.isBlameEnabled(editor.document.uri);
      await this.applyContext(isEnabled, false);
    }
  }

  /**
   * Push context only when values changed. setVscodeContext routes through
   * `commands.executeCommand("setContext", ...)`, which crosses an extension
   * IPC boundary, so it's worth skipping when state is unchanged.
   */
  private async applyContext(
    activeForFile: boolean,
    untrackedFile: boolean
  ): Promise<void> {
    if (this.lastActiveForFile !== activeForFile) {
      this.lastActiveForFile = activeForFile;
      await setVscodeContext("svnBlameActiveForFile", activeForFile);
    }
    if (this.lastUntrackedFile !== untrackedFile) {
      this.lastUntrackedFile = untrackedFile;
      await setVscodeContext("svnBlameUntrackedFile", untrackedFile);
    }
  }

  public dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
