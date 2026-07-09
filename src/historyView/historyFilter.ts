// Copyright (c) 2025-present Viktor Rognas
// Licensed under MIT License

import { Disposable, Event, EventEmitter } from "vscode";
import { ISvnLogEntry } from "../common/types";
import { truncate } from "../util/formatting";

/**
 * Action types for file changes in SVN commits
 * A = Added (new file, no history)
 * R = Renamed/copied (has copyfromPath, history preserved)
 * M = Modified
 * D = Deleted
 * ! = Replaced (delete+add at same path, history broken)
 */
export type ActionType = "A" | "R" | "M" | "D" | "!";

/**
 * Filter criteria for SVN history
 */
export interface IHistoryFilter {
  /** Filter by commit message text (SVN --search) */
  message?: string;
  /** Filter by file/folder path pattern (SVN --search) */
  path?: string;
  /** Filter by author name (SVN --search) */
  author?: string;
  /** Revision range start (inclusive) */
  revisionFrom?: number;
  /** Revision range end (inclusive) */
  revisionTo?: number;
  /** Date range start (inclusive) */
  dateFrom?: Date;
  /** Date range end (inclusive) */
  dateTo?: Date;
  /** Filter by action types - client-side only */
  actions?: ActionType[];
}

/**
 * Service to manage history filter state
 */
export class HistoryFilterService implements Disposable {
  private _filter?: IHistoryFilter;
  private _onDidChangeFilter = new EventEmitter<IHistoryFilter | undefined>();
  private _disposables: Disposable[] = [];

  public readonly onDidChangeFilter: Event<IHistoryFilter | undefined> =
    this._onDidChangeFilter.event;

  constructor() {
    this._disposables.push(this._onDidChangeFilter);
  }

  /**
   * Get the current filter
   */
  public getFilter(): IHistoryFilter | undefined {
    return this._filter;
  }

  /**
   * Set a new filter, replacing any existing filter
   */
  public setFilter(filter: IHistoryFilter): void {
    this._filter = filter;
    this._onDidChangeFilter.fire(filter);
  }

  /**
   * Update specific fields of the current filter
   */
  public updateFilter(partial: Partial<IHistoryFilter>): void {
    this._filter = { ...this._filter, ...partial };
    this._onDidChangeFilter.fire(this._filter);
  }

  /**
   * Clear the current filter
   */
  public clearFilter(): void {
    this._filter = undefined;
    this._onDidChangeFilter.fire(undefined);
  }

  /**
   * Check if any filter is active
   */
  public hasActiveFilter(): boolean {
    if (!this._filter) return false;
    return Object.values(this._filter).some(
      v =>
        v !== undefined &&
        v !== null &&
        v !== "" &&
        (Array.isArray(v) ? v.length > 0 : true)
    );
  }

  /**
   * Get a human-readable description of the active filter
   */
  public getFilterDescription(): string {
    if (!this._filter) return "";

    const parts: string[] = [];
    if (this._filter.message) parts.push(`message: "${this._filter.message}"`);
    if (this._filter.author) parts.push(`author: "${this._filter.author}"`);
    if (this._filter.path) parts.push(`path: "${this._filter.path}"`);
    if (this._filter.revisionFrom || this._filter.revisionTo) {
      const from = this._filter.revisionFrom ?? "1";
      const to = this._filter.revisionTo ?? "HEAD";
      parts.push(`revision: ${from}-${to}`);
    }
    if (this._filter.dateFrom || this._filter.dateTo) {
      const from = this._filter.dateFrom?.toLocaleDateString() ?? "...";
      const to = this._filter.dateTo?.toLocaleDateString() ?? "...";
      parts.push(`date: ${from} to ${to}`);
    }
    if (this._filter.actions?.length) {
      parts.push(`actions: ${this._filter.actions.join(", ")}`);
    }

    return parts.join(" | ");
  }

