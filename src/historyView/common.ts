// Copyright (c) 2017-2020 Christopher Johnston
// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import * as path from "path";
import {
  commands,
  env,
  TextDocumentShowOptions,
  ThemeIcon,
  TreeItem,
  Uri,
  window
} from "vscode";
import { ISvnLogEntry, ISvnLogEntryPath } from "../common/types";
import {
  IHistoryFilter,
  filterEntriesByAction,
  isFilterEmpty
} from "./historyFilter";
import SvnError from "../svnError";
import { svnErrorCodes } from "../svn";
import { exists, lstat } from "../fs";
import { configuration } from "../helpers/configuration";
import { IRemoteRepository } from "../remoteRepository";
import { SvnRI } from "../svnRI";
import { tempSvnFs } from "../temp_svn_fs";
import { getAuthorColorDot } from "./letterAvatar";

/**
 * Format a date as relative time ("2 days ago", "3 months ago")
 * Replaces dayjs dependency (-46KB bundle size)
 */
function formatRelativeTime(date: string | Date): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  if (diffYear > 0) return rtf.format(-diffYear, "year");
  if (diffMonth > 0) return rtf.format(-diffMonth, "month");
  if (diffWeek > 0) return rtf.format(-diffWeek, "week");
  if (diffDay > 0) return rtf.format(-diffDay, "day");
  if (diffHour > 0) return rtf.format(-diffHour, "hour");
  if (diffMin > 0) return rtf.format(-diffMin, "minute");
  return rtf.format(-diffSec, "second");
}

export enum LogTreeItemKind {
  Commit = 1,
  CommitDetail,
  TItem
}

export interface ICachedLog {
  entries: ISvnLogEntry[];
  // O(1) lookup for deduplication during pagination
  revisionSet: Set<string>;
  // Uri of svn repository (remote URL)
  svnTarget: Uri;
  // Local working copy file path (for file-level history)
  localPath?: string;
  isComplete: boolean;
  /** True when entries hold the COMPLETE UNFILTERED history - enables
   *  instant client-side filtering (applyFilterToEntries) */
  fullHistory?: boolean;
  isLoading?: boolean; // True while fetching from SVN
  repo: IRemoteRepository;
  persisted: {
    readonly commitFrom: string;
    baseRevision?: number;
  };
  lastAccessed?: number; // LRU tracking
  // Active filter for this cache
  filter?: IHistoryFilter;
}

/** Maps each tree-item kind to the data shape it carries. */
type DataFor<K extends LogTreeItemKind> = K extends LogTreeItemKind.Commit
  ? ISvnLogEntry
  : K extends LogTreeItemKind.CommitDetail
    ? ISvnLogEntryPath
    : TreeItem;

interface ILogTreeItemBase {
  readonly parent?: ILogTreeItem;
  isBase?: boolean; // True if this commit is the BASE revision
  isServerOnly?: boolean; // True if revision > BASE (not synced yet)
}

/**
 * Discriminated on `kind`: checking it narrows `data` to the matching shape,
 * so handlers don't need (and can't mis-state) `as` casts.
 */
export type ILogTreeItem =
  | (ILogTreeItemBase & {
      readonly kind: LogTreeItemKind.Commit;
      data: ISvnLogEntry;
    })
  | (ILogTreeItemBase & {
      readonly kind: LogTreeItemKind.CommitDetail;
      data: ISvnLogEntryPath;
    })
  | (ILogTreeItemBase & {
      readonly kind: LogTreeItemKind.TItem;
      data: TreeItem;
    });

export function transform<K extends LogTreeItemKind>(
  array: DataFor<K>[],
  kind: K,
  parent?: ILogTreeItem
): ILogTreeItem[] {
  return array.map(data => {
    // Safe: K correlates data with kind at every call site; TS can't prove
    // the correlated pair inside a generic, hence the single cast here
    return { kind, data, parent } as ILogTreeItem;
  });
}

export function getIconObject(iconName: string): { light: Uri; dark: Uri } {
  // XXX Maybe use full path to extension?
  // Path needs to be relative from out/
  const iconsRootPath = path.join(__dirname, "..", "icons");
  const toUri = (theme: string) =>
    Uri.file(path.join(iconsRootPath, theme, `${iconName}.svg`));
  return {
    light: toUri("light"),
    dark: toUri("dark")
  };
}

export async function copyCommitToClipboard(what: string, item: ILogTreeItem) {
  const clipboard = (
    env as unknown as {
      clipboard?: { writeText: (text: string) => Promise<void> };
    }
  ).clipboard;
  if (clipboard === undefined) {
    window.showErrorMessage("Clipboard is supported in VS Code 1.30 and newer");
    return;
  }
  if (item.kind === LogTreeItemKind.Commit) {
    const commit = item.data;
    switch (what) {
      case "msg":
      case "revision":
        await clipboard.writeText(commit[what]);
    }
  }
}

