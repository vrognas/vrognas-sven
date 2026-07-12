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
import { configuration } from "../helpers/configuration";
import { Repository } from "../repository";
import { SourceControlManager } from "../source_control_manager";
import { blameConfiguration } from "./blameConfiguration";
import { blameStateManager } from "./blameStateManager";
import {
  compileTemplate,
  clearTemplateCache,
  CompiledTemplateFn
} from "./templateCompiler";
import { logError } from "../util/errorLogger";
import { classifyBlameError, BlameErrorKind } from "./classifyBlameError";
import { buildBlameHover } from "./blameHover";
import { Operation, Status } from "../common/types";
import { BLAME_INVALIDATING_OPERATIONS, isDescendant } from "../util";
import {
  computeLineMapping,
  LineMapping,
  mapBlameLineNumber
} from "../util/lineMapper";
import { formatBlameDate } from "../util/formatting";

/**
 * BlameProvider manages blame decorations for SVN.
 * Single shared instance across all repositories (like BlameStatusBar):
 * resolves the owning repo per file via SourceControlManager.getRepository.
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
  // uri → monotonic access sequence for LRU eviction. A counter, not
  // Date.now(): same-millisecond accesses tie on wall-clock time, making
  // eviction order arbitrary (and the LRU test flaky on fast runners)
  private cacheAccessOrder = new Map<string, number>();
  private cacheAccessCounter = 0;
  /** Built decoration arrays per uri: revisiting a file at the same
   *  document version reuses them instead of rebuilding N hover/
   *  decoration objects per editor switch (measurable latency). */
  private renderCache = new Map<
    string,
    {
      version: number;
      addRevision: string | undefined;
      cursorLine: number | undefined;
      decorations: {
        gutter: DecorationOptions[];
        icon: DecorationOptions[];
        inline: DecorationOptions[];
      };
      revisionRange: { min: number; max: number; uniqueRevisions: number[] };
    }
  >();
  /** Files whose peek data was already swept (cleared with the caches). */
  private peekPrefetchDone = new Set<string>();
  // Warm only the few newest revisions' peek data on file open. These are
  // the categorically-colored, visually-emphasized lines users are likeliest
  // to peek; any colder line's default peek fetches on demand. A wider sweep
  // fired ~2 speculative svn subprocesses per revision - a server storm most
  // files never cashed in.
  private static readonly MAX_PEEK_PREFETCH = 5;
  private currentLineNumber?: number; // Track cursor position for current-line-only mode
  private disposables: Disposable[] = [];
  private isActivated = false;

  // LRU cache limits
  private readonly MAX_CACHE_SIZE = 20; // Keep last 20 files (prevents unbounded growth)
  private readonly MAX_MESSAGE_CACHE_SIZE = 500; // Keep last 500 revision messages

  // Template compilation cache (performance optimization)
  private compiledGutterTemplate?: { template: string; fn: CompiledTemplateFn };
  private compiledInlineTemplate?: { template: string; fn: CompiledTemplateFn };

  constructor(private sourceControlManager: SourceControlManager) {
    this.decorationTypes = this.createDecorationTypes();
  }

  /**
   * Resolve the repository that owns a file (single shared provider across
   * all repos, like BlameStatusBar). Uses getRepositoryFromUri (a pure
   * workspaceRoot descendant match), NOT getRepository, so files inside an
   * svn:external - which getRepository rejects via the repo's excluded set -
   * still resolve to the owning repo and get blamed, matching the old
   * per-repo isDescendant gate. Returns undefined for files outside any open
   * working copy.
   */
  private repoFor(hint: Uri | string): Repository | undefined {
    const uri = typeof hint === "string" ? Uri.file(hint) : hint;
    return this.sourceControlManager.getRepositoryFromUri(uri) ?? undefined;
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

    // Per-repo hooks (mirrors BlameStatusBar): every open repo plus any that
    // open later. Mutating operations change BASE content; the provider cache
    // is version-keyed and a commit doesn't bump document.version, so the
    // owning repo's entries must be dropped explicitly. And updateDecorations
    // no longer blocks on the initial status crawl, so a re-render when a
    // repo's status lands reconciles a file rendered against an empty index.
    // (Guarded: stubbed repositories in unit tests may lack the instance
    // fields.)
    const hookRepository = (repo: Repository) => {
      if (typeof repo.onDidRunOperation === "function") {
        this.disposables.push(
          repo.onDidRunOperation(op => this.onRepositoryOperation(op, repo))
        );
      }
      if (typeof repo.statusReady?.then === "function") {
        void repo.statusReady.then(() => {
          if (window.activeTextEditor) {
            void this.updateDecorations(window.activeTextEditor);
          }
        });
      }
      // Paint the active file immediately if this newly-opened repo owns it.
      // Repos are discovered asynchronously AFTER activate(), so without this
      // the initially-open file would stay blank until statusReady resolves
      // (the multi-second initial crawl) - the old per-repo provider painted
      // it at repo-open because it was constructed there.
      const active = window.activeTextEditor;
      if (active && this.repoFor(active.document.uri) === repo) {
        void this.updateDecorations(active);
      }
    };
    (this.sourceControlManager.repositories ?? []).forEach(hookRepository);
    if (typeof this.sourceControlManager.onDidOpenRepository === "function") {
      this.disposables.push(
        this.sourceControlManager.onDidOpenRepository(hookRepository)
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

    // Resolve the owning repository. Files outside any open working copy
    // (no repo) are cleared - running SVN commands on them returns
    // NotASvnRepository, which would incorrectly dispose a repo.
    const repository = this.repoFor(target.document.uri);
    if (!repository) {
      this.clearDecorations(target);
      return;
    }

    // Check if should decorate
    const shouldDec = this.shouldDecorate(target);

    if (!shouldDec) {
      this.clearDecorations(target);
      return;
    }

    // Don't serialize the first blame behind the initial full status
    // crawl (`svn stat` over the whole working copy took seconds on
    // large checkouts before the first blame could even start). The
    // resource checks below degrade gracefully while the index is still
    // empty, and blame's own error handling silently skips unversioned
    // files; activate() re-renders once statusReady lands.

    // Skip untracked files (prevents SVN errors for UNVERSIONED/IGNORED files)
    const resource = repository.getResourceFromFile(target.document.uri);

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
      // Blame (network-bound) and line mapping (local `svn cat -r BASE`)
      // are independent - fetch them concurrently instead of paying a
      // serial subprocess spawn before the first paint
      const [blameData, lineMapping] = await Promise.all([
        this.getBlameData(target.document.uri, target),
        this.getLineMapping(target.document.uri, target)
      ]);

      if (!blameData) {
        this.clearDecorations(target);
        return;
      }

      // Render cache: same document version + message state -> reuse
      // the built decoration objects instead of rebuilding them all
      const uriKey = target.document.uri.toString();
      // NOTE: no message epoch here. The cached decorations' inline field is
      // applied only when messages are OFF (Phase 2 handles the messages-on
      // case separately), so the reused render never depends on message
      // content - a global epoch just invalidated every file on any fetch.
      const renderKey = {
        version: target.document.version,
        addRevision: this.addRevisionCache.get(uriKey),
        cursorLine: blameConfiguration.isInlineCurrentLineOnly()
          ? this.currentLineNumber
          : undefined
      };
      const cachedRender = this.renderCache.get(uriKey);
      let decorations: {
        gutter: DecorationOptions[];
        icon: DecorationOptions[];
        inline: DecorationOptions[];
      };
      let revisionRange: {
        min: number;
        max: number;
        uniqueRevisions: number[];
      };
      if (
        cachedRender &&
        cachedRender.version === renderKey.version &&
        cachedRender.addRevision === renderKey.addRevision &&
        cachedRender.cursorLine === renderKey.cursorLine
      ) {
        ({ decorations, revisionRange } = cachedRender);
      } else {
        // PROGRESSIVE RENDERING: build without waiting for messages
        decorations = await this.createAllDecorations(blameData, target, {
          skipMessagePrefetch: true, // Don't block on message fetching
          lineMapping
        });
        revisionRange = this.getRevisionRange(blameData);
        this.renderCache.set(uriKey, {
          ...renderKey,
          decorations,
          revisionRange
        });
      }

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

      // Pre-warm Peek Changes data in the background (diffs + hop
      // contents; never historical blames)
      if (configuration.get<boolean>("blame.prefetchHistory", true)) {
        void this.prefetchPeekData(target.document.uri, blameData);
      }

      // Add-revision marker resolves in the background (network log) -
      // never gate the paint on it; one re-render when it first lands
      void this.ensureAddRevision(target.document.uri).then(landed => {
        if (
          landed &&
          window.activeTextEditor?.document.uri.toString() ===
            target.document.uri.toString()
        ) {
          void this.updateDecorations(target);
        }
      });

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

      // Icon types are NOT disposed here. They key on a bounded, shared
      // color palette (~13 quantized values total, not per-file), so
      // reusing them across renders/files avoids the dispose+recreate
      // churn that dominated every editor switch. Disposed only in
      // dispose(); recreated in onConfigurationChange (palette may change).
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
    this.addRevisionCache.delete(key);
    this.renderCache.delete(key);
    this.peekPrefetchDone.delete(key);
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
      this.renderCache.delete(oldestKey);
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

  /** Per-repo scope for the (shared) message cache: revision numbers are only
   *  unique within a repository, so a bare-revision key would let r42 in one
   *  open checkout show the other checkout's r42 message. Scope by the owning
   *  repo's workspace root. */
  private messageScope(uri: Uri): string {
    return this.repoFor(uri)?.workspaceRoot ?? "";
  }

  /** Composite (scope, revision) message-cache key. Revision-first: a
   *  revision is always digits (no '@'), so the first '@' unambiguously
   *  separates it from the scope path even when the path contains '@'. */
  private msgKey(scope: string, revision: string): string {
    return `${revision}@${scope}`;
  }

  /**
   * Read a cached commit message, refreshing its recency. Re-inserting the
   * key moves it to the end of the Map so the insertion-order eviction in
   * evictMessageCache() behaves as true LRU (a hot message read every render
   * won't be evicted just because it was fetched long ago).
   */
  private readMessage(scope: string, revision: string): string | undefined {
    const key = this.msgKey(scope, revision);
    const msg = this.messageCache.get(key);
    if (msg !== undefined) {
      this.messageCache.delete(key);
      this.messageCache.set(key, msg);
    }
    return msg;
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
        this.updateInlineDecorationsWithMessages(
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
   * Build one end-of-line inline blame decoration. Shared by the three
   * inline render paths (message refresh, cursor move, full render) so the
   * range/renderOptions/hover shape can't drift between them - the copies
   * had already diverged once before this was extracted.
   */
  private buildInlineDecoration(
    editor: TextEditor,
    lineIndex: number,
    blameLine: ISvnBlameLine,
    inlineText: string,
    inlineColor: string,
    scope: string
  ): DecorationOptions {
    const line = editor.document.lineAt(lineIndex);
    return {
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
      hoverMessage: buildBlameHover(
        blameLine,
        blameLine.revision
          ? this.readMessage(scope, blameLine.revision)
          : undefined,
        editor.document.uri,
        this.addRevisionCache.get(editor.document.uri.toString()),
        lineIndex
      )
    };
  }

  /**
   * Pre-warm what "Peek Changes" needs, in the background: the per-
   * revision diffs (the peek previews) and the REV-1 contents (the
   * walk's mapping hops), newest revisions first. Historical BLAMES
   * stay lazy - prefetching those would multiply server load. Runs
   * sequentially, once per file per session, and aborts the sweep on
   * the first network failure.
   */
  private async prefetchPeekData(
    uri: Uri,
    blameData: ISvnBlameLine[]
  ): Promise<void> {
    const key = uri.toString();
    if (this.peekPrefetchDone.has(key)) {
      return;
    }
    const repository = this.repoFor(uri);
    if (!repository) {
      return;
    }
    this.peekPrefetchDone.add(key);

    const revisions = [
      ...new Set(blameData.map(b => b.revision).filter((r): r is string => !!r))
    ]
      .map(r => parseInt(r, 10))
      .filter(n => !isNaN(n))
      .sort((a, b) => b - a)
      .slice(0, BlameProvider.MAX_PEEK_PREFETCH);

    let peg: string | undefined;
    try {
      const info = await repository.repository.getInfo(uri.fsPath);
      if (/^\d+$/.test(info.revision)) {
        peg = info.revision;
      }
    } catch {
      return; // offline - the sweep retries after the next invalidation
    }

    for (const rev of revisions) {
      try {
        await repository.repository.patchRevision(String(rev), uri);
      } catch {
        return; // network trouble - stop, don't storm the server
      }
      if (rev > 1) {
        try {
          await repository.repository.show(uri.fsPath, String(rev - 1), peg);
        } catch {
          // lineage boundary (file added at rev) - keep sweeping
        }
      }
    }
  }

  /** Oldest revision that touched each file - marks "added here" lines.
   *  "" is the negative sentinel: lookup failed, don't retry per render. */
  private addRevisionCache = new Map<string, string>();

  /**
   * Resolve the file's ADD revision (`svn log -r 1:HEAD --limit=1`, the
   * first revision of its lineage) once per file. Best-effort and NEVER
   * awaited on the paint path: it's a network log that can outlast a
   * cached blame. Returns whether a NEW marker value landed (callers
   * re-render once on true). Failures negative-cache so an offline
   * session doesn't re-spawn a doomed subprocess on every render.
   */
  private async ensureAddRevision(uri: Uri): Promise<boolean> {
    const key = uri.toString();
    if (this.addRevisionCache.has(key)) {
      return false;
    }
    const repository = this.repoFor(uri);
    if (!repository) {
      return false;
    }
    try {
      const entries = await repository.repository.log(
        "1",
        "HEAD",
        1,
        uri.fsPath
      );
      const first = entries[0]?.revision;
      this.addRevisionCache.set(key, first ?? "");
      return !!first;
    } catch {
      this.addRevisionCache.set(key, "");
      return false;
    }
  }

  /**
   * Update inline decorations with commit messages
   * Called after messages are fetched asynchronously
   */
  private updateInlineDecorationsWithMessages(
    blameData: ISvnBlameLine[],
    editor: TextEditor,
    lineMapping?: LineMapping
  ): void {
    const inlineDecorations: DecorationOptions[] = [];
    const currentLineOnly = blameConfiguration.isInlineCurrentLineOnly();
    const inlineColor = `rgba(127, 127, 127, ${blameConfiguration.getInlineOpacity()})`;
    const activeLine = editor.selection.active.line;
    const scope = this.messageScope(editor.document.uri);

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
      const message = this.readMessage(scope, blameLine.revision) || "";
      const inlineText = this.formatInlineText(blameLine, message);

      inlineDecorations.push(
        this.buildInlineDecoration(
          editor,
          lineIndex,
          blameLine,
          inlineText,
          inlineColor,
          scope
        )
      );
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

    // Skip files outside any open working copy.
    if (!this.repoFor(editor.document.uri)) {
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
    const scope = this.messageScope(editor.document.uri);

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
      const message = this.readMessage(scope, blameLine.revision) || "";
      const inlineText = this.formatInlineText(blameLine, message);

      inlineDecorations.push(
        this.buildInlineDecoration(
          editor,
          lineIndex,
          blameLine,
          inlineText,
          inlineColor,
          scope
        )
      );

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
    this.renderCache.clear();
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
    // No explicit editor: @throttle isn't keep-last, so a queued render
    // would otherwise repaint whichever editor was active when the FIRST
    // queued call fired. Resolving window.activeTextEditor at execution
    // time keeps rapid tab-switching from leaving the visible editor blank.
    await this.updateDecorations();
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
  private onRepositoryOperation(operation: Operation, repo: Repository): void {
    if (!BLAME_INVALIDATING_OPERATIONS.has(operation)) {
      return;
    }

    // Shared provider: a mutation in repo A must only drop repo A's files'
    // entries, not every repo's. clearCache(uri) already clears all per-uri
    // structures, so scope-clear the union of their keys under repo.root.
    const owns = (key: string) => {
      try {
        return isDescendant(repo.workspaceRoot, Uri.parse(key).fsPath);
      } catch {
        return false;
      }
    };
    const keys = new Set<string>([
      ...this.blameCache.keys(),
      ...this.lineMappingCache.keys(),
      ...this.renderCache.keys(),
      ...this.addRevisionCache.keys(),
      ...this.peekPrefetchDone,
      ...this.inFlightMessageFetches.keys()
    ]);
    for (const key of keys) {
      if (owns(key)) {
        this.clearCache(Uri.parse(key));
      }
    }

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

  /** sven.blame.* keys whose change alters what's rendered (templates,
   *  toggles, opacity, date format). A change to anything else - CSV/large-
   *  file gates, autoBlame, enableLogs - needs no decoration-type teardown. */
  private static readonly APPEARANCE_KEYS = [
    "sven.blame.enabled",
    "sven.blame.dateFormat",
    "sven.blame.gutter.enabled",
    "sven.blame.gutter.template",
    "sven.blame.gutter.showIcons",
    "sven.blame.gutter.showText",
    "sven.blame.inline.enabled",
    "sven.blame.inline.template",
    "sven.blame.inline.opacity",
    "sven.blame.inline.showMessage",
    "sven.blame.inline.currentLineOnly",
    "sven.blame.inline.maxLength"
  ];

  private async onConfigurationChange(
    event: ConfigurationChangeEvent
  ): Promise<void> {
    // Only appearance keys need the type/cache teardown below. For anything
    // else (gate limits, autoBlame, enableLogs) a re-render suffices - it
    // picks up a changed gate without disposing types or clearing caches.
    // (A degenerate event without affectsConfiguration - test stubs - falls
    // through to the full teardown, the conservative default.)
    const affectsAppearance =
      typeof event?.affectsConfiguration !== "function" ||
      BlameProvider.APPEARANCE_KEYS.some(k => event.affectsConfiguration(k));

    if (!affectsAppearance) {
      this.renderCache.clear();
      if (window.activeTextEditor) {
        await this.updateDecorations();
      }
      return;
    }

    // Built decorations embed template/config-dependent content
    this.renderCache.clear();

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
    return this.repoFor(filePath)?.isInsideUnversionedOrIgnored(filePath);
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
      this.cacheAccessOrder.set(key, ++this.cacheAccessCounter);
      return cached.data;
    }

    const repository = this.repoFor(uri);
    if (!repository) {
      return undefined;
    }

    // Pre-check: verify file is under version control before attempting blame
    // First check resource index (avoids SVN call for known unversioned files)
    const resource = repository.getResourceFromFile(uri);
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
      const data = await repository.blame(uri.fsPath);

      // Cache with document version (for staleness detection on external changes)
      this.blameCache.set(key, { data, version: currentVersion });

      // Track access time for LRU
      this.cacheAccessOrder.set(key, ++this.cacheAccessCounter);

      // Evict oldest entry if cache exceeds limit
      this.evictOldestCache();

      return data;
    } catch (err) {
      const kind = classifyBlameError(err);
      if (kind === "untracked") {
        return undefined; // Silently skip unversioned files
      }

      logError("BlameProvider: Failed to fetch blame data", err);
      this.notifyBlameFetchError(kind, repository);
      return undefined;
    }
  }

  /** Surface a blame-fetch failure to the user (auth/network only). */
  private notifyBlameFetchError(
    kind: BlameErrorKind,
    repository: Repository
  ): void {
    if (kind === "auth") {
      window
        .showWarningMessage(
          "SVN authentication required. Use 'SVN: Authenticate' command or check credentials.",
          "Authenticate"
        )
        .then(choice => {
          if (choice === "Authenticate") {
            const repoUrl = repository.repository.info?.url;
            commands.executeCommand(
              "sven.promptAuth",
              undefined,
              undefined,
              repoUrl
            );
          }
        });
    } else if (kind === "network") {
      window.showErrorMessage(
        "Unable to connect to SVN server. Check VPN/network."
      );
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
    const repository = this.repoFor(uri);
    const resource = repository?.getResourceFromFile(uri);
    if (!repository || !resource || resource.type !== Status.MODIFIED) {
      // File not modified (or no repo) - no mapping needed (identity mapping)
      return undefined;
    }

    try {
      // Get BASE content (committed version)
      const baseContent = await repository.repository.show(uri.fsPath, "BASE");
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
    // On the progressive path the inline array is discarded and rebuilt in
    // Phase 2 (with batched messages), so building it here - one svn log per
    // line when messages are on - is pure waste. Only skip when messages are
    // on; without messages this call's inline output IS the one applied.
    const buildInline =
      inlineEnabled && !(options.skipMessagePrefetch && showInlineMessage);
    const inlineColor = `rgba(127, 127, 127, ${blameConfiguration.getInlineOpacity()})`;
    const activeLine = editor.selection.active.line;
    const scope = this.messageScope(editor.document.uri);

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
      if (buildInline) {
        const isCurrentLine = lineIndex === activeLine;

        if (!inlineCurrentLineOnly || isCurrentLine) {
          const message = showInlineMessage
            ? await this.getCommitMessage(
                blameLine.revision,
                editor.document.uri
              )
            : "";

          const inlineText = this.formatInlineText(blameLine, message);

          inlineDecorations.push(
            this.buildInlineDecoration(
              editor,
              lineIndex,
              blameLine,
              inlineText,
              inlineColor,
              scope
            )
          );
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

    // min/max are the endpoints of the sorted-desc list - O(1), and safe on
    // huge files (Math.min(...revisions) spreads every line as an argument
    // and overflows the call stack past ~125k lines).
    return {
      min: uniqueRevisions[uniqueRevisions.length - 1]!,
      max: uniqueRevisions[0]!,
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
    const revNum = parseInt(revision, 10);
    const saturation = 45; // Increased for better distinction
    const lightness = this.getThemeAwareLightness();

    // Find index of this revision in the file's unique revisions (sorted newest first)
    const revisionIndex = range.uniqueRevisions.indexOf(revNum);

    // The color is a function of the revision's POSITION in this file's
    // range (index + range size) and the theme lightness - a revision-only
    // key would freeze the first-blamed file's palette for every other
    // file sharing the revision (and across theme switches)
    const cacheKey = `${revision}@${revisionIndex}/${range.uniqueRevisions.length}L${lightness}`;
    const cached = this.revisionColors.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    // Bound growth: keys are per (revision, position, range size, theme).
    // Evict the oldest fraction rather than clearing all - a full wipe
    // thrashed every cached color when the working set legitimately
    // exceeded the cap (colors are cheap to recompute, but not free).
    if (this.revisionColors.size > 2000) {
      const toRemove = Math.ceil(this.revisionColors.size * 0.25);
      let removed = 0;
      for (const key of this.revisionColors.keys()) {
        if (removed++ >= toRemove) break;
        this.revisionColors.delete(key);
      }
    }

    if (isNaN(revNum) || range.uniqueRevisions.length === 0) {
      // Fallback for invalid or empty: mid-point blue-purple
      const color = this.hslToHex(240, 45, lightness);
      this.revisionColors.set(cacheKey, color);
      return color;
    }

    if (revisionIndex === -1) {
      // Not found (shouldn't happen), fallback
      const color = this.hslToHex(240, saturation, lightness);
      this.revisionColors.set(cacheKey, color);
      return color;
    }

    // Hybrid approach: categorical for top 5 unique revisions, gradient for rest
    if (revisionIndex < 5) {
      // Recent revisions: categorical colors (index 0=newest=red, 4=5th newest=blue)
      const categoricalHues = [0, 30, 60, 120, 200]; // Red→orange→yellow→green→blue
      const hue = categoricalHues[revisionIndex]!;
      const color = this.hslToHex(hue, saturation, lightness);
      this.revisionColors.set(cacheKey, color);
      return color;
    } else {
      // Older revisions: gradient heatmap (blue → purple)
      const olderRevisions = range.uniqueRevisions.slice(5); // Skip first 5
      const olderIndex = revisionIndex - 5; // Position within older revisions

      if (olderRevisions.length === 1) {
        // Only one older revision, use blue
        const color = this.hslToHex(200, saturation, lightness);
        this.revisionColors.set(cacheKey, color);
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
      this.revisionColors.set(cacheKey, color);
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
    const gutterEnabled = blameConfiguration.isGutterEnabled();
    const iconsEnabled = blameConfiguration.isGutterIconEnabled();

    if (!gutterEnabled || !iconsEnabled) {
      this.clearIconDecorations(editor);
      return;
    }

    // Group lines by color (icon types are reused across renders, keyed by
    // the bounded shared palette - never disposed/recreated per render)
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

    // Clear only colors this editor no longer uses (reuse the rest in place)
    for (const color of this.iconTypes.keys()) {
      if (!decorationsByColor.has(color)) {
        editor.setDecorations(this.iconTypes.get(color)!, []);
      }
    }

    // Apply each present color's decoration type
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
  /**
   * Deliberately UNTARGETED: a single-revision log is cheap either way,
   * and a targeted one misses revisions that belong to a replaced/renamed
   * ancestor path (this is also the fallback when the targeted range log
   * in prefetchMessages fails for exactly that reason). Only the RANGE
   * query (logBatch) needs a target - that's where the cost lives.
   */
  private async getCommitMessage(revision: string, uri: Uri): Promise<string> {
    const scope = this.messageScope(uri);
    const cached = this.readMessage(scope, revision);
    if (cached !== undefined) {
      return cached;
    }

    if (!blameConfiguration.isLogsEnabled()) {
      return "";
    }

    const repository = this.repoFor(uri);
    if (!repository) {
      return "";
    }

    try {
      const log = await repository.log(revision, revision, 1);
      const message = log[0]?.msg || "";
      this.messageCache.set(this.msgKey(scope, revision), message);

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

    // The batch log must be targeted at the blamed file's repo; without a
    // resolvable target there's nothing to query.
    const repository = target ? this.repoFor(target) : undefined;
    if (!repository || !target) {
      return;
    }
    const scope = this.messageScope(target);

    const uncached = revisions.filter(
      r => !this.messageCache.has(this.msgKey(scope, r))
    );

    if (uncached.length === 0) {
      return;
    }

    try {
      // Batch fetch: single SVN command for all revisions, targeted at the
      // blamed file so the server filters to its history. Without a target
      // this spanned every revision in the checkout between min and max.
      const logEntries = await repository.logBatch(uncached, target.fsPath);

      // Cache all fetched messages
      for (const entry of logEntries) {
        if (entry.revision && entry.msg !== undefined) {
          this.messageCache.set(this.msgKey(scope, entry.revision), entry.msg);
        }
      }

      // Evict message cache if exceeding limit
      this.evictMessageCache();
    } catch (err) {
      logError(
        "BlameProvider: Batch message fetch failed, falling back to sequential",
        err
      );

      // Fallback to sequential fetching on error (untargeted - see
      // getCommitMessage; the targeted range log may have failed because
      // of the target)
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
