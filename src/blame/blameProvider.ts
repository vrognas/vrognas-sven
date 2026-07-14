// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

"use strict";

import * as path from "path";
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
import { ISvnBlameLine } from "../common/types";
import { configuration } from "../helpers/configuration";
import { ExternalOperationImpact, Repository } from "../repository";
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
import { BLAME_INVALIDATING_OPERATIONS } from "../operationPolicy";
import { isDescendant, pathEquals } from "../util";
import {
  computeLineMapping,
  LineMapping,
  mapBlameLineNumber
} from "../util/lineMapper";
import { formatBlameDate } from "../util/formatting";

interface UriOwnerToken {
  key: string;
  uri: Uri;
  repository: Repository;
  generation: number;
}

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
  private messageCache = new Map<string, string>(); // scope+revision → message
  private inFlightMessageFetches = new Map<string, Promise<void>>();
  private messageScopeEpochs = new Map<string, number>();
  private uriOwners = new Map<string, UriOwnerToken>();
  private nextOwnerGeneration = 0;
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
      messageScope?: string;
      messageRevisions?: Set<string>;
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
  private documentChangeTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private cursorTimers = new Map<TextEditor, ReturnType<typeof setTimeout>>();
  private cursorLines = new WeakMap<TextEditor, number>();
  private renderGenerations = new WeakMap<TextEditor, number>();
  private disposables: Disposable[] = [];
  /** Per-repo event subscriptions, released when the repo closes so a churny
   *  session (externals add/remove) doesn't accumulate dead subscriptions. */
  private repoHooks = new Map<Repository, Disposable[]>();
  private repoRenderFlights = new Map<
    Repository,
    { rerun: boolean; promise: Promise<void> }
  >();
  private isActivated = false;
  private isDisposed = false;

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

  private claimOwner(uri: Uri, repository: Repository): UriOwnerToken {
    const key = uri.toString();
    const current = this.uriOwners.get(key);
    if (current?.repository === repository) {
      return current;
    }
    if (current) {
      this.clearMessageFlights(current.generation);
      this.clearCacheEntries(key);
    }
    const token = {
      key,
      uri,
      repository,
      generation: ++this.nextOwnerGeneration
    };
    this.uriOwners.set(key, token);
    return token;
  }

  private isCurrentOwner(token: UriOwnerToken): boolean {
    return (
      this.uriOwners.get(token.key) === token &&
      this.repoFor(token.uri) === token.repository
    );
  }

  private clearMessageFlights(generation: number): void {
    const prefix = `${generation}:`;
    for (const key of this.inFlightMessageFetches.keys()) {
      if (key.startsWith(prefix)) {
        this.inFlightMessageFetches.delete(key);
      }
    }
  }

  private visibleEditors(): readonly TextEditor[] {
    const visible = window.visibleTextEditors ?? [];
    const active = window.activeTextEditor;
    return active && !visible.includes(active) ? [...visible, active] : visible;
  }

  private isEditorVisible(editor: TextEditor): boolean {
    return this.visibleEditors().includes(editor);
  }

  private visibleEditorsForUri(uri?: Uri): readonly TextEditor[] {
    if (!uri) {
      return [...this.visibleEditors()];
    }
    const key = uri.toString();
    return this.visibleEditors().filter(
      editor => editor.document.uri.toString() === key
    );
  }

  private isEditorLive(editor: TextEditor): boolean {
    return editor.document.isClosed !== true && this.isEditorVisible(editor);
  }

  /**
   * Lifecycle snapshots can outlive a pane. Revalidate every editor at its
   * actual turn and contain one failed render so later split panes still run.
   */
  private async renderVisibleEditors(
    editors: readonly TextEditor[]
  ): Promise<void> {
    for (const editor of editors) {
      try {
        if (this.isDisposed) {
          return;
        }
        if (!this.isEditorLive(editor)) {
          continue;
        }
        await this.renderDecorations(editor, true);
      } catch (err) {
        logError("BlameProvider: Failed to render visible editor", err);
      }
    }
  }

  private async renderVisibleEditorsByRepository(
    editors: readonly TextEditor[]
  ): Promise<void> {
    const groups = new Map<Repository | undefined, TextEditor[]>();
    for (const editor of editors) {
      const repo = this.repoFor(editor.document.uri);
      const group = groups.get(repo) ?? [];
      group.push(editor);
      groups.set(repo, group);
    }
    await Promise.all(
      [...groups.values()].map(group => this.renderVisibleEditors(group))
    );
  }

  private scheduleRepositoryRender(repo: Repository): Promise<void> {
    const current = this.repoRenderFlights.get(repo);
    if (current) {
      current.rerun = true;
      return current.promise;
    }

    const state = { rerun: false, promise: Promise.resolve() };
    const run = async () => {
      do {
        state.rerun = false;
        const editors = this.visibleEditors().filter(
          editor => this.repoFor(editor.document.uri) === repo
        );
        await this.renderVisibleEditors(editors);
      } while (state.rerun && !this.isDisposed);
    };
    state.promise = run().finally(() => {
      if (this.repoRenderFlights.get(repo) === state) {
        this.repoRenderFlights.delete(repo);
      }
    });
    this.repoRenderFlights.set(repo, state);
    return state.promise;
  }

  private clearCacheEntries(key: string): void {
    this.blameCache.delete(key);
    this.lineMappingCache.delete(key);
    this.cacheAccessOrder.delete(key);
    this.addRevisionCache.delete(key);
    this.renderCache.delete(key);
    this.peekPrefetchDone.delete(key);
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
      const hooks: Disposable[] = [];
      if (typeof repo.onDidRunOperationDetail === "function") {
        hooks.push(
          repo.onDidRunOperationDetail(detail =>
            this.onRepositoryOperation(
              detail.operation,
              repo,
              detail.affectedExternalRoots,
              detail.externalImpact,
              detail.externalTopologyIncomplete === true
            )
          )
        );
      } else if (typeof repo.onDidRunOperation === "function") {
        hooks.push(
          repo.onDidRunOperation(op => this.onRepositoryOperation(op, repo))
        );
      }
      this.repoHooks.set(repo, hooks);
      // Resolve the active editor at execution time after status lands.
      if (typeof repo.statusReady?.then === "function") {
        void repo.statusReady.then(() => {
          if (!this.repoHooks.has(repo)) {
            return;
          }
          const editors = this.visibleEditors().filter(
            editor => this.repoFor(editor.document.uri) === repo
          );
          for (const editor of editors) {
            // The pre-status render may have cached identity line mapping
            // while the resource index was empty.
            this.clearCache(editor.document.uri);
            this.clearDecorations(editor);
          }
          if (editors.length > 0) {
            void this.renderVisibleEditors(editors);
          }
        });
      }
      // Repositories are discovered asynchronously. Reconcile every visible
      // editor now owned by this repo, including inactive split editors that
      // may still carry a parent repo's token/messages.
      const editors = this.visibleEditors().filter(editor => {
        const uri = editor.document.uri;
        return (
          this.repoFor(uri) === repo &&
          this.uriOwners.get(uri.toString())?.repository !== repo
        );
      });
      for (const editor of editors) {
        this.clearDecorations(editor);
      }
      if (editors.length > 0) {
        void this.renderVisibleEditors(editors);
      }
    };
    (this.sourceControlManager.repositories ?? []).forEach(hookRepository);
    if (typeof this.sourceControlManager.onDidOpenRepository === "function") {
      this.disposables.push(
        this.sourceControlManager.onDidOpenRepository(hookRepository)
      );
    }
    if (typeof this.sourceControlManager.onDidCloseRepository === "function") {
      this.disposables.push(
        this.sourceControlManager.onDidCloseRepository((repo: Repository) => {
          this.repoHooks.get(repo)?.forEach(d => d.dispose());
          this.repoHooks.delete(repo);
          this.repoRenderFlights.delete(repo);
          this.onRepositoryClosed(repo);
        })
      );
    }

    this.isActivated = true;

    // Apply to current active editor
    if (window.activeTextEditor) {
      void this.onActiveEditorChange(window.activeTextEditor);
    }
  }

  /** Explicit targets render losslessly; no-arg active renders coalesce per repo. */
  public async updateDecorations(editor?: TextEditor): Promise<void> {
    if (editor) {
      await this.renderDecorations(editor);
      return;
    }
    const target = window.activeTextEditor;
    if (!target) {
      return;
    }
    const repo = this.repoFor(target.document.uri);
    if (!repo) {
      await this.renderDecorations(target, true);
      return;
    }
    await this.scheduleRepositoryRender(repo);
  }

  private async renderDecorations(
    editor?: TextEditor,
    requireVisible = false
  ): Promise<void> {
    const target = editor || window.activeTextEditor;

    if (
      this.isDisposed ||
      !target ||
      target.document.isClosed === true ||
      (requireVisible && !this.isEditorVisible(target))
    ) {
      return;
    }
    const renderGeneration = (this.renderGenerations.get(target) ?? 0) + 1;
    this.renderGenerations.set(target, renderGeneration);

    // Resolve the owning repository. Files outside any open working copy
    // (no repo) are cleared - running SVN commands on them returns
    // NotASvnRepository, which would incorrectly dispose a repo.
    const repository = this.repoFor(target.document.uri);
    if (!repository) {
      this.clearCache(target.document.uri);
      this.clearDecorations(target);
      return;
    }
    const ownerToken = this.claimOwner(target.document.uri, repository);
    const documentVersion = target.document.version;

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
      this.clearDecorations(target);
      window.showWarningMessage(
        `Blame skipped for large CSV (${target.document.lineCount} lines > ` +
          `${blameConfiguration.getCsvLineLimit()} limit). ` +
          `Adjust 'sven.blame.csvLineLimit' or 'sven.blame.csvExtensions'.`
      );
      return;
    }
    if (sizeGate === "largeFile") {
      this.clearDecorations(target);
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
        this.getBlameData(target.document.uri, target, repository, ownerToken),
        this.getLineMapping(target.document.uri, target, repository, ownerToken)
      ]);

      if (
        !this.canApplyRender(
          target,
          ownerToken,
          documentVersion,
          requireVisible,
          renderGeneration
        )
      ) {
        return;
      }
      if (!blameData) {
        this.clearDecorations(target);
        return;
      }

      // Render cache: same document version + message state -> reuse
      // the built decoration objects instead of rebuilding them all
      const uriKey = target.document.uri.toString();
      const messageScope = repository.workspaceRoot;
      const embedsCachedMessage =
        blameConfiguration.isInlineEnabled() &&
        !blameConfiguration.shouldShowInlineMessage() &&
        blameConfiguration.isLogsEnabled();
      const messageEpoch = embedsCachedMessage
        ? (this.messageScopeEpochs.get(messageScope) ?? 0)
        : undefined;
      const renderKey = {
        version: target.document.version,
        addRevision: this.addRevisionCache.get(uriKey),
        cursorLine: blameConfiguration.isInlineCurrentLineOnly()
          ? target.selection.active.line
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
          lineMapping,
          ownerToken
        });
        if (
          !this.canApplyRender(
            target,
            ownerToken,
            documentVersion,
            requireVisible,
            renderGeneration
          )
        ) {
          return;
        }
        revisionRange = this.getRevisionRange(blameData);
        if (
          messageEpoch === undefined ||
          (this.messageScopeEpochs.get(messageScope) ?? 0) === messageEpoch
        ) {
          this.renderCache.set(uriKey, {
            ...renderKey,
            messageScope: embedsCachedMessage ? messageScope : undefined,
            messageRevisions: embedsCachedMessage
              ? new Set(
                  blameData
                    .map(line => line.revision)
                    .filter((revision): revision is string => !!revision)
                )
              : undefined,
            decorations,
            revisionRange
          });
        }
      }

      if (
        !this.canApplyRender(
          target,
          ownerToken,
          documentVersion,
          requireVisible,
          renderGeneration
        )
      ) {
        return;
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
        blameConfiguration.shouldShowInlineMessage() &&
        blameConfiguration.isLogsEnabled();

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
        void this.prefetchPeekData(target.document.uri, blameData, ownerToken);
      }

      // Add-revision marker resolves in the background (network log) -
      // never gate the paint on it; one re-render when it first lands
      void this.ensureAddRevision(target.document.uri, ownerToken).then(
        landed => {
          if (landed && this.isCurrentOwner(ownerToken)) {
            void this.renderVisibleEditors(
              this.visibleEditorsForUri(target.document.uri)
            );
          }
        }
      );

      // PHASE 2: Fetch messages asynchronously and update inline decorations
      // (Fire-and-forget - don't block UI)
      if (willFetchMessages) {
        this.prefetchMessagesProgressively(
          target.document.uri,
          blameData,
          target,
          undefined,
          lineMapping,
          ownerToken,
          renderGeneration
        ).catch(err => {
          logError("BlameProvider: Progressive message fetch failed", err);
        });
      }
    } catch (err) {
      logError("BlameProvider: Failed to update decorations", err);
      if (
        this.canApplyRender(
          target,
          ownerToken,
          documentVersion,
          requireVisible,
          renderGeneration
        )
      ) {
        this.clearDecorations(target);
      }
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
   * Async work is valid only while ownership, document contents, pane
   * liveness, and render eligibility still match the render that started it.
   */
  private canApplyRender(
    editor: TextEditor,
    ownerToken: UriOwnerToken,
    documentVersion: number,
    requireVisible: boolean,
    renderGeneration?: number
  ): boolean {
    if (
      this.isDisposed ||
      !this.isCurrentOwner(ownerToken) ||
      editor.document.version !== documentVersion ||
      editor.document.isClosed === true ||
      (requireVisible && !this.isEditorVisible(editor)) ||
      (renderGeneration !== undefined &&
        (this.renderGenerations.get(editor) ?? 0) !== renderGeneration)
    ) {
      return false;
    }
    if (!this.isRenderEligible(editor)) {
      this.clearDecorations(editor);
      return false;
    }
    return true;
  }

  private isRenderEligible(editor: TextEditor): boolean {
    return (
      this.shouldDecorate(editor) &&
      !blameConfiguration.getBlameSizeGate(
        editor.document.uri,
        editor.document.lineCount
      )
    );
  }

  /**
   * Clear cache for URI
   */
  public clearCache(uri: Uri): void {
    const key = uri.toString();
    const token = this.uriOwners.get(key);
    if (token) {
      this.clearMessageFlights(token.generation);
      this.uriOwners.delete(key);
    }
    this.clearCacheEntries(key);
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
      this.renderCache.delete(oldestKey);
    }
  }

  /**
   * Evict message cache entries when exceeding limit
   * Map order is LRU: reads/writes reinsert hits before oldest-first eviction.
   */
  private evictMessageCache(): void {
    if (this.messageCache.size <= this.MAX_MESSAGE_CACHE_SIZE) {
      return; // Within limit, no eviction needed
    }

    // Evict oldest 25% of entries (batch eviction for efficiency)
    const toRemove = Math.ceil(this.messageCache.size * 0.25);
    const keys = Array.from(this.messageCache.keys()).slice(0, toRemove);
    const affectedScopes = new Set<string>();

    for (const key of keys) {
      this.messageCache.delete(key);
      const at = key.indexOf("@");
      if (at >= 0) {
        const scope = key.slice(at + 1);
        affectedScopes.add(scope);
        this.invalidateMessageDependentRenders(scope, key.slice(0, at));
      }
    }
    for (const scope of affectedScopes) {
      this.messageScopeEpochs.set(
        scope,
        (this.messageScopeEpochs.get(scope) ?? 0) + 1
      );
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
    if (!blameConfiguration.isLogsEnabled()) {
      return undefined;
    }
    const key = this.msgKey(scope, revision);
    const msg = this.messageCache.get(key);
    if (msg !== undefined) {
      this.messageCache.delete(key);
      this.messageCache.set(key, msg);
    }
    return msg;
  }

  private writeMessage(scope: string, revision: string, message: string): void {
    const key = this.msgKey(scope, revision);
    const previous = this.messageCache.get(key);
    if (previous === message) {
      this.messageCache.delete(key);
      this.messageCache.set(key, message);
      return;
    }
    if (previous !== undefined) {
      this.messageCache.delete(key);
    }
    this.messageCache.set(key, message);
    this.messageScopeEpochs.set(
      scope,
      (this.messageScopeEpochs.get(scope) ?? 0) + 1
    );
    this.invalidateMessageDependentRenders(scope, revision);
  }

  private invalidateMessageDependentRenders(
    scope: string,
    revision: string
  ): void {
    for (const [uri, entry] of this.renderCache) {
      if (
        entry.messageScope === scope &&
        entry.messageRevisions?.has(revision)
      ) {
        this.renderCache.delete(uri);
      }
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
    lineMapping?: LineMapping,
    ownerToken?: UriOwnerToken,
    renderGeneration?: number
  ): Promise<void> {
    const repository = ownerToken?.repository ?? this.repoFor(uri);
    if (!repository) {
      return;
    }
    const token = ownerToken ?? this.claimOwner(uri, repository);
    if (!this.isCurrentOwner(token)) {
      return;
    }
    const documentVersion = editor.document.version;
    const flightKey = `${token.generation}:${documentVersion}`;

    // Deduplicate only the network fetch. Every caller keeps its own
    // post-fetch apply so split editors and statusReady remaps cannot inherit
    // another render's editor or line mapping.
    let fetchPromise = this.inFlightMessageFetches.get(flightKey);
    if (!fetchPromise) {
      const uniqueRevisions =
        precomputedUniqueRevisions ||
        ([
          ...new Set(blameData.map(b => b.revision).filter(Boolean))
        ] as string[]);
      if (uniqueRevisions.length === 0 || uniqueRevisions.length > 100) {
        return;
      }
      fetchPromise = this.prefetchMessages(uniqueRevisions, uri, token).finally(
        () => this.inFlightMessageFetches.delete(flightKey)
      );
      this.inFlightMessageFetches.set(flightKey, fetchPromise);
    }
    await fetchPromise;

    if (
      !this.canApplyRender(
        editor,
        token,
        documentVersion,
        true,
        renderGeneration
      )
    ) {
      return;
    }
    if (
      !blameConfiguration.isInlineEnabled() ||
      !blameConfiguration.shouldShowInlineMessage() ||
      !blameConfiguration.isLogsEnabled()
    ) {
      return;
    }
    this.updateInlineDecorationsWithMessages(
      blameData,
      editor,
      lineMapping,
      token
    );
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
    blameData: ISvnBlameLine[],
    ownerToken?: UriOwnerToken
  ): Promise<void> {
    const key = uri.toString();
    if (this.peekPrefetchDone.has(key)) {
      return;
    }
    const repository = ownerToken?.repository ?? this.repoFor(uri);
    if (!repository) {
      return;
    }
    const token = ownerToken ?? this.claimOwner(uri, repository);
    if (!this.isCurrentOwner(token)) {
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
      if (!this.isCurrentOwner(token)) {
        return;
      }
      if (/^\d+$/.test(info.revision)) {
        peg = info.revision;
      }
    } catch {
      return; // offline - the sweep retries after the next invalidation
    }

    for (const rev of revisions) {
      if (!this.isCurrentOwner(token)) {
        return;
      }
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
  private inFlightAddRevisions = new Map<string, Promise<boolean>>();

  /**
   * Resolve the file's ADD revision (`svn log -r 1:HEAD --limit=1`, the
   * first revision of its lineage) once per file. Best-effort and NEVER
   * awaited on the paint path: it's a network log that can outlast a
   * cached blame. Returns whether a NEW marker value landed (callers
   * re-render once on true). Failures negative-cache so an offline
   * session doesn't re-spawn a doomed subprocess on every render.
   */
  private async ensureAddRevision(
    uri: Uri,
    ownerToken?: UriOwnerToken
  ): Promise<boolean> {
    const key = uri.toString();
    const repository = ownerToken?.repository ?? this.repoFor(uri);
    if (!repository) {
      return false;
    }
    const token = ownerToken ?? this.claimOwner(uri, repository);
    if (!this.isCurrentOwner(token) || this.addRevisionCache.has(key)) {
      return false;
    }
    const flightKey = `${token.generation}:${key}`;
    const pending = this.inFlightAddRevisions.get(flightKey);
    if (pending) {
      await pending;
      return false;
    }
    const lookup = (async () => {
      try {
        const entries = await repository.repository.log(
          "1",
          "HEAD",
          1,
          uri.fsPath
        );
        if (!this.isCurrentOwner(token)) {
          return false;
        }
        const first = entries[0]?.revision;
        this.addRevisionCache.set(key, first ?? "");
        return !!first;
      } catch {
        if (!this.isCurrentOwner(token)) {
          return false;
        }
        this.addRevisionCache.set(key, "");
        return false;
      }
    })();
    this.inFlightAddRevisions.set(flightKey, lookup);
    try {
      return await lookup;
    } finally {
      if (this.inFlightAddRevisions.get(flightKey) === lookup) {
        this.inFlightAddRevisions.delete(flightKey);
      }
    }
  }

  /**
   * Update inline decorations with commit messages
   * Called after messages are fetched asynchronously
   */
  private updateInlineDecorationsWithMessages(
    blameData: ISvnBlameLine[],
    editor: TextEditor,
    lineMapping?: LineMapping,
    ownerToken?: UriOwnerToken
  ): void {
    const inlineDecorations: DecorationOptions[] = [];
    const currentLineOnly = blameConfiguration.isInlineCurrentLineOnly();
    const inlineColor = `rgba(127, 127, 127, ${blameConfiguration.getInlineOpacity()})`;
    const activeLine = editor.selection.active.line;
    const scope =
      ownerToken?.repository.workspaceRoot ??
      this.messageScope(editor.document.uri);

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
      const message = blameConfiguration.shouldShowInlineMessage()
        ? this.readMessage(scope, blameLine.revision) || ""
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
    const repository = this.repoFor(editor.document.uri);
    if (!repository) {
      return;
    }
    const ownerToken = this.claimOwner(editor.document.uri, repository);
    const documentVersion = editor.document.version;
    const renderGeneration = this.renderGenerations.get(editor) ?? 0;

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
    const blameData = await this.getBlameData(
      editor.document.uri,
      editor,
      repository,
      ownerToken
    );
    if (
      !blameData ||
      !this.canApplyCursorRender(
        editor,
        ownerToken,
        documentVersion,
        renderGeneration
      )
    ) {
      return;
    }

    // Get line mapping for modified files
    const lineMapping = await this.getLineMapping(
      editor.document.uri,
      editor,
      repository,
      ownerToken
    );
    if (
      !this.canApplyCursorRender(
        editor,
        ownerToken,
        documentVersion,
        renderGeneration
      )
    ) {
      return;
    }

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
      const message = blameConfiguration.shouldShowInlineMessage()
        ? this.readMessage(scope, blameLine.revision) || ""
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

      break; // Found current line, done
    }

    // Apply only inline decorations (skip gutter and icons)
    editor.setDecorations(this.decorationTypes.inline, inlineDecorations);
  }

  private canApplyCursorRender(
    editor: TextEditor,
    ownerToken: UriOwnerToken,
    documentVersion: number,
    renderGeneration: number
  ): boolean {
    return (
      this.canApplyRender(
        editor,
        ownerToken,
        documentVersion,
        true,
        renderGeneration
      ) &&
      blameConfiguration.isInlineEnabled() &&
      blameConfiguration.isInlineCurrentLineOnly()
    );
  }

  /**
   * Dispose provider - cleanup resources
   */
  public dispose(): void {
    this.isDisposed = true;
    this.documentChangeTimers.forEach(timer => clearTimeout(timer));
    this.documentChangeTimers.clear();
    this.cursorTimers.forEach(timer => clearTimeout(timer));
    this.cursorTimers.clear();
    this.repoRenderFlights.clear();
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
    this.messageScopeEpochs.clear();
    this.inFlightMessageFetches.clear(); // Owner guards suppress late applies
    this.inFlightAddRevisions.clear();
    this.uriOwners.clear();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.repoHooks.forEach(hooks => hooks.forEach(d => d.dispose()));
    this.repoHooks.clear();
    this.isActivated = false;
  }

  // ===== Event Handlers =====

  private async onActiveEditorChange(
    editor: TextEditor | undefined
  ): Promise<void> {
    if (!editor) {
      return;
    }

    this.cursorLines.set(editor, editor.selection.active.line);
    // Same-repo activations coalesce; different repositories run independently.
    await this.updateDecorations();
  }

  private onDocumentChange(event: { document: { uri: Uri } }): void {
    const key = event.document.uri.toString();
    const ownerToken = this.uriOwners.get(key);
    const pending = this.documentChangeTimers.get(key);
    if (pending) {
      clearTimeout(pending);
    }
    this.documentChangeTimers.set(
      key,
      setTimeout(() => {
        this.documentChangeTimers.delete(key);
        if (this.isDisposed || this.uriOwners.get(key) !== ownerToken) {
          return;
        }
        for (const editor of this.visibleEditors()) {
          if (editor.document.uri.toString() === key) {
            this.clearDecorations(editor);
          }
        }
      }, 500)
    );
  }

  private cancelDocumentChange(uri: Uri): void {
    const key = uri.toString();
    const pending = this.documentChangeTimers.get(key);
    if (pending) {
      clearTimeout(pending);
      this.documentChangeTimers.delete(key);
    }
  }

  private clearCursorState(uri: Uri): void {
    const key = uri.toString();
    for (const [editor, timer] of this.cursorTimers) {
      if (editor.document.uri.toString() === key) {
        clearTimeout(timer);
        this.cursorTimers.delete(editor);
        this.cursorLines.delete(editor);
      }
    }
  }

  private async onDocumentSave(document: { uri: Uri }): Promise<void> {
    this.cancelDocumentChange(document.uri);
    // Invalidate cache and refresh on save
    this.clearCache(document.uri);

    await this.renderVisibleEditors(this.visibleEditorsForUri(document.uri));
  }

  private onDocumentClose(document: { uri: Uri }): void {
    this.cancelDocumentChange(document.uri);
    this.clearCursorState(document.uri);
    // Clear cache on close
    this.clearCache(document.uri);
  }

  private onCursorPositionChange(event: { textEditor: TextEditor }): void {
    const editor = event.textEditor;
    const pending = this.cursorTimers.get(editor);
    if (pending) {
      clearTimeout(pending);
    }
    this.cursorTimers.set(
      editor,
      setTimeout(() => {
        this.cursorTimers.delete(editor);
        if (!this.isDisposed) {
          void this.applyCursorPositionChange(editor).catch(err => {
            logError("BlameProvider: Failed to update cursor decorations", err);
          });
        }
      }, 150)
    );
  }

  private async applyCursorPositionChange(editor: TextEditor): Promise<void> {
    if (!blameConfiguration.isInlineCurrentLineOnly()) {
      return; // Skip if not in current-line-only mode
    }

    const newLine = editor.selection.active.line;
    if (this.cursorLines.get(editor) === newLine) {
      return; // Skip if cursor still on same line
    }

    this.cursorLines.set(editor, newLine);
    await this.updateInlineDecorationsForCursor(editor);
  }

  /**
   * Drop the version-keyed provider cache after operations that change
   * BASE content (commit/update/revert/... plus switch/merge), then
   * refresh every affected visible editor so decorations reflect the new BASE.
   */
  private onRepositoryOperation(
    operation: Operation,
    repo: Repository,
    affectedExternalRoots: readonly string[] = [],
    externalImpact?: ExternalOperationImpact,
    externalTopologyIncomplete = false
  ): void {
    if (!BLAME_INVALIDATING_OPERATIONS.has(operation)) {
      return;
    }

    const directlyInvalidated = new Set<Repository>([
      repo,
      ...this.externalRepositoriesForOperation(
        affectedExternalRoots,
        externalImpact
      )
    ]);
    // An exhausted topology scan cannot prove which nested WC changed.
    // Conservatively cover only the operation's lexical scope; unrelated
    // workspace roots keep their hot caches.
    if (externalTopologyIncomplete) {
      const scopes = externalImpact?.targets?.length
        ? externalImpact.targets
        : [repo.workspaceRoot];
      for (const candidate of this.sourceControlManager.repositories ?? []) {
        let candidateRoot: string;
        try {
          candidateRoot = candidate.workspaceRoot;
        } catch {
          continue;
        }
        if (
          scopes.some(
            scope =>
              pathEquals(
                path.normalize(scope),
                path.normalize(candidateRoot)
              ) || isDescendant(scope, candidateRoot)
          )
        ) {
          directlyInvalidated.add(candidate);
        }
      }
    }
    const invalidated = new Set<Repository>();
    for (const affected of directlyInvalidated) {
      for (const peer of this.repositoriesSharingWorkingCopy(affected)) {
        invalidated.add(peer);
      }
    }
    const editors = this.visibleEditors().filter(editor => {
      const token = this.uriOwners.get(editor.document.uri.toString());
      const owner = this.repoFor(editor.document.uri);
      return (
        (owner !== undefined && invalidated.has(owner)) ||
        (token !== undefined && invalidated.has(token.repository))
      );
    });

    // Shared provider: a mutation in repo A must only drop repo A's files'
    // entries. Use PRECISE ownership (the deepest repo that owns each file),
    // not a lexical descendant test - else a parent-repo commit would also
    // clear a nested repo's still-valid caches.
    this.clearRepoScope(repo, key => this.cacheKeyBelongsToRepo(key, repo));

    for (const child of invalidated) {
      if (child === repo) {
        continue;
      }
      child.repository.clearBlameCache();
      this.clearRepoScope(child, key => this.cacheKeyBelongsToRepo(key, child));
    }

    for (const editor of editors) {
      this.clearDecorations(editor);
    }
    if (editors.length > 0) {
      void this.renderVisibleEditorsByRepository(editors);
    }
  }

  private repositoriesSharingWorkingCopy(repo: Repository): Set<Repository> {
    const peers = new Set<Repository>([repo]);
    let root: string;
    try {
      root = path.normalize(repo.root);
    } catch {
      return peers;
    }

    for (const candidate of this.sourceControlManager.repositories ?? []) {
      try {
        if (pathEquals(root, path.normalize(candidate.root))) {
          peers.add(candidate);
        }
      } catch {
        // Ignore incomplete repository stubs and disposed repositories.
      }
    }
    return peers;
  }

  private externalRepositoriesForOperation(
    roots: readonly string[],
    impact?: ExternalOperationImpact
  ): Set<Repository> {
    const affected = new Set<Repository>();
    for (const target of impact?.targets ?? []) {
      try {
        const owner = this.repoFor(Uri.file(target));
        if (owner) {
          affected.add(owner);
        }
      } catch {
        // Ignore malformed operation targets.
      }
    }
    const pending = [...roots];
    const seen = new Set<string>();

    while (pending.length > 0) {
      const root = path.normalize(pending.shift()!);
      const key = process.platform === "win32" ? root.toLowerCase() : root;
      if (seen.has(key)) continue;
      seen.add(key);

      for (const candidate of this.sourceControlManager.repositories ?? []) {
        let candidateRoot: string;
        try {
          candidateRoot = path.normalize(candidate.root);
        } catch {
          continue;
        }
        if (!pathEquals(root, candidateRoot) || affected.has(candidate)) {
          continue;
        }

        affected.add(candidate);
        for (const nestedRoot of candidate.externalWorkingCopyRoots ?? []) {
          if (this.externalRootAffected(nestedRoot, impact)) {
            pending.push(nestedRoot);
          }
        }
      }
    }

    return affected;
  }

  private externalRootAffected(
    root: string,
    impact?: ExternalOperationImpact
  ): boolean {
    if (!impact) return false;
    if (!impact.targets?.length) return impact.traverseExternals;
    return impact.targets.some(
      target =>
        isDescendant(root, target) ||
        (impact.traverseExternals && isDescendant(target, root))
    );
  }

  /** Resolve the owning repo for a cache key (a uri.toString()); undefined on
   *  an unparseable key or a path outside any open working copy. */
  private repoForKey(key: string): Repository | undefined {
    try {
      return this.repoFor(Uri.parse(key));
    } catch {
      return undefined;
    }
  }

  private cacheKeyBelongsToRepo(key: string, repo: Repository): boolean {
    return (
      this.uriOwners.get(key)?.repository === repo ||
      this.repoForKey(key) === repo
    );
  }

  /**
   * Drop every cache entry belonging to one repo. `ownsUri` decides which
   * uri-keyed entries belong to it (precise ownership for a live-repo op;
   * a descendant test on close, when the repo is already deregistered and
   * repoFor can no longer find it). Message-cache entries are keyed by
   * `revision@workspaceRoot`, so they clear by exact scope with no nesting
   * ambiguity.
   */
  private clearRepoScope(
    repo: Repository,
    ownsUri: (key: string) => boolean
  ): void {
    const keys = new Set<string>([
      ...this.blameCache.keys(),
      ...this.lineMappingCache.keys(),
      ...this.renderCache.keys(),
      ...this.addRevisionCache.keys(),
      ...this.peekPrefetchDone,
      ...this.uriOwners.keys()
    ]);
    for (const key of keys) {
      if (ownsUri(key)) {
        this.clearCache(Uri.parse(key));
      }
    }

    let root: string | undefined;
    try {
      root = repo.workspaceRoot;
    } catch {
      root = undefined;
    }
    if (root) {
      for (const key of [...this.messageCache.keys()]) {
        const at = key.indexOf("@");
        if (at >= 0 && key.slice(at + 1) === root) {
          this.messageCache.delete(key);
        }
      }
      this.messageScopeEpochs.delete(root);
    }
  }

  /**
   * A repository closed: drop its cached blame (otherwise stale authors/
   * revisions linger on the still-open file, and a checkout reopened at the
   * same path could read pre-close data) and clear decorations on the
   * editors it owned. The repo is already deregistered, so scope by
   * descendant path - repoFor can no longer resolve it.
   */
  private onRepositoryClosed(repo: Repository): void {
    let root: string | undefined;
    try {
      root = repo.workspaceRoot;
    } catch {
      root = undefined;
    }
    const owned = (uri: Uri) => {
      if (!root) return false;
      try {
        if (!isDescendant(root, uri.fsPath)) {
          return false;
        }
        const token = this.uriOwners.get(uri.toString());
        if (token) {
          return token.repository === repo;
        }
        const survivingOwner = this.repoFor(uri);
        return !(
          survivingOwner &&
          survivingOwner !== repo &&
          isDescendant(root, survivingOwner.workspaceRoot)
        );
      } catch {
        return false;
      }
    };
    const visibleOwnership = this.visibleEditors().map(editor => ({
      editor,
      owned: owned(editor.document.uri)
    }));
    this.clearRepoScope(repo, key => {
      try {
        return owned(Uri.parse(key));
      } catch {
        return false;
      }
    });
    // Shared decoration types can't be disposed (other repos use them), so
    // clear per editor the closed repo owned.
    const rerender: TextEditor[] = [];
    for (const entry of visibleOwnership) {
      if (entry.owned) {
        this.clearDecorations(entry.editor);
        if (this.repoFor(entry.editor.document.uri)) {
          rerender.push(entry.editor);
        }
      }
    }
    if (rerender.length > 0) {
      void this.renderVisibleEditorsByRepository(rerender);
    }
  }

  private async onBlameStateChange(uri: Uri | undefined): Promise<void> {
    const editors = this.visibleEditorsForUri(uri);
    for (const editor of editors) {
      if (this.isEditorLive(editor)) {
        this.clearDecorations(editor);
      }
    }
    await this.renderVisibleEditorsByRepository(editors);
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
    const editors = [...this.visibleEditors()];
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
      for (const editor of editors) {
        if (this.isEditorLive(editor)) {
          this.clearDecorations(editor);
        }
      }
      await this.renderVisibleEditorsByRepository(editors);
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
    for (const editor of editors) {
      if (!this.isEditorLive(editor)) {
        continue;
      }
      editor.setDecorations(oldTypes.gutter, []);
      editor.setDecorations(oldTypes.icon, []);
      editor.setDecorations(oldTypes.inline, []);
      oldIconTypes.forEach(type => {
        editor.setDecorations(type, []);
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
    await this.renderVisibleEditorsByRepository(editors);
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
    editor: TextEditor,
    owner?: Repository,
    ownerToken?: UriOwnerToken
  ): Promise<ISvnBlameLine[] | undefined> {
    const key = uri.toString();

    // Document version (changes on every edit/reload) from the editor that
    // triggered the lookup - NOT window.activeTextEditor, which pinned
    // non-active visible editors to version -1 (a permanent cache miss).
    const currentVersion =
      editor.document.uri.toString() === key ? editor.document.version : -1;

    // Reuse the caller's already-resolved repo when given (the cache-hit path
    // above never resolves), else resolve it now.
    const repository = owner ?? this.repoFor(uri);
    if (!repository) {
      return undefined;
    }
    const token = ownerToken ?? this.claimOwner(uri, repository);
    if (!this.isCurrentOwner(token)) {
      return undefined;
    }

    // Check cache - validate version to detect external changes (svn update, etc.)
    const cached = this.blameCache.get(key);
    if (cached && cached.version === currentVersion && currentVersion !== -1) {
      this.cacheAccessOrder.set(key, ++this.cacheAccessCounter);
      return cached.data;
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

      if (
        !this.isCurrentOwner(token) ||
        editor.document.version !== currentVersion
      ) {
        return undefined;
      }
      this.blameCache.set(key, { data, version: currentVersion });
      this.cacheAccessOrder.set(key, ++this.cacheAccessCounter);
      this.evictOldestCache();
      return data;
    } catch (err) {
      if (!this.isCurrentOwner(token)) {
        return undefined;
      }
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
    editor: TextEditor,
    owner?: Repository,
    ownerToken?: UriOwnerToken
  ): Promise<LineMapping | undefined> {
    const key = uri.toString();
    const currentVersion = editor.document.version;

    // Check if file is modified (reuse the caller's resolved repo if given)
    const repository = owner ?? this.repoFor(uri);
    if (!repository) {
      return undefined;
    }
    const token = ownerToken ?? this.claimOwner(uri, repository);
    if (!this.isCurrentOwner(token)) {
      return undefined;
    }
    const cached = this.lineMappingCache.get(key);
    if (cached && cached.version === currentVersion) {
      return cached.mapping;
    }
    const resource = repository?.getResourceFromFile(uri);
    if (!resource || resource.type !== Status.MODIFIED) {
      // File not modified (or no repo) - no mapping needed (identity mapping)
      return undefined;
    }

    try {
      // Get BASE content (committed version)
      const baseContent = await repository.repository.show(uri.fsPath, "BASE");
      if (
        !this.isCurrentOwner(token) ||
        editor.document.version !== currentVersion
      ) {
        return undefined;
      }
      const baseLines = baseContent.split(/\r?\n/);

      // Get working copy content (current editor)
      const workingContent = editor.document.getText();
      const workingLines = workingContent.split(/\r?\n/);

      // Compute mapping
      const mapping = computeLineMapping(baseLines, workingLines);

      if (!this.isCurrentOwner(token)) {
        return undefined;
      }
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
    options: {
      skipMessagePrefetch?: boolean;
      lineMapping?: LineMapping;
      ownerToken?: UriOwnerToken;
    } = {}
  ): Promise<{
    gutter: DecorationOptions[];
    icon: DecorationOptions[];
    inline: DecorationOptions[];
  }> {
    const gutterDecorations: DecorationOptions[] = [];
    const inlineDecorations: DecorationOptions[] = [];

    const template = blameConfiguration.getGutterTemplate();
    const dateFormat = blameConfiguration.getDateFormat();
    const { lineMapping, ownerToken } = options;

    // Hoist config reads + color-string allocation out of the per-line loop.
    // For a 1000-line file these were ~6000 redundant config reads and
    // 1000 redundant rgba(...) string allocations per blame render.
    const gutterEnabled = blameConfiguration.isGutterEnabled();
    const gutterTextEnabled = blameConfiguration.isGutterTextEnabled();
    const showGutterText = gutterEnabled && gutterTextEnabled;
    const inlineEnabled = blameConfiguration.isInlineEnabled();
    const inlineCurrentLineOnly = blameConfiguration.isInlineCurrentLineOnly();
    const showInlineMessage = blameConfiguration.shouldShowInlineMessage();
    const fetchInlineMessage =
      showInlineMessage && blameConfiguration.isLogsEnabled();
    // On the progressive path the inline array is discarded and rebuilt in
    // Phase 2 (with batched messages), so building it here - one svn log per
    // line when messages are on - is pure waste. Only skip when messages are
    // on; without messages this call's inline output IS the one applied.
    const buildInline =
      inlineEnabled && !(options.skipMessagePrefetch && fetchInlineMessage);
    const inlineColor = `rgba(127, 127, 127, ${blameConfiguration.getInlineOpacity()})`;
    const activeLine = editor.selection.active.line;
    const scope = this.messageScope(editor.document.uri);

    // Prefetch messages if inline enabled (unless skipped for progressive rendering)
    if (!options.skipMessagePrefetch && inlineEnabled && fetchInlineMessage) {
      const uniqueRevisions = [
        ...new Set(blameData.map(b => b.revision).filter(Boolean))
      ] as string[];

      if (uniqueRevisions.length > 0 && uniqueRevisions.length <= 100) {
        await this.prefetchMessages(
          uniqueRevisions,
          editor.document.uri,
          ownerToken
        );
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
          const message = fetchInlineMessage
            ? await this.getCommitMessage(
                blameLine.revision,
                editor.document.uri,
                ownerToken
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
  private async getCommitMessage(
    revision: string,
    uri?: Uri,
    ownerToken?: UriOwnerToken
  ): Promise<string> {
    if (!blameConfiguration.isLogsEnabled()) {
      return "";
    }

    const repository =
      ownerToken?.repository ??
      (uri
        ? this.repoFor(uri)
        : (this.sourceControlManager.repositories?.[0] as
            | Repository
            | undefined));
    if (!repository) {
      return "";
    }
    const target = uri ?? Uri.file(repository.workspaceRoot);
    const token = ownerToken ?? this.claimOwner(target, repository);
    if (!this.isCurrentOwner(token)) {
      return "";
    }
    const scope = repository.workspaceRoot;
    const cached = this.readMessage(scope, revision);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const log = await repository.log(revision, revision, 1);
      if (!this.isCurrentOwner(token)) {
        return "";
      }
      const message = log[0]?.msg || "";
      this.writeMessage(scope, revision, message);

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
    target?: Uri,
    ownerToken?: UriOwnerToken
  ): Promise<void> {
    if (!blameConfiguration.isLogsEnabled()) {
      return;
    }

    // The batch log must be targeted at the blamed file's repo; without a
    // resolvable target there's nothing to query.
    const repository =
      ownerToken?.repository ?? (target ? this.repoFor(target) : undefined);
    if (!repository || !target) {
      return;
    }
    const token = ownerToken ?? this.claimOwner(target, repository);
    if (!this.isCurrentOwner(token)) {
      return;
    }
    const scope = repository.workspaceRoot;

    const uncached = revisions.filter(
      r => this.readMessage(scope, r) === undefined
    );

    if (uncached.length === 0) {
      return;
    }

    try {
      // Batch fetch: single SVN command for all revisions, targeted at the
      // blamed file so the server filters to its history. Without a target
      // this spanned every revision in the checkout between min and max.
      const logEntries = await repository.logBatch(uncached, target.fsPath);
      if (!this.isCurrentOwner(token)) {
        return;
      }

      // Cache all fetched messages
      for (const entry of logEntries) {
        if (entry.revision && entry.msg !== undefined) {
          this.writeMessage(scope, entry.revision, entry.msg);
        }
      }

      // Evict message cache if exceeding limit
      this.evictMessageCache();
    } catch (err) {
      if (!this.isCurrentOwner(token)) {
        return;
      }
      logError(
        "BlameProvider: Batch message fetch failed, falling back to sequential",
        err
      );

      // Fallback to sequential fetching on error (untargeted - see
      // getCommitMessage; the targeted range log may have failed because
      // of the target)
      for (const revision of uncached) {
        await this.getCommitMessage(revision, target, token);
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
