// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

"use strict";

import {
  Disposable,
  env,
  StatusBarAlignment,
  StatusBarItem,
  TextEditor,
  TextEditorSelectionChangeEvent,
  Uri,
  window
} from "vscode";
import { debounce } from "../decorators";
import { ISvnBlameLine, Operation, Status } from "../common/types";
import { BLAME_INVALIDATING_OPERATIONS } from "../util";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import { blameConfiguration } from "./blameConfiguration";
import { blameStateManager } from "./blameStateManager";
import { logError } from "../util/errorLogger";
import { formatBlameDate } from "../util/formatting";

/**
 * BlameStatusBar manages the status bar item showing blame info for current line
 * Singleton instance (unlike BlameProvider which is per-repo).
 *
 * Blame data is fetched via `Repository.blame`, which is itself
 * cached by `SvnRepository._blameCache` (5min TTL). No local cache layer
 * here — a redundant TTL of the same length plus over-eager invalidation
 * on edit/save (BASE blame doesn't change on a local edit) was previously
 * adding nothing on top of the shared cache.
 */
export class BlameStatusBar implements Disposable {
  private statusBarItem: StatusBarItem;
  private disposables: Disposable[] = [];
  // Last `${uri}#${line}` the status bar was updated for; selection events
  // on the same line are skipped before they reach the blame pipeline.
  private lastLineKey?: string;

  constructor(private sourceControlManager: SourceControlManager) {
    // Create status bar item (right-aligned, priority 100)
    this.statusBarItem = window.createStatusBarItem(
      "sven.blame.statusBar",
      StatusBarAlignment.Right,
      100
    );

    // Command for click action
    this.statusBarItem.command = "sven.showBlameCommit";

    // Register event listeners
    this.registerListeners();
  }

  /**
   * Register event listeners
   */
  private registerListeners(): void {
    this.disposables.push(
      // Cursor position changes (debounced)
      window.onDidChangeTextEditorSelection(e => this.onSelectionChanged(e)),

      // Active editor changes
      window.onDidChangeActiveTextEditor(e => this.onActiveEditorChanged(e)),

      // (Document change / save invalidation removed — BASE blame doesn't
      //  change on local edit/save, and SvnRepository._blameCache is the
      //  authoritative cache below us.)

      // Configuration changes
      blameConfiguration.onDidChange(() => this.onConfigurationChanged()),

      // Blame state changes
      blameStateManager.onDidChangeState(() => this.onBlameStateChanged())
    );

    // Mutating repository operations change BASE content; without this the
    // same-line skip would pin pre-op blame while the cursor doesn't move.
    // (Guarded: stubbed managers in unit tests may lack instance fields.)
    const hookRepository = (repo: Repository) => {
      if (typeof repo.onDidRunOperation === "function") {
        this.disposables.push(
          repo.onDidRunOperation(op => this.onRepositoryOperation(op))
        );
      }
    };
    (this.sourceControlManager.repositories ?? []).forEach(hookRepository);
    if (typeof this.sourceControlManager.onDidOpenRepository === "function") {
      this.disposables.push(
        this.sourceControlManager.onDidOpenRepository(hookRepository)
      );
    }

    // Initial update
    if (window.activeTextEditor) {
      void this.onActiveEditorChanged(window.activeTextEditor);
    }
  }

