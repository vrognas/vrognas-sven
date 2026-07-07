// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

"use strict";

import { Disposable, Event, EventEmitter, Uri, window } from "vscode";
import { blameConfiguration } from "./blameConfiguration";

/**
 * Get target URI from argument or active editor.
 * Shared by all blame commands.
 */
export function getBlameTargetUri(uri?: Uri): Uri | undefined {
  if (uri) return uri;
  return window.activeTextEditor?.document.uri;
}

/**
 * Manages per-file and global blame state
 */
export class BlameStateManager implements Disposable {
  private fileStates = new Map<string, boolean>();
  private globalEnabled = true;
  private _onDidChangeState = new EventEmitter<Uri | undefined>();
  private disposables: Disposable[] = [];

  get onDidChangeState(): Event<Uri | undefined> {
    return this._onDidChangeState.event;
  }

  constructor() {
    this.disposables.push(this._onDidChangeState);
  }

  /**
   * Check if blame is enabled for a specific file.
   * Files without an explicit state default to `sven.blame.autoBlame`:
   * with autoBlame off, blame stays hidden (and unfetched) until the user
   * enables it per file via the enable/toggle/show commands.
   */
  public isBlameEnabled(uri: Uri): boolean {
    const key = uri.toString();
    return this.fileStates.get(key) ?? blameConfiguration.isAutoBlameEnabled();
  }

  /**
   * Set blame state for a specific file
   */
  public setBlameEnabled(uri: Uri, enabled: boolean): void {
    const key = uri.toString();
    this.fileStates.set(key, enabled);
    this._onDidChangeState.fire(uri);
  }

  /**
   * Toggle blame state for a specific file
   */
  public toggleBlame(uri: Uri): boolean {
    const currentState = this.isBlameEnabled(uri);
    const newState = !currentState;
    this.setBlameEnabled(uri, newState);
    return newState;
  }

  /**
   * Clear blame state for a specific file
   */
  public clearBlame(uri: Uri): void {
    const key = uri.toString();
    this.fileStates.delete(key);
    this._onDidChangeState.fire(uri);
  }

  /**
   * Clear all blame states
   */
  public clearAll(): void {
    this.fileStates.clear();
    this._onDidChangeState.fire(undefined);
  }

  /**
   * Get all files with blame enabled
   */
  public getEnabledFiles(): Uri[] {
    const files: Uri[] = [];
    for (const [key, enabled] of this.fileStates.entries()) {
      if (enabled) {
        files.push(Uri.parse(key));
      }
    }
    return files;
  }

  /**
   * Check if global blame is enabled
   */
  public isGlobalEnabled(): boolean {
    return this.globalEnabled;
  }

  /**
   * Set global blame enabled state
   */
  public setGlobalEnabled(enabled: boolean): void {
    this.globalEnabled = enabled;
    this._onDidChangeState.fire(undefined);
  }

  /**
   * Toggle global blame state
   */
  public toggleGlobalEnabled(): boolean {
    this.globalEnabled = !this.globalEnabled;
    this._onDidChangeState.fire(undefined);
    return this.globalEnabled;
  }

  /**
   * Check if blame should be shown for a file (considers both global and per-file state)
   */
  public shouldShowBlame(uri: Uri): boolean {
    return this.globalEnabled && this.isBlameEnabled(uri);
  }

  dispose(): void {
    this.fileStates.clear();
    this.disposables.forEach(d => d.dispose());
  }
}

export const blameStateManager = new BlameStateManager();