function needFetch(
  cached: ISvnLogEntry[],
  fetched: ISvnLogEntry[],
  limit: number
): boolean {
  if (cached.length && cached[cached.length - 1]!.revision === "1") {
    return false;
  }
  if (fetched.length === 0 || fetched[fetched.length - 1]!.revision === "1") {
    return false;
  }
  if (fetched.length < limit) {
    return false;
  }
  return true;
}

/**
 * Mark commit status in the output list:
 * - isBase: true if revision === BASE (your working copy revision)
 * - isServerOnly: true if revision > BASE (not synced yet)
 */
export function insertBaseMarker(
  item: ICachedLog,
  entries: ISvnLogEntry[],
  out: ILogTreeItem[]
): void {
  const baseRev = item.persisted.baseRevision;
  if (!entries.length || !baseRev) {
    return;
  }

  for (let i = 0; i < out.length; i++) {
    const logItem = out[i];
    if (logItem?.kind !== LogTreeItemKind.Commit) {
      continue;
    }
    const commit = logItem.data;
    const rev = parseInt(commit.revision, 10);
    if (rev === baseRev) {
      // Mark this commit as BASE
      logItem.isBase = true;
    } else if (rev > baseRev) {
      // Mark commits above BASE as server-only (not synced)
      logItem.isServerOnly = true;
    }
  }
}

export async function checkIfFile(
  e: SvnRI,
  local: boolean
): Promise<boolean | undefined> {
  if (e.localFullPath === undefined) {
    if (local) {
      window.showErrorMessage("No working copy for this path");
    }
    return undefined;
  }
  let stat;
  try {
    stat = await lstat(e.localFullPath.fsPath);
  } catch {
    window.showWarningMessage(
      "Not available from this working copy: " + e.localFullPath
    );
    return false;
  }
  if (!stat.isFile()) {
    window.showErrorMessage("This target is not a file");
    return false;
  }
  return true;
}

export function getLimit(): number {
  return configuration.logLength();
}

/** Create "Load more" tree item for log pagination */
export function createLoadMoreItem(
  command: string,
  args: unknown[]
): ILogTreeItem {
  const ti = new TreeItem(`Load another ${getLimit()} revisions`);
  ti.tooltip = "Paging size may be adjusted using log.length setting";
  ti.command = { command, arguments: args, title: "load more" };
  ti.iconPath = new ThemeIcon("unfold");
  return { kind: LogTreeItemKind.TItem, data: ti };
}

/** Create "Load all" tree item: pages until history is exhausted */
export function createLoadAllItem(command: string): ILogTreeItem {
  const ti = new TreeItem("Load all remaining revisions");
  ti.tooltip = "Fetches the entire remaining history in chunks (cancellable)";
  ti.command = { command, arguments: [], title: "load all" };
  ti.iconPath = new ThemeIcon("cloud-download");
  return { kind: LogTreeItemKind.TItem, data: ti };
}

/** Create loading indicator tree item */
export function createLoadingItem(): ILogTreeItem {
  const item = new TreeItem("Loading...");
  item.iconPath = new ThemeIcon("loading~spin");
  return { kind: LogTreeItemKind.TItem, data: item };
}

