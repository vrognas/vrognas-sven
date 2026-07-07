// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

"use strict";

import {
  ConfigurationChangeEvent,
  ConfigurationTarget,
  Event,
  EventEmitter,
  Uri,
  workspace,
  WorkspaceConfiguration
} from "vscode";
import { matchesExtensionList } from "../util/extensionMatch";

const SVN_BLAME = "sven.blame";
const DEFAULT_CSV_EXTENSIONS = [".csv", ".tsv"];
const DEFAULT_CSV_LINE_LIMIT = 500;

export interface BlameConfig {
  enabled: boolean;
  autoBlame: boolean;
  dateFormat: "relative" | "absolute";
  enableLogs: boolean;
  largeFileLimit: number;
  largeFileWarning: boolean;
  showWorkingCopyChanges: boolean;
  statusBar: {
    enabled: boolean;
    template: string;
  };
  gutter: {
    enabled: boolean;
    dateFormat: "relative" | "absolute";
    template: string;
  };
}

class BlameConfiguration {
  private configuration: WorkspaceConfiguration;
  private _onDidChange = new EventEmitter<ConfigurationChangeEvent>();

  get onDidChange(): Event<ConfigurationChangeEvent> {
    return this._onDidChange.event;
  }

  constructor() {
    this.configuration = workspace.getConfiguration(SVN_BLAME);
    workspace.onDidChangeConfiguration(this.onConfigurationChanged, this);
  }

  private onConfigurationChanged(event: ConfigurationChangeEvent) {
    if (!event.affectsConfiguration(SVN_BLAME)) {
      return;
    }

    this.configuration = workspace.getConfiguration(SVN_BLAME);
    this._onDidChange.fire(event);
  }

  public get<T>(section: string, defaultValue?: T): T {
    return this.configuration.get<T>(section, defaultValue!);
  }

  public update(
    section: string,
    value: unknown,
    configurationTarget?: ConfigurationTarget | boolean
  ): Thenable<void> {
    return this.configuration.update(section, value, configurationTarget);
  }

  public inspect(section: string) {
    return this.configuration.inspect(section);
  }

  /**
   * Check if blame is globally enabled
   */
  public isEnabled(): boolean {
    return this.get<boolean>("enabled", true);
  }

  /**
   * Check if auto-blame on file open is enabled.
   * Fallback must match the package.json default (true).
   */
  public isAutoBlameEnabled(): boolean {
    return this.get<boolean>("autoBlame", true);
  }

  /**
   * Check if file exceeds large file limit
   */
  public isFileTooLarge(lines: number): boolean {
    const limit = this.get<number>("largeFileLimit", 3000);
    return lines > limit;
  }

  /**
   * Check if large file warnings are enabled
   */
  public shouldWarnLargeFile(): boolean {
    return this.get<boolean>("largeFileWarning", true);
  }

  /**
   * Check if commit message fetching is enabled
   */
  public isLogsEnabled(): boolean {
    return this.get<boolean>("enableLogs", true);
  }

  /**
   * Get date format preference
   */
  public getDateFormat(): "relative" | "absolute" {
    return this.get<"relative" | "absolute">("dateFormat", "relative");
  }

  /**
   * Get status bar template
   */
  public getStatusBarTemplate(): string {
    return this.get<string>(
      "statusBar.template",
      "$(person) ${author}, $(clock) ${date} - ${message}"
    );
  }

  /**
   * Get gutter template
   */
  public getGutterTemplate(): string {
    return this.get<string>(
      "gutter.template",
      "${author} (${revision}) ${date}"
    );
  }

  /**
   * Check if status bar is enabled
   */
  public isStatusBarEnabled(): boolean {
    return this.get<boolean>("statusBar.enabled", true);
  }

  /**
   * Check if gutter decorations are enabled
   */
  public isGutterEnabled(): boolean {
    return this.get<boolean>("gutter.enabled", true);
  }

  /**
   * Check if working copy changes should be shown
   */
  public shouldShowWorkingCopyChanges(): boolean {
    return this.get<boolean>("showWorkingCopyChanges", true);
  }

  /**
   * Check if gutter text annotations are enabled
   */
  public isGutterTextEnabled(): boolean {
    return this.get<boolean>("gutter.showText", false);
  }

  /**
   * Check if gutter icons (colored bars) are enabled
   */
  public isGutterIconEnabled(): boolean {
    return this.get<boolean>("gutter.showIcons", true);
  }

  /**
   * Check if inline annotations are enabled
   */
  public isInlineEnabled(): boolean {
    return this.get<boolean>("inline.enabled", true);
  }

  /**
   * Get inline annotation template
   */
  public getInlineTemplate(): string {
    return this.get<string>(
      "inline.template",
      " ${author}, ${date} (r${revision}) • ${message}"
    );
  }

  /**
   * Get inline annotation opacity
   */
  public getInlineOpacity(): number {
    return this.get<number>("inline.opacity", 0.5);
  }

  /**
   * Check if inline should only show on current line
   */
  public isInlineCurrentLineOnly(): boolean {
    return this.get<boolean>("inline.currentLineOnly", true);
  }

  /**
   * Check if inline should show commit messages
   */
  public shouldShowInlineMessage(): boolean {
    return this.get<boolean>("inline.showMessage", false);
  }

  /**
   * Get maximum length for inline messages
   */
  public getInlineMaxLength(): number {
    return this.get<number>("inline.maxLength", 50);
  }

  /**
   * Aggressive line-count limit for csv-like files (kicks in before largeFileLimit)
   */
  public getCsvLineLimit(): number {
    return this.get<number>("csvLineLimit", DEFAULT_CSV_LINE_LIMIT);
  }

  /**
   * Match uri against configured csv-like extension list (case-insensitive)
   */
  public isCsvLike(uri: Uri): boolean {
    return matchesExtensionList(
      uri,
      this.get<string[]>("csvExtensions", DEFAULT_CSV_EXTENSIONS)
    );
  }
}

export const blameConfiguration = new BlameConfiguration();
