// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import {
  commands,
  Disposable,
  Position,
  Range,
  SourceControlResourceState,
  TextDocumentShowOptions,
  TextEditor,
  Uri,
  ViewColumn,
  window,
  workspace,
  WorkspaceEdit
} from "vscode";
import {
  ICommandOptions,
  PropStatus,
  Status,
  SvnUriAction,
  LineChange
} from "../common/types";
import { exists, readFile, stat, unlink } from "../fs";
import { configuration } from "../helpers/configuration";
import { fetchSourceControlManager } from "../helpers/sourceControlManager";
import { inputIgnoreList } from "../ignoreitems";
import { applyLineChanges } from "../lineChanges";
import { SourceControlManager } from "../source_control_manager";
import { Repository } from "../repository";
import { Resource } from "../resource";
import { fromSvnUri, toSvnUri } from "../uri";
import { getSvnDir } from "../util";
import { getErrorMessage, logError, logWarning } from "../util/errorLogger";
import { STAGING_CHANGELIST } from "../services/stagingService";
import { FORMAT_CODE_MESSAGES } from "./errorPatterns";
import {
  getLockErrorTypeFromFullError,
  hasFormatConnectionErrorFromFullError,
  hasFormatTimeoutErrorFromFullError,
  needsAuthActionFromFullError,
  needsCleanupFromFullError,
  needsConflictResolutionFromFullError,
  needsNetworkRetryFromFullError,
  needsOutputActionFromFullError,
  needsUpdateFromFullError
} from "./errorDetectors";
import {
  buildErrorContext,
  extractErrorCode,
  type ErrorContext
} from "./errorUtils";

/**
 * Type-safe command argument patterns used across all commands.
 * Commands can accept various combinations of these argument types.
 */
export type CommandArgs =
  // Repository commands (e.g., refresh, update)
  | [Repository]
  // Resource state commands (e.g., commit, revert)
  | SourceControlResourceState[]
  // URI-based commands
  | [Uri]
  | [Uri, LineChange[], number] // revertChange
  // Resource/URI with optional states
  | [Resource | Uri | undefined, ...SourceControlResourceState[]]
  // Other variadic patterns
  | unknown[];

/**
 * Return type for command execution. Most commands return void or Promise<void>,
 * but some may return specific values.
 */
export type CommandResult = void | Promise<void> | Promise<unknown>;

export abstract class Command implements Disposable {
  // Phase 10.2 perf fix - cache SourceControlManager to avoid IPC overhead
  private static _sourceControlManager?: SourceControlManager;

  static setSourceControlManager(scm: SourceControlManager) {
    Command._sourceControlManager = scm;
  }

  private _disposable?: Disposable;

  constructor(commandName: string, options: ICommandOptions = {}) {
    if (options.repository) {
      const command = this.createRepositoryCommand(this.execute);

      this._disposable = commands.registerCommand(commandName, command);

      return;
    }

    this._disposable = commands.registerCommand(
      commandName,
      (...args: unknown[]) => this.execute(...args)
    );
  }

  public abstract execute(...args: unknown[]): CommandResult;

  public dispose() {
    this._disposable?.dispose();
  }

  protected async getSourceControlManager(): Promise<SourceControlManager> {
    return Command._sourceControlManager || (await fetchSourceControlManager());
  }

  private createRepositoryCommand(
    method: (...args: unknown[]) => CommandResult
  ): (...args: unknown[]) => Promise<unknown> {
    const result = async (...args: unknown[]) => {
      const sourceControlManager = await this.getSourceControlManager();
      const repository = sourceControlManager.getRepository(args[0]);
      let repositoryPromise: Promise<Repository | undefined>;

      if (repository) {
        repositoryPromise = Promise.resolve(repository);
      } else if (sourceControlManager.repositories.length === 1) {
        repositoryPromise = Promise.resolve(
          sourceControlManager.repositories[0]!
        );
      } else {
        repositoryPromise = sourceControlManager.pickRepository();
      }

      const result = repositoryPromise.then(repository => {
        if (!repository) {
          return Promise.resolve();
        }

        return Promise.resolve(method.apply(this, [repository, ...args]));
      });

      return result.catch(err => {
        logError("Command execution failed", err);
      });
    };

    return result;
  }