  /**
   * Get a short description for tree view title (concise format)
   */
  public getShortDescription(): string {
    if (!this._filter) return "";

    const parts: string[] = [];

    if (this._filter.message) {
      parts.push(`msg:${truncate(this._filter.message, 15)}`);
    }
    if (this._filter.author) {
      parts.push(`author:${truncate(this._filter.author, 12)}`);
    }
    if (this._filter.path) {
      parts.push(`path:${truncate(this._filter.path, 12)}`);
    }
    if (
      this._filter.revisionFrom !== undefined ||
      this._filter.revisionTo !== undefined
    ) {
      const from = this._filter.revisionFrom ?? 1;
      const to = this._filter.revisionTo ?? "HEAD";
      parts.push(`rev:${from}-${to}`);
    }
    if (this._filter.dateFrom || this._filter.dateTo) {
      const fmt = (d: Date) => d.toISOString().split("T")[0];
      const from = this._filter.dateFrom ? fmt(this._filter.dateFrom) : "...";
      const to = this._filter.dateTo ? fmt(this._filter.dateTo) : "...";
      parts.push(`date:${from}~${to}`);
    }
    if (this._filter.actions?.length) {
      parts.push(`actions:${this._filter.actions.join(",")}`);
    }

    return parts.join(" ");
  }

  public dispose(): void {
    this._disposables.forEach(d => d.dispose());
  }
}

/**
 * Check if filter uses text search (--search) which has special limit behavior.
 * SVN's --limit restricts commits SEARCHED, not results returned.
 * So with --search, we must NOT use --limit or text filters won't find matches
 * outside the first N commits.
 */
export function hasTextSearchFilter(
  filter: IHistoryFilter | undefined
): boolean {
  if (!filter) return false;
  return !!(filter.message || filter.author || filter.path);
}

/**
 * Build SVN log command arguments from filter criteria
 * Returns only server-side filterable args (not action filter)
 */
export function buildSvnLogArgs(filter: IHistoryFilter): string[] {
  const args: string[] = [];

  // Text search filters (message, author, path). SVN --search matches
  // log message, author and paths; multiple --search patterns are OR'd
  // (match ANY). The filter UI is additive, so criteria after the first
  // must AND via --search-and.
  const textCriteria = [filter.message, filter.author, filter.path].filter(
    (v): v is string => !!v
  );
  textCriteria.forEach((value, i) => {
    args.push(i === 0 ? "--search" : "--search-and", value);
  });

  // Revision/date bounds: ONE combined -r range, newest-first. SVN accepts
  // mixed forms like `-r 2999:{2024-01-01}`. Emitting two -r args (the old
  // separate revision + date branches) made SVN treat them as independent
  // ranges, so load-more pagination (which adds revisionTo to a date
  // filter) kept re-fetching the same page. Revision bounds win over date
  // bounds on the same side; pagination only ever sets revisionTo.
  if (
    filter.revisionFrom !== undefined ||
    filter.revisionTo !== undefined ||
    filter.dateFrom ||
    filter.dateTo
  ) {
    const upper =
      filter.revisionTo ??
      (filter.dateTo ? `{${formatSvnDate(dayAfter(filter.dateTo))}}` : "HEAD");
    const lower =
      filter.revisionFrom ??
      (filter.dateFrom ? `{${formatSvnDate(filter.dateFrom)}}` : 1);
    args.push("-r", `${upper}:${lower}`);
  }

  // Note: actions filter is client-side only, not included here

  return args;
}

/**
 * Format date for SVN -r {DATE} syntax (uses local timezone)
 */
function formatSvnDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * svn resolves {DATE} to the youngest revision BEFORE that day starts,
 * so an INCLUSIVE upper bound must name the day after dateTo.
 */