/// @note: cached.svnTarget should be valid
export async function fetchMore(cached: ICachedLog, limitOverride?: number) {
  const entries = cached.entries;
  const limit = limitOverride ?? getLimit();
  const filter = cached.filter;

  // Build revision range based on existing entries
  let rfrom = cached.persisted.commitFrom;
  if (entries.length) {
    const lastRev = Number.parseInt(entries[entries.length - 1]!.revision, 10);
    // Already at r1 or invalid revision, nothing more to fetch
    if (isNaN(lastRev) || lastRev <= 1) {
      cached.isComplete = true;
      if (isFilterEmpty(filter)) {
        cached.fullHistory = true;
      }
      return;
    }
    rfrom = (lastRev - 1).toString();
  }

  let moreCommits: ISvnLogEntry[] = [];
  try {
    // Use filtered log when filter is active (and has server-side filters)
    const hasServerSideFilter =
      filter &&
      (filter.message ||
        filter.author ||
        filter.path ||
        filter.revisionFrom !== undefined ||
        filter.revisionTo !== undefined ||
        filter.dateFrom ||
        filter.dateTo);

    if (hasServerSideFilter) {
      // Build filter with revision range for pagination
      // Use min of user's revisionTo and current position (rfrom)
      const rfromNum = parseInt(rfrom, 10);
      const validRfrom = !isNaN(rfromNum) ? rfromNum : undefined;
      const paginatedRevisionTo = filter.revisionTo
        ? Math.min(filter.revisionTo, validRfrom ?? Infinity)
        : validRfrom;
      const paginatedFilter: IHistoryFilter = {
        ...filter,
        revisionTo: paginatedRevisionTo
      };
      moreCommits = await cached.repo.logWithFilter(
        paginatedFilter,
        limit,
        cached.svnTarget
      );
    } else {
      // No server-side filter, use regular log
      moreCommits = await cached.repo.log(rfrom, "1", limit, cached.svnTarget);
    }
  } catch (e) {
    // Show user-friendly message for connection errors
    if (e instanceof SvnError) {
      if (
        e.svnErrorCode === svnErrorCodes.UnableToConnect ||
        e.stderrFormated?.includes("No such host")
      ) {
        window.showErrorMessage(
          "Unable to connect to SVN server. Check VPN/network."
        );
        return;
      }
    }
    // Silently ignore other errors (e.g., item didn't exist)
  }

  // Check needFetch BEFORE action filtering (action filter reduces count)
  if (!needFetch(entries, moreCommits, limit)) {
    cached.isComplete = true;
    // Complete + no filter constraining the fetch = full history cached;
    // filters can now be answered locally without server round-trips
    if (isFilterEmpty(filter)) {
      cached.fullHistory = true;
    }
  }

  // Apply client-side action filter AFTER needFetch check
  if (filter?.actions?.length) {
    moreCommits = filterEntriesByAction(moreCommits, filter.actions);
  }
  // Deduplicate using persistent Set (O(1) lookup)
  const newCommits = moreCommits.filter(
    c => !cached.revisionSet.has(c.revision)
  );
  for (const c of newCommits) {
    cached.revisionSet.add(c.revision);
  }
  entries.push(...newCommits);
}

/**
 * Page older history until `revision` is in the cache, the cache is
 * exhausted, or paging has passed the target. Revisions are monotonic, so
 * once the oldest loaded entry is <= the target and it hasn't appeared,
 * it cannot appear further down - it doesn't touch this checkout's path
 * (e.g. a commit in another subtree). Returns whether it was found.
 */
export async function ensureRevisionLoaded(
  cached: ICachedLog,
  revision: number,
  chunkSize = 500,
  shouldContinue: () => boolean = () => true
): Promise<boolean> {
  const key = String(revision);
  while (!cached.revisionSet.has(key) && !cached.isComplete) {
    const last = cached.entries[cached.entries.length - 1];
    const lastRev = last ? parseInt(last.revision, 10) : NaN;
    if (!isNaN(lastRev) && lastRev <= revision) {
      break;
    }
    if (!shouldContinue()) {
      break;
    }
    const before = cached.entries.length;
    await fetchMore(cached, chunkSize);
    if (cached.entries.length === before && !cached.isComplete) {
      break; // no progress (e.g. network error swallowed) - avoid spinning
    }
  }
  return cached.revisionSet.has(key);
}

/**
 * Get commit author icon for history view
 * Returns colored dot (if enabled) or standard git-commit icon
 */
export function getCommitIcon(
  author: string
): Uri | { light: Uri; dark: Uri } | ThemeIcon {
  const showColors = configuration.get("log.authorColors", true);

  if (!author || !showColors) {
    return new ThemeIcon("git-commit");
  }

  return getAuthorColorDot(author);
}

/**
 * Build file change stats string (e.g., "A:1 · M:3 · D:2")
 */
function getFileStats(paths: ISvnLogEntryPath[] | undefined): string {
  if (!paths || paths.length === 0) return "";

  const counts: Record<string, number> = {};
  for (const p of paths) {
    const action = p.action || "?";
    counts[action] = (counts[action] || 0) + 1;
  }

  // Order: A (Added), M (Modified), D (Deleted), R (Replaced), other
  const order = ["A", "M", "D", "R"];
  const parts: string[] = [];

  for (const action of order) {
    if (counts[action]) {
      parts.push(`${action}:${counts[action]}`);
      delete counts[action];
    }
  }
  // Add any remaining actions
  for (const [action, count] of Object.entries(counts)) {
    parts.push(`${action}:${count}`);
  }

  return parts.join(" · ");
}

export function getCommitDescription(commit: ISvnLogEntry): string {
  const relativeDate = formatRelativeTime(commit.date);
  const hasMsg = commit.msg && commit.msg.trim();
  const prefix = hasMsg ? "· " : "";

  // Add file stats if available
  const stats = getFileStats(commit.paths);
  const statsPart = stats ? ` · ${stats}` : "";

  return `${prefix}r${commit.revision} · ${commit.author} · ${relativeDate}${statsPart}`;
}

export function getCommitLabel(commit: ISvnLogEntry): string {
  if (!commit.msg) {
    return "";
  }
  return commit.msg.split(/\r?\n/, 1)[0]!;
}