  protected async getResourceStates(
    resourceStates: SourceControlResourceState[]
  ): Promise<Resource[]> {
    resourceStates = resourceStates.filter(
      (state): state is SourceControlResourceState => !!state
    );

    if (
      resourceStates.length === 0 ||
      !(resourceStates[0]!.resourceUri instanceof Uri)
    ) {
      const resource = await this.getSCMResource();

      if (!resource) {
        return [];
      }

      resourceStates = [resource];
    }

    return this.filterResources(resourceStates);
  }

  /**
   * Get resource states or return null if empty (Phase 13.2).
   * Replaces pattern: `if (selection.length === 0) return;`
   */
  protected async getResourceStatesOrExit(
    resourceStates: SourceControlResourceState[]
  ): Promise<Resource[] | null> {
    const selection = await this.getResourceStates(resourceStates);
    return selection.length === 0 ? null : selection;
  }

  /**
   * Resolve selected resource URIs or return null when selection is empty.
   */
  protected async getResourceUrisOrExit(
    resourceStates: SourceControlResourceState[]
  ): Promise<Uri[] | null> {
    const selection = await this.getResourceStatesOrExit(resourceStates);
    return selection ? this.toUris(selection) : null;
  }

  /**
   * Resolve selected resource URIs and execute callback when selection exists.
   * Returns false when there is no selection.
   */
  protected async withSelectedResourceUris(
    resourceStates: SourceControlResourceState[],
    fn: (uris: Uri[]) => Promise<void>
  ): Promise<boolean> {
    const uris = await this.getResourceUrisOrExit(resourceStates);
    if (!uris) {
      return false;
    }

    await fn(uris);
    return true;
  }

