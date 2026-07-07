// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

"use strict";

import {
  ColorThemeKind,
  commands,
  ConfigurationChangeEvent,
  DecorationOptions,
  Disposable,
  Range,
  TextEditor,
  TextEditorDecorationType,
  ThemeColor,
  Uri,
  window,
  workspace
} from "vscode";
import { debounce, throttle } from "../decorators";
import { ISvnBlameLine } from "../common/types";
import { Repository } from "../repository";
import { blameConfiguration } from "./blameConfiguration";
import { blameStateManager } from "./blameStateManager";
import {
  compileTemplate,
  clearTemplateCache,
  CompiledTemplateFn
} from "./templateCompiler";
import { getErrorMessage, logError } from "../util/errorLogger";
import { Operation, Status } from "../common/types";
import { BLAME_INVALIDATING_OPERATIONS, isDescendant } from "../util";
import {
  computeLineMapping,
  LineMapping,
  mapBlameLineNumber
} from "../util/lineMapper";
import { formatBlameDate } from "../util/formatting";

/**
 * BlameProvider manages gutter decorations for SVN blame
 * Per-repository instance (like StatusService)
 */
export class BlameProvider implements Disposable {
  private decorationTypes: {
    gutter: TextEditorDecorationType;
    icon: TextEditorDecorationType;
    inline: TextEditorDecorationType;
  };
  private iconTypes = new Map<string, TextEditorDecorationType>(); // color → decoration type
  private blameCache = new Map<
    string,
    { data: ISvnBlameLine[]; version: number }
  >();
  private lineMappingCache = new Map<
    string,
    { mapping: LineMapping; version: number }
  >(); // uri → line mapping for modified files
  private revisionColors = new Map<string, string>(); // revision → gradient color
  private svgCache = new Map<string, Uri>(); // color → SVG data URI
  private messageCache = new Map<string, string>(); // revision → commit message
  private inFlightMessageFetches = new Map<string, Promise<void>>(); // uri → fetch promise
  private cacheAccessOrder = new Map<string, number>(); // uri → timestamp for LRU
  private currentLineNumber?: number; // Track cursor position for current-line-only mode
  private disposables: Disposable[] = [];
  private isActivated = false;

  // LRU cache limits
  private readonly MAX_CACHE_SIZE = 20; // Keep last 20 files (prevents unbounded growth)
  private readonly MAX_MESSAGE_CACHE_SIZE = 500; // Keep last 500 revision messages

  // Template compilation cache (performance optimization)
  private compiledGutterTemplate?: { template: string; fn: CompiledTemplateFn };
  private compiledInlineTemplate?: { template: string; fn: CompiledTemplateFn };

  constructor(private repository: Repository) {
    this.decorationTypes = this.createDecorationTypes();
  }

  /**
   * Create gutter and inline decoration types (icons use separate types per color)
   */
  private createDecorationTypes(): {
    gutter: TextEditorDecorationType;
    icon: TextEditorDecorationType;
    inline: TextEditorDecorationType;
  } {
    return {
      gutter: window.createTextEditorDecorationType({
        before: {
          color: new ThemeColor("editorCodeLens.foreground"),
          margin: "0 1.5em 0 0",
          fontStyle: "italic",
          fontWeight: "normal"
        },
        isWholeLine: false
      }),
      icon: window.createTextEditorDecorationType({}), // Placeholder, not used
      inline: window.createTextEditorDecorationType({
        after: {
          color: new ThemeColor("editorCodeLens.foreground"),
          margin: "0 0 0 3em",
          fontStyle: "normal",
          fontWeight: "normal"
        },
        isWholeLine: false,
        rangeBehavior: 1 // ClosedClosed
      })
    };
  }

  /**
   * Activate provider - register event handlers
   */
  public activate(): void {
    if (this.isActivated) {
      return;
    }

    this.disposables.push(
      // Editor changes
      window.onDidChangeActiveTextEditor(e => this.onActiveEditorChange(e)),

      // Document changes
      workspace.onDidChangeTextDocument(e => this.onDocumentChange(e)),
      workspace.onDidSaveTextDocument(d => this.onDocumentSave(d)),
      workspace.onDidCloseTextDocument(d => this.onDocumentClose(d)),

      // Cursor position changes (for current-line-only inline blame)
      window.onDidChangeTextEditorSelection(e =>
        this.onCursorPositionChange(e)
      ),

      // State changes
      blameStateManager.onDidChangeState(uri => this.onBlameStateChange(uri)),
      blameConfiguration.onDidChange(e => this.onConfigurationChange(e))
    );

    // Mutating repository operations change BASE content; the provider
    // cache is version-keyed and a commit doesn't bump document.version,
    // so it must be dropped explicitly. (Guarded: stubbed repositories in
    // unit tests may not carry the instance-field event.)
    if (typeof this.repository.onDidRunOperation === "function") {
      this.disposables.push(
        this.repository.onDidRunOperation(op => this.onRepositoryOperation(op))
      );
    }

    this.isActivated = true;

    // Apply to current active editor
    if (window.activeTextEditor) {
      void this.onActiveEditorChange(window.activeTextEditor);
    }
  }

