// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { Command, Disposable, Event, EventEmitter } from "vscode";
import { Operation } from "../common/types";
import { Repository } from "../repository";
import { FEEDBACK_TIMEOUT_MS } from "../util/actionFeedback";

interface ISyncStatusBarState {
  isIncomplete: boolean;
  isOperationRunning: boolean;
  isStatusRemoteRunning: boolean;
  isSyncRunning: boolean;
  needCleanUp: boolean;
  remoteChangedFiles: number;
}

export class SyncStatusBar {
  private static startState: ISyncStatusBarState = {
    isIncomplete: false,
    isOperationRunning: false,
    isStatusRemoteRunning: false,
    isSyncRunning: false,
    needCleanUp: false,
    remoteChangedFiles: 0
  };

  private _onDidChange = new EventEmitter<void>();
  get onDidChange(): Event<void> {
    return this._onDidChange.event;
  }
  private disposables: Disposable[] = [];

  private _state: ISyncStatusBarState = SyncStatusBar.startState;
  private get state() {
    return this._state;
  }
  private set state(state: ISyncStatusBarState) {
    this._state = state;
    this._onDidChange.fire();
  }

  constructor(private repository: Repository) {
    repository.onDidChangeStatus(this.onModelChange, this, this.disposables);
    repository.onDidChangeOperations(
      this.onOperationsChange,
      this,
      this.disposables
    );
    this._onDidChange.fire();
  }

  private onOperationsChange(): void {
    const isSyncRunning =
      this.repository.operations.isRunning(Operation.SwitchBranch) ||
      this.repository.operations.isRunning(Operation.NewBranch) ||
      this.repository.operations.isRunning(Operation.Update) ||
      this.repository.operations.isRunning(Operation.Merge);

    const isStatusRemoteRunning = this.repository.operations.isRunning(
      Operation.StatusRemote
    );

    const isOperationRunning = !this.repository.operations.isIdle();

    this.state = {
      ...this.state,
      isStatusRemoteRunning,
      isOperationRunning,
      isSyncRunning
    };
  }

  /** Transient outcome shown in place of the normal affordance. */
  private transient?: { text: string; timer: NodeJS.Timeout };

  /**
   * Flash an action outcome INSIDE this status bar item - feedback
   * where the action was initiated (e.g. "Updated to revision 3001."
   * after its update affordance was clicked), then revert.
   */
  public flashResult(text: string): void {
    if (this.transient) {
      clearTimeout(this.transient.timer);
    }
    this.transient = {
      text,
      timer: setTimeout(() => {
        this.transient = undefined;
        this._onDidChange.fire();
      }, FEEDBACK_TIMEOUT_MS)
    };
    this._onDidChange.fire();
  }

  private onModelChange(): void {
    this.state = {
      ...this.state,
      remoteChangedFiles: this.repository.remoteChangedFiles,
      // Wedged-WC affordances (cleanup / finish checkout) - without
      // these copies the branches below were unreachable
      needCleanUp: this.repository.needCleanUp,
      isIncomplete: this.repository.isIncomplete
    };
  }

  get command(): Command | undefined {
    let icon = "$(sync)";
    let text = "";
    let command = "";
    let tooltip = "";

    if (this.state.isSyncRunning) {
      command = "";
      icon = "$(sync~spin)";
      text = "";
      tooltip = "Updating Revision...";
    } else if (this.state.isStatusRemoteRunning) {
      command = "";
      icon = "$(sync~spin)";
      text = "";
      tooltip = "Checking remote updates...";
    } else if (this.state.isOperationRunning) {
      command = "";
      icon = "$(sync~spin)";
      text = "Running";
      tooltip = "Running...";
    } else if (this.transient) {
      // Outcome of the action this item initiated, shown in place
      command = "";
      icon = "$(check)";
      text = this.transient.text;
      tooltip = this.transient.text;
    } else if (this.state.needCleanUp) {
      command = "sven.cleanup";
      icon = "$(alert)";
      text = "Need cleanup";
      tooltip = "Run cleanup command";
    } else if (this.state.isIncomplete) {
      command = "sven.finishCheckout";
      icon = "$(issue-reopened)";
      text = "Incomplete (Need finish checkout)";
      tooltip = "Run update to complete";
    } else if (this.state.remoteChangedFiles > 0) {
      icon = "$(cloud-download)";
      command = "sven.incomingChanges";
      tooltip = "Preview or pull incoming changes";
      text = `${this.state.remoteChangedFiles}↓`;
    } else {
      command = "sven.update";
      tooltip = "Update Revision";
    }

    return {
      command,
      title: [icon, text].join(" ").trim(),
      tooltip,
      arguments: [this.repository]
    };
  }

  public dispose(): void {
    if (this.transient) {
      clearTimeout(this.transient.timer);
    }
    this.disposables.forEach(d => d.dispose());
  }
}