function dayAfter(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

/**
 * Inclusive day bounds for a filter: [start of dateFrom, start of the
 * day after dateTo) in epoch ms.
 */
function dateBoundsMs(filter: IHistoryFilter): {
  fromMs?: number;
  toMs?: number;
} {
  const fromMs = filter.dateFrom
    ? new Date(
        filter.dateFrom.getFullYear(),
        filter.dateFrom.getMonth(),
        filter.dateFrom.getDate()
      ).getTime()
    : undefined;
  const toMs = filter.dateTo
    ? new Date(
        filter.dateTo.getFullYear(),
        filter.dateTo.getMonth(),
        filter.dateTo.getDate() + 1
      ).getTime()
    : undefined;
  return { fromMs, toMs };
}

/**
 * Keep only entries within the filter's inclusive day bounds. svn's
 * server-side {DATE} bounds are day-start approximations (the lower
 * bound admits the last pre-range commit) and lose outright to revision
 * bounds in the single -r range - fetched pages are re-checked exactly,
 * client-side.
 */
export function filterEntriesByDate(
  entries: ISvnLogEntry[],
  filter: IHistoryFilter
): ISvnLogEntry[] {
  const { fromMs, toMs } = dateBoundsMs(filter);
  if (fromMs === undefined && toMs === undefined) {
    return entries;
  }
  return entries.filter(e => {
    const t = new Date(e.date).getTime();
    if (isNaN(t)) return false;
    if (fromMs !== undefined && t < fromMs) return false;
    if (toMs !== undefined && t >= toMs) return false;
    return true;
  });
}

/**
 * Filter log entries by action type (client-side filtering)
 * Maps SVN actions to our ActionType:
 * - SVN "A" + copyfromPath → "R" (renamed with history)
 * - SVN "A" without copyfrom → "A" (added)
 * - SVN "R" (replaced) → "↻" (history broken)
 * - SVN "M", "D" → direct match
 */
/** True when the filter has no populated criteria. */
export function isFilterEmpty(filter: IHistoryFilter | undefined): boolean {
  if (!filter) return true;
  return !Object.values(filter).some(
    v =>
      v !== undefined &&
      v !== null &&
      v !== "" &&
      (Array.isArray(v) ? v.length > 0 : true)
  );
}

/**
 * Apply a history filter to already-loaded entries, entirely client-side.
 *
 * Used when the FULL unfiltered history is cached (ICachedLog.fullHistory):
 * filtering locally is instant and skips the server round-trip that
 * `--search` performs (a full-history scan per page). Matching is slightly
 * more precise than SVN's `--search` — each criterion checks only its own
 * field (author matches authors, not messages), which is what the filter UI
 * implies anyway. Criteria combine with AND; dates are inclusive per day.
 */
export function applyFilterToEntries(
  entries: ISvnLogEntry[],
  filter: IHistoryFilter
): ISvnLogEntry[] {
  const msg = filter.message?.toLowerCase();
  const author = filter.author?.toLowerCase();
  const pathNeedle = filter.path?.toLowerCase();
  // Inclusive day bounds: [start of dateFrom, start of day after dateTo)
  const { fromMs, toMs } = dateBoundsMs(filter);

  let result = entries.filter(e => {
    if (msg && !e.msg?.toLowerCase().includes(msg)) return false;
    if (author && !e.author?.toLowerCase().includes(author)) return false;
    if (
      pathNeedle &&
      !e.paths?.some(p => p._.toLowerCase().includes(pathNeedle))
    ) {
      return false;
    }
    const rev = parseInt(e.revision, 10);
    if (filter.revisionFrom !== undefined && rev < filter.revisionFrom) {
      return false;
    }
    if (filter.revisionTo !== undefined && rev > filter.revisionTo) {
      return false;
    }
    if (fromMs !== undefined || toMs !== undefined) {
      const t = new Date(e.date).getTime();
      if (isNaN(t)) return false;
      if (fromMs !== undefined && t < fromMs) return false;
      if (toMs !== undefined && t >= toMs) return false;
    }
    return true;
  });

  if (filter.actions?.length) {
    result = filterEntriesByAction(result, filter.actions);
  }
  return result;
}

export function filterEntriesByAction(
  entries: ISvnLogEntry[],
  actions: ActionType[] | undefined
): ISvnLogEntry[] {
  if (!actions || actions.length === 0) {
    return entries;
  }

  const actionSet = new Set(actions);
  const wantRenamed = actionSet.has("R");
  const wantAddedPlain = actionSet.has("A");
  const wantReplaced = actionSet.has("!");

  return entries.filter(entry => {
    // Keep entry if any of its paths match the action filter
    return entry.paths?.some(p => {
      const svnAction = p.action;

      // Handle A vs R (renamed) distinction
      if (svnAction === "A") {
        const hasHistory = !!p.copyfromPath;
        if (hasHistory) {
          return wantRenamed; // R filter (renamed with history)
        } else {
          return wantAddedPlain; // A filter (plain add)
        }
      }

      // SVN "R" (replaced) → our "↻"
      if (svnAction === "R") {
        return wantReplaced;
      }

      // Other actions (M, D) - direct match
      return actionSet.has(svnAction as ActionType);
    });
  });
}