  /**
   * Update decorations for editor (throttled to prevent spam)
   */
  @throttle
  public async updateDecorations(editor?: TextEditor): Promise<void> {
    const target = editor || window.activeTextEditor;

    if (!target) {
      return;
    }

    // CRITICAL: Skip files outside this repository to prevent disposing repo on external files
    // (SVN commands on external files return NotASvnRepository which incorrectly disposes repo)
    if (
      !isDescendant(this.repository.workspaceRoot, target.document.uri.fsPath)
    ) {
      this.clearDecorations(target);
      return;
    }

    // Check if should decorate
    const shouldDec = this.shouldDecorate(target);

    if (!shouldDec) {
      this.clearDecorations(target);
      return;
    }

    // Wait for initial status to load before checking file version
    await this.repository.statusReady;

    // Skip untracked files (prevents SVN errors for UNVERSIONED/IGNORED files)
    const resource = this.repository.getResourceFromFile(target.document.uri);

    // Only check status if resource exists (null means clean file, not untracked)
    if (resource) {
      // Skip files that can't be blamed:
      // - UNVERSIONED/IGNORED/NONE: not under version control
      // - ADDED: scheduled for addition but never committed (E195002)
      if (
        resource.type === Status.UNVERSIONED ||
        resource.type === Status.IGNORED ||
        resource.type === Status.NONE ||
        resource.type === Status.ADDED
      ) {
        this.clearDecorations(target);
        return;
      }
    } else {
      // Check if file is inside unversioned/ignored folder (not in resource index directly)
      const parentStatus = this.getParentFolderStatus(
        target.document.uri.fsPath
      );
      if (
        parentStatus === Status.UNVERSIONED ||
        parentStatus === Status.IGNORED
      ) {
        this.clearDecorations(target);
        return;
      }
    }

    // Shared size gate (CSV limit runs before generic largeFileLimit);
    // this is the only surface that warns - the others skip silently
    const sizeGate = blameConfiguration.getBlameSizeGate(
      target.document.uri,
      target.document.lineCount
    );
    if (sizeGate === "csv") {
      window.showWarningMessage(
        `Blame skipped for large CSV (${target.document.lineCount} lines > ` +
          `${blameConfiguration.getCsvLineLimit()} limit). ` +
          `Adjust 'sven.blame.csvLineLimit' or 'sven.blame.csvExtensions'.`
      );
      return;
    }
    if (sizeGate === "largeFile") {
      window.showWarningMessage(
        `File too large for blame (${target.document.lineCount} lines). Consider disabling blame.`
      );
      return;
    }

    try {
      // Fetch blame data (with cache)
      const blameData = await this.getBlameData(target.document.uri, target);

      if (!blameData) {
        this.clearDecorations(target);
        return;
      }

      // Compute line mapping for modified files (maps BASE line numbers to working copy)
      const lineMapping = await this.getLineMapping(
        target.document.uri,
        target
      );

      // PROGRESSIVE RENDERING: Create decorations without waiting for messages
      const decorations = await this.createAllDecorations(blameData, target, {
        skipMessagePrefetch: true, // Don't block on message fetching
        lineMapping
      });

      // Calculate revision range for icon colors
      const revisionRange = this.getRevisionRange(blameData);

      // PHASE 1: Apply decorations immediately (gutter + icons + inline without messages)
      target.setDecorations(
        this.decorationTypes.gutter,
        blameConfiguration.isGutterTextEnabled() ? decorations.gutter : []
      );

      // Apply icon decorations (separate method using multiple decoration types)
      this.applyIconDecorations(target, blameData, revisionRange, lineMapping);

      // OPTIMIZATION: Skip first inline render if progressive message fetch will happen
      // Prevents duplicate setDecorations() call (first without messages, second with messages)
      const willFetchMessages =
        blameConfiguration.isInlineEnabled() &&
        blameConfiguration.shouldShowInlineMessage();

      if (!willFetchMessages) {
        // Render inline immediately (no progressive update will happen)
        target.setDecorations(
          this.decorationTypes.inline,
          blameConfiguration.isInlineEnabled() ? decorations.inline : []
        );
      }

      // PHASE 2: Fetch messages asynchronously and update inline decorations
      // (Fire-and-forget - don't block UI)
      if (willFetchMessages) {
        this.prefetchMessagesProgressively(
          target.document.uri,
          blameData,
          target,
          undefined,
          lineMapping
        ).catch(err => {
          logError("BlameProvider: Progressive message fetch failed", err);
        });
      }
    } catch (err) {
      logError("BlameProvider: Failed to update decorations", err);
      this.clearDecorations(target);
    }
  }

  /**
   * Clear decorations for editor
   */
  public clearDecorations(editor?: TextEditor): void {
    const target = editor || window.activeTextEditor;
    if (target) {
      target.setDecorations(this.decorationTypes.gutter, []);
      target.setDecorations(this.decorationTypes.icon, []);
      target.setDecorations(this.decorationTypes.inline, []);
      this.clearIconDecorations(target);

      // Dispose and clear icon decoration types to prevent memory leak
      // (16 types per file × 100 files = 1600 uncleaned types)
      this.iconTypes.forEach(type => type.dispose());
      this.iconTypes.clear();
    }
  }

  /**
   * Clear cache for URI
   */
  public clearCache(uri: Uri): void {
    const key = uri.toString();
    this.blameCache.delete(key);
    this.lineMappingCache.delete(key); // Clear line mapping too
    this.cacheAccessOrder.delete(key); // Clean up access tracking
    // Cancel any in-flight message fetches for this URI
    this.inFlightMessageFetches.delete(key);
  }

  /**
   * Evict oldest blame cache entry (LRU policy)
   * Prevents unbounded memory growth during long editing sessions
   */
  private evictOldestCache(): void {
    if (this.blameCache.size <= this.MAX_CACHE_SIZE) {
      return; // Within limit, no eviction needed
    }

    // Find least recently used entry (oldest timestamp)
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [key, timestamp] of this.cacheAccessOrder) {
      if (timestamp < oldestTime) {
        oldestTime = timestamp;
        oldestKey = key;
      }
    }