export function getCommitToolTip(commit: ISvnLogEntry): string {
  let date = commit.date;
  if (!isNaN(Date.parse(date))) {
    date = new Date(date).toString();
  }
  return `Author: ${commit.author}
${date}
Revision: ${commit.revision}
Message: ${commit.msg}`;
}

async function downloadFile(
  repo: IRemoteRepository,
  arg: Uri,
  revision: string
): Promise<Uri> {
  if (revision === "BASE") {
    const nm = repo.getPathNormalizer();
    const ri = nm.parse(arg.toString(true));
    const localPath = ri.localFullPath;
    if (localPath === undefined || !(await exists(localPath.path))) {
      const errorMsg =
        "BASE revision doesn't exist for " +
        (localPath ? localPath.path : "remote path");
      window.showErrorMessage(errorMsg);
      throw new Error(errorMsg);
    }
    return localPath;
  }
  let out;
  try {
    out = await repo.show(arg, revision);
  } catch (e) {
    window.showErrorMessage("Failed to open path");
    throw e;
  }
  return tempSvnFs.createTempSvnRevisionFile(arg, revision, out);
}

export async function openDiff(
  repo: IRemoteRepository,
  arg1: Uri,
  r1: string | undefined,
  r2: string,
  arg2?: Uri
) {
  // For added files (r1 = undefined), create empty temp file.
  // Both sides fetch in parallel - they were sequential round-trips before.
  const [uri1, uri2] = await Promise.all([
    r1
      ? downloadFile(repo, arg1, r1)
      : Promise.resolve(tempSvnFs.createTempSvnRevisionFile(arg1, "empty", "")),
    downloadFile(repo, arg2 || arg1, r2)
  ]);
  const opts: TextDocumentShowOptions = {
    preview: true
  };
  const title = r1
    ? `${path.basename(arg1.path)} (${r1} : ${r2})`
    : `${path.basename(arg1.path)} (added in ${r2})`;
  return commands.executeCommand<void>("vscode.diff", uri1, uri2, title, opts);
}

/**
 * Open the diff for a file modified in a commit. Fetches BOTH revisions in
 * parallel and detects property-only changes by content equality (identical
 * content means the commit only touched properties), showing the patch in
 * that case. Replaces the old flow of a discarded `svn diff` pre-check
 * followed by two sequential cats - 3 serial round-trips down to 1 wave.
 *
 * `right` lets callers that must resolve the previous revision first (an
 * `svn log` lookup) start the right-side fetch concurrently with it.
 */
export async function openDiffCompared(
  repo: IRemoteRepository,
  target: Uri,
  r1: string,
  r2: string,
  right?: Promise<string>
): Promise<void> {
  let out1: string;
  let out2: string;
  try {
    [out1, out2] = await Promise.all([
      repo.show(target, r1),
      right ?? repo.show(target, r2)
    ]);
  } catch {
    window.showErrorMessage("Failed to open path");
    return;
  }

  if (out1 === out2) {
    return openPatch(repo, target, r2);
  }

  const uri1 = tempSvnFs.createTempSvnRevisionFile(target, r1, out1);
  const uri2 = tempSvnFs.createTempSvnRevisionFile(target, r2, out2);
  const opts: TextDocumentShowOptions = {
    preview: true
  };
  const title = `${path.basename(target.path)} (${r1} : ${r2})`;
  return commands.executeCommand<void>("vscode.diff", uri1, uri2, title, opts);
}

export async function openFileRemote(
  repo: IRemoteRepository,
  arg: Uri,
  against: string
) {
  let out;
  try {
    out = await repo.show(arg, against);
  } catch {
    window.showErrorMessage("Failed to open path");
    return;
  }
  const localUri = tempSvnFs.createTempSvnRevisionFile(arg, against, out);
  const opts: TextDocumentShowOptions = {
    preview: true
  };
  return commands.executeCommand<void>("vscode.open", localUri, opts);
}

/**
 * Show SVN patch output in a temp file (for property-only changes)
 */
export async function openPatch(
  repo: IRemoteRepository,
  remotePath: Uri,
  revision: string
): Promise<void> {
  let patch: string;
  try {
    patch = await repo.patchRevision(revision, remotePath);
  } catch {
    window.showErrorMessage("Failed to get patch for revision");
    return;
  }

  if (!patch.trim()) {
    window.showInformationMessage("No changes in this revision");
    return;
  }

  // Create temp file with patch content
  const patchUri = tempSvnFs.createTempSvnRevisionFile(
    remotePath,
    `${revision}.patch`,
    patch
  );
  const opts: TextDocumentShowOptions = {
    preview: true
  };
  return commands.executeCommand<void>("vscode.open", patchUri, opts);
}