  /**
   * Update status bar for current line (debounced 150ms)
   */
  @debounce(150)
  public async updateStatusBar(): Promise<void> {
    const editor = window.activeTextEditor;

    // Hide if no editor
    if (!editor) {
      this.lastLineKey = undefined;
      this.statusBarItem.hide();
      return;
    }

    const lineKey = `${editor.document.uri.toString()}#${editor.selection.active.line}`;

    // Check if should show
    if (!this.shouldShowStatusBar(editor.document.uri)) {
      this.lastLineKey = lineKey; // deterministic - no point retrying
      this.statusBarItem.hide();
      return;
    }

    // Size gates: skip files BlameProvider refuses for performance
    // (over-limit CSVs, files over largeFileLimit). Silent - no toast.
    const doc = editor.document;
    if (
      blameConfiguration.isCsvLike(doc.uri) &&
      doc.lineCount > blameConfiguration.getCsvLineLimit()
    ) {
      this.lastLineKey = lineKey; // deterministic - no point retrying
      this.statusBarItem.hide();
      return;
    }
    if (
      blameConfiguration.isFileTooLarge(doc.lineCount) &&
      blameConfiguration.shouldWarnLargeFile()
    ) {
      this.lastLineKey = lineKey; // deterministic - no point retrying
      this.statusBarItem.hide();
      return;
    }

    // Get current line number (1-indexed)
    const lineNumber = editor.selection.active.line + 1;

    // Fetch blame data for file (cached)
    const blameData = await this.getBlameData(editor.document.uri);
    if (!blameData) {
      // Failure or unversioned: leave lastLineKey unset so the next
      // same-line event retries (transient errors aren't negative-cached)
      this.lastLineKey = undefined;
      this.showUncommittedStatus();
      return;
    }

    // Find blame info for current line
    const blameLine = blameData.find(b => b.lineNumber === lineNumber);

    if (blameLine && blameLine.revision) {
      // Show blame info
      this.lastLineKey = lineKey;
      this.statusBarItem.text = this.formatStatusBarText(blameLine);
      this.statusBarItem.tooltip = this.formatTooltip(blameLine);
      this.statusBarItem.show();
    } else {
      // Uncommitted line: keep retryable (data may arrive post-commit)
      this.lastLineKey = undefined;
      this.showUncommittedStatus();
    }
  }