  /**
   * Check whether command args contain an explicit SCM resource selection.
   * Used by *All commands to distinguish context-menu selection from group-header actions.
   */
  protected hasExplicitResourceSelection(
    resourceStates: SourceControlResourceState[]
  ): boolean {
    return resourceStates.length > 0 && resourceStates[0] instanceof Resource;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DRY Helpers - Reduce common patterns in commands
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Filter resource states to only Resource instances.
   * Replaces: `.filter(s => s instanceof Resource) as Resource[]`
   */
  protected filterResources(states: SourceControlResourceState[]): Resource[] {
    return states.filter((s): s is Resource => s instanceof Resource);
  }

  /**
   * Extract URIs from resources.
   * Replaces: `.map(resource => resource.resourceUri)`
   */
  protected toUris(resources: Resource[]): Uri[] {
    return resources.map(r => r.resourceUri);
  }

  /**
   * Filter resource states to Resource instances and extract their URIs.
   */
  protected resourceStatesToUris(states: SourceControlResourceState[]): Uri[] {
    return this.toUris(this.filterResources(states));
  }

  /**
   * Extract URI from common command argument shapes.
   * Supports Uri, Resource, and SourceControlResourceState-like objects.
   */
  protected extractUri(arg: unknown): Uri | undefined {
    if (arg instanceof Uri) {
      return arg;
    }
    if (arg instanceof Resource) {
      return arg.resourceUri;
    }
    if (arg && typeof arg === "object" && "resourceUri" in arg) {
      const maybeUri = (arg as { resourceUri?: unknown }).resourceUri;
      return maybeUri instanceof Uri ? maybeUri : undefined;
    }

    return undefined;
  }

  /**
   * Extract file system paths from URIs.
   * Replaces: `.map(uri => uri.fsPath)`
   */
  protected toPaths(uris: Uri[]): string[] {
    return uris.map(u => u.fsPath);
  }

  /**
   * Convert resources directly to paths (combines toUris + toPaths).
   * Replaces: `.map(r => r.resourceUri).map(u => u.fsPath)`
   */
  protected resourcesToPaths(resources: Resource[]): string[] {
    return resources.map(r => r.resourceUri.fsPath);
  }

  /**
   * Extract URIs from command args (Explorer context menu multi-select).
   * Returns null if args are not URI-based (e.g., SCM resource states).
   * Pattern: args[0] = clicked item, args[1] = all selected items (multi-select)
   */
  protected extractUris(args: unknown[]): Uri[] | null {
    if (args.length > 0 && args[0] instanceof Uri) {
      return Array.isArray(args[1])
        ? (args[1] as Uri[]).filter((a): a is Uri => a instanceof Uri)
        : [args[0]];
    }
    return null;
  }

  /**
   * Run operation for all resources in a group across all repositories.
   * Replaces: runForAllChanges/runForAllStaged patterns
   */
  protected async runForAllInGroup(
    group: "changes" | "staged",
    fn: (repository: Repository, paths: string[]) => Promise<void>
  ): Promise<void> {
    const sourceControlManager = await this.getSourceControlManager();

    for (const repository of sourceControlManager.repositories) {
      const resources = repository[group].resourceStates;
      const paths = this.resourcesToPaths(this.filterResources(resources));
      if (paths.length > 0) {
        await fn(repository, paths);
      }
    }
  }

  protected runByRepository<T>(
    resource: Uri,
    fn: (repository: Repository, resource: Uri) => Promise<T>
  ): Promise<T[]>;
  protected runByRepository<T>(
    resources: Uri[],
    fn: (repository: Repository, resources: Uri[]) => Promise<T>
  ): Promise<T[]>;
  protected async runByRepository<T>(
    arg: Uri | Uri[],
    fn:
      | ((repository: Repository, resource: Uri) => Promise<T>)
      | ((repository: Repository, resources: Uri[]) => Promise<T>)
  ): Promise<T[]> {
    const resources = arg instanceof Uri ? [arg] : arg;
    const isSingleResource = arg instanceof Uri;

    const sourceControlManager = await this.getSourceControlManager();

    const groups: Array<{ repository: Repository; resources: Uri[] }> = [];

    for (const resource of resources) {
      const repository = sourceControlManager.getRepository(resource);

      if (!repository) {
        logWarning("Could not find Svn repository for resource");
        continue;
      }

      const tuple = groups.find(p => p.repository === repository);

      if (tuple) {
        tuple.resources.push(resource);
      } else {
        groups.push({ repository, resources: [resource] });
      }
    }

    const promises = groups.map(({ repository, resources }) => {
      if (isSingleResource) {
        return (fn as (repository: Repository, resource: Uri) => Promise<T>)(
          repository,
          resources[0]!
        );
      }
      return (fn as (repository: Repository, resources: Uri[]) => Promise<T>)(
        repository,
        resources
      );
    });

    return Promise.all(promises);
  }

  /**
   * Run operation grouped by repository with path arrays.
   * Replaces callbacks that immediately call `toPaths(resources)`.
   */
  protected async runByRepositoryPaths(
    uris: Uri[],
    fn: (repository: Repository, paths: string[]) => Promise<void>
  ): Promise<void> {
    await this.runByRepository(uris, async (repository, resources) =>
      fn(repository, this.toPaths(resources))
    );
  }

  /**
   * Run operation grouped by repository using an existing resource selection.
   */
  protected async runBySelectionPaths(
    selection: Resource[],
    fn: (repository: Repository, paths: string[]) => Promise<void>
  ): Promise<void> {
    await this.runByRepositoryPaths(this.toUris(selection), fn);
  }

  protected async getSCMResource(uri?: Uri): Promise<Resource | undefined> {
    uri = uri
      ? uri
      : window.activeTextEditor && window.activeTextEditor.document.uri;

    if (!uri) {
      return undefined;
    }

    if (uri.scheme === "svn") {
      const { fsPath } = fromSvnUri(uri);
      uri = Uri.file(fsPath);
    }

    if (uri.scheme === "file") {
      const sourceControlManager = await this.getSourceControlManager();
      const repository = sourceControlManager.getRepository(uri);

      if (!repository) {
        return undefined;
      }

      return repository.getResourceFromFile(uri);
    }

    // Unsupported URI scheme (e.g., untitled, output)
    return undefined;
  }

  protected async resolveResourceFromArg(
    arg?: Resource | Uri
  ): Promise<Resource | undefined> {
    if (arg instanceof Resource) {
      return arg;
    }
    if (arg instanceof Uri) {
      return this.getSCMResource(arg);
    }

    return this.getSCMResource();
  }

  protected async _openResource(
    resource: Resource,
    against?: string,
    preview?: boolean,
    preserveFocus?: boolean,
    preserveSelection?: boolean
  ): Promise<void> {
    // Property-only changes (status=NORMAL, props!=NONE) - show patch
    // VS Code diff can't show property changes, so show the SVN patch instead
    if (
      resource.type === Status.NORMAL &&
      resource.props &&
      resource.props !== PropStatus.NONE
    ) {
      const scm = Command._sourceControlManager;
      if (scm) {
        const repository = scm.getRepository(resource.resourceUri);
        if (repository) {
          const content = await repository.patch([resource.resourceUri.fsPath]);
          await this.showDiffPath(repository, content);
          return;
        }
      }
      // Fallback if can't get repository
      window.showInformationMessage(
        `Only SVN properties changed. Use 'svn diff' to see property changes.`
      );
      return;
    }

    let left = await this.getLeftResource(resource, against);
    let right = this.getRightResource(resource, against);
    const title = this.getTitle(resource, against);

    if (resource.remote && left) {
      [left, right] = [right, left];
    }

    if (!right) {
      window.showErrorMessage("Unable to open resource: file not found");
      return;
    }

    if (
      (await exists(right.fsPath)) &&
      (await stat(right.fsPath)).isDirectory()
    ) {
      return;
    }

    const opts: TextDocumentShowOptions = {
      preserveFocus,
      preview,
      viewColumn: ViewColumn.Active
    };

    const activeTextEditor = window.activeTextEditor;

    if (
      preserveSelection &&
      activeTextEditor &&
      activeTextEditor.document.uri.toString() === right.toString()
    ) {
      opts.selection = activeTextEditor.selection;
    }

    if (!left) {
      return commands.executeCommand<void>("vscode.open", right, opts);
    }

    // Gate runs only when there's actually a BASE side to fetch — otherwise
    // there's no svn cat to skip and the "diff may be slow" prompt is bogus.
    const shouldSkipDiff = await this.checkCsvDiffGate(
      left,
      right,
      title,
      opts
    );
    if (shouldSkipDiff) {
      return commands.executeCommand<void>("vscode.open", right, opts);
    }

    return commands.executeCommand<void>(
      "vscode.diff",
      left,
      right,
      title,
      opts
    );
  }

  /**
   * Aggressive size gate for CSV-like diffs. Returns true when the caller
   * should skip the diff and open the file directly.
   *
   * For over-limit CSVs we fire a non-blocking info toast offering
   * "Open Diff Anyway"; clicking it triggers `vscode.diff` retroactively.
   * The default (no click / toast dismissed) keeps the user in the file —
   * fast workflow, no modal interrupt.
   */
  private async checkCsvDiffGate(
    left: Uri,
    right: Uri,
    title: string,
    opts: TextDocumentShowOptions
  ): Promise<boolean> {
    if (right.scheme !== "file" || !configuration.isCsvLikeDiff(right)) {
      return false;
    }
    const limitMB = configuration.diffCsvSizeLimitMB();
    const limitBytes = limitMB * 1024 * 1024;
    let size: number;
    try {
      size = (await stat(right.fsPath)).size;
    } catch {
      return false; // missing or unreadable → don't block the user
    }
    if (size <= limitBytes) {
      return false;
    }
    const sizeMB = (size / (1024 * 1024)).toFixed(1);
    // Fire-and-forget: don't await the toast. User's workflow continues.
    void window
      .showInformationMessage(
        `CSV diff skipped (${sizeMB} MB > ${limitMB} MB). ` +
          `Adjust 'sven.diff.csvSizeLimitMB' to change.`,
        "Open Diff Anyway"
      )
      .then(choice => {
        if (choice === "Open Diff Anyway") {
          void commands.executeCommand<void>(
            "vscode.diff",
            left,
            right,
            title,
            opts
          );
        }
      });
    return true;
  }

  protected async getLeftResource(
    resource: Resource,
    against: string = ""
  ): Promise<Uri | undefined> {
    if (resource.remote) {
      if (resource.type !== Status.DELETED) {
        return toSvnUri(resource.resourceUri, SvnUriAction.SHOW, {
          ref: against
        });
      }
      return;
    }

    if (resource.type === Status.ADDED && resource.renameResourceUri) {
      return toSvnUri(resource.renameResourceUri, SvnUriAction.SHOW, {
        ref: against
      });
    }

    // Show file if has conflicts marks
    if (
      resource.type === Status.CONFLICTED &&
      (await exists(resource.resourceUri.fsPath))
    ) {
      const text = (await readFile(resource.resourceUri.fsPath, {
        encoding: "utf8"
      })) as string;

      // Check for lines begin with "<<<<<<", "=======", ">>>>>>>"
      if (/^<{7}[^]+^={7}[^]+^>{7}/m.test(text)) {
        return undefined;
      }
    }

    switch (resource.type) {
      case Status.CONFLICTED:
      case Status.MODIFIED:
      case Status.REPLACED:
        return toSvnUri(resource.resourceUri, SvnUriAction.SHOW, {
          ref: against
        });
    }

    return;
  }

  protected getRightResource(
    resource: Resource,
    against: string = ""
  ): Uri | undefined {
    if (resource.remote) {
      if (resource.type !== Status.ADDED) {
        return resource.resourceUri;
      }
      return;
    }
    switch (resource.type) {
      case Status.ADDED:
      case Status.CONFLICTED:
      case Status.IGNORED:
      case Status.MODIFIED:
      case Status.UNVERSIONED:
      case Status.REPLACED:
      case Status.NORMAL: // Property-only changes have status=NORMAL
        return resource.resourceUri;
      case Status.DELETED:
      case Status.MISSING:
        return toSvnUri(resource.resourceUri, SvnUriAction.SHOW, {
          ref: against
        });
    }

    return;
  }

  private getTitle(resource: Resource, against?: string): string {
    if (resource.type === Status.ADDED && resource.renameResourceUri) {
      const basename = path.basename(resource.renameResourceUri.fsPath);

      const newname = path.relative(
        path.dirname(resource.renameResourceUri.fsPath),
        resource.resourceUri.fsPath
      );
      if (against) {
        return `${basename} -> ${newname} (${against})`;
      }
      return `${basename} -> ${newname}`;
    }
    const basename = path.basename(resource.resourceUri.fsPath);

    if (against) {
      return `${basename} (${against})`;
    }

    return "";
  }

  protected async openChange(
    arg?: Resource | Uri,
    against?: string,
    resourceStates?: SourceControlResourceState[]
  ): Promise<void> {
    const preserveFocus = arg instanceof Resource;
    const preserveSelection = arg instanceof Uri || !arg;
    let resources: Resource[] | undefined;

    const resource = await this.resolveResourceFromArg(arg);
    if (resource) {
      resources =
        arg instanceof Uri
          ? [resource]
          : [...(resourceStates as Resource[]), resource];
    }

    if (!resources) {
      return;
    }

    const preview = resources.length === 1 ? undefined : false;
    for (const resource of resources) {
      await this._openResource(
        resource,
        against,
        preview,
        preserveFocus,
        preserveSelection
      );
    }
  }

  protected async showDiffPath(repository: Repository, content: string) {
    try {
      const tempFile = path.join(
        repository.root,
        getSvnDir(),
        "tmp",
        "sven.patch"
      );

      if (await exists(tempFile)) {
        try {
          await unlink(tempFile);
        } catch (err) {
          logError(`Failed to unlink temp file ${tempFile}`, err);
        }
      }

      const uri = Uri.file(tempFile).with({
        scheme: "untitled"
      });

      const document = await workspace.openTextDocument(uri);
      const textEditor = await window.showTextDocument(document);

      await textEditor.edit(e => {
        // if is opened, clear content
        e.delete(
          new Range(
            new Position(0, 0),
            new Position(Number.MAX_SAFE_INTEGER, 0)
          )
        );
        e.insert(new Position(0, 0), content);
      });
    } catch (error) {
      logError("Patch operation failed", error);
      window.showErrorMessage("Unable to patch");
    }
  }

  protected async _revertChanges(
    textEditor: TextEditor,
    changes: LineChange[]
  ): Promise<void> {
    const modifiedDocument = textEditor.document;
    const modifiedUri = modifiedDocument.uri;

    if (modifiedUri.scheme !== "file") {
      return;
    }

    const originalUri = toSvnUri(modifiedUri, SvnUriAction.SHOW, {
      ref: "BASE"
    });
    const originalDocument = await workspace.openTextDocument(originalUri);

    const result = applyLineChanges(
      originalDocument,
      modifiedDocument,
      changes
    );
    const edit = new WorkspaceEdit();
    edit.replace(
      modifiedUri,
      new Range(
        new Position(0, 0),
        modifiedDocument.lineAt(modifiedDocument.lineCount - 1).range.end
      ),
      result
    );
    workspace.applyEdit(edit);
    await modifiedDocument.save();
  }

  protected async addToIgnore(uris: Uri[]): Promise<void> {
    await this.runByRepository(uris, async (repository, resources) => {
      try {
        const ignored = await inputIgnoreList(repository, resources);

        if (ignored) {
          window.showInformationMessage(
            "svn:ignore set on parent folder - file(s) will be ignored"
          );
        }
      } catch (error) {
        logError("Property ignore operation failed", error);
        window.showErrorMessage("Unable to set property ignore");
      }
    });
  }

  /**
   * Execute operation on resource states grouped by repository.
   * Pattern: getResourceStates → map → runByRepository → error handling
   */
  protected async executeOnResources(
    resourceStates: SourceControlResourceState[],
    operation: (repository: Repository, paths: string[]) => Promise<void>,
    errorMsg: string
  ): Promise<void> {
    const uris = await this.getResourceUrisOrExit(resourceStates);
    if (!uris) {
      return;
    }

    await this.runByRepositoryPaths(uris, async (repository, paths) => {
      try {
        await operation(repository, paths);
      } catch (error) {
        await this.handleOperationError(error, errorMsg);
      }
    });
  }

  /**
   * Execute operation on URIs or resource states (unified handler).
   * Handles both Explorer context menu (URIs) and SCM view (resource states).
   * Returns true if executed, false if cancelled/empty.
   */
  protected async executeOnUrisOrResources(
    args: unknown[],
    operation: (repository: Repository, paths: string[]) => Promise<void>,
    errorMsg: string
  ): Promise<boolean> {
    // Try URI path first (Explorer context menu)
    const uris = this.extractUris(args);
    if (uris) {
      await this.runByRepositoryPaths(uris, async (repository, paths) => {
        try {
          await operation(repository, paths);
        } catch (error) {
          await this.handleOperationError(error, errorMsg);
        }
      });
      return true;
    }

    // Fall back to resource states (SCM view)
    const selection = await this.getResourceStatesOrExit(
      args as SourceControlResourceState[]
    );
    if (!selection) return false;

    await this.executeOnResources(selection, operation, errorMsg);
    return true;
  }

  /**
   * Sanitize stderr to prevent information disclosure.
   * Strips file paths, credentials, and internal URLs.
   * WARNING: When debug.disableSanitization enabled, returns raw stderr
   */
  private sanitizeStderr(stderr: string): string {
    if (!stderr) {
      return "";
    }

    // ⚠️ DEBUG MODE: Return raw stderr when sanitization disabled
    if (configuration.get<boolean>("debug.disableSanitization", false)) {
      return stderr;
    }

    return (
      stderr
        // Sanitize URLs first (preserve protocol/domain, strip credentials)
        .replace(/https?:\/\/[^:@\s]+:[^@\s]+@/g, "https://[CREDENTIALS]@")
        // Strip absolute file paths (Unix and Windows)
        // Avoid matching URLs by requiring start/whitespace and no double slash.
        .replace(/(^|\s)\/(?!\/)[^\s:]+/g, "$1[PATH]")
        .replace(/[A-Za-z]:\\[^\s:]+/g, "[PATH]")
        // Remove password parameters (handles quoted values with spaces)
        .replace(
          /password[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
          "password=[REDACTED]"
        )
        .replace(
          /--password\s+(?:"[^"]*"|'[^']*'|\S+)/gi,
          "--password [REDACTED]"
        )
        // Remove username parameters (handles quoted values with spaces)
        .replace(
          /username[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
          "username=[REDACTED]"
        )
        .replace(
          /--username\s+(?:"[^"]*"|'[^']*'|\S+)/gi,
          "--username [REDACTED]"
        )
        // Strip internal IP addresses
        .replace(
          /\b(?:10|127|172\.(?:1[6-9]|2[0-9]|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g,
          "[INTERNAL_IP]"
        )
    );
  }

  /**
   * Format user-friendly error message based on error type.
   * Includes error code for transparency (e.g., "Message (E155004)").
   * Provides actionable guidance for common errors.
   *
   * Takes a pre-built `ErrorContext` so call sites that also need to route
   * on the same context (lock/cleanup/update/network detection) build it
   * once and share — sanitizeStderr in `getErrorContext` runs 13 regex
   * passes so duplicating is wasteful.
   */
  private formatErrorMessageFromContext(
    context: ErrorContext,
    fallbackMsg: string
  ): string {
    const fullError = context.fullErrorSanitized;
    const code = extractErrorCode(context.rawCombined);

    // Authentication errors - check FIRST (priority over network errors)
    // SVN may return E170013 with E215004 when auth fails
    if (needsAuthActionFromFullError(fullError)) {
      const c = fullError.includes("e215004") ? "E215004" : "E170001";
      return `Authentication failed (${c}). Check credentials and try again.`;
    }

    // Network/connection errors (E170013)
    if (hasFormatConnectionErrorFromFullError(fullError)) {
      return "Unable to connect (E170013). Check network and repository URL.";
    }

    // Timeout errors (E175002)
    if (hasFormatTimeoutErrorFromFullError(fullError)) {
      return "Network timeout (E175002). Try again or check network connection.";
    }

    // Out-of-date errors (E155019, E200042)
    if (needsUpdateFromFullError(fullError)) {
      const c = fullError.includes("e200042") ? "E200042" : "E155019";
      return `Working copy not up-to-date (${c}). Update before committing.`;
    }

    // Conflict errors (E155015, E155023, E200024)
    if (needsConflictResolutionFromFullError(fullError)) {
      const c = fullError.includes("e200024")
        ? "E200024"
        : fullError.includes("e155015")
          ? "E155015"
          : "E155023";
      return `Conflict blocking operation (${c}). Resolve conflicts first.`;
    }

    for (const { token, message } of FORMAT_CODE_MESSAGES) {
      if (fullError.includes(token)) {
        return message;
      }
    }

    // Working copy needs cleanup (E155004, E155037, E200030, E155032, E200033, etc.)
    if (needsCleanupFromFullError(fullError)) {
      const c = code || "E155004";
      return `Working copy needs cleanup (${c}). Run cleanup to fix.`;
    }

    // Use fallback message for other errors (append code if found)
    return code ? `${fallbackMsg} (${code})` : fallbackMsg;
  }

  private getErrorContext(error: unknown): ErrorContext {
    return buildErrorContext(error, stderr => this.sanitizeStderr(stderr));
  }

  /**
   * Show one-action error notification and execute command when chosen.
   * Returns true when action was selected and command executed.
   */
  private async runCommandActionIfChosen(
    userMessage: string,
    actionLabel: string,
    commandId: string,
    commandArgs: unknown[] = []
  ): Promise<boolean> {
    const choice = await window.showErrorMessage(userMessage, actionLabel);
    if (choice !== actionLabel) {
      return false;
    }

    await commands.executeCommand(commandId, ...commandArgs);
    return true;
  }

  /**
   * Handle operation error with full priority chain.
   * Shared by executeOnResources, executeOnUrisOrResources, and handleRepositoryOperation.
   * Priority: auth > lock > cleanup > update > conflict > output > generic
   * Note: network retry is NOT here — it needs the operation lambda, so it stays
   * in handleRepositoryOperation only.
   */
  protected async handleOperationError(
    error: unknown,
    errorMsg: string,
    targets: Uri[] = []
  ): Promise<void> {
    logError("Repository operation failed", error);
    // Build error context once — both message formatting and lock/cleanup/
    // update routing below need it, and rebuilding re-runs sanitizeStderr
    // (13 regex passes).
    const context = this.getErrorContext(error);
    const userMessage = this.formatErrorMessageFromContext(context, errorMsg);
    const fullError = context.fullErrorRaw;
    const lockType = getLockErrorTypeFromFullError(fullError);

    // Priority order: auth → file-lock → cleanup → update → conflict → output → generic.
    if (needsAuthActionFromFullError(fullError)) {
      await this.runCommandActionIfChosen(
        userMessage,
        "Clear Credentials",
        "sven.clearCredentials"
      );
    } else if (lockType === "conflict") {
      // Target the FAILED files - with no args the lock commands fall
      // back to the active editor, stealing the wrong file's lock
      await this.runCommandActionIfChosen(
        userMessage,
        "Steal Lock",
        "sven.stealLock",
        targets
      );
    } else if (lockType === "notLocked" || lockType === "expired") {
      await this.runCommandActionIfChosen(
        userMessage,
        "Lock File",
        "sven.lock",
        targets
      );
    } else if (needsCleanupFromFullError(fullError)) {
      await this.runCommandActionIfChosen(
        userMessage,
        "Run Cleanup",
        "sven.cleanup"
      );
    } else if (needsUpdateFromFullError(fullError)) {
      await this.runCommandActionIfChosen(userMessage, "Update", "sven.update");
    } else if (needsConflictResolutionFromFullError(fullError)) {
      await this.runCommandActionIfChosen(
        userMessage,
        "Resolve Conflicts",
        "sven.resolveAll"
      );
    } else if (needsOutputActionFromFullError(fullError)) {
      await this.runCommandActionIfChosen(
        userMessage,
        "Show Output",
        "sven.showOutput"
      );
    } else {
      window.showErrorMessage(userMessage);
    }
  }

  /**
   * Handle repository operation with consistent error handling.
   * Wraps handleOperationError; adds network retry (needs operation lambda).
   * Priority: network retry (special) > handleOperationError chain
   */
  protected async handleRepositoryOperation<T>(
    operation: () => Promise<T>,
    errorMsg: string,
    targets: Uri[] = []
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      // Network errors - offer retry (needs the operation to re-run)
      const context = this.getErrorContext(error);
      if (needsNetworkRetryFromFullError(context.fullErrorRaw)) {
        logError("Repository operation failed", error);
        const userMessage = this.formatErrorMessageFromContext(
          context,
          errorMsg
        );
        const retry = "Retry";
        const choice = await window.showErrorMessage(userMessage, retry);
        if (choice === retry) {
          return this.handleRepositoryOperation(operation, errorMsg, targets);
        }
      } else {
        await this.handleOperationError(error, errorMsg, targets);
      }

      return undefined;
    }
  }

  /**
   * Execute operation on each path with success/error feedback.
   * Common pattern: loop paths, count successes, show messages.
   *
   * @param paths Paths to operate on
   * @param operation Function returning { exitCode, stderr? } or void
   * @param successMsg Message template: string with {count} or function
   * @param errorPrefix Prefix for error message
   * @param options.ignoreErrors If true, don't track/show errors
   * @returns Number of successful operations
   */
  protected async executeWithFeedback(
    paths: string[],
    operation: (
      path: string
    ) => Promise<{ exitCode: number; stderr?: string } | void>,
    successMsg: string | ((count: number) => string),
    errorPrefix: string,
    options?: { ignoreErrors?: boolean }
  ): Promise<number> {
    let successCount = 0;
    let errorMessage = "";

    for (const filePath of paths) {
      try {
        const result = await operation(filePath);
        if (!result || result.exitCode === 0) {
          successCount++;
        } else if (!options?.ignoreErrors) {
          errorMessage = result.stderr || "Unknown error";
        }
      } catch (error) {
        if (!options?.ignoreErrors) {
          errorMessage = getErrorMessage(error);
        }
      }
    }

    if (successCount > 0) {
      const msg =
        typeof successMsg === "function"
          ? successMsg(successCount)
          : successMsg.replace("{count}", String(successCount));
      window.showInformationMessage(msg);
    }

    if (errorMessage) {
      window.showErrorMessage(`${errorPrefix}: ${errorMessage}`);
    }

    return successCount;
  }

  /**
   * Execute revert operation with depth check and confirmation.
   * Shared by revert and revertExplorer commands.
   */
  protected async executeRevert(
    uris: Uri[],
    depth: keyof typeof import("../common/types").SvnDepth
  ): Promise<void> {
    await this.runByRepository(uris, async (repository, resources) => {
      const paths = this.toPaths(resources).reverse();

      // Find staged files before revert so we can unstage them after
      const stagedPaths = paths.filter(p => {
        const resource = repository.getResourceFromFile(p);
        return resource?.changelist === STAGING_CHANGELIST;
      });

      try {
        await repository.revert(paths, depth);

        // Post-revert cleanup
        await repository.refreshAllPropertyCaches();
        repository.refreshExplorerDecorations(resources);

        // Unstage reverted files
        if (stagedPaths.length > 0) {
          await repository.removeChangelist(stagedPaths);
          repository.staging.clearOriginalChangelists(stagedPaths);
        }
      } catch (error) {
        logError("Revert operation failed", error);
        window.showErrorMessage("Unable to revert");
      }
    });
  }
}