    // Evict oldest entry
    if (oldestKey) {
      this.blameCache.delete(oldestKey);
      this.cacheAccessOrder.delete(oldestKey);
      this.inFlightMessageFetches.delete(oldestKey);
    }
  }

  /**
   * Evict message cache entries when exceeding limit
   * Uses simple eviction (remove first entries) since messages are immutable
   */
  private evictMessageCache(): void {
    if (this.messageCache.size <= this.MAX_MESSAGE_CACHE_SIZE) {
      return; // Within limit, no eviction needed
    }

    // Evict oldest 25% of entries (batch eviction for efficiency)
    const toRemove = Math.ceil(this.messageCache.size * 0.25);
    const keys = Array.from(this.messageCache.keys()).slice(0, toRemove);

    for (const key of keys) {
      this.messageCache.delete(key);
    }
  }

  /**
   * Prefetch commit messages progressively (non-blocking)
   * Fetches messages in background and updates inline decorations when done
   *
   * OPTIMIZED: Can accept pre-computed uniqueRevisions to avoid re-iteration
   */
  private async prefetchMessagesProgressively(
    uri: Uri,
    blameData: ISvnBlameLine[],
    editor: TextEditor,
    precomputedUniqueRevisions?: string[],
    lineMapping?: LineMapping
  ): Promise<void> {
    const uriKey = uri.toString();

    // Check if already fetching messages for this file
    const existingFetch = this.inFlightMessageFetches.get(uriKey);
    if (existingFetch) {
      return existingFetch; // Reuse existing fetch
    }

    // Use pre-computed unique revisions or extract them
    const uniqueRevisions =
      precomputedUniqueRevisions ||
      ([
        ...new Set(blameData.map(b => b.revision).filter(Boolean))
      ] as string[]);

    if (uniqueRevisions.length === 0 || uniqueRevisions.length > 100) {
      return; // Skip if no revisions or too many
    }

    // Create fetch promise
    const fetchPromise = (async () => {
      try {
        // Fetch all messages
        await this.prefetchMessages(uniqueRevisions, uri);

        // Check if blame still enabled and editor still active
        if (!blameStateManager.isBlameEnabled(uri)) {
          // Blame was disabled, clear decorations
          if (window.activeTextEditor?.document.uri.toString() === uriKey) {
            this.clearDecorations(editor);
          }
          return;
        }

        if (window.activeTextEditor?.document.uri.toString() !== uriKey) {
          return; // User navigated away, don't update
        }

        // Re-create inline decorations with messages
        await this.updateInlineDecorationsWithMessages(
          blameData,
          editor,
          lineMapping
        );
      } finally {
        // Remove from in-flight map when done
        this.inFlightMessageFetches.delete(uriKey);
      }
    })();

    // Track this fetch
    this.inFlightMessageFetches.set(uriKey, fetchPromise);

    return fetchPromise;
  }

  /**
   * Update inline decorations with commit messages
   * Called after messages are fetched asynchronously
   */
  private async updateInlineDecorationsWithMessages(
    blameData: ISvnBlameLine[],
    editor: TextEditor,
    lineMapping?: LineMapping
  ): Promise<void> {
    const inlineDecorations: DecorationOptions[] = [];
    const currentLineOnly = blameConfiguration.isInlineCurrentLineOnly();
    const inlineColor = `rgba(127, 127, 127, ${blameConfiguration.getInlineOpacity()})`;
    const activeLine = editor.selection.active.line;

    for (const blameLine of blameData) {
      // Apply line mapping (handles modified files)
      const lineIndex = mapBlameLineNumber(blameLine.lineNumber, lineMapping);
      if (lineIndex === undefined) continue; // Line was deleted

      // Skip invalid lines or uncommitted
      if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
        continue;
      }
      if (!blameLine.revision || !blameLine.author) {
        continue;
      }

      // Filter by current line if needed
      const isCurrentLine = lineIndex === activeLine;
      if (currentLineOnly && !isCurrentLine) {
        continue;
      }

      // Get message from cache (should be available now)
      const message = this.messageCache.get(blameLine.revision) || "";
      const inlineText = this.formatInlineText(blameLine, message);

      const line = editor.document.lineAt(lineIndex);
      inlineDecorations.push({
        range: new Range(
          lineIndex,
          line.range.end.character,
          lineIndex,
          line.range.end.character
        ),
        renderOptions: {
          after: {
            contentText: inlineText,
            color: inlineColor
          }
        },
        hoverMessage: `SVN: r${blameLine.revision} by ${blameLine.author}`
      });
    }

    // Apply updated inline decorations with messages
    editor.setDecorations(this.decorationTypes.inline, inlineDecorations);
  }

  /**
   * OPTIMIZED: Update inline decorations for cursor movement only
   * Lightweight update that:
   * - Reuses cached blame data (no re-fetch)
   * - Skips gutter and icon processing
   * - Only renders inline decoration for current line
   * - 60-80% faster than full updateDecorations()
   */
  private async updateInlineDecorationsForCursor(
    editor: TextEditor
  ): Promise<void> {
    // Early exit if inline not enabled or not in current-line-only mode
    if (
      !blameConfiguration.isInlineEnabled() ||
      !blameConfiguration.isInlineCurrentLineOnly()
    ) {
      return;
    }

    // CRITICAL: Skip files outside this repository to prevent disposing repo
    if (
      !isDescendant(this.repository.workspaceRoot, editor.document.uri.fsPath)
    ) {
      return;
    }

    // Check if decorations should be shown (respects per-file state)
    if (!this.shouldDecorate(editor)) {
      editor.setDecorations(this.decorationTypes.inline, []);
      return;
    }

    // Shared size gate, silent on the cursor path
    if (
      blameConfiguration.getBlameSizeGate(
        editor.document.uri,
        editor.document.lineCount
      )
    ) {
      return;
    }

    // Get cached blame data (don't re-fetch)
    const blameData = await this.getBlameData(editor.document.uri, editor);
    if (!blameData) {
      return;
    }

    // Get line mapping for modified files
    const lineMapping = await this.getLineMapping(editor.document.uri, editor);

    const currentLine = editor.selection.active.line;
    const inlineDecorations: DecorationOptions[] = [];
    const inlineColor = `rgba(127, 127, 127, ${blameConfiguration.getInlineOpacity()})`;

    // Find blame info for current line only
    for (const blameLine of blameData) {
      // Apply line mapping (handles modified files)
      const lineIndex = mapBlameLineNumber(blameLine.lineNumber, lineMapping);
      if (lineIndex === undefined) continue; // Line was deleted

      // Skip if not current line
      if (lineIndex !== currentLine) {
        continue;
      }

      // Skip invalid lines or uncommitted
      if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
        continue;
      }
      if (!blameLine.revision || !blameLine.author) {
        continue;
      }

      // Get message from cache (may not be loaded yet, that's okay)
      const message = this.messageCache.get(blameLine.revision) || "";
      const inlineText = this.formatInlineText(blameLine, message);

      const line = editor.document.lineAt(lineIndex);
      inlineDecorations.push({
        range: new Range(
          lineIndex,
          line.range.end.character,
          lineIndex,
          line.range.end.character
        ),
        renderOptions: {
          after: {
            contentText: inlineText,
            color: inlineColor
          }
        },
        hoverMessage: `SVN: r${blameLine.revision} by ${blameLine.author}`
      });

      break; // Found current line, done
    }

    // Apply only inline decorations (skip gutter and icons)
    editor.setDecorations(this.decorationTypes.inline, inlineDecorations);
  }

  /**
   * Dispose provider - cleanup resources
   */
  public dispose(): void {
    this.decorationTypes.gutter.dispose();
    this.decorationTypes.icon.dispose();
    this.decorationTypes.inline.dispose();
    this.iconTypes.forEach(type => type.dispose());
    this.iconTypes.clear();
    this.blameCache.clear();
    this.lineMappingCache.clear();
    this.revisionColors.clear();
    this.svgCache.clear();
    this.messageCache.clear();
    this.inFlightMessageFetches.clear(); // Cancel all in-flight fetches
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.isActivated = false;
  }

  // ===== Event Handlers =====

  private async onActiveEditorChange(
    editor: TextEditor | undefined
  ): Promise<void> {
    if (!editor) {
      return;
    }

    // Update current line number for new editor
    this.currentLineNumber = editor.selection.active.line;
    await this.updateDecorations(editor);
  }

  @debounce(500)
  private onDocumentChange(event: { document: { uri: Uri } }): void {
    // Clear decorations on text change (debounced to wait for typing to stop)
    const editor = window.activeTextEditor;
    if (
      editor &&
      editor.document.uri.toString() === event.document.uri.toString()
    ) {
      this.clearDecorations(editor);
    }
  }

  private async onDocumentSave(document: { uri: Uri }): Promise<void> {
    // Invalidate cache and refresh on save
    this.clearCache(document.uri);

    const editor = window.activeTextEditor;
    if (editor && editor.document.uri.toString() === document.uri.toString()) {
      await this.updateDecorations(editor);
    }
  }

  private onDocumentClose(document: { uri: Uri }): void {
    // Clear cache on close
    this.clearCache(document.uri);
  }

  @debounce(150)
  private async onCursorPositionChange(event: {
    textEditor: TextEditor;
  }): Promise<void> {
    // Update current line number and refresh inline decorations (debounced 150ms)
    if (!blameConfiguration.isInlineCurrentLineOnly()) {
      return; // Skip if not in current-line-only mode
    }

    const newLine = event.textEditor.selection.active.line;
    if (this.currentLineNumber === newLine) {
      return; // Skip if cursor still on same line
    }

    this.currentLineNumber = newLine;
    await this.updateInlineDecorationsForCursor(event.textEditor);
  }

  /**
   * Drop the version-keyed provider cache after operations that change
   * BASE content (commit/update/revert/... plus switch/merge), then
   * refresh the active editor so decorations reflect the new BASE.
   */
  private onRepositoryOperation(operation: Operation): void {
    if (!BLAME_INVALIDATING_OPERATIONS.has(operation)) {
      return;
    }

    this.blameCache.clear();
    this.lineMappingCache.clear();
    this.cacheAccessOrder.clear();
    this.inFlightMessageFetches.clear();

    const editor = window.activeTextEditor;
    if (editor) {
      void this.updateDecorations(editor);
    }
  }

  private async onBlameStateChange(uri: Uri | undefined): Promise<void> {
    // State toggled - update decorations
    const editor = window.activeTextEditor;
    if (!uri || (editor && editor.document.uri.toString() === uri.toString())) {
      await this.updateDecorations(editor);
    }
  }

  private async onConfigurationChange(
    _event: ConfigurationChangeEvent
  ): Promise<void> {
    // Save old decoration types
    const oldTypes = this.decorationTypes;
    const oldIconTypes = this.iconTypes;

    // Create new decoration types first
    this.decorationTypes = this.createDecorationTypes();
    this.iconTypes = new Map<string, TextEditorDecorationType>();

    // Clear decorations using old types before disposing
    if (window.activeTextEditor) {
      window.activeTextEditor.setDecorations(oldTypes.gutter, []);
      window.activeTextEditor.setDecorations(oldTypes.icon, []);
      window.activeTextEditor.setDecorations(oldTypes.inline, []);
      oldIconTypes.forEach(type => {
        window.activeTextEditor!.setDecorations(type, []);
      });
    }

    // Now safe to dispose old types
    oldTypes.gutter.dispose();
    oldTypes.icon.dispose();
    oldTypes.inline.dispose();
    oldIconTypes.forEach(type => type.dispose());

    // Clear caches (colors/templates may have changed)
    this.revisionColors.clear();
    this.svgCache.clear();
    // Keep messageCache (revision messages don't change)

    // Clear compiled template cache (templates may have changed)
    this.compiledGutterTemplate = undefined;
    this.compiledInlineTemplate = undefined;
    clearTemplateCache();

    // Refresh all editors with new decoration types
    if (window.activeTextEditor) {
      await this.updateDecorations(window.activeTextEditor);
    }
  }

  // ===== Helper Methods =====

  /**
   * Check if editor should show blame decorations
   */
  private shouldDecorate(editor: TextEditor): boolean {
    const uri = editor.document.uri;

    // Must be file scheme
    if (uri.scheme !== "file") {
      return false;
    }

    // Check configuration - at least one decoration type must be enabled
    const anyDecorationEnabled =
      (blameConfiguration.isGutterEnabled() &&
        (blameConfiguration.isGutterTextEnabled() ||
          blameConfiguration.isGutterIconEnabled())) ||
      blameConfiguration.isInlineEnabled();

    if (!blameConfiguration.isEnabled() || !anyDecorationEnabled) {
      return false;
    }

    // Check state manager
    if (!blameStateManager.shouldShowBlame(uri)) {
      return false;
    }

    return true;
  }

  /**
   * Check if file is inside an unversioned or ignored folder.
   * Delegates to Repository.isInsideUnversionedOrIgnored which uses _allUnversioned
   * (not UI-filtered) to correctly detect hidden folders.
   */
  private getParentFolderStatus(filePath: string): Status | undefined {
    return this.repository.isInsideUnversionedOrIgnored(filePath);
  }

  /**
   * Get blame data for URI (with caching)
   */
  private async getBlameData(
    uri: Uri,
    editor: TextEditor
  ): Promise<ISvnBlameLine[] | undefined> {
    const key = uri.toString();

    // Document version (changes on every edit/reload) from the editor that
    // triggered the lookup - NOT window.activeTextEditor, which pinned
    // non-active visible editors to version -1 (a permanent cache miss).
    const currentVersion =
      editor.document.uri.toString() === key ? editor.document.version : -1;

    // Check cache - validate version to detect external changes (svn update, etc.)
    const cached = this.blameCache.get(key);
    if (cached && cached.version === currentVersion && currentVersion !== -1) {
      // Update access time for LRU
      this.cacheAccessOrder.set(key, Date.now());
      return cached.data;
    }

    // Pre-check: verify file is under version control before attempting blame
    // First check resource index (avoids SVN call for known unversioned files)
    const resource = this.repository.getResourceFromFile(uri);
    if (resource) {
      if (
        resource.type === Status.UNVERSIONED ||
        resource.type === Status.IGNORED ||
        resource.type === Status.ADDED
      ) {
        return undefined;
      }
    }

    // No svn info pre-check: blame's own error handling already skips
    // unversioned files silently (W155010/E200009 below), so the extra
    // subprocess per clean file bought nothing.

    // Fetch from repository
    try {
      const data = await this.repository.blame(uri.fsPath);

      // Cache with document version (for staleness detection on external changes)
      this.blameCache.set(key, { data, version: currentVersion });

      // Track access time for LRU
      this.cacheAccessOrder.set(key, Date.now());

      // Evict oldest entry if cache exceeds limit
      this.evictOldestCache();

      return data;
    } catch (err) {
      // Extract error details
      const errorMsg = getErrorMessage(err) || "Unknown error";
      const stderrStr =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr?: unknown }).stderr)
          : "";

      // Suppress expected errors for unversioned/untracked files (not actual errors)
      // W155010: node not found in working copy
      // E200009: could not perform operation on some targets
      // E155007: not a working copy (file outside/detached from the WC -
      //          the shallow-checkout edge the old svn-info pre-check hid)
      const isUntrackedFile =
        stderrStr.includes("W155010") ||
        stderrStr.includes("E200009") ||
        stderrStr.includes("E155007") ||
        errorMsg.includes("W155010") ||
        errorMsg.includes("E200009") ||
        errorMsg.includes("E155007");

      if (isUntrackedFile) {
        return undefined; // Silently skip unversioned files
      }

      logError("BlameProvider: Failed to fetch blame data", err);
      if (
        errorMsg.includes("Authentication failed") ||
        errorMsg.includes("No more credentials") ||
        errorMsg.includes("E170001") ||
        errorMsg.includes("E215004")
      ) {
        window
          .showWarningMessage(
            "SVN authentication required. Use 'SVN: Authenticate' command or check credentials.",
            "Authenticate"
          )
          .then(choice => {
            if (choice === "Authenticate") {
              const repoUrl = this.repository.repository.info?.url;
              commands.executeCommand(
                "sven.promptAuth",
                undefined,
                undefined,
                repoUrl
              );
            }
          });
      } else if (
        errorMsg.includes("E170013") ||
        errorMsg.includes("No such host") ||
        errorMsg.includes("Unable to connect")
      ) {
        window.showErrorMessage(
          "Unable to connect to SVN server. Check VPN/network."
        );
      }

      return undefined;
    }
  }

  /**
   * Get line mapping for modified files.
   * Maps BASE revision line numbers to working copy line numbers.
   * Returns undefined if file is not modified or mapping cannot be computed.
   */
  private async getLineMapping(
    uri: Uri,
    editor: TextEditor
  ): Promise<LineMapping | undefined> {
    const key = uri.toString();
    const currentVersion = editor.document.version;

    // Check cache
    const cached = this.lineMappingCache.get(key);
    if (cached && cached.version === currentVersion) {
      return cached.mapping;
    }

    // Check if file is modified
    const resource = this.repository.getResourceFromFile(uri);
    if (!resource || resource.type !== Status.MODIFIED) {
      // File not modified - no mapping needed (identity mapping)
      return undefined;
    }

    try {
      // Get BASE content (committed version)
      const baseContent = await this.repository.repository.show(
        uri.fsPath,
        "BASE"
      );
      const baseLines = baseContent.split(/\r?\n/);

      // Get working copy content (current editor)
      const workingContent = editor.document.getText();
      const workingLines = workingContent.split(/\r?\n/);

      // Compute mapping
      const mapping = computeLineMapping(baseLines, workingLines);

      // Cache the mapping
      this.lineMappingCache.set(key, { mapping, version: currentVersion });

      return mapping;
    } catch (err) {
      logError("BlameProvider: Failed to compute line mapping", err);
      return undefined;
    }
  }

  /**
   * Create gutter and inline decoration arrays from blame data
   * (icons handled separately via applyIconDecorations)
   */
  private async createAllDecorations(
    blameData: ISvnBlameLine[],
    editor: TextEditor,
    options: { skipMessagePrefetch?: boolean; lineMapping?: LineMapping } = {}
  ): Promise<{
    gutter: DecorationOptions[];
    icon: DecorationOptions[];
    inline: DecorationOptions[];
  }> {
    const gutterDecorations: DecorationOptions[] = [];
    const inlineDecorations: DecorationOptions[] = [];

    const template = blameConfiguration.getGutterTemplate();
    const dateFormat = blameConfiguration.getDateFormat();
    const { lineMapping } = options;

    // Hoist config reads + color-string allocation out of the per-line loop.
    // For a 1000-line file these were ~6000 redundant config reads and
    // 1000 redundant rgba(...) string allocations per blame render.
    const gutterEnabled = blameConfiguration.isGutterEnabled();
    const gutterTextEnabled = blameConfiguration.isGutterTextEnabled();
    const showGutterText = gutterEnabled && gutterTextEnabled;
    const inlineEnabled = blameConfiguration.isInlineEnabled();
    const inlineCurrentLineOnly = blameConfiguration.isInlineCurrentLineOnly();
    const showInlineMessage = blameConfiguration.shouldShowInlineMessage();
    const inlineColor = `rgba(127, 127, 127, ${blameConfiguration.getInlineOpacity()})`;
    const activeLine = editor.selection.active.line;

    // Prefetch messages if inline enabled (unless skipped for progressive rendering)
    if (!options.skipMessagePrefetch && inlineEnabled && showInlineMessage) {
      const uniqueRevisions = [
        ...new Set(blameData.map(b => b.revision).filter(Boolean))
      ] as string[];

      if (uniqueRevisions.length > 0 && uniqueRevisions.length <= 100) {
        await this.prefetchMessages(uniqueRevisions, editor.document.uri);
      }
    }

    for (const blameLine of blameData) {
      // Apply line mapping (handles modified files)
      const lineIndex = mapBlameLineNumber(blameLine.lineNumber, lineMapping);
      if (lineIndex === undefined) continue; // Line was deleted

      // Skip if line doesn't exist in document
      if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
        continue;
      }

      const range = new Range(lineIndex, 0, lineIndex, 0);

      // 1. Gutter text decoration
      if (showGutterText) {
        const text = this.formatBlameText(blameLine, template, dateFormat);
        gutterDecorations.push({
          range,
          renderOptions: {
            before: {
              contentText: text
            }
          }
        });
      }

      // Skip uncommitted lines for inline
      if (!blameLine.revision || !blameLine.author) {
        continue;
      }

      // 2. Inline annotation
      if (inlineEnabled) {
        const isCurrentLine = lineIndex === activeLine;

        if (!inlineCurrentLineOnly || isCurrentLine) {
          const message = showInlineMessage
            ? await this.getCommitMessage(blameLine.revision)
            : "";

          const inlineText = this.formatInlineText(blameLine, message);

          const line = editor.document.lineAt(lineIndex);
          inlineDecorations.push({
            range: new Range(
              lineIndex,
              line.range.end.character,
              lineIndex,
              line.range.end.character
            ),
            renderOptions: {
              after: {
                contentText: inlineText,
                color: inlineColor
              }
            },
            hoverMessage: `SVN: r${blameLine.revision} by ${blameLine.author}`
          });
        }
      }
    }

    return {
      gutter: gutterDecorations,
      icon: [], // Not used, handled by applyIconDecorations
      inline: inlineDecorations
    };
  }

  /**
   * Format blame line using template (optimized with compiled template)
   */
  private formatBlameText(
    line: ISvnBlameLine,
    template: string,
    dateFormat: "relative" | "absolute"
  ): string {
    const revision = line.revision || "???";
    const author = line.author || "unknown";
    const date = formatBlameDate(line.date, dateFormat);

    // Compile template once, cache and reuse (eliminates 3 regex ops per line)
    if (
      !this.compiledGutterTemplate ||
      this.compiledGutterTemplate.template !== template
    ) {
      this.compiledGutterTemplate = {
        template,
        fn: compileTemplate(template)
      };
    }

    const result = this.compiledGutterTemplate.fn({ revision, author, date });
    return result.padEnd(30); // Ensure consistent spacing
  }

  // ===== Phase 2.5: Revision Gradient Coloring =====

  /**
   * Calculate min/max revision range and unique revisions from blame data
   */
  private getRevisionRange(blameData: ISvnBlameLine[]): {
    min: number;
    max: number;
    uniqueRevisions: number[];
  } {
    const revisions = blameData
      .map(b => b.revision)
      .filter(Boolean)
      .map(r => parseInt(r as string, 10))
      .filter(r => !isNaN(r));

    if (revisions.length === 0) {
      return { min: 0, max: 0, uniqueRevisions: [] };
    }

    // Get unique revisions sorted descending (newest first)
    const uniqueRevisions = [...new Set(revisions)].sort((a, b) => b - a);

    return {
      min: Math.min(...revisions),
      max: Math.max(...revisions),
      uniqueRevisions
    };
  }

  /**
   * Get color for revision (hybrid: categorical for recent, gradient for older)
   * Recent 5 unique revisions in file: Distinct categorical colors (red→orange→yellow→green→blue)
   * Older revisions: Blue→purple gradient heatmap
   * Formula: Categorical hues [0,30,60,120,200], gradient 200→280, saturation 45%, lightness theme-aware
   */
  private getRevisionColor(
    revision: string,
    range: { min: number; max: number; uniqueRevisions: number[] }
  ): string {
    if (this.revisionColors.has(revision)) {
      return this.revisionColors.get(revision)!;
    }

    const revNum = parseInt(revision, 10);
    if (isNaN(revNum) || range.uniqueRevisions.length === 0) {
      // Fallback for invalid or empty: mid-point blue-purple
      const color = this.hslToHex(240, 45, this.getThemeAwareLightness());
      this.revisionColors.set(revision, color);
      return color;
    }

    const saturation = 45; // Increased for better distinction
    const lightness = this.getThemeAwareLightness();

    // Find index of this revision in the file's unique revisions (sorted newest first)
    const revisionIndex = range.uniqueRevisions.indexOf(revNum);

    if (revisionIndex === -1) {
      // Not found (shouldn't happen), fallback
      const color = this.hslToHex(240, saturation, lightness);
      this.revisionColors.set(revision, color);
      return color;
    }

    // Hybrid approach: categorical for top 5 unique revisions, gradient for rest
    if (revisionIndex < 5) {
      // Recent revisions: categorical colors (index 0=newest=red, 4=5th newest=blue)
      const categoricalHues = [0, 30, 60, 120, 200]; // Red→orange→yellow→green→blue
      const hue = categoricalHues[revisionIndex]!;
      const color = this.hslToHex(hue, saturation, lightness);
      this.revisionColors.set(revision, color);
      return color;
    } else {
      // Older revisions: gradient heatmap (blue → purple)
      const olderRevisions = range.uniqueRevisions.slice(5); // Skip first 5
      const olderIndex = revisionIndex - 5; // Position within older revisions

      if (olderRevisions.length === 1) {
        // Only one older revision, use blue
        const color = this.hslToHex(200, saturation, lightness);
        this.revisionColors.set(revision, color);
        return color;
      }

      // Normalize position within older revisions (0=newest of older, 1=oldest)
      const normalized = olderIndex / (olderRevisions.length - 1);

      // Quantize to 8 discrete buckets for gradient
      const bucket = Math.floor(normalized * 7.99); // 0-7 inclusive
      const quantizedNormalized = bucket / 7;

      // Interpolate hue: 200 (blue) → 280 (purple)
      const hue = Math.round(200 + quantizedNormalized * 80);
      const color = this.hslToHex(hue, saturation, lightness);
      this.revisionColors.set(revision, color);
      return color;
    }
  }

  /**
   * Get theme-aware lightness (darker for light themes, lighter for dark themes)
   */
  private getThemeAwareLightness(): number {
    const theme = window.activeColorTheme.kind;
    return theme === ColorThemeKind.Light ? 40 : 60;
  }

  /**
   * Convert HSL to hex color for better SVG compatibility in data URIs
   */
  private hslToHex(h: number, s: number, l: number): string {
    s /= 100;
    l /= 100;

    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;

    let r = 0,
      g = 0,
      b = 0;

    if (h >= 0 && h < 60) {
      r = c;
      g = x;
      b = 0;
    } else if (h >= 60 && h < 120) {
      r = x;
      g = c;
      b = 0;
    } else if (h >= 120 && h < 180) {
      r = 0;
      g = c;
      b = x;
    } else if (h >= 180 && h < 240) {
      r = 0;
      g = x;
      b = c;
    } else if (h >= 240 && h < 300) {
      r = x;
      g = 0;
      b = c;
    } else if (h >= 300 && h < 360) {
      r = c;
      g = 0;
      b = x;
    }

    const toHex = (val: number) =>
      Math.round((val + m) * 255)
        .toString(16)
        .padStart(2, "0");

    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  /**
   * Get or create decoration type for specific color
   * Uses multiple decoration types (one per color) for correct VS Code API usage
   */
  private getIconDecorationType(color: string): TextEditorDecorationType {
    if (this.iconTypes.has(color)) {
      return this.iconTypes.get(color)!;
    }

    const svgUri = this.generateColorBarSvg(color);
    const type = window.createTextEditorDecorationType({
      gutterIconPath: svgUri, // Set at TYPE level (correct API usage)
      gutterIconSize: "auto",
      isWholeLine: false
    });

    this.iconTypes.set(color, type);
    return type;
  }

  /**
   * Apply icon decorations using multiple decoration types (one per color)
   * This is the correct VS Code API pattern for gutter icons
   */
  private applyIconDecorations(
    editor: TextEditor,
    blameData: ISvnBlameLine[],
    revisionRange: { min: number; max: number; uniqueRevisions: number[] },
    lineMapping?: LineMapping
  ): void {
    // Dispose previous file's icon types to prevent memory leak
    // Each file creates ~16 color-based types; without this, types accumulate unbounded
    this.iconTypes.forEach(type => type.dispose());
    this.iconTypes.clear();

    const gutterEnabled = blameConfiguration.isGutterEnabled();
    const iconsEnabled = blameConfiguration.isGutterIconEnabled();

    if (!gutterEnabled || !iconsEnabled) {
      this.clearIconDecorations(editor);
      return;
    }

    // Group lines by color
    const decorationsByColor = new Map<string, Range[]>();

    for (const blameLine of blameData) {
      if (!blameLine.revision) continue;

      // Apply line mapping (handles modified files)
      const lineIndex = mapBlameLineNumber(blameLine.lineNumber, lineMapping);
      if (lineIndex === undefined) continue; // Line was deleted
      if (lineIndex < 0 || lineIndex >= editor.document.lineCount) continue;

      const color = this.getRevisionColor(blameLine.revision, revisionRange);
      if (!decorationsByColor.has(color)) {
        decorationsByColor.set(color, []);
      }
      decorationsByColor
        .get(color)!
        .push(new Range(lineIndex, 0, lineIndex, 0));
    }

    // Apply each color's decoration type
    for (const [color, ranges] of decorationsByColor) {
      const type = this.getIconDecorationType(color);
      editor.setDecorations(
        type,
        ranges.map(r => ({ range: r }))
      );
    }
  }

  /**
   * Clear all icon decorations
   */
  private clearIconDecorations(editor: TextEditor): void {
    this.iconTypes.forEach(type => {
      editor.setDecorations(type, []);
    });
  }

  // ===== Phase 2.5: SVG Generation =====

  /**
   * Generate colored vertical bar SVG (cached by color)
   */
  private generateColorBarSvg(color: string): Uri {
    if (this.svgCache.has(color)) {
      return this.svgCache.get(color)!;
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="3" height="16" viewBox="0 0 3 16"><rect width="3" height="16" fill="${color}"/></svg>`;
    const base64 = Buffer.from(svg, "utf-8").toString("base64");
    const uri = Uri.parse(`data:image/svg+xml;base64,${base64}`);

    this.svgCache.set(color, uri);
    return uri;
  }

  // ===== Phase 2.5: Message Fetching =====

  /**
   * Get commit message for revision (cached)
   */
  private async getCommitMessage(
    revision: string,
    target?: Uri
  ): Promise<string> {
    if (this.messageCache.has(revision)) {
      return this.messageCache.get(revision)!;
    }

    if (!blameConfiguration.isLogsEnabled()) {
      return "";
    }

    try {
      const log = await this.repository.log(
        revision,
        revision,
        1,
        target?.fsPath
      );
      const message = log[0]?.msg || "";
      this.messageCache.set(revision, message);

      // Evict message cache if exceeding limit
      this.evictMessageCache();

      return message;
    } catch (err) {
      logError(`BlameProvider: Failed to fetch message for r${revision}`, err);
      return "";
    }
  }

  /**
   * Prefetch messages for multiple revisions (batch)
   * Uses single SVN log command for all revisions instead of N sequential calls
   */
  private async prefetchMessages(
    revisions: string[],
    target?: Uri
  ): Promise<void> {
    if (!blameConfiguration.isLogsEnabled()) {
      return;
    }

    const uncached = revisions.filter(r => !this.messageCache.has(r));

    if (uncached.length === 0) {
      return;
    }

    try {
      // Batch fetch: single SVN command for all revisions, targeted at the
      // blamed file so the server filters to its history. Without a target
      // this spanned every revision in the checkout between min and max.
      const logEntries = await this.repository.logBatch(
        uncached,
        target?.fsPath
      );

      // Cache all fetched messages
      for (const entry of logEntries) {
        if (entry.revision && entry.msg !== undefined) {
          this.messageCache.set(entry.revision, entry.msg);
        }
      }

      // Evict message cache if exceeding limit
      this.evictMessageCache();
    } catch (err) {
      logError(
        "BlameProvider: Batch message fetch failed, falling back to sequential",
        err
      );

      // Fallback to sequential fetching on error
      for (const revision of uncached) {
        await this.getCommitMessage(revision, target);
      }
    }
  }

  // ===== Phase 2.5: Text Formatting =====

  /**
   * Truncate commit message intelligently
   */
  private truncateMessage(message: string): string {
    if (!message) {
      return "";
    }

    const maxLength = blameConfiguration.getInlineMaxLength();

    // Extract first line only
    const firstLine = message.split("\n")[0]!.trim();

    if (firstLine.length <= maxLength) {
      return firstLine;
    }

    // Truncate at word boundary
    const ellipsis = "...";
    const targetLength = maxLength - ellipsis.length;

    const truncated = firstLine.substring(0, targetLength);
    const lastSpace = truncated.lastIndexOf(" ");

    if (lastSpace > targetLength * 0.75) {
      // Good word boundary found
      return truncated.substring(0, lastSpace) + ellipsis;
    } else {
      // No good boundary, hard truncate
      return truncated + ellipsis;
    }
  }

  /**
   * Format inline text with message and template (optimized with compiled template)
   */
  private formatInlineText(line: ISvnBlameLine, message: string): string {
    const template = blameConfiguration.getInlineTemplate();
    const revision = line.revision || "???";
    const author = line.author || "unknown";
    const dateFormat = blameConfiguration.getDateFormat();
    const date = formatBlameDate(line.date, dateFormat);

    const truncatedMessage = this.truncateMessage(message);

    // Compile template once, cache and reuse (eliminates 4 regex ops per line)
    if (
      !this.compiledInlineTemplate ||
      this.compiledInlineTemplate.template !== template
    ) {
      this.compiledInlineTemplate = {
        template,
        fn: compileTemplate(template)
      };
    }

    let result = this.compiledInlineTemplate.fn({
      revision,
      author,
      date,
      message: truncatedMessage
    });

    // Remove bullet and trailing whitespace if message is empty
    if (!truncatedMessage) {
      result = result.replace(/\s*[•·]\s*$/, "");
    }

    return result;
  }
}