  /**
   * Show commit details QuickPick (called on status bar click)
   */
  public async showCommitDetails(): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor) {
      return;
    }

    const lineNumber = editor.selection.active.line + 1;
    const blameData = await this.getBlameData(editor.document.uri);
    if (!blameData) {
      return;
    }

    const blameLine = blameData.find(b => b.lineNumber === lineNumber);
    if (!blameLine || !blameLine.revision) {
      window.showInformationMessage("No blame information for this line");
      return;
    }

    // Show QuickPick with actions
    const items = [
      {
        label: "$(file-code) Show Commit",
        description: `r${blameLine.revision}`,
        action: "show"
      },
      {
        label: "$(clippy) Copy Revision",
        description: `r${blameLine.revision}`,
        action: "copy"
      },
      {
        label: "$(git-compare) Toggle Blame",
        description: "Show/hide blame decorations",
        action: "toggle"
      }
    ];

    const selected = await window.showQuickPick(items, {
      placeHolder: `Commit r${blameLine.revision} by ${blameLine.author}`
    });

    if (selected) {
      await this.executeAction(selected.action, blameLine, editor.document.uri);
    }
  }

  /**
   * Dispose status bar
   */
  public dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }

  // ===== Event Handlers =====

  private onSelectionChanged(event: TextEditorSelectionChangeEvent): void {
    // Only the active editor drives the status bar
    const editor = event.textEditor;
    if (editor !== window.activeTextEditor) {
      return;
    }

    // Same-line skip: cheap synchronous check per event; updateStatusBar
    // (debounced 150ms) is only scheduled when the line actually changed.
    // lastLineKey is written by updateStatusBar on DEFINITIVE outcomes only,
    // so a transient blame failure stays retryable on the same line.
    const key = `${editor.document.uri.toString()}#${editor.selection.active.line}`;
    if (key === this.lastLineKey) {
      return;
    }
    void this.updateStatusBar();
  }

  private onRepositoryOperation(operation: Operation): void {
    if (!BLAME_INVALIDATING_OPERATIONS.has(operation)) {
      return;
    }
    this.lastLineKey = undefined;
    void this.updateStatusBar();
  }

  private async onActiveEditorChanged(
    _editor: TextEditor | undefined
  ): Promise<void> {
    this.lastLineKey = undefined;
    await this.updateStatusBar();
  }

  private async onConfigurationChanged(): Promise<void> {
    this.lastLineKey = undefined;
    await this.updateStatusBar();
  }

  private async onBlameStateChanged(): Promise<void> {
    this.lastLineKey = undefined;
    await this.updateStatusBar();
  }

  // ===== Helper Methods =====

  /**
   * Check if should show status bar for URI
   */
  private shouldShowStatusBar(uri: Uri): boolean {
    // Must be file scheme
    if (uri.scheme !== "file") {
      return false;
    }

    // Check configuration
    if (
      !blameConfiguration.isEnabled() ||
      !blameConfiguration.isStatusBarEnabled()
    ) {
      return false;
    }

    // Check state manager
    if (!blameStateManager.shouldShowBlame(uri)) {
      return false;
    }

    return true;
  }

  /**
   * Get blame data for URI. No local cache — the underlying
   * `SvnRepository._blameCache` (5min TTL) is the single source of truth.
   */
  private async getBlameData(uri: Uri): Promise<ISvnBlameLine[] | undefined> {
    const repository = this.sourceControlManager.getRepository(uri);
    if (!repository) {
      return undefined;
    }

    // Wait for initial status to load before checking file version
    await repository.statusReady;

    // Skip files that can't be blamed:
    // - UNVERSIONED/IGNORED/NONE: not under version control
    // - ADDED: scheduled for addition but never committed (E195002)
    const resource = repository.getResourceFromFile(uri);
    if (resource) {
      if (
        resource.type === Status.UNVERSIONED ||
        resource.type === Status.IGNORED ||
        resource.type === Status.NONE ||
        resource.type === Status.ADDED
      ) {
        return undefined;
      }
    } else {
      const parentStatus = repository.isInsideUnversionedOrIgnored(uri.fsPath);
      if (
        parentStatus === Status.UNVERSIONED ||
        parentStatus === Status.IGNORED
      ) {
        return undefined;
      }
    }

    try {
      return await repository.blame(uri.fsPath);
    } catch (err) {
      logError("BlameStatusBar: Failed to fetch blame data", err);
      return undefined;
    }
  }

  /**
   * Format status bar text using template
   */
  private formatStatusBarText(line: ISvnBlameLine): string {
    const template = blameConfiguration.getStatusBarTemplate();
    const dateFormat = blameConfiguration.getDateFormat();

    const revision = line.revision || "???";
    const author = line.author || "unknown";
    const date = formatBlameDate(line.date, dateFormat);
    const message = ""; // Message fetching deferred to Phase 3 (hover)

    return template
      .replace(/\$\{revision\}/g, revision)
      .replace(/\$\{author\}/g, author)
      .replace(/\$\{date\}/g, date)
      .replace(/\$\{message\}/g, message)
      .replace(/\s+-\s+$/g, "") // Remove trailing " - " if message empty
      .trim();
  }

  /**
   * Format tooltip content
   */
  private formatTooltip(line: ISvnBlameLine): string {
    const parts = [
      `Revision: r${line.revision}`,
      `Author: ${line.author}`,
      `Date: ${new Date(line.date!).toLocaleString()}`
    ];

    // Add merge info if present
    if (line.merged) {
      parts.push(
        "",
        `Merged from: r${line.merged.revision} (${line.merged.author})`
      );
    }

    parts.push("", "Click for actions");

    return parts.join("\n");
  }

  /**
   * Show uncommitted status
   */
  private showUncommittedStatus(): void {
    this.statusBarItem.text = "$(edit) Not committed";
    this.statusBarItem.tooltip = "Line not yet committed to SVN";
    this.statusBarItem.show();
  }

  /**
   * Execute QuickPick action
   */
  private async executeAction(
    action: string,
    blameLine: ISvnBlameLine,
    uri: Uri
  ): Promise<void> {
    switch (action) {
      case "show":
        // Show commit details - delegate to log command
        window.showInformationMessage(
          `Commit r${blameLine.revision} by ${blameLine.author} on ${blameLine.date}`
        );
        break;

      case "copy":
        // Copy revision to clipboard
        await env.clipboard.writeText(blameLine.revision!);
        window.showInformationMessage(
          `Copied r${blameLine.revision} to clipboard`
        );
        break;

      case "toggle":
        // Toggle blame for this file
        blameStateManager.toggleBlame(uri);
        break;
    }
  }
}
